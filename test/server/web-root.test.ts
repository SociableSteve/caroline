import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildServer, resolveWebRoot } from '../../src/server/app.js'
import { loadConfig } from '../../src/config/load.js'
import { migratedDatabase } from '../helpers/temp-database.js'

const cleanCheckout = loadConfig({ file: null, env: {} as NodeJS.ProcessEnv })

describe('resolveWebRoot', () => {
  it('joins the given directory with dist/web, as npm run build writes it', () => {
    expect(resolveWebRoot('/repo')).toBe(join('/repo', 'dist', 'web'))
  })

  it('defaults to process.cwd() when no directory is given', () => {
    expect(resolveWebRoot()).toBe(join(process.cwd(), 'dist', 'web'))
  })
})

/**
 * `buildServer`'s `webRoot` option, exercised end to end: a caller (or a test) that points
 * it somewhere the built SPA does or does not exist gets the fallback behaviour that implies,
 * without needing to `chdir` the whole process or dynamically re-import `app.ts` to make it
 * see a different `process.cwd()`.
 */
describe('the built SPA directory', () => {
  const openDirectories: string[] = []

  afterEach(() => {
    for (const directory of openDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('is served from an injected webRoot when the built SPA is there', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'caroline-webroot-'))
    openDirectories.push(repoRoot)
    const webDirectory = join(repoRoot, 'dist', 'web')
    mkdirSync(webDirectory, { recursive: true })
    writeFileSync(join(webDirectory, 'index.html'), '<!doctype html><title>caroline</title>')

    const app = await buildServer({
      config: cleanCheckout,
      database: migratedDatabase(),
      webRoot: webDirectory,
    })

    // An unmatched GET is exactly what the OAuth callback's redirect and every other
    // client-side route look like to the server: no route matches, so the SPA fallback in
    // `registerErrorHandling` is what has to serve the shell instead of a 404.
    const response = await app.inject({ method: 'GET', url: '/dashboard' })

    expect(response.statusCode).toBe(200)
    expect(response.body).toContain('<title>caroline</title>')
    await app.close()
  })

  /**
   * Spec 13, "The boundary is decided by the route that matched", applied to the one place still
   * reading the raw URL after the auth gate stopped: the SPA fallback. Fastify decodes
   * percent-escapes before it matches, so `/%61pi/no-such-route` is an API path that matched no
   * route, and a fallback deciding on `request.url` saw a path beginning `/%61` and served the
   * shell with a 200. The class of defect is the one the gate was fixed for, and the shape of the
   * fix is the same. Spec 09, criterion 26.
   */
  it('answers a JSON 404 for an unmatched API path however it was spelled', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'caroline-webroot-'))
    openDirectories.push(repoRoot)
    const webDirectory = join(repoRoot, 'dist', 'web')
    mkdirSync(webDirectory, { recursive: true })
    writeFileSync(join(webDirectory, 'index.html'), '<!doctype html><title>caroline</title>')

    const app = await buildServer({
      config: cleanCheckout,
      database: migratedDatabase(),
      webRoot: webDirectory,
    })

    for (const url of [
      '/api/no-such-route',
      '/%61pi/no-such-route',
      '/api%2fno-such-route',
      '/%61%70%69/no-such-route',
    ]) {
      const response = await app.inject({ method: 'GET', url })

      expect(response.statusCode, url).toBe(404)
      expect(response.json(), url).toEqual({
        error: { code: 'not_found', message: expect.any(String) },
      })
    }

    await app.close()
  })

  it('still serves the shell for a genuine client-side route beside that', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'caroline-webroot-'))
    openDirectories.push(repoRoot)
    const webDirectory = join(repoRoot, 'dist', 'web')
    mkdirSync(webDirectory, { recursive: true })
    writeFileSync(join(webDirectory, 'index.html'), '<!doctype html><title>caroline</title>')

    const app = await buildServer({
      config: cleanCheckout,
      database: migratedDatabase(),
      webRoot: webDirectory,
    })

    // Including one whose name merely starts with the same letters, which is not an API path and
    // must not be answered as one, and a deep client route with an escape in it.
    for (const url of ['/dashboard', '/apiary', '/projects/a%20project', '/']) {
      const response = await app.inject({ method: 'GET', url })

      expect(response.statusCode, url).toBe(200)
      expect(response.body, url).toContain('<title>caroline</title>')
    }

    await app.close()
  })

  it('404s on an unmatched GET when the injected webRoot does not exist', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'caroline-webroot-'))
    openDirectories.push(repoRoot)
    const webDirectory = join(repoRoot, 'dist', 'web')

    const app = await buildServer({
      config: cleanCheckout,
      database: migratedDatabase(),
      webRoot: webDirectory,
    })

    const response = await app.inject({ method: 'GET', url: '/dashboard' })

    expect(response.statusCode).toBe(404)
    await app.close()
  })
})

