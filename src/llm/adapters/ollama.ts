/**
 * Ollama, over its own HTTP API with no SDK. There is one endpoint, no authentication and no
 * error taxonomy to model, so a client would be a wrapper around `fetch` with nothing in it.
 * The hosted providers earn their SDKs by having none of those properties.
 *
 * Structured output is `format` set to the JSON schema, which recent Ollama versions honour.
 * An older server rejects an object there, so the adapter falls back once to `format: 'json'`
 * with the schema stated in the prompt. Spec 03.
 */
import {
  LlmError,
  type CompletionChunk,
  type CompletionRequest,
  type CompletionResult,
  type JsonSchema,
  type LlmProvider,
  type ToolCall,
} from '../types.js'
import { assertRequestIsAnswerable } from '../request.js'
import { guardCall, guardStream } from './guard.js'
import type { AdapterOptions } from './options.js'

const LABEL = 'Ollama'

export const DEFAULT_OLLAMA_URL = 'http://localhost:11434'

interface OllamaMessage {
  readonly role: string
  readonly content?: string
  readonly tool_calls?: ReadonlyArray<{
    readonly function?: { readonly name?: unknown; readonly arguments?: unknown }
  }>
}

interface OllamaResponse {
  readonly message?: OllamaMessage
  readonly done_reason?: unknown
  readonly prompt_eval_count?: unknown
  readonly eval_count?: unknown
}

function count(value: unknown): number {
  return typeof value === 'number' ? value : 0
}

/**
 * The schema restated as an instruction. Only used on the fallback path, where the server
 * can promise valid JSON but not JSON of a particular shape.
 */
function schemaInPrompt(system: string, schema: JsonSchema): string {
  return `${system}\n\nAnswer with a single JSON object matching this JSON Schema exactly, and nothing else:\n${JSON.stringify(schema)}`
}

function requestBody(
  request: CompletionRequest,
  model: string,
  { schemaInFormat }: { schemaInFormat: boolean },
): Record<string, unknown> {
  assertRequestIsAnswerable(request)

  const schema = request.schema
  const system =
    schema !== undefined && !schemaInFormat
      ? schemaInPrompt(request.system, schema)
      : request.system

  // `stream` is not set here: `send` supplies it, so there is one place that decides.
  return {
    model,
    messages: [
      { role: 'system', content: system },
      ...request.messages.map((message) => ({ role: message.role, content: message.content })),
    ],
    ...(schema === undefined ? {} : { format: schemaInFormat ? schema : 'json' }),
    ...((request.tools ?? []).length === 0
      ? {}
      : {
          tools: (request.tools ?? []).map((tool) => ({
            type: 'function',
            function: {
              name: tool.name,
              description: tool.description,
              parameters: tool.parameters,
            },
          })),
        }),
    options: {
      num_predict: request.maxTokens,
      ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
    },
  }
}

/** Ollama sends the structured answer as message content, so it is parsed rather than read. */
function parseStructured(content: string): unknown {
  try {
    return JSON.parse(content)
  } catch {
    return undefined
  }
}

/** A tool call as Ollama sends it: named, with arguments, and with no identity. */
type NamedCall = { readonly name: string; readonly arguments: unknown }

function toolCallsIn(body: OllamaResponse): NamedCall[] {
  return (body.message?.tool_calls ?? []).flatMap((call) =>
    typeof call.function?.name === 'string'
      ? [{ name: call.function.name, arguments: call.function.arguments }]
      : [],
  )
}

/**
 * Ollama does not give a call an id, and chat has to be able to attribute a result back to
 * one, so the position within the whole turn is used as the identity it never sent. Assigned
 * once over the collected list rather than per response, or two calls arriving in different
 * chunks of a stream would both be `call_0`.
 */
function withIds(calls: readonly NamedCall[]): ToolCall[] {
  return calls.map((call, index) => ({ id: `call_${index}`, ...call }))
}

function readResponse(body: OllamaResponse, wantedStructure: boolean): CompletionResult {
  const text = body.message?.content ?? ''
  const structured = wantedStructure ? parseStructured(text) : undefined

  return {
    text,
    ...(structured === undefined ? {} : { structured }),
    toolCalls: withIds(toolCallsIn(body)),
    usage: {
      inputTokens: count(body.prompt_eval_count),
      outputTokens: count(body.eval_count),
    },
    stopReason: typeof body.done_reason === 'string' ? body.done_reason : 'stop',
  }
}

