import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { TurnServerConfig } from '../types/calls.ts'
import type { ToastLevel, TrustedPeerEntry } from '../types/protocol.ts'
import {
  DEFAULT_AMAIL_RELAY_SETTINGS,
  type AmailAckTombstone,
  type AmailContact,
  type AmailDraftInput,
  type AmailEngine,
  type AmailFolder,
  type AmailMeshPeer,
  type AmailMessage,
  type AmailRelayCapsuleMeta,
  type AmailRelaySettings,
  type AmailSealedCapsule,
  type AmailSendInput,
  type AmailStorageStats,
  type AmailSyncSnapshot,
} from '../types/amail.ts'
import {
  createSignedAckTombstone,
  sealAmailCapsule,
  unsealAmailCapsule,
  type AmailInnerMailPayload,
  type AmailInnerReadReceiptPayload,
} from '../lib/amailCrypto.ts'
import { AmailMeshNode } from '../lib/amailMesh.ts'
import { AmailStorage } from '../lib/amailStorage.ts'
import {
  decodePubkeyInput,
  encodeNpubSafe,
  formatShortPubkey,
  type IdentityManager,
} from '../lib/identity.ts'
import type { RelayPool } from '../lib/relayPool.ts'
import { parseShareTarget } from '../lib/shareLinks.ts'

export interface UseAmailOptions {
  relayPool: RelayPool
  identityManager: IdentityManager
  masterPubkey: string
  activeNickname: string
  trustedPubkeys: TrustedPeerEntry[]
  blockedPubkeys: string[]
  turnConfig?: TurnServerConfig | null
  onLocalChange?: () => void
  pushToast?: (level: ToastLevel, title: string, detail?: string) => void
}

function makeAmailId(prefix: string): string {
  const rand = new Uint8Array(8)
  crypto.getRandomValues(rand)
  let hex = ''
  for (let i = 0; i < rand.length; i++) {
    hex += rand[i].toString(16).padStart(2, '0')
  }
  return `${prefix}-${Date.now().toString(36)}-${hex}`
}

function resolveContactPubkeyInput(raw: string): { pubkey: string; nicknameHint?: string } | null {
  const trimmed = raw.trim()
  if (!trimmed) return null

  const share = parseShareTarget(trimmed)
  if (share && share.kind === 'dm') {
    return { pubkey: share.pubkey.toLowerCase(), nicknameHint: share.nickname }
  }

  const cleaned = trimmed.replace(/^nostr:/i, '').trim()
  const direct = decodePubkeyInput(cleaned)
  if (direct) {
    return { pubkey: direct.toLowerCase() }
  }
  return null
}

const DELIVERY_RANK: Record<AmailMessage['deliveryStatus'], number> = {
  draft: 0,
  queued: 1,
  relayed: 2,
  expired: 2,
  delivered: 3,
  read: 4,
}

const EMPTY_STATS: AmailStorageStats = {
  vaultBytes: 0,
  vaultLimitBytes: DEFAULT_AMAIL_RELAY_SETTINGS.maxVaultBytes,
  vaultCapsuleCount: 0,
  mailBytes: 0,
  mailCount: 0,
  tombstoneCount: 0,
  contactCount: 0,
  totalRelayedOut: 0,
  totalDeliveredPurged: 0,
  totalExpiredPurged: 0,
}

