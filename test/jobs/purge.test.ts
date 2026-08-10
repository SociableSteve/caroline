/**
 * The nightly purge: content the policy no longer allows, content past its retention window, and
 * run history past its own. Spec 09 criteria 4 and 5, and spec 06's retention.
 */
import { describe, expect, it } from 'vitest'
import { loadConfig } from '../../src/config/load.js'
import type { Config } from '../../src/config/schema.js'
import type { Database } from '../../src/db/connection.js'
import { listJobRuns, recordJobRun } from '../../src/db/repositories/job-runs.js'
import { getSourceByExternalId, upsertSource } from '../../src/db/repositories/sources.js'
import { createTask, getTask } from '../../src/db/repositories/tasks.js'
import { runPurge } from '../../src/jobs/purge.js'
import { migratedDatabase } from '../helpers/temp-database.js'

const NOW = Date.UTC(2026, 7, 10, 3, 20, 0)
const DAY = 24 * 60 * 60_000
const BODY = 'Could you take a look at the hub numbers before Thursday? Ta, Sam'

function config(file: Record<string, unknown> = {}): Config {
  return loadConfig({ file, env: {} as NodeJS.ProcessEnv })
}

/** A thread with a body stored at the given level, written at the given moment. */
function aStoredThread(
  database: Database,
  options: { level: 'snippet' | 'full'; storedAt: number; content?: string },
): string {
  const task = createTask(database, { title: 'Hub numbers', statusSetBy: 'sync' }, options.storedAt)

  upsertSource(
    database,
    {
      provider: 'gmail',
      externalId: `thread-${task.id}`,
      title: 'Hub numbers',
      content: options.content ?? BODY,
      contentLevel: options.level,
      taskId: task.id,
    },
    options.storedAt,
  )

  return `thread-${task.id}`
}

describe('lowering the store policy', () => {
  /** Spec 09, criterion 4. */
  it('clears a body stored above the new level and reports the count', () => {
    const database = migratedDatabase()
    const externalId = aStoredThread(database, { level: 'full', storedAt: NOW - DAY })

    const result = runPurge({ database, config: config(), now: () => NOW })

    expect(result.counts.contentPurged).toBe(1)
    expect(getSourceByExternalId(database, 'gmail', externalId)).toMatchObject({
      content: null,
      contentLevel: 'metadata',
      contentStoredAt: null,
    })
  })

  it('cuts a full body back to a snippet when the new level is snippet', () => {
    const database = migratedDatabase()
    const externalId = aStoredThread(database, { level: 'full', storedAt: NOW - DAY })

    runPurge({
      database,
      config: config({ privacy: { storeContent: 'snippet', snippetChars: 10 } }),
      now: () => NOW,
    })

    expect(getSourceByExternalId(database, 'gmail', externalId)).toMatchObject({
      content: 'Could you ',
      contentLevel: 'snippet',
    })
  })

  it('leaves a body the policy still allows, and counts nothing', () => {
    const database = migratedDatabase()
    const externalId = aStoredThread(database, { level: 'snippet', storedAt: NOW - DAY })

    const result = runPurge({
      database,
      config: config({ privacy: { storeContent: 'full' } }),
      now: () => NOW,
    })

    expect(result.counts.contentPurged).toBe(0)
    expect(getSourceByExternalId(database, 'gmail', externalId)?.content).toBe(BODY)
  })
})

describe('the retention window', () => {
  /** Spec 09, criterion 5. */
  it('drops a body older than the window while its source row and task survive', () => {
    const database = migratedDatabase()
    const externalId = aStoredThread(database, { level: 'snippet', storedAt: NOW - 40 * DAY })
    const taskId = getSourceByExternalId(database, 'gmail', externalId)?.taskId ?? ''

    const result = runPurge({
      database,
      config: config({ privacy: { storeContent: 'snippet', retainContentDays: 30 } }),
      now: () => NOW,
    })

    expect(result.counts.contentPurged).toBe(1)
    expect(getSourceByExternalId(database, 'gmail', externalId)).toMatchObject({
      content: null,
      title: 'Hub numbers',
      taskId,
    })
    expect(getTask(database, taskId)).not.toBeNull()
  })

  it('keeps a body inside the window', () => {
    const database = migratedDatabase()
    const externalId = aStoredThread(database, { level: 'snippet', storedAt: NOW - 5 * DAY })

    runPurge({
      database,
      config: config({ privacy: { storeContent: 'snippet', retainContentDays: 30 } }),
      now: () => NOW,
    })

    expect(getSourceByExternalId(database, 'gmail', externalId)?.content).toBe(BODY)
  })

  it('measures age from when the body was written, not from when the thread was last seen', () => {
    const database = migratedDatabase()
    const externalId = aStoredThread(database, { level: 'snippet', storedAt: NOW - 40 * DAY })
    // Seen again just now, with the same body: still forty days old as far as retention goes.
    upsertSource(
      database,
      { provider: 'gmail', externalId, content: BODY, contentLevel: 'snippet' },
      NOW,
    )

    runPurge({
      database,
      config: config({ privacy: { storeContent: 'snippet', retainContentDays: 30 } }),
      now: () => NOW,
    })

    expect(getSourceByExternalId(database, 'gmail', externalId)?.content).toBeNull()
  })
})

