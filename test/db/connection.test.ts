import { describe, expect, it } from 'vitest'
import { withTransaction, type Database } from '../../src/db/connection.js'
import { migratedDatabase } from '../helpers/temp-database.js'

/** A handle that records what it was asked to run, and fails the statements it is told to. */
function recordingDatabase(failing: { statement: string; message: string }): {
  database: Database
  statements: string[]
} {
  const statements: string[] = []
  const database = {
    exec(statement: string): void {
      statements.push(statement)
      if (statement === failing.statement) throw new Error(failing.message)
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
      statement: 'rollback',
      message: 'cannot rollback - no transaction is active',
    })

    expect(() =>
      withTransaction(database, () => {
        throw new Error('the work failed')
      }),
    ).toThrow('the work failed')

    expect(statements).toEqual(['begin', 'rollback'])
  })

  it('reports the original failure when the commit fails and the rollback fails too', () => {
    const { database } = recordingDatabase({
      statement: 'commit',
      message: 'disk I/O error',
    })

    expect(() => withTransaction(database, () => 'unused')).toThrow('disk I/O error')
  })
})
