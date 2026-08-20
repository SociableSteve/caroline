import { describe, expect, it } from 'vitest'
import { loadConfig } from '../../src/config/load.js'
import { buildServer } from '../../src/server/app.js'
import { migratedDatabase } from '../helpers/temp-database.js'
import { NO_BUILT_WEB_ROOT } from '../helpers/test-server.js'
import { UNMATCHED_ROUTE } from '../../src/server/log-redaction.js'
import { captureLog } from '../helpers/log-capture.js'

const secrets = {
  ANTHROPIC_API_KEY: 'sk-ant-supersecret',
  GITHUB_TOKEN: 'ghp_supersecret',
  CAROLINE_AUTH_CLIENT_SECRET: 'access-supersecret',
} as NodeJS.ProcessEnv

describe('request URLs never reach a log line', () => {
  it('logs the matched route, not the URL the caller sent', async () => {
    const { lines, stream } = captureLog()
    const config = loadConfig({ file: null, env: secrets })
    const app = await buildServer({
      config,
      database: migratedDatabase(),
      logger: { level: 'info', stream },
    })

    await app.inject({ method: 'GET', url: '/api/health?verbose=true&token=anything-at-all' })
    await app.close()

    const logged = lines.join('\n')
    expect(logged).toContain('"route":"/api/health"')
    expect(logged).not.toContain('anything-at-all')
    expect(logged).not.toContain('verbose=true')
    expect(logged).not.toContain('?')
  })

  it('logs no URL bytes at all for a request that matched no route', async () => {
    const { lines, stream } = captureLog()
    const config = loadConfig({ file: null, env: secrets })
    const app = await buildServer({
      config,
      database: migratedDatabase(),
      logger: { level: 'info', stream },
      webRoot: NO_BUILT_WEB_ROOT,
    })

    await app.inject({ method: 'GET', url: '/api/no-such-route-abcdef' })
    await app.close()

    const logged = lines.join('\n')
    expect(logged).toContain(UNMATCHED_ROUTE)
    expect(logged).not.toContain('no-such-route-abcdef')
  })
})

describe('secrets are redacted before the log line is serialised', () => {
  it('redacts a secret whose characters JSON escaping would rewrite', async () => {
    const secretNeedingEscapes = 'tok"en\\value'
    const { lines, stream } = captureLog()
    const config = loadConfig({
      file: null,
      env: { CAROLINE_AUTH_CLIENT_SECRET: secretNeedingEscapes } as NodeJS.ProcessEnv,
    })
    const app = await buildServer({
      config,
      database: migratedDatabase(),
      logger: { level: 'info', stream },
    })

    app.get('/api/boom', async () => {
      throw new Error(`upstream rejected ${secretNeedingEscapes}`)
    })

    await app.inject({ method: 'GET', url: '/api/boom' })
    await app.close()

    const logged = lines.join('\n')
    const jsonEscaped = JSON.stringify(secretNeedingEscapes).slice(1, -1)
    expect(logged).not.toContain(secretNeedingEscapes)
    expect(logged).not.toContain(jsonEscaped)
  })

  it('redacts a secret logged as a structured field', async () => {
    const { lines, stream } = captureLog()
    const config = loadConfig({ file: null, env: secrets })
    const app = await buildServer({
      config,
      database: migratedDatabase(),
      logger: { level: 'info', stream },
    })

    app.log.info({ upstream: { token: 'ghp_supersecret' } }, 'calling upstream')
    await app.close()

    expect(lines.join('\n')).not.toContain('ghp_supersecret')
  })

  it('redacts a secret appearing in the log message itself', async () => {
    const { lines, stream } = captureLog()
    const config = loadConfig({ file: null, env: secrets })
    const app = await buildServer({
      config,
      database: migratedDatabase(),
      logger: { level: 'info', stream },
    })

    app.log.info('calling upstream with ghp_supersecret')
    await app.close()

    expect(lines.join('\n')).not.toContain('ghp_supersecret')
  })
})

