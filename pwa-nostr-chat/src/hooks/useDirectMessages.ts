import { chatRetries, isUnconfirmed, publishChatWire } from '../lib/chatDelivery.ts'
import {
  applyDmReaction,
  dmTargetId,
  findDmReactionTarget,
  mergeDmMessageMetadata,
  type DmReactionUpdate,
} from '../lib/dmMessageActions.ts'
import { rememberLiveDmPush } from '../lib/pushDisplay.ts'
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
import { isAutoAnonNickname } from '../lib/deviceSync.ts'
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

export function pickBestPeerNickname(
  pubkey: string,
  ...candidates: Array<string | null | undefined>
): string {
  for (const raw of candidates) {
    const clean = (raw ?? '').trim().slice(0, 32)
    if (!isAutoAnonNickname(clean)) {
      return clean
    }
  }
  return `anon${pubkey.toLowerCase().slice(-4)}`
}

export function getDmOrderKey(msg: Pick<DmMessage, 'orderMs' | 'createdAt'>): number {
  return typeof msg.orderMs === 'number' && Number.isFinite(msg.orderMs)
    ? msg.orderMs
    : msg.createdAt * 1000
}

export function compareDmMessages(a: DmMessage, b: DmMessage): number {
  const pending = Number(isUnconfirmed(a)) - Number(isUnconfirmed(b))
  if (pending !== 0) return pending
  const diff = getDmOrderKey(a) - getDmOrderKey(b)
  if (diff !== 0) return diff
  const left = a.wireId ?? a.id
  const right = b.wireId ?? b.id
  return left < right ? -1 : left > right ? 1 : 0
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
  onError?: (title: string, detail?: string, retryMessageId?: string) => void
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
  const dmSubSeqRef = useRef<number>(0)
  const activeDmPeerRef = useRef<string | null>(activeDmPeer)
  const blockedRef = useRef<Set<string>>(blockedPubkeys)
  const onIncomingRef = useRef(onIncomingDm)
  const onNotifyPushPokeRef = useRef(onNotifyPushPoke)
  const onErrorRef = useRef(onError)

  // Hold out-of-order authenticated actions until their parent is genuinely available.
  // Existing parents update directly, without a separate render/effect round trip.
  const pendingReactions = useRef(new Map<string, DmReactionUpdate>())
  const acceptIncomingReaction = useCallback((reaction: DmReactionUpdate) => {
    if (findDmReactionTarget(threadsRef.current, reaction)) {
      setThreads((prev) => applyDmReaction(prev, reaction))
      return
    }
    const key = JSON.stringify([reaction.peer, reaction.target, reaction.sender, reaction.emoji])
    const pending = pendingReactions.current
    if (pending.has(key)) return
    if (pending.size >= 256) pending.delete(pending.keys().next().value!)
    pending.set(key, reaction)
  }, [])

  useLayoutEffect(() => {
    const matched: DmReactionUpdate[] = []
    for (const [key, reaction] of pendingReactions.current) {
      if (!findDmReactionTarget(threads, reaction)) continue
      pendingReactions.current.delete(key)
      if (!blockedRef.current.has(reaction.sender)) matched.push(reaction)
    }
    if (matched.length) {
      setThreads((prev) => matched.reduce(applyDmReaction, prev))
    }
  }, [threads])

  // Optimistic rows are presentation only: storage and device sync consume confirmed threads.
  const outgoingReactions = useRef(new Map<string, DmReactionUpdate>())
  const [optimisticReactions, setOptimisticReactions] = useState<DmReactionUpdate[]>([])
  const reactionIdentity = useMemo(() => {
    void identityVersion
    return identityManager.getMasterKeyMaterial().pubkey.toLowerCase()
  }, [identityManager, identityVersion])
  const updateOptimisticReactions = useCallback(() => {
    setOptimisticReactions(Array.from(outgoingReactions.current.values()))
  }, [])
  const dropReactionsForPeer = useCallback((peer: string) => {
    for (const [key, r] of pendingReactions.current) {
      if (r.peer === peer) pendingReactions.current.delete(key)
    }
    for (const [key, r] of outgoingReactions.current) {
      if (r.peer === peer) outgoingReactions.current.delete(key)
    }
    updateOptimisticReactions()
  }, [updateOptimisticReactions])

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
    const since = Math.floor(Date.now() / 1000) - DM_LOOKBACK_SEC
    const unsub = pool.subscribe(
      `agnostr-dm-${++dmSubSeqRef.current}`,
      dmRelays,
      [{ kinds: [KIND_GIFT_WRAP], '#p': pTags, since, limit: 150 }],
      {
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
              chatRetries.confirm(decrypted.embeddedMessageId)
              setThreads((prev) =>
                prev.map((t) => {
                  if (t.peerPubkey !== senderPk) return t
                  return {
                    ...t,
                    messages: t.messages.map((m) =>
                      m.id === decrypted.embeddedMessageId
                        ? mergeDmMessageMetadata(m, { ...m, deliveryStatus: decrypted.ackType === 'read' ? 'read' : 'delivered' })
                        : m
                    ).sort(compareDmMessages),
                  }
                })
              )
              return
            }

            if (decrypted.reactionToId) {
              acceptIncomingReaction({
                peer: senderPk, target: decrypted.reactionToId, sender: senderPk,
                emoji: decrypted.content, own: false,
              })
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

            const presenceNick = presenceTracker.getNickname(senderPk)
            const initialNick = pickBestPeerNickname(senderPk, presenceNick)
            let resolvedHandle = formatDisplayHandle(initialNick, senderPk)
            const isViewing = activeDmPeerRef.current?.toLowerCase() === senderPk

            const rawMsgMs = decrypted.timestampMs ?? decrypted.createdAt * 1000
            const orderMs = Math.min(rawMsgMs, receivedAtMs)

            const baseMsg: DmMessage = {
              id: decrypted.id,
              replyToId: decrypted.replyToId,
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
                const nextNick = pickBestPeerNickname(senderPk, presenceNick, existing.peerNickname)
                const nextHandle = formatDisplayHandle(nextNick, senderPk)
                resolvedHandle = nextHandle
                const newMsg: DmMessage = {
                  ...baseMsg,
                  orderMs,
                }
                rememberLiveDmPush(newMsg, ev.id, masterMat.pubkey)
                const nextMsgs = [...existing.messages, newMsg].sort(compareDmMessages)
                const tail = nextMsgs[nextMsgs.length - 1]
                const updated: DmThread = {
                  ...existing,
                  peerNickname: nextNick,
                  peerDisplayHandle: nextHandle,
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
                orderMs,
              }
              rememberLiveDmPush(newMsg, ev.id, masterMat.pubkey)
              const created: DmThread = {
                peerPubkey: senderPk,
                peerNpub: encodeNpubSafe(senderPk),
                peerNickname: initialNick,
                peerDisplayHandle: resolvedHandle,
                protocol: decrypted.protocol,
                messages: [newMsg],
                unreadCount: isViewing ? 0 : 1,
                lastMessageAt: newMsg.createdAt,
                lastPreview: formatDmPreview(newMsg),
              }
              return [created, ...prev].sort((a, b) => b.lastMessageAt - a.lastMessageAt)
            })

            if (added && !isViewing && !blockedRef.current.has(senderPk)) {
              onIncomingRef.current?.(resolvedHandle, previewText.slice(0, 80), senderPk)
            }
          })
        },
      }
    )

    return () => {
      cancelled = true
      unsub()
    }
  }, [pool, dmRelays, activeGeohash, identityManager, presenceTracker, identityVersion, acceptIncomingReaction])

  const ensureThread = useCallback(
    (peerPubkey: string, nicknameHint?: string, preferredProtocol?: DmProtocol): DmThread => {
      const pk = peerPubkey.toLowerCase()
      const presenceNick = presenceTracker.getNickname(pk)
      const nick = pickBestPeerNickname(pk, nicknameHint, presenceNick)
      const handle = formatDisplayHandle(nick, pk)
      const defaultProto: DmProtocol =
        preferredProtocol ?? (identityManager.getSignMode() === 'extension' ? 'nip17' : 'bitchat')

      let target: DmThread | null = null
      setThreads((prev) => {
        const idx = prev.findIndex((t) => t.peerPubkey === pk)
        if (idx !== -1) {
          const existing = prev[idx]
          const nextNick = pickBestPeerNickname(
            pk,
            nicknameHint,
            existing.peerNickname,
            presenceNick
          )
          target = {
            ...existing,
            peerNickname: nextNick,
            peerDisplayHandle: formatDisplayHandle(nextNick, pk),
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
      onPublishedId?: (id: string) => void,
      replyToId?: string
    ): Promise<boolean> => {
      const content = rawContent.trim()
      if (!content || !pool) return false
      const pk = peerPubkey.toLowerCase()

      const existingThread = threadsRef.current.find((t) => t.peerPubkey === pk)
      const parent = replyToId ? existingThread?.messages.find(m => m.id === replyToId) : undefined
      const target = parent && dmTargetId(parent)
      if (replyToId && !target) {
        onErrorRef.current?.('Cannot reply', 'This message has no shared ID in this conversation.')
        return false
      }
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
        replyToId: target,
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

      const queueAttempt = (attempt: () => Promise<boolean>) =>
        dmSendQueueRef.current.enqueue(`dm:${pk}`, attempt, () => false)
      const attempt = async (): Promise<boolean> => {
        if (identityManager.getWipeGeneration() !== wipeGen) return false
        try {
          setThreads((prev) => prev.map((t) => t.peerPubkey === pk ? { ...t, messages: t.messages.map((m) =>
            m.id === localMsgId ? { ...m, deliveryStatus: 'sending' } : m) } : t))
          if (!await pool.waitForChatRelay(targetRelays)) throw new Error('No connected DM relay accepted the message.')
          if (identityManager.getWipeGeneration() !== wipeGen) return false
          const { event, protocol, wireId, orderMs } = await createEncryptedDmEvent({
            content,
            recipientPubkey: pk,
            signer,
            protocol: chosenProtocol,
            messageId: localMsgId,
            action: target ? { type: 'reply', targetId: target } : undefined,
          })
          if (identityManager.getWipeGeneration() !== wipeGen) return false
          processedWrapIdsRef.current.add(event.id)
          return await publishChatWire({
            rowId: localMsgId,
            publish: (ack) => pool.publish([...new Set([...targetRelays, ...dmRelaysRef.current])], event, undefined, ack),
            isCurrent: () => identityManager.getWipeGeneration() === wipeGen,
            queueRetry: (retry) => dmSendQueueRef.current.enqueue(`dm:${pk}`, retry, () => false),
            update: (deliveryStatus) => setThreads((prev) => prev.map((t) => {
              if (t.peerPubkey !== pk) return t
              const messages = t.messages.map((m) => m.id === localMsgId
                ? { ...m, wireId, protocol, orderMs, createdAt: Math.floor(orderMs / 1000),

                    deliveryStatus: m.deliveryStatus === 'read' || m.deliveryStatus === 'delivered'
                      ? m.deliveryStatus : deliveryStatus }
                : m).sort(compareDmMessages)
              const tail = messages.at(-1)
              return { ...t, protocol, messages, lastMessageAt: tail?.createdAt ?? 0,
                lastPreview: tail ? formatDmPreview(tail) : '' }
            }).sort((a, b) => b.lastMessageAt - a.lastMessageAt)),
            onSuccess: () => onNotifyPushPokeRef.current?.({
              recipientPubkeys: [pk],
              category: 'dm',
              eventId: localMsgId,
            }),
            onFailure: (reason) => onErrorRef.current?.('DM failed to publish', reason, localMsgId),
          })
        } catch (err) {
          if (identityManager.getWipeGeneration() !== wipeGen) return false
          chatRetries.hold(localMsgId, () => queueAttempt(attempt))
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
            'DM failed to send',
            err instanceof Error ? err.message : 'Unable to send encrypted DM',
            localMsgId
          )
          return false
        }
      }
      return await queueAttempt(attempt)
    },
    [pool, identityManager, activeGeohash, presenceTracker]
  )

  const sendDirectVoiceMemo = useCallback(
    async (
      peerPubkey: string,
      voiceMemoOrLoader: VoiceMemoAttachment | (() => Promise<VoiceMemoAttachment>),
      caption?: string,
      protocolOverride?: DmProtocol,
      replyToId?: string
    ): Promise<boolean> => {
      if (!pool) return false
      const pk = peerPubkey.toLowerCase()
      const cleanCaption = caption?.trim() ?? ''

      const existingThread = threadsRef.current.find((t) => t.peerPubkey === pk)
      const parent = replyToId ? existingThread?.messages.find(m => m.id === replyToId) : undefined
      const target = parent && dmTargetId(parent)
      if (replyToId && !target) {
        onErrorRef.current?.('Cannot reply', 'This message has no shared ID in this conversation.')
        return false
      }
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
              replyToId: target,
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
            await pool.waitForChatRelay(targetRelays)
            if (identityManager.getWipeGeneration() !== wipeGen) return false
            const { event, protocol, wireId, orderMs } = await createEncryptedDmEvent({
              content: wireContent,
              recipientPubkey: pk,
              signer,
              protocol: chosenProtocol,
              messageId: localMsgId,
              action: target ? { type: 'reply', targetId: target } : undefined,
            })
            if (identityManager.getWipeGeneration() !== wipeGen) return false
            processedWrapIdsRef.current.add(event.id)
            return await publishChatWire({
              rowId: localMsgId,
              publish: (ack) => pool.publish([...new Set([...targetRelays, ...dmRelaysRef.current])], event, undefined, ack),
              isCurrent: () => identityManager.getWipeGeneration() === wipeGen,
              queueRetry: (retry) => dmSendQueueRef.current.enqueue(`dm:${pk}`, retry, () => false),
              update: (deliveryStatus) => setThreads((prev) => prev.map((t) => {
                if (t.peerPubkey !== pk) return t
                const messages = t.messages.map((m) => m.id === localMsgId
                  ? { ...m, wireId, protocol, orderMs, createdAt: Math.floor(orderMs / 1000),
                      voiceMemo, content: cleanCaption,
                      deliveryStatus: m.deliveryStatus === 'read' || m.deliveryStatus === 'delivered'
                        ? m.deliveryStatus : deliveryStatus }
                  : m).sort(compareDmMessages)
                const tail = messages.at(-1)
                return { ...t, protocol, messages, lastMessageAt: tail?.createdAt ?? 0,
                  lastPreview: tail ? formatDmPreview(tail) : '' }
              }).sort((a, b) => b.lastMessageAt - a.lastMessageAt)),
              onSuccess: () => onNotifyPushPokeRef.current?.({
                recipientPubkeys: [pk],
                category: 'dm',
                eventId: localMsgId,
              }),
              onFailure: (reason) => onErrorRef.current?.('Encrypted voice DM failed', reason, localMsgId),
            })
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
      protocolOverride?: DmProtocol,
      replyToId?: string
    ): Promise<boolean> => {
      if (!pool) return false
      const pk = peerPubkey.toLowerCase()
      const cleanCaption = caption?.trim() ?? ''

      const existingThread = threadsRef.current.find((t) => t.peerPubkey === pk)
      const parent = replyToId ? existingThread?.messages.find(m => m.id === replyToId) : undefined
      const target = parent && dmTargetId(parent)
      if (replyToId && !target) {
        onErrorRef.current?.('Cannot reply', 'This message has no shared ID in this conversation.')
        return false
      }
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
              replyToId: target,
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
            await pool.waitForChatRelay(targetRelays)
            if (identityManager.getWipeGeneration() !== wipeGen) return false
            const { event, protocol, wireId, orderMs } = await createEncryptedDmEvent({
              content: wireContent,
              recipientPubkey: pk,
              signer,
              protocol: chosenProtocol,
              messageId: localMsgId,
              action: target ? { type: 'reply', targetId: target } : undefined,
            })
            if (identityManager.getWipeGeneration() !== wipeGen) return false
            processedWrapIdsRef.current.add(event.id)
            return await publishChatWire({
              rowId: localMsgId,
              publish: (ack) => pool.publish([...new Set([...targetRelays, ...dmRelaysRef.current])], event, undefined, ack),
              isCurrent: () => identityManager.getWipeGeneration() === wipeGen,
              queueRetry: (retry) => dmSendQueueRef.current.enqueue(`dm:${pk}`, retry, () => false),
              update: (deliveryStatus) => setThreads((prev) => prev.map((t) => {
                if (t.peerPubkey !== pk) return t
                const messages = t.messages.map((m) => m.id === localMsgId
                  ? { ...m, wireId, protocol, orderMs, createdAt: Math.floor(orderMs / 1000),
                      imageAttachment, content: cleanCaption,
                      deliveryStatus: m.deliveryStatus === 'read' || m.deliveryStatus === 'delivered'
                        ? m.deliveryStatus : deliveryStatus }
                  : m).sort(compareDmMessages)
                const tail = messages.at(-1)
                return { ...t, protocol, messages, lastMessageAt: tail?.createdAt ?? 0,
                  lastPreview: tail ? formatDmPreview(tail) : '' }
              }).sort((a, b) => b.lastMessageAt - a.lastMessageAt)),
              onSuccess: () => onNotifyPushPokeRef.current?.({
                recipientPubkeys: [pk],
                category: 'dm',
                eventId: localMsgId,
              }),
              onFailure: (reason) => onErrorRef.current?.('Encrypted image DM failed', reason, localMsgId),
            })
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

  const sendDmReaction = useCallback(async (peer: string, messageId: string, emoji: string) => {
    const pk = peer.toLowerCase()
    const thread = threadsRef.current.find((t) => t.peerPubkey === pk)
    const parent = thread?.messages.find((m) => m.id === messageId)
    const targetId = parent && dmTargetId(parent)
    if (!pool || !thread || !parent || !targetId || !emoji || emoji.length > 32 || /\s/u.test(emoji)) return
    const signer = identityManager.getKeyMaterialForGeohash(activeGeohash)
    const sender = signer.pubkey.toLowerCase()
    if (parent.reactions?.some((r) => r.emoji === emoji && r.pubkeys.includes(sender))) return
    const key = JSON.stringify([pk, targetId, sender, emoji])
    const inflight = outgoingReactions.current
    if (inflight.has(key)) return
    const reaction: DmReactionUpdate = { peer: pk, target: targetId, sender, emoji, own: true }
    const wipeGen = identityManager.getWipeGeneration()
    const isCurrent = () => inflight.get(key) === reaction &&
      identityManager.getWipeGeneration() === wipeGen &&
      identityManager.getMasterKeyMaterial().pubkey.toLowerCase() === sender
    inflight.set(key, reaction)
    updateOptimisticReactions()
    try {
      const { event } = await createEncryptedDmEvent({ content: emoji, signer, recipientPubkey: pk,
        protocol: thread.protocol, action: { type: 'reaction', targetId } })
      if (!isCurrent()) return
      const result = await pool.publish([...dmRelaysRef.current], event)
      if (!isCurrent()) return
      if (!result.acceptedRelays.length) throw new Error('No DM relay accepted the encrypted reaction.')
      setThreads((prev) => applyDmReaction(prev, reaction))
    } catch (err) {
      if (isCurrent()) onErrorRef.current?.('Private reaction failed',
        err instanceof Error ? err.message : 'Unable to send reaction')
    } finally {
      if (inflight.get(key) === reaction) {
        inflight.delete(key)
        updateOptimisticReactions()
      }
    }
  }, [pool, identityManager, activeGeohash, updateOptimisticReactions])

  const clearThread = useCallback((peerPubkey: string) => {
    const pk = peerPubkey.toLowerCase()
    dropReactionsForPeer(pk)
    setThreads((prev) =>
      prev.map((t) => (t.peerPubkey === pk ? { ...t, messages: [], lastPreview: '', unreadCount: 0 } : t))
    )
  }, [dropReactionsForPeer])

  const closeThread = useCallback((peerPubkey: string) => {
    const pk = peerPubkey.trim().toLowerCase()
    if (!pk) return
    dropReactionsForPeer(pk)
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
  }, [dropReactionsForPeer])

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
      const metaNick =
        peerMeta?.peerNickname && !isAutoAnonNickname(peerMeta.peerNickname)
          ? peerMeta.peerNickname.trim().slice(0, 32)
          : undefined

      const existingThread = threadsRef.current.find((t) => t.peerPubkey === pk)
      const shouldUpgradeNameOnly = Boolean(
        existingThread && metaNick && isAutoAnonNickname(existingThread.peerNickname)
      )

      if (validIncoming.length === 0 && !shouldUpgradeNameOnly) return 0

      const inboundById = new Map(validIncoming.map(m => [m.id, m]))
      const existingById = new Map(existingThread?.messages.map(m => [m.id, m]))
      const changes = validIncoming.filter(m => {
        const existing = existingById.get(m.id)
        return !existing || mergeDmMessageMetadata(existing, m) !== existing
      }).length
      if (!changes && !shouldUpgradeNameOnly) return 0

      setThreads((prev) => {
        const idx = prev.findIndex((t) => t.peerPubkey === pk)
        if (idx !== -1) {
          const existing = prev[idx]
          const seen = new Set(existing.messages.map(m => m.id))
          const toAdd = [...inboundById.values()].filter(m => !seen.has(m.id))
          const withMetadata = existing.messages.map(m => {
            const incoming = inboundById.get(m.id)
            return incoming ? mergeDmMessageMetadata(m, incoming) : m
          })
          const metadataChanged = withMetadata.some((m, i) => m !== existing.messages[i])
          const nextNick = pickBestPeerNickname(
            pk,
            metaNick,
            existing.peerNickname,
            presenceTracker.getNickname(pk)
          )
          const nameChanged = nextNick !== existing.peerNickname
          if (toAdd.length === 0 && !nameChanged && !metadataChanged) return prev

          if (toAdd.length === 0) {
            const copy = [...prev]
            copy[idx] = {
              ...existing,
              peerNickname: nextNick,
              peerDisplayHandle: formatDisplayHandle(nextNick, pk),
              messages: withMetadata,
            }
            return copy
          }

          const merged = [...withMetadata, ...toAdd].sort(compareDmMessages).slice(-150)
          const tail = merged[merged.length - 1]
          const updated: DmThread = {
            ...existing,
            peerNickname: nextNick,
            peerDisplayHandle: formatDisplayHandle(nextNick, pk),
            messages: merged,
            lastMessageAt: tail ? tail.createdAt : existing.lastMessageAt,
            lastPreview: tail ? formatDmPreview(tail) : existing.lastPreview,
          }
          const copy = [...prev]
          copy[idx] = updated
          copy.sort((a, b) => b.lastMessageAt - a.lastMessageAt)
          return copy
        }
        if (validIncoming.length === 0) return prev
        const sorted = [...validIncoming].sort(compareDmMessages).slice(-150)
        const tail = sorted[sorted.length - 1]
        const nick = pickBestPeerNickname(pk, metaNick, presenceTracker.getNickname(pk))
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
      return changes || Number(shouldUpgradeNameOnly)
    },
    [identityManager, presenceTracker]
  )

  const applySyncedDmPeerNames = useCallback(
    (namesByPubkey: Record<string, string>, opts?: { upgradeAnonOnly?: boolean }): number => {
      const cleanMap = new Map<string, string>()
      for (const [rawPk, rawName] of Object.entries(namesByPubkey)) {
        const pk = rawPk.trim().toLowerCase()
        if (!/^[0-9a-f]{64}$/.test(pk)) continue
        const cleanName = typeof rawName === 'string' ? rawName.trim().slice(0, 32) : ''
        if (isAutoAnonNickname(cleanName)) continue
        cleanMap.set(pk, cleanName)
      }
      if (cleanMap.size === 0) return 0

      let expectedCount = 0
      for (const t of threadsRef.current) {
        const incomingName = cleanMap.get(t.peerPubkey.toLowerCase())
        if (!incomingName) continue
        if (opts?.upgradeAnonOnly && !isAutoAnonNickname(t.peerNickname)) continue
        if (incomingName !== t.peerNickname) expectedCount += 1
      }

      setThreads((prev) => {
        let changed = false
        const next = prev.map((t) => {
          const incomingName = cleanMap.get(t.peerPubkey.toLowerCase())
          if (!incomingName) return t
          if (opts?.upgradeAnonOnly && !isAutoAnonNickname(t.peerNickname)) return t
          if (incomingName === t.peerNickname) return t
          changed = true
          return {
            ...t,
            peerNickname: incomingName,
            peerDisplayHandle: formatDisplayHandle(incomingName, t.peerPubkey),
          }
        })
        return changed ? next : prev
      })
      return expectedCount
    },
    []
  )

  const clearAllDms = useCallback(() => {
    dmSendQueueRef.current.clearAll()
    processedWrapIdsRef.current.clear()
    pendingReactions.current.clear()
    outgoingReactions.current.clear()
    updateOptimisticReactions()
    dmClearedAtRef.current = {}
    setDmClearedAt({})
    setThreads([])
  }, [updateOptimisticReactions])

  const sanitizedThreads = useMemo(
    () =>
      threads.map((t) =>
        blockedPubkeys.has(t.peerPubkey.toLowerCase())
          ? { ...t, unreadCount: 0, lastPreview: '' }
          : t
      ),
    [threads, blockedPubkeys]
  )

  const visibleDmThreads = useMemo(
    () => optimisticReactions.reduce((result, reaction) =>
      reaction.sender === reactionIdentity ? applyDmReaction(result, reaction) : result, sanitizedThreads),
    [optimisticReactions, reactionIdentity, sanitizedThreads],
  )

  const totalDmUnread = useMemo(
    () => sanitizedThreads.reduce((sum, t) => sum + t.unreadCount, 0),
    [sanitizedThreads]
  )

  return {
    dmThreads: sanitizedThreads,
    visibleDmThreads,
    dmClearedAt,
    totalDmUnread,
    ensureThread,
    sendDirectMessage,
    sendDmReaction,
    sendDirectVoiceMemo,
    sendDirectImageAttachment,
    clearThread,
    closeThread,
    mergeSyncedDmClearedAt,
    mergeSyncedDmMessages,
    applySyncedDmPeerNames,
    clearAllDms,
  }
}
