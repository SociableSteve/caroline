/**
 * The one interface the classifier, the planner and chat depend on. Callers never see a
 * vendor SDK type: everything provider-shaped stays inside `src/llm/adapters/`, which
 * `test/llm/boundary.test.ts` asserts rather than trusts. Spec 03, criterion 4.
 */
import type { LlmCallStatus } from '../domain/llm.js'

/**
 * A JSON Schema, carried as data rather than as a type. Adapters hand it to the provider as
 * the shape it must produce; `validate.ts` checks the answer against the same object, so the
 * schema the provider was asked for and the schema the answer is judged by cannot drift.
 */
export type JsonSchema = Record<string, unknown>

export interface Message {
  readonly role: 'user' | 'assistant'
  readonly content: string
}

export interface ToolDefinition {
  readonly name: string
  readonly description: string
  readonly parameters: JsonSchema
}

export interface ToolCall {
  /** The provider's own id for the call, needed to attribute a result back to it. */
  readonly id: string
  readonly name: string
  /** Parsed from whatever the provider sent. Validated by the tool, not here. */
  readonly arguments: unknown
}

export interface CompletionRequest {
  readonly system: string
  readonly messages: readonly Message[]
  /** When set, the result must validate against it, and `structured` carries the answer. */
  readonly schema?: JsonSchema
  /** Chat only. Spec 03 keeps scheduled jobs on structured output alone. */
  readonly tools?: readonly ToolDefinition[]
  readonly maxTokens: number
  readonly temperature?: number
}

export interface TokenUsage {
  readonly inputTokens: number
  readonly outputTokens: number
}

export interface CompletionResult {
  readonly text: string
  /** Present exactly when the request carried a schema and the answer satisfied it. */
  readonly structured?: unknown
  readonly toolCalls: readonly ToolCall[]
  readonly usage: TokenUsage
  /** The provider's own word for why it stopped, passed through rather than mapped. */
  readonly stopReason: string
}

/**
 * One call to a provider, as it happened. Reported by the retry loop, which is the only
 * place that knows how many calls a single `complete` turned into, and consumed by whatever
 * wants to record them. Spec 03's cost record is built from these.
 */
export interface CompletionAttempt {
  readonly startedAt: number
  readonly durationMs: number
  /** Zeroes when the call never came back, which is the only case where nothing was spent. */
  readonly usage: TokenUsage
  readonly status: LlmCallStatus
  readonly error: string | null
}

/**
 * A streamed turn. Text arrives in pieces; the final chunk carries the whole result, so a
 * caller that only wants the total does not have to reassemble it. Chat only: spec 03 says
 * scheduled jobs do not stream.
 */
export type CompletionChunk =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'done'; readonly result: CompletionResult }

export interface LlmProvider {
  readonly name: 'anthropic' | 'openai' | 'ollama'
  /** True only for ollama. Spec 09's full-content guard turns on exactly this. */
  readonly isLocal: boolean
  readonly model: string

  complete(request: CompletionRequest): Promise<CompletionResult>
  stream(request: CompletionRequest): AsyncIterable<CompletionChunk>
}

/** A call that failed on the provider's side: transport, authentication, a rejection. */
export class LlmError extends Error {
  override readonly name = 'LlmError'
}

/**
 * A call that came back and did not match the requested schema, twice. Separate from
 * `LlmError` because the fix is a different one: the prompt or the schema, not the provider.
 * Spec 03, criterion 3.
 */
export class LlmSchemaError extends Error {
  override readonly name = 'LlmSchemaError'

  constructor(
    message: string,
    /** Every attempt's validation failure, in order, so the run history shows both. */
    readonly attempts: readonly string[],
  ) {
    super(message)
  }
}
