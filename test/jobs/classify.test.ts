/**
 * The classifier, against a real database and a fake provider. Spec 04's acceptance criteria are
 * the shape of this file; no test here calls a real model.
 */
import { describe, expect, it } from 'vitest'
import { loadConfig } from '../../src/config/load.js'
import type { Config } from '../../src/config/schema.js'
import type { Database } from '../../src/db/connection.js'
import { listClassifications, pendingProposal } from '../../src/db/repositories/classifications.js'
import { upsertSource } from '../../src/db/repositories/sources.js'
import {
  changeTaskStatus,
  createTask,
  getTask,
  listClassificationCandidates,
} from '../../src/db/repositories/tasks.js'
import { runClassification } from '../../src/jobs/classify.js'
import { createFakeProvider, type FakeAnswer } from '../../src/llm/fake.js'
import type { LlmProvider, LlmRuntime } from '../../src/llm/index.js'
import { withSchemaValidation } from '../../src/llm/structured.js'
import { migratedDatabase } from '../helpers/temp-database.js'

const NOW = Date.UTC(2026, 7, 10, 9, 0, 0)
const DAY = 24 * 60 * 60_000

/** The configuration under test, with the classification settings the case needs. */
function config(
  overrides: Partial<{ threshold: number; batchSize: number; llmContent: string }> = {},
): Config {
  return loadConfig({
    file: {
      classification: {
        ...(overrides.threshold === undefined ? {} : { confidenceThreshold: overrides.threshold }),
        ...(overrides.batchSize === undefined ? {} : { batchSize: overrides.batchSize }),
      },
      ...(overrides.llmContent === undefined
        ? {}
        : { privacy: { llmContent: overrides.llmContent } }),
    },
    env: {} as NodeJS.ProcessEnv,
  })
}

/**
 * A runtime over the fake provider, wrapped in the same validate-and-retry rule the real one uses,
 * so that a schema violation behaves here exactly as it would in production. Spec 03.
 */
function runtime(
  answers: readonly FakeAnswer[],
  configured = true,
  /** The spending ceiling's answer for this run. Spec 03, criterion 13. */
  overBudget: string | null = null,
) {
  const fake = createFakeProvider({ answers, model: 'fake-classifier' })
  const validating = withSchemaValidation(fake, { now: () => NOW })

  const llm: LlmRuntime = {
    isConfigured: () => configured,
    budgetRefusal: () => overBudget,
    for: (): LlmProvider => validating,
  }

  return { llm, fake }
}

/** An answer the schema will accept. */
function answer(structured: Record<string, unknown>): FakeAnswer {
  return { structured, text: JSON.stringify(structured) }
}

/** A Gmail thread already ingested: a source row and the inbox task it created. */
function anIngestedThread(
  database: Database,
  options: { title?: string; content?: string | null; createdAt?: number } = {},
): string {
  const title = options.title ?? 'Hub numbers for Thursday'
  const task = createTask(
    database,
    { title, status: 'inbox', statusSetBy: 'sync' },
    options.createdAt ?? NOW - 2 * DAY,
  )

  upsertSource(
    database,
    {
      provider: 'gmail',
      externalId: `thread-${task.id}`,
      title,
      url: 'https://mail.google.com/mail/u/0/#all/thread-1',
      metadata: { from: 'sam@example.com', participants: ['sam@example.com'], messageCount: 2 },
      content: options.content ?? null,
      contentLevel: options.content === undefined || options.content === null ? 'metadata' : 'full',
      taskId: task.id,
    },
    options.createdAt ?? NOW - 2 * DAY,
  )

  return task.id
}

function run(database: Database, llm: LlmRuntime, settings = config()) {
  return runClassification({ database, config: settings, llm, now: () => NOW })
}

