import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { PushPokePayload } from '../types/notifications.ts'
import type {
  DmMessage,
  DmProtocol,
  DmThread,
  ImageAttachment,
  VoiceMemoAttachment,
} from '../types/protocol.ts'
import { KIND_GIFT_WRAP, verifyEventCached } from '../lib/bitchatProtocol.ts'
import {
  createEncryptedDmEvent,
  decodeDmImagePayload,
  decodeDmVoicePayload,
  decryptGiftWrapEvent,
  encodeDmImagePayload,
  encodeDmVoicePayload,
} from '../lib/dmCrypto.ts'
import {
  bytesToHex,
  encodeNpubSafe,
  formatDisplayHandle,
  type IdentityManager,
  type SigningKeyMaterial,
} from '../lib/identity.ts'
import type { PresenceTracker } from '../lib/presenceService.ts'
import type { RelayPool } from '../lib/relayPool.ts'
import { KeyedFifoQueue } from '../lib/sendQueue.ts'
import {
  isEphemeralPendingMessage,
  isStuckMediaPlaceholder,
  loadDmClearedAt,
  loadDmThreads,
  saveDmClearedAt,
  saveDmThreads,
} from '../lib/storage.ts'
import { formatVoiceDuration } from '../lib/voiceRecorder.ts'

const DM_LOOKBACK_SEC = 3 * 24 * 60 * 60 // 3 days to account for NIP-59 ±2d randomized timestamps
const DM_BACKLOG_FALLBACK_MS = 2500
const DM_EOSE_GRACE_MS = 500
const LIVE_RECENCY_WINDOW_MS = 10 * 60 * 1000 // 10 minutes tolerance for live clock skew

export function getDmOrderKey(msg: Pick<DmMessage, 'orderMs' | 'createdAt'>): number {
  return typeof msg.orderMs === 'number' && Number.isFinite(msg.orderMs)
    ? msg.orderMs
    : msg.createdAt * 1000
}

export function compareDmMessages(a: DmMessage, b: DmMessage): number {
  const diff = getDmOrderKey(a) - getDmOrderKey(b)
  if (diff !== 0) return diff
  return a.id.localeCompare(b.id)
}

function getMaxOrderMs(messages: readonly DmMessage[]): number {
  let max = 0
  for (const m of messages) {
    const k = getDmOrderKey(m)
    if (k > max) max = k
  }
  return max
}

function formatDmPreview(msg: DmMessage): string {
  if (msg.voiceMemo) {
    return msg.content
      ? `🎤 ${msg.content}`.slice(0, 96)
      : `🎤 Voice memo (${formatVoiceDuration(msg.voiceMemo.durationSec)})`
  }
  if (msg.imageAttachment) {
    return msg.content
      ? `🖼️ ${msg.content}`.slice(0, 96)
      : msg.imageAttachment.width > 0 && msg.imageAttachment.height > 0
        ? `🖼️ Image (${msg.imageAttachment.width}×${msg.imageAttachment.height})`
        : '🖼️ Image'
  }
  return msg.content.slice(0, 96)
}

export interface UseDirectMessagesOptions {
  pool: RelayPool | null
  identityManager: IdentityManager
  presenceTracker: PresenceTracker
  dmRelays: readonly string[]
  activeGeohash: string
  activeDmPeer: string | null
  blockedPubkeys: Set<string>
  identityVersion: number
  onIncomingDm?: (senderHandle: string, preview: string, peerPubkey: string) => void
  onNotifyPushPoke?: (payload: PushPokePayload) => void
  onError?: (title: string, detail?: string) => void
}

