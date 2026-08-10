import { describe, expect, it } from 'vitest'
import { createFakeProvider } from '../../src/llm/fake.js'
import { withSchemaValidation } from '../../src/llm/structured.js'
import { LlmSchemaError, type CompletionRequest, type JsonSchema } from '../../src/llm/types.js'

const classificationSchema: JsonSchema = {
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
  schema: classificationSchema,
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