describe('choosing what to classify', () => {
  /** Spec 04, criterion 1. */
  it('never selects a task whose status the user set, even in the inbox', () => {
    const database = migratedDatabase()
    const mine = createTask(database, { title: 'Left here on purpose' }, NOW)
    const theirs = anIngestedThread(database)

    const candidates = listClassificationCandidates(database, 50).map((task) => task.id)

    expect(candidates).toEqual([theirs])
    expect(candidates).not.toContain(mine.id)
  })

  it('takes the oldest first, up to the batch size', () => {
    const database = migratedDatabase()
    const oldest = anIngestedThread(database, { title: 'Oldest', createdAt: NOW - 5 * DAY })
    anIngestedThread(database, { title: 'Newer', createdAt: NOW - DAY })

    expect(listClassificationCandidates(database, 1).map((task) => task.id)).toEqual([oldest])
  })

  it('leaves out a task the classifier has already answered about', async () => {
    const database = migratedDatabase()
    anIngestedThread(database)
    const { llm } = runtime([
      answer({ status: 'inbox', confidence: 0.9, reasoning: 'Cannot tell from this.' }),
    ])

    await run(database, llm)

    expect(listClassificationCandidates(database, 50)).toEqual([])
  })

  /** Spec 04, criterion 8. */
  it('produces no further changes on a second run with no new input', async () => {
    const database = migratedDatabase()
    const taskId = anIngestedThread(database)
    const { llm, fake } = runtime([
      answer({ status: 'next_action', confidence: 0.9, reasoning: 'One action.' }),
    ])

    await run(database, llm)
    const afterFirst = getTask(database, taskId)

    const second = await run(database, llm)

    expect(second.counts.classified).toBe(0)
    expect(fake.requests).toHaveLength(1)
    expect(getTask(database, taskId)).toEqual(afterFirst)
  })

  it('asks again once the item has changed upstream', async () => {
    const database = migratedDatabase()
    const taskId = anIngestedThread(database)
    const { llm } = runtime([
      answer({ status: 'inbox', confidence: 0.9, reasoning: 'Cannot tell.' }),
    ])

    await run(database, llm)
    const source = upsertSource(
      database,
      { provider: 'gmail', externalId: `thread-${taskId}` },
      NOW,
    )
    database.prepare('update sources set requeued_at = ? where id = ?').run(NOW + 1000, source.id)

    expect(listClassificationCandidates(database, 50).map((task) => task.id)).toEqual([taskId])
  })
})

