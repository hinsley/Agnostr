// No image tooling or network required. Run with npm run test:solar-maps.
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const dir = fileURLToPath(new URL('../src/assets/solar/', import.meta.url))
const slots = JSON.parse(readFileSync(join(dir, 'slots.json')))
const registry = readFileSync(new URL('../src/lib/solarSystem.ts', import.meta.url), 'utf8')
const bodies = [...registry.matchAll(/\bid: '([a-z]+)',\s+name: '[^']+',\s+kind: '(?:planet|moon)'/g)].map(m => m[1])
assert.ok(bodies.length > 0)
assert.deepEqual(Object.keys(slots).sort(), [...bodies, 'titan-haze', 'venus-clouds'].sort(), 'new bodies need atlas coverage')
assert.deepEqual(Object.values(slots).sort((a, b) => a - b), Array.from({ length: bodies.length + 2 }, (_, i) => i))
const expected = new Set(['slots.json'])

function check(name, width, height, maxBytes) {
  expected.add(name)
  const buf = readFileSync(join(dir, name))
  assert.equal(buf.toString('ascii', 0, 4), 'RIFF', name)
  assert.equal(buf.toString('ascii', 8, 12), 'WEBP', name)
  // The baker exports opaque lossy WebP: dimensions live in the VP8 frame header.
  assert.equal(buf.toString('ascii', 12, 16), 'VP8 ', name)
  assert.equal(buf.readUInt16LE(26) & 0x3fff, width, name)
  assert.equal(buf.readUInt16LE(28) & 0x3fff, height, name)
  assert.ok(buf.length <= maxBytes, `${name} exceeds ${maxBytes} byte budget`)
  return buf.length
}

const atlas = check('solar-overview.webp', 640, Math.ceil(Object.keys(slots).length / 5) * 64, 40 * 1024)
const mobile = [], desktop = []
for (const body of bodies.filter(body => body !== 'earth')) {
  mobile.push(check(`surface-${body}-512.webp`, 512, 256, 24 * 1024))
  desktop.push(check(`surface-${body}-1024.webp`, 1024, 512, 100 * 1024))
}
assert.deepEqual(readdirSync(dir).sort(), [...expected].sort(), 'unexpected or missing generated file')
console.log(`${bodies.length} worlds, ${mobile.length * 2} details; atlas ${atlas} bytes, largest mobile ${Math.max(...mobile)}, largest desktop ${Math.max(...desktop)}`)
