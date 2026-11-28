import React, { useEffect, useId, useMemo, useRef, useState } from 'react'
import {
  BadgeCheck,
  Check,
  Compass,
  Loader2,
  ShieldCheck,
  Sparkles,
  User,
  UserPlus,
  X,
} from 'lucide-react'
import type { AgnostrEngine } from '../../types/protocol.ts'
import { getProfileDisplayName, sanitizeHttpUrl } from '../../lib/agoraProtocol.ts'
import { identiconDataUrl } from '../../utils/identicon.ts'
import type { SoundCue } from '../../utils/sound.ts'
import type { DiscoveredAccount, WotGraphEdge, WotGraphNode } from './types.ts'

export interface WotGraphCanvasProps {
  engine: AgnostrEngine
  nodes: WotGraphNode[]
  edges: WotGraphEdge[]
  accounts: DiscoveredAccount[]
  compact?: boolean
  trustedOnlyPaths?: boolean
  onToggleTrustedOnlyPaths?: () => void
  focusedPubkey?: string | null
  onOpenProfile: (pubkey: string) => void
  onFindSimilar: (pubkey: string) => void
  onFollow: (pubkey: string) => void
  onDismiss: (pubkey: string) => void
  onPlaySound?: (cue: SoundCue) => void
}

interface PositionedNode {
  node: WotGraphNode
  x: number
  y: number
  angle: number
  radius: number
}

const MAX_HOP1_SEEDS = 16
const MAX_HOP2_CANDIDATES = 20

const ROLE_STROKE: Record<WotGraphNode['role'], string> = {
  self: 'var(--accent, #22c55e)',
  trusted: '#10b981',
  following: '#3b82f6',
  local: '#8b5cf6',
  candidate: '#f59e0b',
}

const EDGE_STROKE: Record<WotGraphEdge['kind'], string> = {
  trust: '#10b981',
  follow: '#3b82f6',
  zap: '#f59e0b',
  repost: '#a855f7',
  local: '#8b5cf6',
}

function normalizeAngle(rad: number): number {
  let a = rad % (Math.PI * 2)
  if (a < 0) a += Math.PI * 2
  return a
}

function angularDelta(a: number, b: number): number {
  let d = b - a
  while (d > Math.PI) d -= Math.PI * 2
  while (d < -Math.PI) d += Math.PI * 2
  return d
}

function relaxAngles(items: Array<{ id: string; angle: number }>, minGap: number): Map<string, number> {
  if (items.length === 0) return new Map()
  if (items.length === 1) return new Map([[items[0].id, items[0].angle]])

  const sorted = items
    .map((item) => ({ id: item.id, angle: normalizeAngle(item.angle) }))
    .sort((a, b) => a.angle - b.angle)

  const gap = Math.min(minGap, (Math.PI * 2) / sorted.length)
  for (let iter = 0; iter < 16; iter += 1) {
    let moved = false
    for (let i = 0; i < sorted.length; i += 1) {
      const nextIdx = (i + 1) % sorted.length
      const curr = sorted[i]
      const next = sorted[nextIdx]
      let sep = next.angle - curr.angle
      if (nextIdx === 0) sep += Math.PI * 2
      if (sep < gap - 0.0005) {
        const push = (gap - sep) * 0.52
        curr.angle = normalizeAngle(curr.angle - push)
        next.angle = normalizeAngle(next.angle + push)
        moved = true
      }
    }
    sorted.sort((a, b) => a.angle - b.angle)
    if (!moved) break
  }

  return new Map(sorted.map((item) => [item.id, item.angle]))
}

function makeCurvedEdgePath(x1: number, y1: number, x2: number, y2: number, bend: number): string {
  const mx = (x1 + x2) / 2
  const my = (y1 + y2) / 2
  const dx = x2 - x1
  const dy = y2 - y1
  const len = Math.hypot(dx, dy) || 1
  const nx = -dy / len
  const ny = dx / len
  const qx = mx + nx * bend
  const qy = my + ny * bend
  return `M ${x1.toFixed(1)} ${y1.toFixed(1)} Q ${qx.toFixed(1)} ${qy.toFixed(1)} ${x2.toFixed(1)} ${y2.toFixed(1)}`
}

