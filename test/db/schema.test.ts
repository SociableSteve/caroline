import { describe, expect, it } from 'vitest'
import {
  calendarEventStatuses,
  calendarResponseStatuses,
  calendarTransparencies,
} from '../../src/domain/calendar.js'
import {
  chatChangeEntities,
  chatConfirmationDecisions,
  chatConfirmationReasons,
  chatRoles,
} from '../../src/domain/chat.js'
import { planEntryKinds } from '../../src/domain/plan.js'
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

/**
 * Calendar events exist to compute capacity and nothing else. The strongest thing the schema
 * can say about spec 02 criterion 7 is that there is nowhere to write a task id.
 */
describe('a calendar event', () => {
  interface EventFields {
    responseStatus: string
    transparency: string
    status: string
    startsAt: number
    endsAt: number
  }

  function insertEvent(overrides: Partial<EventFields> = {}): void {
    const {
      responseStatus = 'accepted',
      transparency = 'opaque',
      status = 'confirmed',
      startsAt = 0,
      endsAt = 3_600_000,
    } = overrides

    migratedDatabase()
      .prepare(
        `insert into calendar_events (id, calendar_id, external_id, starts_at, ends_at, all_day,
           response_status, transparency, status, synced_at)
         values ('event-1', 'primary', 'abc', ?, ?, 0, ?, ?, ?, 0)`,
      )
      .run(startsAt, endsAt, responseStatus, transparency, status)
  }

  /** Spec 02, criterion 7, said in the schema: there is nowhere to write a task id. */
  it('has no column a task could be attached to', () => {
    const columns = migratedDatabase()
      .prepare('select name from pragma_table_info(?)')
      .all('calendar_events')
      .map((row) => String((row as { name: unknown }).name))

    expect(columns).not.toContain('task_id')
  })

  it.each(calendarResponseStatuses)('accepts %s as a response status', (responseStatus) => {
    expect(() => insertEvent({ responseStatus })).not.toThrow()
  })

  it('rejects a response status the domain does not define', () => {
    expect(() => insertEvent({ responseStatus: 'maybe' })).toThrow(/constraint/i)
  })

  it.each(calendarTransparencies)('accepts %s as a transparency', (transparency) => {
    expect(() => insertEvent({ transparency })).not.toThrow()
  })

  it('rejects a transparency the domain does not define', () => {
    expect(() => insertEvent({ transparency: 'translucent' })).toThrow(/constraint/i)
  })

  it.each(calendarEventStatuses)('accepts %s as an event status', (status) => {
    expect(() => insertEvent({ status })).not.toThrow()
  })

  it('rejects an event status the domain does not define', () => {
    expect(() => insertEvent({ status: 'postponed' })).toThrow(/constraint/i)
  })

  /** A negative duration would subtract from the busy total rather than adding to it. */
  it('rejects one that ends before it starts', () => {
    expect(() => insertEvent({ startsAt: 3_600_000, endsAt: 0 })).toThrow(/constraint/i)
  })

  it('rejects a second row for the same event on the same calendar', () => {
    const database = migratedDatabase()
    const insert = database.prepare(
      `insert into calendar_events (id, calendar_id, external_id, starts_at, ends_at, all_day,
         response_status, transparency, status, synced_at)
       values (?, 'primary', 'abc', 0, 1, 0, 'accepted', 'opaque', 'confirmed', 0)`,
    )
    insert.run('event-1')

    expect(() => insert.run('event-2')).toThrow(/unique/i)
  })
})

