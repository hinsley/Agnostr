import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Event as NostrEvent, EventTemplate } from 'nostr-tools'
import type { ToastLevel } from '../types/protocol.ts'
import type {
  NutzapInfoRecord,
  WalletEngine,
  ZapAddressMode,
  ZapEngine,
  ZapInvoiceResult,
  ZapReceiptSummary,
  ZapTarget,
} from '../types/wallet.ts'
import { normalizeMintUrl } from '../lib/cashuMints.ts'
import { deriveWalletP2pkPubkeyHex } from '../lib/cashuWallet.ts'
import { bytesToHex, type IdentityManager } from '../lib/identity.ts'
import {
  buildNpubCashAddress,
  clearClaimedNpubCashQuotes,
  fetchNpubCashQuotes,
  fetchNpubCashUser,
  isNpubCashQuoteClaimed,
  markNpubCashQuoteClaimed,
  parseNpubCashZapRequest,
  syncNpubCashMint,
} from '../lib/npubCash.ts'
import {
  KIND_NUTZAP,
  KIND_NUTZAP_INFO,
  buildNutzapEventTemplate,
  buildNutzapInfoTemplate,
  clearClaimedNutzapIds,
  clearStoredPeerNutzapInfoCache,
  isNutzapIdClaimed,
  loadStoredPeerNutzapInfoCache,
  markNutzapIdClaimed,
  nutzapToZapReceiptSummary,
  parseNutzapEvent,
  parseNutzapInfoEvent,
  saveStoredPeerNutzapInfoCache,
} from '../lib/nutzaps.ts'
import type { RelayPool } from '../lib/relayPool.ts'
import {
  KIND_PROFILE_METADATA,
  KIND_ZAP_RECEIPT,
  LIGHTNING_ADDRESS_STORAGE_KEY,
  NPUBCASH_AUTOSWEEP_STORAGE_KEY,
  PEER_LUD16_CACHE_STORAGE_KEY,
  ZAP_MODE_STORAGE_KEY,
  buildProfileMetadataTemplate,
  buildZapRequestTemplate,
  extractLightningAddressTag,
  fetchLnurlPayInvoice,
  isNpubCashAddress,
  loadStoredLightningAddress,
  loadStoredNpubCashAutoSweep,
  loadStoredPeerLud16Cache,
  loadStoredZapAddressMode,
  normalizeLightningAddress,
  parseProfileLightningAddress,
  parseZapReceiptEvent,
  resolveLnurlPay,
  saveStoredLightningAddress,
  saveStoredNpubCashAutoSweep,
  saveStoredPeerLud16Cache,
  saveStoredZapAddressMode,
} from '../lib/zaps.ts'

export interface UseZapsOptions {
  relayPool: RelayPool
  identityManager: IdentityManager
  wallet: WalletEngine
  getPublishRelayUrls: () => string[]
  ownPubkeys: Set<string>
  activeNickname: string
  masterPubkey?: string
  pushToast?: (level: ToastLevel, title: string, detail?: string) => void
}

const NEGATIVE_LOOKUP_TTL_MS = 5 * 60 * 1000
const PROFILE_LOOKUP_TIMEOUT_MS = 4500
const MAX_WATCHED_EVENT_IDS = 120
const INITIAL_SWEEP_DELAY_MS = 4000
const PERIODIC_SWEEP_INTERVAL_MS = 60_000
const FOCUS_SWEEP_THROTTLE_MS = 15_000
const STARTUP_AUTOPUB_DELAY_MS = 5000
const SESSION_AUTOPUB_KIND0_KEY = 'agnostr:v2:zap_autopub_kind0'
const SESSION_AUTOPUB_10019_KEY = 'agnostr:v2:zap_autopub_10019'
const FALLBACK_PROFILE_RELAYS = [
  'wss://purplepag.es',
  'wss://relay.damus.io',
  'wss://nos.lol',
]

function readSessionFlag(key: string): string | null {
  try {
    return sessionStorage.getItem(key)
  } catch {
    return null
  }
}

function writeSessionFlag(key: string, value: string): void {
  try {
    sessionStorage.setItem(key, value)
  } catch {
    // Ignore storage errors
  }
}

function removeSessionFlag(key: string): void {
  try {
    sessionStorage.removeItem(key)
  } catch {
    // Ignore storage errors
  }
}

