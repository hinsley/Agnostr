import React, { useCallback, useEffect, useMemo, useState } from 'react'
import {
  ChevronDown,
  ChevronUp,
  Compass,
  Flame,
  Loader2,
  MessageCircle,
  Network,
  RefreshCw,
  RotateCcw,
  Search,
  Shield,
  ShieldCheck,
  ShieldOff,
  Sparkles,
  User,
  Users,
  X,
} from 'lucide-react'
import type { AgnostrEngine } from '../../types/protocol.ts'
import { getProfileDisplayName } from '../../lib/agoraProtocol.ts'
import type { SoundCue } from '../../utils/sound.ts'
import type {
  AntiSlopMode,
  DiscoveryLens,
  DiscoveryTopicId,
  FollowPack,
  WotReachMode,
} from './types.ts'
import { useAgoraDiscovery } from './useAgoraDiscovery.ts'
import { WotGraphCanvas } from './WotGraphCanvas.tsx'
import { DiscoveredAccountCard, DiscoveredNoteCard, FollowPackCard } from './DiscoveryCards.tsx'
import './agoraDiscovery.css'

export interface AgoraDiscoveryViewProps {
  engine: AgnostrEngine
  initialSimilarPubkey?: string | null
  onConsumedInitialSimilar?: () => void
  onOpenProfile: (pubkey: string) => void
  onOpenThread: (noteId: string) => void
  onOpenArticle: (articleId: string) => void
  onOpenDm: (pubkey: string, nickname?: string) => void
  onPlaySound?: (cue: SoundCue) => void
}

const REACH_OPTIONS: ReadonlyArray<{ id: WotReachMode; label: string; title: string }> = [
  {
    id: 'strict',
    label: 'Strict WoT',
    title: 'Require multiple endorsements or trusted-peer backing',
  },
  {
    id: 'network',
    label: '2-Hop',
    title: 'Balanced 2-hop Web-of-Trust discovery',
  },
  {
    id: 'wide',
    label: 'Wide',
    title: 'Include broader high-signal voices, packs & long-form writers',
  },
]

const ANTI_SLOP_OPTIONS: ReadonlyArray<{ id: AntiSlopMode; label: string }> = [
  { id: 'strict', label: 'Strict' },
  { id: 'balanced', label: 'Balanced' },
  { id: 'off', label: 'Off' },
]

const TOPIC_OPTIONS: ReadonlyArray<{ id: DiscoveryTopicId; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'nostr', label: 'Nostr' },
  { id: 'bitcoin', label: 'Bitcoin' },
  { id: 'privacy', label: 'Privacy' },
  { id: 'dev', label: 'Dev' },
  { id: 'art', label: 'Art' },
  { id: 'writing', label: 'Writing' },
]

function describeProgressPhase(
  phase: 'idle' | 'seeds' | 'graph' | 'signals' | 'samples' | 'ready'
): string {
  switch (phase) {
    case 'seeds':
      return 'Mapping your trust & follow seeds…'
    case 'graph':
      return 'Crawling 2-hop Web-of-Trust follows…'
    case 'signals':
      return 'Scoring zaps, reposts & filtering slop…'
    case 'samples':
      return 'Fetching sample posts & follow packs…'
    default:
      return 'Building Web-of-Trust discovery graph…'
  }
}

