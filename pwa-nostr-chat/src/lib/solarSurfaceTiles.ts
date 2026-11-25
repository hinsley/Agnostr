import * as THREE from 'three'
import levels from '../assets/solar-tile-levels.json'
import {
  surfaceTilePlan, tileKey, TILE_COLUMNS, TILE_GRID_HEIGHT, TILE_GRID_WIDTH, TILE_STRIDE, MAX_TILE_LEVEL,
  type SurfaceTile,
} from './solarTileLayout.ts'
import type { GeohashableBodyId } from './solarSystem'

type SurfaceBody = Exclude<GeohashableBodyId, 'earth'>
type Slot = { tile: SurfaceTile; index: number; used: number }

const retryMs = 45_000

/** Dedicated to the focused globe. Upload one bounded atlas, never a full
 * high-res map. A nearest-neighbor indirection texture selects the sharpest
 * resident tile for each UV. Uncovered pixels use the existing whole globe. */
export class SolarSurfaceTiles {
  private body: SurfaceBody | null = null
  private readonly baseWidth: number
  private readonly capacity: number
  private readonly concurrent: number
  private readonly slots = new Map<string, Slot>()
  private readonly loading = new Map<string, AbortController>()
  private readonly failed = new Map<string, number>()
  private wanted: SurfaceTile[] = []
  private wantedKeys = new Set<string>()
  private canvas: HTMLCanvasElement | null = null
  private ctx: CanvasRenderingContext2D | null = null
  private atlas: THREE.CanvasTexture | null = null
  private lookup: THREE.DataTexture | null = null
  private lastCheck = -Infinity
  private clock = 0
  private dirty = false

  readonly uniforms = {
    uSurfaceAtlas: { value: null as THREE.CanvasTexture | null },
    uSurfaceLookup: { value: null as THREE.DataTexture | null },
    uSurfaceAtlasRows: { value: 0 },
    uSurfaceTilesReady: { value: false },
  }

  constructor(baseWidth: number) {
    this.baseWidth = baseWidth
    this.capacity = baseWidth === 512 ? 8 : 16
    this.concurrent = baseWidth === 512 ? 2 : 4
    this.uniforms.uSurfaceAtlasRows.value = this.capacity / TILE_COLUMNS
  }

  focus(body: SurfaceBody | null) {
    if (body === this.body) return
    this.dispose()
    this.body = body
  }

  update(now: number, lat: number, lon: number, altitude: number, fov: number, aspect: number, height: number) {
    if (!this.body || !this.baseWidth || height < 1) return
    this.clock = now
    if (now - this.lastCheck >= 160) {
      this.lastCheck = now
      const manifest = levels as Record<string, { level: number; revision: string }>
      const maxLevel = manifest[this.body]?.level ?? -1
      this.wanted = maxLevel < 0 ? [] : surfaceTilePlan(lat, lon, altitude, fov, aspect, height, this.baseWidth, maxLevel, this.capacity)
      this.wantedKeys = new Set(this.wanted.map(tileKey))
      for (const [key, req] of this.loading) {
        if (!this.wantedKeys.has(key)) req.abort()
      }
      for (const [key, slot] of this.slots) {
        if (this.wantedKeys.has(key)) slot.used = now
      }
      this.uniforms.uSurfaceTilesReady.value = this.wanted.length > 0 && this.slots.size > 0
      this.pump()
    }
    if (this.dirty && this.atlas && this.lookup) {
      this.dirty = false
      this.atlas.needsUpdate = true
      this.updateLookup()
      this.uniforms.uSurfaceTilesReady.value = this.wanted.length > 0
    }
  }

  private init() {
    if (this.ctx) return this.ctx
    const canvas = document.createElement('canvas')
    canvas.width = TILE_COLUMNS * TILE_STRIDE
    canvas.height = this.capacity / TILE_COLUMNS * TILE_STRIDE
    const ctx = canvas.getContext('2d', { alpha: false })
    if (!ctx) return null
    this.canvas = canvas
    this.ctx = ctx
    const atlas = new THREE.CanvasTexture(canvas)
    atlas.colorSpace = THREE.SRGBColorSpace
    atlas.generateMipmaps = false // no cross-slot bleed
    atlas.minFilter = THREE.LinearFilter
    this.atlas = atlas
    this.lookup = new THREE.DataTexture(new Uint8Array(TILE_GRID_WIDTH * TILE_GRID_HEIGHT * 4), TILE_GRID_WIDTH, TILE_GRID_HEIGHT)
    this.uniforms.uSurfaceAtlas.value = atlas
    this.uniforms.uSurfaceLookup.value = this.lookup
    return ctx
  }

