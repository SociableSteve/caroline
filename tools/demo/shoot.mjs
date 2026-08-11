/**
 * Screenshots the running Caroline over the DevTools protocol.
 *
 * Not `--screenshot --virtual-time-budget`: the client holds an SSE subscription to the change
 * feed open and ticks a one-minute interval, so virtual time never settles and Chrome waits for a
 * network idle that is never coming. Driving the protocol directly means deciding for ourselves
 * when the page has had long enough.
 *
 * Node 24 has a global WebSocket, so this needs nothing installed.
 */
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { chromePath } from './chrome.mjs'

const CHROME = chromePath()
const PORT = Number(process.env.CDP_PORT ?? 9333)
const BASE = process.env.BASE ?? 'http://127.0.0.1:5207'
const OUT = process.env.OUT ?? '/tmp/caroline-demo/shots'

/** Each surface, and the width to look at it at. */
const shots = [
  { name: 'dashboard', hash: '#/', width: 1440, height: 1100 },
  { name: 'board', hash: '#/board', width: 1440, height: 1100 },
  { name: 'projects', hash: '#/projects', width: 1440, height: 900 },
  { name: 'chat', hash: '#/chat', width: 1440, height: 900 },
  { name: 'jobs', hash: '#/jobs', width: 1440, height: 1000 },
  { name: 'settings', hash: '#/settings', width: 1440, height: 900 },
  { name: 'board-narrow', hash: '#/board', width: 430, height: 1200 },
  { name: 'dashboard-narrow', hash: '#/', width: 430, height: 1400 },
]

mkdirSync(OUT, { recursive: true })

const chrome = spawn(
  CHROME,
  [
    `--remote-debugging-port=${PORT}`,
    '--headless',
    '--disable-gpu',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--hide-scrollbars',
    '--force-color-profile=srgb',
    '--user-data-dir=/tmp/caroline-demo/chrome-cdp',
    'about:blank',
  ],
  { stdio: ['ignore', 'ignore', 'pipe'] },
)

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** The debugger port takes a moment to come up, and there is no signal for it but polling. */
async function debuggerUrl() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/json/version`)
      const body = await response.json()
      if (body.webSocketDebuggerUrl !== undefined) return body.webSocketDebuggerUrl
    } catch {
      // Not listening yet.
    }
    await sleep(200)
  }
  throw new Error('Chrome never opened its debugging port')
}

class Session {
  constructor(socket) {
    this.socket = socket
    this.nextId = 1
    this.pending = new Map()
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      const resolver = this.pending.get(message.id)
      if (resolver !== undefined) {
        this.pending.delete(message.id)
        resolver(message.result ?? {})
      }
    })
  }

  send(method, params = {}, sessionId) {
    const id = this.nextId++
    return new Promise((resolve) => {
      this.pending.set(id, resolve)
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
    })
  }
}

const url = await debuggerUrl()
const socket = new WebSocket(url)
await new Promise((resolve) => socket.addEventListener('open', resolve))
const browser = new Session(socket)

const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' })
const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true })

for (const shot of shots) {
  await browser.send(
    'Emulation.setDeviceMetricsOverride',
    { width: shot.width, height: shot.height, deviceScaleFactor: 2, mobile: false },
    sessionId,
  )

  // A hash change alone does not reload, so every shot navigates from scratch.
  await browser.send('Page.navigate', { url: 'about:blank' }, sessionId)
  await sleep(150)
  await browser.send('Page.navigate', { url: `${BASE}/${shot.hash}` }, sessionId)
  // Long enough for the fetches behind the surface to land and React to paint them.
  await sleep(2500)

  const { data } = await browser.send(
    'Page.captureScreenshot',
    { format: 'png', captureBeyondViewport: true },
    sessionId,
  )

  writeFileSync(`${OUT}/${shot.name}.png`, Buffer.from(data, 'base64'))
  console.log(`${shot.name}.png  ${shot.width}px`)
}

socket.close()
chrome.kill()
process.exit(0)
