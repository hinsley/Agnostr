// Against a local production build; use an in-memory Nostr relay and two isolated Chrome profiles.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateSecretKey, getPublicKey, nip19 } from 'nostr-tools'
import { decryptSelfPayload, deviceCheckpointAddressOf } from '../src/lib/deviceSync.ts'

const url = new URL(process.argv[2] || 'http://127.0.0.1:4173/')
assert.equal(url.hostname, '127.0.0.1')
const secretKey = generateSecretKey(), pubkey = getPublicKey(secretKey)
const peer = getPublicKey(generateSecretKey())
const id = 'synthetic-local-dm'
const secret = Buffer.from(secretKey).toString('hex')
const contexts = [], frames = [], checkpoints = new Map()
let failCheckpoint = true, passCheckpointBacklog = false, isolated = true
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

function fixture({secret, pk, npub, own, id, a, now}) {
  if (location.hostname !== '127.0.0.1') return
  window.fakeRelaySockets = []
  window.WebSocket = class extends EventTarget {
    static OPEN=1; static CONNECTING=0; static CLOSED=3
    constructor() {
      super(); this.readyState=0; this.idx=window.fakeRelaySockets.push(this)-1
      setTimeout(()=>{if(this.readyState!==0)return; this.readyState=1;this.dispatchEvent(new Event('open'))},5)
    }
    onFrame(frame) { this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify(frame)})) }
    send(raw) { window.relayToTest(JSON.stringify([this.idx,JSON.parse(raw)])) }
    close() { this.readyState=3 }
  }
  if (sessionStorage.getItem('seeded')) return
  sessionStorage.setItem('seeded','1')
  const set=(key,value)=>localStorage.setItem('agnostr:v2:'+key,value)
  set('device_seed',secret)
  set('sign_mode','auto')
  set('nickname',a?'Synthetic source':'Synthetic sibling')
  if (a !== null) set('pinned_channels',JSON.stringify([{geohash:a?'topic:desktop-pin':'topic:phone-pin',pinnedAt:now*1000,unreadCount:0,mentionCount:0}]))
  set('translator_prefs',JSON.stringify({model:a?'opus':'m2m100'}))
  const msg = {id, peerPubkey:pk, senderPubkey:own, content:'Same message on both devices',
    createdAt:now-10,isOwn:true,protocol:'nip17',deliveryStatus:a?'read':'sent'}
  if (a) Object.assign(msg,{wireId:'shared-wire-id', reactions:[{emoji:'🧪',count:1,pubkeys:[pk],reactedByMe:false}]})
  set('dm_threads',JSON.stringify([{peerPubkey:pk,peerNpub:npub,peerNickname:'Synthetic peer',
    peerDisplayHandle:'Synthetic peer',protocol:'nip17',messages:[msg],unreadCount:0,lastMessageAt:now,lastPreview:msg.content}]))
}

const matches = (event, filter) => {
  if (filter.kinds && !filter.kinds.includes(event.kind)) return false
  if (filter.authors && !filter.authors.some(pk=>event.pubkey.startsWith(pk))) return false
  for (const [tag,values] of Object.entries(filter)) {
    if (tag[0]==='#' && !event.tags.some(t=>t[0]===tag.slice(1)&&values.includes(t[1]))) return false
  }
  return !(filter.since && event.created_at<filter.since)
}

async function relay(from, raw) {
  const [socket,[cmd,first,...args]]=JSON.parse(raw)
  if (cmd==='REQ') {
    from.subs.set(socket+':'+first,{socket,id:first,filters:args})
    if (passCheckpointBacklog) for (const event of checkpoints.values()) {
      if (args.some(filter=>matches(event,filter))) await from.send(socket,['EVENT',first,event])
    }
    await from.send(socket,['EOSE',first])
    return
  }
  if (cmd==='CLOSE') {from.subs.delete(socket+':'+first);return}
  if (cmd!=='EVENT') return
  const event=first
  if (event.kind!==25055 && event.kind!==30078) {
    await from.send(socket,['OK',event.id,true,'synthetic relay']);return
  }
  const accept=event.kind!==30078||!failCheckpoint
  frames.push({side:from.side,event,accept})
  await from.send(socket,['OK',event.id,accept,accept?'':'synthetic offline'])
  if (!accept) return
  if (event.kind===30078) {
    const key = event.pubkey + ':' + deviceCheckpointAddressOf(event)
    const prior=checkpoints.get(key)
    if (!prior || event.created_at>prior.created_at || (event.created_at===prior.created_at&&event.id<prior.id)) {
      checkpoints.set(key,event)
    }
  }
  for (const context of contexts) for (const sub of context.subs.values()) {
    if (isolated && context!==from) continue
    if (sub.filters.some(filter=>matches(event,filter))) await context.send(sub.socket,['EVENT',sub.id,event])
  }
}

