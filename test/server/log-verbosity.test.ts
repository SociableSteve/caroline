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
import { describe, expect, it } from 'vitest'
import { loadConfig } from '../../src/config/load.js'
import type { Config } from '../../src/config/schema.js'
import type { Database } from '../../src/db/connection.js'
import { upsertSource } from '../../src/db/repositories/sources.js'
import { createTask } from '../../src/db/repositories/tasks.js'
import { runSync } from '../../src/connectors/engine.js'
import type { Connector, SourceItem } from '../../src/connectors/types.js'
import { runClassification } from '../../src/jobs/classify.js'
import { runPlanning } from '../../src/jobs/plan.js'
import { createFakeProvider, type FakeAnswer } from '../../src/llm/fake.js'
import type { LlmProvider, LlmRuntime } from '../../src/llm/index.js'
import { withSchemaValidation } from '../../src/llm/structured.js'
import { callMcpTool, UNKNOWN_TOOL } from '../../src/mcp/call.js'
import { buildServer } from '../../src/server/app.js'
import type { OperationalLog } from '../../src/server/log.js'
import { migratedDatabase } from '../helpers/temp-database.js'
import { captureLog } from '../helpers/log-capture.js'

const NOW = Date.UTC(2026, 7, 10, 9, 0, 0)

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
