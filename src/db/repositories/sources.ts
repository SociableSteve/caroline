import { randomUUID } from 'node:crypto'
import type { Database } from '../connection.js'
import type { Row } from '../rows.js'
import { contentLevels, type ContentLevel } from '../../domain/content.js'
import {
  markActed,
  markRequeued,
  markResolved,
  markSuppressed,
  proposeCompletion,
  retractResolution,
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
  /**
   * What the storage content policy permits, already applied: the repository stores what it is
   * given and does not decide policy. Supplied together with the level it was computed at, so
   * that a later downgrade can tell a truncated snippet from a short body. Spec 09.
   */
  readonly content?: string | null
  readonly contentLevel?: ContentLevel
  readonly contentHash?: string | null
  readonly taskId?: string | null
  readonly lifecycleState?: string | null
  /**
   * The connector's state machine carries the previous marker forward itself, so these are
   * supplied on every pass rather than only when they change. Spec 02.
   */
  readonly actedAt?: number | null
  readonly actedAtMarker?: string | null
}

const columns = `id, provider, external_id, url, title, metadata, content, content_level,
  content_stored_at, content_hash, task_id, first_seen_at, last_seen_at, resolved_at,
  suppressed_at, lifecycle_state, acted_at, acted_at_marker, requeued_at,
  completion_proposed_at`

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
    contentLevel: toContentLevel(row.content_level),
    contentStoredAt: nullableNumber(row.content_stored_at),
    contentHash: nullableText(row.content_hash),
    taskId: nullableText(row.task_id),
    firstSeenAt: Number(row.first_seen_at),
    lastSeenAt: Number(row.last_seen_at),
    resolvedAt: nullableNumber(row.resolved_at),
    suppressedAt: nullableNumber(row.suppressed_at),
    lifecycleState: nullableText(row.lifecycle_state),
    actedAt: nullableNumber(row.acted_at),
    actedAtMarker: nullableText(row.acted_at_marker),
    requeuedAt: nullableNumber(row.requeued_at),
    completionProposedAt: nullableNumber(row.completion_proposed_at),
  }
}

function nullableText(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value)
}

/**
 * The column is text with a default, and its values are the policy's, so a row written before
 * the column existed reads as `none`: it holds no body, which is what `none` says.
 */
