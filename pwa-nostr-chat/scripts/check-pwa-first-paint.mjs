// Run after npm run build: node scripts/check-pwa-first-paint.mjs [dist directory].
// CHROME can point to a local Chrome executable. Uses a disposable profile and no relays.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { extname, join, resolve, sep } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const dist = resolve(process.argv[2] || 'dist')
assert.ok(existsSync(join(dist, 'sw.js')), 'Build the production PWA first')
const chrome = process.env.CHROME || (process.platform === 'darwin'
  ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : 'google-chrome')
let rev = 1
let paintProbe = true
const delayedModules = []
const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname
  if (path === '/seed') {
    res.writeHead(200, { 'Content-Type': 'text/html' }).end('<!doctype html><title>Seed</title>')
    return
  }
  const file = resolve(dist, '.' + (path === '/' ? '/index.html' : path))
  if (!file.startsWith(dist + sep) || !existsSync(file)) return res.writeHead(404).end()
  if (paintProbe && file.endsWith('.css')) return res.writeHead(503).end()
  const send = () => {
    const mime = { '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css',
      '.webmanifest': 'application/manifest+json' }
    let body = readFileSync(file)
    // Two otherwise identical real workers, with a query for the active test revision.
    if (path === '/sw.js') body += '\nself.addEventListener("message", e => {' +
      'if(e.data==="fixture-revision") e.ports[0].postMessage(' + rev + ')})'
    res.writeHead(200, { 'Content-Type': mime[extname(file)] || 'application/octet-stream' }).end(body)
  }
  if (paintProbe && path.startsWith('/assets/') && file.endsWith('.js')) delayedModules.push(send)
  else send()
})
server.listen(0, '127.0.0.1')
await once(server, 'listening')
const origin = 'http://127.0.0.1:' + server.address().port
const profile = mkdtempSync(join(tmpdir(), 'agnostr-paint-'))
const proc = spawn(chrome, ['--headless', '--no-first-run', '--no-default-browser-check',
  '--disable-background-networking', '--remote-debugging-port=0', '--user-data-dir=' + profile,
  '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1', 'about:blank'],
  { stdio: 'ignore' })