/** A plan's three sections. An entry outside them would be a part of the plan nothing renders. */
describe('a daily plan entry', () => {
  /** A database holding one plan, ready for entries to be added to it. */
  function withPlan() {
    const database = migratedDatabase()
    database
      .prepare(
        `insert into daily_plans (id, plan_date, generated_at, time_zone, window_minutes,
           busy_minutes, reserve_minutes, capacity_minutes, capacity_verified, prompt_version)
         values ('plan-1', '2026-06-08', 0, 'UTC', 510, 0, 102, 408, 1, '2026-08-10')`,
      )
      .run()

    const insert = database.prepare(
      `insert into daily_plan_entries (id, plan_id, kind, rank, title)
       values (?, 'plan-1', ?, ?, 'Book the venue')`,
    )

    return { database, add: (id: string, kind: string, rank = 1) => insert.run(id, kind, rank) }
  }

  it.each(planEntryKinds)('accepts %s as a kind of entry', (kind) => {
    const { add } = withPlan()

    expect(() => add('entry-1', kind)).not.toThrow()
  })

  it('rejects a kind the repository does not define', () => {
    const { add } = withPlan()

    expect(() => add('entry-1', 'someday-maybe')).toThrow(/constraint/i)
  })

  it('rejects two entries at the same position in the same section', () => {
    const { add } = withPlan()
    add('entry-1', 'plan', 1)

    expect(() => add('entry-2', 'plan', 1)).toThrow(/unique/i)
  })

  /** The same position in two different sections is two different positions. */
  it('allows the same rank in a different section', () => {
    const { add } = withPlan()
    add('entry-1', 'plan', 1)

    expect(() => add('entry-2', 'overflow', 1)).not.toThrow()
  })

  it('rejects a rank of zero, since a plan is numbered from one', () => {
    const { add } = withPlan()

    expect(() => add('entry-1', 'plan', 0)).toThrow(/constraint/i)
  })

  it('goes when its plan goes, since an entry without a plan is not part of anything', () => {
    const { database, add } = withPlan()
    add('entry-1', 'plan', 1)

    database.prepare('delete from daily_plans where id = ?').run('plan-1')

    expect(
      database.prepare('select count(*) as count from daily_plan_entries').get(),
    ).toMatchObject({ count: 0 })
  })
})

/**
 * The chat tables. Spec 07's rules are enforced in `src/chat`, and the ones the schema can hold on
 * its own are held here too: a user turn that claims to have spent tokens, a confirmation that is
 * half-decided, and a change or a confirmation belonging to a turn that has gone.
 */
describe('a chat row', () => {
  function withConversation() {
    const database = migratedDatabase()
    database
      .prepare(
        `insert into chat_conversations (id, title, created_at, updated_at)
         values ('conversation-1', 'Triage my inbox', 0, 0)`,
      )
      .run()

    const addMessage = (id: string, role: string, seq: number, extra = '', values = '') =>
      database
        .prepare(
          `insert into chat_messages (id, conversation_id, seq, role, content, created_at${extra})
           values (?, 'conversation-1', ?, ?, 'Hello', 0${values})`,
        )
        .run(id, seq, role)

    return { database, addMessage }
  }

  it.each(chatRoles)('accepts %s as a role', (role) => {
    const { addMessage } = withConversation()

    expect(() => addMessage('message-1', role, 1)).not.toThrow()
  })

  it('rejects a role the domain does not define', () => {
    const { addMessage } = withConversation()

    expect(() => addMessage('message-1', 'system', 1)).toThrow(/constraint/i)
  })

  it('rejects two messages at the same position in one conversation', () => {
    const { addMessage } = withConversation()
    addMessage('message-1', 'user', 1)

    expect(() => addMessage('message-2', 'assistant', 1)).toThrow(/unique/i)
  })

  /** A user turn that spent tokens would be a row nothing could act on and a wrong usage total. */
  it('rejects a user turn carrying token usage', () => {
    const { addMessage } = withConversation()

    expect(() => addMessage('message-1', 'user', 1, ', input_tokens', ', 100')).toThrow(
      /constraint/i,
    )
  })

  it('rejects a user turn that claims to have called a tool', () => {
    const { addMessage } = withConversation()

    expect(() => addMessage('message-1', 'user', 1, ', tool_calls', ', 3')).toThrow(/constraint/i)
  })

  it('accepts an assistant turn carrying usage, which is the point of the columns', () => {
    const { addMessage } = withConversation()

    expect(() =>
      addMessage('message-1', 'assistant', 1, ', input_tokens, output_tokens', ', 100, 40'),
    ).not.toThrow()
  })

  it('goes with its conversation, since a turn of nothing is nothing', () => {
    const { database, addMessage } = withConversation()
    addMessage('message-1', 'user', 1)

    database.prepare('delete from chat_conversations where id = ?').run('conversation-1')

    expect(database.prepare('select count(*) as count from chat_messages').get()).toMatchObject({
      count: 0,
    })
  })
})

