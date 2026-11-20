import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowDown,
  Crosshair,
  Lock,
  Radio,
  Terminal,
  Compass,
} from 'lucide-react'
import type { AgnostrEngine, GeoMessage, PeerInfo } from '../types/protocol'
import { MessageItem } from './MessageItem'
import { identiconDataUrl, formatHandle } from '../utils/identicon'

function buildFallbackPeer(
  pubkey: string,
  nickname: string,
  activeGeohash: string,
  isSelf: boolean,
  isBlocked: boolean
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
  onInspectPeer: (peer: PeerInfo) => void
  onStartDm: (pubkey: string, nickname?: string) => void
  onTuneChannel: (geohash: string) => void
  onClickMention: (mention: string) => void
  onLocateMe: () => void
  onOpenRadar: () => void
  onRunHelpCommand: () => void
}

export const MessageStream: React.FC<MessageStreamProps> = ({
  engine,
  searchQuery,
  activeSearchMessageId,
  onReply,
  onReact,
  onInspectPeer,
  onStartDm,
  onTuneChannel,
  onClickMention,
  onLocateMe,
  onOpenRadar,
  onRunHelpCommand,
}) => {
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const bottomRef = useRef<HTMLDivElement | null>(null)
  const stickToBottomRef = useRef(true)
  const [showJumpBtn, setShowJumpBtn] = useState(false)
  const [unseenBelow, setUnseenBelow] = useState(0)

  const isDm = engine.activeView.type === 'dm' && engine.activeDmThread !== null
  const dmThread = engine.activeDmThread
  const streamKey = isDm ? `dm:${dmThread?.peerPubkey}` : `ch:${engine.activeGeohash}`

  // Track which message IDs were already present when switching into a stream
  // so only newly arriving live transmissions animate in.
  const initialIdsRef = useRef<{ key: string; ids: Set<string> }>({
    key: '',
    ids: new Set(),
  })

  // Normalize DM messages into GeoMessage shape for unified high-craft rendering
  const displayMessages: GeoMessage[] = useMemo(() => {
    if (!isDm || !dmThread) return engine.messages
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
        deliveryStatus:
          dm.deliveryStatus === 'failed'
            ? 'failed'
            : dm.deliveryStatus === 'sending'
              ? 'sending'
              : 'sent',
      }
    })
  }, [isDm, dmThread, engine.messages, engine.identity.nickname, engine.activeGeohash])

  // Snapshot existing IDs on channel/DM switch & snap to bottom
  useEffect(() => {
    initialIdsRef.current = {
      key: streamKey,
      ids: new Set(displayMessages.map((m) => m.id)),
    }
    stickToBottomRef.current = true
    setShowJumpBtn(false)
    setUnseenBelow(0)
    requestAnimationFrame(() => {
      bottomRef.current?.scrollIntoView({ block: 'end' })
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
          bottomRef.current?.scrollIntoView({ block: 'end' })
        })
      } else {
        setUnseenBelow((c) => c + delta)
      }
    }
  }, [displayMessages.length])

  // Scroll to active search hit when navigating search results
  useEffect(() => {
    if (!activeSearchMessageId) return
    const el = document.getElementById(`msg-${activeSearchMessageId}`)
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }
  }, [activeSearchMessageId])

  const handleScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
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
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
    engine.markChannelRead()
  }, [engine])

  const handleJumpToMessage = useCallback((id: string) => {
    const el = document.getElementById(`msg-${id}`)
    if (!el) return
    el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    el.classList.add('is-search-active')
    window.setTimeout(() => el.classList.remove('is-search-active'), 1600)
  }, [])

  const handleInspectAuthor = useCallback(
    (pubkey: string, nickname: string) => {
      const existing = engine.getPeerByPubkey(pubkey)
      if (existing) {
        onInspectPeer(existing)
        return
      }
      onInspectPeer(
        buildFallbackPeer(
          pubkey,
          nickname,
          engine.activeGeohash,
          pubkey === engine.identity.activePubkey || pubkey === engine.identity.masterPubkey,
          engine.isPeerBlocked(pubkey)
        )
      )
    },
    [engine, onInspectPeer]
  )

  const hottestPulse = useMemo(() => {
    return engine.pulseRooms.find((r) => r.geohash !== engine.activeGeohash) ?? null
  }, [engine.pulseRooms, engine.activeGeohash])

  const ownNickLower = engine.identity.nickname.toLowerCase()
  const ownPubkey = engine.identity.activePubkey

  return (
    <div className="ag-stream-wrap">
      <div
        ref={scrollRef}
        className="ag-stream-scroll"
        onScroll={handleScroll}
        role="log"
        aria-live="polite"
        aria-relevant="additions"
      >
        <div className="ag-stream-inner">
          {displayMessages.length === 0 ? (
            isDm && dmThread ? (
              /* Encrypted DM Empty State */
              <div className="ag-empty-stage">
                <img
                  src={identiconDataUrl(dmThread.peerPubkey)}
                  alt=""
                  style={{ width: 64, height: 64, borderRadius: 16, boxShadow: 'var(--shadow-md)' }}
                />
                <div>
                  <h2 className="ag-empty-title">{dmThread.peerDisplayHandle}</h2>
                  <p className="ag-empty-sub" style={{ marginTop: 6 }}>
                    Direct messages are end-to-end encrypted using{' '}
                    <strong>
                      {dmThread.protocol === 'bitchat'
                        ? 'Bitchat v2 (XChaCha20-Poly1305)'
                        : 'NIP-17 / NIP-59 Gift-Wrap'}
                    </strong>{' '}
                    and relayed privately over Nostr.
                  </p>
                </div>
                <div className="ag-empty-telemetry">
                  <span className="ag-badge dm">
                    <Lock size={10} />
                    ZERO-METADATA GIFT WRAP
                  </span>
                </div>
              </div>
            ) : (
              /* Tactical Geohash Radar Listening Empty State */
              <div className="ag-empty-stage">
                <div className="ag-radar-beacon" aria-hidden="true">
                  <span className="ag-radar-ring" />
                  <span className="ag-radar-ring" />
                  <div className="ag-radar-core">
                    <Radio size={22} />
                  </div>
                </div>

                <div>
                  <h2 className="ag-empty-title">
                    Listening on <span style={{ color: 'var(--accent)' }}>#{engine.activeGeohash}</span>
                  </h2>
                  <p className="ag-empty-sub" style={{ marginTop: 6 }}>
                    {engine.cell.nearestCity ? `${engine.cell.nearestCity} · ` : ''}
                    {engine.cell.label} frequency ({engine.cell.approxSizeLabel}). Bitchat geohash
                    transmissions are ephemeral — say hello to broadcast live across{' '}
                    {engine.connectedRelayCount} connected relays!
                  </p>
                </div>

                <div className="ag-empty-telemetry">
                  <span className="ag-badge muted">
                    {engine.cell.center.lat.toFixed(3)}°, {engine.cell.center.lon.toFixed(3)}°
                  </span>
                  <span className={`ag-badge ${engine.isTeleported ? 'warn' : 'ok'}`}>
                    {engine.isTeleported ? 'TELEPORT MODE' : 'LOCAL GPS LOCK'}
                  </span>
                  {engine.cell.allowsPresence ? (
                    <span className="ag-badge ok">PRESENCE ACTIVE</span>
                  ) : (
                    <span className="ag-badge muted">HIGH-PRECISION PRIVACY</span>
                  )}
                </div>

                <div className="ag-empty-actions">
                  <button type="button" className="ag-cta-btn primary" onClick={onLocateMe}>
                    <Crosshair size={14} />
                    <span>Locate My Area (GPS)</span>
                  </button>

                  {hottestPulse ? (
                    <button
                      type="button"
                      className="ag-cta-btn"
                      onClick={() => onTuneChannel(hottestPulse.geohash)}
                    >
                      <Radio size={14} style={{ color: 'var(--status-ok)' }} />
                      <span>
                        Tune Live #{hottestPulse.geohash}
                        {hottestPulse.nearestCity ? ` (${hottestPulse.nearestCity})` : ''}
                      </span>
                    </button>
                  ) : (
                    <button type="button" className="ag-cta-btn" onClick={onOpenRadar}>
                      <Compass size={14} style={{ color: 'var(--accent)' }} />
                      <span>Open World Radar</span>
                    </button>
                  )}

                  <button type="button" className="ag-cta-btn" onClick={onRunHelpCommand}>
                    <Terminal size={14} />
                    <span>Slash Commands</span>
                  </button>
                </div>
              </div>
            )
          ) : (
            displayMessages.map((msg, idx) => {
              const prev = idx > 0 ? displayMessages[idx - 1] : null
              const showDateDivider = !prev || dateDayKey(prev.createdAt) !== dateDayKey(msg.createdAt)
              const showUnreadDivider =
                !isDm && engine.unreadDividerId !== null && msg.id === engine.unreadDividerId

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
                (msg.mentions.includes(ownPubkey) ||
                  (ownNickLower.length > 0 &&
                    msg.content.toLowerCase().includes(`@${ownNickLower}`)))

              return (
                <React.Fragment key={msg.id}>
                  {showDateDivider && (
                    <div className="ag-date-divider" role="separator">
                      <span className="ag-date-pill">{formatDateHeading(msg.createdAt)}</span>
                    </div>
                  )}

                  {showUnreadDivider && (
                    <div className="ag-unread-divider" role="separator">
                      <span className="ag-unread-label">New Transmissions</span>
                    </div>
                  )}

                  <MessageItem
                    message={msg}
                    grouped={grouped}
                    isLive={isLive}
                    isMentioned={isMentioned}
                    isSearchActive={activeSearchMessageId === msg.id}
                    highlightQuery={searchQuery}
                    showBridgeBadges={engine.settings.showBridgeBadges}
                    isDmMode={isDm}
                    dmProtocolLabel={
                      isDm && dmThread
                        ? dmThread.protocol === 'bitchat'
                          ? 'v2'
                          : 'NIP-17'
                        : undefined
                    }
                    onReply={!isDm ? onReply : undefined}
                    onReact={!isDm ? onReact : undefined}
                    onInspectAuthor={handleInspectAuthor}
                    onStartDm={!isDm ? onStartDm : undefined}
                    onTuneGeohash={onTuneChannel}
                    onClickMention={onClickMention}
                    onJumpToMessage={handleJumpToMessage}
                    onCopyText={() => engine.pushToast('info', 'Copied message text')}
                  />
                </React.Fragment>
              )
            })
          )}
          <div ref={bottomRef} style={{ height: 1 }} />
        </div>
      </div>

      {showJumpBtn && (
        <button type="button" className="ag-jump-latest" onClick={scrollToLatest}>
          <ArrowDown size={14} />
          <span>
            {unseenBelow > 0
              ? `${unseenBelow} new message${unseenBelow === 1 ? '' : 's'}`
              : 'Jump to latest'}
          </span>
        </button>
      )}
    </div>
  )
}

export default MessageStream