export function useAmail(options: UseAmailOptions): AmailEngine {
  const {
    relayPool,
    identityManager,
    masterPubkey,
    activeNickname,
    trustedPubkeys,
    blockedPubkeys,
    turnConfig = null,
  } = options

  const pushToastRef = useRef(options.pushToast)
  pushToastRef.current = options.pushToast

  const onLocalChangeRef = useRef(options.onLocalChange)
  onLocalChangeRef.current = options.onLocalChange

  const activeNicknameRef = useRef(activeNickname)
  activeNicknameRef.current = activeNickname

  const blockedSetRef = useRef<Set<string>>(new Set())
  blockedSetRef.current = new Set(blockedPubkeys.map((pk) => pk.toLowerCase()))

  const trustedMapRef = useRef<Map<string, TrustedPeerEntry>>(new Map())
  trustedMapRef.current = new Map(trustedPubkeys.map((t) => [t.pubkey.toLowerCase(), t]))

  const storageRef = useRef<AmailStorage | null>(null)
  if (!storageRef.current) {
    storageRef.current = new AmailStorage()
  }

  const meshRef = useRef<AmailMeshNode | null>(null)

  const [messages, setMessages] = useState<AmailMessage[]>([])
  const [storedContacts, setStoredContacts] = useState<AmailContact[]>([])
  const [relayCapsules, setRelayCapsules] = useState<AmailRelayCapsuleMeta[]>([])
  const [tombstonesCount, setTombstonesCount] = useState<number>(0)
  const [meshPeers, setMeshPeers] = useState<AmailMeshPeer[]>([])
  const [storageStats, setStorageStats] = useState<AmailStorageStats>(EMPTY_STATS)
  const [settings, setSettings] = useState<AmailRelaySettings>(DEFAULT_AMAIL_RELAY_SETTINGS)
  const [isSyncing, setIsSyncing] = useState<boolean>(false)

  const refreshFromStorage = useCallback(() => {
    const storage = storageRef.current
    if (!storage) return
    const snap = storage.getSnapshot()
    const nowSec = Math.floor(Date.now() / 1000)

    // Reflect expired outgoing messages cleanly
    const adjustedMessages = snap.messages.map((m) => {
      if (
        m.direction === 'out' &&
        (m.deliveryStatus === 'queued' || m.deliveryStatus === 'relayed') &&
        m.expiresAt > 0 &&
        nowSec > m.expiresAt
      ) {
        return { ...m, deliveryStatus: 'expired' as const }
      }
      return m
    })

    setMessages(adjustedMessages)
    setStoredContacts(snap.contacts)
    setRelayCapsules(snap.relayCapsules)
    setTombstonesCount(snap.tombstonesCount)
    setSettings(snap.settings)
    setStorageStats(snap.stats)
    setMeshPeers(meshRef.current?.getMeshPeers() ?? [])
    setIsSyncing(meshRef.current?.isSyncing() ?? false)
  }, [])

  // Merge explicitly saved Amail contacts with Agnostr's Trusted People list
  const contacts = useMemo<AmailContact[]>(() => {
    const map = new Map<string, AmailContact>()
    for (const c of storedContacts) {
      const pk = c.pubkey.toLowerCase()
      const isTrusted = trustedPubkeys.some((t) => t.pubkey.toLowerCase() === pk)
      map.set(pk, { ...c, pubkey: pk, isTrustedPeer: isTrusted })
    }
    for (const t of trustedPubkeys) {
      const pk = t.pubkey.toLowerCase()
      if (!map.has(pk)) {
        map.set(pk, {
          pubkey: pk,
          npub: t.npub || encodeNpubSafe(pk),
          nickname: (t.label || formatShortPubkey(pk)).trim(),
          addedAt: t.addedAt,
          isTrustedPeer: true,
        })
      }
    }
    return Array.from(map.values()).sort((a, b) =>
      a.nickname.localeCompare(b.nickname, undefined, { sensitivity: 'base' })
    )
  }, [storedContacts, trustedPubkeys])

  const contactsRef = useRef<AmailContact[]>(contacts)
  contactsRef.current = contacts

  const resolveDisplayName = useCallback((pubkey: string, fallback?: string): string => {
    const pk = pubkey.toLowerCase()
    const found = contactsRef.current.find((c) => c.pubkey === pk)
    if (found?.nickname) return found.nickname
    const trusted = trustedMapRef.current.get(pk)
    if (trusted?.label) return trusted.label
    if (fallback?.trim()) return fallback.trim()
    return formatShortPubkey(pk)
  }, [])

  const handleCapsuleForSelf = useCallback(
    async (capsule: AmailSealedCapsule) => {
      const storage = storageRef.current
      const mesh = meshRef.current
      if (!storage) return

      const inner = await unsealAmailCapsule(capsule, identityManager)
      if (!inner) return

      // Always emit a recipient-signed ACK tombstone so couriers purge ciphertext immediately
      const ack = await createSignedAckTombstone({
        capsuleId: capsule.capsuleId,
        expiresAt: capsule.expiresAt,
        identityManager,
      })
      await storage.applyAckTombstone(ack)
      if (mesh) {
        void mesh.broadcastAckTombstone(ack)
      }

      if (blockedSetRef.current.has(capsule.senderPubkey.toLowerCase())) {
        refreshFromStorage()
        return
      }

      const senderPk = capsule.senderPubkey.toLowerCase()
      const nowSec = Math.floor(Date.now() / 1000)

      if (inner.type === 'mail') {
        if (storage.getMessage(inner.id)) {
          refreshFromStorage()
          return
        }
        const myPk = identityManager.getMasterKeyMaterial().pubkey.toLowerCase()
        const fromName = resolveDisplayName(senderPk, inner.fromName)
        const incoming: AmailMessage = {
          id: inner.id,
          threadId: inner.threadId || inner.id,
          inReplyTo: inner.inReplyTo,
          folder: 'inbox',
          direction: 'in',
          fromPubkey: senderPk,
          fromNpub: encodeNpubSafe(senderPk),
          fromName,
          toPubkey: myPk,
          toNpub: encodeNpubSafe(myPk),
          toName: activeNicknameRef.current,
          subject: inner.subject || '(no subject)',
          body: inner.body,
          sentAt: inner.sentAt,
          receivedAt: nowSec,
          isRead: false,
          isStarred: false,
          requestReadReceipt: inner.requestReadReceipt,
          deliveryStatus: 'delivered',
          relayHopCount: capsule.hopCount,
          relayedPeerCount: 0,
          capsuleId: capsule.capsuleId,
          ttlSec: inner.ttlSec,
          expiresAt: capsule.expiresAt,
          updatedAt: Date.now(),
        }
        await storage.putMessage(incoming)

        // Ensure sender is easily replyable in contacts if they have a readable name
        if (!storage.getContact(senderPk) && inner.fromName.trim()) {
          await storage.putContact({
            pubkey: senderPk,
            npub: encodeNpubSafe(senderPk),
            nickname: inner.fromName.trim().slice(0, 32),
            addedAt: Date.now(),
            updatedAt: Date.now(),
          })
        }

        refreshFromStorage()
        onLocalChangeRef.current?.()
        pushToastRef.current?.('info', `New Agmail from ${fromName}`, incoming.subject)
        return
      }

      if (inner.type === 'read_receipt') {
        const target = storage.getMessage(inner.mailId)
        if (target && target.direction === 'out' && target.toPubkey.toLowerCase() === senderPk) {
          const updated: AmailMessage = {
            ...target,
            deliveryStatus: 'read',
            deliveredAt: target.deliveredAt ?? inner.readAt,
            readAt: target.readAt ?? inner.readAt,
            updatedAt: Date.now(),
          }
          await storage.putMessage(updated)
          refreshFromStorage()
          onLocalChangeRef.current?.()
        }
      }
    },
    [identityManager, refreshFromStorage, resolveDisplayName]
  )

  const handleAckObserved = useCallback(
    async (ack: AmailAckTombstone) => {
      const storage = storageRef.current
      if (!storage) return
      const all = storage.getAllMessages()
      let changed = false
      for (const msg of all) {
        if (
          msg.direction === 'out' &&
          msg.capsuleId === ack.capsuleId &&
          DELIVERY_RANK[msg.deliveryStatus] < DELIVERY_RANK.delivered
        ) {
          await storage.putMessage({
            ...msg,
            deliveryStatus: 'delivered',
            deliveredAt: msg.deliveredAt ?? ack.ackedAt,
            updatedAt: Date.now(),
          })
          changed = true
        }
      }
      if (changed) {
        refreshFromStorage()
        onLocalChangeRef.current?.()
      }
    },
    [refreshFromStorage]
  )

  const handleCapsuleRelayed = useCallback(
    (capsuleId: string, peerCount: number) => {
      const storage = storageRef.current
      if (!storage) return
      const all = storage.getAllMessages()
      for (const msg of all) {
        if (msg.direction === 'out' && msg.capsuleId === capsuleId) {
          const nextStatus =
            msg.deliveryStatus === 'queued' ? 'relayed' : msg.deliveryStatus
          if (msg.relayedPeerCount !== peerCount || msg.deliveryStatus !== nextStatus) {
            void storage
              .putMessage({
                ...msg,
                deliveryStatus: nextStatus,
                relayedPeerCount: Math.max(msg.relayedPeerCount, peerCount),
                updatedAt: Date.now(),
              })
              .then(() => refreshFromStorage())
          }
        }
      }
    },
    [refreshFromStorage]
  )

  // Initialize IndexedDB storage + Briar Mesh Node whenever identity changes
  useEffect(() => {
    let cancelled = false
    const storage = storageRef.current!

    void storage.init().then(async () => {
      if (cancelled) return
      await storage.pruneExpired()
      refreshFromStorage()

      const mesh = new AmailMeshNode({
        relayPool,
        identityManager,
        storage,
        settings: storage.getSettings(),
        turnConfig,
        callbacks: {
          onCapsuleForSelf: handleCapsuleForSelf,
          onAckObserved: handleAckObserved,
          onCapsuleRelayed: handleCapsuleRelayed,
          onStateChange: refreshFromStorage,
        },
      })
      meshRef.current = mesh
      mesh.start()
      refreshFromStorage()
    })

    return () => {
      cancelled = true
      if (meshRef.current) {
        meshRef.current.stop()
        meshRef.current = null
      }
    }
  }, [
    handleAckObserved,
    handleCapsuleForSelf,
    handleCapsuleRelayed,
    identityManager,
    masterPubkey,
    refreshFromStorage,
    relayPool,
    turnConfig,
  ])

  /* ------------------------------------------------------------------------
     Public Engine Actions
     ------------------------------------------------------------------------ */

  const updateSettings = useCallback(
    async (patch: Partial<AmailRelaySettings>) => {
      const storage = storageRef.current
      if (!storage) return
      await storage.init()
      const next = await storage.updateSettings(patch)
      meshRef.current?.updateSettings(next)
      refreshFromStorage()
      onLocalChangeRef.current?.()
    },
    [refreshFromStorage]
  )

  const sendMail = useCallback(
    async (input: AmailSendInput): Promise<AmailMessage | null> => {
      const storage = storageRef.current
      if (!storage) return null
      await storage.init()

      const resolved = resolveContactPubkeyInput(input.toPubkey)
      if (!resolved) {
        pushToastRef.current?.('error', 'Invalid Agmail recipient', 'Provide a valid npub or hex pubkey.')
        return null
      }

      const toPk = resolved.pubkey
      const myPk = identityManager.getMasterKeyMaterial().pubkey.toLowerCase()
      const curSettings = storage.getSettings()
      const ttlSec = Math.max(
        3600,
        Math.min(30 * 86_400, Math.floor(input.ttlSec ?? curSettings.defaultTtlSec))
      )
      const mailId = makeAmailId('amail')
      const threadId = input.threadId?.trim() || mailId
      const sentAt = Math.floor(Date.now() / 1000)
      const subject = input.subject.trim() || '(no subject)'
      const body = input.body.trim()
      const requestReadReceipt = input.requestReadReceipt ?? true

      const innerPayload: AmailInnerMailPayload = {
        v: 1,
        type: 'mail',
        id: mailId,
        threadId,
        inReplyTo: input.inReplyTo,
        fromName: activeNicknameRef.current,
        subject,
        body,
        sentAt,
        requestReadReceipt,
        ttlSec,
      }

      try {
        const capsule = await sealAmailCapsule({
          payload: innerPayload,
          recipientPubkey: toPk,
          identityManager,
          ttlSec,
          maxHops: curSettings.maxHops,
        })

        // Store outbound sealed capsule in relayVault so couriers can pick it up via anti-entropy
        await storage.putRelayCapsule(capsule, { ownPubkey: myPk })

        const sentMsg: AmailMessage = {
          id: mailId,
          threadId,
          inReplyTo: input.inReplyTo,
          folder: 'sent',
          direction: 'out',
          fromPubkey: myPk,
          fromNpub: encodeNpubSafe(myPk),
          fromName: activeNicknameRef.current,
          toPubkey: toPk,
          toNpub: encodeNpubSafe(toPk),
          toName: resolveDisplayName(toPk, resolved.nicknameHint),
          subject,
          body,
          sentAt,
          isRead: true,
          isStarred: false,
          requestReadReceipt,
          deliveryStatus: 'queued',
          relayHopCount: 0,
          relayedPeerCount: 0,
          capsuleId: capsule.capsuleId,
          ttlSec,
          expiresAt: capsule.expiresAt,
          updatedAt: Date.now(),
        }

        await storage.putMessage(sentMsg)

        // Delete draft if sending from a saved draft
        if (input.draftId) {
          await storage.deleteMessage(input.draftId, true)
        }

        // Dispatch immediately into WebRTC DataChannel mesh + Layer 2 ephemeral hop
        const relayed = (await meshRef.current?.publishLocalCapsule(capsule)) ?? 0
        if (relayed > 0) {
          const updated: AmailMessage = {
            ...sentMsg,
            deliveryStatus: 'relayed',
            relayedPeerCount: relayed,
            updatedAt: Date.now(),
          }
          await storage.putMessage(updated)
          refreshFromStorage()
          onLocalChangeRef.current?.()
          pushToastRef.current?.(
            'success',
            'Agmail sealed & dispatched',
            `Relayed to ${relayed} mesh courier${relayed === 1 ? '' : 's'}`
          )
          return updated
        }

        refreshFromStorage()
        onLocalChangeRef.current?.()
        pushToastRef.current?.(
          'success',
          'Agmail queued in mesh vault',
          'Will relay automatically when couriers connect'
        )
        return sentMsg
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Failed to encrypt Agmail.'
        pushToastRef.current?.('error', 'Failed to send Agmail', msg)
        return null
      }
    },
    [identityManager, refreshFromStorage, resolveDisplayName]
  )

  const saveDraft = useCallback(
    async (draft: AmailDraftInput): Promise<AmailMessage> => {
      const storage = storageRef.current!
      await storage.init()

      const myPk = identityManager.getMasterKeyMaterial().pubkey.toLowerCase()
      const curSettings = storage.getSettings()
      const resolved = draft.toPubkey ? resolveContactPubkeyInput(draft.toPubkey) : null
      const toPk = resolved?.pubkey ?? ''
      const id = draft.id || makeAmailId('draft')
      const nowSec = Math.floor(Date.now() / 1000)
      const ttlSec = draft.ttlSec ?? curSettings.defaultTtlSec

      const entry: AmailMessage = {
        id,
        threadId: draft.threadId || id,
        inReplyTo: draft.inReplyTo,
        folder: 'drafts',
        direction: 'out',
        fromPubkey: myPk,
        fromNpub: encodeNpubSafe(myPk),
        fromName: activeNicknameRef.current,
        toPubkey: toPk,
        toNpub: toPk ? encodeNpubSafe(toPk) : '',
        toName: toPk ? resolveDisplayName(toPk, resolved?.nicknameHint) : '',
        subject: draft.subject,
        body: draft.body,
        sentAt: nowSec,
        isRead: true,
        isStarred: false,
        requestReadReceipt: draft.requestReadReceipt ?? true,
        deliveryStatus: 'draft',
        relayHopCount: 0,
        relayedPeerCount: 0,
        ttlSec,
        expiresAt: nowSec + ttlSec,
        updatedAt: Date.now(),
      }

      await storage.putMessage(entry)
      refreshFromStorage()
      onLocalChangeRef.current?.()
      return entry
    },
    [identityManager, refreshFromStorage, resolveDisplayName]
  )

  const deleteDraft = useCallback(
    async (id: string) => {
      const storage = storageRef.current
      if (!storage) return
      await storage.init()
      await storage.deleteMessage(id, true)
      refreshFromStorage()
      onLocalChangeRef.current?.()
    },
    [refreshFromStorage]
  )

  const markRead = useCallback(
    async (id: string, isRead: boolean) => {
      const storage = storageRef.current
      if (!storage) return
      await storage.init()
      const existing = storage.getMessage(id)
      if (!existing) return

      const curSettings = storage.getSettings()
      let readAt = existing.readAt
      const shouldEmitReadReceipt =
        isRead &&
        existing.direction === 'in' &&
        existing.requestReadReceipt &&
        curSettings.sendReadReceipts &&
        !existing.readAt

      if (shouldEmitReadReceipt) {
        readAt = Math.floor(Date.now() / 1000)
      }

      const updated: AmailMessage = {
        ...existing,
        isRead,
        readAt,
        updatedAt: Date.now(),
      }
      await storage.putMessage(updated)
      refreshFromStorage()
      onLocalChangeRef.current?.()

      if (shouldEmitReadReceipt && readAt) {
        try {
          const receiptPayload: AmailInnerReadReceiptPayload = {
            v: 1,
            type: 'read_receipt',
            mailId: existing.id,
            threadId: existing.threadId,
            readAt,
            readerName: activeNicknameRef.current,
          }
          const myPk = identityManager.getMasterKeyMaterial().pubkey.toLowerCase()
          const capsule = await sealAmailCapsule({
            payload: receiptPayload,
            recipientPubkey: existing.fromPubkey,
            identityManager,
            ttlSec: Math.min(curSettings.defaultTtlSec, 3 * 86_400),
            maxHops: curSettings.maxHops,
          })
          await storage.putRelayCapsule(capsule, { ownPubkey: myPk })
          await meshRef.current?.publishLocalCapsule(capsule)
          refreshFromStorage()
        } catch {
          // Non-fatal if read receipt sealing fails
        }
      }
    },
    [identityManager, refreshFromStorage]
  )

  const toggleStar = useCallback(
    async (id: string) => {
      const storage = storageRef.current
      if (!storage) return
      await storage.init()
      const existing = storage.getMessage(id)
      if (!existing) return
      await storage.putMessage({
        ...existing,
        isStarred: !existing.isStarred,
        updatedAt: Date.now(),
      })
      refreshFromStorage()
      onLocalChangeRef.current?.()
    },
    [refreshFromStorage]
  )

  const moveToFolder = useCallback(
    async (id: string, folder: AmailFolder) => {
      const storage = storageRef.current
      if (!storage) return
      await storage.init()
      const existing = storage.getMessage(id)
      if (!existing) return
      if (folder === 'starred') {
        await storage.putMessage({
          ...existing,
          isStarred: true,
          updatedAt: Date.now(),
        })
      } else {
        await storage.putMessage({
          ...existing,
          folder,
          updatedAt: Date.now(),
        })
      }
      refreshFromStorage()
      onLocalChangeRef.current?.()
    },
    [refreshFromStorage]
  )

  const deletePermanently = useCallback(
    async (id: string) => {
      const storage = storageRef.current
      if (!storage) return
      await storage.init()
      await storage.deleteMessage(id, true)
      refreshFromStorage()
      onLocalChangeRef.current?.()
    },
    [refreshFromStorage]
  )

  const addContact = useCallback(
    async (
      pubkeyOrNpubOrDmLink: string,
      nickname?: string,
      notes?: string
    ): Promise<AmailContact | null> => {
      const storage = storageRef.current
      if (!storage) return null
      await storage.init()

      const resolved = resolveContactPubkeyInput(pubkeyOrNpubOrDmLink)
      if (!resolved) {
        pushToastRef.current?.(
          'error',
          'Invalid contact key',
          'Paste an npub1…, 64-char hex pubkey, or Agnostr #dm link.'
        )
        return null
      }

      const pk = resolved.pubkey
      const existing = storage.getContact(pk)
      const now = Date.now()
      const contact: AmailContact = {
        pubkey: pk,
        npub: encodeNpubSafe(pk),
        nickname: (
          nickname?.trim() ||
          resolved.nicknameHint ||
          existing?.nickname ||
          formatShortPubkey(pk)
        ).slice(0, 40),
        notes: notes !== undefined ? notes.trim() || undefined : existing?.notes,
        addedAt: existing?.addedAt ?? now,
        updatedAt: now,
        isTrustedPeer: trustedMapRef.current.has(pk),
      }
      await storage.putContact(contact)
      refreshFromStorage()
      onLocalChangeRef.current?.()
      pushToastRef.current?.('success', `Saved contact: ${contact.nickname}`)
      return contact
    },
    [refreshFromStorage]
  )

  const updateContact = useCallback(
    async (pubkey: string, patch: { nickname?: string; notes?: string }) => {
      const storage = storageRef.current
      if (!storage) return
      await storage.init()
      const pk = pubkey.toLowerCase()
      const existing = storage.getContact(pk)
      const now = Date.now()
      const updated: AmailContact = {
        pubkey: pk,
        npub: existing?.npub || encodeNpubSafe(pk),
        nickname: (
          patch.nickname?.trim() ||
          existing?.nickname ||
          formatShortPubkey(pk)
        ).slice(0, 40),
        notes: patch.notes !== undefined ? patch.notes.trim() || undefined : existing?.notes,
        addedAt: existing?.addedAt ?? now,
        updatedAt: now,
        isTrustedPeer: trustedMapRef.current.has(pk),
      }
      await storage.putContact(updated)
      refreshFromStorage()
      onLocalChangeRef.current?.()
    },
    [refreshFromStorage]
  )

  const removeContact = useCallback(
    async (pubkey: string) => {
      const storage = storageRef.current
      if (!storage) return
      await storage.init()
      await storage.deleteContact(pubkey.toLowerCase(), true)
      refreshFromStorage()
      onLocalChangeRef.current?.()
    },
    [refreshFromStorage]
  )

  const syncMeshNow = useCallback(async () => {
    if (!meshRef.current) return
    await meshRef.current.syncNow()
    refreshFromStorage()
  }, [refreshFromStorage])

  const pruneExpired = useCallback(async (): Promise<number> => {
    const storage = storageRef.current
    if (!storage) return 0
    await storage.init()
    const removed = await storage.pruneExpired()
    refreshFromStorage()
    return removed
  }, [refreshFromStorage])

  const purgeRelayVault = useCallback(async () => {
    const storage = storageRef.current
    if (!storage) return
    await storage.init()
    await storage.purgeRelayVault()
    refreshFromStorage()
    pushToastRef.current?.('info', 'Relay vault purged', 'Your own Agmail messages remain untouched.')
  }, [refreshFromStorage])

  /* ------------------------------------------------------------------------
     Multi-Device Conflict-Free Sync Export / Merge (for `engine.deviceSync`)
     ------------------------------------------------------------------------ */

  const exportSyncState = useCallback((): AmailSyncSnapshot => {
    const storage = storageRef.current
    if (!storage) {
      return {
        version: 1,
        updatedAt: Date.now(),
        messages: [],
        deletedMessageIds: {},
        contacts: [],
        removedContactPubkeys: {},
      }
    }
    const snap = storage.getSnapshot()
    return {
      version: 1,
      updatedAt: Date.now(),
      messages: snap.messages.slice(0, 200),
      deletedMessageIds: snap.deletedMessageIds,
      contacts: snap.contacts,
      removedContactPubkeys: snap.removedContactPubkeys,
      settings: snap.settings,
    }
  }, [])

  const mergeSyncState = useCallback(
    async (remote: AmailSyncSnapshot): Promise<boolean> => {
      const storage = storageRef.current
      if (!storage || !remote || remote.version !== 1) return false
      await storage.init()

      let changed = false
      const localSnap = storage.getSnapshot()
      const mergedDeleted = {
        ...localSnap.deletedMessageIds,
        ...(remote.deletedMessageIds ?? {}),
      }
      const mergedRemovedContacts = {
        ...localSnap.removedContactPubkeys,
        ...(remote.removedContactPubkeys ?? {}),
      }
      await storage.mergeSyncTombstones(mergedDeleted, mergedRemovedContacts)

      // Merge messages with LWW + monotonic deliveryStatus progression + delete tombstones
      for (const rm of remote.messages ?? []) {
        if (!rm || !rm.id) continue
        const deletedAt = mergedDeleted[rm.id] ?? 0
        if (deletedAt > (rm.updatedAt ?? rm.sentAt * 1000)) {
          if (storage.getMessage(rm.id)) {
            await storage.deleteMessage(rm.id, false)
            changed = true
          }
          continue
        }
        const local = storage.getMessage(rm.id)
        if (!local) {
          await storage.putMessage(rm)
          changed = true
          continue
        }
        const remoteNewer = (rm.updatedAt ?? 0) > (local.updatedAt ?? 0)
        const bestStatus =
          DELIVERY_RANK[rm.deliveryStatus] > DELIVERY_RANK[local.deliveryStatus]
            ? rm.deliveryStatus
            : local.deliveryStatus
        const merged: AmailMessage = {
          ...(remoteNewer ? rm : local),
          deliveryStatus: bestStatus,
          deliveredAt: local.deliveredAt ?? rm.deliveredAt,
          readAt: local.readAt ?? rm.readAt,
          isRead: remoteNewer ? rm.isRead : local.isRead || rm.isRead,
          relayedPeerCount: Math.max(local.relayedPeerCount, rm.relayedPeerCount),
          updatedAt: Math.max(local.updatedAt ?? 0, rm.updatedAt ?? 0),
        }
        if (JSON.stringify(merged) !== JSON.stringify(local)) {
          await storage.putMessage(merged)
          changed = true
        }
      }

      // Apply remote deletions to local messages
      for (const [delId, delTs] of Object.entries(remote.deletedMessageIds ?? {})) {
        const local = storage.getMessage(delId)
        if (local && delTs > (local.updatedAt ?? local.sentAt * 1000)) {
          await storage.deleteMessage(delId, false)
          changed = true
        }
      }

      // Merge contacts
      for (const rc of remote.contacts ?? []) {
        if (!rc || !rc.pubkey) continue
        const pk = rc.pubkey.toLowerCase()
        const removedAt = mergedRemovedContacts[pk] ?? 0
        const rcTs = rc.updatedAt ?? rc.addedAt
        if (removedAt > rcTs) {
          if (storage.getContact(pk)) {
            await storage.deleteContact(pk, false)
            changed = true
          }
          continue
        }
        const local = storage.getContact(pk)
        if (!local || rcTs > (local.updatedAt ?? local.addedAt)) {
          await storage.putContact(rc)
          changed = true
        }
      }

      for (const [remPk, remTs] of Object.entries(remote.removedContactPubkeys ?? {})) {
        const pk = remPk.toLowerCase()
        const local = storage.getContact(pk)
        if (local && remTs > (local.updatedAt ?? local.addedAt)) {
          await storage.deleteContact(pk, false)
          changed = true
        }
      }

      if (changed) {
        refreshFromStorage()
      }
      return changed
    },
    [refreshFromStorage]
  )

  const resetAll = useCallback(async () => {
    if (meshRef.current) {
      meshRef.current.stop()
      meshRef.current = null
    }
    if (storageRef.current) {
      await storageRef.current.wipeDatabase()
    }
    setMessages([])
    setStoredContacts([])
    setRelayCapsules([])
    setTombstonesCount(0)
    setMeshPeers([])
    setStorageStats(EMPTY_STATS)
    setSettings(DEFAULT_AMAIL_RELAY_SETTINGS)
    setIsSyncing(false)
  }, [])

  const unreadInboxCount = useMemo(
    () => messages.filter((m) => m.folder === 'inbox' && !m.isRead).length,
    [messages]
  )

  return useMemo<AmailEngine>(
    () => ({
      messages,
      contacts,
      unreadInboxCount,
      relayCapsules,
      tombstonesCount,
      meshPeers,
      storageStats,
      settings,
      isSyncing,
      updateSettings,
      sendMail,
      saveDraft,
      deleteDraft,
      markRead,
      toggleStar,
      moveToFolder,
      deletePermanently,
      addContact,
      updateContact,
      removeContact,
      syncMeshNow,
      pruneExpired,
      purgeRelayVault,
      exportSyncState,
      mergeSyncState,
      resetAll,
    }),
    [
      messages,
      contacts,
      unreadInboxCount,
      relayCapsules,
      tombstonesCount,
      meshPeers,
      storageStats,
      settings,
      isSyncing,
      updateSettings,
      sendMail,
      saveDraft,
      deleteDraft,
      markRead,
      toggleStar,
      moveToFolder,
      deletePermanently,
      addContact,
      updateContact,
      removeContact,
      syncMeshNow,
      pruneExpired,
      purgeRelayVault,
      exportSyncState,
      mergeSyncState,
      resetAll,
    ]
  )
}