export const AgoraDiscoveryView: React.FC<AgoraDiscoveryViewProps> = ({
  engine,
  initialSimilarPubkey = null,
  onConsumedInitialSimilar,
  onOpenProfile,
  onOpenThread,
  onOpenArticle,
  onOpenDm,
  onPlaySound,
}) => {
  const { agora } = engine
  const discovery = useAgoraDiscovery({ engine, initialSimilarPubkey })

  const [showCompactGraph, setShowCompactGraph] = useState(true)
  const [trustedOnlyPaths, setTrustedOnlyPaths] = useState(false)
  const [focusedGraphPubkey, setFocusedGraphPubkey] = useState<string | null>(null)
  const [similarPickerQuery, setSimilarPickerQuery] = useState('')

  const { setLens, setSimilarToPubkey } = discovery

  // Consume deep-linked "Similar" trigger from Profile header
  useEffect(() => {
    const clean = initialSimilarPubkey?.trim().toLowerCase()
    if (!clean) return
    setSimilarToPubkey(clean)
    setLens('graph')
    setFocusedGraphPubkey(clean)
    onConsumedInitialSimilar?.()
  }, [initialSimilarPubkey, setSimilarToPubkey, setLens, onConsumedInitialSimilar])

  const handleFindSimilar = useCallback(
    (pubkey: string) => {
      const clean = pubkey.trim().toLowerCase()
      if (!clean) return
      onPlaySound?.('click')
      discovery.setSimilarToPubkey(clean)
      discovery.setLens('graph')
      setFocusedGraphPubkey(clean)
    },
    [discovery, onPlaySound]
  )

  const handleInspectInGraph = useCallback(
    (pubkey: string) => {
      const clean = pubkey.trim().toLowerCase()
      if (!clean) return
      onPlaySound?.('click')
      setFocusedGraphPubkey(clean)
      discovery.setLens('graph')
    },
    [discovery, onPlaySound]
  )

  const handleFollowSingle = useCallback(
    async (pubkey: string) => {
      await agora.toggleFollow(pubkey)
    },
    [agora]
  )

  const handleFollowPackMembers = useCallback(
    async (pubkeys: string[]) => {
      const added = await discovery.followMultiple(pubkeys)
      if (added > 0) {
        engine.pushToast(
          'success',
          `Followed ${added} ${added === 1 ? 'account' : 'accounts'}`,
          'Your 2-hop Web-of-Trust graph will personalize around your new follows.'
        )
      } else {
        engine.pushToast('info', 'No new accounts followed', 'Selected accounts are already followed.')
      }
    },
    [discovery, engine]
  )

  const handleSavePackList = useCallback(
    async (pack: FollowPack, selectedPubkeys?: string[]) => {
      const ok = await discovery.savePackAsCustomList(pack, selectedPubkeys)
      if (ok) {
        engine.pushToast(
          'success',
          'Saved as Custom List',
          `"${pack.title}" is now available in your Agora feed filter bar.`
        )
      } else {
        engine.pushToast('error', 'Could not save custom list', 'Try again in a moment.')
      }
    },
    [discovery, engine]
  )

  const handleWidenReach = useCallback(() => {
    onPlaySound?.('click')
    if (discovery.prefs.topic !== 'all') {
      discovery.setTopic('all')
    }
    if (discovery.prefs.reach === 'strict') {
      discovery.setReach('network')
    } else if (discovery.prefs.reach === 'network') {
      discovery.setReach('wide')
    } else if (discovery.prefs.antiSlop === 'strict') {
      discovery.setAntiSlop('balanced')
    }
  }, [discovery, onPlaySound])

  const similarTargetPubkey = discovery.similarToPubkey?.trim().toLowerCase() || null
  const similarTargetProfile = similarTargetPubkey ? agora.getProfile(similarTargetPubkey) : null
  const similarTargetName = similarTargetPubkey
    ? getProfileDisplayName(similarTargetProfile, similarTargetPubkey)
    : ''

  // Quick-picker candidates for "Find Similar Voices" in Network Graph lens
  const similarPickerCandidates = useMemo(() => {
    const myPk = agora.myPubkey.trim().toLowerCase()
    const seen = new Set<string>()
    const pool: string[] = []
    const pushPk = (raw: string) => {
      const pk = raw.trim().toLowerCase()
      if (!pk || pk === myPk || seen.has(pk)) return
      seen.add(pk)
      pool.push(pk)
    }

    for (const entry of engine.trustedPubkeys) pushPk(entry.pubkey)
    for (const pk of agora.followingPubkeys) pushPk(pk)
    for (const acc of discovery.accounts) pushPk(acc.pubkey)

    const q = similarPickerQuery.trim().toLowerCase()
    const filtered = q
      ? pool.filter((pk) => {
          const prof = agora.getProfile(pk)
          const name = getProfileDisplayName(prof, pk).toLowerCase()
          const nip05 = (prof?.nip05 || '').toLowerCase()
          return name.includes(q) || nip05.includes(q) || pk.startsWith(q)
        })
      : pool

    return filtered.slice(0, 12)
  }, [agora, discovery.accounts, engine.trustedPubkeys, similarPickerQuery])

  const progressPct = useMemo(() => {
    const { loading, phase, seedsProcessed, seedsTotal } = discovery.progress
    if (!loading) return 100
    if (phase === 'seeds') return 15
    if (phase === 'graph') {
      if (seedsTotal > 0) {
        return Math.min(68, Math.max(22, Math.round(20 + (seedsProcessed / seedsTotal) * 48)))
      }
      return 38
    }
    if (phase === 'signals') return 78
    if (phase === 'samples') return 92
    return 10
  }, [discovery.progress])

  const ShieldIcon =
    discovery.prefs.antiSlop === 'off'
      ? ShieldOff
      : discovery.prefs.antiSlop === 'strict'
        ? ShieldCheck
        : Shield

  const lenses: ReadonlyArray<{
    id: DiscoveryLens
    label: string
    icon: typeof Sparkles
    count?: number
  }> = [
    { id: 'people', label: 'For You', icon: Sparkles, count: discovery.accounts.length },
    {
      id: 'trending',
      label: 'High-Signal',
      icon: Flame,
      count: discovery.highSignalNotes.length,
    },
    { id: 'packs', label: 'Follow Packs', icon: Users, count: discovery.followPacks.length },
    { id: 'graph', label: 'Network Graph', icon: Network },
  ]

  return (
    <div className="ag-disc-root" aria-label="Web-of-Trust Discovery">
      {/* 1. Experimental Header Banner */}
      <header className="ag-disc-banner">
        <div className="ag-disc-banner-top">
          <div className="ag-disc-banner-title-wrap">
            <span className="ag-disc-banner-icon" aria-hidden="true">
              <Compass size={17} />
            </span>
            <div className="ag-disc-banner-titles">
              <div className="ag-disc-banner-heading-row">
                <h2 className="ag-disc-banner-title">Web-of-Trust Discovery</h2>
                <span className="ag-disc-exp-pill">Experimental</span>
              </div>
              <p className="ag-disc-banner-status tabular" aria-live="polite">
                {discovery.progress.loading ? (
                  <>
                    <span>{describeProgressPhase(discovery.progress.phase)}</span>
                    {discovery.progress.seedsTotal > 0 && (
                      <span>
                        {' '}
                        ({discovery.progress.seedsProcessed}/{discovery.progress.seedsTotal})
                      </span>
                    )}
                  </>
                ) : (
                  <>
                    Mapped {discovery.seedCount}{' '}
                    {discovery.seedCount === 1 ? 'seed' : 'seeds'} · {discovery.accounts.length}{' '}
                    high-signal {discovery.accounts.length === 1 ? 'account' : 'accounts'} ·{' '}
                    {discovery.filteredSlopCount} slop filtered
                  </>
                )}
              </p>
            </div>
          </div>

          <div className="ag-disc-banner-actions">
            {discovery.dismissedCount > 0 && (
              <button
                type="button"
                className="ag-disc-banner-btn"
                onClick={() => {
                  onPlaySound?.('click')
                  discovery.clearDismissed()
                }}
                title="Restore dismissed recommendations"
              >
                <RotateCcw size={13} aria-hidden="true" />
                <span>Clear dismissed ({discovery.dismissedCount})</span>
              </button>
            )}
            <button
              type="button"
              className="ag-disc-banner-btn primary"
              disabled={discovery.progress.loading}
              onClick={() => {
                onPlaySound?.('click')
                discovery.refreshGraph()
              }}
              aria-label="Refresh Web-of-Trust discovery graph"
            >
              <RefreshCw
                size={13}
                className={discovery.progress.loading ? 'ag-agora-spin' : undefined}
                aria-hidden="true"
              />
              <span>Refresh</span>
            </button>
          </div>
        </div>

        {discovery.progress.loading && (
          <div
            className="ag-disc-progress-track"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={progressPct}
            aria-label="Building Web-of-Trust graph"
          >
            <div className="ag-disc-progress-fill" style={{ width: `${progressPct}%` }} />
          </div>
        )}
      </header>

      {/* 2. Algorithm Dial Controls */}
      <section className="ag-disc-dials" aria-label="Discovery algorithm controls">
        <div className="ag-disc-dial-row">
          <div className="ag-disc-dial-group" role="group" aria-label="Web-of-Trust reach">
            <span className="ag-disc-dial-label">Reach</span>
            <div className="ag-disc-seg-group">
              {REACH_OPTIONS.map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  className={`ag-disc-seg-btn${discovery.prefs.reach === opt.id ? ' active' : ''}`}
                  aria-pressed={discovery.prefs.reach === opt.id}
                  title={opt.title}
                  onClick={() => {
                    onPlaySound?.('click')
                    discovery.setReach(opt.id)
                  }}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          <div className="ag-disc-dial-group" role="group" aria-label="Anti-Slop shield">
            <span className="ag-disc-dial-label">
              <ShieldIcon size={13} aria-hidden="true" />
              <span>Anti-Slop</span>
            </span>
            <div className="ag-disc-seg-group">
              {ANTI_SLOP_OPTIONS.map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  className={`ag-disc-seg-btn${
                    discovery.prefs.antiSlop === opt.id ? ' active' : ''
                  }${opt.id === 'off' ? ' is-off' : ''}`}
                  aria-pressed={discovery.prefs.antiSlop === opt.id}
                  onClick={() => {
                    onPlaySound?.('click')
                    discovery.setAntiSlop(opt.id)
                  }}
                >
                  {opt.label}
                </button>
              ))}
            </div>
            {discovery.filteredSlopCount > 0 && discovery.prefs.antiSlop !== 'off' && (
              <span
                className="ag-disc-slop-badge tabular"
                title="Low-signal spam/slop items filtered out"
              >
                {discovery.filteredSlopCount} filtered
              </span>
            )}
          </div>
        </div>

        <div className="ag-disc-topics" role="group" aria-label="Topic focus">
          {TOPIC_OPTIONS.map((topic) => (
            <button
              key={topic.id}
              type="button"
              className={`ag-disc-topic-pill${
                discovery.prefs.topic === topic.id ? ' active' : ''
              }`}
              aria-pressed={discovery.prefs.topic === topic.id}
              onClick={() => {
                onPlaySound?.('click')
                discovery.setTopic(topic.id)
              }}
            >
              {topic.label}
            </button>
          ))}
        </div>
      </section>

      {/* 3. Four Lens Tabs */}
      <nav className="ag-disc-lenses" role="tablist" aria-label="Discovery lenses">
        {lenses.map((item) => {
          const Icon = item.icon
          const isActive = discovery.lens === item.id
          return (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={isActive}
              className={`ag-disc-lens-tab${isActive ? ' active' : ''}`}
              onClick={() => {
                onPlaySound?.('click')
                discovery.setLens(item.id)
              }}
            >
              <Icon size={14} aria-hidden="true" />
              <span>{item.label}</span>
              {typeof item.count === 'number' && item.count > 0 && (
                <span className="ag-disc-lens-count tabular">{item.count}</span>
              )}
            </button>
          )
        })}
      </nav>

      {/* 4. Active Lens Panel */}
      <div className="ag-disc-content" role="tabpanel">
        {/* ===== LENS 1: FOR YOU (PEOPLE) ===== */}
        {discovery.lens === 'people' && (
          <div className="ag-disc-pane">
            {discovery.isColdStart && (
              <div className="ag-disc-cold-callout" role="status">
                <Sparkles size={16} className="ag-disc-cold-icon" aria-hidden="true" />
                <div className="ag-disc-cold-copy">
                  <p className="ag-disc-cold-title">Personalize your Web-of-Trust</p>
                  <p className="ag-disc-cold-sub">
                    Follow or trust 3+ people (or pick a Follow Pack) to personalize your 2-hop
                    Web-of-Trust graph.
                  </p>
                </div>
                <button
                  type="button"
                  className="ag-disc-action-btn"
                  onClick={() => {
                    onPlaySound?.('click')
                    discovery.setLens('packs')
                  }}
                >
                  <Users size={13} aria-hidden="true" />
                  <span>Follow Packs</span>
                </button>
              </div>
            )}

            {/* Collapsible Compact 2-Hop WoT Graph Preview */}
            <div className="ag-disc-graph-preview-card">
              <div className="ag-disc-graph-preview-head">
                <div className="ag-disc-graph-preview-title">
                  <Network size={14} aria-hidden="true" />
                  <span>2-Hop Web-of-Trust Preview</span>
                </div>
                <button
                  type="button"
                  className="ag-disc-link-btn"
                  aria-expanded={showCompactGraph}
                  onClick={() => {
                    onPlaySound?.('click')
                    setShowCompactGraph((v) => !v)
                  }}
                >
                  <span>{showCompactGraph ? 'Hide Graph' : 'Show Graph'}</span>
                  {showCompactGraph ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
                </button>
              </div>
              {showCompactGraph && (
                <WotGraphCanvas
                  engine={engine}
                  nodes={discovery.graphNodes}
                  edges={discovery.graphEdges}
                  accounts={discovery.accounts}
                  compact
                  trustedOnlyPaths={trustedOnlyPaths}
                  onToggleTrustedOnlyPaths={() => setTrustedOnlyPaths((v) => !v)}
                  focusedPubkey={focusedGraphPubkey}
                  onOpenProfile={onOpenProfile}
                  onFindSimilar={handleFindSimilar}
                  onFollow={handleFollowSingle}
                  onDismiss={discovery.dismissAccount}
                  onPlaySound={onPlaySound}
                />
              )}
            </div>

            {/* Discovered Account Cards */}
            {discovery.progress.loading && discovery.accounts.length === 0 ? (
              <div className="ag-disc-loading-box" role="status">
                <Loader2 size={20} className="ag-agora-spin" aria-hidden="true" />
                <p className="ag-disc-empty-title">Scoring 2-hop Web-of-Trust voices…</p>
                <p className="ag-disc-empty-sub">
                  Sampling posts, verifying NIP-05 handles, and filtering out low-signal noise.
                </p>
              </div>
            ) : discovery.accounts.length > 0 ? (
              <div className="ag-disc-cards-list">
                {discovery.accounts.map((account) => (
                  <DiscoveredAccountCard
                    key={account.pubkey}
                    engine={engine}
                    account={account}
                    onOpenProfile={onOpenProfile}
                    onOpenThread={onOpenThread}
                    onOpenArticle={onOpenArticle}
                    onFindSimilar={handleFindSimilar}
                    onInspectInGraph={handleInspectInGraph}
                    onFollow={handleFollowSingle}
                    onDismiss={discovery.dismissAccount}
                    onPlaySound={onPlaySound}
                  />
                ))}
              </div>
            ) : (
              <div className="ag-disc-empty">
                <Compass size={22} aria-hidden="true" />
                <p className="ag-disc-empty-title">No accounts match these filters</p>
                <p className="ag-disc-empty-sub">
                  Try widening your Web-of-Trust reach, switching topic back to All, or relaxing the
                  Anti-Slop shield.
                </p>
                <div className="ag-disc-empty-actions">
                  {(discovery.prefs.reach !== 'wide' || discovery.prefs.topic !== 'all') && (
                    <button
                      type="button"
                      className="ag-disc-banner-btn primary"
                      onClick={handleWidenReach}
                    >
                      <span>Widen Reach</span>
                    </button>
                  )}
                  <button
                    type="button"
                    className="ag-disc-action-btn"
                    onClick={() => {
                      onPlaySound?.('click')
                      discovery.setLens('packs')
                    }}
                  >
                    <Users size={13} aria-hidden="true" />
                    <span>Browse Follow Packs</span>
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* ===== LENS 2: HIGH-SIGNAL NOTES ===== */}
        {discovery.lens === 'trending' && (
          <div className="ag-disc-pane">
            {discovery.progress.loading && discovery.highSignalNotes.length === 0 ? (
              <div className="ag-disc-loading-box" role="status">
                <Loader2 size={20} className="ag-agora-spin" aria-hidden="true" />
                <p className="ag-disc-empty-title">Finding high-signal notes…</p>
                <p className="ag-disc-empty-sub">
                  Ranking substantive posts endorsed by unique Web-of-Trust zappers and reposters.
                </p>
              </div>
            ) : discovery.highSignalNotes.length > 0 ? (
              <div className="ag-disc-cards-list">
                {discovery.highSignalNotes.map((item) => (
                  <DiscoveredNoteCard
                    key={item.note.id}
                    engine={engine}
                    item={item}
                    onOpenProfile={onOpenProfile}
                    onOpenThread={onOpenThread}
                    onFollow={handleFollowSingle}
                    onPlaySound={onPlaySound}
                  />
                ))}
              </div>
            ) : (
              <div className="ag-disc-empty">
                <Flame size={22} aria-hidden="true" />
                <p className="ag-disc-empty-title">No high-signal notes pass the current filter</p>
                <p className="ag-disc-empty-sub">
                  {discovery.filteredSlopCount > 0
                    ? `Filtered ${discovery.filteredSlopCount} low-signal notes. Widen reach or switch topic to explore more.`
                    : 'Widen your Web-of-Trust reach or refresh to pull more peer-endorsed notes.'}
                </p>
                <div className="ag-disc-empty-actions">
                  <button
                    type="button"
                    className="ag-disc-banner-btn primary"
                    onClick={handleWidenReach}
                  >
                    <span>Widen Reach</span>
                  </button>
                  <button
                    type="button"
                    className="ag-disc-action-btn"
                    onClick={() => {
                      onPlaySound?.('click')
                      discovery.refreshGraph()
                    }}
                  >
                    <RefreshCw size={13} aria-hidden="true" />
                    <span>Refresh</span>
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* ===== LENS 3: FOLLOW PACKS ===== */}
        {discovery.lens === 'packs' && (
          <div className="ag-disc-pane">
            {discovery.progress.loading && discovery.followPacks.length === 0 ? (
              <div className="ag-disc-loading-box" role="status">
                <Loader2 size={20} className="ag-agora-spin" aria-hidden="true" />
                <p className="ag-disc-empty-title">Loading curated Follow Packs…</p>
                <p className="ag-disc-empty-sub">
                  Querying kind 39089 &amp; 30000 packs with Web-of-Trust overlap.
                </p>
              </div>
            ) : discovery.followPacks.length > 0 ? (
              <div className="ag-disc-cards-list">
                {discovery.followPacks.map((pack) => (
                  <FollowPackCard
                    key={pack.id}
                    engine={engine}
                    pack={pack}
                    onFollowSelected={handleFollowPackMembers}
                    onSaveAsCustomList={handleSavePackList}
                    onOpenProfile={onOpenProfile}
                    onPlaySound={onPlaySound}
                  />
                ))}
              </div>
            ) : (
              <div className="ag-disc-empty">
                <Users size={22} aria-hidden="true" />
                <p className="ag-disc-empty-title">No Follow Packs found yet</p>
                <p className="ag-disc-empty-sub">
                  Refresh discovery to query connected social relays for curated Follow Packs.
                </p>
                <div className="ag-disc-empty-actions">
                  <button
                    type="button"
                    className="ag-disc-banner-btn primary"
                    onClick={() => {
                      onPlaySound?.('click')
                      discovery.refreshGraph()
                    }}
                  >
                    <RefreshCw size={13} aria-hidden="true" />
                    <span>Refresh Packs</span>
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* ===== LENS 4: FULL NETWORK GRAPH + SIMILAR VOICES ===== */}
        {discovery.lens === 'graph' && (
          <div className="ag-disc-pane">
            <WotGraphCanvas
              engine={engine}
              nodes={discovery.graphNodes}
              edges={discovery.graphEdges}
              accounts={discovery.accounts}
              compact={false}
              trustedOnlyPaths={trustedOnlyPaths}
              onToggleTrustedOnlyPaths={() => setTrustedOnlyPaths((v) => !v)}
              focusedPubkey={focusedGraphPubkey}
              onOpenProfile={onOpenProfile}
              onFindSimilar={handleFindSimilar}
              onFollow={handleFollowSingle}
              onDismiss={discovery.dismissAccount}
              onPlaySound={onPlaySound}
            />

            {/* Find Similar Voices Bar */}
            <section className="ag-disc-similar-section" aria-label="Find Similar Voices">
              <div className="ag-disc-similar-bar">
                <div className="ag-disc-similar-head">
                  <div className="ag-disc-similar-title-wrap">
                    <Compass size={15} aria-hidden="true" />
                    <h3 className="ag-disc-similar-title">Find Similar Voices</h3>
                  </div>

                  {similarTargetPubkey && (
                    <div className="ag-disc-similar-active-row">
                      <span className="ag-disc-similar-chip">
                        <span>Similar to</span>
                        <strong>@{similarTargetName}</strong>
                        <button
                          type="button"
                          className="ag-disc-similar-chip-clear"
                          onClick={() => {
                            onPlaySound?.('click')
                            discovery.setSimilarToPubkey(null)
                          }}
                          aria-label={`Clear similar voices filter for ${similarTargetName}`}
                        >
                          <X size={12} />
                        </button>
                      </span>
                      <button
                        type="button"
                        className="ag-disc-action-btn"
                        onClick={() => {
                          onPlaySound?.('click')
                          onOpenProfile(similarTargetPubkey)
                        }}
                      >
                        <User size={12} aria-hidden="true" />
                        <span>Profile</span>
                      </button>
                      <button
                        type="button"
                        className="ag-disc-action-btn"
                        onClick={() => {
                          onPlaySound?.('click')
                          onOpenDm(similarTargetPubkey, similarTargetName)
                        }}
                      >
                        <MessageCircle size={12} aria-hidden="true" />
                        <span>Message</span>
                      </button>
                    </div>
                  )}
                </div>

                {/* Pick any followed / known profile to find kindred accounts */}
                <div className="ag-disc-similar-picker">
                  <div className="ag-disc-similar-search-box">
                    <Search size={13} aria-hidden="true" />
                    <input
                      type="text"
                      className="ag-disc-similar-search"
                      value={similarPickerQuery}
                      onChange={(e) => setSimilarPickerQuery(e.target.value)}
                      placeholder="Pick a followed or known voice to find kindred accounts…"
                      aria-label="Filter people for similar voices"
                    />
                    {similarPickerQuery && (
                      <button
                        type="button"
                        className="ag-disc-similar-chip-clear"
                        onClick={() => setSimilarPickerQuery('')}
                        aria-label="Clear search"
                      >
                        <X size={12} />
                      </button>
                    )}
                  </div>

                  {similarPickerCandidates.length > 0 && (
                    <div className="ag-disc-similar-picks">
                      {similarPickerCandidates.map((pk) => {
                        const prof = agora.getProfile(pk)
                        const name = getProfileDisplayName(prof, pk)
                        const active = similarTargetPubkey === pk
                        return (
                          <button
                            key={pk}
                            type="button"
                            className={`ag-disc-similar-pick-btn${active ? ' active' : ''}`}
                            aria-pressed={active}
                            onClick={() => handleFindSimilar(pk)}
                          >
                            <span className="truncate">@{name}</span>
                          </button>
                        )
                      })}
                    </div>
                  )}
                </div>
              </div>

              {similarTargetPubkey ? (
                discovery.similarAccounts.length > 0 ? (
                  <div className="ag-disc-cards-list">
                    {discovery.similarAccounts.map((account) => (
                      <DiscoveredAccountCard
                        key={account.pubkey}
                        engine={engine}
                        account={account}
                        onOpenProfile={onOpenProfile}
                        onOpenThread={onOpenThread}
                        onOpenArticle={onOpenArticle}
                        onFindSimilar={handleFindSimilar}
                        onInspectInGraph={(pk) => setFocusedGraphPubkey(pk)}
                        onFollow={handleFollowSingle}
                        onDismiss={discovery.dismissAccount}
                        onPlaySound={onPlaySound}
                      />
                    ))}
                  </div>
                ) : (
                  <div className="ag-disc-empty compact">
                    <Compass size={18} aria-hidden="true" />
                    <p className="ag-disc-empty-title">
                      No kindred accounts matched @{similarTargetName} yet
                    </p>
                    <p className="ag-disc-empty-sub">
                      Try widening Reach above or pick another active voice from your network.
                    </p>
                  </div>
                )
              ) : (
                <p className="ag-disc-similar-hint">
                  Click any node in the graph above or pick a voice here to discover kindred
                  accounts ranked by shared Web-of-Trust overlap.
                </p>
              )}
            </section>
          </div>
        )}
      </div>
    </div>
  )
}

export default AgoraDiscoveryView
