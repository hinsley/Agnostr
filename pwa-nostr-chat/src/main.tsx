import { Component, StrictMode } from 'react'
import type { ErrorInfo, ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles/tokens.css'
import './styles/base.css'
import './styles/layout.css'
import './styles/components.css'
import './styles/panels.css'
import './styles/servers.css'
import './styles/radar.css'
import './styles/calls.css'
import './styles/media.css'
import App from './App.tsx'

declare global {
  interface Window {
    __AGNOSTR_BOOTED__?: boolean
    __AGNOSTR_BOOT_ERR__?: string
    __AGNOSTR_SHOW_RECOVERY__?: (reason?: string) => void
  }
}

const PRELOAD_RELOAD_GUARD_KEY = 'agnostr_preload_reload_ts'
const PRELOAD_RELOAD_WINDOW_MS = 30_000

/**
 * Unregister Service Workers and clear CacheStorage ONLY — NEVER touches
 * localStorage or IndexedDB so user keys, messages, and wallet stay 100% safe.
 */
async function refreshAppCacheAndReload(): Promise<void> {
  const tasks: Promise<unknown>[] = []
  try {
    if ('serviceWorker' in navigator && navigator.serviceWorker.getRegistrations) {
      tasks.push(
        navigator.serviceWorker
          .getRegistrations()
          .then((regs) => Promise.all(regs.map((reg) => reg.unregister())))
      )
    }
  } catch {
    /* ignore */
  }
  try {
    if ('caches' in window && window.caches?.keys) {
      tasks.push(
        window.caches
          .keys()
          .then((keys) => Promise.all(keys.map((key) => window.caches.delete(key))))
      )
    }
  } catch {
    /* ignore */
  }
  await Promise.allSettled(tasks)
  window.location.reload()
}

// Auto-recover cleanly (at most once per 30s) if a lazy chunk fails after a fresh deploy
window.addEventListener('vite:preloadError', (event) => {
  try {
    const now = Date.now()
    const lastTs = Number(sessionStorage.getItem(PRELOAD_RELOAD_GUARD_KEY) || '0')
    if (Number.isFinite(lastTs) && now - lastTs < PRELOAD_RELOAD_WINDOW_MS) {
      return
    }
    sessionStorage.setItem(PRELOAD_RELOAD_GUARD_KEY, String(now))
    event.preventDefault()
    window.location.reload()
  } catch {
    /* ignore storage failures */
  }
})

interface AppErrorBoundaryProps {
  children: ReactNode
}

interface AppErrorBoundaryState {
  error: Error | null
  refreshingCache: boolean
}

class AppErrorBoundary extends Component<AppErrorBoundaryProps, AppErrorBoundaryState> {
  state: AppErrorBoundaryState = {
    error: null,
    refreshingCache: false,
  }

  static getDerivedStateFromError(error: Error): Partial<AppErrorBoundaryState> {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    window.__AGNOSTR_BOOTED__ = true
    console.error('[Agnostr] Uncaught render error:', error, info.componentStack)
  }

  private handleRefreshCache = () => {
    if (this.state.refreshingCache) return
    this.setState({ refreshingCache: true })
    void refreshAppCacheAndReload()
  }

  render() {
    const { error, refreshingCache } = this.state
    if (!error) {
      return this.props.children
    }

    const message = error.message?.trim() || 'An unexpected error interrupted rendering.'

    return (
      <div
        role="alert"
        style={{
          minHeight: '100dvh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 24,
          backgroundColor: 'var(--bg-canvas, #0B0C0F)',
          color: 'var(--text-primary, #ECEFF4)',
          fontFamily: 'Inter, system-ui, -apple-system, sans-serif',
          boxSizing: 'border-box',
        }}
      >
        <div
          style={{
            width: '100%',
            maxWidth: 420,
            padding: 24,
            borderRadius: 16,
            backgroundColor: 'var(--bg-surface, #13161C)',
            border: '1px solid var(--border-subtle, rgba(255,255,255,0.1))',
            boxShadow: '0 18px 48px rgba(0,0,0,0.45)',
          }}
        >
          <h1
            style={{
              margin: '0 0 10px',
              fontSize: 18,
              fontWeight: 700,
              letterSpacing: '-0.01em',
              color: 'var(--text-primary, #F8FAFC)',
            }}
          >
            Agnostr ran into an unexpected error
          </h1>
          <p
            style={{
              margin: '0 0 14px',
              fontSize: 13.5,
              lineHeight: 1.5,
              color: 'var(--text-secondary, #9CA3AF)',
            }}
          >
            Your local keys, messages, and wallet data remain safe. Reload to continue or refresh
            the cached app bundle.
          </p>
          <p
            style={{
              margin: '0 0 18px',
              padding: '8px 10px',
              borderRadius: 8,
              backgroundColor: 'rgba(255,255,255,0.04)',
              border: '1px solid var(--border-subtle, rgba(255,255,255,0.08))',
              fontFamily: '"JetBrains Mono", ui-monospace, monospace',
              fontSize: 11.5,
              lineHeight: 1.4,
              color: 'var(--text-secondary, #CBD5E1)',
              wordBreak: 'break-word',
            }}
          >
            {message}
          </p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
            <button
              type="button"
              onClick={() => window.location.reload()}
              style={{
                flex: '1 1 120px',
                height: 38,
                padding: '0 16px',
                borderRadius: 10,
                border: 'none',
                backgroundColor: 'var(--accent, #22C55E)',
                color: 'var(--text-inverse, #052E16)',
                fontSize: 13.5,
                fontWeight: 700,
                cursor: 'pointer',
              }}
            >
              Reload
            </button>
            <button
              type="button"
              disabled={refreshingCache}
              onClick={this.handleRefreshCache}
              style={{
                flex: '1 1 160px',
                height: 38,
                padding: '0 16px',
                borderRadius: 10,
                border: '1px solid var(--border-default, rgba(255,255,255,0.16))',
                backgroundColor: 'var(--bg-elevated, rgba(255,255,255,0.05))',
                color: 'var(--text-primary, #F1F5F9)',
                fontSize: 13.5,
                fontWeight: 600,
                cursor: refreshingCache ? 'wait' : 'pointer',
                opacity: refreshingCache ? 0.7 : 1,
              }}
            >
              {refreshingCache ? 'Refreshing cache…' : 'Refresh App Cache'}
            </button>
          </div>
        </div>
      </div>
    )
  }
}

const rootEl = document.getElementById('root')
if (rootEl) {
  createRoot(rootEl).render(
    <StrictMode>
      <AppErrorBoundary>
        <App />
      </AppErrorBoundary>
    </StrictMode>
  )
  window.__AGNOSTR_BOOTED__ = true
}
