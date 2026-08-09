/**
 * The sync engine. It owns everything a connector does not: the upsert keyed on
 * `(provider, external_id)`, content hashing, task creation and lifecycle application,
 * resolution, per-connector failure isolation and the `job_runs` record. Spec 02.
 *
 * A connector produces items. Nothing else about a connector reaches the database.
 */
import { withTransaction, type Database } from '../db/connection.js'
import { recordJobRun } from '../db/repositories/job-runs.js'
import {
  getSourceByExternalId,
  markSourceRequeued,
  markSourceResolved,
  proposeSourceCompletion,
  upsertSource,
} from '../db/repositories/sources.js'
import { getSyncCursor, setSyncCursor } from '../db/repositories/sync-state.js'
import { changeTaskStatus, createTask, getTask, updateTask } from '../db/repositories/tasks.js'
import { noCounts, type JobCounts, type JobRunStatus, type JobTrigger } from '../domain/job.js'
import type { SourceProvider } from '../domain/source.js'
import type { Task } from '../domain/task.js'
import { trackedStatusesFor } from '../domain/tracking.js'
import { contentHash } from './hash.js'
import type { Connector, SourceItem } from './types.js'

/** The job name a connector's run is recorded under, so the history reads per connector. */
export function syncJobName(provider: SourceProvider): string {
  return `sync:${provider}`
}

export interface ConnectorRunResult {
  readonly provider: SourceProvider
  readonly status: JobRunStatus
  readonly counts: JobCounts
  /** The failure message, in the connector's own words. Null unless the run failed. */
  readonly error: string | null
}

export interface SyncSummary {
  readonly results: readonly ConnectorRunResult[]
  /** True when anything at all was written, which is what the UI needs telling about. */
  readonly changed: boolean
}

export interface RunSyncOptions {
  readonly database: Database
  readonly connectors: readonly Connector[]
  readonly trigger: JobTrigger
  /** Injected so a test can name the moment rather than wait for one. */
  readonly now: () => number
}

/** A mutable tally, turned into the immutable `JobCounts` when the connector's run ends. */
type Tally = { -readonly [K in keyof JobCounts]: JobCounts[K] }

function newTally(): Tally {
  return { ...noCounts }
}

/**
 * Applies one item. Everything about it lands together or not at all: a crash between
 * creating the task and linking it to its source would otherwise have the next run create a
 * second task for the same pull request.
 */
export function applyItem(
  database: Database,
  provider: SourceProvider,
  item: SourceItem,
  now: number,
  tally: Tally,
): void {
  withTransaction(database, () => {
    const existing = getSourceByExternalId(database, provider, item.externalId)
    const hash = contentHash(item)
    const contentChanged = existing !== null && existing.contentHash !== hash

    const source = upsertSource(
      database,
      {
        provider,
        externalId: item.externalId,
        url: item.url,
        title: item.title,
        metadata: item.metadata,
        content: item.content ?? null,
        contentHash: hash,
        lifecycleState: item.lifecycleState ?? null,
        ...(item.actedAt === undefined ? {} : { actedAt: item.actedAt }),
        ...(item.actedAtMarker === undefined ? {} : { actedAtMarker: item.actedAtMarker }),
      },
      now,
    )

    tally.itemsSeen += 1
    if (existing === null) tally.sourcesCreated += 1

    const task = source.taskId === null ? null : getTask(database, source.taskId)

    // Resolution comes first, and it does not need a task. A source whose task the user
    // deleted still has to stop being followed when the item upstream closes, or the refresh
    // pass would fetch it on every run for the rest of the process's life.
    if (item.resolved === true) {
      resolve(database, source.id, existing?.resolvedAt ?? null, task, now, tally)
      return
    }

    if (task === null) {
      createTaskFor(database, provider, item, now, tally)
      return
    }

    // An upstream change returns the item to the classification queue only while its task is
    // still in the inbox. A task the user has already triaged is left alone and the change is
    // visible in the UI instead. Spec 02, criteria 2 and 3.
    if (contentChanged && task.status === 'inbox') {
      markSourceRequeued(database, source.id, now)
      tally.requeued += 1
    }

    applyLifecycle(database, provider, item, task, now, tally)
  })
}

/**
 * Creates the task an item asks for and links it to its source. Two things stop one being
 * created: a connector that declares no task intent, and the provider guard below. An item
 * that arrives already closed never reaches here, because a record of finished work is not
 * something to put on the board for nobody to do.
 */
function createTaskFor(
  database: Database,
  provider: SourceProvider,
  item: SourceItem,
  now: number,
  tally: Tally,
): void {
  // A calendar event never becomes a task, in any code path. The connector declares no task
  // intent, and this refuses one even if a future connector wrongly offers it: the rule is
  // worth more than one connector's good behaviour. Spec 02, criterion 7.
  if (provider === 'gcal') return
  if (item.task === undefined) return

  const created = createTask(
    database,
    {
      title: item.title,
      status: item.task.status,
      // Attribution belongs to sync, which is also what makes the task sync-tracked.
      statusSetBy: 'sync',
      ...(item.task.waitingOn === undefined ? {} : { waitingOn: item.task.waitingOn }),
      ...(item.task.estimateMinutes === undefined
        ? {}
        : { estimateMinutes: item.task.estimateMinutes }),
    },
    now,
  )

  upsertSource(database, { provider, externalId: item.externalId, taskId: created.id }, now)
  tally.tasksCreated += 1
}

