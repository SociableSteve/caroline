import { describe, expect, it } from 'vitest'
import {
  listLlmCalls,
  llmUsageByDay,
  llmUsageByPurpose,
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
  it('adds up a day, including the calls that failed after spending tokens', () => {
    const database = migratedDatabase()
    recordLlmCall(database, aCall({ inputTokens: 100, outputTokens: 10 }))
    recordLlmCall(database, aCall({ inputTokens: 200, outputTokens: 20, status: 'invalid' }))

    const [today] = llmUsageByDay(database, { offsetMinutes: 0 })

    expect(today).toEqual({
      day: '2026-01-15',
      usage: { calls: 2, inputTokens: 300, outputTokens: 30 },
    })
  })

  it('separates the days by the local calendar, not by UTC', () => {
    const database = migratedDatabase()
    // 23:00 UTC is the next day anywhere an hour or more east of Greenwich.
    recordLlmCall(database, aCall({ startedAt: Date.UTC(2026, 0, 15, 23) }))

    expect(llmUsageByDay(database, { offsetMinutes: 0 })[0]?.day).toBe('2026-01-15')
    expect(llmUsageByDay(database, { offsetMinutes: 120 })[0]?.day).toBe('2026-01-16')
  })

  it('adds up each purpose separately, which is the per-job view', () => {
    const database = migratedDatabase()
    recordLlmCall(database, aCall({ purpose: 'classification', outputTokens: 10 }))
    recordLlmCall(database, aCall({ purpose: 'classification', outputTokens: 20 }))
    recordLlmCall(database, aCall({ purpose: 'chat', outputTokens: 5 }))

    expect(llmUsageByPurpose(database)).toEqual([
      { purpose: 'chat', usage: { calls: 1, inputTokens: 412, outputTokens: 5 } },
      {
        purpose: 'classification',
        usage: { calls: 2, inputTokens: 824, outputTokens: 30 },
      },
    ])
  })

  it('answers nothing at all with an empty list rather than a zero row', () => {
    const database = migratedDatabase()

    expect(llmUsageByDay(database)).toEqual([])
    expect(llmUsageByPurpose(database)).toEqual([])
  })
})
