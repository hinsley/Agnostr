import {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react'
import { createPortal } from 'react-dom'
import {
  Loader2,
  Phone,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Trash2,
  Video,
  WifiOff,
  X,
} from 'lucide-react'
import { useAgnostrEngine } from './hooks/useAgnostrEngine'
import { useBackHandler, useBackNavigation } from './hooks/useBackNavigation'
import { useMobileSwipeDrawers } from './hooks/useMobileSwipeDrawers'
import { useMobileViewport } from './hooks/useMobileViewport'
import { usePwa } from './hooks/usePwa'
import { doesContentMentionUser } from './lib/bitchatProtocol'
import {
  formatBitchatChannelLabel,
  parseQuickTuneInput,
  parseBitchatChannelHash,
} from './lib/bitchatChannel'
import {
  clearLocationAgoraHash,
  clearLocationDmHash,
  extractPendingAgoraFromLocation,
  extractPendingDmFromLocation,
  parseAgoraShareUrl,
  parseShareTarget,
  type ParsedAgoraNoteShareTarget,
  type ParsedAgoraProfileShareTarget,
  type ParsedShareTarget,
} from './lib/shareLinks'
import type { GeoMessage, PeerInfo, ThemeId } from './types/protocol'
import type { ServerMessage, ServerSummary } from './types/servers'
import type { WalletInitialIntent, ZapTarget } from './types/wallet'
import { bitchatAudio, type SoundCue } from './utils/sound'
import { shortPubkey } from './utils/identicon'
import AppRail, { type ActiveWorkspace } from './components/AppRail'
import { AvatarImg } from './components/AvatarImg'
import {
  registerInternalAgoraLinkHandler,
  UntrustedLinkModal,
} from './components/UntrustedLinkModal'
import SuiteLauncher from './components/SuiteLauncher'
import ConversationList, { type ListTab } from './components/ConversationList'
import UserListPane from './components/UserListPane'
import MobileTabBar from './components/MobileTabBar'
import ChannelHeader from './components/ChannelHeader'
import SearchBar from './components/SearchBar'
import MessageStream from './components/MessageStream'
import Composer from './components/Composer'
import ToastStack from './components/ToastStack'
import IncomingCallBanner from './components/IncomingCallBanner'
import TrustConfirmModal from './components/TrustConfirmModal'
import { ContextMenuProvider } from './components/ContextMenu'
import type { SettingsTab } from './components/SettingsModal'
import type { ServerHubTab } from './components/ServerHubModal'
import type { ServerSettingsTab } from './components/ServerSettingsModal'
import type { LightboxImagePayload } from './components/ImageLightboxModal'
import type { QrShareTarget } from './components/QrShareModal'
import type { AmailComposeTarget, AmailInitialSection } from './components/AmailView'

// Aggressive React.lazy code-splitting: secondary workspaces & modals load on demand only
const AgoraView = lazy(() => import('./components/AgoraView'))
const AmailView = lazy(() => import('./components/AmailView'))
const WalletModal = lazy(() => import('./components/WalletModal'))
const SettingsModal = lazy(() => import('./components/SettingsModal'))
const ExpandedRadarModal = lazy(() => import('./components/ExpandedRadarModal'))
const CallStage = lazy(() => import('./components/CallStage'))
const RoomInfoSheet = lazy(() => import('./components/RoomInfoSheet'))
const ServerHubModal = lazy(() => import('./components/ServerHubModal'))
const ServerSettingsModal = lazy(() => import('./components/ServerSettingsModal'))
const CommandPalette = lazy(() => import('./components/CommandPalette'))
const PeerInspectorModal = lazy(() => import('./components/PeerInspectorModal'))
const QrShareModal = lazy(() => import('./components/QrShareModal'))
const QrScannerModal = lazy(() => import('./components/QrScannerModal'))
const ZapModal = lazy(() => import('./components/ZapModal'))
const PwaInstallModal = lazy(() => import('./components/PwaInstallModal'))
const ImageLightboxModal = lazy(() => import('./components/ImageLightboxModal'))

const THEME_META_COLORS: Record<ThemeId, string> = {
  phosphor: '#0B0C0F',
  indigo: '#090A10',
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

interface PwaLaunchParams {
  readonly targetURL?: string
}

interface PwaLaunchQueue {
  setConsumer: (consumer: (launchParams: PwaLaunchParams) => void) => void
}

function isAgoraLocationHash(hash: string): boolean {
  const raw = (hash || '').replace(/^#/, '').trim().toLowerCase()
  return (
    raw === 'agora' ||
    raw.startsWith('agora/') ||
    raw.startsWith('agora?') ||
    raw.startsWith('agora=') ||
    raw.startsWith('post=')
  )
}

export function App() {
  useMobileViewport()
  const [initialPendingAgora, setInitialPendingAgora] = useState<
    ParsedAgoraNoteShareTarget | ParsedAgoraProfileShareTarget | null
  >(() => extractPendingAgoraFromLocation())
  const engine = useAgnostrEngine()

  const [workspace, setWorkspace] = useState<ActiveWorkspace>(() =>
    typeof window !== 'undefined' &&
    (isAgoraLocationHash(window.location.hash) || Boolean(initialPendingAgora))
      ? 'agora'
      : 'chat'
  )
  const [listTab, setListTab] = useState<ListTab>('bitchat')
  const [suiteLauncherOpen, setSuiteLauncherOpen] = useState(false)
  const [agoraInitialCompose, setAgoraInitialCompose] = useState(false)
  const [selectedServerId, setSelectedServerId] = useState<string | null>(
    () => engine.servers.activeServer?.id ?? engine.servers.joinedServers[0]?.id ?? null
  )
  const [mobileScreen, setMobileScreen] = useState<'list' | 'chat'>('chat')
  const [isMobileViewport, setIsMobileViewport] = useState<boolean>(() =>
    typeof window !== 'undefined' ? window.innerWidth <= 867 : false
  )
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [userListCollapsed, setUserListCollapsed] = useState(false)
  const [mobileUserListOpen, setMobileUserListOpen] = useState(false)
  const [roomInfoOpen, setRoomInfoOpen] = useState(false)

  // Keep selectedServerId synced with active server & joined servers list
  const activeServerId = engine.servers.activeServer?.id ?? null
  const firstJoinedServerId = engine.servers.joinedServers[0]?.id ?? null
  const joinedServerIdsKey = engine.servers.joinedServers.map((s) => s.id).join(',')

  useEffect(() => {
    if (activeServerId) {
      setSelectedServerId(activeServerId)
    }
  }, [activeServerId])

  useEffect(() => {
    const validIds = new Set(joinedServerIdsKey ? joinedServerIdsKey.split(',') : [])
    setSelectedServerId((prev) => {
      if (prev && validIds.has(prev)) return prev
      return activeServerId ?? firstJoinedServerId ?? null
    })
  }, [joinedServerIdsKey, activeServerId, firstJoinedServerId])

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
  const [walletIntent, setWalletIntent] = useState<WalletInitialIntent | undefined>(undefined)
  const [zapTarget, setZapTarget] = useState<ZapTarget | null>(null)
  const [amailState, setAmailState] = useState<{
    section: AmailInitialSection
    composeTo: AmailComposeTarget | null
  }>({ section: 'inbox', composeTo: null })
  const [pendingDeleteDm, setPendingDeleteDm] = useState<{
    pubkey: string
    displayName: string
    isTrusted: boolean
  } | null>(null)
  const [noteEditorPeer, setNoteEditorPeer] = useState<{
    pubkey: string
    nickname: string
    displayHandle: string
  } | null>(null)
  const [noteDraft, setNoteDraft] = useState('')
  const noteTextareaRef = useRef<HTMLTextAreaElement | null>(null)
  const deleteDmCancelBtnRef = useRef<HTMLButtonElement | null>(null)
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

  // Subtle startup safety-filter loading/ready floating popup state
  const cfStatus = engine.contentFilter.modelStatus
  const cfProgress = engine.contentFilter.downloadProgress
  const cfRuntime = engine.contentFilter.runtimeDevice
  const cfEnabled = engine.contentFilter.settings.enabled
  const [cfPopupDismissed, setCfPopupDismissed] = useState(false)
  const [cfReadyVisible, setCfReadyVisible] = useState(false)
  const cfSawPendingRef = useRef(cfStatus !== 'ready')
  const cfPrevStatusRef = useRef(cfStatus)

  useEffect(() => {
    const prev = cfPrevStatusRef.current
    cfPrevStatusRef.current = cfStatus

    if (cfStatus === 'downloading') {
      cfSawPendingRef.current = true
      if (prev !== 'downloading') {
        setCfPopupDismissed(false)
      }
      setCfReadyVisible(false)
      return
    }

    if (cfStatus === 'ready') {
      if (cfSawPendingRef.current && prev !== 'ready' && cfEnabled) {
        cfSawPendingRef.current = false
        setCfReadyVisible(true)
        const timer = window.setTimeout(() => {
          setCfReadyVisible(false)
        }, 2600)
        return () => window.clearTimeout(timer)
      }
      if (!cfEnabled) {
        setCfReadyVisible(false)
      }
      return
    }

    if (cfStatus === 'error') {
      cfSawPendingRef.current = true
      if (prev !== 'error') {
        setCfPopupDismissed(false)
      }
      setCfReadyVisible(false)
      return
    }

    // 'idle'
    cfSawPendingRef.current = true
    setCfPopupDismissed(false)
    setCfReadyVisible(false)
  }, [cfStatus, cfEnabled])

  const cfPopupState: 'loading' | 'ready' | 'error' | null = cfPopupDismissed
    ? null
    : cfStatus === 'downloading'
      ? 'loading'
      : cfStatus === 'ready' && cfReadyVisible && cfEnabled
        ? 'ready'
        : cfStatus === 'error' && cfEnabled
          ? 'error'
          : null

  const cfPct = Math.max(0, Math.min(100, Math.round(cfProgress)))
  const cfRuntimeLabel =
    cfRuntime === 'webgpu' ? 'WebGPU' : cfRuntime === 'wasm' ? 'WASM' : null

  const isDm = engine.activeView.type === 'dm' && engine.activeDmThread !== null
  const isServer =
    engine.activeView.type === 'server' &&
    engine.servers.activeServer !== null &&
    engine.servers.activeChannel !== null
  const activeServer = engine.servers.activeServer
  const activeChannel = engine.servers.activeChannel
  const isServerE2ee = Boolean(isServer && activeServer?.encrypted)

  // Total unread count across DMs, Servers, Bitchat rooms, Agmail, and Agora for PWA App Badge
  const totalUnreadBadge = useMemo(() => {
    return (
      engine.totalDmUnread +
      engine.servers.totalServerUnread +
      engine.totalGeoUnread +
      engine.amail.unreadInboxCount +
      engine.agora.unreadNotificationCount
    )
  }, [
    engine.totalDmUnread,
    engine.servers.totalServerUnread,
    engine.totalGeoUnread,
    engine.amail.unreadInboxCount,
    engine.agora.unreadNotificationCount,
  ])

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
    setSuiteLauncherOpen(false)
    setWorkspace('chat')
    setAmailState({ section: 'inbox', composeTo: null })
    setWalletIntent(undefined)
    setRadarExpanded(false)
    setSettingsState((prev) => (prev.open ? { ...prev, open: false } : prev))
    setMobileUserListOpen(false)
    setRoomInfoOpen(false)
    if (activeCall.mode === 'geo' && activeCall.geohash) {
      engine.tuneGeohash(activeCall.geohash)
      setListTab('bitchat')
      setMobileScreen('chat')
    } else if (activeCall.mode === 'server' && activeCall.serverId) {
      engine.servers.selectServer(activeCall.serverId)
      setSelectedServerId(activeCall.serverId)
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

    // If this notification belongs to another saved profile on this device, switch into it
    const targetProfilePk = payload.recipientPubkey?.trim().toLowerCase()
    if (
      targetProfilePk &&
      /^[0-9a-f]{64}$/.test(targetProfilePk) &&
      targetProfilePk !== engine.profiles.activeProfileId.toLowerCase() &&
      engine.profiles.profiles.some((p) => p.id.toLowerCase() === targetProfilePk)
    ) {
      engine.notifications.consumePendingAction()
      void engine.profiles.switchProfile(targetProfilePk)
      return
    }

    // Navigate to target room/DM/server/Agmail once per pending notification action
    if (navigatedNotifTsRef.current !== receivedAt) {
      navigatedNotifTsRef.current = receivedAt
      setWalletIntent(undefined)
      setMobileUserListOpen(false)
      setRoomInfoOpen(false)
      setCmdkOpen(false)
      setRadarExpanded(false)

      if (payload.category === 'agmail') {
        setWorkspace('mail')
        setAmailState({ section: 'inbox', composeTo: null })
      } else {
        setWorkspace('chat')
        setAmailState({ section: 'inbox', composeTo: null })

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
          setSelectedServerId(payload.serverId)
          setListTab('servers')
          setMobileScreen('chat')
        } else if (
          (payload.category === 'geo-message' ||
            payload.category === 'location-note' ||
            payload.category === 'geo-call') &&
          payload.geohash
        ) {
          engine.tuneGeohash(payload.geohash)
          setListTab('bitchat')
          setMobileScreen('chat')
        } else if (payload.category === 'test') {
          setSettingsState({ open: true, tab: 'notifications' })
        }
      }
    }

    if (action === 'open') {
      engine.notifications.consumePendingAction()
      return
    }

    // Handle Bitchat call notification Accept / Decline actions immediately
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
        bitchatAudio.play('call-leave')
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
      bitchatAudio.play('call-join')
    } else if (prev && !activeCallId) {
      bitchatAudio.play('call-leave')
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
      bitchatAudio.play('rec-start')
    } else if (recordingCount < prev.count) {
      bitchatAudio.play('rec-stop')
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
    bitchatAudio.setEnabled(engine.settings.soundEnabled)
  }, [engine.settings.soundEnabled])

  // Sync dynamic document title with active workspace, channel, DM, or Server channel
  useEffect(() => {
    const totalUnread = engine.totalDmUnread + engine.servers.totalServerUnread
    const unreadPrefix = totalUnread > 0 ? `(${totalUnread}) ` : ''
    if (workspace === 'agora') {
      const agoraPrefix =
        engine.agora.unreadNotificationCount > 0
          ? `(${engine.agora.unreadNotificationCount}) `
          : unreadPrefix
      document.title = `${agoraPrefix}Agora — Agnostr`
    } else if (workspace === 'mail') {
      const mailPrefix = engine.amail.unreadInboxCount > 0 ? `(${engine.amail.unreadInboxCount}) ` : unreadPrefix
      document.title = `${mailPrefix}Agmail · Agnostr`
    } else if (workspace === 'wallet') {
      document.title = `${unreadPrefix}Agwallet · Agnostr`
    } else if (engine.activeView.type === 'dm' && engine.activeDmThread) {
      document.title = `${unreadPrefix}${engine.activeDmThread.peerDisplayHandle} · Agnostr`
    } else if (
      engine.activeView.type === 'server' &&
      engine.servers.activeServer &&
      engine.servers.activeChannel
    ) {
      document.title = `${unreadPrefix}#${engine.servers.activeChannel.name} · ${engine.servers.activeServer.name} · Agnostr`
    } else {
      document.title = `${unreadPrefix}${formatBitchatChannelLabel(engine.activeGeohash)} · Agnostr`
    }
  }, [
    workspace,
    engine.agora.unreadNotificationCount,
    engine.amail.unreadInboxCount,
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
      bitchatAudio.play(mentionsUs ? 'mention' : 'receive')
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
      bitchatAudio.play(mentionsUs ? 'mention' : 'receive')
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
      bitchatAudio.play('dm')
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
      setWorkspace('chat')
      setSuiteLauncherOpen(false)
      setAgoraInitialCompose(false)
      setSelectedServerId(null)
      setServerSettingsState({ serverId: null, tab: 'overview' })
      setSettingsState({ open: false, tab: undefined })
      setMobileUserListOpen(false)
      setRoomInfoOpen(false)
      setRadarExpanded(false)
      setInstallModalOpen(false)
      setCallExpanded(false)
      setLightboxImage(null)
      setQrShareTarget(null)
      setQrScannerOpen(false)
      setWalletIntent(undefined)
      setZapTarget(null)
      setAmailState({ section: 'inbox', composeTo: null })
      setPendingDeleteDm(null)
      setNoteEditorPeer(null)
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
          if (!v) {
            setMobileUserListOpen(false)
            setMobileScreen('chat')
          }
          return !v
        })
        return
      }
      if (mod && e.key === ',') {
        e.preventDefault()
        setRadarExpanded(false)
        setSettingsState((prev) => ({ open: !prev.open, tab: undefined }))
        return
      }
      if (e.key === 'Escape') {
        if (engine.pendingTrustRequest) {
          e.stopImmediatePropagation()
          engine.cancelPendingTrust()
        } else if (pendingDeleteDm) {
          e.stopImmediatePropagation()
          setPendingDeleteDm(null)
        } else if (noteEditorPeer) {
          e.stopImmediatePropagation()
          setNoteEditorPeer(null)
        } else if (qrScannerOpen) {
          e.stopImmediatePropagation()
          setQrScannerOpen(false)
        } else if (zapTarget) {
          e.stopImmediatePropagation()
          setZapTarget(null)
        } else if (qrShareTarget) {
          e.stopImmediatePropagation()
          setQrShareTarget(null)
        } else if (cmdkOpen) {
          e.stopImmediatePropagation()
          setCmdkOpen(false)
        } else if (lightboxImage) {
          e.stopImmediatePropagation()
          setLightboxImage(null)
        } else if (suiteLauncherOpen) {
          e.stopImmediatePropagation()
          setSuiteLauncherOpen(false)
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
        } else if (mobileUserListOpen) {
          setMobileUserListOpen(false)
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
    pendingDeleteDm,
    noteEditorPeer,
    qrScannerOpen,
    zapTarget,
    qrShareTarget,
    cmdkOpen,
    lightboxImage,
    suiteLauncherOpen,
    settingsState.open,
    serverSettingsState.serverId,
    serverHubState.open,
    closeServerHub,
    radarExpanded,
    installModalOpen,
    callExpanded,
    inspectedPeer,
    mobileUserListOpen,
    roomInfoOpen,
    searchOpen,
  ])

  const playSound = useCallback((cue: SoundCue) => {
    bitchatAudio.play(cue)
  }, [])

  const closeAgora = useCallback(() => {
    setAgoraInitialCompose(false)
    setWorkspace('chat')
  }, [])

  const closeAmail = useCallback(() => {
    setAmailState({ section: 'inbox', composeTo: null })
    setWorkspace('chat')
  }, [])

  const closeWallet = useCallback(() => {
    setWalletIntent(undefined)
    setWorkspace('chat')
  }, [])

  const handleToggleSuiteLauncher = useCallback(() => {
    setSuiteLauncherOpen((v) => !v)
  }, [])

  const handleOpenCommandPalette = useCallback(() => {
    setSuiteLauncherOpen(false)
    setCmdkOpen(true)
  }, [])

  const handleSelectAgora = useCallback((opts?: { compose?: boolean }) => {
    setSuiteLauncherOpen(false)
    setRadarExpanded(false)
    setSettingsState((prev) => (prev.open ? { ...prev, open: false } : prev))
    setMobileUserListOpen(false)
    setRoomInfoOpen(false)
    setZapTarget(null)
    setInspectedPeer(null)
    setWalletIntent(undefined)
    setAmailState({ section: 'inbox', composeTo: null })
    setWorkspace('agora')
    if (opts?.compose) {
      setAgoraInitialCompose(true)
    }
  }, [])

  const handleSelectBitchat = useCallback(() => {
    setSuiteLauncherOpen(false)
    setRadarExpanded(false)
    setSettingsState((prev) => (prev.open ? { ...prev, open: false } : prev))
    setMobileUserListOpen(false)
    setRoomInfoOpen(false)
    setZapTarget(null)
    setInspectedPeer(null)
    setWalletIntent(undefined)
    setAmailState({ section: 'inbox', composeTo: null })
    setWorkspace('chat')
    setListTab('bitchat')
    setSidebarCollapsed(false)
    if (engine.activeView.type !== 'channel') {
      engine.tuneGeohash(engine.activeGeohash)
    }
    if (isMobileViewport) {
      setMobileScreen('list')
    }
  }, [engine, isMobileViewport])

  const handleSelectPeople = useCallback(() => {
    setSuiteLauncherOpen(false)
    setRadarExpanded(false)
    setSettingsState((prev) => (prev.open ? { ...prev, open: false } : prev))
    setMobileUserListOpen(false)
    setRoomInfoOpen(false)
    setZapTarget(null)
    setInspectedPeer(null)
    setWalletIntent(undefined)
    setAmailState({ section: 'inbox', composeTo: null })
    setWorkspace('chat')
    setListTab('dms')
    setSidebarCollapsed(false)
    if (isMobileViewport) {
      setMobileScreen('list')
    }
  }, [isMobileViewport])

  const handleSelectGroups = useCallback(() => {
    setSuiteLauncherOpen(false)
    setRadarExpanded(false)
    setSettingsState((prev) => (prev.open ? { ...prev, open: false } : prev))
    setMobileUserListOpen(false)
    setRoomInfoOpen(false)
    setZapTarget(null)
    setInspectedPeer(null)
    setWalletIntent(undefined)
    setAmailState({ section: 'inbox', composeTo: null })
    setWorkspace('chat')
    setListTab('servers')
    setSidebarCollapsed(false)
    const joined = engine.servers.joinedServers
    if (joined.length > 0) {
      const preferredId =
        (selectedServerId && joined.some((s) => s.id === selectedServerId)
          ? selectedServerId
          : null) ??
        engine.servers.activeServer?.id ??
        joined[0]?.id ??
        null
      if (preferredId) {
        setSelectedServerId(preferredId)
        if (engine.activeView.type !== 'server' || engine.activeView.serverId !== preferredId) {
          engine.servers.selectServer(preferredId)
        }
      }
    }
    if (isMobileViewport) {
      setMobileScreen('list')
    }
  }, [engine.servers, engine.activeView, selectedServerId, isMobileViewport])

  const handleSelectWorkspace = useCallback((next: ActiveWorkspace) => {
    setSuiteLauncherOpen(false)
    setRadarExpanded(false)
    setSettingsState((prev) => (prev.open ? { ...prev, open: false } : prev))
    setMobileUserListOpen(false)
    setRoomInfoOpen(false)
    setZapTarget(null)
    setInspectedPeer(null)
    if (next === 'agora') {
      setWalletIntent(undefined)
      setAmailState({ section: 'inbox', composeTo: null })
    } else if (next === 'mail') {
      setWalletIntent(undefined)
      setAmailState((prev) => ({ section: prev.section || 'inbox', composeTo: null }))
    } else if (next === 'wallet') {
      setWalletIntent(undefined)
    }
    setWorkspace(next)
  }, [])

  const handleSelectChatTab = useCallback(
    (tab: ListTab) => {
      if (tab === 'servers') {
        handleSelectGroups()
        return
      }
      setSuiteLauncherOpen(false)
      setRadarExpanded(false)
      setSettingsState((prev) => (prev.open ? { ...prev, open: false } : prev))
      setMobileUserListOpen(false)
      setRoomInfoOpen(false)
      setZapTarget(null)
      setInspectedPeer(null)
      setWorkspace('chat')
      setListTab(tab)
      setSidebarCollapsed(false)
      if (tab === 'bitchat' && engine.activeView.type !== 'channel') {
        engine.tuneGeohash(engine.activeGeohash)
      }
    },
    [engine, handleSelectGroups]
  )

  const handleSelectServer = useCallback(
    (serverId: string) => {
      engine.servers.selectServer(serverId)
      bitchatAudio.play('tune')
      setSuiteLauncherOpen(false)
      setRadarExpanded(false)
      setSettingsState((prev) => (prev.open ? { ...prev, open: false } : prev))
      setMobileUserListOpen(false)
      setRoomInfoOpen(false)
      setZapTarget(null)
      setInspectedPeer(null)
      setAmailState({ section: 'inbox', composeTo: null })
      setWalletIntent(undefined)
      setSelectedServerId(serverId)
      setListTab('servers')
      setWorkspace('chat')
      setSidebarCollapsed(false)
      setMobileScreen('chat')
    },
    [engine.servers]
  )

  const handleOpenAmail = useCallback((section: AmailInitialSection = 'inbox') => {
    setSuiteLauncherOpen(false)
    setRadarExpanded(false)
    setSettingsState((prev) => (prev.open ? { ...prev, open: false } : prev))
    setMobileUserListOpen(false)
    setRoomInfoOpen(false)
    setWalletIntent(undefined)
    setZapTarget(null)
    setInspectedPeer(null)
    setAmailState({ section, composeTo: null })
    setWorkspace('mail')
  }, [])

  const handleOpenAmailCompose = useCallback((pubkey: string, nickname?: string) => {
    setSuiteLauncherOpen(false)
    setRadarExpanded(false)
    setSettingsState((prev) => (prev.open ? { ...prev, open: false } : prev))
    setMobileUserListOpen(false)
    setRoomInfoOpen(false)
    setWalletIntent(undefined)
    setZapTarget(null)
    setInspectedPeer(null)
    setAmailState({ section: 'compose', composeTo: { pubkey, nickname } })
    setWorkspace('mail')
  }, [])

  const handleOpenSettings = useCallback((tab?: SettingsTab) => {
    setSuiteLauncherOpen(false)
    setRadarExpanded(false)
    setMobileUserListOpen(false)
    setRoomInfoOpen(false)
    setSettingsState({ open: true, tab })
  }, [])

  const handleOpenRoomInfo = useCallback(() => {
    setMobileUserListOpen(false)
    setMobileScreen('chat')
    setRoomInfoOpen(true)
  }, [])

  const handleToggleUserList = useCallback(() => {
    bitchatAudio.play('click')
    if (isMobileViewport) {
      setMobileUserListOpen((open) => {
        if (!open) {
          setMobileScreen('chat')
          setRoomInfoOpen(false)
        }
        return !open
      })
    } else {
      setUserListCollapsed((v) => !v)
    }
  }, [isMobileViewport])

  const handleLeftDrawerOpenChange = useCallback((open: boolean) => {
    if (open) {
      setMobileUserListOpen(false)
      setRoomInfoOpen(false)
      setMobileScreen('list')
    } else {
      setMobileScreen('chat')
    }
  }, [])

  const handleRightDrawerOpenChange = useCallback((open: boolean) => {
    if (open) {
      setMobileScreen('chat')
      setRoomInfoOpen(false)
      setMobileUserListOpen(true)
    } else {
      setMobileUserListOpen(false)
    }
  }, [])

  const swipeDisabled =
    !isMobileViewport ||
    workspace !== 'chat' ||
    suiteLauncherOpen ||
    Boolean(engine.pendingTrustRequest) ||
    Boolean(pendingDeleteDm) ||
    Boolean(noteEditorPeer) ||
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
    rightOpen: mobileUserListOpen,
    disabled: swipeDisabled || roomInfoOpen,
    onLeftOpenChange: handleLeftDrawerOpenChange,
    onRightOpenChange: handleRightDrawerOpenChange,
  })

  const handleMobileBack = useCallback(() => {
    if (engine.activeView.type === 'dm') setListTab('dms')
    else if (engine.activeView.type === 'server') setListTab('servers')
    else setListTab('bitchat')
    setMobileUserListOpen(false)
    setRoomInfoOpen(false)
    setMobileScreen('list')
  }, [engine.activeView.type])

  const handleMobileSelectTab = useCallback((tab: ListTab) => {
    bitchatAudio.play('click')
    setSuiteLauncherOpen(false)
    setWorkspace('chat')
    setAmailState({ section: 'inbox', composeTo: null })
    setWalletIntent(undefined)
    setRadarExpanded(false)
    setSettingsState((prev) => (prev.open ? { ...prev, open: false } : prev))
    setMobileUserListOpen(false)
    setRoomInfoOpen(false)
    setListTab(tab)
    setMobileScreen('list')
  }, [])

  const { pushToast } = engine

  const handleBackNavigation = useCallback((): boolean => {
    if (engine.pendingTrustRequest) {
      engine.cancelPendingTrust()
      return true
    }
    if (pendingDeleteDm) {
      setPendingDeleteDm(null)
      return true
    }
    if (noteEditorPeer) {
      setNoteEditorPeer(null)
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
    if (suiteLauncherOpen) {
      setSuiteLauncherOpen(false)
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
    if (workspace === 'agora') {
      closeAgora()
      return true
    }
    if (workspace === 'wallet') {
      closeWallet()
      return true
    }
    if (workspace === 'mail') {
      closeAmail()
      return true
    }
    if (activeCall && callExpanded) {
      setCallExpanded(false)
      return true
    }
    if (mobileUserListOpen) {
      setMobileUserListOpen(false)
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
    pendingDeleteDm,
    noteEditorPeer,
    qrScannerOpen,
    zapTarget,
    qrShareTarget,
    lightboxImage,
    cmdkOpen,
    suiteLauncherOpen,
    inspectedPeer,
    serverSettingsState.serverId,
    serverHubState.open,
    closeServerHub,
    installModalOpen,
    radarExpanded,
    settingsState.open,
    workspace,
    closeAgora,
    closeWallet,
    closeAmail,
    activeCall,
    callExpanded,
    mobileUserListOpen,
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

  useBackHandler(Boolean(pendingDeleteDm), () => setPendingDeleteDm(null))
  useBackHandler(Boolean(noteEditorPeer), () => setNoteEditorPeer(null))

  useEffect(() => {
    if (!noteEditorPeer) return
    engine.ensureProfilePictures([noteEditorPeer.pubkey])
    const raf = window.requestAnimationFrame(() => {
      const el = noteTextareaRef.current
      if (el) {
        el.focus()
        const end = el.value.length
        el.setSelectionRange(end, end)
      }
    })
    return () => window.cancelAnimationFrame(raf)
  }, [noteEditorPeer, engine])

  useEffect(() => {
    const pks: string[] = []
    if (engine.calls.incomingCall?.callerPubkey) {
      pks.push(engine.calls.incomingCall.callerPubkey)
    }
    if (engine.pendingTrustRequest?.pubkey) {
      pks.push(engine.pendingTrustRequest.pubkey)
    }
    if (pks.length > 0) {
      engine.ensureProfilePictures(pks)
    }
  }, [engine.calls.incomingCall?.callerPubkey, engine.pendingTrustRequest?.pubkey, engine])

  useEffect(() => {
    if (!pendingDeleteDm) return
    const raf = window.requestAnimationFrame(() => {
      deleteDmCancelBtnRef.current?.focus()
    })
    return () => window.cancelAnimationFrame(raf)
  }, [pendingDeleteDm])

  const hasActiveBackTarget =
    Boolean(engine.pendingTrustRequest) ||
    Boolean(pendingDeleteDm) ||
    Boolean(noteEditorPeer) ||
    qrScannerOpen ||
    Boolean(zapTarget) ||
    workspace !== 'chat' ||
    suiteLauncherOpen ||
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
    mobileUserListOpen ||
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
          : 'bitchat'
      : listTab

  const handleTuneChannel = useCallback(
    (channelInput: string): boolean => {
      const resolved = parseQuickTuneInput(channelInput, 'geo')
      const ok = engine.tuneGeohash(resolved?.key ?? channelInput)
      if (ok) {
        bitchatAudio.play('tune')
        setSuiteLauncherOpen(false)
        setWorkspace('chat')
        setAmailState({ section: 'inbox', composeTo: null })
        setWalletIntent(undefined)
        setListTab('bitchat')
        setMobileScreen('chat')
        setMobileUserListOpen(false)
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
      bitchatAudio.play('tune')
      setWorkspace('chat')
      setSelectedServerId(serverId)
      setAmailState({ section: 'inbox', composeTo: null })
      setWalletIntent(undefined)
      setListTab('servers')
      setMobileScreen('chat')
      setMobileUserListOpen(false)
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
      setMobileUserListOpen(false)
      setRoomInfoOpen(false)
    },
    []
  )

  const handleJoinedServer = useCallback(
    (server: ServerSummary) => {
      engine.servers.selectServer(server.id)
      closeServerHub()
      setWorkspace('chat')
      setSelectedServerId(server.id)
      setListTab('servers')
      setMobileScreen('chat')
    },
    [engine.servers, closeServerHub]
  )

  const handleOpenScanner = useCallback(() => {
    setQrScannerOpen(true)
  }, [])

  const handleOpenWallet = useCallback((intent?: WalletInitialIntent) => {
    setSuiteLauncherOpen(false)
    setZapTarget(null)
    setInspectedPeer(null)
    setAmailState({ section: 'inbox', composeTo: null })
    setRadarExpanded(false)
    setSettingsState((prev) => (prev.open ? { ...prev, open: false } : prev))
    setMobileUserListOpen(false)
    setRoomInfoOpen(false)
    setWalletIntent(intent)
    setWorkspace('wallet')
  }, [])

  // Global Agnostr Suite keyboard shortcuts (Alt+0..Alt+6 when not typing in an input)
  useEffect(() => {
    const onSuiteShortcut = (e: KeyboardEvent) => {
      if (!e.altKey || e.metaKey || e.ctrlKey || e.shiftKey) return
      const target = e.target as HTMLElement | null
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable)
      ) {
        return
      }
      const digit = e.code.startsWith('Digit') ? e.code.slice(5) : e.key
      if (digit === '0') {
        e.preventDefault()
        bitchatAudio.play('click')
        setSuiteLauncherOpen((v) => !v)
      } else if (digit === '1') {
        e.preventDefault()
        bitchatAudio.play('click')
        handleSelectAgora()
      } else if (digit === '2') {
        e.preventDefault()
        bitchatAudio.play('click')
        handleSelectBitchat()
      } else if (digit === '3') {
        e.preventDefault()
        bitchatAudio.play('click')
        handleSelectPeople()
      } else if (digit === '4') {
        e.preventDefault()
        bitchatAudio.play('click')
        handleSelectGroups()
      } else if (digit === '5') {
        e.preventDefault()
        bitchatAudio.play('click')
        handleOpenAmail('inbox')
      } else if (digit === '6') {
        e.preventDefault()
        bitchatAudio.play('click')
        handleOpenWallet({ tab: 'overview' })
      }
    }
    window.addEventListener('keydown', onSuiteShortcut)
    return () => window.removeEventListener('keydown', onSuiteShortcut)
  }, [
    handleSelectAgora,
    handleSelectBitchat,
    handleSelectPeople,
    handleSelectGroups,
    handleOpenAmail,
    handleOpenWallet,
  ])

  const handleOpenZap = useCallback((target: ZapTarget) => {
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
    return formatBitchatChannelLabel(engine.activeGeohash)
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
        bitchatAudio.play(isDm || isServerE2ee ? 'dm' : 'send')
        setWalletIntent(undefined)
        setWorkspace('chat')
        setMobileScreen('chat')
      }
      return ok
    },
    [isServer, activeServer, activeChannel, isDm, isServerE2ee, engine]
  )

  const openAgoraShareTarget = useCallback(
    (target: ParsedAgoraNoteShareTarget | ParsedAgoraProfileShareTarget) => {
      handleSelectAgora()
      setCmdkOpen(false)
      setQrScannerOpen(false)
      setQrShareTarget(null)
      setLightboxImage(null)
      engine.agora.activate()
      if (target.kind === 'agora-note') {
        engine.agora.closeProfile()
        void engine.agora.openThreadById(target.noteId, target.relays)
      } else {
        engine.agora.closeThread()
        engine.agora.openProfile(target.pubkey)
      }
      bitchatAudio.play('tune')
    },
    [engine.agora, handleSelectAgora]
  )

  // Register internal Agora link handler so trusted clicks & approved UntrustedLinkModal links
  // open directly inside the installed PWA instead of spawning an external browser tab.
  useEffect(() => {
    registerInternalAgoraLinkHandler(openAgoraShareTarget)
    return () => {
      registerInternalAgoraLinkHandler(null)
    }
  }, [openAgoraShareTarget])

  const handleResolvedShareTarget = useCallback(
    (target: ParsedShareTarget) => {
      setQrScannerOpen(false)
      if (target.kind === 'agora-note' || target.kind === 'agora-profile') {
        openAgoraShareTarget(target)
        return
      }
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
        if (workspace === 'mail') {
          void engine.amail.addContact(target.pubkey, target.nickname)
          setAmailState({
            section: 'compose',
            composeTo: { pubkey: target.pubkey, nickname: target.nickname },
          })
          bitchatAudio.play('tune')
          engine.pushToast(
            'success',
            `Ready to Agmail ${target.nickname || `${target.npub.slice(0, 12)}…`}`
          )
          return
        }
        setWorkspace('chat')
        setAmailState({ section: 'inbox', composeTo: null })
        setWalletIntent(undefined)
        setZapTarget(null)
        setRadarExpanded(false)
        setSettingsState((prev) => (prev.open ? { ...prev, open: false } : prev))
        setMobileUserListOpen(false)
        setRoomInfoOpen(false)
        setInspectedPeer(null)
        engine.openDmThread(target.pubkey, target.nickname)
        bitchatAudio.play('tune')
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
      setWorkspace('chat')
      setAmailState({ section: 'inbox', composeTo: null })
      setWalletIntent(undefined)
      setZapTarget(null)
      setRadarExpanded(false)
      setSettingsState((prev) => (prev.open ? { ...prev, open: false } : prev))
      setMobileUserListOpen(false)
      setRoomInfoOpen(false)
      void engine.servers.joinFromInvite(parsed).then((joined) => {
        if (joined) {
          bitchatAudio.play('tune')
          handleJoinedServer(joined)
        }
      })
    },
    [workspace, engine, handleJoinedServer, handleOpenWallet, openAgoraShareTarget]
  )

  // Consume cold-launch `#agora=...` / `?agora=...` / `#post=...` deep links captured on mount
  useEffect(() => {
    if (!initialPendingAgora) return
    const target = initialPendingAgora
    setInitialPendingAgora(null)
    clearLocationAgoraHash()
    openAgoraShareTarget(target)
  }, [initialPendingAgora, openAgoraShareTarget])

  // Listen on hashchange for `#agora=...` / `#post=...` deep links
  useEffect(() => {
    const consumeLocationAgora = () => {
      const pending = extractPendingAgoraFromLocation()
      if (!pending) return
      clearLocationAgoraHash()
      openAgoraShareTarget(pending)
    }
    window.addEventListener('hashchange', consumeLocationAgora)
    return () => window.removeEventListener('hashchange', consumeLocationAgora)
  }, [openAgoraShareTarget])

  // Handle OS link launches inside installed PWAs via Web App Launch Handler API
  useEffect(() => {
    if (typeof window === 'undefined') return
    const launchQueue = (window as Window & { launchQueue?: PwaLaunchQueue }).launchQueue
    if (!launchQueue || typeof launchQueue.setConsumer !== 'function') return
    launchQueue.setConsumer((launchParams) => {
      const targetUrl = launchParams?.targetURL
      if (!targetUrl) return
      const agoraTarget = parseAgoraShareUrl(targetUrl)
      if (agoraTarget) {
        clearLocationAgoraHash()
        openAgoraShareTarget(agoraTarget)
        return
      }
      const shareTarget = parseShareTarget(targetUrl)
      if (shareTarget) {
        handleResolvedShareTarget(shareTarget)
      }
    })
  }, [openAgoraShareTarget, handleResolvedShareTarget])

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
    const onBitchatHash = () => {
      if (isAgoraLocationHash(window.location.hash)) {
        handleSelectAgora()
        return
      }
      const key = parseBitchatChannelHash(window.location.hash)
      if (!key) return
      setSuiteLauncherOpen(false)
      setWorkspace('chat')
      setAmailState({ section: 'inbox', composeTo: null })
      setWalletIntent(undefined)
      setRadarExpanded(false)
      setSettingsState((prev) => (prev.open ? { ...prev, open: false } : prev))
      setMobileUserListOpen(false)
      setRoomInfoOpen(false)
      setListTab('bitchat')
      setMobileScreen('chat')
    }
    window.addEventListener('hashchange', onBitchatHash)
    return () => window.removeEventListener('hashchange', onBitchatHash)
  }, [handleSelectAgora])

  const handleLeftServer = useCallback(() => {
    setServerSettingsState({ serverId: null, tab: 'overview' })
    setMobileUserListOpen(false)
    setRoomInfoOpen(false)
    setWorkspace('chat')
    engine.tuneGeohash(engine.activeGeohash)
    setListTab('bitchat')
  }, [engine])

  const handleOpenDm = useCallback(
    (pubkey: string, nickname?: string) => {
      engine.openDmThread(pubkey, nickname)
      bitchatAudio.play('click')
      setSuiteLauncherOpen(false)
      setWorkspace('chat')
      setAmailState({ section: 'inbox', composeTo: null })
      setWalletIntent(undefined)
      setInspectedPeer(null)
      setMobileUserListOpen(false)
      setRoomInfoOpen(false)
      setListTab('dms')
      setMobileScreen('chat')
    },
    [engine]
  )

  const handleCloseDmThread = useCallback(
    (pubkey: string) => {
      const targetPk = pubkey.toLowerCase()
      const thread = engine.dmThreads.find((t) => t.peerPubkey.toLowerCase() === targetPk)
      const livePeer = engine.getPeerByPubkey(pubkey)
      const trustedEntry = engine.trustedPubkeys.find((t) => t.pubkey.toLowerCase() === targetPk)
      const displayName =
        thread?.peerDisplayHandle ||
        livePeer?.displayHandle ||
        trustedEntry?.label?.trim() ||
        shortPubkey(pubkey, 8, 6)
      setPendingDeleteDm({
        pubkey,
        displayName,
        isTrusted: engine.isExplicitlyTrusted(pubkey),
      })
    },
    [engine]
  )

  const handleConfirmDeleteDm = useCallback(() => {
    if (!pendingDeleteDm) return
    const { pubkey } = pendingDeleteDm
    const targetPk = pubkey.toLowerCase()
    const wasActiveDm =
      engine.activeView.type === 'dm' &&
      engine.activeView.peerPubkey.toLowerCase() === targetPk
    setPendingDeleteDm(null)
    bitchatAudio.play('click')
    engine.closeDmThread(pubkey)
    if (wasActiveDm) {
      setMobileUserListOpen(false)
      setRoomInfoOpen(false)
      if (isMobileViewport) {
        setListTab('dms')
        setMobileScreen('list')
      }
    }
  }, [pendingDeleteDm, engine, isMobileViewport])

  const handleOpenPeerNote = useCallback(
    (peer: { pubkey: string; nickname: string; displayHandle: string }) => {
      setNoteDraft(engine.peerNotes[peer.pubkey.toLowerCase()] ?? '')
      setNoteEditorPeer(peer)
    },
    [engine.peerNotes]
  )

  const handleSavePeerNote = useCallback(() => {
    if (!noteEditorPeer) return
    engine.setPeerNote(noteEditorPeer.pubkey, noteDraft)
    bitchatAudio.play('click')
    setNoteEditorPeer(null)
  }, [noteEditorPeer, noteDraft, engine])

  const handleClearPeerNote = useCallback(() => {
    if (!noteEditorPeer) return
    engine.setPeerNote(noteEditorPeer.pubkey, '')
    setNoteDraft('')
    bitchatAudio.play('click')
    setNoteEditorPeer(null)
  }, [noteEditorPeer, engine])

  const handleMentionPeer = useCallback((handle: string) => {
    const clean = handle.startsWith('@') ? handle : `@${handle}`
    setExternalDraftToken({ id: Date.now(), text: `${clean} ` })
    setInspectedPeer(null)
    setMobileUserListOpen(false)
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
    setSuiteLauncherOpen(false)
    setSettingsState((prev) => (prev.open ? { ...prev, open: false } : prev))
    setRadarExpanded(true)
    setMobileUserListOpen(false)
    setRoomInfoOpen(false)
    bitchatAudio.play('click')
  }, [])

  const handleOpenInstall = useCallback(() => {
    bitchatAudio.play('click')
    if (pwa.canPromptInstall) {
      void pwa.promptInstall().then((outcome) => {
        if (outcome === 'accepted') {
          bitchatAudio.play('tune')
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
    bitchatAudio.setEnabled(next)
    if (next) {
      bitchatAudio.play('tune', true)
    }
  }, [engine])

  const handleLocateMe = useCallback(async () => {
    const found = await engine.locateMe()
    if (found) {
      bitchatAudio.play('tune')
      setWorkspace('chat')
      setListTab('bitchat')
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
      bitchatAudio.play('click')
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
      bitchatAudio.play('click')
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
            filename: `agnostr-group-${slug}-${stamp}.json`,
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
            `Exported ${new Date().toISOString()} (${activeServer.kind === 'nip29' ? 'Hosted Group' : activeServer.encrypted ? 'Private Encrypted Group' : 'Public Group'})`,
            '',
            ...engine.servers.messages.map((m) => {
              const ts = new Date(m.createdAt * 1000).toISOString()
              const voice = m.voiceMemo ? ` [Voice memo: ${m.voiceMemo.url}]` : ''
              const img = m.imageAttachment ? ` [Image: ${m.imageAttachment.url}]` : ''
              return `- **${m.displayHandle}** (${ts}): ${m.content}${voice}${img}`
            }),
          ]
          file = {
            filename: `agnostr-group-${slug}-${stamp}.md`,
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

  const engineZaps = engine.zaps
  const engineWallet = engine.wallet
  const engineAgora = engine.agora
  const zapTargetEventId = zapTarget?.eventId
  const zapModalZaps = useMemo(
    () => ({
      ...engineZaps,
      sendNutzap: async (params: Parameters<typeof engineZaps.sendNutzap>[0]) => {
        const res = await engineZaps.sendNutzap(params)
        if (params.target.eventId) {
          engineAgora.recordOptimisticZap(params.target.eventId, res.amountSats)
        }
        return res
      },
    }),
    [engineZaps, engineAgora]
  )

  const zapModalWallet = useMemo(
    () => ({
      ...engineWallet,
      payBolt11Invoice: async (
        invoice: string,
        opts?: Parameters<typeof engineWallet.payBolt11Invoice>[1]
      ) => {
        const res = await engineWallet.payBolt11Invoice(invoice, opts)
        if (opts?.txType === 'zap_out' && zapTargetEventId) {
          engineAgora.recordOptimisticZap(zapTargetEventId, res.amountSats)
        }
        return res
      },
    }),
    [engineWallet, engineAgora, zapTargetEventId]
  )

  const workspaceLoadingFallback = (
    <div className="ag-workspace-stage ag-workspace-loading" role="status" aria-live="polite">
      <Loader2 size={20} className="ag-spin" aria-hidden="true" />
    </div>
  )

  return (
    <ContextMenuProvider>
    <div
      className={`ag-app ag-shell ${panicFlash ? 'ag-panic-active' : ''}`}
      data-workspace={workspace}
      data-mobile-screen={mobileScreen}
      data-right-drawer={mobileUserListOpen ? 'open' : 'closed'}
    >
      <div
        ref={shellBodyRef}
        className={`ag-shell-body ${isSwipingLeft ? 'is-swiping-left' : ''} ${isSwipingRight ? 'is-swiping-right' : ''}`}
        style={
          {
            '--ag-left-drawer-p': String(leftProgress),
            '--ag-right-drawer-p': String(rightProgress),
          } as CSSProperties
        }
      >
        {/* Far-Left Desktop Agnostr Suite & Groups Rail (68px, always visible >= 868px) */}
        {!isMobileViewport && (
          <AppRail
            engine={engine}
            workspace={workspace}
            listTab={listTab}
            selectedServerId={selectedServerId}
            mapActive={radarExpanded}
            settingsActive={settingsState.open}
            pwa={pwa}
            agoraUnread={engine.agora.unreadNotificationCount}
            suiteLauncherOpen={suiteLauncherOpen}
            onToggleSuiteLauncher={handleToggleSuiteLauncher}
            onSelectWorkspace={handleSelectWorkspace}
            onSelectChatTab={handleSelectChatTab}
            onSelectGroups={handleSelectGroups}
            onSelectServer={handleSelectServer}
            onOpenServerHub={handleOpenServerHub}
            onOpenServerSettings={handleOpenServerSettings}
            onOpenMap={handleExpandRadar}
            onOpenSearch={handleOpenCommandPalette}
            onOpenSettings={handleOpenSettings}
            onOpenInstall={handleOpenInstall}
            onPlaySound={playSound}
          />
        )}

        {workspace === 'agora' ? (
          <div className="ag-workspace-stage">
            <Suspense fallback={workspaceLoadingFallback}>
              <AgoraView
                engine={engine}
                isMobileViewport={isMobileViewport}
                initialComposeOpen={agoraInitialCompose}
                onConsumedInitialCompose={() => setAgoraInitialCompose(false)}
                onOpenDm={handleOpenDm}
                onOpenAmailCompose={handleOpenAmailCompose}
                onOpenZap={handleOpenZap}
                onOpenLightbox={setLightboxImage}
                onPlaySound={playSound}
              />
            </Suspense>
          </div>
        ) : workspace === 'mail' ? (
          <div className="ag-workspace-stage">
            <Suspense fallback={workspaceLoadingFallback}>
              <AmailView
                open={true}
                embedded={true}
                inShell={isMobileViewport}
                onClose={closeAmail}
                engine={engine}
                initialSection={amailState.section}
                initialComposeTo={amailState.composeTo}
                onOpenScanner={handleOpenScanner}
                onOpenLightbox={setLightboxImage}
                onPlaySound={playSound}
              />
            </Suspense>
          </div>
        ) : workspace === 'wallet' ? (
          <div className="ag-workspace-stage">
            <Suspense fallback={workspaceLoadingFallback}>
              <WalletModal
                open={true}
                embedded={true}
                onClose={closeWallet}
                wallet={engine.wallet}
                zaps={engine.zaps}
                initialIntent={walletIntent}
                onOpenScanner={handleOpenScanner}
                onSendToChat={handleSendCashuToChat}
                activeChatLabel={activeChatLabel}
              />
            </Suspense>
          </div>
        ) : (
          <>
            {/* Dimmed Interactive Scrim behind Mobile Left Slide-Over Sidebar */}
            <div
              className={`ag-drawer-scrim ${mobileScreen === 'list' ? 'active' : ''} ${isSwipingLeft ? 'is-swiping' : ''}`}
              onClick={() => setMobileScreen('chat')}
              aria-hidden="true"
            />

            {/* Left Pane (Desktop 256px) / Interactive Slide-Over Sidebar Drawer (Mobile <868px) */}
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
                isMobileViewport={isMobileViewport}
                selectedServerId={selectedServerId}
                onSelectServer={handleSelectServer}
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
                onOpenOwnAgoraProfile={() => {
                  handleSelectWorkspace('agora')
                  engine.agora.openProfile(engine.identity.masterPubkey)
                }}
                amailOpen={false}
                onOpenAmail={handleOpenAmail}
                onOpenAmailCompose={handleOpenAmailCompose}
                onOpenWallet={handleOpenWallet}
                onOpenZap={handleOpenZap}
                onLocateMe={() => void handleLocateMe()}
                onFocusActiveCall={() => {
                  setMobileScreen('chat')
                  setCallExpanded(true)
                }}
                onInspectPeer={setInspectedPeer}
                onEditPeerNote={handleOpenPeerNote}
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
                userListOpen={isMobileViewport ? mobileUserListOpen : !userListCollapsed}
                roomInfoOpen={roomInfoOpen}
                searchOpen={searchOpen}
                hasOtherUnread={totalUnreadBadge > 0}
                onMobileBack={handleMobileBack}
                onToggleSidebar={() => setSidebarCollapsed((v) => !v)}
                onToggleUserList={handleToggleUserList}
                onOpenRoomInfo={handleOpenRoomInfo}
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
              {(activeCall || engine.transcription.endedCallTranscript) && (
                <Suspense fallback={null}>
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
                </Suspense>
              )}

              {/* Live Bitchat Group Call Join Banner (shown when peers are in this room's call) */}
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
                          : `Join ${formatBitchatChannelLabel(engine.activeGeohash)} voice call`
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
                        title={`Join ${formatBitchatChannelLabel(engine.activeGeohash)} video call`}
                        aria-label={`Join ${formatBitchatChannelLabel(engine.activeGeohash)} video call`}
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
                    searchMatchIds.length
                      ? (i - 1 + searchMatchIds.length) % searchMatchIds.length
                      : 0
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
                onSent={(isEncrypted) => bitchatAudio.play(isEncrypted ? 'dm' : 'send')}
              />
            </main>

            {/* Dimmed Interactive Scrim behind Mobile Right Slide-Out User List Tray */}
            <div
              className={`ag-right-drawer-scrim ${mobileUserListOpen ? 'active' : ''} ${isSwipingRight ? 'is-swiping' : ''}`}
              onClick={() => setMobileUserListOpen(false)}
              aria-hidden="true"
            />

            {/* Right Pane (Desktop User List) / Interactive Swipe-Left Slide-Out Tray (Mobile <868px) */}
            <div
              className={`ag-users-col ${mobileUserListOpen ? 'open' : ''} ${isSwipingRight ? 'is-swiping' : ''}`}
              aria-hidden={
                isMobileViewport && !mobileUserListOpen && !isSwipingRight ? true : undefined
              }
            >
              <UserListPane
                engine={engine}
                collapsed={userListCollapsed}
                onCloseMobile={() => setMobileUserListOpen(false)}
                onInspectPeer={setInspectedPeer}
                onStartDm={handleOpenDm}
                onMentionPeer={handleMentionPeer}
                onEditPeerNote={handleOpenPeerNote}
                onOpenZap={handleOpenZap}
                onOpenAmailCompose={({ pubkey, nickname }) =>
                  handleOpenAmailCompose(pubkey, nickname)
                }
                onPlaySound={playSound}
              />
            </div>
          </>
        )}

        {/* Keep floating active call pill accessible when viewing Agora, Agmail, or Agwallet */}
        {workspace !== 'chat' && (activeCall || engine.transcription.endedCallTranscript) && (
          <Suspense fallback={null}>
            <CallStage
              calls={engine.calls}
              engine={engine}
              expanded={callExpanded}
              compactFloating={!callExpanded}
              onToggleExpand={() => setCallExpanded((v) => !v)}
              onInspectPeer={setInspectedPeer}
              onOpenDm={handleOpenDm}
              onReturnToCall={handleReturnToActiveCall}
              onPlaySound={playSound}
            />
          </Suspense>
        )}

        {/* Clean Chat / Room / Server Info Slide-Over Sheet (Lazy loaded on open) */}
        {roomInfoOpen && (
          <Suspense fallback={null}>
            <RoomInfoSheet
              open={roomInfoOpen}
              swipeProgress={undefined}
              isSwiping={false}
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
          </Suspense>
        )}

        {/* Mobile In-Shell Map & Settings Overlays (Sit above Always-Present 5-Tab Bottom Bar) */}
        {isMobileViewport && radarExpanded && (
          <Suspense fallback={null}>
            <ExpandedRadarModal
              open={radarExpanded}
              inShell={true}
              engine={engine}
              onClose={() => setRadarExpanded(false)}
              onTuneChannel={handleTuneChannel}
              onPlaySound={playSound}
            />
          </Suspense>
        )}
        {isMobileViewport && settingsState.open && (
          <Suspense fallback={null}>
            <SettingsModal
              open={settingsState.open}
              inShell={true}
              engine={engine}
              pwa={pwa}
              initialTab={settingsState.tab}
              onClose={() => setSettingsState((prev) => ({ ...prev, open: false }))}
              onOpenInstall={handleOpenInstall}
              onShowQr={setQrShareTarget}
              onOpenScanner={handleOpenScanner}
              onPlaySound={playSound}
            />
          </Suspense>
        )}
      </div>

      {/* Always-Present 5-Tab Native Mobile Bottom Tab Bar (< 868px, Flex Flow) */}
      <MobileTabBar
        workspace={workspace}
        activeTab={mobileNavActiveTab}
        agoraUnread={engine.agora.unreadNotificationCount}
        bitchatUnread={engine.totalGeoUnread}
        bitchatMentions={engine.totalGeoMentions}
        dmUnread={engine.totalDmUnread}
        serverUnread={engine.servers.totalServerUnread}
        serverMentions={engine.servers.totalServerMentions}
        mailUnread={engine.amail.unreadInboxCount}
        suiteOpen={suiteLauncherOpen}
        mapActive={radarExpanded}
        settingsActive={settingsState.open}
        onSelectAgora={() => {
          bitchatAudio.play('click')
          handleSelectAgora()
        }}
        onSelectTab={handleMobileSelectTab}
        onToggleSuite={() => {
          bitchatAudio.play('click')
          handleToggleSuiteLauncher()
        }}
      />

      {/* Unified Agnostr Suite Launcher (Desktop glass popover / Mobile glass bottom sheet) */}
      <SuiteLauncher
        open={suiteLauncherOpen}
        variant={isMobileViewport ? 'sheet' : 'popover'}
        workspace={workspace}
        listTab={listTab}
        mapActive={radarExpanded}
        settingsActive={settingsState.open}
        agoraUnread={engine.agora.unreadNotificationCount}
        bitchatUnread={engine.totalGeoUnread}
        bitchatMentions={engine.totalGeoMentions}
        dmUnread={engine.totalDmUnread}
        serverUnread={engine.servers.totalServerUnread}
        serverMentions={engine.servers.totalServerMentions}
        mailUnread={engine.amail.unreadInboxCount}
        walletSats={engine.wallet.totalBalanceSats}
        onClose={() => setSuiteLauncherOpen(false)}
        onSelectAgora={() => handleSelectAgora()}
        onSelectBitchat={handleSelectBitchat}
        onSelectPeople={handleSelectPeople}
        onSelectGroups={handleSelectGroups}
        onSelectMail={() => handleOpenAmail('inbox')}
        onSelectWallet={() => handleOpenWallet({ tab: 'overview' })}
        onOpenMap={handleExpandRadar}
        onOpenSearch={handleOpenCommandPalette}
        onOpenSettings={() => handleOpenSettings()}
        onPlaySound={playSound}
      />

      {/* Desktop Unified Calm Settings Modal (Lazy loaded on open) */}
      {!isMobileViewport && settingsState.open && (
        <Suspense fallback={null}>
          <SettingsModal
            open={settingsState.open}
            inShell={false}
            engine={engine}
            pwa={pwa}
            initialTab={settingsState.tab}
            onClose={() => setSettingsState((prev) => ({ ...prev, open: false }))}
            onOpenInstall={handleOpenInstall}
            onShowQr={setQrShareTarget}
            onOpenScanner={handleOpenScanner}
            onPlaySound={playSound}
          />
        </Suspense>
      )}

      {/* Peer Profile & Moderation Modal */}
      {inspectedPeer && (
        <Suspense fallback={null}>
          <PeerInspectorModal
            peer={inspectedPeer}
            engine={engine}
            onClose={() => setInspectedPeer(null)}
            onStartDm={handleOpenDm}
            onMentionPeer={handleMentionPeer}
            onOpenZap={handleOpenZap}
            onOpenAgoraProfile={(pubkey) => {
              setInspectedPeer(null)
              handleSelectWorkspace('agora')
              engine.agora.closeThread()
              engine.agora.openProfile(pubkey)
            }}
          />
        </Suspense>
      )}

      {/* Desktop Full-Screen Expandable Geohash Map Modal */}
      {!isMobileViewport && radarExpanded && (
        <Suspense fallback={null}>
          <ExpandedRadarModal
            open={radarExpanded}
            inShell={false}
            engine={engine}
            onClose={() => setRadarExpanded(false)}
            onTuneChannel={handleTuneChannel}
            onPlaySound={playSound}
          />
        </Suspense>
      )}

      {/* PWA Install Guide / Native Install Modal */}
      {installModalOpen && (
        <Suspense fallback={null}>
          <PwaInstallModal
            open={installModalOpen}
            pwa={pwa}
            onClose={() => setInstallModalOpen(false)}
            onPlaySound={playSound}
          />
        </Suspense>
      )}

      {/* Create / Join / Explore Servers Hub Modal */}
      {serverHubState.open && (
        <Suspense fallback={null}>
          <ServerHubModal
            open={serverHubState.open}
            initialTab={serverHubState.tab}
            servers={engine.servers}
            engine={engine}
            onClose={closeServerHub}
            onJoinedServer={handleJoinedServer}
            onShowQr={setQrShareTarget}
            onOpenScanner={handleOpenScanner}
            onPlaySound={playSound}
          />
        </Suspense>
      )}

      {/* Server Settings, Invite & Moderation Modal */}
      {settingsServer && (
        <Suspense fallback={null}>
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
        </Suspense>
      )}

      {/* Quick Switcher & Command Palette (Cmd+K) */}
      {cmdkOpen && (
        <Suspense fallback={null}>
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
            onOpenRoomInfo={handleOpenRoomInfo}
            onOpenSettings={handleOpenSettings}
            onOpenAgora={handleSelectAgora}
            onSelectBitchat={handleSelectBitchat}
            onSelectPeople={handleSelectPeople}
            onSelectGroups={handleSelectGroups}
            onOpenAmail={handleOpenAmail}
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
        </Suspense>
      )}

      {/* Fullscreen Image Lightbox Viewer */}
      {lightboxImage && (
        <Suspense fallback={null}>
          <ImageLightboxModal
            payload={lightboxImage}
            onClose={() => setLightboxImage(null)}
          />
        </Suspense>
      )}

      {/* Shareable QR Code Modal (DMs & Community Invites) */}
      {qrShareTarget && (
        <Suspense fallback={null}>
          <QrShareModal target={qrShareTarget} onClose={() => setQrShareTarget(null)} />
        </Suspense>
      )}

      {/* Camera / Image QR Code Scanner Modal (DMs & Community Invites) */}
      {qrScannerOpen && (
        <Suspense fallback={null}>
          <QrScannerModal
            open={qrScannerOpen}
            onClose={() => setQrScannerOpen(false)}
            onResolved={handleResolvedShareTarget}
          />
        </Suspense>
      )}

      {/* Incoming Encrypted P2P Call Offer Takeover / Card */}
      {engine.calls.incomingCall && (
        <IncomingCallBanner
          incoming={engine.calls.incomingCall}
          callerAvatarUrl={engine.getProfilePicture(engine.calls.incomingCall.callerPubkey)}
          mode="dm"
          isRinging={engine.notifications.isRinging}
          isRingMuted={engine.notifications.isRingMuted}
          isStandalonePwa={pwa.isInstalled}
          onMuteRing={engine.notifications.muteCurrentRing}
          onAcceptAudio={() => {
            const offer = engine.calls.incomingCall
            if (offer) {
              setWorkspace('chat')
              engine.openDmThread(offer.callerPubkey, offer.callerNickname)
              setListTab('dms')
              setMobileScreen('chat')
            }
            void engine.calls.acceptIncomingCall('audio')
          }}
          onAcceptVideo={() => {
            const offer = engine.calls.incomingCall
            if (offer) {
              setWorkspace('chat')
              engine.openDmThread(offer.callerPubkey, offer.callerNickname)
              setListTab('dms')
              setMobileScreen('chat')
            }
            void engine.calls.acceptIncomingCall('video')
          }}
          onDecline={() => {
            bitchatAudio.play('call-leave')
            engine.calls.declineIncomingCall()
          }}
        />
      )}

      {/* Lightning Zap Modal */}
      {zapTarget && (
        <Suspense fallback={null}>
          <ZapModal
            target={zapTarget}
            onClose={() => setZapTarget(null)}
            wallet={zapModalWallet}
            zaps={zapModalZaps}
            onOpenWallet={handleOpenWallet}
          />
        </Suspense>
      )}

      {/* Global Trust Peer Security Warning Confirmation Dialog */}
      <TrustConfirmModal
        request={engine.pendingTrustRequest}
        avatarUrl={
          engine.pendingTrustRequest
            ? engine.getProfilePicture(engine.pendingTrustRequest.pubkey)
            : undefined
        }
        onConfirm={engine.confirmPendingTrust}
        onCancel={engine.cancelPendingTrust}
      />

      {/* Global Untrusted External Link Confirmation Warning Modal */}
      <UntrustedLinkModal />

      {/* Universal Delete Private Chat Confirmation Modal */}
      {pendingDeleteDm &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            className="ag-inline-dialog-backdrop"
            onClick={() => setPendingDeleteDm(null)}
          >
            <div
              className="ag-inline-dialog"
              role="alertdialog"
              aria-modal="true"
              aria-labelledby="ag-delete-dm-title"
              aria-describedby="ag-delete-dm-desc"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="ag-inline-dialog-head">
                <div className="ag-inline-dialog-emblem danger" aria-hidden="true">
                  <Trash2 size={18} />
                </div>
                <div className="ag-inline-dialog-title-wrap">
                  <h2 id="ag-delete-dm-title" className="ag-inline-dialog-title">
                    Delete private chat?
                  </h2>
                </div>
                <button
                  type="button"
                  className="ag-circle-btn ag-inline-dialog-close"
                  onClick={() => setPendingDeleteDm(null)}
                  aria-label="Cancel"
                >
                  <X size={16} />
                </button>
              </div>

              <p id="ag-delete-dm-desc" className="ag-inline-dialog-body">
                Remove your conversation with <strong>{pendingDeleteDm.displayName}</strong> from
                this device?
                {pendingDeleteDm.isTrusted ? ' They will remain in Trusted Friends.' : ''}
              </p>

              <div className="ag-inline-dialog-actions">
                <button
                  ref={deleteDmCancelBtnRef}
                  type="button"
                  className="ag-inline-dialog-btn secondary"
                  onClick={() => setPendingDeleteDm(null)}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="ag-inline-dialog-btn danger"
                  onClick={handleConfirmDeleteDm}
                >
                  Delete Chat
                </button>
              </div>
            </div>
          </div>,
          document.body
        )}

      {/* Sleek Borderless People Private Note Editor Modal */}
      {noteEditorPeer &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            className="ag-inline-dialog-backdrop"
            onClick={() => setNoteEditorPeer(null)}
          >
            <div
              className="ag-inline-dialog ag-note-dialog"
              role="dialog"
              aria-modal="true"
              aria-labelledby="ag-peer-note-title"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="ag-inline-dialog-head">
                <AvatarImg
                  pubkey={noteEditorPeer.pubkey}
                  pictureUrl={engine.getProfilePicture(noteEditorPeer.pubkey)}
                  alt=""
                  className="ag-note-dialog-avatar"
                />
                <div className="ag-inline-dialog-title-wrap">
                  <h2 id="ag-peer-note-title" className="ag-inline-dialog-title truncate">
                    {noteEditorPeer.displayHandle}
                  </h2>
                  <span className="ag-note-dialog-sub">Private note</span>
                </div>
                <button
                  type="button"
                  className="ag-circle-btn ag-inline-dialog-close"
                  onClick={() => setNoteEditorPeer(null)}
                  aria-label="Close"
                >
                  <X size={16} />
                </button>
              </div>

              <textarea
                ref={noteTextareaRef}
                rows={3}
                maxLength={400}
                className="ag-note-modal-textarea"
                placeholder="Private note…"
                aria-label={`Private note for ${noteEditorPeer.displayHandle}`}
                value={noteDraft}
                onChange={(e) => setNoteDraft(e.target.value)}
                onKeyDown={(e) => {
                  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                    e.preventDefault()
                    handleSavePeerNote()
                  }
                }}
              />

              <div className="ag-note-dialog-footer">
                <div className="ag-note-dialog-left">
                  <span className="ag-note-dialog-count tabular">{noteDraft.length}/400</span>
                  {(noteDraft.trim().length > 0 ||
                    Boolean(engine.peerNotes[noteEditorPeer.pubkey.toLowerCase()])) && (
                    <button
                      type="button"
                      className="ag-note-dialog-clear"
                      onClick={handleClearPeerNote}
                    >
                      Clear
                    </button>
                  )}
                </div>
                <div className="ag-inline-dialog-actions">
                  <button
                    type="button"
                    className="ag-inline-dialog-btn secondary"
                    onClick={() => setNoteEditorPeer(null)}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="ag-inline-dialog-btn primary"
                    onClick={handleSavePeerNote}
                  >
                    Save
                  </button>
                </div>
              </div>
            </div>
          </div>,
          document.body
        )}

      {/* Subtle On-Device Safety Filter Loading / Ready Floating Popup */}
      {cfPopupState && (
        <div
          className={`ag-cf-status-popup is-${cfPopupState}`}
          role="status"
          aria-live="polite"
        >
          {cfPopupState === 'loading' ? (
            <Loader2 size={14} className="ag-cf-popup-icon ag-spin" aria-hidden="true" />
          ) : cfPopupState === 'ready' ? (
            <ShieldCheck size={14} className="ag-cf-popup-icon" aria-hidden="true" />
          ) : (
            <ShieldAlert size={14} className="ag-cf-popup-icon" aria-hidden="true" />
          )}

          <span className="ag-cf-popup-text truncate">
            {cfPopupState === 'loading'
              ? cfPct > 0 && cfPct < 100
                ? `Loading safety filter · ${cfPct}%`
                : 'Loading safety filter…'
              : cfPopupState === 'ready'
                ? 'Safety filter ready'
                : 'Safety filter unavailable'}
          </span>

          {cfPopupState === 'ready' && cfRuntimeLabel && (
            <span className="ag-cf-popup-tag">{cfRuntimeLabel}</span>
          )}

          {cfPopupState === 'error' && (
            <button
              type="button"
              className="ag-cf-popup-retry"
              onClick={() => {
                setCfPopupDismissed(false)
                void engine.contentFilter.preloadModel({ silent: true })
              }}
            >
              Retry
            </button>
          )}

          <button
            type="button"
            className="ag-cf-popup-dismiss"
            onClick={() => {
              setCfPopupDismissed(true)
              setCfReadyVisible(false)
            }}
            aria-label="Dismiss safety filter notification"
            title="Dismiss"
          >
            <X size={13} />
          </button>
        </div>
      )}

      {/* Non-Blocking Notifications */}
      <ToastStack toasts={engine.toasts} onDismiss={engine.dismissToast} />
    </div>
    </ContextMenuProvider>
  )
}

export default App
