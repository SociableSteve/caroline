/**
 * What the chat tests are driven by: a real database, a real turn loop, and a provider that answers
 * from a script. No test in this repository calls a model, and none of them reaches a network.
 */
import { loadConfig } from '../../src/config/load.js'
import type { Config } from '../../src/config/schema.js'
import type { Database } from '../../src/db/connection.js'
import { createFakeProvider, type FakeAnswer } from '../../src/llm/fake.js'
import type { LlmProvider, LlmRuntime } from '../../src/llm/index.js'
import type { CompletionRequest, ToolCall } from '../../src/llm/types.js'
import { createChatService, type ChatEvent, type PlanRegeneration } from '../../src/chat/index.js'
import type { ItemRef } from '../../src/domain/selection.js'
import { createChangeFeed, type ChangeEvent } from '../../src/server/changes.js'
import { upsertCalendarEvent } from '../../src/db/repositories/calendar-events.js'
import { recordDailyPlan } from '../../src/db/repositories/daily-plans.js'
import { createProject } from '../../src/db/repositories/projects.js'
import { upsertSource } from '../../src/db/repositories/sources.js'
import { createTask, setTaskTags } from '../../src/db/repositories/tasks.js'
import { migratedDatabase } from './temp-database.js'

/** The moment every turn in these tests happens at. A Monday morning, inside a working window. */
export const CHAT_NOW = Date.UTC(2026, 5, 1, 9, 0, 0)

/** One scripted answer that calls a tool, in the shape the fake provider serves. */
export function toolAnswer(
  calls: ReadonlyArray<{ name: string; arguments: unknown; id?: string }>,
  text = '',
): FakeAnswer {
  return {
    text,
    toolCalls: calls.map((call, index) => ({
      id: call.id ?? `call_${index}`,
      name: call.name,
      arguments: call.arguments,
    })) as ToolCall[],
    usage: { inputTokens: 10, outputTokens: 5 },
    stopReason: 'tool_use',
  }
}

/** A scripted answer that only talks. */
export function textAnswer(text: string): FakeAnswer {
  return { text, toolCalls: [], usage: { inputTokens: 7, outputTokens: 3 }, stopReason: 'end_turn' }
}

/**
 * Every piece of item text `seedItemText` writes: titles, notes, tags, a person's name, a meeting's
 * summary, a plan's rationale and its summary. At `none` none of it may appear in anything a provider
 * is handed. Spec 09, criterion 13.
 */
export const ITEM_TEXT: readonly string[] = [
  'Northwind',
  'indemnity',
  'Contoso',
  'Book the venue',
  'due today',
  'A quiet day',
  'Standup',
  'Sign-off',
  'Beatrix',
  'legal',
]

/**
 * The items every content-policy sweep runs against. One fixture for two boundaries: the tools called
 * directly, and the same tools called through a turn, whose results are read off the built request.
 * A task in each of the shapes a tool answers about, a project with notes, a diary, and a plan.
 */
export function seedItemText(database: Database = migratedDatabase()): Database {
  createProject(
    database,
    { id: 'project-1', title: 'Northwind renewal', notes: 'Signed off at Contoso last year.' },
    CHAT_NOW,
  )
  createTask(
    database,
    {
      id: 'task-1',
      title: 'Review the Northwind contract',
      notes: 'Ring about the indemnity clause.',
      projectId: 'project-1',
    },
    CHAT_NOW,
  )
  setTaskTags(database, 'task-1', ['legal'])
  createTask(
    database,
    { id: 'task-2', title: 'Sign-off from Beatrix', status: 'waiting', waitingOn: 'Beatrix' },
    CHAT_NOW - 10 * 24 * 60 * 60_000,
  )
  // An open review, so `mark_reviewed` has something to discharge. Its author is the name that tool
  // answers with, which is a person's name reaching a provider by a route of its own.
  createTask(
    database,
    {
      id: 'task-3',
      title: 'Review the Northwind retry helper',
      status: 'review',
      statusSetBy: 'sync',
    },
    CHAT_NOW,
  )
  upsertSource(
    database,
    {
      provider: 'github',
      externalId: 'example-org/service#42',
      taskId: 'task-3',
      lifecycleState: 'awaiting_review',
      metadata: { headSha: 'abc123', author: 'Beatrix' },
    },
    CHAT_NOW,
  )
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
  recordDailyPlan(database, {
    planDate: '2026-06-01',
    generatedAt: CHAT_NOW,
    timeZone: 'Europe/London',
    windowMinutes: 510,
    busyMinutes: 30,
    reserveMinutes: 96,
    capacityMinutes: 384,
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
    nudges: [
      {
        taskId: 'task-2',
        title: 'Sign-off from Beatrix',
        rank: 1,
        waitingOn: 'Beatrix',
        waitingSince: CHAT_NOW - 10 * 24 * 60 * 60_000,
        pushedSinceReview: false,
      },
    ],
  })

  return database
}

