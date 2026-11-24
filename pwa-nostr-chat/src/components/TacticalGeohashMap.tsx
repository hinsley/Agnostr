import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import type { GeoCoords, PulseRoom, ThemeId } from '../types/protocol.ts'
import {
  decodeBounds,
  decodeCenter,
  encodeGeohash,
  formatCoords,
  getChildGeohashes,
  getGeohashCellsInBounds,
  getRecommendedPrecisionForZoom,
  getZoomForPrecision,
  isValidGeohash,
} from '../lib/geohash.ts'
import { isTopicChannel } from '../lib/bitchatChannel.ts'

export type PrecisionSelection = 'auto' | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8

export interface TacticalGeohashMapHandle {
  zoomIn: () => void
  zoomOut: () => void
  flyToGeohash: (geohash: string, options?: { animate?: boolean; zoom?: number }) => void
  flyToCoords: (lat: number, lon: number, zoom?: number) => void
  fitWorld: () => void
  getZoom: () => number
}

export interface TacticalGeohashMapProps {
  mode: 'compact' | 'expanded'
  theme: ThemeId
  activeGeohash: string
  selectedGeohash: string | null
  precisionMode: PrecisionSelection
  showSubZones: boolean
  showPulse: boolean
  showBubbles?: boolean
  pulseRooms: PulseRoom[]
  userCoords: GeoCoords | null
  isTeleported: boolean
  onSelectGeohash: (geohash: string) => void
  onTuneGeohash?: (geohash: string) => void
  onViewportInfoChange?: (info: { zoom: number; effectivePrecision: number }) => void
  className?: string
}

const ESRI_DARK_BASE_URL =
  'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}'
const ESRI_DARK_REF_URL =
  'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}'
const ESRI_TOPO_URL =
  'https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}'
const TILE_ATTRIBUTION = '&copy; Esri &middot; &copy; OpenStreetMap contributors'

const WORLD_MAX_BOUNDS: L.LatLngBoundsExpression = [
  [-85, -180],
  [85, 180],
]

const VIEWPORT_DEBOUNCE_MS = 140
const RECENT_BUBBLE_WINDOW_MS = 120_000

interface MapCanvasPalette {
  accent: string
  accentSecondary: string
  borderStrong: string
  gridOpacity: number
  gridHoverOpacity: number
  gridHoverFillOpacity: number
  isLight: boolean
}

const THEME_FALLBACKS: Record<
  ThemeId,
  { accent: string; accentSecondary: string; borderStrong: string }
> = {
  phosphor: {
    accent: '#3B82F6',
    accentSecondary: '#38BDF8',
    borderStrong: 'rgba(255, 255, 255, 0.19)',
  },
  obsidian: {
    accent: '#6366F1',
    accentSecondary: '#38BDF8',
    borderStrong: 'rgba(255, 255, 255, 0.2)',
  },
  amber: {
    accent: '#F59E0B',
    accentSecondary: '#FB7185',
    borderStrong: 'rgba(255, 245, 235, 0.2)',
  },
  daylight: {
    accent: '#2563EB',
    accentSecondary: '#0284C7',
    borderStrong: 'rgba(15, 23, 42, 0.22)',
  },
}

