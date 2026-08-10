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

function toUsage(row: Row | undefined): LlmUsage {
  if (row === undefined) return noUsage
  return {
    calls: Number(row.calls),
    inputTokens: Number(row.input_tokens),
    outputTokens: Number(row.output_tokens),
  }
}

/**
 * Usage grouped by local calendar day, because "what did today cost" is a question about the
 * day the user is living in and a UTC boundary lands in the middle of one for most of the
 * world.
 *
 * Grouped in JavaScript rather than in SQL, and by time zone rather than by a fixed offset.
 * A single offset applied to every row is only correct until a daylight-saving change: a
 * call made at 04:30 UTC in January belongs to the previous day in New York, but a query run
 * in July would apply that summer's offset and file it under the wrong one. `Intl` knows
 * which offset was in force at each instant; a number cannot.
 *
 * The row count here is one per model call over a reporting window, so reading them to add
 * them up is not a cost worth trading correctness for.
 */
export function llmUsageByDay(
  database: Database,
  {
    since,
    timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone,
  }: { since?: number; timeZone?: string } = {},
): Array<{ day: string; usage: LlmUsage }> {
  // `en-CA` formats as YYYY-MM-DD, which is both the readable form and the sortable one.
  const asDay = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })

  const where = since === undefined ? '' : 'where started_at >= ?'
  const params = since === undefined ? [] : [since]

  const totals = new Map<string, { calls: number; inputTokens: number; outputTokens: number }>()

  for (const row of database
    .prepare(`select started_at, input_tokens, output_tokens from llm_calls ${where}`)
    .all(...params)) {
    const { started_at, input_tokens, output_tokens } = row as Row
    const day = asDay.format(new Date(Number(started_at)))

    const running = totals.get(day) ?? { calls: 0, inputTokens: 0, outputTokens: 0 }
    running.calls += 1
    running.inputTokens += Number(input_tokens)
    running.outputTokens += Number(output_tokens)
    totals.set(day, running)
  }

  return [...totals.entries()]
    .map(([day, usage]) => ({ day, usage }))
    .toSorted((left, right) => right.day.localeCompare(left.day))
}

/** Usage grouped by what the call was for. Spec 03's "per job" view. */
export function llmUsageByPurpose(
  database: Database,
  { since }: { since?: number } = {},
): Array<{ purpose: LlmPurpose; usage: LlmUsage }> {
  const where = since === undefined ? '' : 'where started_at >= ?'
  const params = since === undefined ? [] : [since]

  return database
    .prepare(
      `select purpose,
              count(*) as calls,
              sum(input_tokens) as input_tokens,
              sum(output_tokens) as output_tokens
         from llm_calls ${where}
        group by purpose
        order by purpose`,
    )
    .all(...params)
    .map((row) => ({
      purpose: String((row as Row).purpose) as LlmPurpose,
      usage: toUsage(row as Row),
    }))
}
