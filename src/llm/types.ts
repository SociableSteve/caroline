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

/**
 * What a tool answered, on its way back to the model. The content is text rather than an
 * object because text is what all three providers carry, and because the tool has already
 * decided what the model should be told: a shape here would invite a second opinion.
 */
export interface ToolResult {
  readonly toolCallId: string
  readonly name: string
  readonly content: string
  /** True when the tool refused. Spec 07 allows the model one retry against that. */
  readonly isError?: boolean
}

/**
 * One turn of a conversation. Tool traffic travels on the messages rather than in a list of
 * its own, because its position in the exchange is most of its meaning: a result answers the
 * call in the turn before it, and every provider encodes that as ordering. `toolCalls`
 * belongs to an assistant turn and `toolResults` to a user turn; the other combination is
 * nothing an adapter can express, and chat never builds one.
 */
export interface Message {
  readonly role: 'user' | 'assistant'
  readonly content: string
  readonly toolCalls?: readonly ToolCall[]
  readonly toolResults?: readonly ToolResult[]
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
  /**
   * Whether this model can be given tools at all. The hosted providers can; Ollama's answer
   * depends on the model, so it is declared in the configuration rather than assumed. False
   * makes chat read-only, which spec 07 criterion 7 asks be said plainly rather than
   * discovered when a change silently fails to happen.
   */
  readonly supportsTools: boolean

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