async function browser(port, a) {
  const dir=mkdtempSync(join(tmpdir(),'agnostr-sync-test-'))
  const proc=spawn(process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',[
    '--headless','--disable-gpu','--no-first-run','--no-default-browser-check','--disable-background-networking','--no-proxy-server',
    '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1','--window-size=1200,960','--remote-debugging-port='+port,'--user-data-dir='+dir],{stdio:'ignore'})
  const state={side:a===null?'C':a?'A':'B',subs:new Map(),proc,dir};contexts.push(state)
  let target
  for(let i=0;i<100&&!target;i++){
    try {target=(await (await fetch('http://127.0.0.1:'+port+'/json/list')).json()).find(x=>x.type==='page')} catch {}
    if(!target)await sleep(80)
  }
  assert.ok(target)
  const ws=new WebSocket(target.webSocketDebuggerUrl);state.ws=ws
  await new Promise((ok,no)=>{ws.onopen=ok;ws.onerror=no})
  const calls=new Map();let requestId=0
  ws.onmessage=e=>{
    const d=JSON.parse(e.data)
    if(calls.has(d.id)){calls.get(d.id)(d);calls.delete(d.id)}
    if(d.method==='Runtime.bindingCalled'&&d.params.name==='relayToTest') void relay(state,d.params.payload).catch(err=>{if(!closed)console.error(err)})
  }
  const cdp=(method,params={})=>new Promise((ok,no)=>{
    const id=++requestId;calls.set(id,val=>val.error?no(Error(val.error.message)):ok(val.result));ws.send(JSON.stringify({id,method,params}))
  })
  const run=async (fn,arg)=>{
    const val=await cdp('Runtime.evaluate',{expression:'('+fn+')('+JSON.stringify(arg)+')',awaitPromise:true,returnByValue:true})
    if(val.exceptionDetails)throw Error(val.exceptionDetails.exception?.description ?? val.exceptionDetails.text)
    return val.result.value
  }
  state.send=(socket,frame)=>run(({socket,frame})=>window.fakeRelaySockets?.[socket]?.onFrame(frame),{socket,frame})
  state.run=run
  await cdp('Runtime.enable');await cdp('Page.enable')
  await cdp('Runtime.addBinding',{name:'relayToTest'})
  const npub=nip19.npubEncode(peer)
  await cdp('Page.addScriptToEvaluateOnNewDocument',{source:'('+fixture+')('+JSON.stringify({secret,pk:peer,npub,own:pubkey,id,a,now:Math.floor(Date.now()/1000)})+')'})
  await cdp('Page.navigate',{url:url.href+'#dm='+npub+'&name=Synthetic+peer'})
  return state
}

async function wait(fn,hint) {
  for(let i=0;i<180;i++){if(await fn())return;await sleep(100)}
  throw Error('Timeout: '+hint)
}
let closed = false
try {
  const a=await browser(9478,true)
  await wait(()=>frames.some(f=>f.side==='A'&&f.event.kind===30078&&!f.accept),'failed first checkpoint')
  assert.equal(await a.run(()=>localStorage.getItem('agnostr:v2:device_sync_checkpoint_pending')),pubkey)
  failCheckpoint=false
  await a.run(()=>location.reload())
  await wait(()=>frames.some(f=>f.side==='A'&&f.event.kind===30078&&f.accept),'pending checkpoint retried after reload')
  await wait(()=>a.run(()=>localStorage.getItem('agnostr:v2:device_sync_checkpoint_pending')===null),'durable pending marker cleared only after an accepted publish')
  const b=await browser(9479,false)
  const durable = side => frames.find(f=>f.side===side&&f.accept&&deviceCheckpointAddressOf(f.event)?.startsWith('agnostr-device-sync-v2:'))?.event
  await wait(()=>durable('B'),'second offline device publishes an independent checkpoint')
  assert.notEqual(deviceCheckpointAddressOf(durable('A')),deviceCheckpointAddressOf(durable('B')))
  passCheckpointBacklog=true
  const c=await browser(9480,null)
  await wait(()=>c.run(()=> {
    const pins = JSON.parse(localStorage.getItem('agnostr:v2:pinned_channels') ?? '[]').map(x=>x.geohash)
    return pins.includes('topic:desktop-pin') && pins.includes('topic:phone-pin')
  }), 'cold client restored both offline edits')
  passCheckpointBacklog=false
  isolated=false
  await a.run(()=>location.reload())
  await wait(()=>b.run(()=>document.querySelector('#msg-synthetic-local-dm .ag-reaction-pill')?.textContent.includes('🧪')),'the sibling receives reaction metadata for an existing row')
  assert.equal(await b.run(()=>JSON.parse(localStorage.getItem('agnostr:v2:dm_threads'))[0].messages[0].deliveryStatus),'read')
  for (const [context,wanted] of [[a,'opus'],[b,'m2m100']]) assert.equal(await context.run(()=>JSON.parse(localStorage.getItem('agnostr:v2:translator_prefs')).model),wanted)
  const wire=await Promise.all(frames.filter(x=>x.accept).map(x=>decryptSelfPayload(x.event.content,{mode:'auto',pubkey,secretKey})))
  assert.ok(wire.some(raw=>raw?.includes('"dmVersions":true')))
  assert.ok(wire.every(raw=>!raw?.includes('"model"')&&!raw?.includes(secret)))
  // Cold sibling boot receives the authenticated checkpoint, not an actual user's history.
  passCheckpointBacklog=true
  await b.run(()=>{ localStorage.removeItem('agnostr:v2:dm_threads'); location.reload() })
  await wait(()=>b.run(()=>localStorage.getItem('agnostr:v2:dm_threads')?.includes('shared-wire-id')),'cold restore of the checkpoint tail')
  console.log('PASS: cold third client merged disjoint offline edits; failed checkpoint retry after restart, live same-ID metadata convergence, offline history restore, device-local model selection.')
} finally {
  closed = true
  for(const c of contexts){c.ws?.close();c.proc.kill()}
  for(const c of contexts){await new Promise(r=>c.proc.exitCode!==null?r():c.proc.once('exit',r));rmSync(c.dir,{recursive:true,force:true,maxRetries:4,retryDelay:100})}
}
