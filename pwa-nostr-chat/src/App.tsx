import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { RefreshCw, WifiOff, X } from 'lucide-react'
import { useAgnostrEngine } from './hooks/useAgnostrEngine'
import { usePwa } from './hooks/usePwa'
import type { GeoMessage, InspectorTab, PeerInfo, ThemeId } from './types/protocol'
import type { ServerMessage, ServerSummary } from './types/servers'
import { radioAudio, type SoundCue } from './utils/sound'
import ServerRail from './components/ServerRail'
import Sidebar from './components/Sidebar'
import ServerSidebar from './components/ServerSidebar'
import ServerHubModal, { type ServerHubTab } from './components/ServerHubModal'
import ServerSettingsModal, { type ServerSettingsTab } from './components/ServerSettingsModal'
import ChannelHeader from './components/ChannelHeader'
import SearchBar from './components/SearchBar'
import MessageStream from './components/MessageStream'
import Composer from './components/Composer'
import CommandPalette from './components/CommandPalette'
import ToastStack from './components/ToastStack'
import InspectorDrawer from './components/InspectorDrawer'
import PeerInspectorModal from './components/PeerInspectorModal'
import ExpandedRadarModal from './components/ExpandedRadarModal'
import PwaInstallModal from './components/PwaInstallModal'

const THEME_META_COLORS: Record<ThemeId, string> = {
  phosphor: '#090C0A',
  amber: '#0D0A07',
  obsidian: '#09090F',
  daylight: '#F4F5F2',
}

