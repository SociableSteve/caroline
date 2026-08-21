/**
 * The `Host` check, spec 09's network-posture section and criterion 21. Loopback is not a
 * boundary against other software on the machine, and a name somebody else controls can be made
 * to resolve to `127.0.0.1`, at which point a page in the user's own browser is same-origin with
 * the API and reads and writes everything in it. The MCP endpoint has validated `Host` for
 * exactly this reason since spec 12; this asserts the same check over the rest of the API, on the
 * default configuration as much as on an install with a login.
 */
import { describe, expect, it } from 'vitest'
import { loadConfig } from '../../src/config/load.js'
import { buildServer } from '../../src/server/app.js'
import { migratedDatabase } from '../helpers/temp-database.js'
import { isAcceptableHost } from '../../src/auth/origin.js'

const noEnv = {} as NodeJS.ProcessEnv

/** The default: loopback bind, no login, which is where the rebinding hole actually was. */
function looseConfig() {
  return loadConfig({ file: null, env: noEnv })
}

function exposedConfig() {
  return loadConfig({
    file: {
      server: { publicUrl: 'https://caroline.example.com' },
      auth: {
        mode: 'required',
        allow: ['owner@example.com'],
        provider: { clientId: 'a-client-id' },
      },
    },
    env: noEnv,
  })
}

describe('isAcceptableHost', () => {
  it('accepts any loopback host, on any port, where there is no public URL', () => {
    const config = looseConfig()
    for (const host of [
      '127.0.0.1',
      '127.0.0.1:5123',
      'localhost',
      'localhost:5173',
      '[::1]',
      '[::1]:5123',
      '[::ffff:127.0.0.1]:5123',
    ]) {
      expect(isAcceptableHost(config, host), host).toBe(true)
    }
  })

  it('refuses a missing Host outright', () => {
    // An HTTP/1.0 request may carry no `Host` at all, and there is no address for it to be
    // addressed to, so there is nothing to accept. The MCP endpoint answers a missing one the
    // same way.
    expect(isAcceptableHost(looseConfig(), undefined)).toBe(false)
    expect(isAcceptableHost(exposedConfig(), undefined)).toBe(false)
  })

  it('refuses a host that is not loopback where there is no public URL', () => {
    const config = looseConfig()
    for (const host of [
      'rebind.example.com',
      'rebind.example.com:5123',
      '203.0.113.5:5123',
      '127.0.0.1.nip.io',
      'localhost.evil.example',
      '',
      'localhost/../evil',
      'user@evil.example',
    ]) {
      expect(isAcceptableHost(config, host), host).toBe(false)
    }
  })

  it('accepts the public URL host where one is set, and refuses another name', () => {
    const config = exposedConfig()
    expect(isAcceptableHost(config, 'caroline.example.com')).toBe(true)
    expect(isAcceptableHost(config, 'rebind.example.com')).toBe(false)
    expect(isAcceptableHost(config, 'caroline.example.com.evil.example')).toBe(false)
  })

  it('accepts the loopback set beside the public URL host, rather than instead of it', () => {
    // The loopback set is accepted whatever the public URL says, because a rebinding attacker
    // forges DNS and not this header: a page served from a name that resolves to `127.0.0.1`
    // still sends the name in the address bar. Refusing loopback here bought nothing and made
    // the MCP endpoint, which requires a loopback `Host` of its own, unreachable on every
    // install that names a public URL.
    const config = exposedConfig()
    expect(isAcceptableHost(config, '127.0.0.1:5123')).toBe(true)
    expect(isAcceptableHost(config, 'localhost:5123')).toBe(true)
    expect(isAcceptableHost(config, '[::1]')).toBe(true)
  })

  it('does not require the public URL port, because a proxy forwards the bare name', () => {
    // `proxy_set_header Host $host;` is the standard nginx recipe and forwards a hostname with
    // no port at all, so an install whose public URL names a port used to refuse every request
    // that reached it. The port adds nothing against rebinding for the same reason the hostname
    // is enough: the header cannot be forged in the first place.
    const config = loadConfig({
      file: {
        server: { publicUrl: 'https://caroline.example.com:8443' },
        auth: {
          mode: 'required',
          allow: ['owner@example.com'],
          provider: { clientId: 'a-client-id' },
        },
      },
      env: noEnv,
    })

    expect(isAcceptableHost(config, 'caroline.example.com:8443')).toBe(true)
    expect(isAcceptableHost(config, 'caroline.example.com')).toBe(true)
    expect(isAcceptableHost(config, 'caroline.example.com:9443')).toBe(true)
    expect(isAcceptableHost(config, 'rebind.example.com:8443')).toBe(false)
  })

  it('accepts every loopback name where the public URL is itself a loopback one', () => {
    // `server.publicUrl: "http://127.0.0.1:5123"` is a configuration the startup guards
    // explicitly permit (`assertPublicUrlSchemeIsSafe`'s both-loopback branch). Browsing such an
    // install as `http://localhost:5123` sends `Host: localhost:5123`, whose hostname is not
    // `127.0.0.1`, and a rule that named only the public URL's own host refused the whole app.
    const config = loadConfig({
      file: {
        server: { publicUrl: 'http://127.0.0.1:5123' },
        auth: {
          mode: 'required',
          allow: ['owner@example.com'],
          provider: { clientId: 'a-client-id' },
        },
      },
      env: noEnv,
    })

    expect(isAcceptableHost(config, '127.0.0.1:5123')).toBe(true)
    expect(isAcceptableHost(config, 'localhost:5123')).toBe(true)
    expect(isAcceptableHost(config, 'rebind.example.com')).toBe(false)
  })
})

