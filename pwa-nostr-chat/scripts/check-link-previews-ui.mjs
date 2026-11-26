// Run against a local production preview: node scripts/check-link-previews-ui.mjs http://127.0.0.1:4173/
// Disposable browser profile and local mock relay only.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateSecretKey, getPublicKey, nip19 } from 'nostr-tools'

const base = new URL(process.argv.find(arg => /^https?:/.test(arg)) || 'http://127.0.0.1:4173/')
assert.equal(base.hostname, '127.0.0.1')
const tmp = mkdtempSync(join(tmpdir(),'agnostr-link-preview-test-'))
const port = Number(process.env.CDP_PORT || 9523)
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
  const setUp = ({ pk, npub, untrusted, localSecret }) => {
    window.previewRequests = []
    const nativeFetch = window.fetch.bind(window)
    window.fetch = (input, init) => {
      if (String(input) !== 'http://127.0.0.1:4801/preview') return nativeFetch(input, init)
      const { url } = JSON.parse(init.body)
      window.previewRequests.push({ url, credentials: init.credentials })
      if (url.endsWith('/unavailable')) return Promise.resolve(new Response(null, { status: 204 }))
      return Promise.resolve(Response.json({ title: 'A trusted article', description: 'A short summary' }))
    }
    window.subscriptions = []
    window.WebSocket = class extends EventTarget {
      static CONNECTING = 0
      static OPEN = 1
      static CLOSED = 3
      readyState = 0
      constructor() {
        super()
        queueMicrotask(() => { this.readyState = 1; this.dispatchEvent(new Event('open')) })
      }
      send(raw) {
        const [type, id, ...filters] = JSON.parse(raw)
        if (type === 'REQ') window.subscriptions.push(...filters)
        const reply = type === 'REQ' ? ['EOSE', id] : type === 'EVENT' ? ['OK', id.id, true, ''] : null
        if (reply) queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(reply) })))
      }
      close() { this.readyState = 3 }
    }

    Object.defineProperty(navigator.clipboard, 'writeText', { value: text => {
      window.copiedText = text
      return Promise.resolve()
    } })
    const geohash = '9q'
    if (sessionStorage.getItem('seeded')) return
    sessionStorage.setItem('seeded', '1')
    localStorage.setItem('agnostr:v2:device_seed', localSecret)
    localStorage.setItem('agnostr:v2:trusted', JSON.stringify([{ pubkey: pk, label: 'Trusted fixture', addedAt: Date.now() }]))
    localStorage.setItem('agnostr:v2:active_geohash', geohash)
    const now=Math.floor(Date.now()/1000)
    const privateText='A DM https://newspaper.com/private-story'
    localStorage.setItem('agnostr:v2:dm_threads', JSON.stringify([{
      peerPubkey:pk, peerNpub:npub, peerNickname:'Fixture', peerDisplayHandle:'Fixture',
      protocol:'nip17', unreadCount:0, lastMessageAt:now, lastPreview:privateText,
      messages:[{id:'previewdm',peerPubkey:pk,senderPubkey:pk,content:privateText,createdAt:now,
        isOwn:false,protocol:'nip17',deliveryStatus:'delivered'}],
    }]))

    localStorage.setItem('agnostr:v2:msgs:'+geohash, JSON.stringify([
      '[An article](https://newspaper.com/world?utm_source=chat) https://newspaper.com/world#same ||https://hidden.com/spoiler|| `https://ignored.com/inline`',
      'Untrusted https://other.com/untrusted',
      'Unavailable https://newspaper.com/unavailable',
    ].map((content,i)=>({
      id:String(i+1).repeat(64), geohash, pubkey:i===1?untrusted:pk, nickname:'Fixture', displayHandle:'Fixture',
      content, createdAt:Math.floor(Date.now()/1000)-60+i, tags:[], isOwn:false, isTeleported:false,
      isMeshBridge:false, powBits:0, reactions:[], mentions:[],
    }))))
  }
  await cdp('Page.enable')
  await cdp('Page.addScriptToEvaluateOnNewDocument',{source:'('+setUp+')('+JSON.stringify({
    pk:peer.pubkey,npub:nip19.npubEncode(peer.pubkey),untrusted:getPublicKey(generateSecretKey()),localSecret:Buffer.from(generateSecretKey()).toString('hex'),
  })+')'})
  const mobile = process.argv.includes('--mobile')
  if(mobile) {
    await cdp('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true})
    await cdp('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:1})
  }
  base.hash='9q'
  await cdp('Page.navigate',{url:base.href})
  await wait(()=>!!document.querySelector('.ag-msg-row .ag-msg-rich') ||
    [...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='Open Chat'))
  await run(()=>[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Open Chat')?.click())
  await wait(()=>document.querySelectorAll('.ag-msg-row .ag-msg-rich').length>=3)
  await wait(()=>document.querySelector('.ag-link-card-title')?.textContent==='A trusted article')
  await wait(()=>window.previewRequests.length===2)
  const result=await run(()=>{
    const card=document.querySelector('.ag-link-card')
    const parent=card.closest('.ag-msg-rich')
    return {
      href: card.getAttribute('href'), rel: card.rel,
      width: card.getBoundingClientRect().width, parentWidth: parent.getBoundingClientRect().width,
      domain: card.querySelector('.ag-link-card-domain').textContent,
      description:card.querySelector('.ag-link-card-description').textContent,
      cards:document.querySelectorAll('.ag-link-card').length,
      plain:!!document.querySelector('a[href="https://newspaper.com/unavailable"]'),
      requests:window.previewRequests.map(x=>[x.url,x.credentials]).sort(),
    }
  })
  assert.equal(result.cards,1)
  assert.ok(result.width>0 && result.width<=result.parentWidth+1)
  assert.equal(result.href,'https://newspaper.com/world?utm_source=chat')
  assert.equal(result.rel,'noopener noreferrer')
  assert.equal(result.domain,'newspaper.com')
  assert.equal(result.description,'A short summary')
  assert.equal(result.plain,true)
  assert.deepEqual(result.requests,[['https://newspaper.com/unavailable','omit'],['https://newspaper.com/world','omit']])
  base.hash='dm='+nip19.npubEncode(peer.pubkey)+'&name=Fixture'
  await cdp('Page.navigate',{url:base.href})
  await wait(()=>document.querySelector('#msg-previewdm .ag-link-card-load')?.textContent?.includes('Load link preview'))
  await sleep(500)
  assert.equal(await run(()=>window.previewRequests.some(req=>req.url.endsWith('/private-story'))),false)
  await run(()=>document.querySelector('#msg-previewdm .ag-link-card-load').click())
  await wait(()=>document.querySelector('#msg-previewdm .ag-link-card-title')?.textContent==='A trusted article')
  assert.equal(await run(()=>window.previewRequests.filter(req=>req.url.endsWith('/private-story')).length),1)
  console.log('Browser link cards: trusted only, normalized metadata, no hidden-link fetch, normal fallback and responsive width.',mobile?'mobile':'desktop')
} finally {
  ws?.close()
  chrome.kill()
  await sleep(300)
  rmSync(tmp,{recursive:true,force:true})
}
