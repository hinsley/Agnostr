import * as THREE from 'three'
import { SOLAR_BODIES, type GeohashableBodyId } from './solarSystem.ts'

const textureCache = new Map<string, THREE.CanvasTexture>()

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

function lonToX(lonDeg: number, w: number): number {
  const wrapped = (((lonDeg + 180) % 360) + 360) % 360
  return (wrapped / 360) * w
}

function latToY(latDeg: number, h: number): number {
  const clamped = Math.max(-90, Math.min(90, latDeg))
  return ((90 - clamped) / 180) * h
}

function hexToRgba(hex: string, alpha: number): string {
  const clean = hex.replace('#', '')
  const full =
    clean.length === 3
      ? clean
          .split('')
          .map((c) => c + c)
          .join('')
      : clean
  const num = Number.parseInt(full, 16)
  if (Number.isNaN(num)) return `rgba(180,180,180,${alpha})`
  const r = (num >> 16) & 255
  const g = (num >> 8) & 255
  const b = num & 255
  return `rgba(${r},${g},${b},${alpha})`
}

function drawWrappedRadialBlob(
  ctx: CanvasRenderingContext2D,
  w: number,
  x: number,
  y: number,
  rx: number,
  ry: number,
  innerColor: string,
  outerColor: string,
): void {
  const offsets = [0, -w, w]
  for (const dx of offsets) {
    const cx = x + dx
    if (cx + rx < -4 || cx - rx > w + 4) continue
    ctx.save()
    ctx.translate(cx, y)
    ctx.scale(1, ry / Math.max(0.001, rx))
    const grad = ctx.createRadialGradient(0, 0, rx * 0.08, 0, 0, rx)
    grad.addColorStop(0, innerColor)
    grad.addColorStop(0.62, innerColor)
    grad.addColorStop(1, outerColor)
    ctx.fillStyle = grad
    ctx.beginPath()
    ctx.arc(0, 0, rx, 0, Math.PI * 2)
    ctx.fill()
    ctx.restore()
  }
}

function drawWrappedCrater(
  ctx: CanvasRenderingContext2D,
  w: number,
  x: number,
  y: number,
  r: number,
  floorRgba: string,
  rimRgba: string,
  rayRgba?: string,
): void {
  const offsets = [0, -w, w]
  for (const dx of offsets) {
    const cx = x + dx
    if (cx + r * 3 < -4 || cx - r * 3 > w + 4) continue
    if (rayRgba) {
      ctx.save()
      ctx.strokeStyle = rayRgba
      ctx.lineWidth = Math.max(0.7, r * 0.14)
      for (let k = 0; k < 7; k++) {
        const ang = (k / 7) * Math.PI * 2 + (x * 0.03)
        ctx.beginPath()
        ctx.moveTo(cx + Math.cos(ang) * r * 0.85, y + Math.sin(ang) * r * 0.85)
        ctx.lineTo(cx + Math.cos(ang) * r * 2.5, y + Math.sin(ang) * r * 2.5)
        ctx.stroke()
      }
      ctx.restore()
    }
    ctx.fillStyle = floorRgba
    ctx.beginPath()
    ctx.arc(cx, y, r, 0, Math.PI * 2)
    ctx.fill()

    ctx.strokeStyle = rimRgba
    ctx.lineWidth = Math.max(0.7, r * 0.16)
    ctx.beginPath()
    ctx.arc(cx - r * 0.1, y - r * 0.1, r * 0.96, 0, Math.PI * 2)
    ctx.stroke()
  }
}

function paintMottledTerrain(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  rand: () => number,
  primary: string,
  secondary: string,
  detail: string,
  blobCount: number,
): void {
  ctx.fillStyle = primary
  ctx.fillRect(0, 0, w, h)

  for (let i = 0; i < blobCount; i++) {
    const x = rand() * w
    const y = rand() * h
    const rx = (0.04 + rand() * 0.13) * w
    const ry = rx * (0.45 + rand() * 0.55)
    const isLight = rand() > 0.54
    const col = isLight ? detail : secondary
    const alpha = 0.14 + rand() * 0.24
    drawWrappedRadialBlob(ctx, w, x, y, rx, ry, hexToRgba(col, alpha), hexToRgba(col, 0))
  }
}

