/**
 * The tools themselves, against a real migrated database. Spec 07's write policy, criterion 1 in
 * particular: every task or project mutated through chat is the user's decision, so the classifier
 * is locked out of it afterwards exactly as it is after a manual edit.
 */
import { describe, expect, it } from 'vitest'
import { loadConfig } from '../../src/config/load.js'
import { allChatTools } from '../../src/chat/registry.js'
import type { Config } from '../../src/config/schema.js'
import type { ChatTool, ChatToolContext, PlanRegeneration } from '../../src/chat/types.js'
import { upsertCalendarEvent } from '../../src/db/repositories/calendar-events.js'
import { recordClassification } from '../../src/db/repositories/classifications.js'
import { recordDailyPlan } from '../../src/db/repositories/daily-plans.js'
import { createProject, getProject } from '../../src/db/repositories/projects.js'
import { upsertSource } from '../../src/db/repositories/sources.js'
import { createTask, getTask, getTaskTags, setTaskTags } from '../../src/db/repositories/tasks.js'
import type { Database } from '../../src/db/connection.js'
import { migratedDatabase } from '../helpers/temp-database.js'
import { CHAT_NOW } from '../helpers/chat.js'

const config = loadConfig({
  file: { jobs: { timezone: 'Europe/London' } },
  env: {} as NodeJS.ProcessEnv,
})

/** The same configuration with one content level changed, for the tools the policy shapes. */
function policyAt(llmContent: string, snippetChars = 300): Config {
  return loadConfig({
    file: { privacy: { llmContent, snippetChars }, jobs: { timezone: 'Europe/London' } },
    env: {} as NodeJS.ProcessEnv,
  })
}

function tool(name: string): ChatTool {
  const found = allChatTools.find((candidate) => candidate.name === name)
  if (found === undefined) throw new Error(`no tool called ${name}`)
  return found
}

interface HarnessOptions {
  readonly calendarConnected?: boolean
  readonly regeneratePlan?: () => Promise<PlanRegeneration>
  /** For the tools whose answers the content policy shapes. Spec 09. */
  readonly config?: Config
}

function context(database: Database, options: HarnessOptions = {}): ChatToolContext {
  return {
    database,
    config: options.config ?? config,
    now: CHAT_NOW,
    calendarConnected: () => options.calendarConnected ?? false,
    regeneratePlan:
      options.regeneratePlan ??
      (() => Promise.resolve<PlanRegeneration>({ status: 'drawn', summary: 'A plan.' })),
  }
}

/** Runs a tool the way the loop does, and insists it answered rather than refused. */
async function run(database: Database, name: string, args: unknown, options?: HarnessOptions) {
  const outcome = await tool(name).execute(context(database, options), args)
  if (!outcome.ok) throw new Error(`${name} refused: ${outcome.message}`)
  return outcome
}

async function refuse(database: Database, name: string, args: unknown, options?: HarnessOptions) {
  const outcome = await tool(name).execute(context(database, options), args)
  if (outcome.ok) throw new Error(`${name} was expected to refuse and did not`)
  return outcome
}

