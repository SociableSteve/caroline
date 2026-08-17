import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { loadConfig } from '../../src/config/load.js'
import { migratedDatabase } from '../helpers/temp-database.js'

/**
 * `app.ts` resolves the built SPA's directory once, at module load, from `process.cwd()`
 * (spec: the fix for the dev-mode 404 regression, where `import.meta.url` pointed at
 * `src/web` in dev and only happened to land on `dist/web` in prod because the compiled
 * module lives one level deeper). That resolution has to be exercised with the module
 * freshly imported after `chdir`, since it runs once at import time: a statically imported
 * `buildServer` would carry over whatever `process.cwd()` was when some earlier test file
 * first loaded it.
 */
const cleanCheckout = loadConfig({ file: null, env: {} as NodeJS.ProcessEnv })

const realCwd = process.cwd()
const openDirectories: string[] = []

afterEach(() => {
  process.chdir(realCwd)
  for (const directory of openDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('the built SPA directory', () => {
  it('is found under dist/web relative to the process cwd, as npm run build writes it', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'caroline-webroot-'))
    openDirectories.push(repoRoot)
    const webDirectory = join(repoRoot, 'dist', 'web')
    mkdirSync(webDirectory, { recursive: true })
    writeFileSync(join(webDirectory, 'index.html'), '<!doctype html><title>caroline</title>')

    process.chdir(repoRoot)
    const { buildServer } = await import(
      /* @vite-ignore */ `../../src/server/app.js?t=${randomUUID().replace(/-/g, '')}`
    )
    const app = await buildServer({ config: cleanCheckout, database: migratedDatabase() })

    // An unmatched GET is exactly what the OAuth callback's redirect and every other
    // client-side route look like to the server: no route matches, so the SPA fallback in
    // `registerErrorHandling` is what has to serve the shell instead of a 404.
    const response = await app.inject({ method: 'GET', url: '/dashboard' })

    expect(response.statusCode).toBe(200)
    expect(response.body).toContain('<title>caroline</title>')
    await app.close()
  })

  it('is absent when npm run build has not been run, so unmatched GETs 404 rather than crash', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'caroline-webroot-'))
    openDirectories.push(repoRoot)

    process.chdir(repoRoot)
    const { buildServer } = await import(
      /* @vite-ignore */ `../../src/server/app.js?t=${randomUUID().replace(/-/g, '')}`
    )
    const app = await buildServer({ config: cleanCheckout, database: migratedDatabase() })

    const response = await app.inject({ method: 'GET', url: '/dashboard' })

    expect(response.statusCode).toBe(404)
    await app.close()
  })
})
