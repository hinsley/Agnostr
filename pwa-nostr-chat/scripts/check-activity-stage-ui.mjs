// Run against a local Vite dev server, optionally with --mobile. CHROME can override the executable.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { once } from 'node:events'
const chrome=process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const dir=fs.mkdtempSync(path.join(os.tmpdir(), 'agnostr-stage-browser-'))
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
  if (process.argv.includes('--mobile')) await call('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
  for(const [kind, room] of [['chess','dm'],['go','dm'],['poker','geo'],['poker','server']]){
    const url = new URL('scripts/fixtures/activity-stage.html', origin)
    url.searchParams.set('kind',kind)
    url.searchParams.set('room',room)
    await call('Page.navigate',{url:url.href})
    await new Promise(r=>setTimeout(r,300))
    const probe = async kind => {
      const q = s => document.querySelector(s)
      const wait = async f => {
        for(let i=0;i<150;i++){const v=f();if(v)return v;await new Promise(r=>setTimeout(r,100))}
        throw Error('missing '+f+' '+document.body.innerText.slice(-1200))
      }
      const assert=(x,msg)=>{if(!x)throw Error(msg)}
      const btn=(s,root=document)=>root.querySelector('button[aria-label="'+s+'"]')
      const click=async f => (await wait(f)).click()
      const name=kind==='poker'?"Texas Hold'em":kind==='go'?'Go':'Chess'
      const pills=()=>[...document.querySelectorAll('.ag-game-mini-main')]
      const gamePill=()=>pills().find(p=>p.title.includes(name)&&!p.title.includes('@Other'))
      const board = () => q('.ag-game-stage-panel')
      const compactBoard = () => q('.ag-game-stage-panel.is-compact')
      const rail = () => q('.ag-game-compact-video-rail')
      const hit = async f => {
        const el=await wait(f)
        el.scrollIntoView({block:'nearest'})
        const r=el.getBoundingClientRect()
        assert(el.contains(document.elementFromPoint(r.left+r.width/2,r.top+r.height/2)),
          'Cannot physically reach '+(el.getAttribute('aria-label') || el.textContent))
        el.dispatchEvent(new MouseEvent('click',{bubbles:true}))
      }
      const playable = async () => {
        const before=q('#sent').textContent
        if(kind==='chess'){
          await hit(()=>q('[data-square="e2"]'));await hit(()=>q('[data-square="e4"]'))
        }else if(kind==='go'){
          await hit(()=>q('rect[role="gridcell"]'))
        }else{
          await hit(()=>[...board().querySelectorAll('button')].find(b=>b.textContent.includes('Sit In')))
        }
        await wait(()=>q('#sent').textContent!==before)
      }
      const expectComposer=()=>{
        const b=board().getBoundingClientRect(), c=q('#fixture-composer').getBoundingClientRect()
        assert(b.width>170 && b.height>120,'Unreadable board: '+JSON.stringify(b.toJSON()))
        assert(b.bottom<=c.top || b.right<=c.left,'Board hides composer')
        assert(document.elementFromPoint(c.left+5,c.top+5)===q('#fixture-composer'),'Composer is not usable')
        assert(document.documentElement.scrollWidth<=innerWidth+1,'Viewport overflow')
      }
      await wait(()=>pills().length===2 && q('.ag-activity-dock .ag-call-mini-pip'))
      const dock=q('.ag-activity-dock')
      assert(dock.contains(pills().find(p=>p.title.includes('Other'))),'Missing other game')
      const sink=await wait(()=>q('audio'))
      const src=await wait(()=>sink.srcObject)
      await click(gamePill)
      await wait(()=>q('.ag-game-chat-slot .ag-game-in-chat') && !compactBoard())
      expectComposer()
      const originalBoard=board()
      const composer=q('#fixture-composer')
      composer.focus(); composer.value='Draft still visible'
      await click(()=>btn('Minimize game'))
      await wait(()=>compactBoard() && rail()?.querySelector('video')?.srcObject)
      assert(board()===originalBoard,'Minimizing remounted the board')
      await wait(()=>board().querySelector('.ag-game-compact-call-controls .ag-call-mini-pill'))
      assert(!q('.ag-call-mini-pip') && document.querySelectorAll('video').length===1,'Compact stage duplicated video')
      expectComposer()
      await playable()
      assert(composer.value==='Draft still visible','Playing cleared chat draft')
      await click(()=>btn('Expand @bob video'))
      await wait(()=>!board() && (q('.ag-call-stage-pinned video')?.srcObject || q('.ag-dm-call-view video')?.srcObject))
      assert(q('audio')===sink && sink.srcObject===src,'Maximizing video interrupted audio')
      await click(()=>btn('Minimize call stage') || btn('Minimize call'))
      await wait(()=>compactBoard() && rail()?.querySelector('video')?.srcObject)
      assert(q('audio')===sink && sink.srcObject===src,'Returning to the compact board interrupted audio')
      await click(()=>btn('Hide game'));await wait(()=>!board() && pills().length===2 && q('.ag-call-mini-pip'))
      await click(()=>btn('Pin '+(kind==='poker'?'Poker':name)+' to compact stage'))
      await wait(()=>compactBoard() && rail()?.querySelector('video')?.srcObject)
      await click(()=>btn('Hide game'))
      await click(()=>pills().find(p=>p.title.includes('Other')))
      await wait(()=>board() && q('.ag-call-mini-pip'))
      await click(()=>btn('Minimize game'))
      await wait(compactBoard)
      assert(!rail(),'Unrelated game inherited the call video rail')
      await click(()=>btn('Hide game'))
      q('#stop-test-call').click()
      await wait(()=>!q('audio') && !q('.ag-call-mini-pip') && pills().length===2)
      await click(gamePill);await wait(board)
      await click(()=>btn('Minimize game'));await wait(compactBoard)
      expectComposer()
      await playable()
      assert(!rail() && !q('audio'),'Minimizing a standalone game attached media')
      q('#toggle-test-chat').click();await wait(()=>q('.ag-activity-dock .ag-game-floating.is-compact'))
      await click(()=>btn('Expand game'));await wait(()=>q('.ag-game-chat-slot .ag-game-in-chat:not(.is-compact)'))
      await click(()=>btn('Hide game'));await wait(()=>!board() && pills().length===2)
      return kind+' OK'
    }
    const result=await call('Runtime.evaluate',{expression:'('+probe+')('+JSON.stringify(kind)+')',awaitPromise:true,returnByValue:true})
    if(result.result.exceptionDetails)throw Error(result.result.exceptionDetails.exception?.description || JSON.stringify(result.result.exceptionDetails))
    console.log(room, result.result.result.value)
  }
  // Full App entry point: wholly local mock relay and synthetic signed room Poker events.
  const mockRelay = () => {
    const requests = []
    window.fixtureEvents = []
    window.fixtureMediaRequests = 0
    window.RTCPeerConnection = function () { ++window.fixtureMediaRequests; throw Error('Unexpected call') }
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
      value: () => { ++window.fixtureMediaRequests; throw Error('Unexpected media permission') },
    })
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
          if(id.kind===25055) window.fixtureEvents.push(JSON.parse(id.content))
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
          if(filters.some(f=>f.kinds?.includes(event.kind) && f['#t']?.includes(event.tags[0][1]))) {
            ws.deliver(['EVENT',id,event])
          }
        }
      }
    }
  }
  await call('Fetch.enable',{patterns:[{urlPattern:'*'}]})
  await call('Page.addScriptToEvaluateOnNewDocument',{source:'('+mockRelay+')()'})
  await call('Page.navigate',{url:new URL('/#topic=stage-fixture',origin).href})
  const appProbe = async () => {
    const q = s => document.querySelector(s)
    const wait = async f => {
      for(let i=0;i<150;i++){const v=f();if(v)return v;await new Promise(r=>setTimeout(r,100))}
      throw Error('missing '+f+' '+document.body.innerText.slice(-1600))
    }
    const assert=(v,message)=>{ if(!v) throw Error(message) }
    const click=async f => (await wait(f)).click()
    await wait(()=>q('.ag-header-game-btn'))
    const {roomEvents} = await import('/scripts/fixtures/activity-smoke-events.js')
    const events=roomEvents('topic:stage-fixture')
    await wait(()=> {
      window.fixtureReplay(events)
      return q('button[aria-label="View poker table"]')
    })
    await click(()=>[...document.querySelectorAll('.ag-game-banner button')].find(b=>b.textContent.trim()==='View table'))
    const board=await wait(()=>q('.ag-game-chat-slot .ag-game-in-chat'))
    await wait(()=>board.textContent.includes('Synthetic host'))
    assert(board.textContent.includes('Watching'),'Viewing took a seat')
    await click(()=>q('.ag-game-in-chat button[aria-label="Minimize game"]'))
    await wait(()=>board.matches('.is-compact'))
    assert(window.fixtureEvents.length===0 && window.fixtureMediaRequests===0,'Viewing or minimizing sent a signal or joined a call')
    const composer=await wait(()=>q('.ag-composer-input'))
    const c=composer.getBoundingClientRect(), b=board.getBoundingClientRect()
    assert(c.height>20 && (b.bottom<=c.top || b.right<=c.left),'Board overlaps the real composer')
    composer.focus()
    assert(document.activeElement===composer,'Real chat composer is not focusable')
    return true
  }
  const actual=await call('Runtime.evaluate',{expression:'('+appProbe+')()',awaitPromise:true,returnByValue:true})
  if(actual.result.exceptionDetails)throw Error(actual.result.exceptionDetails.exception?.description || JSON.stringify(actual.result.exceptionDetails))
  await call('Input.insertText',{text:'A draft while I watch'})
  const seated=await call('Runtime.evaluate',{expression:`(async()=>{
    const composer=document.querySelector('.ag-composer-input')
    if(!composer.value.includes('A draft while I watch'))throw Error('Could not type into chat while viewing')
    const seat=[...document.querySelectorAll('.ag-game-in-chat.is-compact button')].find(b=>b.textContent.includes('Sit In'))
    if(!seat)throw Error('Missing explicit seat button')
    seat.click()
    for(let i=0;i<100;i++){if(window.fixtureEvents.some(e=>e.type==='poker-join'))break;await new Promise(r=>setTimeout(r,50))}
    if(!window.fixtureEvents.some(e=>e.type==='poker-join')||window.fixtureMediaRequests!==0)throw Error('Taking a seat did not signal only poker')
    if(!composer.value.includes('A draft while I watch'))throw Error('Taking a seat cleared the chat draft')
    return true
  })()`,awaitPromise:true,returnByValue:true})
  if(seated.result.exceptionDetails)throw Error(seated.result.exceptionDetails.exception?.description || JSON.stringify(seated.result.exceptionDetails))
  console.log('Bitchat: minimize the playable table, type in the real composer, and explicitly sit in without a call')
} finally {
  proc.kill(); await exited
  fs.rmSync(dir,{recursive:true,force:true,maxRetries:3})
}
