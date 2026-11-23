import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Event as NostrEvent } from 'nostr-tools'
import type { ToastLevel } from '../types/protocol.ts'
import type {
  ZapEngine,
  ZapInvoiceResult,
  ZapReceiptSummary,
  ZapTarget,
} from '../types/wallet.ts'
import type { IdentityManager } from '../lib/identity.ts'
import type { RelayPool } from '../lib/relayPool.ts'
import {
  KIND_PROFILE_METADATA,
  KIND_ZAP_RECEIPT,
  LIGHTNING_ADDRESS_STORAGE_KEY,
  PEER_LUD16_CACHE_STORAGE_KEY,
  buildProfileMetadataTemplate,
  buildZapRequestTemplate,
  extractLightningAddressTag,
  fetchLnurlPayInvoice,
  loadStoredLightningAddress,
  loadStoredPeerLud16Cache,
  normalizeLightningAddress,
  parseProfileLightningAddress,
  parseZapReceiptEvent,
  resolveLnurlPay,
  saveStoredLightningAddress,
  saveStoredPeerLud16Cache,
} from '../lib/zaps.ts'

export interface UseZapsOptions {
  relayPool: RelayPool
  identityManager: IdentityManager
  getPublishRelayUrls: () => string[]
  ownPubkeys: Set<string>
  activeNickname: string
  pushToast?: (level: ToastLevel, title: string, detail?: string) => void
}

const NEGATIVE_LOOKUP_TTL_MS = 5 * 60 * 1000
const PROFILE_LOOKUP_TIMEOUT_MS = 4500
const MAX_WATCHED_EVENT_IDS = 120
const FALLBACK_PROFILE_RELAYS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.primal.net',
]