function paintEarthProcedural(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  const rand = mulberry32(19721207)
  const oceanGrad = ctx.createLinearGradient(0, 0, 0, h)
  oceanGrad.addColorStop(0, '#DCEAF5')
  oceanGrad.addColorStop(0.08, '#2C72B8')
  oceanGrad.addColorStop(0.5, '#1D5FA8')
  oceanGrad.addColorStop(0.92, '#2C72B8')
  oceanGrad.addColorStop(1, '#E5F0F8')
  ctx.fillStyle = oceanGrad
  ctx.fillRect(0, 0, w, h)

  // Stylized continents positioned at authentic Earth longitudes/latitudes
  const continents: Array<{ lat: number; lon: number; rx: number; ry: number; col: string }> = [
    // North America
    { lat: 44, lon: -102, rx: 0.12, ry: 0.14, col: '#3B8A4E' },
    { lat: 24, lon: -96, rx: 0.055, ry: 0.06, col: '#699B52' },
    // South America
    { lat: -14, lon: -60, rx: 0.075, ry: 0.16, col: '#2F8245' },
    { lat: -36, lon: -66, rx: 0.038, ry: 0.09, col: '#7C9356' },
    // Europe
    { lat: 52, lon: 18, rx: 0.08, ry: 0.075, col: '#4A9352' },
    // Africa
    { lat: 22, lon: 16, rx: 0.09, ry: 0.095, col: '#C7A96B' },
    { lat: -6, lon: 24, rx: 0.075, ry: 0.13, col: '#3F8648' },
    // Asia
    { lat: 52, lon: 88, rx: 0.18, ry: 0.13, col: '#4D8E52' },
    { lat: 30, lon: 102, rx: 0.12, ry: 0.09, col: '#789A58' },
    { lat: 22, lon: 48, rx: 0.06, ry: 0.065, col: '#CBA86D' },
    // Australia
    { lat: -25, lon: 134, rx: 0.075, ry: 0.065, col: '#C48A54' },
    // Greenland
    { lat: 73, lon: -42, rx: 0.055, ry: 0.055, col: '#E8F0F6' },
  ]
  for (const c of continents) {
    drawWrappedRadialBlob(
      ctx,
      w,
      lonToX(c.lon, w),
      latToY(c.lat, h),
      c.rx * w,
      c.ry * h,
      hexToRgba(c.col, 0.92),
      hexToRgba(c.col, 0),
    )
  }

  // Polar ice caps
  const northCap = ctx.createLinearGradient(0, 0, 0, h * 0.13)
  northCap.addColorStop(0, 'rgba(244, 249, 255, 0.95)')
  northCap.addColorStop(1, 'rgba(244, 249, 255, 0)')
  ctx.fillStyle = northCap
  ctx.fillRect(0, 0, w, h * 0.13)

  const southCap = ctx.createLinearGradient(0, h * 0.86, 0, h)
  southCap.addColorStop(0, 'rgba(244, 249, 255, 0)')
  southCap.addColorStop(1, 'rgba(244, 249, 255, 0.96)')
  ctx.fillStyle = southCap
  ctx.fillRect(0, h * 0.86, w, h * 0.14)

  // Soft atmospheric cloud wisps
  for (let i = 0; i < 28; i++) {
    const cx = rand() * w
    const cy = (0.12 + rand() * 0.76) * h
    const rx = (0.04 + rand() * 0.11) * w
    const ry = (0.012 + rand() * 0.025) * h
    drawWrappedRadialBlob(
      ctx,
      w,
      cx,
      cy,
      rx,
      ry,
      `rgba(255,255,255,${0.26 + rand() * 0.24})`,
      'rgba(255,255,255,0)',
    )
  }
}

function paintMoon(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  const rand = mulberry32(4201969)
  paintMottledTerrain(ctx, w, h, rand, '#C4C6CA', '#8F939C', '#E4E6EA', 24)

  // Authentic dark basalt maria
  const maria: Array<{ lat: number; lon: number; rx: number; ry: number }> = [
    { lat: 18, lon: -57, rx: 0.13, ry: 0.15 }, // Oceanus Procellarum
    { lat: 33, lon: -16, rx: 0.095, ry: 0.1 }, // Mare Imbrium
    { lat: 28, lon: 18, rx: 0.068, ry: 0.075 }, // Mare Serenitatis
    { lat: 8, lon: 30, rx: 0.075, ry: 0.08 }, // Sea of Tranquility
    { lat: -15, lon: 48, rx: 0.06, ry: 0.06 }, // Mare Fecunditatis
    { lat: 17, lon: 59, rx: 0.045, ry: 0.045 }, // Mare Crisium
    { lat: -53, lon: -169, rx: 0.14, ry: 0.11 }, // South Pole-Aitken
  ]
  for (const m of maria) {
    drawWrappedRadialBlob(
      ctx,
      w,
      lonToX(m.lon, w),
      latToY(m.lat, h),
      m.rx * w,
      m.ry * h,
      'rgba(96, 100, 108, 0.62)',
      'rgba(96, 100, 108, 0)',
    )
  }

  const craterCount = w >= 512 ? 220 : 95
  for (let i = 0; i < craterCount; i++) {
    const cx = rand() * w
    const cy = (0.04 + rand() * 0.92) * h
    const r = (0.004 + Math.pow(rand(), 2.3) * 0.026) * h
    drawWrappedCrater(
      ctx,
      w,
      cx,
      cy,
      r,
      `rgba(76, 79, 86, ${0.18 + rand() * 0.24})`,
      `rgba(235, 237, 240, ${0.22 + rand() * 0.22})`,
    )
  }

  // Iconic bright ray craters: Tycho & Copernicus
  drawWrappedCrater(
    ctx,
    w,
    lonToX(-11.36, w),
    latToY(-43.31, h),
    h * 0.028,
    'rgba(105, 108, 114, 0.5)',
    'rgba(248, 250, 252, 0.78)',
    'rgba(242, 244, 248, 0.28)',
  )
  drawWrappedCrater(
    ctx,
    w,
    lonToX(-20.08, w),
    latToY(9.62, h),
    h * 0.024,
    'rgba(105, 108, 114, 0.45)',
    'rgba(246, 248, 252, 0.72)',
    'rgba(240, 242, 246, 0.24)',
  )
}

