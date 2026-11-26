// Run against a local production preview: node scripts/check-chat-delivery-ui.mjs http://127.0.0.1:4173/
// Disposable browser profile and local mock relay only.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools'

const base = new URL(process.argv.find(arg => /^https?:/.test(arg)) || 'http://127.0.0.1:4173/')
assert.equal(base.hostname, '127.0.0.1')
const tmp = mkdtempSync(join(tmpdir(),'agnostr-delivery-test-'))
const port = Number(process.env.CDP_PORT || 9531)
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
  const grouped = process.argv.includes('--group')
  const kind = grouped ? 9 : 20000
  const setup = ({localSecret, grouped, kind, founder}) => {
    window.sockets = []
    window.attempts = []
    window.acks = []
    window.hold = new Set(['first outbound'])
    window.WebSocket = class extends EventTarget {
      static OPEN=1; static CONNECTING=0; static CLOSED=3
      constructor(url) {
        super()
        this.url=url
        this.readyState=0
        this.reqs={}
        window.sockets.push(this)
        queueMicrotask(() => { this.readyState=1; this.dispatchEvent(new Event('open')) })
      }
      frame(frame) { this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify(frame)})) }
      send(raw) {
        const [cmd, event, ...filters] = JSON.parse(raw)
        if (cmd === 'REQ') {
          this.reqs[event]=filters
          queueMicrotask(() => this.frame(['EOSE', event]))
        }
        if (cmd === 'CLOSE') delete this.reqs[event]
        if (cmd !== 'EVENT') return
        if (event.kind === kind) window.attempts.push(event)
        if (event.kind === kind && window.hold.has(event.content)) {
          window.acks.push({socket:this,event})
        } else queueMicrotask(() => this.frame(['OK',event.id,true,'']))
      }
      close() { this.readyState=3 }
    }
    if(sessionStorage.getItem('seeded')) return
    sessionStorage.setItem('seeded','1')
    localStorage.setItem('agnostr:v2:device_seed',localSecret)
    localStorage.setItem('agnostr:v2:active_geohash','9q')
    if (grouped) localStorage.setItem('agnostr:v2:servers',JSON.stringify([{
      id:'delivery-fixture',kind:'virtual',name:'Delivery fixture',description:'',icon:'D',accentColor:'#4caf50',
      encrypted:false,founderPubkey:founder,relays:['wss://relay.example.com'],channels:[{id:'general',name:'general'}],
      moderators:[],bannedPubkeys:[],rev:1,joinedAt:Date.now(),lastActiveChannelId:'general',unreadCount:0,mentionCount:0,
    }]))
  }
  await cdp('Page.enable')
  await cdp('Page.addScriptToEvaluateOnNewDocument',{source:'('+setup+')('+JSON.stringify({
    localSecret:Buffer.from(generateSecretKey()).toString('hex'), grouped, kind, founder:peer.pubkey,
  })+')'})
  if(process.argv.includes('--mobile')) {
    await cdp('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true})
    await cdp('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:1})
  }
  base.hash='9q'
  await cdp('Page.navigate',{url:base.href})
  await wait(()=>!!document.querySelector('.ag-composer-bar textarea') ||
    [...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='Open Chat'))
  await run(()=>[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Open Chat')?.click())
  await wait(()=>!!document.querySelector('.ag-composer-bar textarea'))
  if (grouped) {
    await wait(()=>!!document.querySelector('button[aria-label="Delivery fixture"]'))
    await run(()=>document.querySelector('button[aria-label="Delivery fixture"]').click())
    await wait(()=>window.sockets.some(s=>Object.values(s.reqs).some(filters=>filters.some(f=>f['#t']?.includes('agnostr:delivery-fixture:general')))))
  }
  const send = async content => {
    await run(text=>{
      const t=document.querySelector('.ag-composer-bar textarea')
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(t,text)
      t.dispatchEvent(new Event('input',{bubbles:true}))
    },content)
    await run(()=>document.querySelector('[aria-label="Send message"]').click())
  }
  await send('first outbound')
  const first=await wait(()=>window.attempts.find(e=>e.content==='first outbound'))
  await send('second outbound')
  assert.equal(await run(()=>window.attempts.some(e=>e.content==='second outbound')),false)
  // Insert a peer event between wire timestamps, not just between ACKs.
  while(Math.floor(Date.now()/1000)<=first.created_at) await sleep(30)
  const inbound=finalizeEvent({kind,content:'peer arrived while queued',
    tags:[grouped?['t','agnostr:delivery-fixture:general']:['g','9q'],['n','Fixture']],created_at:Math.floor(Date.now()/1000)},peer.secretKey)
  await run(event=>{
    for(const s of window.sockets)for(const [id,filters] of Object.entries(s.reqs))
      if(filters.some(f=>f.kinds?.includes(event.kind)&&(event.kind===9?f['#t']?.includes(event.tags[0][1]):f['#g']?.includes('9q'))))s.frame(['EVENT',id,event])
  },inbound)
  await wait(()=>document.querySelector('.ag-msg-row') && document.body.innerText.includes('peer arrived while queued'))
  while(Math.floor(Date.now()/1000)<=inbound.created_at) await sleep(30)
  await run(()=>{
    window.hold.clear()
    for(const {socket,event} of window.acks.splice(0))socket.frame(['OK',event.id,false,'blocked: test rejection'])
  })
  const second=await wait(()=>window.attempts.find(e=>e.content==='second outbound'))
  assert.ok(second.created_at>inbound.created_at)
  await wait(()=>!!document.querySelector('.ag-msg-row button[aria-label="Retry sending message"]') &&
    !!document.querySelector('.ag-toast button.ag-msg-retry'))
  const rowOrder=()=>run(()=>[...document.querySelectorAll('.ag-msg-row .ag-msg-rich')].map(r=>r.textContent.trim()))
  assert.deepEqual((await rowOrder()).filter(s=>/outbound|peer arrived/.test(s)),['peer arrived while queued','second outbound','first outbound'])
  await run(()=>document.querySelector('.ag-toast button.ag-msg-retry').click())
  await wait(()=>!document.querySelector('.ag-msg-row button[aria-label="Retry sending message"]') &&
    [...document.querySelectorAll('.ag-msg-row')].some(r=>r.textContent.includes('first outbound')&&r.querySelector('.ag-msg-delivery.sent')))
  assert.equal(await run(()=>document.querySelector('.ag-composer-bar textarea').value),'','the failed row must not create a second draft')
  const ids=await run(()=>[...new Set(window.attempts.filter(e=>e.content==='first outbound').map(e=>e.id))])
  assert.deepEqual(ids,[first.id])
  assert.deepEqual((await rowOrder()).filter(s=>/outbound|peer arrived/.test(s)),['first outbound','peer arrived while queued','second outbound'])
  console.log('Chat delivery UI: chronological wire order, clickable failure toast, no duplicate row or wire event.',process.argv.includes('--mobile')?'mobile':'desktop',grouped?'group':'Bitchat')
} finally {
  ws?.close()
  chrome.kill()
  await sleep(300)
  rmSync(tmp,{recursive:true,force:true})
}
