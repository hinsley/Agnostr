// Run against a local production preview: node scripts/check-message-action-spacing-ui.mjs http://127.0.0.1:4173/
// Disposable browser profile and local mock relay only.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateSecretKey, getPublicKey } from 'nostr-tools'

const base = new URL(process.argv.find(arg => /^https?:/.test(arg)) || 'http://127.0.0.1:4173/')
assert.equal(base.hostname, '127.0.0.1')
const tmp = mkdtempSync(join(tmpdir(),'agnostr-message-actions-test-'))
const port = Number(process.env.CDP_PORT || 9511)
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

    Object.defineProperty(navigator.clipboard, 'writeText', { value: text => {
      window.copiedText = text
      return Promise.resolve()
    } })
    const geohash = '9q'
    if (sessionStorage.getItem('seeded')) return
    sessionStorage.setItem('seeded', '1')
    localStorage.setItem('agnostr:v2:device_seed', localSecret)
    localStorage.setItem('agnostr:v2:active_geohash', geohash)
    localStorage.setItem('agnostr:v2:msgs:'+geohash, JSON.stringify([
      'Short hello.',
      'Two lines\nA longer line with a #moon:u4pr link.',
      'Long message: '+('this text needs to wrap without hiding under the toolbar. '.repeat(12)),
    ].map((content,i)=>({
      id:String(i+1).repeat(64), geohash, pubkey:pk, nickname:'Fixture', displayHandle:'Fixture',
      content, createdAt:Math.floor(Date.now()/1000)-60+i, tags:[], isOwn:false, isTeleported:false,
      isMeshBridge:false, powBits:0, reactions:[], mentions:[],
    }))))
  }
  await cdp('Page.enable')
  await cdp('Page.addScriptToEvaluateOnNewDocument',{source:'('+setUp+')('+JSON.stringify({
    pk:peer.pubkey,localSecret:Buffer.from(generateSecretKey()).toString('hex'),
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
  const measure = prefix => {
    const row = [...document.querySelectorAll('.ag-msg-row')].find(n=>n.querySelector('.ag-msg-rich')?.textContent.startsWith(prefix))
    const toolbar = row.querySelector('.ag-msg-actions')
    const body = row.querySelector('.ag-msg-content')
    const text = row.querySelector('.ag-msg-rich')
    const range = document.createRange()
    range.selectNodeContents(text)
    return {
      row:row.getBoundingClientRect().toJSON(),
      text:text.getBoundingClientRect().toJSON(),
      content:body.getBoundingClientRect().toJSON(),
      glyphs:range.getBoundingClientRect().toJSON(),
      toolbar:toolbar.getBoundingClientRect().toJSON(),
      opacity:getComputedStyle(toolbar).opacity,
    }
  }
  const reveal = async prefix => {
    const m = await run(measure,prefix)
    if (mobile && m.opacity!=='1') {
      await run(prefix=>[...document.querySelectorAll('.ag-msg-row .ag-msg-rich')]
        .find(n=>n.textContent.startsWith(prefix)).click(),prefix)
    } else if(!mobile) {
      await cdp('Input.dispatchMouseEvent',{type:'mouseMoved',x:m.text.left+5,y:m.text.top+5})
    }
    await sleep(180)
    const shown=await run(measure,prefix)
    assert.equal(shown.opacity,'1')
    return shown
  }
  if(!mobile) {
    for(const message of ['Short hello.','Two lines','Long message:']){
      const before=await run(measure,message)
      const after=await reveal(message)
      const gap = after.toolbar.left - after.content.right
      assert.ok(gap >= 0 && gap < 16, 'Toolbar overlaps the message or is too far away: '+gap)
      assert.ok(after.toolbar.right < after.row.right,'Toolbar overflows the chat row')
      assert.equal(after.glyphs.right,before.glyphs.right,'Hover rewraps the message')
      assert.equal(after.row.height,before.row.height,'Hover changes row height')
      if (message==='Short hello.') assert.ok(after.toolbar.left-after.glyphs.right<68,'Short message still has a large visual gap')
    }
  }
  await reveal('Short hello.')
  await run(()=>[...document.querySelectorAll('.ag-msg-actions')]
    .find(n=>getComputedStyle(n).opacity==='1').querySelector('[aria-label="Add reaction"]').click())
  const quick=await wait(()=>{
    const p=document.querySelector('.ag-emoji-popover')
    if(!p)return null
    const b=p.getBoundingClientRect(),s=p.closest('.ag-stream-scroll').getBoundingClientRect()
    return {left:b.left,right:b.right,streamLeft:s.left,streamRight:s.right}
  })
  assert.ok(quick.left>=quick.streamLeft && quick.right<=quick.streamRight,'Reaction picker is clipped horizontally')
  await cdp('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape'})
  await wait(()=>!document.querySelector('.ag-emoji-popover'))
  await reveal('Short hello.')
  const clickAction=label=>run(label=>[...document.querySelectorAll('.ag-msg-actions')]
    .find(n=>getComputedStyle(n).opacity==='1').querySelector('[aria-label="'+label+'"]').click(),label)
  await clickAction('Copy message')
  await wait(()=>window.copiedText==='Short hello.')
  await reveal('Short hello.')
  await clickAction('Reply to message')
  await wait(()=>Boolean(document.querySelector('[aria-label="Cancel reply"]')))
  console.log(mobile?'Mobile tap, reactions, copy and reply passed.':'Desktop actions stay next to short and long messages without overlap or reflow; reactions, copy and reply passed.')
} finally {
  ws?.close()
  chrome.kill()
  if(chrome.exitCode===null)await new Promise(r=>chrome.once('exit',r))
  rmSync(tmp,{recursive:true,force:true,maxRetries:3})
}
