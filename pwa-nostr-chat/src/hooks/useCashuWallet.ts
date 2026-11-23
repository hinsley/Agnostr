import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { mnemonicToSeedSync } from '@scure/bip39'
import type { ToastLevel } from '../types/protocol.ts'
import type {
  BoltzReversePairInfo,
  BoltzSubmarinePairInfo,
  BoltzSwapRecord,
  CashuMeltQuotePreview,
  CashuMintAccount,
  CashuMintInfoSummary,
  CashuMintQuoteRecord,
  CashuMintQuoteState,
  CashuSentTokenRecord,
  CashuSentTokenStatus,
  StoredCashuProof,
  WalletBackupPayload,
  WalletDraftKeys,
  WalletEngine,
  WalletImportMode,
  WalletTransaction,
} from '../types/wallet.ts'
import {
  BOLTZ_API_URL_STORAGE_KEY,
  BOLTZ_SWAPS_STORAGE_KEY,
  DEFAULT_BOLTZ_API_URL,
  buildBoltzSwapRescueJson,
  createBoltzReverseSwap,
  createBoltzSubmarineSwap,
  fetchBoltzReversePair as fetchBoltzReversePairApi,
  fetchBoltzSubmarinePair as fetchBoltzSubmarinePairApi,
  fetchBoltzSwapStatus,
  isBoltzSwapActive,
  loadStoredBoltzApiUrl,
  loadStoredBoltzSwaps,
  saveStoredBoltzApiUrl,
  saveStoredBoltzSwaps,
} from '../lib/boltzSwap.ts'
import { findCatalogMint, formatMintHost, normalizeMintUrl } from '../lib/cashuMints.ts'
import {
  CASHU_WALLET_STORAGE_KEY,
  checkAndMintCashuQuote,
  checkCashuSentTokenClaimed,
  claimCashuTokenProofs,
  clearCashuWalletInstanceCache,
  configureCashuWalletRuntime,
  createCashuMeltQuote,
  createCashuMintQuote,
  createEmptyWalletState,
  decodeCashuTokenPreview,
  deduplicateProofs,
  derivePrivateKeyHexFromSeed,
  detectWalletImportFormat,
  executeCashuMeltQuote,
  generateCashuWalletKeys,
  inspectCashuMint,
  isValidBip39Mnemonic,
  loadPersistedCashuWallet,
  normalizeMintError,
  normalizeMnemonicPhrase,
  parseWalletBackupJson,
  parseWalletPrivateKeyHex,
  restoreCashuProofsFromMint,
  savePersistedCashuWallet,
  sendCashuTokenProofs,
  sumStoredProofs,
  verifyCashuProofsOnMint,
  type PersistedCashuWalletState,
} from '../lib/cashuWallet.ts'
import {
  fetchLnurlPayInvoice,
  parseLightningPayload,
  resolveLnurlPay,
} from '../lib/zaps.ts'

export interface UseCashuWalletOptions {
  pushToast?: (level: ToastLevel, title: string, detail?: string) => void
}

function makeId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

