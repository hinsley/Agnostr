import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import {
  AlertCircle,
  ArrowDown,
  Columns2,
  Crosshair,
  Hash,
  Languages,
  Loader2,
  Lock,
  Map as MapIcon,
  PanelRightClose,
  PanelRightOpen,
  Radio,
  Server,
  ShieldCheck,
  UserPlus,
  X,
} from 'lucide-react'
import type { AgnostrEngine, GeoMessage, PeerInfo } from '../types/protocol'
import type { ServerMessage } from '../types/servers'
import {
  TRANSLATION_LANGUAGE_OPTIONS,
  TRANSLATOR_MODELS,
  translationCacheKey,
  type OutgoingOriginalEntry,
} from '../types/translator'
import { detectRoomDominantLanguage, isNonTranslatableText } from '../lib/languageDetect'
import type { ZapTarget } from '../types/wallet'
import type { ServerSettingsTab } from './ServerSettingsModal'
import type { LightboxImagePayload } from './ImageLightboxModal'
import { MessageItem } from './MessageItem'
import { doesContentMentionUser } from '../lib/bitchatProtocol'
import { formatRadioChannelLabel, isTopicChannel } from '../lib/radioChannel'
import { isStuckMediaPlaceholder } from '../lib/storage'
import { identiconDataUrl, formatHandle } from '../utils/identicon'

function extractCleanMessageText(msg: GeoMessage): string {
  let text = msg.content.trim()
  if (!text) return ''
  for (const rawUrl of [msg.voiceMemo?.url, msg.imageAttachment?.url]) {
    const target = rawUrl?.trim()
    if (!target) continue
    if (text === target) return ''
    text = text.split(target).join('')
  }
  return text.replace(/\n{3,}/g, '\n\n').trim()
}

function getServerMonogram(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return 'SV'
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase()
  return `${words[0][0] ?? ''}${words[1][0] ?? ''}`.toUpperCase()
}

function buildFallbackPeer(
  pubkey: string,
  nickname: string,
  activeGeohash: string,
  isSelf: boolean,
  isBlocked: boolean,
  isTrusted: boolean
): PeerInfo {
  const h = formatHandle(nickname, pubkey)
  return {
    pubkey,
    npub: pubkey,
    nickname: h.base,
    displayHandle: h.full,
    lastSeenAt: Math.floor(Date.now() / 1000),
    isOnline: true,
    isSelf,
    isTeleported: false,
    isMeshBridge: false,
    isBlocked,
    isTrusted,
    messageCount: 1,
    channels: [activeGeohash],
  }
}

function dateDayKey(unixSec: number): string {
  const d = new Date(unixSec * 1000)
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
}

