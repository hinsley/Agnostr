const DEG2RAD = Math.PI / 180
const RAD2DEG = 180 / Math.PI

export interface SubCelestialPoint {
  /** Sub-point geographic latitude in degrees [-90, +90] */
  lat: number
  /** Sub-point geographic longitude in degrees [-180, +180] */
  lon: number
}

export interface SubLunarPoint extends SubCelestialPoint {
  /** Illuminated lunar disc fraction [0 = new moon .. 1 = full moon] */
  illumination: number
  /** Ecliptic elongation angle from Sun in degrees [0..360): 0=new, 90=first quarter, 180=full, 270=last quarter */
  phaseAngleDeg: number
}

function normalizeDeg(deg: number): number {
  const m = deg % 360
  return m < 0 ? m + 360 : m
}

function wrapLonDeg(deg: number): number {
  let lon = ((deg + 180) % 360 + 360) % 360 - 180
  if (lon === -180 && deg > 0) lon = 180
  return lon
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v))
}

function julianDaysSinceJ2000(date: Date): number {
  const jd = date.getTime() / 86_400_000 + 2_440_587.5
  return jd - 2_451_545.0
}

function gmstDegrees(d: number): number {
  return normalizeDeg(280.46061837 + 360.98564736629 * d)
}

function computeSolarEcliptic(d: number): {
  meanLonDeg: number
  meanAnomalyDeg: number
  eclipticLonDeg: number
  obliquityDeg: number
} {
  const meanLonDeg = normalizeDeg(280.46 + 0.9856474 * d)
  const meanAnomalyDeg = normalizeDeg(357.528 + 0.9856003 * d)
  const gRad = meanAnomalyDeg * DEG2RAD
  const eclipticLonDeg = normalizeDeg(
    meanLonDeg + 1.915 * Math.sin(gRad) + 0.02 * Math.sin(2 * gRad)
  )
  const obliquityDeg = 23.439 - 0.0000004 * d
  return { meanLonDeg, meanAnomalyDeg, eclipticLonDeg, obliquityDeg }
}

/**
 * Computes Earth's live subsolar point (where the Sun is directly at zenith)
 * using J2000 low-precision solar ephemeris (~0.01° accuracy).
 */
export function computeSubsolarPoint(date: Date = new Date()): SubCelestialPoint {
  const d = julianDaysSinceJ2000(date)
  const { eclipticLonDeg, obliquityDeg } = computeSolarEcliptic(d)
  const lam = eclipticLonDeg * DEG2RAD
  const eps = obliquityDeg * DEG2RAD

  const sinDec = clamp(Math.sin(eps) * Math.sin(lam), -1, 1)
  const decDeg = Math.asin(sinDec) * RAD2DEG
  const raDeg = normalizeDeg(Math.atan2(Math.cos(eps) * Math.sin(lam), Math.cos(lam)) * RAD2DEG)
  const gmst = gmstDegrees(d)

  return {
    lat: decDeg,
    lon: wrapLonDeg(raDeg - gmst),
  }
}

/**
 * Computes Earth's live sublunar point, illuminated fraction, and ecliptic phase
 * angle using J2000 low-precision lunar ephemeris (~0.3° accuracy).
 */
export function computeSublunarPoint(date: Date = new Date()): SubLunarPoint {
  const d = julianDaysSinceJ2000(date)
  const solar = computeSolarEcliptic(d)

  const L = normalizeDeg(218.316 + 13.176396 * d) // Mean longitude
  const M = normalizeDeg(134.963 + 13.064993 * d) // Moon mean anomaly
  const F = normalizeDeg(93.272 + 13.22935 * d) // Argument of latitude
  const D = normalizeDeg(L - solar.meanLonDeg) // Mean elongation from Sun

  const mRad = M * DEG2RAD
  const fRad = F * DEG2RAD
  const dRad = D * DEG2RAD
  const msRad = solar.meanAnomalyDeg * DEG2RAD

  // Ecliptic longitude & latitude with equation of center, evection, variation & annual inequality
  const lonEclDeg = normalizeDeg(
    L +
      6.289 * Math.sin(mRad) +
      1.274 * Math.sin(2 * dRad - mRad) +
      0.658 * Math.sin(2 * dRad) -
      0.186 * Math.sin(msRad) -
      0.114 * Math.sin(2 * fRad)
  )
  const latEclDeg =
    5.128 * Math.sin(fRad) +
    0.28 * Math.sin(mRad + fRad) +
    0.278 * Math.sin(mRad - fRad) +
    0.173 * Math.sin(2 * dRad - fRad)

  const lam = lonEclDeg * DEG2RAD
  const bet = latEclDeg * DEG2RAD
  const eps = solar.obliquityDeg * DEG2RAD

  const sinDec = clamp(
    Math.sin(bet) * Math.cos(eps) + Math.cos(bet) * Math.sin(eps) * Math.sin(lam),
    -1,
    1
  )
  const decDeg = Math.asin(sinDec) * RAD2DEG
  const raDeg = normalizeDeg(
    Math.atan2(
      Math.sin(lam) * Math.cos(eps) - Math.tan(bet) * Math.sin(eps),
      Math.cos(lam)
    ) * RAD2DEG
  )
  const gmst = gmstDegrees(d)

  const phaseAngleDeg = normalizeDeg(lonEclDeg - solar.eclipticLonDeg)
  const cosElong = clamp(Math.cos(bet) * Math.cos(phaseAngleDeg * DEG2RAD), -1, 1)
  const illumination = clamp((1 - cosElong) / 2, 0, 1)

  return {
    lat: decDeg,
    lon: wrapLonDeg(raDeg - gmst),
    illumination,
    phaseAngleDeg,
  }
}

/**
 * Converts geographic latitude/longitude (degrees) into a Three.js right-handed
 * unit sphere vector matching `SphereGeometry` equirectangular UV orientation
 * (`(0, 0)` prime meridian at `[+1, 0, 0]`, North Pole at `[0, +1, 0]`).
 */
export function latLonToUnitVec3(latDeg: number, lonDeg: number): [number, number, number] {
  const phi = (90 - latDeg) * DEG2RAD
  const theta = (lonDeg + 180) * DEG2RAD
  const sinPhi = Math.sin(phi)
  const x = -sinPhi * Math.cos(theta)
  const y = Math.cos(phi)
  const z = sinPhi * Math.sin(theta)
  return [x, y, z]
}
