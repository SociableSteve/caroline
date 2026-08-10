/**
 * The tool half of a conversation, on the wire. Chat's loop hands the model back its own tool call
 * and the result beside it (spec 07), and each provider encodes that differently: Anthropic as
 * content blocks inside the two turns, OpenAI and Ollama as messages of their own. Getting it wrong
 * does not fail loudly, it produces a model that cannot see what its tools answered, so the built
 * payload is asserted rather than the round trip.
 */
import { describe, expect, it } from 'vitest'
import { createAdapter } from '../../../src/llm/index.js'
import type { LlmSettings } from '../../../src/config/schema.js'
import type { CompletionRequest, LlmProvider } from '../../../src/llm/types.js'
import { recordedPayload, stubFetch, type StubFetch } from '../../helpers/llm.js'

function settings(over: Partial<LlmSettings>): LlmSettings {
  return {
    provider: 'ollama',
    model: 'test-model',
    baseUrl: null,
    apiKey: null,
    maxTokens: 1024,
    timeoutMs: 5_000,
    supportsTools: true,
    isLocal: true,
    configured: true,
    ...over,
  }
}

/** The exchange chat builds on its second pass: a call was made, and a tool answered it. */
const request: CompletionRequest = {
  system: 'You are Caroline.',
  messages: [
    { role: 'user', content: 'Anything about the venue?' },
    {
      role: 'assistant',
      content: 'Let me look.',
      toolCalls: [{ id: 'call_1', name: 'search_tasks', arguments: { query: 'venue' } }],
    },
    {
      role: 'user',
      content: '',
      toolResults: [{ toolCallId: 'call_1', name: 'search_tasks', content: '{"total":1}' }],
    },
  ],
  tools: [
    {
      name: 'search_tasks',
      description: 'Find tasks.',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
    },
  ],
  maxTokens: 1024,
}

interface Case {
  readonly name: LlmProvider['name']
  readonly settings: LlmSettings
  readonly fixture: string
}

const cases: readonly Case[] = [
  {
    name: 'anthropic',
    settings: settings({ provider: 'anthropic', apiKey: 'sk-ant-test', isLocal: false }),
    fixture: 'anthropic-classification',
  },
  {
    name: 'openai',
    settings: settings({ provider: 'openai', apiKey: 'sk-oai-test', isLocal: false }),
    fixture: 'openai-classification',
  },
  {
    name: 'ollama',
    settings: settings({ provider: 'ollama' }),
    fixture: 'ollama-classification',
  },
]

async function send(testCase: Case): Promise<StubFetch> {
  const stub = stubFetch([{ body: recordedPayload(testCase.fixture) }])
  await createAdapter(testCase.settings, { fetch: stub.fetch }).complete(request)
  return stub
}

describe.each(cases)('$name, given a turn that carried tool traffic', (testCase) => {
  it('declares the tool it was given', async () => {
    const stub = await send(testCase)
    const body = JSON.stringify(stub.requests[0]?.body)

    expect(body).toContain('search_tasks')
    expect(body).toContain('Find tasks.')
  })

  it('carries the call the model made and the result it was given back', async () => {
    const stub = await send(testCase)
    const body = JSON.stringify(stub.requests[0]?.body)

    // The arguments and the answer both have to survive, or the model is being asked the same
    // question again. How each is encoded, and how a result is paired to its call, is the
    // provider's business and is asserted per provider below: Ollama has no call id at all.
    expect(body).toContain('venue')
    expect(body).toContain('total')
  })
})

describe('anthropic', () => {
  it('puts the call and the result in the turns they belong to, results first', async () => {
    const stub = await send(cases[0] as Case)
    const messages = (stub.requests[0]?.body.messages ?? []) as Array<{
      role: string
      content: unknown
    }>

    expect(messages[1]).toMatchObject({
      role: 'assistant',
      content: [
        { type: 'text', text: 'Let me look.' },
        { type: 'tool_use', id: 'call_1', name: 'search_tasks', input: { query: 'venue' } },
      ],
    })
    // Anthropic rejects a `tool_result` that does not lead the user turn it belongs to, and a turn
    // that is nothing but results carries no text block at all.
    expect(messages[2]).toMatchObject({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'call_1', content: '{"total":1}' }],
    })
  })

  it('leaves an ordinary turn as a plain string, which is what the fixtures were taken against', async () => {
    const stub = await send(cases[0] as Case)
    const messages = (stub.requests[0]?.body.messages ?? []) as Array<{ content: unknown }>

    expect(messages[0]?.content).toBe('Anything about the venue?')
  })
})

describe('openai', () => {
  it('sends the result as a message of its own, addressed to the call', async () => {
    const stub = await send(cases[1] as Case)
    const messages = (stub.requests[0]?.body.messages ?? []) as Array<Record<string, unknown>>

    expect(messages[2]).toMatchObject({
      role: 'assistant',
      // Null rather than empty: OpenAI rejects an assistant message with neither content nor calls,
      // and this one has calls.
      content: 'Let me look.',
      tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'search_tasks' } }],
    })
    expect(messages[3]).toMatchObject({
      role: 'tool',
      tool_call_id: 'call_1',
      content: '{"total":1}',
    })
  })

  it('encodes the arguments as the JSON string the API expects', async () => {
    const stub = await send(cases[1] as Case)
    const messages = (stub.requests[0]?.body.messages ?? []) as Array<{
      tool_calls?: Array<{ function: { arguments: unknown } }>
    }>

    expect(messages[2]?.tool_calls?.[0]?.function.arguments).toBe('{"query":"venue"}')
  })
})

describe('ollama', () => {
  it('names the tool on the result, since it has no call id to pair on', async () => {
    const stub = await send(cases[2] as Case)
    const messages = (stub.requests[0]?.body.messages ?? []) as Array<Record<string, unknown>>

    // The system prompt is the first message for ollama, so the exchange starts at index one.
    expect(messages[2]).toMatchObject({
      role: 'assistant',
      content: 'Let me look.',
      tool_calls: [{ function: { name: 'search_tasks', arguments: { query: 'venue' } } }],
    })
    expect(messages[3]).toMatchObject({
      role: 'tool',
      tool_name: 'search_tasks',
      content: '{"total":1}',
    })
  })
})