export function createOllamaAdapter({
  model,
  baseUrl,
  timeoutMs,
  fetch = globalThis.fetch,
}: AdapterOptions): LlmProvider {
  const endpoint = `${(baseUrl ?? DEFAULT_OLLAMA_URL).replace(/\/+$/, '')}/api/chat`

  /**
   * Servers that reject a schema in `format` are remembered for the life of the process, so
   * the fallback is paid for once rather than on every call.
   */
  let schemaInFormat = true

  async function post(body: Record<string, unknown>): Promise<Response> {
    try {
      return await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (error) {
      if (error instanceof Error && error.name === 'TimeoutError') {
        throw new LlmError(`Ollama did not answer within ${timeoutMs}ms`)
      }
      throw new LlmError(
        `Ollama call failed: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      )
    }
  }

  async function send(request: CompletionRequest, stream: boolean): Promise<Response> {
    const response = await post({ ...requestBody(request, model, { schemaInFormat }), stream })
    if (response.ok) return response

    // A server too old for a schema in `format` answers 400. Anything else, and any failure
    // on a request that was not asking for a schema, is a real failure.
    if (response.status !== 400 || request.schema === undefined || !schemaInFormat) {
      throw new LlmError(`Ollama answered ${response.status} ${response.statusText}`)
    }

    schemaInFormat = false
    const retried = await post({ ...requestBody(request, model, { schemaInFormat }), stream })
    if (!retried.ok) {
      throw new LlmError(`Ollama answered ${retried.status} ${retried.statusText}`)
    }
    return retried
  }

  return {
    name: 'ollama',
    isLocal: true,
    model,

    async complete(request) {
      // Guarded around the parse as well as the request: a server that answers 200 with a
      // proxy's HTML error page fails in `response.json()`, and a `SyntaxError` escaping
      // from here would be the one provider failure a caller had to recognise by shape.
      return guardCall(LABEL, async () => {
        const response = await send(request, false)
        return readResponse((await response.json()) as OllamaResponse, request.schema !== undefined)
      })
    },

    stream(request): AsyncIterable<CompletionChunk> {
      // Guarded across the whole iteration, not only the opening request: a truncated body
      // fails on a `JSON.parse` partway through, and that should reach the caller as the same
      // kind of failure as a refused connection.
      return guardStream(LABEL, async function* () {
        const response = await send(request, true)
        if (response.body === null) throw new LlmError('Ollama answered a stream with no body')

        let text = ''
        let last: OllamaResponse = {}
        // Ollama sends a tool call complete, in whichever chunk it decides on, and the final
        // chunk carries the totals with an empty message. Reading the calls off the last
        // chunk alone would therefore lose every one of them.
        const calls: NamedCall[] = []

        // Newline-delimited JSON, one object per token batch, with the totals on the last.
        for await (const line of jsonLines(response.body)) {
          last = line
          calls.push(...toolCallsIn(line))

          const piece = line.message?.content ?? ''
          if (piece !== '') {
            text += piece
            yield { type: 'text' as const, text: piece }
          }
        }

        const structured = request.schema === undefined ? undefined : parseStructured(text)

        yield {
          type: 'done' as const,
          result: {
            text,
            ...(structured === undefined ? {} : { structured }),
            toolCalls: withIds(calls),
            usage: {
              inputTokens: count(last.prompt_eval_count),
              outputTokens: count(last.eval_count),
            },
            stopReason: typeof last.done_reason === 'string' ? last.done_reason : 'stop',
          },
        }
      })
    },
  }
}

/** The response body, cut on newlines and parsed. A blank or unparseable line is skipped. */
async function* jsonLines(body: ReadableStream<Uint8Array>): AsyncIterable<OllamaResponse> {
  const decoder = new TextDecoder()
  let buffered = ''

  for await (const piece of body as unknown as AsyncIterable<Uint8Array>) {
    buffered += decoder.decode(piece, { stream: true })

    let newline = buffered.indexOf('\n')
    while (newline !== -1) {
      const line = buffered.slice(0, newline).trim()
      buffered = buffered.slice(newline + 1)
      if (line !== '') yield JSON.parse(line) as OllamaResponse
      newline = buffered.indexOf('\n')
    }
  }

  const rest = buffered.trim()
  if (rest !== '') yield JSON.parse(rest) as OllamaResponse
}
