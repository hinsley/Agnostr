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
  deriveNativeBtcWallet,
  fetchBitcoinOnchainState,
  type NativeBtcWalletKeys,
} from '../lib/bitcoinOnchain.ts'
import {
  createNativeBitcoinSend,
  nativeBitcoinSendJournalKey,
  type NativeBitcoinPendingSend,
  type NativeBitcoinSendReview,
} from '../lib/nativeBitcoinSend.ts'
import {
  BOLTZ_API_URL_STORAGE_KEY,
  BOLTZ_SWAPS_STORAGE_KEY,
  DEFAULT_BOLTZ_API_URL,
  buildBoltzSwapRescueJson,
  BOLTZ_NEW_SWAPS_PAUSED_MESSAGE,
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
  claimExternalMintQuoteProofs,
  claimP2pkCashuProofs,
  clearCashuWalletInstanceCache,
  configureCashuWalletRuntime,
  createCashuMeltQuote,
  createCashuMintQuote,
  createEmptyWalletState,
  decodeCashuTokenPreview,
  deduplicateProofs,
  derivePrivateKeyHexFromSeed,
  deriveWalletP2pkPubkeyHex,
  detectWalletImportFormat,
  generateCashuWalletKeys,
  inspectCashuMint,
  isValidBip39Mnemonic,
  loadPersistedCashuWallet,
  normalizeMintError,
  normalizeMnemonicPhrase,
  parseWalletBackupJson,
  parseWalletPrivateKeyHex,
  readStoredWalletCredentialEnvelope,
  replaceWalletCredentialsWithEnvelope,
  sameStoredWalletCredentialEnvelope,
  prepareRecoverableLightningMelt,
  reconcileLightningMelt,
  restoreCashuProofsFromMint,
  sanitizeSpentProofSecrets,
  savePersistedCashuWallet,
  sendCashuTokenProofs,
  sendP2pkCashuProofs,
  sumStoredProofs,
  verifyCashuProofsOnMint,
  type PersistedCashuWalletState,
  type PendingLightningMelt,
  type LightningMeltOutcome,
} from '../lib/cashuWallet.ts'
import {
  fetchLnurlPayInvoice,
  parseLightningPayload,
  resolveLnurlPay,
} from '../lib/zaps.ts'

import { getActiveProfileId, snapshotCurrentProfileToVault } from '../lib/profileVault.ts'
import { decryptWalletCredentials, encryptWalletCredentials } from '../lib/walletCredentialVault.ts'
import { selectWalletRestoreCredentials } from '../lib/walletRestoreIdentity.ts'

export interface UseCashuWalletOptions {
  pushToast?: (level: ToastLevel, title: string, detail?: string) => void
  onLocalWalletChanged?: () => void
}

function makeId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