const ZERO_ARG_COMMANDS = new Set([
  '/who',
  '/w',
  '/help',
  '/clear',
  '/notes',
  '/burn',
  '/whitelist',
  '/trusted',
  '/strict',
])

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
  const [radarExpanded, setRadarExpanded] = useState(false)
  const [installModalOpen, setInstallModalOpen] = useState(false)
  const [serverHubState, setServerHubState] = useState<{ open: boolean; tab: ServerHubTab }>({
    open: false,
    tab: 'create',
  })
  const [serverSettingsState, setServerSettingsState] = useState<{
    serverId: string | null
    tab: ServerSettingsTab
  }>({
    serverId: null,
    tab: 'overview',
  })
  const [externalDraftToken, setExternalDraftToken] = useState<{ id: number; text: string } | null>(
    null
  )
  const [panicFlash, setPanicFlash] = useState(false)

  const isDm = engine.activeView.type === 'dm' && engine.activeDmThread !== null
  const isServer =
    engine.activeView.type === 'server' &&
    engine.servers.activeServer !== null &&
    engine.servers.activeChannel !== null
  const activeServer = engine.servers.activeServer
  const activeChannel = engine.servers.activeChannel
  const isServerE2ee = Boolean(isServer && activeServer?.encrypted)

  // Total unread count across DMs, Servers, and pinned Geohash channels for PWA App Badge
  const totalUnreadBadge = useMemo(() => {
    const pinnedUnread = engine.pinnedChannels.reduce((sum, ch) => sum + ch.unreadCount, 0)
    return engine.totalDmUnread + engine.servers.totalServerUnread + pinnedUnread
  }, [engine.totalDmUnread, engine.servers.totalServerUnread, engine.pinnedChannels])

  const pwa = usePwa(totalUnreadBadge)

  const settingsServer: ServerSummary | null = useMemo(() => {
    if (!serverSettingsState.serverId) return null
    return engine.servers.joinedServers.find((s) => s.id === serverSettingsState.serverId) ?? null
  }, [serverSettingsState.serverId, engine.servers.joinedServers])

  // Auto-open ServerHubModal on Join tab when `#invite=...` is detected in URL hash
  const pendingInviteCode = engine.servers.pendingInvite?.rawCode ?? null
  useEffect(() => {
    if (pendingInviteCode) {
      setServerHubState({ open: true, tab: 'join' })
    }
  }, [pendingInviteCode])

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

  // Sync dynamic document title with active channel, DM, or Server channel
  useEffect(() => {
    const totalUnread = engine.totalDmUnread + engine.servers.totalServerUnread
    const unreadPrefix = totalUnread > 0 ? `(${totalUnread}) ` : ''
    if (engine.activeView.type === 'dm' && engine.activeDmThread) {
      document.title = `${unreadPrefix}${engine.activeDmThread.peerDisplayHandle} · Agnostr`
    } else if (
      engine.activeView.type === 'server' &&
      engine.servers.activeServer &&
      engine.servers.activeChannel
    ) {
      document.title = `${unreadPrefix}#${engine.servers.activeChannel.name} · ${engine.servers.activeServer.name} · Agnostr`
    } else {
      document.title = `${unreadPrefix}#${engine.activeGeohash} · Agnostr`
    }
  }, [
    engine.activeView,
    engine.activeGeohash,
    engine.activeDmThread,
    engine.servers.activeServer,
    engine.servers.activeChannel,
    engine.totalDmUnread,
    engine.servers.totalServerUnread,
  ])

  // Subtle audio cue when fresh live geohash messages arrive
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

  // Subtle audio cue when fresh live Server messages arrive
  const activeServerStreamKey =
    isServer && activeServer && activeChannel ? `${activeServer.id}:${activeChannel.id}` : ''
  const lastSrvMsgIdRef = useRef<string | null>(null)
  const lastSrvKeyRef = useRef<string>(activeServerStreamKey)
  useEffect(() => {
    const list = engine.servers.messages
    if (lastSrvKeyRef.current !== activeServerStreamKey) {
      lastSrvKeyRef.current = activeServerStreamKey
      lastSrvMsgIdRef.current = list.length ? list[list.length - 1].id : null
      return
    }
    if (!activeServerStreamKey || !list.length) return
    const newest = list[list.length - 1]
    if (newest.id === lastSrvMsgIdRef.current) return
    lastSrvMsgIdRef.current = newest.id

    const nowSec = Math.floor(Date.now() / 1000)
    if (!newest.isOwn && !newest.isSystem && nowSec - newest.createdAt <= 30) {
      const nickLower = engine.identity.nickname.toLowerCase()
      const mentionsUs =
        newest.mentions.includes(engine.identity.masterPubkey) ||
        (nickLower.length > 0 && newest.content.toLowerCase().includes(`@${nickLower}`))
      radioAudio.play(mentionsUs ? 'mention' : 'receive')
    }
  }, [
    engine.servers.messages,
    activeServerStreamKey,
    engine.identity.nickname,
    engine.identity.masterPubkey,
  ])

  // Audio cue on incoming unread DM
  const prevDmUnreadRef = useRef(engine.totalDmUnread)
  useEffect(() => {
    if (engine.totalDmUnread > prevDmUnreadRef.current) {
      radioAudio.play('dm')
    }
    prevDmUnreadRef.current = engine.totalDmUnread
  }, [engine.totalDmUnread])

  // Detect identity panic wipe (masterPubkey changes) for subtle flash & modal teardown
  const prevMasterPkRef = useRef(engine.identity.masterPubkey)
  useEffect(() => {
    if (
      prevMasterPkRef.current &&
      engine.identity.masterPubkey &&
      prevMasterPkRef.current !== engine.identity.masterPubkey
    ) {
      setServerSettingsState({ serverId: null, tab: 'overview' })
      setRadarExpanded(false)
      setInstallModalOpen(false)
      setPanicFlash(true)
      const t = window.setTimeout(() => setPanicFlash(false), 700)
      prevMasterPkRef.current = engine.identity.masterPubkey
      return () => window.clearTimeout(t)
    }
    prevMasterPkRef.current = engine.identity.masterPubkey
  }, [engine.identity.masterPubkey])

  // Compute in-stream search matches across Geohash, DM, and Server streams
  const searchMatchIds = useMemo(() => {
    const q = searchQuery.trim().toLowerCase()
    if (!q) return []
    if (engine.activeView.type === 'dm' && engine.activeDmThread) {
      return engine.activeDmThread.messages
        .filter((m) => m.content.toLowerCase().includes(q))
        .map((m) => m.id)
    }
    if (engine.activeView.type === 'server') {
      return engine.servers.messages
        .filter(
          (m) =>
            m.content.toLowerCase().includes(q) ||
            m.nickname.toLowerCase().includes(q) ||
            m.displayHandle.toLowerCase().includes(q)
        )
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
  }, [searchQuery, engine.activeView, engine.activeDmThread, engine.servers.messages, engine.messages])

  useEffect(() => {
    setSearchMatchIdx(searchMatchIds.length > 0 ? searchMatchIds.length - 1 : 0)
  }, [
    searchQuery,
    engine.activeGeohash,
    engine.activeView.type,
    activeServerStreamKey,
    searchMatchIds.length,
  ])

  const activeSearchMessageId =
    searchOpen && searchMatchIds.length > 0
      ? searchMatchIds[Math.min(searchMatchIdx, searchMatchIds.length - 1)]
      : null

  const closeServerHub = useCallback(() => {
    setServerHubState((prev) => ({ ...prev, open: false }))
    if (engine.servers.pendingInvite) {
      engine.servers.clearPendingInvite()
    }
  }, [engine.servers])

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
        } else if (serverSettingsState.serverId) {
          setServerSettingsState({ serverId: null, tab: 'overview' })
        } else if (serverHubState.open) {
          closeServerHub()
        } else if (radarExpanded) {
          setRadarExpanded(false)
        } else if (installModalOpen) {
          setInstallModalOpen(false)
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
  }, [
    cmdkOpen,
    serverSettingsState.serverId,
    serverHubState.open,
    closeServerHub,
    radarExpanded,
    installModalOpen,
    inspectedPeer,
    searchOpen,
    inspectorOpen,
    sidebarOpen,
  ])

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

  const handleSelectGeoRadio = useCallback(() => {
    engine.tuneGeohash(engine.activeGeohash)
    if (typeof window !== 'undefined' && window.innerWidth >= 768) {
      setSidebarOpen(true)
    }
  }, [engine])

  const handleSelectDms = useCallback(() => {
    if (engine.dmThreads.length > 0) {
      const latest = engine.dmThreads[0]
      engine.openDmThread(latest.peerPubkey, latest.peerNickname)
      if (typeof window !== 'undefined' && window.innerWidth >= 768) {
        setSidebarOpen(true)
      }
    } else {
      engine.tuneGeohash(engine.activeGeohash)
      setSidebarOpen(true)
      engine.pushToast(
        'info',
        'No encrypted DMs yet',
        'Click any peer handle or open the Peers tab to start an E2EE DM.'
      )
    }
  }, [engine])

  const handleSelectServer = useCallback(
    (serverId: string) => {
      engine.servers.selectServer(serverId)
      if (typeof window !== 'undefined' && window.innerWidth >= 768) {
        setSidebarOpen(true)
      }
    },
    [engine.servers]
  )

  const handleSelectServerChannel = useCallback(
    (serverId: string, channelId: string) => {
      engine.servers.selectChannel(serverId, channelId)
      radioAudio.play('tune')
      if (typeof window !== 'undefined' && window.innerWidth < 768) {
        setSidebarOpen(false)
      }
      if (typeof window !== 'undefined' && window.innerWidth < 1100) {
        setInspectorOpen(false)
      }
    },
    [engine.servers]
  )

  const handleOpenServerHub = useCallback((initialTab: ServerHubTab = 'create') => {
    setServerHubState({ open: true, tab: initialTab })
    if (typeof window !== 'undefined' && window.innerWidth < 768) {
      setSidebarOpen(false)
    }
  }, [])

  const handleOpenServerSettings = useCallback(
    (serverId: string, initialTab: ServerSettingsTab = 'overview') => {
      setServerSettingsState({ serverId, tab: initialTab })
      if (typeof window !== 'undefined' && window.innerWidth < 768) {
        setSidebarOpen(false)
      }
      if (typeof window !== 'undefined' && window.innerWidth < 1100) {
        setInspectorOpen(false)
      }
    },
    []
  )

  const handleJoinedServer = useCallback(
    (server: ServerSummary) => {
      engine.servers.selectServer(server.id)
      closeServerHub()
      if (typeof window !== 'undefined' && window.innerWidth < 768) {
        setSidebarOpen(false)
      }
    },
    [engine.servers, closeServerHub]
  )

  const handleLeftServer = useCallback(() => {
    setServerSettingsState({ serverId: null, tab: 'overview' })
    engine.tuneGeohash(engine.activeGeohash)
  }, [engine])

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
        return
      }
      const matchedMember = engine.servers.members.find(
        (m) =>
          m.displayHandle.toLowerCase() === `@${lower}` ||
          m.nickname.toLowerCase() === lower ||
          m.displayHandle.toLowerCase().includes(lower)
      )
      if (matchedMember) {
        setInspectedPeer({
          pubkey: matchedMember.pubkey,
          npub: matchedMember.npub,
          nickname: matchedMember.nickname,
          displayHandle: matchedMember.displayHandle,
          lastSeenAt: Math.floor(Date.now() / 1000),
          isOnline: true,
          isSelf: matchedMember.isSelf,
          isTeleported: false,
          isMeshBridge: false,
          isBlocked: engine.isPeerBlocked(matchedMember.pubkey),
          isTrusted: engine.isTrusted(matchedMember.pubkey),
          messageCount: 1,
          channels: activeChannel ? [activeChannel.name] : [],
        })
        return
      }
      handleMentionPeer(mention)
    },
    [engine, activeChannel, handleMentionPeer]
  )

  const handleOpenInspectorTab = useCallback((tab: InspectorTab) => {
    setInspectorTab(tab)
    setInspectorOpen(true)
    if (typeof window !== 'undefined' && window.innerWidth < 768) {
      setSidebarOpen(false)
    }
  }, [])

  const handleExpandRadar = useCallback(() => {
    setRadarExpanded(true)
    radioAudio.play('click')
    if (typeof window !== 'undefined' && window.innerWidth < 768) {
      setSidebarOpen(false)
    }
    if (typeof window !== 'undefined' && window.innerWidth < 1100) {
      setInspectorOpen(false)
    }
  }, [])

  const { pushToast } = engine
  const handleOpenInstall = useCallback(() => {
    radioAudio.play('click')
    if (typeof window !== 'undefined' && window.innerWidth < 768) {
      setSidebarOpen(false)
    }
    if (typeof window !== 'undefined' && window.innerWidth < 1100) {
      setInspectorOpen(false)
    }
    if (pwa.canPromptInstall) {
      void pwa.promptInstall().then((outcome) => {
        if (outcome === 'accepted') {
          radioAudio.play('tune')
          pushToast('success', 'Agnostr installed', 'Launch anytime from your home screen or dock.')
        } else if (outcome === 'unavailable') {
          setInstallModalOpen(true)
        }
      })
      return
    }
    setInstallModalOpen(true)
  }, [pwa, pushToast])

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

  const handleReplyServer = useCallback(
    (msg: ServerMessage) => {
      engine.servers.setReplyingTo(msg)
      setExternalDraftToken((prev) => ({ id: (prev?.id ?? 0) + 1, text: '' }))
    },
    [engine.servers]
  )

  const handleReactServer = useCallback(
    (msg: ServerMessage, emoji: string) => {
      radioAudio.play('click')
      void engine.servers.sendReaction(msg, emoji)
    },
    [engine.servers]
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
      let file: { filename: string; content: string; mimeType: string }
      if (isServer && activeServer && activeChannel) {
        const slug = `${activeServer.name}-${activeChannel.name}`
          .toLowerCase()
          .replace(/[^a-z0-9-]+/g, '-')
          .replace(/^-+|-+$/g, '')
        const stamp = new Date().toISOString().slice(0, 10)
        if (format === 'json') {
          file = {
            filename: `agnostr-server-${slug}-${stamp}.json`,
            mimeType: 'application/json;charset=utf-8',
            content: JSON.stringify(
              {
                server: {
                  id: activeServer.id,
                  kind: activeServer.kind,
                  name: activeServer.name,
                  encrypted: activeServer.encrypted,
                },
                channel: activeChannel,
                exportedAt: new Date().toISOString(),
                messages: engine.servers.messages,
              },
              null,
              2
            ),
          }
        } else {
          const lines = [
            `# ${activeServer.name} — #${activeChannel.name}`,
            `Exported ${new Date().toISOString()} (${activeServer.kind === 'nip29' ? 'NIP-29' : activeServer.encrypted ? 'E2EE Virtual Server' : 'Public Virtual Server'})`,
            '',
            ...engine.servers.messages.map((m) => {
              const ts = new Date(m.createdAt * 1000).toISOString()
              const voice = m.voiceMemo ? ` [Voice memo: ${m.voiceMemo.url}]` : ''
              return `- **${m.displayHandle}** (${ts}): ${m.content}${voice}`
            }),
          ]
          file = {
            filename: `agnostr-server-${slug}-${stamp}.md`,
            mimeType: 'text/markdown;charset=utf-8',
            content: lines.join('\n'),
          }
        }
      } else {
        file = engine.exportTranscript(format)
      }

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
    [engine, isServer, activeServer, activeChannel]
  )

  return (
    <div className={`ag-app ${panicFlash ? 'ag-panic-active' : ''}`}>
      {/* Mobile Left Navigation Scrim */}
      {sidebarOpen && (
        <div
          className="ag-backdrop ag-mobile-only"
          onClick={() => setSidebarOpen(false)}
          aria-hidden="true"
        />
      )}

      {/* Left Workspace Rail + Channel / Server Sidebar Shell */}
      <div className={`ag-nav-shell ${sidebarOpen ? '' : 'drawer-closed'}`}>
        <ServerRail
          mode={engine.activeView.type}
          activeServerId={activeServer?.id ?? null}
          joinedServers={engine.servers.joinedServers}
          totalDmUnread={engine.totalDmUnread}
          onSelectGeoRadio={handleSelectGeoRadio}
          onSelectDms={handleSelectDms}
          onSelectServer={handleSelectServer}
          onOpenHub={handleOpenServerHub}
          onPlaySound={playSound}
        />

        {isServer && activeServer && activeChannel ? (
          <ServerSidebar
            engine={engine}
            servers={engine.servers}
            server={activeServer}
            activeChannelId={activeChannel.id}
            open={sidebarOpen}
            onClose={() => setSidebarOpen(false)}
            onSelectChannel={handleSelectServerChannel}
            onBackToGeoRadio={handleSelectGeoRadio}
            onOpenCommandPalette={() => setCmdkOpen(true)}
            onOpenInspectorTab={handleOpenInspectorTab}
            onOpenHub={handleOpenServerHub}
            onOpenSettings={handleOpenServerSettings}
            onPlaySound={playSound}
          />
        ) : (
          <Sidebar
            engine={engine}
            open={sidebarOpen}
            onClose={() => setSidebarOpen(false)}
            onTuneChannel={handleTuneChannel}
            onOpenDm={handleOpenDm}
            onOpenCommandPalette={() => setCmdkOpen(true)}
            onOpenInspectorTab={handleOpenInspectorTab}
            onExpandRadar={handleExpandRadar}
            onLocateMe={() => void handleLocateMe()}
            pwa={pwa}
            onOpenInstall={handleOpenInstall}
          />
        )}
      </div>

      {/* Center Stage */}
      <main
        className={`ag-main ${isDm ? 'dm-mode' : isServerE2ee ? 'server-e2ee-mode' : ''}`}
      >
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
          onOpenServerSettings={handleOpenServerSettings}
          onExpandRadar={handleExpandRadar}
          onExport={handleExport}
        />

        {/* Compact PWA Offline & Update-Ready Status Strips */}
        {pwa.isOffline && (
          <div className="ag-pwa-banner offline" role="status" aria-live="polite">
            <div className="ag-pwa-banner-left">
              <WifiOff size={13} />
              <span>Offline · Cached mode</span>
            </div>
          </div>
        )}

        {pwa.updateAvailable && (
          <div className="ag-pwa-banner update" role="status" aria-live="polite">
            <div className="ag-pwa-banner-left">
              <RefreshCw size={13} />
              <span>New version ready</span>
            </div>
            <div className="ag-pwa-banner-actions">
              <button
                type="button"
                className="ag-pwa-reload-btn"
                onClick={() => void pwa.applyUpdate()}
              >
                Reload
              </button>
              <button
                type="button"
                className="ag-pwa-dismiss-btn"
                onClick={pwa.dismissUpdate}
                title="Dismiss update notice"
                aria-label="Dismiss update notice"
              >
                <X size={13} />
              </button>
            </div>
          </div>
        )}

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
          onReplyServer={handleReplyServer}
          onReactServer={handleReactServer}
          onInspectPeer={setInspectedPeer}
          onStartDm={handleOpenDm}
          onTuneChannel={handleTuneChannel}
          onClickMention={handleClickInlineMention}
          onLocateMe={() => void handleLocateMe()}
          onOpenRadar={() => handleOpenInspectorTab('radar')}
          onRunHelpCommand={() => void engine.sendInput('/help')}
          onOpenServerSettings={handleOpenServerSettings}
        />

        <Composer
          engine={engine}
          externalDraftToken={externalDraftToken}
          onSent={(isEncrypted) => radioAudio.play(isEncrypted ? 'dm' : 'send')}
        />
      </main>

      {/* Right Tabbed Inspector Drawer (Geo Radar/Server | Peers | Notes | Relays | Identity) */}
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
        onOpenServerSettings={handleOpenServerSettings}
        onExpandRadar={handleExpandRadar}
        onLeftServer={handleLeftServer}
        pwa={pwa}
        onOpenInstall={handleOpenInstall}
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

      {/* Full-Screen Expandable Geohash Radar Map Modal */}
      <ExpandedRadarModal
        open={radarExpanded}
        engine={engine}
        onClose={() => setRadarExpanded(false)}
        onTuneChannel={handleTuneChannel}
        onPlaySound={playSound}
      />

      {/* PWA Install Guide / Native Install Modal */}
      <PwaInstallModal
        open={installModalOpen}
        pwa={pwa}
        onClose={() => setInstallModalOpen(false)}
        onPlaySound={playSound}
      />

      {/* Create / Join / Explore Servers Hub Modal */}
      <ServerHubModal
        open={serverHubState.open}
        initialTab={serverHubState.tab}
        servers={engine.servers}
        onClose={closeServerHub}
        onJoinedServer={handleJoinedServer}
        onPlaySound={playSound}
      />

      {/* Server Settings, Invite & Moderation Modal */}
      <ServerSettingsModal
        server={settingsServer}
        initialTab={serverSettingsState.tab}
        engine={engine}
        servers={engine.servers}
        onClose={() => setServerSettingsState({ serverId: null, tab: 'overview' })}
        onLeftServer={handleLeftServer}
        onPlaySound={playSound}
      />

      {/* Spotlight Command Palette (Cmd+K) */}
      <CommandPalette
        open={cmdkOpen}
        engine={engine}
        onClose={() => setCmdkOpen(false)}
        onTuneChannel={handleTuneChannel}
        onSelectServerChannel={handleSelectServerChannel}
        onOpenServerHub={handleOpenServerHub}
        onExpandRadar={handleExpandRadar}
        onLocateMe={() => void handleLocateMe()}
        onOpenInspectorTab={handleOpenInspectorTab}
        onToggleSound={handleToggleSound}
        onRunCommand={handleRunCommand}
        onExport={handleExport}
        pwa={pwa}
        onOpenInstall={handleOpenInstall}
      />

      {/* Tactical Non-Blocking Notifications */}
      <ToastStack toasts={engine.toasts} onDismiss={engine.dismissToast} />
    </div>
  )
}

export default App
