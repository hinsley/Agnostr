import { dmReplyReference, dmTargetId } from '../lib/dmMessageActions.ts'
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import {
  AlertCircle,
  ArrowDown,
  Ban,
  Crosshair,
  Globe,
  Hash,
  Languages,
  Loader2,
  Lock,
  Map as MapIcon,
  Server,
  ShieldCheck,
  UserPlus,
  X,
} from 'lucide-react'
import type { AgnostrEngine, GeoMessage, PeerInfo } from '../types/protocol'
import type { ServerMessage } from '../types/servers'
import {
  resolveLanguageCodes,
  TRANSLATION_LANGUAGE_OPTIONS,
  TRANSLATOR_MODELS,
  translationCacheKey,
  type OutgoingOriginalEntry,
} from '../types/translator'
import { detectRoomDominantLanguage, isNonTranslatableText } from '../lib/languageDetect'
import type { ZapTarget } from '../types/wallet'
import type { ServerSettingsTab } from './ServerSettingsModal'
import type { LightboxImagePayload } from './ImageLightboxModal'
import { AvatarImg } from './AvatarImg'
import { MessageItem } from './MessageItem'
import { doesContentMentionUser } from '../lib/bitchatProtocol'
import {
  formatBitchatChannelLabel,
  getChannelBodyName,
  isTopicChannel,
  parseCelestialChannelKey,
} from '../lib/bitchatChannel'
import { isStuckMediaPlaceholder } from '../lib/storage'
import { parseInlineChatVoice } from '../lib/inlineChatVoice'
import { parseInlineChatImage } from '../lib/inlineChatImage'
import { getGroupSpecifier, hasUploadedGroupPicture } from '../utils/groupIcon'
import { formatHandle } from '../utils/identicon'

