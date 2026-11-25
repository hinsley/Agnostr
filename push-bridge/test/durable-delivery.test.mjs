import assert from 'node:assert/strict'
import test from 'node:test'
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure'
import worker, { PushDelivery } from '../src/index.ts'
import { PUBKEYS_INDEX_KEY, subKeyForPubkey, DEFAULT_PUSH_PREFERENCES } from '../src/types.ts'
import { sha256Hex } from '../src/webpush.ts'

const signer = generateSecretKey()
const recipientSecret = generateSecretKey()
const recipient = getPublicKey(recipientSecret)
const url = 'https://agnostr.fixture.invalid/poke'
const b64 = (value) => Buffer.from(value).toString('base64url')

function memoryStorage() {
  const kv = new Map()
  let alarm = null
  const store = {
    async get(k) { return Array.isArray(k) ? new Map(k.filter((key) => kv.has(key)).map((key) => [key, kv.get(key)])) : kv.get(k) },
    async put(k, val) {
      if (typeof k === 'string') kv.set(k, structuredClone(val))
      else {
        assert.ok(Object.keys(k).length <= 128)
        for (const [key, value] of Object.entries(k)) kv.set(key, structuredClone(value))
      }
    },
    async list({ prefix, start = '', end = '\uffff', limit = Infinity }) {
      return new Map([...kv].sort(([a], [b]) => a < b ? -1 : 1)
        .filter(([k]) => (prefix === undefined || k.startsWith(prefix)) && k >= start && k < end).slice(0,limit))
    },
    async delete(k) { for (const key of Array.isArray(k) ? k : [k]) kv.delete(key) },
    async getAlarm() { return alarm },
    async setAlarm(at) { alarm = at },
    async transaction(fn) { return fn(store) },
    clearAlarm() { alarm = null },
  }
  return store
}

async function endpoint(name) {
  const keys = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])
  return {
    endpointHash: name, updatedAt: 123,
    preferences: { ...DEFAULT_PUSH_PREFERENCES },
    subscription: {
      endpoint: 'https://provider.fixture.invalid/' + name,
      keys: {
        p256dh: b64(await crypto.subtle.exportKey('raw', keys.publicKey)),
        auth: b64(crypto.getRandomValues(new Uint8Array(16))),
      },
    },
  }
}

async function fixture(names = ['a', 'b']) {
  const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  const kv = new Map([
    [PUBKEYS_INDEX_KEY,[recipient]],
    [subKeyForPubkey(recipient),{ pubkey: recipient, devices: await Promise.all(names.map(endpoint)) }],
  ])
  const waits = []
  const objects = new Map()
  const env = {
    VAPID_PUBLIC_KEY: b64(await crypto.subtle.exportKey('raw',keys.publicKey)),
    VAPID_PRIVATE_KEY: (await crypto.subtle.exportKey('jwk',keys.privateKey)).d,
    VAPID_SUBJECT: 'mailto:offline@example.invalid',
    PUSH_KV: {
      async get(k) { return kv.get(k) ?? null },
      async list({prefix,limit,cursor}) {
        const keys = [...kv.keys()].filter((key) => key.startsWith(prefix)).sort()
        const at = Number(cursor || 0)
        return { keys: keys.slice(at,at+limit).map((name) => ({name})),
          list_complete: at+limit>=keys.length, cursor: String(at+limit) }
      },
      async put(k,v) { kv.set(k, k.startsWith('sub:') || k===PUBKEYS_INDEX_KEY ? JSON.parse(v) : v) },
      async delete(k) { kv.delete(k) },
    },
    PUSH_DELIVERY: {
      idFromName(n) { return n },
      get(n) {
        const get = () => {
          let obj = objects.get(n)
          if (!obj) {
            const storage = memoryStorage()
            const state = { storage, blockConcurrencyWhile(fn) { return fn() }, waitUntil(p) { waits.push(p) } }
            obj = { storage, worker: new PushDelivery(state, env) }
            objects.set(n,obj)
          }
          return obj
        }
        return { fetch(url, init) { return get().worker.fetch(new Request(url, init)) } }
      },
    },
  }
  return { env, waits: async () => { while (waits.length) await Promise.all(waits.splice(0)) }, objects }
}

async function poke(env, eventId, key = signer) {
  const body = JSON.stringify({ category: 'dm', recipientPubkeys: [recipient], eventId })
  const event = finalizeEvent({ kind: 27235, content: '', created_at: Math.floor(Date.now()/1000),
    tags: [['u',url],['method','POST'],['payload',await sha256Hex(body)]] }, key)
  return worker.fetch(new Request(url, { method: 'POST', body,
    headers: { Authorization: 'Nostr '+Buffer.from(JSON.stringify(event)).toString('base64') } }), env)
}

