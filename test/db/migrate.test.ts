import { describe, expect, it } from 'vitest'
import { openDatabase, type Database } from '../../src/db/connection.js'
import { migrations } from '../../src/db/migrations/index.js'
import { mcpAccumulatorVersion } from '../../src/db/migrations/0014-mcp-accumulator-version.js'
import { appliedMigrationIds, runMigrations, type Migration } from '../../src/db/migrate.js'
import { emptyDatabase, temporaryDatabasePath } from '../helpers/temp-database.js'

function columnsOf(database: Database, table: string): string[] {
  return database
    .prepare('select name from pragma_table_info(?)')
    .all(table)
    .map((row) => String((row as { name: unknown }).name))
}

function countingMigration(id: number, table: string): Migration {
  return {
    id,
    name: `create ${table}`,
    up: (database) => database.exec(`create table ${table} (id text primary key)`),
  }
}

function tableNames(database: ReturnType<typeof emptyDatabase>): string[] {
  return database
    .prepare(`select name from sqlite_master where type = 'table' order by name`)
    .all()
    .map((row) => String((row as { name: unknown }).name))
}

describe('the migration runner', () => {
  // Criterion 7.
  it('applies pending migrations in ascending id order', () => {
    const database = emptyDatabase()
    const applied: number[] = []
    const record = (id: number): Migration => ({
      id,
      name: `migration ${id}`,
      up: () => applied.push(id),
    })

    runMigrations(database, [record(3), record(1), record(2)])

    expect(applied).toEqual([1, 2, 3])
  })

  it('records what it applied', () => {
    const database = emptyDatabase()

    runMigrations(database, [countingMigration(1, 'alpha'), countingMigration(2, 'beta')])

    expect(appliedMigrationIds(database)).toEqual([1, 2])
  })

  it('reports the ids it applied on this run', () => {
    const database = emptyDatabase()

    const result = runMigrations(database, [countingMigration(1, 'alpha')])

    expect(result.applied).toEqual([1])
  })

  // Criterion 7: idempotent. This is the property that lets it run on every startup.
  it('applies nothing on a second run over the same migrations', () => {
    const database = emptyDatabase()
    const set = [countingMigration(1, 'alpha'), countingMigration(2, 'beta')]
    runMigrations(database, set)

    const second = runMigrations(database, set)

    expect(second.applied).toEqual([])
    expect(appliedMigrationIds(database)).toEqual([1, 2])
  })

  it('runs only the new migration when one is added later', () => {
    const database = emptyDatabase()
    runMigrations(database, [countingMigration(1, 'alpha')])

    const second = runMigrations(database, [
      countingMigration(1, 'alpha'),
      countingMigration(2, 'beta'),
    ])

    expect(second.applied).toEqual([2])
    expect(tableNames(database)).toContain('beta')
  })

  it('survives the process restarting between runs', () => {
    const path = temporaryDatabasePath()
    const first = openDatabase(path)
    runMigrations(first, [countingMigration(1, 'alpha')])
    first.close()

    const second = openDatabase(path)
    try {
      expect(runMigrations(second, [countingMigration(1, 'alpha')]).applied).toEqual([])
    } finally {
      second.close()
    }
  })

  it('rolls a failing migration back, leaving no half-applied schema', () => {
    const database = emptyDatabase()
    const broken: Migration = {
      id: 1,
      name: 'half a schema',
      up: (target) => {
        target.exec('create table alpha (id text primary key)')
        throw new Error('migration blew up')
      },
    }

    expect(() => runMigrations(database, [broken])).toThrow(/half a schema/)
    expect(tableNames(database)).not.toContain('alpha')
    expect(appliedMigrationIds(database)).toEqual([])
  })

  it('names the migration that failed, since the id alone says nothing', () => {
    const database = emptyDatabase()
    const broken: Migration = {
      id: 7,
      name: 'add calendar events',
      up: () => {
        throw new Error('no such column: whoops')
      },
    }

    expect(() => runMigrations(database, [broken])).toThrow(
      /migration 7 \(add calendar events\).*no such column: whoops/s,
    )
  })

  it('refuses a set with a duplicate id rather than silently skipping one', () => {
    const database = emptyDatabase()

    expect(() =>
      runMigrations(database, [countingMigration(1, 'alpha'), countingMigration(1, 'beta')]),
    ).toThrow(/duplicate migration id 1/)
  })
})

describe('the shipped migrations', () => {
  it('are numbered uniquely and consecutively from 1', () => {
    expect(migrations.map((migration) => migration.id)).toEqual(
      migrations.map((_, index) => index + 1),
    )
  })

  it('bring an empty database up to the full schema', () => {
    const database = emptyDatabase()

    runMigrations(database)

    expect(tableNames(database)).toEqual(
      expect.arrayContaining(['projects', 'tasks', 'task_tags', 'sources']),
    )
  })

  it('are idempotent as a whole, which is what startup relies on', () => {
    const database = emptyDatabase()
    runMigrations(database)

    expect(runMigrations(database).applied).toEqual([])
  })
})

