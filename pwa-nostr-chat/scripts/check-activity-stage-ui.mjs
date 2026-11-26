// Run against a local Vite dev server, optionally with --mobile and --short-viewport (busy-room case only). CHROME can override the executable.
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
  const shortViewport = process.argv.includes('--short-viewport')
  if (process.argv.includes('--mobile')) await call('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
  for(const [kind, room] of [['chess','dm'],['go','dm'],['poker','geo'],['poker','server']]){
    const url = new URL('scripts/fixtures/activity-stage.html', origin)
    url.searchParams.set('kind',kind)
    url.searchParams.set('room',room)
    await call('Page.navigate',{url:url.href})
    await new Promise(r=>setTimeout(r,300))
    const probe = async ({kind,room}) => {
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
      const dialog = () => q('.ag-game-modal-backdrop > .ag-game-modal-frame[role=dialog][aria-modal=true]')
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
      const expectComposer=(fullWidth = true)=>{
        const b=board().getBoundingClientRect(), c=q('#fixture-composer').getBoundingClientRect()
        assert(b.width>170 && b.height>115,'Unreadable board: '+JSON.stringify(b.toJSON()))
        if (fullWidth) {
          const chat=q('.ag-main').getBoundingClientRect()
          assert(Math.abs(b.left-chat.left)<2 && Math.abs(b.right-chat.right)<2,
            'Minimized board does not span the entire chat column')
          assert(b.height<=Math.min(Math.max(224,0.32*innerHeight),270)+2,'Compact game stretches vertically: '+b.height)
          assert(q('.ag-game-chat-slot').getBoundingClientRect().height<=b.height+2,'Chat slot stretches beyond board')
          assert(q('.ag-stream-wrap').getBoundingClientRect().height>100,'Not enough room left for chat')
        }
        assert(b.bottom<=c.top || b.right<=c.left,'Board hides composer')
        assert(document.elementFromPoint(c.left+5,c.top+5)===q('#fixture-composer'),'Composer is not usable')
        assert(document.documentElement.scrollWidth<=innerWidth+1,'Viewport overflow')
      }
      const roomCall = room !== 'dm'
      const dockedStage=()=>q('.ag-call-dock-slot .ag-call-stage-docked')
      await wait(()=>pills().length===2 && (roomCall ? dockedStage() : q('.ag-activity-dock .ag-call-mini-pip')))
      const dock=q('.ag-activity-dock')
      assert(dock.contains(pills().find(p=>p.title.includes('Other'))),'Missing other game')
      const sink=await wait(()=>q('audio'))
      const src=await wait(()=>sink.srcObject)
      const groupStage=dockedStage()
      const groupVideo=roomCall && await wait(()=>groupStage.querySelector('video')?.srcObject && groupStage.querySelector('video'))
      const groupControls=groupStage?.querySelector('.ag-call-controls')
      const assertStandardCall=(video=groupVideo)=>{
        assert(dockedStage()===groupStage && groupStage.querySelector('.ag-call-controls')===groupControls,
          'Game changed the docked room call or moved its controls')
        assert(q('audio')===sink && sink.srcObject===src,'Game interrupted the call audio')
        if (video) assert(groupStage.querySelector('video')===video,'Game remounted normal room video')
        assert(!q('.ag-call-mini-pip, .ag-call-mini-pill, .ag-game-compact-video-rail'),
          'Game replaced the normal room call with a compact call')
      }
      await click(gamePill)
      await wait(dialog)
      await new Promise(r=>setTimeout(r,250)) // Measure after the restored opening transition.
      const modal = dialog().getBoundingClientRect()
      const expectedWidth=kind==='poker'?920:kind==='go'?600:560
      assert(Math.abs((modal.left+modal.right)/2-innerWidth/2)<2 &&
        Math.abs((modal.top+modal.bottom)/2-innerHeight/2)<2 &&
        Math.abs(modal.width-Math.min(expectedWidth,innerWidth-(innerWidth<=867?16:28)))<2,
        'Maximized game does not match the original centered modal')
      assert(q('.ag-game-chat-slot').childElementCount===0,'Expanded game takes up room inside chat')
      const composer=q('#fixture-composer')
      composer.focus(); composer.value='Draft still visible'
      if (roomCall) {
        assertStandardCall()
        await click(()=>btn('Minimize game'))
        const gameTile=()=>dockedStage()?.querySelector('.ag-call-tile .ag-game-in-call')
        await wait(gameTile)
        assertStandardCall()
        assert(!q('.ag-game-chat-slot .ag-game-stage-panel'),'Board rendered twice')
        expectComposer(false)
        await playable()
        assert(composer.value==='Draft still visible','Playing cleared chat draft')
        await hit(()=>btn('Pin Poker to stage'))
        await wait(()=>q('.ag-call-stage-pinned .ag-game-in-call'))
        assertStandardCall(null)
        await playable()
        await hit(()=>btn('Unpin Poker'))
        await wait(()=>gameTile() && q('.ag-call-grid video')?.srcObject)
        assertStandardCall(null)
        q('.ag-call-grid .ag-call-tile.has-video').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))
        await wait(()=>q('.ag-call-stage-pinned video')?.srcObject && !gameTile())
        await click(()=>q('.ag-call-stage-pinned .ag-call-unpin-btn'))
        await wait(gameTile)
        await click(()=>btn('Expand call stage'))
        await wait(()=>q('.ag-call-stage-expanded .ag-game-in-call') && q('.ag-call-stage-expanded video')?.srcObject)
        await click(()=>btn('Expand game'))
        await wait(()=>dialog() && q('.ag-call-stage-expanded') && !q('.ag-game-in-call'))
        document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}))
        await wait(()=>q('.ag-call-stage-expanded .ag-game-in-call'))
        await click(()=>btn('Minimize call stage'))
        await wait(()=>gameTile() && q('.ag-call-grid video')?.srcObject)
        assert(!q('.ag-call-mini-pip, .ag-call-mini-pill'),'Room did not return to its normal dock')
        assert(!btn('Hide game',board()),'A room game still offers the down-caret')
      } else {
        await click(()=>btn('Minimize game'))
        await wait(()=>compactBoard() && rail()?.querySelector('video')?.srcObject)
        await wait(()=>board().querySelector('.ag-game-compact-call-controls .ag-call-mini-pill'))
        assert(!q('.ag-call-mini-pip') && document.querySelectorAll('video').length===1,'Compact stage duplicated video')
        expectComposer()
        if(innerWidth<=867){
          document.documentElement.dataset.keyboardOpen='true'
          assert(board().getBoundingClientRect().height<=Math.min(innerHeight*.23,172)+2,
            'Compact board did not shrink when the keyboard opened')
          delete document.documentElement.dataset.keyboardOpen
        }
        await playable()
        assert(composer.value==='Draft still visible','Playing cleared chat draft')
        await click(()=>btn('Expand @bob video'))
        await wait(()=>!board() && q('.ag-dm-call-view video')?.srcObject)
        assert(q('audio')===sink && sink.srcObject===src,'Maximizing video interrupted audio')
        await click(()=>btn('Minimize call'))
        await wait(()=>compactBoard() && rail()?.querySelector('video')?.srcObject)
        assert(q('audio')===sink && sink.srcObject===src,'Returning to the compact board interrupted audio')
        assert(!btn('Hide game',board()),'A DM game still offers the down-caret')
      }
      // Ending the matching call must not clear the game or require opening its shortcut.
      q('#stop-test-call').click()
      await wait(()=>!q('audio') && !q('.ag-call-mini-pip') && q('.ag-game-in-chat.is-compact'))
      expectComposer()
      await playable()
      assert(!btn('Hide game',board()),'A standalone game still offers the down-caret')
      const dockedBoard=board()
      document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}))
      const back = new CustomEvent('agnostr:back',{cancelable:true})
      window.dispatchEvent(back)
      await new Promise(r=>setTimeout(r,50))
      assert(board()===dockedBoard && !back.defaultPrevented,'Compact game intercepted Escape/Back or disappeared')
      q('#toggle-test-chat').click()
      await wait(()=>!board() && gamePill())
      assert(!q('.ag-activity-dock .ag-game-stage-panel'),'Navigating popped out a game window')
      await click(gamePill)
      await wait(()=>q('.ag-game-in-chat.is-compact') && !dialog())
      await click(()=>btn('Expand game'))
      await wait(dialog)
      document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}))
      await wait(()=>q('.ag-game-in-chat.is-compact') && !dialog())
      expectComposer()
      await click(()=>pills().find(p=>p.title.includes('Other')))
      await wait(dialog)
      await click(()=>btn('Minimize game'))
      await wait(()=>q('.ag-game-in-chat.is-compact'))
      assert(!rail() && !q('.ag-game-in-call'),'Unrelated game inherited the call')
      return kind+' OK'
    }
    const result=await call('Runtime.evaluate',{expression:'('+probe+')('+JSON.stringify({kind,room})+')',awaitPromise:true,returnByValue:true})
    if(result.result.exceptionDetails)throw Error(result.result.exceptionDetails.exception?.description || JSON.stringify(result.result.exceptionDetails))
    console.log(room, result.result.result.value)
  }
  // Full App entry point: wholly local mock relay and synthetic signed room Poker events.
  const mockRelay = () => {
    const requests = []
    window.fixtureEvents = []
    window.fixtureGameEventsSigned = []
    window.fixtureMediaRequests = 0
    window.RTCPeerConnection = function () { ++window.fixtureMediaRequests; throw Error('Unexpected call') }
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
      value: async ({audio,video}) => {
        ++window.fixtureMediaRequests
        if (!window.fixtureAllowMedia) throw Error('Unexpected media permission')
        const tracks = []
        if (audio) {
          const ctx = new AudioContext()
          tracks.push(...ctx.createMediaStreamDestination().stream.getAudioTracks())
        }
        if (video) {
          const canvas = document.createElement('canvas')
          canvas.getContext('2d').fillRect(0, 0, 100, 80)
          tracks.push(...canvas.captureStream(1).getVideoTracks())
        }
        return new MediaStream(tracks)
      },
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
          if(id.kind===25055) {
            window.fixtureEvents.push(JSON.parse(id.content))
            window.fixtureGameEventsSigned.push(id)
          }
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
          if(filters.some(f=>f.kinds?.includes(event.kind) && Object.entries(f)
            .filter(([key])=>key.startsWith('#'))
            .every(([key,values])=>event.tags.some(([name,value])=>key==='#'+name && values.includes(value))))) {
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
    const modal=await wait(()=>q('.ag-game-modal-backdrop > .ag-game-modal-frame'))
    await wait(()=>modal.textContent.includes('Synthetic host'))
    assert(modal.textContent.includes('Watching'),'Viewing took a seat')
    await click(()=>q('.ag-game-modal-frame button[aria-label="Minimize game"]'))
    const board=await wait(()=>q('.ag-game-in-chat.is-compact'))
    assert(window.fixtureEvents.length===0 && window.fixtureMediaRequests===0,'Viewing or minimizing sent a signal or joined a call')
    const composer=await wait(()=>q('.ag-composer-input'))
    const c=composer.getBoundingClientRect(), b=board.getBoundingClientRect()
    assert(c.height>20 && (b.bottom<=c.top || b.right<=c.left),'Board overlaps the real composer')
    assert(b.height<=Math.min(Math.max(224,0.32*innerHeight),270)+2,'Real compact table takes up too much height')
    const chat=q('.ag-main').getBoundingClientRect()
    assert(Math.abs(b.left-chat.left)<2 && Math.abs(b.right-chat.right)<2,'Real compact table is not full chat width')
    const felt=board.querySelector('.ag-poker-felt').getBoundingClientRect()
    assert(felt.bottom<=b.bottom,'Compact felt bounds: '+JSON.stringify([felt.toJSON(),b.toJSON(),getComputedStyle(board.querySelector('.ag-poker-arena')).height]))
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
    const r=seat.getBoundingClientRect()
    if(!seat.contains(document.elementFromPoint(r.left+r.width/2,r.top+r.height/2)))throw Error('Seat button is clipped')
    seat.click()
    for(let i=0;i<100;i++){if(window.fixtureEvents.some(e=>e.type==='poker-join'))break;await new Promise(r=>setTimeout(r,50))}
    if(!window.fixtureEvents.some(e=>e.type==='poker-join')||window.fixtureMediaRequests!==0)throw Error('Taking a seat did not signal only poker')
    if(!composer.value.includes('A draft while I watch'))throw Error('Taking a seat cleared the chat draft')
    return true
  })()`,awaitPromise:true,returnByValue:true})
  if(seated.result.exceptionDetails)throw Error(seated.result.exceptionDetails.exception?.description || JSON.stringify(seated.result.exceptionDetails))
  console.log('Bitchat: minimize the playable table, type in the real composer, and explicitly sit in without a call')
  const roomCallProbe = async () => {
    const q = s => document.querySelector(s)
    const btn = (label, parent=document) => parent.querySelector('button[aria-label="'+label+'"]')
    const stage = () => q('.ag-call-dock-slot .ag-call-stage-docked')
    const gameTile = () => stage()?.querySelector('.ag-call-room-game-pane .ag-game-in-call')
    const wait = async f => {
      for(let i=0;i<150;i++){const v=f();if(v)return v;await new Promise(r=>setTimeout(r,100))}
      throw Error('missing '+f+' '+document.body.innerText.slice(-1800))
    }
    const click=async f => (await wait(f)).click()
    window.fixtureAllowMedia = true
    await click(()=>btn('Start call in #stage-fixture',q('.ag-header')))
    const call=await wait(stage)
    await wait(gameTile)
    await click(()=>btn('Turn camera on',call))
    const video=await wait(()=>call.querySelector('video')?.srcObject && call.querySelector('video'))
    const controls=call.querySelector('.ag-call-controls')
    await click(()=>q('.ag-header-game-btn'))
    await wait(()=>q('.ag-game-modal-frame'))
    if(stage()!==call || call.querySelector('video')!==video)throw Error('Expanded game changed the Bitchat call stage')
    await click(()=>btn('Minimize game'))
    await wait(gameTile)
    if(stage()!==call || call.querySelector('video')!==video || call.querySelector('.ag-call-controls')!==controls)
      throw Error('Minimizing remounted the Bitchat call')
    if(q('.ag-call-mini-pip, .ag-call-mini-pill, .ag-game-compact-video-rail, .ag-game-in-chat'))
      throw Error('Bitchat call turned into PiP or duplicated the game')
    await click(()=>btn('Pin Poker to stage'))
    await wait(()=>q('.ag-call-stage-pinned .ag-game-in-call'))
    await click(()=>btn('Unpin Poker'))
    await wait(()=>gameTile() && call.querySelector('video')?.srcObject)
    if(document.querySelector('.ag-composer-input').value!=='A draft while I watch')
      throw Error('Using a call game pane lost the chat draft')
    if(btn('Hide game'))throw Error('Removed caret is still available')
    await click(()=>call.querySelector('button[aria-label="Leave Bitchat call"]'))
    const standalone=await wait(()=>!stage() && q('.ag-game-in-chat.is-compact'))
    const b=standalone.getBoundingClientRect(), bounds=q('.ag-main').getBoundingClientRect()
    if(Math.abs(b.left-bounds.left)>2 || Math.abs(b.right-bounds.right)>2)
      throw Error('Leaving the Bitchat call did not restore a full-width game')
    document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}))
    await new Promise(r=>setTimeout(r,80))
    if(q('.ag-game-in-chat.is-compact')!==standalone)throw Error('Escape hid the standalone table')
    if(q('.ag-composer-input').value!=='A draft while I watch')throw Error('Leaving the call lost chat draft')
    await click(()=>btn('Close game',standalone))
    await wait(()=>!q('.ag-game-stage-panel'))
    if(q('.ag-composer-input').value!=='A draft while I watch')throw Error('Closing the game lost the chat draft')
    return true
  }
  const room=await call('Runtime.evaluate',{expression:'('+roomCallProbe+')()',awaitPromise:true,returnByValue:true})
  if(room.result.exceptionDetails)throw Error(room.result.exceptionDetails.exception?.description || JSON.stringify(room.result.exceptionDetails))
  console.log('Bitchat: the normal call dock stays intact; leaving the call immediately restores the full-width playable board')
  if(shortViewport && process.argv.includes('--mobile'))
    await call('Emulation.setDeviceMetricsOverride',{width:390,height:667,deviceScaleFactor:1,mobile:true})
  await call('Page.navigate',{url:new URL('/?busy-board=1#topic=busy-game-fixture',origin).href})
  const busyRoomProbe = async () => {
    const q = s => document.querySelector(s)
    const wait = async f => {
      for(let i=0;i<150;i++){const v=f();if(v)return v;await new Promise(r=>setTimeout(r,100))}
      throw Error('missing '+f+' '+document.body.innerText.slice(-1800))
    }
    const assert=(valid,msg)=>{if(!valid)throw Error(msg)}
    const findButton=(label,root=document)=>[...root.querySelectorAll('button')]
      .find(el=>el.getAttribute('aria-label')===label || el.textContent.trim()===label)
    const target='topic:busy-game-fixture'
    const {roomEvents,busyRoomHistory,liveHandForVisitor}=await import('/scripts/fixtures/activity-smoke-events.js')
    const events=[...roomEvents(target),...busyRoomHistory(target)]
    await wait(()=>q('.ag-header-game-btn'))
    await wait(()=>{
      window.fixtureReplay(events)
      const stream=q('.ag-stream-scroll')
      return stream?.scrollHeight > stream?.clientHeight + 1200 && findButton('View table')
    })
    findButton('View table').click()
    const modal=await wait(()=>q('.ag-game-modal-frame'))
    await wait(()=>modal.textContent.includes('Synthetic host'))
    findButton('Minimize game',modal).click()
    const board=await wait(()=>q('.ag-game-in-chat.is-compact'))
    const body=q('.ag-game-in-chat .ag-game-stage-body')
    const composer=q('.ag-composer-input')
    const stream=q('.ag-stream-scroll')
    const layout=phase=>{
      const h=body.getBoundingClientRect().height
      const c=composer.getBoundingClientRect(), b=board.getBoundingClientRect()
      const chat=q('.ag-main').getBoundingClientRect()
      assert(h>=185,phase+' board body collapsed to '+h+'px with '+stream.scrollHeight+'px of messages')
      assert(b.bottom<c.top && Math.abs(b.width-chat.width)<2,'Board overlaps chat composer or is not full width')
      assert(stream.clientHeight>78 && stream.scrollHeight>stream.clientHeight+1200,'Busy chat no longer has its own scroll area')
      assert(!q('.ag-call-stage, .ag-call-mini-pip, .ag-call-mini-pill') && window.fixtureMediaRequests===0,
        'Standalone play unexpectedly started a call')
      return h
    }
    const lobby=layout('Lobby')
    const physicalTarget=el=>{
      el.scrollIntoView({block:'nearest'})
      const b=el.getBoundingClientRect()
      assert(el.contains(document.elementFromPoint(b.left+b.width/2,b.top+b.height/2)),
        el.textContent.trim()+' is not physically reachable through the compact scroll area')
      return {x:b.left+b.width/2,y:b.top+b.height/2}
    }
    const seat=await wait(()=>[...board.querySelectorAll('button')].find(b=>b.textContent.includes('Sit In')))
    physicalTarget(seat)
    seat.click()
    const join=await wait(()=>window.fixtureGameEventsSigned.find(e=>JSON.parse(e.content).type==='poker-join'))
    const live=liveHandForVisitor(target,join.pubkey)
    const check=await wait(()=>{
      window.fixtureReplay([live])
      return findButton('Check',board)
    })
    const liveHeight=layout('Live hand')
    assert(Math.abs(lobby-liveHeight)<2,'Changing game state changed the dock height')
    const chatBefore=stream.scrollTop
    const targetPoint=physicalTarget(check)
    assert(chatBefore===stream.scrollTop,'Scrolling to poker controls moved chat history')
    return {...targetPoint,lobby,live:liveHeight,messages:stream.scrollHeight}
  }
  const busy=await call('Runtime.evaluate',{expression:'('+busyRoomProbe+')()',awaitPromise:true,returnByValue:true})
  if(busy.result.exceptionDetails)throw Error(busy.result.exceptionDetails.exception?.description || JSON.stringify(busy.result.exceptionDetails))
  const {x,y,...dimensions}=busy.result.result.value
  if(process.argv.includes('--mobile')){
    await call('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:1})
    await call('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y,id:1}]})
    await call('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]})
  }else{
    await call('Input.dispatchMouseEvent',{type:'mousePressed',x,y,button:'left',clickCount:1})
    await call('Input.dispatchMouseEvent',{type:'mouseReleased',x,y,button:'left',clickCount:1})
  }
  const action=await call('Runtime.evaluate',{expression:`(async()=>{
    for(let i=0;i<100;i++){
      const sent=window.fixtureEvents.find(e=>e.type==='poker-action' && JSON.parse(e.action).type==='check')
      if(sent)return sent.handNumber===1 && window.fixtureMediaRequests===0
      await new Promise(r=>setTimeout(r,50))
    }
    return false
  })()`,awaitPromise:true,returnByValue:true})
  if(action.result.result.value!==true)throw Error('Physical click/tap on compact Check did not send the live-hand action')
  console.log('Busy Bitchat: lobby and live board survived overflowing chat, then physical Check succeeded',dimensions)
} finally {
  proc.kill(); await exited
  fs.rmSync(dir,{recursive:true,force:true,maxRetries:3})
}
