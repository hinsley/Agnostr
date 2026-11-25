// Run against a local Vite dev server: node scripts/check-bitchat-drawer-ui.mjs http://127.0.0.1:5173/
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { once } from 'node:events'
const chrome=process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const dir=fs.mkdtempSync(path.join(os.tmpdir(), 'agnostr-drawer-browser-'))
const origin = new URL(process.argv.find(arg => /^https?:/.test(arg)) || 'http://127.0.0.1:5173/')
if (!['localhost','127.0.0.1','[::1]'].includes(origin.hostname)) throw Error('Use a local Vite dev server')
const proc=spawn(chrome,['--headless','--no-first-run','--no-default-browser-check','--disable-gpu','--window-size=1280,950','--remote-debugging-port=0','--user-data-dir='+dir,'about:blank'],{stdio:'ignore'})
const exited=once(proc,'exit')
try {
  let target;
  for (let i=0;i<80;i++){try{const port=fs.readFileSync(path.join(dir,'DevToolsActivePort'),'utf8').split('\n')[0];target=(await (await fetch('http://127.0.0.1:'+port+'/json/list')).json()).find(x=>x.type==='page');if(target)break}catch{};await new Promise(r=>setTimeout(r,100))}
  if(!target)throw Error('Chrome failed to start')
  const socket=new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((r,j)=>{socket.onopen=r;socket.onerror=j})
  process.on('exit',()=>socket.close())
  let seq=0;const pending=new Map()
  socket.onmessage=e=>{const d=JSON.parse(e.data);if(d.id){const p=pending.get(d.id);p?.(d);pending.delete(d.id)}else if(d.method==='Fetch.requestPaused'){ const p=d.params; const local=new URL(p.request.url).origin===origin.origin; void call(local?'Fetch.continueRequest':'Fetch.failRequest', {requestId:p.requestId,...(local?{}:{errorReason:'BlockedByClient'})}); }else if(d.method==='Log.entryAdded'||d.method==='Runtime.exceptionThrown') console.log(JSON.stringify(d).slice(0,1200))}
  function call(method,params={}){return new Promise(r=>{pending.set(++seq,r);socket.send(JSON.stringify({id:seq,method,params}))})}
  await call('Runtime.enable');await call('Page.enable');
  const mockRelay = () => {
    const requests = []
    localStorage.setItem('agnostr:v2:pinned_channels', JSON.stringify(['pinned-quiet', 'pinned-active']
      .map(slug => ({ geohash: 'topic:'+slug, pinnedAt: 1 }))))
    window.WebSocket = class LocalRelay extends EventTarget {
      static CONNECTING = 0
      static OPEN = 1
      static CLOSING = 2
      static CLOSED = 3
      readyState = 0
      constructor(url) {
        super()
        this.url = url
        queueMicrotask(() => { this.readyState=1;this.dispatchEvent(new Event('open')) })
      }
      send(message) {
        const [type,id,...filters] = JSON.parse(message)
        if(type==='REQ') {
          requests.push({ ws: this, id, filters })
          this.deliver(['EOSE',id])
        }
        if(type==='EVENT') {
          this.deliver(['OK',id.id,true,''])
        }
      }
      deliver(value) {
        setTimeout(() => this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify(value)})), 0)
      }
      close() { this.readyState=3;this.dispatchEvent(new CloseEvent('close')) }
    }
    window.fixtureReplay = events => {
      for (const {ws,id,filters} of requests) {
        for (const event of events) {
          if(filters.some(f=>f.kinds?.includes(event.kind) && (!f['#t'] || event.tags.some(([type,tag])=>type==='t' && f['#t'].includes(tag))))) {
            ws.deliver(['EVENT',id,event])
          }
        }
      }
    }
  }

  await call('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
  await call('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:1})
  await call('Fetch.enable',{patterns:[{urlPattern:'*'}]})
  await call('Page.addScriptToEvaluateOnNewDocument',{source:'('+mockRelay+')()'})
  await call('Page.navigate',{url:new URL('/#topic=drawer-current',origin).href})
  const exercise = async () => {
    const q = s => document.querySelector(s)
    const wait = async f => {
      for(let i=0;i<160;i++){const v=f();if(v)return v;await new Promise(r=>setTimeout(r,100))}
      throw Error('missing '+f+' '+document.body.innerText.slice(-2000))
    }
    const assert = (v,m) => { if(!v)throw Error(m) }
    const btn = (label) => q('button[aria-label="'+label+'"]')
    const press = async f => (await wait(f)).click()
    const drawer = () => q('.ag-conv-col.open #ag-bitchat-channels')
    const opening = () => btn('Switch Bitchat channel')
    const row = key => q('[data-channel-key="'+key+'"]')
    const rowsIn = label => Array.from(drawer().querySelectorAll('[aria-label="'+label+'"] [data-channel-key]')).map(b=>b.dataset.channelKey)
    const same = (actual,expected) => JSON.stringify(actual) === JSON.stringify(expected)
    await press(opening)
    await wait(drawer)
    const {fixtureDrawerEvents} = await import('/scripts/fixtures/bitchat-drawer-events.js')
    const events = fixtureDrawerEvents()
    await wait(() => {
      window.fixtureReplay(events)
      return row('topic:live-room')
    })
    assert(same(rowsIn('Pinned channels'),['topic:pinned-quiet','topic:pinned-active']),'Wrong pin order')
    assert(same(rowsIn('Active channels'),['topic:live-room']),'Pinned activity duplicated in active list')
    assert(drawer().querySelector('section').getAttribute('aria-label')==='Pinned channels','Pins are not on top')
    assert(row('topic:drawer-current').getAttribute('aria-current')==='page','Quiet current channel is missing')
    assert(!/Precision Scale|Protocol|Coordinates|Channel Overview/.test(drawer().textContent),'Decorative info kept in switcher')
    await press(()=>row('topic:pinned-quiet'))
    await wait(()=>!drawer() && opening()?.textContent.includes('#pinned-quiet'))
    await press(opening);await wait(drawer)
    assert(row('topic:pinned-quiet').getAttribute('aria-current')==='page','Quiet pin was not selected')
    await press(()=>btn('Unpin current channel'))
    await wait(()=>!rowsIn('Pinned channels').includes('topic:pinned-quiet'))
    assert(row('topic:pinned-quiet').getAttribute('aria-current')==='page','Unpin removed the selected room')
    await press(()=>btn('Pin current channel'))
    await wait(()=>rowsIn('Pinned channels').includes('topic:pinned-quiet'))
    await press(()=>row('topic:live-room'))
    await wait(()=>!drawer() && opening()?.textContent.includes('#live-room'))
    await press(opening); await wait(drawer)
    assert(row('topic:live-room').getAttribute('aria-current')==='page','Live channel was not selected')
    await press(()=>btn('Close Bitchat channels')); await wait(()=>!drawer())
    await press(opening); await wait(drawer)
    await press(()=>q('.ag-drawer-scrim.active'));await wait(()=>!drawer())
    await press(()=>q('[data-mtab-id="dms"]'));await wait(()=>!drawer() && !opening())
    await press(()=>q('[data-mtab-id="bitchat"]')); await wait(()=>opening()?.textContent.includes('#live-room'))
    await press(opening); await wait(drawer)
    assert(rowsIn('Pinned channels').includes('topic:pinned-quiet'),'Pin lost when switching tabs')
    await press(()=>btn('Current channel details'))
    await wait(()=>!drawer() && q('.ag-sheet-backdrop[data-open="true"] .ag-info-sheet'))
    return 'Mobile switcher: pinned/live order, dedup, quiet pin, live switching, pin/unpin, close, scrim, tabs and details'
  }
  const result=await call('Runtime.evaluate',{expression:'('+exercise+')()',awaitPromise:true,returnByValue:true})
  if(result.result.exceptionDetails)throw Error(result.result.exceptionDetails.exception?.description || JSON.stringify(result.result.exceptionDetails))
  console.log(result.result.result.value)
  const assertion = async (expression) => {
    const r = await call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true})
    if (r.result.result.value !== true) throw Error(r.result.exceptionDetails?.exception?.description || 'Failed browser assertion: '+expression)
  }
  await assertion(`(async()=>{
    const details=document.querySelector('.ag-sheet-backdrop[data-open="true"]')
    details.querySelector('.ag-sheet-back-btn').click()
    for(let i=0;i<40;i++){if(!document.querySelector('.ag-sheet-backdrop[data-open="true"]'))return true;await new Promise(r=>setTimeout(r,50))}
    return false
  })()`)
  const touch = (type,x) => call('Input.dispatchTouchEvent',
    {type,touchPoints: x === undefined ? [] : [{x,y:185,id:1}]})
  await touch('touchStart',12)
  for (const x of [32,70,138,223]) {
    await touch('touchMove',x)
    await new Promise(r=>setTimeout(r,30))
  }
  await touch('touchEnd')
  await assertion(`(async()=>{
    await new Promise(r=>setTimeout(r,350))
    return !!document.querySelector('.ag-conv-col.open #ag-bitchat-channels')
  })()`)
  console.log('Mobile edge swipe still opens the channel tray')
  await call('Emulation.setTouchEmulationEnabled',{enabled:false})
  await call('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false})
  await assertion(`(async()=>{
    await new Promise(r=>setTimeout(r,350))
    const header=document.querySelector('[aria-label="Switch Bitchat channel"]')
    if (header.getAttribute('aria-haspopup') !== 'dialog') return false
    header.click()
    await new Promise(r=>setTimeout(r,200))
    return !!document.querySelector('.ag-room-switcher-popover') && !document.querySelector('#ag-bitchat-channels')
  })()`)
  console.log('Desktop still uses its channel popover')
} finally {
  proc.kill(); await exited
  fs.rmSync(dir,{recursive:true,force:true,maxRetries:3})
}