/**
 * The upstream item closed. The source is resolved and completion is *proposed*; whether
 * the task is actually completed depends on whether the user has decided its status for
 * themselves since. Sync never silently overwrites that. Spec 02, criterion 4.
 */
function resolve(
  database: Database,
  sourceId: string,
  alreadyResolvedAt: number | null,
  task: Task | null,
  now: number,
  tally: Tally,
): void {
  markSourceResolved(database, sourceId, now)
  proposeSourceCompletion(database, sourceId, now)
  if (alreadyResolvedAt === null) tally.resolved += 1

  if (task === null) return
  if (task.status === 'done') return
  // The user decided this task's status themselves. Completing it now would be sync
  // overruling that decision on the strength of an upstream event they can already see.
  if (task.statusSetBy === 'user') return

  const result = changeTaskStatus(database, task.id, { status: 'done', by: 'sync', at: now })

  if (result?.applied === true) tally.tasksUpdated += 1
}

/**
 * Moves the task to where the connector's state machine says it belongs. Refused for a task
 * the user has filed outside the connector's tracked set, which is the permanent opt-out in
 * spec 01: `changeTaskStatus` is where that rule lives, and the refusal is simply not
 * counted. Spec 02, criterion 17.
 */
function applyLifecycle(
  database: Database,
  provider: SourceProvider,
  item: SourceItem,
  task: Task,
  now: number,
  tally: Tally,
): void {
  if (item.task === undefined) return
  // The permanent opt-out. `changeTaskStatus` would refuse the move anyway; checking here
  // is what stops `waiting_on` being written to a task sync no longer owns.
  if (!task.syncTracked) return

  // A connector owns transitions only inside the set of statuses it declares, and only for a
  // task that is currently in that set. A connector that declares no set owns no transitions
  // at all: Gmail captures a thread into the inbox once, and where it goes after that is the
  // user's decision, not something to be reasserted every fifteen minutes. Spec 01, sync
  // tracking; spec 02, criterion 3.
  const owned = trackedStatusesFor(provider)
  if (owned === undefined) return
  if (!owned.includes(task.status) || !owned.includes(item.task.status)) return

  let updated = false

  if (item.task.status !== task.status) {
    const result = changeTaskStatus(database, task.id, {
      status: item.task.status,
      by: 'sync',
      at: now,
    })
    updated = result?.applied === true
  }

  // Who it is waiting on is part of the transition into `waiting`, not a separate edit: a
  // chase list that does not name the person is not a chase list. Spec 02.
  const waitingOn = item.task.waitingOn ?? null
  if (item.task.status === 'waiting' && task.waitingOn !== waitingOn) {
    updateTask(database, task.id, { waitingOn }, now)
    updated = true
  }

  if (updated) tally.tasksUpdated += 1
}

async function runConnector(
  { database, trigger, now }: RunSyncOptions,
  connector: Connector,
): Promise<ConnectorRunResult> {
  const job = syncJobName(connector.provider)
  const startedAt = now()
  const tally = newTally()

  if (!connector.isConfigured()) {
    // Not an error. A clean checkout with no credentials is a valid state, and the run
    // history should say the connector was skipped rather than that nothing happened.
    recordJobRun(database, {
      job,
      trigger,
      startedAt,
      finishedAt: now(),
      status: 'skipped',
      counts: tally,
    })
    return { provider: connector.provider, status: 'skipped', counts: { ...tally }, error: null }
  }

  try {
    const since = getSyncCursor(database, connector.provider)
    for await (const item of connector.fetch(since)) {
      applyItem(database, connector.provider, item, now(), tally)
    }

    // Only a successful run advances the cursor, and it advances to when the run *started*,
    // not to when it finished: anything that changed while it was running is still ahead of
    // the cursor and will be picked up next time rather than skipped.
    setSyncCursor(database, connector.provider, startedAt, now())

    recordJobRun(database, {
      job,
      trigger,
      startedAt,
      finishedAt: now(),
      status: 'success',
      counts: tally,
    })

    return { provider: connector.provider, status: 'success', counts: { ...tally }, error: null }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)

    recordJobRun(database, {
      job,
      trigger,
      startedAt,
      finishedAt: now(),
      status: 'failure',
      counts: tally,
      error: message,
      ...(error instanceof Error && error.stack !== undefined ? { errorStack: error.stack } : {}),
    })

    return { provider: connector.provider, status: 'failure', counts: { ...tally }, error: message }
  }
}

function didAnything(counts: JobCounts): boolean {
  return (
    counts.sourcesCreated > 0 ||
    counts.tasksCreated > 0 ||
    counts.tasksUpdated > 0 ||
    counts.resolved > 0 ||
    counts.requeued > 0
  )
}

/**
 * Runs every connector, one after another. A connector that throws fails its own run and
 * nothing else: the others still run, and the failure is in the history with its message.
 * Spec 02, criterion 5.
 */
export async function runSync(options: RunSyncOptions): Promise<SyncSummary> {
  const results: ConnectorRunResult[] = []

  for (const connector of options.connectors) {
    results.push(await runConnector(options, connector))
  }

  return { results, changed: results.some((result) => didAnything(result.counts)) }
}
