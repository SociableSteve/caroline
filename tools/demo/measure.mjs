/** Measures whether a board column is actually bounded and actually scrolls. Spec 08, criterion 13. */
import { spawn } from 'node:child_process'
import { chromePath } from './chrome.mjs'

const CHROME = chromePath()
const PORT = Number(process.env.CDP_PORT ?? 9334)
const BASE = process.env.BASE ?? 'http://127.0.0.1:5207'

const chrome = spawn(
  CHROME,
  [
    `--remote-debugging-port=${PORT}`,
    '--headless',
    '--disable-gpu',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--user-data-dir=/tmp/caroline-demo/chrome-measure',
    'about:blank',
  ],
  { stdio: ['ignore', 'ignore', 'ignore'] },
)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function debuggerUrl() {
  for (let i = 0; i < 50; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/version`)
      const body = await res.json()
      if (body.webSocketDebuggerUrl) return body.webSocketDebuggerUrl
    } catch {
      /* not up yet */
    }
    await sleep(200)
  }
  throw new Error('no debugger')
}

const socket = new WebSocket(await debuggerUrl())
await new Promise((r) => socket.addEventListener('open', r))

let nextId = 1
const pending = new Map()
socket.addEventListener('message', (event) => {
  const message = JSON.parse(event.data)
  const resolve = pending.get(message.id)
  if (resolve) {
    pending.delete(message.id)
    resolve(message.result ?? {})
  }
})
const send = (method, params = {}, sessionId) =>
  new Promise((resolve) => {
    const id = nextId++
    pending.set(id, resolve)
    socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
  })

const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
await send(
  'Emulation.setDeviceMetricsOverride',
  { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false },
  sessionId,
)
await send('Page.navigate', { url: `${BASE}/#/board` }, sessionId)
await sleep(2500)

const expression = `
  (() => {
    const viewport = window.innerHeight
    return [...document.querySelectorAll('.column')].map((column) => {
      const cards = column.querySelector('.column-cards')
      return {
        column: column.getAttribute('aria-label'),
        columnHeight: Math.round(column.getBoundingClientRect().height),
        capAt70vh: Math.round(viewport * 0.7),
        listClient: cards ? cards.clientHeight : null,
        listScroll: cards ? cards.scrollHeight : null,
        scrolls: cards ? cards.scrollHeight > cards.clientHeight + 1 : null,
      }
    })
  })()
`

const { result } = await send('Runtime.evaluate', { expression, returnByValue: true }, sessionId)

console.log(JSON.stringify(result.value, null, 2))
socket.close()
chrome.kill()
process.exit(0)
