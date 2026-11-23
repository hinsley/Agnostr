import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ChangeEvent } from 'react'
import { createPortal } from 'react-dom'
import {
  AlertCircle,
  ArrowDownLeft,
  ArrowUpRight,
  Bitcoin,
  Check,
  ChevronDown,
  ChevronRight,
  Coins,
  Copy,
  Download,
  ExternalLink,
  Loader2,
  Plus,
  QrCode,
  RefreshCw,
  ScanLine,
  Send,
  Trash2,
  Upload,
  X,
  Zap,
} from 'lucide-react'
import type {
  BoltzReversePairInfo,
  BoltzSubmarinePairInfo,
  BoltzSwapRecord,
  CashuMeltQuotePreview,
  CashuSentTokenRecord,
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
  DEFAULT_BOLTZ_API_URL,
  formatBoltzStatusLabel,
  getMempoolAddressUrl,
  getMempoolTxUrl,
  isBoltzSwapActive,
  isBoltzSwapFailed,
  isValidBitcoinAddress,
} from '../lib/boltzSwap.ts'
import { formatMintHost } from '../lib/cashuMints.ts'
import { extractCashuTokenString } from '../lib/cashuWallet.ts'
import { generateQrSvg } from '../lib/qrCode.ts'
import { parseLightningPayload } from '../lib/zaps.ts'
import '../styles/wallet.css'

export interface WalletModalProps {
  open: boolean
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
      return 'BTC Deposit'
    case 'send_btc':
      return 'BTC Send'
    case 'zap_out':
      return 'Zap'
    case 'reclaim':
      return 'Reclaimed Token'
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
        receiveMode: intent?.receiveMode ?? 'cashu',
        sendMode: intent?.sendMode ?? 'lightning',
        cashuReceiveInput: '',
        lnSendInput: payload,
      }
    }
  }
  return {
    tab: intent?.tab ?? 'overview',
    receiveMode: intent?.receiveMode ?? 'cashu',
    sendMode: intent?.sendMode ?? 'cashu',
    cashuReceiveInput: '',
    lnSendInput: '',
  }
}

