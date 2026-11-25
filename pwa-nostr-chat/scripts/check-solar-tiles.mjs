import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { test } from 'node:test'
import { MAX_TILE_LEVEL, TILE_STRIDE, surfaceTilePlan, tileKey } from '../src/lib/solarTileLayout.ts'
const levelManifest = JSON.parse(readFileSync(new URL('../src/assets/solar-tile-levels.json', import.meta.url)))
const world = (lat, lon, altitude, args = [42, 1.33, 800, 512, 4, 8]) =>
  surfaceTilePlan(lat * Math.PI / 180, lon * Math.PI / 180, altitude, args[0] * Math.PI / 180, ...args.slice(1))

test('tiling is lazy, bounded, and increases resolution as the globe fills the screen', () => {
  assert.deepEqual(world(21, -20, 15), [])
  const levels = [2.5, 1.2, 0.5, 0.15, 0.03].map(alt => world(21, -20, alt)[0]?.level ?? 0)
  assert.ok(levels.every((n, i) => i === 0 || n >= levels[i - 1]))
  assert.ok(levels[0] < levels[4], String(levels))
  assert.equal(levels[4], 4)
  for (const args of [[42, 1.33, 700, 512, 4, 8], [42, 2.2, 900, 1024, 4, 16]]) {
    for (const lat of [-90, -72, 0, 71, 90]) for (const lon of [-180, -12, 0, 179.999]) {
      const plan = world(lat, lon, 0.02, args)
      assert.ok(plan.length && plan.length <= args[5])
      assert.equal(new Set(plan.map(tileKey)).size, plan.length)
      assert.ok(plan.every(t => t.x >= 0 && t.x < 2 ** (t.level + 1) && t.y >= 0 && t.y < 2 ** t.level))
    }
  }
})

test('antimeridian wraps, poles clamp, and the prime meridian never shifts', () => {
  const seam = world(3, 180, 0.02)
  assert.deepEqual(seam, world(3, -180, 0.02))
  assert.ok(seam.some(t => t.x === 0) && seam.some(t => t.x === 2 ** (t.level + 1) - 1))
  assert.ok(world(90, 0, .001).every(t => t.y === 0))
  assert.ok(world(-90, 0, .001).every(t => t.y === 2 ** t.level - 1))
  assert.ok(world(0, 0, .001).every(t => t.x === 2 ** t.level || t.x === 2 ** t.level - 1))
})

test('all published levels contain complete, versioned 260px WebP grids', () => {
  assert.equal(levelManifest.moon.level, 4)
  assert.ok(!levelManifest.earth)
  const base = new URL('../public/solar-tiles/', import.meta.url)
  for (const [body, { level, revision }] of Object.entries(levelManifest)) {
    assert.ok(level >= 1 && level <= MAX_TILE_LEVEL)
    const hash = createHash('sha256')
    const bodyRoot = new URL(body + '/', base)
    assert.deepEqual(readdirSync(bodyRoot), [revision])
    for (let z = 1; z <= level; z++) {
      const rows = 2 ** z
      for (let y = 0; y < rows; y++) for (let x = 0; x < 2 * rows; x++) {
        const asset = readFileSync(new URL(`${revision}/${z}/${x}/${y}.webp`, bodyRoot))
        assert.equal(asset.toString('ascii', 8, 16), 'WEBPVP8 ')
        assert.equal(asset.readUInt16LE(26) & 0x3fff, TILE_STRIDE)
        assert.equal(asset.readUInt16LE(28) & 0x3fff, TILE_STRIDE)
        assert.ok(asset.length <= 32768)
        hash.update(asset)
      }
    }
    assert.equal(hash.digest('hex').slice(0, 16), revision)
  }
})
