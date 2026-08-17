import { describe, expect, it } from 'vitest'
import { loadConfig } from '../../src/config/load.js'
import { buildServer } from '../../src/server/app.js'
import { migratedDatabase } from '../helpers/temp-database.js'
import { REDACTED } from '../../src/config/redact.js'

const secrets = {
  ANTHROPIC_API_KEY: 'sk-ant-supersecret',
  GITHUB_TOKEN: 'ghp_supersecret',
  GOOGLE_CLIENT_SECRET: 'google-supersecret',
  CAROLINE_AUTH_CLIENT_SECRET: 'access-supersecret',
} as NodeJS.ProcessEnv

describe('GET /api/config', () => {
  it('returns the full effective configuration', async () => {
    const config = loadConfig({ file: { server: { port: 6000 } }, env: {} as NodeJS.ProcessEnv })
    const app = await buildServer({ config, database: migratedDatabase() })

    const body = (await app.inject({ method: 'GET', url: '/api/config' })).json()

    expect(body.server.port).toBe(6000)
    expect(body.privacy.storeContent).toBe('metadata')
    await app.close()
  })

  it('redacts every secret field (spec 09 criterion 8)', async () => {
    const config = loadConfig({ file: { llm: { provider: 'anthropic' } }, env: secrets })
    const app = await buildServer({ config, database: migratedDatabase() })

    const response = await app.inject({ method: 'GET', url: '/api/config' })

    for (const secret of Object.values(secrets) as string[]) {
      expect(response.body).not.toContain(secret)
    }
    expect(response.json().llm.apiKey).toBe(REDACTED)
    await app.close()
  })

  /** Spec 13, criterion 25: the `auth` block is present with `clientSecret` redacted and
   * everything else about it visible. */
  it('shows the auth block with clientSecret redacted and everything else present', async () => {
    const config = loadConfig({
      file: { auth: { provider: { label: 'Test IdP', clientId: 'a-client-id' } } },
      env: { ...secrets },
    })
    const app = await buildServer({ config, database: migratedDatabase() })

    const body = (await app.inject({ method: 'GET', url: '/api/config' })).json()

    expect(body.auth).toMatchObject({
      mode: 'auto',
      allow: [],
      sessionIdleDays: 7,
      sessionMaxDays: 30,
      provider: {
        label: 'Test IdP',
        issuer: 'https://accounts.google.com',
        clientId: 'a-client-id',
        clientSecret: REDACTED,
        scopes: ['openid', 'email'],
      },
    })
    await app.close()
  })
})

describe('the standard error shape', () => {
  it('returns { error: { code, message } } for an unknown route', async () => {
    const app = await buildServer({
      config: loadConfig({ file: null, env: {} as NodeJS.ProcessEnv }),
      database: migratedDatabase(),
    })

    const response = await app.inject({ method: 'GET', url: '/api/nope' })

    expect(response.statusCode).toBe(404)
    expect(response.json()).toEqual({
      error: { code: 'not_found', message: expect.any(String) },
    })
    await app.close()
  })

  it('echoes no part of the request URL in an unknown-route message', async () => {
    const app = await buildServer({
      config: loadConfig({ file: null, env: {} as NodeJS.ProcessEnv }),
      database: migratedDatabase(),
    })

    const response = await app.inject({ method: 'GET', url: '/api/nope?token=anything-at-all' })

    const message = response.json().error.message as string
    expect(message).toContain('GET')
    expect(message).not.toContain('/api/nope')
    expect(message).not.toContain('anything-at-all')
    await app.close()
  })

  it('returns 400 in the standard shape when a request violates its schema', async () => {
    const app = await buildServer({
      config: loadConfig({ file: null, env: {} as NodeJS.ProcessEnv }),
      database: migratedDatabase(),
    })

    const response = await app.inject({ method: 'GET', url: '/api/health?verbose=maybe' })

    expect(response.statusCode).toBe(400)
    const body = response.json()
    expect(body.error.code).toBe('bad_request')
    expect(typeof body.error.message).toBe('string')
    await app.close()
  })

  it('does not leak a secret through an error message', async () => {
    const config = loadConfig({ file: null, env: secrets })
    const app = await buildServer({ config, database: migratedDatabase() })

    const response = await app.inject({ method: 'GET', url: '/api/ghp_supersecret' })

    expect(response.body).not.toContain('ghp_supersecret')
    await app.close()
  })
})
