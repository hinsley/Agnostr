import { reconcileSyncedPins, mergeSyncedPins, sanitizeSyncedPinnedState } from '../src/lib/syncedPins.ts'
import { amailTombstoneCovers, mergeAmailTombstones } from '../src/lib/amailSyncTombstones.ts'
import test from 'node:test'
import assert from 'node:assert/strict'
import { generateSecretKey, getPublicKey } from 'nostr-tools'
import {
  deviceCheckpointAddress, deviceCheckpointAddressOf, collectDeviceCheckpoint, buildMessageChunkPackets,
  buildAmailChunkPackets, buildMessageRequestPackets, buildSignedDeviceSyncCheckpointEvent,
  buildSignedDeviceSyncEphemeralEvent, computeDmScopeDigest, computeJsonDigest, createEmptyCrdtState,
  decryptSelfPayload, fitCheckpointStateWithinBudget, MAX_NIP44_CHUNK_BYTES,
  mergeCrdtStates, parseDeviceSyncCheckpointEvent, parseDeviceSyncEphemeralEvent, utf8ByteLength,
} from '../src/lib/deviceSync.ts'
import { mergeDmMessageMetadata } from '../src/lib/dmMessageActions.ts'
const material = () => {
  const secretKey = generateSecretKey()
  return { mode: 'auto', secretKey, pubkey: getPublicKey(secretKey) }
}

test('siblings share encrypted CRDT and apply a later delete, but other profiles cannot read it', async () => {
  const a = material(), b = { ...a, secretKey: new Uint8Array(a.secretKey) }, other = material()
  const peer = 'e'.repeat(64)
  const first = createEmptyCrdtState()
  first.trusted[peer] = { pubkey: peer, addedAt: 100, removedAt: 0, label: 'Synthetic contact' }
  const event = await buildSignedDeviceSyncCheckpointEvent(first, a)
  assert.ok(event && !event.content.includes('Synthetic contact'))
  const firstOnB = await parseDeviceSyncCheckpointEvent(event, b)
  assert.equal(firstOnB.trusted[peer].label, 'Synthetic contact')
  assert.equal(await parseDeviceSyncCheckpointEvent(event, other), null)
  const second = { ...firstOnB, trusted: { [peer]: { ...firstOnB.trusted[peer], removedAt: 200 } } }
  const merged = mergeCrdtStates(first, second).merged
  assert.equal(merged.trusted[peer].removedAt, 200)
  assert.equal(mergeCrdtStates(merged, firstOnB).merged.trusted[peer].removedAt, 200)
})

test('request packets split by count and UTF-8 wire size without losing any scope', async () => {
  const scopes = Array.from({ length: 77 }, (_, i) => ({
    kind: 'dm', key: String(i), knownIds: Array.from({ length: 150 }, (_, j) => String(j).padStart(64,'0')),
  }))
  const packets = buildMessageRequestPackets({ v:1,type:'sync-msg-req',deviceId:'a',targetDeviceId:'b',ts:1,wantAmail:true,scopes })
  assert.ok(packets.every(p => p.scopes.length <= 32 && utf8ByteLength(JSON.stringify(p)) <= MAX_NIP44_CHUNK_BYTES))
  assert.deepEqual(packets.flatMap(p=>p.scopes),scopes)
  assert.equal(packets.filter(p=>p.wantAmail).length,1)
  // Legacy requesters could send more than 32 scopes in one small packet.
  const oldRequest={v:1,type:'sync-msg-req',deviceId:'old',targetDeviceId:'new',ts:1,
    scopes:scopes.slice(0,44).map(s=>({...s,knownIds:[]}))}
  const a=material()
  const parsed=await parseDeviceSyncEphemeralEvent(await buildSignedDeviceSyncEphemeralEvent(oldRequest,a),a)
  assert.equal(parsed.scopes.length,44)
  assert.equal(parsed.scopes[32].key,'32')
})

test('Agmail sync obeys encrypted packet limit with emoji, CJK, quotes and control characters', async () => {
  const a = material()
  const payload = { text: '你好🌚😀"\\\t\u0000'.repeat(15_000) }
  const packets = buildAmailChunkPackets({ deviceId:'a',targetDeviceId:'b',transferId:'1',
    updatedAt:1,hash:computeJsonDigest(payload),payload })
  const parts = []
  for (const packet of packets) {
    assert.ok(utf8ByteLength(JSON.stringify(packet)) <= MAX_NIP44_CHUNK_BYTES)
    const e = await buildSignedDeviceSyncEphemeralEvent(packet,a)
    const p = await parseDeviceSyncEphemeralEvent(e,a)
    parts.push(p.data)
  }
  assert.deepEqual(JSON.parse(parts.join('')),payload)
  const invalid = { ...packets[0],chunkIndex:packets.length }
  assert.equal(await parseDeviceSyncEphemeralEvent(await buildSignedDeviceSyncEphemeralEvent(invalid,a),a),null)
})

