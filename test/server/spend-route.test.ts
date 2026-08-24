/**
 * `GET /api/spend`, which is what the Jobs surface reads to show what the models cost. Spec 03,
 * criterion 15.
 */
import { describe, expect, it } from 'vitest'
import { loadConfig } from '../../src/config/load.js'
import { recordLlmCall } from '../../src/db/repositories/llm-calls.js'
import { migratedDatabase } from '../helpers/temp-database.js'
import { REQUEST_TIME, testServer } from '../helpers/test-server.js'

describe('GET /api/spend', () => {
  it('answers with an empty report on a clean checkout rather than a 404', async () => {
    const { app } = await testServer()

    const response = await app.inject({ method: 'GET', url: '/api/spend' })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      currency: 'USD',
      period: 'month',
      byDay: [],
      byPurpose: [],
      byModel: [],
      checkedOn: null,
    })
  })

  it('reports the period’s calls three ways, priced, with where each provider stands', async () => {
    const database = migratedDatabase()
    recordLlmCall(database, {
      provider: 'anthropic',
      model: 'claude-sonnet-5',
      purpose: 'classification',
      startedAt: REQUEST_TIME,
      durationMs: 10,
      inputTokens: 500_000,
      outputTokens: 100_000,
      status: 'success',
    })

    const { app } = await testServer({
      database,
      config: loadConfig({
        file: {
          database: { path: ':memory:' },
          jobs: { timezone: 'Europe/London' },
          llm: {
            provider: 'anthropic',
            model: 'claude-sonnet-5',
            budget: { currency: 'USD', period: 'month', anthropic: 20 },
          },
        },
        env: { ANTHROPIC_API_KEY: 'sk-ant' } as NodeJS.ProcessEnv,
      }),
    })

    const body = await app.inject({ method: 'GET', url: '/api/spend' }).then((it) => it.json())

    // $2 per million input and $10 per million output: 500k in and 100k out is $2.
    expect(body.byDay).toEqual([
      {
        day: '2026-06-01',
        usage: { calls: 1, inputTokens: 500_000, outputTokens: 100_000 },
        estimate: 2,
      },
    ])
    expect(body.byPurpose).toEqual([
      {
        purpose: 'classification',
        usage: { calls: 1, inputTokens: 500_000, outputTokens: 100_000 },
        estimate: 2,
      },
    ])
    expect(body.byModel[0]).toMatchObject({ provider: 'anthropic', model: 'claude-sonnet-5' })
    expect(body.checkedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/)

    // "no ceiling" is the client's word for this, and it needs the state to be said rather than
    // inferred from an absence. Spec 03, criterion 15.
    expect(body.providers).toEqual([
      { provider: 'anthropic', limit: 20, tokens: 600_000, allowance: 2_000_000, estimate: 2 },
      { provider: 'openai', limit: 'unlimited', tokens: 0, allowance: null, estimate: null },
      { provider: 'ollama', limit: 'unlimited', tokens: 0, allowance: null, estimate: null },
    ])
  })
})