function useSafeScreenedPictures(
  engine: AgnostrEngine,
  pubkeys: readonly string[]
): Record<string, string> {
  const { agora, contentFilter } = engine
  const requestedRef = useRef<Set<string>>(new Set())

  const resolvedUrls = useMemo(() => {
    const out: Record<string, string> = {}
    for (const rawPk of pubkeys) {
      const pk = rawPk.trim().toLowerCase()
      if (!pk) continue
      const profile = agora.profilesByPubkey[pk]
      const clean = sanitizeHttpUrl(profile?.picture)
      if (!clean || !clean.startsWith('https://')) continue
      const cacheKey = `agora-img:${pk}:${clean}`
      const verdict = contentFilter.getVerdict(cacheKey)
      const blobUrl = verdict?.status === 'safe' ? contentFilter.getSafeImageObjectUrl(cacheKey) : null
      if (blobUrl) {
        out[pk] = blobUrl
      }
    }
    return out
  }, [agora.profilesByPubkey, contentFilter, pubkeys])

  useEffect(() => {
    for (const rawPk of pubkeys) {
      const pk = rawPk.trim().toLowerCase()
      if (!pk) continue
      const profile = agora.profilesByPubkey[pk]
      const clean = sanitizeHttpUrl(profile?.picture)
      if (!clean || !clean.startsWith('https://')) continue
      const cacheKey = `agora-img:${pk}:${clean}`
      const verdict = contentFilter.getVerdict(cacheKey)
      const blobUrl = verdict?.status === 'safe' ? contentFilter.getSafeImageObjectUrl(cacheKey) : null
      const needsScreen = !verdict || verdict.status === 'idle'
      const needsRehydrate = verdict?.status === 'safe' && !blobUrl
      if (!needsScreen && !needsRehydrate) continue
      if (requestedRef.current.has(cacheKey)) continue
      requestedRef.current.add(cacheKey)
      void contentFilter.screenExternalImageUrl(cacheKey, clean, pk)
    }
  }, [agora.profilesByPubkey, contentFilter, pubkeys])

  return resolvedUrls
}

