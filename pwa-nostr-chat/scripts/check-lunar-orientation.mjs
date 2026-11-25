import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SphereGeometry } from 'three'
import { computeSublunarPoint, latLonToUnitVec3 } from '../src/lib/astronomy.ts'
import { computeSolarSystemSnapshot, samplePlanetOrbitPoints } from '../src/lib/solarSystem.ts'

// Independent geocentric reference samples from NASA SVS Dial-A-Moon,
// https://svs.gsfc.nasa.gov/5587/ . Angles are east-positive degrees.
const fixtures = [
  // UTC                      sub-Earth lon/lat  subsolar lon/lat
  ['2026-05-11T15:00:00Z',     -7.690, -0.630,   -118.107,  1.481],
  ['2026-11-09T06:00:00Z',      4.044,  6.473,   -175.442, -1.540],
  ['2026-11-13T06:00:00Z',     -0.205,  5.105,    135.761, -1.557],
  ['2026-11-25T06:00:00Z',     -1.247, -6.231,    -10.122, -1.516],
  ['2026-12-03T06:00:00Z',      6.764,  4.386,   -107.310, -1.461],
]
const deg = 180 / Math.PI
const dot = (a, b) => a.reduce((sum, value, i) => sum + value * b[i], 0)
const unit = v => v.map(x => x / Math.hypot(...v))
const relative = (target, origin) => target.map((x, i) => x - origin[i])
const apply = (m, v) => [dot(m.slice(0, 3), v), dot(m.slice(3, 6), v), dot(m.slice(6, 9), v)]
const inverse = m => [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]]
const geo = v => [Math.atan2(-v[2], v[0]) * deg, Math.asin(v[1] / Math.hypot(...v)) * deg]
const lonDiff = (a, b) => Math.abs(((a - b + 540) % 360) - 180)

function anglesMatch(v, lon, lat, name) {
  const [gotLon, gotLat] = geo(v)
  assert.ok(lonDiff(gotLon, lon) < 0.75 && Math.abs(gotLat - lat) < 0.75,
    `${name}: got (${gotLon}, ${gotLat}), want (${lon}, ${lat})`)
}

test('Earth and Sun directions agree with lunar libration throughout multiple phases', () => {
  for (const [time, earthLon, earthLat, sunLon, sunLat] of fixtures) {
    const date = new Date(time)
    const earth = computeSolarSystemSnapshot(date, 'earth')
    const moon = computeSolarSystemSnapshot(date, 'moon')
    const mars = computeSolarSystemSnapshot(date, 'mars')
    const moonAxes = earth.bodies.moon.surfaceAxes
    assert.deepEqual(moon.earthToViewAxes, inverse(moonAxes))
    assert.deepEqual(mars.bodies.moon.surfaceAxes, moonAxes)
    assert.deepEqual(moon.bodies.earth.surfaceAxes, moon.earthToViewAxes)
    assert.equal(moon.bodies.moon.surfaceAxes, undefined, 'the active map must retain local geohash axes')

    const moonFromEarth = latLonToUnitVec3(computeSublunarPoint(date).lat, computeSublunarPoint(date).lon)
    const earthFromMoon = unit(relative(earth.bodies.earth.position, earth.bodies.moon.position))
    assert.ok(Math.abs(dot(moonFromEarth, earthFromMoon) + 1) < 1e-12)
    anglesMatch(apply(moon.earthToViewAxes, earthFromMoon), earthLon, earthLat, `${time} Earth view`)
    anglesMatch(moon.bodies.earth.position, earthLon, earthLat, `${time} Moon view`)
    anglesMatch(apply(moon.earthToViewAxes, earth.bodies.moon.sunDir), sunLon, sunLat, `${time} atlas illumination`)
    anglesMatch(moon.focusedSunDir, sunLon, sunLat, `${time} focus illumination`)
    assert.deepEqual(moon.bodies.moon.sunDir, moon.focusedSunDir)

    const [x, y, z] = [moonAxes.slice(0, 3), moonAxes.slice(3, 6), moonAxes.slice(6, 9)]
    const xCrossY = [x[1]*y[2] - x[2]*y[1], x[2]*y[0] - x[0]*y[2], x[0]*y[1] - x[1]*y[0]]
    assert.ok(Math.abs(dot(xCrossY, z) - 1) < 1e-12, 'view transform must not mirror lunar east/west')
  }
})

test('Moon focus rotates orbit tracks and positions together', () => {
  const date = new Date(fixtures[3][0])
  const earth = computeSolarSystemSnapshot(date, 'earth')
  const moon = computeSolarSystemSnapshot(date, 'moon')
  const original = samplePlanetOrbitPoints('mars', earth.sunPos, date, 32)
  const focused = samplePlanetOrbitPoints('mars', moon.sunPos, date, 32, moon.earthToViewAxes)
  for (let i = 0; i < original.length; i += 3) {
    const v = apply(moon.earthToViewAxes, relative(original.slice(i, i + 3), earth.sunPos))
    const w = relative(focused.slice(i, i + 3), moon.sunPos)
    assert.ok(Math.hypot(...relative(v, w)) < 3e-5)
  }
})

test('north-up lunar image convention puts prime meridian at u=.5, east right, north up', () => {
  const geometry = new SphereGeometry(1, 36, 18)
  const uv = geometry.getAttribute('uv')
  const p = geometry.getAttribute('position')
  for (const [lon, lat] of [[0, 0], [-20, 10], [-10, -40], [-60, 20], [20, 0]]) {
    const index = (9 - lat / 10) * 37 + 18 + lon / 10
    assert.ok(Math.abs(uv.getX(index) - (180 + lon) / 360) < 1e-7)
    assert.ok(Math.abs(uv.getY(index) - (90 + lat) / 180) < 1e-7)
    assert.ok(Math.hypot(...relative([p.getX(index), p.getY(index), p.getZ(index)], latLonToUnitVec3(lat, lon))) < 1e-7)
  }
  geometry.dispose()
})
