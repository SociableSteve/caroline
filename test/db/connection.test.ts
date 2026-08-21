import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { openDatabase, withTransaction, type Database } from '../../src/db/connection.js'
import { migratedDatabase } from '../helpers/temp-database.js'

/** A handle that records what it was asked to run, and fails the statements it is told to. */
function recordingDatabase(failures: Readonly<Record<string, string>>): {
  database: Database
  statements: string[]
} {
  const statements: string[] = []
  const database = {
    exec(statement: string): void {
      statements.push(statement)
      const message = failures[statement]
      if (message !== undefined) throw new Error(message)
    },
  } as unknown as Database

  return { database, statements }
}

describe('withTransaction', () => {
  it('commits the work and returns its result', () => {
    const database = migratedDatabase()

    const result = withTransaction(database, () => {
      database
        .prepare(
          'insert into projects (id, title, state, created_at, updated_at) values (?, ?, ?, 0, 0)',
        )
        .run('project-1', 'Ship Caroline', 'active')
      return 'committed'
    })

    expect(result).toBe('committed')
    expect(database.prepare('select count(*) as count from projects').get()).toMatchObject({
      count: 1,
    })
  })

  it('rolls back the work when it throws', () => {
    const database = migratedDatabase()

    expect(() =>
      withTransaction(database, () => {
        database
          .prepare(
            'insert into projects (id, title, state, created_at, updated_at) values (?, ?, ?, 0, 0)',
          )
          .run('project-1', 'Ship Caroline', 'active')
        throw new Error('the work failed')
      }),
    ).toThrow('the work failed')

    expect(database.prepare('select count(*) as count from projects').get()).toMatchObject({
      count: 0,
    })
  })

  // SQLite aborts the transaction itself on errors such as SQLITE_FULL, which makes the
  // explicit rollback fail. The original failure is the one worth reporting.
  it('reports the original failure when the rollback itself fails', () => {
    const { database, statements } = recordingDatabase({
      rollback: 'cannot rollback - no transaction is active',
    })

    expect(() =>
      withTransaction(database, () => {
        throw new Error('the work failed')
      }),
    ).toThrow('the work failed')

    expect(statements).toEqual(['begin', 'rollback'])
  })

  it('reports the original failure when the commit fails and the rollback fails too', () => {
    const { database, statements } = recordingDatabase({
      commit: 'disk I/O error',
      rollback: 'cannot rollback - no transaction is active',
    })

    expect(() => withTransaction(database, () => 'unused')).toThrow('disk I/O error')
    expect(statements).toEqual(['begin', 'commit', 'rollback'])
  })
})

/**
 * SQLite has no nested transactions, so a repository function that wraps its own writes
 * cannot be called from inside a caller's transaction without savepoints. It happens as soon
 * as a route composes two repository calls, which is what the task routes do.
 */
