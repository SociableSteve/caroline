import { describe, expect, it } from 'vitest'
import { createAdapter } from '../../../src/llm/index.js'
import { withSchemaValidation } from '../../../src/llm/structured.js'
import type { LlmSettings } from '../../../src/config/schema.js'
import { LlmError, type CompletionRequest, type LlmProvider } from '../../../src/llm/types.js'
import {
  classificationSchema,
  expectedClassification,
  recordedPayload,
  stubFetch,
  type StubFetch,
} from '../../helpers/llm.js'

function settings(over: Partial<LlmSettings>): LlmSettings {
  return {
    provider: 'ollama',
    model: 'test-model',
    baseUrl: null,
    apiKey: null,
    maxTokens: 1024,
    timeoutMs: 5_000,
    isLocal: true,
    configured: true,
    ...over,
  }
}

const request: CompletionRequest = {
  system: 'Sort this item into a GTD status.',
  messages: [{ role: 'user', content: 'Can you sign off the venue booking?' }],
  schema: classificationSchema,
  maxTokens: 1024,
}

interface Case {
  readonly name: LlmProvider['name']
  readonly settings: LlmSettings
  readonly fixture: string
  /** Where the schema ends up in the built request, which is what spec 09 wants inspected. */
  schemaInBody(body: Record<string, unknown>): unknown
}

const cases: readonly Case[] = [
  {
    name: 'anthropic',
    settings: settings({ provider: 'anthropic', apiKey: 'sk-ant-test', isLocal: false }),
    fixture: 'anthropic-classification',
    schemaInBody: (body) =>
      (body.tools as Array<{ input_schema: unknown }> | undefined)?.[0]?.input_schema,
  },
  {
    name: 'openai',
    settings: settings({ provider: 'openai', apiKey: 'sk-oai-test', isLocal: false }),
    fixture: 'openai-classification',
    schemaInBody: (body) =>
      (body.response_format as { json_schema?: { schema?: unknown } } | undefined)?.json_schema
        ?.schema,
  },
  {
    name: 'ollama',
    settings: settings({ provider: 'ollama' }),
    fixture: 'ollama-classification',
    schemaInBody: (body) => body.format,
  },
]

function build(testCase: Case): { provider: LlmProvider; stub: StubFetch } {
  const stub = stubFetch([{ body: recordedPayload(testCase.fixture) }])
  return { provider: createAdapter(testCase.settings, { fetch: stub.fetch }), stub }
}

/** Spec 03, criterion 2. */
describe.each(cases)('the $name adapter', (testCase) => {
  it('turns its recorded response into the shared structured object', async () => {
    const { provider } = build(testCase)

    const result = await provider.complete(request)

    expect(result.structured).toEqual(expectedClassification)
  })

  it('survives validation against the schema it was asked for', async () => {
    const { provider } = build(testCase)

    const result = await withSchemaValidation(provider).complete(request)

    expect(result.structured).toEqual(expectedClassification)
  })

  it('reports the token usage the provider stated', async () => {
    const { provider } = build(testCase)

    const result = await provider.complete(request)

    expect(result.usage).toEqual({ inputTokens: 412, outputTokens: 37 })
  })

  it('names itself and its model, which is what the usage record is tagged with', async () => {
    const { provider } = build(testCase)

    expect(provider.name).toBe(testCase.name)
    expect(provider.model).toBe('test-model')
  })

  it('reports whether it is local, which is the whole of the content-policy guard', () => {
    const { provider } = build(testCase)

    expect(provider.isLocal).toBe(testCase.name === 'ollama')
  })

  it('puts the requested schema in the request it actually sends', async () => {
    const { provider, stub } = build(testCase)

    await provider.complete(request)

    expect(testCase.schemaInBody(stub.requests[0]?.body ?? {})).toEqual(classificationSchema)
  })

  it('sends the message content, and nothing the caller did not give it', async () => {
    const { provider, stub } = build(testCase)

    await provider.complete(request)

    const sent = JSON.stringify(stub.requests[0]?.body)
    expect(sent).toContain('Can you sign off the venue booking?')
    expect(sent).toContain('Sort this item into a GTD status.')
  })
})

/**
 * A schema and a set of tools in one request has no answer that satisfies both: forcing the
 * structured tool makes the declared tools unreachable, and leaving the choice open cannot
 * guarantee the schema. Refused by every adapter rather than sent and hoped for.
 */