test('signed /poke stores before provider I/O, retries the one transient device, counts duplicates and permanent failures separately', async () => {
  const f = await fixture()
  const fromFetch = globalThis.fetch
  const realNow = Date.now
  let now = realNow()
  Date.now = () => now
  const requests = []
  globalThis.fetch = async (url, init) => {
    const dest = String(url).split('/').at(-1)
    requests.push(dest)
    assert.equal(init.method,'POST')
    assert.equal(init.headers['Content-Encoding'],'aes128gcm')
    assert.ok(init.headers.Authorization.startsWith('vapid t='))
    return new Response(null, { status: dest === 'a' && requests.filter((n)=>n==='a').length===1
      ? 429 : dest === 'b' ? 410 : 201, headers: { 'Retry-After': '10' } })
  }
  try {
    assert.equal((await worker.fetch(new Request(url,{method:'POST', body:'{}'}),f.env)).status,401)
    const first = await poke(f.env, 'offline-fixture')
    assert.equal(first.status,200)
    assert.equal((await first.json()).queued,2)
    await f.waits()
    assert.deepEqual(requests,['a','b'])
    const same = await (await poke(f.env,'offline-fixture')).json()
    assert.equal(same.duplicates,1)
    assert.equal(same.permanentFailures,1)
    await f.waits()
    assert.deepEqual(requests,['a','b'])
    const target = f.objects.get(recipient)
    now += 5_000
    target.storage.clearAlarm()
    await target.worker.alarm()
    assert.deepEqual(requests,['a','b'])
    now += 6_000
    target.storage.clearAlarm()
    await target.worker.alarm()
    assert.deepEqual(requests,['a','b','a'])
    const alreadyAccepted = await (await poke(f.env,'offline-fixture')).json()
    assert.equal(alreadyAccepted.duplicates,1)
    assert.equal(alreadyAccepted.permanentFailures,1)
    assert.equal(alreadyAccepted.delivered,0)
    const otherSigner = await (await poke(f.env,'offline-fixture',generateSecretKey())).json()
    assert.equal(otherSigner.queued,2)
    await f.waits()
    assert.deepEqual(requests,['a','b','a','a'])
  } finally {
    Date.now = realNow
    globalThis.fetch = fromFetch
  }
})

test('actual scheduled handler baselines old gift wraps, then queues newly observed backdated events once across relays', async () => {
  const f = await fixture(['test'])
  const fromFetch = globalThis.fetch
  const now = Math.floor(Date.now()/1000)
  const wrapper = generateSecretKey()
  const makeWrap = (created_at, label) => finalizeEvent({
    created_at, kind: 1059, tags: [['p', recipient]], content: label,
  }, wrapper)
  const historical = makeWrap(now-43*3600,'historical-fixture')
  const newlyObserved = makeWrap(now-47*3600,'late-fixture')
  let wraps = [historical]
  let providerCalls = 0
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('provider.fixture.invalid')) {
      providerCalls++
      return new Response(null,{status:201})
    }
    assert.equal(init.headers.Upgrade,'websocket')
    const socket = {
      accept() {}, close() {},
      addEventListener(n,fn) { if (n==='message') this.onMessage=fn },
      send(raw) {
        const [action,id,filter] = JSON.parse(raw)
        if (action!=='REQ') return
        assert.deepEqual(filter['#p'],[recipient])
        for (const ev of wraps) {
          if (filter.kinds.includes(ev.kind) && ev.created_at >= filter.since && ev.created_at <= filter.until) {
            this.onMessage({data:JSON.stringify(['EVENT',id,ev])})
          }
        }
        this.onMessage({data:JSON.stringify(['EOSE',id])})
      },
    }
    return { webSocket: socket }
  }
  const schedule = async (t) => {
    const tasks=[]
    await worker.scheduled({ scheduledTime:t }, f.env,{ waitUntil(p){tasks.push(p)} })
    await Promise.all(tasks)
    await f.waits()
  }
  try {
    await schedule(now*1000)
    assert.equal(providerCalls,0)
    wraps = [...wraps,newlyObserved]
    await schedule((now+60)*1000)
    assert.equal(providerCalls,1)
    await schedule((now+120)*1000)
    assert.equal(providerCalls,1)
  } finally {
    globalThis.fetch = fromFetch
  }
})