describe('no secret reaches a log line (spec 09 criterion 6)', () => {
  it('keeps secrets out of request logging, even when one appears in the URL', async () => {
    const { lines, stream } = captureLog()
    const config = loadConfig({ file: null, env: secrets })
    const app = await buildServer({
      config,
      database: migratedDatabase(),
      logger: { level: 'info', stream },
    })

    await app.inject({ method: 'GET', url: '/api/health?token=ghp_supersecret' })
    await app.inject({ method: 'GET', url: '/api/sk-ant-supersecret' })
    await app.close()

    const logged = lines.join('\n')
    for (const secret of Object.values(secrets) as string[]) {
      expect(logged).not.toContain(secret)
    }
  })

  it('keeps a percent-encoded secret out of request logging', async () => {
    const secretWithReservedChars = 'access+token/value'
    const { lines, stream } = captureLog()
    const config = loadConfig({
      file: null,
      env: { CAROLINE_AUTH_CLIENT_SECRET: secretWithReservedChars } as NodeJS.ProcessEnv,
    })
    const app = await buildServer({
      config,
      database: migratedDatabase(),
      logger: { level: 'info', stream },
    })

    const encoded = encodeURIComponent(secretWithReservedChars)
    await app.inject({ method: 'GET', url: `/api/health?token=${encoded}` })
    await app.close()

    expect(lines.join('\n')).not.toContain(encoded)
  })

  it('keeps a lower-case percent-encoded secret out of request logging', async () => {
    const secretWithReservedChars = 'access+token/value'
    const { lines, stream } = captureLog()
    const config = loadConfig({
      file: null,
      env: { CAROLINE_AUTH_CLIENT_SECRET: secretWithReservedChars } as NodeJS.ProcessEnv,
    })
    const app = await buildServer({
      config,
      database: migratedDatabase(),
      logger: { level: 'info', stream },
    })

    await app.inject({ method: 'GET', url: '/api/health?token=access%2btoken%2fvalue' })
    await app.close()

    expect(lines.join('\n')).not.toContain('access%2btoken%2fvalue')
  })

  it('keeps a percent-encoded secret in the path out of request logging', async () => {
    const secretInPath = 'access-supersecret'
    const { lines, stream } = captureLog()
    const config = loadConfig({ file: null, env: secrets })
    const app = await buildServer({
      config,
      database: migratedDatabase(),
      logger: { level: 'info', stream },
    })

    const percentEncodedPerCharacter = [...secretInPath]
      .map((character) => `%${character.charCodeAt(0).toString(16).padStart(2, '0')}`)
      .join('')
    await app.inject({ method: 'GET', url: `/api/${percentEncodedPerCharacter}` })
    await app.close()

    expect(lines.join('\n')).not.toContain(percentEncodedPerCharacter)
  })

  it('redacts a secret used as a log field name', async () => {
    const secretNeedingEscapes = 'tok"en\\value'
    const { lines, stream } = captureLog()
    const config = loadConfig({
      file: null,
      env: { CAROLINE_AUTH_CLIENT_SECRET: secretNeedingEscapes } as NodeJS.ProcessEnv,
    })
    const app = await buildServer({
      config,
      database: migratedDatabase(),
      logger: { level: 'info', stream },
    })

    app.log.info({ [secretNeedingEscapes]: 'value' }, 'calling upstream')
    await app.close()

    const logged = lines.join('\n')
    const jsonEscaped = JSON.stringify(secretNeedingEscapes).slice(1, -1)
    expect(logged).not.toContain(secretNeedingEscapes)
    expect(logged).not.toContain(jsonEscaped)
  })

  it('redacts every occurrence of an object referenced more than once', async () => {
    const secretNeedingEscapes = 'tok"en\\value'
    const { lines, stream } = captureLog()
    const config = loadConfig({
      file: null,
      env: { CAROLINE_AUTH_CLIENT_SECRET: secretNeedingEscapes } as NodeJS.ProcessEnv,
    })
    const app = await buildServer({
      config,
      database: migratedDatabase(),
      logger: { level: 'info', stream },
    })

    const sharedCredentials = { token: secretNeedingEscapes }
    app.log.info({ primary: sharedCredentials, fallback: sharedCredentials }, 'calling upstream')
    await app.close()

    const logged = lines.join('\n')
    const jsonEscaped = JSON.stringify(secretNeedingEscapes).slice(1, -1)
    expect(logged).not.toContain(secretNeedingEscapes)
    expect(logged).not.toContain(jsonEscaped)
  })

  it('redacts a secret held by an object that is not a plain object', async () => {
    const secretNeedingEscapes = 'tok"en\\value'
    class Credentials {
      constructor(readonly token: string) {}
    }
    const { lines, stream } = captureLog()
    const config = loadConfig({
      file: null,
      env: { CAROLINE_AUTH_CLIENT_SECRET: secretNeedingEscapes } as NodeJS.ProcessEnv,
    })
    const app = await buildServer({
      config,
      database: migratedDatabase(),
      logger: { level: 'info', stream },
    })

    app.log.info({ upstream: new Credentials(secretNeedingEscapes) }, 'calling upstream')
    app.log.info({ pool: [new Credentials(secretNeedingEscapes)] }, 'calling upstream')
    await app.close()

    const logged = lines.join('\n')
    const jsonEscaped = JSON.stringify(secretNeedingEscapes).slice(1, -1)
    expect(logged).not.toContain(secretNeedingEscapes)
    expect(logged).not.toContain(jsonEscaped)
    expect(logged).toContain('[redacted]')
  })

  it('redacts, rather than silently drops, an own __proto__ field', async () => {
    const secretNeedingEscapes = 'tok"en\\value'
    const { lines, stream } = captureLog()
    const config = loadConfig({
      file: null,
      env: { CAROLINE_AUTH_CLIENT_SECRET: secretNeedingEscapes } as NodeJS.ProcessEnv,
    })
    const app = await buildServer({
      config,
      database: migratedDatabase(),
      logger: { level: 'info', stream },
    })

    // JSON.parse is how an own, enumerable `__proto__` reaches a log payload in practice:
    // an upstream response parsed and then logged. An object literal would set the
    // prototype instead of creating the field, so the fixture has to come from real JSON.
    const parsedUpstreamBody: unknown = JSON.parse(
      `{"__proto__":{"token":${JSON.stringify(secretNeedingEscapes)}}}`,
    )
    app.log.info({ upstream: parsedUpstreamBody }, 'calling upstream')
    await app.close()

    const logged = lines.join('\n')
    const jsonEscaped = JSON.stringify(secretNeedingEscapes).slice(1, -1)
    expect(logged).not.toContain(secretNeedingEscapes)
    expect(logged).not.toContain(jsonEscaped)
    expect(logged).toContain('__proto__')
    expect(logged).toContain('[redacted]')
  })

  it('redacts a secret held by an error nested inside a payload', async () => {
    const secretNeedingEscapes = 'tok"en\\value'
    class UpstreamError extends Error {
      constructor(readonly token: string) {
        super('upstream rejected')
      }
      toJSON() {
        return { message: this.message, token: this.token }
      }
    }
    const { lines, stream } = captureLog()
    const config = loadConfig({
      file: null,
      env: { CAROLINE_AUTH_CLIENT_SECRET: secretNeedingEscapes } as NodeJS.ProcessEnv,
    })
    const app = await buildServer({
      config,
      database: migratedDatabase(),
      logger: { level: 'info', stream },
    })

    app.log.info({ cause: new UpstreamError(secretNeedingEscapes) }, 'call failed')
    await app.close()

    const logged = lines.join('\n')
    const jsonEscaped = JSON.stringify(secretNeedingEscapes).slice(1, -1)
    expect(logged).not.toContain(secretNeedingEscapes)
    expect(logged).not.toContain(jsonEscaped)
    expect(logged).toContain('[redacted]')
  })

  it('still lets the error serialiser shape an error, redacted', async () => {
    const { lines, stream } = captureLog()
    const config = loadConfig({ file: null, env: secrets })
    const app = await buildServer({
      config,
      database: migratedDatabase(),
      logger: { level: 'info', stream },
    })

    app.log.error({ err: new Error('upstream rejected ghp_supersecret') }, 'call failed')
    await app.close()

    const logged = lines.join('\n')
    expect(logged).toContain('"type":"Error"')
    expect(logged).toContain('upstream rejected [redacted]')
    expect(logged).not.toContain('ghp_supersecret')
  })

  it('keeps secrets out of a logged error message', async () => {
    const { lines, stream } = captureLog()
    const config = loadConfig({ file: null, env: secrets })
    const app = await buildServer({
      config,
      database: migratedDatabase(),
      logger: { level: 'info', stream },
    })

    app.get('/api/boom', async () => {
      throw new Error('upstream rejected token ghp_supersecret')
    })

    const response = await app.inject({ method: 'GET', url: '/api/boom' })
    await app.close()

    expect(response.statusCode).toBe(500)
    expect(response.body).not.toContain('ghp_supersecret')
    expect(lines.join('\n')).not.toContain('ghp_supersecret')
  })
})
