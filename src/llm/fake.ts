/**
 * A provider that answers from a script. Ships in `src/` rather than in `test/` because the
 * classifier, the planner and chat all need one to be testable, and because a self-hoster
 * with `llm.provider` unset should be able to exercise the rest of Caroline. No test in this
 * repository ever calls a real model. Spec 03, criterion 1.
 */
import type { CompletionRequest, CompletionResult, LlmProvider } from './types.js'

/** One scripted turn: what to answer, what to throw instead, or a streamed answer that emits
 *  some text before failing partway through. */
export type FakeAnswer =
  | Partial<CompletionResult>
  | { readonly throws: Error }
  | { readonly partial: string; readonly throws: Error }

export interface FakeProviderOptions {
  /**
   * Consumed in order, one per `complete` or `stream` call. The last one is reused once the
   * script runs out, which is what makes "always answer this" the one-element case rather
   * than a separate mode.
   */
  readonly answers: readonly FakeAnswer[]
  readonly name?: LlmProvider['name']
  readonly model?: string
  readonly isLocal?: boolean
  /** False to stand in for a model that cannot be given tools. Spec 07, criterion 7. */
  readonly supportsTools?: boolean
  /** How a streamed answer is cut up, so a test can assert reassembly. */
  readonly chunkSize?: number
}

export interface FakeProvider extends LlmProvider {
  /** Every request made, in order. The subject of the content-policy assertions in spec 09. */
  readonly requests: readonly CompletionRequest[]
}

const emptyResult: CompletionResult = {
  text: '',
  toolCalls: [],
  usage: { inputTokens: 0, outputTokens: 0 },
  stopReason: 'end_turn',
}

export function createFakeProvider({
  answers,
  name = 'ollama',
  model = 'fake-model',
  isLocal = true,
  supportsTools = true,
  chunkSize = 8,
}: FakeProviderOptions): FakeProvider {
  const requests: CompletionRequest[] = []
  let served = 0

  /** Registers the call and hands back the script's next answer, unread. */
  function take(request: CompletionRequest): FakeAnswer | undefined {
    requests.push(request)

    // Past the end of the script, the last answer stands. An empty script answers nothing,
    // which is a valid thing to test a caller against.
    const answer = answers[Math.min(served, answers.length - 1)]
    served += 1
    return answer
  }

  function toResult(answer: FakeAnswer | undefined): CompletionResult {
    if (answer === undefined) return emptyResult
    // A non-streamed call has no incremental channel to deliver `partial` on, so it fails the
    // same way `throws` does: nothing came back.
    if ('throws' in answer) throw answer.throws

    return { ...emptyResult, ...answer }
  }

  return {
    name,
    isLocal,
    model,
    supportsTools,
    requests,

    complete(request) {
      return Promise.resolve(toResult(take(request)))
    },

    async *stream(request) {
      const answer = take(request)

      if (answer !== undefined && 'partial' in answer) {
        for (let start = 0; start < answer.partial.length; start += chunkSize) {
          yield { type: 'text', text: answer.partial.slice(start, start + chunkSize) }
        }
        throw answer.throws
      }

      const result = toResult(answer)

      for (let start = 0; start < result.text.length; start += chunkSize) {
        yield { type: 'text', text: result.text.slice(start, start + chunkSize) }
      }

      yield { type: 'done', result }
    },
  }
}