/**
 * Migration 12 was amended in review, after PR #28 round 3, to add `accumulator_version` to
 * `mcp_sessions`. Anyone whose database ran the pre-amendment migration 12 has that id recorded
 * in `schema_migrations` forever, since the runner tracks ids and never re-applies one, and is
 * stuck without the column even though the migration's own file now includes it. Migration 14
 * exists to backfill that gap, additively and without touching any row's data.
 */
describe('migration 14 (mcp accumulator version backfill)', () => {
  /** The shape `mcp_sessions` had under the pre-amendment migration 12: no accumulator_version. */
  function withPreAmendmentMcpSessions(): Database {
    const database = emptyDatabase()
    database.exec(`
      create table mcp_sessions (
        id text primary key,
        client_key text not null,
        last_seen_at integer not null,
        created_at integer not null
      )
    `)
    database
      .prepare(
        'insert into mcp_sessions (id, client_key, last_seen_at, created_at) values (?, ?, ?, ?)',
      )
      .run('session-1', 'unnamed', 100, 0)

    return database
  }

  it("adds the column when it is missing, which is this user's real database", () => {
    const database = withPreAmendmentMcpSessions()

    expect(() => mcpAccumulatorVersion.up(database)).not.toThrow()

    expect(columnsOf(database, 'mcp_sessions')).toContain('accumulator_version')
  })

  it("defaults the backfilled column to 0, matching migration 12's own default", () => {
    const database = withPreAmendmentMcpSessions()

    mcpAccumulatorVersion.up(database)

    expect(
      database
        .prepare('select accumulator_version from mcp_sessions where id = ?')
        .get('session-1'),
    ).toMatchObject({ accumulator_version: 0 })
  })

  it('loses no existing row while backfilling the column', () => {
    const database = withPreAmendmentMcpSessions()

    mcpAccumulatorVersion.up(database)

    expect(
      database
        .prepare('select client_key, last_seen_at from mcp_sessions where id = ?')
        .get('session-1'),
    ).toMatchObject({ client_key: 'unnamed', last_seen_at: 100 })
  })

  /**
   * Any database that ran the amended migration 12, or that ran migration 12 for the first
   * time after this fix shipped, already has the column: `alter table add column` fails
   * outright on a column that exists, so this has to be a genuine no-op rather than a retry.
   */
  it('is a no-op against a database that already has the column', () => {
    const database = emptyDatabase()
    database.exec(`
      create table mcp_sessions (
        id text primary key,
        client_key text not null,
        last_seen_at integer not null,
        accumulator_version integer not null default 0,
        created_at integer not null
      )
    `)
    database
      .prepare(
        `insert into mcp_sessions (id, client_key, last_seen_at, accumulator_version, created_at)
         values (?, ?, ?, ?, ?)`,
      )
      .run('session-1', 'unnamed', 100, 5, 0)

    expect(() => mcpAccumulatorVersion.up(database)).not.toThrow()
    expect(
      database
        .prepare('select accumulator_version from mcp_sessions where id = ?')
        .get('session-1'),
    ).toMatchObject({ accumulator_version: 5 })
  })

  it('runs cleanly as part of the full shipped set, against a brand new database', () => {
    const database = emptyDatabase()

    runMigrations(database)

    expect(columnsOf(database, 'mcp_sessions')).toContain('accumulator_version')
  })
})

/**
 * Migration 15 rebuilds `tasks`, which is the first table rebuild in the tree, and the one line
 * standing between it and a cascade is `withoutForeignKeys: true` on the migration. On an empty
 * database there is nothing for that cascade to destroy, so every test above passes with the line
 * deleted. These run against a populated one, where deleting it wipes `task_tags` and
 * `classifications` and nulls every `sources.task_id` and `daily_plan_entries.task_id`.
 *
 * Spec 01, criteria 7 and 12.
 */
