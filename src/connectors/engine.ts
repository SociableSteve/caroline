/**
 * The sync engine. It owns everything a connector does not: the upsert keyed on
 * `(provider, external_id)`, content hashing, task creation and lifecycle application,
 * resolution, per-connector failure isolation and the `job_runs` record. Spec 02.
 *
 * A connector produces items. Nothing else about a connector reaches the database.
 */
import { contentToStore, type ContentPolicy } from '../config/content.js'
import { withTransaction, type Database } from '../db/connection.js'
import { recordJobRun } from '../db/repositories/job-runs.js'
import {
  getSourceByExternalId,
  markSourceRequeued,
  markSourceResolved,
  markSourceSuppressed,
  proposeSourceCompletion,
  relinkSource,
  retractSourceResolution,
  upsertSource,
} from '../db/repositories/sources.js'
import { getSyncCursor, setSyncCursor } from '../db/repositories/sync-state.js'
import {
  changeTaskStatus,
  createTask,
  deleteTask,
  getTask,
  updateTask,
} from '../db/repositories/tasks.js'
import { noCounts, type JobCounts, type JobRunStatus, type JobTrigger } from '../domain/job.js'
import type { Source, SourceProvider } from '../domain/source.js'
import { isUntriaged, type Task } from '../domain/task.js'
import { trackedStatusesFor } from '../domain/tracking.js'
import { contentHash } from './hash.js'
import { isAddressable, type BackupReference, type Connector, type SourceItem } from './types.js'

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
  /**
   * The store boundary, applied here rather than in each connector: spec 09 criterion 3 is a
   * guarantee about every connector, and a guarantee each connector implemented for itself
   * would be a guarantee only until the next connector.
   */
  readonly policy: ContentPolicy
  /** Injected so a test can name the moment rather than wait for one. */
  readonly now: () => number
}

