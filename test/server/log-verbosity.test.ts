/**
 * What the verbose levels say, and what they must never say. Spec 14, criteria 10, 11 and 12.
 *
 * The sibling of `logging.test.ts`, which owns the destination and the redaction of secrets. This
 * file owns the other half of the same contract: an item's own text is not in a log line at any
 * level, and turning the level down says materially more about the paths a fault is likely to be in.
 *
 * Every case drives the real logger at `trace` through the real scrubbing stream, rather than a
 * collecting double, so what is asserted is the bytes that would have reached the file.
 */
import { describe, expect, it, vi } from 'vitest'
import { loadConfig } from '../../src/config/load.js'
import type { Config } from '../../src/config/schema.js'
import type { Database } from '../../src/db/connection.js'
import { recordJobRun } from '../../src/db/repositories/job-runs.js'
import { recordLlmCall } from '../../src/db/repositories/llm-calls.js'
import { upsertSource } from '../../src/db/repositories/sources.js'
import { createTask } from '../../src/db/repositories/tasks.js'
import { runSync } from '../../src/connectors/engine.js'
import type { Connector, SourceItem } from '../../src/connectors/types.js'
import { runClassification } from '../../src/jobs/classify.js'
import { buildJobs } from '../../src/jobs/registry.js'
import { PURGE_JOB } from '../../src/jobs/purge.js'
import { createScheduler } from '../../src/jobs/scheduler.js'
import { runPlanning } from '../../src/jobs/plan.js'
import { createFakeProvider, type FakeAnswer } from '../../src/llm/fake.js'
import { createLlmRuntime, type LlmProvider, type LlmRuntime } from '../../src/llm/index.js'
import { withSchemaValidation } from '../../src/llm/structured.js'
import { callMcpTool, UNKNOWN_TOOL } from '../../src/mcp/call.js'
import { buildServer } from '../../src/server/app.js'
import type { OperationalLog } from '../../src/server/log.js'
import { migratedDatabase } from '../helpers/temp-database.js'
import { captureLog } from '../helpers/log-capture.js'
import { classificationSchema, recordedPayload, stubFetch } from '../helpers/llm.js'

const NOW = Date.UTC(2026, 7, 10, 9, 0, 0)

/** Anything that would have reached the network fails loudly instead. */
const refuseNetwork: typeof globalThis.fetch = (input) => {
  throw new Error(`A test tried to reach ${String(input)}`)
}

/**
 * The strings that must not appear anywhere: a title, a note and a body, each distinctive enough
 * that a substring match cannot be a coincidence.
 */
const ITEM_TEXT = {
  title: 'Quarterly numbers for Wilbraham Holdings',
  notes: 'Ring Priya about the Zanzibar invoice',
  body: 'The revised figures are attached, including the Kirkwall write-down.',
} as const

/**
 * A logger at `trace` through the real pipeline. Returns the lines as they would have been written to
 * the log file, and the logger the subsystem under test is handed.
 */
async function tracingLog(config: Config): Promise<{
  log: OperationalLog
  lines: () => string
  close: () => Promise<void>
}> {
  const { lines, stream } = captureLog()
  const app = await buildServer({
    config,
    database: migratedDatabase(),
    logger: { level: 'trace', stream },
  })

  return {
    log: app.log,
    lines: () => lines.join(''),
    close: () => app.close(),
  }
}

function configuration(file: Record<string, unknown> = {}): Config {
  return loadConfig({ file, env: {} as NodeJS.ProcessEnv })
}

/** A runtime over the fake provider, wrapped in the rule the real one uses. Spec 03. */
function runtime(answers: readonly FakeAnswer[]): LlmRuntime {
  const validating = withSchemaValidation(createFakeProvider({ answers, model: 'fake-model' }), {
    now: () => NOW,
  })

  return {
    isConfigured: () => true,
    budgetRefusal: () => null,
    for: (): LlmProvider => validating,
  }
}

function answer(structured: Record<string, unknown>): FakeAnswer {
  return { structured, text: JSON.stringify(structured) }
}