describe('the interaction between the two purges', () => {
  /**
   * Cutting a body back is not writing a new one. Stamping it afresh would push the retention
   * window out every time the policy was lowered, so a body written 29 days ago under a 30-day
   * window would suddenly have another 30 to live. Spec 09, criterion 5.
   */
  it('does not restart the retention clock when a downgrade cuts a body back', () => {
    const database = migratedDatabase()
    const storedAt = NOW - 29 * DAY
    const externalId = aStoredThread(database, { level: 'full', storedAt })

    const snippetPolicy = config({
      privacy: { storeContent: 'snippet', snippetChars: 10, retainContentDays: 30 },
    })

    runPurge({ database, config: snippetPolicy, now: () => NOW })

    expect(getSourceByExternalId(database, 'gmail', externalId)).toMatchObject({
      content: 'Could you ',
      contentStoredAt: storedAt,
    })

    // Two days later it is past the window, measured from when the body arrived.
    runPurge({ database, config: snippetPolicy, now: () => NOW + 2 * DAY })

    expect(getSourceByExternalId(database, 'gmail', externalId)?.content).toBeNull()
  })
})

describe('a body stored before the policy columns existed', () => {
  /**
   * The migration backfills the two facts. Without them every policy allows what the row claims to
   * hold, and a null stamp has no age, so neither purge would ever touch the body again.
   */
  it('is labelled and stamped by the migration, so a purge can still reach it', () => {
    const database = migratedDatabase()
    const task = createTask(database, { title: 'Legacy', statusSetBy: 'sync' }, NOW - 40 * DAY)

    // A row as an earlier migration would have left it: a body, no level, no stamp.
    database
      .prepare(
        `insert into sources (id, provider, external_id, title, content, task_id, first_seen_at,
           last_seen_at, content_level, content_stored_at)
         values ('source-legacy', 'gmail', 'thread-legacy', 'Legacy', ?, ?, ?, ?, 'none', null)`,
      )
      .run(BODY, task.id, NOW - 40 * DAY, NOW - 40 * DAY)

    // Re-running the backfill is what the migration does on a database that predates the columns.
    database.exec(
      `update sources set content_level = 'full', content_stored_at = last_seen_at
       where content is not null and content_stored_at is null`,
    )

    const result = runPurge({
      database,
      config: config({ privacy: { storeContent: 'metadata', retainContentDays: 30 } }),
      now: () => NOW,
    })

    expect(result.counts.contentPurged).toBe(1)
    expect(getSourceByExternalId(database, 'gmail', 'thread-legacy')?.content).toBeNull()
  })
})

describe('the run history', () => {
  it('drops runs older than the retention window and keeps the rest', () => {
    const database = migratedDatabase()
    for (const age of [40, 10]) {
      recordJobRun(database, {
        job: 'sync',
        trigger: 'scheduled',
        startedAt: NOW - age * DAY,
        finishedAt: NOW - age * DAY,
        status: 'success',
      })
    }

    const result = runPurge({
      database,
      config: config({ jobs: { retainRunDays: 30 } }),
      now: () => NOW,
    })

    expect(result.counts.runsPurged).toBe(1)
    expect(listJobRuns(database)).toHaveLength(1)
  })

  it('is a success with nothing to say when there is nothing to purge', () => {
    const database = migratedDatabase()

    expect(runPurge({ database, config: config(), now: () => NOW })).toMatchObject({
      status: 'success',
      error: null,
      counts: { contentPurged: 0, runsPurged: 0 },
    })
  })
})
