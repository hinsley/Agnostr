import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { TurnServerConfig } from '../types/calls.ts'
import type { PushPokePayload } from '../types/notifications.ts'
import type { ToastLevel, TrustedPeerEntry } from '../types/protocol.ts'
import {
  DEFAULT_AMAIL_RELAY_SETTINGS,
  type AmailAckTombstone,
  type AmailAttachment,
  type AmailAttachmentKind,
  type AmailBuiltinFolder,
  type AmailContact,
  type AmailCustomFolder,
  type AmailDraftInput,
  type AmailEngine,
  type AmailFolder,
  type AmailFolderSortMode,
  type AmailMeshPeer,
  type AmailMessage,
  type AmailRecipient,
  type AmailRelayCapsuleMeta,
  type AmailRelaySettings,
  type AmailSealedCapsule,
  type AmailSendInput,
  type AmailStorageStats,
  type AmailSyncSnapshot,
} from '../types/amail.ts'
import {
  createSignedAckTombstone,
  sanitizeAmailAttachments,
  sanitizeAttachmentFilename,
  sealAmailCapsule,
  unsealAmailCapsule,
  type AmailInnerMailPayload,
  type AmailInnerReadReceiptPayload,
} from '../lib/amailCrypto.ts'
import { AmailMeshNode } from '../lib/amailMesh.ts'
import { AmailStorage } from '../lib/amailStorage.ts'
import {
  cleanMimeType,
  computeSha256HexAsync,
  decryptMediaBytesAesGcm,
  DEFAULT_BLOSSOM_SERVERS,
  encryptMediaBytesAesGcm,
  MAX_MEDIA_BLOB_BYTES,
  normalizeBlossomServerUrl,
  uploadBlobToBlossom,
} from '../lib/blossom.ts'
import {
  isSupportedImageFile,
  prepareImageFile,
  revokeImagePreviewUrl,
} from '../lib/imageProcessor.ts'
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
  blossomServers?: readonly string[]
  turnConfig?: TurnServerConfig | null
  onLocalChange?: () => void
  onIncomingMail?: (input: {
    id: string
    senderPubkey: string
    senderName: string
    subject: string
    recipientRole: 'to' | 'cc' | 'bcc'
  }) => boolean | void
  onNotifyPushPoke?: (payload: PushPokePayload) => void
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

const BUILTIN_FOLDERS: ReadonlySet<string> = new Set([
  'inbox',
  'starred',
  'sent',
  'drafts',
  'archive',
  'trash',
])

const MAX_RECIPIENTS_PER_MAIL = 50
const MAX_ATTACHMENT_CACHE_ENTRIES = 60

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return copy.buffer
}

