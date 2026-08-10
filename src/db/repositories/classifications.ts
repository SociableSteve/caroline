/**
 * The classification audit trail. One row per answer, applied or not, failed or not: spec 04
 * criterion 6, and the evaluation set the prompt is tuned against later.
 */
import { randomUUID } from 'node:crypto'
import type { Database } from '../connection.js'
import type { Row } from '../rows.js'
import {
  isPending,
  type Classification,
  type ProjectSuggestion,
} from '../../domain/classification.js'
import type { TaskStatus } from '../../domain/task.js'

export interface RecordClassificationInput {
  readonly taskId: string
  /** Null exactly when the call failed, in which case `error` says how. */
  readonly proposedStatus?: TaskStatus | null
  readonly confidence?: number | null
  readonly reasoning?: string | null
  readonly suggestedTitle?: string | null
  readonly estimateMinutes?: number | null
  readonly waitingOn?: string | null
  readonly projectSuggestion?: ProjectSuggestion | null
  readonly provider?: string | null
  readonly model?: string | null
  readonly promptVersion: string
  readonly applied: boolean
  readonly error?: string | null
}

const columnNames = [
  'id',
  'task_id',
  'proposed_status',
  'confidence',
  'reasoning',
  'suggested_title',
  'estimate_minutes',
  'waiting_on',
  'project_suggestion',
  'provider',
  'model',
  'prompt_version',
  'applied',
  'accepted_at',
  'dismissed_at',
  'error',
  'created_at',
] as const

const columns = columnNames.join(', ')

/** The same list, qualified, for the one query that joins `tasks` and would be ambiguous without. */
const qualifiedColumns = columnNames.map((column) => `classifications.${column}`).join(', ')

function nullableText(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value)
}

function nullableNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value)
}

function toClassification(row: Row): Classification {
  const suggestion = row.project_suggestion

  return {
    id: String(row.id),
    taskId: String(row.task_id),
    proposedStatus: nullableText(row.proposed_status) as TaskStatus | null,
    confidence: nullableNumber(row.confidence),
    reasoning: nullableText(row.reasoning),
    suggestedTitle: nullableText(row.suggested_title),
    estimateMinutes: nullableNumber(row.estimate_minutes),
    waitingOn: nullableText(row.waiting_on),
    projectSuggestion:
      typeof suggestion === 'string' ? (JSON.parse(suggestion) as ProjectSuggestion) : null,
    provider: nullableText(row.provider),
    model: nullableText(row.model),
    promptVersion: String(row.prompt_version),
    applied: Number(row.applied) !== 0,
    acceptedAt: nullableNumber(row.accepted_at),
    dismissedAt: nullableNumber(row.dismissed_at),
    error: nullableText(row.error),
    createdAt: Number(row.created_at),
  }
}

export function recordClassification(
  database: Database,
  input: RecordClassificationInput,
  now: number,
): Classification {
  const row = {
    id: randomUUID(),
    task_id: input.taskId,
    proposed_status: input.proposedStatus ?? null,
    confidence: input.confidence ?? null,
    reasoning: input.reasoning ?? null,
    suggested_title: input.suggestedTitle ?? null,
    estimate_minutes: input.estimateMinutes ?? null,
    waiting_on: input.waitingOn ?? null,
    project_suggestion:
      input.projectSuggestion === undefined || input.projectSuggestion === null
        ? null
        : JSON.stringify(input.projectSuggestion),
    provider: input.provider ?? null,
    model: input.model ?? null,
    prompt_version: input.promptVersion,
    applied: input.applied ? 1 : 0,
    accepted_at: null,
    dismissed_at: null,
    error: input.error ?? null,
    created_at: now,
  }

  database
    .prepare(
      `insert into classifications (${columns}) values (
         :id, :task_id, :proposed_status, :confidence, :reasoning, :suggested_title,
         :estimate_minutes, :waiting_on, :project_suggestion, :provider, :model, :prompt_version,
         :applied, :accepted_at, :dismissed_at, :error, :created_at
       )`,
    )
    .run(row)

  return toClassification(row as unknown as Row)
}

export function getClassification(database: Database, id: string): Classification | null {
  const row = database.prepare(`select ${columns} from classifications where id = ?`).get(id)
  return row === undefined ? null : toClassification(row as Row)
}

export interface ClassificationQuery {
  readonly taskId?: string
  readonly limit?: number
}

/** Most recent first: the audit trail is read from the top, and the top is the current answer. */
export function listClassifications(
  database: Database,
  query: ClassificationQuery = {},
): Classification[] {
  const where = query.taskId === undefined ? '' : 'where task_id = ?'
  const params = query.taskId === undefined ? [] : [query.taskId]

  return database
    .prepare(`select ${columns} from classifications ${where} order by created_at desc, id limit ?`)
    .all(...params, query.limit ?? 50)
    .map((row) => toClassification(row as Row))
}

/**
 * The proposal a task is waiting on the user for, if any: the most recent answer, when that
 * answer was below the threshold and has been neither accepted nor dismissed. Derived from the
 * row rather than kept as a flag on the task, so the two cannot disagree.
 */
export function pendingProposal(database: Database, taskId: string): Classification | null {
  const latest = listClassifications(database, { taskId, limit: 1 })[0]
  if (latest === undefined) return null
  return isPending(latest) && stillInInbox(database, taskId) ? latest : null
}

/**
 * A proposal is only on offer while the task is still where the classifier left it. The user moving
 * it themselves is the decision the proposal was asking for, so it stops being offered rather than
 * lingering as a button that would undo what they just did.
 */
function stillInInbox(database: Database, taskId: string): boolean {
  const row = database.prepare('select status from tasks where id = ?').get(taskId)
  return row !== undefined && String((row as Row).status) === 'inbox'
}

/**
 * The pending proposals of several tasks in one query, so a board listing is not a query per
 * card. Only the most recent answer per task is considered, for the same reason as above.
 */
export function listPendingProposals(
  database: Database,
  taskIds: readonly string[],
): Map<string, Classification> {
  const pending = new Map<string, Classification>()
  if (taskIds.length === 0) return pending

  const placeholders = taskIds.map(() => '?').join(', ')
  const rows = database
    .prepare(
      `select ${qualifiedColumns}
       from classifications
       join tasks on tasks.id = classifications.task_id
       where classifications.task_id in (${placeholders}) and tasks.status = 'inbox'
       order by classifications.task_id, classifications.created_at desc, classifications.id`,
    )
    .all(...taskIds)

  const seen = new Set<string>()
  for (const row of rows) {
    const classification = toClassification(row as Row)
    // Ordered newest first per task, so the first row of each task is the only candidate.
    if (seen.has(classification.taskId)) continue
    seen.add(classification.taskId)

    if (isPending(classification)) pending.set(classification.taskId, classification)
  }

  return pending
}

/** The user accepted the proposal. The status change itself is the caller's to make. */
export function markProposalAccepted(
  database: Database,
  id: string,
  at: number,
): Classification | null {
  database
    .prepare('update classifications set accepted_at = ? where id = ? and applied = 0')
    .run(at, id)
  return getClassification(database, id)
}

/** The user looked and decided the model was wrong. The task stays where it is. */
export function markProposalDismissed(
  database: Database,
  id: string,
  at: number,
): Classification | null {
  database
    .prepare('update classifications set dismissed_at = ? where id = ? and applied = 0')
    .run(at, id)
  return getClassification(database, id)
}
