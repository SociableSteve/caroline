/**
 * The sync engine against a real migrated database. Spec 02, criteria 1 to 7: the upsert,
 * content hashing, the requeue rules, resolution, per-connector failure isolation, and the
 * two rules that hold whatever a connector does.
 */
import { describe, expect, it } from 'vitest'
import { runSync, syncJobName } from '../../src/connectors/engine.js'
import type { ContentPolicy } from '../../src/config/content.js'
import type { Connector, SourceItem } from '../../src/connectors/types.js'
import type { Database } from '../../src/db/connection.js'
import { listJobRuns } from '../../src/db/repositories/job-runs.js'
import {
  countSources,
  getSourceByExternalId,
  listUnresolvedSources,
} from '../../src/db/repositories/sources.js'
import { getSyncCursor } from '../../src/db/repositories/sync-state.js'
import {
  changeTaskStatus,
  deleteTask,
  getTask,
  listTasks,
} from '../../src/db/repositories/tasks.js'
import type { SourceProvider } from '../../src/domain/source.js'
import type { Task } from '../../src/domain/task.js'
import { migratedDatabase } from '../helpers/temp-database.js'

const FIRST_RUN = Date.UTC(2026, 0, 5, 9, 0)
const SECOND_RUN = Date.UTC(2026, 0, 5, 9, 15)

/** A connector that yields exactly what it was handed. The engine is what is under test. */
function stubConnector(
  provider: SourceProvider,
  items: ReadonlyArray<readonly SourceItem[]>,
  configured = true,
): Connector & { readonly since: (number | null)[] } {
  let run = 0
  const since: (number | null)[] = []

  return {
    provider,
    since,
    isConfigured: () => configured,
    async *fetch(cursor) {
      since.push(cursor)
      const batch = items[Math.min(run, items.length - 1)] ?? []
      run += 1
      for (const item of batch) yield item
    },
  }
}

function throwingConnector(provider: SourceProvider, message: string): Connector {
  return {
    provider,
    isConfigured: () => true,
    // eslint-disable-next-line require-yield -- the point of it is that it never yields.
    async *fetch() {
      throw new Error(message)
    },
  }
}

const pullRequest: SourceItem = {
  externalId: 'example-org/example-service#42',
  url: 'https://github.com/example-org/example-service/pull/42',
  title: 'example-org/example-service#42 Add a retry to the fetch helper',
  metadata: { repository: 'example-org/example-service', number: 42, author: 'author-one' },
  occurredAt: FIRST_RUN,
  lifecycleState: 'awaiting_review',
  actedAt: null,
  actedAtMarker: null,
  task: { status: 'review', estimateMinutes: 30 },
}

const email: SourceItem = {
  externalId: 'thread-1',
  url: 'https://mail.example.com/thread-1',
  title: 'Invoice for January',
  metadata: { subject: 'Invoice for January' },
  occurredAt: FIRST_RUN,
  task: { status: 'inbox' },
}

/** The default policy: metadata stored, a snippet sent. Spec 09. */
const testPolicy = { llmContent: 'snippet', storeContent: 'metadata', snippetChars: 300 } as const

async function sync(
  database: Database,
  connectors: readonly Connector[],
  now: () => number = () => FIRST_RUN,
  policy: ContentPolicy = testPolicy,
) {
  return runSync({ database, connectors, trigger: 'scheduled', policy, now })
}

/**
 * The one task a single-item sync produced. Named rather than destructured with a fallback
 * id, so a run that created nothing fails saying that, instead of failing later on a lookup
 * against the empty string.
 */
function onlyTask(database: Database, at = FIRST_RUN): Task {
  const { tasks } = listTasks(database, {}, at)
  if (tasks.length !== 1) throw new Error(`expected exactly one task, found ${tasks.length}`)
  return tasks[0] as Task
}

describe('running a sync twice over an unchanged item', () => {
  it('produces one source and one task, with last seen advanced', async () => {
    const database = migratedDatabase()
    const connector = stubConnector('github', [[pullRequest]])

    await sync(database, [connector], () => FIRST_RUN)
    await sync(database, [connector], () => SECOND_RUN)

    const source = getSourceByExternalId(database, 'github', pullRequest.externalId)
    expect(countSources(database)).toBe(1)
    expect(listTasks(database, {}, SECOND_RUN).total).toBe(1)
    expect(source).toMatchObject({ firstSeenAt: FIRST_RUN, lastSeenAt: SECOND_RUN })
  })

  it('leaves the task alone the second time', async () => {
    const database = migratedDatabase()
    const connector = stubConnector('github', [[pullRequest]])

    await sync(database, [connector], () => FIRST_RUN)
    const summary = await sync(database, [connector], () => SECOND_RUN)

    expect(summary.results[0]?.counts).toMatchObject({
      itemsSeen: 1,
      sourcesCreated: 0,
      tasksCreated: 0,
      tasksUpdated: 0,
    })
  })

  it('seeds the estimate on creation and never imposes it again', async () => {
    const database = migratedDatabase()
    const connector = stubConnector('github', [
      [pullRequest],
      [{ ...pullRequest, task: { status: 'review', estimateMinutes: 90 } }],
    ])

    await sync(database, [connector], () => FIRST_RUN)
    const task = onlyTask(database)
    expect(task.estimateMinutes).toBe(30)

    await sync(database, [connector], () => SECOND_RUN)
    expect(getTask(database, task.id)?.estimateMinutes).toBe(30)
  })
})

