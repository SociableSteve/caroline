/**
 * The bridge between an attempt and a row. Kept apart from the retry loop so that the loop
 * has no database in it and can be tested with a sink that just collects, and so that a
 * caller with no database (the setting screen's payload preview, spec 09 criterion 9) can
 * make a call without one. Spec 03.
 */
import type { LlmPurpose } from '../domain/llm.js'
import type { Database } from '../db/connection.js'
import { recordLlmCall } from '../db/repositories/llm-calls.js'
import type { CompletionAttempt, LlmProvider } from './types.js'

/**
 * A sink that writes each attempt to `llm_calls`, tagged with the provider that made it and
 * what it was for.
 *
 * Recording never throws: a usage row is bookkeeping, and losing the classification of a
 * whole mailbox because the cost table would not take a row is the wrong trade. The failure
 * goes to `onError`, which is the process logger in production.
 */
export function llmCallRecorder(
  database: Database,
  provider: Pick<LlmProvider, 'name' | 'model'>,
  purpose: LlmPurpose,
  onError: (error: unknown) => void = () => {},
): (attempt: CompletionAttempt) => void {
  return (attempt) => {
    try {
      recordLlmCall(database, {
        provider: provider.name,
        model: provider.model,
        purpose,
        startedAt: attempt.startedAt,
        durationMs: attempt.durationMs,
        inputTokens: attempt.usage.inputTokens,
        outputTokens: attempt.usage.outputTokens,
        status: attempt.status,
        error: attempt.error,
      })
    } catch (error) {
      onError(error)
    }
  }
}