describe('search_tasks', () => {
  it('finds a task by a substring of its title', async () => {
    const database = migratedDatabase()
    createTask(database, { id: 'task-1', title: 'Book the venue' }, CHAT_NOW)
    createTask(database, { id: 'task-2', title: 'Draft the agenda' }, CHAT_NOW)

    const answer = await run(database, 'search_tasks', { query: 'venue' })

    expect(answer.data).toMatchObject({
      total: 1,
      tasks: [{ id: 'task-1', title: 'Book the venue', status: 'inbox' }],
    })
  })

  it('filters by status', async () => {
    const database = migratedDatabase()
    createTask(database, { id: 'task-1', title: 'Book the venue' }, CHAT_NOW)
    createTask(
      database,
      { id: 'task-2', title: 'Draft the agenda', status: 'next_action' },
      CHAT_NOW,
    )

    const answer = await run(database, 'search_tasks', { status: ['next_action'] })

    expect(answer.data).toMatchObject({ total: 1, tasks: [{ id: 'task-2' }] })
  })

  it('names the project a task belongs to, so the model reads a name and not a uuid', async () => {
    const database = migratedDatabase()
    createProject(database, { id: 'project-1', title: 'Ship Caroline' }, CHAT_NOW)
    createTask(
      database,
      { id: 'task-1', title: 'Book the venue', projectId: 'project-1' },
      CHAT_NOW,
    )

    const answer = await run(database, 'search_tasks', {})

    expect(answer.data).toMatchObject({ tasks: [{ project: 'Ship Caroline' }] })
  })

  it('refuses a dueBefore that is not a date', async () => {
    const database = migratedDatabase()

    const outcome = await refuse(database, 'search_tasks', { dueBefore: '2026-02-30' })

    expect(outcome.message).toContain('is not a date')
  })

  /** Instants go as ISO strings, because a model cannot do arithmetic on epoch milliseconds. */
  it('answers a deadline as an ISO instant', async () => {
    const database = migratedDatabase()
    createTask(
      database,
      { id: 'task-1', title: 'Book the venue', dueAt: Date.UTC(2026, 5, 12, 9, 0, 0) },
      CHAT_NOW,
    )

    const answer = await run(database, 'search_tasks', {})

    expect(answer.data).toMatchObject({ tasks: [{ dueAt: '2026-06-12T09:00:00.000Z' }] })
  })
})

describe('get_task', () => {
  it('carries the source link and the classification history', async () => {
    const database = migratedDatabase()
    createTask(database, { id: 'task-1', title: 'Review the retry helper' }, CHAT_NOW)
    setTaskTags(database, 'task-1', ['review'])
    upsertSource(
      database,
      {
        provider: 'github',
        externalId: 'example-org/service#42',
        url: 'https://github.com/example-org/service/pull/42',
        title: 'Add a retry to the fetch helper',
        taskId: 'task-1',
        lifecycleState: 'awaiting_review',
      },
      CHAT_NOW,
    )
    recordClassification(
      database,
      {
        taskId: 'task-1',
        proposedStatus: 'review',
        confidence: 0.9,
        reasoning: 'It is a review request.',
        promptVersion: '2026-08-10',
        applied: true,
      },
      CHAT_NOW,
    )

    const answer = await run(database, 'get_task', { id: 'task-1' })

    expect(answer.data).toMatchObject({
      id: 'task-1',
      tags: ['review'],
      sources: [{ provider: 'github', lifecycleState: 'awaiting_review' }],
      classifications: [{ proposedStatus: 'review', confidence: 0.9, applied: true }],
    })
  })

  /**
   * Spec 09: the stored body is never sent to a model except through the content policy, and chat
   * has no business reopening that decision.
   */
  it('never returns a stored message body', async () => {
    const database = migratedDatabase()
    createTask(database, { id: 'task-1', title: 'A thread' }, CHAT_NOW)
    upsertSource(
      database,
      {
        provider: 'gmail',
        externalId: 'thread-1',
        taskId: 'task-1',
        content: 'The whole message, which must not travel.',
        contentLevel: 'full',
      },
      CHAT_NOW,
    )

    const answer = await run(database, 'get_task', { id: 'task-1' })

    expect(JSON.stringify(answer.data)).not.toContain('must not travel')
  })

  /**
   * Spec 09, criterion 13. A task's notes are its body-shaped field, so they leave the machine only as
   * far as `llmContent` allows, and this tool is held to that by the same function the item context
   * is: two answers to whether a note may be sent would mean the policy is decoration.
   */
  it('withholds the notes at metadata and still answers with the title', async () => {
    const database = migratedDatabase()
    createTask(
      database,
      { id: 'task-1', title: 'Review the contract', notes: 'Ring Ada about the indemnity clause.' },
      CHAT_NOW,
    )

    const answer = await run(
      database,
      'get_task',
      { id: 'task-1' },
      { config: policyAt('metadata') },
    )

    expect(answer.data).toMatchObject({ title: 'Review the contract', notes: null })
    expect(JSON.stringify(answer.data)).not.toContain('indemnity')
  })

  /**
   * Spec 09, criterion 13: at `none` nothing but the kind and the id appears, in a `get_task` result
   * as in the item context. Spec 07 says the tool and the context are answered by one policy, so a
   * level that withholds a title from the one cannot hand it over from the other.
   */
  it('withholds everything but the ids at none, and says the policy did', async () => {
    const database = migratedDatabase()
    createTask(
      database,
      { id: 'task-1', title: 'Review the Northwind contract', notes: 'Ring Ada about it.' },
      CHAT_NOW,
    )
    setTaskTags(database, 'task-1', ['legal'])

    const answer = await run(database, 'get_task', { id: 'task-1' }, { config: policyAt('none') })

    const serialised = JSON.stringify(answer.data)
    expect(answer.data).toMatchObject({ kind: 'task', id: 'task-1' })
    for (const withheld of ['Northwind', 'Ring Ada', 'inbox', 'legal', 'status', 'sources']) {
      expect(serialised).not.toContain(withheld)
    }
    // Said rather than left as a silence, so the model asks instead of answering from memory.
    expect(serialised).toMatch(/content policy/i)
  })

  it('truncates the notes at snippet and says it did', async () => {
    const database = migratedDatabase()
    createTask(
      database,
      { id: 'task-1', title: 'Review the contract', notes: `${'a'.repeat(30)}THE-TAIL` },
      CHAT_NOW,
    )

    const answer = await run(
      database,
      'get_task',
      { id: 'task-1' },
      { config: policyAt('snippet', 30) },
    )

    expect(answer.data).toMatchObject({ notes: 'a'.repeat(30), notesTruncated: true })
  })

  it('answers with the whole note at full, and claims no truncation', async () => {
    const database = migratedDatabase()
    createTask(database, { id: 'task-1', title: 'Review', notes: 'The whole thing.' }, CHAT_NOW)

    const answer = await run(database, 'get_task', { id: 'task-1' }, { config: policyAt('full') })

    expect(answer.data).toMatchObject({ notes: 'The whole thing.' })
    expect(answer.data).not.toHaveProperty('notesTruncated')
  })

  it('refuses an id that names nothing', async () => {
    const outcome = await refuse(migratedDatabase(), 'get_task', { id: 'nope' })

    expect(outcome.message).toContain('no task with the id nope')
  })
})

