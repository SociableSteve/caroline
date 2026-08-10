/**
 * What a model call is, as a record rather than as an act. The call itself lives in
 * `src/llm`; this is the part the database and the UI share. Spec 03.
 */

/**
 * What the call was for. Every call has one, because "usage per job" is the question the
 * cost view exists to answer and it cannot be reconstructed afterwards.
 */
export const llmPurposes = ['classification', 'planning', 'chat'] as const
export type LlmPurpose = (typeof llmPurposes)[number]

/**
 * How the call ended.
 *
 * `invalid` is separate from `error` because it is the one failure the caller can do
 * something about: the provider answered, spent tokens doing it, and produced something the
 * requested schema rejected. A run of them says the prompt or the schema needs work, which
 * is a different conversation from the provider being down.
 */
export const llmCallStatuses = ['success', 'invalid', 'error'] as const
export type LlmCallStatus = (typeof llmCallStatuses)[number]

export interface LlmCall {
  readonly id: string
  /** The adapter that made it. Never `none`: a call implies a provider. */
  readonly provider: 'anthropic' | 'openai' | 'ollama'
  readonly model: string
  readonly purpose: LlmPurpose
  readonly startedAt: number
  readonly durationMs: number
  readonly inputTokens: number
  readonly outputTokens: number
  readonly status: LlmCallStatus
  /** The failure in the provider's own words, or the validation error. Null on success. */
  readonly error: string | null
}

/** Usage rolled up over some grouping. The UI reads these; nothing prices them. */
export interface LlmUsage {
  readonly calls: number
  readonly inputTokens: number
  readonly outputTokens: number
}

export const noUsage: LlmUsage = { calls: 0, inputTokens: 0, outputTokens: 0 }