describe('an upstream content change', () => {
  const changed: SourceItem = { ...email, title: 'Invoice for January, corrected' }

  it('updates the hash and requeues the task while it is still in the inbox', async () => {
    const database = migratedDatabase()
    const connector = stubConnector('gmail', [[email], [changed]])

    await sync(database, [connector], () => FIRST_RUN)
    const before = getSourceByExternalId(database, 'gmail', email.externalId)

    await sync(database, [connector], () => SECOND_RUN)
    const after = getSourceByExternalId(database, 'gmail', email.externalId)

    expect(after?.contentHash).not.toBe(before?.contentHash)
    expect(after?.requeuedAt).toBe(SECOND_RUN)
  })

  it('does not requeue a task the user has already triaged', async () => {
    const database = migratedDatabase()
    const connector = stubConnector('gmail', [[email], [changed]])

    await sync(database, [connector], () => FIRST_RUN)
    const task = onlyTask(database)
    changeTaskStatus(database, task.id, { status: 'next_action', by: 'user', at: FIRST_RUN })

    await sync(database, [connector], () => SECOND_RUN)

    expect(getSourceByExternalId(database, 'gmail', email.externalId)?.requeuedAt).toBeNull()
    // Criterion 3: no subsequent sync moves a triaged task back to the inbox.
    expect(getTask(database, task.id)).toMatchObject({
      status: 'next_action',
      statusSetBy: 'user',
    })
  })

  it('does not requeue when nothing actually changed', async () => {
    const database = migratedDatabase()
    const connector = stubConnector('gmail', [[email]])

    await sync(database, [connector], () => FIRST_RUN)
    await sync(database, [connector], () => SECOND_RUN)

    expect(getSourceByExternalId(database, 'gmail', email.externalId)?.requeuedAt).toBeNull()
  })
})

describe('an item whose upstream closes', () => {
  const merged: SourceItem = { ...pullRequest, resolved: true, task: { status: 'done' } }

  it('resolves the source and completes the task sync still owns', async () => {
    const database = migratedDatabase()
    const connector = stubConnector('github', [[pullRequest], [merged]])

    await sync(database, [connector], () => FIRST_RUN)
    await sync(database, [connector], () => SECOND_RUN)

    const source = getSourceByExternalId(database, 'github', pullRequest.externalId)
    expect(source).toMatchObject({
      resolvedAt: SECOND_RUN,
      completionProposedAt: SECOND_RUN,
    })
    expect(getTask(database, source?.taskId ?? '')).toMatchObject({
      status: 'done',
      completedAt: SECOND_RUN,
    })
  })

  it('only proposes completion for a task the user has since decided on', async () => {
    const database = migratedDatabase()
    const connector = stubConnector('github', [[pullRequest], [merged]])

    await sync(database, [connector], () => FIRST_RUN)
    const task = onlyTask(database)
    // Still inside the tracked set, so tracking survives: the user has simply decided this
    // one is on the author now, rather than opting out of the lifecycle.
    changeTaskStatus(database, task.id, { status: 'waiting', by: 'user', at: FIRST_RUN })

    await sync(database, [connector], () => SECOND_RUN)

    expect(getSourceByExternalId(database, 'github', pullRequest.externalId)).toMatchObject({
      resolvedAt: SECOND_RUN,
      completionProposedAt: SECOND_RUN,
    })
    expect(getTask(database, task.id)).toMatchObject({ status: 'waiting' })
  })

  it('resolves once, however many times it is seen closed after that', async () => {
    const database = migratedDatabase()
    const connector = stubConnector('github', [[pullRequest], [merged]])
    const THIRD_RUN = SECOND_RUN + 900_000

    await sync(database, [connector], () => FIRST_RUN)
    await sync(database, [connector], () => SECOND_RUN)
    const summary = await sync(database, [connector], () => THIRD_RUN)

    // The count is what the run history reports as work done, so a merged pull request must
    // not go on being reported as newly resolved every fifteen minutes.
    expect(summary.results[0]?.counts.resolved).toBe(0)
    expect(getSourceByExternalId(database, 'github', pullRequest.externalId)?.resolvedAt).toBe(
      SECOND_RUN,
    )
  })

  it('drops out of the refresh set once resolved', async () => {
    const database = migratedDatabase()
    const connector = stubConnector('github', [[pullRequest], [merged]])

    await sync(database, [connector], () => FIRST_RUN)
    expect(listUnresolvedSources(database, 'github')).toHaveLength(1)

    await sync(database, [connector], () => SECOND_RUN)
    expect(listUnresolvedSources(database, 'github')).toHaveLength(0)
  })

  it('stops following it even when the user deleted its task', async () => {
    // The source outlives the task by design (spec 01), and without this the refresh pass
    // would refetch a merged pull request on every run for as long as Caroline is running.
    const database = migratedDatabase()
    const connector = stubConnector('github', [[pullRequest], [merged]])

    await sync(database, [connector], () => FIRST_RUN)
    deleteTask(database, onlyTask(database).id)

    await sync(database, [connector], () => SECOND_RUN)

    expect(listUnresolvedSources(database, 'github')).toHaveLength(0)
  })

  it('never creates a task for something that arrives already closed', async () => {
    const database = migratedDatabase()

    await sync(database, [stubConnector('github', [[merged]])], () => FIRST_RUN)

    expect(listTasks(database, {}, FIRST_RUN).total).toBe(0)
    expect(countSources(database)).toBe(1)
  })
})

