// Run against a local production preview: node scripts/check-bitchat-channel-links-ui.mjs http://127.0.0.1:4173/
// Disposable browser profile and local mock relay only.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateSecretKey, getPublicKey } from 'nostr-tools'

const base = new URL(process.argv.find(arg => /^https?:/.test(arg)) || 'http://127.0.0.1:4173/')
assert.equal(base.hostname, '127.0.0.1')
const tmp = mkdtempSync(join(tmpdir(),'agnostr-channel-links-test-'))
const port = Number(process.env.CDP_PORT || 9501)
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
  const setUp = ({ pk, localSecret }) => {
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

    const geohash = '9q'
    const content = [
      'Planets: #Mars:S000, (#moon:u4pr), #europa:9q8y.',
      'Other links: #9q8y, #topic:bitcoin, #general: hello.',
      'Invalid: #mars:invalid #sun:s000 #earth:9q8y #mars:s000:moon #mars:9q8y12345678901.',
      'Formats: [Moon via markdown](#moon%3Au4pr) and [#mars:s000](#mars:s000).',
      'Full URL: '+location.origin+'/#mars:s000.',
      'Code: `#mars:s000`.',
    ].join('\n')
    if (sessionStorage.getItem('seeded')) return
    sessionStorage.setItem('seeded', '1')
    localStorage.setItem('agnostr:v2:device_seed', localSecret)
    localStorage.setItem('agnostr:v2:active_geohash', geohash)
    localStorage.setItem('agnostr:v2:msgs:'+geohash, JSON.stringify([{
      id:'a'.repeat(64), geohash, pubkey:pk, nickname:'Fixture', displayHandle:'Fixture',
      content, createdAt:Math.floor(Date.now()/1000)-60, tags:[], isOwn:false, isTeleported:false,
      isMeshBridge:false, powBits:0, reactions:[], mentions:[],
    }, ...[
      ['b', '* Fixture waves **enthusiastically** *'],
      ['c', '* ordinary first bullet\n* ordinary second bullet'],
      ['d', '* Fixture waves\n* and keeps waving *'],
    ].map(([id, content], index) => ({
      id:id.repeat(64), geohash, pubkey:pk, nickname:'Fixture', displayHandle:'Fixture',
      content, createdAt:Math.floor(Date.now()/1000)-50+index, tags:[], isOwn:false, isTeleported:false,
      isMeshBridge:false, powBits:0, reactions:[], mentions:[],
    }))]))
  }
  await cdp('Page.enable')
  await cdp('Network.enable')
  await cdp('Page.addScriptToEvaluateOnNewDocument',{source:'('+setUp+')('+JSON.stringify({
    pk:peer.pubkey, localSecret:Buffer.from(generateSecretKey()).toString('hex'),
  })+')'})
  if(process.argv.includes('--mobile')){
    await cdp('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true})
    await cdp('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:1})
  }
  base.hash='9q'

  const openSource = async () => {
    await cdp('Page.navigate',{url:base.href})
    if(await wait(()=>!!document.querySelector('.ag-geo-chip') || [...document.querySelectorAll('button')]
      .some(b=>b.textContent.trim()==='Open Chat')) && !await run(()=>!!document.querySelector('.ag-geo-chip'))){
      await run(()=>[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Open Chat').click())
    }
    await wait(()=>!!document.querySelector('.ag-msg-row .ag-geo-chip'))
  }
  await openSource()
  await wait(() => !!document.querySelector('#msg-' + 'd'.repeat(64)))
  const formatting = await run(() => {
    const body = id => document.querySelector('#msg-' + id.repeat(64) + ' .ag-msg-rich')
    return {
      actionText: body('b').querySelector('.ag-chat-action')?.textContent,
      boldText: body('b').querySelector('strong')?.textContent,
      actionBullets: body('b').querySelectorAll('li').length,
      list: [...body('c').querySelectorAll('li')].map(x => x.textContent),
      multilineAction: body('d').querySelector('.ag-chat-action')?.textContent,
      multilineBullets: body('d').querySelectorAll('li').length,
    }
  })
  assert.equal(formatting.actionText, '* Fixture waves enthusiastically *')
  assert.equal(formatting.boldText, 'enthusiastically')
  assert.equal(formatting.actionBullets, 0)
  assert.deepEqual(formatting.list, ['ordinary first bullet', 'ordinary second bullet'])
  assert.equal(formatting.multilineAction, '* Fixture waves\n* and keeps waving *')
  assert.equal(formatting.multilineBullets, 0)
  const rendered=await run(()=>({
    chips:[...document.querySelectorAll('.ag-msg-row .ag-geo-chip')].map(b=>b.textContent.trim()),
    links:[...document.querySelectorAll('.ag-msg-row .ag-md-link')].map(a=>[a.textContent.trim(),a.getAttribute('href')]),
    nested:!!document.querySelector('.ag-msg-row a button'),
    inlineCode:document.querySelector('.ag-msg-row .ag-inline-code')?.textContent,
  }))
  assert.deepEqual(rendered.chips,['#mars:s000','#moon:u4pr','#europa:9q8y','#9q8y','#bitcoin','#general'])
  assert.deepEqual(rendered.links.slice(0,2),[['Moon via markdown','#moon:u4pr'],['#mars:s000','#mars:s000']])
  assert.equal(rendered.links[2][1],'#mars:s000')
  assert.equal(rendered.nested,false)
  assert.equal(rendered.inlineCode,'#mars:s000')

  for(const [selector,text,key] of [
    ['.ag-geo-chip','#mars:s000','mars:s000'],
    ['.ag-geo-chip','#moon:u4pr','moon:u4pr'],
    ['.ag-geo-chip','#europa:9q8y','europa:9q8y'],
    ['.ag-md-link','Moon via markdown','moon:u4pr'],
    ['.ag-md-link[title^="http"]',null,'mars:s000'],
    ['.ag-geo-chip','#9q8y','9q8y'],
    ['.ag-geo-chip','#bitcoin','topic:bitcoin'],
  ]){
    assert.equal(await run(({selector,text})=>{
      const found=[...document.querySelectorAll('.ag-msg-row '+selector)].find(el=>text===null || el.textContent.trim()===text)
      if(!found)return false
      if(window.subscriptions)window.subscriptions.length=0
      found.click()
      return true
    },{selector,text}),true)
    await wait(key=>{
      if(key.startsWith('topic:')){
        const slug=key.slice(6)
        return location.hash==='#topic='+slug &&
          window.subscriptions.some(f=>f.kinds?.includes(23333)&&f['#d']?.includes(slug))
      }
      return location.hash==='#'+key &&
        window.subscriptions.some(f=>f.kinds?.includes(20000)&&f['#g']?.includes(key))
    },key)
    await openSource()
  }
  console.log('Planet/moon mentions and markdown links reach the exact Bitchat subscriptions; invalid tags stay plain.')
} finally {
  ws?.close()
  chrome.kill()
  if(chrome.exitCode===null)await new Promise(r=>chrome.once('exit',r))
  rmSync(tmp,{recursive:true,force:true,maxRetries:3})
}
