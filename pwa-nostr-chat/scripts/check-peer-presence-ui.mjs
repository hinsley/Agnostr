// Exercise the real chat/People UI using disposable identities and an in-memory relay.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateSecretKey, getPublicKey } from 'nostr-tools'
const origin = new URL(process.argv.find(a=>a.startsWith('http')) || 'http://127.0.0.1:4173/')
assert.equal(origin.hostname,'127.0.0.1')
const mobile = process.argv.includes('--mobile')
const profile = mkdtempSync(join(tmpdir(),'agnostr-peer-test-'))
const chrome = spawn(process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',[
  '--headless','--disable-gpu','--no-first-run','--no-default-browser-check','--disable-background-networking','--no-proxy-server',
  '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1','--window-size=1280,960',
  '--remote-debugging-port=0','--user-data-dir='+profile,'about:blank'],{stdio:'ignore'})
const sleep = ms => new Promise(resolve=>setTimeout(resolve,ms))
const data = {
  secret: Buffer.from(generateSecretKey()).toString('hex'),
  online: getPublicKey(generateSecretKey()), offline: getPublicKey(generateSecretKey()), outbound: getPublicKey(generateSecretKey()),
  note: 'Private fixture note: do not broadcast <b>HTML</b>',
}
const fixture = ({secret,online,offline,outbound,note}) => {
  if (location.hostname!=='127.0.0.1') return
  window.relayEvents=[]
  window.WebSocket = class extends EventTarget {
    static OPEN=1; static CONNECTING=0; static CLOSED=3
    constructor() {super();this.readyState=0;setTimeout(()=>{if(this.readyState===0){this.readyState=1;this.dispatchEvent(new Event('open'))}},2)}
    send(raw) {
      const [cmd, arg]=JSON.parse(raw)
      const send = values => setTimeout(()=>this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify(values)})),5)
      if(cmd==='REQ')send(['EOSE',arg])
      if(cmd==='EVENT'){window.relayEvents.push(arg);send(['OK',arg.id,true,''])}
    }
    close(){this.readyState=3}
  }
  if (sessionStorage.getItem('presence-fixture')) return
  sessionStorage.setItem('presence-fixture','1')
  const set=(key,val)=>localStorage.setItem('agnostr:v2:'+key,typeof val==='string'?val:JSON.stringify(val))
  set('device_seed',secret)
  set('active_geohash','9q')
  set('peer_notes',{[online]:note,[offline]:'Private note on away peer',[outbound]:'Private note on DM contact'})
  const now=Math.floor(Date.now()/1000)
  set('trusted',[{pubkey:online,label:'Online fixture',addedAt:Date.now()},{pubkey:offline,label:'Away fixture',addedAt:Date.now()-100}])
  set('msgs:9q',[[offline,'Away fixture',now-1880],[online,'Online fixture',now-20]].map(([pubkey,nickname,createdAt],i)=>({
    id:String(i+1).padStart(64,'0'),geohash:'9q',pubkey,nickname,displayHandle:nickname,createdAt,
    content:'Synthetic room activity',tags:[],isOwn:false,isTeleported:false,isMeshBridge:false,powBits:0,reactions:[],mentions:[],deliveryStatus:'sent',
  })))
  set('dm_threads',[{peerPubkey:outbound,peerNickname:'Outbound fixture',peerDisplayHandle:'Outbound fixture',
    messages:[{id:'local-fixture-message',peerPubkey:outbound,senderPubkey:'f'.repeat(64),content:'Outgoing-only fixture',
      createdAt:now,isOwn:true,protocol:'nip17',deliveryStatus:'sent'}],
    unreadCount:0,lastMessageAt:now,lastPreview:'Outgoing-only fixture',protocol:'nip17',peerNpub:'npubfixture'}])
}
let socket
try {
  let target
  for(let i=0;i<100&&!target;i++){
    try {
      const port=readFileSync(join(profile,'DevToolsActivePort'),'utf8').split('\n')[0]
      target=(await (await fetch('http://127.0.0.1:'+port+'/json/list')).json()).find(x=>x.type==='page')
    } catch {}
    if(!target) await sleep(75)
  }
  assert.ok(target,'Could not start headless Chromium')
  socket=new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((ok,no)=>{socket.onopen=ok;socket.onerror=no})
  const pending=new Map();let seq=0
  socket.onmessage=e=>{
    const d=JSON.parse(e.data)
    if(pending.has(d.id)){pending.get(d.id)(d);pending.delete(d.id)}
  }
  const cdp=(method,params={})=>new Promise((ok,no)=>{
    const id=++seq;pending.set(id,r=>r.error?no(Error(r.error.message)):ok(r.result));socket.send(JSON.stringify({id,method,params}))
  })
  const run=async (fn,arg)=>{
    const r=await cdp('Runtime.evaluate',{expression:'('+fn+')('+JSON.stringify(arg)+')',returnByValue:true,awaitPromise:true})
    if(r.exceptionDetails) throw Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text)
    return r.result.value
  }
  const wait=async (fn,arg)=>{
    for(let i=0;i<120;i++){const v=await run(fn,arg);if(v)return v;await sleep(100)}
    throw Error('Missing '+fn+' | '+await run(()=>document.body.innerText.slice(-1600)))
  }
  await cdp('Runtime.enable');await cdp('Page.enable')
  if(mobile) await cdp('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true})
  await cdp('Page.addScriptToEvaluateOnNewDocument',{source:'('+fixture+')('+JSON.stringify(data)+')'})
  await cdp('Page.navigate',{url:origin.href+'#9q'})
  const normal=()=>!!document.querySelector('.ag-stream-scroll')
  await wait(()=>!!document.querySelector('.ag-stream-scroll')||[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='Open Chat'))
  if(!await run(normal))await run(()=>[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Open Chat').click())
  if(mobile)await run(()=>document.querySelector('button[aria-label="Show user list"]')?.click())
  const probe = ({selector,person}) => {
    const row=[...document.querySelectorAll(selector)].find(r=>(r.querySelector('.ag-users-name, .ag-chat-row-name')?.textContent ?? '').includes(person))
    if (!row || row.getBoundingClientRect().right<=0 || row.getBoundingClientRect().left>=innerWidth) return null
    const status=row.querySelector('.ag-peer-presence'), note=row.querySelector('.ag-person-note-line')
    return {
      status:status?.textContent, title:status?.title,
      note:note?.title, separate:!!(status&&note&&!status.contains(note)),
      stacked:!!(status&&note&&note.getBoundingClientRect().top>=status.getBoundingClientRect().bottom-1),
      markup:!!note?.querySelector('b')
    }
  }
  const right=await wait(probe,{selector:'.ag-users-row',person:'Online fixture'})
  assert.equal(right.status,'Online')
  assert.equal(right.note,data.note)
  assert.ok(right.separate&&right.stacked&&!right.markup)
  const away=await wait(probe,{selector:'.ag-users-row',person:'Away fixture'})
  assert.match(away.status,/^3[01]m$/)
  assert.match(away.title,/^Last active /)
  assert.equal(away.note,'Private note on away peer')
  assert.ok(away.separate&&away.stacked)
  // Edit via the actual profile opened from the room roster.
  await run(()=>[...document.querySelectorAll('.ag-users-row')].find(r=>r.querySelector('.ag-users-name')?.textContent.includes('Online fixture')).click())
  await wait(()=>!!document.getElementById('ag-peer-inspector-note'))
  assert.ok(await run(()=>document.querySelector('.ag-peer-modal-badges').innerText.includes('ONLINE')))
  await run(()=>{const el=document.getElementById('ag-peer-inspector-note');el.focus();el.select()})
  await cdp('Input.insertText',{text:'Updated private fixture note'})
  await wait(()=>!!document.querySelector('.ag-peer-note-save-btn'))
  await run(()=>document.querySelector('.ag-peer-note-save-btn').click())
  await run(()=>document.querySelector('button[aria-label="Close peer inspector"]').click())
  if(mobile)await run(()=>document.querySelector('button[aria-label="Show user list"]')?.click())
  await wait(()=>[...document.querySelectorAll('.ag-users-row')].some(r=>r.querySelector('.ag-person-note-line')?.title==='Updated private fixture note'&&r.querySelector('.ag-peer-presence')?.textContent==='Online'))
  if(mobile)await run(()=>document.querySelector('.ag-right-drawer-scrim.active')?.click())
  const peopleButton = () => [...document.querySelectorAll('button')].some(b=>b.getClientRects().length&&
    [...b.querySelectorAll('.ag-mtab-label, .ag-rail-app-label')].some(label=>label.textContent==='People'))
  await wait(peopleButton) // select only the visible navigation button
  await run(()=>[...document.querySelectorAll('button')].find(b=>b.getClientRects().length&&
    [...b.querySelectorAll('.ag-mtab-label, .ag-rail-app-label')].some(label=>label.textContent==='People')).click())
  if(mobile)await run(()=>{const b=[...document.querySelectorAll('.ag-mtab-btn')].find(b=>b.textContent.trim()==='People');if(b&&!document.querySelector('.ag-conv-col.open'))b.click()})
  const contact=await wait(probe,{selector:'.ag-chat-row.dm',person:'Online fixture'})
  assert.equal(contact.status,'Online');assert.equal(contact.note,'Updated private fixture note');assert.ok(contact.separate)
  const outbound=await wait(probe,{selector:'.ag-chat-row.dm',person:'Outbound fixture'})
  assert.equal(outbound.status,'Offline','our outgoing DM falsely marked this peer active')
  assert.equal(outbound.note,'Private note on DM contact')
  // The search result also preserves its trusted subtitle, activity, and note as different fields.
  await run(()=>window.dispatchEvent(new KeyboardEvent('keydown',{key:'k',ctrlKey:true,cancelable:true})))
  await wait(()=>!!document.querySelector('.ag-cmdk-input'))
  await run(()=>document.querySelector('.ag-cmdk-input').focus())
  await cdp('Input.insertText',{text:'Updated private fixture note'})
  const search = await wait(()=> {
    const row=[...document.querySelectorAll('.ag-cmdk-row')].find(r=>r.querySelector('.ag-person-note-line')?.title==='Updated private fixture note')
    return row ? {subtitle:row.querySelector('.ag-cmdk-row-sub')?.textContent,status:row.querySelector('.ag-peer-presence')?.textContent} : null
  })
  assert.deepEqual(search,{subtitle:'Trusted',status:'Online'})
  assert.ok(await run(()=>!JSON.stringify(window.relayEvents).includes('Updated private fixture note')))
  console.log(`PASS ${mobile?'mobile':'desktop'}: live and last-active status stay separate from real private notes in room/People rows; editing a note never changes presence or sends the note publicly.`)
} finally {
  socket?.close();chrome.kill()
  await new Promise(resolve=>chrome.exitCode!==null?resolve():chrome.once('exit',resolve))
  rmSync(profile,{recursive:true,force:true,maxRetries:4,retryDelay:100})
}
