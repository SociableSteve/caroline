/**
 * Every failure leaves an adapter as an `LlmError`, so that no caller has to know one SDK's
 * error type, let alone three. Shared by the adapters rather than written out in each,
 * because a provider whose errors escaped in their own shape would be a hole in exactly the
 * boundary spec 03 criterion 4 draws.
 */
import { LlmError } from '../types.js'

function describe(label: string, error: unknown): LlmError {
  // An `LlmError` raised deliberately (a rate limit, a status code) is already the right
  // shape and says something more useful than a wrapper around it would.
  if (error instanceof LlmError) return error

  return new LlmError(
    `${label} call failed: ${error instanceof Error ? error.message : String(error)}`,
    {
      cause: error,
    },
  )
}

export async function guardCall<T>(label: string, work: () => Promise<T>): Promise<T> {
  try {
    return await work()
  } catch (error) {
    throw describe(label, error)
  }
}

/**
 * The whole iteration, not only its first step: a stream fails partway as readily as it
 * fails to open, and the two should not surface as different kinds of thing.
 */
export async function* guardStream<T>(
  label: string,
  work: () => AsyncIterable<T>,
): AsyncIterable<T> {
  try {
    yield* work()
  } catch (error) {
    throw describe(label, error)
  }
}
