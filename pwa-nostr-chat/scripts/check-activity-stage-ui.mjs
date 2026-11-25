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
      const expectLayout=()=>{
        const board=q('.ag-game-stage-body').getBoundingClientRect()
        const rail=q('.ag-call-game-filmstrip').getBoundingClientRect()
        assert(board.width>170 && board.height>120,'Unreadable board: '+board.toJSON())
        assert(rail.width>50 && rail.height>35 && rail.bottom<=innerHeight+1 && rail.right<=innerWidth+1,'Offscreen feeds')
        assert(board.bottom<=rail.top+1 || board.right<=rail.left+1,'Feeds overlap board')
        assert(document.documentElement.scrollWidth<=innerWidth+1,'Viewport overflow')
      }
      await wait(()=>pills().length===2 && q('.ag-activity-dock .ag-call-mini-pip'))
      const dock=q('.ag-activity-dock'), pip=q('.ag-call-mini-pip')
      const other=pills().find(p=>p.title.includes('Other'))
      assert(other&&dock.contains(other),'Missing other game')
      const a=pip.getBoundingClientRect(), b=gamePill().getBoundingClientRect()
      assert(a.bottom<=b.top+1 || b.bottom<=a.top+1,'Overlapping dock activities')
      const sink=await wait(()=>q('audio'))
      const src=await wait(()=>sink.srcObject)
      await click(gamePill)
      await wait(()=>q('.ag-game-chat-slot .ag-game-in-chat') && q('.ag-call-mini-pip'))
      const boardRect=q('.ag-game-in-chat').getBoundingClientRect()
      const composer=q('#fixture-composer')
      const composerRect=composer.getBoundingClientRect()
      assert(boardRect.height>140 && (boardRect.bottom<=composerRect.top || boardRect.right<=composerRect.left),'Board hides composer')
      assert(document.elementFromPoint(composerRect.left+5,composerRect.top+5)===composer,'Composer is not usable')
      composer.focus(); composer.value='Draft still visible'
      assert(document.activeElement===composer,'Could not focus composer')
      assert(!q('.ag-game-modal-backdrop'),'Interactive game opened in a detached overlay')
      assert(q('audio')===sink && sink.srcObject===src,'Inline game remounted call audio')
      if(kind==='chess'){
        await click(()=>q('[data-square="e2"]'));await click(()=>q('[data-square="e4"]'))
      }else if(kind==='go'){
        const stone=await wait(()=>q('rect[role="gridcell"]'))
        stone.dispatchEvent(new MouseEvent('click',{bubbles:true}))
      }else{await click(()=>[...document.querySelectorAll('button')].find(b=>/take a seat|join seat|sit in|sit down|join table/i.test(b.title+' '+b.textContent)))}
      await wait(()=>q('#sent').textContent.length>0)
      assert(composer.value==='Draft still visible','Playing cleared chat draft')
      await click(()=>q('.ag-call-mini-pip button[title*="xpand"]') || q('.ag-call-mini-pip-stage'))
      await click(()=>btn('Pin '+(kind==='poker'?'Poker':name)+' to stage'))
      await wait(()=>q('.ag-game-embedded') && q('.ag-call-game-filmstrip video')?.srcObject)
      expectLayout()
      await click(()=>[...document.querySelectorAll('.ag-game-embedded button')].find(b=>b.textContent==='Play in chat'))
      await wait(()=>q('.ag-game-chat-slot .ag-game-in-chat') && q('.ag-call-mini-pip'))
      await click(()=>q('.ag-call-mini-pip button[title*="xpand"]') || q('.ag-call-mini-pip-stage'))
      await click(()=>btn('Pin '+(kind==='poker'?'Poker':name)+' to stage'))
      await wait(()=>q('.ag-game-embedded'))
      await click(()=>btn('Pin @bob video to stage'))
      await wait(()=>q('.ag-call-stage-pinned video')?.srcObject)
      assert(!q('.ag-game-embedded') && q('audio')===sink && sink.srcObject===src,'Video switch dropped audio or retained board')
      await click(()=>btn('Pin '+(kind==='poker'?'Poker':name)+' to stage'))
      await wait(()=>q('.ag-game-embedded'))
      await click(()=>btn('Minimize call stage'))
      await wait(()=>pills().length===2 && q('.ag-activity-dock .ag-call-mini-pip'))
      await click(()=>q('.ag-call-mini-pip button[title*="xpand"]') || q('.ag-call-mini-pip-stage'))
      await wait(()=>q('.ag-game-embedded'))
      await click(()=>btn('Unpin game'))
      await wait(()=>!q('.ag-game-embedded') && q('.ag-call-grid video') && q('.ag-call-grid .is-stage-tile canvas'))
      await wait(()=>q('.is-stage-tile canvas')?.getContext('2d').getImageData(12,12,1,1).data[3]>0)
      await click(()=>btn('Minimize call stage'))
      await wait(()=>pills().length===2 && q('.ag-activity-dock .ag-call-mini-pip'))
      await click(()=>pills().find(p=>p.title.includes('Other')))
      await wait(()=>q('.ag-game-in-chat') && q('.ag-call-mini-pip'))
      assert(!q('.ag-game-embedded'),'Unrelated board appeared in call')
      await click(()=>btn('Minimize game'));await wait(()=>pills().length===2)
      q('#stop-test-call').click()
      await wait(()=>!q('audio') && !q('.ag-call-mini-pip') && pills().length===2)
      await click(gamePill);await wait(()=>q('.ag-game-in-chat'))
      q('#toggle-test-chat').click();await wait(()=>!q('.ag-game-in-chat') && pills().length===2)
      await click(gamePill);await wait(()=>q('.ag-game-in-chat') && !q('audio'))
      await click(()=>btn('Minimize game'));await wait(()=>pills().length===2)
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
    assert(window.fixtureEvents.length===0 && window.fixtureMediaRequests===0,'Viewing sent a signal or joined a call')
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
    const seat=[...document.querySelectorAll('.ag-game-in-chat button')].find(b=>b.textContent.includes('Sit In'))
    if(!seat)throw Error('Missing explicit seat button')
    seat.click()
    for(let i=0;i<100;i++){if(window.fixtureEvents.some(e=>e.type==='poker-join'))break;await new Promise(r=>setTimeout(r,50))}
    if(!window.fixtureEvents.some(e=>e.type==='poker-join')||window.fixtureMediaRequests!==0)throw Error('Taking a seat did not signal only poker')
    if(!composer.value.includes('A draft while I watch'))throw Error('Taking a seat cleared the chat draft')
    return true
  })()`,awaitPromise:true,returnByValue:true})
  if(seated.result.exceptionDetails)throw Error(seated.result.exceptionDetails.exception?.description || JSON.stringify(seated.result.exceptionDetails))
  console.log('Bitchat: view with no seat or call, type in real composer, explicitly sit in')
} finally {
  proc.kill(); await exited
  fs.rmSync(dir,{recursive:true,force:true,maxRetries:3})
}