test('same DM ID reconciles delivery state, canonical reference and both peers’ reactions', () => {
  const peer = '9'.repeat(64), own = '2'.repeat(64)
  const m = { id:'m',peerPubkey:peer,senderPubkey:own,content:'Original',createdAt:1,deliveryStatus:'sent' }
  const remote = { ...m, content:'Do not overwrite message body', wireId:'wire',replyToId:'parent',deliveryStatus:'read',
    reactions:[{ emoji:'🔥',pubkeys:[peer,own],count:9000,reactedByMe:true }] }
  assert.equal(computeDmScopeDigest([m]).hash,computeDmScopeDigest([remote]).hash)
  assert.notEqual(computeDmScopeDigest([m]).versionsHash,computeDmScopeDigest([remote]).versionsHash)
  const merged = mergeDmMessageMetadata(m,remote)
  assert.equal(merged.content,m.content)
  assert.equal(merged.deliveryStatus,'read')
  assert.equal(merged.wireId,'wire')
  assert.equal(merged.replyToId,'parent')
  assert.equal(merged.reactions[0].count,2)
  assert.equal(mergeDmMessageMetadata(merged,m),merged)
  assert.equal(mergeDmMessageMetadata(merged,remote),merged)
})

test('checkpoint fitting keeps the allowlisted profile fields and drops unrelated sensitive settings', async () => {
  const a = material()
  const state = { ...createEmptyCrdtState(), wallet:{seed:'fixture only'}, settings:{model:'Other',pushEndpoint:'fixture'} }
  const fits = fitCheckpointStateWithinBudget(state,null)
  const e = await buildSignedDeviceSyncCheckpointEvent(fits,a)
  const wire = JSON.parse(await decryptSelfPayload(e.content,a))
  assert.ok(!('wallet' in wire) && !('settings' in wire))
})

test('equal-clock preference conflicts converge and unchanged newer values advance their clock', () => {
  const a=createEmptyCrdtState(), b=createEmptyCrdtState()
  a.nickname={value:'Anna',updatedAt:20};b.nickname={value:'David',updatedAt:20}
  a.lud16={value:'example@example.test',updatedAt:20};b.lud16={value:null,updatedAt:20}
  const ab=mergeCrdtStates(a,b).merged, ba=mergeCrdtStates(b,a).merged
  assert.deepEqual(ab,ba)
  assert.equal(ab.lud16.value,null)
  const newer={...ab,nickname:{...ab.nickname,updatedAt:50},pinned:{...ab.pinned,updatedAt:60}}
  const result=mergeCrdtStates(ab,newer)
  assert.equal(result.changed,true)
  assert.equal(result.merged.nickname.updatedAt,50)
  assert.equal(result.merged.pinned.updatedAt,60)
})

test('stale Agmail tombstones cannot lower the cutoff or remove later records', () => {
  const result=mergeAmailTombstones({mail:200},{mail:100,other:50})
  assert.equal(result.changed,true)
  assert.deepEqual(result.merged,{mail:200,other:50})
  assert.equal(amailTombstoneCovers(result.merged.mail,200),true)
  assert.equal(amailTombstoneCovers(result.merged.mail,201),false)
  assert.equal(amailTombstoneCovers(0,0),false)
})