function readCanvasPalette(el: HTMLElement | null, theme: ThemeId): MapCanvasPalette {
  const fb = THEME_FALLBACKS[theme] ?? THEME_FALLBACKS.phosphor
  const docTheme =
    typeof document !== 'undefined' ? document.documentElement.getAttribute('data-theme') : null
  const themeMatchesDom =
    !docTheme || docTheme === theme || (theme === 'daylight' && docTheme === 'paper')
  const styles =
    el && themeMatchesDom && typeof window !== 'undefined' ? window.getComputedStyle(el) : null

  const accent = styles?.getPropertyValue('--accent').trim() || fb.accent
  const accentSecondary =
    styles?.getPropertyValue('--accent-secondary').trim() || fb.accentSecondary
  const borderStrong = styles?.getPropertyValue('--border-strong').trim() || fb.borderStrong
  const isLight = theme === 'daylight'

  return {
    accent,
    accentSecondary,
    borderStrong,
    gridOpacity: isLight ? 0.28 : 0.24,
    gridHoverOpacity: isLight ? 0.64 : 0.62,
    gridHoverFillOpacity: isLight ? 0.08 : 0.07,
    isLight,
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * Formats a raw message preview for compact map speech bubbles.
 * Collapses whitespace, shortens Cashu tokens & URLs, and caps length cleanly at ~52 chars.
 */
function formatBubbleSnippet(preview: string): string {
  if (!preview) return ''
  const cleaned = preview
    .replace(/\bcashu[AB][A-Za-z0-9_+/-]{8,}={0,2}/g, 'Cashu ecash')
    .replace(/https?:\/\/\S+/gi, 'Link')
    .replace(/\s+/g, ' ')
    .trim()
  if (!cleaned) return ''
  if (cleaned.length <= 52) return cleaned
  return `${cleaned.slice(0, 51).trimEnd()}…`
}

function formatBubbleSender(sender: string): string {
  const cleaned = sender.replace(/^@+/, '').replace(/\s+/g, ' ').trim()
  if (!cleaned) return 'agnon'
  if (cleaned.length <= 11) return cleaned
  return `${cleaned.slice(0, 10).trimEnd()}…`
}

function getBoundsTuple(geohash: string): L.LatLngBoundsExpression {
  const b = decodeBounds(geohash)
  return [
    [Math.max(-85, b.latMin), b.lonMin],
    [Math.min(85, b.latMax), b.lonMax],
  ]
}

interface ScreenBox {
  left: number
  right: number
  top: number
  bottom: number
}

function boxesOverlap(a: ScreenBox, b: ScreenBox, gap: number): boolean {
  return (
    a.left < b.right + gap &&
    a.right + gap > b.left &&
    a.top < b.bottom + gap &&
    a.bottom + gap > b.top
  )
}

export const TacticalGeohashMap = forwardRef<TacticalGeohashMapHandle, TacticalGeohashMapProps>(
  function TacticalGeohashMap(
    {
      mode,
      theme,
      activeGeohash,
      selectedGeohash,
      precisionMode,
      showSubZones,
      showPulse,
      showBubbles = true,
      pulseRooms,
      userCoords,
      isTeleported,
      onSelectGeohash,
      onTuneGeohash,
      onViewportInfoChange,
      className = '',
    },
    ref,
  ) {
    const containerRef = useRef<HTMLDivElement | null>(null)
    const mapRef = useRef<L.Map | null>(null)
    const canvasRendererRef = useRef<L.Canvas | null>(null)
    const tileLayerRef = useRef<L.TileLayer | null>(null)
    const refTileLayerRef = useRef<L.TileLayer | null>(null)
    const gridLayerRef = useRef<L.LayerGroup | null>(null)
    const pulseLayerRef = useRef<L.LayerGroup | null>(null)
    const bubbleLayerRef = useRef<L.LayerGroup | null>(null)
    const subZoneLayerRef = useRef<L.LayerGroup | null>(null)
    const focusLayerRef = useRef<L.LayerGroup | null>(null)
    const gpsLayerRef = useRef<L.LayerGroup | null>(null)
    const cancelWheelZoomRef = useRef<() => void>(() => {})
    const seenBubbleMsgRef = useRef<Map<string, string>>(new Map())
    const hasSeededBubblesRef = useRef(false)
    const bubbleMarkersRef = useRef<
      Map<string, { marker: L.Marker; msgKey: string }>
    >(new Map())

    const [hoverHud, setHoverHud] = useState<{ geohash: string; coords: string } | null>(null)
    const [viewportTick, setViewportTick] = useState(0)

    // Keep latest callbacks & props in refs so Leaflet event listeners never go stale
    const safeActiveGeohash =
      activeGeohash && !isTopicChannel(activeGeohash) && isValidGeohash(activeGeohash)
        ? activeGeohash
        : '9q8y'
    const safeSelectedGeohash =
      selectedGeohash && !isTopicChannel(selectedGeohash) && isValidGeohash(selectedGeohash)
        ? selectedGeohash
        : null

    const onSelectRef = useRef(onSelectGeohash)
    const onTuneRef = useRef(onTuneGeohash)
    const onViewportInfoRef = useRef(onViewportInfoChange)
    const precisionModeRef = useRef(precisionMode)
    const modeRef = useRef(mode)
    const prevActiveRef = useRef<string>(safeActiveGeohash)
    const tileKindRef = useRef<'dark' | 'light'>(theme === 'daylight' ? 'light' : 'dark')

    useEffect(() => {
      onSelectRef.current = onSelectGeohash
      onTuneRef.current = onTuneGeohash
      onViewportInfoRef.current = onViewportInfoChange
      precisionModeRef.current = precisionMode
      modeRef.current = mode
    }, [onSelectGeohash, onTuneGeohash, onViewportInfoChange, precisionMode, mode])

    const flyToCellInternal = (
      map: L.Map,
      geohash: string,
      options?: { animate?: boolean; zoom?: number },
    ) => {
      cancelWheelZoomRef.current()
      const center = decodeCenter(geohash)
      const targetZoom =
        options?.zoom ??
        Math.max(
          2,
          Math.min(
            19,
            modeRef.current === 'compact'
              ? Math.max(2, getZoomForPrecision(geohash.length) - 1)
              : getZoomForPrecision(geohash.length),
          ),
        )
      if (options?.animate === false) {
        map.setView([center.lat, center.lon], targetZoom, { animate: false })
      } else {
        map.flyTo([center.lat, center.lon], targetZoom, {
          duration: 0.55,
          easeLinearity: 0.25,
        })
      }
    }

    useImperativeHandle(
      ref,
      () => ({
        zoomIn() {
          cancelWheelZoomRef.current()
          mapRef.current?.zoomIn(0.75)
        },
        zoomOut() {
          cancelWheelZoomRef.current()
          mapRef.current?.zoomOut(0.75)
        },
        flyToGeohash(geohash: string, options?: { animate?: boolean; zoom?: number }) {
          const map = mapRef.current
          if (!map || !geohash || isTopicChannel(geohash) || !isValidGeohash(geohash)) return
          flyToCellInternal(map, geohash, options)
        },
        flyToCoords(lat: number, lon: number, zoom = 11) {
          cancelWheelZoomRef.current()
          const map = mapRef.current
          if (!map) return
          map.flyTo([lat, lon], Math.max(2, Math.min(19, zoom)), {
            duration: 0.65,
            easeLinearity: 0.25,
          })
        },
        fitWorld() {
          cancelWheelZoomRef.current()
          const map = mapRef.current
          if (!map) return
          map.flyTo([18, 0], 2, { duration: 0.6 })
        },
        getZoom() {
          return mapRef.current?.getZoom() ?? 4
        },
      }),
      [],
    )

    // 1. Mount / unmount Leaflet map instance with smooth rAF wheel/pinch controller
    useEffect(() => {
      const el = containerRef.current
      if (!el) return

      const initialCenter = decodeCenter(safeActiveGeohash)
      const initialZoom =
        mode === 'compact'
          ? Math.max(2, getZoomForPrecision(safeActiveGeohash.length) - 1)
          : getZoomForPrecision(safeActiveGeohash.length)

      const map = L.map(el, {
        center: [initialCenter.lat, initialCenter.lon],
        zoom: initialZoom,
        minZoom: 2,
        maxZoom: 19,
        scrollWheelZoom: false,
        zoomSnap: 0,
        zoomDelta: 0.75,
        zoomAnimation: true,
        inertia: true,
        touchZoom: true,
        tapHold: false,
        bounceAtZoomLimits: false,
        zoomControl: false,
        attributionControl: true,
        doubleClickZoom: false,
        maxBounds: WORLD_MAX_BOUNDS,
        maxBoundsViscosity: 0.85,
        preferCanvas: true,
      })

      map.attributionControl.setPrefix(false)

      const canvasRenderer = L.canvas({ padding: 0.5 })
      canvasRendererRef.current = canvasRenderer

      const isLight = tileKindRef.current === 'light'
      const tileLayer = L.tileLayer(isLight ? ESRI_TOPO_URL : ESRI_DARK_BASE_URL, {
        maxNativeZoom: isLight ? 17 : 16,
        maxZoom: 19,
        updateWhenZooming: false,
        updateWhenIdle: true,
        keepBuffer: 4,
        attribution: TILE_ATTRIBUTION,
      }).addTo(map)

      const refTileLayer = isLight
        ? null
        : L.tileLayer(ESRI_DARK_REF_URL, {
            maxNativeZoom: 16,
            maxZoom: 19,
            opacity: 0.95,
            updateWhenZooming: false,
            updateWhenIdle: true,
            keepBuffer: 4,
            attribution: '',
          }).addTo(map)

      const gridLayer = L.layerGroup().addTo(map)
      const pulseLayer = L.layerGroup().addTo(map)
      const bubbleLayer = L.layerGroup().addTo(map)
      const subZoneLayer = L.layerGroup().addTo(map)
      const focusLayer = L.layerGroup().addTo(map)
      const gpsLayer = L.layerGroup().addTo(map)
      const bubbleMarkers = bubbleMarkersRef.current

      mapRef.current = map
      tileLayerRef.current = tileLayer
      refTileLayerRef.current = refTileLayer
      gridLayerRef.current = gridLayer
      pulseLayerRef.current = pulseLayer
      bubbleLayerRef.current = bubbleLayer
      subZoneLayerRef.current = subZoneLayer
      focusLayerRef.current = focusLayer
      gpsLayerRef.current = gpsLayer

      // Smooth rAF-interpolated wheel & trackpad-pinch zoom state
      const wheelState: {
        rafId: number | null
        active: boolean
        targetZoom: number
        anchorLatLng: L.LatLng | null
        lastClientX: number
        lastClientY: number
        lastFrameMs: number
      } = {
        rafId: null,
        active: false,
        targetZoom: initialZoom,
        anchorLatLng: null,
        lastClientX: 0,
        lastClientY: 0,
        lastFrameMs: 0,
      }

      let viewportDebounceTimer: number | null = null

      const emitViewport = () => {
        const z = map.getZoom()
        const p =
          precisionModeRef.current === 'auto'
            ? getRecommendedPrecisionForZoom(z)
            : precisionModeRef.current
        onViewportInfoRef.current?.({ zoom: z, effectivePrecision: p })
        setViewportTick((t) => t + 1)
      }

      const cancelViewportEmit = () => {
        if (viewportDebounceTimer !== null) {
          window.clearTimeout(viewportDebounceTimer)
          viewportDebounceTimer = null
        }
      }

      const scheduleViewportEmit = () => {
        cancelViewportEmit()
        viewportDebounceTimer = window.setTimeout(() => {
          viewportDebounceTimer = null
          if (wheelState.active) return
          emitViewport()
        }, VIEWPORT_DEBOUNCE_MS)
      }

      const cancelWheelZoom = () => {
        if (wheelState.rafId !== null) {
          window.cancelAnimationFrame(wheelState.rafId)
          wheelState.rafId = null
        }
        wheelState.active = false
        wheelState.anchorLatLng = null
      }
      cancelWheelZoomRef.current = cancelWheelZoom

      const stepWheelZoom = (nowMs: number) => {
        wheelState.rafId = null
        if (!wheelState.active || !wheelState.anchorLatLng) return

        const currentZoom = map.getZoom()
        const diff = wheelState.targetZoom - currentZoom

        if (Math.abs(diff) < 0.004) {
          const finalZoom = wheelState.targetZoom
          const anchor = wheelState.anchorLatLng
          if (finalZoom !== currentZoom) {
            map.setZoomAround(anchor, finalZoom, { animate: false })
          }
          wheelState.active = false
          wheelState.anchorLatLng = null
          scheduleViewportEmit()
          return
        }

        const dt = clamp(nowMs - wheelState.lastFrameMs, 4, 64)
        wheelState.lastFrameMs = nowMs
        const alpha = 1 - Math.exp(-dt / 55)
        const nextZoom = clamp(
          currentZoom + diff * alpha,
          map.getMinZoom(),
          map.getMaxZoom(),
        )

        if (nextZoom !== currentZoom) {
          map.setZoomAround(wheelState.anchorLatLng, nextZoom, { animate: false })
        }

        wheelState.rafId = window.requestAnimationFrame(stepWheelZoom)
      }

      const handleWheel = (e: WheelEvent) => {
        e.preventDefault()
        e.stopPropagation()

        cancelViewportEmit()

        let delta = e.deltaY
        if (e.deltaMode === 1) delta *= 18
        else if (e.deltaMode === 2) delta *= 160
        if (!Number.isFinite(delta) || delta === 0) return

        let zoomStep: number
        if (e.ctrlKey) {
          // Trackpad pinch-to-zoom
          zoomStep = clamp(-delta * 0.011, -0.45, 0.45)
        } else if (e.deltaMode === 0 && Math.abs(delta) < 48) {
          // Smooth high-precision trackpad scroll
          zoomStep = clamp(-delta * 0.0042, -0.35, 0.35)
        } else {
          // Discrete mouse wheel notch
          zoomStep =
            -Math.sign(delta) * Math.min(0.65, Math.max(0.28, Math.abs(delta) * 0.0045))
        }

        const minZ = map.getMinZoom()
        const maxZ = map.getMaxZoom()
        const currentZ = map.getZoom()

        if (!wheelState.active) {
          map.stop()
        }

        const rect = el.getBoundingClientRect()
        const point = L.point(e.clientX - rect.left, e.clientY - rect.top)
        const movedPx = Math.hypot(
          e.clientX - wheelState.lastClientX,
          e.clientY - wheelState.lastClientY,
        )

        if (!wheelState.active || !wheelState.anchorLatLng || movedPx > 3) {
          wheelState.anchorLatLng = map.containerPointToLatLng(point)
          wheelState.lastClientX = e.clientX
          wheelState.lastClientY = e.clientY
        }

        const baseZoom = wheelState.active ? wheelState.targetZoom : currentZ
        const nextTarget = clamp(baseZoom + zoomStep, minZ, maxZ)

        if (Math.abs(nextTarget - currentZ) < 0.0005 && !wheelState.active) {
          return
        }

        wheelState.targetZoom = nextTarget
        wheelState.active = true

        if (wheelState.rafId === null) {
          wheelState.lastFrameMs = performance.now()
          wheelState.rafId = window.requestAnimationFrame(stepWheelZoom)
        }
      }

      const handleTouchStart = (e: TouchEvent) => {
        if (e.touches.length >= 2) {
          cancelWheelZoom()
          cancelViewportEmit()
        }
      }

      const preventSafariGesture = (e: Event) => {
        e.preventDefault()
      }

      el.addEventListener('wheel', handleWheel, { passive: false })
      el.addEventListener('touchstart', handleTouchStart, { passive: true })
      el.addEventListener('gesturestart', preventSafariGesture, { passive: false })
      el.addEventListener('gesturechange', preventSafariGesture, { passive: false })

      const handleMapClick = (e: L.LeafletMouseEvent) => {
        const z = map.getZoom()
        const p =
          precisionModeRef.current === 'auto'
            ? getRecommendedPrecisionForZoom(z)
            : precisionModeRef.current
        const gh = encodeGeohash(e.latlng.lat, e.latlng.lng, p)
        onSelectRef.current(gh)
      }

      const handleMapDblClick = (e: L.LeafletMouseEvent) => {
        if (modeRef.current !== 'expanded' || !onTuneRef.current) return
        const z = map.getZoom()
        const p =
          precisionModeRef.current === 'auto'
            ? getRecommendedPrecisionForZoom(z)
            : precisionModeRef.current
        const gh = encodeGeohash(e.latlng.lat, e.latlng.lng, p)
        onTuneRef.current(gh)
      }

      const isTouchDevice =
        typeof window !== 'undefined' &&
        window.matchMedia &&
        window.matchMedia('(hover: none)').matches

      const handleMouseMove = (e: L.LeafletMouseEvent) => {
        if (isTouchDevice) return
        const z = map.getZoom()
        const p =
          precisionModeRef.current === 'auto'
            ? getRecommendedPrecisionForZoom(z)
            : precisionModeRef.current
        const gh = encodeGeohash(e.latlng.lat, e.latlng.lng, p)
        setHoverHud({
          geohash: gh,
          coords: formatCoords({ lat: e.latlng.lat, lon: e.latlng.lng }),
        })
      }

      const handleMouseOut = () => {
        setHoverHud(null)
      }

      const handleDragStart = () => {
        cancelWheelZoom()
        cancelViewportEmit()
      }

      const handleMoveOrZoomStart = () => {
        cancelViewportEmit()
      }

      const handleMoveOrZoomEnd = () => {
        if (wheelState.active) return
        scheduleViewportEmit()
      }

      map.on('dragstart', handleDragStart)
      map.on('movestart zoomstart move zoom', handleMoveOrZoomStart)
      map.on('moveend zoomend', handleMoveOrZoomEnd)
      map.on('click', handleMapClick)
      map.on('dblclick', handleMapDblClick)
      map.on('mousemove', handleMouseMove)
      map.on('mouseout', handleMouseOut)

      // Guard ResizeObserver so invalidateSize only fires on actual dimension changes
      let lastObservedW = el.clientWidth
      let lastObservedH = el.clientHeight
      const ro = new ResizeObserver(() => {
        const nextW = el.clientWidth
        const nextH = el.clientHeight
        if (nextW === lastObservedW && nextH === lastObservedH) return
        lastObservedW = nextW
        lastObservedH = nextH
        map.invalidateSize({ animate: false })
        scheduleViewportEmit()
      })
      ro.observe(el)

      const settleTimer = window.setTimeout(() => {
        lastObservedW = el.clientWidth
        lastObservedH = el.clientHeight
        map.invalidateSize({ animate: false })
        emitViewport()
      }, 180)

      emitViewport()

      return () => {
        window.clearTimeout(settleTimer)
        cancelViewportEmit()
        cancelWheelZoom()
        cancelWheelZoomRef.current = () => {}
        el.removeEventListener('wheel', handleWheel)
        el.removeEventListener('touchstart', handleTouchStart)
        el.removeEventListener('gesturestart', preventSafariGesture)
        el.removeEventListener('gesturechange', preventSafariGesture)
        ro.disconnect()
        map.off()
        map.remove()
        mapRef.current = null
        canvasRendererRef.current = null
        tileLayerRef.current = null
        refTileLayerRef.current = null
        gridLayerRef.current = null
        pulseLayerRef.current = null
        bubbleLayerRef.current = null
        bubbleMarkers.clear()
        subZoneLayerRef.current = null
        focusLayerRef.current = null
        gpsLayerRef.current = null
      }
      // Intentionally mount once per component instance
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])

    // 2. Swap basemap tiles cleanly when theme switches between dark <-> daylight
    useEffect(() => {
      const nextKind: 'dark' | 'light' = theme === 'daylight' ? 'light' : 'dark'
      if (tileKindRef.current === nextKind) return
      tileKindRef.current = nextKind

      const map = mapRef.current
      if (!map) return

      cancelWheelZoomRef.current()
      map.stop()

      if (tileLayerRef.current) {
        tileLayerRef.current.remove()
        tileLayerRef.current = null
      }
      if (refTileLayerRef.current) {
        refTileLayerRef.current.remove()
        refTileLayerRef.current = null
      }

      const isLight = nextKind === 'light'
      tileLayerRef.current = L.tileLayer(isLight ? ESRI_TOPO_URL : ESRI_DARK_BASE_URL, {
        maxNativeZoom: isLight ? 17 : 16,
        maxZoom: 19,
        updateWhenZooming: false,
        updateWhenIdle: true,
        keepBuffer: 4,
        attribution: TILE_ATTRIBUTION,
      }).addTo(map)

      if (!isLight) {
        refTileLayerRef.current = L.tileLayer(ESRI_DARK_REF_URL, {
          maxNativeZoom: 16,
          maxZoom: 19,
          opacity: 0.95,
          updateWhenZooming: false,
          updateWhenIdle: true,
          keepBuffer: 4,
          attribution: '',
        }).addTo(map)
      }
    }, [theme])

    // 3. Smoothly re-frame map whenever activeGeohash changes externally
    useEffect(() => {
      if (prevActiveRef.current === safeActiveGeohash) return
      prevActiveRef.current = safeActiveGeohash
      const map = mapRef.current
      if (!map) return
      flyToCellInternal(map, safeActiveGeohash, { animate: true })
    }, [safeActiveGeohash])

    // 4. Emit updated effective precision when precisionMode changes
    useEffect(() => {
      const map = mapRef.current
      if (!map) return
      const z = map.getZoom()
      const p = precisionMode === 'auto' ? getRecommendedPrecisionForZoom(z) : precisionMode
      onViewportInfoRef.current?.({ zoom: z, effectivePrecision: p })
    }, [precisionMode])

    // 5. Render Live Geohash Zone Grid Overlay (Canvas-accelerated)
    useEffect(() => {
      const map = mapRef.current
      const layer = gridLayerRef.current
      const renderer = canvasRendererRef.current
      if (!map || !layer || !renderer) return

      layer.clearLayers()

      const palette = readCanvasPalette(containerRef.current, theme)
      const isTouchDevice =
        typeof window !== 'undefined' &&
        window.matchMedia &&
        window.matchMedia('(hover: none)').matches

      const z = map.getZoom()
      const effectivePrecision =
        precisionMode === 'auto' ? getRecommendedPrecisionForZoom(z) : precisionMode

      const b = map.getBounds()
      const cells = getGeohashCellsInBounds(
        {
          latMin: b.getSouth(),
          latMax: b.getNorth(),
          lonMin: b.getWest(),
          lonMax: b.getEast(),
        },
        effectivePrecision,
        mode === 'compact' ? 96 : 180,
      )

      const focusSet = new Set<string>([safeActiveGeohash])
      if (safeSelectedGeohash) focusSet.add(safeSelectedGeohash)

      // Skip plain center cell labels whenever a visible Global Pulse badge occupies the exact geohash
      const pulseOccupiedSet = new Set<string>()
      if (showPulse && pulseRooms.length > 0) {
        const visiblePulse = pulseRooms
          .filter((r) => !isTopicChannel(r.geohash) && isValidGeohash(r.geohash))
          .slice(0, mode === 'compact' ? 24 : 44)
        for (const room of visiblePulse) {
          pulseOccupiedSet.add(room.geohash)
        }
      }

      for (const cell of cells) {
        const isFocus = focusSet.has(cell.geohash)
        const latMin = Math.max(-85, cell.bounds.latMin)
        const latMax = Math.min(85, cell.bounds.latMax)
        const rect = L.rectangle(
          [
            [latMin, cell.bounds.lonMin],
            [latMax, cell.bounds.lonMax],
          ],
          {
            renderer,
            color: palette.accent,
            opacity: isFocus ? 0 : palette.gridOpacity,
            fillColor: palette.accent,
            fillOpacity: 0,
            weight: 0.75,
            interactive: true,
          },
        )

        if (!isTouchDevice && !isFocus) {
          rect.on('mouseover', () => {
            rect.setStyle({
              opacity: palette.gridHoverOpacity,
              fillOpacity: palette.gridHoverFillOpacity,
            })
          })
          rect.on('mouseout', () => {
            rect.setStyle({
              opacity: palette.gridOpacity,
              fillOpacity: 0,
            })
          })
        }

        rect.on('click', (ev: L.LeafletMouseEvent) => {
          L.DomEvent.stopPropagation(ev)
          onSelectRef.current(cell.geohash)
        })

        if (mode === 'expanded') {
          rect.on('dblclick', (ev: L.LeafletMouseEvent) => {
            L.DomEvent.stopPropagation(ev)
            onTuneRef.current?.(cell.geohash)
          })
        }

        rect.addTo(layer)

        // Centered #geohash label only if pixel footprint comfortably fits and isn't covered by focus or Pulse
        if (!isFocus && !pulseOccupiedSet.has(cell.geohash)) {
          const nw = map.latLngToContainerPoint([latMax, cell.bounds.lonMin])
          const se = map.latLngToContainerPoint([latMin, cell.bounds.lonMax])
          const pxW = Math.abs(se.x - nw.x)
          const pxH = Math.abs(se.y - nw.y)
          const neededW = Math.max(40, (cell.geohash.length + 1) * 7.2 + 12)
          if (pxW >= neededW && pxH >= 22) {
            const labelMarker = L.marker([cell.center.lat, cell.center.lon], {
              interactive: false,
              keyboard: false,
              icon: L.divIcon({
                className: 'ag-gh-label-host',
                html: `<span class="ag-gh-label mono">#${escapeHtml(cell.geohash)}</span>`,
                iconSize: [0, 0],
              }),
            })
            labelMarker.addTo(layer)
          }
        }
      }
    }, [
      viewportTick,
      precisionMode,
      safeActiveGeohash,
      safeSelectedGeohash,
      showPulse,
      pulseRooms,
      mode,
      theme,
    ])

    // 6. Render Sub-Zone 32× Drill-Down Overlay (Canvas-accelerated)
    useEffect(() => {
      const map = mapRef.current
      const layer = subZoneLayerRef.current
      const renderer = canvasRendererRef.current
      if (!map || !layer || !renderer) return

      layer.clearLayers()
      if (!showSubZones) return

      const parentHash = safeSelectedGeohash || safeActiveGeohash
      if (!parentHash || parentHash.length >= 8) return

      const palette = readCanvasPalette(containerRef.current, theme)
      const isTouchDevice =
        typeof window !== 'undefined' &&
        window.matchMedia &&
        window.matchMedia('(hover: none)').matches

      const children = getChildGeohashes(parentHash)
      for (const child of children) {
        const latMin = Math.max(-85, child.bounds.latMin)
        const latMax = Math.min(85, child.bounds.latMax)
        const isChildActive = child.geohash === safeActiveGeohash
        const isChildSelected = child.geohash === safeSelectedGeohash
        const baseFillOpacity = isChildSelected ? 0.11 : isChildActive ? 0.08 : 0.025

        const rect = L.rectangle(
          [
            [latMin, child.bounds.lonMin],
            [latMax, child.bounds.lonMax],
          ],
          {
            renderer,
            color: palette.accentSecondary,
            opacity: 0.5,
            fillColor: palette.accentSecondary,
            fillOpacity: baseFillOpacity,
            weight: 0.9,
            dashArray: '3 3',
            interactive: true,
          },
        )

        if (!isTouchDevice) {
          rect.on('mouseover', () => {
            rect.setStyle({ opacity: 0.84, fillOpacity: Math.max(0.11, baseFillOpacity + 0.06) })
          })
          rect.on('mouseout', () => {
            rect.setStyle({ opacity: 0.5, fillOpacity: baseFillOpacity })
          })
        }

        rect.on('click', (ev: L.LeafletMouseEvent) => {
          L.DomEvent.stopPropagation(ev)
          onSelectRef.current(child.geohash)
        })

        if (mode === 'expanded') {
          rect.on('dblclick', (ev: L.LeafletMouseEvent) => {
            L.DomEvent.stopPropagation(ev)
            onTuneRef.current?.(child.geohash)
          })
        }

        rect.addTo(layer)

        const nw = map.latLngToContainerPoint([latMax, child.bounds.lonMin])
        const se = map.latLngToContainerPoint([latMin, child.bounds.lonMax])
        const pxW = Math.abs(se.x - nw.x)
        const pxH = Math.abs(se.y - nw.y)
        const fullNeededW = (child.geohash.length + 1) * 6.8 + 8

        let text: string | null = null
        if (pxW >= fullNeededW && pxH >= 18) {
          text = `#${child.geohash}`
        } else if (pxW >= 16 && pxH >= 14) {
          text = child.geohash.slice(-1)
        }

        if (text) {
          L.marker([child.center.lat, child.center.lon], {
            interactive: false,
            keyboard: false,
            icon: L.divIcon({
              className: 'ag-gh-label-host',
              html: `<span class="ag-gh-sub-label mono">${escapeHtml(text)}</span>`,
              iconSize: [0, 0],
            }),
          }).addTo(layer)
        }
      }
    }, [viewportTick, showSubZones, safeActiveGeohash, safeSelectedGeohash, mode, theme])

    // 7. Render Live Global Pulse Zones, Sonar Beacons & Compact Live Speech Bubbles
    useEffect(() => {
      const map = mapRef.current
      const layer = pulseLayerRef.current
      const bubbleLayer = bubbleLayerRef.current
      const renderer = canvasRendererRef.current
      if (!map || !layer || !bubbleLayer || !renderer) return

      layer.clearLayers()
      if (!showPulse || pulseRooms.length === 0) {
        bubbleLayer.clearLayers()
        bubbleMarkersRef.current.clear()
        return
      }

      const palette = readCanvasPalette(containerRef.current, theme)
      const isTouchDevice =
        typeof window !== 'undefined' &&
        window.matchMedia &&
        window.matchMedia('(hover: none)').matches

      const validRooms = pulseRooms.filter(
        (r) => !isTopicChannel(r.geohash) && isValidGeohash(r.geohash),
      )
      const visible = validRooms.slice(0, mode === 'compact' ? 24 : 44)
      const z = map.getZoom()
      const subZoneCandidate = showSubZones ? safeSelectedGeohash || safeActiveGeohash : null
      const subZoneParent =
        subZoneCandidate && subZoneCandidate.length < 8 ? subZoneCandidate : null

      // Track freshly-arrived message IDs so only newly arrived messages play pop-in animation
      const freshGeohashes = new Set<string>()
      const seenMap = seenBubbleMsgRef.current
      if (!hasSeededBubblesRef.current) {
        for (const r of validRooms) {
          const snip = formatBubbleSnippet(r.lastPreview)
          if (!snip) continue
          const msgKey = r.lastMessageId || `${r.lastMessageAt ?? r.lastActivityAt}:${snip}`
          seenMap.set(r.geohash, msgKey)
        }
        hasSeededBubblesRef.current = true
      } else {
        for (const r of validRooms) {
          const snip = formatBubbleSnippet(r.lastPreview)
          if (!snip) continue
          const msgKey = r.lastMessageId || `${r.lastMessageAt ?? r.lastActivityAt}:${snip}`
          if (seenMap.get(r.geohash) !== msgKey) {
            seenMap.set(r.geohash, msgKey)
            freshGeohashes.add(r.geohash)
          }
        }
        if (seenMap.size > 200) {
          const liveSet = new Set(validRooms.map((r) => r.geohash))
          for (const key of seenMap.keys()) {
            if (!liveSet.has(key)) seenMap.delete(key)
          }
        }
      }

      // Compute screen-space collision-avoided compact speech bubbles
      const placedBubbles: Array<{ room: PulseRoom; snippet: string; isFocused: boolean }> = []
      const bubblePlacedSet = new Set<string>()

      if (showBubbles) {
        const mapSize = map.getSize()
        const isNarrow = mapSize.x < 640
        const bubbleW = isNarrow ? 132 : 154
        const bubbleH = isNarrow ? 42 : 46
        const bubbleGap = 6
        const maxBubbles = mode === 'compact' ? 3 : isNarrow ? 6 : 12

        const isTallExpanded = mode === 'expanded' && mapSize.y >= 460
        const minX = mode === 'expanded' ? 10 : 6
        const maxX = mode === 'expanded' ? mapSize.x - (isNarrow ? 58 : 66) : mapSize.x - 6
        const minY = isTallExpanded ? (isNarrow ? 104 : 96) : 6
        const maxY = isTallExpanded ? mapSize.y - (isNarrow ? 154 : 140) : mapSize.y - 6

        const focusBlocks: Array<{ geohash: string; box: ScreenBox }> = []
        const placedBoxes: ScreenBox[] = []

        const addFocusBadgeBlock = (gh: string | null) => {
          if (!gh || subZoneParent === gh) return
          const center = decodeCenter(gh)
          const pt = map.latLngToContainerPoint([center.lat, center.lon])
          const badgeW = Math.max(66, (gh.length + 1) * 7.5 + 18)
          const badgeH = 26
          focusBlocks.push({
            geohash: gh,
            box: {
              left: pt.x - badgeW / 2,
              right: pt.x + badgeW / 2,
              top: pt.y - badgeH / 2,
              bottom: pt.y + badgeH / 2,
            },
          })
        }
        addFocusBadgeBlock(safeActiveGeohash)
        if (safeSelectedGeohash && safeSelectedGeohash !== safeActiveGeohash) {
          addFocusBadgeBlock(safeSelectedGeohash)
        }

        const paddedBounds = map.getBounds().pad(0.08)
        const bubbleCandidates = validRooms
          .filter((room) => {
            if (subZoneParent === room.geohash) return false
            if (!paddedBounds.contains([room.center.lat, room.center.lon])) return false
            return formatBubbleSnippet(room.lastPreview).length > 0
          })
          .sort((a, b) => {
            // Keep an explicitly selected bubble pinned first so single-clicking it never evicts it
            const aSel = a.geohash === safeSelectedGeohash ? 1 : 0
            const bSel = b.geohash === safeSelectedGeohash ? 1 : 0
            if (aSel !== bSel) return bSel - aSel
            return (b.lastMessageAt ?? b.lastActivityAt) - (a.lastMessageAt ?? a.lastActivityAt)
          })

        for (const room of bubbleCandidates) {
          if (placedBubbles.length >= maxBubbles) break
          const snippet = formatBubbleSnippet(room.lastPreview)
          if (!snippet) continue

          const isFocused =
            room.geohash === safeActiveGeohash || room.geohash === safeSelectedGeohash
          // Lift focused room's bubble slightly above its focus pill so both stay crisp & clickable
          const tailOffset = isFocused ? 20 : 12
          const effectiveMinY = isFocused ? Math.max(6, minY - 8) : minY

          const pt = map.latLngToContainerPoint([room.center.lat, room.center.lon])
          const box: ScreenBox = {
            left: pt.x - bubbleW / 2,
            right: pt.x + bubbleW / 2,
            top: pt.y - tailOffset - bubbleH,
            bottom: pt.y - tailOffset,
          }

          if (box.left < minX || box.right > maxX || box.top < effectiveMinY || box.bottom > maxY) {
            continue
          }

          if (placedBoxes.some((other) => boxesOverlap(box, other, bubbleGap))) {
            continue
          }

          // Never let a room's own focus pill collide out that room's speech bubble
          if (
            focusBlocks.some(
              (fb) => fb.geohash !== room.geohash && boxesOverlap(box, fb.box, bubbleGap),
            )
          ) {
            continue
          }

          placedBoxes.push(box)
          placedBubbles.push({ room, snippet, isFocused })
          bubblePlacedSet.add(room.geohash)
        }
      }

      // 1. Render pulse zone polygons + sonar beacons (ensure every placed bubble has its beacon underneath)
      const visibleSet = new Set(visible.map((r) => r.geohash))
      const beaconRooms = [...visible]
      for (const { room } of placedBubbles) {
        if (!visibleSet.has(room.geohash)) {
          beaconRooms.push(room)
          visibleSet.add(room.geohash)
        }
      }

      for (const room of beaconRooms) {
        const b = decodeBounds(room.geohash)
        const latMin = Math.max(-85, b.latMin)
        const latMax = Math.min(85, b.latMax)
        const isCurrent = room.geohash === safeActiveGeohash
        const isFocused = isCurrent || room.geohash === safeSelectedGeohash
        const baseOpacity = isCurrent ? 0.56 : 0.45
        const baseFillOpacity = isCurrent ? 0.1 : 0.07

        // Highlight the live geohash zone polygon itself on Canvas
        const poly = L.rectangle(
          [
            [latMin, b.lonMin],
            [latMax, b.lonMax],
          ],
          {
            renderer,
            color: palette.accent,
            opacity: baseOpacity,
            fillColor: palette.accent,
            fillOpacity: baseFillOpacity,
            weight: 1.15,
            interactive: true,
          },
        )
        if (!isTouchDevice) {
          poly.on('mouseover', () => {
            poly.setStyle({ opacity: 0.74, fillOpacity: 0.13 })
          })
          poly.on('mouseout', () => {
            poly.setStyle({ opacity: baseOpacity, fillOpacity: baseFillOpacity })
          })
        }
        poly.on('click', (ev: L.LeafletMouseEvent) => {
          L.DomEvent.stopPropagation(ev)
          onSelectRef.current(room.geohash)
        })
        if (mode === 'expanded') {
          poly.on('dblclick', (ev: L.LeafletMouseEvent) => {
            L.DomEvent.stopPropagation(ev)
            onTuneRef.current?.(room.geohash)
          })
        }
        poly.addTo(layer)

        // Skip center sonar beacon when 32x sub-zones are expanded inside this exact cell
        if (subZoneParent === room.geohash) continue

        // Clickable sonar beacon at cell center (suppress side pill when cell has focus badge or speech bubble)
        const hasBubble = bubblePlacedSet.has(room.geohash)
        const showPill =
          !isFocused && !hasBubble && mode === 'expanded' && (z >= 4 || room.peerCount >= 2)
        const countTag = room.peerCount > 0 ? `${room.peerCount}p` : `${room.messageCount}m`
        const html = showPill
          ? `<div class="ag-gh-pulse-beacon with-pill"><span class="ag-gh-pulse-ring"></span><span class="ag-gh-pulse-core"></span><span class="ag-gh-pulse-pill mono">#${escapeHtml(room.geohash)} <b>${escapeHtml(countTag)}</b></span></div>`
          : `<div class="ag-gh-pulse-beacon"><span class="ag-gh-pulse-ring"></span><span class="ag-gh-pulse-core"></span></div>`

        const beacon = L.marker([room.center.lat, room.center.lon], {
          interactive: true,
          keyboard: true,
          title: `#${room.geohash}${room.nearestCity ? ` · ${room.nearestCity}` : ''} (${room.peerCount} ${room.peerCount === 1 ? 'peer' : 'peers'})`,
          icon: L.divIcon({
            className: 'ag-gh-beacon-host',
            html,
            iconSize: [18, 18],
            iconAnchor: [9, 9],
          }),
        })

        beacon.on('click', (ev: L.LeafletMouseEvent) => {
          L.DomEvent.stopPropagation(ev)
          onSelectRef.current(room.geohash)
        })
        if (mode === 'expanded') {
          beacon.on('dblclick', (ev: L.LeafletMouseEvent) => {
            L.DomEvent.stopPropagation(ev)
            onTuneRef.current?.(room.geohash)
          })
        }

        beacon.addTo(layer)
      }

      // 2. Reconcile compact live worldwide speech bubbles in-place so click #1 never detaches DOM before dblclick
      const existingMarkers = bubbleMarkersRef.current
      for (const [gh, entry] of existingMarkers.entries()) {
        if (!bubblePlacedSet.has(gh)) {
          bubbleLayer.removeLayer(entry.marker)
          existingMarkers.delete(gh)
        }
      }

      const nowMs = Date.now()
      for (const { room, snippet, isFocused } of placedBubbles) {
        const msgTs = room.lastMessageAt ?? room.lastActivityAt
        const isRecent = nowMs - msgTs < RECENT_BUBBLE_WINDOW_MS
        const isFresh = freshGeohashes.has(room.geohash)
        const sender = formatBubbleSender(room.lastSender)
        const msgKey = room.lastMessageId || `${msgTs}:${snippet}`
        const zIndexOffset = isFocused ? 420 : isRecent ? 240 : 210

        const buildBubbleIcon = (playFreshAnim: boolean) =>
          L.divIcon({
            className: 'ag-gh-bubble-host',
            html:
              `<div class="ag-gh-bubble${playFreshAnim ? ' is-fresh' : ''}${isRecent ? ' is-recent' : ''}${isFocused ? ' is-focused' : ''}">` +
              `<div class="ag-gh-bubble-head">` +
              `<span class="ag-gh-bubble-dot${isRecent ? ' is-live' : ''}"></span>` +
              `<span class="ag-gh-bubble-sender">${escapeHtml(sender)}</span>` +
              `<span class="ag-gh-bubble-tag mono">#${escapeHtml(room.geohash)}</span>` +
              `</div>` +
              `<div class="ag-gh-bubble-body">${escapeHtml(snippet)}</div>` +
              `</div>`,
            iconSize: [0, 0],
            iconAnchor: [0, 0],
          })

        const existing = existingMarkers.get(room.geohash)
        if (existing) {
          const curLatLng = existing.marker.getLatLng()
          if (curLatLng.lat !== room.center.lat || curLatLng.lng !== room.center.lon) {
            existing.marker.setLatLng([room.center.lat, room.center.lon])
          }
          existing.marker.setZIndexOffset(zIndexOffset)

          if (existing.msgKey !== msgKey) {
            existing.marker.setIcon(buildBubbleIcon(isFresh))
            existing.msgKey = msgKey
          } else {
            const el = existing.marker.getElement()
            const bubbleEl = el?.querySelector('.ag-gh-bubble')
            if (bubbleEl) {
              bubbleEl.classList.remove('is-fresh')
              bubbleEl.classList.toggle('is-focused', isFocused)
              bubbleEl.classList.toggle('is-recent', isRecent)
              const dotEl = bubbleEl.querySelector('.ag-gh-bubble-dot')
              dotEl?.classList.toggle('is-live', isRecent)
            }
          }
          continue
        }

        const gh = room.geohash
        const bubbleMarker = L.marker([room.center.lat, room.center.lon], {
          interactive: true,
          keyboard: true,
          riseOnHover: true,
          zIndexOffset,
          title: `#${gh} — ${sender}: ${snippet}`,
          icon: buildBubbleIcon(isFresh),
        })

        bubbleMarker.on('click', (ev: L.LeafletMouseEvent) => {
          L.DomEvent.stopPropagation(ev)
          onSelectRef.current(gh)
        })
        bubbleMarker.on('dblclick', (ev: L.LeafletMouseEvent) => {
          L.DomEvent.stopPropagation(ev)
          onTuneRef.current?.(gh)
        })

        bubbleMarker.addTo(bubbleLayer)
        existingMarkers.set(gh, { marker: bubbleMarker, msgKey })
      }
    }, [
      viewportTick,
      showPulse,
      showBubbles,
      showSubZones,
      pulseRooms,
      safeActiveGeohash,
      safeSelectedGeohash,
      mode,
      theme,
    ])

    // 8. Render Active Tuned Zone & Selected / Inspected Zone (Canvas-accelerated)
    useEffect(() => {
      const map = mapRef.current
      const layer = focusLayerRef.current
      const renderer = canvasRendererRef.current
      if (!map || !layer || !renderer) return

      layer.clearLayers()

      const palette = readCanvasPalette(containerRef.current, theme)

      // When 32x sub-zones are overlaid on a cell, hide its centered parent pill so center Base32 children stay clear
      const subZoneCandidate = showSubZones ? safeSelectedGeohash || safeActiveGeohash : null
      const subZoneParent =
        subZoneCandidate && subZoneCandidate.length < 8 ? subZoneCandidate : null

      // Active tuned geohash rectangle + badge
      if (safeActiveGeohash) {
        const activeCenter = decodeCenter(safeActiveGeohash)
        const activeRect = L.rectangle(getBoundsTuple(safeActiveGeohash), {
          renderer,
          color: palette.accent,
          opacity: 0.88,
          fillColor: palette.accent,
          fillOpacity: 0.1,
          weight: 2,
          interactive: false,
        })
        activeRect.addTo(layer)

        if (subZoneParent !== safeActiveGeohash) {
          L.marker([activeCenter.lat, activeCenter.lon], {
            interactive: false,
            keyboard: false,
            zIndexOffset: 300,
            icon: L.divIcon({
              className: 'ag-gh-label-host',
              html: `<span class="ag-gh-active-label mono">#${escapeHtml(safeActiveGeohash)}</span>`,
              iconSize: [0, 0],
            }),
          }).addTo(layer)
        }
      }

      // Selected / Inspected geohash rectangle + badge (distinct from active tuned cell)
      if (safeSelectedGeohash && safeSelectedGeohash !== safeActiveGeohash) {
        const selCenter = decodeCenter(safeSelectedGeohash)
        const selRect = L.rectangle(getBoundsTuple(safeSelectedGeohash), {
          renderer,
          color: palette.accentSecondary,
          opacity: 0.88,
          fillColor: palette.accentSecondary,
          fillOpacity: 0.1,
          weight: 2,
          dashArray: '6 4',
          interactive: false,
        })
        selRect.addTo(layer)

        if (subZoneParent !== safeSelectedGeohash) {
          L.marker([selCenter.lat, selCenter.lon], {
            interactive: false,
            keyboard: false,
            zIndexOffset: 400,
            icon: L.divIcon({
              className: 'ag-gh-label-host',
              html: `<span class="ag-gh-selected-label mono">#${escapeHtml(safeSelectedGeohash)}</span>`,
              iconSize: [0, 0],
            }),
          }).addTo(layer)
        }
      }
    }, [safeActiveGeohash, safeSelectedGeohash, showSubZones, viewportTick, theme])

    // 9. Render Physical GPS Beacon + Teleport Vector Polyline (Canvas-accelerated)
    useEffect(() => {
      const layer = gpsLayerRef.current
      const renderer = canvasRendererRef.current
      if (!layer || !renderer) return

      layer.clearLayers()
      if (!userCoords) return

      const palette = readCanvasPalette(containerRef.current, theme)

      if (isTeleported && safeActiveGeohash) {
        const activeCenter = decodeCenter(safeActiveGeohash)
        L.polyline(
          [
            [userCoords.lat, userCoords.lon],
            [activeCenter.lat, activeCenter.lon],
          ],
          {
            renderer,
            color: palette.accentSecondary,
            opacity: 0.82,
            weight: 1.6,
            dashArray: '5 5',
            interactive: false,
          },
        ).addTo(layer)
      }

      L.marker([userCoords.lat, userCoords.lon], {
        interactive: false,
        keyboard: false,
        zIndexOffset: 500,
        icon: L.divIcon({
          className: 'ag-gh-beacon-host',
          html: '<div class="ag-gh-gps-beacon"><span class="ag-gh-gps-halo"></span><span class="ag-gh-gps-dot"></span></div>',
          iconSize: [18, 18],
          iconAnchor: [9, 9],
        }),
      }).addTo(layer)
    }, [userCoords, isTeleported, safeActiveGeohash, theme])

    return (
      <div
        className={`ag-radar-map-host ag-radar-map-${mode} ${className}`}
        data-map-theme={theme}
      >
        <div
          ref={containerRef}
          className="ag-radar-leaflet-canvas"
          aria-label={`Interactive zoomable geohash map centered on #${safeActiveGeohash}`}
        />

        {/* Desktop hover coordinate & live geohash readout */}
        {hoverHud && (
          <div className="ag-radar-hover-hud mono" aria-hidden="true">
            <span className="ag-radar-hud-accent">#{hoverHud.geohash}</span>
            <span className="ag-radar-hud-sep">·</span>
            <span>{hoverHud.coords}</span>
          </div>
        )}
      </div>
    )
  },
)

export default TacticalGeohashMap