function paintMercury(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  const rand = mulberry32(hashBodySeed('mercury'))
  paintMottledTerrain(ctx, w, h, rand, '#9A958E', '#67625B', '#C6C0B6', 32)

  // Caloris Basin & Rembrandt
  drawWrappedRadialBlob(
    ctx,
    w,
    lonToX(-170.2, w),
    latToY(30.5, h),
    w * 0.095,
    h * 0.14,
    'rgba(186, 174, 158, 0.62)',
    'rgba(186, 174, 158, 0)',
  )
  drawWrappedCrater(
    ctx,
    w,
    lonToX(-170.2, w),
    latToY(30.5, h),
    h * 0.085,
    'rgba(146, 136, 124, 0.35)',
    'rgba(222, 214, 202, 0.62)',
  )
  drawWrappedCrater(
    ctx,
    w,
    lonToX(87.9, w),
    latToY(-32.9, h),
    h * 0.055,
    'rgba(96, 90, 84, 0.42)',
    'rgba(208, 200, 190, 0.5)',
  )

  const count = w >= 512 ? 280 : 120
  for (let i = 0; i < count; i++) {
    const cx = rand() * w
    const cy = (0.04 + rand() * 0.92) * h
    const r = (0.004 + Math.pow(rand(), 2.2) * 0.03) * h
    drawWrappedCrater(
      ctx,
      w,
      cx,
      cy,
      r,
      `rgba(62, 58, 54, ${0.22 + rand() * 0.26})`,
      `rgba(218, 212, 204, ${0.2 + rand() * 0.24})`,
      rand() < 0.05 ? 'rgba(232, 228, 222, 0.2)' : undefined,
    )
  }
}