describe('the request-level Host check (criterion 21)', () => {
  it('refuses a non-loopback Host on the default configuration, with no login in play', async () => {
    const config = looseConfig()
    expect(config.authRequired).toBe(false)
    const app = await buildServer({ config, database: migratedDatabase() })

    for (const { method, url } of [
      { method: 'GET' as const, url: '/api/tasks' },
      { method: 'GET' as const, url: '/api/config' },
      { method: 'POST' as const, url: '/api/jobs/classify/run' },
    ]) {
      const response = await app.inject({
        method,
        url,
        headers: { host: 'rebind.example.com' },
        ...(method === 'GET' ? {} : { payload: {} }),
      })

      expect(response.statusCode, `${method} ${url}`).toBe(403)
      expect(response.json(), `${method} ${url}`).toEqual({
        error: { code: 'forbidden', message: expect.any(String) },
      })
    }

    await app.close()
  })

  it('serves a loopback Host on the default configuration', async () => {
    const app = await buildServer({ config: looseConfig(), database: migratedDatabase() })

    const response = await app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { host: '127.0.0.1:5123' },
    })

    expect(response.statusCode).toBe(200)

    await app.close()
  })

  it('refuses a foreign Host where a public URL is configured, before the session check', async () => {
    const app = await buildServer({ config: exposedConfig(), database: migratedDatabase() })

    const response = await app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { host: 'rebind.example.com' },
    })

    // 403 rather than the 401 an unauthenticated request would otherwise get: the `Host` check
    // runs before the session check, because a request that is not addressed to this install has
    // no business being told whether its session would have been accepted.
    expect(response.statusCode).toBe(403)

    await app.close()
  })

  it('lets a loopback Host past the Host check where a public URL is configured', async () => {
    const app = await buildServer({ config: exposedConfig(), database: migratedDatabase() })

    const response = await app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { host: '127.0.0.1:5123' },
    })

    // 401, not 403: the request is addressed to an address this install does answer to, and what
    // it lacks is a session. The distinction is the whole of the fix, because the loopback names
    // are exactly the ones the MCP endpoint requires and used to be refused here first.
    expect(response.statusCode).toBe(401)

    await app.close()
  })

  it('names server.publicUrl in the refusal, which is the setting that fixes it', async () => {
    // An operator who fronts Caroline with a proxy and has not set `server.publicUrl` gets this
    // refusal on every request, and the message has to name the setting rather than only the
    // symptom: the forwarded-header refusal that does name it is behind this check and is never
    // reached.
    const app = await buildServer({ config: looseConfig(), database: migratedDatabase() })

    const response = await app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { host: 'caroline.example.com', 'x-forwarded-for': '203.0.113.5' },
    })

    expect(response.statusCode).toBe(403)
    expect(response.json().error.message).toContain('server.publicUrl')

    await app.close()
  })

  it('refuses a non-loopback Host on a route outside /api too', async () => {
    const app = await buildServer({ config: looseConfig(), database: migratedDatabase() })

    const response = await app.inject({
      method: 'GET',
      url: '/some-client-route',
      headers: { host: 'rebind.example.com' },
    })

    expect(response.statusCode).toBe(403)

    await app.close()
  })
})
