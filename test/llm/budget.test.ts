/**
 * The spending ceiling, enforced against the tokens `llm_calls` already holds. Spec 03, criteria
 * 11 and 12.
 */
import { describe, expect, it } from 'vitest'
import { loadConfig } from '../../src/config/load.js'
import type { Config } from '../../src/config/schema.js'
import type { Database } from '../../src/db/connection.js'
import { listLlmCalls, recordLlmCall } from '../../src/db/repositories/llm-calls.js'
import { createBudgetGate, LlmBudgetError } from '../../src/llm/budget.js'
import { createLlmRuntime } from '../../src/llm/index.js'
import { migratedDatabase } from '../helpers/temp-database.js'
import { classificationSchema, recordedPayload, stubFetch } from '../helpers/llm.js'

const keys = { ANTHROPIC_API_KEY: 'sk-ant', OPENAI_API_KEY: 'sk-oai' } as NodeJS.ProcessEnv

/** Midday UTC on the 15th of January 2026. */
const noon = Date.UTC(2026, 0, 15, 12)

/** claude-sonnet-5 is $10 per million output tokens, so $10 buys exactly one million. */
function capped(file: Record<string, unknown> = {}): Config {
  return loadConfig({
    file: {
      jobs: { timezone: 'UTC' },
      llm: {
        provider: 'anthropic',
        model: 'claude-sonnet-5',
        budget: { currency: 'USD', period: 'month', anthropic: 10 },
        ...file,
      },
    },
    env: keys,
  })
}

function spend(database: Database, tokens: number, at: number, provider = 'anthropic' as const) {
  recordLlmCall(database, {
    provider,
    model: 'claude-sonnet-5',
    purpose: 'classification',
    startedAt: at,
    durationMs: 10,
    inputTokens: tokens,
    outputTokens: 0,
    status: 'success',
  })
}

describe('the gate, spec 03 criterion 11', () => {
  it('lets a call through while the recorded tokens are under the allowance', () => {
    const database = migratedDatabase()
    spend(database, 999_999, noon)

    const gate = createBudgetGate({ config: capped(), database, now: () => noon })

    expect(gate.refusalFor('anthropic')).toBeNull()
  })

  it('refuses once the recorded tokens reach it, naming the provider and the ceiling', () => {
    const database = migratedDatabase()
    spend(database, 1_000_000, noon)

    const refusal = createBudgetGate({ config: capped(), database, now: () => noon }).refusalFor(
      'anthropic',
    )

    expect(refusal).toContain('anthropic')
    expect(refusal).toContain('10 USD')
  })

  it('leaves a provider under its own ceiling alone', () => {
    const database = migratedDatabase()
    spend(database, 5_000_000, noon)

    const config = capped({
      budget: { currency: 'USD', period: 'month', anthropic: 10, openai: 10 },
      overrides: { chat: { provider: 'openai', model: 'gpt-5' } },
    })
    const gate = createBudgetGate({ config, database, now: () => noon })

    expect(gate.refusalFor('anthropic')).not.toBeNull()
    expect(gate.refusalFor('openai')).toBeNull()
  })

  it('counts only the current period, so a new month starts clear', () => {
    const database = migratedDatabase()
    spend(database, 5_000_000, Date.UTC(2025, 11, 31, 23))

    const gate = createBudgetGate({ config: capped(), database, now: () => noon })

    expect(gate.refusalFor('anthropic')).toBeNull()
  })

  it('never consults the database for a provider with no ceiling', () => {
    // Spec 03 criterion 9: an install that has configured nothing behaves as it did, including
    // making no query it did not make before. A gate with no database at all stands in for that.
    const gate = createBudgetGate({
      config: loadConfig({ file: { llm: { provider: 'anthropic', model: 'x' } }, env: keys }),
      now: () => noon,
    })

    expect(gate.refusalFor('anthropic')).toBeNull()
  })
})

describe('the gate under concurrency, spec 03 criterion 12', () => {
  it('counts and compares in one transaction, so a reading is never taken mid-write', () => {
    const database = migratedDatabase()
    const config = capped()
    const gate = createBudgetGate({ config, database, now: () => noon })

    // `node:sqlite` is synchronous, so the proof is that nothing can interleave with the
    // transaction rather than that a race was observed. What is asserted here is the consequence:
    // every check taken against the same committed total agrees, and the check made after the row
    // that crosses the line refuses. Three calls in flight cannot all be told yes.
    spend(database, 600_000, noon)
    const first = gate.refusalFor('anthropic')
    spend(database, 600_000, noon)
    const second = gate.refusalFor('anthropic')

    expect(first).toBeNull()
    expect(second).not.toBeNull()
  })
})

describe('the runtime, spec 03 criteria 11 and 13', () => {
  const request = {
    system: 'Sort this item.',
    messages: [{ role: 'user' as const, content: 'Can you sign off the venue booking?' }],
    schema: classificationSchema,
    maxTokens: 512,
  }

  it('says why a purpose cannot call before anything is attempted', () => {
    const database = migratedDatabase()
    spend(database, 1_000_000, noon)

    const runtime = createLlmRuntime({ config: capped(), database, now: () => noon })

    expect(runtime.budgetRefusal('classification')).toContain('anthropic')
    expect(runtime.isConfigured('classification')).toBe(true)
  })

  it('refuses the call itself, spending nothing and recording nothing', async () => {
    const database = migratedDatabase()
    spend(database, 1_000_000, noon)
    const before = listLlmCalls(database).length

    const stub = stubFetch([{ body: recordedPayload('anthropic-classification') }])
    const runtime = createLlmRuntime({
      config: capped(),
      database,
      now: () => noon,
      fetch: stub.fetch,
    })

    await expect(runtime.for('classification').complete(request)).rejects.toBeInstanceOf(
      LlmBudgetError,
    )
    expect(stub.requests).toHaveLength(0)
    expect(listLlmCalls(database)).toHaveLength(before)
  })

  it('lets the call through while there is allowance left', async () => {
    const database = migratedDatabase()
    const stub = stubFetch([{ body: recordedPayload('anthropic-classification') }])
    const runtime = createLlmRuntime({
      config: capped(),
      database,
      now: () => noon,
      fetch: stub.fetch,
    })

    await expect(runtime.for('classification').complete(request)).resolves.toBeDefined()
    expect(runtime.budgetRefusal('classification')).toBeNull()
  })
})
