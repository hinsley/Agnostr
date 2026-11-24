import { useEffect, useMemo, useState, type MouseEvent as ReactMouseEvent } from 'react'
import {
  AtSign,
  Ban,
  Mail,
  MessageCircle,
  Search,
  ShieldCheck,
  ShieldOff,
  StickyNote,
  User,
  Users,
  X,
  Zap,
} from 'lucide-react'
import type { AgnostrEngine, PeerInfo } from '../types/protocol.ts'
import type { ZapTarget } from '../types/wallet.ts'
import type { SoundCue } from '../utils/sound.ts'
import { useContextMenu, type ContextMenuItem } from './ContextMenu.tsx'
import { formatHandle, identiconDataUrl, pubkeyToColor } from '../utils/identicon.ts'

export interface UserListPaneProps {
  engine: AgnostrEngine
  collapsed: boolean
  onCloseMobile: () => void
  onInspectPeer: (peer: PeerInfo) => void
  onStartDm: (pubkey: string, nickname?: string) => void
  onMentionPeer: (handle: string) => void
  onEditPeerNote: (peer: { pubkey: string; nickname: string; displayHandle: string }) => void
  onOpenZap?: (target: ZapTarget) => void
  onOpenAmailCompose?: (target: { pubkey: string; nickname?: string }) => void
  onPlaySound?: (cue: SoundCue) => void
}

interface NormalizedUserItem {
  pubkey: string
  npub: string
  nickname: string
  displayHandle: string
  isSelf: boolean
  isOnline: boolean
  isAgnostrClient: boolean
  clientName?: string
  isBlocked: boolean
  isTrusted: boolean
  isFounder?: boolean
  roleBadge?: string
  peerInfo: PeerInfo
}

interface UserListGroup {
  id: string
  label: string
  items: NormalizedUserItem[]
}

function formatRoleLabel(raw: string): string {
  const clean = raw.trim()
  if (!clean) return ''
  const lower = clean.toLowerCase()
  if (lower === 'moderator' || lower === 'mod') return 'Mod'
  if (lower === 'admin' || lower === 'administrator') return 'Admin'
  if (lower === 'founder' || lower === 'owner') return 'Founder'
  return clean.charAt(0).toUpperCase() + clean.slice(1)
}

