import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAgnostrEngine } from './hooks/useAgnostrEngine'
import type { GeoMessage, InspectorTab, PeerInfo, ThemeId } from './types/protocol'
import { radioAudio, type SoundCue } from './utils/sound'
import Sidebar from './components/Sidebar'
import ChannelHeader from './components/ChannelHeader'
import SearchBar from './components/SearchBar'
import MessageStream from './components/MessageStream'
import Composer from './components/Composer'
import CommandPalette from './components/CommandPalette'
import ToastStack from './components/ToastStack'
import InspectorDrawer from './components/InspectorDrawer'
import PeerInspectorModal from './components/PeerInspectorModal'

const THEME_META_COLORS: Record<ThemeId, string> = {
  phosphor: '#090C0A',
  amber: '#0D0A07',
  obsidian: '#09090F',
  daylight: '#F4F5F2',
}

const ZERO_ARG_COMMANDS = new Set(['/who', '/w', '/help', '/clear', '/notes', '/burn'])

function getInitialViewportFlags() {
  if (typeof window === 'undefined') {
    return { sidebar: true, inspector: true }
  }
  return {
    sidebar: window.innerWidth >= 768,
    inspector: window.innerWidth >= 1100,
  }
}

export function App() {
  const engine = useAgnostrEngine()

  const initialFlags = useMemo(() => getInitialViewportFlags(), [])
  const [sidebarOpen, setSidebarOpen] = useState(initialFlags.sidebar)
  const [inspectorOpen, setInspectorOpen] = useState(initialFlags.inspector)
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>('radar')
  const [cmdkOpen, setCmdkOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchMatchIdx, setSearchMatchIdx] = useState(0)
  const [inspectedPeer, setInspectedPeer] = useState<PeerInfo | null>(null)
  const [externalDraftToken, setExternalDraftToken] = useState<{ id: number; text: string } | null>(
    null
  )
  const [panicFlash, setPanicFlash] = useState(false)

  // Sync theme attribute & browser chrome <meta name="theme-color">
  useEffect(() => {
    const theme = engine.settings.theme
    document.documentElement.setAttribute('data-theme', theme)
    const meta = document.querySelector('meta[name="theme-color"]')
    if (meta) {
      meta.setAttribute('content', THEME_META_COLORS[theme] ?? THEME_META_COLORS.phosphor)
    }
  }, [engine.settings.theme])

  // Sync audio synthesizer enabled state
  useEffect(() => {
    radioAudio.setEnabled(engine.settings.soundEnabled)
  }, [engine.settings.soundEnabled])

  // Sync dynamic document title with active channel or DM
  useEffect(() => {
    const unreadPrefix = engine.totalDmUnread > 0 ? `(${engine.totalDmUnread}) ` : ''
    if (engine.activeView.type === 'dm' && engine.activeDmThread) {
      document.title = `${unreadPrefix}${engine.activeDmThread.peerDisplayHandle} · Agnostr`
    } else {
      document.title = `${unreadPrefix}#${engine.activeGeohash} · Agnostr`
    }
  }, [engine.activeView, engine.activeGeohash, engine.activeDmThread, engine.totalDmUnread])

  // Subtle audio cue when fresh live messages arrive
  const lastMsgIdRef = useRef<string | null>(null)
  const lastChannelRef = useRef<string>(engine.activeGeohash)
  useEffect(() => {
    const list = engine.messages
    if (lastChannelRef.current !== engine.activeGeohash) {
      lastChannelRef.current = engine.activeGeohash
      lastMsgIdRef.current = list.length ? list[list.length - 1].id : null
      return
    }
    if (!list.length) return
    const newest = list[list.length - 1]
    if (newest.id === lastMsgIdRef.current) return
    lastMsgIdRef.current = newest.id

    const nowSec = Math.floor(Date.now() / 1000)
    if (!newest.isOwn && !newest.isSystem && nowSec - newest.createdAt <= 30) {
      const nickLower = engine.identity.nickname.toLowerCase()
      const mentionsUs =
        newest.mentions.includes(engine.identity.activePubkey) ||
        (nickLower.length > 0 && newest.content.toLowerCase().includes(`@${nickLower}`))
      radioAudio.play(mentionsUs ? 'mention' : 'receive')
    }
  }, [engine.messages, engine.activeGeohash, engine.identity.nickname, engine.identity.activePubkey])

  // Audio cue on incoming unread DM
  const prevDmUnreadRef = useRef(engine.totalDmUnread)
  useEffect(() => {
    if (engine.totalDmUnread > prevDmUnreadRef.current) {
      radioAudio.play('dm')
    }
    prevDmUnreadRef.current = engine.totalDmUnread
  }, [engine.totalDmUnread])

  // Detect identity panic wipe (masterPubkey changes while messages cleared) for subtle flash
  const prevMasterPkRef = useRef(engine.identity.masterPubkey)
  useEffect(() => {
    if (
      prevMasterPkRef.current &&
      engine.identity.masterPubkey &&
      prevMasterPkRef.current !== engine.identity.masterPubkey
    ) {
      setPanicFlash(true)
      const t = window.setTimeout(() => setPanicFlash(false), 700)
      prevMasterPkRef.current = engine.identity.masterPubkey
      return () => window.clearTimeout(t)
    }
    prevMasterPkRef.current = engine.identity.masterPubkey
  }, [engine.identity.masterPubkey])

  // Compute in-stream search matches
  const searchMatchIds = useMemo(() => {
    const q = searchQuery.trim().toLowerCase()
    if (!q) return []
    if (engine.activeView.type === 'dm' && engine.activeDmThread) {
      return engine.activeDmThread.messages
        .filter((m) => m.content.toLowerCase().includes(q))
        .map((m) => m.id)
    }
    return engine.messages
      .filter(
        (m) =>
          m.content.toLowerCase().includes(q) ||
          m.nickname.toLowerCase().includes(q) ||
          m.displayHandle.toLowerCase().includes(q)
      )
      .map((m) => m.id)
  }, [searchQuery, engine.activeView, engine.activeDmThread, engine.messages])

  useEffect(() => {
    setSearchMatchIdx(searchMatchIds.length > 0 ? searchMatchIds.length - 1 : 0)
  }, [searchQuery, engine.activeGeohash, engine.activeView.type, searchMatchIds.length])

  const activeSearchMessageId =
    searchOpen && searchMatchIds.length > 0
      ? searchMatchIds[Math.min(searchMatchIdx, searchMatchIds.length - 1)]
      : null

  // Global keyboard shortcuts
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey
      if (mod && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setCmdkOpen((v) => !v)
        return
      }
      if (mod && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        setSearchOpen((v) => !v)
        return
      }
      if (mod && e.key.toLowerCase() === 'b') {
        e.preventDefault()
        setSidebarOpen((v) => !v)
        return
      }
      if (mod && e.key.toLowerCase() === 'i') {
        e.preventDefault()
        setInspectorOpen((v) => !v)
        return
      }
      if (e.key === 'Escape') {
        if (cmdkOpen) {
          setCmdkOpen(false)
        } else if (inspectedPeer) {
          setInspectedPeer(null)
        } else if (searchOpen) {
          setSearchOpen(false)
          setSearchQuery('')
        } else if (inspectorOpen && window.innerWidth < 1100) {
          setInspectorOpen(false)
        } else if (sidebarOpen && window.innerWidth < 768) {
          setSidebarOpen(false)
        }
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [cmdkOpen, inspectedPeer, searchOpen, inspectorOpen, sidebarOpen])

  const playSound = useCallback((cue: SoundCue) => {
    radioAudio.play(cue)
  }, [])

  const handleTuneChannel = useCallback(
    (geohash: string): boolean => {
      const ok = engine.tuneGeohash(geohash)
      if (ok) {
        radioAudio.play('tune')
        if (typeof window !== 'undefined' && window.innerWidth < 768) {
          setSidebarOpen(false)
        }
        if (typeof window !== 'undefined' && window.innerWidth < 1100) {
          setInspectorOpen(false)
        }
      }
      return ok
    },
    [engine]
  )

  const handleOpenDm = useCallback(
    (pubkey: string, nickname?: string) => {
      engine.openDmThread(pubkey, nickname)
      radioAudio.play('click')
      setInspectedPeer(null)
      if (typeof window !== 'undefined' && window.innerWidth < 768) {
        setSidebarOpen(false)
      }
      if (typeof window !== 'undefined' && window.innerWidth < 1100) {
        setInspectorOpen(false)
      }
    },
    [engine]
  )

  const handleMentionPeer = useCallback((handle: string) => {
    const clean = handle.startsWith('@') ? handle : `@${handle}`
    setExternalDraftToken({ id: Date.now(), text: `${clean} ` })
    setInspectedPeer(null)
    if (typeof window !== 'undefined' && window.innerWidth < 1100) {
      setInspectorOpen(false)
    }
  }, [])

  const handleClickInlineMention = useCallback(
    (mention: string) => {
      const lower = mention.toLowerCase()
      const matched = engine.peers.find(
        (p) =>
          p.displayHandle.toLowerCase() === `@${lower}` ||
          p.nickname.toLowerCase() === lower ||
          p.displayHandle.toLowerCase().includes(lower)
      )
      if (matched) {
        setInspectedPeer(matched)
      } else {
        handleMentionPeer(mention)
      }
    },
    [engine.peers, handleMentionPeer]
  )

  const handleOpenInspectorTab = useCallback(
    (tab: InspectorTab) => {
      setInspectorTab(tab)
      setInspectorOpen(true)
      if (typeof window !== 'undefined' && window.innerWidth < 768) {
        setSidebarOpen(false)
      }
    },
    []
  )

  const handleToggleSound = useCallback(() => {
    const next = !engine.settings.soundEnabled
    engine.updateSettings({ soundEnabled: next })
    radioAudio.setEnabled(next)
    if (next) {
      radioAudio.play('tune', true)
    }
  }, [engine])

  const handleLocateMe = useCallback(async () => {
    const found = await engine.locateMe()
    if (found) {
      radioAudio.play('tune')
      if (typeof window !== 'undefined' && window.innerWidth < 768) {
        setSidebarOpen(false)
      }
    }
  }, [engine])

  const handleReply = useCallback(
    (msg: GeoMessage) => {
      engine.setReplyingTo(msg)
      setExternalDraftToken((prev) => ({ id: (prev?.id ?? 0) + 1, text: '' }))
    },
    [engine]
  )

  const handleReact = useCallback(
    (msg: GeoMessage, emoji: string) => {
      radioAudio.play('click')
      void engine.sendReaction(msg, emoji)
    },
    [engine]
  )

  const handleRunCommand = useCallback(
    (cmdLine: string) => {
      const normalized = cmdLine.trim().toLowerCase()
      if (ZERO_ARG_COMMANDS.has(normalized)) {
        void engine.sendInput(cmdLine)
        return
      }
      setExternalDraftToken({ id: Date.now(), text: `${cmdLine.trim()} ` })
    },
    [engine]
  )

  const handleExport = useCallback(
    (format: 'markdown' | 'json') => {
      const file = engine.exportTranscript(format)
      try {
        const blob = new Blob([file.content], { type: file.mimeType })
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = file.filename
        document.body.appendChild(a)
        a.click()
        document.body.removeChild(a)
        URL.revokeObjectURL(url)
        engine.pushToast('success', `Exported ${file.filename}`)
      } catch {
        engine.pushToast('error', 'Failed to export transcript')
      }
    },
    [engine]
  )

  return (
    <div className={`ag-app ${panicFlash ? 'ag-panic-active' : ''}`}>
      {/* Mobile Left Sidebar Scrim */}
      {sidebarOpen && (
        <div
          className="ag-backdrop ag-mobile-only"
          onClick={() => setSidebarOpen(false)}
          aria-hidden="true"
        />
      )}

      {/* Left Frequency & Global Pulse Rail */}
      <Sidebar
        engine={engine}
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        onTuneChannel={handleTuneChannel}
        onOpenDm={handleOpenDm}
        onOpenCommandPalette={() => setCmdkOpen(true)}
        onOpenInspectorTab={handleOpenInspectorTab}
        onLocateMe={() => void handleLocateMe()}
      />

      {/* Center Stage */}
      <main className={`ag-main ${engine.activeView.type === 'dm' ? 'dm-mode' : ''}`}>
        <ChannelHeader
          engine={engine}
          sidebarOpen={sidebarOpen}
          inspectorOpen={inspectorOpen}
          inspectorTab={inspectorTab}
          searchOpen={searchOpen}
          onToggleSidebar={() => setSidebarOpen((v) => !v)}
          onOpenInspectorTab={handleOpenInspectorTab}
          onToggleInspector={() => setInspectorOpen((v) => !v)}
          onToggleSearch={() => {
            setSearchOpen((v) => {
              if (v) setSearchQuery('')
              return !v
            })
          }}
          onToggleSound={handleToggleSound}
          onTuneChannel={handleTuneChannel}
          onLocateMe={() => void handleLocateMe()}
          onInspectPeer={setInspectedPeer}
        />

        <SearchBar
          open={searchOpen}
          query={searchQuery}
          matchCount={searchMatchIds.length}
          activeMatchIndex={searchMatchIdx}
          onQueryChange={setSearchQuery}
          onPrev={() =>
            setSearchMatchIdx((i) =>
              searchMatchIds.length ? (i - 1 + searchMatchIds.length) % searchMatchIds.length : 0
            )
          }
          onNext={() =>
            setSearchMatchIdx((i) =>
              searchMatchIds.length ? (i + 1) % searchMatchIds.length : 0
            )
          }
          onClose={() => {
            setSearchOpen(false)
            setSearchQuery('')
          }}
        />

        <MessageStream
          engine={engine}
          searchQuery={searchOpen ? searchQuery : ''}
          activeSearchMessageId={activeSearchMessageId}
          onReply={handleReply}
          onReact={handleReact}
          onInspectPeer={setInspectedPeer}
          onStartDm={handleOpenDm}
          onTuneChannel={handleTuneChannel}
          onClickMention={handleClickInlineMention}
          onLocateMe={() => void handleLocateMe()}
          onOpenRadar={() => handleOpenInspectorTab('radar')}
          onRunHelpCommand={() => void engine.sendInput('/help')}
        />

        <Composer
          engine={engine}
          externalDraftToken={externalDraftToken}
          onSent={(isDm) => radioAudio.play(isDm ? 'dm' : 'send')}
        />
      </main>

      {/* Right Tabbed Inspector Drawer (Geo Radar | Peers | Notes | Relays | Identity) */}
      <InspectorDrawer
        engine={engine}
        activeTab={inspectorTab}
        onTabChange={setInspectorTab}
        open={inspectorOpen}
        onClose={() => setInspectorOpen(false)}
        onInspectPeer={setInspectedPeer}
        onMentionPeer={handleMentionPeer}
        onStartDm={handleOpenDm}
        onTuneChannel={handleTuneChannel}
        onPlaySound={playSound}
      />

      {/* Peer Profile & Moderation Modal */}
      <PeerInspectorModal
        peer={inspectedPeer}
        engine={engine}
        onClose={() => setInspectedPeer(null)}
        onStartDm={handleOpenDm}
        onMentionPeer={handleMentionPeer}
      />

      {/* Spotlight Command Palette (Cmd+K) */}
      <CommandPalette
        open={cmdkOpen}
        engine={engine}
        onClose={() => setCmdkOpen(false)}
        onTuneChannel={handleTuneChannel}
        onLocateMe={() => void handleLocateMe()}
        onOpenInspectorTab={handleOpenInspectorTab}
        onToggleSound={handleToggleSound}
        onRunCommand={handleRunCommand}
        onExport={handleExport}
      />

      {/* Tactical Non-Blocking Notifications */}
      <ToastStack toasts={engine.toasts} onDismiss={engine.dismissToast} />
    </div>
  )
}

export default App