export interface ChatHarnessOptions {
  readonly answers: readonly FakeAnswer[]
  readonly database?: Database
  /** Merged into the file config, for a test about a threshold or a limit. */
  readonly file?: Record<string, unknown>
  /** False to stand in for a model that cannot use tools. Spec 07, criterion 7. */
  readonly supportsTools?: boolean
  /** Whether a model is configured at all. */
  readonly configured?: boolean
  /** The spending ceiling's answer for this turn, or null when there is nothing to refuse.
   *  Spec 03, criterion 14. */
  readonly overBudget?: string | null
  readonly regeneratePlan?: () => Promise<PlanRegeneration>
}

export interface ChatHarness {
  readonly database: Database
  /** Moves the harness clock on, for a test where the order of two writes is the point. */
  advance(ms: number): void
  readonly config: Config
  readonly service: ReturnType<typeof createChatService>
  /** Every request the provider was given, so the built payload can be inspected. Spec 09. */
  readonly requests: readonly CompletionRequest[]
  readonly published: readonly ChangeEvent[]
  /**
   * Runs a turn and returns everything it emitted. `selected` is the item the rail had open when the
   * message was sent, which is resolved per message rather than per conversation. Spec 07.
   */
  turn(message: string, conversationId?: string, selected?: ItemRef): Promise<ChatEvent[]>
}

export function chatHarness({
  answers,
  database = migratedDatabase(),
  file = {},
  supportsTools = true,
  configured = true,
  overBudget = null,
  regeneratePlan = () => Promise.resolve<PlanRegeneration>({ status: 'drawn', summary: 'A plan.' }),
}: ChatHarnessOptions): ChatHarness {
  // The zone is pinned as it is everywhere else in the suite, and merged one level down: a test
  // overriding `jobs` with a spread would otherwise drop the timezone and pass or fail by where CI
  // happens to think it is.
  const { jobs, ...rest } = file as { jobs?: Record<string, unknown> }
  const config = loadConfig({
    file: { ...rest, jobs: { timezone: 'Europe/London', ...(jobs ?? {}) } },
    env: {} as NodeJS.ProcessEnv,
  })

  const provider = createFakeProvider({ answers, supportsTools })
  const llm: LlmRuntime = {
    isConfigured: () => configured,
    budgetRefusal: () => overBudget,
    for: (): LlmProvider => provider,
  }

  const changes = createChangeFeed()
  const published: ChangeEvent[] = []
  changes.subscribe((event) => published.push(event))

  let now = CHAT_NOW

  const service = createChatService({
    database,
    config,
    llm,
    now: () => now,
    calendarConnected: () => false,
    regeneratePlan,
    changes,
  })

  return {
    database,
    config,
    service,
    requests: provider.requests,
    published,

    advance(ms) {
      now += ms
    },

    async turn(message, conversationId, selected) {
      const events: ChatEvent[] = []
      await service.turn(
        {
          message,
          ...(conversationId === undefined ? {} : { conversationId }),
          ...(selected === undefined ? {} : { selected }),
        },
        (event) => events.push(event),
      )
      return events
    },
  }
}

/** The text a turn produced, reassembled from its deltas as a browser would. */
export function streamedText(events: readonly ChatEvent[]): string {
  return events
    .filter((event): event is Extract<ChatEvent, { type: 'text' }> => event.type === 'text')
    .map((event) => event.text)
    .join('')
}

export function doneEvent(events: readonly ChatEvent[]): Extract<ChatEvent, { type: 'done' }> {
  const done = events.find(
    (event): event is Extract<ChatEvent, { type: 'done' }> => event.type === 'done',
  )
  if (done === undefined) throw new Error('the turn never finished')
  return done
}

export function eventsOfType<Type extends ChatEvent['type']>(
  events: readonly ChatEvent[],
  type: Type,
): Array<Extract<ChatEvent, { type: Type }>> {
  return events.filter((event): event is Extract<ChatEvent, { type: Type }> => event.type === type)
}
