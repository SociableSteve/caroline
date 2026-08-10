/**
 * A provider that answers from a script. Ships in `src/` rather than in `test/` because the
 * classifier, the planner and chat all need one to be testable, and because a self-hoster
 * with `llm.provider` unset should be able to exercise the rest of Caroline. No test in this
 * repository ever calls a real model. Spec 03, criterion 1.
 */
import type { CompletionRequest, CompletionResult, LlmProvider } from './types.js'

/** One scripted turn: what to answer, or what to throw instead. */
export type FakeAnswer = Partial<CompletionResult> | { readonly throws: Error }

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
  chunkSize = 8,
}: FakeProviderOptions): FakeProvider {
  const requests: CompletionRequest[] = []
  let served = 0

  function next(request: CompletionRequest): CompletionResult {
    requests.push(request)

    // Past the end of the script, the last answer stands. An empty script answers nothing,
    // which is a valid thing to test a caller against.
    const answer = answers[Math.min(served, answers.length - 1)]
    served += 1

    if (answer === undefined) return emptyResult
    if ('throws' in answer) throw answer.throws

    return { ...emptyResult, ...answer }
  }

  return {
    name,
    isLocal,
    model,
    requests,

    complete(request) {
      return Promise.resolve(next(request))
    },

    async *stream(request) {
      const result = next(request)

      for (let start = 0; start < result.text.length; start += chunkSize) {
        yield { type: 'text', text: result.text.slice(start, start + chunkSize) }
      }

      yield { type: 'done', result }
    },
  }
}
