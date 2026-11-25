// Run against a local production preview: node --experimental-strip-types scripts/check-private-dm-ui.mjs http://127.0.0.1:4173/
// Synthetic recipient, disposable Chrome profile, in-memory relays, no external network.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateSecretKey, getPublicKey, nip19 } from 'nostr-tools'
import { createEncryptedDmEvent, decryptGiftWrapEvent } from '../src/lib/dmCrypto.ts'
const base = new URL(process.argv[2] || 'http://127.0.0.1:4173/')
assert.equal(base.hostname, '127.0.0.1')
const tmp = mkdtempSync(join(tmpdir(),'agnostr-dm-test-'))
const port = Number(process.env.CDP_PORT || 9466)
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
  const setup = ({pk,npub}) => {
    if(location.protocol !== 'http:') return
    window.testEvents = {}; window.testSockets = []; window.testAcks = []; window.holdTestAcks = false
    window.WebSocket = class extends EventTarget {
      static OPEN=1; static CONNECTING=0; static CLOSED=3
      constructor(url){super();this.url=url;this.readyState=0;this.reqs={};window.testSockets.push(this);
        setTimeout(()=>{if(this.readyState!==0)return;this.readyState=1;this.dispatchEvent(new Event('open'))},10)}
      frame(frame){this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify(frame)}))}
      send(raw){const [cmd,id,...args]=JSON.parse(raw)
        if(cmd==='EVENT'){
          window.testEvents[id.id]=id
          if(window.holdTestAcks)window.testAcks.push({socket:this,id:id.id})
          else setTimeout(()=>this.frame(['OK',id.id,true,'']),5)
        }
        if(cmd==='REQ'){this.reqs[id]=args;setTimeout(()=>this.frame(['EOSE',id]),5)}
        if(cmd==='CLOSE')delete this.reqs[id]}
      close(){this.readyState=3}
    }
    if(sessionStorage.getItem('seeded'))return
    sessionStorage.setItem('seeded','1')
    const sec=Math.floor(Date.now()/1000)
    const messages=['Earlier test DM','Selected test DM'].map((content,i)=>({
      id:'fixture'+i,peerPubkey:pk,senderPubkey:pk,content,createdAt:sec-4+i,isOwn:false,protocol:'nip17',deliveryStatus:'delivered'}))
    localStorage.setItem('agnostr:v2:dm_threads',JSON.stringify([{peerPubkey:pk,peerNpub:npub,peerNickname:'Fixture',
      peerDisplayHandle:'Fixture',protocol:'nip17',messages,unreadCount:0,lastMessageAt:sec,lastPreview:'Selected test DM'}]))
  }
  const npub=nip19.npubEncode(peer.pubkey)
  await cdp('Page.enable')
  await cdp('Page.addScriptToEvaluateOnNewDocument',{source:'('+setup+')('+JSON.stringify({pk:peer.pubkey,npub})+')'})
  if(process.argv.includes('--mobile'))await cdp('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true})
  base.hash='dm='+npub+'&name=Fixture'
  await cdp('Page.navigate',{url:base.href})
  await wait(()=>!!document.getElementById('msg-fixture1'))
  await run(()=>document.querySelector('#msg-fixture1').click())
  await wait(()=>getComputedStyle(document.querySelector('#msg-fixture1 .ag-msg-actions')).pointerEvents!=='none')
  await run(()=>document.querySelector('#msg-fixture1 [aria-label="Reply to message"]').click())
  await wait(()=>document.querySelector('.ag-composer-reply-snippet')?.textContent==='Selected test DM')
  await run(()=>{const t=document.querySelector('.ag-composer-bar textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(t,'Reply from fixture');t.dispatchEvent(new Event('input',{bubbles:true}))})
  await run(()=>document.querySelector('[aria-label="Send message"]').click())
  await wait(()=>[...document.querySelectorAll('article')].some(a=>a.textContent.includes('Reply from fixture')&&a.querySelector('.ag-reply-quote-text')?.textContent==='Selected test DM'))
  const chooseReaction = async index => {
    await run(()=>document.querySelector('#msg-fixture1').click())
    await wait(()=>getComputedStyle(document.querySelector('#msg-fixture1 .ag-msg-actions')).pointerEvents!=='none')
    await run(()=>document.querySelector('#msg-fixture1 [aria-label="Add reaction"]').click())
    return run(i=>{
      const button=document.querySelectorAll('#msg-fixture1 .ag-emoji-opt:not(.ag-emoji-expand-btn)')[i]
      const emoji=button.textContent.trim()
      button.click()
      return emoji
    },index)
  }
  const rememberedReaction = emoji => run(e=>JSON.parse(localStorage.getItem('agnostr:v2:dm_threads')||'[]')
    .flatMap(t=>t.messages).find(m=>m.id==='fixture1')?.reactions?.some(r=>r.emoji===e&&r.reactedByMe)??false,emoji)
  const releaseAcks = ok => run(accept=>{
    window.holdTestAcks=false
    for(const {socket,id} of window.testAcks.splice(0))socket.frame(['OK',id,accept,accept?'':'synthetic rejection'])
  },ok)
  await run(()=>{window.holdTestAcks=true})
  const ownEmoji=await chooseReaction(0)
  await wait(e=>[...document.querySelectorAll('#msg-fixture1 .ag-reaction-pill.mine')].some(p=>p.textContent.includes(e)),ownEmoji)
  await wait(()=>window.testAcks.length)
  assert.equal(await rememberedReaction(ownEmoji),false,'pending reactions must not be persisted')
  await releaseAcks(true)
  await wait(e=>JSON.parse(localStorage.getItem('agnostr:v2:dm_threads')||'[]').flatMap(t=>t.messages)
    .find(m=>m.id==='fixture1')?.reactions?.some(r=>r.emoji===e&&r.reactedByMe),ownEmoji)
  const events=await run(()=>Object.values(window.testEvents))
  assert.ok(!events.some(ev=>ev.kind===7||ev.kind===14),'found public plaintext action')
  const wraps=events.filter(ev=>ev.kind===1059&&ev.tags[0]?.[1]===peer.pubkey)
  const decrypted=await Promise.all(wraps.map(ev=>decryptGiftWrapEvent(ev,peer)))
  const reply=decrypted.find(d=>d?.replyToId==='fixture1'&&d.content==='Reply from fixture')
  assert.ok(reply); assert.ok(decrypted.find(d=>d?.reactionToId==='fixture1'))
  const inbound=await createEncryptedDmEvent({recipientPubkey:reply.senderPubkey,signer:peer,protocol:'nip17',
    content:'💜',action:{type:'reaction',targetId:reply.id}})
  const deliver = event => run(ev=>{for(const sock of window.testSockets)for(const [id,filters] of Object.entries(sock.reqs)){
    if(filters.some(f=>f.kinds?.includes(1059)&&f['#p']?.includes(ev.tags[0][1])))sock.frame(['EVENT',id,ev])
  }},event)
  await deliver(inbound.event)
  await wait(()=>[...document.querySelectorAll('article')].find(a=>a.textContent.includes('Reply from fixture'))?.querySelector('.ag-reaction-pill')?.textContent?.includes('💜'))
  await run(()=>{window.holdTestAcks=true})
  const rejectedEmoji=await chooseReaction(1)
  await wait(e=>[...document.querySelectorAll('#msg-fixture1 .ag-reaction-pill.mine')].some(p=>p.textContent.includes(e)),rejectedEmoji)
  await wait(()=>window.testAcks.length)
  const reactToFixture=await createEncryptedDmEvent({recipientPubkey:reply.senderPubkey,signer:peer,protocol:'nip17',
    content:rejectedEmoji,action:{type:'reaction',targetId:'fixture1'}})
  await deliver(reactToFixture.event)
  // An incoming reaction updates immediately even while a local send's ACKs are held.
  await wait(e=>[...document.querySelectorAll('#msg-fixture1 .ag-reaction-pill.mine')]
    .some(p=>p.textContent.includes(e+'2')),rejectedEmoji)
  await releaseAcks(false)
  await wait(e=>[...document.querySelectorAll('#msg-fixture1 .ag-reaction-pill:not(.mine)')]
    .some(p=>p.textContent.includes(e+'1')),rejectedEmoji)
  assert.equal(await rememberedReaction(rejectedEmoji),false)
  // Backlog can arrive in arbitrary order. A reaction and reply preceding their
  // target must reconcile when that target arrives, without an extra chat row.
  const fromPeer = (content,action) => createEncryptedDmEvent({recipientPubkey:reply.senderPubkey,
    signer:peer,protocol:'nip17',content,action})
  const lateParent=await fromPeer('Late-arriving parent')
  const earlyRx=await fromPeer('🐬',{type:'reaction',targetId:lateParent.wireId})
  const earlyReply=await fromPeer('Early reply',{type:'reply',targetId:lateParent.wireId})
  await deliver(earlyRx.event);await deliver(earlyReply.event)
  await wait(()=>[...document.querySelectorAll('article')].find(a=>a.textContent.includes('Early reply'))?.querySelector('.ag-reply-quote-text')?.textContent==='Original message unavailable')
  await deliver(lateParent.event);await deliver(earlyRx.event)
  await wait(()=>[...document.querySelectorAll('article')].find(a=>a.textContent.includes('Early reply'))?.querySelector('.ag-reply-quote-text')?.textContent==='Late-arriving parent')
  await wait(id=>document.getElementById('msg-'+id)?.querySelector('.ag-reaction-pill')?.textContent?.includes('🐬1'),lateParent.wireId)
  assert.equal(await run(()=>!!document.querySelector('#msg-fixture0 .ag-reaction-pill')),false)
  assert.equal(await run(()=>!!document.querySelector('.ag-composer-reply-strip')),false)
  await cdp('Page.navigate',{url:base.href.split('#')[0]+'?reload=1#'+base.hash.slice(1)})
  await wait(()=>[...document.querySelectorAll('article')].find(a=>a.textContent.includes('Reply from fixture'))?.querySelector('.ag-reaction-pill')?.textContent?.includes('💜'))
  console.log('PASS: real People DM entry, targeted composer/quote, optimistic reactions before ACK, reject rollback preserves incoming reaction, reload, no public action.')
} finally {
  ws?.close();chrome.kill();await new Promise(r=>chrome.exitCode!==null?r():chrome.once('exit',r))
  rmSync(tmp,{recursive:true,force:true,maxRetries:4,retryDelay:100})
}