async function fetchCiphertextWithTimeout(url: string, timeoutMs = 20_000): Promise<Uint8Array> {
  const controller = new AbortController()
  const timer = window.setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, { method: 'GET', mode: 'cors', signal: controller.signal })
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`)
    }
    const contentLength = Number.parseInt(res.headers.get('content-length') ?? '', 10)
    if (Number.isFinite(contentLength) && contentLength > MAX_MEDIA_BLOB_BYTES) {
      throw new Error('Attachment exceeds maximum allowed download size.')
    }
    const rawBuf = await res.arrayBuffer()
    if (rawBuf.byteLength === 0) {
      throw new Error('Downloaded attachment blob is empty.')
    }
    if (rawBuf.byteLength > MAX_MEDIA_BLOB_BYTES) {
      throw new Error('Attachment exceeds maximum allowed download size.')
    }
    return new Uint8Array(rawBuf)
  } finally {
    window.clearTimeout(timer)
  }
}

function isBuiltinFolder(folder: string): folder is AmailBuiltinFolder {
  return BUILTIN_FOLDERS.has(folder)
}

function sanitizeFolderName(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim().slice(0, 40)
}

function makeCustomFolderId(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24)
  const rand = new Uint8Array(4)
  crypto.getRandomValues(rand)
  let hex = ''
  for (let i = 0; i < rand.length; i++) {
    hex += rand[i].toString(16).padStart(2, '0')
  }
  return `folder:${slug || 'list'}-${hex}`
}

function isRecipientOfMessage(msg: AmailMessage, pubkey: string): boolean {
  const pk = pubkey.toLowerCase()
  if (msg.toPubkey && msg.toPubkey.toLowerCase() === pk) return true
  if (msg.toRecipients?.some((r) => r.pubkey.toLowerCase() === pk)) return true
  if (msg.ccRecipients?.some((r) => r.pubkey.toLowerCase() === pk)) return true
  if (msg.bccRecipients?.some((r) => r.pubkey.toLowerCase() === pk)) return true
  return false
}

function mergeUniqueStrings(a?: string[], b?: string[]): string[] | undefined {
  if (!a?.length && !b?.length) return undefined
  const set = new Set<string>()
  if (a) {
    for (const s of a) if (s) set.add(s)
  }
  if (b) {
    for (const s of b) if (s) set.add(s)
  }
  return set.size > 0 ? Array.from(set) : undefined
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

  const onIncomingMailRef = useRef(options.onIncomingMail)
  onIncomingMailRef.current = options.onIncomingMail

  const onNotifyPushPokeRef = useRef(options.onNotifyPushPoke)
  onNotifyPushPokeRef.current = options.onNotifyPushPoke

  const activeNicknameRef = useRef(activeNickname)
  activeNicknameRef.current = activeNickname

  const blockedSetRef = useRef<Set<string>>(new Set())
  blockedSetRef.current = new Set(blockedPubkeys.map((pk) => pk.toLowerCase()))

  const trustedMapRef = useRef<Map<string, TrustedPeerEntry>>(new Map())
  trustedMapRef.current = new Map(trustedPubkeys.map((t) => [t.pubkey.toLowerCase(), t]))

  const blossomServersRef = useRef<readonly string[]>(DEFAULT_BLOSSOM_SERVERS)
  blossomServersRef.current =
    options.blossomServers && options.blossomServers.length > 0
      ? options.blossomServers
      : DEFAULT_BLOSSOM_SERVERS

  const attachmentBlobCacheRef = useRef<Map<string, Blob>>(new Map())
  const attachmentInflightRef = useRef<Map<string, Promise<Blob>>>(new Map())

  const storageRef = useRef<AmailStorage | null>(null)
  if (!storageRef.current) {
    storageRef.current = new AmailStorage()
  }

  const meshRef = useRef<AmailMeshNode | null>(null)

  const [messages, setMessages] = useState<AmailMessage[]>([])
  const [storedContacts, setStoredContacts] = useState<AmailContact[]>([])
  const [customFolders, setCustomFolders] = useState<AmailCustomFolder[]>([])
  const [folderSortMode, setFolderSortMode] = useState<AmailFolderSortMode>('manual')
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
    setCustomFolders(snap.customFolders)
    setFolderSortMode(snap.folderSortMode)
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

  const toRecipientRecord = useCallback(
    (pubkey: string, nicknameHint?: string): AmailRecipient => {
      const pk = pubkey.toLowerCase()
      const myPk = identityManager.getMasterKeyMaterial().pubkey.toLowerCase()
      const nickname =
        pk === myPk
          ? activeNicknameRef.current?.trim() || 'You'
          : resolveDisplayName(pk, nicknameHint)
      return {
        pubkey: pk,
        npub: encodeNpubSafe(pk),
        nickname,
      }
    },
    [identityManager, resolveDisplayName]
  )

  const resolveRecipientGroups = useCallback(
    (input: {
      toPubkey?: string
      toPubkeys?: string[]
      ccPubkeys?: string[]
      bccPubkeys?: string[]
    }): {
      to: AmailRecipient[]
      cc: AmailRecipient[]
      bcc: AmailRecipient[]
      all: AmailRecipient[]
      invalidInputs: string[]
    } => {
      const seen = new Set<string>()
      const invalidInputs: string[] = []

      const resolveList = (rawList: string[]): AmailRecipient[] => {
        const out: AmailRecipient[] = []
        for (const raw of rawList) {
          const trimmed = raw.trim()
          if (!trimmed) continue
          const resolved = resolveContactPubkeyInput(trimmed)
          if (!resolved) {
            invalidInputs.push(trimmed)
            continue
          }
          if (seen.has(resolved.pubkey)) continue
          seen.add(resolved.pubkey)
          out.push(toRecipientRecord(resolved.pubkey, resolved.nicknameHint))
        }
        return out
      }

      const rawTo: string[] = []
      if (Array.isArray(input.toPubkeys)) {
        rawTo.push(...input.toPubkeys)
      }
      if (input.toPubkey?.trim()) {
        rawTo.push(input.toPubkey)
      }

      // Priority: To > CC > BCC so no recipient receives duplicate capsules
      const to = resolveList(rawTo)
      const cc = resolveList(Array.isArray(input.ccPubkeys) ? input.ccPubkeys : [])
      const bcc = resolveList(Array.isArray(input.bccPubkeys) ? input.bccPubkeys : [])
      return {
        to,
        cc,
        bcc,
        all: [...to, ...cc, ...bcc],
        invalidInputs,
      }
    },
    [toRecipientRecord]
  )

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
        const hasRecipientHeaders = inner.to !== undefined || inner.cc !== undefined
        const toRecipients: AmailRecipient[] | undefined =
          inner.to && inner.to.length > 0
            ? inner.to.map((r) => toRecipientRecord(r.pubkey, r.name))
            : undefined
        const ccRecipients: AmailRecipient[] | undefined =
          inner.cc && inner.cc.length > 0
            ? inner.cc.map((r) => toRecipientRecord(r.pubkey, r.name))
            : undefined
        const inTo = (inner.to ?? []).some((r) => r.pubkey === myPk)
        const inCc = (inner.cc ?? []).some((r) => r.pubkey === myPk)
        const isBccRecipient = hasRecipientHeaders && !inTo && !inCc
        const recipientRole: 'to' | 'cc' | 'bcc' = isBccRecipient
          ? 'bcc'
          : !inTo && inCc
            ? 'cc'
            : 'to'
        const primaryTo = toRecipients?.[0]

        const incoming: AmailMessage = {
          id: inner.id,
          threadId: inner.threadId || inner.id,
          inReplyTo: inner.inReplyTo,
          folder: 'inbox',
          direction: 'in',
          fromPubkey: senderPk,
          fromNpub: encodeNpubSafe(senderPk),
          fromName,
          toPubkey: primaryTo?.pubkey ?? myPk,
          toNpub: primaryTo?.npub ?? encodeNpubSafe(myPk),
          toName: primaryTo?.nickname ?? activeNicknameRef.current,
          ...(toRecipients ? { toRecipients } : {}),
          ...(ccRecipients ? { ccRecipients } : {}),
          ...(isBccRecipient ? { isBccRecipient: true } : {}),
          subject: inner.subject || '(no subject)',
          body: inner.body,
          ...(inner.attachments && inner.attachments.length > 0
            ? { attachments: inner.attachments }
            : {}),
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
        const shouldToast = onIncomingMailRef.current?.({
          id: incoming.id,
          senderPubkey: senderPk,
          senderName: fromName,
          subject: incoming.subject,
          recipientRole,
        })
        if (shouldToast !== false) {
          pushToastRef.current?.(
            'info',
            recipientRole === 'to'
              ? `New Agmail from ${fromName}`
              : `New Agmail (${recipientRole.toUpperCase()}) from ${fromName}`,
            incoming.subject
          )
        }
        return
      }

      if (inner.type === 'read_receipt') {
        const target = storage.getMessage(inner.mailId)
        if (target && target.direction === 'out' && isRecipientOfMessage(target, senderPk)) {
          const nextReadPubkeys = mergeUniqueStrings(target.readPubkeys, [senderPk])
          const nextDeliveredPubkeys = mergeUniqueStrings(target.deliveredPubkeys, [senderPk])
          const updated: AmailMessage = {
            ...target,
            deliveryStatus: 'read',
            deliveredAt: target.deliveredAt ?? inner.readAt,
            readAt: target.readAt ?? inner.readAt,
            ...(nextDeliveredPubkeys ? { deliveredPubkeys: nextDeliveredPubkeys } : {}),
            ...(nextReadPubkeys ? { readPubkeys: nextReadPubkeys } : {}),
            updatedAt: Date.now(),
          }
          await storage.putMessage(updated)
          refreshFromStorage()
          onLocalChangeRef.current?.()
        }
      }
    },
    [identityManager, refreshFromStorage, resolveDisplayName, toRecipientRecord]
  )

  const handleAckObserved = useCallback(
    async (ack: AmailAckTombstone) => {
      const storage = storageRef.current
      if (!storage) return
      const all = storage.getAllMessages()
      const ackPk = ack.pubkey.toLowerCase()
      let changed = false
      for (const msg of all) {
        const matchesCapsule =
          msg.capsuleId === ack.capsuleId ||
          Boolean(msg.capsuleIds?.includes(ack.capsuleId))
        if (msg.direction === 'out' && matchesCapsule) {
          const prevDelivered = msg.deliveredPubkeys ?? []
          const hasAckPk = prevDelivered.includes(ackPk)
          const needsStatusAdvance =
            DELIVERY_RANK[msg.deliveryStatus] < DELIVERY_RANK.delivered
          if (needsStatusAdvance || !hasAckPk) {
            await storage.putMessage({
              ...msg,
              deliveryStatus: needsStatusAdvance ? 'delivered' : msg.deliveryStatus,
              deliveredAt: msg.deliveredAt ?? ack.ackedAt,
              deliveredPubkeys: hasAckPk ? prevDelivered : [...prevDelivered, ackPk],
              updatedAt: Date.now(),
            })
            changed = true
          }
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
        const matchesCapsule =
          msg.capsuleId === capsuleId || Boolean(msg.capsuleIds?.includes(capsuleId))
        if (msg.direction === 'out' && matchesCapsule) {
          const nextStatus =
            msg.deliveryStatus === 'queued' ? 'relayed' : msg.deliveryStatus
          if (msg.relayedPeerCount < peerCount || msg.deliveryStatus !== nextStatus) {
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

  const cacheAttachmentBlob = useCallback((cacheKey: string, blob: Blob) => {
    const cache = attachmentBlobCacheRef.current
    if (cache.has(cacheKey)) {
      cache.delete(cacheKey)
    } else if (cache.size >= MAX_ATTACHMENT_CACHE_ENTRIES) {
      const oldestKey = cache.keys().next().value
      if (oldestKey !== undefined) {
        cache.delete(oldestKey)
      }
    }
    cache.set(cacheKey, blob)
  }, [])

  const uploadAttachment = useCallback(
    async (
      file: File | Blob,
      opts?: {
        kind?: AmailAttachmentKind
        name?: string
        width?: number
        height?: number
        durationSec?: number
        peaks?: number[]
      }
    ): Promise<AmailAttachment> => {
      if (!file || file.size <= 0) {
        throw new Error('Cannot attach an empty file.')
      }

      const rawMime = cleanMimeType(file.type || '', 'application/octet-stream')
      const inferredName = sanitizeAttachmentFilename(
        opts?.name ?? (file instanceof File ? file.name : undefined)
      )
      const isSvg = rawMime === 'image/svg+xml'
      const kind: AmailAttachmentKind =
        opts?.kind === 'image' || opts?.kind === 'voice' || opts?.kind === 'file'
          ? opts.kind
          : !isSvg &&
              (rawMime.startsWith('image/') ||
                (file instanceof File && isSupportedImageFile(file)))
            ? 'image'
            : 'file'

      let blobToEncrypt: Blob = file
      let finalMime = rawMime
      let finalName = inferredName
      let width =
        typeof opts?.width === 'number' && Number.isFinite(opts.width) && opts.width > 0
          ? Math.floor(opts.width)
          : undefined
      let height =
        typeof opts?.height === 'number' && Number.isFinite(opts.height) && opts.height > 0
          ? Math.floor(opts.height)
          : undefined

      if (kind === 'image' && rawMime !== 'image/gif' && !isSvg) {
        const asFile =
          file instanceof File
            ? file
            : new File([file], finalName || 'image.png', { type: rawMime || 'image/png' })
        try {
          const prepared = await prepareImageFile(asFile)
          blobToEncrypt = prepared.blob
          finalMime = prepared.mime
          width = prepared.width
          height = prepared.height
          if (!finalName) {
            finalName = sanitizeAttachmentFilename(prepared.fileName)
          }
          revokeImagePreviewUrl(prepared)
        } catch {
          // Graceful fallback for non-canvas/unsupported image formats (still bounded by MAX_MEDIA_BLOB_BYTES)
        }
      }

      const plaintextBytes = new Uint8Array(await blobToEncrypt.arrayBuffer())
      if (plaintextBytes.byteLength === 0) {
        throw new Error('Cannot attach an empty file.')
      }
      if (plaintextBytes.byteLength > MAX_MEDIA_BLOB_BYTES) {
        throw new Error('Attachment exceeds the 15 MiB maximum encrypted size limit.')
      }

      const encrypted = await encryptMediaBytesAesGcm(plaintextBytes)
      if (encrypted.ciphertext.byteLength > MAX_MEDIA_BLOB_BYTES) {
        throw new Error('Encrypted attachment exceeds the 15 MiB Blossom size limit.')
      }

      const activeBlossomServers =
        blossomServersRef.current.length > 0
          ? blossomServersRef.current
          : DEFAULT_BLOSSOM_SERVERS

      const uploaded = await uploadBlobToBlossom({
        bytes: encrypted.ciphertext,
        mime: 'application/octet-stream',
        servers: activeBlossomServers,
        signAuthEvent: (tpl) => identityManager.signEvent(tpl),
      })

      const uploadedUrl = uploaded.url.trim()
      let validatedHttpsUrl = ''
      try {
        const parsed = new URL(uploadedUrl)
        if (parsed.protocol === 'https:') {
          validatedHttpsUrl = parsed.toString()
        }
      } catch {
        // Handled below
      }
      if (!validatedHttpsUrl) {
        throw new Error('Blossom server returned a non-HTTPS attachment URL.')
      }

      const durationSec =
        typeof opts?.durationSec === 'number' &&
        Number.isFinite(opts.durationSec) &&
        opts.durationSec > 0
          ? Math.min(86_400, Math.round(opts.durationSec * 100) / 100)
          : undefined

      let peaks: number[] | undefined
      if (Array.isArray(opts?.peaks) && opts.peaks.length > 0) {
        const clamped: number[] = []
        for (const v of opts.peaks.slice(0, 64)) {
          if (typeof v !== 'number' || !Number.isFinite(v)) continue
          const c = Math.max(0, Math.min(1, v))
          clamped.push(Math.round(c * 1000) / 1000)
        }
        if (clamped.length > 0) peaks = clamped
      }

      const cleanMime = cleanMimeType(finalMime, 'application/octet-stream').slice(0, 120)
      const sha256 = uploaded.sha256.toLowerCase()
      const attachment: AmailAttachment = {
        id: makeAmailId('att'),
        kind,
        url: validatedHttpsUrl,
        sha256,
        mime: cleanMime,
        size: plaintextBytes.byteLength,
        ...(finalName ? { name: finalName } : {}),
        encryption: encrypted.encryption,
        ...(width !== undefined ? { width } : {}),
        ...(height !== undefined ? { height } : {}),
        ...(durationSec !== undefined ? { durationSec } : {}),
        ...(peaks ? { peaks } : {}),
      }

      const cacheKey = `${sha256}:${encrypted.encryption.plaintextSha256 ?? ''}`
      cacheAttachmentBlob(cacheKey, new Blob([toArrayBuffer(plaintextBytes)], { type: cleanMime }))
      return attachment
    },
    [identityManager, cacheAttachmentBlob]
  )

  const downloadAttachment = useCallback(
    async (attachment: AmailAttachment): Promise<Blob> => {
      const sanitized = sanitizeAmailAttachments([attachment])?.[0]
      if (!sanitized) {
        throw new Error('Malformed or unsafe Agmail attachment descriptor.')
      }

      const sha256 = sanitized.sha256.toLowerCase()
      const cacheKey = `${sha256}:${sanitized.encryption.plaintextSha256 ?? ''}`
      const cached = attachmentBlobCacheRef.current.get(cacheKey)
      if (cached) {
        cacheAttachmentBlob(cacheKey, cached)
        return cached
      }

      const inflight = attachmentInflightRef.current.get(cacheKey)
      if (inflight) {
        return await inflight
      }

      const task = (async (): Promise<Blob> => {
        const candidateUrls: string[] = [sanitized.url]
        const seen = new Set<string>([sanitized.url])
        const mirrorServers = [...blossomServersRef.current, ...DEFAULT_BLOSSOM_SERVERS]
        for (const rawServer of mirrorServers) {
          const normalized = normalizeBlossomServerUrl(rawServer)
          if (!normalized || !normalized.startsWith('https://')) continue
          const mirrorUrl = `${normalized}/${sha256}`
          if (!seen.has(mirrorUrl)) {
            seen.add(mirrorUrl)
            candidateUrls.push(mirrorUrl)
          }
        }

        const errors: string[] = []
        for (const candidateUrl of candidateUrls) {
          try {
            const ciphertext = await fetchCiphertextWithTimeout(candidateUrl, 20_000)
            const actualHash = await computeSha256HexAsync(ciphertext)
            if (actualHash !== sha256) {
              errors.push('SHA-256 mismatch')
              continue
            }
            const plaintext = await decryptMediaBytesAesGcm(ciphertext, sanitized.encryption)
            const blob = new Blob([toArrayBuffer(plaintext)], {
              type: cleanMimeType(sanitized.mime),
            })
            cacheAttachmentBlob(cacheKey, blob)
            return blob
          } catch (err) {
            errors.push(err instanceof Error ? err.message : 'download error')
          }
        }

        throw new Error(
          `Failed to download encrypted attachment (${errors.slice(0, 3).join('; ')})`
        )
      })().finally(() => {
        attachmentInflightRef.current.delete(cacheKey)
      })

      attachmentInflightRef.current.set(cacheKey, task)
      return await task
    },
    [cacheAttachmentBlob]
  )

  const sendMail = useCallback(
    async (input: AmailSendInput): Promise<AmailMessage | null> => {
      const storage = storageRef.current
      if (!storage) return null
      await storage.init()

      const groups = resolveRecipientGroups({
        toPubkey: input.toPubkey,
        toPubkeys: input.toPubkeys,
        ccPubkeys: input.ccPubkeys,
        bccPubkeys: input.bccPubkeys,
      })

      if (groups.invalidInputs.length > 0) {
        pushToastRef.current?.(
          'error',
          'Invalid Agmail recipient',
          `Could not resolve: ${groups.invalidInputs[0].slice(0, 32)}`
        )
        return null
      }

      if (groups.all.length === 0) {
        pushToastRef.current?.(
          'error',
          'Invalid Agmail recipient',
          'Provide at least one valid npub or hex pubkey.'
        )
        return null
      }

      if (groups.all.length > MAX_RECIPIENTS_PER_MAIL) {
        pushToastRef.current?.(
          'error',
          'Too many recipients',
          `Agmail supports up to ${MAX_RECIPIENTS_PER_MAIL} recipients per message.`
        )
        return null
      }

      const myPk = identityManager.getMasterKeyMaterial().pubkey.toLowerCase()
      const primary = groups.to[0] ?? groups.cc[0] ?? groups.bcc[0]
      const includesSelf = groups.all.some((r) => r.pubkey === myPk)
      const selfIsOnlyInBcc =
        groups.bcc.some((r) => r.pubkey === myPk) &&
        !groups.to.some((r) => r.pubkey === myPk) &&
        !groups.cc.some((r) => r.pubkey === myPk)
      const remoteRecipients = groups.all.filter((r) => r.pubkey !== myPk)

      const curSettings = storage.getSettings()
      const ttlSec = Math.max(
        3600,
        Math.min(30 * 86_400, Math.floor(input.ttlSec ?? curSettings.defaultTtlSec))
      )
      const mailId = makeAmailId('amail')
      const threadId = input.threadId?.trim() || mailId
      const sentAt = Math.floor(Date.now() / 1000)
      const rawSubject = input.subject.trim()
      const body = input.body.trim()
      const cleanAttachments = sanitizeAmailAttachments(input.attachments)
      if (!rawSubject && !body && !(cleanAttachments && cleanAttachments.length > 0)) {
        pushToastRef.current?.(
          'error',
          'Empty Agmail',
          'Add a subject, message body, or attachment before sending.'
        )
        return null
      }
      const subject = rawSubject || '(no subject)'
      const requestReadReceipt = input.requestReadReceipt ?? true

      // STRICT E2EE BCC PRIVACY: only `to` and `cc` are placed inside the wire payload;
      // `bcc` is NEVER serialized into any sealed capsule!
      const innerPayload: AmailInnerMailPayload = {
        v: 1,
        type: 'mail',
        id: mailId,
        threadId,
        inReplyTo: input.inReplyTo,
        fromName: activeNicknameRef.current,
        to: groups.to.map((r) => ({ pubkey: r.pubkey, name: r.nickname })),
        ...(groups.cc.length > 0
          ? { cc: groups.cc.map((r) => ({ pubkey: r.pubkey, name: r.nickname })) }
          : {}),
        subject,
        body,
        ...(cleanAttachments ? { attachments: cleanAttachments } : {}),
        sentAt,
        requestReadReceipt,
        ttlSec,
      }

      try {
        // Seal one distinct NIP-44 capsule per remote recipient before persisting locally
        const sealedCapsules: AmailSealedCapsule[] = []
        for (const recipient of remoteRecipients) {
          const capsule = await sealAmailCapsule({
            payload: innerPayload,
            recipientPubkey: recipient.pubkey,
            identityManager,
            ttlSec,
            maxHops: curSettings.maxHops,
          })
          sealedCapsules.push(capsule)
        }

        // Store outbound sealed capsules in relayVault so couriers can pick them up via anti-entropy
        for (const capsule of sealedCapsules) {
          await storage.putRelayCapsule(capsule, { ownPubkey: myPk })
        }

        const capsuleIds = sealedCapsules.map((c) => c.capsuleId)
        const expiresAt = sealedCapsules[0]?.expiresAt ?? sentAt + ttlSec
        const nowMs = Date.now()
        const isSelfOnly = remoteRecipients.length === 0 && includesSelf

        // Self-Mail: immediately materialize local Inbox copy without sending a network capsule to self
        if (includesSelf) {
          const selfInboxMsg: AmailMessage = {
            id: `${mailId}:self`,
            threadId,
            inReplyTo: input.inReplyTo,
            folder: 'inbox',
            direction: 'in',
            fromPubkey: myPk,
            fromNpub: encodeNpubSafe(myPk),
            fromName: activeNicknameRef.current,
            toPubkey: primary.pubkey,
            toNpub: primary.npub,
            toName: primary.nickname,
            ...(groups.to.length > 0 ? { toRecipients: groups.to } : {}),
            ...(groups.cc.length > 0 ? { ccRecipients: groups.cc } : {}),
            ...(selfIsOnlyInBcc ? { isBccRecipient: true } : {}),
            subject,
            body,
            ...(cleanAttachments ? { attachments: cleanAttachments } : {}),
            sentAt,
            receivedAt: sentAt,
            deliveredAt: sentAt,
            isRead: false,
            isStarred: false,
            requestReadReceipt,
            deliveryStatus: 'delivered',
            relayHopCount: 0,
            relayedPeerCount: 0,
            ttlSec,
            expiresAt,
            updatedAt: nowMs,
          }
          await storage.putMessage(selfInboxMsg)
        }

        const sentMsg: AmailMessage = {
          id: mailId,
          threadId,
          inReplyTo: input.inReplyTo,
          folder: 'sent',
          direction: 'out',
          fromPubkey: myPk,
          fromNpub: encodeNpubSafe(myPk),
          fromName: activeNicknameRef.current,
          toPubkey: primary.pubkey,
          toNpub: primary.npub,
          toName: primary.nickname,
          ...(groups.to.length > 0 ? { toRecipients: groups.to } : {}),
          ...(groups.cc.length > 0 ? { ccRecipients: groups.cc } : {}),
          ...(groups.bcc.length > 0 ? { bccRecipients: groups.bcc } : {}),
          subject,
          body,
          ...(cleanAttachments ? { attachments: cleanAttachments } : {}),
          sentAt,
          ...(isSelfOnly ? { deliveredAt: sentAt } : {}),
          isRead: true,
          isStarred: false,
          requestReadReceipt,
          deliveryStatus: isSelfOnly ? 'delivered' : 'queued',
          relayHopCount: 0,
          relayedPeerCount: 0,
          ...(capsuleIds[0] ? { capsuleId: capsuleIds[0] } : {}),
          ...(capsuleIds.length > 0 ? { capsuleIds } : {}),
          ...(includesSelf ? { deliveredPubkeys: [myPk] } : {}),
          ttlSec,
          expiresAt,
          updatedAt: nowMs,
        }

        await storage.putMessage(sentMsg)

        // Delete draft if sending from a saved draft
        if (input.draftId) {
          await storage.deleteMessage(input.draftId, true)
        }

        if (isSelfOnly) {
          refreshFromStorage()
          onLocalChangeRef.current?.()
          pushToastRef.current?.('success', 'Agmail delivered to your Inbox')
          return sentMsg
        }

        // Dispatch every remote capsule into WebRTC DataChannel mesh + Layer 2 ephemeral hop
        let maxRelayed = 0
        for (const capsule of sealedCapsules) {
          const relayed = (await meshRef.current?.publishLocalCapsule(capsule)) ?? 0
          if (relayed > maxRelayed) maxRelayed = relayed
        }

        // Fire blind 0ms push wake for remote recipients (zero plaintext / zero subject;
        // direct To vs CC vs isolated per-recipient BCC pokes so BCC peers cannot be correlated)
        const toPks = groups.to.filter((r) => r.pubkey !== myPk).map((r) => r.pubkey)
        if (toPks.length > 0) {
          onNotifyPushPokeRef.current?.({
            recipientPubkeys: toPks,
            category: 'agmail',
            eventId: mailId,
            senderName: activeNicknameRef.current,
          })
        }
        const ccPks = groups.cc.filter((r) => r.pubkey !== myPk).map((r) => r.pubkey)
        if (ccPks.length > 0) {
          onNotifyPushPokeRef.current?.({
            recipientPubkeys: ccPks,
            category: 'agmail-cc',
            eventId: `${mailId}:cc`,
            senderName: activeNicknameRef.current,
          })
        }
        const bccRemote = groups.bcc.filter((r) => r.pubkey !== myPk)
        bccRemote.forEach((r, idx) => {
          onNotifyPushPokeRef.current?.({
            recipientPubkeys: [r.pubkey],
            category: 'agmail-cc',
            eventId: `${mailId}:bcc:${idx}`,
            senderName: activeNicknameRef.current,
          })
        })

        if (maxRelayed > 0) {
          const updated: AmailMessage = {
            ...sentMsg,
            deliveryStatus: 'relayed',
            relayedPeerCount: maxRelayed,
            updatedAt: Date.now(),
          }
          await storage.putMessage(updated)
          refreshFromStorage()
          onLocalChangeRef.current?.()
          const recipientCount = groups.all.length
          const detail =
            recipientCount > 1
              ? `Dispatched to ${recipientCount} recipients via ${maxRelayed} mesh courier${maxRelayed === 1 ? '' : 's'}`
              : `Relayed to ${maxRelayed} mesh courier${maxRelayed === 1 ? '' : 's'}`
          pushToastRef.current?.('success', 'Agmail sealed & dispatched', detail)
          return updated
        }

        refreshFromStorage()
        onLocalChangeRef.current?.()
        pushToastRef.current?.(
          'success',
          'Agmail queued in mesh vault',
          includesSelf
            ? 'Delivered to your Inbox; remote recipients queued for couriers'
            : 'Will relay automatically when couriers connect'
        )
        return sentMsg
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Failed to encrypt Agmail.'
        pushToastRef.current?.('error', 'Failed to send Agmail', msg)
        return null
      }
    },
    [identityManager, refreshFromStorage, resolveRecipientGroups]
  )

  const saveDraft = useCallback(
    async (draft: AmailDraftInput): Promise<AmailMessage> => {
      const storage = storageRef.current!
      await storage.init()

      const myPk = identityManager.getMasterKeyMaterial().pubkey.toLowerCase()
      const curSettings = storage.getSettings()
      const groups = resolveRecipientGroups({
        toPubkey: draft.toPubkey,
        toPubkeys: draft.toPubkeys,
        ccPubkeys: draft.ccPubkeys,
        bccPubkeys: draft.bccPubkeys,
      })
      const primary = groups.to[0] ?? groups.cc[0] ?? groups.bcc[0]
      const id = draft.id || makeAmailId('draft')
      const existing = storage.getMessage(id)
      const nowSec = Math.floor(Date.now() / 1000)
      const ttlSec = draft.ttlSec ?? curSettings.defaultTtlSec

      const cleanAttachments = sanitizeAmailAttachments(draft.attachments)

      const entry: AmailMessage = {
        id,
        threadId: draft.threadId || id,
        inReplyTo: draft.inReplyTo,
        folder: 'drafts',
        direction: 'out',
        fromPubkey: myPk,
        fromNpub: encodeNpubSafe(myPk),
        fromName: activeNicknameRef.current,
        toPubkey: primary?.pubkey ?? '',
        toNpub: primary?.npub ?? '',
        toName: primary?.nickname ?? '',
        ...(groups.to.length > 0 ? { toRecipients: groups.to } : {}),
        ...(groups.cc.length > 0 ? { ccRecipients: groups.cc } : {}),
        ...(groups.bcc.length > 0 ? { bccRecipients: groups.bcc } : {}),
        subject: draft.subject,
        body: draft.body,
        ...(cleanAttachments ? { attachments: cleanAttachments } : {}),
        sentAt: nowSec,
        isRead: true,
        isStarred: existing?.isStarred ?? false,
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
    [identityManager, refreshFromStorage, resolveRecipientGroups]
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

      const myPk = identityManager.getMasterKeyMaterial().pubkey.toLowerCase()
      const isSelfMail = existing.fromPubkey.toLowerCase() === myPk
      const curSettings = storage.getSettings()
      let readAt = existing.readAt
      const shouldRecordRead =
        isRead &&
        existing.direction === 'in' &&
        !existing.readAt &&
        (isSelfMail || (existing.requestReadReceipt && curSettings.sendReadReceipts))

      if (shouldRecordRead) {
        readAt = Math.floor(Date.now() / 1000)
      }

      const updated: AmailMessage = {
        ...existing,
        isRead,
        readAt,
        updatedAt: Date.now(),
      }
      await storage.putMessage(updated)

      // Self-Mail: skip sealing a network read-receipt capsule and locally mark companion Sent copy read
      if (isSelfMail && shouldRecordRead && readAt) {
        const sentId = existing.id.replace(/:self$/, '')
        if (sentId !== existing.id) {
          const sentCopy = storage.getMessage(sentId)
          if (sentCopy && sentCopy.direction === 'out') {
            const nextDeliveredPubkeys = mergeUniqueStrings(sentCopy.deliveredPubkeys, [myPk])
            const nextReadPubkeys = mergeUniqueStrings(sentCopy.readPubkeys, [myPk])
            await storage.putMessage({
              ...sentCopy,
              deliveryStatus: 'read',
              deliveredAt: sentCopy.deliveredAt ?? readAt,
              readAt: sentCopy.readAt ?? readAt,
              ...(nextDeliveredPubkeys ? { deliveredPubkeys: nextDeliveredPubkeys } : {}),
              ...(nextReadPubkeys ? { readPubkeys: nextReadPubkeys } : {}),
              updatedAt: Date.now(),
            })
          }
        }
        refreshFromStorage()
        onLocalChangeRef.current?.()
        return
      }

      refreshFromStorage()
      onLocalChangeRef.current?.()

      if (!isSelfMail && shouldRecordRead && readAt) {
        try {
          const receiptPayload: AmailInnerReadReceiptPayload = {
            v: 1,
            type: 'read_receipt',
            mailId: existing.id,
            threadId: existing.threadId,
            readAt,
            readerName: activeNicknameRef.current,
          }
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
        if (existing.folder === folder) return
        let nextPreviousFolder: AmailFolder | undefined
        if (folder === 'trash' || folder === 'archive') {
          nextPreviousFolder =
            existing.folder !== 'trash' && existing.folder !== 'archive'
              ? existing.folder
              : existing.previousFolder
        } else {
          nextPreviousFolder = undefined
        }
        await storage.putMessage({
          ...existing,
          folder,
          previousFolder: nextPreviousFolder,
          updatedAt: Date.now(),
        })
      }
      refreshFromStorage()
      onLocalChangeRef.current?.()
    },
    [refreshFromStorage]
  )

  const restoreMessage = useCallback(
    async (id: string): Promise<AmailFolder | null> => {
      const storage = storageRef.current
      if (!storage) return null
      await storage.init()
      const existing = storage.getMessage(id)
      if (!existing) return null

      const prev = existing.previousFolder
      const isPrevValid =
        typeof prev === 'string' &&
        prev.length > 0 &&
        prev !== 'trash' &&
        prev !== 'archive' &&
        prev !== 'starred' &&
        (isBuiltinFolder(prev) || Boolean(storage.getCustomFolder(prev)))

      const targetFolder: AmailFolder = isPrevValid
        ? prev
        : existing.deliveryStatus === 'draft'
          ? 'drafts'
          : existing.direction === 'out'
            ? 'sent'
            : 'inbox'

      await storage.putMessage({
        ...existing,
        folder: targetFolder,
        previousFolder: undefined,
        updatedAt: Date.now(),
      })
      refreshFromStorage()
      onLocalChangeRef.current?.()
      return targetFolder
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

  /* ------------------------------------------------------------------------
     Custom Folders CRUD, Sorting & Reordering
     ------------------------------------------------------------------------ */

  const createFolder = useCallback(
    async (name: string): Promise<AmailCustomFolder | null> => {
      const storage = storageRef.current
      if (!storage) return null
      await storage.init()

      const clean = sanitizeFolderName(name)
      if (!clean) {
        pushToastRef.current?.('error', 'Invalid folder name', 'Enter a folder name.')
        return null
      }
      if (isBuiltinFolder(clean.toLowerCase())) {
        pushToastRef.current?.(
          'error',
          'Reserved folder name',
          `"${clean}" is a built-in Agmail folder.`
        )
        return null
      }

      const existingFolders = storage.getAllCustomFolders()
      if (existingFolders.some((f) => f.name.toLowerCase() === clean.toLowerCase())) {
        pushToastRef.current?.('error', 'Folder already exists', `A folder named "${clean}" already exists.`)
        return null
      }

      const maxOrder = existingFolders.reduce((acc, f) => Math.max(acc, f.order), -1)
      const now = Date.now()
      const folder: AmailCustomFolder = {
        id: makeCustomFolderId(clean),
        name: clean,
        order: maxOrder + 1,
        createdAt: now,
        updatedAt: now,
      }
      await storage.putCustomFolder(folder)
      refreshFromStorage()
      onLocalChangeRef.current?.()
      return folder
    },
    [refreshFromStorage]
  )

  const renameFolder = useCallback(
    async (folderId: string, name: string): Promise<boolean> => {
      const storage = storageRef.current
      if (!storage) return false
      await storage.init()

      const existing = storage.getCustomFolder(folderId)
      if (!existing) return false

      const clean = sanitizeFolderName(name)
      if (!clean) {
        pushToastRef.current?.('error', 'Invalid folder name', 'Enter a folder name.')
        return false
      }
      if (isBuiltinFolder(clean.toLowerCase())) {
        pushToastRef.current?.(
          'error',
          'Reserved folder name',
          `"${clean}" is a built-in Agmail folder.`
        )
        return false
      }

      const existingFolders = storage.getAllCustomFolders()
      if (
        existingFolders.some(
          (f) => f.id !== folderId && f.name.toLowerCase() === clean.toLowerCase()
        )
      ) {
        pushToastRef.current?.('error', 'Folder already exists', `A folder named "${clean}" already exists.`)
        return false
      }

      if (existing.name === clean) return true

      await storage.putCustomFolder({
        ...existing,
        name: clean,
        updatedAt: Date.now(),
      })
      refreshFromStorage()
      onLocalChangeRef.current?.()
      return true
    },
    [refreshFromStorage]
  )

  const deleteFolder = useCallback(
    async (folderId: string): Promise<void> => {
      const storage = storageRef.current
      if (!storage) return
      await storage.init()

      const now = Date.now()
      for (const m of storage.getAllMessages()) {
        if (m.folder === folderId || m.previousFolder === folderId) {
          const fallbackFolder: AmailFolder =
            m.deliveryStatus === 'draft'
              ? 'drafts'
              : m.direction === 'out'
                ? 'sent'
                : 'inbox'
          await storage.putMessage({
            ...m,
            folder: m.folder === folderId ? fallbackFolder : m.folder,
            previousFolder: m.previousFolder === folderId ? undefined : m.previousFolder,
            updatedAt: now,
          })
        }
      }

      await storage.deleteCustomFolder(folderId, true)
      refreshFromStorage()
      onLocalChangeRef.current?.()
    },
    [refreshFromStorage]
  )

  const reorderFolders = useCallback(
    async (orderedIds: string[]): Promise<void> => {
      const storage = storageRef.current
      if (!storage) return
      await storage.init()

      const current = storage.getAllCustomFolders()
      if (current.length === 0) return

      const byId = new Map(current.map((f) => [f.id, f]))
      const seen = new Set<string>()
      const ordered: AmailCustomFolder[] = []

      for (const id of orderedIds) {
        const found = byId.get(id)
        if (found && !seen.has(id)) {
          seen.add(id)
          ordered.push(found)
        }
      }
      for (const f of current) {
        if (!seen.has(f.id)) {
          ordered.push(f)
        }
      }

      const now = Date.now()
      const updated = ordered.map((f, idx) => ({
        ...f,
        order: idx,
        updatedAt: f.order !== idx ? now : f.updatedAt,
      }))

      await storage.setFolderSortMode('manual')
      await storage.putCustomFolders(updated)
      refreshFromStorage()
      onLocalChangeRef.current?.()
    },
    [refreshFromStorage]
  )

  const sortFolders = useCallback(
    async (mode: AmailFolderSortMode): Promise<void> => {
      const storage = storageRef.current
      if (!storage) return
      await storage.init()
      await storage.setFolderSortMode(mode)
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
        customFolders: [],
        deletedFolderIds: {},
        folderSortMode: 'manual',
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
      customFolders: snap.customFolders,
      deletedFolderIds: snap.deletedFolderIds,
      folderSortMode: snap.folderSortMode,
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
      const mergedDeletedFolders = {
        ...localSnap.deletedFolderIds,
        ...(remote.deletedFolderIds ?? {}),
      }
      await storage.mergeSyncTombstones(
        mergedDeleted,
        mergedRemovedContacts,
        mergedDeletedFolders
      )

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
        const cleanRemoteAttachments = sanitizeAmailAttachments(rm.attachments)
        if (!local) {
          const sanitizedRemote: AmailMessage = { ...rm }
          if (cleanRemoteAttachments) {
            sanitizedRemote.attachments = cleanRemoteAttachments
          } else {
            delete sanitizedRemote.attachments
          }
          await storage.putMessage(sanitizedRemote)
          changed = true
          continue
        }
        const remoteNewer = (rm.updatedAt ?? 0) > (local.updatedAt ?? 0)
        const bestStatus =
          DELIVERY_RANK[rm.deliveryStatus] > DELIVERY_RANK[local.deliveryStatus]
            ? rm.deliveryStatus
            : local.deliveryStatus
        const mergedCapsuleIds = mergeUniqueStrings(local.capsuleIds, rm.capsuleIds)
        const mergedDeliveredPubkeys = mergeUniqueStrings(
          local.deliveredPubkeys,
          rm.deliveredPubkeys
        )
        const mergedReadPubkeys = mergeUniqueStrings(local.readPubkeys, rm.readPubkeys)
        const mergedToRecipients =
          (remoteNewer ? rm.toRecipients : local.toRecipients) ??
          local.toRecipients ??
          rm.toRecipients
        const mergedCcRecipients =
          (remoteNewer ? rm.ccRecipients : local.ccRecipients) ??
          local.ccRecipients ??
          rm.ccRecipients
        const mergedBccRecipients =
          (remoteNewer ? rm.bccRecipients : local.bccRecipients) ??
          local.bccRecipients ??
          rm.bccRecipients
        const mergedIsBcc =
          (remoteNewer ? rm.isBccRecipient : local.isBccRecipient) ??
          local.isBccRecipient ??
          rm.isBccRecipient
        const cleanLocalAttachments = sanitizeAmailAttachments(local.attachments)
        const mergedAttachments =
          (remoteNewer ? cleanRemoteAttachments : cleanLocalAttachments) ??
          cleanLocalAttachments ??
          cleanRemoteAttachments

        const mergedBase: AmailMessage = {
          ...(remoteNewer ? rm : local),
          deliveryStatus: bestStatus,
          deliveredAt: local.deliveredAt ?? rm.deliveredAt,
          readAt: local.readAt ?? rm.readAt,
          isRead: remoteNewer ? rm.isRead : local.isRead || rm.isRead,
          relayedPeerCount: Math.max(local.relayedPeerCount, rm.relayedPeerCount),
          ...(mergedToRecipients ? { toRecipients: mergedToRecipients } : {}),
          ...(mergedCcRecipients ? { ccRecipients: mergedCcRecipients } : {}),
          ...(mergedBccRecipients ? { bccRecipients: mergedBccRecipients } : {}),
          ...(mergedIsBcc !== undefined ? { isBccRecipient: mergedIsBcc } : {}),
          ...(mergedCapsuleIds ? { capsuleIds: mergedCapsuleIds } : {}),
          ...(mergedDeliveredPubkeys ? { deliveredPubkeys: mergedDeliveredPubkeys } : {}),
          ...(mergedReadPubkeys ? { readPubkeys: mergedReadPubkeys } : {}),
          updatedAt: Math.max(local.updatedAt ?? 0, rm.updatedAt ?? 0),
        }
        if (mergedAttachments) {
          mergedBase.attachments = mergedAttachments
        } else {
          delete mergedBase.attachments
        }
        const merged = mergedBase
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

      // Merge custom folders with LWW + delete tombstones
      for (const rf of remote.customFolders ?? []) {
        if (
          !rf ||
          typeof rf.id !== 'string' ||
          !rf.id.startsWith('folder:') ||
          typeof rf.name !== 'string'
        ) {
          continue
        }
        const cleanName = sanitizeFolderName(rf.name)
        if (!cleanName) continue
        const deletedAt = mergedDeletedFolders[rf.id] ?? 0
        const rfTs = rf.updatedAt ?? rf.createdAt ?? 0
        if (deletedAt > rfTs) {
          if (storage.getCustomFolder(rf.id)) {
            await storage.deleteCustomFolder(rf.id, false)
            changed = true
          }
          continue
        }
        const local = storage.getCustomFolder(rf.id)
        if (!local || rfTs > (local.updatedAt ?? local.createdAt ?? 0)) {
          await storage.putCustomFolder({
            id: rf.id,
            name: cleanName,
            order: typeof rf.order === 'number' && Number.isFinite(rf.order) ? rf.order : 0,
            createdAt: typeof rf.createdAt === 'number' ? rf.createdAt : Date.now(),
            updatedAt: rfTs || Date.now(),
          })
          changed = true
        }
      }

      // Apply remote folder deletions locally and relocate any orphaned messages
      for (const [delFolderId, delTs] of Object.entries(remote.deletedFolderIds ?? {})) {
        const local = storage.getCustomFolder(delFolderId)
        if (local && delTs > (local.updatedAt ?? local.createdAt ?? 0)) {
          await storage.deleteCustomFolder(delFolderId, false)
          changed = true
          const now = Date.now()
          for (const m of storage.getAllMessages()) {
            if (m.folder === delFolderId || m.previousFolder === delFolderId) {
              const fallbackFolder: AmailFolder =
                m.deliveryStatus === 'draft'
                  ? 'drafts'
                  : m.direction === 'out'
                    ? 'sent'
                    : 'inbox'
              await storage.putMessage({
                ...m,
                folder: m.folder === delFolderId ? fallbackFolder : m.folder,
                previousFolder:
                  m.previousFolder === delFolderId ? undefined : m.previousFolder,
                updatedAt: now,
              })
            }
          }
        }
      }

      if (
        remote.folderSortMode &&
        (remote.folderSortMode === 'manual' ||
          remote.folderSortMode === 'az' ||
          remote.folderSortMode === 'za') &&
        remote.folderSortMode !== storage.getFolderSortMode()
      ) {
        await storage.setFolderSortMode(remote.folderSortMode)
        changed = true
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
    attachmentBlobCacheRef.current.clear()
    attachmentInflightRef.current.clear()
    setMessages([])
    setStoredContacts([])
    setCustomFolders([])
    setFolderSortMode('manual')
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
      customFolders,
      folderSortMode,
      unreadInboxCount,
      relayCapsules,
      tombstonesCount,
      meshPeers,
      storageStats,
      settings,
      isSyncing,
      updateSettings,
      uploadAttachment,
      downloadAttachment,
      sendMail,
      saveDraft,
      deleteDraft,
      markRead,
      toggleStar,
      moveToFolder,
      restoreMessage,
      deletePermanently,
      createFolder,
      renameFolder,
      deleteFolder,
      reorderFolders,
      sortFolders,
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
      customFolders,
      folderSortMode,
      unreadInboxCount,
      relayCapsules,
      tombstonesCount,
      meshPeers,
      storageStats,
      settings,
      isSyncing,
      updateSettings,
      uploadAttachment,
      downloadAttachment,
      sendMail,
      saveDraft,
      deleteDraft,
      markRead,
      toggleStar,
      moveToFolder,
      restoreMessage,
      deletePermanently,
      createFolder,
      renameFolder,
      deleteFolder,
      reorderFolders,
      sortFolders,
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