export function useDirectMessages(opts: UseDirectMessagesOptions) {
  const {
    pool,
    identityManager,
    presenceTracker,
    dmRelays,
    activeGeohash,
    activeDmPeer,
    blockedPubkeys,
    identityVersion,
    onIncomingDm,
    onNotifyPushPoke,
    onError,
  } = opts

  const [threads, setThreads] = useState<DmThread[]>(() => loadDmThreads())
  const [dmClearedAt, setDmClearedAt] = useState<Record<string, number>>(() => loadDmClearedAt())
  const dmClearedAtRef = useRef<Record<string, number>>(dmClearedAt)
  const threadsRef = useRef<DmThread[]>(threads)
  const dmSendQueueRef = useRef<KeyedFifoQueue>(new KeyedFifoQueue())
  const dmRelaysRef = useRef<readonly string[]>(dmRelays)
  const processedWrapIdsRef = useRef<Set<string>>(new Set())
  const dmBacklogSettledRef = useRef<boolean>(false)
  const dmSubSeqRef = useRef<number>(0)
  const activeDmPeerRef = useRef<string | null>(activeDmPeer)
  const blockedRef = useRef<Set<string>>(blockedPubkeys)
  const onIncomingRef = useRef(onIncomingDm)
  const onNotifyPushPokeRef = useRef(onNotifyPushPoke)
  const onErrorRef = useRef(onError)

  useLayoutEffect(() => {
    threadsRef.current = threads
  }, [threads])

  useLayoutEffect(() => {
    dmRelaysRef.current = dmRelays
  }, [dmRelays])

  useLayoutEffect(() => {
    onNotifyPushPokeRef.current = onNotifyPushPoke
  }, [onNotifyPushPoke])

  useLayoutEffect(() => {
    onErrorRef.current = onError
  }, [onError])

  useLayoutEffect(() => {
    dmClearedAtRef.current = dmClearedAt
  }, [dmClearedAt])

  useLayoutEffect(() => {
    activeDmPeerRef.current = activeDmPeer
  }, [activeDmPeer])

  useLayoutEffect(() => {
    blockedRef.current = blockedPubkeys
  }, [blockedPubkeys])

  // Immediately clear persisted unread counts on any DM thread whose peer is muted/blocked
  useEffect(() => {
    if (blockedPubkeys.size === 0) return
    setThreads((prev) => {
      let changed = false
      const next = prev.map((t) => {
        if (t.unreadCount > 0 && blockedPubkeys.has(t.peerPubkey.toLowerCase())) {
          changed = true
          return { ...t, unreadCount: 0 }
        }
        return t
      })
      return changed ? next : prev
    })
  }, [blockedPubkeys])

  useEffect(() => {
    onIncomingRef.current = onIncomingDm
  }, [onIncomingDm])

  // Persist threads on change
  useEffect(() => {
    saveDmThreads(threads)
  }, [threads])

  // Mark active thread read whenever opened
  useEffect(() => {
    if (!activeDmPeer) return
    const pk = activeDmPeer.toLowerCase()
    setThreads((prev) => {
      const idx = prev.findIndex((t) => t.peerPubkey === pk)
      if (idx === -1 || prev[idx].unreadCount === 0) return prev
      const copy = [...prev]
      copy[idx] = { ...copy[idx], unreadCount: 0 }
      return copy
    })
  }, [activeDmPeer])

  // Subscribe to kind 1059 gift wraps for master pubkey (+ derived geohash pubkey if enabled)
  useEffect(() => {
    if (!pool || dmRelays.length === 0) return

    const masterMat = identityManager.getMasterKeyMaterial()
    const geoMat = identityManager.getKeyMaterialForGeohash(activeGeohash)
    const materials: SigningKeyMaterial[] = [masterMat]
    if (geoMat.pubkey !== masterMat.pubkey) {
      materials.push(geoMat)
    }

    const recipientByPubkey = new Map<string, SigningKeyMaterial>()
    for (const mat of materials) {
      recipientByPubkey.set(mat.pubkey.toLowerCase(), mat)
    }

    const pTags = Array.from(recipientByPubkey.keys())
    if (pTags.length === 0) return

    let cancelled = false
    dmBacklogSettledRef.current = false
    const eoseRelays = new Set<string>()
    let eoseGraceTimer: number | null = null
    const settleBacklog = () => {
      if (cancelled) return
      dmBacklogSettledRef.current = true
      if (eoseGraceTimer !== null) {
        window.clearTimeout(eoseGraceTimer)
        eoseGraceTimer = null
      }
      window.clearTimeout(fallbackTimer)
    }
    const fallbackTimer = window.setTimeout(settleBacklog, DM_BACKLOG_FALLBACK_MS)

    const since = Math.floor(Date.now() / 1000) - DM_LOOKBACK_SEC
    const unsub = pool.subscribe(
      `agnostr-dm-${++dmSubSeqRef.current}`,
      dmRelays,
      [{ kinds: [KIND_GIFT_WRAP], '#p': pTags, since, limit: 150 }],
      {
        onEose: (relayUrl) => {
          if (cancelled) return
          eoseRelays.add(relayUrl)
          if (eoseRelays.size >= dmRelays.length) {
            settleBacklog()
          } else if (eoseGraceTimer === null) {
            eoseGraceTimer = window.setTimeout(settleBacklog, DM_EOSE_GRACE_MS)
          }
        },
        onEvent: (ev) => {
          if (cancelled) return
          if (ev.kind !== KIND_GIFT_WRAP) return
          if (processedWrapIdsRef.current.has(ev.id)) return
          if (!verifyEventCached(ev)) return
          if (cancelled) return
          processedWrapIdsRef.current.add(ev.id)
          if (processedWrapIdsRef.current.size > 2000) {
            const first = processedWrapIdsRef.current.values().next().value
            if (first) processedWrapIdsRef.current.delete(first)
          }

          const targetTag = ev.tags.find((t) => t[0] === 'p' && typeof t[1] === 'string')?.[1]?.toLowerCase()
          if (!targetTag) return
          const recipient = recipientByPubkey.get(targetTag)
          if (!recipient) return

          const arrivedAfterEose = dmBacklogSettledRef.current
          const receivedAtMs = Date.now()
          const wipeGen = identityManager.getWipeGeneration()
          void decryptGiftWrapEvent(ev, recipient).then((decrypted) => {
            if (cancelled || !decrypted) return
            // Drop plaintext if a panic wipe occurred during async decryption
            if (identityManager.getWipeGeneration() !== wipeGen) return

            const senderPk = decrypted.senderPubkey.toLowerCase()
            if (blockedRef.current.has(senderPk)) return
            if (recipientByPubkey.has(senderPk)) return // Ignore self-echo wraps

            // Drop pre-deletion relay backlog wraps so closed DM threads never resurrect on reload,
            // while still allowing any brand-new DM sent after closeThread() to open a fresh thread.
            const clearedAtSec = dmClearedAtRef.current[senderPk] ?? 0
            if (clearedAtSec > 0) {
              const rumorSec =
                typeof decrypted.timestampMs === 'number' && Number.isFinite(decrypted.timestampMs)
                  ? Math.floor(decrypted.timestampMs / 1000)
                  : decrypted.createdAt
              if (rumorSec <= clearedAtSec) return
            }

            if (decrypted.ackType && decrypted.embeddedMessageId) {
              setThreads((prev) =>
                prev.map((t) => {
                  if (t.peerPubkey !== senderPk) return t
                  return {
                    ...t,
                    messages: t.messages.map((m) =>
                      m.id === decrypted.embeddedMessageId
                        ? { ...m, deliveryStatus: decrypted.ackType === 'read' ? 'read' : 'delivered' }
                        : m
                    ),
                  }
                })
              )
              return
            }

            if (!decrypted.content.trim()) return

            const decodedVoice = decodeDmVoicePayload(decrypted.content)
            const decodedImage = decodedVoice ? null : decodeDmImagePayload(decrypted.content)
            const displayContent = decodedVoice
              ? decodedVoice.caption
              : decodedImage
                ? decodedImage.caption
                : decrypted.content
            const previewText = decodedVoice
              ? decodedVoice.caption
                ? `🎤 ${decodedVoice.caption}`
                : `🎤 Voice memo (${formatVoiceDuration(decodedVoice.voiceMemo.durationSec)})`
              : decodedImage
                ? decodedImage.caption
                  ? `🖼️ ${decodedImage.caption}`
                  : decodedImage.imageAttachment.width > 0 && decodedImage.imageAttachment.height > 0
                    ? `🖼️ Image (${decodedImage.imageAttachment.width}×${decodedImage.imageAttachment.height})`
                    : '🖼️ Image'
                : decrypted.content.slice(0, 96)

            const nick = presenceTracker.getNickname(senderPk) || `anon${senderPk.slice(-4)}`
            const handle = formatDisplayHandle(nick, senderPk)
            const isViewing = activeDmPeerRef.current?.toLowerCase() === senderPk

            const rawMsgMs = decrypted.timestampMs ?? decrypted.createdAt * 1000
            const clampedBacklogMs = Math.min(rawMsgMs, receivedAtMs)
            const isLiveRecent =
              arrivedAfterEose && Math.abs(receivedAtMs - rawMsgMs) <= LIVE_RECENCY_WINDOW_MS

            const baseMsg: DmMessage = {
              id: decrypted.id,
              peerPubkey: senderPk,
              senderPubkey: senderPk,
              content: displayContent,
              createdAt: decrypted.createdAt,
              isOwn: false,
              protocol: decrypted.protocol,
              voiceMemo: decodedVoice?.voiceMemo,
              imageAttachment: decodedImage?.imageAttachment,
              deliveryStatus: 'delivered',
            }

            let added = false
            setThreads((prev) => {
              const existingIdx = prev.findIndex((t) => t.peerPubkey === senderPk)
              if (existingIdx !== -1) {
                const existing = prev[existingIdx]
                if (existing.messages.some((m) => m.id === baseMsg.id)) return prev
                added = true
                const lastOrder = getMaxOrderMs(existing.messages)
                const newMsg: DmMessage = {
                  ...baseMsg,
                  orderMs: isLiveRecent ? Math.max(receivedAtMs, lastOrder + 1) : clampedBacklogMs,
                }
                const nextMsgs = [...existing.messages, newMsg].sort(compareDmMessages)
                const tail = nextMsgs[nextMsgs.length - 1]
                const updated: DmThread = {
                  ...existing,
                  peerNickname: nick,
                  peerDisplayHandle: handle,
                  protocol: decrypted.protocol,
                  messages: nextMsgs,
                  unreadCount: isViewing ? 0 : existing.unreadCount + 1,
                  lastMessageAt: tail.createdAt,
                  lastPreview: formatDmPreview(tail),
                }
                const copy = [...prev]
                copy[existingIdx] = updated
                copy.sort((a, b) => b.lastMessageAt - a.lastMessageAt)
                return copy
              }
              added = true
              const newMsg: DmMessage = {
                ...baseMsg,
                orderMs: isLiveRecent ? receivedAtMs : clampedBacklogMs,
              }
              const created: DmThread = {
                peerPubkey: senderPk,
                peerNpub: encodeNpubSafe(senderPk),
                peerNickname: nick,
                peerDisplayHandle: handle,
                protocol: decrypted.protocol,
                messages: [newMsg],
                unreadCount: isViewing ? 0 : 1,
                lastMessageAt: newMsg.createdAt,
                lastPreview: formatDmPreview(newMsg),
              }
              return [created, ...prev].sort((a, b) => b.lastMessageAt - a.lastMessageAt)
            })

            if (added && !isViewing && !blockedRef.current.has(senderPk)) {
              onIncomingRef.current?.(handle, previewText.slice(0, 80), senderPk)
            }
          })
        },
      }
    )

    return () => {
      cancelled = true
      window.clearTimeout(fallbackTimer)
      if (eoseGraceTimer !== null) window.clearTimeout(eoseGraceTimer)
      unsub()
    }
  }, [pool, dmRelays, activeGeohash, identityManager, presenceTracker, identityVersion])

  const ensureThread = useCallback(
    (peerPubkey: string, nicknameHint?: string, preferredProtocol?: DmProtocol): DmThread => {
      const pk = peerPubkey.toLowerCase()
      const nick = nicknameHint?.trim() || presenceTracker.getNickname(pk) || `anon${pk.slice(-4)}`
      const handle = formatDisplayHandle(nick, pk)
      const defaultProto: DmProtocol =
        preferredProtocol ?? (identityManager.getSignMode() === 'extension' ? 'nip17' : 'bitchat')

      let target: DmThread | null = null
      setThreads((prev) => {
        const idx = prev.findIndex((t) => t.peerPubkey === pk)
        if (idx !== -1) {
          const existing = prev[idx]
          target = {
            ...existing,
            peerNickname: nicknameHint?.trim() || existing.peerNickname,
            peerDisplayHandle: formatDisplayHandle(nicknameHint?.trim() || existing.peerNickname, pk),
            protocol: preferredProtocol ?? existing.protocol,
            unreadCount: 0,
          }
          const copy = [...prev]
          copy[idx] = target
          return copy
        }
        target = {
          peerPubkey: pk,
          peerNpub: encodeNpubSafe(pk),
          peerNickname: nick,
          peerDisplayHandle: handle,
          protocol: defaultProto,
          messages: [],
          unreadCount: 0,
          lastMessageAt: Math.floor(Date.now() / 1000),
          lastPreview: '',
        }
        return [target, ...prev]
      })

      return (
        target ?? {
          peerPubkey: pk,
          peerNpub: encodeNpubSafe(pk),
          peerNickname: nick,
          peerDisplayHandle: handle,
          protocol: defaultProto,
          messages: [],
          unreadCount: 0,
          lastMessageAt: Math.floor(Date.now() / 1000),
          lastPreview: '',
        }
      )
    },
    [identityManager, presenceTracker]
  )

  const sendDirectMessage = useCallback(
    async (
      peerPubkey: string,
      rawContent: string,
      protocolOverride?: DmProtocol,
      onPublishedId?: (id: string) => void
    ): Promise<boolean> => {
      const content = rawContent.trim()
      if (!content || !pool) return false
      const pk = peerPubkey.toLowerCase()

      const existingThread = threadsRef.current.find((t) => t.peerPubkey === pk)
      const signer = identityManager.getKeyMaterialForGeohash(activeGeohash)
      const targetRelays = [...dmRelaysRef.current]
      const wipeGen = identityManager.getWipeGeneration()
      const chosenProtocol: DmProtocol =
        protocolOverride ??
        existingThread?.protocol ??
        (signer.mode === 'extension' ? 'nip17' : 'bitchat')

      const localMsgId = bytesToHex(crypto.getRandomValues(new Uint8Array(8)))
      onPublishedId?.(localMsgId)
      const nowMs = Date.now()
      const nowSec = Math.floor(nowMs / 1000)

      const optimisticBase: DmMessage = {
        id: localMsgId,
        peerPubkey: pk,
        senderPubkey: signer.pubkey,
        content,
        createdAt: nowSec,
        orderMs: nowMs,
        isOwn: true,
        protocol: chosenProtocol,
        deliveryStatus: 'sending',
      }

      const nick =
        existingThread?.peerNickname || presenceTracker.getNickname(pk) || `anon${pk.slice(-4)}`
      const handle = formatDisplayHandle(nick, pk)

      // Append optimistic message synchronously BEFORE entering FIFO queue so rapid sends appear in exact 1 -> 2 -> 3 order
      setThreads((prev) => {
        const idx = prev.findIndex((t) => t.peerPubkey === pk)
        if (idx !== -1) {
          const lastOrder = getMaxOrderMs(prev[idx].messages)
          const optimistic: DmMessage = {
            ...optimisticBase,
            orderMs: Math.max(nowMs, lastOrder + 1),
          }
          const nextMsgs = [...prev[idx].messages, optimistic].sort(compareDmMessages)
          const tail = nextMsgs[nextMsgs.length - 1]
          const updated: DmThread = {
            ...prev[idx],
            messages: nextMsgs,
            lastMessageAt: tail.createdAt,
            lastPreview: formatDmPreview(tail),
            unreadCount: 0,
          }
          const copy = [...prev]
          copy[idx] = updated
          copy.sort((a, b) => b.lastMessageAt - a.lastMessageAt)
          return copy
        }
        const created: DmThread = {
          peerPubkey: pk,
          peerNpub: encodeNpubSafe(pk),
          peerNickname: nick,
          peerDisplayHandle: handle,
          protocol: chosenProtocol,
          messages: [optimisticBase],
          unreadCount: 0,
          lastMessageAt: nowSec,
          lastPreview: formatDmPreview(optimisticBase),
        }
        return [created, ...prev]
      })

      return await dmSendQueueRef.current.enqueue(
        `dm:${pk}`,
        async () => {
          if (identityManager.getWipeGeneration() !== wipeGen) return false
          try {
            const { event, protocol } = await createEncryptedDmEvent({
              content,
              recipientPubkey: pk,
              signer,
              protocol: chosenProtocol,
              messageId: localMsgId,
            })
            if (identityManager.getWipeGeneration() !== wipeGen) return false
            processedWrapIdsRef.current.add(event.id)
            const res = await pool.publish(targetRelays, event)
            if (identityManager.getWipeGeneration() !== wipeGen) return false
            const ok = res.acceptedRelays.length > 0

            setThreads((prev) =>
              prev.map((t) => {
                if (t.peerPubkey !== pk) return t
                return {
                  ...t,
                  protocol,
                  messages: t.messages.map((m) =>
                    m.id === localMsgId
                      ? { ...m, protocol, deliveryStatus: ok ? 'sent' : 'failed' }
                      : m
                  ),
                }
              })
            )

            if (ok) {
              onNotifyPushPokeRef.current?.({
                recipientPubkeys: [pk],
                category: 'dm',
                eventId: localMsgId,
              })
            } else {
              onErrorRef.current?.(
                'DM failed to publish',
                'No DM-capable relay accepted the gift wrap.'
              )
            }
            return ok
          } catch (err) {
            if (identityManager.getWipeGeneration() !== wipeGen) return false
            setThreads((prev) =>
              prev.map((t) => {
                if (t.peerPubkey !== pk) return t
                return {
                  ...t,
                  messages: t.messages.map((m) =>
                    m.id === localMsgId ? { ...m, deliveryStatus: 'failed' } : m
                  ),
                }
              })
            )
            onErrorRef.current?.(
              'DM encryption error',
              err instanceof Error ? err.message : 'Unable to send encrypted DM'
            )
            return false
          }
        },
        () => false
      )
    },
    [pool, identityManager, activeGeohash, presenceTracker]
  )

  const sendDirectVoiceMemo = useCallback(
    async (
      peerPubkey: string,
      voiceMemoOrLoader: VoiceMemoAttachment | (() => Promise<VoiceMemoAttachment>),
      caption?: string,
      protocolOverride?: DmProtocol
    ): Promise<boolean> => {
      if (!pool) return false
      const pk = peerPubkey.toLowerCase()
      const cleanCaption = caption?.trim() ?? ''

      const existingThread = threadsRef.current.find((t) => t.peerPubkey === pk)
      const signer = identityManager.getKeyMaterialForGeohash(activeGeohash)
      const targetRelays = [...dmRelaysRef.current]
      const wipeGen = identityManager.getWipeGeneration()
      const chosenProtocol: DmProtocol =
        protocolOverride ??
        existingThread?.protocol ??
        (signer.mode === 'extension' ? 'nip17' : 'bitchat')

      const localMsgId = bytesToHex(crypto.getRandomValues(new Uint8Array(8)))

      return await dmSendQueueRef.current.enqueue(
        `dm:${pk}`,
        async () => {
          if (identityManager.getWipeGeneration() !== wipeGen) return false
          let inserted = false
          try {
            const voiceMemo =
              typeof voiceMemoOrLoader === 'function'
                ? await voiceMemoOrLoader()
                : voiceMemoOrLoader
            if (identityManager.getWipeGeneration() !== wipeGen) return false

            const nowMs = Date.now()
            const nowSec = Math.floor(nowMs / 1000)
            const msgBase: DmMessage = {
              id: localMsgId,
              peerPubkey: pk,
              senderPubkey: signer.pubkey,
              content: cleanCaption,
              createdAt: nowSec,
              orderMs: nowMs,
              isOwn: true,
              protocol: chosenProtocol,
              voiceMemo,
              deliveryStatus: 'sending',
            }
            const currentThread = threadsRef.current.find((t) => t.peerPubkey === pk)
            const nick =
              currentThread?.peerNickname ||
              presenceTracker.getNickname(pk) ||
              `anon${pk.slice(-4)}`
            const handle = formatDisplayHandle(nick, pk)

            inserted = true
            setThreads((prev) => {
              const idx = prev.findIndex((t) => t.peerPubkey === pk)
              if (idx !== -1) {
                const lastOrder = getMaxOrderMs(prev[idx].messages)
                const placed: DmMessage = {
                  ...msgBase,
                  orderMs: Math.max(nowMs, lastOrder + 1),
                }
                const nextMsgs = [...prev[idx].messages, placed].sort(compareDmMessages)
                const tail = nextMsgs[nextMsgs.length - 1]
                const updated: DmThread = {
                  ...prev[idx],
                  messages: nextMsgs,
                  lastMessageAt: tail.createdAt,
                  lastPreview: formatDmPreview(tail),
                  unreadCount: 0,
                }
                const copy = [...prev]
                copy[idx] = updated
                copy.sort((a, b) => b.lastMessageAt - a.lastMessageAt)
                return copy
              }
              const created: DmThread = {
                peerPubkey: pk,
                peerNpub: encodeNpubSafe(pk),
                peerNickname: nick,
                peerDisplayHandle: handle,
                protocol: chosenProtocol,
                messages: [msgBase],
                unreadCount: 0,
                lastMessageAt: nowSec,
                lastPreview: formatDmPreview(msgBase),
              }
              return [created, ...prev]
            })

            const wireContent = encodeDmVoicePayload(voiceMemo, cleanCaption)
            const { event, protocol } = await createEncryptedDmEvent({
              content: wireContent,
              recipientPubkey: pk,
              signer,
              protocol: chosenProtocol,
              messageId: localMsgId,
            })
            if (identityManager.getWipeGeneration() !== wipeGen) return false
            processedWrapIdsRef.current.add(event.id)
            const res = await pool.publish(targetRelays, event)
            if (identityManager.getWipeGeneration() !== wipeGen) return false
            const ok = res.acceptedRelays.length > 0

            setThreads((prev) =>
              prev.map((t) => {
                if (t.peerPubkey !== pk) return t
                return {
                  ...t,
                  protocol,
                  messages: t.messages.map((m) =>
                    m.id === localMsgId
                      ? {
                          ...m,
                          protocol,
                          voiceMemo,
                          content: cleanCaption,
                          deliveryStatus: ok ? 'sent' : 'failed',
                        }
                      : m
                  ),
                }
              })
            )

            if (ok) {
              onNotifyPushPokeRef.current?.({
                recipientPubkeys: [pk],
                category: 'dm',
                eventId: localMsgId,
              })
            } else {
              onErrorRef.current?.(
                'Encrypted voice DM failed',
                'No DM-capable relay accepted the gift wrap.'
              )
            }
            return ok
          } catch (err) {
            if (identityManager.getWipeGeneration() !== wipeGen) return false
            if (inserted) {
              setThreads((prev) =>
                prev.map((t) => {
                  if (t.peerPubkey !== pk) return t
                  return {
                    ...t,
                    messages: t.messages.map((m) =>
                      m.id === localMsgId ? { ...m, deliveryStatus: 'failed' } : m
                    ),
                  }
                })
              )
            }
            onErrorRef.current?.(
              'Encrypted voice DM error',
              err instanceof Error ? err.message : 'Unable to send encrypted voice memo'
            )
            return false
          }
        },
        () => false
      )
    },
    [pool, identityManager, activeGeohash, presenceTracker]
  )

  const sendDirectImageAttachment = useCallback(
    async (
      peerPubkey: string,
      imageOrLoader: ImageAttachment | (() => Promise<ImageAttachment>),
      caption?: string,
      protocolOverride?: DmProtocol
    ): Promise<boolean> => {
      if (!pool) return false
      const pk = peerPubkey.toLowerCase()
      const cleanCaption = caption?.trim() ?? ''

      const existingThread = threadsRef.current.find((t) => t.peerPubkey === pk)
      const signer = identityManager.getKeyMaterialForGeohash(activeGeohash)
      const targetRelays = [...dmRelaysRef.current]
      const wipeGen = identityManager.getWipeGeneration()
      const chosenProtocol: DmProtocol =
        protocolOverride ??
        existingThread?.protocol ??
        (signer.mode === 'extension' ? 'nip17' : 'bitchat')

      const localMsgId = bytesToHex(crypto.getRandomValues(new Uint8Array(8)))

      return await dmSendQueueRef.current.enqueue(
        `dm:${pk}`,
        async () => {
          if (identityManager.getWipeGeneration() !== wipeGen) return false
          let inserted = false
          try {
            const imageAttachment =
              typeof imageOrLoader === 'function' ? await imageOrLoader() : imageOrLoader
            if (identityManager.getWipeGeneration() !== wipeGen) return false

            const nowMs = Date.now()
            const nowSec = Math.floor(nowMs / 1000)
            const msgBase: DmMessage = {
              id: localMsgId,
              peerPubkey: pk,
              senderPubkey: signer.pubkey,
              content: cleanCaption,
              createdAt: nowSec,
              orderMs: nowMs,
              isOwn: true,
              protocol: chosenProtocol,
              imageAttachment,
              deliveryStatus: 'sending',
            }
            const currentThread = threadsRef.current.find((t) => t.peerPubkey === pk)
            const nick =
              currentThread?.peerNickname ||
              presenceTracker.getNickname(pk) ||
              `anon${pk.slice(-4)}`
            const handle = formatDisplayHandle(nick, pk)

            inserted = true
            setThreads((prev) => {
              const idx = prev.findIndex((t) => t.peerPubkey === pk)
              if (idx !== -1) {
                const lastOrder = getMaxOrderMs(prev[idx].messages)
                const placed: DmMessage = {
                  ...msgBase,
                  orderMs: Math.max(nowMs, lastOrder + 1),
                }
                const nextMsgs = [...prev[idx].messages, placed].sort(compareDmMessages)
                const tail = nextMsgs[nextMsgs.length - 1]
                const updated: DmThread = {
                  ...prev[idx],
                  messages: nextMsgs,
                  lastMessageAt: tail.createdAt,
                  lastPreview: formatDmPreview(tail),
                  unreadCount: 0,
                }
                const copy = [...prev]
                copy[idx] = updated
                copy.sort((a, b) => b.lastMessageAt - a.lastMessageAt)
                return copy
              }
              const created: DmThread = {
                peerPubkey: pk,
                peerNpub: encodeNpubSafe(pk),
                peerNickname: nick,
                peerDisplayHandle: handle,
                protocol: chosenProtocol,
                messages: [msgBase],
                unreadCount: 0,
                lastMessageAt: nowSec,
                lastPreview: formatDmPreview(msgBase),
              }
              return [created, ...prev]
            })

            const wireContent = encodeDmImagePayload(imageAttachment, cleanCaption)
            const { event, protocol } = await createEncryptedDmEvent({
              content: wireContent,
              recipientPubkey: pk,
              signer,
              protocol: chosenProtocol,
              messageId: localMsgId,
            })
            if (identityManager.getWipeGeneration() !== wipeGen) return false
            processedWrapIdsRef.current.add(event.id)
            const res = await pool.publish(targetRelays, event)
            if (identityManager.getWipeGeneration() !== wipeGen) return false
            const ok = res.acceptedRelays.length > 0

            setThreads((prev) =>
              prev.map((t) => {
                if (t.peerPubkey !== pk) return t
                return {
                  ...t,
                  protocol,
                  messages: t.messages.map((m) =>
                    m.id === localMsgId
                      ? {
                          ...m,
                          protocol,
                          imageAttachment,
                          content: cleanCaption,
                          deliveryStatus: ok ? 'sent' : 'failed',
                        }
                      : m
                  ),
                }
              })
            )

            if (ok) {
              onNotifyPushPokeRef.current?.({
                recipientPubkeys: [pk],
                category: 'dm',
                eventId: localMsgId,
              })
            } else {
              onErrorRef.current?.(
                'Encrypted image DM failed',
                'No DM-capable relay accepted the gift wrap.'
              )
            }
            return ok
          } catch (err) {
            if (identityManager.getWipeGeneration() !== wipeGen) return false
            if (inserted) {
              setThreads((prev) =>
                prev.map((t) => {
                  if (t.peerPubkey !== pk) return t
                  return {
                    ...t,
                    messages: t.messages.map((m) =>
                      m.id === localMsgId ? { ...m, deliveryStatus: 'failed' } : m
                    ),
                  }
                })
              )
            }
            onErrorRef.current?.(
              'Encrypted image DM error',
              err instanceof Error ? err.message : 'Unable to send encrypted image'
            )
            return false
          }
        },
        () => false
      )
    },
    [pool, identityManager, activeGeohash, presenceTracker]
  )

  const clearThread = useCallback((peerPubkey: string) => {
    const pk = peerPubkey.toLowerCase()
    setThreads((prev) =>
      prev.map((t) => (t.peerPubkey === pk ? { ...t, messages: [], lastPreview: '', unreadCount: 0 } : t))
    )
  }, [])

  const closeThread = useCallback((peerPubkey: string) => {
    const pk = peerPubkey.trim().toLowerCase()
    if (!pk) return
    const nextClearedAt: Record<string, number> = {
      ...dmClearedAtRef.current,
      [pk]: Math.floor(Date.now() / 1000),
    }
    dmClearedAtRef.current = nextClearedAt
    setDmClearedAt(nextClearedAt)
    saveDmClearedAt(nextClearedAt)
    setThreads((prev) => {
      const next = prev.filter((t) => t.peerPubkey !== pk)
      saveDmThreads(next)
      return next
    })
  }, [])

  const mergeSyncedDmClearedAt = useCallback((remoteClearedAt: Record<string, number>): number => {
    const nextMap: Record<string, number> = { ...dmClearedAtRef.current }
    let changedCount = 0
    for (const [rawPk, rawTs] of Object.entries(remoteClearedAt)) {
      const pk = rawPk.toLowerCase()
      if (!/^[0-9a-f]{64}$/.test(pk) || typeof rawTs !== 'number' || !Number.isFinite(rawTs) || rawTs <= 0) {
        continue
      }
      const ts = Math.floor(rawTs)
      if ((nextMap[pk] ?? 0) < ts) {
        nextMap[pk] = ts
        changedCount += 1
      }
    }
    if (changedCount === 0) return 0
    dmClearedAtRef.current = nextMap
    setDmClearedAt(nextMap)
    saveDmClearedAt(nextMap)
    setThreads((prev) => {
      let mutated = false
      const next: DmThread[] = []
      for (const thread of prev) {
        const cutoff = nextMap[thread.peerPubkey.toLowerCase()] ?? 0
        if (cutoff <= 0) {
          next.push(thread)
          continue
        }
        const surviving = thread.messages.filter((m) => m.createdAt > cutoff)
        if (surviving.length === thread.messages.length) {
          next.push(thread)
          continue
        }
        mutated = true
        if (surviving.length > 0) {
          const tail = surviving[surviving.length - 1]
          next.push({
            ...thread,
            messages: surviving,
            lastMessageAt: tail.createdAt,
            lastPreview: formatDmPreview(tail),
          })
        }
      }
      if (mutated) {
        saveDmThreads(next)
        return next
      }
      return prev
    })
    return changedCount
  }, [])

  const mergeSyncedDmMessages = useCallback(
    (
      peerPubkey: string,
      incoming: DmMessage[],
      peerMeta?: { peerNickname?: string; protocol?: DmProtocol }
    ): number => {
      const pk = peerPubkey.trim().toLowerCase()
      if (!/^[0-9a-f]{64}$/.test(pk) || incoming.length === 0) return 0
      if (blockedRef.current.has(pk)) return 0

      const masterPk = identityManager.getMasterKeyMaterial().pubkey.toLowerCase()
      const cutoffSec = dmClearedAtRef.current[pk] ?? 0
      const validIncoming: DmMessage[] = []
      for (const raw of incoming) {
        if (!raw || typeof raw.id !== 'string' || !raw.id || typeof raw.createdAt !== 'number') {
          continue
        }
        if (isStuckMediaPlaceholder(raw) || isEphemeralPendingMessage(raw)) continue
        if (cutoffSec > 0 && raw.createdAt <= cutoffSec) continue
        const senderPk = (raw.senderPubkey || '').toLowerCase()
        if (!/^[0-9a-f]{64}$/.test(senderPk)) continue
        if (blockedRef.current.has(senderPk)) continue
        const isOwn = senderPk === masterPk || Boolean(raw.isOwn)
        validIncoming.push({
          ...raw,
          peerPubkey: pk,
          senderPubkey: senderPk,
          isOwn,
          protocol: raw.protocol === 'nip17' ? 'nip17' : 'bitchat',
        })
      }
      if (validIncoming.length === 0) return 0

      const existingThread = threadsRef.current.find((t) => t.peerPubkey === pk)
      const existingIds = new Set(existingThread?.messages.map((m) => m.id) ?? [])
      const uniqueNew = validIncoming.filter((m) => !existingIds.has(m.id))
      if (uniqueNew.length === 0) return 0

      setThreads((prev) => {
        const idx = prev.findIndex((t) => t.peerPubkey === pk)
        if (idx !== -1) {
          const existing = prev[idx]
          const seen = new Set(existing.messages.map((m) => m.id))
          const toAdd = validIncoming.filter((m) => !seen.has(m.id))
          if (toAdd.length === 0) return prev
          const merged = [...existing.messages, ...toAdd].sort(compareDmMessages).slice(-150)
          const tail = merged[merged.length - 1]
          const updated: DmThread = {
            ...existing,
            messages: merged,
            lastMessageAt: tail ? tail.createdAt : existing.lastMessageAt,
            lastPreview: tail ? formatDmPreview(tail) : existing.lastPreview,
          }
          const copy = [...prev]
          copy[idx] = updated
          copy.sort((a, b) => b.lastMessageAt - a.lastMessageAt)
          return copy
        }
        const sorted = [...validIncoming].sort(compareDmMessages).slice(-150)
        const tail = sorted[sorted.length - 1]
        const nick =
          peerMeta?.peerNickname?.trim() ||
          presenceTracker.getNickname(pk) ||
          `anon${pk.slice(-4)}`
        const created: DmThread = {
          peerPubkey: pk,
          peerNpub: encodeNpubSafe(pk),
          peerNickname: nick,
          peerDisplayHandle: formatDisplayHandle(nick, pk),
          protocol: peerMeta?.protocol ?? tail?.protocol ?? 'bitchat',
          messages: sorted,
          unreadCount: 0,
          lastMessageAt: tail ? tail.createdAt : Math.floor(Date.now() / 1000),
          lastPreview: tail ? formatDmPreview(tail) : '',
        }
        return [created, ...prev].sort((a, b) => b.lastMessageAt - a.lastMessageAt)
      })
      return uniqueNew.length
    },
    [identityManager, presenceTracker]
  )

  const clearAllDms = useCallback(() => {
    dmSendQueueRef.current.clearAll()
    processedWrapIdsRef.current.clear()
    dmClearedAtRef.current = {}
    setDmClearedAt({})
    setThreads([])
  }, [])

  const sanitizedThreads = useMemo(
    () =>
      threads.map((t) =>
        blockedPubkeys.has(t.peerPubkey.toLowerCase())
          ? { ...t, unreadCount: 0, lastPreview: '' }
          : t
      ),
    [threads, blockedPubkeys]
  )

  const totalDmUnread = useMemo(
    () => sanitizedThreads.reduce((sum, t) => sum + t.unreadCount, 0),
    [sanitizedThreads]
  )

  return {
    dmThreads: sanitizedThreads,
    dmClearedAt,
    totalDmUnread,
    ensureThread,
    sendDirectMessage,
    sendDirectVoiceMemo,
    sendDirectImageAttachment,
    clearThread,
    closeThread,
    mergeSyncedDmClearedAt,
    mergeSyncedDmMessages,
    clearAllDms,
  }
}
