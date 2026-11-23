import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { Phone, RefreshCw, Video, WifiOff, X } from 'lucide-react'
import { useAgnostrEngine } from './hooks/useAgnostrEngine'
import { useBackNavigation } from './hooks/useBackNavigation'
import { useMobileSwipeDrawers } from './hooks/useMobileSwipeDrawers'
import { useMobileViewport } from './hooks/useMobileViewport'
import { usePwa } from './hooks/usePwa'
import { doesContentMentionUser } from './lib/bitchatProtocol'
import {
  formatRadioChannelLabel,
  parseQuickTuneInput,
  parseRadioChannelHash,
} from './lib/radioChannel'
import {
  clearLocationDmHash,
  extractPendingDmFromLocation,
  type ParsedShareTarget,
} from './lib/shareLinks'
import type { GeoMessage, PeerInfo, ThemeId } from './types/protocol'
import type { ServerMessage, ServerSummary } from './types/servers'
import type { WalletInitialIntent, ZapTarget } from './types/wallet'
import { radioAudio, type SoundCue } from './utils/sound'
import ConversationList, { type ListTab } from './components/ConversationList'
import MobileTabBar from './components/MobileTabBar'
import ChannelHeader from './components/ChannelHeader'
import SearchBar from './components/SearchBar'
import MessageStream from './components/MessageStream'
import Composer from './components/Composer'
import CommandPalette from './components/CommandPalette'
import ToastStack from './components/ToastStack'
import RoomInfoSheet from './components/RoomInfoSheet'
import SettingsModal, { type SettingsTab } from './components/SettingsModal'
import ServerHubModal, { type ServerHubTab } from './components/ServerHubModal'
import ServerSettingsModal, { type ServerSettingsTab } from './components/ServerSettingsModal'
import PeerInspectorModal from './components/PeerInspectorModal'
import ExpandedRadarModal from './components/ExpandedRadarModal'
import PwaInstallModal from './components/PwaInstallModal'
import CallStage from './components/CallStage'
import IncomingCallBanner from './components/IncomingCallBanner'
import ImageLightboxModal, { type LightboxImagePayload } from './components/ImageLightboxModal'
import QrShareModal, { type QrShareTarget } from './components/QrShareModal'
import QrScannerModal from './components/QrScannerModal'
import TrustConfirmModal from './components/TrustConfirmModal'
import WalletModal from './components/WalletModal'
import ZapModal from './components/ZapModal'
import { ContextMenuProvider } from './components/ContextMenu'

