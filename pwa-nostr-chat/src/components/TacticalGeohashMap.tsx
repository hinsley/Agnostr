import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import L from 'leaflet'
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
import { isTopicChannel } from '../lib/radioChannel.ts'

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

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function getBoundsTuple(geohash: string): L.LatLngBoundsExpression {
  const b = decodeBounds(geohash)
  return [
    [Math.max(-85, b.latMin), b.lonMin],
    [Math.min(85, b.latMax), b.lonMax],
  ]
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
    const tileLayerRef = useRef<L.TileLayer | null>(null)
    const refTileLayerRef = useRef<L.TileLayer | null>(null)
    const gridLayerRef = useRef<L.LayerGroup | null>(null)
    const pulseLayerRef = useRef<L.LayerGroup | null>(null)
    const subZoneLayerRef = useRef<L.LayerGroup | null>(null)
    const focusLayerRef = useRef<L.LayerGroup | null>(null)
    const gpsLayerRef = useRef<L.LayerGroup | null>(null)

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
          mapRef.current?.zoomIn(0.75)
        },
        zoomOut() {
          mapRef.current?.zoomOut(0.75)
        },
        flyToGeohash(geohash: string, options?: { animate?: boolean; zoom?: number }) {
          const map = mapRef.current
          if (!map || !geohash || isTopicChannel(geohash) || !isValidGeohash(geohash)) return
          flyToCellInternal(map, geohash, options)
        },
        flyToCoords(lat: number, lon: number, zoom = 11) {
          const map = mapRef.current
          if (!map) return
          map.flyTo([lat, lon], Math.max(2, Math.min(19, zoom)), {
            duration: 0.65,
            easeLinearity: 0.25,
          })
        },
        fitWorld() {
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

    // 1. Mount / unmount Leaflet map instance
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
        zoomSnap: 0,
        zoomDelta: 0.5,
        wheelPxPerZoomLevel: 90,
        wheelDebounceTime: 25,
        zoomAnimation: true,
        inertia: true,
        zoomControl: false,
        attributionControl: true,
        doubleClickZoom: false,
        worldCopyJump: true,
        maxBounds: [
          [-85, -200],
          [85, 200],
        ],
        maxBoundsViscosity: 0.75,
        preferCanvas: false,
      })

      map.attributionControl.setPrefix(false)

      const isLight = tileKindRef.current === 'light'
      const tileLayer = L.tileLayer(isLight ? ESRI_TOPO_URL : ESRI_DARK_BASE_URL, {
        maxNativeZoom: isLight ? 17 : 16,
        maxZoom: 19,
        attribution: TILE_ATTRIBUTION,
      }).addTo(map)

      const refTileLayer = isLight
        ? null
        : L.tileLayer(ESRI_DARK_REF_URL, {
            maxNativeZoom: 16,
            maxZoom: 19,
            opacity: 0.95,
            attribution: '',
          }).addTo(map)

      const gridLayer = L.layerGroup().addTo(map)
      const pulseLayer = L.layerGroup().addTo(map)
      const subZoneLayer = L.layerGroup().addTo(map)
      const focusLayer = L.layerGroup().addTo(map)
      const gpsLayer = L.layerGroup().addTo(map)

      mapRef.current = map
      tileLayerRef.current = tileLayer
      refTileLayerRef.current = refTileLayer
      gridLayerRef.current = gridLayer
      pulseLayerRef.current = pulseLayer
      subZoneLayerRef.current = subZoneLayer
      focusLayerRef.current = focusLayer
      gpsLayerRef.current = gpsLayer

      const emitViewport = () => {
        const z = map.getZoom()
        const p =
          precisionModeRef.current === 'auto'
            ? getRecommendedPrecisionForZoom(z)
            : precisionModeRef.current
        onViewportInfoRef.current?.({ zoom: z, effectivePrecision: p })
        setViewportTick((t) => t + 1)
      }

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

      map.on('moveend zoomend', emitViewport)
      map.on('click', handleMapClick)
      map.on('dblclick', handleMapDblClick)
      map.on('mousemove', handleMouseMove)
      map.on('mouseout', handleMouseOut)

      // Keep Leaflet crisp across drawer & modal animations
      const ro = new ResizeObserver(() => {
        map.invalidateSize({ animate: false })
        setViewportTick((t) => t + 1)
      })
      ro.observe(el)

      const settleTimer = window.setTimeout(() => {
        map.invalidateSize({ animate: false })
        emitViewport()
      }, 180)

      emitViewport()

      return () => {
        window.clearTimeout(settleTimer)
        ro.disconnect()
        map.off()
        map.remove()
        mapRef.current = null
        tileLayerRef.current = null
        refTileLayerRef.current = null
        gridLayerRef.current = null
        pulseLayerRef.current = null
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
        attribution: TILE_ATTRIBUTION,
      }).addTo(map)

      if (!isLight) {
        refTileLayerRef.current = L.tileLayer(ESRI_DARK_REF_URL, {
          maxNativeZoom: 16,
          maxZoom: 19,
          opacity: 0.95,
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

    // 5. Render Live Geohash Zone Grid Overlay
    useEffect(() => {
      const map = mapRef.current
      const layer = gridLayerRef.current
      if (!map || !layer) return

      layer.clearLayers()

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
            className: isFocus ? 'ag-gh-rect ag-gh-rect-under-focus' : 'ag-gh-rect',
            weight: 0.75,
            interactive: true,
          },
        )

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
    }, [viewportTick, precisionMode, safeActiveGeohash, safeSelectedGeohash, showPulse, pulseRooms, mode])

    // 6. Render Sub-Zone 32× Drill-Down Overlay
    useEffect(() => {
      const map = mapRef.current
      const layer = subZoneLayerRef.current
      if (!map || !layer) return

      layer.clearLayers()
      if (!showSubZones) return

      const parentHash = safeSelectedGeohash || safeActiveGeohash
      if (!parentHash || parentHash.length >= 8) return

      const children = getChildGeohashes(parentHash)
      for (const child of children) {
        const latMin = Math.max(-85, child.bounds.latMin)
        const latMax = Math.min(85, child.bounds.latMax)
        const isChildActive = child.geohash === safeActiveGeohash
        const isChildSelected = child.geohash === safeSelectedGeohash

        const rect = L.rectangle(
          [
            [latMin, child.bounds.lonMin],
            [latMax, child.bounds.lonMax],
          ],
          {
            className: `ag-gh-sub-rect${isChildActive ? ' active' : ''}${isChildSelected ? ' selected' : ''}`,
            weight: 0.9,
            dashArray: '3 3',
            interactive: true,
          },
        )

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
    }, [viewportTick, showSubZones, safeActiveGeohash, safeSelectedGeohash, mode])

    // 7. Render Live Global Pulse Zones & Sonar Beacons
    useEffect(() => {
      const map = mapRef.current
      const layer = pulseLayerRef.current
      if (!map || !layer) return

      layer.clearLayers()
      if (!showPulse || pulseRooms.length === 0) return

      const visible = pulseRooms
        .filter((r) => !isTopicChannel(r.geohash) && isValidGeohash(r.geohash))
        .slice(0, mode === 'compact' ? 24 : 44)
      const z = map.getZoom()
      const subZoneCandidate = showSubZones ? safeSelectedGeohash || safeActiveGeohash : null
      const subZoneParent =
        subZoneCandidate && subZoneCandidate.length < 8 ? subZoneCandidate : null

      for (const room of visible) {
        const b = decodeBounds(room.geohash)
        const latMin = Math.max(-85, b.latMin)
        const latMax = Math.min(85, b.latMax)
        const isCurrent = room.geohash === safeActiveGeohash
        const isFocused = isCurrent || room.geohash === safeSelectedGeohash

        // Highlight the live geohash zone polygon itself
        const poly = L.rectangle(
          [
            [latMin, b.lonMin],
            [latMax, b.lonMax],
          ],
          {
            className: isCurrent ? 'ag-gh-pulse-rect active' : 'ag-gh-pulse-rect',
            weight: 1.15,
            interactive: true,
          },
        )
        poly.on('click', (ev: L.LeafletMouseEvent) => {
          L.DomEvent.stopPropagation(ev)
          onSelectRef.current(room.geohash)
        })
        poly.addTo(layer)

        // Skip center sonar beacon when 32x sub-zones are expanded inside this exact cell
        if (subZoneParent === room.geohash) continue

        // Clickable sonar beacon at cell center (suppress duplicate pill when cell already has focus badge)
        const showPill = !isFocused && mode === 'expanded' && (z >= 4 || room.peerCount >= 2)
        const countTag =
          room.peerCount > 0 ? `${room.peerCount}p` : `${room.messageCount}m`
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
    }, [viewportTick, showPulse, showSubZones, pulseRooms, safeActiveGeohash, safeSelectedGeohash, mode])

    // 8. Render Active Tuned Zone & Selected / Inspected Zone
    useEffect(() => {
      const map = mapRef.current
      const layer = focusLayerRef.current
      if (!map || !layer) return

      layer.clearLayers()

      // When 32x sub-zones are overlaid on a cell, hide its centered parent pill so center Base32 children stay clear
      const subZoneCandidate = showSubZones ? safeSelectedGeohash || safeActiveGeohash : null
      const subZoneParent =
        subZoneCandidate && subZoneCandidate.length < 8 ? subZoneCandidate : null

      // Active tuned geohash rectangle + badge
      if (safeActiveGeohash) {
        const activeCenter = decodeCenter(safeActiveGeohash)
        const activeRect = L.rectangle(getBoundsTuple(safeActiveGeohash), {
          className: 'ag-gh-active-rect',
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
          className: 'ag-gh-selected-rect',
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
    }, [safeActiveGeohash, safeSelectedGeohash, showSubZones, viewportTick])

    // 9. Render Physical GPS Beacon + Teleport Vector Polyline
    useEffect(() => {
      const layer = gpsLayerRef.current
      if (!layer) return

      layer.clearLayers()
      if (!userCoords) return

      if (isTeleported && safeActiveGeohash) {
        const activeCenter = decodeCenter(safeActiveGeohash)
        L.polyline(
          [
            [userCoords.lat, userCoords.lon],
            [activeCenter.lat, activeCenter.lon],
          ],
          {
            className: 'ag-gh-teleport-line',
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
    }, [userCoords, isTeleported, safeActiveGeohash])

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