function toContentLevel(value: unknown): ContentLevel {
  const level = String(value ?? 'none')
  return (contentLevels as readonly string[]).includes(level) ? (level as ContentLevel) : 'none'
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
         :id, :provider, :external_id, :url, :title, :metadata, :content, :content_level,
         :content_stored_at, :content_hash, :task_id, :first_seen_at, :last_seen_at,
         :resolved_at, :suppressed_at, :lifecycle_state, :acted_at, :acted_at_marker,
         :requeued_at, :completion_proposed_at
       )
       on conflict (id) do update set
         url = excluded.url,
         title = excluded.title,
         metadata = excluded.metadata,
         content = excluded.content,
         content_level = excluded.content_level,
         content_stored_at = excluded.content_stored_at,
         content_hash = excluded.content_hash,
         task_id = excluded.task_id,
         last_seen_at = excluded.last_seen_at,
         resolved_at = excluded.resolved_at,
         suppressed_at = excluded.suppressed_at,
         lifecycle_state = excluded.lifecycle_state,
         acted_at = excluded.acted_at,
         acted_at_marker = excluded.acted_at_marker,
         requeued_at = excluded.requeued_at,
         completion_proposed_at = excluded.completion_proposed_at`,
    )
    .run({
      id: source.id,
      provider: source.provider,
      external_id: source.externalId,
      url: source.url,
      title: source.title,
      metadata: source.metadata === undefined ? null : JSON.stringify(source.metadata),
      content: source.content,
      content_level: source.contentLevel,
      content_stored_at: source.contentStoredAt,
      content_hash: source.contentHash,
      task_id: source.taskId,
      first_seen_at: source.firstSeenAt,
      last_seen_at: source.lastSeenAt,
      resolved_at: source.resolvedAt,
      suppressed_at: source.suppressedAt,
      lifecycle_state: source.lifecycleState,
      acted_at: source.actedAt,
      acted_at_marker: source.actedAtMarker,
      requeued_at: source.requeuedAt,
      completion_proposed_at: source.completionProposedAt,
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
  const content = supplied(input.content, existing?.content)
  // A caller supplying a body without its level would otherwise leave the stored level describing
  // a body that is no longer there. A body and its label travel together, so a body with no label
  // is `none` rather than whatever the row said last.
  const contentLevel =
    input.contentLevel ??
    (input.content === undefined ? (existing?.contentLevel ?? 'none') : 'none')

  const source: Source = {
    id: existing?.id ?? randomUUID(),
    provider: input.provider,
    externalId: input.externalId,
    url: supplied(input.url, existing?.url),
    title: supplied(input.title, existing?.title),
    metadata: supplied(input.metadata, existing?.metadata),
    content,
    contentLevel,
    // Stamped when a body arrives or changes, and cleared with it, because this is what
    // retention counts from. A body that has not changed keeps the moment it was first written,
    // so a thread seen every fifteen minutes still ages out. Spec 09, criterion 5.
    contentStoredAt:
      content === null
        ? null
        : content === existing?.content
          ? (existing.contentStoredAt ?? now)
          : now,
    contentHash: supplied(input.contentHash, existing?.contentHash),
    taskId: supplied(input.taskId, existing?.taskId),
    firstSeenAt: existing?.firstSeenAt ?? now,
    lastSeenAt: now,
    resolvedAt: existing?.resolvedAt ?? null,
    suppressedAt: existing?.suppressedAt ?? null,
    lifecycleState: supplied(input.lifecycleState, existing?.lifecycleState),
    actedAt: supplied(input.actedAt, existing?.actedAt),
    actedAtMarker: supplied(input.actedAtMarker, existing?.actedAtMarker),
    requeuedAt: existing?.requeuedAt ?? null,
    completionProposedAt: existing?.completionProposedAt ?? null,
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

/**
 * The set the refresh pass follows: everything of this provider that has not closed,
 * whether or not the provider's own discovery query still returns it. Spec 02, criterion 18.
 *
 * A suppressed source is excluded. It is a second telling of an item another connector owns, and
 * following it would mean two things: a needless fetch, and worse, for Gmail, a thread later
 * archived would be read as handled and propose completing the pull request it points at. Spec 02.
 */
export function listUnresolvedSources(database: Database, provider: SourceProvider): Source[] {
  return database
    .prepare(
      `select ${columns} from sources
       where provider = ? and resolved_at is null and suppressed_at is null
       order by first_seen_at, id`,
    )
    .all(provider)
    .map((row) => toSource(row as Row))
}

/** The sources of several tasks in one query, so a board listing is not a query per card. */
export function listSourcesForTasks(
  database: Database,
  taskIds: readonly string[],
): Map<string, Source[]> {
  const sources = new Map<string, Source[]>()
  if (taskIds.length === 0) return sources

  const placeholders = taskIds.map(() => '?').join(', ')
  const rows = database
    .prepare(
      `select ${columns} from sources where task_id in (${placeholders}) order by first_seen_at, id`,
    )
    .all(...taskIds)

  for (const row of rows) {
    const source = toSource(row as Row)
    if (source.taskId === null) continue

    const existing = sources.get(source.taskId)
    if (existing === undefined) sources.set(source.taskId, [source])
    else existing.push(source)
  }

  return sources
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

/**
 * The item is a second telling of an item another connector already covers. The row stays and keeps
 * its own title, link and metadata; what it loses is a task of its own and a place in the set
 * sync follows. Spec 02, notification emails as a backup source.
 */
export function markSourceSuppressed(database: Database, id: string, at: number): Source | null {
  const existing = getSource(database, id)
  if (existing === null) return null

  const source = markSuppressed(existing, at)
  writeSource(database, source)

  return source
}

/** The user discharged their part. The marker pins where upstream was when they did. */
export function markSourceActed(database: Database, id: string, acted: ActedRecord): Source | null {
  const existing = getSource(database, id)
  if (existing === null) return null

  const source = markActed(existing, acted)
  writeSource(database, source)

  return source
}

/** Sync would like the linked task completed. Recorded whether or not it was allowed to. */
export function proposeSourceCompletion(database: Database, id: string, at: number): Source | null {
  const existing = getSource(database, id)
  if (existing === null) return null

  const source = proposeCompletion(existing, at)
  writeSource(database, source)

  return source
}

/**
 * A later pass found the item genuinely still open. `resolvedAt` and `completionProposedAt`
 * go back to null, exactly as `markSourceResolved`/`proposeSourceCompletion` set them, so a
 * transient resolution is not permanent. Whether the caller may call this for a given source
 * is the engine's decision (spec 02, criterion 4); this only ever writes what it is told to.
 */
export function retractSourceResolution(database: Database, id: string): Source | null {
  const existing = getSource(database, id)
  if (existing === null) return null

  const source = retractResolution(existing)
  writeSource(database, source)

  return source
}

/** An upstream content change put the linked inbox task back in the classification queue. */
export function markSourceRequeued(database: Database, id: string, at: number): Source | null {
  const existing = getSource(database, id)
  if (existing === null) return null

  const source = markRequeued(existing, at)
  writeSource(database, source)

  return source
}

/**
 * Every row holding a body, whatever provider it came from. The two content purges read this:
 * it is a small set by construction, because the default policy stores no bodies at all.
 */
export function listSourcesWithContent(database: Database): Source[] {
  return database
    .prepare(`select ${columns} from sources where content is not null order by first_seen_at, id`)
    .all()
    .map((row) => toSource(row as Row))
}

/**
 * Replaces a stored body with what the policy now allows, or clears it. Only the body and its two
 * labels are touched: the source row, its task and its metadata survive a purge, which is the whole
 * distinction spec 09 criterion 5 draws.
 *
 * `storedAt` is the caller's to choose, and cutting a body back is not writing a new one: a
 * downgrade passes the row's own stamp, so the retention window still runs from when the body
 * arrived rather than from when the policy changed.
 */
export function setSourceContent(
  database: Database,
  id: string,
  content: string | null,
  level: ContentLevel,
  storedAt: number,
): void {
  database
    .prepare(
      `update sources
       set content = :content, content_level = :level,
           content_stored_at = case when :content is null then null else :stored_at end
       where id = :id`,
    )
    .run({ id, content, level, stored_at: storedAt })
}

/**
 * Puts the state machine back where it was, stamps and all. Chat's undo of a mark-reviewed: the
 * status change on the task is only half of that move, and leaving the source marked as acted on
 * would have the next sync treat a review that never happened as discharged. Spec 07.
 *
 * Separate from `setSourceLifecycle` because that one is a move forward and cannot express
 * "nobody has acted on this yet", which is exactly what an undo has to write back.
 */
export function restoreSourceLifecycle(
  database: Database,
  id: string,
  lifecycle: {
    readonly lifecycleState: string | null
    readonly actedAt: number | null
    readonly actedAtMarker: string | null
  },
): Source | null {
  const existing = getSource(database, id)
  if (existing === null) return null

  const source: Source = { ...existing, ...lifecycle }
  writeSource(database, source)

  return source
}

/**
 * Reattaches a source to a task. Deleting a task clears the link rather than the row (migration
 * 1), so undoing a delete has to put the link back or the restored task would come back without
 * its provenance.
 */
export function relinkSource(database: Database, id: string, taskId: string): Source | null {
  const existing = getSource(database, id)
  if (existing === null) return null

  const source: Source = { ...existing, taskId }
  writeSource(database, source)

  return source
}

/** Sets the connector's state machine position without touching anything else on the row. */
export function setSourceLifecycle(
  database: Database,
  id: string,
  lifecycleState: string,
  acted: ActedRecord,
): Source | null {
  const existing = getSource(database, id)
  if (existing === null) return null

  const source = markActed({ ...existing, lifecycleState }, acted)
  writeSource(database, source)

  return source
}