function WalletModalInner({
  onClose,
  wallet,
  zaps,
  initialIntent,
  onOpenScanner,
  onSendToChat,
  activeChatLabel,
}: Omit<WalletModalProps, 'open'>) {
  const initNav = useMemo(() => resolveInitialNav(initialIntent), [initialIntent])

  const [tab, setTab] = useState<WalletModalTab>(initNav.tab)
  const [receiveMode, setReceiveMode] = useState<WalletReceiveMode>(initNav.receiveMode)
  const [sendMode, setSendMode] = useState<WalletSendMode>(initNav.sendMode)

  const [feedback, setFeedback] = useState<{
    kind: 'accent' | 'warn' | 'danger'
    text: string
  } | null>(null)
  const [copiedKey, setCopiedKey] = useState<string | null>(null)

  // Overview inline Lightning Address
  const [lud16Draft, setLud16Draft] = useState<string>(zaps.lightningAddress ?? '')
  const [savingLud16, setSavingLud16] = useState(false)

  // Receive: Ecash
  const [cashuReceiveInput, setCashuReceiveInput] = useState<string>(initNav.cashuReceiveInput)
  const [claimingToken, setClaimingToken] = useState(false)

  // Receive: Lightning (NUT-04)
  const [lnReceiveAmount, setLnReceiveAmount] = useState<string>('1000')
  const [lnReceiveMemo, setLnReceiveMemo] = useState<string>('')
  const [creatingLnQuote, setCreatingLnQuote] = useState(false)
  const [checkingLnQuote, setCheckingLnQuote] = useState(false)

  // Receive: On-Chain BTC (Boltz v2 Submarine)
  const [subPair, setSubPair] = useState<BoltzSubmarinePairInfo | null>(null)
  const [subPairLoading, setSubPairLoading] = useState(false)
  const [subPairError, setSubPairError] = useState<string | null>(null)
  const [btcReceiveAmount, setBtcReceiveAmount] = useState<string>('50000')
  const [creatingSubSwap, setCreatingSubSwap] = useState(false)
  const [activeSubSwapId, setActiveSubSwapId] = useState<string | null>(null)

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

  // Send: On-Chain BTC (Boltz v2 Reverse Submarine)
  const [revPair, setRevPair] = useState<BoltzReversePairInfo | null>(null)
  const [revPairLoading, setRevPairLoading] = useState(false)
  const [revPairError, setRevPairError] = useState<string | null>(null)
  const [btcSendAddress, setBtcSendAddress] = useState<string>('')
  const [btcSendAmount, setBtcSendAmount] = useState<string>('50000')
  const [creatingRevSwap, setCreatingRevSwap] = useState(false)
  const [activeRevSwapId, setActiveRevSwapId] = useState<string | null>(null)
  const [refreshingSwapId, setRefreshingSwapId] = useState<string | null>(null)

  // Mints management
  const [customMintUrl, setCustomMintUrl] = useState<string>('')
  const [addingMint, setAddingMint] = useState(false)
  const [inspectingMintUrl, setInspectingMintUrl] = useState<string | null>(null)
  const [verifyingMintUrl, setVerifyingMintUrl] = useState<string | null>(null)
  const [showAdvancedBoltz, setShowAdvancedBoltz] = useState(false)
  const [boltzUrlDraft, setBoltzUrlDraft] = useState<string>(wallet.boltzApiUrl)

  // History / Backup
  const [importJsonText, setImportJsonText] = useState<string>('')
  const [showImportPaste, setShowImportPaste] = useState(false)
  const [importingBackup, setImportingBackup] = useState(false)
  const backupFileInputRef = useRef<HTMLInputElement | null>(null)

  useBackHandler(true, onClose)

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  const markCopied = useCallback(async (key: string, value: string) => {
    const ok = await copyTextSafe(value)
    if (ok) {
      setCopiedKey(key)
      window.setTimeout(() => {
        setCopiedKey((prev) => (prev === key ? null : prev))
      }, 1800)
    }
  }, [])

  const loadSubmarinePair = useCallback(async () => {
    setSubPairLoading(true)
    setSubPairError(null)
    try {
      const info = await wallet.fetchBoltzSubmarinePair()
      setSubPair(info)
    } catch (err) {
      setSubPairError(err instanceof Error ? err.message : 'Unable to fetch swap rates.')
    } finally {
      setSubPairLoading(false)
    }
  }, [wallet])

  const loadReversePair = useCallback(async () => {
    setRevPairLoading(true)
    setRevPairError(null)
    try {
      const info = await wallet.fetchBoltzReversePair()
      setRevPair(info)
    } catch (err) {
      setRevPairError(err instanceof Error ? err.message : 'Unable to fetch swap rates.')
    } finally {
      setRevPairLoading(false)
    }
  }, [wallet])

  const switchTab = useCallback(
    (nextTab: WalletModalTab) => {
      setTab(nextTab)
      setFeedback(null)
      if (nextTab === 'receive' && receiveMode === 'onchain' && !subPair && !subPairLoading) {
        void loadSubmarinePair()
      }
      if (nextTab === 'send' && sendMode === 'onchain' && !revPair && !revPairLoading) {
        void loadReversePair()
      }
    },
    [
      loadReversePair,
      loadSubmarinePair,
      receiveMode,
      revPair,
      revPairLoading,
      sendMode,
      subPair,
      subPairLoading,
    ]
  )

  const switchReceiveMode = useCallback(
    (mode: WalletReceiveMode) => {
      setReceiveMode(mode)
      setFeedback(null)
      if (mode === 'onchain' && !subPair && !subPairLoading) {
        void loadSubmarinePair()
      }
    },
    [loadSubmarinePair, subPair, subPairLoading]
  )

  const switchSendMode = useCallback(
    (mode: WalletSendMode) => {
      setSendMode(mode)
      setFeedback(null)
      if (mode === 'onchain' && !revPair && !revPairLoading) {
        void loadReversePair()
      }
    },
    [loadReversePair, revPair, revPairLoading]
  )

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
    if (activeSubSwapId) {
      return wallet.boltzSwaps.find((s) => s.id === activeSubSwapId) ?? null
    }
    return (
      wallet.boltzSwaps.find((s) => s.direction === 'submarine' && isBoltzSwapActive(s)) ?? null
    )
  }, [activeSubSwapId, wallet.boltzSwaps])

  const activeRevSwap: BoltzSwapRecord | null = useMemo(() => {
    if (activeRevSwapId) {
      return wallet.boltzSwaps.find((s) => s.id === activeRevSwapId) ?? null
    }
    return wallet.boltzSwaps.find((s) => s.direction === 'reverse' && isBoltzSwapActive(s)) ?? null
  }, [activeRevSwapId, wallet.boltzSwaps])

  const activeBoltzSwaps = useMemo(
    () => wallet.boltzSwaps.filter(isBoltzSwapActive),
    [wallet.boltzSwaps]
  )

  /* ------------------------------------------------------------------------
     Action Handlers
     ------------------------------------------------------------------------ */

  const handleSaveLud16 = useCallback(async () => {
    setSavingLud16(true)
    setFeedback(null)
    try {
      const res = await zaps.setLightningAddress(lud16Draft.trim() || null)
      if (!res.ok) {
        setFeedback({ kind: 'danger', text: res.error || 'Invalid Lightning address.' })
      } else {
        setLud16Draft(res.normalized ?? '')
        setFeedback({
          kind: 'accent',
          text: res.normalized ? `Saved ${res.normalized}` : 'Cleared Lightning address',
        })
      }
    } finally {
      setSavingLud16(false)
    }
  }, [lud16Draft, zaps])

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

  const handleCreateSubmarineSwap = useCallback(async () => {
    const sats = Math.floor(Number.parseInt(btcReceiveAmount, 10) || 0)
    if (sats <= 0) {
      setFeedback({ kind: 'danger', text: 'Enter a valid amount.' })
      return
    }
    setCreatingSubSwap(true)
    setFeedback(null)
    try {
      const swap = await wallet.createOnchainReceiveSwap(sats)
      setActiveSubSwapId(swap.id)
    } catch (err) {
      setFeedback({
        kind: 'danger',
        text: err instanceof Error ? err.message : 'Could not create deposit swap.',
      })
    } finally {
      setCreatingSubSwap(false)
    }
  }, [btcReceiveAmount, wallet])

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
        kind: 'accent',
        text: `Paid ${meltPreview.amountSats.toLocaleString()} sats${res.feePaidSats > 0 ? ` · ${res.feePaidSats} sat fee` : ''}`,
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

  const handleCreateReverseSwap = useCallback(async () => {
    const sats = Math.floor(Number.parseInt(btcSendAmount, 10) || 0)
    if (!isValidBitcoinAddress(btcSendAddress)) {
      setFeedback({ kind: 'danger', text: 'Enter a valid Bitcoin address (bc1…, 1…, or 3…).' })
      return
    }
    if (sats <= 0) {
      setFeedback({ kind: 'danger', text: 'Enter a valid amount.' })
      return
    }
    setCreatingRevSwap(true)
    setFeedback(null)
    try {
      const swap = await wallet.createOnchainSendSwap(btcSendAddress.trim(), sats)
      setActiveRevSwapId(swap.id)
      setFeedback({
        kind: 'accent',
        text: `Swap ${swap.id} started — export the Rescue JSON for safekeeping.`,
      })
    } catch (err) {
      setFeedback({
        kind: 'danger',
        text: err instanceof Error ? err.message : 'On-chain swap failed.',
      })
    } finally {
      setCreatingRevSwap(false)
    }
  }, [btcSendAddress, btcSendAmount, wallet])

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
      setFeedback({
        kind: 'accent',
        text: `Added ${info.name}`,
      })
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
            ? `${info.name} · ${info.feePpk ?? 0} ppk · ${info.nuts.length} NUTs`
            : info.error || 'Mint offline',
        })
      } catch (err) {
        setFeedback({
          kind: 'danger',
          text: err instanceof Error ? err.message : 'Inspection failed.',
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
    const json = wallet.exportBackupJson()
    const dateStamp = new Date().toISOString().slice(0, 10)
    downloadJsonFile(`agnostr-cashu-backup-${dateStamp}.json`, json)
    setFeedback({ kind: 'accent', text: 'Backup exported.' })
  }, [wallet])

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
          text: `Restored ${res.importedProofs} proofs · ${res.totalSats.toLocaleString()} sats`,
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
    setSubPair(null)
    setRevPair(null)
    setSubPairError(null)
    setRevPairError(null)
    setFeedback({ kind: 'accent', text: 'Updated Boltz endpoint.' })
  }, [boltzUrlDraft, wallet])

  const subEstimate = useMemo(() => {
    const sats = Math.floor(Number.parseInt(btcReceiveAmount, 10) || 0)
    if (!subPair || sats <= 0) return null
    const serviceFee = Math.ceil((sats * subPair.feePercent) / 100)
    const totalFee = serviceFee + subPair.minerFeeSats
    return {
      mintSats: sats,
      totalFee,
      expectedDeposit: sats + totalFee,
    }
  }, [btcReceiveAmount, subPair])

  const revEstimate = useMemo(() => {
    const sats = Math.floor(Number.parseInt(btcSendAmount, 10) || 0)
    if (!revPair || sats <= 0) return null
    const serviceFee = Math.ceil((sats * revPair.feePercent) / 100)
    const totalFee = serviceFee + revPair.lockupMinerFeeSats + revPair.claimMinerFeeSats
    return {
      sendSats: sats,
      totalFee,
      estOnchainSats: Math.max(0, sats - totalFee),
    }
  }, [btcSendAmount, revPair])

  const renderSwapBlock = (swap: BoltzSwapRecord) => {
    const failed = isBoltzSwapFailed(swap.status)
    const active = isBoltzSwapActive(swap)
    return (
      <div key={swap.id} className="ag-wallet-tonal">
        <div className="ag-wallet-section-head">
          <span className="ag-wallet-section-title">
            {swap.direction === 'submarine' ? 'BTC Deposit' : 'BTC Send'} · {swap.id}
          </span>
          <span className={`ag-wallet-pill ${failed ? 'danger' : active ? 'warn' : 'accent'}`}>
            {formatBoltzStatusLabel(swap.status)}
          </span>
        </div>

        {swap.direction === 'submarine' && active && (
          <div className="ag-wallet-qr-wrap">
            <QrBox
              payload={swap.bip21 || swap.address}
              label={`Bitcoin deposit QR for ${swap.address}`}
            />
            <div className="ag-wallet-code-box" title={swap.address}>
              {swap.address}
            </div>
            <div className="ag-wallet-btn-row" style={{ width: '100%' }}>
              <button
                type="button"
                className="ag-wbtn ag-wbtn-secondary ag-wbtn-sm ag-wbtn-grow"
                onClick={() => void markCopied(`addr-${swap.id}`, swap.address)}
              >
                {copiedKey === `addr-${swap.id}` ? <Check size={13} /> : <Copy size={13} />}
                <span>{copiedKey === `addr-${swap.id}` ? 'Copied' : 'Copy Address'}</span>
              </button>
              {swap.bip21 && (
                <button
                  type="button"
                  className="ag-wbtn ag-wbtn-secondary ag-wbtn-sm ag-wbtn-grow"
                  onClick={() => void markCopied(`bip21-${swap.id}`, swap.bip21!)}
                >
                  {copiedKey === `bip21-${swap.id}` ? <Check size={13} /> : <Copy size={13} />}
                  <span>{copiedKey === `bip21-${swap.id}` ? 'Copied' : 'Copy BIP-21'}</span>
                </button>
              )}
            </div>
          </div>
        )}

        <div className="ag-wallet-kv-list">
          <div className="ag-wallet-kv">
            <span className="ag-wallet-kv-label">
              {swap.direction === 'submarine' ? 'Send exact BTC' : 'Sent'}
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
              {swap.direction === 'submarine' ? 'Mint receives' : 'On-chain output'}
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
              <span className="ag-wallet-kv-label">HTLC</span>
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
            <span>{swap.direction === 'submarine' ? 'Refund JSON' : 'Rescue JSON'}</span>
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
        {/* Minimal Header */}
        <header className="ag-wallet-header">
          <div className="ag-wallet-title-group">
            <h2 id="ag-wallet-modal-title" className="ag-wallet-title">
              Wallet
            </h2>
          </div>

          <button
            type="button"
            className="ag-wallet-close-btn"
            onClick={onClose}
            aria-label="Close wallet"
            title="Close (Esc)"
          >
            <X size={18} />
          </button>
        </header>

        {/* Sleek Borderless Underline Nav */}
        <nav className="ag-wallet-nav" aria-label="Wallet sections">
          {(
            [
              { id: 'overview', label: 'Home' },
              { id: 'receive', label: 'Receive' },
              { id: 'send', label: 'Send' },
              { id: 'mints', label: 'Mints' },
              { id: 'history', label: 'History' },
            ] as const
          ).map((item) => (
            <button
              key={item.id}
              type="button"
              className={`ag-wallet-nav-btn ${tab === item.id ? 'active' : ''}`}
              onClick={() => switchTab(item.id)}
            >
              {item.label}
            </button>
          ))}
        </nav>

        {/* Body */}
        <div className="ag-wallet-body">
          {/* Airy Borderless Balance Hero */}
          <section
            className={`ag-wallet-hero ${tab !== 'overview' ? 'compact' : ''}`}
            aria-label="Wallet balance"
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
            </div>

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
                  onClick={() => {
                    onClose()
                    onOpenScanner()
                  }}
                  title="Scan QR"
                  aria-label="Scan QR"
                >
                  <ScanLine size={15} />
                </button>
              )}
            </div>

            {tab === 'overview' && (
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

          {/* Global Feedback Strip */}
          {feedback && (
            <div className={`ag-wallet-banner ${feedback.kind}`} role="status">
              {feedback.kind === 'danger' ? (
                <AlertCircle size={15} />
              ) : (
                <Check size={15} />
              )}
              <span>{feedback.text}</span>
            </div>
          )}

          {/* ===================== TAB 1: HOME ===================== */}
          {tab === 'overview' && (
            <>
              {/* Lightning Address */}
              <section className="ag-wallet-field">
                <label className="ag-wallet-label" htmlFor="ag-wallet-lud16">
                  Lightning Address
                </label>
                <div className="ag-wallet-input-row">
                  <input
                    id="ag-wallet-lud16"
                    type="text"
                    className="ag-wallet-input mono"
                    value={lud16Draft}
                    onChange={(e) => setLud16Draft(e.target.value)}
                    placeholder="you@domain.com"
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
              </section>

              {/* Active On-Chain Swaps */}
              {activeBoltzSwaps.length > 0 && (
                <section className="ag-wallet-section">
                  {activeBoltzSwaps.map((sw) => renderSwapBlock(sw))}
                </section>
              )}

              {/* Funded Multi-Mint Breakdown (shown only when >1 mint holds funds) */}
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
                                <span className="ag-wallet-mint-host">{formatMintHost(m.url)}</span>
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

              {/* Recent Activity */}
              <section className="ag-wallet-section">
                <div className="ag-wallet-section-head">
                  <h3 className="ag-wallet-section-title">Recent Activity</h3>
                  {wallet.history.length > 4 && (
                    <button
                      type="button"
                      className="ag-wbtn ag-wbtn-link"
                      onClick={() => switchTab('history')}
                    >
                      View all
                    </button>
                  )}
                </div>

                {wallet.history.length === 0 ? (
                  <div className="ag-wallet-empty">No activity yet</div>
                ) : (
                  <div className="ag-wallet-flat-list">
                    {wallet.history.slice(0, 4).map((tx) => {
                      const incoming = isIncomingTx(tx.type)
                      return (
                        <div key={tx.id} className="ag-wallet-tx-item">
                          <div className="ag-wallet-tx-left">
                            <span className={`ag-wallet-tx-icon ${incoming ? 'in' : ''}`}>
                              {incoming ? <ArrowDownLeft size={14} /> : <ArrowUpRight size={14} />}
                            </span>
                            <div className="ag-wallet-tx-copy">
                              <span className="ag-wallet-tx-title truncate">
                                {formatTxLabel(tx.type)}
                              </span>
                              <span className="ag-wallet-tx-sub truncate">
                                {tx.memo || tx.counterparty || formatMintHost(tx.mintUrl)}
                              </span>
                            </div>
                          </div>
                          <div className="ag-wallet-tx-right">
                            <span className={`ag-wallet-tx-amt ${incoming ? 'in' : ''}`}>
                              {incoming ? '+' : '-'}
                              {tx.amountSats.toLocaleString()} sats
                            </span>
                            <span className="ag-wallet-tx-time">
                              {formatRelativeTime(tx.createdAt)}
                            </span>
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
          {tab === 'receive' && (
            <>
              <div className="ag-wallet-subtabs" role="tablist" aria-label="Receive method">
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
                  <span>On-Chain</span>
                </button>
              </div>

              {/* Receive: Ecash */}
              {receiveMode === 'cashu' && (
                <section className="ag-wallet-section">
                  <div className="ag-wallet-field">
                    <div className="ag-wallet-label-row">
                      <label className="ag-wallet-label" htmlFor="ag-cashu-receive-token">
                        Token
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
                            onClick={() => {
                              onClose()
                              onOpenScanner()
                            }}
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
                      placeholder="cashuA… or cashuB…"
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
                            <span className="ag-wallet-kv-val">{cashuReceivePreview.memo}</span>
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

              {/* Receive: Lightning (NUT-04) */}
              {receiveMode === 'lightning' && (
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
                              payload={`lightning:${wallet.activeMintQuote.invoice}`}
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
                              {copiedKey === 'ln-inv' ? <Check size={14} /> : <Copy size={14} />}
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
                        onClick={() => wallet.clearActiveMintQuote()}
                      >
                        New Invoice
                      </button>
                    </>
                  ) : (
                    <>
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
              )}

              {/* Receive: On-Chain BTC */}
              {receiveMode === 'onchain' && (
                <section className="ag-wallet-section">
                  {activeSubSwap ? (
                    <>
                      {renderSwapBlock(activeSubSwap)}
                      <button
                        type="button"
                        className="ag-wbtn ag-wbtn-ghost ag-wbtn-sm ag-wbtn-full"
                        onClick={() => setActiveSubSwapId(null)}
                      >
                        New Deposit Address
                      </button>
                    </>
                  ) : (
                    <>
                      <div className="ag-wallet-rate-line">
                        <span className="truncate tabular">
                          {subPair
                            ? `${subPair.minSats.toLocaleString()}–${subPair.maxSats.toLocaleString()} sats · ${subPair.feePercent}% + ${subPair.minerFeeSats.toLocaleString()} sat fee`
                            : subPairLoading
                              ? 'Loading rates…'
                              : 'Boltz v2 submarine swap'}
                        </span>
                        <button
                          type="button"
                          className="ag-wbtn ag-wbtn-ghost ag-wbtn-sm"
                          disabled={subPairLoading}
                          onClick={() => void loadSubmarinePair()}
                          aria-label="Refresh swap rates"
                          title="Refresh rates"
                        >
                          <RefreshCw
                            size={12}
                            className={subPairLoading ? 'ag-wallet-spin' : undefined}
                          />
                        </button>
                      </div>

                      {subPairError && (
                        <div className="ag-wallet-banner warn">
                          <AlertCircle size={15} />
                          <div>
                            <div>{subPairError}</div>
                            <button
                              type="button"
                              className="ag-wbtn ag-wbtn-link"
                              style={{ paddingLeft: 0, marginTop: '0.2rem' }}
                              onClick={() => {
                                setShowAdvancedBoltz(true)
                                switchTab('mints')
                              }}
                            >
                              Configure Boltz endpoint
                            </button>
                          </div>
                        </div>
                      )}

                      <div className="ag-wallet-field">
                        <label className="ag-wallet-label" htmlFor="ag-btc-rec-amt">
                          Amount (sats)
                        </label>
                        <input
                          id="ag-btc-rec-amt"
                          type="number"
                          inputMode="numeric"
                          min={subPair?.minSats ?? 25000}
                          step={1000}
                          className="ag-wallet-input tabular"
                          value={btcReceiveAmount}
                          onChange={(e) => setBtcReceiveAmount(e.target.value)}
                          placeholder="50000"
                        />
                      </div>

                      {subEstimate && (
                        <div className="ag-wallet-tonal">
                          <div className="ag-wallet-kv-list">
                            <div className="ag-wallet-kv">
                              <span className="ag-wallet-kv-label">Est. BTC deposit</span>
                              <span className="ag-wallet-kv-val tabular">
                                {subEstimate.expectedDeposit.toLocaleString()} sats
                              </span>
                            </div>
                            <div className="ag-wallet-kv">
                              <span className="ag-wallet-kv-label">Swap fee</span>
                              <span className="ag-wallet-kv-val tabular">
                                {subEstimate.totalFee.toLocaleString()} sats
                              </span>
                            </div>
                          </div>
                        </div>
                      )}

                      <button
                        type="button"
                        className="ag-wbtn ag-wbtn-primary ag-wbtn-full"
                        disabled={creatingSubSwap || subPairLoading}
                        onClick={() => void handleCreateSubmarineSwap()}
                      >
                        {creatingSubSwap ? (
                          <Loader2 size={15} className="ag-wallet-spin" />
                        ) : (
                          <Bitcoin size={15} />
                        )}
                        <span>{creatingSubSwap ? 'Generating…' : 'Generate Address'}</span>
                      </button>
                    </>
                  )}
                </section>
              )}
            </>
          )}

          {/* ===================== TAB 3: SEND ===================== */}
          {tab === 'send' && (
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
                  <span>On-Chain</span>
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
                                checkingSentId === freshSentToken.id ? 'ag-wallet-spin' : undefined
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
                            onClick={() => setCashuSendAmount(String(wallet.activeMintBalanceSats))}
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

                  {/* Unclaimed Sent Tokens — Flat Hairline Rows */}
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

              {/* Send: On-Chain BTC */}
              {sendMode === 'onchain' && (
                <section className="ag-wallet-section">
                  {activeRevSwap ? (
                    <>
                      {renderSwapBlock(activeRevSwap)}
                      <button
                        type="button"
                        className="ag-wbtn ag-wbtn-ghost ag-wbtn-sm ag-wbtn-full"
                        onClick={() => setActiveRevSwapId(null)}
                      >
                        New BTC Send
                      </button>
                    </>
                  ) : (
                    <>
                      <div className="ag-wallet-rate-line">
                        <span className="truncate tabular">
                          {revPair
                            ? `${revPair.minSats.toLocaleString()}–${revPair.maxSats.toLocaleString()} sats · ${revPair.feePercent}% + ${(revPair.lockupMinerFeeSats + revPair.claimMinerFeeSats).toLocaleString()} sat fee`
                            : revPairLoading
                              ? 'Loading rates…'
                              : 'Boltz v2 reverse swap'}
                        </span>
                        <button
                          type="button"
                          className="ag-wbtn ag-wbtn-ghost ag-wbtn-sm"
                          disabled={revPairLoading}
                          onClick={() => void loadReversePair()}
                          aria-label="Refresh swap rates"
                          title="Refresh rates"
                        >
                          <RefreshCw
                            size={12}
                            className={revPairLoading ? 'ag-wallet-spin' : undefined}
                          />
                        </button>
                      </div>

                      {revPairError && (
                        <div className="ag-wallet-banner warn">
                          <AlertCircle size={15} />
                          <div>
                            <div>{revPairError}</div>
                            <button
                              type="button"
                              className="ag-wbtn ag-wbtn-link"
                              style={{ paddingLeft: 0, marginTop: '0.2rem' }}
                              onClick={() => {
                                setShowAdvancedBoltz(true)
                                switchTab('mints')
                              }}
                            >
                              Configure Boltz endpoint
                            </button>
                          </div>
                        </div>
                      )}

                      <div className="ag-wallet-field">
                        <label className="ag-wallet-label" htmlFor="ag-btc-send-addr">
                          BTC Address
                        </label>
                        <input
                          id="ag-btc-send-addr"
                          type="text"
                          className="ag-wallet-input mono"
                          value={btcSendAddress}
                          onChange={(e) => setBtcSendAddress(e.target.value)}
                          placeholder="bc1q… / bc1p…"
                        />
                      </div>

                      <div className="ag-wallet-field">
                        <label className="ag-wallet-label" htmlFor="ag-btc-send-amt">
                          Amount (sats)
                        </label>
                        <input
                          id="ag-btc-send-amt"
                          type="number"
                          inputMode="numeric"
                          min={revPair?.minSats ?? 25000}
                          step={1000}
                          className="ag-wallet-input tabular"
                          value={btcSendAmount}
                          onChange={(e) => setBtcSendAmount(e.target.value)}
                          placeholder="50000"
                        />
                      </div>

                      {revEstimate && (
                        <div className="ag-wallet-tonal">
                          <div className="ag-wallet-kv-list">
                            <div className="ag-wallet-kv">
                              <span className="ag-wallet-kv-label">Est. output</span>
                              <span className="ag-wallet-kv-val tabular">
                                ~{revEstimate.estOnchainSats.toLocaleString()} sats
                              </span>
                            </div>
                            <div className="ag-wallet-kv">
                              <span className="ag-wallet-kv-label">Total fee</span>
                              <span className="ag-wallet-kv-val tabular">
                                {revEstimate.totalFee.toLocaleString()} sats
                              </span>
                            </div>
                          </div>
                        </div>
                      )}

                      <button
                        type="button"
                        className="ag-wbtn ag-wbtn-primary ag-wbtn-full"
                        disabled={
                          creatingRevSwap ||
                          revPairLoading ||
                          !isValidBitcoinAddress(btcSendAddress) ||
                          wallet.activeMintBalanceSats <= 0
                        }
                        onClick={() => void handleCreateReverseSwap()}
                      >
                        {creatingRevSwap ? (
                          <Loader2 size={15} className="ag-wallet-spin" />
                        ) : (
                          <Bitcoin size={15} />
                        )}
                        <span>{creatingRevSwap ? 'Sending…' : 'Send On-Chain'}</span>
                      </button>
                    </>
                  )}
                </section>
              )}
            </>
          )}

          {/* ===================== TAB 4: MINTS ===================== */}
          {tab === 'mints' && (
            <>
              <div className="ag-wallet-input-row">
                <input
                  type="url"
                  className="ag-wallet-input mono"
                  value={customMintUrl}
                  onChange={(e) => setCustomMintUrl(e.target.value)}
                  placeholder="https://mint.example.com"
                  aria-label="Add Cashu mint URL"
                />
                <button
                  type="button"
                  className="ag-wbtn ag-wbtn-primary"
                  disabled={addingMint || !customMintUrl.trim()}
                  onClick={() => void handleAddMint()}
                >
                  {addingMint ? <Loader2 size={14} className="ag-wallet-spin" /> : <Plus size={14} />}
                  <span>Add</span>
                </button>
              </div>

              <section className="ag-wallet-flat-list" aria-label="Configured mints">
                {wallet.mints.map((mint) => {
                  const bal = wallet.balancesByMint[mint.url] ?? 0
                  const count = wallet.proofCountByMint[mint.url] ?? 0
                  const isActive = mint.url === wallet.activeMintUrl
                  const canRemove = bal === 0 && wallet.mints.length > 1
                  const feeLabel =
                    mint.info?.feePpk !== undefined && mint.info.feePpk !== null
                      ? mint.info.feePpk === 0
                        ? '0 fee'
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
                          {count > 0 && (
                            <div className="ag-wallet-meta">
                              {count} proof{count === 1 ? '' : 's'}
                            </div>
                          )}
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
                            className={inspectingMintUrl === mint.url ? 'ag-wallet-spin' : undefined}
                          />
                          <span>Inspect</span>
                        </button>
                        {count > 0 && (
                          <button
                            type="button"
                            className="ag-wbtn ag-wbtn-ghost ag-wbtn-sm"
                            disabled={verifyingMintUrl === mint.url}
                            onClick={() => void handleVerifyMintProofs(mint.url)}
                          >
                            <span>{verifyingMintUrl === mint.url ? 'Checking…' : 'Verify'}</span>
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
              </section>

              {/* Discreet Closed-by-Default Advanced Boltz Endpoint */}
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
                      Boltz v2 API
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

          {/* ===================== TAB 5: HISTORY & BACKUP ===================== */}
          {tab === 'history' && (
            <>
              <section className="ag-wallet-section">
                <span className="ag-wallet-meta">
                  Proofs live locally in this browser — export a backup before wiping.
                </span>

                <div className="ag-wallet-btn-row">
                  <button
                    type="button"
                    className="ag-wbtn ag-wbtn-secondary ag-wbtn-sm"
                    onClick={handleExportBackupFile}
                  >
                    <Download size={13} />
                    <span>Export</span>
                  </button>
                  <button
                    type="button"
                    className="ag-wbtn ag-wbtn-secondary ag-wbtn-sm"
                    onClick={() => void markCopied('backup-json', wallet.exportBackupJson())}
                  >
                    {copiedKey === 'backup-json' ? <Check size={13} /> : <Copy size={13} />}
                    <span>{copiedKey === 'backup-json' ? 'Copied' : 'Copy'}</span>
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
                    className="ag-wbtn ag-wbtn-ghost ag-wbtn-sm"
                    onClick={() => setShowImportPaste((v) => !v)}
                  >
                    {showImportPaste ? 'Hide' : 'Paste JSON'}
                  </button>
                  <input
                    ref={backupFileInputRef}
                    type="file"
                    accept="application/json,.json"
                    style={{ display: 'none' }}
                    onChange={handleBackupFileSelected}
                  />
                </div>

                {showImportPaste && (
                  <div className="ag-wallet-field">
                    <textarea
                      className="ag-wallet-textarea mono"
                      value={importJsonText}
                      onChange={(e) => setImportJsonText(e.target.value)}
                      placeholder='{"version": 1, "proofsByMint": { … }}'
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
                <section className="ag-wallet-section">
                  {wallet.boltzSwaps.slice(0, 5).map((sw) => renderSwapBlock(sw))}
                </section>
              )}

              <section className="ag-wallet-section">
                <div className="ag-wallet-section-head">
                  <h3 className="ag-wallet-section-title">Activity</h3>
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

                {wallet.history.length === 0 ? (
                  <div className="ag-wallet-empty">No activity yet</div>
                ) : (
                  <div className="ag-wallet-flat-list">
                    {wallet.history.map((tx) => {
                      const incoming = isIncomingTx(tx.type)
                      return (
                        <div key={tx.id} className="ag-wallet-tx-item">
                          <div className="ag-wallet-tx-left">
                            <span className={`ag-wallet-tx-icon ${incoming ? 'in' : ''}`}>
                              {incoming ? <ArrowDownLeft size={14} /> : <ArrowUpRight size={14} />}
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
                                  title="View on mempool.space"
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
        </div>
      </div>
    </div>
  )
}

export function WalletModal({
  open,
  onClose,
  wallet,
  zaps,
  initialIntent,
  onOpenScanner,
  onSendToChat,
  activeChatLabel,
}: WalletModalProps) {
  if (!open || typeof document === 'undefined') return null

  const intentKey = initialIntent
    ? `${initialIntent.tab ?? ''}:${initialIntent.receiveMode ?? ''}:${initialIntent.sendMode ?? ''}:${initialIntent.payload ?? ''}`
    : 'default'

  return createPortal(
    <WalletModalInner
      key={intentKey}
      onClose={onClose}
      wallet={wallet}
      zaps={zaps}
      initialIntent={initialIntent}
      onOpenScanner={onOpenScanner}
      onSendToChat={onSendToChat}
      activeChatLabel={activeChatLabel}
    />,
    document.body
  )
}

export default WalletModal
