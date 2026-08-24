import { describe, expect, it } from 'vitest'
import {
  listLlmCalls,
  llmTokensForProvider,
  llmUsageBreakdown,
  recordLlmCall,
  type RecordLlmCallInput,
} from '../../../src/db/repositories/llm-calls.js'
import { migratedDatabase } from '../../helpers/temp-database.js'

const noon = Date.UTC(2026, 0, 15, 12)
const day = 24 * 60 * 60 * 1000

function aCall(over: Partial<RecordLlmCallInput> = {}): RecordLlmCallInput {
  return {
    provider: 'anthropic',
    model: 'claude-sonnet-5',
    purpose: 'classification',
    startedAt: noon,
    durationMs: 1_240,
    inputTokens: 412,
    outputTokens: 37,
    status: 'success',
    ...over,
  }
}

describe('recording a call', () => {
  it('keeps everything spec 03 asks for', () => {
    const database = migratedDatabase()

    const written = recordLlmCall(database, aCall())

    expect(listLlmCalls(database)).toEqual([{ ...written, error: null }])
    expect(written.id).not.toBe('')
  })

  it('keeps the failure message of a call that went wrong', () => {
    const database = migratedDatabase()

    recordLlmCall(database, aCall({ status: 'error', error: 'the provider answered 500' }))

    expect(listLlmCalls(database)[0]).toMatchObject({
      status: 'error',
      error: 'the provider answered 500',
    })
  })

  it('refuses a status the domain does not define', () => {
    const database = migratedDatabase()

    expect(() =>
      recordLlmCall(database, aCall({ status: 'nearly' as RecordLlmCallInput['status'] })),
    ).toThrow(/constraint/i)
  })
})

describe('listing calls', () => {
  it('answers most recent first', () => {
    const database = migratedDatabase()
    recordLlmCall(database, aCall({ startedAt: noon }))
    recordLlmCall(database, aCall({ startedAt: noon + 1_000 }))

    expect(listLlmCalls(database).map((call) => call.startedAt)).toEqual([noon + 1_000, noon])
  })

  it('narrows to one purpose', () => {
    const database = migratedDatabase()
    recordLlmCall(database, aCall({ purpose: 'classification' }))
    recordLlmCall(database, aCall({ purpose: 'chat' }))

    expect(listLlmCalls(database, { purpose: 'chat' })).toHaveLength(1)
  })

  it('narrows to a window', () => {
    const database = migratedDatabase()
    recordLlmCall(database, aCall({ startedAt: noon - day }))
    recordLlmCall(database, aCall({ startedAt: noon }))

    expect(listLlmCalls(database, { since: noon })).toHaveLength(1)
  })
})

describe('usage rollups', () => {
  /**
   * One leaf per day, purpose, provider and model. Every view the spend report builds is rolled up
   * from these, so the day boundary and the token totals are asserted here once rather than in
   * each of them. Spec 03.
   */
  it('adds up a leaf, including the calls that failed after spending tokens', () => {
    const database = migratedDatabase()
    recordLlmCall(database, aCall({ inputTokens: 100, outputTokens: 10 }))
    recordLlmCall(database, aCall({ inputTokens: 200, outputTokens: 20, status: 'invalid' }))

    expect(llmUsageBreakdown(database, { timeZone: 'UTC' })).toEqual([
      {
        day: '2026-01-15',
        purpose: 'classification',
        provider: 'anthropic',
        model: 'claude-sonnet-5',
        usage: { calls: 2, inputTokens: 300, outputTokens: 30 },
      },
    ])
  })

  it('separates the days by the local calendar, not by UTC', () => {
    const database = migratedDatabase()
    // 23:00 UTC is the next day anywhere an hour or more east of Greenwich.
    recordLlmCall(database, aCall({ startedAt: Date.UTC(2026, 0, 15, 23) }))

    expect(llmUsageBreakdown(database, { timeZone: 'UTC' })[0]?.day).toBe('2026-01-15')
    expect(llmUsageBreakdown(database, { timeZone: 'Europe/Berlin' })[0]?.day).toBe('2026-01-16')
  })

  /**
   * The reason this groups by time zone rather than by a single offset. New York is UTC-5 in
   * January and UTC-4 in July, so one offset chosen when the query runs files one of these
   * two calls under the wrong day whichever offset it picks.
   */
  it('uses the offset in force at each call, not one offset for the whole table', () => {
    const database = migratedDatabase()
    // 04:30 UTC: still the previous evening in New York, in winter and in summer alike.
    recordLlmCall(database, aCall({ startedAt: Date.parse('2026-01-15T04:30:00Z') }))
    recordLlmCall(database, aCall({ startedAt: Date.parse('2026-07-15T03:30:00Z') }))

    expect(
      llmUsageBreakdown(database, { timeZone: 'America/New_York' })
        .map((leaf) => leaf.day)
        .toSorted(),
    ).toEqual(['2026-01-14', '2026-07-14'])
  })

  it('keeps each purpose apart, which is the per-job view', () => {
    const database = migratedDatabase()
    recordLlmCall(database, aCall({ purpose: 'classification', outputTokens: 10 }))
    recordLlmCall(database, aCall({ purpose: 'classification', outputTokens: 20 }))
    recordLlmCall(database, aCall({ purpose: 'chat', outputTokens: 5 }))

    expect(
      llmUsageBreakdown(database, { timeZone: 'UTC' })
        .map((leaf) => [leaf.purpose, leaf.usage.outputTokens] as const)
        .toSorted((left, right) => left[0].localeCompare(right[0])),
    ).toEqual([
      ['chat', 5],
      ['classification', 30],
    ])
  })

  it('answers nothing at all with an empty list rather than a zero row', () => {
    const database = migratedDatabase()

    expect(llmUsageBreakdown(database)).toEqual([])
  })

  it('counts a window from an instant, and only the named provider', () => {
    // The sum the spending ceiling is enforced against. Spec 03, criteria 11 and 12.
    const database = migratedDatabase()
    recordLlmCall(database, aCall({ startedAt: noon - day, inputTokens: 5, outputTokens: 0 }))
    recordLlmCall(database, aCall({ inputTokens: 100, outputTokens: 10 }))
    recordLlmCall(database, aCall({ provider: 'openai', inputTokens: 7, outputTokens: 0 }))

    expect(llmTokensForProvider(database, { provider: 'anthropic', since: noon })).toBe(110)
    expect(llmTokensForProvider(database, { provider: 'openai', since: noon })).toBe(7)
    expect(llmTokensForProvider(database, { provider: 'ollama', since: noon })).toBe(0)
  })
})