export function UserListPane({
  engine,
  collapsed,
  onCloseMobile,
  onInspectPeer,
  onStartDm,
  onMentionPeer,
  onEditPeerNote,
  onOpenZap,
  onOpenAmailCompose,
  onPlaySound,
}: UserListPaneProps) {
  const { openContextMenu } = useContextMenu()
  const [filterQuery, setFilterQuery] = useState('')

  const { activeView, activeGeohash, activeDmThread, identity, servers, peers, peerNotes } = engine
  const activeServer = servers.activeServer

  // Reset filter query cleanly whenever the active view / channel changes
  const viewKey =
    activeView.type === 'channel'
      ? `ch:${activeGeohash}`
      : activeView.type === 'dm'
        ? `dm:${activeView.peerPubkey}`
        : `srv:${activeView.serverId}:${activeView.channelId}`

  useEffect(() => {
    setFilterQuery('')
  }, [viewKey])

  const headerTitle = activeView.type === 'server' ? 'Members' : 'People'

  const rawGroups = useMemo<UserListGroup[]>(() => {
    const nowSec = Math.floor(Date.now() / 1000)

    if (activeView.type === 'server') {
      const visibleMembers = servers.members.filter((m) => !m.isBanned)
      const staff: NormalizedUserItem[] = []
      const regulars: NormalizedUserItem[] = []

      for (const m of visibleMembers) {
        const pk = m.pubkey.toLowerCase()
        const known = engine.getPeerByPubkey(pk)
        const isAgnostr = m.isSelf
          ? Boolean(known?.isAgnostrClient ?? engine.broadcastClientTag)
          : Boolean(known?.isAgnostrClient)
        const clientName = known?.clientName ?? (isAgnostr ? 'agnostr' : undefined)
        const isOnline = m.isSelf ? true : Boolean(known?.isOnline)
        const isBlocked = !m.isSelf && engine.isPeerBlocked(pk)
        const isTrusted = !m.isSelf && engine.isExplicitlyTrusted(pk)
        const primaryRole = m.roles[0]?.trim() || ''
        const isStaff =
          m.isFounder ||
          m.isAdmin ||
          (Boolean(primaryRole) && primaryRole.toLowerCase() !== 'member')

        const roleBadge = m.isFounder
          ? 'Founder'
          : m.isAdmin
            ? 'Admin'
            : primaryRole && primaryRole.toLowerCase() !== 'member'
              ? formatRoleLabel(primaryRole)
              : m.isSelf
                ? 'You'
                : undefined

        const peerInfo: PeerInfo = known
          ? {
              ...known,
              nickname: m.nickname || known.nickname,
              displayHandle: m.displayHandle || known.displayHandle,
              isSelf: m.isSelf,
              isBlocked,
              isTrusted,
              isAgnostrClient: isAgnostr,
              clientName,
            }
          : {
              pubkey: pk,
              npub: m.npub,
              nickname: m.nickname,
              displayHandle: m.displayHandle,
              lastSeenAt: nowSec,
              isOnline,
              isSelf: m.isSelf,
              isTeleported: false,
              isMeshBridge: false,
              clientName,
              isAgnostrClient: isAgnostr,
              isBlocked,
              isTrusted,
              messageCount: 0,
              channels: [],
            }

        const item: NormalizedUserItem = {
          pubkey: pk,
          npub: m.npub,
          nickname: m.nickname,
          displayHandle: m.displayHandle,
          isSelf: m.isSelf,
          isOnline,
          isAgnostrClient: isAgnostr,
          clientName,
          isBlocked,
          isTrusted,
          isFounder: m.isFounder,
          roleBadge,
          peerInfo,
        }

        if (isStaff) staff.push(item)
        else regulars.push(item)
      }

      const sortMembers = (a: NormalizedUserItem, b: NormalizedUserItem) => {
        if (Boolean(a.isFounder) !== Boolean(b.isFounder)) return a.isFounder ? -1 : 1
        if (a.isSelf !== b.isSelf) return a.isSelf ? -1 : 1
        if (a.isOnline !== b.isOnline) return a.isOnline ? -1 : 1
        return a.nickname.localeCompare(b.nickname, undefined, { sensitivity: 'base' })
      }

      staff.sort(sortMembers)
      regulars.sort(sortMembers)

      const out: UserListGroup[] = []
      if (staff.length > 0) out.push({ id: 'staff', label: 'Staff', items: staff })
      if (regulars.length > 0) out.push({ id: 'members', label: 'Members', items: regulars })
      return out
    }

    if (activeView.type === 'dm') {
      const items: NormalizedUserItem[] = []
      if (activeDmThread) {
        const peerPk = activeDmThread.peerPubkey.toLowerCase()
        const knownPeer = engine.getPeerByPubkey(peerPk)
        const isAgnostr = Boolean(knownPeer?.isAgnostrClient)
        const clientName = knownPeer?.clientName ?? (isAgnostr ? 'agnostr' : undefined)
        const isBlocked = engine.isPeerBlocked(peerPk)
        const isTrusted = engine.isExplicitlyTrusted(peerPk)
        const isOnline = Boolean(knownPeer?.isOnline)

        const peerInfo: PeerInfo = knownPeer
          ? {
              ...knownPeer,
              nickname: activeDmThread.peerNickname || knownPeer.nickname,
              displayHandle: activeDmThread.peerDisplayHandle || knownPeer.displayHandle,
              isBlocked,
              isTrusted,
              isAgnostrClient: isAgnostr,
              clientName,
            }
          : {
              pubkey: peerPk,
              npub: activeDmThread.peerNpub,
              nickname: activeDmThread.peerNickname,
              displayHandle: activeDmThread.peerDisplayHandle,
              lastSeenAt: activeDmThread.lastMessageAt || nowSec,
              isOnline,
              isSelf: false,
              isTeleported: false,
              isMeshBridge: false,
              clientName,
              isAgnostrClient: isAgnostr,
              isBlocked,
              isTrusted,
              messageCount: activeDmThread.messages.length,
              channels: [],
            }

        items.push({
          pubkey: peerPk,
          npub: activeDmThread.peerNpub,
          nickname: activeDmThread.peerNickname,
          displayHandle: activeDmThread.peerDisplayHandle,
          isSelf: false,
          isOnline,
          isAgnostrClient: isAgnostr,
          clientName,
          isBlocked,
          isTrusted,
          peerInfo,
        })
      }

      const selfPk = identity.masterPubkey.toLowerCase()
      const knownSelf = engine.getPeerByPubkey(selfPk) ?? engine.getPeerByPubkey(identity.activePubkey)
      const selfIsAgnostr = Boolean(knownSelf?.isAgnostrClient ?? engine.broadcastClientTag)
      const selfClientName = knownSelf?.clientName ?? (selfIsAgnostr ? 'agnostr' : undefined)
      const selfHandle = formatHandle(identity.nickname, selfPk)
      const selfPeerInfo: PeerInfo = knownSelf
        ? {
            ...knownSelf,
            isSelf: true,
            isOnline: true,
            isAgnostrClient: selfIsAgnostr,
            clientName: selfClientName,
          }
        : {
            pubkey: selfPk,
            npub: identity.masterNpub,
            nickname: identity.nickname,
            displayHandle: selfHandle.full,
            lastSeenAt: nowSec,
            isOnline: true,
            isSelf: true,
            isTeleported: false,
            isMeshBridge: false,
            clientName: selfClientName,
            isAgnostrClient: selfIsAgnostr,
            isBlocked: false,
            isTrusted: true,
            messageCount: 0,
            channels: [],
          }

      items.push({
        pubkey: selfPk,
        npub: identity.masterNpub,
        nickname: identity.nickname,
        displayHandle: selfHandle.full,
        isSelf: true,
        isOnline: true,
        isAgnostrClient: selfIsAgnostr,
        clientName: selfClientName,
        isBlocked: false,
        isTrusted: false,
        roleBadge: 'You',
        peerInfo: selfPeerInfo,
      })

      return [{ id: 'in-chat', label: 'In This Chat', items }]
    }

    // Bitchat channel (`activeView.type === 'channel'`)
    const online: NormalizedUserItem[] = []
    const offline: NormalizedUserItem[] = []

    for (const p of peers) {
      const pk = p.pubkey.toLowerCase()
      const isAgnostr = p.isSelf
        ? Boolean(p.isAgnostrClient ?? engine.broadcastClientTag)
        : Boolean(p.isAgnostrClient)
      const isBlocked = !p.isSelf && engine.isPeerBlocked(pk)
      const isTrusted = !p.isSelf && engine.isExplicitlyTrusted(pk)

      const item: NormalizedUserItem = {
        pubkey: pk,
        npub: p.npub,
        nickname: p.nickname,
        displayHandle: p.displayHandle,
        isSelf: p.isSelf,
        isOnline: p.isOnline,
        isAgnostrClient: isAgnostr,
        clientName: p.clientName ?? (isAgnostr ? 'agnostr' : undefined),
        isBlocked,
        isTrusted,
        roleBadge: p.isSelf ? 'You' : undefined,
        peerInfo: {
          ...p,
          isBlocked,
          isTrusted,
          isAgnostrClient: isAgnostr,
        },
      }

      if (p.isOnline) online.push(item)
      else offline.push(item)
    }

    online.sort((a, b) => {
      if (a.isSelf !== b.isSelf) return a.isSelf ? -1 : 1
      return b.peerInfo.lastSeenAt - a.peerInfo.lastSeenAt
    })
    offline.sort((a, b) => b.peerInfo.lastSeenAt - a.peerInfo.lastSeenAt)

    const out: UserListGroup[] = []
    if (online.length > 0) out.push({ id: 'online', label: 'Online', items: online })
    if (offline.length > 0) out.push({ id: 'offline', label: 'Offline', items: offline })
    return out
  }, [activeView.type, servers.members, activeDmThread, identity, peers, engine])

  const totalCount = useMemo(
    () => rawGroups.reduce((sum, g) => sum + g.items.length, 0),
    [rawGroups],
  )

  const filteredGroups = useMemo<UserListGroup[]>(() => {
    const q = filterQuery.trim().toLowerCase()
    if (!q) return rawGroups
    const out: UserListGroup[] = []
    for (const group of rawGroups) {
      const matched = group.items.filter((item) => {
        const note = peerNotes[item.pubkey] ?? ''
        return (
          item.nickname.toLowerCase().includes(q) ||
          item.displayHandle.toLowerCase().includes(q) ||
          item.npub.toLowerCase().includes(q) ||
          note.toLowerCase().includes(q)
        )
      })
      if (matched.length > 0) {
        out.push({ ...group, items: matched })
      }
    }
    return out
  }, [rawGroups, filterQuery, peerNotes])

  const handleRowContextMenu = (e: ReactMouseEvent, item: NormalizedUserItem) => {
    const savedNote = peerNotes[item.pubkey] ?? ''
    const peerLud16 = !item.isSelf ? engine.zaps.getPeerLightningAddress(item.pubkey) : null
    const peerCanZap = !item.isSelf && engine.zaps.canZapPeer(item.pubkey)
    const items: ContextMenuItem[] = [
      {
        id: 'profile',
        label: 'View Profile',
        icon: <User size={14} />,
        onSelect: () => {
          onPlaySound?.('click')
          onInspectPeer(item.peerInfo)
          onCloseMobile()
        },
      },
    ]

    if (!item.isSelf) {
      items.push({
        id: 'dm',
        label: 'Direct Message',
        icon: <MessageCircle size={14} />,
        onSelect: () => {
          onPlaySound?.('click')
          onStartDm(item.pubkey, item.nickname)
          onCloseMobile()
        },
      })
    }

    items.push({
      id: 'mention',
      label: 'Mention',
      icon: <AtSign size={14} />,
      onSelect: () => {
        onPlaySound?.('click')
        onMentionPeer(item.displayHandle)
        onCloseMobile()
      },
    })

    if (!item.isSelf) {
      items.push({
        id: 'note',
        label: savedNote ? 'Edit Private Note' : 'Add Private Note',
        icon: <StickyNote size={14} />,
        onSelect: () => {
          onPlaySound?.('click')
          onEditPeerNote({
            pubkey: item.pubkey,
            nickname: item.nickname,
            displayHandle: item.displayHandle,
          })
          onCloseMobile()
        },
      })

      items.push({
        id: 'trust',
        label: item.isTrusted ? 'Remove Trust' : 'Trust',
        icon: item.isTrusted ? <ShieldOff size={14} /> : <ShieldCheck size={14} />,
        dividerBefore: true,
        onSelect: () => {
          onPlaySound?.('click')
          if (item.isTrusted) {
            engine.untrustPubkey(item.pubkey)
          } else {
            engine.trustPubkey(item.pubkey, item.nickname)
          }
        },
      })

      if (peerCanZap && onOpenZap) {
        items.push({
          id: 'zap',
          label: 'Zap',
          icon: <Zap size={14} />,
          onSelect: () => {
            onPlaySound?.('click')
            onOpenZap({
              pubkey: item.pubkey,
              nickname: item.nickname,
              lud16: peerLud16,
              channelLabel: item.displayHandle,
            })
            onCloseMobile()
          },
        })
      }

      if (onOpenAmailCompose) {
        items.push({
          id: 'agmail',
          label: 'Send Agmail',
          icon: <Mail size={14} />,
          onSelect: () => {
            onPlaySound?.('click')
            onOpenAmailCompose({ pubkey: item.pubkey, nickname: item.nickname })
            onCloseMobile()
          },
        })
      }

      items.push({
        id: 'block',
        label: item.isBlocked ? 'Unblock' : 'Mute / Block',
        icon: <Ban size={14} />,
        danger: !item.isBlocked,
        dividerBefore: true,
        onSelect: () => {
          onPlaySound?.('click')
          engine.toggleBlockPeer(item.pubkey, item.displayHandle)
        },
      })

      if (
        activeView.type === 'server' &&
        activeServer &&
        servers.canModerate &&
        !item.isFounder
      ) {
        items.push({
          id: 'ban',
          label: 'Ban from Group',
          icon: <Ban size={14} />,
          danger: true,
          onSelect: () => {
            onPlaySound?.('click')
            void servers.banMember(activeServer.id, item.pubkey)
          },
        })
      }
    }

    openContextMenu(e, {
      header: item.displayHandle,
      items,
    })
  }

  return (
    <aside className={`ag-users-pane ${collapsed ? 'collapsed' : ''}`} aria-label="User list">
      <header className="ag-users-header">
        <div className="ag-users-header-left">
          <Users size={15} className="ag-users-header-icon" aria-hidden="true" />
          <span className="ag-users-title">{headerTitle}</span>
          <span className="ag-users-count tabular">{totalCount}</span>
        </div>

        <button
          type="button"
          className="ag-circle-btn ag-mobile-only"
          onClick={() => {
            onPlaySound?.('click')
            onCloseMobile()
          }}
          aria-label="Close user list"
        >
          <X size={17} />
        </button>
      </header>

      {totalCount >= 6 && (
        <div className="ag-users-search-wrap">
          <Search size={13} className="ag-users-search-icon" aria-hidden="true" />
          <input
            type="text"
            className="ag-users-search"
            value={filterQuery}
            onChange={(e) => setFilterQuery(e.target.value)}
            placeholder={`Filter ${headerTitle.toLowerCase()}…`}
            aria-label={`Filter ${headerTitle.toLowerCase()}`}
          />
          {filterQuery && (
            <button
              type="button"
              className="ag-users-search-clear"
              onClick={() => setFilterQuery('')}
              aria-label="Clear filter"
            >
              <X size={12} />
            </button>
          )}
        </div>
      )}

      <div className="ag-users-scroll">
        {filteredGroups.length === 0 ? (
          <p className="ag-users-empty">
            {filterQuery.trim() ? 'No matching people' : 'No one here yet'}
          </p>
        ) : (
          filteredGroups.map((group) => (
            <section key={group.id} className="ag-users-group" aria-label={group.label}>
              <div className="ag-users-group-head">
                <span className="ag-users-group-label">{group.label}</span>
                <span className="ag-users-group-count tabular">{group.items.length}</span>
              </div>

              <div className="ag-users-list" role="list">
                {group.items.map((item) => {
                  const savedNote = !item.isSelf ? (peerNotes[item.pubkey] ?? '') : ''
                  const subline = savedNote
                    ? savedNote
                    : item.isBlocked
                      ? 'Muted'
                      : item.isOnline
                        ? 'Online'
                        : 'Recently active'

                  return (
                    <div
                      key={item.pubkey}
                      role="listitem"
                      tabIndex={0}
                      className={`ag-users-row ${item.isBlocked ? 'blocked' : ''}`}
                      onClick={() => {
                        onPlaySound?.('click')
                        onInspectPeer(item.peerInfo)
                        onCloseMobile()
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault()
                          onPlaySound?.('click')
                          onInspectPeer(item.peerInfo)
                          onCloseMobile()
                        }
                      }}
                      onContextMenu={(e) => handleRowContextMenu(e, item)}
                    >
                      <div className="ag-users-avatar-wrap">
                        <img
                          src={identiconDataUrl(item.pubkey)}
                          alt=""
                          width={32}
                          height={32}
                          className={`ag-users-avatar ${item.isAgnostrClient ? 'ag-avatar-agnostr' : ''}`}
                        />
                        {item.isOnline && (
                          <span className="ag-users-online-dot" aria-hidden="true" />
                        )}
                      </div>

                      <div className="ag-users-copy">
                        <div className="ag-users-name-row">
                          <span
                            className="ag-users-name truncate"
                            style={{ color: pubkeyToColor(item.pubkey) }}
                          >
                            {item.displayHandle}
                          </span>
                          {!item.isSelf && item.isTrusted && (
                            <span
                              className="ag-users-trust-icon"
                              aria-label="Trusted peer"
                            >
                              <ShieldCheck size={12} />
                            </span>
                          )}
                          {item.roleBadge && (
                            <span className="ag-users-role">{item.roleBadge}</span>
                          )}
                        </div>
                        <span
                          className={`ag-users-sub truncate ${
                            savedNote ? 'note' : item.isBlocked ? 'muted-peer' : ''
                          }`}
                        >
                          {subline}
                        </span>
                      </div>

                      {!item.isSelf && (
                        <button
                          type="button"
                          className="ag-users-dm-btn"
                          onClick={(e) => {
                            e.stopPropagation()
                            onPlaySound?.('click')
                            onStartDm(item.pubkey, item.nickname)
                            onCloseMobile()
                          }}
                          aria-label={`Message ${item.displayHandle}`}
                        >
                          <MessageCircle size={14} />
                        </button>
                      )}
                    </div>
                  )
                })}
              </div>
            </section>
          ))
        )}
      </div>
    </aside>
  )
}

export default UserListPane
