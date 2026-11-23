import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
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
import {
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
    onError,
  } = opts

  const [threads, setThreads] = useState<DmThread[]>(() => loadDmThreads())
  const dmClearedAtRef = useRef<Record<string, number>>(loadDmClearedAt())
  const processedWrapIdsRef = useRef<Set<string>>(new Set())
  const dmBacklogSettledRef = useRef<boolean>(false)
  const dmSubSeqRef = useRef<number>(0)
  const activeDmPeerRef = useRef<string | null>(activeDmPeer)
  const blockedRef = useRef<Set<string>>(blockedPubkeys)
  const onIncomingRef = useRef(onIncomingDm)

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

      const existingThread = threads.find((t) => t.peerPubkey === pk)
      const signer = identityManager.getKeyMaterialForGeohash(activeGeohash)
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

      const nick = existingThread?.peerNickname || presenceTracker.getNickname(pk) || `anon${pk.slice(-4)}`
      const handle = formatDisplayHandle(nick, pk)

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

      try {
        const { event, protocol } = await createEncryptedDmEvent({
          content,
          recipientPubkey: pk,
          signer,
          protocol: chosenProtocol,
          messageId: localMsgId,
        })
        processedWrapIdsRef.current.add(event.id)
        const res = await pool.publish(dmRelays, event)
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

        if (!ok) {
          onError?.('DM failed to publish', 'No DM-capable relay accepted the gift wrap.')
        }
        return ok
      } catch (err) {
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
        onError?.('DM encryption error', err instanceof Error ? err.message : 'Unable to send encrypted DM')
        return false
      }
    },
    [pool, threads, identityManager, activeGeohash, presenceTracker, dmRelays, onError]
  )

  const sendDirectVoiceMemo = useCallback(
    async (
      peerPubkey: string,
      voiceMemo: VoiceMemoAttachment,
      caption?: string,
      protocolOverride?: DmProtocol
    ): Promise<boolean> => {
      if (!pool) return false
      const pk = peerPubkey.toLowerCase()
      const cleanCaption = caption?.trim() ?? ''
      const wireContent = encodeDmVoicePayload(voiceMemo, cleanCaption)

      const existingThread = threads.find((t) => t.peerPubkey === pk)
      const signer = identityManager.getKeyMaterialForGeohash(activeGeohash)
      const chosenProtocol: DmProtocol =
        protocolOverride ??
        existingThread?.protocol ??
        (signer.mode === 'extension' ? 'nip17' : 'bitchat')

      const localMsgId = bytesToHex(crypto.getRandomValues(new Uint8Array(8)))
      const nowMs = Date.now()
      const nowSec = Math.floor(nowMs / 1000)

      const optimisticBase: DmMessage = {
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

      const nick = existingThread?.peerNickname || presenceTracker.getNickname(pk) || `anon${pk.slice(-4)}`
      const handle = formatDisplayHandle(nick, pk)

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

      try {
        const { event, protocol } = await createEncryptedDmEvent({
          content: wireContent,
          recipientPubkey: pk,
          signer,
          protocol: chosenProtocol,
          messageId: localMsgId,
        })
        processedWrapIdsRef.current.add(event.id)
        const res = await pool.publish(dmRelays, event)
        const ok = res.acceptedRelays.length > 0

        setThreads((prev) =>
          prev.map((t) => {
            if (t.peerPubkey !== pk) return t
            return {
              ...t,
              protocol,
              messages: t.messages.map((m) =>
                m.id === localMsgId ? { ...m, protocol, deliveryStatus: ok ? 'sent' : 'failed' } : m
              ),
            }
          })
        )

        if (!ok) {
          onError?.('Encrypted voice DM failed', 'No DM-capable relay accepted the gift wrap.')
        }
        return ok
      } catch (err) {
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
        onError?.(
          'Encrypted voice DM error',
          err instanceof Error ? err.message : 'Unable to send encrypted voice memo'
        )
        return false
      }
    },
    [pool, threads, identityManager, activeGeohash, presenceTracker, dmRelays, onError]
  )

  const sendDirectImageAttachment = useCallback(
    async (
      peerPubkey: string,
      imageAttachment: ImageAttachment,
      caption?: string,
      protocolOverride?: DmProtocol
    ): Promise<boolean> => {
      if (!pool) return false
      const pk = peerPubkey.toLowerCase()
      const cleanCaption = caption?.trim() ?? ''
      const wireContent = encodeDmImagePayload(imageAttachment, cleanCaption)

      const existingThread = threads.find((t) => t.peerPubkey === pk)
      const signer = identityManager.getKeyMaterialForGeohash(activeGeohash)
      const chosenProtocol: DmProtocol =
        protocolOverride ??
        existingThread?.protocol ??
        (signer.mode === 'extension' ? 'nip17' : 'bitchat')

      const localMsgId = bytesToHex(crypto.getRandomValues(new Uint8Array(8)))
      const nowMs = Date.now()
      const nowSec = Math.floor(nowMs / 1000)

      const optimisticBase: DmMessage = {
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

      const nick = existingThread?.peerNickname || presenceTracker.getNickname(pk) || `anon${pk.slice(-4)}`
      const handle = formatDisplayHandle(nick, pk)

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

      try {
        const { event, protocol } = await createEncryptedDmEvent({
          content: wireContent,
          recipientPubkey: pk,
          signer,
          protocol: chosenProtocol,
          messageId: localMsgId,
        })
        processedWrapIdsRef.current.add(event.id)
        const res = await pool.publish(dmRelays, event)
        const ok = res.acceptedRelays.length > 0

        setThreads((prev) =>
          prev.map((t) => {
            if (t.peerPubkey !== pk) return t
            return {
              ...t,
              protocol,
              messages: t.messages.map((m) =>
                m.id === localMsgId ? { ...m, protocol, deliveryStatus: ok ? 'sent' : 'failed' } : m
              ),
            }
          })
        )

        if (!ok) {
          onError?.('Encrypted image DM failed', 'No DM-capable relay accepted the gift wrap.')
        }
        return ok
      } catch (err) {
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
        onError?.(
          'Encrypted image DM error',
          err instanceof Error ? err.message : 'Unable to send encrypted image'
        )
        return false
      }
    },
    [pool, threads, identityManager, activeGeohash, presenceTracker, dmRelays, onError]
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
    saveDmClearedAt(nextClearedAt)
    setThreads((prev) => {
      const next = prev.filter((t) => t.peerPubkey !== pk)
      saveDmThreads(next)
      return next
    })
  }, [])

  const clearAllDms = useCallback(() => {
    processedWrapIdsRef.current.clear()
    dmClearedAtRef.current = {}
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
    totalDmUnread,
    ensureThread,
    sendDirectMessage,
    sendDirectVoiceMemo,
    sendDirectImageAttachment,
    clearThread,
    closeThread,
    clearAllDms,
  }
}