export function useZaps(options: UseZapsOptions): ZapEngine {
  const { relayPool, identityManager, getPublishRelayUrls, ownPubkeys, activeNickname } = options

  const pushToastRef = useRef(options.pushToast)
  pushToastRef.current = options.pushToast

  const getRelaysRef = useRef(getPublishRelayUrls)
  getRelaysRef.current = getPublishRelayUrls

  const activeNicknameRef = useRef(activeNickname)
  activeNicknameRef.current = activeNickname

  const ownPubkeysRef = useRef(ownPubkeys)
  ownPubkeysRef.current = ownPubkeys

  const [lightningAddress, setLightningAddressState] = useState<string | null>(() =>
    loadStoredLightningAddress()
  )
  const lightningAddressRef = useRef<string | null>(lightningAddress)

  const [publishingProfile, setPublishingProfile] = useState(false)

  const [peerLightningAddresses, setPeerLightningAddresses] = useState<Record<string, string>>(
    () => loadStoredPeerLud16Cache()
  )
  const peerLud16Ref = useRef<Record<string, string>>(peerLightningAddresses)

  const [zapReceiptsByEventId, setZapReceiptsByEventId] = useState<
    Record<string, ZapReceiptSummary[]>
  >({})
  const seenZapReceiptIdsRef = useRef<Set<string>>(new Set())

  const inFlightLookupsRef = useRef<Map<string, Promise<string | null>>>(new Map())
  const negativeLookupsRef = useRef<Map<string, number>>(new Map())
  const ownProfileCacheRef = useRef<Record<string, unknown> | null>(null)
  const watchedEventIdsRef = useRef<Set<string>>(new Set())
  const watchUnsubRef = useRef<(() => void) | null>(null)
  const watchSubKeyRef = useRef<string>('')

  const getActiveRelays = useCallback((): string[] => {
    const relays = getRelaysRef.current().filter((r) => r.startsWith('wss://'))
    return relays.length > 0 ? Array.from(new Set(relays)) : FALLBACK_PROFILE_RELAYS
  }, [])

  const ingestPeerLightningAddress = useCallback(
    (pubkey: string, lud16: string | null | undefined) => {
      if (!pubkey || !/^[0-9a-f]{64}$/i.test(pubkey)) return
      const normalized = normalizeLightningAddress(lud16)
      if (!normalized) return
      const pk = pubkey.toLowerCase()
      if (peerLud16Ref.current[pk] === normalized) return

      const next = { ...peerLud16Ref.current, [pk]: normalized }
      peerLud16Ref.current = next
      negativeLookupsRef.current.delete(pk)
      saveStoredPeerLud16Cache(next)
      setPeerLightningAddresses(next)
    },
    []
  )

  const ingestEventTags = useCallback(
    (pubkey: string, tags: string[][]) => {
      const addr = extractLightningAddressTag(tags)
      if (addr) {
        ingestPeerLightningAddress(pubkey, addr)
      }
    },
    [ingestPeerLightningAddress]
  )

  const getPeerLightningAddress = useCallback((pubkey: string): string | null => {
    if (!pubkey) return null
    const pk = pubkey.toLowerCase()
    if (ownPubkeysRef.current.has(pk) && lightningAddressRef.current) {
      return lightningAddressRef.current
    }
    return peerLud16Ref.current[pk] ?? null
  }, [])

  const lookupPeerLightningAddress = useCallback(
    async (pubkey: string, force = false): Promise<string | null> => {
      if (!pubkey || !/^[0-9a-f]{64}$/i.test(pubkey)) return null
      const pk = pubkey.toLowerCase()

      if (!force) {
        if (ownPubkeysRef.current.has(pk) && lightningAddressRef.current) {
          return lightningAddressRef.current
        }
        const cached = peerLud16Ref.current[pk]
        if (cached) return cached

        const negAt = negativeLookupsRef.current.get(pk)
        if (negAt && Date.now() - negAt < NEGATIVE_LOOKUP_TTL_MS) {
          return null
        }
      }

      const existingPromise = inFlightLookupsRef.current.get(pk)
      if (existingPromise) return await existingPromise

      const promise = new Promise<string | null>((resolve) => {
        const relays = getActiveRelays()
        let newestEvent: NostrEvent | null = null
        let settled = false
        let eoseCount = 0
        const targetEose = Math.max(1, Math.min(2, relays.length))

        let unsub: (() => void) | null = null
        const finish = () => {
          if (settled) return
          settled = true
          window.clearTimeout(timer)
          if (unsub) {
            unsub()
            unsub = null
          }
          const foundAddr = newestEvent ? parseProfileLightningAddress(newestEvent) : null
          if (foundAddr) {
            ingestPeerLightningAddress(pk, foundAddr)
          } else {
            negativeLookupsRef.current.set(pk, Date.now())
          }
          if (newestEvent && ownPubkeysRef.current.has(pk)) {
            try {
              ownProfileCacheRef.current = JSON.parse(newestEvent.content) as Record<string, unknown>
            } catch {
              // Ignore
            }
          }
          resolve(foundAddr)
        }

        const timer = window.setTimeout(finish, PROFILE_LOOKUP_TIMEOUT_MS)

        unsub = relayPool.subscribe(
          `agnostr-lud16-${pk.slice(0, 12)}`,
          relays,
          [{ kinds: [KIND_PROFILE_METADATA], authors: [pk], limit: 3 }],
          {
            onEvent: (ev) => {
              if (ev.kind !== KIND_PROFILE_METADATA || ev.pubkey.toLowerCase() !== pk) return
              if (!newestEvent || ev.created_at > newestEvent.created_at) {
                newestEvent = ev
              }
            },
            onEose: () => {
              eoseCount += 1
              if (eoseCount >= targetEose && newestEvent) {
                finish()
              } else if (eoseCount >= relays.length) {
                finish()
              }
            },
          }
        )
      })

      inFlightLookupsRef.current.set(pk, promise)
      try {
        return await promise
      } finally {
        inFlightLookupsRef.current.delete(pk)
      }
    },
    [getActiveRelays, ingestPeerLightningAddress, relayPool]
  )

  const setLightningAddress = useCallback(
    async (
      rawAddress: string | null
    ): Promise<{ ok: boolean; normalized: string | null; publishedRelays: number; error?: string }> => {
      const trimmed = rawAddress?.trim() ?? ''
      if (!trimmed) {
        lightningAddressRef.current = null
        saveStoredLightningAddress(null)
        setLightningAddressState(null)
        pushToastRef.current?.('info', 'Lightning Address cleared')
        return { ok: true, normalized: null, publishedRelays: 0 }
      }

      const normalized = normalizeLightningAddress(trimmed)
      if (!normalized) {
        return {
          ok: false,
          normalized: null,
          publishedRelays: 0,
          error: 'Enter a valid Lightning Address (e.g. you@getalby.com) or lnurl1... string.',
        }
      }

      lightningAddressRef.current = normalized
      saveStoredLightningAddress(normalized)
      setLightningAddressState(normalized)

      // Also update local peer cache for all own pubkeys immediately
      for (const pk of ownPubkeysRef.current) {
        ingestPeerLightningAddress(pk, normalized)
      }

      setPublishingProfile(true)
      try {
        const master = identityManager.getMasterKeyMaterial()
        const template = buildProfileMetadataTemplate({
          name: activeNicknameRef.current,
          lud16: normalized,
          existingProfile: ownProfileCacheRef.current,
        })
        const signed = await identityManager.signEventWithMaterial(template, master)
        const relays = getActiveRelays()
        const res = await relayPool.publish(relays, signed)
        const count = res.acceptedRelays.length
        pushToastRef.current?.(
          'success',
          'Lightning Address saved',
          count > 0
            ? `${normalized} · published to ${count} relay${count === 1 ? '' : 's'}`
            : `${normalized} · saved locally`
        )
        return { ok: true, normalized, publishedRelays: count }
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Saved locally, but profile publish failed.'
        pushToastRef.current?.('warning', 'Lightning Address saved locally', msg)
        return { ok: true, normalized, publishedRelays: 0, error: msg }
      } finally {
        setPublishingProfile(false)
      }
    },
    [getActiveRelays, identityManager, ingestPeerLightningAddress, relayPool]
  )

  const ingestZapReceipt = useCallback((event: NostrEvent): ZapReceiptSummary | null => {
    const parsed = parseZapReceiptEvent(event)
    if (!parsed) return null
    if (seenZapReceiptIdsRef.current.has(parsed.id)) return parsed
    seenZapReceiptIdsRef.current.add(parsed.id)

    const targetKey = parsed.targetEventId
    if (!targetKey) return parsed

    setZapReceiptsByEventId((prev) => {
      const existing = prev[targetKey] ?? []
      if (existing.some((r) => r.id === parsed.id)) return prev
      const nextList = [...existing, parsed].sort((a, b) => b.createdAt - a.createdAt)
      return {
        ...prev,
        [targetKey]: nextList,
      }
    })
    return parsed
  }, [])

  const watchEventIds = useCallback(
    (eventIds: string[]) => {
      let changed = false
      for (const id of eventIds) {
        if (!/^[0-9a-f]{64}$/i.test(id)) continue
        const low = id.toLowerCase()
        if (!watchedEventIdsRef.current.has(low)) {
          watchedEventIdsRef.current.add(low)
          changed = true
        }
      }
      if (!changed) return

      // Keep most recent MAX_WATCHED_EVENT_IDS
      const all = Array.from(watchedEventIdsRef.current)
      const trimmed = all.slice(-MAX_WATCHED_EVENT_IDS)
      watchedEventIdsRef.current = new Set(trimmed)

      const key = trimmed.join(',')
      if (!key || key === watchSubKeyRef.current) return
      watchSubKeyRef.current = key

      if (watchUnsubRef.current) {
        watchUnsubRef.current()
        watchUnsubRef.current = null
      }

      const relays = getActiveRelays()
      watchUnsubRef.current = relayPool.subscribe(
        'agnostr-zap-receipts',
        relays,
        [{ kinds: [KIND_ZAP_RECEIPT], '#e': trimmed, limit: 200 }],
        {
          onEvent: (ev) => {
            ingestZapReceipt(ev)
          },
        }
      )
    },
    [getActiveRelays, ingestZapReceipt, relayPool]
  )

  useEffect(() => {
    return () => {
      if (watchUnsubRef.current) {
        watchUnsubRef.current()
        watchUnsubRef.current = null
      }
    }
  }, [])

  const zapTotalsByEventId = useMemo(() => {
    const out: Record<string, number> = {}
    for (const [eventId, list] of Object.entries(zapReceiptsByEventId)) {
      let total = 0
      for (const item of list) {
        total += item.amountSats
      }
      if (total > 0) {
        out[eventId] = total
      }
    }
    return out
  }, [zapReceiptsByEventId])

  const requestZapInvoice = useCallback(
    async (params: {
      target: ZapTarget
      amountSats: number
      comment?: string
    }): Promise<ZapInvoiceResult> => {
      const amountSats = Math.floor(params.amountSats)
      if (!Number.isFinite(amountSats) || amountSats <= 0) {
        throw new Error('Enter a valid positive satoshi amount.')
      }

      const recipientPubkey = params.target.pubkey.toLowerCase()
      const explicitLud16 = normalizeLightningAddress(params.target.lud16)
      const resolvedLud16 =
        explicitLud16 ??
        getPeerLightningAddress(recipientPubkey) ??
        (await lookupPeerLightningAddress(recipientPubkey))

      if (!resolvedLud16) {
        throw new Error('This peer has not published a Lightning Address yet.')
      }

      const metadata = await resolveLnurlPay(resolvedLud16)
      const cleanComment = (params.comment ?? '').trim()

      let zapRequestEvent = null
      if (metadata.allowsNostr) {
        const relays = getActiveRelays()
        const template = buildZapRequestTemplate({
          recipientPubkey,
          amountSats,
          relays,
          eventId: params.target.eventId,
          comment: cleanComment,
          lnurl: resolvedLud16.startsWith('lnurl1') ? resolvedLud16 : undefined,
        })
        const material = identityManager.getMasterKeyMaterial()
        zapRequestEvent = await identityManager.signEventWithMaterial(template, material)
      }

      const invoice = await fetchLnurlPayInvoice({
        metadata,
        amountSats,
        comment: cleanComment,
        zapRequestEvent,
      })

      return {
        invoice,
        amountSats,
        recipientLud16: resolvedLud16,
        recipientPubkey,
        zapRequestEventId: zapRequestEvent?.id,
        allowsNostr: metadata.allowsNostr,
        metadata,
        comment: cleanComment || undefined,
      }
    },
    [getActiveRelays, getPeerLightningAddress, identityManager, lookupPeerLightningAddress]
  )

  const resetAll = useCallback(() => {
    try {
      localStorage.removeItem(LIGHTNING_ADDRESS_STORAGE_KEY)
      localStorage.removeItem(PEER_LUD16_CACHE_STORAGE_KEY)
    } catch {
      // Ignore
    }
    if (watchUnsubRef.current) {
      watchUnsubRef.current()
      watchUnsubRef.current = null
    }
    watchSubKeyRef.current = ''
    watchedEventIdsRef.current.clear()
    seenZapReceiptIdsRef.current.clear()
    inFlightLookupsRef.current.clear()
    negativeLookupsRef.current.clear()
    ownProfileCacheRef.current = null

    lightningAddressRef.current = null
    setLightningAddressState(null)

    peerLud16Ref.current = {}
    setPeerLightningAddresses({})
    setZapReceiptsByEventId({})
    setPublishingProfile(false)
  }, [])

  return useMemo<ZapEngine>(
    () => ({
      lightningAddress,
      publishingProfile,
      peerLightningAddresses,
      zapTotalsByEventId,
      zapReceiptsByEventId,
      setLightningAddress,
      getPeerLightningAddress,
      lookupPeerLightningAddress,
      ingestPeerLightningAddress,
      ingestEventTags,
      ingestZapReceipt,
      watchEventIds,
      resolveLnurlPay,
      requestZapInvoice,
      resetAll,
    }),
    [
      lightningAddress,
      publishingProfile,
      peerLightningAddresses,
      zapTotalsByEventId,
      zapReceiptsByEventId,
      setLightningAddress,
      getPeerLightningAddress,
      lookupPeerLightningAddress,
      ingestPeerLightningAddress,
      ingestEventTags,
      ingestZapReceipt,
      watchEventIds,
      requestZapInvoice,
      resetAll,
    ]
  )
}
