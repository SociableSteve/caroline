import { describe, expect, it } from 'vitest'
import { openDatabase } from '../../src/db/connection.js'
import { migrations } from '../../src/db/migrations/index.js'
import { appliedMigrationIds, runMigrations, type Migration } from '../../src/db/migrate.js'
import { emptyDatabase, temporaryDatabasePath } from '../helpers/temp-database.js'

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
