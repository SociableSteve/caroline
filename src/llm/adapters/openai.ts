/**
 * OpenAI, via the `openai` SDK. Structured output is `response_format` with a JSON schema,
 * so the answer arrives as the message content and is parsed here. Spec 03.
 *
 * Everything OpenAI-shaped stops at this file. Spec 03, criterion 4.
 */
import OpenAI from 'openai'
import type {
  CompletionChunk,
  CompletionRequest,
  CompletionResult,
  LlmProvider,
  ToolCall,
} from '../types.js'
import { assertRequestIsAnswerable } from '../request.js'
import { guardCall, guardStream } from './guard.js'
import { isStrictCompatible } from './strict-schema.js'
import { STRUCTURED_TOOL_NAME, structuredToolDescription } from './structured-tool.js'
import type { AdapterOptions } from './options.js'

const LABEL = 'OpenAI'

type ChatParams = OpenAI.Chat.Completions.ChatCompletionCreateParams
type ChatMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam

function messages(request: CompletionRequest): ChatMessage[] {
  return [
    { role: 'system', content: request.system },
    ...request.messages.map((message) => ({ role: message.role, content: message.content })),
  ]
}

function body(request: CompletionRequest, model: string): ChatParams {
  assertRequestIsAnswerable(request)

  const declared = (request.tools ?? []).map((tool) => ({
    type: 'function' as const,
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  }))

  return {
    model,
    max_completion_tokens: request.maxTokens,
    messages: messages(request),
    ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
    ...(declared.length === 0 ? {} : { tools: declared }),
    ...(request.schema === undefined
      ? {}
      : {
          response_format: {
            type: 'json_schema' as const,
            json_schema: {
              name: STRUCTURED_TOOL_NAME,
              description: structuredToolDescription,
              schema: request.schema,
              // Strict mode is the stronger guarantee and the one to want, but OpenAI
              // rejects the whole request when a schema does not meet its rules rather than
              // relaxing. A schema that cannot be strict is sent unstrict rather than
              // failing the job, and the shared validator still has the final say.
              strict: isStrictCompatible(request.schema),
            },
          },
        }),
  }
}

/** The structured answer arrives as message content, so it is parsed rather than read. */
function parseStructured(content: string | null): unknown {
  if (content === null || content === '') return undefined

  try {
    return JSON.parse(content)
  } catch {
    // Not an error: a model that answered in prose has produced something the schema will
    // reject, and the retry that follows is exactly the handling spec 03 asks for.
    return undefined
  }
}

function readChoice(
  completion: OpenAI.Chat.Completions.ChatCompletion,
  wantedStructure: boolean,
): CompletionResult {
  const choice = completion.choices[0]
  const content = choice?.message.content ?? null
  const structured = wantedStructure ? parseStructured(content) : undefined

  const toolCalls: ToolCall[] = (choice?.message.tool_calls ?? []).flatMap((call) =>
    call.type === 'function'
      ? [
          {
            id: call.id,
            name: call.function.name,
            arguments: parseArguments(call.function.arguments),
          },
        ]
      : [],
  )

  return {
    text: content ?? '',
    ...(structured === undefined ? {} : { structured }),
    toolCalls,
    usage: {
      inputTokens: completion.usage?.prompt_tokens ?? 0,
      outputTokens: completion.usage?.completion_tokens ?? 0,
    },
    stopReason: choice?.finish_reason ?? 'unknown',
  }
}

/** Arguments arrive as a JSON string. A tool decides what to make of them, not this. */
function parseArguments(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

export function createOpenAiAdapter({
  apiKey,
  model,
  baseUrl,
  timeoutMs,
  fetch,
}: AdapterOptions): LlmProvider {
  const client = new OpenAI({
    // Never left unset: as for Anthropic, the SDK would otherwise read `OPENAI_API_KEY`
    // itself, and a key the configuration decided not to use must not come back in.
    apiKey: apiKey ?? '',
    timeout: timeoutMs,
    // As for Anthropic: the scheduler owns backoff, and a retry underneath it would hold the
    // run open past the deadline it was given. Spec 06.
    maxRetries: 0,
    ...(baseUrl === null ? {} : { baseURL: baseUrl }),
    ...(fetch === undefined ? {} : { fetch }),
  })

  return {
    name: 'openai',
    isLocal: false,
    model,

    async complete(request) {
      const completion = await guardCall(LABEL, () =>
        client.chat.completions.create({ ...body(request, model), stream: false }),
      )
      return readChoice(completion, request.schema !== undefined)
    },

    stream(request): AsyncIterable<CompletionChunk> {
      return guardStream(LABEL, async function* () {
        const stream = await client.chat.completions.create({
          ...body(request, model),
          stream: true,
          // Usage is omitted from a streamed response unless it is asked for, and a call
          // with no usage would be recorded as having cost nothing. Spec 03, criterion 7.
          stream_options: { include_usage: true },
        })

        let text = ''
        let usage = { inputTokens: 0, outputTokens: 0 }
        let stopReason = 'unknown'
        // A streamed tool call arrives in pieces addressed by index, with the name in the
        // first and the arguments spread over the rest. Dropping them would leave chat able
        // to stream an answer but never to make a change.
        const partialCalls = new Map<number, { id: string; name: string; arguments: string }>()

        for await (const chunk of stream) {
          if (chunk.usage != null) {
            usage = {
              inputTokens: chunk.usage.prompt_tokens,
              outputTokens: chunk.usage.completion_tokens,
            }
          }

          const choice = chunk.choices[0]
          if (choice?.finish_reason != null) stopReason = choice.finish_reason

          for (const piece of choice?.delta.tool_calls ?? []) {
            const soFar = partialCalls.get(piece.index) ?? { id: '', name: '', arguments: '' }
            partialCalls.set(piece.index, {
              id: piece.id ?? soFar.id,
              name: piece.function?.name ?? soFar.name,
              arguments: soFar.arguments + (piece.function?.arguments ?? ''),
            })
          }

          const delta = choice?.delta.content
          if (delta != null && delta !== '') {
            text += delta
            yield { type: 'text' as const, text: delta }
          }
        }

        // Computed rather than spread inline, so that an answer that would not parse omits
        // the key entirely, exactly as the non-streamed path does. Two shapes for one
        // failure is a difference a caller would have to know about for no reason.
        const structured = request.schema === undefined ? undefined : parseStructured(text)

        yield {
          type: 'done' as const,
          result: {
            text,
            ...(structured === undefined ? {} : { structured }),
            toolCalls: [...partialCalls.entries()]
              .sort(([left], [right]) => left - right)
              .map(([, call]) => ({
                id: call.id,
                name: call.name,
                arguments: parseArguments(call.arguments),
              })),
            usage,
            stopReason,
          },
        }
      })
    },
  }
}