describe('applying an answer', () => {
  /** Spec 04, criterion 2. */
  it('sets the status and attributes it to the model when confident', async () => {
    const database = migratedDatabase()
    const taskId = anIngestedThread(database)
    const { llm } = runtime([
      answer({ status: 'next_action', confidence: 0.9, reasoning: 'One action, yours.' }),
    ])

    const result = await run(database, llm)

    expect(getTask(database, taskId)).toMatchObject({ status: 'next_action', statusSetBy: 'llm' })
    expect(result.counts).toMatchObject({ classified: 1, tasksUpdated: 1, proposals: 0 })
  })

  /** Spec 04, criterion 3. */
  it('leaves the status alone below the threshold and records the proposal', async () => {
    const database = migratedDatabase()
    const taskId = anIngestedThread(database)
    const { llm } = runtime([
      answer({
        status: 'waiting',
        confidence: 0.4,
        reasoning: 'Might be Sam’s move.',
        waitingOn: 'Sam',
      }),
    ])

    const result = await run(database, llm)

    expect(getTask(database, taskId)).toMatchObject({ status: 'inbox', statusSetBy: 'sync' })
    expect(result.counts).toMatchObject({ classified: 1, proposals: 1, tasksUpdated: 0 })
    expect(pendingProposal(database, taskId)).toMatchObject({
      proposedStatus: 'waiting',
      confidence: 0.4,
      applied: false,
      waitingOn: 'Sam',
    })
  })

  it('applies an answer exactly at the threshold', async () => {
    const database = migratedDatabase()
    const taskId = anIngestedThread(database)
    const { llm } = runtime([
      answer({ status: 'reference', confidence: 0.75, reasoning: 'Nothing to do.' }),
    ])

    await run(database, llm, config({ threshold: 0.75 }))

    expect(getTask(database, taskId)).toMatchObject({ status: 'reference', statusSetBy: 'llm' })
  })

  it('names who a waiting task is waiting on', async () => {
    const database = migratedDatabase()
    const taskId = anIngestedThread(database)
    const { llm } = runtime([
      answer({ status: 'waiting', confidence: 0.9, reasoning: 'Sam’s move.', waitingOn: 'Sam' }),
    ])

    await run(database, llm)

    expect(getTask(database, taskId)).toMatchObject({ status: 'waiting', waitingOn: 'Sam' })
  })

  it('applies the suggested title and keeps the original in the notes', async () => {
    const database = migratedDatabase()
    const taskId = anIngestedThread(database, { title: 'Hub numbers for Thursday' })
    const { llm } = runtime([
      answer({
        status: 'next_action',
        confidence: 0.9,
        reasoning: 'One action.',
        suggestedTitle: 'Send Sam the hub numbers',
      }),
    ])

    await run(database, llm)

    expect(getTask(database, taskId)).toMatchObject({
      title: 'Send Sam the hub numbers',
      notes: 'Original title: Hub numbers for Thursday',
    })
  })

  it('leaves a title the user has rewritten alone', async () => {
    const database = migratedDatabase()
    const taskId = anIngestedThread(database, { title: 'Hub numbers for Thursday' })
    database.prepare('update tasks set title = ? where id = ?').run('My own words', taskId)

    const { llm } = runtime([
      answer({
        status: 'next_action',
        confidence: 0.9,
        reasoning: 'One action.',
        suggestedTitle: 'Send Sam the hub numbers',
      }),
    ])

    await run(database, llm)

    expect(getTask(database, taskId)).toMatchObject({ title: 'My own words', notes: null })
  })

  it('seeds an estimate but never overwrites one', async () => {
    const database = migratedDatabase()
    const seeded = anIngestedThread(database, { title: 'Seeded' })
    database.prepare('update tasks set estimate_minutes = 30 where id = ?').run(seeded)
    const fresh = anIngestedThread(database, { title: 'Fresh' })

    const { llm } = runtime([
      answer({
        status: 'next_action',
        confidence: 0.9,
        reasoning: 'One action.',
        estimateMinutes: 15,
      }),
    ])

    await run(database, llm)

    expect(getTask(database, seeded)?.estimateMinutes).toBe(30)
    expect(getTask(database, fresh)?.estimateMinutes).toBe(15)
  })

  /**
   * Spec 04: a project suggestion is never applied automatically, because creating a project is a
   * commitment. It is recorded so the UI can offer it.
   */
  it('records a project suggestion without creating a project', async () => {
    const database = migratedDatabase()
    const taskId = anIngestedThread(database)
    const { llm } = runtime([
      answer({
        status: 'next_action',
        confidence: 0.4,
        reasoning: 'Several steps.',
        projectSuggestion: { existingProjectId: null, newProjectTitle: 'Q3 hub reporting' },
      }),
    ])

    await run(database, llm)

    expect(pendingProposal(database, taskId)?.projectSuggestion).toEqual({
      existingProjectId: null,
      newProjectTitle: 'Q3 hub reporting',
    })
    expect(database.prepare('select count(*) as count from projects').get()).toMatchObject({
      count: 0,
    })
  })

  /**
   * Spec 01, criterion 2, whose recording half lives here. The selection already excludes a
   * user-set task, so the case this covers is the user deciding while the call is in flight: the
   * domain rule refuses the change and the proposal is recorded rather than lost.
   */
  it('records a proposal against a user-set task rather than applying it', async () => {
    const database = migratedDatabase()
    const taskId = anIngestedThread(database)

    const decidedMidCall: LlmProvider = {
      name: 'ollama',
      isLocal: true,
      model: 'fake-classifier',
      supportsTools: false,
      complete: () => {
        changeTaskStatus(database, taskId, { status: 'inbox', by: 'user', at: NOW })
        return Promise.resolve({
          text: '',
          structured: { status: 'next_action', confidence: 0.99, reasoning: 'One action.' },
          toolCalls: [],
          usage: { inputTokens: 0, outputTokens: 0 },
          stopReason: 'end_turn',
        })
      },
      // eslint-disable-next-line require-yield -- the classifier never streams.
      async *stream() {
        throw new Error('not used')
      },
    }

    await run(database, {
      isConfigured: () => true,
      budgetRefusal: () => null,
      for: () => decidedMidCall,
    })

    expect(getTask(database, taskId)).toMatchObject({ status: 'inbox', statusSetBy: 'user' })
    expect(listClassifications(database, { taskId })[0]).toMatchObject({
      proposedStatus: 'next_action',
      applied: false,
    })
  })
})