/** A mutable tally, turned into the immutable `JobCounts` when the connector's run ends. */
export type Tally = { -readonly [K in keyof JobCounts]: JobCounts[K] }

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
  policy: ContentPolicy,
  now: number,
  tally: Tally,
): void {
  withTransaction(database, () => {
    const existing = getSourceByExternalId(database, provider, item.externalId)
    // Hashed from the body as fetched rather than as stored, so a change beyond the stored
    // snippet is still a change. The consequence is that altering the content policy can look
    // like an upstream change once, which requeues inbox items for classification and nothing
    // more.
    const hash = contentHash(item)
    const contentChanged = existing !== null && existing.contentHash !== hash

    // The store boundary. An item that carries no body says nothing about the stored one, so the
    // fields are omitted and the row keeps what it has; an item that does carry one has it cut
    // to the policy, and `none` cuts it to nothing. Spec 09, criterion 3.
    const stored = item.content === undefined ? null : contentToStore(item.content, policy)

    const source = upsertSource(
      database,
      {
        provider,
        externalId: item.externalId,
        url: item.url,
        title: item.title,
        metadata: item.metadata,
        ...(stored === null ? {} : { content: stored.content, contentLevel: stored.level }),
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

    // The other half of resolution: this pass finds the item genuinely still open, which a
    // prior one, wrongly or only transiently, did not. A false resolution must not be
    // permanent, so it is retracted here and the item falls through to the ordinary path
    // below, exactly as it would have if it had never been marked resolved at all.
    if (item.resolved === false && existing !== null) {
      retract(database, existing, task)
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
 * The upstream item this pass finds open was marked resolved, or had completion proposed, by
 * an earlier one: a transient state, such as a review request a rebase knocked out, rather
 * than a genuine close. Retracted so the false resolution is not permanent and the visibility
 * guarantee holds: an open pull request is never left looking closed. Spec 02.
 *
 * Refused, and left exactly as it was, only once the task has actually completed: accepted
 * into `done`, whether that was the user clicking through on the card or sync completing it
 * itself on an earlier, genuine resolution. That is the one response this codebase records to
 * a completion proposal, there being no separate dismissal; a task any other status, including
 * one the user set themselves, has not decided anything about this proposal; sync still owns
 * that answer, and this only ever touches the source's own fields, never the task's status.
 * Spec 01; spec 02, criterion 4.
 */
function retract(database: Database, existing: Source, task: Task | null): void {
  if (existing.resolvedAt === null && existing.completionProposedAt === null) return
  if (task !== null && task.status === 'done') return

  retractSourceResolution(database, existing.id)
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
  // A completed task is a decision, sync's own or the user's, made by `resolve()` and only
  // ever forward. `done` sits inside the tracked set alongside `review` and `waiting`, so
  // without this an item found open again after a false resolution (`retract`, above) would
  // have this ordinary lifecycle move silently reopen a task that had already been finished.
  if (task.status === 'done') return

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
  // chase list that does not name the person is not a chase list. Spec 02. Leaving it does
  // not, which is why it is cleared on the way out: a pull request back in Review that still
  // names the author reads as blocked on them, and it is not.
  const waitingOn = item.task.status === 'waiting' ? (item.task.waitingOn ?? null) : null
  if (task.waitingOn !== waitingOn) {
    updateTask(database, task.id, { waitingOn }, now)
    updated = true
  }

  if (updated) tally.tasksUpdated += 1
}

/**
 * An item that is a second telling of an item another connector owns: a GitHub notification email
 * about a pull request. It is not work of its own, so it does not go through the ordinary upsert
 * rules. Spec 02, notification emails as a backup source.
 *
 * Returns true when the item was suppressed and there is nothing further to do with it, and false
 * when the backup source could not do its job, which puts the item back on the ordinary path to be
 * captured and classified like any other. A backup source that swallowed mail it could not place
 * would be worse than no backup source at all.
 */
async function cover(
  options: RunSyncOptions,
  provider: SourceProvider,
  item: SourceItem,
  reference: BackupReference,
  tally: Tally,
): Promise<boolean> {
  const { database } = options

  const existing = getSourceByExternalId(database, provider, item.externalId)
  const existingTask =
    existing === null || existing.taskId === null ? null : getTask(database, existing.taskId)

  // The user's own decision stands: a thread they have filed themselves is not something a later
  // sync gets to retire or take the task away from. Spec 01's rule, applied here whole. The pull
  // request is still fetched below, because that half is about GitHub rather than about their mail.
  //
  // Skipped once the thread is already suppressed, where the linked task is the pull request's own
  // and its status says nothing about this thread.
  const alreadySuppressed = existing !== null && existing.suppressedAt !== null
  const ownDecision = !alreadySuppressed && existingTask !== null && !isUntriaged(existingTask)

  let owner = getSourceByExternalId(database, reference.provider, reference.externalId)

  // Rule 2: the discovery query missed it, which is the whole reason this email is worth reading.
  // Fetched by id and applied like any other item, so the review lifecycle decides where it goes,
  // including deciding it goes nowhere when nobody is asking the user to review it.
  if (owner === null) {
    if (!(await bringIn(options, reference, tally))) return false
    owner = getSourceByExternalId(database, reference.provider, reference.externalId)
    if (owner === null) return false
  }

  // Checked here rather than at the top so that the fetch above still happens: what the user
  // decided was where their email goes, not whether Caroline may know about the pull request.
  if (ownDecision) return false

  suppress(options, provider, item, owner.taskId, tally)
  return true
}

/**
 * Fetches the item its owning connector missed, through that connector. The engine finds the owner
 * in the list it was given rather than being told which one it is, so it still names no connector.
 *
 * False whenever the item cannot be brought in: no such connector, one that cannot be addressed by
 * id, one with no credentials, an id it does not recognise, or a refusal from the provider. The
 * failure is not this run's: the owning connector has its own pass in the same sync, and a provider
 * that is refusing calls will have failed there, with the message, in its own `job_runs` row. Rule
 * 3 is what happens here instead.
 */
async function bringIn(
  options: RunSyncOptions,
  reference: BackupReference,
  tally: Tally,
): Promise<boolean> {
  const owner = options.connectors.find((connector) => connector.provider === reference.provider)
  if (owner === undefined || !isAddressable(owner) || !owner.isConfigured()) return false

  let fetched: SourceItem | null
  try {
    fetched = await owner.item(reference.externalId)
  } catch {
    return false
  }

  if (fetched === null) return false

  // Counted against the pass that did the writing, which is the pass reading the email rather than
  // the owning connector's. Its own row would be a tidier place for it and a less true one: that
  // pass did not create the source, and a run history is a record of what happened.
  applyItem(options.database, reference.provider, fetched, options.policy, options.now(), tally)
  return true
}

/**
 * Records the item as a second telling and hands its provenance to the task that owns the work. No
 * task of its own is created, and an untriaged one already created for it is retired: what goes is
 * the duplicate card, not the record of where it came from, which moves onto the pull request's.
 *
 * Suppression is not completion and must not read as work done, so nothing here proposes completing
 * anything or moves a status. Spec 02.
 */
function suppress(
  { database, now }: RunSyncOptions,
  provider: SourceProvider,
  item: SourceItem,
  ownerTaskId: string | null,
  tally: Tally,
): void {
  withTransaction(database, () => {
    const at = now()
    const existing = getSourceByExternalId(database, provider, item.externalId)

    const source = upsertSource(
      database,
      {
        provider,
        externalId: item.externalId,
        url: item.url,
        title: item.title,
        metadata: item.metadata,
        // No body, and any body already stored is dropped. Nothing will read it: the item is not
        // going to be classified, and the policy is a ceiling rather than a quota. Spec 09.
        content: null,
        contentHash: contentHash(item),
      },
      at,
    )

    tally.itemsSeen += 1
    if (existing === null) tally.sourcesCreated += 1

    const task = source.taskId === null ? null : getTask(database, source.taskId)

    // Never the owner's own task, which this row points at once it has been suppressed, and never a
    // task the user has decided on, which `cover` has already refused to come this far with.
    //
    // Deleting it takes its `classifications` rows with it, which is right: they are a record of the
    // classifier answering about a card that should never have been on the board.
    if (task !== null && task.id !== ownerTaskId && isUntriaged(task)) {
      deleteTask(database, task.id)
    }

    markSourceSuppressed(database, source.id, at)
    // Deleting the task above cleared the link, so this both moves the provenance and restores it.
    if (ownerTaskId !== null) relinkSource(database, source.id, ownerTaskId)

    if (existing === null || existing.suppressedAt === null) tally.suppressed += 1
  })
}

export interface ConnectorPassOptions {
  readonly database: Database
  readonly provider: SourceProvider
  readonly trigger: JobTrigger
  readonly isConfigured: () => boolean
  readonly now: () => number
}

/**
 * One connector's pass, recorded. What `work` does is the connector's business; skipping when
 * nothing is configured, catching what throws, and writing exactly one `sync:<provider>` row
 * whichever of those happened is not.
 *
 * Shared with the calendar pass, which writes to `calendar_events` rather than to `sources`
 * and so does not go through `applyItem`, but is a connector run in every other respect and
 * has to appear in the history as one. Spec 02 criteria 5 and 6, and spec 06.
 *
 * The tally is passed to `work` rather than returned by it so that a pass that fails part-way
 * still reports what it managed: a run that stored nine events and then lost the connection
 * did store nine events, and a row saying zero would be a lie about the database.
 *
 * `startedAt` is passed too, rather than each pass reading the clock again. The sync cursor is
 * stamped with the moment the run began, and it has to be the same moment the run history
 * records, or the two would disagree about when the pass happened.
 */
export async function runConnectorPass(
  { database, provider, trigger, isConfigured, now }: ConnectorPassOptions,
  work: (tally: Tally, startedAt: number) => Promise<void>,
): Promise<ConnectorRunResult> {
  const job = syncJobName(provider)
  const startedAt = now()
  const tally = newTally()

  if (!isConfigured()) {
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
    return { provider, status: 'skipped', counts: { ...tally }, error: null }
  }

  try {
    await work(tally, startedAt)

    recordJobRun(database, {
      job,
      trigger,
      startedAt,
      finishedAt: now(),
      status: 'success',
      counts: tally,
    })

    return { provider, status: 'success', counts: { ...tally }, error: null }
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

    return { provider, status: 'failure', counts: { ...tally }, error: message }
  }
}

function runConnector(options: RunSyncOptions, connector: Connector): Promise<ConnectorRunResult> {
  const { database, trigger, policy, now } = options

  return runConnectorPass(
    {
      database,
      provider: connector.provider,
      trigger,
      isConfigured: () => connector.isConfigured(),
      now,
    },
    async (tally, startedAt) => {
      const since = getSyncCursor(database, connector.provider)
      for await (const item of connector.fetch(since)) {
        // An item that says it is a second telling of another connector's is decided by the backup
        // source rule, which may put it back here if it cannot place it. Spec 02.
        if (
          item.backupFor !== undefined &&
          (await cover(options, connector.provider, item, item.backupFor, tally))
        ) {
          continue
        }

        applyItem(database, connector.provider, item, policy, now(), tally)
      }

      // Only a successful run advances the cursor, and it advances to when the run *started*,
      // not to when it finished: anything that changed while it was running is still ahead of
      // the cursor and will be picked up next time rather than skipped.
      setSyncCursor(database, connector.provider, startedAt, now())
    },
  )
}

function didAnything(counts: JobCounts): boolean {
  return (
    counts.sourcesCreated > 0 ||
    counts.tasksCreated > 0 ||
    counts.tasksUpdated > 0 ||
    counts.resolved > 0 ||
    counts.requeued > 0 ||
    counts.suppressed > 0
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
