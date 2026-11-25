import * as THREE from 'three'

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function hashBodySeed(bodyId: string): number {
  let h = 2166136261 >>> 0
  for (let i = 0; i < bodyId.length; i++) {
    h ^= bodyId.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

/**
 * Generates a translucent radial banded ring texture (with Cassini Division &
 * delicate concentric ringlets) for Saturn and Uranus.
 */
export function createPlanetaryRingTexture(color: string): THREE.CanvasTexture {
  const w = 512
  const h = 16
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')

  if (ctx) {
    const rand = mulberry32(hashBodySeed(`ring:${color}`))
    const base = new THREE.Color(color)
    const r = Math.round(base.r * 255)
    const g = Math.round(base.g * 255)
    const b = Math.round(base.b * 255)

    ctx.clearRect(0, 0, w, h)
    for (let x = 0; x < w; x++) {
      const u = x / (w - 1) // 0 = inner edge, 1 = outer edge
      let alpha = 0
      if (u < 0.06) {
        alpha = (u / 0.06) * 0.26
      } else if (u < 0.22) {
        // Translucent C Ring
        alpha = 0.24 + 0.14 * Math.sin(u * 48)
      } else if (u < 0.6) {
        // Bright dense B Ring
        alpha = 0.78 + 0.16 * Math.sin(u * 90) + 0.06 * Math.cos(u * 210)
      } else if (u < 0.675) {
        // Dark Cassini Division gap
        alpha = 0.06
      } else if (u < 0.88) {
        // Luminous A Ring
        alpha = 0.56 + 0.12 * Math.sin(u * 130)
      } else if (u < 0.905) {
        // Thin Encke Gap
        alpha = 0.1
      } else if (u < 0.96) {
        alpha = 0.42 * (1 - (u - 0.905) / 0.055)
      } else {
        alpha = 0.0
      }

      const ringletShade = 0.86 + 0.24 * Math.sin(u * 320 + rand() * 0.4)
      const cr = Math.min(255, Math.round(r * ringletShade))
      const cg = Math.min(255, Math.round(g * ringletShade))
      const cb = Math.min(255, Math.round(b * ringletShade))
      ctx.fillStyle = `rgba(${cr},${cg},${cb},${Math.max(0, Math.min(1, alpha))})`
      ctx.fillRect(x, 0, 1, h)
    }
  }

  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.wrapS = THREE.ClampToEdgeWrapping
  tex.wrapT = THREE.RepeatWrapping
  tex.needsUpdate = true
  return tex
}