describe('the audit trail', () => {
  /** Spec 04, criterion 6. */
  it('writes one row per task processed, with the model and the prompt version', async () => {
    const database = migratedDatabase()
    anIngestedThread(database, { title: 'One' })
    anIngestedThread(database, { title: 'Two' })
    const { llm } = runtime([
      answer({ status: 'next_action', confidence: 0.9, reasoning: 'One action.' }),
    ])

    await run(database, llm)

    const rows = listClassifications(database)
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ model: 'fake-classifier', promptVersion: expect.any(String) })
  })

  it('writes a row for a task whose call failed', async () => {
    const database = migratedDatabase()
    const taskId = anIngestedThread(database)
    const { llm } = runtime([{ throws: new Error('the provider is down') }])

    await run(database, llm)

    expect(listClassifications(database, { taskId })[0]).toMatchObject({
      error: 'the provider is down',
      proposedStatus: null,
      applied: false,
    })
  })
})

describe('one write per task', () => {
  /**
   * The status change and the row that records it are one transaction. Apart, a failure between them
   * would leave a task the classifier had moved with an audit trail saying the call failed, and
   * nothing to say which of the two to believe.
   */
  it('rolls the status change back when the audit row cannot be written', async () => {
    const database = migratedDatabase()
    const taskId = anIngestedThread(database)
    const { llm } = runtime([
      answer({ status: 'next_action', confidence: 0.99, reasoning: 'One action.' }),
    ])

    // The one failure that lands between the two writes and nothing else.
    database.exec('drop table classifications')

    await run(database, llm).catch(() => undefined)

    expect(getTask(database, taskId)).toMatchObject({ status: 'inbox', statusSetBy: 'sync' })
  })
})

describe('answers the schema refuses', () => {
  /** Spec 04, criterion 4. */
  it('treats a proposed done as a validation failure and does not complete anything', async () => {
    const database = migratedDatabase()
    const taskId = anIngestedThread(database)
    const { llm, fake } = runtime([
      answer({ status: 'done', confidence: 0.99, reasoning: 'Looks finished.' }),
    ])

    const result = await run(database, llm)

    expect(getTask(database, taskId)).toMatchObject({ status: 'inbox' })
    // Sent back once with the validation error, then given up on. Spec 03.
    expect(fake.requests).toHaveLength(2)
    expect(result.counts.failed).toBe(1)
    expect(listClassifications(database, { taskId })[0]?.error).toMatch(/status/)
  })

  /**
   * Spec 04, criterion 4, extended: `blocked` is refused the same way `done` is. A blocker is the
   * user naming one task of theirs in front of another, and the classifier is never shown the
   * other tasks it would have to pick from. Spec 01.
   */
  it('treats a proposed blocked as a validation failure and blocks nothing', async () => {
    const database = migratedDatabase()
    const taskId = anIngestedThread(database)
    const { llm } = runtime([
      answer({ status: 'blocked', confidence: 0.99, reasoning: 'Something else first.' }),
    ])

    const result = await run(database, llm)

    expect(getTask(database, taskId)).toMatchObject({ status: 'inbox', blockedBy: null })
    expect(result.counts.failed).toBe(1)
    expect(listClassifications(database, { taskId })[0]?.error).toMatch(/status/)
  })

  /** Spec 04, criterion 5. */
  it('retries once when waiting arrives without a waitingOn, and accepts the second answer', async () => {
    const database = migratedDatabase()
    const taskId = anIngestedThread(database)
    const { llm, fake } = runtime([
      answer({ status: 'waiting', confidence: 0.9, reasoning: 'Somebody else.' }),
      answer({ status: 'waiting', confidence: 0.9, reasoning: 'Somebody else.', waitingOn: 'Sam' }),
    ])

    await run(database, llm)

    expect(fake.requests).toHaveLength(2)
    expect(getTask(database, taskId)).toMatchObject({ status: 'waiting', waitingOn: 'Sam' })
  })
})

