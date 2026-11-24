import { useCallback, useMemo, useState } from 'react'
import type { LocationState } from '../types/protocol.ts'
import { encodeGeohash, normalizeGeohash } from '../lib/geohash.ts'
import { isTopicChannel } from '../lib/bitchatChannel.ts'

const PRECISIONS = [1, 2, 3, 4, 5, 6, 7, 8, 9] as const

export function useLocation(activeGeohash: string) {
  const [status, setStatus] = useState<LocationState['status']>('idle')
  const [coords, setCoords] = useState<LocationState['coords']>(null)
  const [accuracyMeters, setAccuracyMeters] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)

  const localGeohashes = useMemo<Record<number, string>>(() => {
    if (!coords) return {}
    const out: Record<number, string> = {}
    for (const p of PRECISIONS) {
      out[p] = encodeGeohash(coords.lat, coords.lon, p)
    }
    return out
  }, [coords])

  const isTeleported = useMemo(() => {
    if (activeGeohash.includes(':') || isTopicChannel(activeGeohash)) return false
    const gh = normalizeGeohash(activeGeohash)
    if (!coords) return true
    const expected = encodeGeohash(coords.lat, coords.lon, gh.length)
    return expected !== gh
  }, [activeGeohash, coords])

  const locateMe = useCallback((): Promise<string | null> => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      setStatus('unavailable')
      setError('Geolocation is not supported in this browser.')
      return Promise.resolve(null)
    }

    setStatus('locating')
    setError(null)

    return new Promise((resolve) => {
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          const nextCoords = {
            lat: pos.coords.latitude,
            lon: pos.coords.longitude,
          }
          setCoords(nextCoords)
          setAccuracyMeters(Number.isFinite(pos.coords.accuracy) ? Math.round(pos.coords.accuracy) : null)
          setStatus('ready')
          setError(null)
          // Precision 5 (city-level ~4.9km) balances local relevance and privacy
          resolve(encodeGeohash(nextCoords.lat, nextCoords.lon, 5))
        },
        (err) => {
          const denied = err.code === err.PERMISSION_DENIED
          setStatus(denied ? 'denied' : 'unavailable')
          setError(denied ? 'Location permission denied.' : err.message || 'Unable to acquire GPS fix.')
          resolve(null)
        },
        {
          enableHighAccuracy: false,
          timeout: 10_000,
          maximumAge: 60_000,
        }
      )
    })
  }, [])

  const resetLocation = useCallback(() => {
    setStatus('idle')
    setCoords(null)
    setAccuracyMeters(null)
    setError(null)
  }, [])

  const location: LocationState = useMemo(
    () => ({
      status,
      coords,
      localGeohashes,
      accuracyMeters,
      error,
      isTeleported,
    }),
    [status, coords, localGeohashes, accuracyMeters, error, isTeleported]
  )

  return {
    location,
    localFullGeohash: localGeohashes[9],
    locateMe,
    resetLocation,
  }
}
