/**
 * Spec 09, criterion 1, asserted the way the criterion asks: by inspecting the request the
 * classifier actually built, not by reading the prompt template. The request is the thing that
 * leaves the machine, so the request is the thing under test.
 */
import { describe, expect, it } from 'vitest'
import { loadConfig } from '../../src/config/load.js'
import type { Config } from '../../src/config/schema.js'
import type { Database } from '../../src/db/connection.js'
import { upsertSource } from '../../src/db/repositories/sources.js'
import { createTask } from '../../src/db/repositories/tasks.js'
import { runClassification } from '../../src/jobs/classify.js'
import { createFakeProvider } from '../../src/llm/fake.js'
import type { LlmProvider, LlmRuntime } from '../../src/llm/index.js'
import { buildClassificationPayload } from '../../src/llm/prompts/classification.js'
import { migratedDatabase } from '../helpers/temp-database.js'

const NOW = Date.UTC(2026, 7, 10, 9, 0, 0)
const DAY = 24 * 60 * 60_000

const BODY =
  'Could you take a look at the hub numbers before Thursday? The occupancy figure is the one I am unsure about, and Priya wants it for the board pack.'

function config(privacy: Record<string, unknown>): Config {
  return loadConfig({ file: { privacy }, env: {} as NodeJS.ProcessEnv })
}

/** A thread whose body is stored, so that every level has something it could disclose. */
function aStoredThread(database: Database): string {
  const task = createTask(
    database,
    { title: 'Hub numbers before Thursday', status: 'inbox', statusSetBy: 'sync' },
    NOW - 2 * DAY,
  )

  upsertSource(
    database,
    {
      provider: 'gmail',
      externalId: 'thread-hub-numbers',
      title: 'Hub numbers before Thursday',
      metadata: {
        from: 'Sam Reed <sam.reed@example.com>',
        participants: ['Sam Reed <sam.reed@example.com>'],
        labels: ['INBOX'],
        messageCount: 2,
      },
      content: BODY,
      contentLevel: 'full',
      taskId: task.id,
    },
    NOW - 2 * DAY,
  )

  return task.id
}

/** Runs one classification and hands back every request the provider was given. */
async function requestsUnder(privacy: Record<string, unknown>): Promise<readonly string[]> {
  const database = migratedDatabase()
  aStoredThread(database)

  const fake = createFakeProvider({
    answers: [
      {
        structured: { status: 'next_action', confidence: 0.9, reasoning: 'One action.' },
        text: '{}',
      },
    ],
  })

  const llm: LlmRuntime = {
    isConfigured: () => true,
    budgetRefusal: () => null,
    for: (): LlmProvider => fake,
  }

  await runClassification({ database, config: config(privacy), llm, now: () => NOW })

  return fake.requests.flatMap((request) => [
    request.system,
    ...request.messages.map((message) => message.content),
  ])
}

describe('the request built at metadata', () => {
  it('carries no body text at all', async () => {
    const sent = (await requestsUnder({ llmContent: 'metadata', storeContent: 'full' })).join('\n')

    expect(sent).not.toContain('occupancy')
    expect(sent).not.toContain(BODY.slice(0, 30))
  })

  it('still carries the sender, the subject, the labels and the age', async () => {
    const sent = (await requestsUnder({ llmContent: 'metadata', storeContent: 'full' })).join('\n')

    expect(sent).toContain('sam.reed@example.com')
    expect(sent).toContain('Hub numbers before Thursday')
    expect(sent).toContain('INBOX')
    expect(sent).toContain('"ageDays": 2')
  })
})

describe('the request built at snippet', () => {
  it('carries the first snippetChars of the body and no more', async () => {
    const sent = (
      await requestsUnder({ llmContent: 'snippet', storeContent: 'full', snippetChars: 40 })
    ).join('\n')

    expect(sent).toContain(BODY.slice(0, 40))
    expect(sent).not.toContain('occupancy')
  })
})

describe('the request built at full', () => {
  it('carries the whole body, which is what the allow flag is for', async () => {
    const sent = (
      await requestsUnder({
        llmContent: 'full',
        storeContent: 'full',
        // The remote-provider guard is what makes this a decision; the fake provider is local.
        allowFullContentToRemoteProvider: true,
      })
    ).join('\n')

    expect(sent).toContain('occupancy')
  })
})

describe('the payload at none', () => {
  /**
   * Nothing beyond internal ids. The classifier does not call at this level at all, so this is the
   * boundary itself rather than the job: it holds even if something else were to build a payload.
   */
  it('is the id and the source and nothing else', () => {
    expect(
      buildClassificationPayload(
        {
          taskId: 'task-1',
          title: 'Hub numbers before Thursday',
          provider: 'gmail',
          metadata: { from: 'sam.reed@example.com' },
          content: BODY,
          createdAt: NOW - DAY,
        },
        { llmContent: 'none', snippetChars: 300 },
        NOW,
      ),
    ).toEqual({ taskId: 'task-1', source: 'gmail' })
  })
})

describe('what a connector adds later', () => {
  /**
   * The metadata fields are named rather than passed through, so a connector that learns a new fact
   * does not start sending it to a third party by inheritance.
   */
  it('is not sent until it is named', () => {
    const payload = buildClassificationPayload(
      {
        taskId: 'task-1',
        title: 'Hub numbers',
        provider: 'gmail',
        metadata: { from: 'sam@example.com', homeAddress: '1 Somewhere Street' },
        content: null,
        createdAt: NOW,
      },
      { llmContent: 'snippet', snippetChars: 300 },
      NOW,
    )

    expect(JSON.stringify(payload)).not.toContain('Somewhere Street')
  })
})