describe('migration 15 (the tasks rebuild)', () => {
  const upToFourteen = migrations.filter((migration) => migration.id <= 14)

  function countOf(database: Database, table: string): number {
    const row = database.prepare(`select count(*) as total from ${table}`).get()
    return Number((row as { total: unknown }).total)
  }

  function foreignKeysOn(database: Database): boolean {
    const row = database.prepare('pragma foreign_keys').get()
    return Number((row as { foreign_keys: unknown }).foreign_keys) === 1
  }

  /**
   * Migration 14's schema, with a row in every table that points at `tasks`. Written in SQL rather
   * than through the repositories, because the repositories are written against the schema this
   * migration produces and would not compile against the one it starts from.
   */
  function populatedAtFourteen(): Database {
    const database = emptyDatabase()
    runMigrations(database, upToFourteen)

    database.exec(`
      insert into tasks (
        id, title, notes, status, project_id, sort_order, estimate_minutes, due_at, defer_until,
        waiting_on, status_set_by, status_set_at, previous_status, previous_status_set_by,
        sync_tracked, created_at, updated_at, completed_at
      ) values (
        'task-1', 'Book the venue', 'The one by the river', 'next_action', null, 3, 45, 900, 800,
        'Legal', 'user', 100, 'inbox', 'llm', 1, 50, 100, null
      )
    `)
    database.exec(`insert into task_tags (task_id, tag) values ('task-1', 'admin')`)
    database.exec(`
      insert into classifications (
        id, task_id, proposed_status, confidence, reasoning, prompt_version, applied, created_at
      ) values ('classification-1', 'task-1', 'next_action', 0.8, 'It reads as a task', 'v1', 1, 60)
    `)
    database.exec(`
      insert into sources (
        id, provider, external_id, task_id, first_seen_at, last_seen_at
      ) values ('source-1', 'gmail', 'message-1', 'task-1', 40, 60)
    `)
    database.exec(`
      insert into daily_plans (
        id, plan_date, generated_at, time_zone, window_minutes, busy_minutes, reserve_minutes,
        capacity_minutes, capacity_verified, prompt_version
      ) values ('plan-1', '2026-08-24', 70, 'Europe/London', 480, 60, 30, 390, 1, 'v1')
    `)
    database.exec(`
      insert into daily_plan_entries (
        id, plan_id, kind, rank, task_id, title, pushed_since_review
      ) values ('entry-1', 'plan-1', 'plan', 1, 'task-1', 'Book the venue', 0)
    `)

    return database
  }

  it('keeps every row in the tables whose foreign keys cascade off tasks', () => {
    const database = populatedAtFourteen()

    expect(runMigrations(database, migrations).applied).toEqual([15])

    expect(countOf(database, 'task_tags')).toBe(1)
    expect(countOf(database, 'classifications')).toBe(1)
  })

  it('leaves the references that would have been nulled pointing at the task', () => {
    const database = populatedAtFourteen()

    runMigrations(database, migrations)

    expect(database.prepare('select task_id from sources where id = ?').get('source-1')).toEqual({
      task_id: 'task-1',
    })
    expect(
      database.prepare('select task_id from daily_plan_entries where id = ?').get('entry-1'),
    ).toEqual({ task_id: 'task-1' })
  })

  it('carries every column of the task itself across the rebuild, with no blocker', () => {
    const database = populatedAtFourteen()

    runMigrations(database, migrations)

    expect(database.prepare('select * from tasks where id = ?').get('task-1')).toEqual({
      id: 'task-1',
      title: 'Book the venue',
      notes: 'The one by the river',
      status: 'next_action',
      project_id: null,
      sort_order: 3,
      estimate_minutes: 45,
      due_at: 900,
      defer_until: 800,
      waiting_on: 'Legal',
      blocked_by: null,
      status_set_by: 'user',
      status_set_at: 100,
      previous_status: 'inbox',
      previous_status_set_by: 'llm',
      sync_tracked: 1,
      created_at: 50,
      updated_at: 100,
      completed_at: null,
    })
  })

  it('leaves no dangling reference behind, which is the check the rebuild runs on itself', () => {
    const database = populatedAtFourteen()

    runMigrations(database, migrations)

    expect(database.prepare('pragma foreign_key_check').all()).toEqual([])
  })

  /**
   * The pragma is the runner's to set and the runner's to put back. A connection left with keys
   * off enforces none of the orphaning rules in the schema, and the connection this ran on is the
   * one the process then serves every request from.
   */
  it('puts foreign keys back on once the rebuild has run', () => {
    const database = populatedAtFourteen()
    expect(foreignKeysOn(database)).toBe(true)

    runMigrations(database, migrations)

    expect(foreignKeysOn(database)).toBe(true)
  })

  it('puts foreign keys back on even when the migration throws', () => {
    const database = emptyDatabase()
    const broken: Migration = {
      id: 1,
      name: 'a rebuild that failed',
      withoutForeignKeys: true,
      up: () => {
        throw new Error('the rebuild blew up')
      },
    }

    expect(() => runMigrations(database, [broken])).toThrow(/a rebuild that failed/)

    expect(foreignKeysOn(database)).toBe(true)
  })

  /**
   * Step ten of SQLite's twelve-step rebuild, and the reason it is inside the transaction. The
   * violation is planted with the keys off, which is the only way a database can come to hold one,
   * and is what a hand-edited file would look like.
   */
  it('rolls the rebuild back when foreign_key_check finds a violation', () => {
    const database = populatedAtFourteen()
    database.exec('pragma foreign_keys = OFF')
    database.exec(`update tasks set project_id = 'no-such-project' where id = 'task-1'`)
    database.exec('pragma foreign_keys = ON')

    expect(() => runMigrations(database, migrations)).toThrow(/foreign key violations/)

    expect(columnsOf(database, 'tasks')).not.toContain('blocked_by')
    expect(appliedMigrationIds(database)).not.toContain(15)
    expect(countOf(database, 'task_tags')).toBe(1)
  })
})