describe('list_projects', () => {
  it('marks an active project with nothing to do next as stalled', async () => {
    const database = migratedDatabase()
    createProject(database, { id: 'project-1', title: 'Ship Caroline' }, CHAT_NOW)
    createProject(database, { id: 'project-2', title: 'Move house' }, CHAT_NOW)
    createTask(
      database,
      {
        id: 'task-1',
        title: 'Book the venue',
        status: 'next_action',
        projectId: 'project-2',
      },
      CHAT_NOW,
    )

    const answer = await run(database, 'list_projects', {})

    expect(answer.data).toMatchObject({
      projects: [
        { id: 'project-1', stalled: true, nextAction: null },
        { id: 'project-2', stalled: false, nextAction: { id: 'task-1' } },
      ],
    })
  })

  it('filters by state without changing what stalled means', async () => {
    const database = migratedDatabase()
    createProject(database, { id: 'project-1', title: 'Ship Caroline' }, CHAT_NOW)
    createProject(
      database,
      { id: 'project-2', title: 'Learn the cello', state: 'someday' },
      CHAT_NOW,
    )

    const answer = await run(database, 'list_projects', { state: 'someday' })

    expect(answer.data).toMatchObject({ projects: [{ id: 'project-2', stalled: false }] })
  })
})

describe('get_daily_plan', () => {
  it('says so plainly when no plan has been drawn', async () => {
    const answer = await run(migratedDatabase(), 'get_daily_plan', {})

    expect(answer.data).toMatchObject({ plan: null, note: 'No plan has been drawn.' })
  })

  it('reads the plan for today, with its rationales and its overflow', async () => {
    const database = migratedDatabase()
    createTask(database, { id: 'task-1', title: 'Book the venue' }, CHAT_NOW)
    recordDailyPlan(database, {
      planDate: '2026-06-01',
      generatedAt: CHAT_NOW,
      timeZone: 'Europe/London',
      windowMinutes: 510,
      busyMinutes: 60,
      reserveMinutes: 102,
      capacityMinutes: 348,
      capacityVerified: true,
      provider: 'ollama',
      model: 'a-model',
      promptVersion: '2026-08-10',
      summary: 'A quiet day with one deadline.',
      warnings: [],
      entries: [
        {
          taskId: 'task-1',
          title: 'Book the venue',
          rank: 1,
          rationale: 'It is due today.',
          estimateMinutes: 30,
        },
      ],
      overflow: [],
      nudges: [],
    })

    const answer = await run(database, 'get_daily_plan', {})

    expect(answer.data).toMatchObject({
      date: '2026-06-01',
      summary: 'A quiet day with one deadline.',
      planned: [{ rank: 1, taskId: 'task-1', rationale: 'It is due today.', done: false }],
    })
  })
})

