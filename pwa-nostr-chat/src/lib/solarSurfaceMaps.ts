import * as THREE from 'three'
import overviewUrl from '../assets/solar/solar-overview.webp?no-inline'
import slots from '../assets/solar/slots.json'
import { SOLAR_BODIES, type GeohashableBodyId } from './solarSystem'

const detailUrls = import.meta.glob<string>('../assets/solar/surface-*.webp', {
  eager: true, import: 'default', query: '?url&no-inline',
})

type DetailSize = 0 | 512 | 1024
type Uniforms = Record<string, THREE.IUniform>

function detailSize(): DetailSize {
  const device = navigator as Navigator & { deviceMemory?: number; connection?: { saveData?: boolean } }
  if (device.connection?.saveData) return 0
  return (device.deviceMemory ?? 8) <= 4 || window.matchMedia('(pointer: coarse), (max-width: 760px)').matches
    ? 512 : 1024
}

const COLUMNS = 5
const ATLAS_WIDTH = COLUMNS * 128
const ATLAS_HEIGHT = Math.ceil(Object.keys(slots).length / COLUMNS) * 64

/** A scene owns one preview atlas and, at most, one focused-world detail texture.
 * No global canvas cache, per-frame generation, or full-map download for distant bodies. */
export class SolarSurfaceMaps {
  private readonly atlas = new THREE.Texture()
  private readonly atlasReady = { value: false }
  private readonly atlasImage = new Image()
  private readonly size = detailSize()
  private readonly anisotropy: number
  private pending: HTMLImageElement | null = null
  private detail: THREE.Texture | null = null
  private focused: GeohashableBodyId | null = null

  constructor(maxAnisotropy: number) {
    this.anisotropy = Math.min(this.size === 512 ? 2 : 4, maxAnisotropy)
    this.atlas.name = 'Solar overview'
    this.atlas.userData.cached = true // owned here, never by a transient material
    this.atlas.colorSpace = THREE.SRGBColorSpace
    this.atlas.generateMipmaps = false // mips across atlas slots would bleed other planets
    this.atlas.minFilter = THREE.LinearFilter
    this.atlasImage.decoding = 'async'
    this.atlasImage.onload = () => {
      this.atlas.image = this.atlasImage
      this.atlas.needsUpdate = true
      this.atlasReady.value = true
    }
    this.atlasImage.src = overviewUrl
  }

  get focusTextureWidth() { return this.size }

  /** Fill the existing Earth basemap from the photos before Esri tiles arrive.
   * Do not delay the tile requests or paint over an already-composited tile. */
  async paintEarthBackdrop(canvas: HTMLCanvasElement, mayPaint: () => boolean): Promise<boolean> {
    try {
      await this.atlasImage.decode()
    } catch {
      return false
    }
    const ctx = mayPaint() ? canvas.getContext('2d') : null
    if (!ctx) return false
    const slot = slots.earth
    ctx.drawImage(this.atlasImage, (slot % COLUMNS) * 128 + 4, Math.floor(slot / COLUMNS) * 64 + 2, 120, 60, 0, 0, canvas.width, canvas.height)
    return true
  }

  preview(body: GeohashableBodyId, distant = true): Uniforms {
    const key = distant && body === 'venus' ? 'venus-clouds' : distant && body === 'titan' ? 'titan-haze' : body
    const slot = slots[key]
    // Sphere UVs run south to north; the image, with canvas-style flipY, is north-up.
    const left = (slot % COLUMNS) * 128 + 4
    const bottom = ATLAS_HEIGHT - (Math.floor(slot / COLUMNS) * 64 + 62)
    return {
      uMap: { value: this.atlas },
      uMapRect: { value: new THREE.Vector4(left / ATLAS_WIDTH, bottom / ATLAS_HEIGHT, 120 / ATLAS_WIDTH, 60 / ATLAS_HEIGHT) },
      uMapReady: this.atlasReady,
      uBaseColor: { value: new THREE.Color(SOLAR_BODIES[body].palette.primary) },
    }
  }

  /** Earth has its own Esri cartography. Null releases a focus map without loading another. */
  focus(body: Exclude<GeohashableBodyId, 'earth'> | null, uniforms: Uniforms) {
    if (body === this.focused) return
    this.focused = body
    Object.assign(uniforms, this.preview(body ?? 'earth', false))
    this.releaseDetail()
    if (!body || !this.size) return

    const image = new Image()
    this.pending = image
    image.decoding = 'async'
    image.onload = () => {
      if (this.pending !== image) return
      this.pending = null
      image.onload = image.onerror = null
      const texture = new THREE.Texture(image)
      texture.name = `Solar surface: ${body}`
      texture.userData.cached = true
      texture.colorSpace = THREE.SRGBColorSpace
      texture.wrapS = THREE.RepeatWrapping
      texture.anisotropy = this.anisotropy
      texture.needsUpdate = true
      this.detail = texture
      uniforms.uMap.value = texture
      uniforms.uMapRect.value.set(0, 0, 1, 1)
      uniforms.uMapReady = { value: true }
    }
    image.onerror = () => {
      // Keep the atlas if detail is unavailable (including opening a new world offline).
      if (this.pending === image) this.pending = null
      image.onload = image.onerror = null
    }
    image.src = detailUrls[`../assets/solar/surface-${body}-${this.size}.webp`]
  }

  private releaseDetail() {
    if (this.pending) {
      this.pending.onload = this.pending.onerror = null
      this.pending.removeAttribute('src')
      this.pending = null
    }
    this.detail?.dispose()
    this.detail = null
  }

  dispose() {
    this.releaseDetail()
    this.atlasImage.onload = null
    this.atlasImage.removeAttribute('src')
    this.atlas.dispose()
  }
}
