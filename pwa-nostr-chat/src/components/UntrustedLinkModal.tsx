import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { AlertTriangle, Check, Copy, ExternalLink, X } from 'lucide-react'
import { useBackHandler } from '../hooks/useBackNavigation.ts'
import {
  parseAgoraShareUrl,
  type ParsedAgoraNoteShareTarget,
  type ParsedAgoraProfileShareTarget,
} from '../lib/shareLinks.ts'

export interface UntrustedLinkRequest {
  url: string
  senderHandle?: string
  senderPubkey?: string
}

type UntrustedLinkListener = (req: UntrustedLinkRequest) => void
type InternalAgoraLinkTarget = ParsedAgoraNoteShareTarget | ParsedAgoraProfileShareTarget
type InternalAgoraLinkHandler = (target: InternalAgoraLinkTarget) => void

const listeners = new Set<UntrustedLinkListener>()
let internalAgoraLinkHandler: InternalAgoraLinkHandler | null = null

// eslint-disable-next-line react-refresh/only-export-components
export function registerInternalAgoraLinkHandler(
  handler: InternalAgoraLinkHandler | null
): void {
  internalAgoraLinkHandler = handler
}

// eslint-disable-next-line react-refresh/only-export-components
export function tryOpenInternalAgoraLink(rawUrl: string): boolean {
  if (!internalAgoraLinkHandler) return false
  const target = parseAgoraShareUrl(rawUrl)
  if (!target) return false
  internalAgoraLinkHandler(target)
  return true
}

function sanitizeExternalHttpUrl(raw: string): { safeUrl: string; hostname: string } | null {
  const trimmed = raw.trim()
  if (!trimmed || !/^https?:\/\//i.test(trimmed)) return null
  try {
    const parsed = new URL(trimmed)
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null
    return {
      safeUrl: parsed.toString(),
      hostname: parsed.hostname || parsed.host,
    }
  } catch {
    return null
  }
}

// eslint-disable-next-line react-refresh/only-export-components
export function requestUntrustedLinkOpen(req: UntrustedLinkRequest): void {
  const checked = sanitizeExternalHttpUrl(req.url)
  if (!checked) return
  const normalized: UntrustedLinkRequest = {
    url: checked.safeUrl,
    senderHandle: req.senderHandle?.trim() || undefined,
    senderPubkey: req.senderPubkey?.trim().toLowerCase() || undefined,
  }
  if (listeners.size === 0) {
    if (typeof window !== 'undefined') {
      const senderNote = normalized.senderHandle ? ` from ${normalized.senderHandle}` : ''
      const ok = window.confirm(
        `Open external link${senderNote}?\n\nDomain: ${checked.hostname}\n${checked.safeUrl}`
      )
      if (ok) {
        if (!tryOpenInternalAgoraLink(checked.safeUrl)) {
          window.open(checked.safeUrl, '_blank', 'noopener,noreferrer')
        }
      }
    }
    return
  }
  for (const listener of listeners) {
    listener(normalized)
  }
}

export const UntrustedLinkModal: React.FC = () => {
  const [pending, setPending] = useState<UntrustedLinkRequest | null>(null)
  const [copied, setCopied] = useState(false)
  const cancelBtnRef = useRef<HTMLButtonElement | null>(null)
  const copyTimerRef = useRef<number | null>(null)

  useEffect(() => {
    const onRequest: UntrustedLinkListener = (req) => {
      setCopied(false)
      setPending(req)
    }
    listeners.add(onRequest)
    return () => {
      listeners.delete(onRequest)
      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current)
        copyTimerRef.current = null
      }
    }
  }, [])

  const close = useCallback(() => {
    setPending(null)
    setCopied(false)
  }, [])

  useBackHandler(Boolean(pending), close)

  useEffect(() => {
    if (!pending) return
    const focusTimer = window.setTimeout(() => {
      cancelBtnRef.current?.focus()
    }, 10)
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        e.stopImmediatePropagation()
        close()
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => {
      window.clearTimeout(focusTimer)
      window.removeEventListener('keydown', onKeyDown, true)
    }
  }, [pending, close])

  const parsed = useMemo(
    () => (pending ? sanitizeExternalHttpUrl(pending.url) : null),
    [pending]
  )

  const handleCopy = useCallback(async () => {
    if (!parsed) return
    try {
      await navigator.clipboard.writeText(parsed.safeUrl)
      setCopied(true)
      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current)
      }
      copyTimerRef.current = window.setTimeout(() => {
        copyTimerRef.current = null
        setCopied(false)
      }, 2000)
    } catch {
      // Ignore clipboard permission denial
    }
  }, [parsed])

  const handleOpenAnyway = useCallback(() => {
    if (!parsed) return
    const targetUrl = parsed.safeUrl
    close()
    if (tryOpenInternalAgoraLink(targetUrl)) {
      return
    }
    window.open(targetUrl, '_blank', 'noopener,noreferrer')
  }, [parsed, close])

  if (!pending || !parsed || typeof document === 'undefined') {
    return null
  }

  const formattedSender = pending.senderHandle
    ? pending.senderHandle.startsWith('@')
      ? pending.senderHandle
      : `@${pending.senderHandle}`
    : null

  return createPortal(
    <div
      className="ag-inline-dialog-backdrop ag-untrusted-link-modal-backdrop"
      onClick={close}
    >
      <div
        className="ag-inline-dialog ag-untrusted-link-modal"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="ag-untrusted-link-title"
        aria-describedby="ag-untrusted-link-desc"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="ag-untrusted-link-modal-head">
          <span className="ag-untrusted-link-modal-icon" aria-hidden="true">
            <AlertTriangle size={18} />
          </span>
          <div className="ag-untrusted-link-modal-title-wrap">
            <h2 id="ag-untrusted-link-title" className="ag-untrusted-link-modal-title">
              External Link From Untrusted Person
            </h2>
            {formattedSender && (
              <span className="ag-untrusted-link-modal-sender mono truncate">
                Sent by {formattedSender}
              </span>
            )}
          </div>
          <button
            type="button"
            className="ag-circle-btn ag-inline-dialog-close"
            onClick={close}
            aria-label="Close warning"
          >
            <X size={16} />
          </button>
        </div>

        <p id="ag-untrusted-link-desc" className="ag-untrusted-link-modal-copy">
          {formattedSender ? `${formattedSender} is` : 'This sender is'} not in your Trusted
          People list. External links can expose your IP address, impersonate login pages
          (phishing), or trigger malicious downloads. Verify the domain before opening.
        </p>

        <div className="ag-untrusted-link-modal-preview">
          <div className="ag-untrusted-link-modal-domain-row">
            <span className="ag-untrusted-link-modal-domain-label">Domain</span>
            <span className="ag-untrusted-link-modal-domain mono">{parsed.hostname}</span>
          </div>
          <div className="ag-untrusted-link-modal-url mono" title={parsed.safeUrl}>
            {parsed.safeUrl}
          </div>
        </div>

        <div className="ag-untrusted-link-modal-actions">
          <button
            ref={cancelBtnRef}
            type="button"
            className="ag-btn ag-btn-primary"
            onClick={close}
          >
            Cancel
          </button>
          <button
            type="button"
            className="ag-btn ag-btn-secondary"
            onClick={() => void handleCopy()}
          >
            {copied ? <Check size={14} /> : <Copy size={14} />}
            <span>{copied ? 'Copied!' : 'Copy Link'}</span>
          </button>
          <button
            type="button"
            className="ag-btn ag-untrusted-link-modal-open-btn"
            onClick={handleOpenAnyway}
          >
            <ExternalLink size={14} />
            <span>Open Anyway</span>
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
