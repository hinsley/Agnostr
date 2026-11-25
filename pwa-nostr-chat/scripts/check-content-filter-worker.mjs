import assert from 'node:assert/strict'
import test from 'node:test'
import { ContentFilterWorkerClient } from '../src/lib/contentFilterWorkerClient.ts'

function fakeWorker() {
  return {
    sent: [],
    terminated: false,
    onmessage: null,
    onerror: null,
    onmessageerror: null,
    postMessage(payload) { this.sent.push(payload) },
    terminate() { this.terminated = true },
    emit(data) { this.onmessage?.({ data }) },
  }
}

function fixture(timeout) {
  const workers = [], crashes = [], status = []
  const client = new ContentFilterWorkerClient(
    () => { const w = fakeWorker(); workers.push(w); return w },
    (msg) => status.push(msg),
    (msg) => crashes.push(msg),
    timeout,
  )
  return { client, workers, crashes, status }
}

const preload = (requestId) => ({ type: 'preload', requestId })
const result = (requestId) => ({
  type: 'result', requestId, safe: true, flagged: false, categories: [], scores: {}, runtimeDevice: 'wasm',
})

test('a failed worker rejects every request and Reload Model uses a fresh worker', async () => {
  const { client, workers, crashes, status } = fixture()
  const a = assert.rejects(client.request(preload('a')), /could not start/)
  const b = assert.rejects(client.request({
    type: 'screen', requestId: 'b', blob: new Blob(), rules: { filterIllegal: true, filterNsfw: true },
  }), /could not start/)
  const old = workers[0]
  const staleMessage = old.onmessage
  old.onerror({ message: '' })
  await Promise.all([a, b])
  assert.equal(client.running, false)
  assert.equal(old.terminated, true)
  assert.equal(crashes.length, 1)

  const retry = client.request(preload('retry'))
  assert.equal(workers.length, 2)
  staleMessage({ data: { type: 'status', status: 'ready' } })
  staleMessage({ data: result('retry') })
  assert.deepEqual(status, [])
  workers[1].emit({ type: 'status', status: 'ready' })
  workers[1].emit(result('retry'))
  assert.deepEqual(await retry, result('retry'))
  assert.equal(status.length, 1)
  client.reset()
})

test('a worker that goes silent rejects its job and can be restarted', async () => {
  const { client, workers } = fixture(15)
  await assert.rejects(client.request(preload('hung')), /stopped responding/)
  assert.equal(workers[0].terminated, true)
  const retry = client.request(preload('next'))
  workers[1].emit(result('next'))
  assert.deepEqual(await retry, result('next'))
  client.reset()
})

test('startup and postMessage failures are surfaced and do not leak outstanding requests', async () => {
  const w = fakeWorker()
  let starts = 0
  const errors = []
  const client = new ContentFilterWorkerClient(() => {
    if (++starts === 1) throw new Error('Worker blocked')
    return w
  }, () => {}, (msg) => errors.push(msg))
  await assert.rejects(client.request(preload('blocked')), /Worker blocked/)
  w.postMessage = () => { throw new Error('Posting failed') }
  await assert.rejects(client.request(preload('clone')), /Posting failed/)
  assert.equal(w.terminated, true)
  assert.deepEqual(errors, ['Worker blocked', 'Posting failed'])
})

test('an ordinary inference error rejects only its own request', async () => {
  const { client, workers, crashes } = fixture()
  const bad = assert.rejects(client.request(preload('bad')), /Model unavailable/)
  const good = client.request(preload('good'))
  workers[0].emit({ type: 'error', requestId: 'bad', error: 'Model unavailable' })
  workers[0].emit(result('good'))
  await bad
  assert.deepEqual(await good, result('good'))
  assert.equal(workers.length, 1)
  assert.deepEqual(crashes, [])
  client.reset()
})
