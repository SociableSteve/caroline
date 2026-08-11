/**
 * Finding a Chrome to drive, without adding a dependency to do it.
 *
 * Puppeteer or Playwright would each be a hundred megabytes and a browser download for something
 * the suite never runs. What these scripts need is a binary that speaks the DevTools protocol, and
 * most machines that have ever run a browser test already have one. So: look in the usual places,
 * take `CHROME_PATH` ahead of all of them, and say plainly what to do when there is nothing.
 */
import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
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
