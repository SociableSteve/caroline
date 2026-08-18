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
