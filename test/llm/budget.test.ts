/**
 * The spending ceiling, enforced against the tokens `llm_calls` already holds and the reservations
 * held by the calls in flight. Spec 03, criteria 11 and 12.
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

const request = {
  system: 'Sort this item.',
  messages: [{ role: 'user' as const, content: 'Can you sign off the venue booking?' }],
  schema: classificationSchema,
  maxTokens: 512,
}

/**
 * A `fetch` that answers nothing until it is released, so every call made against it is genuinely
 * in flight at the same time rather than resolving one at a time.
 */
function heldFetch(inner: typeof globalThis.fetch) {
  let open = () => {}
  const held = new Promise<void>((resolve) => {
    open = resolve
  })

  const fetch: typeof globalThis.fetch = async (input, init) => {
    await held
    return inner(input, init)
  }

  return { fetch, release: () => open() }
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
  /**
   * Leaves 100 tokens of the million-token allowance unspent. That is enough for a call to pass
   * the check, because the check refuses only once the allowance has been reached, and far less
   * than the reservation any call takes, so the second concurrent call has to be refused.
   */
  const nearlySpent = 999_900

  it('lets one of several genuinely concurrent calls through, and refuses the rest', async () => {
    const database = migratedDatabase()
    spend(database, nearlySpent, noon)

    const stub = stubFetch([{ body: recordedPayload('anthropic-classification') }])
    const answers = heldFetch(stub.fetch)
    const runtime = createLlmRuntime({
      config: capped(),
      database,
      now: () => noon,
      fetch: answers.fetch,
    })
    const provider = runtime.for('classification')

    // Started together and left in flight together: nothing is answered until `release`, so the
    // three checks are all taken before any of the three rows can exist. This is the live path,
    // not a hypothetical: `runClassification` runs its candidates through `mapWithConcurrency`.
    const calls = [
      provider.complete(request),
      provider.complete(request),
      provider.complete(request),
    ]
    answers.release()
    const outcomes = await Promise.allSettled(calls)

    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1)
    expect(
      outcomes.filter(
        (outcome) => outcome.status === 'rejected' && outcome.reason instanceof LlmBudgetError,
      ),
    ).toHaveLength(2)

    // The two that were refused reached neither the network nor the cost table.
    expect(stub.requests).toHaveLength(1)
    expect(listLlmCalls(database)).toHaveLength(2)
  })

  it('gives the reservation back when the call fails, so a failure holds nothing for ever', async () => {
    const database = migratedDatabase()
    spend(database, nearlySpent, noon)

    const stub = stubFetch([{ status: 500, body: { error: { message: 'overloaded' } } }])
    const runtime = createLlmRuntime({
      config: capped(),
      database,
      now: () => noon,
      fetch: stub.fetch,
    })

    await expect(runtime.for('classification').complete(request)).rejects.toThrow()

    // The failed attempt recorded zero tokens, so the headroom is exactly what it was. A hold left
    // behind would read as the ceiling having been reached.
    expect(runtime.budgetRefusal('classification')).toBeNull()
  })

  it('holds nothing for a provider with no ceiling, so an uncapped install reserves nothing', () => {
    const database = migratedDatabase()
    const gate = createBudgetGate({
      config: loadConfig({
        file: { llm: { provider: 'anthropic', model: 'claude-sonnet-5' } },
        env: keys,
      }),
      database,
      now: () => noon,
    })

    const first = gate.reserve('anthropic', 1_000_000_000)
    expect('hold' in first).toBe(true)
    expect(gate.refusalFor('anthropic')).toBeNull()
  })
})

describe('the runtime, spec 03 criteria 11 and 13', () => {
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
