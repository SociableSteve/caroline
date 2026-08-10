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

  /**
   * SQLite column types are affinities rather than constraints, so without these checks a
   * negative token count would be stored as given and would subtract from a usage total.
   */
  function insertLlmCallWith(column: string, value: number): void {
    const database = migratedDatabase()
    database
      .prepare(
        `insert into llm_calls (id, provider, model, purpose, started_at, duration_ms,
           input_tokens, output_tokens, status)
         values ('call-1', 'anthropic', 'a-model', 'classification', 0,
           ${column === 'duration_ms' ? '?' : '1'},
           ${column === 'input_tokens' ? '?' : '0'},
           ${column === 'output_tokens' ? '?' : '0'},
           'success')`,
      )
      .run(value)
  }

  const countedColumns = ['duration_ms', 'input_tokens', 'output_tokens'] as const

  it.each(countedColumns)('rejects a negative %s', (column) => {
    expect(() => insertLlmCallWith(column, -1)).toThrow(/constraint/i)
  })

  it.each(countedColumns)('rejects a fractional %s', (column) => {
    expect(() => insertLlmCallWith(column, 1.5)).toThrow(/constraint/i)
  })

  it.each(countedColumns)('accepts a %s of zero, which is a real answer', (column) => {
    expect(() => insertLlmCallWith(column, 0)).not.toThrow()
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

/**
 * The `classifications` table records one decision per row. Spec 04 makes it the audit trail and the
 * evaluation set, so the states that would be two decisions are refused by the schema and not only
 * by the repository that writes it.
 */
describe('a classification row', () => {
  function insertClassification(columns: string, values: string): void {
    const database = migratedDatabase()
    database
      .prepare(
        `insert into tasks (id, title, status, sort_order, status_set_by, status_set_at,
           sync_tracked, created_at, updated_at)
         values ('task-1', 'Hub numbers', 'inbox', 0, 'sync', 0, 1, 0, 0)`,
      )
      .run()

    database
      .prepare(
        `insert into classifications (id, task_id, prompt_version, created_at, ${columns})
         values ('classification-1', 'task-1', '2026-08-10', 0, ${values})`,
      )
      .run()
  }

  it('accepts a proposal waiting on the user', () => {
    expect(() =>
      insertClassification('proposed_status, confidence, applied', "'next_action', 0.4, 0"),
    ).not.toThrow()
  })

  it('accepts an accepted proposal', () => {
    expect(() =>
      insertClassification(
        'proposed_status, confidence, applied, accepted_at',
        "'next_action', 0.4, 0, 100",
      ),
    ).not.toThrow()
  })

  it('accepts a failure, which has no proposal in it', () => {
    expect(() => insertClassification('applied, error', "0, 'the provider is down'")).not.toThrow()
  })

  it('rejects a row that is neither an answer nor a failure', () => {
    expect(() => insertClassification('applied', '0')).toThrow(/constraint/i)
  })

  it('rejects a proposal with no confidence attached to it', () => {
    expect(() => insertClassification('proposed_status, applied', "'next_action', 0")).toThrow(
      /constraint/i,
    )
  })

  it('rejects `done`, which the classifier may never propose', () => {
    expect(() =>
      insertClassification('proposed_status, confidence, applied', "'done', 0.9, 0"),
    ).toThrow(/constraint/i)
  })

  it.each([1.5, -0.1])('rejects a confidence of %s, outside 0 to 1', (confidence) => {
    expect(() =>
      insertClassification(
        'proposed_status, confidence, applied',
        `'next_action', ${confidence}, 0`,
      ),
    ).toThrow(/constraint/i)
  })

  /** Both ends are real answers, so the bound must not drift inwards either. */
  it.each([0, 1])('accepts a confidence of %s, which is an answer', (confidence) => {
    expect(() =>
      insertClassification(
        'proposed_status, confidence, applied',
        `'next_action', ${confidence}, 0`,
      ),
    ).not.toThrow()
  })

  it('rejects an applied row that was also accepted', () => {
    expect(() =>
      insertClassification(
        'proposed_status, confidence, applied, accepted_at',
        "'next_action', 0.9, 1, 100",
      ),
    ).toThrow(/constraint/i)
  })

  it('rejects an applied row that was also dismissed', () => {
    expect(() =>
      insertClassification(
        'proposed_status, confidence, applied, dismissed_at',
        "'next_action', 0.9, 1, 100",
      ),
    ).toThrow(/constraint/i)
  })

  it('rejects a row that was both accepted and dismissed', () => {
    expect(() =>
      insertClassification(
        'proposed_status, confidence, applied, accepted_at, dismissed_at',
        "'next_action', 0.4, 0, 100, 200",
      ),
    ).toThrow(/constraint/i)
  })

  it.each(['accepted_at', 'dismissed_at'])('rejects %s on a failed row', (column) => {
    expect(() => insertClassification(`applied, error, ${column}`, "0, 'nope', 100")).toThrow(
      /constraint/i,
    )
  })

  it('rejects an applied row that also failed', () => {
    expect(() =>
      insertClassification(
        'proposed_status, confidence, applied, error',
        "'next_action', 0.9, 1, 'nope'",
      ),
    ).toThrow(/constraint/i)
  })

  it('deletes with its task, since a proposal about nothing is nothing', () => {
    const database = migratedDatabase()
    database
      .prepare(
        `insert into tasks (id, title, status, sort_order, status_set_by, status_set_at,
           sync_tracked, created_at, updated_at)
         values ('task-1', 'Hub numbers', 'inbox', 0, 'sync', 0, 1, 0, 0)`,
      )
      .run()
    database
      .prepare(
        `insert into classifications (id, task_id, proposed_status, confidence, prompt_version,
           applied, created_at)
         values ('classification-1', 'task-1', 'next_action', 0.4, '2026-08-10', 0, 0)`,
      )
      .run()

    database.prepare('delete from tasks where id = ?').run('task-1')

    expect(database.prepare('select count(*) as count from classifications').get()).toMatchObject({
      count: 0,
    })
  })
})
