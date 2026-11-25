// Run against a local production preview: node scripts/check-bitchat-history-ui.mjs http://127.0.0.1:4173/
// Disposable browser profile and local mock relay only.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools'

const base = new URL(process.argv[2] || 'http://127.0.0.1:4173/')
assert.equal(base.hostname, '127.0.0.1')
const tmp = mkdtempSync(join(tmpdir(),'agnostr-history-test-'))
const port = Number(process.env.CDP_PORT || 9495)
const chrome = spawn(process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
  '--headless','--disable-gpu','--no-first-run','--no-default-browser-check','--disable-background-networking',
  '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1','--no-proxy-server','--window-size=1200,960',
  '--remote-debugging-port='+port,'--user-data-dir='+tmp,'about:blank'],{stdio:'ignore'})
const sleep = ms => new Promise(r=>setTimeout(r,ms))
const peer = { mode:'local',secretKey:generateSecretKey() }
peer.pubkey = getPublicKey(peer.secretKey)
let ws
try {
  let target
  for (let i=0;i<100&&!target;i++) {
    try { target=(await (await fetch('http://127.0.0.1:'+port+'/json/list')).json()).find(x=>x.type==='page') } catch {}
    if (!target) await sleep(80)
  }
  assert.ok(target,'Chrome did not start')
  ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((ok,err)=>{ws.onopen=ok;ws.onerror=err})
  const pending = new Map(); let id=0
  ws.onmessage = e => { const d=JSON.parse(e.data); if(pending.has(d.id)){pending.get(d.id)(d);pending.delete(d.id)} }
  const cdp = (method,params={}) => new Promise((ok,err)=>{
    const n=++id; pending.set(n,d=>d.error?err(Error(d.error.message)):ok(d.result));ws.send(JSON.stringify({id:n,method,params}))
  })
  const run = async (fn,arg) => {
    const r=await cdp('Runtime.evaluate',{expression:'('+fn+')('+JSON.stringify(arg)+')',awaitPromise:true,returnByValue:true})
    if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text)
    return r.result.value
  }
  const wait = async (fn,arg) => {
    for(let i=0;i<100;i++) {const result=await run(fn,arg);if(result)return result;await sleep(100)}
    throw Error('Timeout: '+fn+' | '+await run(()=>document.body.innerText.slice(-1500)))
  }
  const seedCount = 250, geohash = '9q'
  const setup = ({pk,seedCount,geohash}) => {
    if(location.protocol !== 'http:') return
    window.testEvents = {}; window.testSockets = []
    window.WebSocket = class extends EventTarget {
      static OPEN=1; static CONNECTING=0; static CLOSED=3
      constructor(url){super();this.url=url;this.readyState=0;this.reqs={};window.testSockets.push(this);
        setTimeout(()=>{if(this.readyState!==0)return;this.readyState=1;this.dispatchEvent(new Event('open'))},10)}
      frame(frame){this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify(frame)}))}
      send(raw){const [cmd,id,...args]=JSON.parse(raw)
        if(cmd==='EVENT'){window.testEvents[id.id]=id;setTimeout(()=>this.frame(['OK',id.id,true,'']),5)}
        if(cmd==='REQ'){this.reqs[id]=args;setTimeout(()=>this.frame(['EOSE',id]),5)}
        if(cmd==='CLOSE')delete this.reqs[id]}
      close(){this.readyState=3}
    }
    window.fixtureMessage = i => ({
      id:i.toString(16).padStart(64,'0'),geohash,pubkey:pk,nickname:'Fixture',displayHandle:'Fixture',
      content:'Cached message '+i+' — '+('this is a longer line of ordinary chat text '.repeat(1+(i%4))),
      createdAt:Math.floor(Date.now()/1000)-10000+Math.floor(i/3),tags:[],
      isOwn:false,isTeleported:false,isMeshBridge:false,powBits:0,reactions:[],mentions:[]
    })
    window.pins=[];
    for (const name of ['scrollTop','scrollTo']) {
      const d=Object.getOwnPropertyDescriptor(Element.prototype,name);
      if(name==='scrollTop')Object.defineProperty(Element.prototype,name,{...d,set(v){if(this.matches('.ag-stream-scroll'))window.pins.push({v,at:performance.now(),stack:new Error().stack.split('\n').slice(1,4)});return d.set.call(this,v)}})
      else Object.defineProperty(Element.prototype,name,{...d,value(...a){if(this.matches('.ag-stream-scroll'))window.pins.push({v:a,at:performance.now(),stack:new Error().stack.split('\n').slice(1,4)});return d.value.apply(this,a)}})
    }
    if(sessionStorage.getItem('seeded'))return
    sessionStorage.setItem('seeded','1')
    const messages = Array.from({length:seedCount}, (_, i) => window.fixtureMessage(2501 - seedCount + i))
    localStorage.setItem('agnostr:v2:active_geohash',geohash)
    localStorage.setItem('agnostr:v2:msgs:'+geohash,JSON.stringify(messages))
  }
  await cdp('Page.enable')
  await cdp('Network.enable')
  await cdp('Network.setBlockedURLs',{urls:['*://fonts.*/*']})
  await cdp('Page.addScriptToEvaluateOnNewDocument',{source:'('+setup+')('+JSON.stringify({pk:peer.pubkey,seedCount,geohash})+')'})
  await cdp('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true})
  await cdp('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:1})
  base.hash=geohash
  await cdp('Page.navigate',{url:base.href})
  const chat=()=>!!document.querySelector('.ag-msg-row')
  await wait(()=>!!document.querySelector('.ag-msg-row')||[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='Open Chat'))
  if(!await run(chat)) await run(()=>[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Open Chat').click())
  await wait(()=>!!document.querySelector('.ag-msg-row')&&!!document.querySelector('.ag-stream-scroll'))
  await sleep(600)
  const send = async (evs) => run(events=>{
    let delivered=0
    for(const sock of [...window.testSockets].reverse())for(const [id,filters] of Object.entries(sock.reqs)){
      if(filters.some(f=>f.kinds?.includes(20000)&&f['#g']?.includes('9q'))){
        for(const ev of events) sock.frame(['EVENT',id,ev])
        return ++delivered
      }
    }
    return delivered
  },evs)
  const state = ({id}={}) => {
    const s=document.querySelector('.ag-stream-scroll')
    const rect=s.getBoundingClientRect()
    const rows=[...s.querySelectorAll('.ag-msg-row')];
    const anchor=rows.find(x=>x.getBoundingClientRect().bottom>rect.top+15);
    const requested=id ? document.getElementById(id) : anchor;
    const y = x=>x? Math.round(x.getBoundingClientRect().top-rect.top) : null;
    return {
      top:s.scrollTop,height:s.scrollHeight,client:s.clientHeight,viewportY:Math.round(rect.top),
      dist:s.scrollHeight-s.clientHeight-s.scrollTop,anchor:anchor?.id,anchorText:anchor?.textContent.slice(0,60),anchorY:y(anchor),targetY:y(requested),
      rows:rows.length,first:rows[0]?.textContent.slice(0,45),last:rows.at(-1)?.textContent.slice(0,45),
      load:s.querySelector('button.ag-load-earlier-btn')?.textContent?.trim()||s.querySelector('button')?.textContent?.trim(),
      marker:s.querySelector('.ag-unread-divider')?.getBoundingClientRect()?.y??null,
      jumpBtn:document.querySelector('.ag-jump-latest')?.textContent ?? null,
      reading:s.classList.contains('is-reading'), pins:window.pins
    }
  }
  const peers=[peer.secretKey,generateSecretKey()];
  let n=0
  const event=(content,ts,extra=[])=>finalizeEvent({kind:20000,created_at:ts??Math.floor(Date.now()/1000)-200,content,tags:[['g','9q'],['n','Other'],...extra]},peers[n++%peers.length])
  const genuine = (name, times=1, words='new')=>Array.from({length:times},(_,i)=>event(name+' '+i+' '+words.repeat(7+i),Math.floor(Date.now()/1000)-180+n))
  async function step(name,evs) {
    await run(()=>{window.pins=[]});
    const before=await run(state,{})
    const del=await send(evs); assert.ok(del,'no geohash chat subscription')
    await sleep(400)
    const after=await run(state,{id:before.anchor})
    return {name,before,after,shift:after.targetY===null?null:after.targetY-before.anchorY}
  }
  async function park(offset, mode='bottom') {
    await run(({offset,mode})=>{const s=document.querySelector('.ag-stream-scroll');s.scrollTop=mode==='absolute'?offset:s.scrollHeight-s.clientHeight-offset}, {offset,mode});
    await sleep(340)
  }
  const dbStats = async ({seed=false, seedOlder=0, ids=[]}={}) => {
    const req = indexedDB.open('agnostr-bitchat-history-v1')
    await new Promise((ok,no)=>{req.onsuccess=ok;req.onerror=no})
    const db = req.result
    const profile = localStorage.getItem('agnostr:v3:active_profile_id')
    const tx = db.transaction('messages',seed||seedOlder?'readwrite':'readonly')
    const done = new Promise((ok,no)=>{tx.oncomplete=ok;tx.onabort=no;tx.onerror=no})
    const store = tx.objectStore('messages')
    const current=store.count(IDBKeyRange.bound([profile,'9q'],[profile,'9q',[]],false,true))
    const received=store.getAllKeys(IDBKeyRange.bound([profile,'9q'],[profile,'9q',[]],false,true))
    if (seedOlder) {
      for(let i=0;i<seedOlder;i++){
        const message = {...window.fixtureMessage(6000+i), createdAt:100+i}
        store.put({profile,room:'9q',at:message.createdAt,id:message.id,author:message.pubkey,message})
      }
    }
    if (seed) {
      // Populate only history that predates the real recent cache. All live
      // traffic still goes through the production relay and persistence path.
      for(let i=0;i<=2250;i++){
        const message = window.fixtureMessage(i)
        store.put({profile,room:'9q',at:message.createdAt-120,id:message.id,
          author:message.pubkey,message:{...message,createdAt:message.createdAt-120}})
      }
      const message = {...window.fixtureMessage(2500), id:'f'.repeat(64), content:'OTHER PROFILE ONLY'}
      store.put({profile:'e'.repeat(64), room:'9q',at:message.createdAt-200,id:message.id,author:message.pubkey,
        message:{...message,createdAt:message.createdAt-200}})
    }
    await done
    db.close()
    return {count:current.result, selected:received.result.filter(k=>ids.includes(k[3])).map(k=>k[3])}
  }
  assert.ok((await run(dbStats,{})).count >= 240,'existing recent cache did not migrate')
  await run(dbStats,{seed:true})
  assert.ok((await run(dbStats,{})).count >= 2500,'archive fixture not persisted')

  const followed = await step('live incoming',genuine('live-normal'))
  assert.equal(followed.after.dist,0)
  assert.notEqual(followed.after.last,followed.before.last)

  await park(25)
  const near = await step('near tail',genuine('near-tail'))
  assert.equal(near.before.dist,25)
  assert.equal(near.after.dist,25)
  assert.equal(near.shift,0)
  assert.equal(near.after.pins.length,0)
  assert.equal(near.after.jumpBtn,'1 new message')

  await park(680)
  const burst = genuine('parked-burst',5)
  const stationary = await step('capped feed + burst',burst)
  assert.equal(stationary.shift,0)
  assert.equal(stationary.before.top,stationary.after.top)
  assert.equal(stationary.after.rows,160)
  assert.equal(stationary.after.pins.length,0)
  assert.equal(stationary.after.jumpBtn,'6 new messages')
  assert.equal((await run(dbStats,{ids:burst.map(m=>m.id)})).selected.length,5)

  // Draft is intentionally unsent: browsing must never remount the composer.
  await run(()=>document.querySelector('.ag-composer-bar textarea').focus())
  await cdp('Input.insertText',{text:'My unsent draft'})
  const draft = ()=>document.querySelector('.ag-composer-bar textarea').value
  assert.equal(await run(draft),'My unsent draft')

  let oldest = Number.MAX_SAFE_INTEGER
  let visited=0
  for(let i=0;i<30;i++){
    await park(124,'absolute')
    const before=await run(state,{})
    const first=await run(()=>document.querySelector('.ag-stream-scroll .ag-msg-row')?.id)
    await run(()=>document.querySelector('.ag-load-earlier-btn')?.click())
    const changed=await wait(first=>{
      const s=document.querySelector('.ag-stream-scroll')
      return s.querySelector('.ag-msg-row')?.id!==first || !s.querySelector('.ag-load-earlier-btn')
    },first)
    assert.ok(changed)
    const after=await run(state,{id:before.anchor})
    assert.equal(after.targetY,before.anchorY,'anchor lost when paging older')
    assert.ok(after.rows<=160,'page mounted too many rows')
    const body=await run(()=>document.querySelector('.ag-stream-scroll').innerText)
    assert.ok(!body.includes('OTHER PROFILE ONLY'))
    const firstIndex=Number(after.first?.match(/Cached message (\d+)/)?.[1])
    assert.ok(firstIndex<=oldest,'earlier paging reversed')
    if(firstIndex===oldest) break
    visited++; oldest=firstIndex
    if(oldest===0) break
  }
  assert.ok(visited>=23,'did not page through thousands of prior rows')
  assert.equal(oldest,0)
  assert.equal(await run(draft),'My unsent draft')

  // Walk one window forward with preservation near its overlap, then go live.
  await park(90)
  const beforeForward=await run(state,{})
  await run(()=>document.querySelector('.ag-load-newer-wrap button').click())
  await wait(()=>!document.querySelector('.ag-load-newer-wrap button')?.disabled)
  const afterForward=await run(state,{id:beforeForward.anchor})
  assert.equal(afterForward.targetY,beforeForward.anchorY)
  assert.notEqual(afterForward.first,beforeForward.first)

  await run(()=>document.querySelector('.ag-jump-latest').click())
  await wait(()=>{const s=document.querySelector('.ag-stream-scroll');return !s.classList.contains('is-reading')&&s.scrollHeight-s.clientHeight-s.scrollTop<=2})
  assert.equal(await run(draft),'My unsent draft')
  const gestureStart=await run(()=>{
    const {left,top,width,height}=document.querySelector('.ag-stream-scroll').getBoundingClientRect()
    return {x:Math.floor(left+width/2),y:Math.floor(top+height/2)}
  })
  await cdp('Input.synthesizeScrollGesture',{...gestureStart,yDistance:160,speed:1500,preventFling:false,gestureSourceType:'touch'})
  await wait(()=>document.querySelector('.ag-stream-scroll').classList.contains('is-reading'))
  await sleep(750)
  const swipe=await step('after fast touch swipe',genuine('swipe-new'))
  assert.ok(swipe.before.dist>25)
  assert.equal(swipe.before.anchor,swipe.after.anchor)
  assert.equal(swipe.shift,0)
  assert.equal(swipe.after.pins.length,0)
  assert.equal(await run(draft),'My unsent draft')
  await run(()=>document.querySelector('.ag-jump-latest').click())
  await wait(()=>!document.querySelector('.ag-stream-scroll').classList.contains('is-reading'))
  const firstHeld = await run(state,{})
  const gesture = cdp('Input.synthesizeScrollGesture',{...gestureStart,yDistance:425,speed:180,preventFling:true,gestureSourceType:'touch'})
  await wait(()=>document.querySelector('.ag-stream-scroll').classList.contains('is-reading'))
  const during = await step('arrival during finger drag',genuine('finger-drag'))
  assert.equal(during.after.first,firstHeld.first)
  assert.equal(during.after.last,firstHeld.last)
  assert.equal(during.after.pins.length,0)
  await gesture

  await run(dbStats,{seedOlder:3000})
  const cappedEvent=genuine('cap-live')
  await step('prune disk on actual receive',cappedEvent)
  const capped=await run(dbStats,{ids:cappedEvent.map(ev=>ev.id)})
  assert.equal(capped.count,5000)
  assert.equal(capped.selected.length,1)
  assert.equal(await run(draft),'My unsent draft')

  await run(()=>{
    const input=document.querySelector('.ag-composer-bar textarea')
    input.focus()
    input.select()
  })
  await cdp('Input.insertText',{text:'/clear'})
  await run(()=>document.querySelector('button[aria-label="Send message"]').click())
  await wait(()=>!document.querySelector('.ag-stream-scroll .ag-msg-row'))
  assert.equal((await run(dbStats,{})).count,0,'/clear left public local history behind')
  console.log(`Bitchat: ${visited} on-device pages, 160 mounted rows, 5000 stored messages, stable anchor through swipes/arrivals, preserved draft, and /clear purged the room.`)
} finally {
  ws?.close(); chrome.kill(); await sleep(350); rmSync(tmp,{recursive:true,force:true,maxRetries:4,retryDelay:250});
}
