import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ChangeEvent } from 'react'
import { createPortal } from 'react-dom'
import {
  AlertCircle,
  ArrowDownLeft,
  ArrowLeft,
  ArrowUpRight,
  Bitcoin,
  Check,
  ChevronDown,
  ChevronRight,
  Coins,
  Copy,
  Download,
  ExternalLink,
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  Plus,
  QrCode,
  RefreshCw,
  ScanLine,
  Send,
  Trash2,
  Upload,
  Wallet,
  X,
  Zap,
} from 'lucide-react'
import type {
  BoltzSwapRecord,
  CashuMeltQuotePreview,
  CashuSentTokenRecord,
  WalletDraftKeys,
  WalletEngine,
  WalletInitialIntent,
  WalletModalTab,
  WalletReceiveMode,
  WalletSendMode,
  WalletTransaction,
  ZapEngine,
} from '../types/wallet.ts'
import { useBackHandler } from '../hooks/useBackNavigation.ts'
import {
  BITCOIN_DUST_LIMIT_SATS,
  DEFAULT_BITCOIN_FEE_RATES,
  fetchBitcoinFeeRates,
  type BitcoinFeeRates,
} from '../lib/bitcoinOnchain.ts'
import type { NativeBitcoinSendReview } from '../lib/nativeBitcoinSend.ts'
import {
  BOLTZ_NEW_SWAPS_PAUSED_MESSAGE,
  DEFAULT_BOLTZ_API_URL,
  formatBoltzStatusLabel,
  getMempoolAddressUrl,
  getMempoolTxUrl,
  isBoltzSwapActive,
  isBoltzSwapFailed,
  isValidBitcoinAddress,
} from '../lib/boltzSwap.ts'
import { formatMintHost } from '../lib/cashuMints.ts'
import {
  detectWalletImportFormat,
  encodeWalletPrivateKeyNsec,
  extractCashuTokenString,
} from '../lib/cashuWallet.ts'
import { generateQrSvg } from '../lib/qrCode.ts'
import { lightningAddressToQrPayload, parseLightningPayload } from '../lib/zaps.ts'
import '../styles/wallet.css'

export interface WalletModalProps {
  open: boolean
  embedded?: boolean
  onClose: () => void
  wallet: WalletEngine
  zaps: ZapEngine
  initialIntent?: WalletInitialIntent | null
  onOpenScanner?: () => void
  onSendToChat?: (
    token: string,
    amountSats: number,
    memo?: string
  ) => Promise<boolean> | boolean | void
  activeChatLabel?: string | null
}

type SetupMode = 'none' | 'choose' | 'create' | 'import'

const RECEIVE_LN_PRESETS = [100, 500, 1000, 5000, 21000] as const

