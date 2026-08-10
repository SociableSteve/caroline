import { describe, expect, it } from 'vitest'
import { createAdapter } from '../../../src/llm/index.js'
import type { LlmSettings } from '../../../src/config/schema.js'
import { LlmError, type CompletionChunk, type CompletionRequest } from '../../../src/llm/types.js'
import { recordedStream, stubFetch, type StubReply } from '../../helpers/llm.js'

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

const request: CompletionRequest = {
  system: 'Answer questions about the board.',
  messages: [{ role: 'user', content: 'What is waiting on somebody else?' }],
  maxTokens: 1024,
}

const answer = 'Three things are waiting on somebody else.'

/** The turn the tool-call fixtures answer: one call, with its arguments spread over chunks. */
const toolRequest: CompletionRequest = {
  system: 'Answer questions about the board.',
  messages: [{ role: 'user', content: 'Complete the venue task.' }],
  maxTokens: 1024,
  tools: [{ name: 'complete_task', description: 'Complete a task', parameters: {} }],
}

/** The three recorded streams all carry the same answer, so the assertions can be shared. */
const cases = [
  {
    name: 'anthropic',
    settings: settings({ provider: 'anthropic', apiKey: 'sk-ant-test', isLocal: false }),
    reply: { sse: recordedStream('anthropic-chat') } satisfies StubReply,
    // A stream that starts well and then carries an event nobody can parse.
    broken: {
      raw: {
        contentType: 'text/event-stream',
        body: 'event: message_start\ndata: {"type":"message_start","message":{"id":"m","type":"message","role":"assistant","model":"m","content":[],"stop_reason":null,"usage":{"input_tokens":1,"output_tokens":1}}}\n\nevent: content_block_delta\ndata: {not json\n\n',
      },
    } satisfies StubReply,
    toolCall: { sse: recordedStream('anthropic-tool-call') } satisfies StubReply,
  },
  {
    name: 'openai',
    settings: settings({ provider: 'openai', apiKey: 'sk-oai-test', isLocal: false }),
    reply: { sse: recordedStream('openai-chat') } satisfies StubReply,
    broken: {
      raw: {
        contentType: 'text/event-stream',
        body: 'data: {"id":"c","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"content":"Three "},"finish_reason":null}]}\n\ndata: {not json\n\n',
      },
    } satisfies StubReply,
    toolCall: { sse: recordedStream('openai-tool-call') } satisfies StubReply,
  },
  {
    name: 'ollama',
    settings: settings({ provider: 'ollama' }),
    reply: {
      lines: [
        { message: { role: 'assistant', content: 'Three things ' }, done: false },
        { message: { role: 'assistant', content: 'are waiting ' }, done: false },
        { message: { role: 'assistant', content: 'on somebody else.' }, done: false },
        {
          message: { role: 'assistant', content: '' },
          done: true,
          done_reason: 'stop',
          prompt_eval_count: 128,
          eval_count: 11,
        },
      ],
    } satisfies StubReply,
    // A body cut off mid-object, which is what a connection dropped partway looks like.
    broken: {
      raw: {
        contentType: 'application/json',
        body: '{"message":{"role":"assistant","content":"Three "}}\n{"message":',
      },
    } satisfies StubReply,
    // Ollama sends a tool call complete, in a chunk of its own, before the totals arrive.
    toolCall: {
      lines: [
        {
          message: {
            role: 'assistant',
            tool_calls: [{ function: { name: 'complete_task', arguments: { id: 'task-1' } } }],
          },
        },
        { message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop' },
      ],
    } satisfies StubReply,
  },
] as const

async function collect(chunks: AsyncIterable<CompletionChunk>): Promise<CompletionChunk[]> {
  const seen: CompletionChunk[] = []
  for await (const chunk of chunks) seen.push(chunk)
  return seen
}

describe.each(cases)('streaming from $name', (testCase) => {
  function build() {
    const stub = stubFetch([testCase.reply])
    return createAdapter(testCase.settings, { fetch: stub.fetch })
  }

  it('yields the answer in pieces as it arrives', async () => {
    const chunks = await collect(build().stream(request))

    const text = chunks.filter((chunk) => chunk.type === 'text')
    expect(text.length).toBeGreaterThan(1)
    expect(text.map((chunk) => chunk.text).join('')).toBe(answer)
  })

  it('ends with one done chunk carrying the whole result', async () => {
    const chunks = await collect(build().stream(request))

    const done = chunks.filter((chunk) => chunk.type === 'done')
    expect(done).toHaveLength(1)
    expect(chunks.at(-1)).toBe(done[0])
    expect(done[0]?.result.text).toBe(answer)
  })

  it('reports the usage on the done chunk, so a streamed call is not recorded as free', async () => {
    const chunks = await collect(build().stream(request))

    const done = chunks.at(-1)
    expect(done?.type === 'done' && done.result.usage).toEqual({
      inputTokens: 128,
      outputTokens: 11,
    })
  })

  /**
   * The whole iteration is guarded, not only the opening request: a stream that dies partway
   * should reach the caller as the same kind of failure as one that never opened, so that no
   * caller has to know one SDK's error type, let alone three.
   */
  it('raises an LlmError when the stream dies partway through', async () => {
    const stub = stubFetch([testCase.broken])
    const provider = createAdapter(testCase.settings, { fetch: stub.fetch })

    await expect(collect(provider.stream(request))).rejects.toThrow(LlmError)
  })

  it('reports why the model stopped', async () => {
    const chunks = await collect(build().stream(request))

    const done = chunks.at(-1)
    expect(done?.type === 'done' && done.result.stopReason).toBe(
      testCase.name === 'anthropic' ? 'end_turn' : 'stop',
    )
  })

  /**
   * Each provider dribbles a tool call out differently: OpenAI in argument deltas addressed
   * by index, Anthropic in `input_json_delta` blocks, Ollama complete in one chunk. All three
   * have to arrive on the done chunk as one normalised call, or chat can stream an answer
   * but never make a change.
   */
  it('collects a tool call spread across the stream', async () => {
    const stub = stubFetch([testCase.toolCall])
    const provider = createAdapter(testCase.settings, { fetch: stub.fetch })

    const chunks = await collect(provider.stream(toolRequest))

    const done = chunks.at(-1)
    const calls = done?.type === 'done' ? done.result.toolCalls : []
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ name: 'complete_task', arguments: { id: 'task-1' } })
  })
})
