import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import {
  ArrowDown,
  Crosshair,
  Hash,
  Lock,
  Map as MapIcon,
  Radio,
  Server,
  ShieldCheck,
  UserPlus,
} from 'lucide-react'
import type { AgnostrEngine, GeoMessage, PeerInfo } from '../types/protocol'
import type { ServerMessage } from '../types/servers'
import type { ServerSettingsTab } from './ServerSettingsModal'
import type { LightboxImagePayload } from './ImageLightboxModal'
import { MessageItem } from './MessageItem'
import { doesContentMentionUser } from '../lib/bitchatProtocol'
import { formatRadioChannelLabel, isTopicChannel } from '../lib/radioChannel'
import { identiconDataUrl, formatHandle } from '../utils/identicon'

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
}) => {
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const stickToBottomRef = useRef(true)
  const lastClientHeightRef = useRef(0)
  const [showJumpBtn, setShowJumpBtn] = useState(false)
  const [unseenBelow, setUnseenBelow] = useState(0)
  const [activeActionMsgId, setActiveActionMsgId] = useState<string | null>(null)

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
            ? 'Unable to decrypt message — verify you have the latest server invite key.'
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
          (m.isSystem || m.geohash.toLowerCase() === activeKey) &&
          (m.isOwn || m.isSystem || !engine.isPeerBlocked(m.pubkey))
      )
    }
    return dmThread.messages.map((dm) => {
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

  // Snapshot existing IDs on channel/DM switch & snap to bottom
  useEffect(() => {
    initialIdsRef.current = {
      key: streamKey,
      ids: new Set(displayMessages.map((m) => m.id)),
    }
    stickToBottomRef.current = true
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
  }, [scrollContainerToBottom])

  // Scroll to active search hit when navigating search results (container-only, never scrolls window)
  useEffect(() => {
    if (!activeSearchMessageId) return
    const el = document.getElementById(`msg-${activeSearchMessageId}`)
    if (el) {
      scrollMessageIntoContainer(el, true)
    }
  }, [activeSearchMessageId, scrollMessageIntoContainer])

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
  }, [unseenBelow, engine])

  const scrollToLatest = useCallback(() => {
    stickToBottomRef.current = true
    setShowJumpBtn(false)
    setUnseenBelow(0)
    scrollContainerToBottom(true)
    engine.markChannelRead()
  }, [engine, scrollContainerToBottom])

  const handleJumpToMessage = useCallback(
    (id: string) => {
      const el = document.getElementById(`msg-${id}`)
      if (!el) return
      scrollMessageIntoContainer(el, true)
      el.classList.add('is-search-active')
      window.setTimeout(() => el.classList.remove('is-search-active'), 1600)
    },
    [scrollMessageIntoContainer]
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

  const hiddenCount = isServer
    ? engine.servers.hiddenByTrustCount
    : !isDm
      ? engine.hiddenByWhitelistCount
      : 0

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

      <div
        ref={scrollRef}
        className="ag-stream-scroll"
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
                        <span>Join Community</span>
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
                      ? 'Live topic channel (kind 23333) — say hello to start chatting.'
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
            displayMessages.map((msg, idx) => {
              const prev = idx > 0 ? displayMessages[idx - 1] : null
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
                    actionsRevealed={activeActionMsgId === msg.id}
                    highlightQuery={searchQuery}
                    knownHandles={knownHandles}
                    showBridgeBadges={engine.settings.showBridgeBadges}
                    isDmMode={isDm}
                    isEncryptedContext={isEncryptedContext}
                    isSenderTrusted={engine.isTrusted(msg.pubkey)}
                    isSenderExplicitlyTrusted={!msg.isOwn && engine.isExplicitlyTrusted(msg.pubkey)}
                    fetchVoiceMemoBlob={engine.fetchVoiceMemoBlob}
                    fetchImageAttachmentBlob={engine.fetchImageAttachmentBlob}
                    autoTranscribe={engine.transcription.autoTranscribe}
                    memoTranscript={memoTranscript}
                    transcriptionModelStatus={engine.transcription.modelStatus}
                    transcriptionDownloadProgress={engine.transcription.downloadProgress}
                    activeTranscriptionModelLabel={engine.transcription.activeModel.label}
                    onTranscribeMemo={engine.transcription.transcribeVoiceMemo}
                    onOpenLightbox={onOpenLightbox}
                    onToggleActions={setActiveActionMsgId}
                    onTrustSender={handleTrustSender}
                    onUntrustSender={handleUntrustSender}
                    onBlockSender={handleBlockSender}
                    onStartDm={onStartDm}
                    onStartCall={handleStartCallSender}
                    onMentionAuthor={onMentionPeer}
                    onReply={!isDm ? handleReplyUnified : undefined}
                    onReact={!isDm ? handleReactUnified : undefined}
                    onDelete={
                      isServer && !msg.isSystem && (engine.servers.canModerate || msg.isOwn)
                        ? handleDeleteServerMessage
                        : undefined
                    }
                    onInspectAuthor={handleInspectAuthor}
                    onTuneGeohash={onTuneChannel}
                    onClickMention={onClickMention}
                    onJumpToMessage={handleJumpToMessage}
                    onCopyText={() => engine.pushToast('info', 'Copied to clipboard')}
                    onNotify={(title) => engine.pushToast('info', title)}
                  />
                </React.Fragment>
              )
            })
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