test('only an explicitly opted-in, matching pinned public room is queried and delivered', async () => {
  const f = await fixture(['test'])
  const originFetch = globalThis.fetch
  const trueNow = Date.now
  let now = Math.floor(trueNow()/1000)*1000
  Date.now = () => now
  const author = generateSecretKey()
  const makeRoom = (g,label) => finalizeEvent({
    created_at: Math.floor(now/1000),
    kind: 20000, tags: [['g',g]], content: label,
  },author)
  const enrolled = await f.env.PUSH_KV.get(subKeyForPubkey(recipient))
  const [first] = enrolled.devices
  const subscribe = async (eligible, geohashes = ['9q8y']) => {
    const u='https://agnostr.fixture.invalid/subscribe'
    const body = JSON.stringify({ pubkey: recipient, subscription: first.subscription, geohashes,
      publicPinnedRoomFallback:eligible, preferences:{geoMessages:'all'} })
    const ev=finalizeEvent({ kind:27235,created_at:Math.floor(Date.now()/1000),content:'',
      tags:[['u',u],['method','POST'],['payload',await sha256Hex(body)]] }, recipientSecret)
    return worker.fetch(new Request(u,{method:'POST',body,headers:{Authorization:'Nostr '+Buffer.from(JSON.stringify(ev)).toString('base64')}}), f.env)
  }
  let eventList=[]
  const requestedRooms = []
  const sent = []
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('provider.fixture.invalid')) {
      sent.push(url)
      return new Response(null,{status:201})
    }
    assert.equal(init.headers.Upgrade,'websocket')
    return {webSocket:{accept(){},close(){},addEventListener(n,fn){if(n==='message')this.fn=fn},send(raw){
      const [action,id,filter]=JSON.parse(raw)
      if(action!=='REQ')return
      if(filter['#g']) {
        requestedRooms.push(filter['#g'])
        // Deliberately coarse fixture: the client must check the event tag
        // even if a relay returns something outside the exact query scope.
        for (const ev of eventList) this.fn({data:JSON.stringify(['EVENT',id,ev])})
      } else assert.deepEqual(filter['#p'],[recipient])
      this.fn({data:JSON.stringify(['EOSE',id])})
    }}}
  }
  const run = async () => {
    const pending=[]
    await worker.scheduled({scheduledTime: now},f.env,{waitUntil(p){pending.push(p)}})
    await Promise.all(pending)
    await f.waits()
  }
  try {
    assert.equal((await subscribe(false)).status,200)
    await run()
    assert.deepEqual(requestedRooms,[])
    now+=1000
    assert.equal((await subscribe(true)).status,200)
    eventList=[makeRoom('9q8y','inside'), makeRoom('9zzz','outside')]
    await run()
    assert.equal(requestedRooms.length,3)
    assert.ok(requestedRooms.every((rooms)=>rooms.length===1 && rooms[0]==='9q8y'))
    assert.equal(sent.length,1)
    now+=1000
    await subscribe(false)
    eventList=[makeRoom('9q8y','disabled')]
    await run()
    assert.equal(requestedRooms.length,3)
    assert.equal(sent.length,1)
  } finally {
    Date.now = trueNow
    globalThis.fetch = originFetch
  }
})


test('concurrent unrelated signed subscribers are all enumerated without the old global KV index', async () => {
  const f = await fixture(['base'])
  const oldFetch = globalThis.fetch
  const now = Math.floor(Date.now()/60_000)*60_000
  const accounts = await Promise.all(Array.from({length:8},async (_,i)=>{
    const sk=generateSecretKey()
    return {sk,pk:getPublicKey(sk), subscription:(await endpoint('user-'+i)).subscription}
  }))
  let touchedLegacy = false
  const read = f.env.PUSH_KV.get
  const write = f.env.PUSH_KV.put
  f.env.PUSH_KV.get = async (key) => {
    touchedLegacy ||= key===PUBKEYS_INDEX_KEY
    return read(key)
  }
  f.env.PUSH_KV.put = async (key,value) => {
    touchedLegacy ||= key===PUBKEYS_INDEX_KEY
    return write(key,value)
  }
  const results=await Promise.all(accounts.map(async (d)=>{
    const u='https://agnostr.fixture.invalid/subscribe'
    const body=JSON.stringify({pubkey:d.pk,subscription:d.subscription})
    const auth=finalizeEvent({kind:27235,created_at:Math.floor(Date.now()/1000),content:'',
      tags:[['u',u],['method','POST'],['payload',await sha256Hex(body)]]},d.sk)
    return worker.fetch(new Request(u,{method:'POST',body,headers:{Authorization:'Nostr '+Buffer.from(JSON.stringify(auth)).toString('base64')}}),f.env)
  }))
  assert.ok(results.every((r)=>r.status===200))
  const scanned=new Set()
  globalThis.fetch=async () => ({webSocket:{accept(){},close(){},addEventListener(n,fn){if(n==='message')this.fn=fn},send(raw){
    const [op,id,filter]=JSON.parse(raw)
    if(op!=='REQ')return
    for(const pk of filter['#p']) scanned.add(pk)
    this.fn({data:JSON.stringify(['EOSE',id])})
  }}})
  try {
    const run=async(t)=>{
      const jobs=[]
      await worker.scheduled({scheduledTime:t},f.env,{waitUntil(p){jobs.push(p)}})
      await Promise.all(jobs)
      await f.waits()
    }
    await run(now)
    const first=new Set(scanned)
    assert.equal(first.size,6)
    await run(now)
    assert.deepEqual(scanned,first)
    await run(now+60_000)
    assert.equal(scanned.size,9)
    assert.ok(accounts.every((d)=>scanned.has(d.pk)))
    assert.equal(touchedLegacy,false)
  } finally { globalThis.fetch=oldFetch }
})
