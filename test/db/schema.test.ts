import { describe, expect, it } from 'vitest'
import { projectStates } from '../../src/domain/project.js'
import { statusActors, taskStatuses } from '../../src/domain/task.js'
import { migratedDatabase } from '../helpers/temp-database.js'

/**
 * The migration writes its allowed values out literally, because a migration is a frozen
 * record and must not change when a domain constant does. These tests are what keeps the
 * two honest: add a status to the domain without a migration for it and this goes red.
 */
describe('the schema and the domain constants', () => {
  function insertTask(status: string, statusSetBy = 'user'): void {
    const database = migratedDatabase()
    database
      .prepare(
        `insert into tasks (id, title, status, sort_order, status_set_by, status_set_at,
           sync_tracked, created_at, updated_at)
         values (?, ?, ?, 0, ?, 0, 0, 0, 0)`,
      )
      .run('task-1', 'Book the venue', status, statusSetBy)
  }

  it.each(taskStatuses)('accepts %s, which the domain calls a valid status', (status) => {
    expect(() => insertTask(status)).not.toThrow()
  })

  it('rejects a status the domain does not define', () => {
    expect(() => insertTask('project')).toThrow(/constraint/i)
  })

  it.each(statusActors)('accepts %s as a status actor', (actor) => {
    expect(() => insertTask('inbox', actor)).not.toThrow()
  })

  it('rejects a status actor the domain does not define', () => {
    expect(() => insertTask('inbox', 'somebody_else')).toThrow(/constraint/i)
  })

  function insertProject(state: string): void {
    const database = migratedDatabase()
    database
      .prepare(
        'insert into projects (id, title, state, created_at, updated_at) values (?, ?, ?, 0, 0)',
      )
      .run('project-1', 'Ship Caroline', state)
  }

  it.each(projectStates)('accepts %s as a project state', (state) => {
    expect(() => insertProject(state)).not.toThrow()
  })

  it('rejects a project state the domain does not define', () => {
    expect(() => insertProject('paused')).toThrow(/constraint/i)
  })
})

describe('foreign keys', () => {
  it('are enforced, which every orphaning rule depends on', () => {
    const database = migratedDatabase()

    expect(database.prepare('pragma foreign_keys').get()).toMatchObject({ foreign_keys: 1 })
  })

  it('reject a task pointing at a project that does not exist', () => {
    const database = migratedDatabase()

    expect(() =>
      database
        .prepare(
          `insert into tasks (id, title, status, project_id, sort_order, status_set_by,
             status_set_at, sync_tracked, created_at, updated_at)
           values ('task-1', 'Book the venue', 'inbox', 'nonexistent', 0, 'user', 0, 0, 0, 0)`,
        )
        .run(),
    ).toThrow(/foreign key/i)
  })
})
