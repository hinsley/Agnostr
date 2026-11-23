import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { PulseRoom } from '../types/protocol.ts'
import {
  extractGeohashTag,
  extractTopicChannelTag,
  getTagValue,
  KIND_GEOHASH_CHAT,
  KIND_GEOHASH_PRESENCE,
  KIND_NAMED_RADIO_CHAT,
  verifyEventCached,
} from '../lib/bitchatProtocol.ts'
import { decodeCenter, findNearestCityLabel } from '../lib/geohash.ts'
import { PULSE_RELAYS } from '../lib/geoRelays.ts'
import { TOPIC_CHANNEL_PREFIX } from '../lib/radioChannel.ts'
import type { RelayPool } from '../lib/relayPool.ts'

const PULSE_WINDOW_MS = 15 * 60 * 1000
const MAX_PULSE_ROOMS = 48
const MAX_ROOM_MESSAGES = 48
const FLUSH_DEBOUNCE_MS = 150

const IMAGE_URL_EXT_RE = /\.(?:webp|jpe?g|png|gif|avif|bmp)(?:[?#].*)?$/i
const AUDIO_URL_EXT_RE = /\.(?:webm|weba|m4a|mp4|ogg|opus|mp3|wav)(?:[?#].*)?$/i

export interface FormatRadioPreviewOptions {
  content?: string | null
  hasImage?: boolean
  hasVoice?: boolean
  mediaUrl?: string | null
  tags?: readonly (readonly string[])[]
}

export function formatRadioPreviewText(opts: FormatRadioPreviewOptions): string {
  let hasImage = Boolean(opts.hasImage)
  let hasVoice = Boolean(opts.hasVoice)
  const urlsToStrip: string[] = []
  if (opts.mediaUrl) urlsToStrip.push(opts.mediaUrl)

  if (opts.tags && opts.tags.length > 0) {
    for (const tag of opts.tags) {
      if (tag[0] !== 'imeta' || tag.length < 2) continue
      let imetaMime = ''
      let imetaUrl = ''
      for (let i = 1; i < tag.length; i += 1) {
        const entry = tag[i]
        if (typeof entry !== 'string') continue
        if (entry.startsWith('m ')) {
          imetaMime = entry.slice(2).trim().toLowerCase()
        } else if (entry.startsWith('url ')) {
          imetaUrl = entry.slice(4).trim()
        }
      }
      if (imetaUrl) urlsToStrip.push(imetaUrl)
      if (imetaMime.startsWith('image/')) {
        hasImage = true
      } else if (imetaMime.startsWith('audio/')) {
        hasVoice = true
      } else if (imetaUrl) {
        if (IMAGE_URL_EXT_RE.test(imetaUrl)) hasImage = true
        else if (AUDIO_URL_EXT_RE.test(imetaUrl)) hasVoice = true
      }
    }
  }

  let cleaned = opts.content ?? ''
  for (const url of urlsToStrip) {
    if (url && cleaned.includes(url)) {
      cleaned = cleaned.split(url).join(' ')
    }
  }
  cleaned = cleaned.replace(/\s+/g, ' ').trim()

  if (hasImage) {
    return cleaned ? `Photo · ${cleaned}`.slice(0, 96) : 'Photo'
  }
  if (hasVoice) {
    return cleaned ? `Voice memo · ${cleaned}`.slice(0, 96) : 'Voice memo'
  }
  return cleaned.slice(0, 96)
}

export interface RecordRoomMessageInput {
  id: string
  replaceId?: string
  geohash: string
  pubkey: string
  sender: string
  preview: string
  createdAtSec: number
  isAuthoritative?: boolean
}

interface PulseMessageRecord {
  id: string
  pubkey: string
  sender: string
  preview: string
  createdAtSec: number
  tsMs: number
  seq: number
  isAuthoritative: boolean
}

function comparePulseMessages(a: PulseMessageRecord, b: PulseMessageRecord): number {
  if (a.createdAtSec !== b.createdAtSec) return a.createdAtSec - b.createdAtSec
  if (a.isAuthoritative !== b.isAuthoritative) return a.isAuthoritative ? 1 : -1
  return a.seq - b.seq
}

interface MutablePulseRoom {
  geohash: string
  center: { lat: number; lon: number }
  precision: number
  nearestCity: string | null
  messages: PulseMessageRecord[]
  peers: Map<string, number> // pubkey -> lastSeenMs
  lastActivityAt: number
}

export interface UseGlobalPulseOptions {
  blockedSet?: Set<string>
  trustedSet?: Set<string>
  ownPubkeys?: Set<string>
  strictWhitelistMode?: boolean
  priorityChannels?: readonly string[]
}

const EMPTY_SET = new Set<string>()
let pulseSubSeq = 0

export function useGlobalPulse(
  pool: RelayPool | null,
  enabled = true,
  options: UseGlobalPulseOptions = {}
) {
  const {
    blockedSet = EMPTY_SET,
    trustedSet = EMPTY_SET,
    ownPubkeys = EMPTY_SET,
    strictWhitelistMode = false,
    priorityChannels,
  } = options

  const priorityChannelsKey = priorityChannels
    ? Array.from(
        new Set(
          priorityChannels
            .map((ch) => ch.trim().toLowerCase())
            .filter(Boolean)
        )
      )
        .sort()
        .join(',')
    : ''

  const [pulseRooms, setPulseRooms] = useState<PulseRoom[]>([])
  const roomsRef = useRef<Map<string, MutablePulseRoom>>(new Map())
  const seenIdsRef = useRef<Set<string>>(new Set())
  const msgSeqRef = useRef(0)
  const dirtyRef = useRef(false)
  const flushTimerRef = useRef<number | null>(null)

  const blockedSetRef = useRef<Set<string>>(blockedSet)
  const trustedSetRef = useRef<Set<string>>(trustedSet)
  const ownPubkeysRef = useRef<Set<string>>(ownPubkeys)
  const strictWhitelistRef = useRef<boolean>(strictWhitelistMode)
  const priorityChannelsRef = useRef<Set<string>>(
    new Set(priorityChannelsKey ? priorityChannelsKey.split(',') : [])
  )

  useLayoutEffect(() => {
    blockedSetRef.current = blockedSet
  }, [blockedSet])

  useLayoutEffect(() => {
    trustedSetRef.current = trustedSet
  }, [trustedSet])

  useLayoutEffect(() => {
    ownPubkeysRef.current = ownPubkeys
  }, [ownPubkeys])

  useLayoutEffect(() => {
    strictWhitelistRef.current = strictWhitelistMode
  }, [strictWhitelistMode])

  useLayoutEffect(() => {
    priorityChannelsRef.current = new Set(
      priorityChannelsKey ? priorityChannelsKey.split(',') : []
    )
  }, [priorityChannelsKey])

  const rememberSeenId = useCallback((id: string) => {
    if (!id) return
    seenIdsRef.current.add(id)
    if (seenIdsRef.current.size > 3000) {
      const first = seenIdsRef.current.values().next().value
      if (first) seenIdsRef.current.delete(first)
    }
  }, [])

  const ensureRoom = useCallback((roomKey: string, initialMs: number): MutablePulseRoom => {
    let room = roomsRef.current.get(roomKey)
    if (room) return room
    const isTopic = roomKey.startsWith(TOPIC_CHANNEL_PREFIX)
    if (isTopic) {
      room = {
        geohash: roomKey,
        center: { lat: 0, lon: 0 },
        precision: 0,
        nearestCity: null,
        messages: [],
        peers: new Map(),
        lastActivityAt: initialMs,
      }
    } else {
      const center = decodeCenter(roomKey)
      room = {
        geohash: roomKey,
        center,
        precision: roomKey.length,
        nearestCity: findNearestCityLabel(center.lat, center.lon, roomKey),
        messages: [],
        peers: new Map(),
        lastActivityAt: initialMs,
      }
    }
    roomsRef.current.set(roomKey, room)
    return room
  }, [])

  const upsertRoomMessage = useCallback(
    (
      room: MutablePulseRoom,
      params: {
        id: string
        replaceId?: string
        pubkey: string
        sender: string
        preview: string
        createdAtSec: number
        tsMs: number
        isAuthoritative: boolean
      }
    ) => {
      if (params.isAuthoritative) {
        for (const msg of room.messages) {
          if (msg.id !== params.id && msg.id !== params.replaceId && msg.isAuthoritative) {
            msg.isAuthoritative = false
          }
        }
      }

      if (params.replaceId) {
        const replaceIdx = room.messages.findIndex((m) => m.id === params.replaceId)
        if (replaceIdx !== -1) {
          const target = room.messages[replaceIdx]
          const dupIdx = room.messages.findIndex(
            (m, i) => i !== replaceIdx && m.id === params.id
          )
          const bumpedSeq =
            params.isAuthoritative || params.createdAtSec > target.createdAtSec
              ? ++msgSeqRef.current
              : target.seq
          room.messages[replaceIdx] = {
            id: params.id,
            pubkey: params.pubkey,
            sender: params.sender || target.sender,
            preview: params.preview || target.preview,
            createdAtSec: params.createdAtSec,
            tsMs: params.tsMs,
            seq: bumpedSeq,
            isAuthoritative: params.isAuthoritative || target.isAuthoritative,
          }
          if (dupIdx !== -1) {
            room.messages.splice(dupIdx, 1)
          }
          return
        }
      }

      const existingIdx = room.messages.findIndex((m) => m.id === params.id)
      if (existingIdx !== -1) {
        const existing = room.messages[existingIdx]
        existing.pubkey = params.pubkey
        if (params.sender) existing.sender = params.sender
        if (params.preview) existing.preview = params.preview
        existing.createdAtSec = params.createdAtSec
        existing.tsMs = params.tsMs
        if (params.isAuthoritative) {
          existing.isAuthoritative = true
          existing.seq = ++msgSeqRef.current
        }
        return
      }

      room.messages.push({
        id: params.id,
        pubkey: params.pubkey,
        sender: params.sender,
        preview: params.preview,
        createdAtSec: params.createdAtSec,
        tsMs: params.tsMs,
        seq: ++msgSeqRef.current,
        isAuthoritative: params.isAuthoritative,
      })

      if (room.messages.length > MAX_ROOM_MESSAGES) {
        room.messages.sort(comparePulseMessages)
        room.messages = room.messages.slice(-MAX_ROOM_MESSAGES)
      }
    },
    []
  )

  const flushRooms = useCallback(() => {
    const now = Date.now()
    const cutoff = now - PULSE_WINDOW_MS
    const oneMinAgo = now - 60_000
    const blocked = blockedSetRef.current
    const trusted = trustedSetRef.current
    const own = ownPubkeysRef.current
    const strict = strictWhitelistRef.current
    const priority = priorityChannelsRef.current
    const next: PulseRoom[] = []

    for (const [gh, room] of Array.from(roomsRef.current.entries())) {
      // Permanently scrub expired & blocked/muted messages and peers
      room.messages = room.messages.filter(
        (m) => m.tsMs >= cutoff && !blocked.has(m.pubkey)
      )
      for (const [pk, seenMs] of Array.from(room.peers.entries())) {
        if (seenMs < cutoff || blocked.has(pk)) {
          room.peers.delete(pk)
        }
      }

      if (room.messages.length === 0 && room.peers.size === 0) {
        roomsRef.current.delete(gh)
        continue
      }

      const isAllowedPubkey = (pk: string): boolean => {
        if (blocked.has(pk)) return false
        if (!strict) return true
        return own.has(pk) || trusted.has(pk)
      }

      const visibleMessages = strict
        ? room.messages.filter((m) => isAllowedPubkey(m.pubkey))
        : room.messages

      let visiblePeerCount = 0
      let latestPeerMs = 0
      for (const [pk, seenMs] of room.peers.entries()) {
        if (!isAllowedPubkey(pk)) continue
        visiblePeerCount += 1
        if (seenMs > latestPeerMs) latestPeerMs = seenMs
      }

      if (visibleMessages.length === 0 && visiblePeerCount === 0) {
        continue
      }

      let latestMsg: PulseMessageRecord | null = null
      let recentMin = 0
      for (const m of visibleMessages) {
        if (m.tsMs >= oneMinAgo) recentMin += 1
        if (!latestMsg || comparePulseMessages(latestMsg, m) < 0) {
          latestMsg = m
        }
      }

      const lastActivityAt = Math.max(latestPeerMs, latestMsg?.tsMs ?? 0)
      room.lastActivityAt = Math.max(
        latestPeerMs,
        room.messages.reduce((max, m) => (m.tsMs > max ? m.tsMs : max), 0)
      )

      next.push({
        geohash: room.geohash,
        center: room.center,
        precision: room.precision,
        messageCount: visibleMessages.length,
        peerCount: Math.max(visiblePeerCount, visibleMessages.length > 0 ? 1 : 0),
        lastActivityAt,
        lastMessageAt: latestMsg?.tsMs,
        lastMessageId: latestMsg?.id,
        lastPreview: latestMsg?.preview ?? '',
        lastSender: latestMsg?.sender ?? '',
        lastSenderPubkey: latestMsg?.pubkey,
        messagesPerMin: recentMin,
        nearestCity: room.nearestCity,
      })
    }

    next.sort((a, b) => {
      // Favor rooms with actual chat messages first, then peer count, then recency
      const aScore = a.messageCount * 5 + a.peerCount * 2
      const bScore = b.messageCount * 5 + b.peerCount * 2
      if (aScore !== bScore) return bScore - aScore
      return b.lastActivityAt - a.lastActivityAt
    })

    let trimmed: PulseRoom[]
    if (next.length <= MAX_PULSE_ROOMS) {
      trimmed = next
    } else {
      const top = next.slice(0, MAX_PULSE_ROOMS)
      if (priority.size === 0) {
        trimmed = top
      } else {
        const topKeys = new Set(top.map((r) => r.geohash.toLowerCase()))
        const missingPriority = next
          .slice(MAX_PULSE_ROOMS)
          .filter(
            (r) =>
              priority.has(r.geohash.toLowerCase()) &&
              !topKeys.has(r.geohash.toLowerCase())
          )
        if (missingPriority.length === 0) {
          trimmed = top
        } else {
          const kept = [...top]
          for (const prioRoom of missingPriority) {
            let dropIdx = -1
            for (let i = kept.length - 1; i >= 0; i -= 1) {
              if (!priority.has(kept[i].geohash.toLowerCase())) {
                dropIdx = i
                break
              }
            }
            if (dropIdx !== -1) {
              kept.splice(dropIdx, 1)
            }
            kept.push(prioRoom)
          }
          trimmed = kept
        }
      }
    }

    setPulseRooms(trimmed)
    dirtyRef.current = false
  }, [])

  const scheduleFlush = useCallback(
    (immediate = false) => {
      dirtyRef.current = true
      if (immediate) {
        if (flushTimerRef.current !== null) {
          window.clearTimeout(flushTimerRef.current)
          flushTimerRef.current = null
        }
        flushRooms()
        return
      }
      if (flushTimerRef.current !== null) return
      flushTimerRef.current = window.setTimeout(() => {
        flushTimerRef.current = null
        if (dirtyRef.current) flushRooms()
      }, FLUSH_DEBOUNCE_MS)
    },
    [flushRooms]
  )

  useEffect(() => {
    return () => {
      if (flushTimerRef.current !== null) {
        window.clearTimeout(flushTimerRef.current)
        flushTimerRef.current = null
      }
    }
  }, [])

  // Immediately scrub/recompute Active Rooms & Pinned previews when mute/block, whitelist, or priority changes
  useEffect(() => {
    flushRooms()
  }, [blockedSet, trustedSet, ownPubkeys, strictWhitelistMode, priorityChannelsKey, flushRooms])

  const recordRoomMessage = useCallback(
    (input: RecordRoomMessageInput) => {
      const roomKey = input.geohash.trim().toLowerCase()
      const pk = input.pubkey.trim().toLowerCase()
      const preview = input.preview.trim().slice(0, 96)
      if (!roomKey || !input.id || !pk || !preview) return
      if (blockedSetRef.current.has(pk)) return

      const now = Date.now()
      const nowSec = Math.floor(now / 1000)
      const createdAtSec = Math.min(Math.floor(input.createdAtSec), nowSec)
      const tsMs = createdAtSec * 1000
      if (!Number.isFinite(tsMs) || tsMs < now - PULSE_WINDOW_MS) return

      rememberSeenId(input.id)
      const room = ensureRoom(roomKey, tsMs)
      room.peers.set(pk, Math.max(room.peers.get(pk) ?? 0, tsMs))
      if (tsMs > room.lastActivityAt) {
        room.lastActivityAt = tsMs
      }

      upsertRoomMessage(room, {
        id: input.id,
        replaceId: input.replaceId,
        pubkey: pk,
        sender: input.sender.trim() || `anon${pk.slice(-4)}`,
        preview,
        createdAtSec,
        tsMs,
        isAuthoritative: Boolean(input.isAuthoritative),
      })

      scheduleFlush(Boolean(input.isAuthoritative))
    },
    [ensureRoom, rememberSeenId, scheduleFlush, upsertRoomMessage]
  )

  const clearRoomMessages = useCallback(
    (geohash: string) => {
      const roomKey = geohash.trim().toLowerCase()
      if (!roomKey) return
      const room = roomsRef.current.get(roomKey)
      if (!room) return
      room.messages = []
      if (room.peers.size === 0) {
        roomsRef.current.delete(roomKey)
      }
      scheduleFlush(true)
    },
    [scheduleFlush]
  )

  useEffect(() => {
    if (!pool || !enabled) return

    let cancelled = false
    const since = Math.floor(Date.now() / 1000) - 600
    const unsub = pool.subscribe(
      `agnostr-global-pulse-${++pulseSubSeq}`,
      PULSE_RELAYS,
      [
        { kinds: [KIND_GEOHASH_CHAT, KIND_NAMED_RADIO_CHAT], since, limit: 150 },
        { kinds: [KIND_GEOHASH_PRESENCE], since, limit: 80 },
      ],
      {
        onEvent: (ev) => {
          if (cancelled) return
          if (
            ev.kind !== KIND_GEOHASH_CHAT &&
            ev.kind !== KIND_GEOHASH_PRESENCE &&
            ev.kind !== KIND_NAMED_RADIO_CHAT
          ) {
            return
          }
          if (seenIdsRef.current.has(ev.id)) return

          const pk = ev.pubkey.toLowerCase()
          if (blockedSetRef.current.has(pk)) return

          const isTopic = ev.kind === KIND_NAMED_RADIO_CHAT
          let roomKey: string | null = null
          if (isTopic) {
            const slug = extractTopicChannelTag(ev.tags)
            if (!slug) return
            roomKey = `${TOPIC_CHANNEL_PREFIX}${slug}`
          } else {
            roomKey = extractGeohashTag(ev.tags)
            if (!roomKey) return
          }
          if (!verifyEventCached(ev)) return
          if (cancelled || blockedSetRef.current.has(pk)) return

          rememberSeenId(ev.id)

          const now = Date.now()
          const nowSec = Math.floor(now / 1000)
          const evSec = Math.min(Math.floor(ev.created_at), nowSec)
          const evMs = evSec * 1000

          const room = ensureRoom(roomKey, evMs)
          room.peers.set(pk, Math.max(room.peers.get(pk) ?? 0, evMs))
          if (evMs > room.lastActivityAt) {
            room.lastActivityAt = evMs
          }

          if (ev.kind === KIND_GEOHASH_CHAT || ev.kind === KIND_NAMED_RADIO_CHAT) {
            const preview = formatRadioPreviewText({
              content: ev.content,
              tags: ev.tags,
            })
            if (preview) {
              const sender = getTagValue(ev.tags, 'n')?.trim() || `anon${pk.slice(-4)}`
              upsertRoomMessage(room, {
                id: ev.id,
                pubkey: pk,
                sender,
                preview,
                createdAtSec: evSec,
                tsMs: evMs,
                isAuthoritative: false,
              })
            }
          }

          scheduleFlush(false)
        },
      }
    )

    const pruneInterval = window.setInterval(() => {
      flushRooms()
    }, 20_000)

    return () => {
      cancelled = true
      unsub()
      window.clearInterval(pruneInterval)
      if (flushTimerRef.current !== null) {
        window.clearTimeout(flushTimerRef.current)
        flushTimerRef.current = null
      }
    }
  }, [pool, enabled, ensureRoom, flushRooms, rememberSeenId, scheduleFlush, upsertRoomMessage])

  const clearPulse = useCallback(() => {
    if (flushTimerRef.current !== null) {
      window.clearTimeout(flushTimerRef.current)
      flushTimerRef.current = null
    }
    roomsRef.current.clear()
    seenIdsRef.current.clear()
    dirtyRef.current = false
    setPulseRooms([])
  }, [])

  return { pulseRooms, recordRoomMessage, clearRoomMessages, clearPulse }
}
