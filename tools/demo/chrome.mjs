/**
 * Finding a Chrome to drive, without adding a dependency to do it.
 *
 * Puppeteer or Playwright would each be a hundred megabytes and a browser download for something
 * the suite never runs. What these scripts need is a binary that speaks the DevTools protocol, and
 * most machines that have ever run a browser test already have one. So: look in the usual places,
 * take `CHROME_PATH` ahead of all of them, and say plainly what to do when there is nothing.
 */
import { existsSync, readdirSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

/** Playwright and Puppeteer both cache builds under a versioned directory, hence the globbing. */
function playwrightBuilds() {
  const cache = join(homedir(), '.cache', 'ms-playwright')
  if (!existsSync(cache)) return []

  return readdirSync(cache)
    .filter((entry) => entry.startsWith('chromium'))
    .flatMap((entry) => [
      join(cache, entry, 'chrome-headless-shell-linux64', 'chrome-headless-shell'),
      join(cache, entry, 'chrome-linux64', 'chrome'),
      join(cache, entry, 'chrome-linux', 'chrome'),
    ])
}

const SYSTEM = [
  process.env.CHROME_PATH,
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
]

/**
 * The flags every invocation shares.
 *
 * `--no-sandbox` is deliberately absent. These scripts load whatever `BASE` names, and dropping
 * renderer isolation to look at a page is a poor trade for a convenience. It is available as
 * `CHROME_NO_SANDBOX=1` for the restricted containers that genuinely cannot run the sandbox, which
 * is a decision somebody makes rather than one this file makes for them.
 */
export function chromeFlags(userDataDir) {
  const flags = [
    '--headless',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--hide-scrollbars',
    '--force-color-profile=srgb',
    `--user-data-dir=${userDataDir}`,
  ]

  if (process.env.CHROME_NO_SANDBOX === '1') flags.push('--no-sandbox')

  return flags
}

/**
 * A fixed profile directory per script, emptied before use rather than after.
 *
 * Cleaning up afterwards cannot be made reliable: Chrome's children rewrite `Local State` as they
 * exit, so a removal that waits for the parent still races the rest and either throws or leaves a
 * directory behind. Nothing is running at startup, so clearing it then always works, and a fixed
 * name means one stale directory at most rather than one per run.
 */
export function profileDirectory(name) {
  const directory = join(tmpdir(), `caroline-${name}-profile`)
  rmSync(directory, { recursive: true, force: true })
  return directory
}

/**
 * Stop Chrome, and wait for it to actually be gone.
 *
 * `kill` only sends the signal. Returning before the process has exited would leave the debugging
 * port held while the next run tries to bind it, which is the failure this is here to prevent.
 */
export async function stopChrome(chrome) {
  // Already gone, so there is no `exit` left to wait for: `once` would never fire and the timeout
  // below would spend two seconds discovering that. This is the common case when a run failed
  // because Chrome died, which is exactly when nobody wants to wait.
  if (chrome.exitCode !== null || chrome.signalCode !== null) return

  // Registered before the signal rather than after it, so a process that exits promptly cannot
  // slip through the window between the two and leave us waiting for an event that has passed.
  const exited = new Promise((resolve) => {
    const done = setTimeout(resolve, 2000)
    chrome.once('exit', () => {
      clearTimeout(done)
      resolve()
    })
  })

  chrome.kill()
  await exited
}

export function chromePath() {
  const candidates = [...SYSTEM, ...playwrightBuilds()].filter(
    (candidate) => typeof candidate === 'string',
  )
  const found = candidates.find((candidate) => existsSync(candidate))
  if (found !== undefined) return found

  throw new Error(
    'No Chrome found to drive. Set CHROME_PATH to a Chrome or chrome-headless-shell binary, ' +
      'or install one with `npx playwright install chromium`.',
  )
}
