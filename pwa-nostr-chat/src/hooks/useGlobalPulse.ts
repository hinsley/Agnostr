import { useCallback, useEffect, useRef, useState } from 'react'
import type { PulseRoom } from '../types/protocol.ts'
import {
  extractGeohashTag,
  getTagValue,
  KIND_GEOHASH_CHAT,
  KIND_GEOHASH_PRESENCE,
  verifyEventCached,
} from '../lib/bitchatProtocol.ts'
import { decodeCenter, findNearestCityLabel } from '../lib/geohash.ts'
import { PULSE_RELAYS } from '../lib/geoRelays.ts'
import type { RelayPool } from '../lib/relayPool.ts'

const PULSE_WINDOW_MS = 15 * 60 * 1000
const MAX_PULSE_ROOMS = 48

interface MutablePulseRoom {
  geohash: string
  center: { lat: number; lon: number }
  precision: number
  nearestCity: string | null
  messageTimestamps: number[]
  peers: Map<string, number> // pubkey -> lastSeenMs
  lastActivityAt: number
  lastPreview: string
  lastSender: string
}

export function useGlobalPulse(pool: RelayPool | null, enabled = true) {
  const [pulseRooms, setPulseRooms] = useState<PulseRoom[]>([])
  const roomsRef = useRef<Map<string, MutablePulseRoom>>(new Map())
  const seenIdsRef = useRef<Set<string>>(new Set())
  const dirtyRef = useRef(false)

  const flushRooms = useCallback(() => {
    const now = Date.now()
    const cutoff = now - PULSE_WINDOW_MS
    const oneMinAgo = now - 60_000
    const next: PulseRoom[] = []

    for (const [gh, room] of Array.from(roomsRef.current.entries())) {
      room.messageTimestamps = room.messageTimestamps.filter((ts) => ts >= cutoff)
      for (const [pk, seenMs] of Array.from(room.peers.entries())) {
        if (seenMs < cutoff) room.peers.delete(pk)
      }
      if (room.lastActivityAt < cutoff && room.peers.size === 0) {
        roomsRef.current.delete(gh)
        continue
      }
      const recentMin = room.messageTimestamps.filter((ts) => ts >= oneMinAgo).length
      next.push({
        geohash: room.geohash,
        center: room.center,
        precision: room.precision,
        messageCount: room.messageTimestamps.length,
        peerCount: Math.max(1, room.peers.size),
        lastActivityAt: room.lastActivityAt,
        lastPreview: room.lastPreview,
        lastSender: room.lastSender,
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

  useEffect(() => {
    if (!pool || !enabled) return

    const since = Math.floor(Date.now() / 1000) - 600
    const unsub = pool.subscribe(
      'agnostr-global-pulse',
      PULSE_RELAYS,
      [{ kinds: [KIND_GEOHASH_CHAT, KIND_GEOHASH_PRESENCE], since, limit: 80 }],
      {
        onEvent: (ev) => {
          if (ev.kind !== KIND_GEOHASH_CHAT && ev.kind !== KIND_GEOHASH_PRESENCE) return
          if (seenIdsRef.current.has(ev.id)) return
          const gh = extractGeohashTag(ev.tags)
          if (!gh) return
          if (!verifyEventCached(ev)) return

          seenIdsRef.current.add(ev.id)
          if (seenIdsRef.current.size > 3000) {
            const first = seenIdsRef.current.values().next().value
            if (first) seenIdsRef.current.delete(first)
          }

          const now = Date.now()
          const evMs = Math.min(ev.created_at * 1000, now)
          const pk = ev.pubkey.toLowerCase()

          let room = roomsRef.current.get(gh)
          if (!room) {
            const center = decodeCenter(gh)
            room = {
              geohash: gh,
              center,
              precision: gh.length,
              nearestCity: findNearestCityLabel(center.lat, center.lon, gh),
              messageTimestamps: [],
              peers: new Map(),
              lastActivityAt: evMs,
              lastPreview: '',
              lastSender: '',
            }
            roomsRef.current.set(gh, room)
          }

          room.peers.set(pk, Math.max(room.peers.get(pk) ?? 0, evMs))
          if (evMs > room.lastActivityAt) {
            room.lastActivityAt = evMs
          }

          if (ev.kind === KIND_GEOHASH_CHAT) {
            const text = (ev.content ?? '').trim()
            if (text) {
              room.messageTimestamps.push(evMs)
              if (evMs >= room.lastActivityAt - 1000 || !room.lastPreview) {
                room.lastPreview = text.slice(0, 96)
                room.lastSender = getTagValue(ev.tags, 'n')?.trim() || `anon${pk.slice(-4)}`
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
