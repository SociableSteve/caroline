/**
 * Anthropic, via `@anthropic-ai/sdk`. Structured output is a single tool whose input schema
 * is the requested schema, with `tool_choice` forcing it: the model cannot answer in prose
 * instead, and the argument object comes back already parsed. Spec 03.
 *
 * Everything Anthropic-shaped stops at this file. Nothing it imports escapes into a return
 * type, which is what `test/llm/boundary.test.ts` checks. Spec 03, criterion 4.
 */
import Anthropic from '@anthropic-ai/sdk'
import type {
  CompletionChunk,
  CompletionRequest,
  CompletionResult,
  LlmProvider,
  ToolCall,
  ToolDefinition,
} from '../types.js'
import { assertRequestIsAnswerable } from '../request.js'
import { guardCall, guardStream } from './guard.js'
import { STRUCTURED_TOOL_NAME, structuredToolDescription } from './structured-tool.js'
import type { AdapterOptions } from './options.js'

const LABEL = 'Anthropic'

type MessageParam = Anthropic.Messages.MessageParam
type ToolParam = Anthropic.Messages.Tool

/**
 * Either the declared tools or the structured-output tool, never both: a request carrying
 * both is refused before it gets here, so there is no case where the forced choice below
 * makes a declared tool unreachable. See `src/llm/request.ts`.
 */
function tools(request: CompletionRequest): ToolParam[] {
  if (request.schema !== undefined) {
    return [
      {
        name: STRUCTURED_TOOL_NAME,
        description: structuredToolDescription,
        input_schema: request.schema as ToolParam['input_schema'],
      },
    ]
  }

  return (request.tools ?? []).map((tool: ToolDefinition) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters as ToolParam['input_schema'],
  }))
}

function messages(request: CompletionRequest): MessageParam[] {
  return request.messages.map((message) => ({ role: message.role, content: message.content }))
}

function body(request: CompletionRequest, model: string): Anthropic.Messages.MessageCreateParams {
  assertRequestIsAnswerable(request)
  const declared = tools(request)

  return {
    model,
    max_tokens: request.maxTokens,
    system: request.system,
    messages: messages(request),
    ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
    ...(declared.length === 0 ? {} : { tools: declared }),
    // Forced whenever a schema was asked for, which is what makes the structured answer a
    // guarantee rather than a request: the model cannot answer in prose instead.
    ...(request.schema === undefined
      ? {}
      : { tool_choice: { type: 'tool' as const, name: STRUCTURED_TOOL_NAME } }),
  }
}

/** Text blocks joined, tool calls separated out, and the structured answer picked from them. */
function readMessage(message: Anthropic.Messages.Message): CompletionResult {
  let text = ''
  let structured: unknown
  const toolCalls: ToolCall[] = []

  for (const block of message.content) {
    if (block.type === 'text') text += block.text
    if (block.type !== 'tool_use') continue

    if (block.name === STRUCTURED_TOOL_NAME) {
      structured = block.input
      continue
    }
    toolCalls.push({ id: block.id, name: block.name, arguments: block.input })
  }

  return {
    text,
    ...(structured === undefined ? {} : { structured }),
    toolCalls,
    usage: {
      inputTokens: message.usage.input_tokens,
      outputTokens: message.usage.output_tokens,
    },
    stopReason: message.stop_reason ?? 'unknown',
  }
}

export function createAnthropicAdapter({
  apiKey,
  model,
  baseUrl,
  timeoutMs,
  fetch,
}: AdapterOptions): LlmProvider {
  const client = new Anthropic({
    // Never left unset: the SDK falls back to reading `ANTHROPIC_API_KEY` itself, and a key
    // the configuration decided not to use must not come back in through the side door.
    apiKey: apiKey ?? '',
    timeout: timeoutMs,
    // The SDK retries on its own, and a job that is retried on a schedule does not need a
    // second retry policy underneath it holding the run open. Spec 06 owns backoff.
    maxRetries: 0,
    ...(baseUrl === null ? {} : { baseURL: baseUrl }),
    ...(fetch === undefined ? {} : { fetch }),
  })

  return {
    name: 'anthropic',
    isLocal: false,
    model,

    async complete(request) {
      return guardCall(LABEL, async () =>
        readMessage(await client.messages.create({ ...body(request, model), stream: false })),
      )
    },

    stream(request): AsyncIterable<CompletionChunk> {
      return guardStream(LABEL, async function* () {
        const events = client.messages.stream({ ...body(request, model) })

        // The SDK accumulates the final message itself, so the text deltas are forwarded as
        // they arrive and the completed message is read once at the end by the same function
        // the non-streaming path uses. One reader, so the two cannot disagree.
        for await (const event of events) {
          if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
            yield { type: 'text' as const, text: event.delta.text }
          }
        }

        yield { type: 'done' as const, result: readMessage(await events.finalMessage()) }
      })
    },
  }
}
