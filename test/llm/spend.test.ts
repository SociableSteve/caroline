/**
 * The spend view: by day, by purpose and by model, as an estimate in the configured currency with
 * the date its prices were checked. Spec 03, criterion 15.
 */
import { describe, expect, it } from 'vitest'
import { loadConfig } from '../../src/config/load.js'
import type { Config } from '../../src/config/schema.js'
import type { Database } from '../../src/db/connection.js'
import { recordLlmCall } from '../../src/db/repositories/llm-calls.js'
import type { LlmPurpose } from '../../src/domain/llm.js'
import { exchangeRates } from '../../src/domain/pricing.js'
import { spendReport } from '../../src/llm/spend.js'
import { migratedDatabase } from '../helpers/temp-database.js'

/** Midday UTC on the 15th of January 2026. */
const noon = Date.UTC(2026, 0, 15, 12)
const dayBefore = Date.UTC(2026, 0, 14, 12)

function config(budget: Record<string, unknown> = {}): Config {
  return loadConfig({
    file: {
      jobs: { timezone: 'UTC' },
      llm: {
        provider: 'anthropic',
        model: 'claude-sonnet-5',
        budget: { currency: 'USD', period: 'month', ...budget },
      },
    },
    env: { ANTHROPIC_API_KEY: 'k', OPENAI_API_KEY: 'k' } as NodeJS.ProcessEnv,
  })
}

interface Call {
  readonly at: number
  readonly purpose?: LlmPurpose
  readonly provider?: 'anthropic' | 'openai' | 'ollama'
  readonly model?: string
  readonly inputTokens?: number
  readonly outputTokens?: number
}

function record(database: Database, calls: readonly Call[]): void {
  for (const call of calls) {
    recordLlmCall(database, {
      provider: call.provider ?? 'anthropic',
      model: call.model ?? 'claude-sonnet-5',
      purpose: call.purpose ?? 'classification',
      startedAt: call.at,
      durationMs: 10,
      inputTokens: call.inputTokens ?? 0,
      outputTokens: call.outputTokens ?? 0,
      status: 'success',
    })
  }
}

/** claude-sonnet-5: $2 per million input, $10 per million output. */
describe('the three roll-ups', () => {
  const database = migratedDatabase()
  record(database, [
    { at: noon, purpose: 'classification', inputTokens: 1_000_000 },
    { at: noon, purpose: 'chat', model: 'claude-opus-5', outputTokens: 1_000_000 },
    { at: dayBefore, purpose: 'planning', outputTokens: 2_000_000 },
  ])

  const report = spendReport({ config: config(), database, now: () => noon })

  it('reports by day, most recent first, priced in the configured currency', () => {
    expect(report.byDay).toEqual([
      {
        day: '2026-01-15',
        usage: { calls: 2, inputTokens: 1_000_000, outputTokens: 1_000_000 },
        estimate: 27,
      },
      {
        day: '2026-01-14',
        usage: { calls: 1, inputTokens: 0, outputTokens: 2_000_000 },
        estimate: 20,
      },
    ])
  })

  it('reports by purpose', () => {
    expect(report.byPurpose.map((entry) => [entry.purpose, entry.estimate])).toEqual([
      ['chat', 25],
      ['classification', 2],
      ['planning', 20],
    ])
  })

  it('reports by model, which is the only grouping a price belongs to', () => {
    expect(report.byModel.map((entry) => [entry.model, entry.estimate])).toEqual([
      ['claude-opus-5', 25],
      ['claude-sonnet-5', 22],
    ])
  })

  it('says how old the prices behind the figures are', () => {
    expect(report.checkedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })
})

describe('the currency', () => {
  it('converts every figure at the committed rate, and dates the estimate by its stalest input', () => {
    const database = migratedDatabase()
    record(database, [{ at: noon, outputTokens: 1_000_000 }])

    const inPounds = spendReport({ config: config({ currency: 'GBP' }), database, now: () => noon })

    expect(inPounds.currency).toBe('GBP')
    expect(inPounds.byDay[0]?.estimate).toBeCloseTo(10 * exchangeRates.GBP.perUsd, 10)
    // The exchange rate is the older of the two here, so it is the date shown.
    expect(inPounds.checkedOn).toBe(exchangeRates.GBP.checkedOn)
  })
})

describe('a model the price table does not carry', () => {
  it('is reported as no estimate rather than as zero, and does not zero the group it is in', () => {
    const database = migratedDatabase()
    record(database, [
      { at: noon, model: 'claude-from-the-future', outputTokens: 1_000_000 },
      { at: noon, outputTokens: 1_000_000 },
    ])

    const report = spendReport({ config: config(), database, now: () => noon })
    const unpriced = report.byModel.find((entry) => entry.model === 'claude-from-the-future')

    expect(unpriced?.estimate).toBeNull()
    expect(unpriced?.usage.outputTokens).toBe(1_000_000)
    expect(report.byDay[0]?.estimate).toBe(10)
  })

  it('reports no date at all when nothing in the window is priced', () => {
    const database = migratedDatabase()
    record(database, [{ at: noon, model: 'claude-from-the-future', outputTokens: 1 }])

    expect(spendReport({ config: config(), database, now: () => noon }).checkedOn).toBeNull()
  })
})

describe('where each provider stands', () => {
  it('reports every provider, unlimited ones included, so "no ceiling" is legible', () => {
    const database = migratedDatabase()
    record(database, [{ at: noon, inputTokens: 400_000, outputTokens: 100_000 }])

    const report = spendReport({
      config: config({ anthropic: 10 }),
      database,
      now: () => noon,
    })

    expect(report.providers).toEqual([
      {
        provider: 'anthropic',
        limit: 10,
        tokens: 500_000,
        allowance: 1_000_000,
        estimate: 1.8,
      },
      { provider: 'openai', limit: 'unlimited', tokens: 0, allowance: null, estimate: null },
      { provider: 'ollama', limit: 'unlimited', tokens: 0, allowance: null, estimate: null },
    ])
  })

  it('counts an unlimited provider’s tokens too, rather than showing it as having spent nothing', () => {
    const database = migratedDatabase()
    record(database, [{ at: noon, inputTokens: 1_000 }])

    const report = spendReport({ config: config(), database, now: () => noon })

    expect(report.providers[0]).toMatchObject({ limit: 'unlimited', tokens: 1_000 })
  })
})

describe('the window', () => {
  it('covers the current period only, so last month is not in this month’s figure', () => {
    const database = migratedDatabase()
    record(database, [
      { at: Date.UTC(2025, 11, 31, 23), outputTokens: 5_000_000 },
      { at: noon, outputTokens: 1_000_000 },
    ])

    const report = spendReport({ config: config(), database, now: () => noon })

    expect(report.since).toBe(Date.UTC(2026, 0, 1))
    expect(report.byDay).toHaveLength(1)
    expect(report.byDay[0]?.estimate).toBe(10)
  })
})