/** A Gmail thread already ingested, with all three pieces of text on it. */
function anIngestedThread(database: Database): string {
  const task = createTask(
    database,
    { title: ITEM_TEXT.title, notes: ITEM_TEXT.notes, status: 'inbox', statusSetBy: 'sync' },
    NOW - 86_400_000,
  )

  upsertSource(
    database,
    {
      provider: 'gmail',
      externalId: 'thread-1',
      url: 'https://mail.google.com/mail/u/0/#inbox/thread-1',
      title: ITEM_TEXT.title,
      taskId: task.id,
      metadata: { from: 'someone@example.com' },
      content: ITEM_TEXT.body,
      contentLevel: 'full',
    },
    NOW - 86_400_000,
  )

  return task.id
}

/** A connector with one item on it, so a sync pass has something to log. */
function oneItemConnector(): Connector {
  const item: SourceItem = {
    externalId: 'pr-77',
    url: 'https://github.example/org/repo/pull/77',
    title: ITEM_TEXT.title,
    metadata: { repository: 'org/repo' },
    content: ITEM_TEXT.body,
    occurredAt: NOW - 3600_000,
    task: { status: 'review' },
  }

  return {
    provider: 'github',
    isConfigured: () => true,
    async *fetch() {
      yield item
    },
  }
}

describe('no item text reaches a log line (spec 14 criterion 10, spec 09 criterion 28)', () => {
  it('logs the classifier decision by id, status and confidence, and not the subject', async () => {
    const config = configuration({ privacy: { storeContent: 'full' } })
    const { log, lines, close } = await tracingLog(config)
    const database = migratedDatabase()
    const taskId = anIngestedThread(database)

    const result = await runClassification({
      database,
      config,
      llm: runtime([
        answer({
          status: 'next_action',
          confidence: 0.95,
          reasoning: `The ${ITEM_TEXT.title} thread needs a reply`,
          suggestedTitle: ITEM_TEXT.title,
          estimateMinutes: 20,
        }),
      ]),
      now: () => NOW,
      log,
    })
    await close()

    const logged = lines()
    expect(result.status).toBe('success')
    // The decision is there, in the terms it was made in.
    expect(logged).toContain('classification applied')
    expect(logged).toContain(taskId)
    expect(logged).toContain('"proposedStatus":"next_action"')
    expect(logged).toContain('"confidence":0.95')
    // And not one character of what the model read, nor of what it wrote back about it.
    for (const text of Object.values(ITEM_TEXT)) expect(logged).not.toContain(text)
  })

  it('logs the planner arithmetic and neither a title nor the plan prose', async () => {
    const config = configuration()
    const { log, lines, close } = await tracingLog(config)
    const database = migratedDatabase()
    const taskId = createTask(
      database,
      {
        title: ITEM_TEXT.title,
        notes: ITEM_TEXT.notes,
        status: 'next_action',
        statusSetBy: 'user',
      },
      NOW - 86_400_000,
    ).id

    const summary = `Start with ${ITEM_TEXT.title}`
    const result = await runPlanning({
      database,
      config,
      llm: runtime([
        answer({
          summary,
          entries: [{ taskId, rationale: ITEM_TEXT.notes, estimateMinutes: 30 }],
        }),
      ]),
      calendarConnected: () => false,
      now: () => NOW,
      log,
    })
    await close()

    const logged = lines()
    expect(result.status).toBe('success')
    expect(logged).toContain('planning the day')
    expect(logged).toContain('plan drawn')
    expect(logged).toContain('"candidates":1')
    for (const text of Object.values(ITEM_TEXT)) expect(logged).not.toContain(text)
    // The summary is Caroline's prose about somebody's work, which spec 09 counts as content.
    expect(logged).not.toContain(summary)
  })

  it('logs a connector pass by counts and external ids, not by item titles', async () => {
    const config = configuration({ privacy: { storeContent: 'full' } })
    const { log, lines, close } = await tracingLog(config)
    const database = migratedDatabase()

    const summary = await runSync({
      database,
      connectors: [oneItemConnector()],
      trigger: 'manual',
      policy: config.privacy,
      now: () => NOW,
      log,
    })
    await close()

    const logged = lines()
    expect(summary.results[0]?.status).toBe('success')
    expect(logged).toContain('connector pass finished')
    expect(logged).toContain('"externalId":"pr-77"')
    expect(logged).toContain('"tasksCreated":1')
    for (const text of Object.values(ITEM_TEXT)) expect(logged).not.toContain(text)
  })

  it('logs an MCP tool call by tool and item count, while the answer itself carries the title', async () => {
    const config = configuration({ mcp: { enabled: true } })
    const { log, lines, close } = await tracingLog(config)
    const database = migratedDatabase()
    const taskId = anIngestedThread(database)

    const result = await callMcpTool(
      {
        database,
        config,
        now: () => NOW,
        calendarConnected: () => false,
        regeneratePlan: () => Promise.resolve({ status: 'refused', detail: 'not in this test' }),
        log,
      },
      { clientName: 'a client', tool: 'get_task', arguments: { id: taskId } },
    )
    await close()

    const logged = lines()
    // The tool did read the title: that is what makes its absence from the log a fact about the
    // logging rather than about the tool having answered with nothing.
    expect(JSON.stringify(result)).toContain(ITEM_TEXT.title)
    expect(logged).toContain('MCP tool call')
    expect(logged).toContain('"tool":"get_task"')
    expect(logged).toContain('"itemCount":1')
    for (const text of Object.values(ITEM_TEXT)) expect(logged).not.toContain(text)
  })
})