/**
 * `config.server.webRoot` (from `caroline.config.json` or `CAROLINE_WEB_ROOT`) is how a real
 * deployment actually reaches `buildServer`'s `webRoot` option: `main.ts` has no other path
 * from configuration to it. This wires the two together the same way `main.ts` does, rather
 * than calling `buildServer` with `webRoot` directly the way the tests above do, so a
 * regression in that plumbing (the config field silently not reaching `buildServer`) fails
 * here rather than only in production.
 */
describe('config.server.webRoot reaching buildServer', () => {
  const openDirectories: string[] = []

  afterEach(() => {
    for (const directory of openDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('is served when CAROLINE_WEB_ROOT names a directory outside the default guess', async () => {
    const webDirectory = mkdtempSync(join(tmpdir(), 'caroline-webroot-'))
    openDirectories.push(webDirectory)
    writeFileSync(join(webDirectory, 'index.html'), '<!doctype html><title>caroline</title>')

    const config = loadConfig({
      file: null,
      env: { CAROLINE_WEB_ROOT: webDirectory } as NodeJS.ProcessEnv,
    })
    expect(config.server.webRoot).toBe(webDirectory)

    // The same conditional spread `main.ts` uses: `config.server.webRoot` is null in the
    // common case, and `buildServer` must fall back to `resolveWebRoot()` then, not to a
    // literal `undefined` webRoot naming no directory at all.
    const app = await buildServer({
      config,
      database: migratedDatabase(),
      ...(config.server.webRoot === null ? {} : { webRoot: config.server.webRoot }),
    })

    const response = await app.inject({ method: 'GET', url: '/dashboard' })

    expect(response.statusCode).toBe(200)
    expect(response.body).toContain('<title>caroline</title>')
    await app.close()
  })
})

/**
 * The built SPA present on an exposed install: `auth.mode: "required"` and a `server.publicUrl`
 * together, which is the deployment every check in the auth gate exists for and the one
 * configuration this file did not have. Every test above runs on `cleanCheckout`, so the shell,
 * the API 404 and the `Host` check had each been asserted only where the gate lets nearly
 * everything through. The gap is the shape of the round-1 one, where a whole endpoint was dead
 * because nothing paired `server.publicUrl` with `mcp.enabled`: each part worked and the
 * combination was never built. Spec 09, criteria 20, 21 and 26.
 */
describe('the built SPA on an install with a login and a public URL', () => {
  const openDirectories: string[] = []

  afterEach(() => {
    for (const directory of openDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  const exposedInstall = loadConfig({
    file: {
      server: { publicUrl: 'https://caroline.example.com' },
      auth: {
        mode: 'required',
        allow: ['owner@example.com'],
        provider: { clientId: 'a-client-id' },
      },
    },
    env: {} as NodeJS.ProcessEnv,
  })

  async function exposedServerWithShell() {
    const webDirectory = mkdtempSync(join(tmpdir(), 'caroline-webroot-'))
    openDirectories.push(webDirectory)
    writeFileSync(join(webDirectory, 'index.html'), '<!doctype html><title>caroline</title>')

    return buildServer({
      config: exposedInstall,
      database: migratedDatabase(),
      webRoot: webDirectory,
    })
  }

  it('serves the shell with no session, so the login screen can render', async () => {
    const app = await exposedServerWithShell()

    // The one thing an install with a login must still answer to an unauthenticated browser: the
    // shell that renders the login screen. Refusing this would make the login unreachable, and
    // `authRequired` is exactly the configuration where nothing else could fix it.
    for (const url of ['/', '/dashboard']) {
      const response = await app.inject({ method: 'GET', url, headers: { host: 'localhost:5123' } })

      expect(response.statusCode, url).toBe(200)
      expect(response.body, url).toContain('<title>caroline</title>')
    }

    await app.close()
  })

  it('answers the API 404 and the API 401 beside it, rather than the shell', async () => {
    const app = await exposedServerWithShell()

    const missing = await app.inject({ method: 'GET', url: '/api/nope' })
    expect(missing.statusCode).toBe(404)
    expect(missing.json()).toEqual({ error: { code: 'not_found', message: expect.any(String) } })

    const registered = await app.inject({ method: 'GET', url: '/api/tasks' })
    expect(registered.statusCode).toBe(401)

    await app.close()
  })

  it('refuses a Host it does not answer to before serving any of it', async () => {
    const app = await exposedServerWithShell()

    // The `Host` check runs first, so it applies to the shell as much as to the API: a static
    // wildcard registered under the gate is not a way around it.
    for (const url of ['/dashboard', '/api/tasks']) {
      const response = await app.inject({
        method: 'GET',
        url,
        headers: { host: 'rebind.example.com' },
      })

      expect(response.statusCode, url).toBe(403)
    }

    // And the public URL's own name is answered to, so the assertion above is about the name and
    // not about the check refusing everything.
    const served = await app.inject({
      method: 'GET',
      url: '/dashboard',
      headers: { host: 'caroline.example.com' },
    })
    expect(served.statusCode).toBe(200)

    await app.close()
  })
})