describe('the run as a whole', () => {
  /** Spec 04, criterion 7. */
  it('leaves every task in the inbox and fails the run when the provider is down', async () => {
    const database = migratedDatabase()
    const first = anIngestedThread(database, { title: 'One' })
    const second = anIngestedThread(database, { title: 'Two' })
    const { llm } = runtime([{ throws: new Error('connect ECONNREFUSED') }])

    const result = await run(database, llm)

    expect(result.status).toBe('failure')
    expect(result.error).toMatch(/Every classification failed/)
    expect(getTask(database, first)).toMatchObject({ status: 'inbox', statusSetBy: 'sync' })
    expect(getTask(database, second)).toMatchObject({ status: 'inbox', statusSetBy: 'sync' })
  })

  it('is a success that says so when one task of several failed', async () => {
    const database = migratedDatabase()
    anIngestedThread(database, { title: 'One' })
    anIngestedThread(database, { title: 'Two' })
    const { llm } = runtime([
      { throws: new Error('rate limited') },
      answer({ status: 'next_action', confidence: 0.9, reasoning: 'One action.' }),
    ])

    const result = await run(
      database,
      llm,
      // One at a time, so the scripted answers line up with the tasks in order.
      loadConfig({ file: { classification: { concurrency: 1 } }, env: {} as NodeJS.ProcessEnv }),
    )

    expect(result.status).toBe('success')
    expect(result.error).toMatch(/1 of 2 classifications failed/)
    expect(result.counts).toMatchObject({ failed: 1, classified: 1 })
  })

  it('is skipped with an explanation when no provider is configured', async () => {
    const database = migratedDatabase()
    anIngestedThread(database)
    const { llm, fake } = runtime([], false)

    const result = await run(database, llm)

    expect(result.status).toBe('skipped')
    expect(result.error).toMatch(/No LLM provider/)
    expect(fake.requests).toHaveLength(0)
  })

  /**
   * Spec 04, criterion 10: reaching the spending ceiling is an outage Caroline imposes on itself,
   * and criterion 7's rule applies to it. Skipped rather than failed, because nothing went wrong.
   */
  it('is skipped, leaving every candidate in the inbox, when the spending ceiling is reached', async () => {
    const database = migratedDatabase()
    const taskId = anIngestedThread(database)
    const reason =
      'The spending ceiling for "anthropic" has been reached: llm.budget sets it to 20 GBP per month.'
    const { llm, fake } = runtime([], true, reason)

    const result = await run(database, llm)

    expect(result.status).toBe('skipped')
    expect(result.error).toBe(reason)
    expect(fake.requests).toHaveLength(0)
    expect(getTask(database, taskId)?.status).toBe('inbox')
    expect(listClassifications(database, { taskId })).toEqual([])
  })

  /** Spec 09: at `none` there is nothing to classify with, so it is not attempted. */
  it('is skipped when the content policy sends nothing', async () => {
    const database = migratedDatabase()
    anIngestedThread(database)
    const { llm, fake } = runtime([
      answer({ status: 'next_action', confidence: 0.9, reasoning: 'One action.' }),
    ])

    const result = await run(database, llm, config({ llmContent: 'none' }))

    expect(result.status).toBe('skipped')
    expect(fake.requests).toHaveLength(0)
  })

  it('succeeds with nothing to do when the inbox is empty', async () => {
    const database = migratedDatabase()
    const { llm } = runtime([])

    const result = await run(database, llm)

    expect(result).toMatchObject({ status: 'success', error: null })
    expect(result.counts.classified).toBe(0)
  })

  it('counts one call per task attempted', async () => {
    const database = migratedDatabase()
    anIngestedThread(database, { title: 'One' })
    anIngestedThread(database, { title: 'Two' })
    const { llm } = runtime([
      answer({ status: 'next_action', confidence: 0.9, reasoning: 'One action.' }),
    ])

    expect((await run(database, llm)).counts.llmCalls).toBe(2)
  })
})