describe('who a task is waiting on', () => {
  const reviewed: SourceItem = {
    ...pullRequest,
    lifecycleState: 'reviewed',
    task: { status: 'waiting', waitingOn: 'author-one' },
  }

  it('is named when the connector moves it into waiting', async () => {
    const database = migratedDatabase()
    const connector = stubConnector('github', [[pullRequest], [reviewed]])

    await sync(database, [connector], () => FIRST_RUN)
    await sync(database, [connector], () => SECOND_RUN)

    expect(onlyTask(database, SECOND_RUN)).toMatchObject({
      status: 'waiting',
      waitingOn: 'author-one',
    })
  })

  it('is cleared on the way back out, since it is no longer on them', async () => {
    // A card back in Review that still names the author reads as blocked on them, and it is
    // the reader who has to know that the field only counts in one status.
    const database = migratedDatabase()
    const connector = stubConnector('github', [[pullRequest], [reviewed], [pullRequest]])
    const THIRD_RUN = SECOND_RUN + 900_000

    await sync(database, [connector], () => FIRST_RUN)
    await sync(database, [connector], () => SECOND_RUN)
    await sync(database, [connector], () => THIRD_RUN)

    expect(onlyTask(database, THIRD_RUN)).toMatchObject({ status: 'review', waitingOn: null })
  })
})

describe('a connector that throws', () => {
  it('does not stop the others, and its failure is in the run history with the message', async () => {
    const database = migratedDatabase()

    const summary = await sync(database, [
      throwingConnector('gmail', 'Gmail said 401'),
      stubConnector('github', [[pullRequest]]),
    ])

    expect(summary.results).toMatchObject([
      { provider: 'gmail', status: 'failure', error: 'Gmail said 401' },
      { provider: 'github', status: 'success' },
    ])
    expect(listTasks(database, {}, FIRST_RUN).total).toBe(1)

    const [failed] = listJobRuns(database, { job: syncJobName('gmail') })
    expect(failed).toMatchObject({ status: 'failure', error: 'Gmail said 401' })
    expect(failed?.errorStack).toContain('Error: Gmail said 401')
  })

  it('leaves its cursor where it was, so the next run covers the window it lost', async () => {
    const database = migratedDatabase()

    await sync(database, [throwingConnector('gmail', 'Gmail said 401')])

    expect(getSyncCursor(database, 'gmail')).toBeNull()
  })
})

describe('a connector with no credentials', () => {
  it('is skipped without error, and the skip is recorded', async () => {
    const database = migratedDatabase()

    const summary = await sync(database, [stubConnector('github', [[pullRequest]], false)])

    expect(summary.results).toMatchObject([{ provider: 'github', status: 'skipped', error: null }])
    expect(countSources(database)).toBe(0)
    expect(listJobRuns(database, { job: syncJobName('github') })).toMatchObject([
      { status: 'skipped' },
    ])
  })
})

describe('calendar events', () => {
  it('never become tasks, even if a connector asks for one', async () => {
    const database = migratedDatabase()
    const event: SourceItem = {
      externalId: 'event-1',
      url: 'https://calendar.example.com/event-1',
      title: 'Sprint review',
      metadata: { allDay: false },
      occurredAt: FIRST_RUN,
      // A connector that should never do this. The rule is worth more than its good behaviour.
      task: { status: 'next_action' },
    }

    await sync(database, [stubConnector('gcal', [[event]])], () => FIRST_RUN)

    expect(countSources(database)).toBe(1)
    expect(listTasks(database, {}, FIRST_RUN).total).toBe(0)
  })
})

describe('the cursor', () => {
  it('starts null and advances to the start of a successful run', async () => {
    const database = migratedDatabase()
    const connector = stubConnector('github', [[pullRequest]])

    await sync(database, [connector], () => FIRST_RUN)
    expect(connector.since).toEqual([null])
    expect(getSyncCursor(database, 'github')).toBe(FIRST_RUN)

    await sync(database, [connector], () => SECOND_RUN)
    expect(connector.since).toEqual([null, FIRST_RUN])
  })
})

describe('every run', () => {
  it('writes a job_runs row naming the connector', async () => {
    const database = migratedDatabase()

    await sync(database, [stubConnector('github', [[pullRequest]])])

    expect(listJobRuns(database)).toMatchObject([
      {
        job: 'sync:github',
        trigger: 'scheduled',
        status: 'success',
        counts: { itemsSeen: 1, sourcesCreated: 1, tasksCreated: 1 },
      },
    ])
  })
})