const exited = once(proc, 'exit')
const sockets = []
async function until(fn, label) {
  for (let i = 0; i < 180; i++) {
    const value = await fn()
    if (value) return value
    await delay(100)
  }
  throw Error('Timed out: ' + label)
}
async function connect(target) {
  const socket = new WebSocket(target.webSocketDebuggerUrl)
  sockets.push(socket)
  await new Promise((ok, no) => { socket.onopen = ok; socket.onerror = no })
  let seq = 0
  let navigations = 0
  const pending = new Map()
  socket.onmessage = ({ data }) => {
    const msg = JSON.parse(data)
    if (msg.id) { pending.get(msg.id)?.(msg); pending.delete(msg.id) }
    if (msg.method === 'Page.frameNavigated' && !msg.params.frame.parentId) navigations++
  }
  const call = (method, params = {}) => new Promise((ok, no) => {
    const timer = setTimeout(() => no(Error('Timed out: ' + method)), 12000)
    pending.set(++seq, msg => {
      clearTimeout(timer)
      if (msg.error) no(Error(msg.error.message))
      else ok(msg.result)
    })
    socket.send(JSON.stringify({ id: seq, method, params }))
  })
  const evaluate = async expression => {
    const r = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (r.exceptionDetails) throw Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text)
    return r.result.value
  }
  await call('Page.enable')
  await call('Network.enable')
  await call('Network.setCacheDisabled', { cacheDisabled: true })
  await call('Network.setBlockedURLs', { urls: ['*://fonts.*/*'] })
  await call('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, mobile: true, deviceScaleFactor: 1 })
  const go = async url => {
    const before = navigations
    await call('Page.navigate', { url })
    await until(() => navigations > before, 'document navigation')
  }
  const navCount = () => navigations
  return { call, evaluate, go, navCount }
}
const controlled = 'navigator.serviceWorker.controller && !!document.querySelector("#root")?.childElementCount'
const update = 'navigator.serviceWorker.getRegistration().then(r=>r.update()).then(()=>true)'
const reloadButton = 'document.querySelector("button.ag-pwa-reload-btn")'
const workerRevision = `(async () => {
  const worker = navigator.serviceWorker.controller
  if (!worker) return 0
  const c = new MessageChannel()
  const result = new Promise(ok => { c.port1.onmessage = e => ok(e.data) })
  worker.postMessage('fixture-revision', [c.port2])
  return result
})()`
try {
  await until(() => existsSync(join(profile, 'DevToolsActivePort')), 'Chrome startup')
  const port = readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]
  const endpoint = 'http://127.0.0.1:' + port
  const target = (await (await fetch(endpoint + '/json/list')).json()).find(t => t.type === 'page')
  const a = await connect(target)
  const tokens = readFileSync(new URL('../src/styles/tokens.css', import.meta.url), 'utf8')
  for (const theme of [null, 'amber', 'indigo', 'daylight']) {
    const rule = tokens.split(`[data-theme='${theme || 'phosphor'}']`)[1].split('}')[0]
    const cssColor = rule.match(/--bg-canvas:\s*#([0-9a-f]{6});/i)[1]
    const rgb = cssColor.match(/../g).map(channel => parseInt(channel, 16))
    await a.go(origin + '/seed')
    await until(() => a.evaluate('document.title==="Seed"'), 'setup page')
    await a.evaluate(`localStorage.setItem('agnostr:v2:settings', ${JSON.stringify(JSON.stringify({ theme }))})`)
    await a.call('Emulation.setEmulatedMedia', { features: [
      { name: 'prefers-color-scheme', value: theme === 'daylight' ? 'dark' : 'light' },
    ] })
    await a.go(origin)
    await until(() => a.evaluate('!!document.getElementById("root")'), 'boot HTML')
    assert.equal(await a.evaluate('document.getElementById("root").childElementCount'), 0)
    assert.equal(await a.evaluate('document.documentElement.dataset.theme'), theme || 'phosphor')
    // The canvas must be opaque and match the *real* theme tokens before React
    // mounts, even when the CSS request failed and the OS prefers the other mode.
    const bg = await a.evaluate('getComputedStyle(document.documentElement).backgroundColor')
    assert.equal(bg, `rgb(${rgb.join(', ')})`, 'pre-mount canvas for ' + (theme || 'default'))
    assert.equal(await a.evaluate(`document.querySelector('meta[name="theme-color"]').content.toLowerCase()`), '#' + cssColor.toLowerCase())
    for (const send of delayedModules.splice(0)) send()
    await a.go('about:blank')
  }
  console.log('All four themes paint before CSS/JS, independent of device color scheme.')
  paintProbe = false
  for (const send of delayedModules.splice(0)) send()
  // Separate origin: slow-start probes must never pre-install the worker under test.
  const installOrigin = origin.replace('127.0.0.1', 'localhost')
  const before = a.navCount()
  await a.go(installOrigin)
  await until(() => a.evaluate(controlled), 'first install and claim')
  assert.equal(a.navCount(), before + 1, 'first claim must not reload')
  const b = await connect(await (await fetch(endpoint + '/json/new?about:blank', { method: 'PUT' })).json())
  await b.go(installOrigin)
  await until(() => b.evaluate(controlled), 'second controlled tab')
  await b.evaluate("window.fixtureDraft = 'unsent'")
  await a.call('Page.bringToFront')
  // The home globe does not show chat status strips. Open its real Bitchat stage.
  await a.evaluate(`[...document.querySelectorAll('button')].find(b =>
    b.getClientRects().length && b.textContent.trim() === 'Open Chat')?.click()`)
  await a.evaluate("window.fixtureDraft = 'unsent'")
  const aCount = a.navCount(), bCount = b.navCount()
  rev++
  await a.evaluate(update)
  await until(() => a.evaluate('!!' + reloadButton), 'pending update prompt')
  assert.equal(await a.evaluate(workerRevision), 1)
  assert.equal(await a.evaluate('window.fixtureDraft'), 'unsent')
  assert.equal(a.navCount(), aCount)
  await a.evaluate(reloadButton + '.click()')
  await until(() => a.navCount() === aCount + 1, 'one explicit reload')
  await until(() => a.evaluate(controlled), 'new page')
  assert.equal(await a.evaluate(workerRevision), 2)
  assert.equal(await b.evaluate(workerRevision), 2)
  assert.equal(b.navCount(), bCount, 'other tab must not be reloaded')
  assert.equal(await b.evaluate('window.fixtureDraft'), 'unsent')
  rev++
  await a.evaluate(update)
  await until(() => a.evaluate('navigator.serviceWorker.getRegistration().then(r => !!r.waiting)'), 'next update downloaded')
  await a.go('about:blank'); await b.go('about:blank')
  await delay(500)
  await a.go(installOrigin)
  await until(() => a.evaluate(controlled), 'reopen after closing both clients')
  assert.equal(await a.evaluate(workerRevision), 3)
  console.log('First claim, update prompt, explicit reload, second-tab draft and next launch all passed.')
} finally {
  for (const socket of sockets) socket.close()
  proc.kill()
  await exited
  rmSync(profile, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 })
  server.closeAllConnections()
  server.close()
}
