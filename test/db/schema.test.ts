import { describe, expect, it } from 'vitest'
import { jobRunStatuses, jobTriggers } from '../../src/domain/job.js'
import { llmCallStatuses, llmPurposes } from '../../src/domain/llm.js'
import { projectStates } from '../../src/domain/project.js'
import { sourceProviders } from '../../src/domain/source.js'
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

  function insertSource(provider: string): void {
    const database = migratedDatabase()
    database
      .prepare(
        `insert into sources (id, provider, external_id, first_seen_at, last_seen_at)
         values (?, ?, ?, 0, 0)`,
      )
      .run('source-1', provider, 'octo/widgets#42')
  }

  it.each(sourceProviders)('accepts %s as a source provider', (provider) => {
    expect(() => insertSource(provider)).not.toThrow()
  })

  it('rejects a source provider the domain does not define', () => {
    expect(() => insertSource('jira')).toThrow(/constraint/i)
  })

  function insertJobRun(status: string, trigger = 'scheduled'): void {
    const database = migratedDatabase()
    database
      .prepare(
        `insert into job_runs (id, job, trigger, started_at, finished_at, status)
         values (?, 'sync:github', ?, 0, 1, ?)`,
      )
      .run('run-1', trigger, status)
  }

  it.each(jobRunStatuses)('accepts %s as a job run status', (status) => {
    expect(() => insertJobRun(status)).not.toThrow()
  })

  it('rejects a job run status the domain does not define', () => {
    expect(() => insertJobRun('running')).toThrow(/constraint/i)
  })

  it.each(jobTriggers)('accepts %s as a job trigger', (trigger) => {
    expect(() => insertJobRun('success', trigger)).not.toThrow()
  })

  it('rejects a job trigger the domain does not define', () => {
    expect(() => insertJobRun('success', 'webhook')).toThrow(/constraint/i)
  })

  function insertLlmCall(status: string, purpose = 'classification', provider = 'anthropic'): void {
    const database = migratedDatabase()
    database
      .prepare(
        `insert into llm_calls (id, provider, model, purpose, started_at, duration_ms,
           input_tokens, output_tokens, status)
         values ('call-1', ?, 'a-model', ?, 0, 1, 0, 0, ?)`,
      )
      .run(provider, purpose, status)
  }

  it.each(llmCallStatuses)('accepts %s as an llm call status', (status) => {
    expect(() => insertLlmCall(status)).not.toThrow()
  })

  it('rejects an llm call status the domain does not define', () => {
    expect(() => insertLlmCall('retried')).toThrow(/constraint/i)
  })

  it.each(llmPurposes)('accepts %s as an llm call purpose', (purpose) => {
    expect(() => insertLlmCall('success', purpose)).not.toThrow()
  })

  it('rejects an llm call purpose the domain does not define', () => {
    expect(() => insertLlmCall('success', 'summarisation')).toThrow(/constraint/i)
  })

  /** `none` is a configuration state, not something that can have made a call. */
  it('rejects "none" as the provider of a call that was made', () => {
    expect(() => insertLlmCall('success', 'classification', 'none')).toThrow(/constraint/i)
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
