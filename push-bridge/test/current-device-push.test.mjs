import assert from 'node:assert/strict'
import test from 'node:test'
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure'
import worker from '../src/index.ts'
import { sha256Hex } from '../src/webpush.ts'
import { subKeyForPubkey } from '../src/types.ts'

const url = 'https://agnostr-fixture.invalid/test-push'
const testId = 'fd12'.repeat(8)
const secret = Uint8Array.from({ length: 32 }, (_, i) => i + 1)
const pubkey = getPublicKey(secret)
const b64 = (value) => Buffer.from(value).toString('base64url')

async function encryptedEndpoint(endpoint) {
  const keys = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])
  return {
    subscription: {
      endpoint,
      keys: {
        p256dh: b64(await crypto.subtle.exportKey('raw', keys.publicKey)),
        auth: b64(crypto.getRandomValues(new Uint8Array(16))),
      },
    },
  }
}

async function dispatch(env, fields) {
  const body = JSON.stringify({ pubkey, ...fields })
  const event = finalizeEvent({
    kind: 27235,
    content: '',
    created_at: Math.floor(Date.now() / 1000),
    tags: [['u', url], ['method', 'POST'], ['payload', await sha256Hex(body)]],
  }, secret)
  return worker.fetch(new Request(url, {
    method: 'POST',
    headers: {
      authorization: `Nostr ${Buffer.from(JSON.stringify(event)).toString('base64')}`,
      'content-type': 'application/json',
    },
    body,
  }), env)
}

test('a signed test reports acceptance only for its chosen registered device', async () => {
  const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  const endpoint1 = 'https://push.fixture.invalid/a'
  const endpoint2 = 'https://push.fixture.invalid/b'
  const record = { pubkey, devices: await Promise.all([encryptedEndpoint(endpoint1), encryptedEndpoint(endpoint2)]) }
  const env = {
    PUSH_KV: { get: async (key) => key === subKeyForPubkey(pubkey) ? record : null },
    VAPID_PUBLIC_KEY: b64(await crypto.subtle.exportKey('raw', keys.publicKey)),
    VAPID_PRIVATE_KEY: (await crypto.subtle.exportKey('jwk', keys.privateKey)).d,
    VAPID_SUBJECT: 'mailto:offline@example.invalid',
  }
  const orig = globalThis.fetch
  const targets = []
  let providerStatus = 201
  globalThis.fetch = async (endpoint) => {
    targets.push(String(endpoint))
    return new Response(null, { status: providerStatus })
  }
  try {
    const accepted = await dispatch(env, { endpoint: endpoint2, testId })
    assert.equal(accepted.status, 200)
    assert.deepEqual(await accepted.json(), {
      ok: true, accepted: true, testId, delivered: 1, failed: 0,
      results: [{ status: 201, ok: true, expired: false }],
    })
    assert.deepEqual(targets, [endpoint2])

    assert.equal((await dispatch(env, { endpoint: 'https://unregistered.invalid/c', testId })).status, 404)
    assert.equal((await dispatch(env, { endpoint: endpoint2 })).status, 400)
    assert.deepEqual(targets, [endpoint2])

    providerStatus = 503
    const refused = await dispatch(env, { endpoint: endpoint2, testId })
    assert.equal(refused.status, 502)
    const diagnostic = await refused.json()
    assert.equal(diagnostic.accepted, false)
    assert.equal(diagnostic.testId, testId)
    assert.equal(diagnostic.results[0].status, 503)
    assert.deepEqual(targets, [endpoint2, endpoint2])
  } finally {
    globalThis.fetch = orig
  }
})