  private pump() {
    const body = this.body
    if (!body) return
    const manifest = levels as Record<string, { level: number; revision: string }>
    const revision = manifest[body]?.revision
    if (!revision) return
    for (const tile of this.wanted) {
      if (this.loading.size >= this.concurrent) break
      const key = tileKey(tile)
      if (this.slots.has(key) || this.loading.has(key) || (this.failed.get(key) ?? -Infinity) > this.clock) continue
      const request = new AbortController()
      this.loading.set(key, request)
      void this.load(body, revision, tile, key, request)
    }
  }

  private async load(body: SurfaceBody, revision: string, tile: SurfaceTile, key: string, request: AbortController) {
    let objectUrl: string | undefined
    try {
      const response = await fetch(`${import.meta.env.BASE_URL}solar-tiles/${body}/${revision}/${key}.webp`, { signal: request.signal })
      if (!response.ok) throw new Error('Tile unavailable')
      objectUrl = URL.createObjectURL(await response.blob())
      const image = new Image()
      image.src = objectUrl
      await image.decode()
      if (request.signal.aborted || this.body !== body || !this.wantedKeys.has(key)) return
      if (image.naturalWidth !== TILE_STRIDE || image.naturalHeight !== TILE_STRIDE) throw new Error('Unexpected tile size')
      const ctx = this.init()
      if (!ctx) throw new Error('Tile canvas unavailable')
      let index = 0
      if (this.slots.size < this.capacity) {
        const used = new Set([...this.slots.values()].map(slot => slot.index))
        while (used.has(index)) index++
      } else {
        const replacement = [...this.slots.entries()].filter(([k]) => !this.wantedKeys.has(k)).sort((a, b) => a[1].used - b[1].used)[0]
        if (!replacement) return
        this.slots.delete(replacement[0])
        index = replacement[1].index
      }
      ctx.drawImage(image, index % TILE_COLUMNS * TILE_STRIDE, Math.floor(index / TILE_COLUMNS) * TILE_STRIDE)
      this.slots.set(key, { tile, index, used: this.clock })
      this.failed.delete(key)
      this.dirty = true
    } catch {
      if (!request.signal.aborted) this.failed.set(key, this.clock + retryMs)
    } finally {
      if (objectUrl) URL.revokeObjectURL(objectUrl)
      if (this.loading.get(key) === request) {
        this.loading.delete(key)
        this.pump()
      }
    }
  }

  private updateLookup() {
    if (!this.lookup) return
    const data = this.lookup.image.data
    if (!data) return
    data.fill(0)
    // Coarse first, so fine content replaces coarse coverage when both are resident.
    for (const { tile, index } of [...this.slots.values()].sort((a, b) => a.tile.level - b.tile.level)) {
      const span = 1 << (MAX_TILE_LEVEL - tile.level)
      for (let y = tile.y * span; y < (tile.y + 1) * span; y++) {
        for (let x = tile.x * span; x < (tile.x + 1) * span; x++) {
          const i = (y * TILE_GRID_WIDTH + x) * 4
          data[i] = index + 1
          data[i + 1] = tile.level
        }
      }
    }
    this.lookup.needsUpdate = true
  }

  dispose() {
    for (const request of this.loading.values()) request.abort()
    this.loading.clear()
    this.slots.clear()
    this.failed.clear()
    this.wanted = []
    this.wantedKeys.clear()
    this.uniforms.uSurfaceAtlas.value = null
    this.uniforms.uSurfaceLookup.value = null
    this.uniforms.uSurfaceTilesReady.value = false
    this.atlas?.dispose()
    this.lookup?.dispose()
    if (this.canvas) this.canvas.width = this.canvas.height = 1
    this.canvas = this.ctx = this.atlas = this.lookup = null
    this.body = null
    this.dirty = false
    this.lastCheck = -Infinity
  }
}