describe('a chat change', () => {
  function withTurn() {
    const database = migratedDatabase()
    database
      .prepare(
        `insert into chat_conversations (id, title, created_at, updated_at)
         values ('conversation-1', 'Triage my inbox', 0, 0)`,
      )
      .run()
    database
      .prepare(
        `insert into chat_messages (id, conversation_id, seq, role, content, created_at)
         values ('message-1', 'conversation-1', 1, 'assistant', 'Done.', 0)`,
      )
      .run()

    const add = (id: string, entity: string, position = 1) =>
      database
        .prepare(
          `insert into chat_changes (id, message_id, position, tool, summary, entity, created_at)
           values (?, 'message-1', ?, 'complete_task', 'Completed it', ?, 0)`,
        )
        .run(id, position, entity)

    return { database, add }
  }

  it.each(chatChangeEntities)('accepts %s as the thing that changed', (entity) => {
    const { add } = withTurn()

    expect(() => add('change-1', entity)).not.toThrow()
  })

  it('rejects an entity the domain does not define', () => {
    const { add } = withTurn()

    expect(() => add('change-1', 'calendar_event')).toThrow(/constraint/i)
  })

  it('rejects two changes at the same position in one turn', () => {
    const { add } = withTurn()
    add('change-1', 'task', 1)

    expect(() => add('change-2', 'task', 1)).toThrow(/unique/i)
  })

  it('goes with its turn', () => {
    const { database, add } = withTurn()
    add('change-1', 'task')

    database.prepare('delete from chat_messages where id = ?').run('message-1')

    expect(database.prepare('select count(*) as count from chat_changes').get()).toMatchObject({
      count: 0,
    })
  })
})

describe('a chat confirmation', () => {
  function withTurn() {
    const database = migratedDatabase()
    database
      .prepare(
        `insert into chat_conversations (id, title, created_at, updated_at)
         values ('conversation-1', 'Triage my inbox', 0, 0)`,
      )
      .run()
    database
      .prepare(
        `insert into chat_messages (id, conversation_id, seq, role, content, created_at)
         values ('message-1', 'conversation-1', 1, 'assistant', 'Held.', 0)`,
      )
      .run()

    const add = (columns: string, values: string) =>
      database
        .prepare(
          `insert into chat_confirmations (id, message_id, tool, arguments, affected_count,
             summary, created_at, ${columns})
           values ('confirmation-1', 'message-1', 'delete_task', '{}', 1, 'Delete it', 0, ${values})`,
        )
        .run()

    const addWithCount = (affectedCount: number) =>
      database
        .prepare(
          `insert into chat_confirmations (id, message_id, reason, tool, arguments, affected_count,
             summary, created_at)
           values ('confirmation-2', 'message-1', 'delete', 'delete_task', '{}', ?, 'Delete it', 0)`,
        )
        .run(affectedCount)

    return { add, addWithCount }
  }

  it.each(chatConfirmationReasons)('accepts %s as a reason to hold an operation', (reason) => {
    const { add } = withTurn()

    expect(() => add('reason', `'${reason}'`)).not.toThrow()
  })

  it('rejects a reason the domain does not define', () => {
    const { add } = withTurn()

    expect(() => add('reason', "'looks risky'")).toThrow(/constraint/i)
  })

  it.each(chatConfirmationDecisions)('accepts %s as a decision', (decision) => {
    const { add } = withTurn()

    expect(() => add('reason, decision, decided_at', `'delete', '${decision}', 100`)).not.toThrow()
  })

  it('rejects a decision the domain does not define', () => {
    const { add } = withTurn()

    expect(() => add('reason, decision, decided_at', "'delete', 'maybe', 100")).toThrow(
      /constraint/i,
    )
  })

  /** Decided and undecided are one fact. Half of it would be a state nothing could report. */
  it('rejects a decision with no moment attached to it', () => {
    const { add } = withTurn()

    expect(() => add('reason, decision', "'delete', 'confirmed'")).toThrow(/constraint/i)
  })

  it('rejects a moment with no decision attached to it', () => {
    const { add } = withTurn()

    expect(() => add('reason, decided_at', "'delete', 100")).toThrow(/constraint/i)
  })

  it('rejects one that affects nothing, since there would be nothing to confirm', () => {
    const { addWithCount } = withTurn()

    expect(() => addWithCount(0)).toThrow(/constraint/i)
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
