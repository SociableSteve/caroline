import { describe, expect, it } from 'vitest'
import { createFakeProvider } from '../../src/llm/fake.js'
import { withSchemaValidation } from '../../src/llm/structured.js'
import {
  LlmError,
  LlmSchemaError,
  type CompletionAttempt,
  type CompletionChunk,
  type CompletionRequest,
  type CompletionResult,
  type JsonSchema,
  type LlmProvider,
} from '../../src/llm/types.js'

/**
 * Deliberately not the shared `classificationSchema` from `test/helpers/llm.ts`, and named
 * so the two cannot be mistaken for each other. These tests are about the retry rule rather
 * than about any particular schema, so they want the smallest one that can fail in an
 * interesting way.
 */
const statusAndConfidenceSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['status', 'confidence'],
  properties: {
    status: { type: 'string', enum: ['inbox', 'next', 'waiting', 'reference'] },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
  },
}

const request: CompletionRequest = {
  system: 'Sort this item.',
  messages: [{ role: 'user', content: 'Invoice from the venue' }],
  schema: statusAndConfidenceSchema,
  maxTokens: 256,
}

describe('schema validation around a provider', () => {
  it('returns a first answer that validates, without a second call', async () => {
    const fake = createFakeProvider({
      answers: [{ structured: { status: 'next', confidence: 0.9 } }],
    })

    const result = await withSchemaValidation(fake).complete(request)

    expect(result.structured).toEqual({ status: 'next', confidence: 0.9 })
    expect(fake.requests).toHaveLength(1)
  })

  it('retries exactly once when the first answer does not validate', async () => {
    const fake = createFakeProvider({
      answers: [
        { structured: { status: 'somewhere', confidence: 0.9 } },
        { structured: { status: 'waiting', confidence: 0.4 } },
      ],
    })

    const result = await withSchemaValidation(fake).complete(request)

    expect(result.structured).toEqual({ status: 'waiting', confidence: 0.4 })
    expect(fake.requests).toHaveLength(2)
  })

  it('appends the validation error to the retry, so the model is told what was wrong', async () => {
    const fake = createFakeProvider({
      answers: [
        { structured: { status: 'somewhere', confidence: 0.9 } },
        { structured: { status: 'waiting', confidence: 0.4 } },
      ],
    })

    await withSchemaValidation(fake).complete(request)

    const retry = fake.requests[1]
    expect(retry?.messages.at(-1)?.role).toBe('user')
    expect(retry?.messages.at(-1)?.content).toMatch(/did not validate/)
    // The rejected answer goes back too, or the correction names something absent.
    expect(retry?.messages.at(-2)).toEqual({
      role: 'assistant',
      content: '{"status":"somewhere","confidence":0.9}',
    })
  })

  it('fails after the second failure rather than returning unvalidated output', async () => {
    const fake = createFakeProvider({
      answers: [{ structured: { status: 'somewhere' } }, { structured: { confidence: 2 } }],
    })

    await expect(withSchemaValidation(fake).complete(request)).rejects.toThrow(LlmSchemaError)
    expect(fake.requests).toHaveLength(2)
  })

  it('carries both failures on the error, so the run history shows the whole story', async () => {
    const fake = createFakeProvider({
      answers: [{ structured: { status: 'somewhere' } }, { structured: { confidence: 2 } }],
    })

    const error = await withSchemaValidation(fake)
      .complete(request)
      .catch((thrown: unknown) => thrown)

    expect(error).toBeInstanceOf(LlmSchemaError)
    expect((error as LlmSchemaError).attempts).toHaveLength(2)
  })

  it('treats a missing structured answer as a validation failure, not as a success', async () => {
    const fake = createFakeProvider({ answers: [{ text: 'I would rather not' }] })

    await expect(withSchemaValidation(fake).complete(request)).rejects.toThrow(
      /no structured output/,
    )
  })

  it('does not retry a request that asked for no schema', async () => {
    const fake = createFakeProvider({ answers: [{ text: 'anything at all' }] })

    const result = await withSchemaValidation(fake).complete({
      system: 'Chat',
      messages: [{ role: 'user', content: 'hello' }],
      maxTokens: 64,
    })

    expect(result.text).toBe('anything at all')
    expect(fake.requests).toHaveLength(1)
  })
})

/**
 * A streamed call is recorded on the same terms as any other. Spec 03 criterion 7 is every call, and
 * chat only ever streams, so an unrecorded stream would leave the cost view describing a fraction of
 * what was spent.
 */
describe('recording a streamed call', () => {
  const chat: CompletionRequest = {
    system: 'You are Caroline.',
    messages: [{ role: 'user', content: 'What is in my inbox?' }],
    maxTokens: 256,
  }

  /** A provider whose stream is scripted chunk by chunk, so it can be made to stop short. */
  function streamingProvider(chunks: readonly CompletionChunk[]): LlmProvider {
    return {
      name: 'ollama',
      isLocal: true,
      model: 'a-model',
      supportsTools: true,
      complete: () => Promise.reject(new Error('not used')),
      async *stream() {
        // Not asynchronous in fact: what matters is that it is an async iterable, which is what the
        // wrapper consumes.
        for (const chunk of chunks) yield await Promise.resolve(chunk)
      },
    }
  }

  const answer: CompletionResult = {
    text: 'Three things.',
    toolCalls: [],
    usage: { inputTokens: 120, outputTokens: 8 },
    stopReason: 'end_turn',
  }

  async function drain(provider: LlmProvider): Promise<CompletionAttempt[]> {
    const attempts: CompletionAttempt[] = []
    const wrapped = withSchemaValidation(provider, { onAttempt: (a) => attempts.push(a) })

    for await (const chunk of wrapped.stream(chat)) void chunk

    return attempts
  }

  it('records the usage the final chunk carried', async () => {
    const attempts = await drain(
      streamingProvider([
        { type: 'text', text: 'Three things.' },
        { type: 'done', result: answer },
      ]),
    )

    expect(attempts).toMatchObject([
      { status: 'success', usage: { inputTokens: 120, outputTokens: 8 }, error: null },
    ])
  })

  /** A stream that stopped short still cost whatever it produced, and no row reads as free. */
  it('records a stream that ended without a final chunk', async () => {
    const attempts = await drain(streamingProvider([{ type: 'text', text: 'Half an ans' }]))

    expect(attempts).toMatchObject([
      { status: 'error', error: expect.stringContaining('without a final chunk') },
    ])
  })

  it('records a stream that failed partway, and re-raises the failure', async () => {
    const provider: LlmProvider = {
      ...streamingProvider([]),
      // eslint-disable-next-line require-yield
      async *stream() {
        throw new LlmError('the connection went away')
      },
    }
    const attempts: CompletionAttempt[] = []
    const wrapped = withSchemaValidation(provider, { onAttempt: (a) => attempts.push(a) })

    await expect(
      (async () => {
        for await (const chunk of wrapped.stream(chat)) void chunk
      })(),
    ).rejects.toThrow('the connection went away')
    expect(attempts).toMatchObject([{ status: 'error', error: /went away/ }])
  })
})
