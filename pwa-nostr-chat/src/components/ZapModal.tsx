import { useCallback, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  AlertCircle,
  Check,
  Copy,
  ExternalLink,
  Loader2,
  QrCode,
  Wallet,
  X,
  Zap,
} from 'lucide-react'
import type {
  WalletEngine,
  WalletInitialIntent,
  ZapEngine,
  ZapInvoiceResult,
  ZapTarget,
} from '../types/wallet.ts'
import { useBackHandler } from '../hooks/useBackNavigation.ts'
import { formatMintHost } from '../lib/cashuMints.ts'
import { formatShortPubkey } from '../lib/identity.ts'
import { generateQrSvg } from '../lib/qrCode.ts'
import '../styles/wallet.css'

export interface ZapModalProps {
  target: ZapTarget | null
  onClose: () => void
  wallet: WalletEngine
  zaps: ZapEngine
  onOpenWallet?: (intent?: WalletInitialIntent) => void
}

const ZAP_PRESETS = [21, 100, 500, 1000, 5000] as const

async function copyTextSafe(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

function ZapModalInner({
  target,
  onClose,
  wallet,
  zaps,
  onOpenWallet,
}: {
  target: ZapTarget
  onClose: () => void
  wallet: WalletEngine
  zaps: ZapEngine
  onOpenWallet?: (intent?: WalletInitialIntent) => void
}) {
  const initialLud16 = target.lud16 || zaps.getPeerLightningAddress(target.pubkey)
  const [resolvedLud16, setResolvedLud16] = useState<string | null>(initialLud16)
  const [resolvingAddress, setResolvingAddress] = useState<boolean>(!initialLud16)
  const [amountInput, setAmountInput] = useState<string>('100')
  const [comment, setComment] = useState<string>('')

  const [stage, setStage] = useState<'compose' | 'invoice' | 'paid'>('compose')
  const [working, setWorking] = useState<boolean>(false)
  const [error, setError] = useState<string | null>(null)
  const [invoiceResult, setInvoiceResult] = useState<ZapInvoiceResult | null>(null)
  const [qrSvg, setQrSvg] = useState<string | null>(null)
  const [copiedInvoice, setCopiedInvoice] = useState<boolean>(false)
  const [paidSummary, setPaidSummary] = useState<{
    amountSats: number
    feePaidSats: number
  } | null>(null)

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

  useEffect(() => {
    if (resolvedLud16) return
    let cancelled = false
    zaps
      .lookupPeerLightningAddress(target.pubkey)
      .then((found) => {
        if (!cancelled) {
          setResolvedLud16(found)
          setResolvingAddress(false)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setResolvingAddress(false)
        }
      })
    return () => {
      cancelled = true
    }
  }, [resolvedLud16, target.pubkey, zaps])

  useEffect(() => {
    if (!invoiceResult?.invoice) return
    let cancelled = false
    generateQrSvg(`lightning:${invoiceResult.invoice}`)
      .then((svg) => {
        if (!cancelled) setQrSvg(svg)
      })
      .catch(() => {
        if (!cancelled) setQrSvg(null)
      })
    return () => {
      cancelled = true
    }
  }, [invoiceResult?.invoice])

  const parsedAmount = Math.floor(Number.parseInt(amountInput, 10) || 0)
  const recipientName = target.nickname?.trim() || formatShortPubkey(target.pubkey)

  const bestMintUrl = (() => {
    if (wallet.activeMintBalanceSats >= parsedAmount) return wallet.activeMintUrl
    let best = wallet.activeMintUrl
    let bestBal = wallet.activeMintBalanceSats
    for (const [url, bal] of Object.entries(wallet.balancesByMint)) {
      if (bal > bestBal) {
        bestBal = bal
        best = url
      }
    }
    return best
  })()
  const bestMintBalance = wallet.balancesByMint[bestMintUrl] ?? 0
  const canPayWithCashu = parsedAmount > 0 && bestMintBalance >= parsedAmount

  const handleGetInvoice = useCallback(async () => {
    if (parsedAmount <= 0) {
      setError('Enter a positive amount in sats.')
      return
    }
    setWorking(true)
    setError(null)
    setQrSvg(null)
    try {
      const res = await zaps.requestZapInvoice({
        target: { ...target, lud16: resolvedLud16 },
        amountSats: parsedAmount,
        comment: comment.trim() || undefined,
      })
      setInvoiceResult(res)
      setStage('invoice')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to generate Lightning invoice.')
    } finally {
      setWorking(false)
    }
  }, [comment, parsedAmount, resolvedLud16, target, zaps])

  const handlePayWithCashu = useCallback(async () => {
    if (parsedAmount <= 0) {
      setError('Enter a positive amount in sats.')
      return
    }
    setWorking(true)
    setError(null)
    try {
      const zapRes =
        invoiceResult && invoiceResult.amountSats === parsedAmount
          ? invoiceResult
          : await zaps.requestZapInvoice({
              target: { ...target, lud16: resolvedLud16 },
              amountSats: parsedAmount,
              comment: comment.trim() || undefined,
            })

      setInvoiceResult(zapRes)

      const payRes = await wallet.payBolt11Invoice(zapRes.invoice, {
        txType: 'zap_out',
        counterparty: `${recipientName} (${zapRes.recipientLud16})`,
        memo: comment.trim() || `Zap to ${recipientName}`,
        mintUrl: bestMintUrl,
      })

      setPaidSummary({
        amountSats: payRes.amountSats,
        feePaidSats: payRes.feePaidSats,
      })
      setStage('paid')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Payment failed.')
    } finally {
      setWorking(false)
    }
  }, [
    bestMintUrl,
    comment,
    invoiceResult,
    parsedAmount,
    recipientName,
    resolvedLud16,
    target,
    wallet,
    zaps,
  ])

  const handleCopyInvoice = useCallback(async () => {
    if (!invoiceResult?.invoice) return
    const ok = await copyTextSafe(invoiceResult.invoice)
    if (ok) {
      setCopiedInvoice(true)
      window.setTimeout(() => setCopiedInvoice(false), 1800)
    }
  }, [invoiceResult?.invoice])

  const handleOpenTopUp = useCallback(() => {
    onClose()
    onOpenWallet?.({ tab: 'receive', receiveMode: 'lightning' })
  }, [onClose, onOpenWallet])

  return (
    <div
      className="ag-zap-backdrop"
      onClick={onClose}
      role="presentation"
      data-no-swipe="true"
    >
      <div
        className="ag-zap-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ag-zap-modal-title"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="ag-wallet-header">
          <div className="ag-wallet-title-group">
            <div className="ag-wallet-title-copy">
              <h2 id="ag-zap-modal-title" className="ag-wallet-title truncate">
                Zap
              </h2>
            </div>
          </div>

          <button
            type="button"
            className="ag-wallet-close-btn"
            onClick={onClose}
            aria-label="Close Zap dialog"
            title="Close (Esc)"
          >
            <X size={18} />
          </button>
        </header>

        <div className="ag-wallet-body">
          {/* Recipient Strip */}
          <div className="ag-zap-recipient-row">
            <div className="ag-zap-recipient-copy">
              <span className="ag-zap-recipient-name truncate">{recipientName}</span>
              {resolvingAddress ? (
                <span className="ag-wallet-meta">Looking up…</span>
              ) : resolvedLud16 ? (
                <span className="ag-zap-recipient-lud16" title={resolvedLud16}>
                  ⚡ {resolvedLud16}
                </span>
              ) : (
                <span className="ag-wallet-meta">No Lightning address</span>
              )}
            </div>
            {invoiceResult?.allowsNostr && <span className="ag-wallet-pill accent">NIP-57</span>}
          </div>

          {error && (
            <div className="ag-wallet-banner danger" role="alert">
              <AlertCircle size={15} />
              <span>{error}</span>
            </div>
          )}

          {stage === 'paid' && paidSummary ? (
            <div className="ag-zap-success">
              <div className="ag-zap-success-ring" aria-hidden="true">
                <Check size={26} />
              </div>
              <div>
                <div className="ag-wallet-balance-amount" style={{ justifyContent: 'center' }}>
                  <span>{paidSummary.amountSats.toLocaleString()}</span>
                  <span className="ag-wallet-balance-unit">sats</span>
                </div>
                <p className="ag-wallet-subtitle" style={{ marginTop: '0.35rem' }}>
                  Sent to {recipientName}
                  {paidSummary.feePaidSats > 0 ? ` · ${paidSummary.feePaidSats} sat fee` : ''}
                </p>
              </div>
              <button
                type="button"
                className="ag-wbtn ag-wbtn-primary ag-wbtn-full"
                onClick={onClose}
              >
                Done
              </button>
            </div>
          ) : stage === 'invoice' && invoiceResult ? (
            <>
              <div className="ag-wallet-qr-wrap">
                <div className="ag-wallet-qr-frame" aria-label="Lightning Zap Invoice QR Code">
                  {qrSvg ? (
                    <div
                      className="ag-wallet-qr-svg"
                      dangerouslySetInnerHTML={{ __html: qrSvg }}
                    />
                  ) : (
                    <Loader2 size={24} className="ag-wallet-spin" />
                  )}
                </div>

                <div className="ag-wallet-tonal" style={{ width: '100%' }}>
                  <div className="ag-wallet-kv-list">
                    <div className="ag-wallet-kv">
                      <span className="ag-wallet-kv-label">Amount</span>
                      <span className="ag-wallet-kv-val tabular">
                        {invoiceResult.amountSats.toLocaleString()} sats
                      </span>
                    </div>
                    <div className="ag-wallet-kv">
                      <span className="ag-wallet-kv-label">To</span>
                      <span className="ag-wallet-kv-val mono">{invoiceResult.recipientLud16}</span>
                    </div>
                    <div className="ag-wallet-kv">
                      <span className="ag-wallet-kv-label">Type</span>
                      <span className="ag-wallet-kv-val">
                        {invoiceResult.allowsNostr ? 'NIP-57 Zap' : 'LNURL-Pay'}
                      </span>
                    </div>
                  </div>
                </div>

                <div className="ag-wallet-code-box" title={invoiceResult.invoice}>
                  {invoiceResult.invoice}
                </div>
              </div>

              <div className="ag-wallet-btn-row">
                {canPayWithCashu && (
                  <button
                    type="button"
                    className="ag-wbtn ag-wbtn-primary ag-wbtn-full"
                    disabled={working}
                    onClick={() => void handlePayWithCashu()}
                  >
                    {working ? (
                      <Loader2 size={15} className="ag-wallet-spin" />
                    ) : (
                      <Wallet size={15} />
                    )}
                    <span>
                      {working
                        ? 'Paying…'
                        : `Pay ${invoiceResult.amountSats.toLocaleString()} sats`}
                    </span>
                  </button>
                )}

                <button
                  type="button"
                  className="ag-wbtn ag-wbtn-secondary ag-wbtn-grow"
                  onClick={() => void handleCopyInvoice()}
                >
                  {copiedInvoice ? <Check size={15} /> : <Copy size={15} />}
                  <span>{copiedInvoice ? 'Copied' : 'Copy'}</span>
                </button>

                <a
                  href={`lightning:${invoiceResult.invoice}`}
                  className="ag-wbtn ag-wbtn-secondary ag-wbtn-grow"
                  style={{ textDecoration: 'none' }}
                >
                  <ExternalLink size={15} />
                  <span>Open App</span>
                </a>
              </div>

              <button
                type="button"
                className="ag-wbtn ag-wbtn-ghost ag-wbtn-sm ag-wbtn-full"
                onClick={() => {
                  setStage('compose')
                  setInvoiceResult(null)
                  setError(null)
                }}
              >
                Change Amount
              </button>
            </>
          ) : (
            <>
              <div className="ag-wallet-field">
                <div className="ag-wallet-label-row">
                  <span className="ag-wallet-label">Amount (sats)</span>
                  <span className="ag-wallet-meta tabular">
                    {wallet.totalBalanceSats.toLocaleString()} sats available
                  </span>
                </div>
                <div className="ag-wallet-presets">
                  {ZAP_PRESETS.map((amt) => (
                    <button
                      key={amt}
                      type="button"
                      className={`ag-wallet-preset-btn ${parsedAmount === amt ? 'active' : ''}`}
                      onClick={() => {
                        setAmountInput(String(amt))
                        setError(null)
                      }}
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
                  value={amountInput}
                  onChange={(e) => {
                    setAmountInput(e.target.value)
                    setError(null)
                  }}
                  placeholder="Custom sats"
                  aria-label="Zap amount in satoshis"
                />
              </div>

              <div className="ag-wallet-field">
                <label className="ag-wallet-label" htmlFor="ag-zap-comment">
                  Note (optional)
                </label>
                <input
                  id="ag-zap-comment"
                  type="text"
                  maxLength={200}
                  className="ag-wallet-input"
                  value={comment}
                  onChange={(e) => setComment(e.target.value)}
                  placeholder="Optional note"
                />
              </div>

              <div className="ag-zap-wallet-strip">
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 600, color: 'var(--text-primary)' }}>Agwallet</div>
                  <div className="ag-wallet-meta truncate">
                    {formatMintHost(bestMintUrl)} · {bestMintBalance.toLocaleString()} sats
                  </div>
                </div>
                {!canPayWithCashu && onOpenWallet && (
                  <button
                    type="button"
                    className="ag-wbtn ag-wbtn-link"
                    onClick={handleOpenTopUp}
                  >
                    Top up
                  </button>
                )}
              </div>

              <div className="ag-wallet-btn-row">
                <button
                  type="button"
                  className="ag-wbtn ag-wbtn-primary ag-wbtn-full"
                  disabled={working || resolvingAddress || !resolvedLud16 || !canPayWithCashu}
                  onClick={() => void handlePayWithCashu()}
                >
                  {working ? (
                    <Loader2 size={15} className="ag-wallet-spin" />
                  ) : (
                    <Zap size={15} />
                  )}
                  <span>
                    {working
                      ? 'Zapping…'
                      : canPayWithCashu
                        ? `Pay ${parsedAmount.toLocaleString()} sats`
                        : 'Insufficient Balance'}
                  </span>
                </button>

                <button
                  type="button"
                  className="ag-wbtn ag-wbtn-secondary ag-wbtn-full"
                  disabled={working || resolvingAddress || !resolvedLud16 || parsedAmount <= 0}
                  onClick={() => void handleGetInvoice()}
                >
                  {working ? (
                    <Loader2 size={15} className="ag-wallet-spin" />
                  ) : (
                    <QrCode size={15} />
                  )}
                  <span>Show QR Invoice</span>
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

export function ZapModal({
  target,
  onClose,
  wallet,
  zaps,
  onOpenWallet,
}: ZapModalProps) {
  if (!target || typeof document === 'undefined') return null

  return createPortal(
    <ZapModalInner
      key={`${target.pubkey}:${target.eventId ?? ''}:${target.lud16 ?? ''}`}
      target={target}
      onClose={onClose}
      wallet={wallet}
      zaps={zaps}
      onOpenWallet={onOpenWallet}
    />,
    document.body
  )
}

export default ZapModal