test('different devices retain distinct addressable checkpoints and a cold client merges both', async () => {
  const a=material()
  const left=createEmptyCrdtState(), right=createEmptyCrdtState()
  const p='e'.repeat(64), q='f'.repeat(64)
  left.trusted[p]={pubkey:p,addedAt:10,removedAt:0,label:'left'}
  right.blocked[q]={pubkey:q,addedAt:12,removedAt:0}
  const e1=await buildSignedDeviceSyncCheckpointEvent(left,a,false,'device-A')
  const e2=await buildSignedDeviceSyncCheckpointEvent(right,a,false,'device-B')
  const v1a=await buildSignedDeviceSyncCheckpointEvent(left,a)
  const v1b=await buildSignedDeviceSyncCheckpointEvent(right,a)
  assert.equal(deviceCheckpointAddressOf(v1a),deviceCheckpointAddressOf(v1b),'legacy writers overwrite')
  assert.notEqual(deviceCheckpointAddressOf(e1),deviceCheckpointAddressOf(e2))
  assert.equal(deviceCheckpointAddressOf(e1),deviceCheckpointAddress(a.pubkey,'device-A'))
  assert.notEqual(deviceCheckpointAddress(material().pubkey,'device-A'),deviceCheckpointAddressOf(e1))
  const relayState = new Map([v1a,v1b,e1,e2].map(ev=>[deviceCheckpointAddressOf(ev),ev]))
  assert.equal(relayState.size,3)
  const buffer=new Map()
  for(const event of relayState.values()) collectDeviceCheckpoint(buffer,event)
  collectDeviceCheckpoint(buffer,e1)
  assert.equal([...buffer.values()].flat().length,3)
  let recovered=createEmptyCrdtState()
  for (const e of [...buffer.values()].flat()) recovered=mergeCrdtStates(recovered,
    await parseDeviceSyncCheckpointEvent(e,{...a,secretKey:new Uint8Array(a.secretKey)})).merged
  assert.equal(recovered.trusted[p].label,'left')
  assert.equal(recovered.blocked[q].addedAt,12)
})

test('disjoint offline pin changes survive, reorder is deterministic and old snapshots cannot resurrect a pin', () => {
  const pin=(geohash,pinnedAt)=>({geohash,pinnedAt,unreadCount:0,mentionCount:0})
  const x=pin('topic:desktop-pin',20), y=pin('topic:phone-pin',21)
  const empty={updatedAt:0,items:[]}
  const a=reconcileSyncedPins(empty,[x],20,false), b=reconcileSyncedPins(empty,[y],21,false)
  const ab=mergeSyncedPins(a,b), ba=mergeSyncedPins(b,a)
  assert.deepEqual(ab,ba)
  assert.deepEqual(ab.items.map(p=>p.geohash),[y.geohash,x.geohash])
  const roundtrip=sanitizeSyncedPinnedState(JSON.parse(JSON.stringify(ab)))
  assert.deepEqual(roundtrip,ab)
  const moved=reconcileSyncedPins(ab,[x,y],45,false)
  const without=reconcileSyncedPins(ba,[y],44,false)
  assert.deepEqual(mergeSyncedPins(moved,without).items.map(p=>p.geohash),[y.geohash])
  const staleLegacy={updatedAt:100,items:[x]}
  const withStale=mergeSyncedPins(without,staleLegacy)
  assert.deepEqual(withStale.items.map(p=>p.geohash),[y.geohash])
  const repinned=reconcileSyncedPins(withStale,[{...x,pinnedAt:105},y],105,false)
  assert.equal(mergeSyncedPins(repinned,without).items.length,2)
})

test('fallback transfers still obey the final size bound', async () => {
  const requests=buildMessageRequestPackets({ v:1,type:'sync-msg-req',deviceId:'a',targetDeviceId:'b',
    ts:1,scopes:[{kind:'dm',key:'peer',knownIds:['🙂'.repeat(25_000)]}] })
  const oversized = { ...createEmptyCrdtState(), peerNotes: { ['e'.repeat(64)]: { text: 'x'.repeat(50_000), updatedAt: 1 } } }
  const signer = material()
  assert.equal(await buildSignedDeviceSyncCheckpointEvent(oversized,signer),null)
  assert.equal(await buildSignedDeviceSyncEphemeralEvent({v:1,type:'sync-state',deviceId:'a',
    deviceLabel:'a',nickname:'a',ts:1,state:oversized},signer),null)
  assert.deepEqual(requests[0].scopes,[{kind:'dm',key:'peer',knownIds:[]}])
  assert.ok(utf8ByteLength(JSON.stringify(requests[0]))<=MAX_NIP44_CHUNK_BYTES)
  const messages=Array.from({length:17},(_,i)=>({id:String(i).padStart(2,'0'),content:'a'.repeat(100)}))
  const options={deviceId:'a',targetDeviceId:'b',scopeKind:'dm',scopeKey:'peer'}
  const maxBytes=utf8ByteLength(JSON.stringify({...options,v:1,type:'sync-msg-chunk',ts:Date.now(),
    chunkIndex:10,totalChunks:17,messages:[messages[0]]}))
  const chunks=buildMessageChunkPackets({...options,messages,maxBytes})
  assert.ok(chunks.length>10)
  assert.deepEqual(chunks.flatMap(p=>p.messages),messages)
  assert.ok(chunks.every(p=>utf8ByteLength(JSON.stringify(p))<=maxBytes))
})