describe('withTransaction nested inside another', () => {
  it('uses a savepoint rather than a second begin', () => {
    const { database, statements } = recordingDatabase({})

    withTransaction(database, () => withTransaction(database, () => 'inner'))

    expect(statements).toEqual(['begin', 'savepoint caroline_1', 'release caroline_1', 'commit'])
  })

  it('commits the outer work and the inner work together', () => {
    const database = migratedDatabase()
    const insert = (id: string) =>
      database
        .prepare(
          'insert into projects (id, title, state, created_at, updated_at) values (?, ?, ?, 0, 0)',
        )
        .run(id, 'Ship Caroline', 'active')

    withTransaction(database, () => {
      insert('outer')
      withTransaction(database, () => insert('inner'))
    })

    expect(database.prepare('select count(*) as count from projects').get()).toMatchObject({
      count: 2,
    })
  })

  it('rolls the inner work back to its savepoint, leaving the outer work standing', () => {
    const database = migratedDatabase()
    const insert = (id: string) =>
      database
        .prepare(
          'insert into projects (id, title, state, created_at, updated_at) values (?, ?, ?, 0, 0)',
        )
        .run(id, 'Ship Caroline', 'active')

    withTransaction(database, () => {
      insert('outer')
      try {
        withTransaction(database, () => {
          insert('inner')
          throw new Error('the inner work failed')
        })
      } catch {
        // Deliberately swallowed: the point is that the outer transaction survives it.
      }
    })

    expect(
      database
        .prepare('select id from projects order by id')
        .all()
        .map((row) => row.id),
    ).toEqual(['outer'])
  })

  it('rolls everything back when the failure reaches the outermost transaction', () => {
    const database = migratedDatabase()
    const insert = (id: string) =>
      database
        .prepare(
          'insert into projects (id, title, state, created_at, updated_at) values (?, ?, ?, 0, 0)',
        )
        .run(id, 'Ship Caroline', 'active')

    expect(() =>
      withTransaction(database, () => {
        insert('outer')
        withTransaction(database, () => insert('inner'))
        throw new Error('the outer work failed')
      }),
    ).toThrow('the outer work failed')

    expect(database.prepare('select count(*) as count from projects').get()).toMatchObject({
      count: 0,
    })
  })

  it('returns to the outermost level after a nested transaction, so the next one begins', () => {
    const { database, statements } = recordingDatabase({})

    withTransaction(database, () => withTransaction(database, () => 'inner'))
    withTransaction(database, () => 'second')

    expect(statements.slice(-2)).toEqual(['begin', 'commit'])
  })

  it('leaves the level unchanged when the nested work throws', () => {
    const { database, statements } = recordingDatabase({})

    withTransaction(database, () => {
      try {
        withTransaction(database, () => {
          throw new Error('the inner work failed')
        })
      } catch {
        // See above.
      }
      withTransaction(database, () => 'sibling')
    })

    expect(statements).toEqual([
      'begin',
      'savepoint caroline_1',
      // Released as well as rolled back, so the savepoint does not outlive the failure it
      // was undoing and the stack cannot grow through repeated caught failures.
      'rollback to caroline_1; release caroline_1',
      'savepoint caroline_1',
      'release caroline_1',
      'commit',
    ])
  })
})

/**
 * Spec 09: "There is no encryption at rest beyond filesystem permissions", which is only a
 * posture if the permissions are actually set. Spec 09 criterion 23. `google-tokens.json` has
 * been 0600 since it was written; the database, which holds every task, note and stored body,
 * was left to whatever the umask happened to be, and on a default umask that is world-readable.
 */
describe('openDatabase and filesystem permissions (criterion 23)', () => {
  const modeOf = (path: string) => statSync(path).mode & 0o777

  it('creates the data directory owner-only and the database owner read and write', () => {
    const directory = join(mkdtempSync(join(tmpdir(), 'caroline-modes-')), 'data')
    const path = join(directory, 'caroline.db')

    const database = openDatabase(path)
    // WAL mode creates the sidecars on the first write rather than at open, so this is what
    // makes the assertion about them an assertion about something that exists.
    database.exec('create table probe (id integer primary key)')
    database.exec('insert into probe (id) values (1)')

    expect(modeOf(directory)).toBe(0o700)
    expect(modeOf(path)).toBe(0o600)
    expect(modeOf(`${path}-wal`)).toBe(0o600)
    expect(modeOf(`${path}-shm`)).toBe(0o600)

    database.close()
    rmSync(directory, { recursive: true, force: true })
  })

  it('tightens a database that was already there with a wider mode, and leaves a directory it did not create alone', () => {
    const directory = mkdtempSync(join(tmpdir(), 'caroline-modes-'))
    const path = join(directory, 'caroline.db')
    writeFileSync(path, '')
    chmodSync(path, 0o644)
    chmodSync(directory, 0o755)

    const database = openDatabase(path)

    expect(modeOf(path)).toBe(0o600)
    // `database.path` may point somewhere of the user's own, so a directory this did not create
    // is left as it was found: the file is Caroline's to narrow and the directory is not.
    expect(modeOf(directory)).toBe(0o755)

    database.close()
    rmSync(directory, { recursive: true, force: true })
  })

  it('opens an in-memory database without touching the filesystem', () => {
    // `isFilePath` already draws this line for the deletion command, and it is the same line
    // here: there is no file to chmod, and no directory to have created.
    expect(() => openDatabase(':memory:').close()).not.toThrow()
  })
})