function extractCleanMessageText(msg: GeoMessage): string {
  let text = msg.imageAttachment?.inlineMarker
    ? (parseInlineChatImage(msg.content, msg.tags)?.caption ?? msg.content)
    : msg.content.trim()
  if (msg.voiceMemo?.inlineVoiceMarker) {
    text = parseInlineChatVoice(text, msg.tags)?.caption ?? text
  }
  if (!text) return ''
  for (const rawUrl of [msg.voiceMemo?.url, msg.imageAttachment?.inlineMarker ? undefined : msg.imageAttachment?.url]) {
    const target = rawUrl?.trim()
    if (!target) continue
    if (text === target) return ''
    text = text.split(target).join('')
  }
  return text.replace(/\n{3,}/g, '\n\n').trim()
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
const STICKY_REENGAGE_PX = 100
const UNSTICK_DELTA_PX = 2
const JUMP_BTN_THRESHOLD_PX = 160

interface MessageTranslationSpec {
  mode: 'skip' | 'own-original' | 'translate'
  textToTranslate?: string
  sourceLang?: string
  cacheKey?: string
  badge?: string
}

interface BlockedRunSender {
  pubkey: string
  displayHandle: string
  count: number
}

type StreamRenderItem =
  | { kind: 'message'; msg: GeoMessage }
  | {
      kind: 'blocked-run'
      id: string
      createdAt: number
      totalCount: number
      senders: BlockedRunSender[]
    }

function resolveMessageTranslationSpec(
  msg: GeoMessage,
  outgoingOrig: OutgoingOriginalEntry | undefined,
  myLanguage: string,
  explicitSourceLang: string | undefined
): MessageTranslationSpec {
  if (msg.isSystem || msg.isBlockedPlaceholder) return { mode: 'skip' }

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
  const innerRef = useRef<HTMLDivElement | null>(null)
  const stickToBottomRef = useRef(true)
  const lastScrollTopRef = useRef(0)
  const lastScrollHeightRef = useRef(0)
  const lastClientHeightRef = useRef(0)
  const smoothScrollToBottomRef = useRef(false)
  const smoothScrollTimerRef = useRef<number | null>(null)
  const lastUpwardInputAtRef = useRef(0)
  const touchDraggingUpRef = useRef(false)
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
  const [openBlockedRunId, setOpenBlockedRunId] = useState<string | null>(null)
  const [failedServerPictureUrl, setFailedServerPictureUrl] = useState<string | null>(null)

  useEffect(() => {
    if (!openBlockedRunId) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpenBlockedRunId(null)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [openBlockedRunId])

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

  const clearSmoothScrollGuard = useCallback(() => {
    smoothScrollToBottomRef.current = false
    if (smoothScrollTimerRef.current !== null) {
      window.clearTimeout(smoothScrollTimerRef.current)
      smoothScrollTimerRef.current = null
    }
  }, [])

  const isUpwardInputActive = useCallback(
    () => touchDraggingUpRef.current || Date.now() - lastUpwardInputAtRef.current < 260,
    []
  )

  useEffect(() => {
    return () => {
      if (smoothScrollTimerRef.current !== null) {
        window.clearTimeout(smoothScrollTimerRef.current)
        smoothScrollTimerRef.current = null
      }
    }
  }, [])

  const pinScrollToBottomNow = useCallback((el: HTMLDivElement) => {
    const targetTop = Math.max(0, el.scrollHeight - el.clientHeight)
    el.scrollTop = targetTop
    lastScrollTopRef.current = el.scrollTop
    lastScrollHeightRef.current = el.scrollHeight
    lastClientHeightRef.current = el.clientHeight
  }, [])

  const scrollContainerToBottom = useCallback(
    (smooth = false) => {
      const container = scrollRef.current
      if (!container) return
      const targetTop = Math.max(0, container.scrollHeight - container.clientHeight)
      if (smooth) {
        clearSmoothScrollGuard()
        smoothScrollToBottomRef.current = true
        lastUpwardInputAtRef.current = 0
        touchDraggingUpRef.current = false
        container.scrollTo({ top: targetTop, behavior: 'smooth' })
        const dist = Math.max(
          0,
          container.scrollHeight - container.scrollTop - container.clientHeight
        )
        if (dist <= 8) {
          smoothScrollToBottomRef.current = false
          lastScrollTopRef.current = container.scrollTop
          lastScrollHeightRef.current = container.scrollHeight
          lastClientHeightRef.current = container.clientHeight
        } else {
          smoothScrollTimerRef.current = window.setTimeout(() => {
            smoothScrollToBottomRef.current = false
            smoothScrollTimerRef.current = null
          }, 900)
        }
      } else {
        clearSmoothScrollGuard()
        pinScrollToBottomNow(container)
      }
    },
    [clearSmoothScrollGuard, pinScrollToBottomNow]
  )

  const scrollMessageIntoContainer = useCallback(
    (targetEl: HTMLElement, smooth = true) => {
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
      clearSmoothScrollGuard()
      if (maxTop - centeredTop > STICKY_REENGAGE_PX) {
        stickToBottomRef.current = false
      }
      container.scrollTo({ top: centeredTop, behavior: smooth ? 'smooth' : 'auto' })
    },
    [clearSmoothScrollGuard]
  )

  const isDm = engine.activeView.type === 'dm' && engine.activeDmThread !== null
  const isServer =
    engine.activeView.type === 'server' &&
    engine.servers.activeServer !== null &&
    engine.servers.activeChannel !== null
  const dmThread = engine.activeDmThread
  const activeServer = engine.servers.activeServer
  const activeChannel = engine.servers.activeChannel
  const activeServerPicture = activeServer?.picture?.trim() || ''
  const showServerPicture =
    hasUploadedGroupPicture(activeServerPicture) &&
    failedServerPictureUrl !== activeServerPicture
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

  const dmTargets = useMemo(() => {
    const byWire = new Map<string, NonNullable<typeof dmThread>['messages'][number]>()
    const localIds = new Set<string>()
    for (const m of dmThread?.messages ?? []) {
      const wireId = dmTargetId(m)
      if (wireId) { byWire.set(wireId, m); localIds.add(m.id) }
    }
    return { byWire, localIds }
  }, [dmThread])

  // Normalize DM & Server messages into GeoMessage shape for unified bubble rendering
  const displayMessages: GeoMessage[] = useMemo(() => {
    if (isServer && activeServer && activeChannel) {
      return engine.servers.messages
        .filter(
          (sm) =>
            !isStuckMediaPlaceholder(sm) &&
            (sm.isSystem ||
              (sm.serverId === activeServer.id && sm.channelId === activeChannel.id)) &&
            (sm.isOwn || sm.isSystem || sm.isBlockedPlaceholder || !engine.isPeerBlocked(sm.pubkey))
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
          isBlockedPlaceholder: sm.isBlockedPlaceholder,
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
          (m.isOwn || m.isSystem || m.isBlockedPlaceholder || !engine.isPeerBlocked(m.pubkey))
      ).map((m) => {
        if (m.isSystem || m.isBlockedPlaceholder) return m
        const image = !m.imageAttachment ? parseInlineChatImage(m.content, m.tags)?.image : undefined
        const voice = !m.voiceMemo ? parseInlineChatVoice(m.content, m.tags)?.memo : undefined
        return image || voice
          ? { ...m, imageAttachment: m.imageAttachment ?? image, voiceMemo: m.voiceMemo ?? voice }
          : m
      })
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
          reactions: dm.reactions ?? [],
          replyTo: dm.replyToId ? dmReplyReference(dm.replyToId, dmTargets.byWire.get(dm.replyToId),
            engine.identity.nickname, dmThread.peerNickname) : undefined,
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
    dmTargets,
  ])

  const hiddenEarlierCount = Math.max(0, displayMessages.length - renderLimit)
  const visibleMessages = useMemo(
    () => (hiddenEarlierCount > 0 ? displayMessages.slice(hiddenEarlierCount) : displayMessages),
    [displayMessages, hiddenEarlierCount]
  )

  // Coalesce consecutive blocked-message placeholders into a single ultra-compact run indicator
  const renderItems: StreamRenderItem[] = useMemo(() => {
    const items: StreamRenderItem[] = []
    for (const msg of visibleMessages) {
      if (!msg.isBlockedPlaceholder) {
        items.push({ kind: 'message', msg })
        continue
      }
      const pkKey = msg.pubkey.toLowerCase()
      const handleLabel = (msg.displayHandle || formatHandle(msg.nickname, msg.pubkey).full)
        .trim()
        .replace(/^@+/, '')
      const prev = items[items.length - 1]
      if (prev && prev.kind === 'blocked-run') {
        prev.totalCount += 1
        const existingSender = prev.senders.find((s) => s.pubkey.toLowerCase() === pkKey)
        if (existingSender) {
          existingSender.count += 1
        } else {
          prev.senders.push({ pubkey: msg.pubkey, displayHandle: handleLabel, count: 1 })
        }
      } else {
        items.push({
          kind: 'blocked-run',
          id: `blocked-${msg.id}`,
          createdAt: msg.createdAt,
          totalCount: 1,
          senders: [{ pubkey: msg.pubkey, displayHandle: handleLabel, count: 1 }],
        })
      }
    }
    return items
  }, [visibleMessages])

  // Prefetch verified kind: 0 profile pictures for visible authors and active DM peer
  const { ensureProfilePictures } = engine
  const visibleAvatarPubkeysKey = useMemo(() => {
    const seen = new Set<string>()
    const pks: string[] = []
    const addPk = (raw?: string | null) => {
      const pk = raw?.trim().toLowerCase()
      if (!pk || seen.has(pk)) return
      seen.add(pk)
      pks.push(pk)
    }
    if (isDm && dmThread) {
      addPk(dmThread.peerPubkey)
    }
    for (const msg of visibleMessages) {
      if (msg.isSystem || msg.isBlockedPlaceholder) continue
      addPk(msg.pubkey)
    }
    return pks.join(',')
  }, [isDm, dmThread, visibleMessages])

  useEffect(() => {
    if (!visibleAvatarPubkeysKey) return
    ensureProfilePictures(visibleAvatarPubkeysKey.split(','))
  }, [visibleAvatarPubkeysKey, ensureProfilePictures])

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
    lastScrollTopRef.current = el.scrollTop
    lastScrollHeightRef.current = el.scrollHeight
    lastClientHeightRef.current = el.clientHeight
  }, [visibleMessages.length])

  // Snapshot existing IDs on channel/DM switch, reset DOM window to latest 80, & snap to bottom synchronously
  useLayoutEffect(() => {
    initialIdsRef.current = {
      key: streamKey,
      ids: new Set(displayMessages.map((m) => m.id)),
    }
    stickToBottomRef.current = true
    clearSmoothScrollGuard()
    lastUpwardInputAtRef.current = 0
    touchDraggingUpRef.current = false
    streamSwitchedAtRef.current = Date.now()
    pendingScrollAnchorRef.current = null
    pendingJumpIdRef.current = null
    setRenderLimit(INITIAL_RENDER_LIMIT)
    setShowJumpBtn(false)
    setUnseenBelow(0)
    setActiveActionMsgId(null)
    setOpenBlockedRunId(null)
    const el = scrollRef.current
    if (el) {
      pinScrollToBottomNow(el)
    }
    const rafId = window.requestAnimationFrame(() => {
      if (stickToBottomRef.current && scrollRef.current) {
        pinScrollToBottomNow(scrollRef.current)
      }
    })
    return () => window.cancelAnimationFrame(rafId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streamKey])

  // Synchronously auto-pin on newly appended tail messages (including when room buffer is capped)
  // and exclude blocked placeholders from unseenBelow
  const nonPlaceholderCount = useMemo(
    () => displayMessages.reduce((acc, m) => (m.isBlockedPlaceholder ? acc : acc + 1), 0),
    [displayMessages]
  )
  const tailTrackerRef = useRef<{
    streamKey: string
    lastMsgId: string | null
    totalCount: number
    nonPlaceholderCount: number
    seenIds: Set<string>
  }>({
    streamKey: '',
    lastMsgId: null,
    totalCount: 0,
    nonPlaceholderCount: 0,
    seenIds: new Set(),
  })

  useLayoutEffect(() => {
    const lastMsg = displayMessages.length > 0 ? displayMessages[displayMessages.length - 1] : null
    const lastMsgId = lastMsg?.id ?? null
    const prev = tailTrackerRef.current

    if (prev.streamKey !== streamKey) {
      tailTrackerRef.current = {
        streamKey,
        lastMsgId,
        totalCount: displayMessages.length,
        nonPlaceholderCount,
        seenIds: new Set(displayMessages.map((m) => m.id)),
      }
      if (stickToBottomRef.current && scrollRef.current) {
        pinScrollToBottomNow(scrollRef.current)
      }
      return
    }

    let appendedTotal = 0
    let appendedReal = 0
    let hasOwnAppended = false

    if (lastMsgId !== null && lastMsgId !== prev.lastMsgId) {
      for (let i = displayMessages.length - 1; i >= 0; i -= 1) {
        const m = displayMessages[i]
        if (m.id === prev.lastMsgId || prev.seenIds.has(m.id)) break
        appendedTotal += 1
        if (!m.isBlockedPlaceholder) {
          appendedReal += 1
          if (m.isOwn) hasOwnAppended = true
        }
      }
    } else if (displayMessages.length > prev.totalCount && lastMsgId !== null && prev.lastMsgId === null) {
      appendedTotal = displayMessages.length
      appendedReal = nonPlaceholderCount
      hasOwnAppended = displayMessages.some((m) => m.isOwn && !m.isBlockedPlaceholder)
    }

    tailTrackerRef.current = {
      streamKey,
      lastMsgId,
      totalCount: displayMessages.length,
      nonPlaceholderCount,
      seenIds: new Set(displayMessages.map((m) => m.id)),
    }

    if (appendedTotal > 0) {
      if (hasOwnAppended) {
        stickToBottomRef.current = true
        clearSmoothScrollGuard()
        lastUpwardInputAtRef.current = 0
        touchDraggingUpRef.current = false
        setShowJumpBtn(false)
        setUnseenBelow(0)
        if (scrollRef.current) {
          pinScrollToBottomNow(scrollRef.current)
        }
      } else if (stickToBottomRef.current) {
        if (scrollRef.current) {
          pinScrollToBottomNow(scrollRef.current)
        }
      } else if (appendedReal > 0) {
        setUnseenBelow((c) => c + appendedReal)
        setShowJumpBtn(true)
      }
    }
  }, [streamKey, displayMessages, nonPlaceholderCount, clearSmoothScrollGuard, pinScrollToBottomNow])

  // Track direct upward user scroll input so smooth-scroll or height growth never fights the user
  useEffect(() => {
    const container = scrollRef.current
    if (!container) return

    let touchStartY = 0
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY < 0) {
        clearSmoothScrollGuard()
        lastUpwardInputAtRef.current = Date.now()
      } else if (e.deltaY > 0) {
        lastUpwardInputAtRef.current = 0
      }
    }
    const onTouchStart = (e: TouchEvent) => {
      clearSmoothScrollGuard()
      touchStartY = e.touches[0]?.clientY ?? 0
      touchDraggingUpRef.current = false
    }
    const onTouchMove = (e: TouchEvent) => {
      const y = e.touches[0]?.clientY ?? touchStartY
      if (y > touchStartY + 4) {
        // Finger moving down drags content down -> scrolling UP into older messages
        clearSmoothScrollGuard()
        touchDraggingUpRef.current = true
        lastUpwardInputAtRef.current = Date.now()
      } else if (y < touchStartY - 4) {
        touchDraggingUpRef.current = false
        lastUpwardInputAtRef.current = 0
      }
    }
    const onTouchEnd = () => {
      touchDraggingUpRef.current = false
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'PageUp' || e.key === 'ArrowUp' || e.key === 'Home') {
        clearSmoothScrollGuard()
        lastUpwardInputAtRef.current = Date.now()
      } else if (e.key === 'PageDown' || e.key === 'ArrowDown' || e.key === 'End') {
        lastUpwardInputAtRef.current = 0
      }
    }

    container.addEventListener('wheel', onWheel, { passive: true })
    container.addEventListener('touchstart', onTouchStart, { passive: true })
    container.addEventListener('touchmove', onTouchMove, { passive: true })
    container.addEventListener('touchend', onTouchEnd, { passive: true })
    container.addEventListener('touchcancel', onTouchEnd, { passive: true })
    container.addEventListener('keydown', onKeyDown)

    return () => {
      container.removeEventListener('wheel', onWheel)
      container.removeEventListener('touchstart', onTouchStart)
      container.removeEventListener('touchmove', onTouchMove)
      container.removeEventListener('touchend', onTouchEnd)
      container.removeEventListener('touchcancel', onTouchEnd)
      container.removeEventListener('keydown', onKeyDown)
    }
  }, [clearSmoothScrollGuard])

  // Keep pinned to latest message when inner content grows (images, transcripts, translations, reactions),
  // container resizes, or the mobile virtual keyboard / composer changes height
  useEffect(() => {
    const container = scrollRef.current
    const inner = innerRef.current
    if (!container) return
    lastClientHeightRef.current = container.clientHeight
    lastScrollHeightRef.current = container.scrollHeight
    lastScrollTopRef.current = container.scrollTop

    const handleResizeOrGrowth = () => {
      const el = scrollRef.current
      if (!el) return
      if (pendingScrollAnchorRef.current) return

      if (stickToBottomRef.current && !isUpwardInputActive()) {
        pinScrollToBottomNow(el)
      } else {
        lastClientHeightRef.current = el.clientHeight
        lastScrollHeightRef.current = el.scrollHeight
      }
      syncViewportRange()
    }

    const vv = window.visualViewport
    vv?.addEventListener('resize', handleResizeOrGrowth)

    const ro =
      typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(() => {
            handleResizeOrGrowth()
          })
        : null
    ro?.observe(container)
    if (inner) {
      ro?.observe(inner)
    }

    return () => {
      vv?.removeEventListener('resize', handleResizeOrGrowth)
      ro?.disconnect()
    }
  }, [isUpwardInputActive, pinScrollToBottomNow, syncViewportRange])

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
    if (pendingScrollAnchorRef.current) return

    const prevScrollTop = lastScrollTopRef.current
    const prevScrollHeight = lastScrollHeightRef.current
    const prevClientHeight = lastClientHeightRef.current

    const scrollTop = el.scrollTop
    const scrollHeight = el.scrollHeight
    const clientHeight = el.clientHeight
    const distFromBottom = Math.max(0, scrollHeight - scrollTop - clientHeight)

    // If container height just shrank (e.g. mobile keyboard opened) while anchored to bottom,
    // immediately re-pin instead of clearing stickToBottomRef.
    if (prevClientHeight > 0 && clientHeight < prevClientHeight - 4 && stickToBottomRef.current) {
      pinScrollToBottomNow(el)
      syncViewportRange()
      return
    }

    // Protect active "Jump to latest" smooth scroll from prematurely unsticking mid-animation
    if (smoothScrollToBottomRef.current) {
      const movedUp = scrollTop < prevScrollTop - UNSTICK_DELTA_PX
      if (movedUp || isUpwardInputActive()) {
        clearSmoothScrollGuard()
        if (distFromBottom > 48) {
          stickToBottomRef.current = false
        }
      } else {
        if (distFromBottom <= 8) {
          clearSmoothScrollGuard()
        }
        stickToBottomRef.current = true
        lastScrollTopRef.current = scrollTop
        lastScrollHeightRef.current = scrollHeight
        lastClientHeightRef.current = clientHeight
        setShowJumpBtn(false)
        if (unseenBelow > 0) {
          setUnseenBelow(0)
          engine.markChannelRead()
        }
        syncViewportRange()
        return
      }
    }

    const scrolledUp = scrollTop < prevScrollTop - UNSTICK_DELTA_PX
    const scrolledDownOrHeld = scrollTop >= prevScrollTop - UNSTICK_DELTA_PX
    const heightGrew = prevScrollHeight > 0 && scrollHeight > prevScrollHeight + 1

    if (stickToBottomRef.current) {
      if (scrolledUp && distFromBottom > 48) {
        // Genuine upward scroll: unstick immediately so scrolling up never fights the user
        stickToBottomRef.current = false
      } else if (scrolledDownOrHeld && heightGrew && !isUpwardInputActive()) {
        // Height grew beneath an anchored viewport without upward input: stay cleanly pinned
        pinScrollToBottomNow(el)
        setShowJumpBtn(false)
        if (unseenBelow > 0) {
          setUnseenBelow(0)
          engine.markChannelRead()
        }
        syncViewportRange()
        return
      } else if (distFromBottom > STICKY_REENGAGE_PX) {
        // Fallback unstick (e.g. scrollbar thumb drag upward or programmatic jump)
        stickToBottomRef.current = false
      }
    } else if (distFromBottom <= STICKY_REENGAGE_PX && scrolledDownOrHeld) {
      // Scrolled back down into the sticky bottom band: re-engage cleanly
      stickToBottomRef.current = true
      lastUpwardInputAtRef.current = 0
      touchDraggingUpRef.current = false
    }

    lastScrollTopRef.current = scrollTop
    lastScrollHeightRef.current = scrollHeight
    lastClientHeightRef.current = clientHeight

    const isStuck = stickToBottomRef.current
    if (isStuck) {
      setShowJumpBtn(false)
      if (unseenBelow > 0) {
        setUnseenBelow(0)
        engine.markChannelRead()
      }
    } else {
      setShowJumpBtn(
        (distFromBottom > JUMP_BTN_THRESHOLD_PX &&
          scrollHeight > clientHeight + JUMP_BTN_THRESHOLD_PX) ||
          unseenBelow > 0
      )
    }

    // Auto-expand earlier messages smoothly when scrolled near the top
    const now = Date.now()
    if (
      hiddenEarlierCount > 0 &&
      !isStuck &&
      scrollTop <= 48 &&
      scrollHeight > clientHeight + 80 &&
      now - streamSwitchedAtRef.current > 250 &&
      now - lastAutoExpandAtRef.current > 250
    ) {
      lastAutoExpandAtRef.current = now
      loadEarlierMessages()
    }

    syncViewportRange()
  }, [
    unseenBelow,
    engine,
    hiddenEarlierCount,
    loadEarlierMessages,
    clearSmoothScrollGuard,
    isUpwardInputActive,
    pinScrollToBottomNow,
    syncViewportRange,
  ])

  const scrollToLatest = useCallback(() => {
    stickToBottomRef.current = true
    lastUpwardInputAtRef.current = 0
    touchDraggingUpRef.current = false
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
      if (engine.activeView.type === 'dm') {
        engine.setDmReplyingTo(msg)
        return
      }
      if (isServer) {
        const sm = serverMsgById.get(msg.id)
        if (!sm) return
        if (onReplyServer) onReplyServer(sm)
        else engine.servers.setReplyingTo(sm)
        return
      }
      onReply(msg)
    },
    [isServer, serverMsgById, onReplyServer, engine, onReply]
  )

  const handleReactUnified = useCallback(
    (msg: GeoMessage, emoji: string) => {
      if (engine.activeView.type === 'dm') {
        void engine.sendDmReaction(engine.activeView.peerPubkey, msg.id, emoji)
        return
      }
      if (isServer) {
        const sm = serverMsgById.get(msg.id)
        if (!sm) return
        if (onReactServer) onReactServer(sm, emoji)
        else void engine.servers.sendReaction(sm, emoji)
        return
      }
      onReact(msg, emoji)
    },
    [isServer, serverMsgById, onReactServer, engine, onReact]
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
      if (msg.isSystem || msg.isBlockedPlaceholder) continue
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
      const isGeneric = /^a(?:gn|n)on[0-9a-f]{0,4}$/i.test(name)
      const existingIsGeneric = !existing || /^a(?:gn|n)on[0-9a-f]{0,4}$/i.test(existing)
      if (!existing || !isGeneric || existingIsGeneric) {
        map.set(pk, name)
      }
    }

    for (const msg of displayMessages) {
      if (msg.isSystem || msg.isBlockedPlaceholder) continue
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
      if (!m.isSystem && !m.isBlockedPlaceholder && m.id) ids.push(m.id)
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
      if (!m.isSystem && !m.isBlockedPlaceholder) {
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
      if (m.isSystem || m.isBlockedPlaceholder) continue
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
      if (!msg || msg.isSystem || msg.isBlockedPlaceholder || msg.id.startsWith('pending-')) continue
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
      if (!msg || msg.isSystem || msg.isBlockedPlaceholder || msg.id.startsWith('pending-')) return
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
      if (msg.isSystem || msg.isBlockedPlaceholder || msg.id.startsWith('pending-')) continue
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
                  <Languages size={11} />
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
        className="ag-stream-scroll"
        onScroll={handleScroll}
        onClick={(e) => {
          const target = e.target as HTMLElement | null
          if (activeActionMsgId && !target?.closest('.ag-msg-row')) {
            setActiveActionMsgId(null)
          }
          if (openBlockedRunId && !target?.closest('.ag-blocked-run-anchor')) {
            setOpenBlockedRunId(null)
          }
        }}
        role="log"
        aria-live="polite"
        aria-relevant="additions"
      >
        <div ref={innerRef} className="ag-stream-inner">
          {displayMessages.length === 0 ? (
            isDm && dmThread ? (
              /* Serene Encrypted DM Empty State */
              <div className="ag-empty-stage">
                <AvatarImg
                  pubkey={dmThread.peerPubkey}
                  pictureUrl={engine.getProfilePicture(dmThread.peerPubkey)}
                  alt=""
                  width={56}
                  height={56}
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
                  {showServerPicture ? (
                    <img
                      src={activeServerPicture}
                      alt=""
                      loading="lazy"
                      referrerPolicy="no-referrer"
                      onError={() => setFailedServerPictureUrl(activeServerPicture)}
                    />
                  ) : (
                    <span className="mono">
                      {getGroupSpecifier(activeServer.name, activeServer.icon)}
                    </span>
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
              /* Serene Geohash or Named Topic Bitchat Empty State */
              (() => {
                const activeIsTopic = isTopicChannel(engine.activeGeohash)
                const activeBitchatLabel = formatBitchatChannelLabel(engine.activeGeohash)
                const activeCelestial = !activeIsTopic
                  ? parseCelestialChannelKey(engine.activeGeohash)
                  : null
                const isNonEarthCelestial = Boolean(
                  activeCelestial && activeCelestial.bodyId !== 'earth'
                )
                const celestialBodyName = isNonEarthCelestial
                  ? getChannelBodyName(engine.activeGeohash)
                  : null
                const celestialLandmark =
                  isNonEarthCelestial &&
                  engine.cell.nearestCity &&
                  engine.cell.nearestCity !== celestialBodyName
                    ? engine.cell.nearestCity
                    : null
                const titleLocation = activeIsTopic
                  ? null
                  : isNonEarthCelestial
                    ? celestialBodyName
                    : engine.cell.nearestCity
                const emptySubtitle = activeIsTopic
                  ? 'Live topic channel — say hello to start chatting.'
                  : isNonEarthCelestial
                    ? celestialLandmark
                      ? `${celestialLandmark}, ${celestialBodyName} — say hello to start chatting.`
                      : `Live channel on ${celestialBodyName ?? 'this world'} — say hello to start chatting.`
                    : 'Say hello to start chatting with people nearby.'
                return (
              <div className="ag-empty-stage">
                <div className="ag-empty-bitchat-icon" aria-hidden="true">
                  {activeIsTopic ? <Hash size={26} /> : <Globe size={26} />}
                </div>

                <div className="ag-empty-copy">
                  <h2 className="ag-empty-title">
                    <span className="mono">{activeBitchatLabel}</span>
                    {titleLocation ? ` · ${titleLocation}` : ''}
                  </h2>
                  <p className="ag-empty-sub">{emptySubtitle}</p>
                </div>

                {!activeIsTopic && (
                  <div className="ag-empty-actions">
                    {!isNonEarthCelestial && (
                      <button type="button" className="ag-cta-btn primary" onClick={onLocateMe}>
                        <Crosshair size={15} />
                        <span>Locate Me</span>
                      </button>
                    )}

                    <button
                      type="button"
                      className={`ag-cta-btn ${isNonEarthCelestial ? 'primary' : ''}`}
                      onClick={onExpandRadar}
                    >
                      <MapIcon size={15} />
                      <span>{isNonEarthCelestial ? 'Open Globe' : 'Open Map'}</span>
                    </button>
                  </div>
                )}
              </div>
                )
              })()
            )
          ) : (
            <div>
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

              {renderItems.map((item, idx) => {
                const prevItem = idx > 0 ? renderItems[idx - 1] : null
                const prevCreatedAt = prevItem
                  ? prevItem.kind === 'message'
                    ? prevItem.msg.createdAt
                    : prevItem.createdAt
                  : null
                const itemCreatedAt = item.kind === 'message' ? item.msg.createdAt : item.createdAt
                const showDateDivider =
                  prevCreatedAt === null || dateDayKey(prevCreatedAt) !== dateDayKey(itemCreatedAt)

                if (item.kind === 'blocked-run') {
                  const isOpen = openBlockedRunId === item.id
                  const label =
                    item.totalCount === 1
                      ? '1 blocked message'
                      : `${item.totalCount} blocked messages`
                  const fallbackTitle = `Blocked senders: ${item.senders
                    .map((s) => (s.count > 1 ? `@${s.displayHandle} ×${s.count}` : `@${s.displayHandle}`))
                    .join(', ')}`

                  return (
                    <React.Fragment key={item.id}>
                      {showDateDivider && (
                        <div className="ag-date-divider" role="separator">
                          <span className="ag-date-pill">{formatDateHeading(item.createdAt)}</span>
                        </div>
                      )}

                      <div className="ag-blocked-run" role="note">
                        <div
                          className={`ag-blocked-run-anchor ${isOpen ? 'is-open' : ''} ${idx === 0 ? 'is-below' : ''}`}
                        >
                          <button
                            type="button"
                            className="ag-blocked-run-trigger tabular"
                            title={fallbackTitle}
                            aria-expanded={isOpen}
                            aria-describedby={`blocked-tip-${item.id}`}
                            onClick={(e) => {
                              e.stopPropagation()
                              setOpenBlockedRunId((curr) => (curr === item.id ? null : item.id))
                            }}
                          >
                            <Ban size={10} className="ag-blocked-run-icon" aria-hidden="true" />
                            <span>{label}</span>
                          </button>

                          <div
                            id={`blocked-tip-${item.id}`}
                            className="ag-blocked-run-tooltip"
                            role="tooltip"
                          >
                            <span className="ag-blocked-run-tooltip-head">Blocked senders</span>
                            <ul className="ag-blocked-run-tooltip-list">
                              {item.senders.map((sender) => (
                                <li key={sender.pubkey} className="ag-blocked-run-sender-row">
                                  <span className="ag-blocked-run-sender-handle mono truncate">
                                    @{sender.displayHandle}
                                  </span>
                                  {sender.count > 1 && (
                                    <span className="ag-blocked-run-sender-count tabular">
                                      ×{sender.count}
                                    </span>
                                  )}
                                </li>
                              ))}
                            </ul>
                          </div>
                        </div>
                      </div>
                    </React.Fragment>
                  )
                }

                const msg = item.msg
                const prev = prevItem?.kind === 'message' ? prevItem.msg : null
                const showUnreadDivider =
                  !isDm &&
                  !isServer &&
                  !msg.isBlockedPlaceholder &&
                  engine.unreadDividerId !== null &&
                  msg.id === engine.unreadDividerId

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
                const zapReceipts = !msg.isSystem
                  ? engine.zaps.zapReceiptsByEventId[msg.id]
                  : undefined

                // Compute single-column translation state + fine-print side inlay when Translator Mode is active
                let displayContentOverride: string | undefined
                let originalContentInlay: string | undefined
                let translationStatus: 'idle' | 'pending' | 'loading' | 'done' | 'error' | undefined
                let translationError: string | undefined
                let translationBadge: string | undefined
                let onRetryTranslation: (() => void) | undefined

                if (translatorEnabled && !msg.isSystem && !msg.isBlockedPlaceholder) {
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
                      const cleanSent = extractCleanMessageText(msg)
                      if (
                        cleanSent &&
                        cleanSent.trim().toLowerCase() !==
                          outgoingOrig.originalText.trim().toLowerCase()
                      ) {
                        originalContentInlay = cleanSent
                      }
                    } else if (spec.mode === 'translate' && spec.cacheKey && spec.textToTranslate) {
                      const tEntry = translations[spec.cacheKey]
                      if (spec.badge) {
                        translationBadge = spec.badge
                      }
                      if (tEntry?.status === 'done' && tEntry.text) {
                        displayContentOverride = tEntry.text
                        translationStatus = 'done'
                        const origText = spec.textToTranslate.trim()
                        const dispText = tEntry.text.trim()
                        if (
                          origText &&
                          dispText &&
                          !tEntry.sameLanguage &&
                          origText.toLowerCase() !== dispText.toLowerCase()
                        ) {
                          originalContentInlay = origText
                        }
                        if (
                          !explicitSourceLang &&
                          !spec.sourceLang &&
                          !spec.badge &&
                          !tEntry.sameLanguage
                        ) {
                          const detectedLang = tEntry.detectedSourceLang?.trim()
                          if (
                            detectedLang &&
                            detectedLang.toLowerCase() !== myLanguage.trim().toLowerCase() &&
                            resolveLanguageCodes(detectedLang).nllbCode !==
                              resolveLanguageCodes(myLanguage).nllbCode
                          ) {
                            translationBadge = `Translated from ${detectedLang}`
                          }
                        }
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

                    <MessageItem
                      message={msg}
                      grouped={grouped}
                      isLive={isLive}
                      isMentioned={isMentioned}
                      isSearchActive={activeSearchMessageId === msg.id}
                      highlightQuery={searchQuery}
                      knownHandles={knownHandles}
                      showBridgeBadges={engine.settings.showBridgeBadges}
                      allowUntrustedLinks={engine.settings.allowUntrustedLinks}
                      isDmMode={isDm}
                      isEncryptedContext={isEncryptedContext}
                      isSenderTrusted={engine.isTrusted(msg.pubkey)}
                      isSenderExplicitlyTrusted={!msg.isOwn && engine.isExplicitlyTrusted(msg.pubkey)}
                      canLoadVoiceMemo={engine.canLoadVoiceMemo(msg.pubkey)}
                      fetchVoiceMemoBlob={engine.fetchVoiceMemoBlob}
                      fetchImageAttachmentBlob={engine.fetchImageAttachmentBlob}
                      autoTranscribe={engine.transcription.autoTranscribe}
                      memoTranscript={memoTranscript}
                      transcriptionModelStatus={engine.transcription.modelStatus}
                      transcriptionDownloadProgress={engine.transcription.downloadProgress}
                      activeTranscriptionModelLabel={engine.transcription.activeModel.label}
                      onTranscribeMemo={engine.transcription.transcribeVoiceMemo}
                      onOpenLightbox={onOpenLightbox}
                      onTrustSender={handleTrustSender}
                      onUntrustSender={handleUntrustSender}
                      onBlockSender={handleBlockSender}
                      onStartDm={onStartDm}
                      onStartCall={handleStartCallSender}
                      onMentionAuthor={onMentionPeer}
                      onReply={!isDm || dmTargets.localIds.has(msg.id) ? handleReplyUnified : undefined}
                      onReact={!isDm || dmTargets.localIds.has(msg.id) ? handleReactUnified : undefined}
                      resolveReactorName={resolveReactorName}
                      onDelete={
                        isServer &&
                        !msg.isSystem &&
                        !msg.isBlockedPlaceholder &&
                        engine.servers.canDeleteMessages
                          ? handleDeleteServerMessage
                          : undefined
                      }
                      onInspectAuthor={handleInspectAuthor}
                      onTuneGeohash={onTuneChannel}
                      onClickMention={onClickMention}
                      onJumpToMessage={handleJumpToMessage}
                      onCopyText={() => engine.pushToast('info', 'Copied to clipboard')}
                      onNotify={(title: string) => engine.pushToast('info', title)}
                      contentFilter={engine.contentFilter}
                      senderAvatarUrl={engine.getProfilePicture(msg.pubkey)}
                      senderLightningAddress={senderLud16}
                      canZapSender={senderCanZap}
                      zapTotalSats={zapTotalSats}
                      zapReceipts={zapReceipts}
                      onOpenZap={onOpenZap}
                      onClaimCashuToken={onClaimCashuToken}
                      actionsRevealed={activeActionMsgId === msg.id}
                      onToggleActions={setActiveActionMsgId}
                      displayContentOverride={displayContentOverride}
                      originalContentInlay={originalContentInlay}
                      translationStatus={translationStatus}
                      translationLoadingLabel={translatorEnabled ? translationLoadingLabel : undefined}
                      translationError={translationError}
                      translationBadge={translationBadge}
                      onRetryTranslation={onRetryTranslation}
                      compactTranslatorRow={translatorEnabled}
                      underlyingCollapsed
                    />
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