async function copyTextSafe(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

function downloadJsonFile(filename: string, json: string): void {
  const blob = new Blob([json], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function formatRelativeTime(tsMs: number): string {
  const diffSec = Math.max(0, Math.floor((Date.now() - tsMs) / 1000))
  if (diffSec < 30) return 'Just now'
  if (diffSec < 60) return `${diffSec}s ago`
  const mins = Math.floor(diffSec / 60)
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  return `${days}d ago`
}

function isIncomingTx(type: WalletTransaction['type']): boolean {
  return (
    type === 'receive_ecash' ||
    type === 'receive_ln' ||
    type === 'receive_btc' ||
    type === 'zap_in' ||
    type === 'nutzap_in' ||
    type === 'reclaim'
  )
}

function formatTxLabel(type: WalletTransaction['type']): string {
  switch (type) {
    case 'receive_ecash':
      return 'Received Ecash'
    case 'send_ecash':
      return 'Sent Ecash'
    case 'receive_ln':
      return 'Lightning Deposit'
    case 'send_ln':
      return 'Lightning Payment'
    case 'receive_btc':
      return 'Bitcoin Deposit'
    case 'send_btc':
      return 'Bitcoin Send'
    case 'zap_out':
      return 'Zap'
    case 'zap_in':
      return 'Zap Received'
    case 'nutzap_in':
      return 'Nutzap Received'
    case 'nutzap_out':
      return 'Nutzap'
    case 'reclaim':
      return 'Reclaimed Ecash'
  }
}

function getLightningReceiveQrInfo(
  address: string | null | undefined
): { qrPayload: string; lnurl: string } | null {
  if (!address) return null
  try {
    const qrPayload = lightningAddressToQrPayload(address)
    const lnurl = qrPayload.replace(/^lightning:/i, '').toLowerCase()
    return { qrPayload, lnurl }
  } catch {
    return null
  }
}

function QrBox({ payload, label }: { payload: string; label: string }) {
  const [svg, setSvg] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let cancelled = false
    generateQrSvg(payload)
      .then((markup) => {
        if (!cancelled) {
          setSvg(markup)
          setFailed(false)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setSvg(null)
          setFailed(true)
        }
      })
    return () => {
      cancelled = true
    }
  }, [payload])

  return (
    <div className="ag-wallet-qr-frame" aria-label={label}>
      {failed ? (
        <QrCode size={28} />
      ) : svg ? (
        <div className="ag-wallet-qr-svg" dangerouslySetInnerHTML={{ __html: svg }} />
      ) : (
        <Loader2 size={24} className="ag-wallet-spin" />
      )}
    </div>
  )
}

function resolveInitialNav(intent?: WalletInitialIntent | null): {
  tab: WalletModalTab
  receiveMode: WalletReceiveMode
  sendMode: WalletSendMode
  cashuReceiveInput: string
  lnSendInput: string
} {
  const payload = intent?.payload?.trim() ?? ''
  if (payload) {
    if (extractCashuTokenString(payload)) {
      return {
        tab: intent?.tab ?? 'receive',
        receiveMode: intent?.receiveMode ?? 'cashu',
        sendMode: intent?.sendMode ?? 'cashu',
        cashuReceiveInput: payload,
        lnSendInput: '',
      }
    }
    if (parseLightningPayload(payload)) {
      return {
        tab: intent?.tab ?? 'send',
        receiveMode: intent?.receiveMode ?? 'lightning',
        sendMode: intent?.sendMode ?? 'lightning',
        cashuReceiveInput: '',
        lnSendInput: payload,
      }
    }
  }
  return {
    tab: intent?.tab ?? 'overview',
    receiveMode: intent?.receiveMode ?? 'lightning',
    sendMode: intent?.sendMode ?? 'cashu',
    cashuReceiveInput: '',
    lnSendInput: '',
  }
}

function WalletModalInner({
  embedded = false,
  onClose,
  wallet,
  zaps,
  initialIntent,
  onOpenScanner,
  onSendToChat,
  activeChatLabel,
}: Omit<WalletModalProps, 'open'>) {
  const initNav = useMemo(() => resolveInitialNav(initialIntent), [initialIntent])

  // Show sleek setup screen on first launch (unless an explicit scanned payload was passed in)
  const hasExplicitPayload = Boolean(initialIntent?.payload?.trim())
  const [setupMode, setSetupMode] = useState<SetupMode>(() =>
    !wallet.initialized && !hasExplicitPayload ? 'choose' : 'none'
  )
  const [draftKeys, setDraftKeys] = useState<WalletDraftKeys | null>(null)
  const [showDraftPrivKey, setShowDraftPrivKey] = useState(false)
  const [setupMintUrl, setSetupMintUrl] = useState<string>(wallet.activeMintUrl)
  const [setupImportInput, setSetupImportInput] = useState<string>('')
  const [importingSetup, setImportingSetup] = useState(false)
  const setupImportFileRef = useRef<HTMLInputElement | null>(null)

  const [tab, setTab] = useState<WalletModalTab>(
    initNav.tab === 'history' ? 'mints' : initNav.tab
  )
  const [receiveMode, setReceiveMode] = useState<WalletReceiveMode>(initNav.receiveMode)
  const [sendMode, setSendMode] = useState<WalletSendMode>(initNav.sendMode)
  const [showAllActivity, setShowAllActivity] = useState(false)

  const [feedback, setFeedback] = useState<{
    kind: 'accent' | 'warn' | 'danger'
    text: string
  } | null>(null)
  const [copiedKey, setCopiedKey] = useState<string | null>(null)

  // Overview Receive Zaps (built-in npub.cash / NIP-61 or custom address)
  const [lud16Draft, setLud16Draft] = useState<string>(
    () => zaps.customLightningAddress ?? (zaps.zapMode === 'custom' ? (zaps.lightningAddress ?? '') : '')
  )
  const [editingCustomZap, setEditingCustomZap] = useState(false)
  const [savingLud16, setSavingLud16] = useState(false)
  const [showOverviewZapQr, setShowOverviewZapQr] = useState(false)

  // Receive: Ecash
  const [cashuReceiveInput, setCashuReceiveInput] = useState<string>(initNav.cashuReceiveInput)
  const [claimingToken, setClaimingToken] = useState(false)

  // Receive: Lightning (NUT-04)
  const [lnReceiveAmount, setLnReceiveAmount] = useState<string>('1000')
  const [lnReceiveMemo, setLnReceiveMemo] = useState<string>('')
  const [creatingLnQuote, setCreatingLnQuote] = useState(false)
  const [checkingLnQuote, setCheckingLnQuote] = useState(false)
  const [showPermLnQr, setShowPermLnQr] = useState<boolean>(() => !wallet.activeMintQuote)

  // Receive: Native Core Bitcoin (BIP-84) + Optional Boltz v2 Submarine Swap
  const [showBoltzReceiveSwap, setShowBoltzReceiveSwap] = useState<boolean>(() =>
    wallet.boltzSwaps.some((s) => s.direction === 'submarine' && isBoltzSwapActive(s))
  )

  // Send: Ecash
  const [cashuSendAmount, setCashuSendAmount] = useState<string>('')
  const [cashuSendMemo, setCashuSendMemo] = useState<string>('')
  const [creatingToken, setCreatingToken] = useState(false)
  const [freshSentToken, setFreshSentToken] = useState<CashuSentTokenRecord | null>(null)
  const [sendingToChat, setSendingToChat] = useState(false)
  const [checkingSentId, setCheckingSentId] = useState<string | null>(null)

  // Send: Lightning (NUT-05)
  const [lnSendInput, setLnSendInput] = useState<string>(initNav.lnSendInput)
  const [lnSendAmount, setLnSendAmount] = useState<string>('')
  const [lnSendComment, setLnSendComment] = useState<string>('')
  const [meltPreview, setMeltPreview] = useState<CashuMeltQuotePreview | null>(null)
  const [preparingMelt, setPreparingMelt] = useState(false)
  const [payingMelt, setPayingMelt] = useState(false)

  // Send: Core Bitcoin (BIP-84 Native) + Optional Boltz v2 Reverse Submarine Swap
  const [btcSendSource, setBtcSendSource] = useState<'core' | 'boltz'>(() =>
    wallet.btcBalanceTotalSats === 0 &&
    wallet.boltzSwaps.some((s) => s.direction === 'reverse' && isBoltzSwapActive(s))
      ? 'boltz'
      : 'core'
  )
  const [nativeBtcSendAddress, setNativeBtcSendAddress] = useState<string>('')
  const [nativeBtcSendAmount, setNativeBtcSendAmount] = useState<string>('')
  const [nativeBtcFeePriority, setNativeBtcFeePriority] = useState<
    'economy' | 'standard' | 'priority'
  >('standard')
  const [btcFeeRates, setBtcFeeRates] = useState<BitcoinFeeRates | null>(null)
  const [btcFeeRatesLoading, setBtcFeeRatesLoading] = useState(false)
  const [sendingNativeBtc, setSendingNativeBtc] = useState(false)
  const [nativeBtcReview, setNativeBtcReview] = useState<NativeBitcoinSendReview | null>(null)
  const [nativeBtcSentResult, setNativeBtcSentResult] = useState<{
    txid: string
    feeSats: number
    sentSats: number
    toAddress: string
  } | null>(null)
  const [refreshingSwapId, setRefreshingSwapId] = useState<string | null>(null)

  // Mints management
  const [customMintUrl, setCustomMintUrl] = useState<string>('')
  const [addingMint, setAddingMint] = useState(false)
  const [inspectingMintUrl, setInspectingMintUrl] = useState<string | null>(null)
  const [verifyingMintUrl, setVerifyingMintUrl] = useState<string | null>(null)
  const [showAdvancedBoltz, setShowAdvancedBoltz] = useState(false)
  const [boltzUrlDraft, setBoltzUrlDraft] = useState<string>(wallet.boltzApiUrl)

  // History / Keys & Recovery
  const [revealKeys, setRevealKeys] = useState(false)
  const [showProtectWallet, setShowProtectWallet] = useState(false)
  const [walletPassphrase, setWalletPassphrase] = useState('')
  const [repeatWalletPassphrase, setRepeatWalletPassphrase] = useState('')
  const [walletBackupConfirmed, setWalletBackupConfirmed] = useState(false)
  const [walletVaultBusy, setWalletVaultBusy] = useState(false)
  const [restoringSeed, setRestoringSeed] = useState(false)
  const [importJsonText, setImportJsonText] = useState<string>('')
  const [showImportPaste, setShowImportPaste] = useState(false)
  const [importingBackup, setImportingBackup] = useState(false)
  const backupFileInputRef = useRef<HTMLInputElement | null>(null)

  const canStepBackInSetup =
    setupMode === 'create' || setupMode === 'import' || (setupMode === 'choose' && wallet.initialized)

  const activeZapAddress = zaps.lightningAddress || zaps.builtinLightningAddress
  const activeZapQr = useMemo(
    () => getLightningReceiveQrInfo(activeZapAddress),
    [activeZapAddress]
  )

  const effectiveBtcFeeRates = btcFeeRates ?? DEFAULT_BITCOIN_FEE_RATES
  const selectedNativeFeeRateSatVb =
    nativeBtcFeePriority === 'economy'
      ? effectiveBtcFeeRates.economyFee
      : nativeBtcFeePriority === 'priority'
        ? effectiveBtcFeeRates.fastestFee
        : effectiveBtcFeeRates.halfHourFee

  const handleBack = useCallback(() => {
    if (setupMode === 'create' || setupMode === 'import') {
      setSetupMode('choose')
      setFeedback(null)
      return
    }
    if (setupMode === 'choose' && wallet.initialized) {
      setSetupMode('none')
      setFeedback(null)
      return
    }
    if (!embedded) {
      onClose()
    }
  }, [embedded, onClose, setupMode, wallet.initialized])

  useBackHandler(!embedded || canStepBackInSetup, handleBack)

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (canStepBackInSetup) {
        e.preventDefault()
        handleBack()
      } else if (!embedded) {
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [canStepBackInSetup, embedded, handleBack, onClose])

  const handleTriggerScanner = useCallback(() => {
    if (!onOpenScanner) return
    if (!embedded) {
      onClose()
    }
    onOpenScanner()
  }, [embedded, onClose, onOpenScanner])

  const markCopied = useCallback(async (key: string, value: string) => {
    const ok = await copyTextSafe(value)
    if (ok) {
      setCopiedKey(key)
      window.setTimeout(() => {
        setCopiedKey((prev) => (prev === key ? null : prev))
      }, 1800)
    }
  }, [])

  const loadBtcFeeRates = useCallback(async () => {
    setBtcFeeRatesLoading(true)
    try {
      const rates = await fetchBitcoinFeeRates()
      setBtcFeeRates(rates)
    } catch {
      // Fall back quietly to DEFAULT_BITCOIN_FEE_RATES
    } finally {
      setBtcFeeRatesLoading(false)
    }
  }, [])

  const switchTab = useCallback(
    (nextTab: WalletModalTab) => {
      setTab(nextTab)
      setFeedback(null)
      if (nextTab === 'send' && sendMode === 'onchain' && btcSendSource === 'core' && !btcFeeRates && !btcFeeRatesLoading) {
        void loadBtcFeeRates()
      }
    },
    [
      btcFeeRates,
      btcFeeRatesLoading,
      btcSendSource,
      loadBtcFeeRates,
      sendMode,
    ]
  )

  const switchReceiveMode = useCallback((mode: WalletReceiveMode) => {
    setReceiveMode(mode)
    setFeedback(null)
  }, [])

  const jumpToReceive = useCallback((mode: WalletReceiveMode) => {
    setTab('receive')
    setReceiveMode(mode)
    setFeedback(null)
  }, [])

  const switchSendMode = useCallback(
    (mode: WalletSendMode) => {
      setSendMode(mode)
      setFeedback(null)
      if (mode === 'onchain' && btcSendSource === 'core' && !btcFeeRates && !btcFeeRatesLoading) {
        void loadBtcFeeRates()
      }
    },
    [
      btcFeeRates,
      btcFeeRatesLoading,
      btcSendSource,
      loadBtcFeeRates,
    ]
  )

  const handleToggleBoltzReceiveSwap = useCallback(() => {
    setShowBoltzReceiveSwap((prev) => !prev)
  }, [])

  const handleSelectBtcSendSource = useCallback(
    (nextSource: 'core' | 'boltz') => {
      setBtcSendSource(nextSource)
      setFeedback(null)
      if (nextSource === 'core' && !btcFeeRates && !btcFeeRatesLoading) {
        void loadBtcFeeRates()
      }
    },
    [
      btcFeeRates,
      btcFeeRatesLoading,
      loadBtcFeeRates,
    ]
  )

  const handleReviewNativeBtc = useCallback(async () => {
    const amount = nativeBtcSendAmount.trim()
    const sats = /^\d+$/.test(amount) ? Number(amount) : NaN
    if (!Number.isSafeInteger(sats) || sats < BITCOIN_DUST_LIMIT_SATS) return
    setSendingNativeBtc(true)
    setFeedback(null)
    setNativeBtcSentResult(null)
    try {
      setNativeBtcReview(await wallet.prepareNativeOnchainBtc(
        nativeBtcSendAddress.trim(), sats, selectedNativeFeeRateSatVb
      ))
    } catch (err) {
      setFeedback({
        kind: 'danger',
        text: err instanceof Error ? err.message : 'Could not review Bitcoin transaction.',
      })
    } finally {
      setSendingNativeBtc(false)
    }
  }, [nativeBtcSendAddress, nativeBtcSendAmount, selectedNativeFeeRateSatVb, wallet])

  const handleSendNativeBtc = useCallback(async (retryTxid?: string) => {
    if (!retryTxid && (!nativeBtcReview || nativeBtcReview.fromAddress !== wallet.btcAddress)) return
    setSendingNativeBtc(true)
    setFeedback(null)
    try {
      const res = retryTxid
        ? await wallet.retryNativeOnchainBtc(retryTxid)
        : await wallet.sendNativeOnchainBtc(nativeBtcReview!)
      setNativeBtcSentResult({ txid: res.txid, sentSats: res.amountSats, feeSats: res.feeSats, toAddress: res.toAddress })
      setNativeBtcSendAddress('')
      setNativeBtcSendAmount('')
      setFeedback({
        kind: 'accent',
        text: `Broadcast ${res.amountSats.toLocaleString()} sats · ${res.feeSats.toLocaleString()} sat fee`,
      })
    } catch (err) {
      setFeedback({
        kind: 'danger',
        text: err instanceof Error ? err.message : 'Could not send Bitcoin transaction.',
      })
    } finally {
      setNativeBtcReview(null)
      setSendingNativeBtc(false)
    }
  }, [nativeBtcReview, wallet])

  const handleDismissNativeBtc = useCallback(async (txid: string) => {
    setSendingNativeBtc(true)
    try {
      await wallet.dismissNativeOnchainBtc(txid)
      setNativeBtcReview(null)
    } catch (err) {
      setFeedback({
        kind: 'danger',
        text: err instanceof Error ? err.message : 'Could not close Bitcoin send receipt.',
      })
    } finally {
      setSendingNativeBtc(false)
    }
  }, [wallet])

  /* ------------------------------------------------------------------------
     Setup & Key Management Handlers
     ------------------------------------------------------------------------ */

  const enterCreateMode = useCallback(() => {
    setDraftKeys(wallet.generateDraftWalletKeys())
    setShowDraftPrivKey(false)
    setSetupMintUrl(wallet.activeMintUrl)
    setFeedback(null)
    setSetupMode('create')
  }, [wallet])

  const enterImportMode = useCallback(() => {
    setSetupImportInput('')
    setSetupMintUrl(wallet.activeMintUrl)
    setFeedback(null)
    setSetupMode('import')
  }, [wallet.activeMintUrl])

  const handleRegenerateDraft = useCallback(() => {
    setDraftKeys(wallet.generateDraftWalletKeys())
    setFeedback(null)
  }, [wallet])

  const handleExportDraftKey = useCallback(() => {
    if (!draftKeys) return
    const dateStamp = new Date().toISOString().slice(0, 10)
    const payload = {
      version: 1,
      exportedAt: Date.now(),
      activeMintUrl: setupMintUrl,
      mnemonic: draftKeys.mnemonic,
      privateKeyHex: draftKeys.privateKeyHex,
      keysetCounters: {},
      mints: wallet.mints,
      proofsByMint: {},
      history: [],
      sentTokens: [],
      boltzSwaps: [],
    }
    downloadJsonFile(`agwallet-key-${dateStamp}.json`, JSON.stringify(payload, null, 2))
    setFeedback({ kind: 'accent', text: 'Key backup exported.' })
  }, [draftKeys, setupMintUrl, wallet.mints])

  const handleFinalizeCreateWallet = useCallback(() => {
    const keys = draftKeys ?? wallet.generateDraftWalletKeys()
    wallet.createNewWallet({
      mnemonic: keys.mnemonic,
      privateKeyHex: keys.privateKeyHex,
      mintUrl: setupMintUrl,
    })
    setSetupMode('none')
    setTab('overview')
    setRevealKeys(false)
    setFeedback({ kind: 'accent', text: 'Agwallet ready.' })
  }, [draftKeys, setupMintUrl, wallet])

  const detectedSetupImport = useMemo(
    () => (setupImportInput.trim() ? detectWalletImportFormat(setupImportInput) : null),
    [setupImportInput]
  )

  const handleSetupImportFile = useCallback((e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    void file.text().then((text) => {
      setSetupImportInput(text.trim())
      setFeedback(null)
    })
  }, [])

  const handleFinalizeImportWallet = useCallback(async () => {
    if (!setupImportInput.trim()) return
    setImportingSetup(true)
    setFeedback(null)
    try {
      const res = await wallet.importWalletKeyOrSeed(setupImportInput, {
        mintUrl: setupMintUrl,
        scanMints: true,
      })
      setSetupMode('none')
      setTab('overview')
      setRevealKeys(false)
      setSetupImportInput('')
      setFeedback({
        kind: 'accent',
        text:
          res.restoredSats > 0
            ? `Agwallet imported · restored ${res.restoredSats.toLocaleString()} sats`
            : 'Agwallet imported.',
      })
    } catch (err) {
      setFeedback({
        kind: 'danger',
        text: err instanceof Error ? err.message : 'Could not import Agwallet.',
      })
    } finally {
      setImportingSetup(false)
    }
  }, [setupImportInput, setupMintUrl, wallet])

  const handleRestoreFromSeed = useCallback(async () => {
    setRestoringSeed(true)
    setFeedback(null)
    try {
      const res = await wallet.restoreProofsFromSeed(wallet.activeMintUrl)
      setFeedback({
        kind: res.restoredSats > 0 ? 'accent' : 'warn',
        text:
          res.restoredSats > 0
            ? `Restored ${res.restoredSats.toLocaleString()} sats`
            : `No balance found on ${formatMintHost(wallet.activeMintUrl)}`,
      })
    } catch (err) {
      setFeedback({
        kind: 'danger',
        text: err instanceof Error ? err.message : 'Restore failed.',
      })
    } finally {
      setRestoringSeed(false)
    }
  }, [wallet])

  const cashuReceivePreview = useMemo(
    () => (cashuReceiveInput.trim() ? wallet.decodeTokenPreview(cashuReceiveInput) : null),
    [cashuReceiveInput, wallet]
  )

  const parsedLnSend = useMemo(
    () => (lnSendInput.trim() ? parseLightningPayload(lnSendInput) : null),
    [lnSendInput]
  )

  const fundedMints = useMemo(
    () => wallet.mints.filter((m) => (wallet.balancesByMint[m.url] ?? 0) > 0),
    [wallet.balancesByMint, wallet.mints]
  )

  const activeSubSwap: BoltzSwapRecord | null = useMemo(() => {
    return (
      wallet.boltzSwaps.find((s) => s.direction === 'submarine' && isBoltzSwapActive(s)) ?? null
    )
  }, [wallet.boltzSwaps])

  const activeRevSwap: BoltzSwapRecord | null = useMemo(() => {
    return wallet.boltzSwaps.find((s) => s.direction === 'reverse' && isBoltzSwapActive(s)) ?? null
  }, [wallet.boltzSwaps])

  const savedBoltzSwaps = wallet.boltzSwaps

  const walletNsec = useMemo(
    () => encodeWalletPrivateKeyNsec(wallet.privateKeyHex),
    [wallet.privateKeyHex]
  )

  /* ------------------------------------------------------------------------
     Standard Wallet Action Handlers
     ------------------------------------------------------------------------ */

  const handleSaveLud16 = useCallback(async () => {
    setSavingLud16(true)
    setFeedback(null)
    try {
      const cleaned = lud16Draft.trim()
      if (!cleaned) {
        const res = await zaps.setZapAddressMode('builtin')
        if (!res.ok) {
          setFeedback({ kind: 'danger', text: res.error || 'Unable to switch to built-in Zaps.' })
        } else {
          setEditingCustomZap(false)
          setFeedback({ kind: 'accent', text: 'Switched back to built-in Agwallet Zaps' })
        }
        return
      }
      const res = await zaps.setZapAddressMode('custom', cleaned)
      if (!res.ok) {
        setFeedback({ kind: 'danger', text: res.error || 'Invalid Lightning address.' })
      } else {
        setLud16Draft(res.normalized ?? '')
        setEditingCustomZap(false)
        setFeedback({
          kind: 'accent',
          text: res.normalized ? `Saved ${res.normalized}` : 'Updated Zap address',
        })
      }
    } finally {
      setSavingLud16(false)
    }
  }, [lud16Draft, zaps])

  const handleSwitchToBuiltinZaps = useCallback(async () => {
    setSavingLud16(true)
    setFeedback(null)
    try {
      const res = await zaps.setZapAddressMode('builtin')
      if (!res.ok) {
        setFeedback({ kind: 'danger', text: res.error || 'Unable to switch to built-in Zaps.' })
      } else {
        setEditingCustomZap(false)
        setFeedback({ kind: 'accent', text: 'Using built-in Agwallet Zaps' })
      }
    } finally {
      setSavingLud16(false)
    }
  }, [zaps])

  const handleCheckZapsNow = useCallback(async () => {
    setFeedback(null)
    const res = await zaps.sweepNpubCashNow()
    if (res.error) {
      setFeedback({ kind: 'danger', text: res.error })
    } else if (res.claimedSats > 0) {
      setFeedback({
        kind: 'accent',
        text: `Received ${res.claimedSats.toLocaleString()} sats from Zaps`,
      })
    } else {
      setFeedback({ kind: 'accent', text: 'Up to date — no new Zaps yet' })
    }
  }, [zaps])

  const handlePasteInto = useCallback(async (setter: (v: string) => void) => {
    try {
      const text = await navigator.clipboard.readText()
      if (text) setter(text.trim())
    } catch {
      setFeedback({ kind: 'warn', text: 'Clipboard read blocked — paste directly.' })
    }
  }, [])

  const handleClaimCashuToken = useCallback(async () => {
    if (!cashuReceiveInput.trim()) return
    setClaimingToken(true)
    setFeedback(null)
    try {
      const res = await wallet.receiveCashuToken(cashuReceiveInput)
      setCashuReceiveInput('')
      setFeedback({
        kind: 'accent',
        text: `Claimed ${res.amountSats.toLocaleString()} sats · ${formatMintHost(res.mintUrl)}`,
      })
    } catch (err) {
      setFeedback({
        kind: 'danger',
        text: err instanceof Error ? err.message : 'Failed to claim token.',
      })
    } finally {
      setClaimingToken(false)
    }
  }, [cashuReceiveInput, wallet])

  const handleCreateLnReceiveQuote = useCallback(async () => {
    const sats = Math.floor(Number.parseInt(lnReceiveAmount, 10) || 0)
    if (sats <= 0) {
      setFeedback({ kind: 'danger', text: 'Enter a valid amount.' })
      return
    }
    setCreatingLnQuote(true)
    setFeedback(null)
    try {
      await wallet.createLightningReceiveQuote(sats, lnReceiveMemo.trim() || undefined)
      setShowPermLnQr(false)
    } catch (err) {
      setFeedback({
        kind: 'danger',
        text: err instanceof Error ? err.message : 'Could not create invoice.',
      })
    } finally {
      setCreatingLnQuote(false)
    }
  }, [lnReceiveAmount, lnReceiveMemo, wallet])

  const handleManualCheckLnQuote = useCallback(async () => {
    setCheckingLnQuote(true)
    try {
      const res = await wallet.checkAndClaimMintQuote()
      if (res.claimedSats > 0) {
        setFeedback({
          kind: 'accent',
          text: `Received ${res.claimedSats.toLocaleString()} sats`,
        })
      } else if (res.state === 'UNPAID') {
        setFeedback({ kind: 'warn', text: 'Not paid yet — listening automatically.' })
      }
    } catch (err) {
      setFeedback({
        kind: 'danger',
        text: err instanceof Error ? err.message : 'Failed to check quote.',
      })
    } finally {
      setCheckingLnQuote(false)
    }
  }, [wallet])

  const handleCreateCashuToken = useCallback(async () => {
    const sats = Math.floor(Number.parseInt(cashuSendAmount, 10) || 0)
    if (sats <= 0) {
      setFeedback({ kind: 'danger', text: 'Enter a valid amount.' })
      return
    }
    setCreatingToken(true)
    setFeedback(null)
    try {
      const record = await wallet.createCashuToken(sats, cashuSendMemo.trim() || undefined)
      setFreshSentToken(record)
      setCashuSendAmount('')
      setCashuSendMemo('')
    } catch (err) {
      setFeedback({
        kind: 'danger',
        text: err instanceof Error ? err.message : 'Failed to create token.',
      })
    } finally {
      setCreatingToken(false)
    }
  }, [cashuSendAmount, cashuSendMemo, wallet])

  const handleSendTokenToChat = useCallback(
    async (record: CashuSentTokenRecord) => {
      if (!onSendToChat) return
      setSendingToChat(true)
      try {
        const res = await onSendToChat(record.token, record.amountSats, record.memo)
        if (res !== false) {
          setFeedback({
            kind: 'accent',
            text: `Sent ${record.amountSats.toLocaleString()} sats to ${activeChatLabel || 'chat'}`,
          })
        }
      } finally {
        setSendingToChat(false)
      }
    },
    [activeChatLabel, onSendToChat]
  )

  const handleCheckSentToken = useCallback(
    async (sentId: string) => {
      setCheckingSentId(sentId)
      try {
        const st = await wallet.checkSentTokenStatus(sentId)
        setFreshSentToken((prev) => (prev && prev.id === sentId ? { ...prev, status: st } : prev))
        setFeedback({
          kind: st === 'claimed' ? 'accent' : 'warn',
          text: st === 'claimed' ? 'Token claimed.' : 'Still unclaimed — can be reclaimed.',
        })
      } catch (err) {
        setFeedback({
          kind: 'danger',
          text: err instanceof Error ? err.message : 'Could not check status.',
        })
      } finally {
        setCheckingSentId(null)
      }
    },
    [wallet]
  )

  const handleReclaimSentToken = useCallback(
    async (sentId: string) => {
      setCheckingSentId(sentId)
      setFeedback(null)
      try {
        const reclaimedSats = await wallet.reclaimSentToken(sentId)
        setFreshSentToken((prev) =>
          prev && prev.id === sentId ? { ...prev, status: 'reclaimed' } : prev
        )
        setFeedback({
          kind: 'accent',
          text: `Reclaimed ${reclaimedSats.toLocaleString()} sats`,
        })
      } catch (err) {
        setFeedback({
          kind: 'danger',
          text: err instanceof Error ? err.message : 'Failed to reclaim token.',
        })
      } finally {
        setCheckingSentId(null)
      }
    },
    [wallet]
  )

  const handlePrepareMelt = useCallback(async () => {
    if (!lnSendInput.trim()) return
    setPreparingMelt(true)
    setFeedback(null)
    setMeltPreview(null)
    try {
      const amt = parsedLnSend?.kind === 'bolt11' ? undefined : Number.parseInt(lnSendAmount, 10)
      const preview = await wallet.prepareLightningPayment(
        lnSendInput.trim(),
        amt,
        lnSendComment.trim() || undefined
      )
      setMeltPreview(preview)
    } catch (err) {
      setFeedback({
        kind: 'danger',
        text: err instanceof Error ? err.message : 'Failed to prepare quote.',
      })
    } finally {
      setPreparingMelt(false)
    }
  }, [lnSendAmount, lnSendComment, lnSendInput, parsedLnSend?.kind, wallet])

  const handleConfirmMelt = useCallback(async () => {
    if (!meltPreview) return
    setPayingMelt(true)
    setFeedback(null)
    try {
      const res = await wallet.payLightningQuote(meltPreview)
      setMeltPreview(null)
      setLnSendInput('')
      setLnSendAmount('')
      setLnSendComment('')
      setFeedback({
        kind: res.paid ? 'accent' : 'warn',
        text: res.paid
          ? `Paid ${meltPreview.amountSats.toLocaleString()} sats${res.feePaidSats > 0 ? ` · ${res.feePaidSats} sat fee` : ''}`
          : 'Payment pending. Check Agwallet activity before sending again.',
      })
    } catch (err) {
      setFeedback({
        kind: 'danger',
        text: err instanceof Error ? err.message : 'Payment failed.',
      })
    } finally {
      setPayingMelt(false)
    }
  }, [meltPreview, wallet])

  const handleRefreshSwap = useCallback(
    async (swapId: string) => {
      setRefreshingSwapId(swapId)
      try {
        await wallet.refreshBoltzSwap(swapId)
      } catch (err) {
        setFeedback({
          kind: 'danger',
          text: err instanceof Error ? err.message : 'Failed to refresh swap.',
        })
      } finally {
        setRefreshingSwapId(null)
      }
    },
    [wallet]
  )

  const handleDownloadSwapRescue = useCallback(
    (swapId: string) => {
      const json = wallet.exportBoltzSwapRescueJson(swapId)
      if (!json) return
      downloadJsonFile(`agnostr-boltz-rescue-${swapId}.json`, json)
      setFeedback({ kind: 'accent', text: `Exported rescue file for ${swapId}` })
    },
    [wallet]
  )

  const handleAddMint = useCallback(async () => {
    if (!customMintUrl.trim()) return
    setAddingMint(true)
    setFeedback(null)
    try {
      const info = await wallet.addMint(customMintUrl.trim())
      setCustomMintUrl('')
      setFeedback({ kind: 'accent', text: `Added ${info.name}` })
    } catch (err) {
      setFeedback({
        kind: 'danger',
        text: err instanceof Error ? err.message : 'Could not add mint.',
      })
    } finally {
      setAddingMint(false)
    }
  }, [customMintUrl, wallet])

  const handleInspectMint = useCallback(
    async (url: string) => {
      setInspectingMintUrl(url)
      setFeedback(null)
      try {
        const info = await wallet.inspectMint(url)
        setFeedback({
          kind: info.online ? 'accent' : 'danger',
          text: info.online
            ? `${info.name} · ${info.feePpk === 0 ? 'No fee' : `${info.feePpk ?? 0} ppk`} · Online`
            : info.error || 'Mint offline',
        })
      } catch (err) {
        setFeedback({
          kind: 'danger',
          text: err instanceof Error ? err.message : 'Could not reach mint.',
        })
      } finally {
        setInspectingMintUrl(null)
      }
    },
    [wallet]
  )

  const handleVerifyMintProofs = useCallback(
    async (url: string) => {
      setVerifyingMintUrl(url)
      setFeedback(null)
      try {
        const res = await wallet.verifyProofs(url)
        setFeedback({
          kind: res.spentRemoved > 0 ? 'warn' : 'accent',
          text: `${res.checked} checked · ${res.spentRemoved} spent removed · ${res.balanceSats.toLocaleString()} sats`,
        })
      } catch (err) {
        setFeedback({
          kind: 'danger',
          text: err instanceof Error ? err.message : 'Verification failed.',
        })
      } finally {
        setVerifyingMintUrl(null)
      }
    },
    [wallet]
  )

  const handleExportBackupFile = useCallback(() => {
    try {
      const json = wallet.exportWalletKeyJson()
      const dateStamp = new Date().toISOString().slice(0, 10)
      downloadJsonFile(`agwallet-backup-${dateStamp}.json`, json)
      setFeedback({ kind: 'warn', text: 'Plaintext backup exported. Keep it offline and private.' })
    } catch (err) {
      setFeedback({
        kind: 'danger',
        text: err instanceof Error ? err.message : 'Could not export the backup.',
      })
    }
  }, [wallet])

  const resetWalletVaultForm = useCallback(() => {
    setWalletPassphrase('')
    setRepeatWalletPassphrase('')
    setWalletBackupConfirmed(false)
    setShowProtectWallet(false)
  }, [])

  const handleProtectWallet = useCallback(async () => {
    if (walletPassphrase !== repeatWalletPassphrase) {
      setFeedback({ kind: 'danger', text: 'The passphrases do not match.' })
      return
    }
    setWalletVaultBusy(true)
    setFeedback(null)
    try {
      const { snapshotVerified } = await wallet.protectWalletCredentials(walletPassphrase, walletBackupConfirmed)
      setRevealKeys(false)
      setFeedback(snapshotVerified
        ? { kind: 'accent', text: 'The saved recovery phrase and key are now encrypted.' }
        : { kind: 'warn', text: 'This wallet is locked and its saved keys are encrypted. An older profile snapshot could still contain a plaintext copy.' })
    } catch (err) {
      setFeedback({
        kind: 'danger',
        text: err instanceof Error ? err.message : 'Could not secure Agwallet.',
      })
    } finally {
      resetWalletVaultForm()
      setWalletVaultBusy(false)
    }
  }, [repeatWalletPassphrase, resetWalletVaultForm, wallet, walletBackupConfirmed, walletPassphrase])

  const handleUnlockWallet = useCallback(async () => {
    setWalletVaultBusy(true)
    setFeedback(null)
    try {
      await wallet.unlockWalletCredentials(walletPassphrase)
      setFeedback({ kind: 'accent', text: 'Agwallet unlocked in this tab.' })
    } catch (err) {
      setFeedback({
        kind: 'danger',
        text: err instanceof Error ? err.message : 'Could not unlock Agwallet.',
      })
    } finally {
      setWalletPassphrase('')
      setWalletVaultBusy(false)
    }
  }, [wallet, walletPassphrase])

  const handleLockWallet = useCallback(() => {
    try {
      wallet.lockWalletCredentials()
      setRevealKeys(false)
      resetWalletVaultForm()
      setFeedback(null)
    } catch (err) {
      setFeedback({
        kind: 'danger',
        text: err instanceof Error ? err.message : 'Could not lock Agwallet.',
      })
    }
  }, [resetWalletVaultForm, wallet])

  const handleImportBackupText = useCallback(
    async (raw: string) => {
      if (!raw.trim()) return
      setImportingBackup(true)
      setFeedback(null)
      try {
        const res = await wallet.importBackupJson(raw)
        setImportJsonText('')
        setShowImportPaste(false)
        setFeedback({
          kind: 'accent',
          text: `Restored ${res.totalSats.toLocaleString()} sats`,
        })
      } catch (err) {
        setFeedback({
          kind: 'danger',
          text: err instanceof Error ? err.message : 'Import failed.',
        })
      } finally {
        setImportingBackup(false)
      }
    },
    [wallet]
  )

  const handleBackupFileSelected = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0]
      e.target.value = ''
      if (!file) return
      void file.text().then((text) => handleImportBackupText(text))
    },
    [handleImportBackupText]
  )

  const handleSaveBoltzUrl = useCallback(() => {
    wallet.setBoltzApiUrl(boltzUrlDraft.trim() || DEFAULT_BOLTZ_API_URL)
    setFeedback({ kind: 'accent', text: 'Updated swap server.' })
  }, [boltzUrlDraft, wallet])

  const renderSeedGrid = (phrase: string) => {
    const words = phrase.trim().split(/\s+/)
    return (
      <div className="ag-wallet-seed-grid" aria-label="Recovery phrase">
        {words.map((word, idx) => (
          <div key={`${idx}-${word}`} className="ag-wallet-seed-word">
            <span className="ag-wallet-seed-idx">{idx + 1}</span>
            <span className="ag-wallet-seed-text">{word}</span>
          </div>
        ))}
      </div>
    )
  }

  const renderSwapBlock = (swap: BoltzSwapRecord) => {
    const failed = isBoltzSwapFailed(swap.status)
    const active = isBoltzSwapActive(swap)
    return (
      <div key={swap.id} className="ag-wallet-tonal">
        <div className="ag-wallet-section-head">
          <span className="ag-wallet-section-title">
            {swap.direction === 'submarine' ? 'Bitcoin Deposit' : 'Bitcoin Send'} · {swap.id}
          </span>
          <span className={`ag-wallet-pill ${failed ? 'danger' : active ? 'warn' : 'accent'}`}>
            {formatBoltzStatusLabel(swap.status)}
          </span>
        </div>

        <p className="ag-wallet-banner warn">
          <AlertCircle size={15} />
          <span>Recovery only. Do not send new funds to this swap.</span>
        </p>

        <p className="ag-wallet-meta">
          Recovery files include spending secrets. Save yours privately. See the{' '}
          <a href="https://api.docs.boltz.exchange/claiming-swaps.html"
             target="_blank" rel="noopener noreferrer">
            Boltz claim and refund instructions
          </a>.
        </p>

        <div className="ag-wallet-kv-list">
          <div className="ag-wallet-kv">
            <span className="ag-wallet-kv-label">
              {swap.direction === 'submarine' ? 'Original lockup amount' : 'Original Lightning amount'}
            </span>
            <span className="ag-wallet-kv-val tabular">
              {(swap.direction === 'submarine'
                ? swap.expectedOnchainSats
                : swap.amountSats
              ).toLocaleString()}{' '}
              sats
            </span>
          </div>
          <div className="ag-wallet-kv">
            <span className="ag-wallet-kv-label">
              {swap.direction === 'submarine' ? 'Wallet receives' : 'Bitcoin output'}
            </span>
            <span className="ag-wallet-kv-val tabular">
              {(swap.direction === 'submarine'
                ? swap.amountSats
                : swap.expectedOnchainSats
              ).toLocaleString()}{' '}
              sats
            </span>
          </div>
          <div className="ag-wallet-kv">
            <span className="ag-wallet-kv-label">Fee</span>
            <span className="ag-wallet-kv-val tabular">{swap.feeSats.toLocaleString()} sats</span>
          </div>
          {swap.destinationAddress && (
            <div className="ag-wallet-kv">
              <span className="ag-wallet-kv-label">Destination</span>
              <span className="ag-wallet-kv-val mono">{swap.destinationAddress}</span>
            </div>
          )}
          {swap.direction === 'reverse' && (
            <div className="ag-wallet-kv">
              <span className="ag-wallet-kv-label">Lockup</span>
              <a
                href={getMempoolAddressUrl(swap.address)}
                target="_blank"
                rel="noopener noreferrer"
                className="ag-wallet-kv-val mono"
              >
                {swap.address.slice(0, 12)}…{swap.address.slice(-6)}
              </a>
            </div>
          )}
        </div>

        {swap.error && (
          <div className="ag-wallet-banner danger">
            <AlertCircle size={14} />
            <span>{swap.error}</span>
          </div>
        )}

        <div className="ag-wallet-btn-row">
          <button
            type="button"
            className="ag-wbtn ag-wbtn-secondary ag-wbtn-sm ag-wbtn-grow"
            disabled={refreshingSwapId === swap.id}
            onClick={() => void handleRefreshSwap(swap.id)}
          >
            <RefreshCw
              size={13}
              className={refreshingSwapId === swap.id ? 'ag-wallet-spin' : undefined}
            />
            <span>Refresh</span>
          </button>

          <button
            type="button"
            className="ag-wbtn ag-wbtn-secondary ag-wbtn-sm ag-wbtn-grow"
            onClick={() => handleDownloadSwapRescue(swap.id)}
          >
            <Download size={13} />
            <span>{swap.direction === 'submarine' ? 'Refund file' : 'Recovery file'}</span>
          </button>

          {swap.txid && (
            <a
              href={getMempoolTxUrl(swap.txid)}
              target="_blank"
              rel="noopener noreferrer"
              className="ag-wbtn ag-wbtn-ghost ag-wbtn-sm"
              style={{ textDecoration: 'none' }}
            >
              <ExternalLink size={13} />
              <span>Mempool</span>
            </a>
          )}
        </div>
      </div>
    )
  }

  const lockedWalletBody = (
    <section className="ag-wallet-section" aria-label="Unlock Agwallet">
      <h3 className="ag-wallet-section-title">Agwallet is locked</h3>
      <p>Your balances and recovery records stay on this device. Enter your passphrase to use this wallet in this tab.</p>
      {feedback && <div className={`ag-wallet-banner ${feedback.kind}`} role="status">{feedback.text}</div>}
      <form onSubmit={(event) => {
        event.preventDefault()
        void handleUnlockWallet()
      }}>
        <label className="ag-wallet-label" htmlFor="ag-agwallet-unlock">Wallet passphrase</label>
        <input
          id="ag-agwallet-unlock"
          className="ag-wallet-input"
          type="password"
          autoComplete="current-password"
          maxLength={1024}
          value={walletPassphrase}
          onChange={(event) => setWalletPassphrase(event.target.value)}
          disabled={walletVaultBusy}
        />
        <button type="submit" className="ag-wbtn ag-wbtn-primary" disabled={!walletPassphrase || walletVaultBusy}>
          {walletVaultBusy ? 'Unlocking…' : 'Unlock Agwallet'}
        </button>
      </form>
      {wallet.boltzSwaps.length > 0 && (
        <div>
          <p>Existing Boltz recovery files are still available:</p>
          {wallet.boltzSwaps.map((swap) => (
            <button key={swap.id} type="button" className="ag-wbtn ag-wbtn-secondary"
              onClick={() => handleDownloadSwapRescue(swap.id)}>
              Recovery file · {swap.id}
            </button>
          ))}
        </div>
      )}
    </section>
  )

  const inSetupFlow = setupMode !== 'none'
  const showSetupBackBtn = canStepBackInSetup
  const activeTab: 'overview' | 'receive' | 'send' | 'mints' = tab === 'history' ? 'mints' : tab

  const stageHeaderTitle = inSetupFlow
    ? setupMode === 'create'
      ? 'New Agwallet'
      : setupMode === 'import'
        ? 'Import Agwallet'
        : 'Agwallet'
    : activeTab === 'overview'
      ? 'Overview'
      : activeTab === 'receive'
        ? 'Receive'
        : activeTab === 'send'
          ? 'Send'
          : 'Mints & Backup'

  const visibleHistory = showAllActivity ? wallet.history : wallet.history.slice(0, 8)

  const setupBody = (
    <>
      {feedback && (
        <div className={`ag-wallet-banner ${feedback.kind}`} role="status">
          {feedback.kind === 'danger' ? <AlertCircle size={15} /> : <Check size={15} />}
          <span>{feedback.text}</span>
        </div>
      )}

      {/* Mode 0: Choose Create or Import */}
      {setupMode === 'choose' && (
        <div className="ag-wallet-setup-choose">
          <h3 className="ag-wallet-setup-heading">Set up Agwallet</h3>
          <p className="ag-wallet-setup-sub">
            Create a new wallet or import an existing recovery phrase.
          </p>
          <div className="ag-wallet-setup-actions">
            <button
              type="button"
              className="ag-wbtn ag-wbtn-primary ag-wbtn-full"
              onClick={enterCreateMode}
            >
              Create New Agwallet
            </button>
            <button
              type="button"
              className="ag-wbtn ag-wbtn-secondary ag-wbtn-full"
              onClick={enterImportMode}
            >
              Import Agwallet
            </button>
          </div>
        </div>
      )}

      {/* Mode 1: Create New Wallet (12-word Recovery Phrase + Derived Private Key) */}
      {setupMode === 'create' && draftKeys && (
        <section className="ag-wallet-section">
          <div className="ag-wallet-label-row">
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.45rem' }}>
              <span className="ag-wallet-label">Recovery phrase</span>
              <span className="ag-wallet-pill accent">Save this</span>
            </div>
            <button
              type="button"
              className="ag-wbtn ag-wbtn-link"
              onClick={handleRegenerateDraft}
            >
              Regenerate
            </button>
          </div>

          {renderSeedGrid(draftKeys.mnemonic)}

          <div className="ag-wallet-field">
            <div className="ag-wallet-label-row">
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.45rem' }}>
                <span className="ag-wallet-label">Private key</span>
                <span className="ag-wallet-pill">Derived</span>
              </div>
              <button
                type="button"
                className="ag-wbtn ag-wbtn-link"
                onClick={() => setShowDraftPrivKey((v) => !v)}
              >
                {showDraftPrivKey ? 'Hide' : 'Show'}
              </button>
            </div>
            {showDraftPrivKey ? (
              <div className="ag-wallet-code-box" title={draftKeys.privateKeyHex}>
                {draftKeys.privateKeyHex}
              </div>
            ) : (
              <div className="ag-wallet-masked-key">••••••••••••••••••••••••••••••••</div>
            )}
          </div>

          <div className="ag-wallet-btn-row">
            <button
              type="button"
              className="ag-wbtn ag-wbtn-secondary ag-wbtn-sm ag-wbtn-grow"
              onClick={() => void markCopied('draft-phrase', draftKeys.mnemonic)}
            >
              {copiedKey === 'draft-phrase' ? <Check size={13} /> : <Copy size={13} />}
              <span>{copiedKey === 'draft-phrase' ? 'Copied' : 'Copy Phrase'}</span>
            </button>
            <button
              type="button"
              className="ag-wbtn ag-wbtn-secondary ag-wbtn-sm ag-wbtn-grow"
              onClick={() => void markCopied('draft-key', draftKeys.privateKeyHex)}
            >
              {copiedKey === 'draft-key' ? <Check size={13} /> : <KeyRound size={13} />}
              <span>{copiedKey === 'draft-key' ? 'Copied' : 'Copy Key'}</span>
            </button>
            <button
              type="button"
              className="ag-wbtn ag-wbtn-secondary ag-wbtn-sm ag-wbtn-grow"
              onClick={handleExportDraftKey}
            >
              <Download size={13} />
              <span>Export Key</span>
            </button>
          </div>

          <div className="ag-wallet-field">
            <label className="ag-wallet-label" htmlFor="ag-setup-create-mint">
              Starting mint
            </label>
            <select
              id="ag-setup-create-mint"
              className="ag-wallet-select-full"
              value={setupMintUrl}
              onChange={(e) => setSetupMintUrl(e.target.value)}
            >
              {wallet.mints.map((m) => (
                <option key={m.url} value={m.url}>
                  {m.label}
                  {m.info?.feePpk === 0 ? ' · No fee' : ''}
                </option>
              ))}
            </select>
          </div>

          <button
            type="button"
            className="ag-wbtn ag-wbtn-primary ag-wbtn-full"
            onClick={handleFinalizeCreateWallet}
          >
            Create Agwallet
          </button>
        </section>
      )}

      {/* Mode 2: Import Existing Recovery Phrase / Private Key / Backup File */}
      {setupMode === 'import' && (
        <section className="ag-wallet-section">
          <div className="ag-wallet-field">
            <div className="ag-wallet-label-row">
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.45rem' }}>
                <label className="ag-wallet-label" htmlFor="ag-setup-import-input">
                  Recovery phrase or backup
                </label>
                {detectedSetupImport && (
                  <span className="ag-wallet-pill accent">{detectedSetupImport.label}</span>
                )}
              </div>
              <div style={{ display: 'flex', gap: '0.35rem' }}>
                <button
                  type="button"
                  className="ag-wbtn ag-wbtn-link"
                  onClick={() => void handlePasteInto(setSetupImportInput)}
                >
                  Paste
                </button>
                <button
                  type="button"
                  className="ag-wbtn ag-wbtn-link"
                  onClick={() => setupImportFileRef.current?.click()}
                >
                  Import File
                </button>
                <input
                  ref={setupImportFileRef}
                  type="file"
                  accept="application/json,.json,.txt"
                  style={{ display: 'none' }}
                  onChange={handleSetupImportFile}
                />
              </div>
            </div>
            <textarea
              id="ag-setup-import-input"
              className="ag-wallet-textarea mono"
              value={setupImportInput}
              onChange={(e) => {
                setSetupImportInput(e.target.value)
                setFeedback(null)
              }}
              placeholder="12-word recovery phrase, private key, or backup file"
            />
          </div>

          <div className="ag-wallet-field">
            <label className="ag-wallet-label" htmlFor="ag-setup-import-mint">
              Starting mint
            </label>
            <select
              id="ag-setup-import-mint"
              className="ag-wallet-select-full"
              value={setupMintUrl}
              onChange={(e) => setSetupMintUrl(e.target.value)}
            >
              {wallet.mints.map((m) => (
                <option key={m.url} value={m.url}>
                  {m.label}
                  {m.info?.feePpk === 0 ? ' · No fee' : ''}
                </option>
              ))}
            </select>
          </div>

          <button
            type="button"
            className="ag-wbtn ag-wbtn-primary ag-wbtn-full"
            disabled={importingSetup || !detectedSetupImport}
            onClick={() => void handleFinalizeImportWallet()}
          >
            {importingSetup ? <Loader2 size={15} className="ag-wallet-spin" /> : null}
            <span>{importingSetup ? 'Importing & Scanning…' : 'Import & Restore'}</span>
          </button>
        </section>
      )}
    </>
  )

  const mainBody = (
    <>
      {/* Balance Hero (Full calm hero on Overview; compact bar only in modal fallback) */}
      {(activeTab === 'overview' || !embedded) && (
        <section
          className={`ag-wallet-hero ${activeTab !== 'overview' ? 'compact' : ''} ${embedded ? 'workspace-hero' : ''}`}
          aria-label="Agwallet balance"
        >
          <div className="ag-wallet-balance-block">
            <div className="ag-wallet-balance-amount">
              <span>{wallet.activeMintBalanceSats.toLocaleString()}</span>
              <span className="ag-wallet-balance-unit">sats</span>
            </div>
            {wallet.totalBalanceSats !== wallet.activeMintBalanceSats && (
              <span className="ag-wallet-balance-total tabular">
                Total: {wallet.totalBalanceSats.toLocaleString()} sats
              </span>
            )}
            {wallet.btcBalanceTotalSats > 0 && (
              <button
                type="button"
                className="ag-wallet-onchain-pill tabular"
                onClick={() => jumpToReceive('onchain')}
              >
                <Bitcoin size={12} />
                <span>On-chain BTC: {wallet.btcBalanceTotalSats.toLocaleString()} sats</span>
              </button>
            )}
          </div>

          {!embedded && (
            <div className="ag-wallet-mint-pill-row">
              <select
                className="ag-wallet-select"
                value={wallet.activeMintUrl}
                onChange={(e) => wallet.selectMint(e.target.value)}
                aria-label="Active Mint"
              >
                {wallet.mints.map((m) => (
                  <option key={m.url} value={m.url}>
                    {m.label} ({(wallet.balancesByMint[m.url] ?? 0).toLocaleString()} sats)
                  </option>
                ))}
              </select>

              {onOpenScanner && (
                <button
                  type="button"
                  className="ag-wallet-scan-icon-btn"
                  onClick={handleTriggerScanner}
                  aria-label="Scan QR"
                >
                  <ScanLine size={15} />
                </button>
              )}
            </div>
          )}

          {activeTab === 'overview' && (
            <div className="ag-wallet-hero-actions">
              <button
                type="button"
                className="ag-wbtn ag-wbtn-primary"
                onClick={() => switchTab('receive')}
              >
                <ArrowDownLeft size={15} />
                <span>Receive</span>
              </button>
              <button
                type="button"
                className="ag-wbtn ag-wbtn-secondary"
                onClick={() => switchTab('send')}
              >
                <ArrowUpRight size={15} />
                <span>Send</span>
              </button>
            </div>
          )}
        </section>
      )}

      {/* Global Feedback Strip */}
      {feedback && (
        <div className={`ag-wallet-banner ${feedback.kind}`} role="status">
          {feedback.kind === 'danger' ? <AlertCircle size={15} /> : <Check size={15} />}
          <span>{feedback.text}</span>
        </div>
      )}

      {/* ===================== TAB 1: OVERVIEW ===================== */}
      {activeTab === 'overview' && (
        <>
          {/* Empty Balance 1-Tap Quick-Start */}
          {wallet.totalBalanceSats === 0 && (
            <section className="ag-wallet-section" aria-label="Fund your Agwallet">
              <h3 className="ag-wallet-section-title">Add funds</h3>
              <div className="ag-wallet-fund-grid">
                <button
                  type="button"
                  className="ag-wallet-fund-btn"
                  onClick={() => jumpToReceive('lightning')}
                >
                  <Zap size={16} />
                  <span>Lightning</span>
                </button>
                <button
                  type="button"
                  className="ag-wallet-fund-btn"
                  onClick={() => jumpToReceive('onchain')}
                >
                  <Bitcoin size={16} />
                  <span>Bitcoin</span>
                </button>
                <button
                  type="button"
                  className="ag-wallet-fund-btn"
                  onClick={() => jumpToReceive('cashu')}
                >
                  <Coins size={16} />
                  <span>Ecash</span>
                </button>
              </div>
            </section>
          )}

          {/* Self-Contained Receive Zaps Card */}
          <section className="ag-wallet-zap-card" aria-label="Receive Zaps">
            <div className="ag-wallet-zap-head">
              <h3 className="ag-wallet-section-title">Receive Zaps</h3>
              <div className="ag-wallet-zap-pills">
                {zaps.zapMode === 'builtin' ? (
                  <span
                    className={`ag-wallet-pill ${zaps.npubCashAutoSweep ? 'accent' : ''}`}
                  >
                    {zaps.npubCashAutoSweep ? 'Auto-sweep' : 'Manual'}
                  </span>
                ) : (
                  <span className="ag-wallet-pill">Custom</span>
                )}
                {zaps.nutzapInfoPublished && (
                  <span className="ag-wallet-pill accent">NIP-61</span>
                )}
              </div>
            </div>

            {!editingCustomZap && activeZapAddress ? (
              <>
                <div className="ag-wallet-zap-addr-row">
                  <span
                    className="ag-wallet-zap-addr mono"
                    title={activeZapAddress}
                  >
                    {activeZapAddress}
                  </span>
                  <div className="ag-wallet-zap-addr-actions">
                    <button
                      type="button"
                      className="ag-wbtn ag-wbtn-secondary ag-wbtn-sm"
                      onClick={() => void markCopied('zap-addr', activeZapAddress)}
                      aria-label="Copy Zap address"
                    >
                      {copiedKey === 'zap-addr' ? <Check size={13} /> : <Copy size={13} />}
                      <span>{copiedKey === 'zap-addr' ? 'Copied' : 'Copy'}</span>
                    </button>
                    {activeZapQr && (
                      <button
                        type="button"
                        className={`ag-wbtn ag-wbtn-secondary ag-wbtn-sm${showOverviewZapQr ? ' active' : ''}`}
                        onClick={() => setShowOverviewZapQr((prev) => !prev)}
                        aria-expanded={showOverviewZapQr}
                        aria-label={showOverviewZapQr ? 'Hide Zap QR code' : 'Show Zap QR code'}
                      >
                        <QrCode size={13} />
                        <span>QR Code</span>
                      </button>
                    )}
                    {zaps.zapMode === 'builtin' ? (
                      <button
                        type="button"
                        className="ag-wbtn ag-wbtn-secondary ag-wbtn-sm"
                        disabled={zaps.npubCashSweeping}
                        onClick={() => void handleCheckZapsNow()}
                        aria-label="Check for incoming Zaps"
                      >
                        <RefreshCw
                          size={13}
                          className={zaps.npubCashSweeping ? 'ag-wallet-spin' : undefined}
                        />
                        <span>{zaps.npubCashSweeping ? 'Checking…' : 'Check Zaps'}</span>
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="ag-wbtn ag-wbtn-secondary ag-wbtn-sm"
                        onClick={() => {
                          setLud16Draft(zaps.customLightningAddress ?? activeZapAddress)
                          setEditingCustomZap(true)
                        }}
                      >
                        <span>Edit</span>
                      </button>
                    )}
                  </div>
                </div>

                {showOverviewZapQr && activeZapQr && (
                  <div className="ag-wallet-zap-qr-panel">
                    <QrBox
                      payload={activeZapQr.qrPayload}
                      label={`Lightning receive QR for ${activeZapAddress}`}
                    />
                    <div className="ag-wallet-zap-qr-addr mono" title={activeZapAddress}>
                      {activeZapAddress}
                    </div>
                    <div className="ag-wallet-btn-row" style={{ width: '100%' }}>
                      <button
                        type="button"
                        className="ag-wbtn ag-wbtn-secondary ag-wbtn-sm ag-wbtn-grow"
                        onClick={() => void markCopied('zap-qr-addr', activeZapAddress)}
                      >
                        {copiedKey === 'zap-qr-addr' ? <Check size={13} /> : <Copy size={13} />}
                        <span>{copiedKey === 'zap-qr-addr' ? 'Copied' : 'Copy Address'}</span>
                      </button>
                      <button
                        type="button"
                        className="ag-wbtn ag-wbtn-secondary ag-wbtn-sm ag-wbtn-grow"
                        onClick={() => void markCopied('zap-qr-lnurl', activeZapQr.lnurl)}
                      >
                        {copiedKey === 'zap-qr-lnurl' ? <Check size={13} /> : <Copy size={13} />}
                        <span>{copiedKey === 'zap-qr-lnurl' ? 'Copied' : 'Copy LNURL'}</span>
                      </button>
                    </div>
                  </div>
                )}

                {zaps.zapMode === 'builtin' ? (
                  <>
                    {zaps.npubCashLastError ? (
                      <div className="ag-wallet-zap-error" role="status">
                        <AlertCircle size={13} />
                        <span>{zaps.npubCashLastError}</span>
                      </div>
                    ) : (
                      <p className="ag-wallet-zap-meta">
                        {zaps.npubCashLastSweptAt
                          ? `Checked ${formatRelativeTime(zaps.npubCashLastSweptAt)} · Lightning Zaps & NIP-61 Nutzaps sweep straight into Agwallet`
                          : 'Lightning Zaps & NIP-61 Nutzaps sweep straight into Agwallet'}
                      </p>
                    )}

                    <div className="ag-wallet-zap-footer">
                      <label className="ag-wallet-zap-toggle">
                        <input
                          type="checkbox"
                          checked={zaps.npubCashAutoSweep}
                          onChange={(e) => zaps.setNpubCashAutoSweep(e.target.checked)}
                        />
                        <span className="ag-wallet-zap-switch" aria-hidden="true" />
                        <span>Auto-sweep</span>
                      </label>

                      <button
                        type="button"
                        className="ag-wbtn ag-wbtn-link"
                        onClick={() => {
                          setLud16Draft(zaps.customLightningAddress ?? '')
                          setEditingCustomZap(true)
                        }}
                      >
                        Use custom address
                      </button>
                    </div>
                  </>
                ) : (
                  <>
                    <p className="ag-wallet-zap-meta">
                      Custom Lightning address published to your profile for incoming Zaps
                    </p>
                    <div className="ag-wallet-zap-footer">
                      <button
                        type="button"
                        className="ag-wbtn ag-wbtn-link"
                        disabled={savingLud16 || zaps.publishingProfile}
                        onClick={() => void handleSwitchToBuiltinZaps()}
                      >
                        Switch back to built-in Agwallet Zaps
                      </button>
                    </div>
                  </>
                )}
              </>
            ) : (
              <>
                <div className="ag-wallet-input-row">
                  <input
                    id="ag-wallet-lud16"
                    type="text"
                    className="ag-wallet-input mono"
                    value={lud16Draft}
                    onChange={(e) => setLud16Draft(e.target.value)}
                    placeholder="you@domain.com"
                    aria-label="Custom Lightning address"
                  />
                  <button
                    type="button"
                    className="ag-wbtn ag-wbtn-secondary"
                    disabled={savingLud16 || zaps.publishingProfile}
                    onClick={() => void handleSaveLud16()}
                  >
                    {savingLud16 || zaps.publishingProfile ? (
                      <Loader2 size={14} className="ag-wallet-spin" />
                    ) : (
                      'Save'
                    )}
                  </button>
                </div>

                <div className="ag-wallet-zap-footer">
                  {zaps.zapMode === 'custom' && (
                    <button
                      type="button"
                      className="ag-wbtn ag-wbtn-link"
                      disabled={savingLud16 || zaps.publishingProfile}
                      onClick={() => void handleSwitchToBuiltinZaps()}
                    >
                      Switch back to built-in Agwallet Zaps
                    </button>
                  )}
                  {activeZapAddress && (
                    <button
                      type="button"
                      className="ag-wbtn ag-wbtn-link"
                      onClick={() => setEditingCustomZap(false)}
                    >
                      Cancel
                    </button>
                  )}
                </div>
              </>
            )}
          </section>

          {/* Legacy swap rescue, including failed or expired swaps. */}
          {savedBoltzSwaps.length > 0 && (
            <section className="ag-wallet-section">
              <h3 className="ag-wallet-section-title">Existing Boltz swaps</h3>
              {savedBoltzSwaps.map((sw) => renderSwapBlock(sw))}
            </section>
          )}

          {/* Funded Multi-Mint Breakdown */}
          {fundedMints.length > 1 && (
            <section className="ag-wallet-section">
              <div className="ag-wallet-section-head">
                <h3 className="ag-wallet-section-title">Mints</h3>
                <button
                  type="button"
                  className="ag-wbtn ag-wbtn-link"
                  onClick={() => switchTab('mints')}
                >
                  Manage
                </button>
              </div>
              <div className="ag-wallet-flat-list">
                {fundedMints.map((m) => {
                  const bal = wallet.balancesByMint[m.url] ?? 0
                  const isActive = m.url === wallet.activeMintUrl
                  return (
                    <div key={m.url} className="ag-wallet-mint-row">
                      <button
                        type="button"
                        className="ag-wallet-mint-main"
                        onClick={() => wallet.selectMint(m.url)}
                      >
                        <div className="ag-wallet-mint-info">
                          <span className="ag-wallet-mint-name">
                            {isActive && <span className="ag-wallet-active-dot" />}
                            <span className="truncate">{m.label}</span>
                          </span>
                          <span className="ag-wallet-mint-sub">
                            <span className="ag-wallet-mint-host">
                              {formatMintHost(m.url)}
                            </span>
                          </span>
                        </div>
                        <span className="ag-wallet-mint-bal">
                          {bal.toLocaleString()} sats
                        </span>
                      </button>
                    </div>
                  )
                })}
              </div>
            </section>
          )}

          {/* Activity */}
          <section className="ag-wallet-section">
            <div className="ag-wallet-section-head">
              <h3 className="ag-wallet-section-title">Activity</h3>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
                {wallet.history.length > 8 && (
                  <button
                    type="button"
                    className="ag-wbtn ag-wbtn-link"
                    onClick={() => setShowAllActivity((v) => !v)}
                  >
                    {showAllActivity ? 'Show less' : `View all (${wallet.history.length})`}
                  </button>
                )}
                {wallet.history.length > 0 && (
                  <button
                    type="button"
                    className="ag-wbtn ag-wbtn-ghost ag-wbtn-sm"
                    onClick={() => wallet.clearHistory()}
                  >
                    Clear
                  </button>
                )}
              </div>
            </div>

            {wallet.history.length === 0 ? (
              <div className="ag-wallet-empty">No activity yet</div>
            ) : (
              <div className="ag-wallet-flat-list">
                {visibleHistory.map((tx) => {
                  const incoming = isIncomingTx(tx.type)
                  return (
                    <div key={tx.id} className="ag-wallet-tx-item">
                      <div className="ag-wallet-tx-left">
                        <span className={`ag-wallet-tx-icon ${incoming ? 'in' : ''}`}>
                          {incoming ? (
                            <ArrowDownLeft size={14} />
                          ) : (
                            <ArrowUpRight size={14} />
                          )}
                        </span>
                        <div className="ag-wallet-tx-copy">
                          <span className="ag-wallet-tx-title truncate">
                            {formatTxLabel(tx.type)}
                          </span>
                          <span className="ag-wallet-tx-sub truncate">
                            {tx.memo || tx.counterparty || formatMintHost(tx.mintUrl)}
                            {tx.feeSats ? ` · ${tx.feeSats} sat fee` : ''}
                          </span>
                        </div>
                      </div>
                      <div className="ag-wallet-tx-right">
                        <span className={`ag-wallet-tx-amt ${incoming ? 'in' : ''}`}>
                          {incoming ? '+' : '-'}
                          {tx.amountSats.toLocaleString()} sats
                        </span>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
                          {tx.txid && (
                            <a
                              href={getMempoolTxUrl(tx.txid)}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="ag-wallet-tx-time"
                            >
                              tx ↗
                            </a>
                          )}
                          <span className="ag-wallet-tx-time">
                            {formatRelativeTime(tx.createdAt)}
                          </span>
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </section>
        </>
      )}

      {/* ===================== TAB 2: RECEIVE ===================== */}
      {activeTab === 'receive' && (
        <>
          <div className="ag-wallet-subtabs" role="tablist" aria-label="Receive method">
            <button
              type="button"
              role="tab"
              aria-selected={receiveMode === 'lightning'}
              className={`ag-wallet-subtab ${receiveMode === 'lightning' ? 'active' : ''}`}
              onClick={() => switchReceiveMode('lightning')}
            >
              <Zap size={13} />
              <span>Lightning</span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={receiveMode === 'onchain'}
              className={`ag-wallet-subtab ${receiveMode === 'onchain' ? 'active' : ''}`}
              onClick={() => switchReceiveMode('onchain')}
            >
              <Bitcoin size={13} />
              <span>Bitcoin</span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={receiveMode === 'cashu'}
              className={`ag-wallet-subtab ${receiveMode === 'cashu' ? 'active' : ''}`}
              onClick={() => switchReceiveMode('cashu')}
            >
              <Coins size={13} />
              <span>Ecash</span>
            </button>
          </div>

          {/* Receive: Ecash */}
          {receiveMode === 'cashu' && (
            <section className="ag-wallet-section">
              <div className="ag-wallet-field">
                <div className="ag-wallet-label-row">
                  <label className="ag-wallet-label" htmlFor="ag-cashu-receive-token">
                    Ecash token
                  </label>
                  <div style={{ display: 'flex', gap: '0.35rem' }}>
                    <button
                      type="button"
                      className="ag-wbtn ag-wbtn-link"
                      onClick={() => void handlePasteInto(setCashuReceiveInput)}
                    >
                      Paste
                    </button>
                    {onOpenScanner && (
                      <button
                        type="button"
                        className="ag-wbtn ag-wbtn-link"
                        onClick={handleTriggerScanner}
                      >
                        Scan
                      </button>
                    )}
                  </div>
                </div>
                <textarea
                  id="ag-cashu-receive-token"
                  className="ag-wallet-textarea mono"
                  value={cashuReceiveInput}
                  onChange={(e) => setCashuReceiveInput(e.target.value)}
                  placeholder="Paste ecash token…"
                />
              </div>

                      {cashuReceivePreview && (
                        <div className="ag-wallet-tonal">
                          <div className="ag-wallet-kv-list">
                            <div className="ag-wallet-kv">
                              <span className="ag-wallet-kv-label">Amount</span>
                              <span className="ag-wallet-kv-val tabular">
                                {cashuReceivePreview.amountSats.toLocaleString()} sats
                              </span>
                            </div>
                            <div className="ag-wallet-kv">
                              <span className="ag-wallet-kv-label">Mint</span>
                              <span className="ag-wallet-kv-val mono">
                                {formatMintHost(cashuReceivePreview.mintUrl)}
                              </span>
                            </div>
                            {cashuReceivePreview.memo && (
                              <div className="ag-wallet-kv">
                                <span className="ag-wallet-kv-label">Note</span>
                                <span className="ag-wallet-kv-val">
                                  {cashuReceivePreview.memo}
                                </span>
                              </div>
                            )}
                          </div>
                        </div>
                      )}

                      <button
                        type="button"
                        className="ag-wbtn ag-wbtn-primary ag-wbtn-full"
                        disabled={claimingToken || !cashuReceivePreview}
                        onClick={() => void handleClaimCashuToken()}
                      >
                        {claimingToken ? (
                          <Loader2 size={15} className="ag-wallet-spin" />
                        ) : (
                          <ArrowDownLeft size={15} />
                        )}
                        <span>
                          {claimingToken
                            ? 'Claiming…'
                            : cashuReceivePreview
                              ? `Claim ${cashuReceivePreview.amountSats.toLocaleString()} sats`
                              : 'Claim'}
                        </span>
                      </button>
                    </section>
                  )}

                  {/* Receive: Lightning (NUT-04 + Permanent LNURL Address) */}
                  {receiveMode === 'lightning' && (() => {
                    const permZapStrip = activeZapAddress ? (
                      <div className="ag-wallet-perm-zap-strip">
                        <div className="ag-wallet-perm-zap-head">
                          <div className="ag-wallet-perm-zap-copy">
                            <span className="ag-wallet-perm-zap-label">
                              Permanent Lightning Address
                            </span>
                            <span
                              className="ag-wallet-perm-zap-addr mono"
                              title={activeZapAddress}
                            >
                              {activeZapAddress}
                            </span>
                          </div>
                          <div className="ag-wallet-perm-zap-actions">
                            <button
                              type="button"
                              className="ag-wbtn ag-wbtn-secondary ag-wbtn-sm"
                              onClick={() => void markCopied('perm-zap', activeZapAddress)}
                              aria-label="Copy permanent Lightning address"
                            >
                              {copiedKey === 'perm-zap' ? <Check size={13} /> : <Copy size={13} />}
                              <span>{copiedKey === 'perm-zap' ? 'Copied' : 'Copy'}</span>
                            </button>
                            {activeZapQr && (
                              <button
                                type="button"
                                className={`ag-wbtn ag-wbtn-secondary ag-wbtn-sm${showPermLnQr ? ' active' : ''}`}
                                onClick={() => setShowPermLnQr((prev) => !prev)}
                                aria-expanded={showPermLnQr}
                                aria-label={
                                  showPermLnQr
                                    ? 'Hide Lightning address QR'
                                    : 'Show Lightning address QR'
                                }
                              >
                                <QrCode size={13} />
                                <span>{showPermLnQr ? 'Hide QR' : 'Show QR'}</span>
                              </button>
                            )}
                          </div>
                        </div>

                        {showPermLnQr && activeZapQr && (
                          <div className="ag-wallet-perm-zap-qr">
                            <QrBox
                              payload={activeZapQr.qrPayload}
                              label={`Lightning receive QR for ${activeZapAddress}`}
                            />
                            <div className="ag-wallet-zap-qr-addr mono" title={activeZapAddress}>
                              {activeZapAddress}
                            </div>
                            <div className="ag-wallet-btn-row" style={{ width: '100%' }}>
                              <button
                                type="button"
                                className="ag-wbtn ag-wbtn-secondary ag-wbtn-sm ag-wbtn-grow"
                                onClick={() => void markCopied('perm-zap-addr', activeZapAddress)}
                              >
                                {copiedKey === 'perm-zap-addr' ? (
                                  <Check size={13} />
                                ) : (
                                  <Copy size={13} />
                                )}
                                <span>
                                  {copiedKey === 'perm-zap-addr' ? 'Copied' : 'Copy Address'}
                                </span>
                              </button>
                              <button
                                type="button"
                                className="ag-wbtn ag-wbtn-secondary ag-wbtn-sm ag-wbtn-grow"
                                onClick={() => void markCopied('perm-zap-lnurl', activeZapQr.lnurl)}
                              >
                                {copiedKey === 'perm-zap-lnurl' ? (
                                  <Check size={13} />
                                ) : (
                                  <Copy size={13} />
                                )}
                                <span>
                                  {copiedKey === 'perm-zap-lnurl' ? 'Copied' : 'Copy LNURL'}
                                </span>
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    ) : null

                    return (
                      <section className="ag-wallet-section">
                        {wallet.activeMintQuote ? (
                          <>
                            <div className="ag-wallet-section-head">
                              <span className="ag-wallet-section-title tabular">
                                {wallet.activeMintQuote.amountSats.toLocaleString()} sats
                              </span>
                              <span
                                className={`ag-wallet-pill ${
                                  wallet.activeMintQuote.state === 'ISSUED'
                                    ? 'accent'
                                    : wallet.activeMintQuote.state === 'EXPIRED'
                                      ? 'danger'
                                      : 'warn'
                                }`}
                              >
                                {wallet.activeMintQuote.state === 'ISSUED'
                                  ? 'Paid'
                                  : wallet.activeMintQuote.state === 'EXPIRED'
                                    ? 'Expired'
                                    : 'Waiting…'}
                              </span>
                            </div>

                            {wallet.activeMintQuote.state !== 'ISSUED' ? (
                              <>
                                <div className="ag-wallet-qr-wrap">
                                  <QrBox
                                    payload={`lightning:${wallet.activeMintQuote.invoice.toUpperCase()}`}
                                    label="Lightning invoice QR code"
                                  />
                                  <div
                                    className="ag-wallet-code-box"
                                    title={wallet.activeMintQuote.invoice}
                                  >
                                    {wallet.activeMintQuote.invoice}
                                  </div>
                                </div>

                                <div className="ag-wallet-btn-row">
                                  <button
                                    type="button"
                                    className="ag-wbtn ag-wbtn-primary ag-wbtn-grow"
                                    onClick={() =>
                                      void markCopied('ln-inv', wallet.activeMintQuote!.invoice)
                                    }
                                  >
                                    {copiedKey === 'ln-inv' ? (
                                      <Check size={14} />
                                    ) : (
                                      <Copy size={14} />
                                    )}
                                    <span>{copiedKey === 'ln-inv' ? 'Copied' : 'Copy Invoice'}</span>
                                  </button>
                                  <button
                                    type="button"
                                    className="ag-wbtn ag-wbtn-secondary ag-wbtn-grow"
                                    disabled={checkingLnQuote}
                                    onClick={() => void handleManualCheckLnQuote()}
                                  >
                                    <RefreshCw
                                      size={14}
                                      className={checkingLnQuote ? 'ag-wallet-spin' : undefined}
                                    />
                                    <span>Check</span>
                                  </button>
                                </div>
                              </>
                            ) : (
                              <div className="ag-wallet-banner accent">
                                <Check size={15} />
                                <span>
                                  {wallet.activeMintQuote.amountSats.toLocaleString()} sats received
                                </span>
                              </div>
                            )}

                            <button
                              type="button"
                              className="ag-wbtn ag-wbtn-ghost ag-wbtn-sm ag-wbtn-full"
                              onClick={() => {
                                wallet.clearActiveMintQuote()
                                setShowPermLnQr(true)
                              }}
                            >
                              New Invoice
                            </button>

                            {permZapStrip}
                          </>
                        ) : (
                          <>
                            {permZapStrip}

                            <div className="ag-wallet-field">
                              <span className="ag-wallet-label">Amount (sats)</span>
                              <div className="ag-wallet-presets">
                                {RECEIVE_LN_PRESETS.map((amt) => (
                                  <button
                                    key={amt}
                                    type="button"
                                    className={`ag-wallet-preset-btn ${lnReceiveAmount === String(amt) ? 'active' : ''}`}
                                    onClick={() => setLnReceiveAmount(String(amt))}
                                  >
                                    {amt >= 1000 ? `${amt / 1000}k` : amt}
                                  </button>
                                ))}
                              </div>
                              <input
                                type="number"
                                inputMode="numeric"
                                min={1}
                                step={1}
                                className="ag-wallet-input tabular"
                                value={lnReceiveAmount}
                                onChange={(e) => setLnReceiveAmount(e.target.value)}
                                placeholder="Amount in sats"
                              />
                            </div>

                            <div className="ag-wallet-field">
                              <label className="ag-wallet-label" htmlFor="ag-ln-rec-memo">
                                Note (optional)
                              </label>
                              <input
                                id="ag-ln-rec-memo"
                                type="text"
                                maxLength={120}
                                className="ag-wallet-input"
                                value={lnReceiveMemo}
                                onChange={(e) => setLnReceiveMemo(e.target.value)}
                                placeholder="Optional note"
                              />
                            </div>

                            <button
                              type="button"
                              className="ag-wbtn ag-wbtn-primary ag-wbtn-full"
                              disabled={creatingLnQuote}
                              onClick={() => void handleCreateLnReceiveQuote()}
                            >
                              {creatingLnQuote ? (
                                <Loader2 size={15} className="ag-wallet-spin" />
                              ) : (
                                <Zap size={15} />
                              )}
                              <span>{creatingLnQuote ? 'Creating…' : 'Create Invoice'}</span>
                            </button>
                          </>
                        )}
                      </section>
                    )
                  })()}

                  {/* Receive: Core Blockchain Bitcoin (BIP-84 Native SegWit) + Optional Boltz Swap */}
                  {receiveMode === 'onchain' && (() => {
                    const boltzExpanded = showBoltzReceiveSwap || Boolean(activeSubSwap)

                    return (
                      <section className="ag-wallet-section">
                        <p className="ag-wallet-banner warn" role="status">
                          <AlertCircle size={15} />
                          Use an external Bitcoin wallet for new deposits. Agwallet keeps your legacy
                          address and balance visible so you can recover funds you already have here.
                        </p>
                        {wallet.btcAddress && (
                          <div className="ag-wallet-btc-card">
                            <div className="ag-wallet-btc-head">
                              <span className="ag-wallet-btc-head-title">
                                <Bitcoin size={14} />
                                <span>Legacy Agwallet balance</span>
                              </span>
                              <div className="ag-wallet-btc-head-right">
                                <span
                                  className={`ag-wallet-pill tabular ${
                                    wallet.btcBalanceTotalSats > 0 ? 'accent' : ''
                                  }`}
                                >
                                  {wallet.btcBalanceUnconfirmedSats > 0
                                    ? `${wallet.btcBalanceConfirmedSats.toLocaleString()} confirmed · +${wallet.btcBalanceUnconfirmedSats.toLocaleString()} pending`
                                    : `${wallet.btcBalanceConfirmedSats.toLocaleString()} sats`}
                                </span>
                                <button
                                  type="button"
                                  className="ag-wallet-btc-icon-btn"
                                  disabled={wallet.btcRefreshing}
                                  onClick={() => void wallet.refreshOnchainBtcBalance()}
                                  aria-label="Refresh on-chain Bitcoin balance"
                                  title="Refresh balance"
                                >
                                  <RefreshCw
                                    size={12}
                                    className={wallet.btcRefreshing ? 'ag-wallet-spin' : undefined}
                                  />
                                </button>
                                <a
                                  href={getMempoolAddressUrl(wallet.btcAddress)}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="ag-wallet-btc-mempool-link"
                                >
                                  <span>Mempool</span>
                                  <ExternalLink size={10} />
                                </a>
                              </div>
                            </div>

                            <p className="ag-wallet-btc-note mono" aria-label="Legacy Bitcoin address">
                              {wallet.btcAddress}
                            </p>
                            {wallet.btcError && (
                              <div className="ag-wallet-zap-error" role="status">
                                <AlertCircle size={13} />
                                <span>{wallet.btcError}</span>
                              </div>
                            )}
                          </div>
                        )}

                        {/* Collapsible Optional Boltz Swap BTC -> Ecash */}
                        <div className="ag-wallet-boltz-expander">
                          <button
                            type="button"
                            className="ag-wallet-boltz-expander-btn"
                            aria-expanded={boltzExpanded}
                            onClick={handleToggleBoltzReceiveSwap}
                          >
                            <span className="ag-wallet-boltz-expander-left">
                              {boltzExpanded ? (
                                <ChevronDown size={14} />
                              ) : (
                                <ChevronRight size={14} />
                              )}
                              <span>Swap BTC → Ecash (Boltz)</span>
                            </span>
                            {activeSubSwap && (
                              <span className="ag-wallet-pill warn">Active swap</span>
                            )}
                          </button>

                          {boltzExpanded && (
                            <>
                              {activeSubSwap && renderSwapBlock(activeSubSwap)}
                              <p className="ag-wallet-banner warn">{BOLTZ_NEW_SWAPS_PAUSED_MESSAGE}</p>
                            </>
                          )}
                        </div>
                      </section>
                    )
                  })()}
                </>
              )}

              {/* ===================== TAB 3: SEND ===================== */}
              {activeTab === 'send' && (
                <>
                  <div className="ag-wallet-subtabs" role="tablist" aria-label="Send method">
                    <button
                      type="button"
                      role="tab"
                      aria-selected={sendMode === 'cashu'}
                      className={`ag-wallet-subtab ${sendMode === 'cashu' ? 'active' : ''}`}
                      onClick={() => switchSendMode('cashu')}
                    >
                      <Coins size={13} />
                      <span>Ecash</span>
                    </button>
                    <button
                      type="button"
                      role="tab"
                      aria-selected={sendMode === 'lightning'}
                      className={`ag-wallet-subtab ${sendMode === 'lightning' ? 'active' : ''}`}
                      onClick={() => switchSendMode('lightning')}
                    >
                      <Zap size={13} />
                      <span>Lightning</span>
                    </button>
                    <button
                      type="button"
                      role="tab"
                      aria-selected={sendMode === 'onchain'}
                      className={`ag-wallet-subtab ${sendMode === 'onchain' ? 'active' : ''}`}
                      onClick={() => switchSendMode('onchain')}
                    >
                      <Bitcoin size={13} />
                      <span>Bitcoin</span>
                    </button>
                  </div>

                  {/* Send: Ecash */}
                  {sendMode === 'cashu' && (
                    <>
                      {freshSentToken ? (
                        <section className="ag-wallet-section">
                          <div className="ag-wallet-section-head">
                            <span className="ag-wallet-section-title tabular">
                              {freshSentToken.amountSats.toLocaleString()} sat Token
                            </span>
                            <span
                              className={`ag-wallet-pill ${freshSentToken.status === 'claimed' ? 'accent' : 'warn'}`}
                            >
                              {freshSentToken.status === 'claimed'
                                ? 'Claimed'
                                : freshSentToken.status === 'reclaimed'
                                  ? 'Reclaimed'
                                  : 'Unclaimed'}
                            </span>
                          </div>

                          <div className="ag-wallet-qr-wrap">
                            <QrBox payload={freshSentToken.token} label="Cashu token QR code" />
                            <div className="ag-wallet-code-box" title={freshSentToken.token}>
                              {freshSentToken.token}
                            </div>
                          </div>

                          <div className="ag-wallet-btn-row">
                            <button
                              type="button"
                              className="ag-wbtn ag-wbtn-primary ag-wbtn-grow"
                              onClick={() => void markCopied('fresh-tok', freshSentToken.token)}
                            >
                              {copiedKey === 'fresh-tok' ? <Check size={14} /> : <Copy size={14} />}
                              <span>{copiedKey === 'fresh-tok' ? 'Copied' : 'Copy Token'}</span>
                            </button>

                            {onSendToChat && (
                              <button
                                type="button"
                                className="ag-wbtn ag-wbtn-secondary ag-wbtn-grow"
                                disabled={sendingToChat}
                                onClick={() => void handleSendTokenToChat(freshSentToken)}
                              >
                                {sendingToChat ? (
                                  <Loader2 size={14} className="ag-wallet-spin" />
                                ) : (
                                  <Send size={14} />
                                )}
                                <span>
                                  {activeChatLabel ? `Send to ${activeChatLabel}` : 'Send to Chat'}
                                </span>
                              </button>
                            )}
                          </div>

                          {freshSentToken.status === 'unclaimed' && (
                            <div className="ag-wallet-btn-row">
                              <button
                                type="button"
                                className="ag-wbtn ag-wbtn-ghost ag-wbtn-sm ag-wbtn-grow"
                                disabled={checkingSentId === freshSentToken.id}
                                onClick={() => void handleCheckSentToken(freshSentToken.id)}
                              >
                                <RefreshCw
                                  size={13}
                                  className={
                                    checkingSentId === freshSentToken.id
                                      ? 'ag-wallet-spin'
                                      : undefined
                                  }
                                />
                                <span>Check</span>
                              </button>
                              <button
                                type="button"
                                className="ag-wbtn ag-wbtn-ghost ag-wbtn-sm ag-wbtn-grow"
                                disabled={checkingSentId === freshSentToken.id}
                                onClick={() => void handleReclaimSentToken(freshSentToken.id)}
                              >
                                <ArrowDownLeft size={13} />
                                <span>Reclaim</span>
                              </button>
                            </div>
                          )}

                          <button
                            type="button"
                            className="ag-wbtn ag-wbtn-ghost ag-wbtn-sm ag-wbtn-full"
                            onClick={() => setFreshSentToken(null)}
                          >
                            New Token
                          </button>
                        </section>
                      ) : (
                        <section className="ag-wallet-section">
                          <div className="ag-wallet-field">
                            <div className="ag-wallet-label-row">
                              <label className="ag-wallet-label" htmlFor="ag-cashu-send-amt">
                                Amount (sats)
                              </label>
                              <button
                                type="button"
                                className="ag-wbtn ag-wbtn-link"
                                disabled={wallet.activeMintBalanceSats <= 0}
                                onClick={() =>
                                  setCashuSendAmount(String(wallet.activeMintBalanceSats))
                                }
                              >
                                Max ({wallet.activeMintBalanceSats.toLocaleString()})
                              </button>
                            </div>
                            <input
                              id="ag-cashu-send-amt"
                              type="number"
                              inputMode="numeric"
                              min={1}
                              step={1}
                              className="ag-wallet-input tabular"
                              value={cashuSendAmount}
                              onChange={(e) => setCashuSendAmount(e.target.value)}
                              placeholder="Amount in sats"
                            />
                          </div>

                          <div className="ag-wallet-field">
                            <label className="ag-wallet-label" htmlFor="ag-cashu-send-memo">
                              Note (optional)
                            </label>
                            <input
                              id="ag-cashu-send-memo"
                              type="text"
                              maxLength={120}
                              className="ag-wallet-input"
                              value={cashuSendMemo}
                              onChange={(e) => setCashuSendMemo(e.target.value)}
                              placeholder="Optional note"
                            />
                          </div>

                          <button
                            type="button"
                            className="ag-wbtn ag-wbtn-primary ag-wbtn-full"
                            disabled={creatingToken || wallet.activeMintBalanceSats <= 0}
                            onClick={() => void handleCreateCashuToken()}
                          >
                            {creatingToken ? (
                              <Loader2 size={15} className="ag-wallet-spin" />
                            ) : (
                              <Coins size={15} />
                            )}
                            <span>{creatingToken ? 'Creating…' : 'Create Token'}</span>
                          </button>
                        </section>
                      )}

                      {wallet.sentTokens.some((s) => s.status === 'unclaimed') && (
                        <section className="ag-wallet-section">
                          <h3 className="ag-wallet-section-title">Pending Tokens</h3>
                          <div className="ag-wallet-flat-list">
                            {wallet.sentTokens
                              .filter((s) => s.status === 'unclaimed')
                              .slice(0, 5)
                              .map((st) => (
                                <div key={st.id} className="ag-wallet-mint-row">
                                  <div className="ag-wallet-mint-main">
                                    <div className="ag-wallet-mint-info">
                                      <span className="ag-wallet-mint-name tabular">
                                        {st.amountSats.toLocaleString()} sats
                                      </span>
                                      <span className="ag-wallet-mint-sub">
                                        <span className="truncate">
                                          {st.memo || formatMintHost(st.mintUrl)} ·{' '}
                                          {formatRelativeTime(st.createdAt)}
                                        </span>
                                      </span>
                                    </div>
                                    <div className="ag-wallet-mint-actions">
                                      <button
                                        type="button"
                                        className="ag-wbtn ag-wbtn-ghost ag-wbtn-sm"
                                        onClick={() => void markCopied(`st-${st.id}`, st.token)}
                                      >
                                        {copiedKey === `st-${st.id}` ? 'Copied' : 'Copy'}
                                      </button>
                                      <button
                                        type="button"
                                        className="ag-wbtn ag-wbtn-ghost ag-wbtn-sm"
                                        disabled={checkingSentId === st.id}
                                        onClick={() => void handleCheckSentToken(st.id)}
                                      >
                                        Check
                                      </button>
                                      <button
                                        type="button"
                                        className="ag-wbtn ag-wbtn-link"
                                        disabled={checkingSentId === st.id}
                                        onClick={() => void handleReclaimSentToken(st.id)}
                                      >
                                        Reclaim
                                      </button>
                                    </div>
                                  </div>
                                </div>
                              ))}
                          </div>
                        </section>
                      )}
                    </>
                  )}

                  {/* Send: Lightning (NUT-05) */}
                  {sendMode === 'lightning' && (
                    <section className="ag-wallet-section">
                      <div className="ag-wallet-field">
                        <div className="ag-wallet-label-row">
                          <label className="ag-wallet-label" htmlFor="ag-ln-send-target">
                            Invoice or address
                          </label>
                          <button
                            type="button"
                            className="ag-wbtn ag-wbtn-link"
                            onClick={() => void handlePasteInto(setLnSendInput)}
                          >
                            Paste
                          </button>
                        </div>
                        <textarea
                          id="ag-ln-send-target"
                          className="ag-wallet-textarea mono"
                          value={lnSendInput}
                          onChange={(e) => {
                            setLnSendInput(e.target.value)
                            setMeltPreview(null)
                          }}
                          placeholder="lnbc… or user@domain.com"
                        />
                      </div>

                      {parsedLnSend && parsedLnSend.kind !== 'bolt11' && (
                        <>
                          <div className="ag-wallet-field">
                            <label className="ag-wallet-label" htmlFor="ag-ln-send-amt">
                              Amount (sats)
                            </label>
                            <input
                              id="ag-ln-send-amt"
                              type="number"
                              inputMode="numeric"
                              min={1}
                              step={1}
                              className="ag-wallet-input tabular"
                              value={lnSendAmount}
                              onChange={(e) => {
                                setLnSendAmount(e.target.value)
                                setMeltPreview(null)
                              }}
                              placeholder="Amount in sats"
                            />
                          </div>

                          <div className="ag-wallet-field">
                            <label className="ag-wallet-label" htmlFor="ag-ln-send-comment">
                              Note (optional)
                            </label>
                            <input
                              id="ag-ln-send-comment"
                              type="text"
                              maxLength={140}
                              className="ag-wallet-input"
                              value={lnSendComment}
                              onChange={(e) => setLnSendComment(e.target.value)}
                              placeholder="Optional note"
                            />
                          </div>
                        </>
                      )}

                      {meltPreview ? (
                        <>
                          <div className="ag-wallet-tonal">
                            <div className="ag-wallet-kv-list">
                              <div className="ag-wallet-kv">
                                <span className="ag-wallet-kv-label">Amount</span>
                                <span className="ag-wallet-kv-val tabular">
                                  {meltPreview.amountSats.toLocaleString()} sats
                                </span>
                              </div>
                              <div className="ag-wallet-kv">
                                <span className="ag-wallet-kv-label">Fee reserve</span>
                                <span className="ag-wallet-kv-val tabular">
                                  {meltPreview.feeReserveSats.toLocaleString()} sats
                                </span>
                              </div>
                              <div className="ag-wallet-kv">
                                <span className="ag-wallet-kv-label">Total</span>
                                <span className="ag-wallet-kv-val tabular">
                                  {meltPreview.totalRequiredSats.toLocaleString()} sats
                                </span>
                              </div>
                            </div>
                          </div>

                          <div className="ag-wallet-btn-row">
                            <button
                              type="button"
                              className="ag-wbtn ag-wbtn-primary ag-wbtn-grow"
                              disabled={payingMelt}
                              onClick={() => void handleConfirmMelt()}
                            >
                              {payingMelt ? (
                                <Loader2 size={15} className="ag-wallet-spin" />
                              ) : (
                                <Zap size={15} />
                              )}
                              <span>{payingMelt ? 'Paying…' : 'Pay'}</span>
                            </button>
                            <button
                              type="button"
                              className="ag-wbtn ag-wbtn-secondary"
                              disabled={payingMelt}
                              onClick={() => setMeltPreview(null)}
                            >
                              Cancel
                            </button>
                          </div>
                        </>
                      ) : (
                        <button
                          type="button"
                          className="ag-wbtn ag-wbtn-primary ag-wbtn-full"
                          disabled={preparingMelt || !parsedLnSend}
                          onClick={() => void handlePrepareMelt()}
                        >
                          {preparingMelt ? (
                            <Loader2 size={15} className="ag-wallet-spin" />
                          ) : (
                            <Zap size={15} />
                          )}
                          <span>
                            {preparingMelt
                              ? 'Preparing…'
                              : parsedLnSend?.kind === 'bolt11' && parsedLnSend.amountSats
                                ? `Continue (${parsedLnSend.amountSats.toLocaleString()} sats)`
                                : 'Continue'}
                          </span>
                        </button>
                      )}
                    </section>
                  )}

                  {/* Send: Bitcoin (Core BIP-84 Native + Optional Boltz Swap) */}
                  {sendMode === 'onchain' && (() => {
                    const amountText = nativeBtcSendAmount.trim()
                    const parsedNativeSendSats = /^\d+$/.test(amountText) ? Number(amountText) : 0
                    const activeReview = nativeBtcReview?.fromAddress === wallet.btcAddress ? nativeBtcReview : null
                    const pendingSend = wallet.btcPendingSend?.fromAddress === wallet.btcAddress
                      ? wallet.btcPendingSend : null
                    const sendDetails = pendingSend ?? activeReview
                    const estNativeMaxFee = Math.ceil(
                      (10.5 + 68 * Math.max(1, wallet.btcUtxoCount) + 31) *
                        selectedNativeFeeRateSatVb
                    )
                    const maxNativeSendSats = Math.max(
                      0,
                      wallet.btcBalanceTotalSats - estNativeMaxFee
                    )
                    const canSendNativeBtc =
                      !sendingNativeBtc &&
                      isValidBitcoinAddress(nativeBtcSendAddress.trim()) &&
                      Number.isSafeInteger(parsedNativeSendSats) &&
                      parsedNativeSendSats >= BITCOIN_DUST_LIMIT_SATS &&
                      wallet.btcBalanceTotalSats > 0 &&
                      parsedNativeSendSats <= wallet.btcBalanceTotalSats

                    return (
                      <section className="ag-wallet-section">
                        <div
                          className="ag-wallet-btc-mode-switch"
                          role="group"
                          aria-label="Bitcoin send source"
                        >
                          <button
                            type="button"
                            className={`ag-wallet-btc-mode-btn${btcSendSource === 'core' ? ' active' : ''}`}
                            aria-pressed={btcSendSource === 'core'}
                            onClick={() => handleSelectBtcSendSource('core')}
                          >
                            Core Bitcoin
                          </button>
                          <button
                            type="button"
                            className={`ag-wallet-btc-mode-btn${btcSendSource === 'boltz' ? ' active' : ''}`}
                            aria-pressed={btcSendSource === 'boltz'}
                            onClick={() => handleSelectBtcSendSource('boltz')}
                          >
                            Swap Ecash → BTC (Boltz)
                          </button>
                        </div>

                        {btcSendSource === 'core' ? (
                          <>
                            <div className="ag-wallet-rate-line">
                              <span className="truncate tabular">
                                {wallet.btcBalanceUnconfirmedSats > 0
                                  ? `On-chain: ${wallet.btcBalanceConfirmedSats.toLocaleString()} conf · +${wallet.btcBalanceUnconfirmedSats.toLocaleString()} pend`
                                  : `On-chain balance: ${wallet.btcBalanceTotalSats.toLocaleString()} sats`}
                              </span>
                              <button
                                type="button"
                                className="ag-wbtn ag-wbtn-ghost ag-wbtn-sm"
                                disabled={wallet.btcRefreshing}
                                onClick={() => void wallet.refreshOnchainBtcBalance()}
                                aria-label="Refresh on-chain Bitcoin balance"
                                title="Refresh balance"
                              >
                                <RefreshCw
                                  size={12}
                                  className={wallet.btcRefreshing ? 'ag-wallet-spin' : undefined}
                                />
                              </button>
                            </div>

                            {wallet.btcError && (
                              <div className="ag-wallet-zap-error" role="status">
                                <AlertCircle size={13} />
                                <span>{wallet.btcError}</span>
                              </div>
                            )}

                            {nativeBtcSentResult && !pendingSend && (
                              <div className="ag-wallet-tx-confirm" role="status">
                                <div className="ag-wallet-tx-confirm-head">
                                  <span className="ag-wallet-tx-confirm-head-left">
                                    <Check size={14} />
                                    <span className="tabular">
                                      Sent {nativeBtcSentResult.sentSats.toLocaleString()} sats
                                    </span>
                                  </span>
                                  <button
                                    type="button"
                                    className="ag-wbtn ag-wbtn-ghost ag-wbtn-sm"
                                    onClick={() => setNativeBtcSentResult(null)}
                                    aria-label="Dismiss transaction confirmation"
                                  >
                                    <X size={12} />
                                  </button>
                                </div>
                                <span className="ag-wallet-meta tabular">
                                  Fee: {nativeBtcSentResult.feeSats.toLocaleString()} sats · TXID:{' '}
                                  <span className="mono">
                                    {nativeBtcSentResult.txid.slice(0, 10)}…
                                    {nativeBtcSentResult.txid.slice(-6)}
                                  </span>
                                </span>
                                <a
                                  href={getMempoolTxUrl(nativeBtcSentResult.txid)}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="ag-wallet-tx-confirm-link"
                                >
                                  <span>
                                    mempool.space/tx/{nativeBtcSentResult.txid.slice(0, 12)}…
                                  </span>
                                  <ExternalLink size={11} />
                                </a>
                              </div>
                            )}

                            {wallet.btcBalanceTotalSats === 0 && !nativeBtcSentResult && !pendingSend && (
                              <span className="ag-wallet-meta">
                                No on-chain BTC yet.{' '}
                                <button
                                  type="button"
                                  className="ag-wbtn ag-wbtn-link"
                                  style={{ display: 'inline', padding: 0 }}
                                  onClick={() => jumpToReceive('onchain')}
                                >
                                  View your Bitcoin address
                                </button>
                                {' or use Swap Ecash → BTC.'}
                              </span>
                            )}

                            {sendDetails ? (
                              <div className="ag-wallet-field" aria-label="Bitcoin send review">
                                <strong>{pendingSend?.acknowledged
                                  ? 'Broadcast acknowledged by explorer'
                                  : pendingSend ? 'Broadcast not yet verified' : 'Review this Bitcoin transaction'}</strong>
                                <span className="ag-wallet-meta">To</span>
                                <div className="ag-wallet-code-box" style={{ overflowWrap: 'anywhere', whiteSpace: 'normal' }}>
                                  {sendDetails.toAddress}
                                </div>
                                <span>Amount: {sendDetails.amountSats.toLocaleString()} sats</span>
                                <span>Miner fee: {sendDetails.feeSats.toLocaleString()} sats</span>
                                <span>Total: {(sendDetails.amountSats + sendDetails.feeSats).toLocaleString()} sats</span>
                                {pendingSend ? (
                                  <>
                                    <a href={getMempoolTxUrl(pendingSend.txid)} target="_blank" rel="noreferrer">Check transaction in explorer</a>
                                    <span className="ag-wallet-meta">{pendingSend.acknowledged
                                      ? 'This transaction may not be confirmed by the Bitcoin network yet.'
                                      : 'Retry checks or re-broadcasts the same signed transaction. It does not create another payment.'}</span>
                                  </>
                                ) : (
                                  <button type="button" className="ag-wbtn ag-wbtn-ghost" disabled={sendingNativeBtc}
                                    onClick={() => setNativeBtcReview(null)}>Edit transaction</button>
                                )}
                                <button type="button" className="ag-wbtn ag-wbtn-primary ag-wbtn-full" disabled={sendingNativeBtc}
                                  onClick={() => pendingSend?.acknowledged
                                    ? void handleDismissNativeBtc(pendingSend.txid)
                                    : void handleSendNativeBtc(pendingSend?.txid)}>
                                  {sendingNativeBtc ? 'Working…' : pendingSend?.acknowledged
                                    ? 'Done' : pendingSend ? 'Check or retry same transaction' : 'Confirm and send Bitcoin'}
                                </button>
                              </div>
                            ) : (
                              <fieldset className="ag-wallet-section" style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }} disabled={sendingNativeBtc}>
                                <div className="ag-wallet-field">
                                  <div className="ag-wallet-label-row">
                                    <label
                                      className="ag-wallet-label"
                                      htmlFor="ag-native-btc-send-addr"
                                    >
                                      Bitcoin Address
                                    </label>
                                    <button
                                      type="button"
                                      className="ag-wbtn ag-wbtn-link"
                                      onClick={() => void handlePasteInto(setNativeBtcSendAddress)}
                                    >
                                      Paste
                                    </button>
                                  </div>
                                  <input
                                    id="ag-native-btc-send-addr"
                                    type="text"
                                    className="ag-wallet-input mono"
                                    value={nativeBtcSendAddress}
                                    onChange={(e) => setNativeBtcSendAddress(e.target.value)}
                                    placeholder="bc1q… / bc1p… / 1… / 3…"
                                  />
                                </div>

                                <div className="ag-wallet-field">
                                  <div className="ag-wallet-label-row">
                                    <label
                                      className="ag-wallet-label"
                                      htmlFor="ag-native-btc-send-amt"
                                    >
                                      Amount (sats)
                                    </label>
                                    <button
                                      type="button"
                                      className="ag-wbtn ag-wbtn-link tabular"
                                      disabled={maxNativeSendSats < BITCOIN_DUST_LIMIT_SATS}
                                      onClick={() => setNativeBtcSendAmount(String(maxNativeSendSats))}
                                    >
                                      Max ({maxNativeSendSats.toLocaleString()})
                                    </button>
                                  </div>
                                  <input
                                    id="ag-native-btc-send-amt"
                                    type="number"
                                    inputMode="numeric"
                                    min={BITCOIN_DUST_LIMIT_SATS}
                                    step={1}
                                    className="ag-wallet-input tabular"
                                    value={nativeBtcSendAmount}
                                    onChange={(e) => setNativeBtcSendAmount(e.target.value)}
                                    placeholder={`Min ${BITCOIN_DUST_LIMIT_SATS.toLocaleString()} sats`}
                                  />
                                  <span className="ag-wallet-meta tabular">
                                    Available: {wallet.btcBalanceTotalSats.toLocaleString()} sats · Est.
                                    fee ~{estNativeMaxFee.toLocaleString()} sats (
                                    {selectedNativeFeeRateSatVb} sat/vB)
                                  </span>
                                </div>

                                <div className="ag-wallet-field">
                                  <div className="ag-wallet-label-row">
                                    <span className="ag-wallet-label">Fee Priority</span>
                                    <button
                                      type="button"
                                      className="ag-wbtn ag-wbtn-ghost ag-wbtn-sm"
                                      disabled={btcFeeRatesLoading}
                                      onClick={() => void loadBtcFeeRates()}
                                      aria-label="Refresh Bitcoin fee rates"
                                      title="Refresh fee rates"
                                    >
                                      <RefreshCw
                                        size={11}
                                        className={btcFeeRatesLoading ? 'ag-wallet-spin' : undefined}
                                      />
                                      <span>{btcFeeRatesLoading ? 'Updating…' : 'Rates'}</span>
                                    </button>
                                  </div>
                                  <div
                                    className="ag-wallet-fee-grid"
                                    role="group"
                                    aria-label="Bitcoin fee priority"
                                  >
                                    {(
                                      [
                                        {
                                          id: 'economy',
                                          label: 'Economy',
                                          rate: effectiveBtcFeeRates.economyFee,
                                        },
                                        {
                                          id: 'standard',
                                          label: 'Standard',
                                          rate: effectiveBtcFeeRates.halfHourFee,
                                        },
                                        {
                                          id: 'priority',
                                          label: 'Priority',
                                          rate: effectiveBtcFeeRates.fastestFee,
                                        },
                                      ] as const
                                    ).map((opt) => (
                                      <button
                                        key={opt.id}
                                        type="button"
                                        className={`ag-wallet-fee-btn${nativeBtcFeePriority === opt.id ? ' active' : ''}`}
                                        aria-pressed={nativeBtcFeePriority === opt.id}
                                        onClick={() => setNativeBtcFeePriority(opt.id)}
                                      >
                                        <span className="ag-wallet-fee-name">{opt.label}</span>
                                        <span className="ag-wallet-fee-rate">
                                          {opt.rate} sat/vB
                                        </span>
                                      </button>
                                    ))}
                                  </div>
                                </div>

                                <button
                                  type="button"
                                  className="ag-wbtn ag-wbtn-primary ag-wbtn-full"
                                  disabled={!canSendNativeBtc}
                                  onClick={() => void handleReviewNativeBtc()}
                                >
                                  {sendingNativeBtc ? (
                                    <Loader2 size={15} className="ag-wallet-spin" />
                                  ) : (
                                    <Bitcoin size={15} />
                                  )}
                                  <span>{sendingNativeBtc ? 'Preparing…' : 'Review Bitcoin Send'}</span>
                                </button>
                              </fieldset>
                            )}
                          </>
                        ) : (
                          <>
                            {activeRevSwap && renderSwapBlock(activeRevSwap)}
                            <p className="ag-wallet-banner warn">{BOLTZ_NEW_SWAPS_PAUSED_MESSAGE}</p>
                          </>
                        )}
                      </section>
                    )
                  })()}
                </>
              )}

              {/* ===================== TAB 4: MINTS & BACKUP ===================== */}
              {activeTab === 'mints' && (
                <>
                  <section className="ag-wallet-section">
                    <h3 className="ag-wallet-section-title">Mints</h3>
                    <div className="ag-wallet-input-row">
                      <input
                        type="url"
                        className="ag-wallet-input mono"
                        value={customMintUrl}
                        onChange={(e) => setCustomMintUrl(e.target.value)}
                        placeholder="https://mint.example.com"
                        aria-label="Add mint URL"
                      />
                      <button
                        type="button"
                        className="ag-wbtn ag-wbtn-primary"
                        disabled={addingMint || !customMintUrl.trim()}
                        onClick={() => void handleAddMint()}
                      >
                        {addingMint ? (
                          <Loader2 size={14} className="ag-wallet-spin" />
                        ) : (
                          <Plus size={14} />
                        )}
                        <span>Add</span>
                      </button>
                    </div>

                    <div className="ag-wallet-flat-list" aria-label="Configured mints">
                      {wallet.mints.map((mint) => {
                        const bal = wallet.balancesByMint[mint.url] ?? 0
                        const count = wallet.proofCountByMint[mint.url] ?? 0
                        const isActive = mint.url === wallet.activeMintUrl
                        const canRemove = bal === 0 && wallet.mints.length > 1
                        const feeLabel =
                          mint.info?.feePpk !== undefined && mint.info.feePpk !== null
                            ? mint.info.feePpk === 0
                              ? 'No fee'
                              : `${mint.info.feePpk} ppk`
                            : null

                        return (
                          <div key={mint.url} className="ag-wallet-mint-row">
                            <button
                              type="button"
                              className="ag-wallet-mint-main"
                              onClick={() => wallet.selectMint(mint.url)}
                            >
                              <div className="ag-wallet-mint-info">
                                <span className="ag-wallet-mint-name">
                                  {isActive && (
                                    <span className="ag-wallet-active-dot" aria-label="Active mint" />
                                  )}
                                  <span className="truncate">{mint.label}</span>
                                </span>
                                <span className="ag-wallet-mint-sub">
                                  <span className="ag-wallet-mint-host" title={mint.url}>
                                    {formatMintHost(mint.url)}
                                  </span>
                                  {feeLabel && <span>· {feeLabel}</span>}
                                </span>
                              </div>
                              <div className="ag-wallet-mint-bal">
                                <div>{bal.toLocaleString()} sats</div>
                              </div>
                            </button>

                            <div className="ag-wallet-mint-actions">
                              <button
                                type="button"
                                className="ag-wbtn ag-wbtn-ghost ag-wbtn-sm"
                                disabled={inspectingMintUrl === mint.url}
                                onClick={() => void handleInspectMint(mint.url)}
                              >
                                <RefreshCw
                                  size={12}
                                  className={
                                    inspectingMintUrl === mint.url ? 'ag-wallet-spin' : undefined
                                  }
                                />
                                <span>Check</span>
                              </button>
                              {count > 0 && (
                                <button
                                  type="button"
                                  className="ag-wbtn ag-wbtn-ghost ag-wbtn-sm"
                                  disabled={verifyingMintUrl === mint.url}
                                  onClick={() => void handleVerifyMintProofs(mint.url)}
                                >
                                  <span>
                                    {verifyingMintUrl === mint.url ? 'Checking…' : 'Verify'}
                                  </span>
                                </button>
                              )}
                              {canRemove && (
                                <button
                                  type="button"
                                  className="ag-wbtn ag-wbtn-ghost ag-wbtn-sm"
                                  onClick={() => wallet.removeMint(mint.url)}
                                  title="Remove mint"
                                  aria-label={`Remove ${mint.label}`}
                                >
                                  <Trash2 size={12} />
                                </button>
                              )}
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  </section>

                  {/* Always-Accessible Recovery Phrase & Backup */}
                  <section className="ag-wallet-section ag-wallet-divider-top">
                    <div className="ag-wallet-section-head">
                      <h3 className="ag-wallet-section-title">Recovery &amp; Backup</h3>
                      <button
                        type="button"
                        className="ag-wbtn ag-wbtn-ghost ag-wbtn-sm"
                        onClick={() => setRevealKeys((v) => !v)}
                      >
                        {revealKeys ? <EyeOff size={13} /> : <Eye size={13} />}
                        <span>{revealKeys ? 'Hide' : 'Reveal'}</span>
                      </button>
                    </div>

                    <div className="ag-wallet-section">
                      {wallet.credentialsEncrypted ? (
                        <button type="button" className="ag-wbtn ag-wbtn-secondary"
                          onClick={handleLockWallet} disabled={wallet.busy}>
                          Lock Agwallet in this tab
                        </button>
                      ) : (wallet.mnemonic || wallet.privateKeyHex) && (
                        <button type="button" className="ag-wbtn ag-wbtn-secondary"
                          onClick={() => setShowProtectWallet(true)} disabled={wallet.busy || showProtectWallet}>
                          Encrypt saved recovery phrase and key
                        </button>
                      )}
                      {showProtectWallet && (
                        <form className="ag-wallet-field" onSubmit={(event) => {
                          event.preventDefault()
                          void handleProtectWallet()
                        }}>
                          <p className="ag-wallet-banner warn">
                            Back up your phrase or key offline, then close all other Agnostr tabs and app windows.
                            If you lose the passphrase, you will need that backup. This encrypts only the saved
                            phrase and key. Cashu proofs and Boltz recovery files remain local and unencrypted.
                            An unlocked wallet is still exposed to code running in Agnostr. Earlier backups and
                            previously synced copies are not revoked.
                          </p>
                          <button type="button" className="ag-wbtn ag-wbtn-secondary"
                            onClick={handleExportBackupFile} disabled={walletVaultBusy}>
                            Export plaintext backup
                          </button>
                          <label className="ag-wallet-label" htmlFor="ag-agwallet-new-passphrase">Unique wallet passphrase</label>
                          <input id="ag-agwallet-new-passphrase" className="ag-wallet-input" type="password"
                            autoComplete="new-password" minLength={16} maxLength={1024} value={walletPassphrase}
                            onChange={(event) => setWalletPassphrase(event.target.value)} disabled={walletVaultBusy} />
                          <label className="ag-wallet-label" htmlFor="ag-agwallet-repeat-passphrase">Confirm passphrase</label>
                          <input id="ag-agwallet-repeat-passphrase" className="ag-wallet-input" type="password"
                            autoComplete="new-password" minLength={16} maxLength={1024} value={repeatWalletPassphrase}
                            onChange={(event) => setRepeatWalletPassphrase(event.target.value)} disabled={walletVaultBusy} />
                          <label>
                            <input type="checkbox" checked={walletBackupConfirmed}
                              onChange={(event) => setWalletBackupConfirmed(event.target.checked)} disabled={walletVaultBusy} />
                            {' '}I verified my offline recovery backup and closed all other Agnostr tabs and windows.
                          </label>
                          <div className="ag-wallet-btn-row">
                            <button type="submit" className="ag-wbtn ag-wbtn-primary"
                              disabled={walletVaultBusy || wallet.busy || !walletBackupConfirmed || walletPassphrase.length < 16 || !repeatWalletPassphrase}>
                              {walletVaultBusy ? 'Encrypting…' : 'Encrypt and lock'}
                            </button>
                            <button type="button" className="ag-wbtn ag-wbtn-secondary"
                              disabled={walletVaultBusy} onClick={resetWalletVaultForm}>
                              Cancel
                            </button>
                          </div>
                        </form>
                      )}
                    </div>

                    {revealKeys ? (
                      <div className="ag-wallet-section">
                        {wallet.mnemonic && (
                          <div className="ag-wallet-field">
                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.45rem' }}>
                              <span className="ag-wallet-meta">Recovery phrase</span>
                              <span className="ag-wallet-pill accent">Save this</span>
                            </div>
                            {renderSeedGrid(wallet.mnemonic)}
                          </div>
                        )}

                        {wallet.privateKeyHex && (
                          <div className="ag-wallet-field">
                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.45rem' }}>
                              <span className="ag-wallet-meta">Private key</span>
                              <span
                                className={`ag-wallet-pill ${wallet.mnemonic ? '' : 'accent'}`}
                              >
                                {wallet.mnemonic ? 'Derived' : 'Save this'}
                              </span>
                            </div>
                            <div className="ag-wallet-code-box" title={wallet.privateKeyHex}>
                              {wallet.privateKeyHex}
                            </div>
                          </div>
                        )}

                        <div className="ag-wallet-btn-row">
                          {wallet.mnemonic && (
                            <button
                              type="button"
                              className="ag-wbtn ag-wbtn-secondary ag-wbtn-sm"
                              onClick={() => void markCopied('wallet-phrase', wallet.mnemonic!)}
                            >
                              {copiedKey === 'wallet-phrase' ? (
                                <Check size={13} />
                              ) : (
                                <Copy size={13} />
                              )}
                              <span>
                                {copiedKey === 'wallet-phrase' ? 'Copied' : 'Copy Phrase'}
                              </span>
                            </button>
                          )}
                          {wallet.privateKeyHex && (
                            <button
                              type="button"
                              className="ag-wbtn ag-wbtn-secondary ag-wbtn-sm"
                              onClick={() =>
                                void markCopied('wallet-privkey', wallet.privateKeyHex!)
                              }
                            >
                              {copiedKey === 'wallet-privkey' ? (
                                <Check size={13} />
                              ) : (
                                <KeyRound size={13} />
                              )}
                              <span>{copiedKey === 'wallet-privkey' ? 'Copied' : 'Copy Key'}</span>
                            </button>
                          )}
                          {walletNsec && (
                            <button
                              type="button"
                              className="ag-wbtn ag-wbtn-ghost ag-wbtn-sm"
                              onClick={() => void markCopied('wallet-nsec', walletNsec)}
                            >
                              {copiedKey === 'wallet-nsec' ? 'Copied nsec' : 'Copy nsec'}
                            </button>
                          )}
                        </div>
                      </div>
                    ) : (
                      <div className="ag-wallet-masked-key">
                        •••• •••• •••• •••• •••• ••••
                      </div>
                    )}

                    <span className="ag-wallet-meta">
                      Your 12-word recovery phrase backs up both Cashu Ecash (NUT-13) and Core
                      Bitcoin (BIP-84{' '}
                      <span className="mono">{wallet.btcDerivationPath}</span>). Agwallet stores legacy
                      keys on this device without encryption. Keep backups private and use an
                      external wallet for new Bitcoin deposits.
                    </span>

                    <div className="ag-wallet-btn-row">
                      <button
                        type="button"
                        className="ag-wbtn ag-wbtn-secondary ag-wbtn-sm"
                        onClick={handleExportBackupFile}
                      >
                        <Download size={13} />
                        <span>Export Backup</span>
                      </button>
                      <button
                        type="button"
                        className="ag-wbtn ag-wbtn-secondary ag-wbtn-sm"
                        onClick={() => void markCopied('backup-json', wallet.exportWalletKeyJson())}
                      >
                        {copiedKey === 'backup-json' ? <Check size={13} /> : <Copy size={13} />}
                        <span>{copiedKey === 'backup-json' ? 'Copied' : 'Copy JSON'}</span>
                      </button>
                      <button
                        type="button"
                        className="ag-wbtn ag-wbtn-secondary ag-wbtn-sm"
                        onClick={() => backupFileInputRef.current?.click()}
                      >
                        <Upload size={13} />
                        <span>Import</span>
                      </button>
                      <button
                        type="button"
                        className="ag-wbtn ag-wbtn-secondary ag-wbtn-sm"
                        disabled={restoringSeed || (!wallet.mnemonic && !wallet.privateKeyHex)}
                        onClick={() => void handleRestoreFromSeed()}
                      >
                        <RefreshCw
                          size={13}
                          className={restoringSeed ? 'ag-wallet-spin' : undefined}
                        />
                        <span>{restoringSeed ? 'Scanning…' : 'Restore from Phrase'}</span>
                      </button>
                      <button
                        type="button"
                        className="ag-wbtn ag-wbtn-ghost ag-wbtn-sm"
                        onClick={() => setShowImportPaste((v) => !v)}
                      >
                        {showImportPaste ? 'Hide JSON' : 'Paste JSON'}
                      </button>
                      <input
                        ref={backupFileInputRef}
                        type="file"
                        accept="application/json,.json"
                        style={{ display: 'none' }}
                        onChange={handleBackupFileSelected}
                      />
                    </div>

                    <div className="ag-wallet-help">
                      To restore a different wallet, open a separate Agnostr profile first.
                    </div>

                    {showImportPaste && (
                      <div className="ag-wallet-field">
                        <textarea
                          className="ag-wallet-textarea mono"
                          value={importJsonText}
                          onChange={(e) => setImportJsonText(e.target.value)}
                          placeholder='{"version": 1, ...}'
                        />
                        <button
                          type="button"
                          className="ag-wbtn ag-wbtn-primary ag-wbtn-sm ag-wbtn-full"
                          disabled={importingBackup || !importJsonText.trim()}
                          onClick={() => void handleImportBackupText(importJsonText)}
                        >
                          {importingBackup ? 'Importing…' : 'Restore Backup'}
                        </button>
                      </div>
                    )}
                  </section>

                  {wallet.boltzSwaps.length > 0 && (
                    <section className="ag-wallet-section ag-wallet-divider-top">
                      <h3 className="ag-wallet-section-title">Bitcoin Swaps</h3>
                      {wallet.boltzSwaps.slice(0, 5).map((sw) => renderSwapBlock(sw))}
                    </section>
                  )}

                  <div className="ag-wallet-disclosure">
                    <button
                      type="button"
                      className="ag-wallet-disclosure-btn"
                      onClick={() => setShowAdvancedBoltz((v) => !v)}
                      aria-expanded={showAdvancedBoltz}
                    >
                      {showAdvancedBoltz ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                      <span>Advanced</span>
                    </button>

                    {showAdvancedBoltz && (
                      <div className="ag-wallet-field" style={{ marginTop: '0.55rem' }}>
                        <label className="ag-wallet-label" htmlFor="ag-boltz-api-url">
                          Swap server URL
                        </label>
                        <div className="ag-wallet-input-row">
                          <input
                            id="ag-boltz-api-url"
                            type="url"
                            className="ag-wallet-input mono"
                            value={boltzUrlDraft}
                            onChange={(e) => setBoltzUrlDraft(e.target.value)}
                            placeholder={DEFAULT_BOLTZ_API_URL}
                          />
                          <button
                            type="button"
                            className="ag-wbtn ag-wbtn-secondary"
                            onClick={handleSaveBoltzUrl}
                          >
                            Save
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                </>
              )}
    </>
  )

  const navItems = [
    { id: 'overview' as const, desktopLabel: 'Overview', mobileLabel: 'Overview', icon: Wallet },
    { id: 'receive' as const, desktopLabel: 'Receive', mobileLabel: 'Receive', icon: ArrowDownLeft },
    { id: 'send' as const, desktopLabel: 'Send', mobileLabel: 'Send', icon: ArrowUpRight },
    { id: 'mints' as const, desktopLabel: 'Mints & Backup', mobileLabel: 'Mints', icon: KeyRound },
  ]

  if (embedded) {
    return (
      <div className="ag-wallet-workspace" aria-label="Agwallet" data-no-swipe="true">
        {/* Desktop Left 256px Rail */}
        <aside className="ag-wallet-rail" aria-label="Agwallet navigation">
          <header className="ag-wallet-rail-header">
            <Wallet size={16} className="ag-wallet-brand-glyph" aria-hidden="true" />
            <span className="ag-wallet-brand-name">Agwallet</span>
          </header>

          {!inSetupFlow && (
            <>
              <div className="ag-wallet-rail-balance">
                <div className="ag-wallet-rail-balance-sats tabular">
                  <span>{wallet.activeMintBalanceSats.toLocaleString()}</span>
                  <span className="ag-wallet-rail-balance-unit">sats</span>
                </div>
                <span
                  className="ag-wallet-rail-balance-mint mono truncate"
                  title={wallet.activeMintUrl}
                >
                  {formatMintHost(wallet.activeMintUrl)}
                </span>
                {wallet.totalBalanceSats !== wallet.activeMintBalanceSats && (
                  <span className="ag-wallet-rail-balance-total tabular">
                    Total {wallet.totalBalanceSats.toLocaleString()} sats
                  </span>
                )}
                {wallet.btcBalanceTotalSats > 0 && (
                  <button
                    type="button"
                    className="ag-wallet-onchain-pill tabular"
                    onClick={() => jumpToReceive('onchain')}
                  >
                    <Bitcoin size={11} />
                    <span>BTC {wallet.btcBalanceTotalSats.toLocaleString()} sats</span>
                  </button>
                )}
              </div>

              <nav className="ag-wallet-rail-nav" aria-label="Agwallet sections">
                {navItems.map((item) => {
                  const Icon = item.icon
                  const active = activeTab === item.id
                  return (
                    <button
                      key={item.id}
                      type="button"
                      className={`ag-wallet-rail-item ${active ? 'active' : ''}`}
                      aria-current={active ? 'page' : undefined}
                      onClick={() => switchTab(item.id)}
                    >
                      <Icon size={15} />
                      <span className="truncate">{item.desktopLabel}</span>
                    </button>
                  )
                })}
              </nav>

              {onOpenScanner && (
                <div className="ag-wallet-rail-footer">
                  <button
                    type="button"
                    className="ag-wallet-rail-scan-btn"
                    onClick={handleTriggerScanner}
                  >
                    <ScanLine size={15} />
                    <span>Scan QR</span>
                  </button>
                </div>
              )}
            </>
          )}
        </aside>

        {/* Right Spacious Stage */}
        <section className="ag-wallet-stage">
          <header className="ag-wallet-stage-header">
            <div className="ag-wallet-title-group">
              {showSetupBackBtn && (
                <button
                  type="button"
                  className="ag-wallet-back-btn"
                  onClick={handleBack}
                  aria-label="Back"
                >
                  <ArrowLeft size={17} />
                </button>
              )}
              <h2 className="ag-wallet-stage-title ag-wallet-desktop-title">
                {stageHeaderTitle}
              </h2>
              <h2 className="ag-wallet-stage-title ag-wallet-mobile-title">
                {inSetupFlow ? stageHeaderTitle : 'Agwallet'}
              </h2>
            </div>

            {!inSetupFlow && (
              <div className="ag-wallet-stage-header-actions">
                <select
                  className="ag-wallet-select"
                  value={wallet.activeMintUrl}
                  onChange={(e) => wallet.selectMint(e.target.value)}
                  aria-label="Active Mint"
                >
                  {wallet.mints.map((m) => (
                    <option key={m.url} value={m.url}>
                      {m.label} ({(wallet.balancesByMint[m.url] ?? 0).toLocaleString()} sats)
                    </option>
                  ))}
                </select>
                {onOpenScanner && (
                  <button
                    type="button"
                    className="ag-wallet-scan-icon-btn ag-wallet-mobile-scan-btn"
                    onClick={handleTriggerScanner}
                    aria-label="Scan QR"
                  >
                    <ScanLine size={15} />
                  </button>
                )}
              </div>
            )}
          </header>

          {!inSetupFlow && (
            <div className="ag-wallet-mobile-nav-wrap">
              <nav className="ag-wallet-mobile-nav" aria-label="Agwallet sections">
                {navItems.map((item) => {
                  const active = activeTab === item.id
                  return (
                    <button
                      key={item.id}
                      type="button"
                      className={`ag-wallet-mobile-nav-btn ${active ? 'active' : ''}`}
                      aria-current={active ? 'page' : undefined}
                      onClick={() => switchTab(item.id)}
                    >
                      {item.mobileLabel}
                    </button>
                  )
                })}
              </nav>
            </div>
          )}

          <div className="ag-wallet-stage-scroll">
            <div className="ag-wallet-stage-inner">
              {wallet.credentialsLocked ? lockedWalletBody : inSetupFlow ? setupBody : mainBody}
            </div>
          </div>
        </section>
      </div>
    )
  }

  return (
    <div
      className="ag-wallet-backdrop"
      onClick={onClose}
      role="presentation"
      data-no-swipe="true"
    >
      <div
        className="ag-wallet-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ag-wallet-modal-title"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Minimal Modal Header */}
        <header className="ag-wallet-header">
          <div className="ag-wallet-title-group">
            {showSetupBackBtn && (
              <button
                type="button"
                className="ag-wallet-back-btn"
                onClick={handleBack}
                aria-label="Back"
              >
                <ArrowLeft size={17} />
              </button>
            )}
            <h2 id="ag-wallet-modal-title" className="ag-wallet-title">
              {inSetupFlow ? stageHeaderTitle : 'Agwallet'}
            </h2>
          </div>

          <button
            type="button"
            className="ag-wallet-close-btn"
            onClick={onClose}
            aria-label="Close Agwallet"
          >
            <X size={18} />
          </button>
        </header>

        {wallet.credentialsLocked ? (
          <div className="ag-wallet-body">{lockedWalletBody}</div>
        ) : inSetupFlow ? (
          <div className="ag-wallet-body">{setupBody}</div>
        ) : (
          <>
            <nav className="ag-wallet-nav" aria-label="Agwallet sections">
              {navItems.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={`ag-wallet-nav-btn ${activeTab === item.id ? 'active' : ''}`}
                  onClick={() => switchTab(item.id)}
                >
                  {item.mobileLabel}
                </button>
              ))}
            </nav>

            <div className="ag-wallet-body">{mainBody}</div>
          </>
        )}
      </div>
    </div>
  )
}

export function WalletModal({
  open,
  embedded = false,
  onClose,
  wallet,
  zaps,
  initialIntent,
  onOpenScanner,
  onSendToChat,
  activeChatLabel,
}: WalletModalProps) {
  if (!open) return null

  const intentKey = initialIntent
    ? `${initialIntent.tab ?? ''}:${initialIntent.receiveMode ?? ''}:${initialIntent.sendMode ?? ''}:${initialIntent.payload ?? ''}`
    : 'default'

  const inner = (
    <WalletModalInner
      key={intentKey}
      embedded={embedded}
      onClose={onClose}
      wallet={wallet}
      zaps={zaps}
      initialIntent={initialIntent}
      onOpenScanner={onOpenScanner}
      onSendToChat={onSendToChat}
      activeChatLabel={activeChatLabel}
    />
  )

  if (embedded) {
    return inner
  }

  if (typeof document === 'undefined') return null
  return createPortal(inner, document.body)
}

export default WalletModal
