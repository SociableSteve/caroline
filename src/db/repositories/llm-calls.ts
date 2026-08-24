import { randomUUID } from 'node:crypto'
import type { Database } from '../connection.js'
import type { Row } from '../rows.js'
import {
  noUsage,
  type LlmCall,
  type LlmCallStatus,
  type LlmPurpose,
  type LlmUsage,
} from '../../domain/llm.js'

export interface RecordLlmCallInput {
  readonly provider: LlmCall['provider']
  readonly model: string
  readonly purpose: LlmPurpose
  readonly startedAt: number
  readonly durationMs: number
  readonly inputTokens: number
  readonly outputTokens: number
  readonly status: LlmCallStatus
  readonly error?: string | null
}

const columns = `id, provider, model, purpose, started_at, duration_ms, input_tokens,
  output_tokens, status, error`

function toLlmCall(row: Row): LlmCall {
  return {
    id: String(row.id),
    provider: String(row.provider) as LlmCall['provider'],
    model: String(row.model),
    purpose: String(row.purpose) as LlmPurpose,
    startedAt: Number(row.started_at),
    durationMs: Number(row.duration_ms),
    inputTokens: Number(row.input_tokens),
    outputTokens: Number(row.output_tokens),
    status: String(row.status) as LlmCallStatus,
    error: row.error === null || row.error === undefined ? null : String(row.error),
  }
}

/**
 * One row per call, written when the call ends. Spec 03: every call is recorded, including
 * the failures, because a failed call that answered still spent tokens and a usage view that
 * omitted it would understate exactly the case worth noticing.
 */
export function recordLlmCall(database: Database, input: RecordLlmCallInput): LlmCall {
  const call: LlmCall = {
    id: randomUUID(),
    provider: input.provider,
    model: input.model,
    purpose: input.purpose,
    startedAt: input.startedAt,
    durationMs: input.durationMs,
    inputTokens: input.inputTokens,
    outputTokens: input.outputTokens,
    status: input.status,
    error: input.error ?? null,
  }

  database
    .prepare(
      `insert into llm_calls (${columns}) values (
         :id, :provider, :model, :purpose, :started_at, :duration_ms, :input_tokens,
         :output_tokens, :status, :error
       )`,
    )
    .run({
      id: call.id,
      provider: call.provider,
      model: call.model,
      purpose: call.purpose,
      started_at: call.startedAt,
      duration_ms: call.durationMs,
      input_tokens: call.inputTokens,
      output_tokens: call.outputTokens,
      status: call.status,
      error: call.error,
    })

  return call
}

export interface LlmCallQuery {
  readonly purpose?: LlmPurpose
  readonly since?: number
  readonly limit?: number
}

/** Most recent first: usage is read from the top, and the top is what just happened. */
export function listLlmCalls(database: Database, query: LlmCallQuery = {}): LlmCall[] {
  const conditions: string[] = []
  const params: Array<string | number> = []

  if (query.purpose !== undefined) {
    conditions.push('purpose = ?')
    params.push(query.purpose)
  }
  if (query.since !== undefined) {
    conditions.push('started_at >= ?')
    params.push(query.since)
  }

  const where = conditions.length === 0 ? '' : `where ${conditions.join(' and ')}`

  return database
    .prepare(`select ${columns} from llm_calls ${where} order by started_at desc, id limit ?`)
    .all(...params, query.limit ?? 100)
    .map((row) => toLlmCall(row as Row))
}

/**
 * Every token one provider has spent since an instant, input and output together.
 *
 * The spending ceiling is enforced against this number (spec 03, criteria 11 and 12). Summed in
 * SQL rather than read row by row, because this runs before every call rather than when somebody
 * opens a screen, and because the caller wraps it and its comparison in one transaction: the less
 * that happens inside it the better.
 */
export function llmTokensForProvider(
  database: Database,
  { provider, since }: { provider: LlmCall['provider']; since: number },
): number {
  const row = database
    .prepare(
      `select coalesce(sum(input_tokens + output_tokens), 0) as tokens
         from llm_calls
        where provider = ? and started_at >= ?`,
    )
    .get(provider, since) as Row | undefined

  return row === undefined ? 0 : Number(row.tokens)
}

/** One leaf of the spend report: the finest grouping every roll-up in it can be built from. */
export interface LlmUsageLeaf {
  /** A local calendar day, `YYYY-MM-DD`, resolved in the given zone. */
  readonly day: string
  readonly purpose: LlmPurpose
  readonly provider: LlmCall['provider']
  readonly model: string
  readonly usage: LlmUsage
}

/**
 * Usage grouped by day, purpose, provider and model at once. Spec 03's spend view rolls this up
 * three ways rather than asking three times, because a price belongs to a model: a total taken
 * across models cannot be priced, so every roll-up has to be built from leaves that carry one.
 *
 * Grouped in JavaScript for the reason `llmUsageByDay` is, which is that a day is a local calendar
 * day and only `Intl` knows which offset was in force at an instant. The row count is one per
 * model call over a reporting window, so reading them to add them up is not a cost worth trading
 * correctness for.
 */
export function llmUsageBreakdown(
  database: Database,
  {
    since,
    timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone,
  }: { since?: number; timeZone?: string } = {},
): LlmUsageLeaf[] {
  const asDay = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })

  const where = since === undefined ? '' : 'where started_at >= ?'
  const params = since === undefined ? [] : [since]

  const totals = new Map<string, LlmUsageLeaf>()

  for (const row of database
    .prepare(
      `select started_at, purpose, provider, model, input_tokens, output_tokens
         from llm_calls ${where}`,
    )
    .all(...params)) {
    const record = row as Row
    const day = asDay.format(new Date(Number(record.started_at)))
    const purpose = String(record.purpose) as LlmPurpose
    const provider = String(record.provider) as LlmCall['provider']
    const model = String(record.model)

    const key = `${day}\u0000${purpose}\u0000${provider}\u0000${model}`
    const running = totals.get(key) ?? { day, purpose, provider, model, usage: noUsage }

    totals.set(key, {
      ...running,
      usage: {
        calls: running.usage.calls + 1,
        inputTokens: running.usage.inputTokens + Number(record.input_tokens),
        outputTokens: running.usage.outputTokens + Number(record.output_tokens),
      },
    })
  }

  return [...totals.values()]
}