describe('get_capacity', () => {
  it('reports the working window and says the capacity is unverified with no calendar', async () => {
    const answer = await run(migratedDatabase(), 'get_capacity', {})

    expect(answer.data).toMatchObject({
      date: '2026-06-01',
      workingDay: true,
      windowMinutes: 510,
      busyMinutes: 0,
      verified: false,
    })
  })

  it('takes a meeting off the day and lists it', async () => {
    const database = migratedDatabase()
    upsertCalendarEvent(
      database,
      {
        calendarId: 'primary',
        externalId: 'event-1',
        summary: 'Standup',
        startsAt: Date.UTC(2026, 5, 1, 9, 0, 0),
        endsAt: Date.UTC(2026, 5, 1, 9, 30, 0),
        allDay: false,
        responseStatus: 'accepted',
        transparency: 'opaque',
        status: 'confirmed',
        attendeeCount: 4,
        url: null,
      },
      CHAT_NOW,
    )

    const answer = await run(database, 'get_capacity', {}, { calendarConnected: true })

    expect(answer.data).toMatchObject({
      busyMinutes: 30,
      verified: true,
      events: [{ summary: 'Standup', consumesCapacity: true }],
    })
  })

  it('says a Sunday is not a working day rather than reporting no capacity as a fact', async () => {
    const answer = await run(migratedDatabase(), 'get_capacity', { date: '2026-06-07' })

    expect(answer.data).toMatchObject({ workingDay: false, capacityMinutes: 0 })
  })
})

describe('list_waiting', () => {
  const DAY = 24 * 60 * 60_000

  function waitingDatabase(): Database {
    const database = migratedDatabase()
    createTask(
      database,
      {
        id: 'task-1',
        title: 'Sign-off from Ana',
        status: 'waiting',
        waitingOn: 'Ana',
      },
      CHAT_NOW - 10 * DAY,
    )
    createTask(
      database,
      { id: 'task-2', title: 'Invoice from the venue', status: 'waiting', waitingOn: 'the venue' },
      CHAT_NOW - DAY,
    )
    return database
  }

  it('dates each wait and flags the ones past the threshold', async () => {
    const answer = await run(waitingDatabase(), 'list_waiting', {})

    expect(answer.data).toMatchObject({
      staleAfterDays: 7,
      items: [
        { taskId: 'task-1', waitingOn: 'Ana', stale: true },
        { taskId: 'task-2', waitingOn: 'the venue', stale: false },
      ],
    })
  })

  it('returns only the stale ones when asked', async () => {
    const answer = await run(waitingDatabase(), 'list_waiting', { staleOnly: true })

    expect(answer.data).toMatchObject({ items: [{ taskId: 'task-1' }] })
  })
})