export const WotGraphCanvas: React.FC<WotGraphCanvasProps> = ({
  engine,
  nodes,
  edges,
  accounts,
  compact = false,
  trustedOnlyPaths = false,
  onToggleTrustedOnlyPaths,
  focusedPubkey = null,
  onOpenProfile,
  onFindSimilar,
  onFollow,
  onDismiss,
  onPlaySound,
}) => {
  const { agora } = engine
  const svgInstanceId = useId().replace(/:/g, '')
  const [hoveredPk, setHoveredPk] = useState<string | null>(null)
  const [lockedPk, setLockedPk] = useState<string | null>(null)
  const [followBusyPk, setFollowBusyPk] = useState<string | null>(null)

  const width = 680
  const height = compact ? 310 : 420
  const cx = width / 2
  const cy = height / 2
  const r1 = compact ? 74 : 98
  const r2 = compact ? 128 : 172

  const accountByPk = useMemo(() => {
    const map = new Map<string, DiscoveredAccount>()
    for (const acc of accounts) {
      map.set(acc.pubkey.toLowerCase(), acc)
    }
    return map
  }, [accounts])

  // Build filtered radial layout: center self + up to 16 hop-1 seeds + up to 20 hop-2 candidates
  const layout = useMemo(() => {
    const myPk = agora.myPubkey.trim().toLowerCase()
    const selfNode: WotGraphNode =
      nodes.find((n) => n.role === 'self' || n.hop === 0) ?? {
        pubkey: myPk,
        role: 'self',
        hop: 0,
        score: 100,
        signalScore: 100,
        endorserCount: 0,
        trustedEndorserCount: 0,
      }
    const selfPk = selfNode.pubkey.trim().toLowerCase()

    const rolePriority: Record<WotGraphNode['role'], number> = {
      self: 0,
      trusted: 1,
      following: 2,
      local: 3,
      candidate: 4,
    }

    const hop1Candidates = nodes
      .filter((n) => n.hop === 1 && n.pubkey.toLowerCase() !== selfPk)
      .filter((n) => (!trustedOnlyPaths ? true : n.role === 'trusted'))
      .sort((a, b) => {
        if (rolePriority[a.role] !== rolePriority[b.role]) {
          return rolePriority[a.role] - rolePriority[b.role]
        }
        return b.score - a.score
      })
      .slice(0, MAX_HOP1_SEEDS)

    const hop1ByPk = new Map<string, PositionedNode>()
    const positioned: PositionedNode[] = [
      {
        node: selfNode,
        x: cx,
        y: cy,
        angle: 0,
        radius: compact ? 18 : 22,
      },
    ]

    const hop1Offset =
      hop1Candidates.length <= 1 ? Math.PI / 3 : Math.PI / hop1Candidates.length
    hop1Candidates.forEach((node, idx) => {
      const pk = node.pubkey.toLowerCase()
      const angle =
        -Math.PI / 2 + hop1Offset + (idx / Math.max(hop1Candidates.length, 1)) * Math.PI * 2
      const pos: PositionedNode = {
        node,
        x: cx + Math.cos(angle) * r1,
        y: cy + Math.sin(angle) * r1,
        angle,
        radius: node.role === 'trusted' ? (compact ? 14 : 16) : compact ? 12 : 14,
      }
      hop1ByPk.set(pk, pos)
      positioned.push(pos)
    })

    // Index hop-1 -> hop-2 endorsement edges for angular placement
    const seedEndorsersByCandidate = new Map<string, Array<{ seedAngle: number; weight: number }>>()
    for (const edge of edges) {
      const src = edge.source.toLowerCase()
      const tgt = edge.target.toLowerCase()
      const seedPos = hop1ByPk.get(src)
      if (!seedPos) continue
      const list = seedEndorsersByCandidate.get(tgt) ?? []
      list.push({ seedAngle: seedPos.angle, weight: Math.max(0.2, edge.weight || 1) })
      seedEndorsersByCandidate.set(tgt, list)
    }

    const hop2Pool = nodes
      .filter((n) => n.hop === 2 && !n.isDismissed && n.pubkey.toLowerCase() !== selfPk)
      .filter((n) => {
        if (!trustedOnlyPaths) return true
        const pk = n.pubkey.toLowerCase()
        return n.trustedEndorserCount > 0 || (seedEndorsersByCandidate.get(pk)?.length ?? 0) > 0
      })
      .sort((a, b) => b.signalScore - a.signalScore || b.score - a.score)
      .slice(0, MAX_HOP2_CANDIDATES)

    const hop2Offset = hop2Pool.length <= 1 ? Math.PI / 3 : Math.PI / hop2Pool.length
    const topLabelClearance = hop2Pool.length <= 12 ? 0.28 : 0.18
    const rawCandidateAngles = hop2Pool.map((node, idx) => {
      const pk = node.pubkey.toLowerCase()
      const endorsers = seedEndorsersByCandidate.get(pk)
      let baseAngle: number
      if (endorsers && endorsers.length > 0) {
        let sx = 0
        let sy = 0
        for (const e of endorsers) {
          sx += Math.cos(e.seedAngle) * e.weight
          sy += Math.sin(e.seedAngle) * e.weight
        }
        baseAngle = Math.hypot(sx, sy) > 0.001 ? Math.atan2(sy, sx) : endorsers[0].seedAngle
      } else {
        baseAngle = -Math.PI / 2 + hop2Offset + (idx / Math.max(hop2Pool.length, 1)) * Math.PI * 2
      }
      // Keep 12-o'clock ring labels unobstructed when seeds average directly upward
      const deltaFromTop = angularDelta(-Math.PI / 2, baseAngle)
      if (Math.abs(deltaFromTop) < topLabelClearance) {
        const dir = deltaFromTop === 0 ? (idx % 2 === 0 ? 1 : -1) : Math.sign(deltaFromTop)
        baseAngle = -Math.PI / 2 + dir * topLabelClearance
      }
      return { id: pk, angle: baseAngle }
    })

    const relaxed = relaxAngles(rawCandidateAngles, compact ? 0.29 : 0.27)
    for (const node of hop2Pool) {
      const pk = node.pubkey.toLowerCase()
      const angle = relaxed.get(pk) ?? 0
      const clampedSignal = Math.min(100, Math.max(0, node.signalScore))
      const radius = compact
        ? 11 + (clampedSignal / 100) * 4.5
        : 13 + (clampedSignal / 100) * 6.5
      positioned.push({
        node,
        x: cx + Math.cos(angle) * r2,
        y: cy + Math.sin(angle) * r2,
        angle,
        radius,
      })
    }

    const posByPk = new Map<string, PositionedNode>()
    for (const item of positioned) {
      posByPk.set(item.node.pubkey.toLowerCase(), item)
    }

    const visibleEdges: Array<WotGraphEdge & { key: string; from: PositionedNode; to: PositionedNode }> = []
    const edgeKeySet = new Set<string>()
    for (const edge of edges) {
      const src = edge.source.toLowerCase()
      const tgt = edge.target.toLowerCase()
      if (src === tgt) continue
      const from = posByPk.get(src)
      const to = posByPk.get(tgt)
      if (!from || !to) continue
      if (trustedOnlyPaths && from.node.hop === 0 && to.node.role !== 'trusted') continue
      if (trustedOnlyPaths && from.node.hop === 1 && from.node.role !== 'trusted') continue
      const key = `${src}->${tgt}:${edge.kind}`
      if (edgeKeySet.has(key)) continue
      edgeKeySet.add(key)
      visibleEdges.push({ ...edge, source: src, target: tgt, key, from, to })
    }

    // Ensure every visible hop-1 seed has an edge from self so visual trust chains always connect
    for (const seed of hop1Candidates) {
      const spk = seed.pubkey.toLowerCase()
      const hasSelfEdge = visibleEdges.some((e) => e.source === selfPk && e.target === spk)
      const from = posByPk.get(selfPk)
      const to = posByPk.get(spk)
      if (!hasSelfEdge && from && to) {
        const kind: WotGraphEdge['kind'] =
          seed.role === 'trusted' ? 'trust' : seed.role === 'local' ? 'local' : 'follow'
        const key = `${selfPk}->${spk}:${kind}`
        visibleEdges.push({
          source: selfPk,
          target: spk,
          weight: seed.role === 'trusted' ? 3 : 1,
          kind,
          key,
          from,
          to,
        })
      }
    }

    return {
      selfPk,
      positioned,
      posByPk,
      visibleEdges,
      defaultInspectPk: hop2Pool[0]?.pubkey.toLowerCase() ?? hop1Candidates[0]?.pubkey.toLowerCase() ?? selfPk,
    }
  }, [agora.myPubkey, nodes, edges, trustedOnlyPaths, cx, cy, r1, r2, compact])

  const allVisiblePubkeys = useMemo(
    () => layout.positioned.map((p) => p.node.pubkey.toLowerCase()),
    [layout.positioned]
  )

  useEffect(() => {
    if (allVisiblePubkeys.length > 0) {
      agora.ensureProfiles(allVisiblePubkeys)
    }
  }, [agora, allVisiblePubkeys])

  const safePictures = useSafeScreenedPictures(engine, allVisiblePubkeys)

  const cleanFocusedPk = focusedPubkey ? focusedPubkey.trim().toLowerCase() : null
  const activePk =
    (hoveredPk && layout.posByPk.has(hoveredPk) ? hoveredPk : null) ??
    (lockedPk && layout.posByPk.has(lockedPk) ? lockedPk : null) ??
    (cleanFocusedPk && layout.posByPk.has(cleanFocusedPk) ? cleanFocusedPk : null)

  // Compute exact highlighted paths when a node is hovered or locked
  const highlightState = useMemo(() => {
    if (!activePk) return null
    const activePos = layout.posByPk.get(activePk)
    if (!activePos) return null

    const highlightedNodes = new Set<string>([activePk])
    const highlightedEdges = new Set<string>()

    if (activePos.node.hop === 0) {
      for (const e of layout.visibleEdges) {
        if (e.source === activePk) {
          highlightedEdges.add(e.key)
          highlightedNodes.add(e.target)
        }
      }
    } else if (activePos.node.hop === 1) {
      highlightedNodes.add(layout.selfPk)
      for (const e of layout.visibleEdges) {
        if (
          (e.source === layout.selfPk && e.target === activePk) ||
          e.source === activePk
        ) {
          highlightedEdges.add(e.key)
          highlightedNodes.add(e.source)
          highlightedNodes.add(e.target)
        }
      }
    } else {
      const endorserSeeds = new Set<string>()
      for (const e of layout.visibleEdges) {
        if (e.target === activePk) {
          highlightedEdges.add(e.key)
          highlightedNodes.add(e.source)
          endorserSeeds.add(e.source)
        }
      }
      if (endorserSeeds.size > 0) {
        highlightedNodes.add(layout.selfPk)
        for (const e of layout.visibleEdges) {
          if (e.source === layout.selfPk && endorserSeeds.has(e.target)) {
            highlightedEdges.add(e.key)
          }
        }
      }
    }

    return { highlightedNodes, highlightedEdges }
  }, [activePk, layout])

  const inspectedPk = activePk ?? layout.defaultInspectPk
  const inspectedPos = layout.posByPk.get(inspectedPk) ?? layout.positioned[0]
  const inspectedNode = inspectedPos?.node
  const inspectedAccount = inspectedNode ? accountByPk.get(inspectedNode.pubkey.toLowerCase()) : undefined
  const inspectedProfile = inspectedNode ? agora.getProfile(inspectedNode.pubkey) : null
  const inspectedName = inspectedNode
    ? getProfileDisplayName(inspectedProfile, inspectedNode.pubkey)
    : 'You'
  const inspectedIsSelf = inspectedNode?.role === 'self' || inspectedNode?.hop === 0
  const inspectedFollowing = inspectedNode && !inspectedIsSelf && agora.isFollowing(inspectedNode.pubkey)

  const inspectedPathSummary = useMemo(() => {
    if (!inspectedNode) return ''
    const pk = inspectedNode.pubkey.toLowerCase()
    if (inspectedNode.hop === 0) {
      const seedCount = layout.positioned.filter((p) => p.node.hop === 1).length
      const candCount = layout.positioned.filter((p) => p.node.hop === 2).length
      return `Center of your Web-of-Trust · ${seedCount} active seeds illuminating ${candCount} high-signal voices`
    }
    if (inspectedNode.hop === 1) {
      const endorsedTargets = layout.visibleEdges.filter((e) => e.source === pk).length
      const roleWord =
        inspectedNode.role === 'trusted'
          ? 'Trusted Peer (3× weight)'
          : inspectedNode.role === 'local'
            ? 'Local Bitchat/DM peer (0.5× weight)'
            : 'Following (1× weight)'
      return `${roleWord} · Endorses ${endorsedTargets} discovered ${endorsedTargets === 1 ? 'account' : 'accounts'} in view`
    }

    // Candidate node: list specific endorser names (trusted first!)
    const incomingSeeds = layout.visibleEdges
      .filter((e) => e.target === pk && e.source !== layout.selfPk)
      .map((e) => e.source)
    const trustedSet = new Set(inspectedAccount?.trustedEndorsers.map((p) => p.toLowerCase()) ?? [])
    const combinedSeeds = Array.from(
      new Set([
        ...(inspectedAccount?.trustedEndorsers.map((p) => p.toLowerCase()) ?? []),
        ...(inspectedAccount?.endorsers.map((p) => p.toLowerCase()) ?? []),
        ...incomingSeeds,
      ])
    )
    if (combinedSeeds.length > 0) {
      const topLabels = combinedSeeds.slice(0, 2).map((epk) => {
        const name = getProfileDisplayName(agora.getProfile(epk), epk)
        const isTrustedSeed =
          trustedSet.has(epk) || layout.posByPk.get(epk)?.node.role === 'trusted'
        return isTrustedSeed ? `@${name} (Trusted)` : `@${name}`
      })
      const remaining = Math.max(0, combinedSeeds.length - topLabels.length)
      return remaining > 0
        ? `Endorsed by ${topLabels.join(', ')} + ${remaining} more`
        : `Endorsed by ${topLabels.join(', ')}`
    }
    if (inspectedAccount?.reasons[0]) {
      return inspectedAccount.reasons[0]
    }
    return `2-hop high-signal discovery · Signal ${Math.round(inspectedNode.signalScore)}/100`
  }, [inspectedNode, inspectedAccount, layout, agora])

  const handleNodeActivate = (pk: string) => {
    onPlaySound?.('click')
    setLockedPk((cur) => (cur === pk ? null : pk))
  }

  const handleFollowInspector = async () => {
    if (!inspectedNode || inspectedIsSelf || followBusyPk) return
    const pk = inspectedNode.pubkey.toLowerCase()
    setFollowBusyPk(pk)
    try {
      await Promise.resolve(onFollow(pk))
      onPlaySound?.('click')
    } finally {
      setFollowBusyPk(null)
    }
  }

  const hasGraphNodes = layout.positioned.length > 1

  return (
    <div className={`ag-disc-graph-wrap${compact ? ' is-compact' : ''}`}>
      {/* Legend & Trusted-Only Path Toggle */}
      <div className="ag-disc-graph-toolbar">
        <div className="ag-disc-graph-legend" aria-label="Graph legend">
          <span className="ag-disc-legend-item">
            <span className="ag-disc-legend-dot is-self" aria-hidden="true" />
            <span>You</span>
          </span>
          <span className="ag-disc-legend-item">
            <span className="ag-disc-legend-dot is-trusted" aria-hidden="true" />
            <span>Trusted (3×)</span>
          </span>
          <span className="ag-disc-legend-item">
            <span className="ag-disc-legend-dot is-following" aria-hidden="true" />
            <span>Following (1×)</span>
          </span>
          <span className="ag-disc-legend-item">
            <span className="ag-disc-legend-dot is-candidate" aria-hidden="true" />
            <span>High-Signal Discovery</span>
          </span>
        </div>

        {onToggleTrustedOnlyPaths && (
          <button
            type="button"
            className={`ag-disc-graph-toggle${trustedOnlyPaths ? ' active' : ''}`}
            aria-pressed={trustedOnlyPaths}
            onClick={() => {
              onPlaySound?.('click')
              onToggleTrustedOnlyPaths()
            }}
          >
            <ShieldCheck size={13} aria-hidden="true" />
            <span>Trusted paths only</span>
          </button>
        )}
      </div>

      {/* Interactive Radial 2-Hop SVG Canvas */}
      <div className="ag-disc-graph-stage">
        {!hasGraphNodes ? (
          <div className="ag-disc-graph-empty">
            <Compass size={22} aria-hidden="true" />
            <p>Follow or trust people to illuminate your 2-hop Web-of-Trust graph.</p>
          </div>
        ) : (
          <svg
            className="ag-disc-graph-svg"
            viewBox={`0 0 ${width} ${height}`}
            role="img"
            aria-label="Interactive 2-hop Web-of-Trust discovery graph"
            onClick={() => setLockedPk(null)}
          >
            <defs>
              {layout.positioned.map((item) => {
                const pk = item.node.pubkey.toLowerCase()
                return (
                  <clipPath key={pk} id={`ag-wot-clip-${svgInstanceId}-${pk}`}>
                    <circle cx={item.x} cy={item.y} r={Math.max(4, item.radius - 2.2)} />
                  </clipPath>
                )
              })}
            </defs>

            {/* Concentric Guide Rings */}
            <circle
              cx={cx}
              cy={cy}
              r={r1}
              className="ag-disc-guide-ring"
              fill="none"
              strokeDasharray="4 4"
            />
            <circle
              cx={cx}
              cy={cy}
              r={r2}
              className="ag-disc-guide-ring is-outer"
              fill="none"
              strokeDasharray="3 5"
            />

            <text
              x={cx}
              y={cy - r1 - 6}
              textAnchor="middle"
              className="ag-disc-ring-label"
              style={{
                paintOrder: 'stroke',
                stroke: 'var(--bg-surface, var(--bg-canvas, #0b0e11))',
                strokeWidth: 3.5,
                strokeLinejoin: 'round',
              }}
            >
              1-hop Trust &amp; Follows
            </text>
            <text
              x={cx}
              y={Math.max(12, cy - r2 - 8)}
              textAnchor="middle"
              className="ag-disc-ring-label"
              style={{
                paintOrder: 'stroke',
                stroke: 'var(--bg-surface, var(--bg-canvas, #0b0e11))',
                strokeWidth: 3.5,
                strokeLinejoin: 'round',
              }}
            >
              2-hop High-Signal Discoveries
            </text>

            {/* Curved Bezier Trust/Follow/Zap Edges */}
            <g className="ag-disc-edges-layer">
              {layout.visibleEdges.map((edge) => {
                const isLit = !highlightState || highlightState.highlightedEdges.has(edge.key)
                const angleDiff = angularDelta(edge.from.angle, edge.to.angle)
                const bend =
                  edge.from.node.hop === 0
                    ? 10
                    : Math.max(-24, Math.min(24, angleDiff * 16 + (edge.kind === 'zap' ? 10 : 6)))
                const d = makeCurvedEdgePath(edge.from.x, edge.from.y, edge.to.x, edge.to.y, bend)
                const strokeWidth = isLit
                  ? Math.min(2.8, Math.max(1.25, 1.15 + edge.weight * 0.45))
                  : 1
                return (
                  <path
                    key={edge.key}
                    d={d}
                    fill="none"
                    stroke={EDGE_STROKE[edge.kind]}
                    strokeWidth={strokeWidth}
                    strokeOpacity={highlightState ? (isLit ? 0.88 : 0.12) : 0.34}
                    strokeLinecap="round"
                    className={`ag-disc-edge${isLit && highlightState ? ' is-highlighted' : ''}`}
                  />
                )
              })}
            </g>

            {/* Interactive Nodes */}
            <g className="ag-disc-nodes-layer">
              {layout.positioned.map((item) => {
                const { node, x, y, radius } = item
                const pk = node.pubkey.toLowerCase()
                const profile = agora.profilesByPubkey[pk]
                const name = node.hop === 0 ? 'You' : getProfileDisplayName(profile, pk)
                const shortLabel = name.length > 12 ? `${name.slice(0, 11)}…` : name
                const avatarSrc = safePictures[pk] || identiconDataUrl(pk || 'anon')
                const isLit = !highlightState || highlightState.highlightedNodes.has(pk)
                const isSelected = activePk === pk
                const roleLabel =
                  node.role === 'self'
                    ? 'You'
                    : node.role === 'trusted'
                      ? 'Trusted peer'
                      : node.role === 'following'
                        ? 'Following'
                        : node.role === 'local'
                          ? 'Local peer'
                          : 'High-signal discovery'
                const showLabel =
                  node.hop === 0 || isSelected || (!compact && node.hop === 2 && node.signalScore >= 65)

                return (
                  <g
                    key={pk}
                    role="button"
                    tabIndex={0}
                    aria-label={`${name}, ${roleLabel}, Signal ${Math.round(node.signalScore)} out of 100`}
                    aria-pressed={lockedPk === pk}
                    className={`ag-disc-node role-${node.role}${isSelected ? ' is-selected' : ''}`}
                    style={{ opacity: isLit ? 1 : 0.32, cursor: 'pointer' }}
                    onMouseEnter={() => setHoveredPk(pk)}
                    onMouseLeave={() => setHoveredPk((cur) => (cur === pk ? null : cur))}
                    onFocus={() => setHoveredPk(pk)}
                    onBlur={() => setHoveredPk((cur) => (cur === pk ? null : cur))}
                    onClick={(e) => {
                      e.stopPropagation()
                      handleNodeActivate(pk)
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        e.stopPropagation()
                        handleNodeActivate(pk)
                      }
                    }}
                  >
                    {(node.role === 'candidate' || isSelected) && (
                      <circle
                        cx={x}
                        cy={y}
                        r={radius + (isSelected ? 5 : 3)}
                        fill="none"
                        stroke={ROLE_STROKE[node.role]}
                        strokeWidth={isSelected ? 2 : 1.2}
                        strokeOpacity={isSelected ? 0.85 : 0.35}
                      />
                    )}
                    <circle
                      cx={x}
                      cy={y}
                      r={radius}
                      fill="var(--bg-elevated, #12171a)"
                      stroke={ROLE_STROKE[node.role]}
                      strokeWidth={node.role === 'self' || node.role === 'trusted' ? 2.4 : 1.8}
                    />
                    <image
                      href={avatarSrc}
                      x={x - (radius - 2.2)}
                      y={y - (radius - 2.2)}
                      width={(radius - 2.2) * 2}
                      height={(radius - 2.2) * 2}
                      preserveAspectRatio="xMidYMid slice"
                      clipPath={`url(#ag-wot-clip-${svgInstanceId}-${pk})`}
                    />
                    {showLabel && (
                      <text
                        x={x}
                        y={y + radius + 12}
                        textAnchor="middle"
                        className={`ag-disc-node-label${isSelected ? ' is-selected' : ''}`}
                      >
                        {shortLabel}
                      </text>
                    )}
                  </g>
                )
              })}
            </g>
          </svg>
        )}
      </div>

      {/* Selected / Hovered Node Inspector Bar */}
      {inspectedNode && (
        <div className="ag-disc-inspector" aria-live="polite">
          <div className="ag-disc-inspector-main">
            <img
              src={
                safePictures[inspectedNode.pubkey.toLowerCase()] ||
                identiconDataUrl(inspectedNode.pubkey || 'anon')
              }
              alt={inspectedName}
              className="ag-agora-avatar ag-agora-avatar-sm"
            />
            <div className="ag-disc-inspector-copy">
              <div className="ag-disc-inspector-title-row">
                <span className="ag-disc-inspector-name truncate">
                  {inspectedIsSelf ? `${inspectedName} (You)` : inspectedName}
                </span>
                {inspectedNode.isVerifiedNip05 && inspectedProfile?.nip05 && (
                  <BadgeCheck
                    size={13}
                    className="ag-agora-nip05-icon"
                    aria-label="Verified NIP-05"
                  />
                )}
                {!inspectedIsSelf && (
                  <span className="ag-disc-signal-pill tabular">
                    <Sparkles size={11} aria-hidden="true" />
                    <span>Signal {Math.round(inspectedNode.signalScore)}/100</span>
                  </span>
                )}
                {lockedPk === inspectedNode.pubkey.toLowerCase() && (
                  <span className="ag-disc-locked-pill">Pinned</span>
                )}
              </div>
              <p className="ag-disc-inspector-path">{inspectedPathSummary}</p>
            </div>
          </div>

          {!inspectedIsSelf && (
            <div className="ag-disc-inspector-actions">
              <button
                type="button"
                className={`ag-agora-follow-btn${inspectedFollowing ? ' following' : ''}`}
                disabled={followBusyPk === inspectedNode.pubkey.toLowerCase()}
                onClick={() => void handleFollowInspector()}
              >
                {followBusyPk === inspectedNode.pubkey.toLowerCase() ? (
                  <Loader2 size={13} className="ag-agora-spin" />
                ) : inspectedFollowing ? (
                  <Check size={13} />
                ) : (
                  <UserPlus size={13} />
                )}
                <span>{inspectedFollowing ? 'Following' : 'Follow'}</span>
              </button>
              <button
                type="button"
                className="ag-disc-action-btn"
                onClick={() => {
                  onPlaySound?.('click')
                  onOpenProfile(inspectedNode.pubkey)
                }}
              >
                <User size={13} aria-hidden="true" />
                <span>Profile</span>
              </button>
              <button
                type="button"
                className="ag-disc-action-btn"
                onClick={() => {
                  onPlaySound?.('click')
                  onFindSimilar(inspectedNode.pubkey)
                }}
              >
                <Compass size={13} aria-hidden="true" />
                <span>Similar Voices</span>
              </button>
              {inspectedNode.role === 'candidate' && (
                <button
                  type="button"
                  className="ag-disc-action-btn is-dismiss"
                  onClick={() => {
                    onPlaySound?.('click')
                    if (lockedPk === inspectedNode.pubkey.toLowerCase()) setLockedPk(null)
                    onDismiss(inspectedNode.pubkey)
                  }}
                  title="Dismiss this recommendation"
                  aria-label={`Dismiss ${inspectedName}`}
                >
                  <X size={13} aria-hidden="true" />
                  <span>Dismiss</span>
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export default WotGraphCanvas