export function useCashuWallet(options: UseCashuWalletOptions = {}): WalletEngine {
  const pushToastRef = useRef(options.pushToast)
  pushToastRef.current = options.pushToast

  const onLocalWalletChangedRef = useRef(options.onLocalWalletChanged)
  onLocalWalletChangedRef.current = options.onLocalWalletChanged

  const notifyPendingRef = useRef(false)
  const scheduleNotifyLocalWalletChanged = useCallback(() => {
    if (notifyPendingRef.current) return
    notifyPendingRef.current = true
    queueMicrotask(() => {
      notifyPendingRef.current = false
      onLocalWalletChangedRef.current?.()
    })
  }, [])

  const [walletState, setWalletState] = useState<PersistedCashuWalletState>(() =>
    loadPersistedCashuWallet()
  )
  const stateRef = useRef<PersistedCashuWalletState>(walletState)
  const vaultTransitionRef = useRef(false)
  const requireWalletUnlocked = useCallback(() => {
    const current = stateRef.current
    if (
      vaultTransitionRef.current ||
      (current.encryptedCredentials !== undefined && !current.mnemonic && !current.privateKeyHex) ||
      !sameStoredWalletCredentialEnvelope(
        readStoredWalletCredentialEnvelope(), current.encryptedCredentials
      )
    ) {
      throw new Error('Unlock Agwallet in this tab before continuing.')
    }
  }, [])

  const [boltzSwaps, setBoltzSwaps] = useState<BoltzSwapRecord[]>(() => loadStoredBoltzSwaps())
  const boltzSwapsRef = useRef<BoltzSwapRecord[]>(boltzSwaps)

  const [boltzApiUrl, setBoltzApiUrlState] = useState<string>(() => loadStoredBoltzApiUrl())
  const boltzApiUrlRef = useRef<string>(boltzApiUrl)

  const [activeMintQuote, setActiveMintQuote] = useState<CashuMintQuoteRecord | null>(null)
  const activeMintQuoteRef = useRef<CashuMintQuoteRecord | null>(null)

  const [busy, setBusy] = useState(false)
  const [lastError, setLastError] = useState<string | null>(null)

  const [btcBalanceConfirmedSats, setBtcBalanceConfirmedSats] = useState(0)
  const [btcBalanceUnconfirmedSats, setBtcBalanceUnconfirmedSats] = useState(0)
  const [btcUtxoCount, setBtcUtxoCount] = useState(0)
  const [btcRefreshing, setBtcRefreshing] = useState(false)
  const [btcLastUpdatedAt, setBtcLastUpdatedAt] = useState<number | null>(null)
  const [btcError, setBtcError] = useState<string | null>(null)

  const mintPollInFlightRef = useRef(false)
  const swapPollInFlightRef = useRef(false)
  const btcRefreshInFlightRef = useRef(false)

  const commitState = useCallback(
    (
      updater: (prev: PersistedCashuWalletState) => PersistedCashuWalletState,
      opts?: { fromRemoteSync?: boolean; resetSpentSecrets?: boolean; persistLightningTransition?: boolean }
    ) => {
      requireWalletUnlocked()
      const prev = stateRef.current
      let rawNext = updater(prev)
      if (rawNext === prev) return prev

      const pending = rawNext.pendingLightningMelt
      const previousPending = prev.pendingLightningMelt
      const reservedSecrets = new Set(pending?.inputs.map((proof) => proof.secret))
      if (pending) {
        // Manual/seed restores and inbound tokens must not reintroduce reserved inputs.
        const { mintUrl } = pending.transaction
        rawNext = {
          ...rawNext,
          proofsByMint: {
            ...rawNext.proofsByMint,
            [mintUrl]: (rawNext.proofsByMint[mintUrl] ?? []).filter(
              (proof) => !reservedSecrets.has(proof.secret)
            ),
          },
        }
      }

      let spentProofSecrets = sanitizeSpentProofSecrets(
        rawNext.spentProofSecrets ?? (opts?.resetSpentSecrets ? [] : (prev.spentProofSecrets ?? []))
      )

      if (!opts?.resetSpentSecrets && !opts?.fromRemoteSync) {
        const nextSecrets = new Set<string>()
        for (const list of Object.values(rawNext.proofsByMint)) {
          for (const p of list) {
            if (p?.secret) nextSecrets.add(p.secret)
          }
        }
        const removedSecrets: string[] = []
        for (const list of Object.values(prev.proofsByMint)) {
          for (const p of list) {
            if (p?.secret && !nextSecrets.has(p.secret) && !reservedSecrets.has(p.secret)) {
              removedSecrets.push(p.secret)
            }
          }
        }
        if (removedSecrets.length > 0) {
          spentProofSecrets = sanitizeSpentProofSecrets([
            ...spentProofSecrets,
            ...removedSecrets,
          ])
        }
      }

      const updatedAt = opts?.fromRemoteSync
        ? (rawNext.updatedAt ?? prev.updatedAt ?? Date.now())
        : Math.max(Date.now(), (prev.updatedAt ?? 0) + 1)

      const next: PersistedCashuWalletState = {
        ...rawNext,
        updatedAt,
        spentProofSecrets,
        lastLightningMeltId: pending?.transaction.id ?? prev.lastLightningMeltId,
      }

      if (opts?.persistLightningTransition) {
        const saved = savePersistedCashuWallet(next, {
          expectedPendingId: previousPending?.transaction.id ?? null,
          expectedUpdatedAt: prev.updatedAt,
        })
        if (!saved) {
          throw new Error('Could not safely save the Lightning payment. Close other wallet tabs or free browser storage.')
        }
      } else if (!savePersistedCashuWallet(next)) {
        throw new Error('Could not save Agwallet. Reload this tab or check browser storage.')
      }
      stateRef.current = next
      setWalletState(next)

      if (!opts?.fromRemoteSync && next.initialized) {
        scheduleNotifyLocalWalletChanged()
      }
      return next
    },
    [requireWalletUnlocked, scheduleNotifyLocalWalletChanged]
  )

  const syncRuntimeSeed = useCallback(
    (state: PersistedCashuWalletState) => {
      configureCashuWalletRuntime({
        mnemonic: state.mnemonic,
        privateKeyHex: state.privateKeyHex,
        counters: state.keysetCounters,
        encryptedCredentials: state.encryptedCredentials,
        onCountersChanged: (snapshot) => {
          const cur = stateRef.current
          const next: PersistedCashuWalletState = {
            ...cur,
            keysetCounters: snapshot,
          }
          if (!savePersistedCashuWallet(next)) {
            throw new Error('Could not save the wallet counter in this tab.')
          }
          stateRef.current = next
        },
      })
    },
    []
  )

  // Synchronize runtime NUT-13 seed & counter store with persisted wallet credentials
  useEffect(() => {
    syncRuntimeSeed(walletState)
  }, [syncRuntimeSeed, walletState])

  const commitSwaps = useCallback(
    (
      updater: (prev: BoltzSwapRecord[]) => BoltzSwapRecord[],
      opts?: { fromRemoteSync?: boolean }
    ) => {
      const prev = boltzSwapsRef.current
      const next = updater(prev)
      if (next === prev) return prev
      boltzSwapsRef.current = next
      saveStoredBoltzSwaps(next)
      setBoltzSwaps(next)

      if (!opts?.fromRemoteSync && stateRef.current.initialized) {
        const cur = stateRef.current
        const bumped: PersistedCashuWalletState = {
          ...cur,
          updatedAt: Math.max(Date.now(), (cur.updatedAt ?? 0) + 1),
        }
        stateRef.current = bumped
        savePersistedCashuWallet(bumped)
        scheduleNotifyLocalWalletChanged()
      }
      return next
    },
    [scheduleNotifyLocalWalletChanged]
  )

  const setActiveQuoteSynced = useCallback((quote: CashuMintQuoteRecord | null) => {
    activeMintQuoteRef.current = quote
    setActiveMintQuote(quote)
  }, [])

  const ensureInitializedWithKeys = useCallback(() => {
    requireWalletUnlocked()
    const cur = stateRef.current
    if (cur.initialized && cur.privateKeyHex) return
    const derivedFromMnemonic =
      !cur.privateKeyHex && cur.mnemonic && isValidBip39Mnemonic(cur.mnemonic)
        ? derivePrivateKeyHexFromSeed(mnemonicToSeedSync(normalizeMnemonicPhrase(cur.mnemonic)))
        : null
    const fresh = !cur.mnemonic && !cur.privateKeyHex ? generateCashuWalletKeys() : null
    const next = commitState((prev) => ({
      ...prev,
      initialized: true,
      mnemonic: prev.mnemonic ?? fresh?.mnemonic,
      privateKeyHex: prev.privateKeyHex ?? derivedFromMnemonic ?? fresh?.privateKeyHex,
    }))
    syncRuntimeSeed(next)
  }, [commitState, requireWalletUnlocked, syncRuntimeSeed])

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
      commitState((prev) => {
        if (prev.history.some((h) => h.id === entry.id)) return prev
        return {
          ...prev,
          history: [entry, ...prev.history].slice(0, 250),
        }
      })
      return entry
    },
    [commitState]
  )

  const nutzapP2pkPubkeyHex = useMemo(
    () => deriveWalletP2pkPubkeyHex(walletState.privateKeyHex),
    [walletState.privateKeyHex]
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
      requireWalletUnlocked()
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

      const existing = stateRef.current
      if (existing.pendingLightningMelt) {
        throw new Error('Resolve the pending Lightning payment before creating a wallet.')
      }
      const credentials = selectWalletRestoreCredentials(existing, draft)
      if (credentials === existing) return

      clearCashuWalletInstanceCache()
      setActiveQuoteSynced(null)
      setLastError(null)

      const requestedMint = opts?.mintUrl ? normalizeMintUrl(opts.mintUrl) : null

      const next = commitState(
        (prev) => {
          const mints = prev.mints.length > 0 ? prev.mints : createEmptyWalletState().mints
          const activeMintUrl =
            requestedMint && mints.some((m) => m.url === requestedMint)
              ? requestedMint
              : prev.activeMintUrl
          return {
            ...prev,
            ...credentials,
            initialized: true,
            activeMintUrl,
            mints,
          }
        }
      )

      syncRuntimeSeed(next)
      pushToastRef.current?.('success', 'Agwallet created', formatMintHost(next.activeMintUrl))
    },
    [commitState, requireWalletUnlocked, setActiveQuoteSynced, syncRuntimeSeed]
  )

  const restoreProofsFromSeed = useCallback(
    async (mintUrl?: string): Promise<{ restoredSats: number; restoredProofs: number }> => {
      const restoring = stateRef.current
      if (restoring.pendingLightningMelt) {
        throw new Error('Resolve the pending Lightning payment before restoring Agwallet.')
      }
      const targetUrl = normalizeMintUrl(mintUrl ?? restoring.activeMintUrl)
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
          if (
            !prev.initialized ||
            prev.mnemonic !== restoring.mnemonic ||
            prev.privateKeyHex !== restoring.privateKeyHex ||
            prev.pendingLightningMelt
          ) {
            return prev
          }
          const existing = prev.proofsByMint[targetUrl] ?? []
          const existingSecrets = new Set([
            ...existing.map((p) => p.secret),
            ...(prev.spentProofSecrets ?? []),
          ])
          const newlyFound = res.unspentProofs.filter((p) => !existingSecrets.has(p.secret))
          const counters = { ...prev.keysetCounters }
          for (const [id, value] of Object.entries(res.counters)) {
            counters[id] = Math.max(counters[id] ?? 0, value)
          }
          addedCount = newlyFound.length
          addedSats = sumStoredProofs(newlyFound)
          return {
            ...prev,
            keysetCounters: counters,
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
      const hasAccountCredentials = Boolean(backup.mnemonic || backup.privateKeyHex)
      let importedMints = 0
      let importedProofs = 0
      let totalSats = 0

      const nextState = commitState((prev) => {
        if (prev.pendingLightningMelt) {
          throw new Error('Resolve the pending Lightning payment before restoring Agwallet.')
        }
        const { mnemonic: adoptedMnemonic, privateKeyHex: adoptedPrivKey } =
          selectWalletRestoreCredentials(prev, backup)
        const mintMap = new Map<string, CashuMintAccount>()
        for (const m of prev.mints) mintMap.set(m.url, m)
        for (const m of backup.mints) {
          if (!mintMap.has(m.url)) {
            mintMap.set(m.url, m)
            importedMints += 1
          }
        }

        const mergedSpent = sanitizeSpentProofSecrets([
          ...(prev.spentProofSecrets ?? []),
          ...(hasAccountCredentials ? (backup.spentProofSecrets ?? []) : []),
        ])
        const spent = new Set(mergedSpent)
        const nextProofsByMint: Record<string, StoredCashuProof[]> = {}
        for (const [url, list] of Object.entries(prev.proofsByMint)) {
          nextProofsByMint[url] = list.filter((proof) => !spent.has(proof.secret))
        }
        for (const [url, incomingProofs] of Object.entries(backup.proofsByMint)) {
          const before = nextProofsByMint[url] ?? []
          const beforeSecrets = new Set(before.map((p) => p.secret))
          const newlyAdded = incomingProofs.filter(
            (p) => !beforeSecrets.has(p.secret) && !spent.has(p.secret)
          )
          importedProofs += newlyAdded.length
          nextProofsByMint[url] = deduplicateProofs([...before, ...newlyAdded])
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
          ...(hasAccountCredentials ? backup.history : []).filter((h) => h && h.id && !historyIds.has(h.id)),
        ]
          .sort((a, b) => b.createdAt - a.createdAt)
          .slice(0, 250)

        const sentIds = new Set(prev.sentTokens.map((s) => s.id))
        const mergedSent = [
          ...prev.sentTokens,
          ...(hasAccountCredentials ? backup.sentTokens : []).filter((s) => s && s.id && !sentIds.has(s.id)),
        ]
          .sort((a, b) => b.createdAt - a.createdAt)
          .slice(0, 100)

        const nextCounters: Record<string, number> = { ...prev.keysetCounters }
        if (hasAccountCredentials && backup.keysetCounters) {
          for (const [ksId, c] of Object.entries(backup.keysetCounters)) {
            nextCounters[ksId] = Math.max(nextCounters[ksId] ?? 0, c)
          }
        }


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
          spentProofSecrets: mergedSpent,
          history: mergedHistory,
          sentTokens: mergedSent,
        }
      })

      syncRuntimeSeed(nextState)

      if (hasAccountCredentials && backup.boltzSwaps.length > 0) {
        commitSwaps((prev) => {
          const ids = new Set(prev.map((s) => s.id))
          return [...prev, ...backup.boltzSwaps.filter((s) => s && s.id && !ids.has(s.id))]
            .sort((a, b) => b.createdAt - a.createdAt)
            .slice(0, 40)
        })
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
        const current = stateRef.current
        if (current.pendingLightningMelt) {
          throw new Error('Resolve the pending Lightning payment before restoring Agwallet.')
        }
        const proposed =
          detected.mode === 'mnemonic'
            ? { mnemonic: normalizeMnemonicPhrase(rawInput) }
            : { privateKeyHex: parseWalletPrivateKeyHex(rawInput) ?? undefined }
        if (!proposed.mnemonic && !proposed.privateKeyHex) {
          throw new Error('Invalid private key.')
        }
        const credentials = selectWalletRestoreCredentials(current, proposed)
        if (credentials !== current) {
          clearCashuWalletInstanceCache()
          setActiveQuoteSynced(null)
          const targetMint =
            (opts?.mintUrl && normalizeMintUrl(opts.mintUrl)) || current.activeMintUrl
          const next = commitState((prev) => ({
            ...prev,
            ...credentials,
            initialized: true,
            activeMintUrl: prev.mints.some((m) => m.url === targetMint)
              ? targetMint
              : prev.activeMintUrl,
          }))
          syncRuntimeSeed(next)
        }

        let restoredSats = 0
        let restoredProofs = 0
        if (opts?.scanMints !== false) {
          try {
            const restoring = stateRef.current
            const mintUrl = restoring.activeMintUrl
            const scan = await restoreCashuProofsFromMint(mintUrl)
            commitState((prev) => {
              if (
                !prev.initialized ||
                prev.mnemonic !== restoring.mnemonic ||
                prev.privateKeyHex !== restoring.privateKeyHex ||
                prev.pendingLightningMelt
              ) {
                return prev
              }
              const existing = prev.proofsByMint[mintUrl] ?? []
              const present = new Set(existing.map((proof) => proof.secret))
              const spent = new Set(prev.spentProofSecrets ?? [])
              const extra = scan.unspentProofs.filter(
                (proof) => !present.has(proof.secret) && !spent.has(proof.secret)
              )
              restoredSats = sumStoredProofs(extra)
              restoredProofs = extra.length
              const counters = { ...prev.keysetCounters }
              for (const [id, value] of Object.entries(scan.counters)) {
                counters[id] = Math.max(counters[id] ?? 0, value)
              }
              return {
                ...prev,
                keysetCounters: counters,
                proofsByMint: {
                  ...prev.proofsByMint,
                  [mintUrl]: deduplicateProofs([...existing, ...extra]),
                },
              }
            })
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
    requireWalletUnlocked()
    const cur = stateRef.current
    const spentProofSecrets = sanitizeSpentProofSecrets(cur.spentProofSecrets)
    const payload: WalletBackupPayload = {
      version: 1,
      exportedAt: Date.now(),
      ...(cur.updatedAt ? { updatedAt: cur.updatedAt } : {}),
      activeMintUrl: cur.activeMintUrl,
      ...(cur.mnemonic ? { mnemonic: cur.mnemonic } : {}),
      ...(cur.privateKeyHex ? { privateKeyHex: cur.privateKeyHex } : {}),
      keysetCounters: cur.keysetCounters,
      mints: cur.mints,
      proofsByMint: cur.proofsByMint,
      ...(spentProofSecrets.length > 0 ? { spentProofSecrets } : {}),
      history: cur.history,
      sentTokens: cur.sentTokens,
      boltzSwaps: boltzSwapsRef.current,
      boltzApiUrl: boltzApiUrlRef.current,
    }
    return JSON.stringify(payload, null, 2)
  }, [requireWalletUnlocked])

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
        if (prev.activeMintUrl === norm || !prev.mints.some((m) => m.url === norm)) return prev
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
     NIP-61 P2PK Nutzaps & External Mint Quote Sweeping (npub.cash v2)
     ------------------------------------------------------------------------ */

  const sendP2pkNutzapProofs = useCallback(
    async (params: {
      amountSats: number
      recipientP2pkPubkey: string
      mintUrl?: string
      counterparty?: string
      memo?: string
    }): Promise<{
      mintUrl: string
      proofs: StoredCashuProof[]
      amountSats: number
      feeSats: number
    }> => {
      const targetMintUrl = normalizeMintUrl(params.mintUrl ?? stateRef.current.activeMintUrl)
      if (!targetMintUrl) throw new Error('No mint selected.')
      setBusy(true)
      setLastError(null)
      try {
        const availableProofs = stateRef.current.proofsByMint[targetMintUrl] ?? []
        const res = await sendP2pkCashuProofs(
          targetMintUrl,
          params.amountSats,
          availableProofs,
          params.recipientP2pkPubkey
        )
        commitState((prev) => ({
          ...prev,
          proofsByMint: {
            ...prev.proofsByMint,
            [targetMintUrl]: res.keepProofs,
          },
        }))
        recordTransaction({
          type: 'nutzap_out',
          status: 'completed',
          amountSats: res.sentSats,
          feeSats: res.feeSats > 0 ? res.feeSats : undefined,
          mintUrl: targetMintUrl,
          counterparty: params.counterparty,
          memo: params.memo?.trim() || undefined,
        })
        return {
          mintUrl: targetMintUrl,
          proofs: res.sendProofs,
          amountSats: res.sentSats,
          feeSats: res.feeSats,
        }
      } catch (err) {
        const msg = normalizeMintError(err, 'Failed to prepare Nutzap proofs.')
        setLastError(msg)
        throw new Error(msg)
      } finally {
        setBusy(false)
      }
    },
    [commitState, recordTransaction]
  )

  const claimP2pkNutzapProofs = useCallback(
    async (params: {
      mintUrl: string
      proofs: StoredCashuProof[]
      candidatePrivkeysHex: string[]
      senderPubkey?: string
      memo?: string
      nutzapEventId?: string
    }): Promise<{
      claimedSats: number
      mintUrl: string
    }> => {
      const normMint = normalizeMintUrl(params.mintUrl)
      if (!normMint) throw new Error('Invalid mint URL.')
      ensureInitializedWithKeys()

      const allCandidateKeys = Array.from(
        new Set(
          [stateRef.current.privateKeyHex, ...params.candidatePrivkeysHex].filter(
            (k): k is string => typeof k === 'string' && k.trim().length > 0
          )
        )
      )

      const freshProofs = await claimP2pkCashuProofs(normMint, params.proofs, allCandidateKeys)
      const claimedSats = sumStoredProofs(freshProofs)
      if (freshProofs.length > 0 && claimedSats > 0) {
        appendProofsToMint(normMint, freshProofs)
        recordTransaction({
          id: params.nutzapEventId ? `nz-${params.nutzapEventId.slice(0, 16)}` : undefined,
          type: 'nutzap_in',
          status: 'completed',
          amountSats: claimedSats,
          mintUrl: normMint,
          counterparty: params.senderPubkey,
          memo: params.memo?.trim() || 'NIP-61 Nutzap',
        })
      }
      return { claimedSats, mintUrl: normMint }
    },
    [appendProofsToMint, ensureInitializedWithKeys, recordTransaction]
  )

  const claimExternalMintQuote = useCallback(
    async (params: {
      mintUrl: string
      quoteId: string
      amountSats: number
      privkeyHex?: string
      counterparty?: string
      memo?: string
      txType?: 'zap_in' | 'receive_ln'
    }): Promise<{
      state: CashuMintQuoteState
      claimedSats: number
      mintUrl: string
    }> => {
      const normMint = normalizeMintUrl(params.mintUrl)
      if (!normMint) throw new Error('Invalid mint URL.')
      ensureInitializedWithKeys()

      const res = await claimExternalMintQuoteProofs(
        normMint,
        params.quoteId,
        params.amountSats,
        params.privkeyHex
      )
      if (res.proofs.length > 0 && res.claimedSats > 0) {
        appendProofsToMint(normMint, res.proofs)
        recordTransaction({
          id: `ext-${params.quoteId.slice(0, 20)}`,
          type: params.txType ?? 'zap_in',
          status: 'completed',
          amountSats: res.claimedSats,
          mintUrl: normMint,
          counterparty: params.counterparty,
          memo: params.memo?.trim() || 'Lightning Zap (npub.cash)',
        })
      }
      return {
        state: res.state,
        claimedSats: res.claimedSats,
        mintUrl: res.mintUrl,
      }
    },
    [appendProofsToMint, ensureInitializedWithKeys, recordTransaction]
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

  const applyLightningOutcome = useCallback(
    (pending: PendingLightningMelt, outcome: LightningMeltOutcome) => {
      if (outcome.state === 'pending') return
      commitState((prev) => {
        if (prev.pendingLightningMelt?.transaction.id !== pending.transaction.id) return prev
        const mintUrl = pending.transaction.mintUrl
        const credited = outcome.state === 'paid' ? outcome.change : outcome.recoveredInputs
        const creditedSecrets = new Set(credited.map((proof) => proof.secret))
        const spent = outcome.state === 'paid'
          ? [...(prev.spentProofSecrets ?? []), ...pending.inputs.map((proof) => proof.secret)]
          : (prev.spentProofSecrets ?? []).filter((secret) => !creditedSecrets.has(secret))
        const finalTransaction: WalletTransaction = {
          ...pending.transaction,
          status: outcome.state === 'paid' ? 'completed' : 'expired',
          ...(outcome.state === 'paid' ? { feeSats: outcome.feePaidSats } : {}),
        }
        return {
          ...prev,
          pendingLightningMelt: undefined,
          spentProofSecrets: sanitizeSpentProofSecrets(spent),
          proofsByMint: {
            ...prev.proofsByMint,
            [mintUrl]: deduplicateProofs([...(prev.proofsByMint[mintUrl] ?? []), ...credited]),
          },
          history: [finalTransaction, ...prev.history.filter((tx) => tx.id !== finalTransaction.id)].slice(0, 250),
        }
      }, { persistLightningTransition: true })
      pushToastRef.current?.(
        outcome.state === 'paid' ? 'success' : 'info',
        outcome.state === 'paid'
          ? `Paid ${pending.transaction.amountSats.toLocaleString()} sats`
          : 'Lightning quote expired; the mint confirmed your inputs were restored',
        outcome.state === 'paid' && outcome.feePaidSats > 0
          ? `Total fees: ${outcome.feePaidSats} sats`
          : undefined
      )
    },
    [commitState]
  )

  useEffect(() => {
    if (!walletState.pendingLightningMelt || !navigator.locks) return
    const poll = () => {
      void navigator.locks.request('agnostr:agwallet:lightning-melt', { ifAvailable: true }, async (lock) => {
        const pending = stateRef.current.pendingLightningMelt
        if (!lock || !pending) return
        const disk = loadPersistedCashuWallet()
        if (disk.pendingLightningMelt?.transaction.id !== pending.transaction.id) return
        const outcome = await reconcileLightningMelt(pending)
        applyLightningOutcome(pending, outcome)
      }).catch(() => {
        // Keep the paid/pending journal on any ambiguous mint or storage response.
      })
    }
    const timer = window.setInterval(poll, 5000)
    poll()
    return () => window.clearInterval(timer)
  }, [walletState.pendingLightningMelt, applyLightningOutcome])

  useEffect(() => {
    const observeMeltTransition = (event: StorageEvent) => {
      if (event.key !== CASHU_WALLET_STORAGE_KEY) return
      const disk = loadPersistedCashuWallet()
      if (disk.pendingLightningMelt?.transaction.id === stateRef.current.pendingLightningMelt?.transaction.id &&
          disk.lastLightningMeltId === stateRef.current.lastLightningMeltId) return
      if (disk.mnemonic !== stateRef.current.mnemonic || disk.privateKeyHex !== stateRef.current.privateKeyHex) return
      stateRef.current = disk
      setWalletState(disk)
    }
    window.addEventListener('storage', observeMeltTransition)
    return () => window.removeEventListener('storage', observeMeltTransition)
  }, [])

  const payLightningQuote = useCallback(
    async (
      preview: CashuMeltQuotePreview,
      meta?: { counterparty?: string; memo?: string; txType?: 'send_ln' | 'zap_out' }
    ) => {
      if (!navigator.locks) throw new Error('Lightning sending requires a browser that can lock the wallet across tabs.')
      setBusy(true)
      setLastError(null)
      try {
        return await navigator.locks.request('agnostr:agwallet:lightning-melt', async () => {
          const base = stateRef.current
          if (base.pendingLightningMelt) throw new Error('A Lightning payment is still pending. Check Agwallet activity before sending again.')
          if (base.history.some((tx) => (
            (tx.type === 'send_ln' || tx.type === 'zap_out') &&
            (tx.status === 'pending' || tx.status === 'completed') &&
            tx.invoice?.toLowerCase() === preview.invoice.toLowerCase()
          ))) throw new Error('This invoice already has a pending or completed payment in Agwallet.')
          const transaction: WalletTransaction = {
            id: makeId('lnmelt'),
            createdAt: Date.now(),
            type: meta?.txType ?? 'send_ln',
            status: 'pending',
            amountSats: preview.amountSats,
            mintUrl: preview.mintUrl,
            counterparty: meta?.counterparty ?? preview.recipient,
            memo: meta?.memo ?? preview.memo,
            invoice: preview.invoice,
          }
          const { pending, submit } = await prepareRecoverableLightningMelt(
            preview, base.proofsByMint[preview.mintUrl] ?? [], transaction
          )
          commitState((prev) => {
            const currentProofs = new Map((prev.proofsByMint[preview.mintUrl] ?? []).map((proof) => [proof.secret, proof]))
            if (prev.pendingLightningMelt || prev.mnemonic !== base.mnemonic ||
                prev.privateKeyHex !== base.privateKeyHex ||
                !pending.inputs.every((proof) => {
                  const current = currentProofs.get(proof.secret)
                  return current?.C === proof.C && current.id === proof.id && current.amount === proof.amount
                })) throw new Error('The wallet changed. Review a fresh Lightning quote.')
            return { ...prev, pendingLightningMelt: pending, history: [transaction, ...prev.history].slice(0, 250) }
          }, { persistLightningTransition: true })

          try {
            const outcome = await submit()
            if (outcome.state === 'paid') {
              applyLightningOutcome(pending, outcome)
              return { paid: true, feePaidSats: outcome.feePaidSats, preimage: outcome.preimage }
            }
          } catch {
            // A lost response is not a failed payment. The same quote and all
            // inputs and change data are on disk; polling is read-only.
          }
          pushToastRef.current?.('info', 'Lightning payment pending', 'Check Agwallet activity before sending again.')
          return { paid: false, feePaidSats: 0, preimage: null }
        })
      } catch (err) {
        const msg = normalizeMintError(err, 'Could not submit Lightning payment.')
        setLastError(msg)
        throw new Error(msg)
      } finally {
        setBusy(false)
      }
    },
    [applyLightningOutcome, commitState]
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

  const setBoltzApiUrl = useCallback(
    (url: string) => {
      const prev = boltzApiUrlRef.current
      const saved = saveStoredBoltzApiUrl(url)
      boltzApiUrlRef.current = saved
      setBoltzApiUrlState(saved)
      if (saved !== prev && stateRef.current.initialized) {
        const cur = stateRef.current
        const bumped: PersistedCashuWalletState = {
          ...cur,
          updatedAt: Math.max(Date.now(), (cur.updatedAt ?? 0) + 1),
        }
        stateRef.current = bumped
        savePersistedCashuWallet(bumped)
        scheduleNotifyLocalWalletChanged()
      }
    },
    [scheduleNotifyLocalWalletChanged]
  )

  const fetchBoltzSubmarinePair = useCallback(async (): Promise<BoltzSubmarinePairInfo> => {
    return await fetchBoltzSubmarinePairApi(boltzApiUrlRef.current)
  }, [])

  const fetchBoltzReversePair = useCallback(async (): Promise<BoltzReversePairInfo> => {
    return await fetchBoltzReversePairApi(boltzApiUrlRef.current)
  }, [])

  // Keep the recovery surface available without allowing new deposits or melts
  // against an unverified swap that we cannot locally claim or refund.
  const createOnchainReceiveSwap = useCallback(async (): Promise<BoltzSwapRecord> => {
    throw new Error(BOLTZ_NEW_SWAPS_PAUSED_MESSAGE)
  }, [])

  const createOnchainSendSwap = useCallback(async (): Promise<BoltzSwapRecord> => {
    throw new Error(BOLTZ_NEW_SWAPS_PAUSED_MESSAGE)
  }, [])

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

  /* ------------------------------------------------------------------------
     Native Self-Custodial Core Blockchain Bitcoin (BIP-84 P2WPKH `bc1q...`)
     ------------------------------------------------------------------------ */

  const nativeBtc = useMemo<NativeBtcWalletKeys | null>(
    () =>
      walletState.initialized
        ? deriveNativeBtcWallet({
            mnemonic: walletState.mnemonic,
            privateKeyHex: walletState.privateKeyHex,
          })
        : null,
    [walletState.initialized, walletState.mnemonic, walletState.privateKeyHex]
  )
  const nativeBtcRef = useRef<NativeBtcWalletKeys | null>(nativeBtc)
  nativeBtcRef.current = nativeBtc

  const btcAddress = nativeBtc?.address ?? null
  const btcDerivationPath = nativeBtc?.derivationPath ?? null
  const btcAddressRef = useRef<string | null>(btcAddress)
  btcAddressRef.current = btcAddress

  const btcBalanceTotalSats = btcBalanceConfirmedSats + btcBalanceUnconfirmedSats

  const refreshOnchainBtcBalance = useCallback(async (): Promise<void> => {
    const targetAddr = btcAddressRef.current
    if (!targetAddr) {
      setBtcBalanceConfirmedSats(0)
      setBtcBalanceUnconfirmedSats(0)
      setBtcUtxoCount(0)
      setBtcLastUpdatedAt(null)
      setBtcError(null)
      setBtcRefreshing(false)
      return
    }
    if (btcRefreshInFlightRef.current) return
    btcRefreshInFlightRef.current = true
    setBtcRefreshing(true)
    setBtcError(null)
    try {
      const state = await fetchBitcoinOnchainState(targetAddr)
      if (btcAddressRef.current !== targetAddr) return
      setBtcBalanceConfirmedSats(state.confirmedSats)
      setBtcBalanceUnconfirmedSats(state.unconfirmedSats)
      setBtcUtxoCount(state.utxos.length)
      setBtcLastUpdatedAt(state.fetchedAt)
      setBtcError(null)
    } catch (err) {
      if (btcAddressRef.current !== targetAddr) return
      setBtcError(
        err instanceof Error ? err.message : 'Unable to reach Bitcoin blockchain explorer.'
      )
    } finally {
      btcRefreshInFlightRef.current = false
      if (btcAddressRef.current === targetAddr) {
        setBtcRefreshing(false)
      }
    }
  }, [])

  // Passively refresh native on-chain balance once whenever wallet initializes or btcAddress changes
  useEffect(() => {
    btcRefreshInFlightRef.current = false
    setBtcBalanceConfirmedSats(0)
    setBtcBalanceUnconfirmedSats(0)
    setBtcUtxoCount(0)
    setBtcLastUpdatedAt(null)
    setBtcError(null)
    setBtcRefreshing(false)
    if (!btcAddress) return
    void refreshOnchainBtcBalance()
  }, [btcAddress, refreshOnchainBtcBalance])

  const bitcoinSender = useMemo(
    () => createNativeBitcoinSend(() => {
      requireWalletUnlocked()
      return nativeBtcRef.current
    }),
    [requireWalletUnlocked]
  )
  const [btcPendingSend, setBtcPendingSend] = useState<NativeBitcoinPendingSend | null>(null)
  const updateBtcPendingSend = useCallback(() => {
    const address = btcAddressRef.current
    try {
      setBtcPendingSend(address ? bitcoinSender.pending(address) : null)
    } catch (error) {
      setBtcPendingSend(null)
      setBtcError(error instanceof Error ? error.message : 'Could not read Bitcoin send recovery data.')
    }
  }, [bitcoinSender])

  useEffect(() => {
    updateBtcPendingSend()
    if (!btcAddress) return
    const storageChanged = (event: StorageEvent) => {
      if (event.key === null || event.key === nativeBitcoinSendJournalKey(btcAddress)) updateBtcPendingSend()
    }
    window.addEventListener('storage', storageChanged)
    return () => window.removeEventListener('storage', storageChanged)
  }, [btcAddress, updateBtcPendingSend])

  const prepareNativeOnchainBtc = useCallback(
    (toAddress: string, amountSats: number, feeRateSatVb: number) =>
      bitcoinSender.prepare(toAddress, amountSats, feeRateSatVb),
    [bitcoinSender]
  )

  const finishNativeOnchainBtc = useCallback(
    async (operation: () => Promise<NativeBitcoinPendingSend>) => {
      setBusy(true)
      setLastError(null)
      setBtcError(null)
      try {
        const sent = await operation()
        if (btcAddressRef.current === sent.fromAddress) {
          recordTransaction({
            id: `bitcoin:onchain:${sent.txid}`,
            type: 'send_btc',
            status: 'pending',
            amountSats: sent.amountSats,
            feeSats: sent.feeSats,
            mintUrl: 'bitcoin:onchain',
            counterparty: sent.toAddress,
            memo: 'Core Bitcoin (BIP-84) send',
            txid: sent.txid,
          })
          void refreshOnchainBtcBalance()
        }
        return sent
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Could not send Bitcoin transaction.'
        setLastError(msg)
        setBtcError(msg)
        throw new Error(msg)
      } finally {
        updateBtcPendingSend()
        setBusy(false)
      }
    },
    [recordTransaction, refreshOnchainBtcBalance, updateBtcPendingSend]
  )

  const sendNativeOnchainBtc = useCallback(
    (review: NativeBitcoinSendReview) => finishNativeOnchainBtc(() => bitcoinSender.confirm(review)),
    [bitcoinSender, finishNativeOnchainBtc]
  )

  const retryNativeOnchainBtc = useCallback(
    (txid: string) => finishNativeOnchainBtc(() => bitcoinSender.retry(txid)),
    [bitcoinSender, finishNativeOnchainBtc]
  )

  const dismissNativeOnchainBtc = useCallback(
    async (txid: string) => {
      await retryNativeOnchainBtc(txid)
      await bitcoinSender.dismiss(txid)
      updateBtcPendingSend()
    },
    [bitcoinSender, retryNativeOnchainBtc, updateBtcPendingSend]
  )

  const publishLockedState = useCallback((state: PersistedCashuWalletState) => {
    const closed = { ...state }
    delete closed.mnemonic
    delete closed.privateKeyHex
    nativeBtcRef.current?.privateKey.fill(0)
    nativeBtcRef.current = null
    clearCashuWalletInstanceCache()
    setActiveQuoteSynced(null)
    stateRef.current = closed
    syncRuntimeSeed(closed)
    setWalletState(closed)
  }, [setActiveQuoteSynced, syncRuntimeSeed])

  const protectWalletCredentials = useCallback(async (passphrase: string, backupConfirmed: boolean) => {
    if (!backupConfirmed) throw new Error('Save and verify an offline wallet backup first.')
    if (busy || vaultTransitionRef.current) throw new Error('Wait for the current wallet action to finish.')
    const current = stateRef.current
    if (current.pendingLightningMelt) {
      throw new Error('Resolve the pending Lightning payment before securing the wallet.')
    }
    requireWalletUnlocked()
    if (current.encryptedCredentials !== undefined) throw new Error('Wallet credentials are already encrypted.')
    const original = localStorage.getItem(CASHU_WALLET_STORAGE_KEY)
    if (!original) throw new Error('No saved wallet credentials to encrypt.')
    const disk = loadPersistedCashuWallet()
    if (
      disk.mnemonic !== current.mnemonic ||
      disk.privateKeyHex !== current.privateKeyHex ||
      !deriveNativeBtcWallet(disk)
    ) {
      throw new Error('The saved wallet changed. Reload before securing it.')
    }

    const profile = getActiveProfileId()
    vaultTransitionRef.current = true
    try {
      const envelope = await encryptWalletCredentials(disk, passphrase)
      const check = await decryptWalletCredentials(envelope, passphrase)
      if (check.mnemonic !== current.mnemonic || check.privateKeyHex !== current.privateKeyHex) {
        throw new Error('Wallet encryption did not pass its recovery check. No keys were changed.')
      }
      if (
        profile !== getActiveProfileId() ||
        stateRef.current !== current ||
        !replaceWalletCredentialsWithEnvelope(original, envelope)
      ) {
        throw new Error('Could not replace the saved credentials safely. Check browser storage and close other wallet tabs before retrying.')
      }

      publishLockedState({ ...disk, encryptedCredentials: envelope })
      const saved = localStorage.getItem(CASHU_WALLET_STORAGE_KEY)
      const snapshotVerified = Boolean(
        profile && saved && await snapshotCurrentProfileToVault(profile, [CASHU_WALLET_STORAGE_KEY, saved])
      )
      return { snapshotVerified }
    } finally {
      vaultTransitionRef.current = false
    }
  }, [busy, publishLockedState, requireWalletUnlocked])

  const unlockWalletCredentials = useCallback(async (passphrase: string) => {
    const current = stateRef.current
    const envelope = current.encryptedCredentials
    if (envelope === undefined || current.mnemonic || current.privateKeyHex) return
    if (vaultTransitionRef.current) throw new Error('Wait for the current wallet action to finish.')
    const profile = getActiveProfileId()
    vaultTransitionRef.current = true
    try {
      const credentials = await decryptWalletCredentials(envelope, passphrase)
      if (
        profile !== getActiveProfileId() ||
        stateRef.current !== current ||
        !sameStoredWalletCredentialEnvelope(readStoredWalletCredentialEnvelope(), envelope)
      ) {
        throw new Error('The saved wallet changed. Reload before unlocking.')
      }
      if (!deriveNativeBtcWallet(credentials)) throw new Error('Encrypted wallet credentials are invalid.')
      const next = { ...loadPersistedCashuWallet(), ...credentials }
      stateRef.current = next
      syncRuntimeSeed(next)
      setWalletState(next)
    } finally {
      vaultTransitionRef.current = false
    }
  }, [syncRuntimeSeed])

  const lockWalletCredentials = useCallback(() => {
    const current = stateRef.current
    if (current.encryptedCredentials === undefined) return
    if (busy || vaultTransitionRef.current || current.pendingLightningMelt) {
      throw new Error('Finish the pending wallet activity before locking.')
    }
    publishLockedState(current)
  }, [busy, publishLockedState])

  useEffect(() => {
    const checkRemoteVault = (event: StorageEvent) => {
      if (event.key !== CASHU_WALLET_STORAGE_KEY && event.key !== null) return
      try {
        const current = stateRef.current
        const diskEnvelope = readStoredWalletCredentialEnvelope()
        if (!sameStoredWalletCredentialEnvelope(diskEnvelope, current.encryptedCredentials)) {
          if (diskEnvelope !== undefined) publishLockedState(loadPersistedCashuWallet())
          else if (current.encryptedCredentials !== undefined) publishLockedState(current)
        }
      } catch {
        if (stateRef.current.encryptedCredentials !== undefined) publishLockedState(stateRef.current)
      }
    }
    window.addEventListener('storage', checkRemoteVault)
    return () => window.removeEventListener('storage', checkRemoteVault)
  }, [publishLockedState])

  const clearHistory = useCallback(() => {
    commitState((prev) => ({ ...prev, history: prev.pendingLightningMelt ? [prev.pendingLightningMelt.transaction] : [] }))
  }, [commitState])

  const resetAll = useCallback(() => {
    requireWalletUnlocked()
    if (stateRef.current.pendingLightningMelt) {
      throw new Error('Resolve the pending Lightning payment before resetting Agwallet.')
    }
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
    btcRefreshInFlightRef.current = false
    setBtcBalanceConfirmedSats(0)
    setBtcBalanceUnconfirmedSats(0)
    setBtcUtxoCount(0)
    setBtcRefreshing(false)
    setBtcLastUpdatedAt(null)
    setBtcError(null)
  }, [requireWalletUnlocked, setActiveQuoteSynced])

  return useMemo<WalletEngine>(
    () => ({
      initialized: walletState.initialized,
      credentialsEncrypted: walletState.encryptedCredentials !== undefined,
      credentialsLocked: walletState.encryptedCredentials !== undefined &&
        !walletState.mnemonic && !walletState.privateKeyHex,
      protectWalletCredentials,
      unlockWalletCredentials,
      lockWalletCredentials,
      mnemonic: walletState.mnemonic ?? null,
      privateKeyHex: walletState.privateKeyHex ?? null,
      nutzapP2pkPubkeyHex,
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
      btcAddress,
      btcDerivationPath,
      btcBalanceConfirmedSats,
      btcBalanceUnconfirmedSats,
      btcBalanceTotalSats,
      btcUtxoCount,
      btcRefreshing,
      btcLastUpdatedAt,
      btcError,
      refreshOnchainBtcBalance,
      btcPendingSend,
      prepareNativeOnchainBtc,
      sendNativeOnchainBtc,
      retryNativeOnchainBtc,
      dismissNativeOnchainBtc,
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
      sendP2pkNutzapProofs,
      claimP2pkNutzapProofs,
      claimExternalMintQuote,
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
      walletState.encryptedCredentials,
      protectWalletCredentials,
      unlockWalletCredentials,
      lockWalletCredentials,
      walletState.mnemonic,
      walletState.privateKeyHex,
      nutzapP2pkPubkeyHex,
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
      btcAddress,
      btcDerivationPath,
      btcBalanceConfirmedSats,
      btcBalanceUnconfirmedSats,
      btcBalanceTotalSats,
      btcUtxoCount,
      btcRefreshing,
      btcLastUpdatedAt,
      btcError,
      refreshOnchainBtcBalance,
      btcPendingSend,
      prepareNativeOnchainBtc,
      sendNativeOnchainBtc,
      retryNativeOnchainBtc,
      dismissNativeOnchainBtc,
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
      sendP2pkNutzapProofs,
      claimP2pkNutzapProofs,
      claimExternalMintQuote,
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