export function useCashuWallet(options: UseCashuWalletOptions = {}): WalletEngine {
  const pushToastRef = useRef(options.pushToast)
  pushToastRef.current = options.pushToast

  const [walletState, setWalletState] = useState<PersistedCashuWalletState>(() =>
    loadPersistedCashuWallet()
  )
  const stateRef = useRef<PersistedCashuWalletState>(walletState)

  const [boltzSwaps, setBoltzSwaps] = useState<BoltzSwapRecord[]>(() => loadStoredBoltzSwaps())
  const boltzSwapsRef = useRef<BoltzSwapRecord[]>(boltzSwaps)

  const [boltzApiUrl, setBoltzApiUrlState] = useState<string>(() => loadStoredBoltzApiUrl())
  const boltzApiUrlRef = useRef<string>(boltzApiUrl)

  const [activeMintQuote, setActiveMintQuote] = useState<CashuMintQuoteRecord | null>(null)
  const activeMintQuoteRef = useRef<CashuMintQuoteRecord | null>(null)

  const [busy, setBusy] = useState(false)
  const [lastError, setLastError] = useState<string | null>(null)

  const mintPollInFlightRef = useRef(false)
  const swapPollInFlightRef = useRef(false)

  const commitState = useCallback(
    (updater: (prev: PersistedCashuWalletState) => PersistedCashuWalletState) => {
      const next = updater(stateRef.current)
      stateRef.current = next
      savePersistedCashuWallet(next)
      setWalletState(next)
      return next
    },
    []
  )

  const syncRuntimeSeed = useCallback(
    (state: PersistedCashuWalletState) => {
      configureCashuWalletRuntime({
        mnemonic: state.mnemonic,
        privateKeyHex: state.privateKeyHex,
        counters: state.keysetCounters,
        onCountersChanged: (snapshot) => {
          const cur = stateRef.current
          const next: PersistedCashuWalletState = {
            ...cur,
            keysetCounters: snapshot,
          }
          stateRef.current = next
          savePersistedCashuWallet(next)
        },
      })
    },
    []
  )

  // Synchronize runtime NUT-13 seed & counter store with persisted wallet credentials
  useEffect(() => {
    syncRuntimeSeed(walletState)
  }, [syncRuntimeSeed, walletState])

  const commitSwaps = useCallback((updater: (prev: BoltzSwapRecord[]) => BoltzSwapRecord[]) => {
    const next = updater(boltzSwapsRef.current)
    boltzSwapsRef.current = next
    saveStoredBoltzSwaps(next)
    setBoltzSwaps(next)
    return next
  }, [])

  const setActiveQuoteSynced = useCallback((quote: CashuMintQuoteRecord | null) => {
    activeMintQuoteRef.current = quote
    setActiveMintQuote(quote)
  }, [])

  const ensureInitializedWithKeys = useCallback(() => {
    const cur = stateRef.current
    if (cur.initialized && (cur.mnemonic || cur.privateKeyHex)) return
    const fresh = !cur.mnemonic && !cur.privateKeyHex ? generateCashuWalletKeys() : null
    const next = commitState((prev) => ({
      ...prev,
      initialized: true,
      mnemonic: prev.mnemonic ?? fresh?.mnemonic,
      privateKeyHex: prev.privateKeyHex ?? fresh?.privateKeyHex,
    }))
    syncRuntimeSeed(next)
  }, [commitState, syncRuntimeSeed])

  const appendProofsToMint = useCallback(
    (mintUrl: string, newProofs: StoredCashuProof[], labelHint?: string) => {
      const norm = normalizeMintUrl(mintUrl)
      if (!norm || newProofs.length === 0) return
      commitState((prev) => {
        const existing = prev.proofsByMint[norm] ?? []
        const merged = deduplicateProofs([...existing, ...newProofs])
        const hasMint = prev.mints.some((m) => m.url === norm)
        const catalog = findCatalogMint(norm)
        const mints: CashuMintAccount[] = hasMint
          ? prev.mints
          : [
              ...prev.mints,
              {
                url: norm,
                label: (labelHint || catalog?.name || formatMintHost(norm)).trim(),
                description: catalog?.description,
                addedAt: Date.now(),
              },
            ]
        return {
          ...prev,
          initialized: true,
          mints,
          proofsByMint: {
            ...prev.proofsByMint,
            [norm]: merged,
          },
        }
      })
    },
    [commitState]
  )

  const recordTransaction = useCallback(
    (tx: Omit<WalletTransaction, 'id' | 'createdAt'> & { id?: string; createdAt?: number }) => {
      const entry: WalletTransaction = {
        ...tx,
        id: tx.id ?? makeId('tx'),
        createdAt: tx.createdAt ?? Date.now(),
      }
      commitState((prev) => ({
        ...prev,
        history: [entry, ...prev.history].slice(0, 250),
      }))
      return entry
    },
    [commitState]
  )

  // Derived per-mint & total balances
  const balancesByMint = useMemo(() => {
    const out: Record<string, number> = {}
    for (const mint of walletState.mints) {
      out[mint.url] = sumStoredProofs(walletState.proofsByMint[mint.url])
    }
    for (const [url, list] of Object.entries(walletState.proofsByMint)) {
      if (!(url in out)) {
        out[url] = sumStoredProofs(list)
      }
    }
    return out
  }, [walletState.mints, walletState.proofsByMint])

  const proofCountByMint = useMemo(() => {
    const out: Record<string, number> = {}
    for (const mint of walletState.mints) {
      out[mint.url] = walletState.proofsByMint[mint.url]?.length ?? 0
    }
    return out
  }, [walletState.mints, walletState.proofsByMint])

  const totalBalanceSats = useMemo(() => {
    let total = 0
    for (const val of Object.values(balancesByMint)) {
      total += val
    }
    return total
  }, [balancesByMint])

  const activeMintBalanceSats = balancesByMint[walletState.activeMintUrl] ?? 0

  /* ------------------------------------------------------------------------
     Setup, NUT-13 BIP-39 Seed & Private Key Management
     ------------------------------------------------------------------------ */

  const generateDraftWalletKeys = useCallback((): WalletDraftKeys => {
    return generateCashuWalletKeys()
  }, [])

  const createNewWallet = useCallback(
    (opts?: { mnemonic?: string; privateKeyHex?: string; mintUrl?: string }) => {
      const draft =
        opts?.mnemonic && isValidBip39Mnemonic(opts.mnemonic)
          ? {
              mnemonic: normalizeMnemonicPhrase(opts.mnemonic),
              privateKeyHex:
                (opts.privateKeyHex && parseWalletPrivateKeyHex(opts.privateKeyHex)) ||
                derivePrivateKeyHexFromSeed(
                  mnemonicToSeedSync(normalizeMnemonicPhrase(opts.mnemonic))
                ),
            }
          : opts?.privateKeyHex && parseWalletPrivateKeyHex(opts.privateKeyHex)
            ? {
                mnemonic: undefined,
                privateKeyHex: parseWalletPrivateKeyHex(opts.privateKeyHex)!,
              }
            : generateCashuWalletKeys()

      clearCashuWalletInstanceCache()
      setActiveQuoteSynced(null)
      setLastError(null)

      const requestedMint = opts?.mintUrl ? normalizeMintUrl(opts.mintUrl) : null

      const next = commitState((prev) => {
        const mints = prev.mints.length > 0 ? prev.mints : createEmptyWalletState().mints
        const activeMintUrl =
          requestedMint && mints.some((m) => m.url === requestedMint)
            ? requestedMint
            : prev.activeMintUrl
        return {
          version: 1,
          initialized: true,
          ...(draft.mnemonic ? { mnemonic: draft.mnemonic } : {}),
          privateKeyHex: draft.privateKeyHex,
          keysetCounters: {},
          activeMintUrl,
          mints,
          proofsByMint: {},
          history: [],
          sentTokens: [],
        }
      })

      syncRuntimeSeed(next)
      pushToastRef.current?.('success', 'Agwallet created', formatMintHost(next.activeMintUrl))
    },
    [commitState, setActiveQuoteSynced, syncRuntimeSeed]
  )

  const restoreProofsFromSeed = useCallback(
    async (mintUrl?: string): Promise<{ restoredSats: number; restoredProofs: number }> => {
      const targetUrl = normalizeMintUrl(mintUrl ?? stateRef.current.activeMintUrl)
      if (!targetUrl) throw new Error('No mint selected.')
      if (!stateRef.current.mnemonic && !stateRef.current.privateKeyHex) {
        throw new Error('No recovery phrase or private key configured.')
      }

      setBusy(true)
      setLastError(null)
      try {
        syncRuntimeSeed(stateRef.current)
        const res = await restoreCashuProofsFromMint(targetUrl)

        let addedCount = 0
        let addedSats = 0
        commitState((prev) => {
          const existing = prev.proofsByMint[targetUrl] ?? []
          const existingSecrets = new Set(existing.map((p) => p.secret))
          const newlyFound = res.unspentProofs.filter((p) => !existingSecrets.has(p.secret))
          addedCount = newlyFound.length
          addedSats = sumStoredProofs(newlyFound)
          return {
            ...prev,
            keysetCounters: { ...prev.keysetCounters, ...res.counters },
            proofsByMint:
              newlyFound.length > 0
                ? {
                    ...prev.proofsByMint,
                    [targetUrl]: deduplicateProofs([...existing, ...newlyFound]),
                  }
                : prev.proofsByMint,
          }
        })

        if (addedSats > 0) {
          pushToastRef.current?.(
            'success',
            `Restored ${addedSats.toLocaleString()} sats`,
            `${addedCount} unspent proof${addedCount === 1 ? '' : 's'} on ${formatMintHost(targetUrl)}`
          )
        }
        return { restoredSats: addedSats, restoredProofs: addedCount }
      } catch (err) {
        const msg = normalizeMintError(err, 'Failed to restore proofs from seed.')
        setLastError(msg)
        throw new Error(msg)
      } finally {
        setBusy(false)
      }
    },
    [commitState, syncRuntimeSeed]
  )

  const importBackupJson = useCallback(
    async (rawJson: string) => {
      const backup = parseWalletBackupJson(rawJson)
      let importedMints = 0
      let importedProofs = 0
      let totalSats = 0

      const nextState = commitState((prev) => {
        const mintMap = new Map<string, CashuMintAccount>()
        for (const m of prev.mints) mintMap.set(m.url, m)
        for (const m of backup.mints) {
          if (!mintMap.has(m.url)) {
            mintMap.set(m.url, m)
            importedMints += 1
          }
        }

        const nextProofsByMint: Record<string, StoredCashuProof[]> = { ...prev.proofsByMint }
        for (const [url, incomingProofs] of Object.entries(backup.proofsByMint)) {
          const before = nextProofsByMint[url] ?? []
          const beforeSecrets = new Set(before.map((p) => p.secret))
          const newlyAdded = incomingProofs.filter((p) => !beforeSecrets.has(p.secret))
          importedProofs += newlyAdded.length
          nextProofsByMint[url] = deduplicateProofs([...before, ...incomingProofs])
          if (!mintMap.has(url)) {
            const cat = findCatalogMint(url)
            mintMap.set(url, {
              url,
              label: cat?.name || formatMintHost(url),
              description: cat?.description,
              addedAt: Date.now(),
            })
            importedMints += 1
          }
        }

        for (const list of Object.values(nextProofsByMint)) {
          totalSats += sumStoredProofs(list)
        }

        const historyIds = new Set(prev.history.map((h) => h.id))
        const mergedHistory = [
          ...prev.history,
          ...backup.history.filter((h) => h && h.id && !historyIds.has(h.id)),
        ]
          .sort((a, b) => b.createdAt - a.createdAt)
          .slice(0, 250)

        const sentIds = new Set(prev.sentTokens.map((s) => s.id))
        const mergedSent = [
          ...prev.sentTokens,
          ...backup.sentTokens.filter((s) => s && s.id && !sentIds.has(s.id)),
        ]
          .sort((a, b) => b.createdAt - a.createdAt)
          .slice(0, 100)

        const nextCounters: Record<string, number> = { ...prev.keysetCounters }
        if (backup.keysetCounters) {
          for (const [ksId, c] of Object.entries(backup.keysetCounters)) {
            nextCounters[ksId] = Math.max(nextCounters[ksId] ?? 0, c)
          }
        }

        const adoptedMnemonic = backup.mnemonic ?? prev.mnemonic
        const adoptedPrivKey = backup.privateKeyHex ?? prev.privateKeyHex

        return {
          version: 1,
          initialized: true,
          ...(adoptedMnemonic ? { mnemonic: adoptedMnemonic } : {}),
          ...(adoptedPrivKey ? { privateKeyHex: adoptedPrivKey } : {}),
          keysetCounters: nextCounters,
          activeMintUrl: mintMap.has(backup.activeMintUrl)
            ? backup.activeMintUrl
            : prev.activeMintUrl,
          mints: Array.from(mintMap.values()),
          proofsByMint: nextProofsByMint,
          history: mergedHistory,
          sentTokens: mergedSent,
        }
      })

      syncRuntimeSeed(nextState)

      if (backup.boltzSwaps.length > 0) {
        commitSwaps((prev) => {
          const ids = new Set(prev.map((s) => s.id))
          return [...prev, ...backup.boltzSwaps.filter((s) => s && s.id && !ids.has(s.id))]
            .sort((a, b) => b.createdAt - a.createdAt)
            .slice(0, 40)
        })
      }

      if (backup.boltzApiUrl) {
        const saved = saveStoredBoltzApiUrl(backup.boltzApiUrl)
        boltzApiUrlRef.current = saved
        setBoltzApiUrlState(saved)
      }

      pushToastRef.current?.(
        'success',
        'Agwallet backup restored',
        `+${importedProofs} proof${importedProofs === 1 ? '' : 's'} · ${totalSats.toLocaleString()} sats total`
      )
      return { importedMints, importedProofs, totalSats }
    },
    [commitState, commitSwaps, syncRuntimeSeed]
  )

  const importWalletKeyOrSeed = useCallback(
    async (
      rawInput: string,
      opts?: { mintUrl?: string; scanMints?: boolean }
    ): Promise<{ mode: WalletImportMode; restoredSats: number; restoredProofs: number }> => {
      const detected = detectWalletImportFormat(rawInput)
      if (!detected) {
        throw new Error(
          'Unrecognized format. Paste a 12/24-word BIP-39 phrase, 64-hex / nsec1… private key, or backup JSON.'
        )
      }

      if (detected.mode === 'json') {
        const res = await importBackupJson(rawInput)
        // If backup JSON also carried a seed/key and user opted to scan, scan active mint too
        let extraSats = 0
        let extraProofs = 0
        if (opts?.scanMints && (stateRef.current.mnemonic || stateRef.current.privateKeyHex)) {
          try {
            const scan = await restoreProofsFromSeed(opts.mintUrl ?? stateRef.current.activeMintUrl)
            extraSats = scan.restoredSats
            extraProofs = scan.restoredProofs
          } catch {
            // Keep imported JSON proofs even if online scan fails
          }
        }
        return {
          mode: 'json',
          restoredSats: res.totalSats + extraSats,
          restoredProofs: res.importedProofs + extraProofs,
        }
      }

      setBusy(true)
      setLastError(null)
      try {
        clearCashuWalletInstanceCache()
        setActiveQuoteSynced(null)

        const targetMint =
          (opts?.mintUrl && normalizeMintUrl(opts.mintUrl)) || stateRef.current.activeMintUrl

        if (detected.mode === 'mnemonic') {
          const mnemonic = normalizeMnemonicPhrase(rawInput)
          const privateKeyHex = derivePrivateKeyHexFromSeed(mnemonicToSeedSync(mnemonic))
          const next = commitState((prev) => ({
            version: 1,
            initialized: true,
            mnemonic,
            privateKeyHex,
            keysetCounters: {},
            activeMintUrl: prev.mints.some((m) => m.url === targetMint)
              ? targetMint
              : prev.activeMintUrl,
            mints: prev.mints.length > 0 ? prev.mints : createEmptyWalletState().mints,
            proofsByMint: {},
            history: [],
            sentTokens: [],
          }))
          syncRuntimeSeed(next)
        } else {
          const privateKeyHex = parseWalletPrivateKeyHex(rawInput)
          if (!privateKeyHex) {
            throw new Error('Invalid private key.')
          }
          const next = commitState((prev) => ({
            version: 1,
            initialized: true,
            privateKeyHex,
            keysetCounters: {},
            activeMintUrl: prev.mints.some((m) => m.url === targetMint)
              ? targetMint
              : prev.activeMintUrl,
            mints: prev.mints.length > 0 ? prev.mints : createEmptyWalletState().mints,
            proofsByMint: {},
            history: [],
            sentTokens: [],
          }))
          syncRuntimeSeed(next)
        }

        let restoredSats = 0
        let restoredProofs = 0
        if (opts?.scanMints !== false) {
          try {
            const scan = await restoreCashuProofsFromMint(stateRef.current.activeMintUrl)
            restoredSats = scan.restoredSats
            restoredProofs = scan.unspentProofs.length
            commitState((prev) => ({
              ...prev,
              keysetCounters: { ...prev.keysetCounters, ...scan.counters },
              proofsByMint:
                scan.unspentProofs.length > 0
                  ? {
                      ...prev.proofsByMint,
                      [prev.activeMintUrl]: scan.unspentProofs,
                    }
                  : prev.proofsByMint,
            }))
          } catch {
            // Mint may be unreachable during import; wallet keys are still safely imported
          }
        }

        pushToastRef.current?.(
          'success',
          restoredSats > 0
            ? `Imported & restored ${restoredSats.toLocaleString()} sats`
            : 'Agwallet imported',
          formatMintHost(stateRef.current.activeMintUrl)
        )
        return { mode: detected.mode, restoredSats, restoredProofs }
      } catch (err) {
        const msg = normalizeMintError(err, 'Failed to import Agwallet key.')
        setLastError(msg)
        throw new Error(msg)
      } finally {
        setBusy(false)
      }
    },
    [commitState, importBackupJson, restoreProofsFromSeed, setActiveQuoteSynced, syncRuntimeSeed]
  )

  const exportBackupJson = useCallback((): string => {
    const cur = stateRef.current
    const payload: WalletBackupPayload = {
      version: 1,
      exportedAt: Date.now(),
      activeMintUrl: cur.activeMintUrl,
      ...(cur.mnemonic ? { mnemonic: cur.mnemonic } : {}),
      ...(cur.privateKeyHex ? { privateKeyHex: cur.privateKeyHex } : {}),
      keysetCounters: cur.keysetCounters,
      mints: cur.mints,
      proofsByMint: cur.proofsByMint,
      history: cur.history,
      sentTokens: cur.sentTokens,
      boltzSwaps: boltzSwapsRef.current,
      boltzApiUrl: boltzApiUrlRef.current,
    }
    return JSON.stringify(payload, null, 2)
  }, [])

  const exportWalletKeyJson = useCallback((): string => {
    return exportBackupJson()
  }, [exportBackupJson])

  /* ------------------------------------------------------------------------
     Mint Management
     ------------------------------------------------------------------------ */

  const selectMint = useCallback(
    (mintUrl: string) => {
      const norm = normalizeMintUrl(mintUrl)
      if (!norm) return
      commitState((prev) => {
        if (!prev.mints.some((m) => m.url === norm)) return prev
        return { ...prev, activeMintUrl: norm }
      })
      setLastError(null)
    },
    [commitState]
  )

  const inspectMint = useCallback(
    async (mintUrl: string): Promise<CashuMintInfoSummary> => {
      const norm = normalizeMintUrl(mintUrl)
      if (!norm) throw new Error('Enter a valid HTTPS Cashu mint URL.')
      const info = await inspectCashuMint(norm)
      commitState((prev) => ({
        ...prev,
        mints: prev.mints.map((m) =>
          m.url === norm
            ? {
                ...m,
                label: info.online && info.name ? info.name : m.label,
                description: info.description || m.description,
                info,
              }
            : m
        ),
      }))
      return info
    },
    [commitState]
  )

  const addMint = useCallback(
    async (mintUrl: string, label?: string): Promise<CashuMintInfoSummary> => {
      const norm = normalizeMintUrl(mintUrl)
      if (!norm) {
        throw new Error('Enter a valid HTTPS Cashu mint URL (e.g. https://mint.minibits.cash/Bitcoin).')
      }
      setBusy(true)
      setLastError(null)
      try {
        const info = await inspectCashuMint(norm)
        if (!info.online) {
          throw new Error(info.error || 'Unable to connect to this Cashu mint.')
        }
        commitState((prev) => {
          const exists = prev.mints.some((m) => m.url === norm)
          const nextMints = exists
            ? prev.mints.map((m) =>
                m.url === norm
                  ? {
                      ...m,
                      label: (label?.trim() || info.name || m.label).trim(),
                      description: info.description || m.description,
                      info,
                    }
                  : m
              )
            : [
                ...prev.mints,
                {
                  url: norm,
                  label: (label?.trim() || info.name || formatMintHost(norm)).trim(),
                  description: info.description,
                  addedAt: Date.now(),
                  info,
                },
              ]
          return {
            ...prev,
            activeMintUrl: norm,
            mints: nextMints,
          }
        })
        pushToastRef.current?.('success', `Connected mint: ${info.name}`, formatMintHost(norm))
        return info
      } catch (err) {
        const msg = normalizeMintError(err, 'Failed to add Cashu mint.')
        setLastError(msg)
        throw new Error(msg)
      } finally {
        setBusy(false)
      }
    },
    [commitState]
  )

  const removeMint = useCallback(
    (mintUrl: string): boolean => {
      const norm = normalizeMintUrl(mintUrl)
      if (!norm) return false
      const prev = stateRef.current
      if (prev.mints.length <= 1) {
        setLastError('Keep at least one active Cashu mint in your Agwallet.')
        return false
      }
      const bal = sumStoredProofs(prev.proofsByMint[norm])
      if (bal > 0) {
        setLastError(`Cannot remove mint while it holds ${bal.toLocaleString()} sats.`)
        return false
      }
      commitState((cur) => {
        const nextMints = cur.mints.filter((m) => m.url !== norm)
        const nextProofs = { ...cur.proofsByMint }
        delete nextProofs[norm]
        const nextActive =
          cur.activeMintUrl === norm ? nextMints[0]?.url ?? cur.activeMintUrl : cur.activeMintUrl
        return {
          ...cur,
          mints: nextMints,
          proofsByMint: nextProofs,
          activeMintUrl: nextActive,
        }
      })
      pushToastRef.current?.('info', 'Removed Cashu mint', formatMintHost(norm))
      return true
    },
    [commitState]
  )

  const verifyProofs = useCallback(
    async (mintUrl?: string) => {
      const targetUrl = normalizeMintUrl(mintUrl ?? stateRef.current.activeMintUrl)
      if (!targetUrl) throw new Error('No mint selected.')
      setBusy(true)
      setLastError(null)
      try {
        const currentProofs = stateRef.current.proofsByMint[targetUrl] ?? []
        const result = await verifyCashuProofsOnMint(targetUrl, currentProofs)
        commitState((prev) => ({
          ...prev,
          proofsByMint: {
            ...prev.proofsByMint,
            [targetUrl]: result.unspentProofs,
          },
        }))
        const balanceSats = sumStoredProofs(result.unspentProofs)
        if (result.spentRemoved > 0) {
          pushToastRef.current?.(
            'warning',
            `Pruned ${result.spentRemoved} spent proof${result.spentRemoved === 1 ? '' : 's'}`,
            `${balanceSats.toLocaleString()} sats verified unspent`
          )
        } else {
          pushToastRef.current?.(
            'success',
            'Proofs verified',
            `${result.checked} proof${result.checked === 1 ? '' : 's'} · ${balanceSats.toLocaleString()} sats`
          )
        }
        return {
          checked: result.checked,
          spentRemoved: result.spentRemoved,
          pendingCount: result.pendingCount,
          balanceSats,
        }
      } catch (err) {
        const msg = normalizeMintError(err, 'Failed to verify proof states with mint.')
        setLastError(msg)
        throw new Error(msg)
      } finally {
        setBusy(false)
      }
    },
    [commitState]
  )

  /* ------------------------------------------------------------------------
     Cashu Ecash Receive, Send, Status Check & Reclaim
     ------------------------------------------------------------------------ */

  const decodeTokenPreview = useCallback((token: string) => decodeCashuTokenPreview(token), [])

  const receiveCashuToken = useCallback(
    async (rawToken: string) => {
      ensureInitializedWithKeys()
      setBusy(true)
      setLastError(null)
      try {
        const claimed = await claimCashuTokenProofs(rawToken)
        appendProofsToMint(claimed.mintUrl, claimed.proofs)
        commitState((prev) => ({
          ...prev,
          activeMintUrl: claimed.mintUrl,
        }))
        recordTransaction({
          type: 'receive_ecash',
          status: 'completed',
          amountSats: claimed.amountSats,
          mintUrl: claimed.mintUrl,
          memo: claimed.memo,
        })
        pushToastRef.current?.(
          'success',
          `Claimed ${claimed.amountSats.toLocaleString()} sats`,
          formatMintHost(claimed.mintUrl)
        )
        return {
          amountSats: claimed.amountSats,
          mintUrl: claimed.mintUrl,
          memo: claimed.memo,
        }
      } catch (err) {
        const msg = normalizeMintError(err, 'Failed to claim Cashu ecash token.')
        setLastError(msg)
        throw new Error(msg)
      } finally {
        setBusy(false)
      }
    },
    [appendProofsToMint, commitState, ensureInitializedWithKeys, recordTransaction]
  )

  const createCashuToken = useCallback(
    async (amountSats: number, memo?: string, mintUrl?: string): Promise<CashuSentTokenRecord> => {
      const targetUrl = normalizeMintUrl(mintUrl ?? stateRef.current.activeMintUrl)
      if (!targetUrl) throw new Error('No mint selected.')
      setBusy(true)
      setLastError(null)
      try {
        const existingProofs = stateRef.current.proofsByMint[targetUrl] ?? []
        const res = await sendCashuTokenProofs({
          mintUrl: targetUrl,
          existingProofs,
          amountSats,
          memo,
        })

        const sentRecord: CashuSentTokenRecord = {
          id: makeId('tok'),
          token: res.token,
          mintUrl: targetUrl,
          amountSats: res.sentSats,
          memo: memo?.trim() || undefined,
          createdAt: Date.now(),
          status: 'unclaimed',
          proofSecrets: res.sendProofs.map((p) => p.secret),
        }

        commitState((prev) => ({
          ...prev,
          proofsByMint: {
            ...prev.proofsByMint,
            [targetUrl]: res.keepProofs,
          },
          sentTokens: [sentRecord, ...prev.sentTokens].slice(0, 100),
          history: [
            {
              id: makeId('tx'),
              type: 'send_ecash' as const,
              status: 'completed' as const,
              amountSats: res.sentSats,
              feeSats: res.feeSats > 0 ? res.feeSats : undefined,
              mintUrl: targetUrl,
              memo: memo?.trim() || undefined,
              token: res.token,
              createdAt: sentRecord.createdAt,
            },
            ...prev.history,
          ].slice(0, 250),
        }))

        pushToastRef.current?.(
          'success',
          `Created ${res.sentSats.toLocaleString()} sat token`,
          formatMintHost(targetUrl)
        )
        return sentRecord
      } catch (err) {
        const msg = normalizeMintError(err, 'Failed to create Cashu token.')
        setLastError(msg)
        throw new Error(msg)
      } finally {
        setBusy(false)
      }
    },
    [commitState]
  )

  const checkSentTokenStatus = useCallback(
    async (sentId: string): Promise<CashuSentTokenStatus> => {
      const record = stateRef.current.sentTokens.find((s) => s.id === sentId)
      if (!record) return 'claimed'
      if (record.status !== 'unclaimed') return record.status

      const spent = await checkCashuSentTokenClaimed(record.mintUrl, record.proofSecrets)
      if (spent) {
        commitState((prev) => ({
          ...prev,
          sentTokens: prev.sentTokens.map((s) =>
            s.id === sentId ? { ...s, status: 'claimed' } : s
          ),
        }))
        return 'claimed'
      }
      return 'unclaimed'
    },
    [commitState]
  )

  const reclaimSentToken = useCallback(
    async (sentId: string): Promise<number> => {
      const record = stateRef.current.sentTokens.find((s) => s.id === sentId)
      if (!record) throw new Error('Sent token record not found.')
      setBusy(true)
      setLastError(null)
      try {
        const claimed = await claimCashuTokenProofs(record.token)
        appendProofsToMint(claimed.mintUrl, claimed.proofs)
        commitState((prev) => ({
          ...prev,
          sentTokens: prev.sentTokens.map((s) =>
            s.id === sentId ? { ...s, status: 'reclaimed' } : s
          ),
        }))
        recordTransaction({
          type: 'reclaim',
          status: 'completed',
          amountSats: claimed.amountSats,
          mintUrl: claimed.mintUrl,
          memo: record.memo ? `Reclaimed: ${record.memo}` : 'Reclaimed unclaimed token',
        })
        pushToastRef.current?.(
          'success',
          `Reclaimed ${claimed.amountSats.toLocaleString()} sats`,
          formatMintHost(claimed.mintUrl)
        )
        return claimed.amountSats
      } catch (err) {
        const msg = normalizeMintError(err, 'Could not reclaim token (it may already be claimed).')
        if (/already been claimed|spent/i.test(msg)) {
          commitState((prev) => ({
            ...prev,
            sentTokens: prev.sentTokens.map((s) =>
              s.id === sentId ? { ...s, status: 'claimed' } : s
            ),
          }))
        }
        setLastError(msg)
        throw new Error(msg)
      } finally {
        setBusy(false)
      }
    },
    [appendProofsToMint, commitState, recordTransaction]
  )

  /* ------------------------------------------------------------------------
     Lightning NUT-04 Receive & NUT-05 Send
     ------------------------------------------------------------------------ */

  const createLightningReceiveQuote = useCallback(
    async (
      amountSats: number,
      description?: string,
      mintUrl?: string
    ): Promise<CashuMintQuoteRecord> => {
      ensureInitializedWithKeys()
      const targetUrl = normalizeMintUrl(mintUrl ?? stateRef.current.activeMintUrl)
      if (!targetUrl) throw new Error('No mint selected.')
      setBusy(true)
      setLastError(null)
      try {
        const quote = await createCashuMintQuote(targetUrl, amountSats, description)
        setActiveQuoteSynced(quote)
        return quote
      } catch (err) {
        const msg = normalizeMintError(err, 'Failed to create Lightning receive invoice.')
        setLastError(msg)
        throw new Error(msg)
      } finally {
        setBusy(false)
      }
    },
    [ensureInitializedWithKeys, setActiveQuoteSynced]
  )

  const checkAndClaimMintQuote = useCallback(
    async (quoteId?: string): Promise<{ state: CashuMintQuoteState; claimedSats: number }> => {
      const current = activeMintQuoteRef.current
      if (!current || (quoteId && current.quoteId !== quoteId)) {
        return { state: 'EXPIRED', claimedSats: 0 }
      }
      if (current.state === 'ISSUED') {
        return { state: 'ISSUED', claimedSats: 0 }
      }
      if (mintPollInFlightRef.current) {
        return { state: current.state, claimedSats: 0 }
      }

      mintPollInFlightRef.current = true
      try {
        const res = await checkAndMintCashuQuote(current)
        if (res.claimedSats > 0 && res.proofs.length > 0) {
          appendProofsToMint(current.mintUrl, res.proofs)
          recordTransaction({
            type: 'receive_ln',
            status: 'completed',
            amountSats: res.claimedSats,
            mintUrl: current.mintUrl,
            memo: current.description || 'Lightning deposit',
            invoice: current.invoice,
          })
          pushToastRef.current?.(
            'success',
            `Received ${res.claimedSats.toLocaleString()} sats`,
            `Minted on ${formatMintHost(current.mintUrl)}`
          )
        }
        if (res.state !== current.state) {
          setActiveQuoteSynced({ ...current, state: res.state })
        }
        return { state: res.state, claimedSats: res.claimedSats }
      } finally {
        mintPollInFlightRef.current = false
      }
    },
    [appendProofsToMint, recordTransaction, setActiveQuoteSynced]
  )

  const clearActiveMintQuote = useCallback(() => {
    setActiveQuoteSynced(null)
  }, [setActiveQuoteSynced])

  // Auto-poll active NUT-04 mint quote every 3.5s while UNPAID
  useEffect(() => {
    if (!activeMintQuote || activeMintQuote.state !== 'UNPAID') return
    const timer = window.setInterval(() => {
      void checkAndClaimMintQuote(activeMintQuote.quoteId).catch(() => {
        // Silent retry
      })
    }, 3500)
    return () => window.clearInterval(timer)
  }, [activeMintQuote, checkAndClaimMintQuote])

  const prepareLightningPayment = useCallback(
    async (
      invoiceOrAddress: string,
      amountSats?: number,
      comment?: string,
      mintUrl?: string
    ): Promise<CashuMeltQuotePreview> => {
      const targetUrl = normalizeMintUrl(mintUrl ?? stateRef.current.activeMintUrl)
      if (!targetUrl) throw new Error('No mint selected.')
      const parsed = parseLightningPayload(invoiceOrAddress)
      if (!parsed) {
        throw new Error('Enter a valid BOLT-11 invoice (lnbc…) or Lightning Address (user@domain).')
      }

      setBusy(true)
      setLastError(null)
      try {
        let invoice: string
        let recipient: string | undefined

        if (parsed.kind === 'bolt11') {
          invoice = parsed.invoice
        } else {
          const cleanSats = Math.floor(amountSats ?? 0)
          if (!Number.isFinite(cleanSats) || cleanSats <= 0) {
            throw new Error('Enter the satoshi amount to send to this Lightning Address.')
          }
          const addr = parsed.kind === 'lud16' ? parsed.address : parsed.lnurl
          recipient = addr
          const meta = await resolveLnurlPay(addr)
          invoice = await fetchLnurlPayInvoice({
            metadata: meta,
            amountSats: cleanSats,
            comment,
          })
        }

        const preview = await createCashuMeltQuote({
          mintUrl: targetUrl,
          invoice,
          recipient,
          memo: comment?.trim() || undefined,
        })
        return preview
      } catch (err) {
        const msg = normalizeMintError(err, 'Failed to prepare Lightning payment quote.')
        setLastError(msg)
        throw new Error(msg)
      } finally {
        setBusy(false)
      }
    },
    []
  )

  const payLightningQuote = useCallback(
    async (
      preview: CashuMeltQuotePreview,
      meta?: { counterparty?: string; memo?: string; txType?: 'send_ln' | 'zap_out' }
    ) => {
      setBusy(true)
      setLastError(null)
      try {
        const existingProofs = stateRef.current.proofsByMint[preview.mintUrl] ?? []
        const result = await executeCashuMeltQuote({
          preview,
          existingProofs,
          onCommitKeep: (keepProofs) => {
            commitState((prev) => ({
              ...prev,
              proofsByMint: {
                ...prev.proofsByMint,
                [preview.mintUrl]: keepProofs,
              },
            }))
          },
        })

        if (result.changeProofs.length > 0) {
          appendProofsToMint(preview.mintUrl, result.changeProofs)
        }

        const txType = meta?.txType ?? 'send_ln'
        recordTransaction({
          type: txType,
          status: result.paid ? 'completed' : 'pending',
          amountSats: preview.amountSats,
          feeSats: result.feePaidSats,
          mintUrl: preview.mintUrl,
          counterparty: meta?.counterparty ?? preview.recipient,
          memo: meta?.memo ?? preview.memo,
          invoice: preview.invoice,
        })

        pushToastRef.current?.(
          'success',
          txType === 'zap_out'
            ? `Zapped ${preview.amountSats.toLocaleString()} sats`
            : `Paid ${preview.amountSats.toLocaleString()} sats`,
          result.feePaidSats > 0
            ? `Fee: ${result.feePaidSats} sat${result.feePaidSats === 1 ? '' : 's'}`
            : 'Zero routing fee'
        )

        return {
          paid: result.paid,
          feePaidSats: result.feePaidSats,
          preimage: result.preimage,
        }
      } catch (err) {
        const msg = normalizeMintError(err, 'Lightning payment failed.')
        setLastError(msg)
        throw new Error(msg)
      } finally {
        setBusy(false)
      }
    },
    [appendProofsToMint, commitState, recordTransaction]
  )

  const payBolt11Invoice = useCallback(
    async (
      invoice: string,
      meta?: {
        counterparty?: string
        memo?: string
        txType?: 'send_ln' | 'zap_out'
        mintUrl?: string
      }
    ) => {
      const preview = await prepareLightningPayment(invoice, undefined, meta?.memo, meta?.mintUrl)
      const res = await payLightningQuote(preview, {
        counterparty: meta?.counterparty,
        memo: meta?.memo,
        txType: meta?.txType,
      })
      return {
        paid: res.paid,
        amountSats: preview.amountSats,
        feePaidSats: res.feePaidSats,
        preimage: res.preimage,
      }
    },
    [payLightningQuote, prepareLightningPayment]
  )

  /* ------------------------------------------------------------------------
     On-Chain BTC <-> Cashu Ecash via Boltz Exchange v2
     ------------------------------------------------------------------------ */

  const setBoltzApiUrl = useCallback((url: string) => {
    const saved = saveStoredBoltzApiUrl(url)
    boltzApiUrlRef.current = saved
    setBoltzApiUrlState(saved)
  }, [])

  const fetchBoltzSubmarinePair = useCallback(async (): Promise<BoltzSubmarinePairInfo> => {
    return await fetchBoltzSubmarinePairApi(boltzApiUrlRef.current)
  }, [])

  const fetchBoltzReversePair = useCallback(async (): Promise<BoltzReversePairInfo> => {
    return await fetchBoltzReversePairApi(boltzApiUrlRef.current)
  }, [])

  const createOnchainReceiveSwap = useCallback(
    async (amountSats: number, mintUrl?: string): Promise<BoltzSwapRecord> => {
      ensureInitializedWithKeys()
      const targetUrl = normalizeMintUrl(mintUrl ?? stateRef.current.activeMintUrl)
      if (!targetUrl) throw new Error('No mint selected.')
      const cleanSats = Math.floor(amountSats)
      if (!Number.isFinite(cleanSats) || cleanSats <= 0) {
        throw new Error('Enter a valid satoshi amount.')
      }

      setBusy(true)
      setLastError(null)
      try {
        const pairInfo = await fetchBoltzSubmarinePairApi(boltzApiUrlRef.current)
        if (cleanSats < pairInfo.minSats || cleanSats > pairInfo.maxSats) {
          throw new Error(
            `Boltz on-chain receive requires ${pairInfo.minSats.toLocaleString()}–${pairInfo.maxSats.toLocaleString()} sats.`
          )
        }

        const mintQuote = await createCashuMintQuote(
          targetUrl,
          cleanSats,
          'Boltz on-chain BTC deposit'
        )
        const swap = await createBoltzSubmarineSwap({
          apiUrl: boltzApiUrlRef.current,
          invoice: mintQuote.invoice,
          mintUrl: targetUrl,
          mintQuoteId: mintQuote.quoteId,
          amountSats: cleanSats,
          pairInfo,
        })

        commitSwaps((prev) => [swap, ...prev].slice(0, 40))
        recordTransaction({
          type: 'receive_btc',
          status: 'pending',
          amountSats: cleanSats,
          feeSats: swap.feeSats,
          mintUrl: targetUrl,
          memo: `Boltz BTC deposit (${swap.id})`,
          swapId: swap.id,
        })
        pushToastRef.current?.(
          'info',
          'On-chain BTC deposit address ready',
          `Send exactly ${swap.expectedOnchainSats.toLocaleString()} sats`
        )
        return swap
      } catch (err) {
        const msg = normalizeMintError(err, 'Failed to create on-chain BTC receive swap.')
        setLastError(msg)
        throw new Error(msg)
      } finally {
        setBusy(false)
      }
    },
    [commitSwaps, ensureInitializedWithKeys, recordTransaction]
  )

  const createOnchainSendSwap = useCallback(
    async (
      destinationAddress: string,
      amountSats: number,
      mintUrl?: string
    ): Promise<BoltzSwapRecord> => {
      const targetUrl = normalizeMintUrl(mintUrl ?? stateRef.current.activeMintUrl)
      if (!targetUrl) throw new Error('No mint selected.')
      const cleanSats = Math.floor(amountSats)
      if (!Number.isFinite(cleanSats) || cleanSats <= 0) {
        throw new Error('Enter a valid satoshi amount.')
      }

      setBusy(true)
      setLastError(null)
      try {
        const pairInfo = await fetchBoltzReversePairApi(boltzApiUrlRef.current)
        if (cleanSats < pairInfo.minSats || cleanSats > pairInfo.maxSats) {
          throw new Error(
            `Boltz on-chain send requires ${pairInfo.minSats.toLocaleString()}–${pairInfo.maxSats.toLocaleString()} sats.`
          )
        }

        const available = sumStoredProofs(stateRef.current.proofsByMint[targetUrl])
        if (available < cleanSats) {
          throw new Error(`Insufficient balance (${available.toLocaleString()} sats on selected mint).`)
        }

        const swap = await createBoltzReverseSwap({
          apiUrl: boltzApiUrlRef.current,
          destinationAddress,
          amountSats: cleanSats,
          mintUrl: targetUrl,
          pairInfo,
        })
        commitSwaps((prev) => [swap, ...prev].slice(0, 40))

        try {
          const meltPreview = await createCashuMeltQuote({
            mintUrl: targetUrl,
            invoice: swap.invoice,
            recipient: destinationAddress.trim(),
            memo: `Boltz on-chain BTC send (${swap.id})`,
          })

          const existingProofs = stateRef.current.proofsByMint[targetUrl] ?? []
          const meltResult = await executeCashuMeltQuote({
            preview: meltPreview,
            existingProofs,
            onCommitKeep: (keepProofs) => {
              commitState((prev) => ({
                ...prev,
                proofsByMint: {
                  ...prev.proofsByMint,
                  [targetUrl]: keepProofs,
                },
              }))
            },
          })

          if (meltResult.changeProofs.length > 0) {
            appendProofsToMint(targetUrl, meltResult.changeProofs)
          }

          const updatedSwap: BoltzSwapRecord = {
            ...swap,
            status: meltResult.paid ? 'invoice.paid' : 'invoice.pending',
            updatedAt: Date.now(),
          }
          commitSwaps((prev) => prev.map((s) => (s.id === swap.id ? updatedSwap : s)))
          recordTransaction({
            type: 'send_btc',
            status: 'pending',
            amountSats: cleanSats,
            feeSats: swap.feeSats + meltResult.feePaidSats,
            mintUrl: targetUrl,
            counterparty: destinationAddress.trim(),
            memo: `Boltz BTC swap (${swap.id})`,
            swapId: swap.id,
          })
          pushToastRef.current?.(
            'success',
            'Reverse BTC swap initiated',
            `Swap ${swap.id} · Save rescue JSON until claimed`
          )
          return updatedSwap
        } catch (meltErr) {
          const meltMsg = normalizeMintError(meltErr, 'Mint melt payment to Boltz failed.')
          commitSwaps((prev) =>
            prev.map((s) =>
              s.id === swap.id
                ? { ...s, status: 'invoice.failedToPay', error: meltMsg, updatedAt: Date.now() }
                : s
            )
          )
          throw new Error(meltMsg)
        }
      } catch (err) {
        const msg = normalizeMintError(err, 'Failed to create on-chain BTC send swap.')
        setLastError(msg)
        throw new Error(msg)
      } finally {
        setBusy(false)
      }
    },
    [appendProofsToMint, commitState, commitSwaps, recordTransaction]
  )

  const refreshBoltzSwap = useCallback(
    async (swapId: string): Promise<BoltzSwapRecord | null> => {
      const existing = boltzSwapsRef.current.find((s) => s.id === swapId)
      if (!existing) return null

      const statusRes = await fetchBoltzSwapStatus(existing.id, existing.apiUrl)
      let updated: BoltzSwapRecord = {
        ...existing,
        status: statusRes.status,
        txid: statusRes.txid ?? existing.txid,
        txConfirmed: statusRes.txConfirmed ?? existing.txConfirmed,
        zeroConfRejected: statusRes.zeroConfRejected ?? existing.zeroConfRejected,
        error: statusRes.failureReason ?? existing.error,
        updatedAt: Date.now(),
      }

      if (
        updated.direction === 'submarine' &&
        !updated.mintClaimed &&
        updated.mintQuoteId &&
        (updated.status === 'invoice.paid' ||
          updated.status === 'transaction.claimed' ||
          updated.status === 'transaction.confirmed')
      ) {
        try {
          const claimRes = await checkAndMintCashuQuote({
            quoteId: updated.mintQuoteId,
            mintUrl: updated.mintUrl,
            amountSats: updated.amountSats,
            invoice: updated.invoice,
            state: 'UNPAID',
            expiry: null,
            createdAt: updated.createdAt,
          })
          if (claimRes.claimedSats > 0 && claimRes.proofs.length > 0) {
            appendProofsToMint(updated.mintUrl, claimRes.proofs)
            updated = { ...updated, mintClaimed: true }
            commitState((prev) => ({
              ...prev,
              history: prev.history.map((tx) =>
                tx.swapId === updated.id
                  ? { ...tx, status: 'completed', txid: updated.txid }
                  : tx
              ),
            }))
            pushToastRef.current?.(
              'success',
              `On-chain BTC received: ${claimRes.claimedSats.toLocaleString()} sats`,
              `Credited to ${formatMintHost(updated.mintUrl)}`
            )
          } else if (claimRes.state === 'ISSUED') {
            updated = { ...updated, mintClaimed: true }
          }
        } catch {
          // Retry on next poll
        }
      }

      if (updated.txid && updated.txid !== existing.txid) {
        commitState((prev) => ({
          ...prev,
          history: prev.history.map((tx) =>
            tx.swapId === updated.id ? { ...tx, txid: updated.txid } : tx
          ),
        }))
      }

      commitSwaps((prev) => prev.map((s) => (s.id === updated.id ? updated : s)))
      return updated
    },
    [appendProofsToMint, commitState, commitSwaps]
  )

  // Periodically poll active Boltz swaps every 12s
  const hasActiveBoltzSwaps = useMemo(() => boltzSwaps.some(isBoltzSwapActive), [boltzSwaps])
  useEffect(() => {
    if (!hasActiveBoltzSwaps) return
    const timer = window.setInterval(() => {
      if (swapPollInFlightRef.current) return
      swapPollInFlightRef.current = true
      const activeIds = boltzSwapsRef.current.filter(isBoltzSwapActive).map((s) => s.id)
      void Promise.allSettled(activeIds.map((id) => refreshBoltzSwap(id))).finally(() => {
        swapPollInFlightRef.current = false
      })
    }, 12_000)
    return () => window.clearInterval(timer)
  }, [hasActiveBoltzSwaps, refreshBoltzSwap])

  const exportBoltzSwapRescueJson = useCallback((swapId: string): string | null => {
    const swap = boltzSwapsRef.current.find((s) => s.id === swapId)
    if (!swap) return null
    return buildBoltzSwapRescueJson(swap)
  }, [])

  const clearHistory = useCallback(() => {
    commitState((prev) => ({ ...prev, history: [] }))
  }, [commitState])

  const resetAll = useCallback(() => {
    clearCashuWalletInstanceCache()
    try {
      localStorage.removeItem(CASHU_WALLET_STORAGE_KEY)
      localStorage.removeItem(BOLTZ_SWAPS_STORAGE_KEY)
      localStorage.removeItem(BOLTZ_API_URL_STORAGE_KEY)
    } catch {
      // Ignore
    }
    const empty = createEmptyWalletState()
    stateRef.current = empty
    setWalletState(empty)

    boltzSwapsRef.current = []
    setBoltzSwaps([])

    boltzApiUrlRef.current = DEFAULT_BOLTZ_API_URL
    setBoltzApiUrlState(DEFAULT_BOLTZ_API_URL)

    setActiveQuoteSynced(null)
    setLastError(null)
    setBusy(false)
  }, [setActiveQuoteSynced])

  return useMemo<WalletEngine>(
    () => ({
      initialized: walletState.initialized,
      mnemonic: walletState.mnemonic ?? null,
      privateKeyHex: walletState.privateKeyHex ?? null,
      mints: walletState.mints,
      activeMintUrl: walletState.activeMintUrl,
      balancesByMint,
      proofCountByMint,
      totalBalanceSats,
      activeMintBalanceSats,
      history: walletState.history,
      sentTokens: walletState.sentTokens,
      activeMintQuote,
      boltzSwaps,
      boltzApiUrl,
      busy,
      lastError,
      generateDraftWalletKeys,
      createNewWallet,
      importWalletKeyOrSeed,
      restoreProofsFromSeed,
      exportWalletKeyJson,
      selectMint,
      addMint,
      removeMint,
      inspectMint,
      verifyProofs,
      decodeTokenPreview,
      receiveCashuToken,
      createCashuToken,
      checkSentTokenStatus,
      reclaimSentToken,
      createLightningReceiveQuote,
      checkAndClaimMintQuote,
      clearActiveMintQuote,
      prepareLightningPayment,
      payLightningQuote,
      payBolt11Invoice,
      setBoltzApiUrl,
      fetchBoltzSubmarinePair,
      fetchBoltzReversePair,
      createOnchainReceiveSwap,
      createOnchainSendSwap,
      refreshBoltzSwap,
      exportBoltzSwapRescueJson,
      exportBackupJson,
      importBackupJson,
      clearHistory,
      resetAll,
    }),
    [
      walletState.initialized,
      walletState.mnemonic,
      walletState.privateKeyHex,
      walletState.mints,
      walletState.activeMintUrl,
      walletState.history,
      walletState.sentTokens,
      balancesByMint,
      proofCountByMint,
      totalBalanceSats,
      activeMintBalanceSats,
      activeMintQuote,
      boltzSwaps,
      boltzApiUrl,
      busy,
      lastError,
      generateDraftWalletKeys,
      createNewWallet,
      importWalletKeyOrSeed,
      restoreProofsFromSeed,
      exportWalletKeyJson,
      selectMint,
      addMint,
      removeMint,
      inspectMint,
      verifyProofs,
      decodeTokenPreview,
      receiveCashuToken,
      createCashuToken,
      checkSentTokenStatus,
      reclaimSentToken,
      createLightningReceiveQuote,
      checkAndClaimMintQuote,
      clearActiveMintQuote,
      prepareLightningPayment,
      payLightningQuote,
      payBolt11Invoice,
      setBoltzApiUrl,
      fetchBoltzSubmarinePair,
      fetchBoltzReversePair,
      createOnchainReceiveSwap,
      createOnchainSendSwap,
      refreshBoltzSwap,
      exportBoltzSwapRescueJson,
      exportBackupJson,
      importBackupJson,
      clearHistory,
      resetAll,
    ]
  )
}