describe('a caller chooses the bytes, so Caroline logs what it recognised (spec 14 criterion 12)', () => {
  it('logs a tool the registry does not have as unknown, not by the name it was sent', async () => {
    const config = configuration({ mcp: { enabled: true } })
    const { log, lines, close } = await tracingLog(config)

    const result = await callMcpTool(
      {
        database: migratedDatabase(),
        config,
        now: () => NOW,
        calendarConnected: () => false,
        regeneratePlan: () => Promise.resolve({ status: 'refused', detail: 'not in this test' }),
        log,
      },
      { clientName: null, tool: 'ghp_smuggled_in_a_tool_name', arguments: {} },
    )
    await close()

    const logged = lines()
    expect(result.outcome).toBe('error')
    expect(logged).toContain(`"tool":"${UNKNOWN_TOOL}"`)
    expect(logged).not.toContain('ghp_smuggled_in_a_tool_name')
  })
})

describe('turning the level down says more (spec 14 criterion 11)', () => {
  it('says nothing at info that it says at debug, for the same run', async () => {
    const config = configuration({ privacy: { storeContent: 'full' } })

    // A database of its own per run: the first run sorts the thread, and a second run against the
    // same database would have no candidate left to say anything about.
    const run = async (level: 'info' | 'debug'): Promise<string> => {
      const database = migratedDatabase()
      anIngestedThread(database)
      const { lines, stream } = captureLog()
      const app = await buildServer({
        config,
        database: migratedDatabase(),
        logger: { level, stream },
      })

      await runClassification({
        database,
        config,
        llm: runtime([
          answer({
            status: 'next_action',
            confidence: 0.9,
            reasoning: 'because',
            suggestedTitle: null,
          }),
        ]),
        now: () => NOW,
        log: app.log,
      })
      await app.close()
      return lines.join('')
    }

    const atInfo = await run('info')
    const atDebug = await run('debug')

    // Every `debug` line of the run, absent at the level above it.
    expect(atInfo).not.toContain('classification run starting')
    expect(atInfo).not.toContain('classification applied')
    expect(atDebug).toContain('classification run starting')
    expect(atDebug).toContain('classification applied')
    expect(atDebug.length).toBeGreaterThan(atInfo.length)
  })
})

/**
 * The other arms of criterion 11. The classifier, the planner, the connectors and the MCP surface
 * are asserted above; the scheduler, the provider and the purge are asserted here, by the message
 * each of them writes rather than by the log being longer.
 */