function paintVenus(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  const rand = mulberry32(hashBodySeed('venus'))
  const baseGrad = ctx.createLinearGradient(0, 0, 0, h)
  baseGrad.addColorStop(0, '#D4B06E')
  baseGrad.addColorStop(0.25, '#EAD098')
  baseGrad.addColorStop(0.5, '#F5E1B0')
  baseGrad.addColorStop(0.75, '#E4C37E')
  baseGrad.addColorStop(1, '#CFA966')
  ctx.fillStyle = baseGrad
  ctx.fillRect(0, 0, w, h)

  // Sweeping creamy-gold sulfuric acid chevron cloud bands
  const bandCount = w >= 512 ? 42 : 22
  for (let i = 0; i < bandCount; i++) {
    const baseY = (i / bandCount) * h
    const amp = (0.015 + rand() * 0.035) * h
    const phase = rand() * Math.PI * 2
    const freq = 1 + Math.floor(rand() * 2)
    ctx.strokeStyle =
      i % 2 === 0
        ? `rgba(186, 134, 62, ${0.14 + rand() * 0.18})`
        : `rgba(255, 244, 214, ${0.18 + rand() * 0.22})`
    ctx.lineWidth = (0.018 + rand() * 0.032) * h
    ctx.beginPath()
    const steps = 48
    for (let s = 0; s <= steps; s++) {
      const t = s / steps
      const x = t * w
      const chevron = Math.sin(t * Math.PI * 2 * freq + phase) * amp
      const y = baseY + chevron
      if (s === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    }
    ctx.stroke()
  }

  for (let i = 0; i < 22; i++) {
    drawWrappedRadialBlob(
      ctx,
      w,
      rand() * w,
      (0.15 + rand() * 0.7) * h,
      (0.08 + rand() * 0.14) * w,
      (0.03 + rand() * 0.05) * h,
      rand() > 0.5 ? 'rgba(255, 245, 218, 0.24)' : 'rgba(176, 122, 54, 0.2)',
      'rgba(230, 198, 135, 0)',
    )
  }
}

function paintMars(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  const rand = mulberry32(hashBodySeed('mars'))
  paintMottledTerrain(ctx, w, h, rand, '#C8603B', '#8E3B21', '#E59F72', 36)

  // Dark basaltic albedo plains (Syrtis Major, Acidalia, Sinus Meridiani)
  const darkPlains: Array<{ lat: number; lon: number; rx: number; ry: number }> = [
    { lat: 10, lon: 68, rx: 0.075, ry: 0.09 }, // Syrtis Major
    { lat: 46, lon: -24, rx: 0.13, ry: 0.1 }, // Acidalia Planitia
    { lat: -20, lon: -16, rx: 0.12, ry: 0.08 }, // Margaritifer / Meridiani
    { lat: -18, lon: 145, rx: 0.11, ry: 0.075 }, // Terra Cimmeria
  ]
  for (const p of darkPlains) {
    drawWrappedRadialBlob(
      ctx,
      w,
      lonToX(p.lon, w),
      latToY(p.lat, h),
      p.rx * w,
      p.ry * h,
      'rgba(104, 42, 24, 0.56)',
      'rgba(104, 42, 24, 0)',
    )
  }

  // Pale dusty Hellas Planitia impact basin (-42.4, 70.5)
  drawWrappedRadialBlob(
    ctx,
    w,
    lonToX(70.5, w),
    latToY(-42.4, h),
    w * 0.075,
    h * 0.095,
    'rgba(232, 174, 132, 0.65)',
    'rgba(232, 174, 132, 0)',
  )

  // Dramatic Valles Marineris canyon streak (-13.9, -59.2)
  ctx.save()
  const vmX = lonToX(-59.2, w)
  const vmY = latToY(-13.9, h)
  ctx.strokeStyle = 'rgba(72, 24, 14, 0.72)'
  ctx.lineWidth = Math.max(2, h * 0.022)
  ctx.lineCap = 'round'
  ctx.beginPath()
  ctx.moveTo(vmX - w * 0.07, vmY - h * 0.015)
  ctx.quadraticCurveTo(vmX, vmY + h * 0.012, vmX + w * 0.08, vmY + h * 0.025)
  ctx.stroke()
  ctx.strokeStyle = 'rgba(235, 165, 120, 0.35)'
  ctx.lineWidth = Math.max(1, h * 0.008)
  ctx.beginPath()
  ctx.moveTo(vmX - w * 0.07, vmY - h * 0.026)
  ctx.quadraticCurveTo(vmX, vmY, vmX + w * 0.08, vmY + h * 0.014)
  ctx.stroke()
  ctx.restore()

  // Olympus Mons shield volcano & caldera (18.65, -133.8)
  const omX = lonToX(-133.8, w)
  const omY = latToY(18.65, h)
  drawWrappedRadialBlob(
    ctx,
    w,
    omX,
    omY,
    w * 0.036,
    h * 0.056,
    'rgba(235, 160, 114, 0.78)',
    'rgba(235, 160, 114, 0)',
  )
  drawWrappedCrater(
    ctx,
    w,
    omX,
    omY,
    h * 0.014,
    'rgba(96, 36, 20, 0.65)',
    'rgba(246, 194, 152, 0.7)',
  )

  // Scattered Martian craters
  const count = w >= 512 ? 120 : 50
  for (let i = 0; i < count; i++) {
    const cx = rand() * w
    const cy = (0.1 + rand() * 0.8) * h
    const r = (0.004 + Math.pow(rand(), 2.3) * 0.022) * h
    drawWrappedCrater(
      ctx,
      w,
      cx,
      cy,
      r,
      `rgba(92, 36, 20, ${0.18 + rand() * 0.22})`,
      `rgba(242, 182, 138, ${0.18 + rand() * 0.2})`,
    )
  }

  // Crisp bright white north & south polar ice caps
  const nCap = ctx.createLinearGradient(0, 0, 0, h * 0.105)
  nCap.addColorStop(0, 'rgba(248, 250, 255, 0.96)')
  nCap.addColorStop(0.6, 'rgba(244, 240, 238, 0.78)')
  nCap.addColorStop(1, 'rgba(244, 240, 238, 0)')
  ctx.fillStyle = nCap
  ctx.fillRect(0, 0, w, h * 0.105)

  const sCap = ctx.createLinearGradient(0, h * 0.905, 0, h)
  sCap.addColorStop(0, 'rgba(244, 240, 238, 0)')
  sCap.addColorStop(0.45, 'rgba(244, 240, 238, 0.72)')
  sCap.addColorStop(1, 'rgba(248, 250, 255, 0.95)')
  ctx.fillStyle = sCap
  ctx.fillRect(0, h * 0.905, w, h * 0.095)
}

function paintJupiter(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  const rand = mulberry32(hashBodySeed('jupiter'))
  // Rich zonal banded gas-giant base
  const bands: Array<[number, string]> = [
    [0.0, '#7E726A'],
    [0.08, '#A99682'],
    [0.16, '#E8D5B8'],
    [0.24, '#B9784E'],
    [0.31, '#F2E3CA'],
    [0.39, '#A75E3B'], // North Equatorial Belt
    [0.47, '#F5EAD6'], // Equatorial Zone
    [0.55, '#B6633D'], // South Equatorial Belt
    [0.64, '#EFE0C6'],
    [0.72, '#C78A5B'],
    [0.8, '#E3CEB0'],
    [0.89, '#A6907C'],
    [1.0, '#726A68'],
  ]
  const grad = ctx.createLinearGradient(0, 0, 0, h)
  for (const [stop, col] of bands) grad.addColorStop(stop, col)
  ctx.fillStyle = grad
  ctx.fillRect(0, 0, w, h)

  // Turbulent horizontal shear ribbons & festoons
  const ribbonCount = w >= 512 ? 64 : 28
  for (let i = 0; i < ribbonCount; i++) {
    const y0 = (0.05 + rand() * 0.9) * h
    const amp = (0.004 + rand() * 0.012) * h
    const freq = 2 + Math.floor(rand() * 5)
    const phase = rand() * Math.PI * 2
    const palette = ['#F8EFE0', '#C4774B', '#985032', '#DFC29B', '#E8D6BC']
    const col = palette[Math.floor(rand() * palette.length)]
    ctx.strokeStyle = hexToRgba(col, 0.22 + rand() * 0.24)
    ctx.lineWidth = (0.006 + rand() * 0.016) * h
    ctx.beginPath()
    const steps = 64
    for (let s = 0; s <= steps; s++) {
      const t = s / steps
      const x = t * w
      const y = y0 + Math.sin(t * Math.PI * 2 * freq + phase) * amp
      if (s === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    }
    ctx.stroke()
  }

  // Iconic Great Red Spot at (-22°, -45°)
  const grsX = lonToX(-45, w)
  const grsY = latToY(-22, h)
  drawWrappedRadialBlob(
    ctx,
    w,
    grsX,
    grsY,
    w * 0.056,
    h * 0.068,
    'rgba(246, 228, 206, 0.72)',
    'rgba(246, 228, 206, 0)',
  )
  drawWrappedRadialBlob(
    ctx,
    w,
    grsX,
    grsY,
    w * 0.044,
    h * 0.052,
    'rgba(202, 74, 42, 0.94)',
    'rgba(202, 74, 42, 0)',
  )
  drawWrappedRadialBlob(
    ctx,
    w,
    grsX,
    grsY,
    w * 0.022,
    h * 0.026,
    'rgba(232, 114, 72, 0.85)',
    'rgba(182, 54, 28, 0)',
  )

  // Oval BA at (-33°, 85°)
  drawWrappedRadialBlob(
    ctx,
    w,
    lonToX(85, w),
    latToY(-33, h),
    w * 0.024,
    h * 0.028,
    'rgba(242, 222, 200, 0.8)',
    'rgba(210, 128, 86, 0)',
  )
}

function paintSaturn(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  const rand = mulberry32(hashBodySeed('saturn'))
  const bands: Array<[number, string]> = [
    [0.0, '#7E888C'], // North polar hexagon hood
    [0.11, '#B8A882'],
    [0.24, '#E6D2A6'],
    [0.36, '#D4BC88'],
    [0.48, '#F6EBC8'], // Bright equatorial band
    [0.6, '#DFC793'],
    [0.74, '#C8AC78'],
    [0.88, '#AD966E'],
    [1.0, '#8A806E'],
  ]
  const grad = ctx.createLinearGradient(0, 0, 0, h)
  for (const [stop, col] of bands) grad.addColorStop(stop, col)
  ctx.fillStyle = grad
  ctx.fillRect(0, 0, w, h)

  const count = w >= 512 ? 48 : 22
  for (let i = 0; i < count; i++) {
    const y = (0.04 + rand() * 0.92) * h
    ctx.fillStyle =
      i % 2 === 0
        ? `rgba(255, 246, 220, ${0.12 + rand() * 0.14})`
        : `rgba(164, 134, 82, ${0.1 + rand() * 0.14})`
    ctx.fillRect(0, y, w, (0.005 + rand() * 0.018) * h)
  }
}

function paintUranus(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  const grad = ctx.createLinearGradient(0, 0, 0, h)
  grad.addColorStop(0, '#C8F4F8')
  grad.addColorStop(0.22, '#9BE3EC')
  grad.addColorStop(0.5, '#7DD3E0')
  grad.addColorStop(0.78, '#66BFCF')
  grad.addColorStop(1, '#98DDE8')
  ctx.fillStyle = grad
  ctx.fillRect(0, 0, w, h)

  for (let i = 0; i < 18; i++) {
    const y = (i / 18) * h
    ctx.fillStyle = i % 2 === 0 ? 'rgba(225, 250, 255, 0.12)' : 'rgba(54, 132, 150, 0.08)'
    ctx.fillRect(0, y, w, h * 0.03)
  }
}

function paintNeptune(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  const rand = mulberry32(hashBodySeed('neptune'))
  const grad = ctx.createLinearGradient(0, 0, 0, h)
  grad.addColorStop(0, '#284CC8')
  grad.addColorStop(0.22, '#3B66F5')
  grad.addColorStop(0.45, '#254BD6')
  grad.addColorStop(0.65, '#3E6BF8')
  grad.addColorStop(0.84, '#2445BD')
  grad.addColorStop(1, '#4C79FF')
  ctx.fillStyle = grad
  ctx.fillRect(0, 0, w, h)

  for (let i = 0; i < 32; i++) {
    const y = rand() * h
    ctx.fillStyle =
      rand() > 0.45
        ? `rgba(139, 180, 255, ${0.12 + rand() * 0.16})`
        : `rgba(16, 36, 120, ${0.14 + rand() * 0.18})`
    ctx.fillRect(0, y, w, (0.008 + rand() * 0.022) * h)
  }

  // Great Dark Spot (-20°, -30°)
  drawWrappedRadialBlob(
    ctx,
    w,
    lonToX(-30, w),
    latToY(-20, h),
    w * 0.048,
    h * 0.052,
    'rgba(14, 28, 96, 0.88)',
    'rgba(22, 46, 138, 0)',
  )
  // Bright white methane cirrus Scooter cloud (-42°, 55°)
  drawWrappedRadialBlob(
    ctx,
    w,
    lonToX(55, w),
    latToY(-42, h),
    w * 0.032,
    h * 0.015,
    'rgba(232, 244, 255, 0.86)',
    'rgba(232, 244, 255, 0)',
  )
  // Companion bright wispy streaks
  for (let i = 0; i < 8; i++) {
    drawWrappedRadialBlob(
      ctx,
      w,
      rand() * w,
      (0.2 + rand() * 0.6) * h,
      (0.03 + rand() * 0.05) * w,
      h * 0.009,
      'rgba(218, 236, 255, 0.55)',
      'rgba(218, 236, 255, 0)',
    )
  }
}

function paintPluto(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  const rand = mulberry32(hashBodySeed('pluto'))
  paintMottledTerrain(ctx, w, h, rand, '#D2C1AE', '#9A6952', '#EDE4D8', 32)

  // Dark mahogany equatorial band: Cthulhu Macula (-5°, 90°)
  drawWrappedRadialBlob(
    ctx,
    w,
    lonToX(90, w),
    latToY(-5, h),
    w * 0.22,
    h * 0.14,
    'rgba(104, 52, 38, 0.78)',
    'rgba(104, 52, 38, 0)',
  )
  drawWrappedRadialBlob(
    ctx,
    w,
    lonToX(15, w),
    latToY(-10, h),
    w * 0.14,
    h * 0.11,
    'rgba(116, 62, 44, 0.62)',
    'rgba(116, 62, 44, 0)',
  )

  // Iconic bright heart-shaped Sputnik Planitia / Tombaugh Regio at (25°, 175°)
  const hx = lonToX(175, w)
  const hy = latToY(25, h)
  // Left & right heart lobes + tapered southern tip (wrapped across antimeridian)
  drawWrappedRadialBlob(
    ctx,
    w,
    hx - w * 0.036,
    hy - h * 0.02,
    w * 0.055,
    h * 0.095,
    'rgba(248, 242, 232, 0.94)',
    'rgba(248, 242, 232, 0)',
  )
  drawWrappedRadialBlob(
    ctx,
    w,
    hx + w * 0.036,
    hy - h * 0.015,
    w * 0.052,
    h * 0.09,
    'rgba(244, 236, 224, 0.9)',
    'rgba(244, 236, 224, 0)',
  )
  drawWrappedRadialBlob(
    ctx,
    w,
    hx,
    hy + h * 0.068,
    w * 0.044,
    h * 0.075,
    'rgba(246, 240, 230, 0.88)',
    'rgba(246, 240, 230, 0)',
  )
}

function paintIo(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  const rand = mulberry32(hashBodySeed('io'))
  paintMottledTerrain(ctx, w, h, rand, '#E5CF58', '#C48A28', '#F8F2A6', 40)

  // Volcanic sulfur plumes & dark calderas
  const calderas: Array<{ lat: number; lon: number; r: number }> = [
    { lat: 13.0, lon: -51.2, r: 0.045 }, // Loki Patera
    { lat: -18.7, lon: 104.7, r: 0.052 }, // Pele
    { lat: -1.5, lon: -153.9, r: 0.036 }, // Prometheus
    { lat: 62.8, lon: -123.5, r: 0.04 }, // Tvashtar
  ]
  for (const c of calderas) {
    const x = lonToX(c.lon, w)
    const y = latToY(c.lat, h)
    drawWrappedRadialBlob(
      ctx,
      w,
      x,
      y,
      w * c.r * 1.4,
      h * c.r * 2.1,
      'rgba(218, 86, 36, 0.62)',
      'rgba(218, 86, 36, 0)',
    )
    drawWrappedRadialBlob(
      ctx,
      w,
      x,
      y,
      w * c.r * 0.35,
      h * c.r * 0.55,
      'rgba(40, 32, 24, 0.86)',
      'rgba(40, 32, 24, 0)',
    )
  }

  for (let i = 0; i < 42; i++) {
    const x = rand() * w
    const y = (0.08 + rand() * 0.84) * h
    drawWrappedRadialBlob(
      ctx,
      w,
      x,
      y,
      (0.008 + rand() * 0.018) * w,
      (0.01 + rand() * 0.022) * h,
      rand() > 0.35 ? 'rgba(206, 98, 32, 0.45)' : 'rgba(54, 42, 30, 0.65)',
      'rgba(229, 207, 88, 0)',
    )
  }
}

function paintEuropa(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  const rand = mulberry32(hashBodySeed('europa'))
  paintMottledTerrain(ctx, w, h, rand, '#E4E6E8', '#C6D4E0', '#F8FAFC', 28)

  // Mottled brownish chaos regions (Conamara Chaos & Thera Macula)
  drawWrappedRadialBlob(
    ctx,
    w,
    lonToX(87.3, w),
    latToY(9.7, h),
    w * 0.075,
    h * 0.095,
    'rgba(164, 114, 82, 0.58)',
    'rgba(164, 114, 82, 0)',
  )
  drawWrappedRadialBlob(
    ctx,
    w,
    lonToX(-178.8, w),
    latToY(-46.7, h),
    w * 0.08,
    h * 0.09,
    'rgba(154, 104, 74, 0.52)',
    'rgba(154, 104, 74, 0)',
  )

  // Signature reddish-brown global tectonic lineae criss-crossing the ice shell
  const lineCount = w >= 512 ? 72 : 34
  for (let i = 0; i < lineCount; i++) {
    const x0 = rand() * w
    const y0 = (0.06 + rand() * 0.88) * h
    const ang = (rand() - 0.5) * Math.PI * 1.4
    const len = (0.18 + rand() * 0.42) * w
    const x1 = x0 + Math.cos(ang) * len
    const y1 = Math.max(4, Math.min(h - 4, y0 + Math.sin(ang) * len * 0.55))
    const cx = (x0 + x1) / 2 + (rand() - 0.5) * w * 0.08
    const cy = (y0 + y1) / 2 + (rand() - 0.5) * h * 0.08

    ctx.strokeStyle = `rgba(156, 102, 72, ${0.32 + rand() * 0.36})`
    ctx.lineWidth = Math.max(0.7, (0.002 + rand() * 0.0045) * h)
    for (const dx of [0, -w, w]) {
      ctx.beginPath()
      ctx.moveTo(x0 + dx, y0)
      ctx.quadraticCurveTo(cx + dx, cy, x1 + dx, y1)
      ctx.stroke()
    }
  }
}

function paintTitan(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  const grad = ctx.createLinearGradient(0, 0, 0, h)
  grad.addColorStop(0, '#B58435')
  grad.addColorStop(0.18, '#DDA64B')
  grad.addColorStop(0.5, '#F0C572')
  grad.addColorStop(0.82, '#D79D42')
  grad.addColorStop(1, '#AE7B2D')
  ctx.fillStyle = grad
  ctx.fillRect(0, 0, w, h)

  for (let i = 0; i < 24; i++) {
    const y = (i / 24) * h
    ctx.fillStyle = i % 2 === 0 ? 'rgba(255, 232, 168, 0.12)' : 'rgba(148, 92, 24, 0.1)'
    ctx.fillRect(0, y, w, h * 0.028)
  }

  // Dark polar hydrocarbon lakes/seas (Kraken Mare & Ligeia Mare)
  drawWrappedRadialBlob(
    ctx,
    w,
    lonToX(50, w),
    latToY(68, h),
    w * 0.09,
    h * 0.07,
    'rgba(78, 52, 26, 0.62)',
    'rgba(78, 52, 26, 0)',
  )
  drawWrappedRadialBlob(
    ctx,
    w,
    lonToX(-112, w),
    latToY(79, h),
    w * 0.08,
    h * 0.055,
    'rgba(74, 48, 24, 0.56)',
    'rgba(74, 48, 24, 0)',
  )
  // Dark equatorial Shangri-La dune sea
  drawWrappedRadialBlob(
    ctx,
    w,
    lonToX(-165, w),
    latToY(-10, h),
    w * 0.16,
    h * 0.09,
    'rgba(138, 86, 30, 0.42)',
    'rgba(138, 86, 30, 0)',
  )
}

function paintEnceladus(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  const rand = mulberry32(hashBodySeed('enceladus'))
  paintMottledTerrain(ctx, w, h, rand, '#EFF5FA', '#C6D6E4', '#FFFFFF', 24)

  // Subtle icy craters on northern plains
  const count = w >= 512 ? 90 : 40
  for (let i = 0; i < count; i++) {
    const cx = rand() * w
    const cy = (0.06 + rand() * 0.68) * h
    const r = (0.004 + Math.pow(rand(), 2.2) * 0.02) * h
    drawWrappedCrater(
      ctx,
      w,
      cx,
      cy,
      r,
      'rgba(164, 188, 208, 0.25)',
      'rgba(255, 255, 255, 0.65)',
    )
  }

  // Luminous cyan south-polar Tiger Stripes
  ctx.save()
  ctx.strokeStyle = 'rgba(56, 189, 248, 0.72)'
  ctx.lineWidth = Math.max(1.2, h * 0.008)
  for (let k = 0; k < 4; k++) {
    const yBase = h * (0.84 + k * 0.032)
    ctx.beginPath()
    for (let s = 0; s <= 36; s++) {
      const t = s / 36
      const x = t * w
      const y = yBase + Math.sin(t * Math.PI * 4 + k * 1.1) * h * 0.012
      if (s === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    }
    ctx.stroke()
  }
  ctx.restore()
}

function paintTriton(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  const rand = mulberry32(hashBodySeed('triton'))
  paintMottledTerrain(ctx, w, h, rand, '#DECBC0', '#AE9084', '#F4ECE6', 30)

  // Dimpled "cantaloupe terrain" across mid/northern latitudes
  const dimples = w >= 512 ? 150 : 65
  for (let i = 0; i < dimples; i++) {
    const cx = rand() * w
    const cy = (0.1 + rand() * 0.55) * h
    const r = (0.007 + rand() * 0.014) * h
    drawWrappedCrater(
      ctx,
      w,
      cx,
      cy,
      r,
      'rgba(148, 114, 102, 0.22)',
      'rgba(248, 238, 232, 0.34)',
    )
  }

  // Bright pinkish-white nitrogen south polar ice cap
  const cap = ctx.createLinearGradient(0, h * 0.64, 0, h)
  cap.addColorStop(0, 'rgba(246, 236, 232, 0)')
  cap.addColorStop(0.5, 'rgba(246, 236, 232, 0.72)')
  cap.addColorStop(1, 'rgba(252, 246, 244, 0.94)')
  ctx.fillStyle = cap
  ctx.fillRect(0, h * 0.64, w, h * 0.36)
}

function paintGenericCrateredWorld(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  bodyId: GeohashableBodyId,
): void {
  const def = SOLAR_BODIES[bodyId]
  const rand = mulberry32(hashBodySeed(bodyId))
  paintMottledTerrain(
    ctx,
    w,
    h,
    rand,
    def.palette.primary,
    def.palette.secondary,
    def.palette.detail,
    30,
  )

  // Signature body-specific hero features
  if (bodyId === 'charon') {
    // Mordor Macula rusty-red north polar cap
    const cap = ctx.createLinearGradient(0, 0, 0, h * 0.26)
    cap.addColorStop(0, 'rgba(132, 62, 48, 0.9)')
    cap.addColorStop(0.65, 'rgba(142, 74, 58, 0.45)')
    cap.addColorStop(1, 'rgba(142, 74, 58, 0)')
    ctx.fillStyle = cap
    ctx.fillRect(0, 0, w, h * 0.26)
  } else if (bodyId === 'ganymede') {
    // Dark ancient Galileo Regio + bright grooved sulci
    drawWrappedRadialBlob(
      ctx,
      w,
      lonToX(-129.6, w),
      latToY(47, h),
      w * 0.14,
      h * 0.16,
      'rgba(86, 78, 70, 0.74)',
      'rgba(86, 78, 70, 0)',
    )
    for (let i = 0; i < 24; i++) {
      const y = (0.14 + rand() * 0.72) * h
      ctx.strokeStyle = 'rgba(228, 222, 214, 0.28)'
      ctx.lineWidth = Math.max(1, h * 0.008)
      ctx.beginPath()
      ctx.moveTo(0, y)
      ctx.lineTo(w, y + (rand() - 0.5) * h * 0.12)
      ctx.stroke()
    }
  } else if (bodyId === 'callisto') {
    // Concentric bright Valhalla Basin rings (14.7°, -56°)
    const vx = lonToX(-56, w)
    const vy = latToY(14.7, h)
    for (let ring = 1; ring <= 4; ring++) {
      ctx.strokeStyle = `rgba(218, 212, 204, ${0.42 - ring * 0.07})`
      ctx.lineWidth = Math.max(1, h * 0.006)
      for (const dx of [0, -w, w]) {
        ctx.beginPath()
        ctx.arc(vx + dx, vy, h * 0.03 * ring, 0, Math.PI * 2)
        ctx.stroke()
      }
    }
  } else if (bodyId === 'phobos') {
    // Massive Stickney Crater (1°, -49°) & parallel groove striations
    drawWrappedCrater(
      ctx,
      w,
      lonToX(-49, w),
      latToY(1, h),
      h * 0.11,
      'rgba(62, 54, 48, 0.58)',
      'rgba(196, 184, 174, 0.56)',
    )
    for (let i = 0; i < 18; i++) {
      const y = (0.12 + rand() * 0.76) * h
      ctx.strokeStyle = 'rgba(72, 62, 56, 0.25)'
      ctx.lineWidth = Math.max(0.8, h * 0.005)
      ctx.beginPath()
      ctx.moveTo(0, y)
      ctx.lineTo(w, y + h * 0.04)
      ctx.stroke()
    }
  }

  const isCallisto = bodyId === 'callisto'
  const craterCount = w >= 512 ? 190 : 85
  for (let i = 0; i < craterCount; i++) {
    const cx = rand() * w
    const cy = (0.04 + rand() * 0.92) * h
    const r = (0.004 + Math.pow(rand(), 2.2) * 0.028) * h
    drawWrappedCrater(
      ctx,
      w,
      cx,
      cy,
      r,
      hexToRgba(def.palette.secondary, 0.28 + rand() * 0.25),
      hexToRgba(def.palette.detail, isCallisto ? 0.52 + rand() * 0.3 : 0.24 + rand() * 0.24),
      isCallisto && rand() < 0.16 ? 'rgba(238, 236, 232, 0.28)' : undefined,
    )
  }
}

/**
 * Lazily generates and caches an authentic equirectangular procedural
 * `THREE.CanvasTexture` for any geohashable Solar System planet or moon.
 * (`'lo'` = 256×128 for distant spheres, `'hi'` = 1024×512 for the focused world).
 */
export function getCelestialSurfaceTexture(
  bodyId: GeohashableBodyId,
  resolution: 'hi' | 'lo' = 'hi',
): THREE.CanvasTexture {
  const cacheKey = `${bodyId}:${resolution}`
  const existing = textureCache.get(cacheKey)
  if (existing) return existing

  const w = resolution === 'hi' ? 1024 : 256
  const h = resolution === 'hi' ? 512 : 128
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')

  if (ctx) {
    switch (bodyId) {
      case 'earth':
        paintEarthProcedural(ctx, w, h)
        break
      case 'moon':
        paintMoon(ctx, w, h)
        break
      case 'mercury':
        paintMercury(ctx, w, h)
        break
      case 'venus':
        paintVenus(ctx, w, h)
        break
      case 'mars':
        paintMars(ctx, w, h)
        break
      case 'jupiter':
        paintJupiter(ctx, w, h)
        break
      case 'saturn':
        paintSaturn(ctx, w, h)
        break
      case 'uranus':
        paintUranus(ctx, w, h)
        break
      case 'neptune':
        paintNeptune(ctx, w, h)
        break
      case 'pluto':
        paintPluto(ctx, w, h)
        break
      case 'io':
        paintIo(ctx, w, h)
        break
      case 'europa':
        paintEuropa(ctx, w, h)
        break
      case 'titan':
        paintTitan(ctx, w, h)
        break
      case 'enceladus':
        paintEnceladus(ctx, w, h)
        break
      case 'triton':
        paintTriton(ctx, w, h)
        break
      default:
        paintGenericCrateredWorld(ctx, w, h, bodyId)
        break
    }
  }

  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.wrapS = THREE.RepeatWrapping
  tex.wrapT = THREE.ClampToEdgeWrapping
  tex.userData.cached = true
  tex.needsUpdate = true
  textureCache.set(cacheKey, tex)
  return tex
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
