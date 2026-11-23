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

interface PulseMessageRecord {
  id: string
  pubkey: string
  sender: string
  preview: string
  tsMs: number
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
  } = options

  const [pulseRooms, setPulseRooms] = useState<PulseRoom[]>([])
  const roomsRef = useRef<Map<string, MutablePulseRoom>>(new Map())
  const seenIdsRef = useRef<Set<string>>(new Set())
  const dirtyRef = useRef(false)

  const blockedSetRef = useRef<Set<string>>(blockedSet)
  const trustedSetRef = useRef<Set<string>>(trustedSet)
  const ownPubkeysRef = useRef<Set<string>>(ownPubkeys)
  const strictWhitelistRef = useRef<boolean>(strictWhitelistMode)

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

  const flushRooms = useCallback(() => {
    const now = Date.now()
    const cutoff = now - PULSE_WINDOW_MS
    const oneMinAgo = now - 60_000
    const blocked = blockedSetRef.current
    const trusted = trustedSetRef.current
    const own = ownPubkeysRef.current
    const strict = strictWhitelistRef.current
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
        if (!latestMsg || m.tsMs >= latestMsg.tsMs) {
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

    setPulseRooms(next.slice(0, MAX_PULSE_ROOMS))
    dirtyRef.current = false
  }, [])

  // Immediately scrub/recompute Active Rooms & Pinned previews when mute/block or whitelist changes
  useEffect(() => {
    flushRooms()
  }, [blockedSet, trustedSet, ownPubkeys, strictWhitelistMode, flushRooms])

  useEffect(() => {
    if (!pool || !enabled) return

    let cancelled = false
    const since = Math.floor(Date.now() / 1000) - 600
    const unsub = pool.subscribe(
      `agnostr-global-pulse-${++pulseSubSeq}`,
      PULSE_RELAYS,
      [{ kinds: [KIND_GEOHASH_CHAT, KIND_GEOHASH_PRESENCE, KIND_NAMED_RADIO_CHAT], since, limit: 100 }],
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

          seenIdsRef.current.add(ev.id)
          if (seenIdsRef.current.size > 3000) {
            const first = seenIdsRef.current.values().next().value
            if (first) seenIdsRef.current.delete(first)
          }

          const now = Date.now()
          const evMs = Math.min(ev.created_at * 1000, now)

          let room = roomsRef.current.get(roomKey)
          if (!room) {
            if (isTopic) {
              room = {
                geohash: roomKey,
                center: { lat: 0, lon: 0 },
                precision: 0,
                nearestCity: null,
                messages: [],
                peers: new Map(),
                lastActivityAt: evMs,
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
                lastActivityAt: evMs,
              }
            }
            roomsRef.current.set(roomKey, room)
          }

          room.peers.set(pk, Math.max(room.peers.get(pk) ?? 0, evMs))
          if (evMs > room.lastActivityAt) {
            room.lastActivityAt = evMs
          }

          if (ev.kind === KIND_GEOHASH_CHAT || ev.kind === KIND_NAMED_RADIO_CHAT) {
            const text = (ev.content ?? '').trim()
            if (text && !room.messages.some((m) => m.id === ev.id)) {
              const sender = getTagValue(ev.tags, 'n')?.trim() || `anon${pk.slice(-4)}`
              room.messages.push({
                id: ev.id,
                pubkey: pk,
                sender,
                preview: text.slice(0, 96),
                tsMs: evMs,
              })
              if (room.messages.length > MAX_ROOM_MESSAGES) {
                room.messages.sort((a, b) => a.tsMs - b.tsMs)
                room.messages = room.messages.slice(-MAX_ROOM_MESSAGES)
              }
            }
          }

          dirtyRef.current = true
        },
      }
    )

    const flushInterval = window.setInterval(() => {
      if (dirtyRef.current) flushRooms()
    }, 900)

    const pruneInterval = window.setInterval(() => {
      flushRooms()
    }, 20_000)

    return () => {
      cancelled = true
      unsub()
      window.clearInterval(flushInterval)
      window.clearInterval(pruneInterval)
    }
  }, [pool, enabled, flushRooms])

  const clearPulse = useCallback(() => {
    roomsRef.current.clear()
    seenIdsRef.current.clear()
    setPulseRooms([])
  }, [])

  return { pulseRooms, clearPulse }
}