function formatDateHeading(unixSec: number): string {
  const d = new Date(unixSec * 1000)
  const now = new Date()
  const todayKey = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}`
  const yest = new Date(now.getTime() - 86400_000)
  const yestKey = `${yest.getFullYear()}-${yest.getMonth()}-${yest.getDate()}`
  const key = dateDayKey(unixSec)
  if (key === todayKey) return 'Today'
  if (key === yestKey) return 'Yesterday'
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
}

export interface MessageStreamProps {
  engine: AgnostrEngine
  searchQuery: string
  activeSearchMessageId: string | null
  onReply: (message: GeoMessage) => void
  onReact: (message: GeoMessage, emoji: string) => void
  onReplyServer?: (message: ServerMessage) => void
  onReactServer?: (message: ServerMessage, emoji: string) => void
  onInspectPeer: (peer: PeerInfo) => void
  onStartDm?: (pubkey: string, nickname?: string) => void
  onMentionPeer?: (handle: string) => void
  onTuneChannel: (geohash: string) => void
  onClickMention: (mention: string) => void
  onLocateMe: () => void
  onExpandRadar: () => void
  onOpenServerSettings?: (serverId: string, initialTab?: ServerSettingsTab) => void
  onOpenLightbox: (payload: LightboxImagePayload) => void
  onOpenZap?: (target: ZapTarget) => void
  onClaimCashuToken?: (token: string) => void
}

const INITIAL_RENDER_LIMIT = 80
const LOAD_EARLIER_STEP = 60
const MAX_ACTIVE_BACKFILL = 2
const DEFAULT_VIEWPORT_TAIL = 20

interface MessageTranslationSpec {
  mode: 'skip' | 'own-original' | 'translate'
  textToTranslate?: string
  sourceLang?: string
  cacheKey?: string
  badge?: string
}

function resolveMessageTranslationSpec(
  msg: GeoMessage,
  outgoingOrig: OutgoingOriginalEntry | undefined,
  myLanguage: string,
  explicitSourceLang: string | undefined
): MessageTranslationSpec {
  if (msg.isSystem) return { mode: 'skip' }

  if (outgoingOrig) {
    const badge = `Sent as ${outgoingOrig.targetLang}`
    if (outgoingOrig.sourceLang.trim().toLowerCase() === myLanguage.trim().toLowerCase()) {
      return { mode: 'own-original', badge }
    }
    const origText = outgoingOrig.originalText.trim()
    if (!origText || isNonTranslatableText(origText)) {
      return { mode: 'skip' }
    }
    const origSource = outgoingOrig.sourceLang.trim()
    const normalizedSource =
      origSource && origSource.toLowerCase() !== 'auto' ? origSource : undefined
    return {
      mode: 'translate',
      textToTranslate: origText,
      sourceLang: normalizedSource,
      cacheKey: translationCacheKey(msg.id, myLanguage, normalizedSource),
      badge,
    }
  }

  const cleanOriginal = extractCleanMessageText(msg)
  if (!cleanOriginal || isNonTranslatableText(cleanOriginal)) {
    return { mode: 'skip' }
  }

  return {
    mode: 'translate',
    textToTranslate: cleanOriginal,
    sourceLang: explicitSourceLang,
    cacheKey: translationCacheKey(msg.id, myLanguage, explicitSourceLang),
  }
}

export const MessageStream: React.FC<MessageStreamProps> = ({
  engine,
  searchQuery,
  activeSearchMessageId,
  onReply,
  onReact,
  onReplyServer,
  onReactServer,
  onInspectPeer,
  onStartDm,
  onMentionPeer,
  onTuneChannel,
  onClickMention,
  onLocateMe,
  onExpandRadar,
  onOpenServerSettings,
  onOpenLightbox,
  onOpenZap,
  onClaimCashuToken,
}) => {
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const stickToBottomRef = useRef(true)
  const lastClientHeightRef = useRef(0)
  const streamSwitchedAtRef = useRef(0)
  const lastAutoExpandAtRef = useRef(0)
  const pendingScrollAnchorRef = useRef<{ prevScrollHeight: number; prevScrollTop: number } | null>(
    null
  )
  const pendingJumpIdRef = useRef<string | null>(null)
  const visibleCountRef = useRef(0)
  const translatorBaselineRef = useRef<{
    key: string
    existingIds: Set<string>
    baselineMaxCreatedAt: number
    startedEmpty: boolean
  }>({
    key: '',
    existingIds: new Set(),
    baselineMaxCreatedAt: 0,
    startedEmpty: true,
  })
  const [renderLimit, setRenderLimit] = useState<number>(INITIAL_RENDER_LIMIT)
  const [viewportRange, setViewportRange] = useState<[number, number]>([0, -1])
  const [showJumpBtn, setShowJumpBtn] = useState(false)
  const [unseenBelow, setUnseenBelow] = useState(0)
  const [activeActionMsgId, setActiveActionMsgId] = useState<string | null>(null)
  const handleToggleOriginalActions = useCallback((id: string | null) => {
    setActiveActionMsgId(id ? `${id}-orig` : null)
  }, [])

  const syncViewportRange = useCallback(() => {
    const count = visibleCountRef.current
    if (count <= 0) {
      setViewportRange((prev) => (prev[0] === 0 && prev[1] === -1 ? prev : [0, -1]))
      return
    }
    const el = scrollRef.current
    let nextStart: number
    let nextEnd: number
    if (!el || stickToBottomRef.current || el.scrollHeight <= el.clientHeight + 8) {
      nextStart = Math.max(0, count - DEFAULT_VIEWPORT_TAIL)
      nextEnd = count - 1
    } else {
      const totalH = Math.max(1, el.scrollHeight)
      const startRatio = Math.max(0, el.scrollTop / totalH)
      const endRatio = Math.min(1, (el.scrollTop + el.clientHeight) / totalH)
      const overscan = 3
      nextStart = Math.max(0, Math.min(count - 1, Math.floor(startRatio * count) - overscan))
      nextEnd = Math.max(nextStart, Math.min(count - 1, Math.ceil(endRatio * count) + overscan))
    }
    setViewportRange((prev) =>
      prev[0] === nextStart && prev[1] === nextEnd ? prev : [nextStart, nextEnd]
    )
  }, [])

  const scrollContainerToBottom = useCallback((smooth = false) => {
    const container = scrollRef.current
    if (!container) return
    const targetTop = Math.max(0, container.scrollHeight - container.clientHeight)
    if (smooth) {
      container.scrollTo({ top: targetTop, behavior: 'smooth' })
    } else {
      container.scrollTop = container.scrollHeight
    }
  }, [])

  const scrollMessageIntoContainer = useCallback((targetEl: HTMLElement, smooth = true) => {
    const container = scrollRef.current
    if (!container) return
    const containerRect = container.getBoundingClientRect()
    const targetRect = targetEl.getBoundingClientRect()
    const offsetInContainer = targetRect.top - containerRect.top + container.scrollTop
    const maxTop = Math.max(0, container.scrollHeight - container.clientHeight)
    const centeredTop = Math.max(
      0,
      Math.min(maxTop, offsetInContainer - (container.clientHeight - targetRect.height) / 2)
    )
    container.scrollTo({ top: centeredTop, behavior: smooth ? 'smooth' : 'auto' })
  }, [])

  const isDm = engine.activeView.type === 'dm' && engine.activeDmThread !== null
  const isServer =
    engine.activeView.type === 'server' &&
    engine.servers.activeServer !== null &&
    engine.servers.activeChannel !== null
  const dmThread = engine.activeDmThread
  const activeServer = engine.servers.activeServer
  const activeChannel = engine.servers.activeChannel
  const isEncryptedContext = Boolean(isDm || (isServer && activeServer?.encrypted))
  const streamKey = isDm
    ? `dm:${dmThread?.peerPubkey}`
    : isServer && activeServer && activeChannel
      ? `srv:${activeServer.id}:${activeChannel.id}`
      : `ch:${engine.activeGeohash}`

  // Track which message IDs were already present when switching into a stream
  const initialIdsRef = useRef<{ key: string; ids: Set<string> }>({
    key: '',
    ids: new Set(),
  })

  // Index server messages by ID for O(1) reply/reaction/delete dispatch
  const serverMsgById = useMemo(() => {
    const map = new Map<string, ServerMessage>()
    if (!isServer) return map
    for (const sm of engine.servers.messages) {
      map.set(sm.id, sm)
    }
    return map
  }, [isServer, engine.servers.messages])

  // Normalize DM & Server messages into GeoMessage shape for unified bubble rendering
  const displayMessages: GeoMessage[] = useMemo(() => {
    if (isServer && activeServer && activeChannel) {
      return engine.servers.messages
        .filter(
          (sm) =>
            !isStuckMediaPlaceholder(sm) &&
            (sm.isSystem ||
              (sm.serverId === activeServer.id && sm.channelId === activeChannel.id)) &&
            (sm.isOwn || sm.isSystem || !engine.isPeerBlocked(sm.pubkey))
        )
        .map((sm) => ({
          id: sm.id,
          geohash: activeChannel.id,
          pubkey: sm.pubkey,
          nickname: sm.nickname,
          displayHandle: sm.displayHandle,
          content: sm.decryptFailed
            ? 'Unable to decrypt message — verify you have the latest group invite key.'
            : sm.content,
          createdAt: sm.createdAt,
          tags: sm.tags,
          isOwn: sm.isOwn,
          isSystem: sm.isSystem,
          isEmote: sm.isEmote,
          isTeleported: false,
          isMeshBridge: false,
          powBits: sm.powBits,
          replyTo: sm.replyTo,
          reactions: sm.reactions,
          mentions: sm.mentions,
          voiceMemo: sm.voiceMemo,
          imageAttachment: sm.imageAttachment,
          deliveryStatus: sm.deliveryStatus,
          relayCount: sm.relayCount,
        }))
    }
    if (!isDm || !dmThread) {
      const activeKey = engine.activeGeohash.toLowerCase()
      return engine.messages.filter(
        (m) =>
          !isStuckMediaPlaceholder(m) &&
          (m.isSystem || m.geohash.toLowerCase() === activeKey) &&
          (m.isOwn || m.isSystem || !engine.isPeerBlocked(m.pubkey))
      )
    }
    return dmThread.messages
      .filter((dm) => !isStuckMediaPlaceholder(dm))
      .map((dm) => {
        const isOwn = dm.isOwn
        const nick = isOwn ? engine.identity.nickname : dmThread.peerNickname
        const h = formatHandle(nick, dm.senderPubkey)
        return {
          id: dm.id,
          geohash: engine.activeGeohash,
          pubkey: dm.senderPubkey,
          nickname: h.base,
          displayHandle: h.full,
          content: dm.content,
          createdAt: dm.createdAt,
          tags: [],
          isOwn,
          isTeleported: false,
          isMeshBridge: false,
          powBits: 0,
          reactions: [],
          mentions: [],
          voiceMemo: dm.voiceMemo,
          imageAttachment: dm.imageAttachment,
          deliveryStatus:
            dm.deliveryStatus === 'failed'
              ? 'failed'
              : dm.deliveryStatus === 'sending'
                ? 'sending'
                : 'sent',
        }
      })
  }, [
    isServer,
    activeServer,
    activeChannel,
    engine,
    isDm,
    dmThread,
  ])

  const hiddenEarlierCount = Math.max(0, displayMessages.length - renderLimit)
  const visibleMessages = useMemo(
    () => (hiddenEarlierCount > 0 ? displayMessages.slice(hiddenEarlierCount) : displayMessages),
    [displayMessages, hiddenEarlierCount]
  )

  const loadEarlierMessages = useCallback(() => {
    if (hiddenEarlierCount <= 0) return
    const el = scrollRef.current
    if (el) {
      pendingScrollAnchorRef.current = {
        prevScrollHeight: el.scrollHeight,
        prevScrollTop: el.scrollTop,
      }
    }
    setRenderLimit((curr) => curr + LOAD_EARLIER_STEP)
  }, [hiddenEarlierCount])

  // Preserve visual scroll anchor when prepending older windowed messages
  useLayoutEffect(() => {
    const anchor = pendingScrollAnchorRef.current
    if (!anchor) return
    pendingScrollAnchorRef.current = null
    const el = scrollRef.current
    if (!el) return
    const heightDelta = el.scrollHeight - anchor.prevScrollHeight
    if (heightDelta > 0) {
      el.scrollTop = anchor.prevScrollTop + heightDelta
    }
  }, [visibleMessages.length])

  // Snapshot existing IDs on channel/DM switch, reset DOM window to latest 80, & snap to bottom
  useEffect(() => {
    initialIdsRef.current = {
      key: streamKey,
      ids: new Set(displayMessages.map((m) => m.id)),
    }
    stickToBottomRef.current = true
    streamSwitchedAtRef.current = Date.now()
    pendingScrollAnchorRef.current = null
    pendingJumpIdRef.current = null
    setRenderLimit(INITIAL_RENDER_LIMIT)
    setShowJumpBtn(false)
    setUnseenBelow(0)
    setActiveActionMsgId(null)
    requestAnimationFrame(() => {
      scrollContainerToBottom(false)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streamKey])

  // Auto-scroll when new messages arrive if anchored at bottom
  const prevCountRef = useRef(displayMessages.length)
  useEffect(() => {
    const delta = displayMessages.length - prevCountRef.current
    prevCountRef.current = displayMessages.length

    if (delta > 0) {
      if (stickToBottomRef.current) {
        requestAnimationFrame(() => {
          scrollContainerToBottom(false)
        })
      } else {
        setUnseenBelow((c) => c + delta)
      }
    }
  }, [displayMessages.length, scrollContainerToBottom])

  // Keep pinned to latest message when the virtual keyboard opens or composer height changes
  useEffect(() => {
    const container = scrollRef.current
    if (!container) return
    lastClientHeightRef.current = container.clientHeight

    let rafId: number | null = null
    const pinIfStuck = () => {
      if (rafId !== null) window.cancelAnimationFrame(rafId)
      rafId = window.requestAnimationFrame(() => {
        rafId = null
        const el = scrollRef.current
        if (!el) return
        lastClientHeightRef.current = el.clientHeight
        if (stickToBottomRef.current) {
          scrollContainerToBottom(false)
        }
        syncViewportRange()
      })
    }

    const vv = window.visualViewport
    vv?.addEventListener('resize', pinIfStuck)

    const ro =
      typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(() => {
            pinIfStuck()
          })
        : null
    ro?.observe(container)

    return () => {
      if (rafId !== null) window.cancelAnimationFrame(rafId)
      vv?.removeEventListener('resize', pinIfStuck)
      ro?.disconnect()
    }
  }, [scrollContainerToBottom, syncViewportRange])

  // Scroll to active search hit when navigating search results (auto-expanding window if hit is older)
  useEffect(() => {
    if (!activeSearchMessageId) return
    const idx = displayMessages.findIndex((m) => m.id === activeSearchMessageId)
    if (idx !== -1 && idx < hiddenEarlierCount) {
      const needed = displayMessages.length - idx + 12
      setRenderLimit((curr) => Math.max(curr, needed))
      return
    }
    const el = document.getElementById(`msg-${activeSearchMessageId}`)
    if (el) {
      scrollMessageIntoContainer(el, true)
    }
  }, [activeSearchMessageId, displayMessages, hiddenEarlierCount, scrollMessageIntoContainer])

  // Fulfill deferred reply-quote jumps after expanding the message window
  useEffect(() => {
    const targetId = pendingJumpIdRef.current
    if (!targetId) return
    const el = document.getElementById(`msg-${targetId}`)
    if (!el) return
    pendingJumpIdRef.current = null
    scrollMessageIntoContainer(el, true)
    el.classList.add('is-search-active')
    window.setTimeout(() => el.classList.remove('is-search-active'), 1600)
  }, [visibleMessages.length, scrollMessageIntoContainer])

  const handleScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    // If container height just shrank (e.g. mobile keyboard opened) while anchored to bottom,
    // immediately re-pin instead of clearing stickToBottomRef.
    const prevHeight = lastClientHeightRef.current
    if (prevHeight > 0 && el.clientHeight < prevHeight - 4 && stickToBottomRef.current) {
      lastClientHeightRef.current = el.clientHeight
      el.scrollTop = el.scrollHeight
      return
    }
    lastClientHeightRef.current = el.clientHeight

    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    const atBottom = distFromBottom <= 64
    stickToBottomRef.current = atBottom
    setShowJumpBtn(!atBottom && el.scrollHeight > el.clientHeight + 120)
    if (atBottom && unseenBelow > 0) {
      setUnseenBelow(0)
      engine.markChannelRead()
    }

    // Auto-expand earlier messages smoothly when scrolled near the top
    const now = Date.now()
    if (
      hiddenEarlierCount > 0 &&
      !atBottom &&
      el.scrollTop <= 48 &&
      el.scrollHeight > el.clientHeight + 80 &&
      now - streamSwitchedAtRef.current > 250 &&
      now - lastAutoExpandAtRef.current > 250
    ) {
      lastAutoExpandAtRef.current = now
      loadEarlierMessages()
    }

    syncViewportRange()
  }, [unseenBelow, engine, hiddenEarlierCount, loadEarlierMessages, syncViewportRange])

  const scrollToLatest = useCallback(() => {
    stickToBottomRef.current = true
    setShowJumpBtn(false)
    setUnseenBelow(0)
    scrollContainerToBottom(true)
    syncViewportRange()
    engine.markChannelRead()
  }, [engine, scrollContainerToBottom, syncViewportRange])

  const handleJumpToMessage = useCallback(
    (id: string) => {
      const el = document.getElementById(`msg-${id}`)
      if (el) {
        scrollMessageIntoContainer(el, true)
        el.classList.add('is-search-active')
        window.setTimeout(() => el.classList.remove('is-search-active'), 1600)
        return
      }
      const idx = displayMessages.findIndex((m) => m.id === id)
      if (idx !== -1 && idx < hiddenEarlierCount) {
        pendingJumpIdRef.current = id
        const needed = displayMessages.length - idx + 12
        setRenderLimit((curr) => Math.max(curr, needed))
      }
    },
    [displayMessages, hiddenEarlierCount, scrollMessageIntoContainer]
  )

  const handleInspectAuthor = useCallback(
    (pubkey: string, nickname: string) => {
      const existing = engine.getPeerByPubkey(pubkey)
      if (existing) {
        onInspectPeer(existing)
        return
      }
      const pkLower = pubkey.toLowerCase()
      const srvMember = engine.servers.members.find((m) => m.pubkey.toLowerCase() === pkLower)
      if (srvMember) {
        onInspectPeer({
          pubkey: srvMember.pubkey,
          npub: srvMember.npub,
          nickname: srvMember.nickname,
          displayHandle: srvMember.displayHandle,
          lastSeenAt: Math.floor(Date.now() / 1000),
          isOnline: true,
          isSelf: srvMember.isSelf,
          isTeleported: false,
          isMeshBridge: false,
          isBlocked: engine.isPeerBlocked(srvMember.pubkey),
          isTrusted: engine.isTrusted(srvMember.pubkey),
          messageCount: 1,
          channels: activeChannel ? [activeChannel.name] : [],
        })
        return
      }
      onInspectPeer(
        buildFallbackPeer(
          pubkey,
          nickname,
          engine.activeGeohash,
          pubkey === engine.identity.activePubkey || pubkey === engine.identity.masterPubkey,
          engine.isPeerBlocked(pubkey),
          engine.isTrusted(pubkey)
        )
      )
    },
    [engine, onInspectPeer, activeChannel]
  )

  const handleReplyUnified = useCallback(
    (msg: GeoMessage) => {
      if (isServer) {
        const sm = serverMsgById.get(msg.id)
        if (!sm) return
        if (onReplyServer) onReplyServer(sm)
        else engine.servers.setReplyingTo(sm)
        return
      }
      onReply(msg)
    },
    [isServer, serverMsgById, onReplyServer, engine.servers, onReply]
  )

  const handleReactUnified = useCallback(
    (msg: GeoMessage, emoji: string) => {
      if (isServer) {
        const sm = serverMsgById.get(msg.id)
        if (!sm) return
        if (onReactServer) onReactServer(sm, emoji)
        else void engine.servers.sendReaction(sm, emoji)
        return
      }
      onReact(msg, emoji)
    },
    [isServer, serverMsgById, onReactServer, engine.servers, onReact]
  )

  const handleDeleteServerMessage = useCallback(
    (msg: GeoMessage) => {
      const sm = serverMsgById.get(msg.id)
      if (!sm) return
      void engine.servers.deleteMessage(sm)
    },
    [serverMsgById, engine.servers]
  )

  const handleTrustSender = useCallback(
    (pubkey: string, nickname: string) => {
      engine.trustPubkey(pubkey, nickname)
    },
    [engine]
  )

  const handleUntrustSender = useCallback(
    (pubkey: string) => {
      engine.untrustPubkey(pubkey)
    },
    [engine]
  )

  const handleStartCallSender = useCallback(
    (pubkey: string, mediaType: 'audio' | 'video', nickname?: string) => {
      void engine.calls.startDmCall(pubkey, mediaType, nickname)
    },
    [engine.calls]
  )

  const handleBlockSender = useCallback(
    (pubkey: string, displayHandle: string) => {
      engine.toggleBlockPeer(pubkey, displayHandle)
    },
    [engine]
  )

  const hottestPulse = useMemo(() => {
    return engine.pulseRooms.find((r) => r.geohash !== engine.activeGeohash) ?? null
  }, [engine.pulseRooms, engine.activeGeohash])

  // Memoized list of known peer, member, self & author handles (including multi-word names with spaces)
  // so inline `@John Doe` and `@John Doe#a1b2` highlight cleanly as one clickable chip.
  const knownHandles = useMemo(() => {
    const out: string[] = []
    const seen = new Set<string>()
    const add = (raw?: string | null) => {
      if (!raw) return
      const clean = raw.trim().replace(/^@+/, '').trim()
      if (!clean) return
      const key = clean.toLowerCase()
      if (seen.has(key)) return
      seen.add(key)
      out.push(clean)
    }

    add(engine.identity.activeDisplayHandle)
    add(engine.identity.nickname)

    if (isDm && dmThread) {
      add(dmThread.peerDisplayHandle)
      add(dmThread.peerNickname)
    } else if (isServer) {
      for (const m of engine.servers.members) {
        add(m.displayHandle)
        add(m.nickname)
      }
    } else {
      for (const p of engine.peers) {
        add(p.displayHandle)
        add(p.nickname)
      }
    }

    for (const msg of displayMessages) {
      if (msg.isSystem) continue
      add(msg.displayHandle)
      add(msg.nickname)
    }

    return out
  }, [
    engine.identity.activeDisplayHandle,
    engine.identity.nickname,
    isDm,
    dmThread,
    isServer,
    engine.servers.members,
    engine.peers,
    displayMessages,
  ])

  const ownNick = engine.identity.nickname
  const ownPubkey = isServer ? engine.identity.masterPubkey : engine.identity.activePubkey

  const reactorNameMap = useMemo(() => {
    const map = new Map<string, string>()
    const setPreferred = (pkRaw: string | undefined, nameRaw: string | undefined) => {
      if (!pkRaw || !nameRaw) return
      const pk = pkRaw.trim().toLowerCase()
      const name = nameRaw.trim()
      if (!pk || !name) return
      const existing = map.get(pk)
      const isGeneric = /^anon[0-9a-f]{0,4}$/i.test(name)
      const existingIsGeneric = !existing || /^anon[0-9a-f]{0,4}$/i.test(existing)
      if (!existing || !isGeneric || existingIsGeneric) {
        map.set(pk, name)
      }
    }

    for (const msg of displayMessages) {
      if (msg.isSystem) continue
      setPreferred(msg.pubkey, msg.nickname)
    }
    for (const entry of engine.trustedPubkeys) {
      setPreferred(entry.pubkey, entry.label)
    }
    for (const peer of engine.peers) {
      setPreferred(peer.pubkey, peer.nickname)
    }
    for (const member of engine.servers.members) {
      setPreferred(member.pubkey, member.nickname)
    }
    return map
  }, [displayMessages, engine.trustedPubkeys, engine.peers, engine.servers.members])

  const resolveReactorName = useCallback(
    (pubkey: string): string => {
      const pk = pubkey.trim().toLowerCase()
      if (!pk) return 'anon'
      if (
        pk === engine.identity.activePubkey.toLowerCase() ||
        pk === engine.identity.masterPubkey.toLowerCase()
      ) {
        return 'You'
      }
      const mapped = reactorNameMap.get(pk)
      if (mapped) return mapped
      const lookedUp = engine.getPeerByPubkey(pk)?.nickname?.trim()
      if (lookedUp) return lookedUp
      return `anon${pk.slice(-4)}`
    },
    [engine, reactorNameMap]
  )

  const hiddenCount = isServer
    ? engine.servers.hiddenByTrustCount
    : !isDm
      ? engine.hiddenByWhitelistCount
      : 0

  // Watch recent visible non-DM event IDs for live NIP-57 kind: 9735 Zap Receipts
  const watchedZapIdsKey = useMemo(() => {
    if (isDm) return ''
    const ids: string[] = []
    for (let i = Math.max(0, displayMessages.length - 40); i < displayMessages.length; i += 1) {
      const m = displayMessages[i]
      if (!m.isSystem && m.id) ids.push(m.id)
    }
    return ids.join(',')
  }, [isDm, displayMessages])

  useEffect(() => {
    if (!watchedZapIdsKey) return
    engine.zaps.watchEventIds(watchedZapIdsKey.split(','))
  }, [watchedZapIdsKey, engine.zaps])

  // Double-Column Translator Mode — viewport-aware newest-first sliding scheduler
  const translator = engine.translator
  const {
    translations,
    originalOutgoingById,
    translateMessage,
    cancelScope,
    cancelDownload,
    updateSettings,
    preloadModel,
  } = translator
  const translatorShortLabel =
    TRANSLATOR_MODELS[translator.modelKey]?.shortLabel ?? translator.modelLabel
  const translatorEnabled = translator.settings.enabled
  const myLanguage = translator.settings.myLanguage
  const sourceLanguage = translator.settings.sourceLanguage || 'Auto'
  const outgoingEnabled = translator.settings.outgoingEnabled
  const outgoingLanguage = translator.settings.outgoingLanguage
  const underlyingCollapsed = translator.settings.underlyingCollapsed
  const explicitSourceLang = sourceLanguage !== 'Auto' ? sourceLanguage : undefined
  const scopeKey = `${streamKey}|${myLanguage}|${sourceLanguage}|${translator.modelKey}`
  const baselineKey = `${streamKey}|${translatorEnabled ? '1' : '0'}`

  // Snapshot previously-existing message IDs & timestamp floor whenever room changes or Translator Mode turns ON
  useLayoutEffect(() => {
    if (translatorBaselineRef.current.key === baselineKey) return
    if (!translatorEnabled) {
      translatorBaselineRef.current = {
        key: baselineKey,
        existingIds: new Set(),
        baselineMaxCreatedAt: 0,
        startedEmpty: true,
      }
      return
    }
    const existingIds = new Set<string>()
    let maxCreatedAt = 0
    let nonSystemCount = 0
    for (const m of displayMessages) {
      existingIds.add(m.id)
      if (!m.isSystem) {
        nonSystemCount += 1
        if (m.createdAt > maxCreatedAt) maxCreatedAt = m.createdAt
      }
    }
    const nowSec = Math.floor(Date.now() / 1000)
    translatorBaselineRef.current = {
      key: baselineKey,
      existingIds,
      baselineMaxCreatedAt: nonSystemCount > 0 ? maxCreatedAt : nowSec,
      startedEmpty: nonSystemCount === 0,
    }
  }, [baselineKey, translatorEnabled, displayMessages])

  // Sync visible message count & viewport range whenever message window, room, or translator mode changes
  useLayoutEffect(() => {
    visibleCountRef.current = visibleMessages.length
    syncViewportRange()
  }, [visibleMessages.length, streamKey, translatorEnabled, syncViewportRange])

  // Detect dominant foreign language across the latest 40 non-system messages for Auto room hint
  const recentTextsForHint = useMemo(() => {
    if (!translatorEnabled) return [] as string[]
    const otherTexts: string[] = []
    const allTexts: string[] = []
    for (let i = Math.max(0, displayMessages.length - 40); i < displayMessages.length; i += 1) {
      const m = displayMessages[i]
      if (m.isSystem) continue
      const clean = extractCleanMessageText(m)
      if (!clean || isNonTranslatableText(clean)) continue
      allTexts.push(clean)
      if (!m.isOwn) otherTexts.push(clean)
    }
    return otherTexts.length >= 2 ? otherTexts : allTexts
  }, [translatorEnabled, displayMessages])

  const roomHintLang = useMemo(() => {
    if (!translatorEnabled || recentTextsForHint.length === 0) return null
    return detectRoomDominantLanguage(recentTextsForHint, myLanguage)
  }, [translatorEnabled, recentTextsForHint, myLanguage])

  const effectiveSourceLabel = explicitSourceLang ?? roomHintLang ?? null

  // Immediately cancel stale worker jobs on room/language/model/enabled change
  useEffect(() => {
    cancelScope(translatorEnabled ? scopeKey : undefined)
  }, [translatorEnabled, scopeKey, cancelScope])

  // Stop background translation cleanly when leaving chat view (e.g., switching to Agmail/Agwallet)
  useEffect(() => {
    return () => {
      cancelScope(undefined)
    }
  }, [cancelScope])

  // Live-first incoming priority ('live', unthrottled) + low-priority interruptible backfill (MAX_ACTIVE_BACKFILL = 2)
  useEffect(() => {
    if (!translatorEnabled || translator.modelStatus === 'error') return
    const total = visibleMessages.length
    if (total === 0) return

    let visStart: number
    let visEnd: number
    if (stickToBottomRef.current || viewportRange[1] < viewportRange[0]) {
      visStart = Math.max(0, total - DEFAULT_VIEWPORT_TAIL)
      visEnd = total - 1
    } else {
      visStart = Math.max(0, Math.min(total - 1, viewportRange[0]))
      visEnd = Math.max(visStart, Math.min(total - 1, viewportRange[1]))
    }

    const baseline = translatorBaselineRef.current
    const liveRecencyFloor = Math.floor(Date.now() / 1000) - 90
    const isLiveIncoming = (msg: GeoMessage): boolean => {
      if (baseline.existingIds.has(msg.id)) return false
      if (msg.createdAt < baseline.baselineMaxCreatedAt - 5) return false
      if (baseline.startedEmpty && msg.createdAt < liveRecencyFloor) return false
      return true
    }

    let activeLiveLoading = 0
    let activeBackfillLoading = 0
    const seenKeys = new Set<string>()
    const liveCandidates: Array<{ msgId: string; spec: MessageTranslationSpec }> = []
    const backfillCandidates: Array<{
      msgId: string
      spec: MessageTranslationSpec
      priority: 'visible' | 'normal'
    }> = []

    // Pass 1 ('live'): ALL untranslated live incoming messages (newest first), never blocked behind backfill cap
    for (let i = total - 1; i >= 0; i -= 1) {
      const msg = visibleMessages[i]
      if (!msg || msg.isSystem || msg.id.startsWith('pending-')) continue
      if (!isLiveIncoming(msg)) continue
      const spec = resolveMessageTranslationSpec(
        msg,
        originalOutgoingById[msg.id],
        myLanguage,
        explicitSourceLang
      )
      if (spec.mode !== 'translate' || !spec.cacheKey || !spec.textToTranslate) continue
      if (seenKeys.has(spec.cacheKey)) continue
      seenKeys.add(spec.cacheKey)
      const entry = translations[spec.cacheKey]
      if (entry?.status === 'loading') {
        activeLiveLoading += 1
        continue
      }
      if (entry?.status === 'done' || entry?.status === 'error') {
        continue
      }
      liveCandidates.push({ msgId: msg.id, spec })
    }

    for (const cand of liveCandidates) {
      activeLiveLoading += 1
      void translateMessage(cand.msgId, cand.spec.textToTranslate!, myLanguage, {
        sourceLang: cand.spec.sourceLang ?? 'Auto',
        roomHintLang: cand.spec.sourceLang ? undefined : roomHintLang,
        scopeKey,
        priority: 'live',
      })
    }

    // Pass 2 ('visible' & 'normal' backfill): previously-existing messages strictly NEWEST -> OLDEST
    const inspectBackfill = (idx: number, priority: 'visible' | 'normal') => {
      const msg = visibleMessages[idx]
      if (!msg || msg.isSystem || msg.id.startsWith('pending-')) return
      if (isLiveIncoming(msg)) return
      const spec = resolveMessageTranslationSpec(
        msg,
        originalOutgoingById[msg.id],
        myLanguage,
        explicitSourceLang
      )
      if (spec.mode !== 'translate' || !spec.cacheKey || !spec.textToTranslate) return
      if (seenKeys.has(spec.cacheKey)) return
      seenKeys.add(spec.cacheKey)
      const entry = translations[spec.cacheKey]
      if (entry?.status === 'loading') {
        activeBackfillLoading += 1
        return
      }
      if (entry?.status === 'done' || entry?.status === 'error') {
        return
      }
      backfillCandidates.push({ msgId: msg.id, spec, priority })
    }

    // Viewport items NEWEST -> OLDEST ('visible')
    for (let i = visEnd; i >= visStart; i -= 1) {
      inspectBackfill(i, 'visible')
    }
    // Off-screen items strictly NEWEST -> OLDEST ('normal'): below viewport first, then above viewport
    for (let i = total - 1; i > visEnd; i -= 1) {
      inspectBackfill(i, 'normal')
    }
    for (let i = visStart - 1; i >= 0; i -= 1) {
      inspectBackfill(i, 'normal')
    }

    if (activeLiveLoading > 0 || backfillCandidates.length === 0) return

    let backfillSlots = Math.max(0, MAX_ACTIVE_BACKFILL - activeBackfillLoading)
    if (backfillSlots <= 0) return

    for (const cand of backfillCandidates) {
      if (backfillSlots <= 0) break
      backfillSlots -= 1
      void translateMessage(cand.msgId, cand.spec.textToTranslate!, myLanguage, {
        sourceLang: cand.spec.sourceLang ?? 'Auto',
        roomHintLang: cand.spec.sourceLang ? undefined : roomHintLang,
        scopeKey,
        priority: cand.priority,
      })
    }
  }, [
    translatorEnabled,
    translator.modelStatus,
    visibleMessages,
    viewportRange,
    myLanguage,
    explicitSourceLang,
    roomHintLang,
    scopeKey,
    translations,
    originalOutgoingById,
    translateMessage,
  ])

  const translationProgress = useMemo(() => {
    if (!translatorEnabled) {
      return { totalTranslatable: 0, doneCount: 0, pendingCount: 0 }
    }
    let totalTranslatable = 0
    let doneCount = 0
    let pendingCount = 0
    for (const msg of visibleMessages) {
      if (msg.isSystem || msg.id.startsWith('pending-')) continue
      const spec = resolveMessageTranslationSpec(
        msg,
        originalOutgoingById[msg.id],
        myLanguage,
        explicitSourceLang
      )
      if (spec.mode !== 'translate' || !spec.cacheKey) continue
      totalTranslatable += 1
      const status = translations[spec.cacheKey]?.status
      if (status === 'done') {
        doneCount += 1
      } else if (status !== 'error') {
        pendingCount += 1
      }
    }
    return { totalTranslatable, doneCount, pendingCount }
  }, [
    translatorEnabled,
    visibleMessages,
    originalOutgoingById,
    myLanguage,
    explicitSourceLang,
    translations,
  ])

  const sourceLanguageOptions = useMemo(() => {
    const names = TRANSLATION_LANGUAGE_OPTIONS.map((o) => o.name)
    if (sourceLanguage !== 'Auto' && !names.includes(sourceLanguage)) {
      return [sourceLanguage, ...names]
    }
    return names
  }, [sourceLanguage])

  const myLanguageOptions = useMemo(() => {
    const names = TRANSLATION_LANGUAGE_OPTIONS.map((o) => o.name)
    return names.includes(myLanguage) ? names : [myLanguage, ...names]
  }, [myLanguage])

  const outgoingLanguageOptions = useMemo(() => {
    const names = TRANSLATION_LANGUAGE_OPTIONS.map((o) => o.name)
    return names.includes(outgoingLanguage) ? names : [outgoingLanguage, ...names]
  }, [outgoingLanguage])

  const translationLoadingLabel =
    translator.modelStatus === 'downloading' ? 'Loading model…' : 'Translating…'

  const showTrustedFilterBar = !isDm && engine.strictWhitelistMode && hiddenCount > 0

  return (
    <div className="ag-stream-wrap">
      {showTrustedFilterBar && (
        <div className="ag-trusted-filter-bar" role="status" aria-live="polite">
          <div className="ag-trusted-filter-copy">
            <ShieldCheck size={14} style={{ color: 'var(--accent)', flexShrink: 0 }} />
            <span>
              <strong>Trusted Peers Only</strong> · hiding{' '}
              <span className="tabular">{hiddenCount}</span>{' '}
              {hiddenCount === 1 ? 'message' : 'messages'}
            </span>
          </div>
          <button
            type="button"
            className="ag-trusted-filter-btn"
            onClick={() => engine.setStrictWhitelistMode(false)}
          >
            Show all
          </button>
        </div>
      )}

      {/* Compact Double-Column Translator Controls Strip */}
      {translatorEnabled && (
        <div className="ag-translator-bar" role="region" aria-label="Translator controls">
          <div className="ag-translator-bar-row">
            <div className="ag-translator-bar-group">
              <span className="ag-translator-bar-icon" aria-hidden="true">
                <Languages size={14} />
              </span>

              <label className="ag-translator-select-wrap" title="Source chat language">
                <span className="ag-translator-field-label">From</span>
                <select
                  className="ag-translator-select compact"
                  value={sourceLanguage}
                  onChange={(e) => updateSettings({ sourceLanguage: e.target.value })}
                  aria-label="Source chat language"
                >
                  <option value="Auto">
                    {roomHintLang ? `Auto (${roomHintLang})` : 'Auto'}
                  </option>
                  {sourceLanguageOptions.map((lang) => (
                    <option key={lang} value={lang}>
                      {lang}
                    </option>
                  ))}
                </select>
              </label>

              <label className="ag-translator-select-wrap" title="Your reading language">
                <span className="ag-translator-field-label">Read</span>
                <select
                  className="ag-translator-select"
                  value={myLanguage}
                  onChange={(e) => updateSettings({ myLanguage: e.target.value })}
                  aria-label="My reading language"
                >
                  {myLanguageOptions.map((lang) => (
                    <option key={lang} value={lang}>
                      {lang}
                    </option>
                  ))}
                </select>
              </label>

              <button
                type="button"
                className={`ag-translator-pill-btn ${outgoingEnabled ? 'active' : ''}`}
                onClick={() => updateSettings({ outgoingEnabled: !outgoingEnabled })}
                aria-pressed={outgoingEnabled}
                title="Translate your outgoing messages before sending"
              >
                <span>Send →</span>
              </button>

              {outgoingEnabled && (
                <select
                  className="ag-translator-select compact"
                  value={outgoingLanguage}
                  onChange={(e) => updateSettings({ outgoingLanguage: e.target.value })}
                  aria-label="Outgoing message language"
                >
                  {outgoingLanguageOptions.map((lang) => (
                    <option key={lang} value={lang}>
                      {lang}
                    </option>
                  ))}
                </select>
              )}
            </div>

            <div className="ag-translator-bar-right">
              {translator.modelStatus === 'downloading' ? (
                <>
                  <span
                    className="ag-translator-model-status downloading tabular"
                    title={translator.modelLabel}
                  >
                    <Loader2 size={12} className="ag-spin" />
                    <span>
                      {translatorShortLabel} · {Math.round(translator.downloadProgress)}%
                    </span>
                  </span>
                  <button
                    type="button"
                    className="ag-translator-pill-btn"
                    onClick={() => cancelDownload()}
                    title="Cancel model download"
                    aria-label="Cancel model download"
                  >
                    <span>Cancel</span>
                  </button>
                </>
              ) : translator.modelStatus === 'error' ? (
                <button
                  type="button"
                  className="ag-translator-model-status error"
                  onClick={() => void preloadModel()}
                  title={translator.modelError || 'Retry loading translator model'}
                >
                  <AlertCircle size={12} />
                  <span>Retry model</span>
                </button>
              ) : translationProgress.pendingCount > 0 ? (
                <span
                  className="ag-translator-model-status translating tabular"
                  title={`Translating messages (${translationProgress.doneCount} of ${translationProgress.totalTranslatable} done)`}
                >
                  <Loader2 size={12} className="ag-spin" />
                  <span>
                    Translating ({translationProgress.doneCount}/{translationProgress.totalTranslatable})
                  </span>
                </span>
              ) : (
                <span
                  className="ag-translator-model-status ready ag-desktop-only"
                  title={`${translator.modelLabel} · On-device translation`}
                >
                  <Columns2 size={11} />
                  <span>
                    {translatorShortLabel}
                    {translator.runtimeDevice
                      ? ` · ${translator.runtimeDevice === 'webgpu' ? 'WebGPU' : 'WASM'}`
                      : ''}
                  </span>
                </span>
              )}

              <button
                type="button"
                className={`ag-translator-pill-btn ${!underlyingCollapsed ? 'active' : ''}`}
                onClick={() => updateSettings({ underlyingCollapsed: !underlyingCollapsed })}
                title={
                  underlyingCollapsed
                    ? 'Show Original column'
                    : 'Hide Original column'
                }
                aria-label={
                  underlyingCollapsed
                    ? 'Show Original column'
                    : 'Hide Original column'
                }
              >
                {underlyingCollapsed ? <PanelRightOpen size={13} /> : <PanelRightClose size={13} />}
                <span className="ag-hide-xs">
                  {underlyingCollapsed ? 'Show Original' : 'Hide Original'}
                </span>
              </button>

              <button
                type="button"
                className="ag-translator-close-btn"
                onClick={() => updateSettings({ enabled: false })}
                title="Exit Translator Mode"
                aria-label="Exit Translator Mode"
              >
                <X size={14} />
              </button>
            </div>
          </div>

          {translator.modelStatus === 'downloading' && (
            <div className="ag-translator-progress-track" aria-hidden="true">
              <div
                className="ag-translator-progress-fill"
                style={{ width: `${Math.max(4, Math.min(100, Math.round(translator.downloadProgress)))}%` }}
              />
            </div>
          )}
        </div>
      )}

      <div
        ref={scrollRef}
        className={`ag-stream-scroll ${translatorEnabled ? 'is-translator-active' : ''}`}
        onScroll={handleScroll}
        onClick={(e) => {
          if (activeActionMsgId && !(e.target as HTMLElement | null)?.closest('.ag-msg-row')) {
            setActiveActionMsgId(null)
          }
        }}
        role="log"
        aria-live="polite"
        aria-relevant="additions"
      >
        <div className="ag-stream-inner">
          {displayMessages.length === 0 ? (
            isDm && dmThread ? (
              /* Serene Encrypted DM Empty State */
              <div className="ag-empty-stage">
                <img
                  src={identiconDataUrl(dmThread.peerPubkey)}
                  alt=""
                  className="ag-empty-avatar"
                />
                <div className="ag-empty-copy">
                  <h2 className="ag-empty-title">{dmThread.peerNickname}</h2>
                  <p className="ag-empty-sub">
                    <Lock size={13} style={{ display: 'inline', verticalAlign: '-2px', marginRight: 5 }} />
                    End-to-end encrypted direct messages. Only you and {dmThread.peerNickname} can
                    read them.
                  </p>
                </div>
              </div>
            ) : isServer && activeServer && activeChannel ? (
              /* Serene Server Channel Empty State */
              <div className="ag-empty-stage">
                <div
                  className="ag-srv-empty-emblem"
                  style={
                    {
                      '--srv-accent': activeServer.accentColor || 'var(--accent)',
                    } as CSSProperties
                  }
                  aria-hidden="true"
                >
                  {activeServer.picture && /^https?:\/\//i.test(activeServer.picture) ? (
                    <img
                      src={activeServer.picture}
                      alt=""
                      loading="lazy"
                      referrerPolicy="no-referrer"
                    />
                  ) : activeServer.icon?.trim() ? (
                    <span>{activeServer.icon}</span>
                  ) : (
                    <span className="mono">{getServerMonogram(activeServer.name)}</span>
                  )}
                </div>

                <div className="ag-empty-copy">
                  <h2 className="ag-empty-title">#{activeChannel.name}</h2>
                  <p className="ag-empty-sub">
                    {activeChannel.topic ||
                      activeServer.description ||
                      (activeServer.encrypted
                        ? `Private end-to-end encrypted channel in ${activeServer.name}.`
                        : `Start the conversation in ${activeServer.name}.`)}
                  </p>
                </div>

                <div className="ag-empty-actions">
                  <button
                    type="button"
                    className="ag-cta-btn primary"
                    onClick={() => onOpenServerSettings?.(activeServer.id, 'overview')}
                  >
                    <UserPlus size={15} />
                    <span>Invite People</span>
                  </button>

                  {activeServer.kind === 'nip29' &&
                    !activeServer.isJoinedMember &&
                    activeServer.relayUrl &&
                    activeServer.groupId && (
                      <button
                        type="button"
                        className="ag-cta-btn"
                        onClick={() =>
                          void engine.servers.joinNip29Group(
                            activeServer.relayUrl!,
                            activeServer.groupId!
                          )
                        }
                      >
                        <Server size={15} />
                        <span>Join Group</span>
                      </button>
                    )}
                </div>
              </div>
            ) : (
              /* Serene Geohash or Named Topic Radio Empty State */
              (() => {
                const activeIsTopic = isTopicChannel(engine.activeGeohash)
                const activeRadioLabel = formatRadioChannelLabel(engine.activeGeohash)
                const hottestIsTopic = hottestPulse ? isTopicChannel(hottestPulse.geohash) : false
                const hottestLabel = hottestPulse
                  ? formatRadioChannelLabel(hottestPulse.geohash)
                  : ''
                return (
              <div className="ag-empty-stage">
                <div className="ag-empty-radio-icon" aria-hidden="true">
                  {activeIsTopic ? <Hash size={26} /> : <Radio size={26} />}
                </div>

                <div className="ag-empty-copy">
                  <h2 className="ag-empty-title">
                    <span className="mono">{activeRadioLabel}</span>
                    {!activeIsTopic && engine.cell.nearestCity ? ` · ${engine.cell.nearestCity}` : ''}
                  </h2>
                  <p className="ag-empty-sub">
                    {activeIsTopic
                      ? 'Live topic channel — say hello to start chatting.'
                      : 'Say hello to start chatting with people nearby.'}
                  </p>
                </div>

                <div className="ag-empty-actions">
                  {!activeIsTopic && (
                    <button type="button" className="ag-cta-btn primary" onClick={onLocateMe}>
                      <Crosshair size={15} />
                      <span>Locate Me</span>
                    </button>
                  )}

                  {hottestPulse ? (
                    <button
                      type="button"
                      className={`ag-cta-btn ${activeIsTopic ? 'primary' : ''}`}
                      onClick={() => onTuneChannel(hottestPulse.geohash)}
                    >
                      {hottestIsTopic ? (
                        <Hash size={15} style={{ color: activeIsTopic ? 'currentColor' : 'var(--accent)' }} />
                      ) : (
                        <Radio size={15} style={{ color: activeIsTopic ? 'currentColor' : 'var(--accent)' }} />
                      )}
                      <span>
                        Join {hottestLabel}
                        {!hottestIsTopic && hottestPulse.nearestCity
                          ? ` · ${hottestPulse.nearestCity}`
                          : ''}
                      </span>
                    </button>
                  ) : (
                    <button type="button" className="ag-cta-btn" onClick={onExpandRadar}>
                      <MapIcon size={15} />
                      <span>Open Map</span>
                    </button>
                  )}
                </div>
              </div>
                )
              })()
            )
          ) : (
            <div className={translatorEnabled ? 'ag-translator-grid-wrap' : undefined}>
              {translatorEnabled && (
                <div
                  className={`ag-translator-col-heads ${underlyingCollapsed ? 'collapsed' : ''}`}
                  aria-hidden="true"
                >
                  <div className="ag-translator-col-head">
                    <Languages size={12} />
                    <span className="truncate">My Language · {myLanguage}</span>
                  </div>
                  {!underlyingCollapsed && (
                    <div className="ag-translator-col-head underlying">
                      <span className="truncate">
                        {effectiveSourceLabel ? `Original · ${effectiveSourceLabel}` : 'Original'}
                      </span>
                    </div>
                  )}
                </div>
              )}

              {hiddenEarlierCount > 0 && (
                <div
                  className="ag-load-earlier-wrap"
                  style={{
                    display: 'flex',
                    justifyContent: 'center',
                    padding: '8px 0 12px',
                  }}
                >
                  <button
                    type="button"
                    className="ag-load-earlier-btn"
                    onClick={loadEarlierMessages}
                    style={{
                      appearance: 'none',
                      border: '1px solid var(--border-subtle)',
                      background: 'var(--bg-surface)',
                      color: 'var(--text-secondary)',
                      borderRadius: '999px',
                      padding: '5px 14px',
                      fontSize: '12px',
                      fontWeight: 500,
                      lineHeight: 1.4,
                      cursor: 'pointer',
                    }}
                  >
                    Load earlier messages ({hiddenEarlierCount})
                  </button>
                </div>
              )}

              {visibleMessages.map((msg, idx) => {
                const prev = idx > 0 ? visibleMessages[idx - 1] : null
                const showDateDivider = !prev || dateDayKey(prev.createdAt) !== dateDayKey(msg.createdAt)
                const showUnreadDivider =
                  !isDm && !isServer && engine.unreadDividerId !== null && msg.id === engine.unreadDividerId

                const grouped =
                  !showDateDivider &&
                  !showUnreadDivider &&
                  !msg.isSystem &&
                  !msg.isEmote &&
                  !msg.replyTo &&
                  prev !== null &&
                  !prev.isSystem &&
                  !prev.isEmote &&
                  prev.pubkey === msg.pubkey &&
                  msg.createdAt - prev.createdAt <= 180

                const isLive =
                  initialIdsRef.current.key === streamKey && !initialIdsRef.current.ids.has(msg.id)

                const isMentioned =
                  !msg.isOwn &&
                  !msg.isSystem &&
                  doesContentMentionUser(msg.content, msg.mentions, ownNick, ownPubkey)

                const voiceMemoKey = msg.voiceMemo
                  ? msg.voiceMemo.sha256 || msg.voiceMemo.url || msg.id
                  : ''
                const memoTranscript = voiceMemoKey
                  ? engine.transcription.memoTranscripts[voiceMemoKey]
                  : undefined

                const senderLud16 =
                  !msg.isOwn && !msg.isSystem
                    ? engine.zaps.getPeerLightningAddress(msg.pubkey)
                    : null
                const senderCanZap =
                  !msg.isOwn && !msg.isSystem && engine.zaps.canZapPeer(msg.pubkey)
                const zapTotalSats = !msg.isSystem ? (engine.zaps.zapTotalsByEventId[msg.id] ?? 0) : 0

                // Compute Left-column translation state when Translator Mode is active
                let displayContentOverride: string | undefined
                let translationStatus: 'idle' | 'pending' | 'loading' | 'done' | 'error' | undefined
                let translationError: string | undefined
                let translationBadge: string | undefined
                let onRetryTranslation: (() => void) | undefined

                if (translatorEnabled && !msg.isSystem) {
                  if (msg.id.startsWith('pending-')) {
                    if (outgoingEnabled && msg.deliveryStatus === 'sending') {
                      translationStatus = 'loading'
                    }
                  } else {
                    const outgoingOrig = originalOutgoingById[msg.id]
                    const spec = resolveMessageTranslationSpec(
                      msg,
                      outgoingOrig,
                      myLanguage,
                      explicitSourceLang
                    )
                    if (spec.mode === 'own-original' && outgoingOrig) {
                      displayContentOverride = outgoingOrig.originalText
                      translationStatus = 'done'
                      translationBadge = spec.badge
                    } else if (spec.mode === 'translate' && spec.cacheKey && spec.textToTranslate) {
                      const tEntry = translations[spec.cacheKey]
                      if (spec.badge) {
                        translationBadge = spec.badge
                      }
                      if (tEntry?.status === 'done' && tEntry.text) {
                        displayContentOverride = tEntry.text
                        translationStatus = 'done'
                      } else if (tEntry?.status === 'loading') {
                        translationStatus = 'loading'
                      } else if (tEntry?.status === 'error') {
                        translationStatus = 'error'
                        translationError = tEntry.error
                        const retryText = spec.textToTranslate
                        const retrySourceLang = spec.sourceLang
                        const retryRoomHint = retrySourceLang ? undefined : roomHintLang
                        onRetryTranslation = () => {
                          void translateMessage(msg.id, retryText, myLanguage, {
                            sourceLang: retrySourceLang ?? 'Auto',
                            roomHintLang: retryRoomHint,
                            scopeKey,
                            priority: 'visible',
                          })
                        }
                      } else {
                        // Translatable message queued behind sliding window: never render raw foreign text
                        translationStatus = 'pending'
                      }
                    }
                  }
                }

                const sharedMessageProps = {
                  message: msg,
                  grouped,
                  isLive,
                  isMentioned,
                  isSearchActive: activeSearchMessageId === msg.id,
                  highlightQuery: searchQuery,
                  knownHandles,
                  showBridgeBadges: engine.settings.showBridgeBadges,
                  isDmMode: isDm,
                  isEncryptedContext,
                  isSenderTrusted: engine.isTrusted(msg.pubkey),
                  isSenderExplicitlyTrusted: !msg.isOwn && engine.isExplicitlyTrusted(msg.pubkey),
                  fetchVoiceMemoBlob: engine.fetchVoiceMemoBlob,
                  fetchImageAttachmentBlob: engine.fetchImageAttachmentBlob,
                  autoTranscribe: engine.transcription.autoTranscribe,
                  memoTranscript,
                  transcriptionModelStatus: engine.transcription.modelStatus,
                  transcriptionDownloadProgress: engine.transcription.downloadProgress,
                  activeTranscriptionModelLabel: engine.transcription.activeModel.label,
                  onTranscribeMemo: engine.transcription.transcribeVoiceMemo,
                  onOpenLightbox,
                  onTrustSender: handleTrustSender,
                  onUntrustSender: handleUntrustSender,
                  onBlockSender: handleBlockSender,
                  onStartDm,
                  onStartCall: handleStartCallSender,
                  onMentionAuthor: onMentionPeer,
                  onReply: !isDm ? handleReplyUnified : undefined,
                  onReact: !isDm ? handleReactUnified : undefined,
                  resolveReactorName: !isDm ? resolveReactorName : undefined,
                  onDelete:
                    isServer && !msg.isSystem && (engine.servers.canModerate || msg.isOwn)
                      ? handleDeleteServerMessage
                      : undefined,
                  onInspectAuthor: handleInspectAuthor,
                  onTuneGeohash: onTuneChannel,
                  onClickMention,
                  onJumpToMessage: handleJumpToMessage,
                  onCopyText: () => engine.pushToast('info', 'Copied to clipboard'),
                  onNotify: (title: string) => engine.pushToast('info', title),
                  contentFilter: engine.contentFilter,
                  senderLightningAddress: senderLud16,
                  canZapSender: senderCanZap,
                  zapTotalSats,
                  onOpenZap,
                  onClaimCashuToken,
                  compactTranslatorRow: translatorEnabled,
                }

                const messageNode = (
                  <MessageItem
                    {...sharedMessageProps}
                    actionsRevealed={activeActionMsgId === msg.id}
                    onToggleActions={setActiveActionMsgId}
                    displayContentOverride={displayContentOverride}
                    translationStatus={translationStatus}
                    translationLoadingLabel={translatorEnabled ? translationLoadingLabel : undefined}
                    translationError={translationError}
                    translationBadge={translationBadge}
                    onRetryTranslation={onRetryTranslation}
                    underlyingCollapsed={underlyingCollapsed}
                  />
                )

                return (
                  <React.Fragment key={msg.id}>
                    {showDateDivider && (
                      <div className="ag-date-divider" role="separator">
                        <span className="ag-date-pill">{formatDateHeading(msg.createdAt)}</span>
                      </div>
                    )}

                    {showUnreadDivider && (
                      <div className="ag-unread-divider" role="separator">
                        <span className="ag-unread-label">New messages</span>
                      </div>
                    )}

                    {translatorEnabled && !msg.isSystem ? (
                      <div
                        className={`ag-translator-pair ${underlyingCollapsed ? 'collapsed' : ''} ${grouped ? 'grouped' : ''}`}
                      >
                        <div className="ag-translator-cell translated">{messageNode}</div>

                        {!underlyingCollapsed && (
                          <div className="ag-translator-cell original" aria-label="Original chat message">
                            <MessageItem
                              {...sharedMessageProps}
                              actionsRevealed={activeActionMsgId === `${msg.id}-orig`}
                              onToggleActions={handleToggleOriginalActions}
                              isOriginalColumn
                            />
                          </div>
                        )}
                      </div>
                    ) : (
                      messageNode
                    )}
                  </React.Fragment>
                )
              })}
            </div>
          )}
        </div>
      </div>

      {showJumpBtn && (
        <button type="button" className="ag-jump-latest" onClick={scrollToLatest}>
          <ArrowDown size={15} />
          <span>
            {unseenBelow > 0
              ? `${unseenBelow} new ${unseenBelow === 1 ? 'message' : 'messages'}`
              : 'Jump to latest'}
          </span>
        </button>
      )}
    </div>
  )
}

export default MessageStream