describe('create_task', () => {
  /** Criterion 1. A task chat created is the user's, so the classifier may not move it. */
  it('attributes the task to the user', async () => {
    const database = migratedDatabase()

    const answer = await run(database, 'create_task', { title: 'Book the venue' })
    const id = (answer.data as { id: string }).id

    expect(getTask(database, id)).toMatchObject({
      title: 'Book the venue',
      status: 'inbox',
      statusSetBy: 'user',
      syncTracked: false,
    })
  })

  it('files it where it was asked to and records what it did', async () => {
    const database = migratedDatabase()

    const answer = await run(database, 'create_task', {
      title: 'Draft the agenda',
      status: 'next_action',
      estimateMinutes: 45,
      dueAt: '2026-06-03',
    })

    expect(answer.mutations?.[0]).toMatchObject({
      summary: 'Created “Draft the agenda” in next_action',
      entity: 'task',
    })
    const id = (answer.data as { id: string }).id
    expect(getTask(database, id)).toMatchObject({
      status: 'next_action',
      statusSetBy: 'user',
      estimateMinutes: 45,
    })
  })

  /** A deadline is the end of the day named, so "due Wednesday" is not due at midnight. */
  it('takes a due date as the end of that local day', async () => {
    const database = migratedDatabase()

    const answer = await run(database, 'create_task', {
      title: 'Book the venue',
      dueAt: '2026-06-03',
    })

    const task = getTask(database, (answer.data as { id: string }).id)
    // 23:59:59.999 on the third, in Europe/London, which is one hour ahead in June.
    expect(task?.dueAt).toBe(Date.UTC(2026, 5, 3, 22, 59, 59, 999))
  })

  it('refuses a project that does not exist rather than failing on a foreign key', async () => {
    const outcome = await refuse(migratedDatabase(), 'create_task', {
      title: 'Book the venue',
      projectId: 'nope',
    })

    expect(outcome.message).toContain('no project with the id nope')
  })
})

describe('update_task', () => {
  it('attributes a status change to the user and says what changed', async () => {
    const database = migratedDatabase()
    createTask(database, { id: 'task-1', title: 'Book the venue', statusSetBy: 'llm' }, CHAT_NOW)

    const answer = await run(database, 'update_task', { id: 'task-1', status: 'next_action' })

    expect(getTask(database, 'task-1')).toMatchObject({
      status: 'next_action',
      statusSetBy: 'user',
    })
    expect(answer.mutations?.[0]?.summary).toBe('Updated “Book the venue”: to next_action')
  })

  it('leaves the fields it was not given alone', async () => {
    const database = migratedDatabase()
    createTask(
      database,
      { id: 'task-1', title: 'Book the venue', notes: 'The old hall', estimateMinutes: 30 },
      CHAT_NOW,
    )

    await run(database, 'update_task', { id: 'task-1', estimateMinutes: 60 })

    expect(getTask(database, 'task-1')).toMatchObject({
      title: 'Book the venue',
      notes: 'The old hall',
      estimateMinutes: 60,
    })
  })

  /**
   * Spec 01's sync tracking: filing a tracked task outside its connector's statuses is a permanent
   * opt-out, and doing it from chat is the same decision as doing it on the board.
   */
  it('opts a tracked task out of sync when it is filed outside the connector’s statuses', async () => {
    const database = migratedDatabase()
    createTask(
      database,
      { id: 'task-1', title: 'Review the helper', status: 'review', statusSetBy: 'sync' },
      CHAT_NOW,
    )
    upsertSource(
      database,
      { provider: 'github', externalId: 'example-org/service#42', taskId: 'task-1' },
      CHAT_NOW,
    )

    await run(database, 'update_task', { id: 'task-1', status: 'someday' })

    expect(getTask(database, 'task-1')).toMatchObject({
      status: 'someday',
      statusSetBy: 'user',
      syncTracked: false,
    })
  })

  /**
   * A user asking for a deadline to be taken off has to have a tool that can do it, and
   * `describeUpdate` renders 'due date cleared', which would otherwise be unreachable.
   */
  it('clears a deadline and a deferral when told null', async () => {
    const database = migratedDatabase()
    createTask(
      database,
      {
        id: 'task-1',
        title: 'Book the venue',
        dueAt: Date.UTC(2026, 5, 3, 9, 0, 0),
        deferUntil: Date.UTC(2026, 5, 2, 9, 0, 0),
      },
      CHAT_NOW,
    )

    const answer = await run(database, 'update_task', {
      id: 'task-1',
      dueAt: null,
      deferUntil: null,
    })

    expect(getTask(database, 'task-1')).toMatchObject({ dueAt: null, deferUntil: null })
    expect(answer.mutations?.[0]?.summary).toContain('due date cleared')
    expect(answer.mutations?.[0]?.summary).toContain('deferral cleared')
  })

  it('reports a patch that changed nothing as having changed nothing', async () => {
    const database = migratedDatabase()
    createTask(database, { id: 'task-1', title: 'Book the venue' }, CHAT_NOW)

    const answer = await run(database, 'update_task', { id: 'task-1', title: 'Book the venue' })

    expect(answer.mutations?.[0]?.summary).toBe('Left “Book the venue” as it was')
  })
})

