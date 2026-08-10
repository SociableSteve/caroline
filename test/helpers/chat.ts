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
import { createChangeFeed, type ChangeEvent } from '../../src/server/changes.js'
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

export interface ChatHarnessOptions {
  readonly answers: readonly FakeAnswer[]
  readonly database?: Database
  /** Merged into the file config, for a test about a threshold or a limit. */
  readonly file?: Record<string, unknown>
  /** False to stand in for a model that cannot use tools. Spec 07, criterion 7. */
  readonly supportsTools?: boolean
  /** Whether a model is configured at all. */
  readonly configured?: boolean
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
  /** Runs a turn and returns everything it emitted. */
  turn(message: string, conversationId?: string): Promise<ChatEvent[]>
}

export function chatHarness({
  answers,
  database = migratedDatabase(),
  file = {},
  supportsTools = true,
  configured = true,
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

    async turn(message, conversationId) {
      const events: ChatEvent[] = []
      await service.turn(
        { message, ...(conversationId === undefined ? {} : { conversationId }) },
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
