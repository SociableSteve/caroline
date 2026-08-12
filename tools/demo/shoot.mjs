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
import { chromeFlags, chromePath, profileDirectory, stopChrome } from './chrome.mjs'

const CHROME = chromePath()
const PORT = Number(process.env.CDP_PORT ?? 9333)
const BASE = process.env.BASE ?? 'http://127.0.0.1:5207'

/**
 * `--docs` writes the three pictures the documentation carries, into the repository, in both
 * palettes. Everything else about the run is the same, which is the point: the images in `docs/` are
 * this script pointed at the seeded day, so regenerating them is one command rather than a person
 * with a cropping tool. Spec 11.
 */
const forDocumentation = process.argv.includes('--docs')
const OUT = process.env.OUT ?? (forDocumentation ? 'docs/images' : '/tmp/caroline-demo/shots')

/**
 * Each surface, and the width to look at it at. Chat is no longer one of them: it is a rail beside a
 * surface, so it is shot where it is actually used. The rail is open unless the hash says it was
 * closed, which is why the bare hashes carry it and `?chat=closed` is what shows a surface alone.
 * The narrow pair is where the rail collapses to an overlay and the six columns stack.
 */
const surfaces = [
  { name: 'dashboard', hash: '#/', width: 1440, height: 1100 },
  { name: 'board', hash: '#/board?chat=closed', width: 1440, height: 1100 },
  { name: 'board-with-rail', hash: '#/board', width: 1440, height: 1100 },
  { name: 'projects', hash: '#/projects', width: 1440, height: 900 },
  { name: 'jobs', hash: '#/jobs', width: 1440, height: 1000 },
  { name: 'settings', hash: '#/settings', width: 1440, height: 1400 },
  { name: 'board-narrow', hash: '#/board?chat=closed', width: 430, height: 1200 },
  { name: 'rail-narrow', hash: '#/board', width: 430, height: 1200 },
  { name: 'dashboard-narrow', hash: '#/?chat=closed', width: 430, height: 1400 },
]

/**
 * A task the seeded day has, asked of the running server rather than written down here: the ids are
 * generated per seed, so a hash with one in it cannot be a constant. The rail shot is the whole
 * reason this exists, because the details panel is what an open item looks like and nothing opens it
 * but a selection.
 */
async function seeded(path, collection, what) {
  const response = await fetch(`${BASE}/${path}`)
  if (!response.ok) throw new Error(`${BASE} answered ${response.status} for ${what}`)
  const [first] = (await response.json())[collection]

  if (first === undefined) {
    throw new Error(`${BASE} has no ${what}: run npm run demo:seed and point the server at it`)
  }

  return first.id
}

/**
 * The pictures the documentation carries. Fewer than the surfaces above, and at one device pixel per
 * CSS pixel rather than two: these are committed, so their size is a cost somebody pays on every
 * clone. `--docs` shoots each of them in both palettes, because the site and the application follow
 * the reader's theme and a light-only screenshot in a dark page reads as somebody else's product.
 */
const documentationShots = forDocumentation
  ? [
      { name: 'dashboard', hash: '#/?chat=closed', width: 1440, height: 1100, scale: 1 },
      /**
       * Wider than the rest, because the document's subject here is that there are six columns and its
       * alt text says so. Six at their 15rem minimum plus the gaps and the surface padding need a little
       * over 1500px, and `captureBeyondViewport` extends the shot downwards only, so at 1440 the sixth
       * column was cut through its cards.
       */
      { name: 'board', hash: '#/board?chat=closed', width: 1600, height: 1100, scale: 1 },
      {
        name: 'rail',
        // The item open above the conversation it is about, which is the whole of what the rail is:
        // one shot rather than two, because that is one region on screen.
        hash:
          `#/board?item=task:${await seeded('api/tasks?status=review', 'tasks', 'task in Review')}` +
          `&conversation=${await seeded('api/chat/conversations', 'conversations', 'conversation')}`,
        width: 1440,
        height: 1100,
        scale: 1,
      },
    ]
  : []

const shots = forDocumentation ? documentationShots : surfaces

mkdirSync(OUT, { recursive: true })

const profile = profileDirectory('shoot')
const chrome = spawn(
  CHROME,
  [`--remote-debugging-port=${PORT}`, ...chromeFlags(profile), 'about:blank'],
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

/**
 * In a `finally`, because anything thrown between the spawn and the last screenshot would
 * otherwise leave Chrome alive holding the debugging port and its profile, and the next run would
 * either fail to bind or quietly attach to the stale browser and screenshot yesterday's client.
 */
let socket = null

try {
  socket = new WebSocket(await debuggerUrl())
  await new Promise((resolve) => socket.addEventListener('open', resolve))
  const browser = new Session(socket)

  const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true })

  // One palette for a look at the client, both for the documentation: `light` keeps the name it has
  // always written, and `dark` takes a suffix, so a page can ask for either.
  const palettes = forDocumentation ? ['light', 'dark'] : ['light']

  for (const shot of shots) {
    await browser.send(
      'Emulation.setDeviceMetricsOverride',
      {
        width: shot.width,
        height: shot.height,
        deviceScaleFactor: shot.scale ?? 2,
        mobile: false,
      },
      sessionId,
    )

    for (const palette of palettes) {
      // The reader's theme, as the client sees it: the stylesheet's dark rules are behind
      // `prefers-color-scheme`, and there is no switch in the UI to press instead.
      await browser.send(
        'Emulation.setEmulatedMedia',
        { features: [{ name: 'prefers-color-scheme', value: palette }] },
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

      const name = palette === 'dark' ? `${shot.name}-dark` : shot.name
      writeFileSync(`${OUT}/${name}.png`, Buffer.from(data, 'base64'))
      console.log(`${name}.png  ${shot.width}px`)
    }
  }
} finally {
  socket?.close()
  await stopChrome(chrome)
}