describe('the scheduler says what it decided (spec 14 criterion 11)', () => {
  it('logs a job run finishing, and the purge counts beside it', async () => {
    const config = configuration()
    const { lines, stream } = captureLog()
    const database = migratedDatabase()
    const app = await buildServer({ config, database, logger: { level: 'debug', stream } })
    const log = app.log
    const jobs = buildJobs({
      database,
      config,
      now: () => NOW,
      fetch: refuseNetwork,
      log,
    })

    await jobs.scheduler.run(PURGE_JOB, 'manual')
    await app.close()

    const logged = lines.join('')
    expect(logged).toContain('purge finished')
    expect(logged).toContain('"retainContentDays"')
    expect(logged).toContain('job run finished')
    expect(logged).toContain('"job":"purge"')
    expect(logged).toContain('"status":"success"')
  })

  it('logs a run skipped for being in flight, and a failed one at warn', async () => {
    const config = configuration()
    const { lines, stream } = captureLog()
    const database = migratedDatabase()
    const app = await buildServer({ config, database, logger: { level: 'debug', stream } })

    let release = (): void => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const scheduler = createScheduler({
      database,
      steps: [
        { name: 'sync', run: async () => (await held, { status: 'success' as const }) },
        {
          name: 'classify',
          run: () => Promise.resolve({ status: 'failure' as const, error: 'the provider is down' }),
        },
      ],
      schedules: [],
      timeZone: 'UTC',
      backoffBaseMs: 60_000,
      backoffCeilingMs: 3_600_000,
      startupStaggerMs: 0,
      now: () => NOW,
      log: app.log,
    })

    const first = scheduler.run('sync', 'manual')
    const skipped = await scheduler.run('sync', 'manual')
    release()
    await first
    await scheduler.run('classify', 'manual')
    await app.close()

    const logged = lines.join('')
    expect(skipped.status).toBe('already-running')
    expect(logged).toContain('job run skipped')
    expect(logged).toContain('"reason":"already in flight"')
    expect(logged).toContain('job run failed')
    expect(logged).toContain('"reason":"the provider is down"')
  })

  it('logs a schedule firing and the rearm that follows it', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    try {
      const config = configuration()
      const { lines, stream } = captureLog()
      const database = migratedDatabase()
      const app = await buildServer({ config, database, logger: { level: 'debug', stream } })

      // A success just now, so the cold-start catch-up does not count the job as overdue and the
      // only thing that fires is the tick this test advances the clock to.
      recordJobRun(database, {
        job: 'sync',
        trigger: 'scheduled',
        startedAt: NOW,
        finishedAt: NOW,
        status: 'success',
      })

      const scheduler = createScheduler({
        database,
        steps: [{ name: 'sync', run: () => Promise.resolve({ status: 'success' as const }) }],
        schedules: [{ job: 'sync', cron: '*/5 * * * *', chain: ['sync'] }],
        timeZone: 'UTC',
        backoffBaseMs: 60_000,
        backoffCeilingMs: 3_600_000,
        startupStaggerMs: 0,
        log: app.log,
      })

      scheduler.start()
      await vi.advanceTimersByTimeAsync(6 * 60_000)
      scheduler.stop()
      await scheduler.drain(0)
      await app.close()

      const logged = lines.join('')
      expect(logged).toContain('schedule firing')
      expect(logged).toContain('"chain":["sync"]')
      expect(logged).toContain('schedule rearmed')
      expect(logged).toContain('"nextRunAt"')
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('each provider attempt says what it cost (spec 14 criterion 11)', () => {
  /** $10 of Anthropic a month, which is the ceiling the refusal below is measured against. */
  function capped(): Config {
    return loadConfig({
      file: {
        jobs: { timezone: 'UTC' },
        llm: {
          provider: 'anthropic',
          model: 'claude-sonnet-5',
          budget: { currency: 'USD', period: 'month', anthropic: 10 },
        },
      },
      env: { ANTHROPIC_API_KEY: 'sk-ant' } as NodeJS.ProcessEnv,
    })
  }

  const request = {
    system: 'Sort this item.',
    messages: [{ role: 'user' as const, content: 'Can you sign off the venue booking?' }],
    schema: classificationSchema,
    maxTokens: 512,
  }

  it('logs a call that answered, with its model, duration and tokens', async () => {
    const config = capped()
    const { log, lines, close } = await tracingLog(config)
    const stub = stubFetch([{ body: recordedPayload('anthropic-classification') }])

    await createLlmRuntime({
      config,
      database: migratedDatabase(),
      fetch: stub.fetch,
      now: () => NOW,
      log,
    })
      .for('classification')
      .complete(request)
    await close()

    const logged = lines()
    expect(logged).toContain('provider call finished')
    expect(logged).toContain('"provider":"anthropic"')
    expect(logged).toContain('"model":"claude-sonnet-5"')
    expect(logged).toContain('"purpose":"classification"')
    expect(logged).toContain('"inputTokens"')
    expect(logged).toContain('"durationMs"')
  })

  it('logs a call that did not answer usably at warn, with the reason', async () => {
    const config = capped()
    const { log, lines, close } = await tracingLog(config)
    const stub = stubFetch([{ status: 500, body: { error: { message: 'overloaded' } } }])

    await expect(
      createLlmRuntime({
        config,
        database: migratedDatabase(),
        fetch: stub.fetch,
        now: () => NOW,
        log,
      })
        .for('classification')
        .complete(request),
    ).rejects.toThrow()
    await close()

    expect(lines()).toContain('provider call did not answer usably')
  })

  it('logs a refusal by the spending ceiling, with the ceiling as the reason', async () => {
    const config = capped()
    const { log, lines, close } = await tracingLog(config)
    const database = migratedDatabase()
    // Well past $10 at $2 per million input tokens, so the ceiling is reached rather than close.
    recordLlmCall(database, {
      provider: 'anthropic',
      model: 'claude-sonnet-5',
      purpose: 'classification',
      startedAt: NOW,
      durationMs: 10,
      inputTokens: 50_000_000,
      outputTokens: 0,
      status: 'success',
    })

    const refusal = createLlmRuntime({
      config,
      database,
      fetch: refuseNetwork,
      now: () => NOW,
      log,
    }).budgetRefusal('classification')
    await close()

    expect(refusal).not.toBeNull()
    const logged = lines()
    expect(logged).toContain('provider call refused')
    expect(logged).toContain('"purpose":"classification"')
  })
})

/**
 * Nothing constrains a rejection to an `Error`. The warn line that reports a failed pass hands the
 * thrown value to the error serialiser, and a serialiser that assumed an `Error` threw a
 * `TypeError` from inside the log call, out of the `catch` block: the remaining connectors never
 * ran and the failure was reported twice. Spec 09 criterion 6, over the path spec 14 added.
 */
describe('a connector that rejects with something other than an Error', () => {
  it('is logged as a failed pass, and the connectors after it still run', async () => {
    const config = loadConfig({
      file: { privacy: { storeContent: 'full' } },
      env: { GITHUB_TOKEN: 'ghp_supersecret' } as NodeJS.ProcessEnv,
    })
    const { log, lines, close } = await tracingLog(config)

    const rejecting: Connector = {
      provider: 'gmail',
      isConfigured: () => true,
      // eslint-disable-next-line require-yield -- rejecting before the first item is the point
      async *fetch() {
        throw 'Gmail said 401 for ghp_supersecret'
      },
    }

    const summary = await runSync({
      database: migratedDatabase(),
      connectors: [rejecting, oneItemConnector()],
      trigger: 'manual',
      policy: config.privacy,
      now: () => NOW,
      log,
    })
    await close()

    expect(summary.results.map((result) => result.status)).toEqual(['failure', 'success'])
    const logged = lines()
    expect(logged).toContain('connector pass failed')
    expect(logged).toContain('connector pass finished')
    expect(logged).not.toContain('ghp_supersecret')
    expect(logged).toContain('[redacted]')
  })
})