export function useZaps(options: UseZapsOptions): ZapEngine {
  const { relayPool, identityManager, wallet, getPublishRelayUrls, ownPubkeys, activeNickname } =
    options

  const pushToastRef = useRef(options.pushToast)
  pushToastRef.current = options.pushToast

  const getRelaysRef = useRef(getPublishRelayUrls)
  getRelaysRef.current = getPublishRelayUrls

  const activeNicknameRef = useRef(activeNickname)
  activeNicknameRef.current = activeNickname

  const ownPubkeysRef = useRef(ownPubkeys)
  ownPubkeysRef.current = ownPubkeys

  const walletRef = useRef(wallet)
  walletRef.current = wallet

  const resolvedMasterPubkey = (
    options.masterPubkey || identityManager.getMasterKeyMaterial().pubkey
  ).toLowerCase()

  const [npubCashUsername, setNpubCashUsername] = useState<string | null>(null)

  const [customLightningAddress, setCustomLightningAddressState] = useState<string | null>(() => {
    const stored = loadStoredLightningAddress()
    return stored && !isNpubCashAddress(stored) ? stored : null
  })
  const customLightningAddressRef = useRef<string | null>(customLightningAddress)
  customLightningAddressRef.current = customLightningAddress

  const [zapMode, setZapModeState] = useState<ZapAddressMode>(() =>
    loadStoredZapAddressMode(loadStoredLightningAddress())
  )
  const zapModeRef = useRef<ZapAddressMode>(zapMode)
  zapModeRef.current = zapMode

  const builtinLightningAddress = useMemo(
    () => buildNpubCashAddress(resolvedMasterPubkey, npubCashUsername),
    [resolvedMasterPubkey, npubCashUsername]
  )
  const builtinAddressRef = useRef<string>(builtinLightningAddress)
  builtinAddressRef.current = builtinLightningAddress

  const lightningAddress =
    zapMode === 'builtin' ? builtinLightningAddress : customLightningAddress
  const lightningAddressRef = useRef<string | null>(lightningAddress)
  lightningAddressRef.current = lightningAddress

  const [npubCashAutoSweep, setNpubCashAutoSweepState] = useState<boolean>(() =>
    loadStoredNpubCashAutoSweep()
  )
  const npubCashAutoSweepRef = useRef<boolean>(npubCashAutoSweep)
  npubCashAutoSweepRef.current = npubCashAutoSweep

  const [npubCashSweeping, setNpubCashSweeping] = useState(false)
  const [npubCashLastSweptAt, setNpubCashLastSweptAt] = useState<number | null>(null)
  const [npubCashLastError, setNpubCashLastError] = useState<string | null>(null)
  const [npubCashMintUrl, setNpubCashMintUrl] = useState<string | null>(null)
  const [nutzapInfoPublished, setNutzapInfoPublished] = useState(false)
  const [publishingProfile, setPublishingProfile] = useState(false)

  const [peerLightningAddresses, setPeerLightningAddresses] = useState<Record<string, string>>(
    () => loadStoredPeerLud16Cache()
  )
  const peerLud16Ref = useRef<Record<string, string>>(peerLightningAddresses)

  const [peerNutzapInfo, setPeerNutzapInfo] = useState<Record<string, NutzapInfoRecord>>(() =>
    loadStoredPeerNutzapInfoCache()
  )
  const peerNutzapInfoRef = useRef<Record<string, NutzapInfoRecord>>(peerNutzapInfo)

  const [zapReceiptsByEventId, setZapReceiptsByEventId] = useState<
    Record<string, ZapReceiptSummary[]>
  >({})
  const seenZapReceiptIdsRef = useRef<Set<string>>(new Set())

  const inFlightLookupsRef = useRef<Map<string, Promise<string | null>>>(new Map())
  const negativeLookupsRef = useRef<Map<string, number>>(new Map())
  const inFlightNutzapLookupsRef = useRef<Map<string, Promise<NutzapInfoRecord | null>>>(new Map())
  const negativeNutzapLookupsRef = useRef<Map<string, number>>(new Map())
  const claimingNutzapIdsRef = useRef<Set<string>>(new Set())
  const ownProfileCacheRef = useRef<Record<string, unknown> | null>(null)
  const watchedEventIdsRef = useRef<Set<string>>(new Set())
  const watchUnsubRef = useRef<(() => void) | null>(null)
  const watchSubKeyRef = useRef<string>('')
  const sweepInFlightRef = useRef(false)
  const lastFocusSweepAtRef = useRef(0)
  const lastAutoPubKind0Ref = useRef<string | null>(readSessionFlag(SESSION_AUTOPUB_KIND0_KEY))
  const lastAutoPub10019Ref = useRef<string | null>(readSessionFlag(SESSION_AUTOPUB_10019_KEY))

  // Reset per-identity transient state when master pubkey rotates or switches
  useEffect(() => {
    setNpubCashUsername(null)
    setNpubCashMintUrl(null)
    setNutzapInfoPublished(false)
    ownProfileCacheRef.current = null
  }, [resolvedMasterPubkey])

  const isLocalMasterSigner = useCallback((): boolean => {
    const master = identityManager.getMasterKeyMaterial()
    return master.mode !== 'extension' && Boolean(master.secretKey)
  }, [identityManager])

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

  const ingestPeerNutzapInfo = useCallback((record: NutzapInfoRecord) => {
    const pk = record.pubkey.toLowerCase()
    const existing = peerNutzapInfoRef.current[pk]
    if (existing && existing.createdAt > record.createdAt) return
    if (
      existing &&
      existing.createdAt === record.createdAt &&
      existing.p2pkPubkey === record.p2pkPubkey &&
      existing.mints.length === record.mints.length &&
      existing.mints.every((m, idx) => m.url === record.mints[idx]?.url)
    ) {
      return
    }
    const next = { ...peerNutzapInfoRef.current, [pk]: record }
    peerNutzapInfoRef.current = next
    negativeNutzapLookupsRef.current.delete(pk)
    saveStoredPeerNutzapInfoCache(next)
    setPeerNutzapInfo(next)
  }, [])

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

  const getPeerNutzapInfo = useCallback((pubkey: string): NutzapInfoRecord | null => {
    if (!pubkey) return null
    const pk = pubkey.toLowerCase()
    return peerNutzapInfoRef.current[pk] ?? null
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
              ownProfileCacheRef.current = JSON.parse(newestEvent.content) as Record<
                string,
                unknown
              >
            } catch {
              // Ignore invalid JSON
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

  const lookupPeerNutzapInfo = useCallback(
    async (pubkey: string, force = false): Promise<NutzapInfoRecord | null> => {
      if (!pubkey || !/^[0-9a-f]{64}$/i.test(pubkey)) return null
      const pk = pubkey.toLowerCase()

      if (!force) {
        const cached = peerNutzapInfoRef.current[pk]
        if (cached) return cached

        const negAt = negativeNutzapLookupsRef.current.get(pk)
        if (negAt && Date.now() - negAt < NEGATIVE_LOOKUP_TTL_MS) {
          return null
        }
      }

      const existingPromise = inFlightNutzapLookupsRef.current.get(pk)
      if (existingPromise) return await existingPromise

      const promise = new Promise<NutzapInfoRecord | null>((resolve) => {
        const relays = getActiveRelays()
        let newestRecord: NutzapInfoRecord | null = null
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
          if (newestRecord) {
            ingestPeerNutzapInfo(newestRecord)
          } else {
            negativeNutzapLookupsRef.current.set(pk, Date.now())
          }
          resolve(newestRecord)
        }

        const timer = window.setTimeout(finish, PROFILE_LOOKUP_TIMEOUT_MS)

        unsub = relayPool.subscribe(
          `agnostr-10019-${pk.slice(0, 12)}`,
          relays,
          [{ kinds: [KIND_NUTZAP_INFO], authors: [pk], limit: 3 }],
          {
            onEvent: (ev) => {
              if (ev.kind !== KIND_NUTZAP_INFO || ev.pubkey.toLowerCase() !== pk) return
              const parsed = parseNutzapInfoEvent(ev)
              if (parsed && (!newestRecord || parsed.createdAt > newestRecord.createdAt)) {
                newestRecord = parsed
              }
            },
            onEose: () => {
              eoseCount += 1
              if (eoseCount >= targetEose && newestRecord) {
                finish()
              } else if (eoseCount >= relays.length) {
                finish()
              }
            },
          }
        )
      })

      inFlightNutzapLookupsRef.current.set(pk, promise)
      try {
        return await promise
      } finally {
        inFlightNutzapLookupsRef.current.delete(pk)
      }
    },
    [getActiveRelays, ingestPeerNutzapInfo, relayPool]
  )

  const publishProfileLightningAddress = useCallback(
    async (addr: string | null): Promise<number> => {
      const master = identityManager.getMasterKeyMaterial()
      const template = buildProfileMetadataTemplate({
        name: activeNicknameRef.current,
        lud16: addr,
        existingProfile: ownProfileCacheRef.current,
      })
      const signed = await identityManager.signEventWithMaterial(template, master)
      const relays = getActiveRelays()
      const res = await relayPool.publish(relays, signed)
      return res.acceptedRelays.length
    },
    [getActiveRelays, identityManager, relayPool]
  )

  const setZapAddressMode = useCallback(
    async (
      mode: ZapAddressMode,
      customAddress?: string | null
    ): Promise<{ ok: boolean; normalized: string | null; publishedRelays: number; error?: string }> => {
      let targetMode: ZapAddressMode = mode
      let normalizedCustom: string | null = customLightningAddressRef.current

      if (mode === 'custom') {
        const rawCandidate =
          customAddress !== undefined ? (customAddress ?? '').trim() : (normalizedCustom ?? '')
        if (!rawCandidate) {
          // Empty custom address gracefully reverts to built-in npub.cash mode
          targetMode = 'builtin'
          normalizedCustom = null
        } else {
          const normalized = normalizeLightningAddress(rawCandidate)
          if (!normalized) {
            return {
              ok: false,
              normalized: null,
              publishedRelays: 0,
              error: 'Enter a valid Lightning Address (e.g. you@getalby.com) or lnurl1... string.',
            }
          }
          if (isNpubCashAddress(normalized)) {
            targetMode = 'builtin'
            normalizedCustom = null
          } else {
            targetMode = 'custom'
            normalizedCustom = normalized
          }
        }
      } else if (customAddress === null) {
        normalizedCustom = null
      }

      const effectiveAddress =
        targetMode === 'builtin' ? builtinAddressRef.current : normalizedCustom

      zapModeRef.current = targetMode
      setZapModeState(targetMode)
      saveStoredZapAddressMode(targetMode)

      customLightningAddressRef.current = normalizedCustom
      setCustomLightningAddressState(normalizedCustom)
      saveStoredLightningAddress(normalizedCustom)

      lightningAddressRef.current = effectiveAddress

      if (effectiveAddress) {
        for (const pk of ownPubkeysRef.current) {
          ingestPeerLightningAddress(pk, effectiveAddress)
        }
      }

      setPublishingProfile(true)
      try {
        const count = await publishProfileLightningAddress(effectiveAddress)
        if (targetMode === 'builtin' && effectiveAddress) {
          const masterPk = identityManager.getMasterKeyMaterial().pubkey.toLowerCase()
          const autoKey = `${masterPk}:${effectiveAddress}`
          lastAutoPubKind0Ref.current = autoKey
          writeSessionFlag(SESSION_AUTOPUB_KIND0_KEY, autoKey)
        }
        pushToastRef.current?.(
          'success',
          targetMode === 'builtin' ? 'Built-in Lightning Address active' : 'Lightning Address saved',
          effectiveAddress
            ? count > 0
              ? `${effectiveAddress} · published to ${count} relay${count === 1 ? '' : 's'}`
              : `${effectiveAddress} · saved locally`
            : undefined
        )
        return { ok: true, normalized: effectiveAddress, publishedRelays: count }
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Saved locally, but profile publish failed.'
        pushToastRef.current?.('warning', 'Lightning Address saved locally', msg)
        return { ok: true, normalized: effectiveAddress, publishedRelays: 0, error: msg }
      } finally {
        setPublishingProfile(false)
      }
    },
    [identityManager, ingestPeerLightningAddress, publishProfileLightningAddress]
  )

  const setLightningAddress = useCallback(
    async (
      rawAddress: string | null
    ): Promise<{ ok: boolean; normalized: string | null; publishedRelays: number; error?: string }> => {
      const trimmed = rawAddress?.trim() ?? ''
      if (!trimmed || isNpubCashAddress(trimmed)) {
        return await setZapAddressMode('builtin', null)
      }
      return await setZapAddressMode('custom', trimmed)
    },
    [setZapAddressMode]
  )

  const setNpubCashAutoSweep = useCallback((enabled: boolean) => {
    npubCashAutoSweepRef.current = enabled
    saveStoredNpubCashAutoSweep(enabled)
    setNpubCashAutoSweepState(enabled)
  }, [])

  const sweepNpubCashNow = useCallback(
    async (opts?: {
      silent?: boolean
    }): Promise<{ claimedCount: number; claimedSats: number; error?: string }> => {
      if (sweepInFlightRef.current) {
        return { claimedCount: 0, claimedSats: 0 }
      }
      sweepInFlightRef.current = true
      setNpubCashSweeping(true)
      if (!opts?.silent) {
        setNpubCashLastError(null)
      }

      try {
        const master = identityManager.getMasterKeyMaterial()
        const signFn = (tmpl: EventTemplate) =>
          identityManager.signEventWithMaterial(tmpl, master)

        const user = await fetchNpubCashUser(signFn)
        if (user.name) {
          setNpubCashUsername(user.name)
        }
        if (user.mintUrl) {
          setNpubCashMintUrl(user.mintUrl)
        }

        // Best-effort sync of user's active Cashu mint to npub.cash when in built-in mode
        if (zapModeRef.current === 'builtin') {
          const activeMint = normalizeMintUrl(walletRef.current.activeMintUrl)
          if (activeMint && activeMint !== user.mintUrl) {
            try {
              const synced = await syncNpubCashMint(signFn, activeMint)
              setNpubCashMintUrl(synced.mintUrl)
            } catch {
              // Ignore gracefully if npub.cash declines a custom/unlisted mint
            }
          }
        }

        const quotes = await fetchNpubCashQuotes(signFn)
        const masterPrivHex =
          master.mode !== 'extension' && master.secretKey
            ? bytesToHex(master.secretKey)
            : undefined

        let claimedCount = 0
        let totalClaimedSats = 0
        let lastMemo: string | undefined

        for (const quote of quotes) {
          if (quote.state.toUpperCase() !== 'PAID') continue
          if (isNpubCashQuoteClaimed(quote.quoteId)) continue

          const zapMeta = parseNpubCashZapRequest(quote.zapRequest)
          try {
            const res = await walletRef.current.claimExternalMintQuote({
              mintUrl: quote.mintUrl,
              quoteId: quote.quoteId,
              amountSats: quote.amount,
              privkeyHex: quote.locked ? masterPrivHex : undefined,
              counterparty: zapMeta?.senderPubkey,
              memo: zapMeta?.comment || 'Lightning Zap',
              txType: 'zap_in',
            })
            if (res.claimedSats > 0) {
              markNpubCashQuoteClaimed(quote.quoteId)
              claimedCount += 1
              totalClaimedSats += res.claimedSats
              if (zapMeta?.comment) lastMemo = zapMeta.comment
            } else if (res.state === 'ISSUED') {
              markNpubCashQuoteClaimed(quote.quoteId)
            }
          } catch (claimErr) {
            const claimMsg = claimErr instanceof Error ? claimErr.message : ''
            if (/already.*issued|already.*claimed|spent/i.test(claimMsg)) {
              markNpubCashQuoteClaimed(quote.quoteId)
            }
            // Continue sweeping remaining quotes even if one fails
          }
        }

        setNpubCashLastSweptAt(Date.now())
        setNpubCashLastError(null)

        if (totalClaimedSats > 0) {
          pushToastRef.current?.(
            'success',
            `Received ${totalClaimedSats.toLocaleString()} sats`,
            lastMemo || 'Auto-swept from npub.cash'
          )
        }

        return { claimedCount, claimedSats: totalClaimedSats }
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Failed to check npub.cash.'
        setNpubCashLastError(msg)
        if (!opts?.silent) {
          pushToastRef.current?.('warning', 'npub.cash check failed', msg)
        }
        return { claimedCount: 0, claimedSats: 0, error: msg }
      } finally {
        sweepInFlightRef.current = false
        setNpubCashSweeping(false)
      }
    },
    [identityManager]
  )

  const publishNutzapInfo = useCallback(async (): Promise<{
    ok: boolean
    publishedRelays: number
    error?: string
  }> => {
    try {
      const w = walletRef.current
      let p2pkPubkeyHex = w.nutzapP2pkPubkeyHex
      if (!p2pkPubkeyHex) {
        const draft = w.generateDraftWalletKeys()
        w.createNewWallet({
          mnemonic: draft.mnemonic,
          privateKeyHex: draft.privateKeyHex,
        })
        p2pkPubkeyHex = deriveWalletP2pkPubkeyHex(draft.privateKeyHex)
      }
      if (!p2pkPubkeyHex) {
        return {
          ok: false,
          publishedRelays: 0,
          error: 'Could not derive Cashu P2PK key for Nutzaps.',
        }
      }

      const activeMint = normalizeMintUrl(w.activeMintUrl)
      const fundedMintUrls = w.mints
        .filter((m) => (w.balancesByMint[m.url] ?? 0) > 0)
        .map((m) => normalizeMintUrl(m.url))
        .filter((u): u is string => u !== null)
      const mints = Array.from(
        new Set([...(activeMint ? [activeMint] : []), ...fundedMintUrls])
      )
      const relays = getActiveRelays()

      const template = buildNutzapInfoTemplate({
        relays,
        mints,
        p2pkPubkeyHex,
      })
      const master = identityManager.getMasterKeyMaterial()
      const signed = await identityManager.signEventWithMaterial(template, master)
      const res = await relayPool.publish(relays, signed)
      const publishedRelays = res.acceptedRelays.length

      const parsed = parseNutzapInfoEvent(signed)
      if (parsed) {
        ingestPeerNutzapInfo(parsed)
      }
      setNutzapInfoPublished(true)

      const autoKey = `${master.pubkey.toLowerCase()}:${activeMint ?? ''}:${p2pkPubkeyHex}`
      lastAutoPub10019Ref.current = autoKey
      writeSessionFlag(SESSION_AUTOPUB_10019_KEY, autoKey)

      return { ok: true, publishedRelays }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to publish Nutzap info.'
      return { ok: false, publishedRelays: 0, error: msg }
    }
  }, [getActiveRelays, identityManager, ingestPeerNutzapInfo, relayPool])

  // Background npub.cash auto-sweep (strictly local master signer only — never prompts NIP-07)
  useEffect(() => {
    if (zapMode !== 'builtin' || !npubCashAutoSweep || !isLocalMasterSigner()) return

    const initialTimer = window.setTimeout(() => {
      if (document.visibilityState === 'visible') {
        void sweepNpubCashNow({ silent: true })
      }
    }, INITIAL_SWEEP_DELAY_MS)

    const interval = window.setInterval(() => {
      if (document.visibilityState === 'visible') {
        void sweepNpubCashNow({ silent: true })
      }
    }, PERIODIC_SWEEP_INTERVAL_MS)

    const onFocus = () => {
      const now = Date.now()
      if (now - lastFocusSweepAtRef.current < FOCUS_SWEEP_THROTTLE_MS) return
      lastFocusSweepAtRef.current = now
      void sweepNpubCashNow({ silent: true })
    }

    window.addEventListener('focus', onFocus)
    return () => {
      window.clearTimeout(initialTimer)
      window.clearInterval(interval)
      window.removeEventListener('focus', onFocus)
    }
  }, [isLocalMasterSigner, npubCashAutoSweep, resolvedMasterPubkey, sweepNpubCashNow, zapMode])

  // Debounced once-per-session startup auto-publish for kind:0 (builtin lud16) & kind:10019 (Nutzap info)
  const walletActiveMintUrl = wallet.activeMintUrl
  const walletNutzapP2pkPubkeyHex = wallet.nutzapP2pkPubkeyHex

  useEffect(() => {
    if (!isLocalMasterSigner()) return

    let cancelled = false
    const timer = window.setTimeout(() => {
      void (async () => {
        if (cancelled || !isLocalMasterSigner()) return

        // 1. Auto-publish kind:0 with built-in npub.cash address once per (pubkey, addr)
        if (zapModeRef.current === 'builtin') {
          const targetAddr = builtinAddressRef.current
          const kind0Key = `${resolvedMasterPubkey}:${targetAddr}`
          if (lastAutoPubKind0Ref.current !== kind0Key) {
            try {
              // Fetch existing kind:0 first so we never clobber existing profile metadata
              if (!ownProfileCacheRef.current) {
                const existingAddr = await lookupPeerLightningAddress(resolvedMasterPubkey, true)
                if (cancelled) return
                if (existingAddr === targetAddr) {
                  lastAutoPubKind0Ref.current = kind0Key
                  writeSessionFlag(SESSION_AUTOPUB_KIND0_KEY, kind0Key)
                }
              }
              if (lastAutoPubKind0Ref.current !== kind0Key) {
                await publishProfileLightningAddress(targetAddr)
                if (cancelled) return
                lastAutoPubKind0Ref.current = kind0Key
                writeSessionFlag(SESSION_AUTOPUB_KIND0_KEY, kind0Key)
              }
            } catch {
              // Non-fatal background publish error
            }
          }
        }

        // 2. Auto-publish kind:10019 Nutzap info as soon as wallet P2PK pubkey exists
        if (walletNutzapP2pkPubkeyHex) {
          const activeMint = normalizeMintUrl(walletActiveMintUrl) ?? ''
          const key10019 = `${resolvedMasterPubkey}:${activeMint}:${walletNutzapP2pkPubkeyHex}`
          if (lastAutoPub10019Ref.current !== key10019) {
            try {
              const res = await publishNutzapInfo()
              if (!cancelled && res.ok) {
                lastAutoPub10019Ref.current = key10019
                writeSessionFlag(SESSION_AUTOPUB_10019_KEY, key10019)
              }
            } catch {
              // Non-fatal background publish error
            }
          } else {
            setNutzapInfoPublished(true)
          }
        }
      })()
    }, STARTUP_AUTOPUB_DELAY_MS)

    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [
    builtinLightningAddress,
    isLocalMasterSigner,
    lookupPeerLightningAddress,
    publishNutzapInfo,
    publishProfileLightningAddress,
    resolvedMasterPubkey,
    walletActiveMintUrl,
    walletNutzapP2pkPubkeyHex,
    zapMode,
  ])

  const recordReceiptSummary = useCallback((summary: ZapReceiptSummary): ZapReceiptSummary => {
    if (seenZapReceiptIdsRef.current.has(summary.id)) return summary
    seenZapReceiptIdsRef.current.add(summary.id)

    const targetKey = summary.targetEventId
    if (!targetKey) return summary

    setZapReceiptsByEventId((prev) => {
      const existing = prev[targetKey] ?? []
      if (existing.some((r) => r.id === summary.id)) return prev
      const nextList = [...existing, summary].sort((a, b) => b.createdAt - a.createdAt)
      return {
        ...prev,
        [targetKey]: nextList,
      }
    })
    return summary
  }, [])

  const ingestZapReceipt = useCallback(
    (event: NostrEvent): ZapReceiptSummary | null => {
      if (event.kind === KIND_NUTZAP) {
        const parsedNutzap = parseNutzapEvent(event)
        if (!parsedNutzap) return null
        return recordReceiptSummary(nutzapToZapReceiptSummary(parsedNutzap))
      }
      const parsed = parseZapReceiptEvent(event)
      if (!parsed) return null
      return recordReceiptSummary(parsed)
    },
    [recordReceiptSummary]
  )

  // Live subscription to incoming NIP-61 Nutzaps (kind: 9321) addressed to our pubkeys + auto-claim
  const ownPubkeysKey = useMemo(
    () =>
      Array.from(ownPubkeys)
        .map((pk) => pk.toLowerCase())
        .filter((pk) => /^[0-9a-f]{64}$/.test(pk))
        .sort()
        .join(','),
    [ownPubkeys]
  )

  useEffect(() => {
    const pubkeyList = ownPubkeysKey ? ownPubkeysKey.split(',') : []
    if (pubkeyList.length === 0) return

    const relays = getActiveRelays()
    const unsub = relayPool.subscribe(
      `agnostr-nutzaps-in-${pubkeyList[0].slice(0, 10)}`,
      relays,
      [{ kinds: [KIND_NUTZAP], '#p': pubkeyList, limit: 60 }],
      {
        onEvent: (ev) => {
          if (ev.kind !== KIND_NUTZAP) return
          const parsed = parseNutzapEvent(ev)
          if (!parsed) return

          // Always ingest into message zap totals
          recordReceiptSummary(nutzapToZapReceiptSummary(parsed))

          if (!ownPubkeysRef.current.has(parsed.recipientPubkey.toLowerCase())) return
          if (parsed.unit !== 'sat' || parsed.proofs.length === 0) return
          if (isNutzapIdClaimed(parsed.id) || claimingNutzapIdsRef.current.has(parsed.id)) return

          claimingNutzapIdsRef.current.add(parsed.id)

          const master = identityManager.getMasterKeyMaterial()
          const candidatePrivkeysHex: string[] = []
          if (master.mode !== 'extension' && master.secretKey) {
            candidatePrivkeysHex.push(bytesToHex(master.secretKey))
          }

          void walletRef.current
            .claimP2pkNutzapProofs({
              mintUrl: parsed.mintUrl,
              proofs: parsed.proofs,
              candidatePrivkeysHex,
              senderPubkey: parsed.senderPubkey,
              memo: parsed.comment,
              nutzapEventId: parsed.id,
            })
            .then((res) => {
              markNutzapIdClaimed(parsed.id)
              if (res.claimedSats > 0) {
                pushToastRef.current?.(
                  'success',
                  `Received ${res.claimedSats.toLocaleString()} sat Nutzap`,
                  parsed.comment || undefined
                )
              }
            })
            .catch((err) => {
              const msg = err instanceof Error ? err.message : ''
              if (/spent|already|claimed|duplicate/i.test(msg)) {
                markNutzapIdClaimed(parsed.id)
              }
            })
            .finally(() => {
              claimingNutzapIdsRef.current.delete(parsed.id)
            })
        },
      }
    )

    return () => {
      unsub()
    }
  }, [getActiveRelays, identityManager, ownPubkeysKey, recordReceiptSummary, relayPool])

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
        [{ kinds: [KIND_ZAP_RECEIPT, KIND_NUTZAP], '#e': trimmed, limit: 150 }],
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

  const sendNutzap = useCallback(
    async (params: {
      target: ZapTarget
      amountSats: number
      comment?: string
      mintUrl?: string
    }): Promise<{
      eventId: string
      amountSats: number
      feeSats: number
      mintUrl: string
      publishedRelays: number
    }> => {
      const amountSats = Math.floor(params.amountSats)
      if (!Number.isFinite(amountSats) || amountSats <= 0) {
        throw new Error('Enter a valid positive satoshi amount.')
      }

      const recipientPubkey = params.target.pubkey.toLowerCase()
      const info =
        getPeerNutzapInfo(recipientPubkey) ?? (await lookupPeerNutzapInfo(recipientPubkey))
      if (!info) {
        throw new Error('This peer has not published NIP-61 Nutzap info yet.')
      }

      const recipientMintUrls = info.mints
        .filter((m) => m.units.length === 0 || m.units.includes('sat'))
        .map((m) => normalizeMintUrl(m.url))
        .filter((u): u is string => u !== null)

      const w = walletRef.current
      let chosenMint: string | null = null
      if (params.mintUrl) {
        const reqMint = normalizeMintUrl(params.mintUrl)
        if (reqMint && recipientMintUrls.includes(reqMint)) {
          if ((w.balancesByMint[reqMint] ?? 0) >= amountSats) {
            chosenMint = reqMint
          } else {
            throw new Error(
              'Insufficient balance on this shared mint — use Lightning Zap or top up.'
            )
          }
        }
      }
      if (!chosenMint) {
        const activeNorm = normalizeMintUrl(w.activeMintUrl)
        if (
          activeNorm &&
          recipientMintUrls.includes(activeNorm) &&
          (w.balancesByMint[activeNorm] ?? 0) >= amountSats
        ) {
          chosenMint = activeNorm
        } else {
          chosenMint =
            recipientMintUrls.find((url) => (w.balancesByMint[url] ?? 0) >= amountSats) ?? null
        }
      }

      if (!chosenMint) {
        throw new Error(
          'No shared funded Cashu mint with this peer — use Lightning Zap instead.'
        )
      }

      const cleanComment = (params.comment ?? '').trim() || undefined
      const sent = await w.sendP2pkNutzapProofs({
        amountSats,
        recipientP2pkPubkey: info.p2pkPubkey,
        mintUrl: chosenMint,
        counterparty: params.target.nickname || recipientPubkey,
        memo: cleanComment,
      })

      const template = buildNutzapEventTemplate({
        proofs: sent.proofs,
        mintUrl: sent.mintUrl,
        recipientPubkey,
        targetEventId: params.target.eventId,
        comment: cleanComment,
        unit: 'sat',
      })
      const master = identityManager.getMasterKeyMaterial()
      const signed = await identityManager.signEventWithMaterial(template, master)
      const publishRelays = Array.from(new Set([...info.relays, ...getActiveRelays()]))
      const pubRes = await relayPool.publish(publishRelays, signed)
      const publishedRelays = pubRes.acceptedRelays.length

      // Reflect immediately in local message Zap totals
      ingestZapReceipt(signed)

      pushToastRef.current?.(
        'success',
        `Sent ${sent.amountSats.toLocaleString()} sat Nutzap`,
        params.target.nickname
          ? `To ${params.target.nickname}`
          : `${publishedRelays} relay${publishedRelays === 1 ? '' : 's'}`
      )

      return {
        eventId: signed.id,
        amountSats: sent.amountSats,
        feeSats: sent.feeSats,
        mintUrl: sent.mintUrl,
        publishedRelays,
      }
    },
    [
      getActiveRelays,
      getPeerNutzapInfo,
      identityManager,
      ingestZapReceipt,
      lookupPeerNutzapInfo,
      relayPool,
    ]
  )

  const canZapPeer = useCallback(
    (pubkey: string): boolean => {
      if (!pubkey) return false
      const pk = pubkey.toLowerCase()
      if (ownPubkeysRef.current.has(pk) && lightningAddress) return true
      return Boolean(peerLightningAddresses[pk] || peerNutzapInfo[pk])
    },
    [lightningAddress, peerLightningAddresses, peerNutzapInfo]
  )

  const resetAll = useCallback(() => {
    try {
      localStorage.removeItem(LIGHTNING_ADDRESS_STORAGE_KEY)
      localStorage.removeItem(PEER_LUD16_CACHE_STORAGE_KEY)
      localStorage.removeItem(ZAP_MODE_STORAGE_KEY)
      localStorage.removeItem(NPUBCASH_AUTOSWEEP_STORAGE_KEY)
    } catch {
      // Ignore storage errors
    }
    clearClaimedNpubCashQuotes()
    clearClaimedNutzapIds()
    clearStoredPeerNutzapInfoCache()
    removeSessionFlag(SESSION_AUTOPUB_KIND0_KEY)
    removeSessionFlag(SESSION_AUTOPUB_10019_KEY)

    if (watchUnsubRef.current) {
      watchUnsubRef.current()
      watchUnsubRef.current = null
    }
    watchSubKeyRef.current = ''
    watchedEventIdsRef.current.clear()
    seenZapReceiptIdsRef.current.clear()
    inFlightLookupsRef.current.clear()
    negativeLookupsRef.current.clear()
    inFlightNutzapLookupsRef.current.clear()
    negativeNutzapLookupsRef.current.clear()
    claimingNutzapIdsRef.current.clear()
    ownProfileCacheRef.current = null
    lastAutoPubKind0Ref.current = null
    lastAutoPub10019Ref.current = null
    lastFocusSweepAtRef.current = 0
    sweepInFlightRef.current = false

    zapModeRef.current = 'builtin'
    setZapModeState('builtin')
    customLightningAddressRef.current = null
    setCustomLightningAddressState(null)
    setNpubCashUsername(null)
    npubCashAutoSweepRef.current = true
    setNpubCashAutoSweepState(true)
    setNpubCashSweeping(false)
    setNpubCashLastSweptAt(null)
    setNpubCashLastError(null)
    setNpubCashMintUrl(null)
    setNutzapInfoPublished(false)

    peerLud16Ref.current = {}
    setPeerLightningAddresses({})
    peerNutzapInfoRef.current = {}
    setPeerNutzapInfo({})
    setZapReceiptsByEventId({})
    setPublishingProfile(false)
  }, [])

  return useMemo<ZapEngine>(
    () => ({
      lightningAddress,
      zapMode,
      builtinLightningAddress,
      customLightningAddress,
      npubCashAutoSweep,
      npubCashSweeping,
      npubCashLastSweptAt,
      npubCashLastError,
      npubCashMintUrl,
      nutzapInfoPublished,
      publishingProfile,
      peerLightningAddresses,
      peerNutzapInfo,
      zapTotalsByEventId,
      zapReceiptsByEventId,
      setLightningAddress,
      setZapAddressMode,
      setNpubCashAutoSweep,
      sweepNpubCashNow,
      publishNutzapInfo,
      getPeerLightningAddress,
      lookupPeerLightningAddress,
      getPeerNutzapInfo,
      lookupPeerNutzapInfo,
      ingestPeerLightningAddress,
      ingestEventTags,
      ingestZapReceipt,
      watchEventIds,
      resolveLnurlPay,
      requestZapInvoice,
      sendNutzap,
      canZapPeer,
      resetAll,
    }),
    [
      lightningAddress,
      zapMode,
      builtinLightningAddress,
      customLightningAddress,
      npubCashAutoSweep,
      npubCashSweeping,
      npubCashLastSweptAt,
      npubCashLastError,
      npubCashMintUrl,
      nutzapInfoPublished,
      publishingProfile,
      peerLightningAddresses,
      peerNutzapInfo,
      zapTotalsByEventId,
      zapReceiptsByEventId,
      setLightningAddress,
      setZapAddressMode,
      setNpubCashAutoSweep,
      sweepNpubCashNow,
      publishNutzapInfo,
      getPeerLightningAddress,
      lookupPeerLightningAddress,
      getPeerNutzapInfo,
      lookupPeerNutzapInfo,
      ingestPeerLightningAddress,
      ingestEventTags,
      ingestZapReceipt,
      watchEventIds,
      requestZapInvoice,
      sendNutzap,
      canZapPeer,
      resetAll,
    ]
  )
}