describe('complete_task', () => {
  it('completes it as the user, and stamps the completion', async () => {
    const database = migratedDatabase()
    createTask(database, { id: 'task-1', title: 'Book the venue' }, CHAT_NOW)

    const answer = await run(database, 'complete_task', { id: 'task-1' })

    expect(getTask(database, 'task-1')).toMatchObject({
      status: 'done',
      statusSetBy: 'user',
      completedAt: CHAT_NOW,
    })
    expect(answer.mutations?.[0]?.summary).toBe('Completed “Book the venue”')
  })

  /** Not a refusal, and not a change either: an undo control against nothing would be a lie. */
  it('records no change when the task is already done', async () => {
    const database = migratedDatabase()
    createTask(database, { id: 'task-1', title: 'Book the venue', status: 'done' }, CHAT_NOW)

    const answer = await run(database, 'complete_task', { id: 'task-1' })

    expect(answer.data).toMatchObject({ alreadyDone: true })
    expect(answer.mutations ?? []).toEqual([])
  })
})

describe('mark_reviewed', () => {
  function reviewDatabase(): Database {
    const database = migratedDatabase()
    createTask(
      database,
      { id: 'task-1', title: 'Review the helper', status: 'review', statusSetBy: 'sync' },
      CHAT_NOW,
    )
    upsertSource(
      database,
      {
        provider: 'github',
        externalId: 'example-org/service#42',
        taskId: 'task-1',
        lifecycleState: 'awaiting_review',
        metadata: { headSha: 'abc123', author: 'ana' },
      },
      CHAT_NOW,
    )
    return database
  }

  /**
   * The same effect as the UI action, which spec 07 asks for by name: Waiting for, named on the
   * author, and attributed to sync because it is the connector's own move (spec 02).
   */
  it('moves the task to waiting on the author, as the UI action does', async () => {
    const database = reviewDatabase()

    const answer = await run(database, 'mark_reviewed', { id: 'task-1' })

    expect(getTask(database, 'task-1')).toMatchObject({
      status: 'waiting',
      waitingOn: 'ana',
      statusSetBy: 'sync',
    })
    expect(answer.mutations?.[0]?.summary).toBe('Marked “Review the helper” reviewed')
  })

  it('carries both halves of the move in its inverse', async () => {
    const database = reviewDatabase()

    const answer = await run(database, 'mark_reviewed', { id: 'task-1' })

    expect(answer.mutations?.[0]?.inverse?.map((operation) => operation.kind)).toEqual([
      'restore-task',
      'restore-source-lifecycle',
    ])
  })

  it('refuses a task that is not an open review', async () => {
    const database = migratedDatabase()
    createTask(database, { id: 'task-1', title: 'Book the venue' }, CHAT_NOW)

    const outcome = await refuse(database, 'mark_reviewed', { id: 'task-1' })

    expect(outcome.message).toContain('not an open pull request')
  })

  it('says nothing changed when the review was already discharged', async () => {
    const database = reviewDatabase()
    await run(database, 'mark_reviewed', { id: 'task-1' })

    const answer = await run(database, 'mark_reviewed', { id: 'task-1' })

    expect(answer.data).toMatchObject({ note: expect.stringContaining('already discharged') })
    expect(answer.mutations ?? []).toEqual([])
  })
})

describe('delete_task', () => {
  it('describes what it would delete before anything is done', () => {
    const database = migratedDatabase()
    createTask(database, { id: 'task-1', title: 'Book the venue' }, CHAT_NOW)

    expect(tool('delete_task').describe?.(context(database), { id: 'task-1' })).toBe(
      'Delete “Book the venue”',
    )
  })

  it('deletes the task and keeps its tags and source links in the inverse', async () => {
    const database = migratedDatabase()
    createTask(database, { id: 'task-1', title: 'Book the venue' }, CHAT_NOW)
    setTaskTags(database, 'task-1', ['errand'])
    upsertSource(
      database,
      { provider: 'gmail', externalId: 'thread-1', taskId: 'task-1' },
      CHAT_NOW,
    )

    const answer = await run(database, 'delete_task', { id: 'task-1' })

    expect(getTask(database, 'task-1')).toBeNull()
    expect(answer.mutations?.[0]?.inverse?.[0]).toMatchObject({
      kind: 'restore-task',
      tags: ['errand'],
      sourceIds: [expect.any(String)],
    })
  })
})