const THEME_META_COLORS: Record<ThemeId, string> = {
  phosphor: '#0B0C0F',
  obsidian: '#090A10',
  amber: '#100F0E',
  daylight: '#FFFFFF',
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

export function App() {
  useMobileViewport()
  const engine = useAgnostrEngine()

  const [listTab, setListTab] = useState<ListTab>('radio')
  const [mobileScreen, setMobileScreen] = useState<'list' | 'chat'>('chat')
  const [isMobileViewport, setIsMobileViewport] = useState<boolean>(() =>
    typeof window !== 'undefined' ? window.innerWidth <= 867 : false
  )
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [roomInfoOpen, setRoomInfoOpen] = useState(false)

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return
    const mql = window.matchMedia('(max-width: 867px)')
    const sync = () => setIsMobileViewport(mql.matches)
    sync()
    mql.addEventListener('change', sync)
    return () => mql.removeEventListener('change', sync)
  }, [])
  const [settingsState, setSettingsState] = useState<{ open: boolean; tab?: SettingsTab }>({
    open: false,
    tab: undefined,
  })
  const [cmdkOpen, setCmdkOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchMatchIdx, setSearchMatchIdx] = useState(0)
  const [inspectedPeer, setInspectedPeer] = useState<PeerInfo | null>(null)
  const [radarExpanded, setRadarExpanded] = useState(false)
  const [installModalOpen, setInstallModalOpen] = useState(false)
  const [callExpanded, setCallExpanded] = useState(false)
  const [lightboxImage, setLightboxImage] = useState<LightboxImagePayload | null>(null)
  const [qrShareTarget, setQrShareTarget] = useState<QrShareTarget | null>(null)
  const [qrScannerOpen, setQrScannerOpen] = useState(false)
  const [walletState, setWalletState] = useState<{
    open: boolean
    intent?: WalletInitialIntent
  }>({ open: false, intent: undefined })
  const [zapTarget, setZapTarget] = useState<ZapTarget | null>(null)
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

  // Total unread count across DMs, Servers, and Geo Radio rooms for PWA App Badge
  const totalUnreadBadge = useMemo(() => {
    return engine.totalDmUnread + engine.servers.totalServerUnread + engine.totalGeoUnread
  }, [engine.totalDmUnread, engine.servers.totalServerUnread, engine.totalGeoUnread])

  const pwa = usePwa(totalUnreadBadge)

  const activeCall = engine.calls.activeCall
  const viewingActiveCallContext = Boolean(
    activeCall &&
      ((activeCall.mode === 'dm' &&
        engine.activeView.type === 'dm' &&
        engine.activeView.peerPubkey.toLowerCase() ===
          (activeCall.peerPubkey ?? '').toLowerCase()) ||
        (activeCall.mode === 'server' &&
          engine.activeView.type === 'server' &&
          engine.activeView.serverId === activeCall.serverId) ||
        (activeCall.mode === 'geo' &&
          engine.activeView.type === 'channel' &&
          (activeCall.geohash ?? '').toLowerCase() === engine.activeGeohash.toLowerCase()))
  )
  const callCompactFloating = Boolean(activeCall && !callExpanded && !viewingActiveCallContext)

  const activeGeoKey = engine.activeGeohash.toLowerCase()
  const inActiveGeoCallHere = Boolean(
    !isDm &&
      !isServer &&
      activeCall?.mode === 'geo' &&
      (activeCall.geohash ?? '').toLowerCase() === activeGeoKey
  )
  const activeGeoCallPresence = useMemo(
    () => (!isDm && !isServer ? engine.calls.getGeoCallPresence(activeGeoKey) : []),
    [isDm, isServer, engine.calls, activeGeoKey]
  )
  const activeGeoCallCount = activeGeoCallPresence.length
  const showGeoCallJoinBanner = !isDm && !isServer && !inActiveGeoCallHere && activeGeoCallCount > 0
  const isActiveGeoCallFull = activeGeoCallCount >= engine.calls.maxParticipants

  const handleReturnToActiveCall = useCallback(() => {
    if (!activeCall) return
    setRadarExpanded(false)
    setSettingsState((prev) => (prev.open ? { ...prev, open: false } : prev))
    setRoomInfoOpen(false)
    if (activeCall.mode === 'geo' && activeCall.geohash) {
      engine.tuneGeohash(activeCall.geohash)
      setListTab('radio')
      setMobileScreen('chat')
    } else if (activeCall.mode === 'server' && activeCall.serverId) {
      engine.servers.selectServer(activeCall.serverId)
      setListTab('servers')
      setMobileScreen('chat')
    } else if (activeCall.mode === 'dm' && activeCall.peerPubkey) {
      engine.openDmThread(activeCall.peerPubkey)
      setListTab('dms')
      setMobileScreen('chat')
    }
  }, [activeCall, engine])

  // Handle Service Worker notification clicks & cold-launch `#notify=...` deep links
  const pendingNotifAction = engine.notifications.pendingAction
  const incomingCall = engine.calls.incomingCall
  const navigatedNotifTsRef = useRef<number>(0)
  useEffect(() => {
    if (!pendingNotifAction) return
    const { action, payload, receivedAt } = pendingNotifAction

    // Navigate to target room/DM/server once per pending notification action
    if (navigatedNotifTsRef.current !== receivedAt) {
      navigatedNotifTsRef.current = receivedAt
      setRoomInfoOpen(false)
      setCmdkOpen(false)
      setRadarExpanded(false)

      if ((payload.category === 'dm' || payload.category === 'dm-call') && payload.peerPubkey) {
        engine.openDmThread(payload.peerPubkey, payload.callerNickname)
        setListTab('dms')
        setMobileScreen('chat')
      } else if (
        (payload.category === 'server-message' || payload.category === 'server-call') &&
        payload.serverId
      ) {
        if (payload.channelId) {
          engine.servers.selectChannel(payload.serverId, payload.channelId)
        } else {
          engine.servers.selectServer(payload.serverId)
        }
        setListTab('servers')
        setMobileScreen('chat')
      } else if (
        (payload.category === 'geo-message' ||
          payload.category === 'location-note' ||
          payload.category === 'geo-call') &&
        payload.geohash
      ) {
        engine.tuneGeohash(payload.geohash)
        setListTab('radio')
        setMobileScreen('chat')
      } else if (payload.category === 'test') {
        setSettingsState({ open: true, tab: 'notifications' })
      }
    }

    if (action === 'open') {
      engine.notifications.consumePendingAction()
      return
    }

    // Handle Geo Radio call notification Accept / Decline actions immediately
    if (payload.category === 'geo-call' && payload.geohash) {
      if (action === 'answer' || action === 'answer-audio') {
        const media = action === 'answer-audio' ? 'audio' : (payload.mediaType ?? 'audio')
        void engine.calls.joinGeoCall(payload.geohash, media)
      }
      engine.notifications.consumePendingAction()
      return
    }

    // Execute Answer / Decline call actions (waiting briefly for relay invite on cold launch)
    const callMatches = Boolean(
      incomingCall &&
        ((payload.callId && incomingCall.callId === payload.callId) ||
          (payload.peerPubkey &&
            incomingCall.callerPubkey.toLowerCase() === payload.peerPubkey.toLowerCase()) ||
          (!payload.callId && !payload.peerPubkey))
    )

    if (callMatches && incomingCall) {
      if (action === 'decline') {
        radioAudio.play('call-leave')
        engine.calls.declineIncomingCall()
      } else if (action === 'answer-audio') {
        void engine.calls.acceptIncomingCall('audio')
      } else if (action === 'answer') {
        void engine.calls.acceptIncomingCall(payload.mediaType ?? incomingCall.mediaType)
      }
      engine.notifications.consumePendingAction()
      return
    }

    const remainingMs = 18_000 - (Date.now() - receivedAt)
    if (remainingMs <= 0) {
      engine.notifications.consumePendingAction()
      return
    }
    const expiryTimer = window.setTimeout(() => {
      engine.notifications.consumePendingAction()
    }, remainingMs)
    return () => window.clearTimeout(expiryTimer)
  }, [pendingNotifAction, incomingCall, engine])

  // Play crisp join/leave cues when active call starts or ends
  const activeCallId = activeCall?.callId ?? null
  const prevActiveCallIdRef = useRef<string | null>(activeCallId)
  useEffect(() => {
    const prev = prevActiveCallIdRef.current
    prevActiveCallIdRef.current = activeCallId
    if (!prev && activeCallId) {
      radioAudio.play('call-join')
    } else if (prev && !activeCallId) {
      radioAudio.play('call-leave')
      setCallExpanded(false)
    }
  }, [activeCallId])

  // Play subtle rec-start / rec-stop cues when any participant starts or stops recording
  const recordingCount = activeCall
    ? activeCall.participants.filter((p) => p.isRecording).length
    : 0
  const prevRecRef = useRef<{ callId: string | null; count: number }>({
    callId: activeCallId,
    count: recordingCount,
  })
  useEffect(() => {
    const prev = prevRecRef.current
    prevRecRef.current = { callId: activeCallId, count: recordingCount }
    if (!activeCallId || prev.callId !== activeCallId) return
    if (recordingCount > prev.count) {
      radioAudio.play('rec-start')
    } else if (recordingCount < prev.count) {
      radioAudio.play('rec-stop')
    }
  }, [activeCallId, recordingCount])

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
      document.title = `${unreadPrefix}${formatRadioChannelLabel(engine.activeGeohash)} · Agnostr`
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
      const mentionsUs = doesContentMentionUser(
        newest.content,
        newest.mentions,
        engine.identity.nickname,
        engine.identity.activePubkey
      )
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
      const mentionsUs = doesContentMentionUser(
        newest.content,
        newest.mentions,
        engine.identity.nickname,
        engine.identity.masterPubkey
      )
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
      setSettingsState({ open: false, tab: undefined })
      setRoomInfoOpen(false)
      setRadarExpanded(false)
      setInstallModalOpen(false)
      setCallExpanded(false)
      setLightboxImage(null)
      setQrShareTarget(null)
      setQrScannerOpen(false)
      setWalletState({ open: false, intent: undefined })
      setZapTarget(null)
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
        setSidebarCollapsed((v) => !v)
        return
      }
      if (mod && e.key.toLowerCase() === 'i') {
        e.preventDefault()
        setRoomInfoOpen((v) => {
          if (!v) setMobileScreen('chat')
          return !v
        })
        return
      }
      if (mod && e.key === ',') {
        e.preventDefault()
        setSettingsState((prev) => ({ open: !prev.open, tab: undefined }))
        return
      }
      if (e.key === 'Escape') {
        if (engine.pendingTrustRequest) {
          engine.cancelPendingTrust()
        } else if (qrScannerOpen) {
          setQrScannerOpen(false)
        } else if (zapTarget) {
          setZapTarget(null)
        } else if (walletState.open) {
          setWalletState({ open: false, intent: undefined })
        } else if (qrShareTarget) {
          setQrShareTarget(null)
        } else if (cmdkOpen) {
          setCmdkOpen(false)
        } else if (lightboxImage) {
          setLightboxImage(null)
        } else if (settingsState.open) {
          setSettingsState((prev) => ({ ...prev, open: false }))
        } else if (serverSettingsState.serverId) {
          setServerSettingsState({ serverId: null, tab: 'overview' })
        } else if (serverHubState.open) {
          closeServerHub()
        } else if (radarExpanded) {
          setRadarExpanded(false)
        } else if (installModalOpen) {
          setInstallModalOpen(false)
        } else if (callExpanded) {
          setCallExpanded(false)
        } else if (inspectedPeer) {
          setInspectedPeer(null)
        } else if (roomInfoOpen) {
          setRoomInfoOpen(false)
        } else if (searchOpen) {
          setSearchOpen(false)
          setSearchQuery('')
        }
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [
    engine,
    qrScannerOpen,
    zapTarget,
    walletState.open,
    qrShareTarget,
    cmdkOpen,
    lightboxImage,
    settingsState.open,
    serverSettingsState.serverId,
    serverHubState.open,
    closeServerHub,
    radarExpanded,
    installModalOpen,
    callExpanded,
    inspectedPeer,
    roomInfoOpen,
    searchOpen,
  ])

  const playSound = useCallback((cue: SoundCue) => {
    radioAudio.play(cue)
  }, [])

  const handleOpenSettings = useCallback((tab?: SettingsTab) => {
    setRadarExpanded(false)
    setRoomInfoOpen(false)
    setSettingsState({ open: true, tab })
  }, [])

  const handleLeftDrawerOpenChange = useCallback((open: boolean) => {
    if (open) {
      setRoomInfoOpen(false)
      setMobileScreen('list')
    } else {
      setMobileScreen('chat')
    }
  }, [])

  const handleRightDrawerOpenChange = useCallback((open: boolean) => {
    if (open) {
      setMobileScreen('chat')
      setRoomInfoOpen(true)
    } else {
      setRoomInfoOpen(false)
    }
  }, [])

  const swipeDisabled =
    !isMobileViewport ||
    Boolean(engine.pendingTrustRequest) ||
    walletState.open ||
    Boolean(zapTarget) ||
    settingsState.open ||
    radarExpanded ||
    serverHubState.open ||
    Boolean(serverSettingsState.serverId) ||
    Boolean(inspectedPeer) ||
    Boolean(lightboxImage) ||
    Boolean(qrShareTarget) ||
    qrScannerOpen ||
    cmdkOpen ||
    installModalOpen ||
    Boolean(engine.calls.incomingCall) ||
    Boolean(activeCall && callExpanded)

  const {
    bindRef: shellBodyRef,
    leftProgress,
    rightProgress,
    isSwipingLeft,
    isSwipingRight,
  } = useMobileSwipeDrawers({
    leftOpen: mobileScreen === 'list',
    rightOpen: roomInfoOpen,
    disabled: swipeDisabled,
    onLeftOpenChange: handleLeftDrawerOpenChange,
    onRightOpenChange: handleRightDrawerOpenChange,
  })

  const handleMobileBack = useCallback(() => {
    if (engine.activeView.type === 'dm') setListTab('dms')
    else if (engine.activeView.type === 'server') setListTab('servers')
    else setListTab('radio')
    setRoomInfoOpen(false)
    setMobileScreen('list')
  }, [engine.activeView.type])

  const handleMobileSelectTab = useCallback((tab: ListTab) => {
    setRadarExpanded(false)
    setSettingsState((prev) => (prev.open ? { ...prev, open: false } : prev))
    setRoomInfoOpen(false)
    setListTab(tab)
    setMobileScreen('list')
  }, [])

  const handleMobileTabMap = useCallback(() => {
    setSettingsState((prev) => (prev.open ? { ...prev, open: false } : prev))
    setRoomInfoOpen(false)
    setRadarExpanded((open) => !open)
    radioAudio.play('click')
  }, [])

  const handleMobileTabSettings = useCallback(() => {
    setRadarExpanded(false)
    setRoomInfoOpen(false)
    setSettingsState((prev) =>
      prev.open ? { ...prev, open: false } : { open: true, tab: undefined }
    )
    radioAudio.play('click')
  }, [])

  const { pushToast } = engine

  const handleBackNavigation = useCallback((): boolean => {
    if (engine.pendingTrustRequest) {
      engine.cancelPendingTrust()
      return true
    }
    if (qrScannerOpen) {
      setQrScannerOpen(false)
      return true
    }
    if (zapTarget) {
      setZapTarget(null)
      return true
    }
    if (walletState.open) {
      setWalletState({ open: false, intent: undefined })
      return true
    }
    if (qrShareTarget) {
      setQrShareTarget(null)
      return true
    }
    if (lightboxImage) {
      setLightboxImage(null)
      return true
    }
    if (cmdkOpen) {
      setCmdkOpen(false)
      return true
    }
    if (inspectedPeer) {
      setInspectedPeer(null)
      return true
    }
    if (serverSettingsState.serverId) {
      setServerSettingsState({ serverId: null, tab: 'overview' })
      return true
    }
    if (serverHubState.open) {
      closeServerHub()
      return true
    }
    if (installModalOpen) {
      setInstallModalOpen(false)
      return true
    }
    if (radarExpanded) {
      setRadarExpanded(false)
      return true
    }
    if (settingsState.open) {
      setSettingsState((prev) => ({ ...prev, open: false }))
      return true
    }
    if (activeCall && callExpanded) {
      setCallExpanded(false)
      return true
    }
    if (roomInfoOpen) {
      setRoomInfoOpen(false)
      return true
    }
    if (searchOpen) {
      setSearchOpen(false)
      setSearchQuery('')
      return true
    }
    if (isMobileViewport && mobileScreen === 'chat') {
      handleMobileBack()
      return true
    }
    return false
  }, [
    engine,
    qrScannerOpen,
    zapTarget,
    walletState.open,
    qrShareTarget,
    lightboxImage,
    cmdkOpen,
    inspectedPeer,
    serverSettingsState.serverId,
    serverHubState.open,
    closeServerHub,
    installModalOpen,
    radarExpanded,
    settingsState.open,
    activeCall,
    callExpanded,
    roomInfoOpen,
    searchOpen,
    isMobileViewport,
    mobileScreen,
    handleMobileBack,
  ])

  const handleBackExitHint = useCallback(() => {
    pushToast('info', 'Press back again to exit')
  }, [pushToast])

  const { rearmGuard } = useBackNavigation({
    onBack: handleBackNavigation,
    onExitHint: handleBackExitHint,
  })

  const hasActiveBackTarget =
    Boolean(engine.pendingTrustRequest) ||
    qrScannerOpen ||
    Boolean(zapTarget) ||
    walletState.open ||
    Boolean(qrShareTarget) ||
    Boolean(lightboxImage) ||
    cmdkOpen ||
    Boolean(inspectedPeer) ||
    Boolean(serverSettingsState.serverId) ||
    serverHubState.open ||
    installModalOpen ||
    radarExpanded ||
    settingsState.open ||
    Boolean(activeCall && callExpanded) ||
    roomInfoOpen ||
    searchOpen ||
    (isMobileViewport && mobileScreen === 'chat')

  useEffect(() => {
    if (hasActiveBackTarget) {
      rearmGuard()
    }
  }, [hasActiveBackTarget, rearmGuard])

  const mobileNavActiveTab: ListTab =
    mobileScreen === 'chat'
      ? isDm
        ? 'dms'
        : isServer
          ? 'servers'
          : 'radio'
      : listTab

  const handleTuneChannel = useCallback(
    (channelInput: string): boolean => {
      const resolved = parseQuickTuneInput(channelInput, 'geo')
      const ok = engine.tuneGeohash(resolved?.key ?? channelInput)
      if (ok) {
        radioAudio.play('tune')
        setListTab('radio')
        setMobileScreen('chat')
        setRoomInfoOpen(false)
        setRadarExpanded(false)
      }
      return ok
    },
    [engine]
  )

  const handleSelectServerChannel = useCallback(
    (serverId: string, channelId: string) => {
      engine.servers.selectChannel(serverId, channelId)
      radioAudio.play('tune')
      setListTab('servers')
      setMobileScreen('chat')
      setRoomInfoOpen(false)
    },
    [engine.servers]
  )

  const handleOpenServerHub = useCallback((initialTab: ServerHubTab = 'create') => {
    setServerHubState({ open: true, tab: initialTab })
  }, [])

  const handleOpenServerSettings = useCallback(
    (serverId: string, initialTab: ServerSettingsTab = 'overview') => {
      setServerSettingsState({ serverId, tab: initialTab })
      setRoomInfoOpen(false)
    },
    []
  )

  const handleJoinedServer = useCallback(
    (server: ServerSummary) => {
      engine.servers.selectServer(server.id)
      closeServerHub()
      setListTab('servers')
      setMobileScreen('chat')
    },
    [engine.servers, closeServerHub]
  )

  const handleOpenScanner = useCallback(() => {
    setQrScannerOpen(true)
  }, [])

  const handleOpenWallet = useCallback((intent?: WalletInitialIntent) => {
    setZapTarget(null)
    setInspectedPeer(null)
    setRadarExpanded(false)
    setSettingsState((prev) => (prev.open ? { ...prev, open: false } : prev))
    setRoomInfoOpen(false)
    setWalletState({ open: true, intent })
  }, [])

  const handleOpenZap = useCallback((target: ZapTarget) => {
    setWalletState({ open: false, intent: undefined })
    setZapTarget(target)
  }, [])

  const handleClaimCashuToken = useCallback(
    (token: string) => {
      handleOpenWallet({ tab: 'receive', receiveMode: 'cashu', payload: token })
    },
    [handleOpenWallet]
  )

  const activeChatLabel = useMemo(() => {
    if (isDm && engine.activeDmThread) {
      return engine.activeDmThread.peerDisplayHandle
    }
    if (isServer && activeServer && activeChannel) {
      return `${activeServer.name} · #${activeChannel.name}`
    }
    return formatRadioChannelLabel(engine.activeGeohash)
  }, [isDm, engine.activeDmThread, isServer, activeServer, activeChannel, engine.activeGeohash])

  const handleSendCashuToChat = useCallback(
    async (token: string, amountSats: number, memo?: string): Promise<boolean> => {
      const cleanToken = token.trim()
      if (!cleanToken) return false
      const body = memo?.trim()
        ? `⚡ ${amountSats.toLocaleString()} sats — ${memo.trim()}\n${cleanToken}`
        : cleanToken
      let ok = false
      if (isServer && activeServer && activeChannel) {
        ok = await engine.servers.sendMessage(body)
      } else if (isDm && engine.activeDmThread) {
        ok = await engine.sendDirectMessage(
          engine.activeDmThread.peerPubkey,
          body,
          engine.activeDmThread.protocol
        )
      } else {
        ok = await engine.sendInput(body)
      }
      if (ok) {
        radioAudio.play(isDm || isServerE2ee ? 'dm' : 'send')
        setWalletState({ open: false, intent: undefined })
        setMobileScreen('chat')
      }
      return ok
    },
    [isServer, activeServer, activeChannel, isDm, isServerE2ee, engine]
  )

  const handleResolvedShareTarget = useCallback(
    (target: ParsedShareTarget) => {
      setQrScannerOpen(false)
      if (target.kind === 'cashu') {
        handleOpenWallet({
          tab: 'receive',
          receiveMode: 'cashu',
          payload: target.token,
        })
        return
      }
      if (target.kind === 'lightning') {
        handleOpenWallet({
          tab: 'send',
          sendMode: 'lightning',
          payload: target.payload,
        })
        return
      }
      if (target.kind === 'dm') {
        const myMaster = engine.identity.masterPubkey.toLowerCase()
        const myActive = engine.identity.activePubkey.toLowerCase()
        if (
          target.pubkey.toLowerCase() === myMaster ||
          target.pubkey.toLowerCase() === myActive
        ) {
          engine.pushToast(
            'info',
            "That's your own DM link!",
            'Share this link or QR code with someone else to start an encrypted DM.'
          )
          return
        }
        setWalletState({ open: false, intent: undefined })
        setZapTarget(null)
        setRadarExpanded(false)
        setSettingsState((prev) => (prev.open ? { ...prev, open: false } : prev))
        setRoomInfoOpen(false)
        setInspectedPeer(null)
        engine.openDmThread(target.pubkey, target.nickname)
        radioAudio.play('tune')
        setListTab('dms')
        setMobileScreen('chat')
        engine.pushToast(
          'success',
          `Opened DM with ${target.nickname || `${target.npub.slice(0, 12)}…`}`
        )
        return
      }

      const parsed = engine.servers.parseInviteInput(target.inviteCode)
      if (!parsed) {
        engine.pushToast(
          'warning',
          'Invalid community invite',
          'Could not decode that community invite link or QR code.'
        )
        return
      }
      setWalletState({ open: false, intent: undefined })
      setZapTarget(null)
      setRadarExpanded(false)
      setSettingsState((prev) => (prev.open ? { ...prev, open: false } : prev))
      setRoomInfoOpen(false)
      void engine.servers.joinFromInvite(parsed).then((joined) => {
        if (joined) {
          radioAudio.play('tune')
          handleJoinedServer(joined)
        }
      })
    },
    [engine, handleJoinedServer, handleOpenWallet]
  )

  // Listen on mount + hashchange for `#dm=npub1...(&name=...)` deep links
  useEffect(() => {
    const consumeLocationDm = () => {
      const pending = extractPendingDmFromLocation()
      if (!pending) return
      clearLocationDmHash()
      handleResolvedShareTarget({
        kind: 'dm',
        pubkey: pending.pubkey,
        npub: pending.npub,
        nickname: pending.nickname,
      })
    }
    consumeLocationDm()
    window.addEventListener('hashchange', consumeLocationDm)
    return () => window.removeEventListener('hashchange', consumeLocationDm)
  }, [handleResolvedShareTarget])

  // Navigate mobile shell cleanly to chat when a `#topic=<slug>` deep link is clicked in-app
  useEffect(() => {
    const onRadioHash = () => {
      const key = parseRadioChannelHash(window.location.hash)
      if (!key) return
      setRadarExpanded(false)
      setSettingsState((prev) => (prev.open ? { ...prev, open: false } : prev))
      setRoomInfoOpen(false)
      setListTab('radio')
      setMobileScreen('chat')
    }
    window.addEventListener('hashchange', onRadioHash)
    return () => window.removeEventListener('hashchange', onRadioHash)
  }, [])

  const handleLeftServer = useCallback(() => {
    setServerSettingsState({ serverId: null, tab: 'overview' })
    setRoomInfoOpen(false)
    engine.tuneGeohash(engine.activeGeohash)
    setListTab('radio')
  }, [engine])

  const handleOpenDm = useCallback(
    (pubkey: string, nickname?: string) => {
      engine.openDmThread(pubkey, nickname)
      radioAudio.play('click')
      setInspectedPeer(null)
      setRoomInfoOpen(false)
      setListTab('dms')
      setMobileScreen('chat')
    },
    [engine]
  )

  const handleCloseDmThread = useCallback(
    (pubkey: string) => {
      const targetPk = pubkey.toLowerCase()
      const wasActiveDm =
        engine.activeView.type === 'dm' &&
        engine.activeView.peerPubkey.toLowerCase() === targetPk
      engine.closeDmThread(pubkey)
      if (wasActiveDm) {
        setRoomInfoOpen(false)
        if (isMobileViewport) {
          setListTab('dms')
          setMobileScreen('list')
        }
      }
    },
    [engine, isMobileViewport]
  )

  const handleMentionPeer = useCallback((handle: string) => {
    const clean = handle.startsWith('@') ? handle : `@${handle}`
    setExternalDraftToken({ id: Date.now(), text: `${clean} ` })
    setInspectedPeer(null)
    setRoomInfoOpen(false)
    setMobileScreen('chat')
  }, [])

  const handleClickInlineMention = useCallback(
    (mention: string) => {
      const raw = mention.trim().replace(/^@+/, '').trim()
      if (!raw) return
      const lower = raw.toLowerCase()
      const suffixMatch = /^(.*)#([0-9a-f]{4})$/i.exec(raw)
      const targetName = (suffixMatch ? suffixMatch[1] : raw).trim().toLowerCase()
      const targetSuffix = suffixMatch ? suffixMatch[2].toLowerCase() : null

      const findBestMatch = <T extends { displayHandle: string; nickname: string; pubkey: string }>(
        list: readonly T[]
      ): T | undefined => {
        return (
          list.find((item) => item.displayHandle.toLowerCase() === `@${lower}`) ??
          (targetSuffix
            ? list.find(
                (item) =>
                  item.nickname.toLowerCase() === targetName &&
                  item.pubkey.toLowerCase().endsWith(targetSuffix)
              ) ?? list.find((item) => item.pubkey.toLowerCase().endsWith(targetSuffix))
            : undefined) ??
          list.find((item) => item.nickname.toLowerCase() === targetName)
        )
      }

      const matched = findBestMatch(engine.peers)
      if (matched) {
        setInspectedPeer(matched)
        return
      }
      const matchedMember = findBestMatch(engine.servers.members)
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
      const recentAuthor = isServer
        ? findBestMatch(engine.servers.messages)
        : findBestMatch(engine.messages)
      if (recentAuthor) {
        setInspectedPeer({
          pubkey: recentAuthor.pubkey,
          npub: recentAuthor.pubkey,
          nickname: recentAuthor.nickname,
          displayHandle: recentAuthor.displayHandle,
          lastSeenAt: recentAuthor.createdAt,
          isOnline: false,
          isSelf:
            recentAuthor.pubkey === engine.identity.activePubkey ||
            recentAuthor.pubkey === engine.identity.masterPubkey,
          isTeleported: false,
          isMeshBridge: false,
          isBlocked: engine.isPeerBlocked(recentAuthor.pubkey),
          isTrusted: engine.isTrusted(recentAuthor.pubkey),
          messageCount: 1,
          channels: isServer && activeChannel ? [activeChannel.name] : [engine.activeGeohash],
        })
        return
      }
      handleMentionPeer(raw)
    },
    [engine, isServer, activeChannel, handleMentionPeer]
  )

  const handleExpandRadar = useCallback(() => {
    setSettingsState((prev) => (prev.open ? { ...prev, open: false } : prev))
    setRadarExpanded(true)
    setRoomInfoOpen(false)
    radioAudio.play('click')
  }, [])

  const handleOpenInstall = useCallback(() => {
    radioAudio.play('click')
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
      setListTab('radio')
      setMobileScreen('chat')
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
      setMobileScreen('chat')
      if (ZERO_ARG_COMMANDS.has(normalized)) {
        void engine.sendInput(cmdLine)
        return
      }
      setExternalDraftToken({ id: Date.now(), text: `${cmdLine.trim()} ` })
    },
    [engine]
  )

  const handleExport = useCallback(
    (format: 'md' | 'json') => {
      const engineFmt: 'markdown' | 'json' = format === 'json' ? 'json' : 'markdown'
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
              const img = m.imageAttachment ? ` [Image: ${m.imageAttachment.url}]` : ''
              return `- **${m.displayHandle}** (${ts}): ${m.content}${voice}${img}`
            }),
          ]
          file = {
            filename: `agnostr-server-${slug}-${stamp}.md`,
            mimeType: 'text/markdown;charset=utf-8',
            content: lines.join('\n'),
          }
        }
      } else {
        file = engine.exportTranscript(engineFmt)
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
        engine.pushToast('error', 'Failed to export chat')
      }
    },
    [engine, isServer, activeServer, activeChannel]
  )

  return (
    <ContextMenuProvider>
    <div
      className={`ag-app ag-shell ${panicFlash ? 'ag-panic-active' : ''}`}
      data-mobile-screen={mobileScreen}
      data-right-drawer={roomInfoOpen ? 'open' : 'closed'}
    >
      <div
        ref={shellBodyRef}
        className={`ag-shell-body ${isSwipingLeft ? 'is-swiping-left' : ''} ${isSwipingRight ? 'is-swiping-right' : ''}`}
        style={{ '--ag-left-drawer-p': String(leftProgress) } as CSSProperties}
      >
        {/* Dimmed Interactive Scrim behind Mobile Left Slide-Over Sidebar */}
        <div
          className={`ag-drawer-scrim ${mobileScreen === 'list' ? 'active' : ''} ${isSwipingLeft ? 'is-swiping' : ''}`}
          onClick={() => setMobileScreen('chat')}
          aria-hidden="true"
        />

        {/* Left Pane (Desktop 280px) / Interactive Slide-Over Sidebar Drawer (Mobile <868px) */}
        <div
          className={`ag-conv-col ${mobileScreen === 'list' ? 'open' : ''} ${isSwipingLeft ? 'is-swiping' : ''}`}
          aria-hidden={
            isMobileViewport && mobileScreen === 'chat' && !isSwipingLeft ? true : undefined
          }
        >
          <ConversationList
            engine={engine}
            activeTab={listTab}
            collapsed={sidebarCollapsed}
            onTabChange={setListTab}
            onTuneChannel={handleTuneChannel}
            onOpenDm={handleOpenDm}
            onCloseDmThread={handleCloseDmThread}
            onSelectServerChannel={handleSelectServerChannel}
            onOpenServerHub={handleOpenServerHub}
            onOpenServerSettings={handleOpenServerSettings}
            onOpenCommandPalette={() => setCmdkOpen(true)}
            onExpandRadar={handleExpandRadar}
            onOpenSettings={handleOpenSettings}
            onOpenWallet={handleOpenWallet}
            onOpenZap={handleOpenZap}
            onLocateMe={() => void handleLocateMe()}
            onFocusActiveCall={() => {
              setMobileScreen('chat')
              setCallExpanded(true)
            }}
            onInspectPeer={setInspectedPeer}
            onShowQr={setQrShareTarget}
            onOpenScanner={handleOpenScanner}
            onResolvedShareTarget={handleResolvedShareTarget}
            pwa={pwa}
            onOpenInstall={handleOpenInstall}
            onPlaySound={playSound}
          />
        </div>

        {/* Main Chat Stage */}
        <main
          className={`ag-main ${isDm ? 'dm-mode' : isServerE2ee ? 'server-e2ee-mode' : ''}`}
        >
        <ChannelHeader
          engine={engine}
          sidebarCollapsed={sidebarCollapsed}
          roomInfoOpen={roomInfoOpen}
          searchOpen={searchOpen}
          hasOtherUnread={totalUnreadBadge > 0}
          onMobileBack={handleMobileBack}
          onToggleSidebar={() => setSidebarCollapsed((v) => !v)}
          onOpenRoomInfo={() => handleRightDrawerOpenChange(true)}
          onOpenTrustedSettings={() => handleOpenSettings('privacy')}
          onToggleSearch={() => {
            setSearchOpen((v) => {
              if (v) setSearchQuery('')
              return !v
            })
          }}
          onExpandRadar={handleExpandRadar}
          onFocusActiveCall={() => setCallExpanded(true)}
          onOpenZap={handleOpenZap}
        />

        {/* Compact PWA Offline & Update-Ready Status Strips */}
        {pwa.isOffline && (
          <div className="ag-pwa-banner offline" role="status" aria-live="polite">
            <div className="ag-pwa-banner-left">
              <WifiOff size={14} />
              <span>Offline · Viewing cached messages</span>
            </div>
          </div>
        )}

        {pwa.updateAvailable && (
          <div className="ag-pwa-banner update" role="status" aria-live="polite">
            <div className="ag-pwa-banner-left">
              <RefreshCw size={14} />
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
                <X size={14} />
              </button>
            </div>
          </div>
        )}

        {/* Active P2P Voice & Video Call Stage (+ Post-Call Transcript Save Prompt) */}
        <CallStage
          calls={engine.calls}
          engine={engine}
          expanded={callExpanded}
          compactFloating={callCompactFloating}
          onToggleExpand={() => setCallExpanded((v) => !v)}
          onInspectPeer={setInspectedPeer}
          onOpenDm={handleOpenDm}
          onReturnToCall={handleReturnToActiveCall}
          onPlaySound={playSound}
        />

        {/* Live Geo Radio Group Call Join Banner (shown when peers are in this room's call) */}
        {showGeoCallJoinBanner && (
          <div className="ag-geo-call-banner" role="region" aria-label="Active room call">
            <div className="ag-geo-call-banner-left">
              <span className="ag-live-dot" aria-hidden="true" />
              <span className="ag-geo-call-banner-count tabular">
                {activeGeoCallCount} in call
              </span>
              <span className="ag-geo-call-banner-peers truncate">
                {activeGeoCallPresence
                  .slice(0, 2)
                  .map((p) => p.nickname || p.displayHandle)
                  .join(', ')}
                {activeGeoCallPresence.length > 2
                  ? ` +${activeGeoCallPresence.length - 2}`
                  : ''}
              </span>
            </div>
            <div className="ag-geo-call-banner-actions">
              <button
                type="button"
                className="ag-geo-call-join-btn primary"
                disabled={isActiveGeoCallFull}
                onClick={() => void engine.calls.joinGeoCall(engine.activeGeohash, 'audio')}
                title={
                  isActiveGeoCallFull
                    ? `Call full (${engine.calls.maxParticipants}/${engine.calls.maxParticipants})`
                    : `Join ${formatRadioChannelLabel(engine.activeGeohash)} voice call`
                }
              >
                <Phone size={13} />
                <span>{isActiveGeoCallFull ? 'Full 6/6' : 'Join Voice'}</span>
              </button>
              {!isActiveGeoCallFull && (
                <button
                  type="button"
                  className="ag-geo-call-join-btn"
                  onClick={() => void engine.calls.joinGeoCall(engine.activeGeohash, 'video')}
                  title={`Join ${formatRadioChannelLabel(engine.activeGeohash)} video call`}
                  aria-label={`Join ${formatRadioChannelLabel(engine.activeGeohash)} video call`}
                >
                  <Video size={13} />
                  <span>Video</span>
                </button>
              )}
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
          onMentionPeer={handleMentionPeer}
          onTuneChannel={handleTuneChannel}
          onClickMention={handleClickInlineMention}
          onLocateMe={() => void handleLocateMe()}
          onExpandRadar={handleExpandRadar}
          onOpenServerSettings={handleOpenServerSettings}
          onOpenLightbox={setLightboxImage}
          onOpenZap={handleOpenZap}
          onClaimCashuToken={handleClaimCashuToken}
        />

        <Composer
          engine={engine}
          externalDraftToken={externalDraftToken}
          onSent={(isEncrypted) => radioAudio.play(isEncrypted ? 'dm' : 'send')}
        />
        </main>

        {/* Clean Chat / Room / Server Info Slide-Over Sheet (In-Shell Drawer on Mobile) */}
        <RoomInfoSheet
          open={roomInfoOpen}
          swipeProgress={isMobileViewport ? rightProgress : undefined}
          isSwiping={isSwipingRight}
          inShell={isMobileViewport}
          engine={engine}
          onClose={() => setRoomInfoOpen(false)}
          onInspectPeer={setInspectedPeer}
          onStartDm={handleOpenDm}
          onCloseDmThread={handleCloseDmThread}
          onTuneChannel={handleTuneChannel}
          onExpandRadar={handleExpandRadar}
          onOpenServerSettings={handleOpenServerSettings}
          onExportTranscript={handleExport}
          onLeftServer={handleLeftServer}
          onShowQr={setQrShareTarget}
          onOpenScanner={handleOpenScanner}
          onOpenZap={handleOpenZap}
          onPlaySound={playSound}
        />

        {/* Mobile In-Shell Map & Settings Tabs (Sit above Always-Present Bottom Tab Bar) */}
        {isMobileViewport && (
          <ExpandedRadarModal
            open={radarExpanded}
            inShell={true}
            engine={engine}
            onClose={() => setRadarExpanded(false)}
            onTuneChannel={handleTuneChannel}
            onPlaySound={playSound}
          />
        )}
        {isMobileViewport && (
          <SettingsModal
            open={settingsState.open}
            inShell={true}
            engine={engine}
            pwa={pwa}
            initialTab={settingsState.tab}
            onClose={() => setSettingsState((prev) => ({ ...prev, open: false }))}
            onOpenInstall={handleOpenInstall}
            onOpenWallet={() => handleOpenWallet({ tab: 'overview' })}
            onShowQr={setQrShareTarget}
            onOpenScanner={handleOpenScanner}
            onPlaySound={playSound}
          />
        )}
      </div>

      {/* Always-Present Native Mobile Bottom Tab Bar (< 868px, Flex Flow) */}
      <MobileTabBar
        activeTab={mobileNavActiveTab}
        mapActive={radarExpanded}
        settingsActive={settingsState.open}
        radioUnread={engine.totalGeoUnread}
        radioMentions={engine.totalGeoMentions}
        dmUnread={engine.totalDmUnread}
        serverUnread={engine.servers.totalServerUnread}
        serverMentions={engine.servers.totalServerMentions}
        onSelectTab={handleMobileSelectTab}
        onOpenMap={handleMobileTabMap}
        onOpenSettings={handleMobileTabSettings}
      />

      {/* Desktop Unified Calm Settings Modal (Profile · Privacy & Trust · Appearance · Calls · Network) */}
      {!isMobileViewport && (
        <SettingsModal
          open={settingsState.open}
          inShell={false}
          engine={engine}
          pwa={pwa}
          initialTab={settingsState.tab}
          onClose={() => setSettingsState((prev) => ({ ...prev, open: false }))}
          onOpenInstall={handleOpenInstall}
          onOpenWallet={() => handleOpenWallet({ tab: 'overview' })}
          onShowQr={setQrShareTarget}
          onOpenScanner={handleOpenScanner}
          onPlaySound={playSound}
        />
      )}

      {/* Peer Profile & Moderation Modal */}
      <PeerInspectorModal
        peer={inspectedPeer}
        engine={engine}
        onClose={() => setInspectedPeer(null)}
        onStartDm={handleOpenDm}
        onMentionPeer={handleMentionPeer}
        onOpenZap={handleOpenZap}
      />

      {/* Desktop Full-Screen Expandable Geohash Map Modal */}
      {!isMobileViewport && (
        <ExpandedRadarModal
          open={radarExpanded}
          inShell={false}
          engine={engine}
          onClose={() => setRadarExpanded(false)}
          onTuneChannel={handleTuneChannel}
          onPlaySound={playSound}
        />
      )}

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
        onShowQr={setQrShareTarget}
        onOpenScanner={handleOpenScanner}
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
        onShowQr={setQrShareTarget}
        onOpenScanner={handleOpenScanner}
        onPlaySound={playSound}
      />

      {/* Quick Switcher & Command Palette (Cmd+K) */}
      <CommandPalette
        open={cmdkOpen}
        engine={engine}
        onClose={() => setCmdkOpen(false)}
        onTuneChannel={handleTuneChannel}
        onOpenDm={handleOpenDm}
        onSelectServerChannel={handleSelectServerChannel}
        onOpenServerHub={handleOpenServerHub}
        onExpandRadar={handleExpandRadar}
        onLocateMe={() => void handleLocateMe()}
        onOpenRoomInfo={() => handleRightDrawerOpenChange(true)}
        onOpenSettings={handleOpenSettings}
        onOpenWallet={handleOpenWallet}
        onToggleSound={handleToggleSound}
        onRunCommand={handleRunCommand}
        onExport={handleExport}
        onShowQr={setQrShareTarget}
        onOpenScanner={handleOpenScanner}
        onResolvedShareTarget={handleResolvedShareTarget}
        pwa={pwa}
        onOpenInstall={handleOpenInstall}
      />

      {/* Fullscreen Image Lightbox Viewer */}
      <ImageLightboxModal
        payload={lightboxImage}
        onClose={() => setLightboxImage(null)}
      />

      {/* Shareable QR Code Modal (DMs & Community Invites) */}
      <QrShareModal target={qrShareTarget} onClose={() => setQrShareTarget(null)} />

      {/* Camera / Image QR Code Scanner Modal (DMs & Community Invites) */}
      <QrScannerModal
        open={qrScannerOpen}
        onClose={() => setQrScannerOpen(false)}
        onResolved={handleResolvedShareTarget}
      />

      {/* Incoming Encrypted P2P Call Offer Takeover / Card */}
      {engine.calls.incomingCall && (
        <IncomingCallBanner
          incoming={engine.calls.incomingCall}
          mode="dm"
          isRinging={engine.notifications.isRinging}
          isRingMuted={engine.notifications.isRingMuted}
          isStandalonePwa={pwa.isInstalled}
          onMuteRing={engine.notifications.muteCurrentRing}
          onAcceptAudio={() => {
            const offer = engine.calls.incomingCall
            if (offer) {
              engine.openDmThread(offer.callerPubkey, offer.callerNickname)
              setListTab('dms')
              setMobileScreen('chat')
            }
            void engine.calls.acceptIncomingCall('audio')
          }}
          onAcceptVideo={() => {
            const offer = engine.calls.incomingCall
            if (offer) {
              engine.openDmThread(offer.callerPubkey, offer.callerNickname)
              setListTab('dms')
              setMobileScreen('chat')
            }
            void engine.calls.acceptIncomingCall('video')
          }}
          onDecline={() => {
            radioAudio.play('call-leave')
            engine.calls.declineIncomingCall()
          }}
        />
      )}

      {/* Built-In Multi-Mint Cashu Ecash Wallet & Boltz On-Chain Swap Modal */}
      <WalletModal
        open={walletState.open}
        onClose={() => setWalletState({ open: false, intent: undefined })}
        wallet={engine.wallet}
        zaps={engine.zaps}
        initialIntent={walletState.intent}
        onOpenScanner={handleOpenScanner}
        onSendToChat={handleSendCashuToChat}
        activeChatLabel={activeChatLabel}
      />

      {/* NIP-57 / Nymchat Lightning Zap Modal */}
      <ZapModal
        target={zapTarget}
        onClose={() => setZapTarget(null)}
        wallet={engine.wallet}
        zaps={engine.zaps}
        onOpenWallet={handleOpenWallet}
      />

      {/* Global Trust Peer Security Warning Confirmation Dialog */}
      <TrustConfirmModal
        request={engine.pendingTrustRequest}
        onConfirm={engine.confirmPendingTrust}
        onCancel={engine.cancelPendingTrust}
      />

      {/* Non-Blocking Notifications */}
      <ToastStack toasts={engine.toasts} onDismiss={engine.dismissToast} />
    </div>
    </ContextMenuProvider>
  )
}

export default App
