import { randomUUID } from 'node:crypto'
import type { Database } from '../connection.js'
import type { Row } from '../rows.js'
import {
  markActed,
  markResolved,
  type ActedRecord,
  type Source,
  type SourceProvider,
} from '../../domain/source.js'

export interface UpsertSourceInput {
  readonly provider: SourceProvider
  readonly externalId: string
  readonly url?: string | null
  readonly title?: string | null
  readonly metadata?: unknown
  readonly content?: string | null
  readonly contentHash?: string | null
  readonly taskId?: string | null
  readonly lifecycleState?: string | null
}

const columns = `id, provider, external_id, url, title, metadata, content, content_hash, task_id,
  first_seen_at, last_seen_at, resolved_at, lifecycle_state, acted_at, acted_at_marker`

function toSource(row: Row): Source {
  const metadata = row.metadata
  return {
    id: String(row.id),
    provider: String(row.provider) as SourceProvider,
    externalId: String(row.external_id),
    url: nullableText(row.url),
    title: nullableText(row.title),
    metadata: typeof metadata === 'string' ? JSON.parse(metadata) : null,
    content: nullableText(row.content),
    contentHash: nullableText(row.content_hash),
    taskId: nullableText(row.task_id),
    firstSeenAt: Number(row.first_seen_at),
    lastSeenAt: Number(row.last_seen_at),
    resolvedAt: nullableNumber(row.resolved_at),
    lifecycleState: nullableText(row.lifecycle_state),
    actedAt: nullableNumber(row.acted_at),
    actedAtMarker: nullableText(row.acted_at_marker),
  }
}

function nullableText(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value)
}

/**
 * The upsert's field rule: what the caller supplied wins, including an explicit `null`;
 * only an omitted field falls back to what is stored.
 */
function supplied<T>(input: T | undefined, stored: T | null | undefined): T | null {
  return input !== undefined ? input : (stored ?? null)
}

function nullableNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value)
}

function writeSource(database: Database, source: Source): void {
  database
    .prepare(
      `insert into sources (${columns}) values (
         :id, :provider, :external_id, :url, :title, :metadata, :content, :content_hash,
         :task_id, :first_seen_at, :last_seen_at, :resolved_at, :lifecycle_state, :acted_at,
         :acted_at_marker
       )
       on conflict (id) do update set
         url = excluded.url,
         title = excluded.title,
         metadata = excluded.metadata,
         content = excluded.content,
         content_hash = excluded.content_hash,
         task_id = excluded.task_id,
         last_seen_at = excluded.last_seen_at,
         resolved_at = excluded.resolved_at,
         lifecycle_state = excluded.lifecycle_state,
         acted_at = excluded.acted_at,
         acted_at_marker = excluded.acted_at_marker`,
    )
    .run({
      id: source.id,
      provider: source.provider,
      external_id: source.externalId,
      url: source.url,
      title: source.title,
      metadata: source.metadata === undefined ? null : JSON.stringify(source.metadata),
      content: source.content,
      content_hash: source.contentHash,
      task_id: source.taskId,
      first_seen_at: source.firstSeenAt,
      last_seen_at: source.lastSeenAt,
      resolved_at: source.resolvedAt,
      lifecycle_state: source.lifecycleState,
      acted_at: source.actedAt,
      acted_at_marker: source.actedAtMarker,
    })
}

/**
 * Insert or update, keyed on `(provider, external_id)`. Every connector writes through
 * here, so seeing the same item twice can never produce a second row. Spec 01, criterion 3.
 *
 * `first_seen_at` belongs to the first sighting and is never overwritten; `last_seen_at`
 * moves on every pass. Fields the caller omits keep their stored value, so a refresh that
 * only knows the new title does not blank the rest of the row. An explicit `null` is the
 * other case and does clear the field: a connector saying a pull request no longer has a
 * linked task means it, where a connector that never mentions the link does not.
 */
export function upsertSource(database: Database, input: UpsertSourceInput, now: number): Source {
  const existing = getSourceByExternalId(database, input.provider, input.externalId)

  const source: Source = {
    id: existing?.id ?? randomUUID(),
    provider: input.provider,
    externalId: input.externalId,
    url: supplied(input.url, existing?.url),
    title: supplied(input.title, existing?.title),
    metadata: supplied(input.metadata, existing?.metadata),
    content: supplied(input.content, existing?.content),
    contentHash: supplied(input.contentHash, existing?.contentHash),
    taskId: supplied(input.taskId, existing?.taskId),
    firstSeenAt: existing?.firstSeenAt ?? now,
    lastSeenAt: now,
    resolvedAt: existing?.resolvedAt ?? null,
    lifecycleState: supplied(input.lifecycleState, existing?.lifecycleState),
    actedAt: existing?.actedAt ?? null,
    actedAtMarker: existing?.actedAtMarker ?? null,
  }

  writeSource(database, source)

  return source
}

export function getSource(database: Database, id: string): Source | null {
  const row = database.prepare(`select ${columns} from sources where id = ?`).get(id)
  return row === undefined ? null : toSource(row as Row)
}

export function getSourceByExternalId(
  database: Database,
  provider: SourceProvider,
  externalId: string,
): Source | null {
  const row = database
    .prepare(`select ${columns} from sources where provider = ? and external_id = ?`)
    .get(provider, externalId)

  return row === undefined ? null : toSource(row as Row)
}

export function listSourcesForTask(database: Database, taskId: string): Source[] {
  return database
    .prepare(`select ${columns} from sources where task_id = ? order by first_seen_at, id`)
    .all(taskId)
    .map((row) => toSource(row as Row))
}

export function countSources(database: Database): number {
  const row = database.prepare('select count(*) as count from sources').get()
  return Number((row as Row).count)
}

/** The upstream item closed or vanished. The row stays; only sync's interest in it ends. */
export function markSourceResolved(database: Database, id: string, at: number): Source | null {
  const existing = getSource(database, id)
  if (existing === null) return null

  const resolved = markResolved(existing, at)
  writeSource(database, resolved)

  return resolved
}

/** The user discharged their part. The marker pins where upstream was when they did. */
export function markSourceActed(database: Database, id: string, acted: ActedRecord): Source | null {
  const existing = getSource(database, id)
  if (existing === null) return null

  const source = markActed(existing, acted)
  writeSource(database, source)

  return source
}
