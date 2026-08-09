import { describe, expect, it } from 'vitest'
import { loadConfig } from '../../src/config/load.js'
import { buildServer } from '../../src/server/app.js'

const cleanCheckout = loadConfig({ file: null, env: {} as NodeJS.ProcessEnv })

describe('GET /api/health on a clean checkout with no credentials', () => {
  it('answers 200 rather than failing', async () => {
    const app = await buildServer({ config: cleanCheckout })

    const response = await app.inject({ method: 'GET', url: '/api/health' })

    expect(response.statusCode).toBe(200)
    await app.close()
  })

  it('reports every integration as not configured', async () => {
    const app = await buildServer({ config: cleanCheckout })

    const response = await app.inject({ method: 'GET', url: '/api/health' })
    const body = response.json()

    expect(body.status).toBe('ok')
    expect(body.integrations).toEqual({
      github: { configured: false, status: 'not configured' },
      google: { configured: false, status: 'not configured' },
      llm: { configured: false, status: 'not configured' },
    })
    await app.close()
  })

  it('reports its version and uptime', async () => {
    const app = await buildServer({ config: cleanCheckout })

    const body = (await app.inject({ method: 'GET', url: '/api/health' })).json()

    expect(typeof body.version).toBe('string')
    expect(typeof body.uptimeSeconds).toBe('number')
    await app.close()
  })
})

describe('GET /api/health with integrations configured', () => {
  it('reports a configured integration as configured', async () => {
    const config = loadConfig({
      file: { llm: { provider: 'anthropic' } },
      env: { GITHUB_TOKEN: 'ghp_x', ANTHROPIC_API_KEY: 'sk-ant-x' } as NodeJS.ProcessEnv,
    })
    const app = await buildServer({ config })

    const body = (await app.inject({ method: 'GET', url: '/api/health' })).json()

    expect(body.integrations.github).toEqual({ configured: true, status: 'configured' })
    expect(body.integrations.llm).toEqual({ configured: true, status: 'configured' })
    expect(body.integrations.google).toEqual({ configured: false, status: 'not configured' })
    await app.close()
  })

  it('never leaks a secret into the health payload', async () => {
    const config = loadConfig({
      file: null,
      env: { GITHUB_TOKEN: 'ghp_supersecret' } as NodeJS.ProcessEnv,
    })
    const app = await buildServer({ config })

    const response = await app.inject({ method: 'GET', url: '/api/health' })

    expect(response.body).not.toContain('ghp_supersecret')
    await app.close()
  })
})