describe('create_project and update_project', () => {
  it('creates a project and records the change against it', async () => {
    const database = migratedDatabase()

    const answer = await run(database, 'create_project', { title: 'Ship Caroline' })

    const id = (answer.data as { id: string }).id
    expect(getProject(database, id)).toMatchObject({ title: 'Ship Caroline', state: 'active' })
    expect(answer.mutations?.[0]).toMatchObject({ entity: 'project', entityId: id })
  })

  it('completing a project does not complete its tasks', async () => {
    const database = migratedDatabase()
    createProject(database, { id: 'project-1', title: 'Ship Caroline' }, CHAT_NOW)
    createTask(
      database,
      { id: 'task-1', title: 'Book the venue', projectId: 'project-1', status: 'next_action' },
      CHAT_NOW,
    )

    await run(database, 'update_project', { id: 'project-1', state: 'done' })

    expect(getProject(database, 'project-1')).toMatchObject({ state: 'done' })
    expect(getTask(database, 'task-1')).toMatchObject({ status: 'next_action' })
  })

  it('refuses a project that does not exist', async () => {
    const outcome = await refuse(migratedDatabase(), 'update_project', {
      id: 'nope',
      state: 'done',
    })

    expect(outcome.message).toContain('no project with the id nope')
  })
})

describe('regenerate_daily_plan', () => {
  it('redraws today and records a change with nothing to undo', async () => {
    const answer = await run(migratedDatabase(), 'regenerate_daily_plan', {})

    expect(answer.mutations?.[0]).toMatchObject({ entity: 'plan', inverse: null })
  })

  /** Spec 05: an earlier day's plan is a record of what was proposed on it. */
  it('refuses a day that is not today', async () => {
    const outcome = await refuse(migratedDatabase(), 'regenerate_daily_plan', {
      date: '2026-05-30',
    })

    expect(outcome.message).toContain('Only today')
  })

  it('reports a planner that is already running rather than pretending it drew one', async () => {
    const outcome = await refuse(
      migratedDatabase(),
      'regenerate_daily_plan',
      {},
      { regeneratePlan: () => Promise.resolve({ status: 'already-running' }) },
    )

    expect(outcome.message).toContain('already running')
  })

  it('passes the planner’s own refusal through', async () => {
    const outcome = await refuse(
      migratedDatabase(),
      'regenerate_daily_plan',
      {},
      {
        regeneratePlan: () =>
          Promise.resolve({ status: 'refused', detail: 'No LLM provider is configured.' }),
      },
    )

    expect(outcome.message).toBe('No LLM provider is configured.')
  })
})

/**
 * Criterion 1, as a property of the write tools rather than of one of them: every task a write tool
 * touches ends up attributed to the user. `mark_reviewed` is the stated exception, for the reason
 * the UI action has it, and is asserted above on its own terms.
 */
describe('every write tool', () => {
  it('leaves the tasks it changes attributed to the user', async () => {
    const cases: ReadonlyArray<{ tool: string; args: unknown }> = [
      { tool: 'create_task', args: { title: 'A new thing' } },
      { tool: 'update_task', args: { id: 'task-1', status: 'someday' } },
      { tool: 'complete_task', args: { id: 'task-1' } },
    ]

    for (const scenario of cases) {
      const database = migratedDatabase()
      createTask(database, { id: 'task-1', title: 'Book the venue', statusSetBy: 'llm' }, CHAT_NOW)

      const answer = await run(database, scenario.tool, scenario.args)
      const changed = (answer.data as { id: string }).id

      expect(getTask(database, changed)?.statusSetBy, scenario.tool).toBe('user')
    }
  })

  it('keeps a task’s tags when it edits one', async () => {
    const database = migratedDatabase()
    createTask(database, { id: 'task-1', title: 'Book the venue' }, CHAT_NOW)
    setTaskTags(database, 'task-1', ['errand'])

    await run(database, 'update_task', { id: 'task-1', status: 'next_action' })

    expect(getTaskTags(database, 'task-1')).toEqual(['errand'])
  })
})