describe.each(cases)('the $name adapter given both a schema and tools', (testCase) => {
  const ambiguous: CompletionRequest = {
    ...request,
    tools: [{ name: 'complete_task', description: 'Complete a task', parameters: {} }],
  }

  it('refuses the request rather than sending an ambiguous one', async () => {
    const stub = stubFetch([{ body: recordedPayload(testCase.fixture) }])
    const provider = createAdapter(testCase.settings, { fetch: stub.fetch })

    await expect(provider.complete(ambiguous)).rejects.toThrow(/both a schema and tools/)
    expect(stub.requests).toHaveLength(0)
  })

  it('refuses it on the streaming path too', async () => {
    const stub = stubFetch([{ body: recordedPayload(testCase.fixture) }])
    const provider = createAdapter(testCase.settings, { fetch: stub.fetch })

    await expect(
      (async () => {
        for await (const _chunk of provider.stream(ambiguous)) void _chunk
      })(),
    ).rejects.toThrow(/both a schema and tools/)
    expect(stub.requests).toHaveLength(0)
  })

  it('forces the structured answer when a schema is asked for alone', async () => {
    const { provider, stub } = build(testCase)

    await provider.complete(request)

    // Only Anthropic expresses this as a forced tool choice; the other two have their own
    // mechanism, asserted by the schema-in-the-body test above.
    if (testCase.name === 'anthropic') {
      expect(stub.requests[0]?.body.tool_choice).toEqual({
        type: 'tool',
        name: 'structured_answer',
      })
    }
  })
})

describe('the ollama adapter on an older server', () => {
  const ollama = cases[2] as Case

  it('falls back to json mode with the schema in the prompt when format is rejected', async () => {
    const stub = stubFetch([
      { status: 400, body: { error: 'invalid format' } },
      { body: recordedPayload(ollama.fixture) },
    ])
    const provider = createAdapter(ollama.settings, { fetch: stub.fetch })

    const result = await provider.complete(request)

    expect(result.structured).toEqual(expectedClassification)
    expect(stub.requests[1]?.body.format).toBe('json')
    expect(JSON.stringify(stub.requests[1]?.body)).toContain('JSON Schema')
  })

  it('remembers the fallback, so the second call does not pay for the rejection again', async () => {
    const stub = stubFetch([
      { status: 400, body: { error: 'invalid format' } },
      { body: recordedPayload(ollama.fixture) },
    ])
    const provider = createAdapter(ollama.settings, { fetch: stub.fetch })

    await provider.complete(request)
    await provider.complete(request)

    expect(stub.requests).toHaveLength(3)
    expect(stub.requests[2]?.body.format).toBe('json')
  })

  it('does not retry a failure that was not about the schema', async () => {
    const stub = stubFetch([{ status: 500, body: { error: 'model not loaded' } }])
    const provider = createAdapter(ollama.settings, { fetch: stub.fetch })

    await expect(provider.complete(request)).rejects.toThrow(/500/)
    expect(stub.requests).toHaveLength(1)
  })

  /**
   * A proxy in front of Ollama answering 200 with an HTML error page fails in the parse, not
   * in the request. That has to leave as an `LlmError` like every other provider failure, or
   * it is the one a caller has to recognise by shape.
   */
  it('raises an LlmError when a 200 carries something that is not JSON', async () => {
    const stub = stubFetch([
      { raw: { contentType: 'text/html', body: '<html>502 Bad Gateway</html>' } },
    ])
    const provider = createAdapter(ollama.settings, { fetch: stub.fetch })

    await expect(provider.complete(request)).rejects.toThrow(LlmError)
  })
})

/**
 * Ollama sends a tool call complete, in whichever chunk it decides on, and the final chunk
 * carries the totals with an empty message. Reading the calls off the last chunk alone loses
 * every one of them.
 */
describe('the ollama adapter reading streamed tool calls', () => {
  const ollama = cases[2] as Case

  const chatRequest: CompletionRequest = {
    system: 'Answer questions about the board.',
    messages: [{ role: 'user', content: 'Complete the venue task.' }],
    maxTokens: 512,
    tools: [{ name: 'complete_task', description: 'Complete a task', parameters: {} }],
  }

  it('collects calls announced before the final chunk', async () => {
    const stub = stubFetch([
      {
        lines: [
          {
            message: {
              role: 'assistant',
              tool_calls: [{ function: { name: 'complete_task', arguments: { id: 'task-1' } } }],
            },
          },
          { message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop' },
        ],
      },
    ])
    const provider = createAdapter(ollama.settings, { fetch: stub.fetch })

    const chunks = []
    for await (const chunk of provider.stream(chatRequest)) chunks.push(chunk)

    const done = chunks.at(-1)
    expect(done?.type === 'done' && done.result.toolCalls).toEqual([
      { id: 'call_0', name: 'complete_task', arguments: { id: 'task-1' } },
    ])
  })

  it('gives calls from different chunks different ids', async () => {
    const stub = stubFetch([
      {
        lines: [
          {
            message: {
              role: 'assistant',
              tool_calls: [{ function: { name: 'complete_task', arguments: { id: 'task-1' } } }],
            },
          },
          {
            message: {
              role: 'assistant',
              tool_calls: [{ function: { name: 'complete_task', arguments: { id: 'task-2' } } }],
            },
          },
          { message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop' },
        ],
      },
    ])
    const provider = createAdapter(ollama.settings, { fetch: stub.fetch })

    const chunks = []
    for await (const chunk of provider.stream(chatRequest)) chunks.push(chunk)

    const done = chunks.at(-1)
    const calls = done?.type === 'done' ? done.result.toolCalls : []
    expect(calls.map((call) => call.id)).toEqual(['call_0', 'call_1'])
  })
})
