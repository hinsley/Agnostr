import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, Globe, Hash, Info, Link2, Pin, PinOff, X } from 'lucide-react'
import type { AgnostrEngine } from '../types/protocol'
import type { PwaState } from '../hooks/usePwa'
import type { SoundCue } from '../utils/sound'
import type { SettingsTab } from './SettingsModal'
import {
  buildBitchatChannelShareUrl,
  formatBitchatChannelLabel,
  getChannelBodyName,
  isTopicChannel,
} from '../lib/bitchatChannel'
import { selectBitchatDrawerChannels, type DrawerChannel } from '../lib/bitchatDrawerChannels'
import { UserProfileDock } from './UserProfileDock'

export interface BitchatChannelDrawerProps {
  engine: AgnostrEngine
  isMobileViewport?: boolean
  pwa?: PwaState
  onClose: () => void
  onBackToGlobe: () => void
  onTuneChannel: (channelKey: string) => boolean | void
  onOpenRoomInfo: () => void
  onOpenSettings: (tab?: SettingsTab) => void
  onOpenOwnAgoraProfile?: () => void
  onOpenInstall?: () => void
  onPlaySound?: (cue: SoundCue) => void
}

export function BitchatChannelDrawer({
  engine,
  isMobileViewport = true,
  pwa,
  onClose,
  onBackToGlobe,
  onTuneChannel,
  onOpenRoomInfo,
  onOpenSettings,
  onOpenOwnAgoraProfile,
  onOpenInstall,
  onPlaySound,
}: BitchatChannelDrawerProps) {
  const [copiedShare, setCopiedShare] = useState(false)
  const copyTimerRef = useRef<number | null>(null)
  const { activeGeohash, cell, mentionCounts, pinnedChannels, pulseRooms, unreadCounts } = engine
  const channelLabel = formatBitchatChannelLabel(activeGeohash)
  const isPinned = engine.isChannelPinned(activeGeohash)
  const channels = useMemo(
    () => selectBitchatDrawerChannels(pinnedChannels, pulseRooms, activeGeohash),
    [pinnedChannels, pulseRooms, activeGeohash],
  )

  useEffect(() => {
    setCopiedShare(false)
    return () => {
      if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current)
    }
  }, [activeGeohash])

  const handleShare = async () => {
    try {
      await navigator.clipboard.writeText(buildBitchatChannelShareUrl(activeGeohash))
      onPlaySound?.('click')
      engine.pushToast('success', 'Channel link copied', channelLabel)
      setCopiedShare(true)
      if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current)
      copyTimerRef.current = window.setTimeout(() => setCopiedShare(false), 1800)
    } catch {
      engine.pushToast('error', 'Unable to copy link')
    }
  }

  const renderChannel = ({ key, pin, pulse, selected }: DrawerChannel) => {
    const isTopic = isTopicChannel(key)
    const label = formatBitchatChannelLabel(key)
    const place = [pin?.label, pulse?.nearestCity, selected ? cell.nearestCity : null,
      !isTopic ? getChannelBodyName(key) : null].find((value) => value && value !== label && value !== 'Earth')
    const unread = Math.max(pin?.unreadCount ?? 0, unreadCounts[key] ?? 0)
    const mentions = Math.max(pin?.mentionCount ?? 0, mentionCounts[key] ?? 0)
    const peers = pulse?.peerCount ?? (selected && !engine.presence.isUncertainCount ? engine.presence.onlineCount : 0)
    const messages = pulse?.messageCount ?? 0
    const activity = peers > 0
      ? `${peers} active`
      : messages > 0 ? `${messages} recent ${messages === 1 ? 'message' : 'messages'}` : null
    return (
      <li key={key}>
        <button
          type="button"
          className={`ag-bitchat-drawer-row${selected ? ' is-selected' : ''}`}
          data-channel-key={key}
          aria-current={selected ? 'page' : undefined}
          onClick={() => {
            if (selected || onTuneChannel(key) !== false) onClose()
          }}
        >
          <span className="ag-bitchat-drawer-row-icon" aria-hidden="true">
            {isTopic ? <Hash size={15} /> : <Globe size={15} />}
          </span>
          <span className="ag-bitchat-drawer-row-copy">
            <span className="ag-bitchat-drawer-row-title mono truncate">{label}</span>
            {(place || activity) && (
              <span className="ag-bitchat-drawer-row-meta truncate">
                {[place, activity].filter(Boolean).join(' · ')}
              </span>
            )}
          </span>
          {mentions > 0 ? (
            <span className="ag-ping-badge tabular" aria-label={`${mentions} mentions`}>{mentions > 99 ? '99+' : mentions}</span>
          ) : unread > 0 ? (
            <span className="ag-unread-pill tabular" aria-label={`${unread} unread`}>{unread > 99 ? '99+' : unread}</span>
          ) : null}
          {selected && <Check className="ag-bitchat-drawer-current" size={15} aria-hidden="true" />}
        </button>
      </li>
    )
  }

  return (
    <aside id="ag-bitchat-channels" className="ag-conv-pane ag-bitchat-drawer" aria-label="Bitchat channels"
      data-mobile={isMobileViewport ? 'true' : undefined}>
      <div className="ag-bitchat-drawer-header">
        <h2>Channels</h2>
        <button type="button" className="ag-circle-btn" onClick={onBackToGlobe}
          aria-label="Open Bitchat globe" title="Globe">
          <Globe size={17} aria-hidden="true" />
        </button>
        <button type="button" className="ag-circle-btn" onClick={onClose}
          aria-label="Close Bitchat channels" title="Close">
          <X size={17} aria-hidden="true" />
        </button>
      </div>

      <div className="ag-bitchat-drawer-body">
        {channels.pinned.length > 0 && (
          <section className="ag-bitchat-drawer-section" aria-label="Pinned channels">
            <h3><Pin size={12} aria-hidden="true" /> Pinned</h3>
            <ul>{channels.pinned.map(renderChannel)}</ul>
          </section>
        )}
        <section className="ag-bitchat-drawer-section" aria-label="Active channels">
          <h3>Active channels</h3>
          {channels.live.length > 0 ? <ul>{channels.live.map(renderChannel)}</ul> : (
            <p className="ag-bitchat-drawer-empty">
              {channels.pinned.some((room) => room.pulse) ? 'All active channels are pinned.' : 'No recent activity in other channels.'}
            </p>
          )}
        </section>
        {channels.current && (
          <section className="ag-bitchat-drawer-section" aria-label="Current channel">
            <h3>Current channel</h3>
            <ul>{renderChannel(channels.current)}</ul>
          </section>
        )}
      </div>

      <div className="ag-bitchat-drawer-actions" role="group" aria-label={`Actions for ${channelLabel}`}>
        <button type="button" className="ag-bitchat-drawer-action-label mono truncate"
          aria-label={`Return to ${channelLabel}`} onClick={onClose}>
          {channelLabel}
        </button>
        <button type="button" className="ag-circle-btn" aria-pressed={isPinned}
          aria-label={isPinned ? 'Unpin current channel' : 'Pin current channel'}
          onClick={() => {
            onPlaySound?.('click')
            engine.togglePinChannel(activeGeohash,
              isTopicChannel(activeGeohash) ? undefined : cell.nearestCity ?? getChannelBodyName(activeGeohash) ?? undefined)
          }}>
          {isPinned ? <PinOff size={16} aria-hidden="true" /> : <Pin size={16} aria-hidden="true" />}
        </button>
        <button type="button" className="ag-circle-btn" aria-label="Copy current channel link" onClick={() => void handleShare()}>
          {copiedShare ? <Check size={16} aria-hidden="true" /> : <Link2 size={16} aria-hidden="true" />}
        </button>
        <button type="button" className="ag-circle-btn" aria-label="Current channel details" onClick={() => {
          onClose()
          onOpenRoomInfo()
        }}>
          <Info size={16} aria-hidden="true" />
        </button>
      </div>

      <UserProfileDock
        engine={engine}
        pwa={pwa}
        onOpenSettings={onOpenSettings}
        onOpenOwnAgoraProfile={onOpenOwnAgoraProfile}
        onOpenInstall={onOpenInstall}
        onPlaySound={onPlaySound}
      />
    </aside>
  )
}

export default BitchatChannelDrawer
