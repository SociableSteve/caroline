/**
 * The retry rule, wrapped around a provider rather than written into each adapter. A
 * response that fails validation is sent back once with the validation error appended; a
 * second failure raises `LlmSchemaError` and the job records it. Callers never receive
 * unvalidated output, so a partial write on a malformed answer is not possible.
 * Spec 03, criterion 3.
 *
 * This is also where each attempt is timed and reported, because the retry loop is the only
 * place that knows an attempt happened at all. A schema failure and its retry are two calls,
 * both of which spent tokens, and spec 03 criterion 7 asks for both to be recorded.
 */
import {
  LlmSchemaError,
  type CompletionAttempt,
  type CompletionChunk,
  type CompletionRequest,
  type CompletionResult,
  type LlmProvider,
} from './types.js'
import { validateAgainstSchema } from './validate.js'

/** How many times a schema failure is fed back. Spec 03 says exactly one. */
export const SCHEMA_RETRIES = 1

export interface SchemaValidationOptions {
  /** Called once per provider call, whatever became of it. `recording.ts` writes the rows. */
  readonly onAttempt?: (attempt: CompletionAttempt) => void
  readonly now?: () => number
}

/**
 * The correction turn. Addressed to the model as the user, because that is the only role
 * every provider accepts a follow-up in, and it quotes the validator rather than
 * paraphrasing it: the message the model has to act on is the one the schema produced.
 */
function correction(failure: string): string {
  return `Your previous answer did not validate against the required schema: ${failure}. Answer again, using the schema exactly. Return only the structured answer.`
}

/** What the model said, in a form it can be shown again. */
function describe(result: CompletionResult): string {
  if (result.structured !== undefined) return JSON.stringify(result.structured)
  return result.text === '' ? '(no answer)' : result.text
}

const noTokens = { inputTokens: 0, outputTokens: 0 }

export function withSchemaValidation(
  provider: LlmProvider,
  { onAttempt, now = () => Date.now() }: SchemaValidationOptions = {},
): LlmProvider {
  /**
   * One provider call, timed. Whether it counts as a success or as an answer that did not
   * fit is not known until the schema has had a look, so the verdict is passed back rather
   * than reported here. A throw needs no verdict, and is reported before it is re-raised: a
   * provider that failed is a fact about usage even when it spent nothing, and this is the
   * only record that the attempt was made at all.
   */
  async function attempt(
    request: CompletionRequest,
  ): Promise<{ result: CompletionResult; report: (verdict: SchemaVerdict) => void }> {
    const startedAt = now()

    try {
      const result = await provider.complete(request)
      return {
        result,
        report: (verdict) =>
          onAttempt?.({
            startedAt,
            durationMs: now() - startedAt,
            usage: result.usage,
            status: verdict.valid ? 'success' : 'invalid',
            error: verdict.valid ? null : verdict.message,
          }),
      }
    } catch (error) {
      onAttempt?.({
        startedAt,
        durationMs: now() - startedAt,
        usage: noTokens,
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
      })
      throw error
    }
  }

  return {
    name: provider.name,
    isLocal: provider.isLocal,
    model: provider.model,
    supportsTools: provider.supportsTools,

    async complete(request: CompletionRequest): Promise<CompletionResult> {
      const { schema } = request

      if (schema === undefined) {
        const { result, report } = await attempt(request)
        report({ valid: true })
        return result
      }

      const failures: string[] = []
      let next = request

      for (let tries = 0; tries <= SCHEMA_RETRIES; tries += 1) {
        const { result, report } = await attempt(next)
        const outcome = validateAgainstSchema(schema, result.structured)

        // Recorded either way, and as what it was. The tokens of an answer that did not fit
        // were still spent. Spec 03, criterion 7.
        report(outcome)
        if (outcome.valid) return result

        failures.push(outcome.message)
        next = {
          ...next,
          messages: [
            ...next.messages,
            // The model's own answer goes back with the complaint. Without it the correction
            // names a mistake the conversation no longer contains.
            { role: 'assistant', content: describe(result) },
            { role: 'user', content: correction(outcome.message) },
          ],
        }
      }

      throw new LlmSchemaError(
        `${provider.name}/${provider.model} did not produce output matching the schema after ${failures.length} attempts: ${failures.join(' then ')}`,
        failures,
      )
    },

    /**
     * Streaming is chat's, and chat does not ask for structured output, so there is no schema to
     * validate and no retry rule to apply: the request is passed through rather than
     * reimplemented, so there cannot be a second, subtly different one.
     *
     * It is still recorded. Spec 03 criterion 7 is every call, and a chat turn that made eight
     * of them spent real tokens on all eight. Reported when the final chunk arrives, because that
     * is the chunk that carries the usage, and reported as an error if the stream fails part-way,
     * because a stream that died halfway through was still a call.
     */
    async *stream(request: CompletionRequest): AsyncIterable<CompletionChunk> {
      const startedAt = now()
      let finished = false

      try {
        for await (const chunk of provider.stream(request)) {
          if (chunk.type === 'done') {
            finished = true
            onAttempt?.({
              startedAt,
              durationMs: now() - startedAt,
              usage: chunk.result.usage,
              status: 'success',
              error: null,
            })
          }
          yield chunk
        }

        // A stream that stopped without a final chunk answered nothing and still cost whatever it
        // had produced. The caller decides what to make of that; this records that it happened,
        // because a call with no row is a call the cost view says was never made.
        if (!finished) {
          onAttempt?.({
            startedAt,
            durationMs: now() - startedAt,
            usage: noTokens,
            status: 'error',
            error: 'the stream ended without a final chunk',
          })
        }
      } catch (error) {
        onAttempt?.({
          startedAt,
          durationMs: now() - startedAt,
          usage: noTokens,
          status: 'error',
          error: error instanceof Error ? error.message : String(error),
        })
        throw error
      }
    },
  }
}

type SchemaVerdict = { valid: true } | { valid: false; message: string }
