# 03. LLM provider

## Purpose

One interface, three adapters, so that the classifier, the planner and the chat never know
which model they are talking to and a self-hoster can run entirely locally.

## Interface

```ts
interface LlmProvider {
  readonly name: 'anthropic' | 'openai' | 'ollama'
  readonly isLocal: boolean          // true only for ollama
  readonly model: string             // what the usage record is tagged with
  readonly supportsTools: boolean    // whether tools may be offered at all

  complete(request: CompletionRequest): Promise<CompletionResult>
  stream(request: CompletionRequest): AsyncIterable<CompletionChunk>
}

interface CompletionRequest {
  system: string
  messages: Message[]
  schema?: JsonSchema        // when set, the result must validate against it
  tools?: ToolDefinition[]   // chat only
  maxTokens: number
  temperature?: number
}

interface Message {
  role: 'user' | 'assistant'
  content: string
  toolCalls?: ToolCall[]     // an assistant turn: what the model asked for
  toolResults?: ToolResult[] // a user turn: what those calls answered
}

interface CompletionResult {
  text: string
  structured?: unknown       // parsed and validated when schema was set
  toolCalls: ToolCall[]
  usage: { inputTokens: number; outputTokens: number }
  stopReason: string
}
```

Callers depend on `LlmProvider`, never on a vendor SDK type. Provider-specific types stay
inside the adapter.

## Structured output

Every scheduled job asks for structured output. Each adapter meets the same contract by
different means:

- **Anthropic**: a single tool whose `input_schema` is the requested schema, with
  `tool_choice` forcing it. Uses `@anthropic-ai/sdk`.
- **OpenAI**: `response_format` with a JSON schema. Strict mode is the stronger guarantee,
  but OpenAI rejects the whole request when a schema falls outside the subset it supports
  (every object closed, every declared property required, and only certain keywords used)
  rather than relaxing. Rather than rewrite a schema to fit, which would change what was
  asked for, the adapter turns strict mode on for the schemas that already qualify and sends
  the rest unstrict. Shared validation has the final say either way.

  The keyword test is an allowlist rather than a list of known-bad keywords, because the two
  failure modes are not symmetric: sending a supported schema unstrict costs a guarantee that
  validation supplies anyway, while sending an unsupported one strict fails the whole
  request. The supported subset also moves. A keyword nobody has considered therefore falls
  on the unstrict side.

A request carrying both a schema and a set of tools is refused before it reaches a provider.
There is no answer that satisfies both: forcing the structured tool makes the declared tools
unreachable, and leaving the choice open cannot guarantee the schema. Tools are chat's and
structured output is the scheduled jobs', and a caller that genuinely needs both needs turns
rather than one ambiguous request.
- **Ollama**: `format` set to the JSON schema, which recent Ollama versions support; falls
  back to `format: 'json'` plus schema-in-prompt for older servers.

The result is validated against the schema in shared code, not in the adapter. A
validation failure retries once with the validation error appended, then fails the job with
a recorded error. Callers never receive unvalidated output.

## Tool use

Only chat (spec 07) uses tools. The adapter translates the shared `ToolDefinition` shape to
the provider's format and normalises tool calls back.

A tool loop is a conversation, so the traffic travels on the messages: an assistant turn
carries the calls the model made, and the user turn after it carries their results. Each
provider encodes that differently, and the adapter is where that difference stops. Anthropic
takes both as content blocks inside the two turns, with results leading the user turn;
OpenAI and Ollama take a result as a message of its own, addressed by call id and by tool
name respectively.

Whether tools may be offered at all is a property of the provider, `supportsTools`. The
hosted providers take tools from every model they serve, so it is true for them. Ollama's
answer depends on the model rather than on the server, so it is declared in the
configuration (`llm.supportsTools`, inheritable by an override) and is false until it is:
chat that says it cannot make changes is recoverable, and chat that claims a change it could
not make is not. That is the graceful degradation spec 07 criterion 7 asks for.

## Configuration

```jsonc
{
  "llm": {
    "provider": "anthropic",
    "model": "claude-sonnet-5",
    "baseUrl": null,              // override for proxies or self-hosted gateways
    "maxTokens": 4096,
    "timeoutMs": 60000,
    "supportsTools": true       // ollama only: does this model call tools?
  }
}
```

API keys come from the environment (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`), never from the
config file. Ollama needs no key and defaults to `http://localhost:11434`.

Different jobs may use different models: `llm.overrides.classification` and
`llm.overrides.chat` accept a partial config. A cheap fast model for hourly sorting and a
stronger one for chat is the expected setup. The planner runs on the base settings, because
a plan is drawn once a day and is the one place where the better model obviously earns its
cost.

An override is a patch, not a replacement: what it does not name it inherits. The one
exception is `baseUrl`, which is not inherited across a change of provider, because it
addresses a particular provider's API. An override may name a different provider, and the
key for that provider is then read from its own environment variable.

A provider with no model named is reported as not configured, in the same way as one with no
key: neither can make a call, and neither is a reason to refuse to start.

## Cost and observability

Every call records provider, model, purpose, token usage and duration in an `llm_calls`
table. The UI shows usage per day and per job. There is no billing integration and no
attempt to price the tokens, because rates change.

One row per call to the provider, not one per request from a caller: a schema failure and
the retry that follows it are two calls, and both spent tokens. A streamed call is recorded
on the same terms, because a chat turn that made eight of them spent real tokens on all
eight. Each row carries how it
ended, and a schema failure is recorded as its own outcome rather than as a generic error,
because a run of them says the prompt or the schema needs work rather than that the provider
is down.

A day is a local calendar day, resolved by time zone rather than by a single offset. One
offset applied to the whole table is only correct until a daylight-saving change: a call made
at 04:30 UTC in January belongs to the previous day in New York, and a query run the
following July would file it under the wrong one.

Writing a usage row never fails a call. Losing a whole mailbox's classification because the
cost table would not take a row is the wrong trade.

## Non-goals

- Streaming for scheduled jobs. Only chat streams.
- Embeddings, vector search, or retrieval. If a task list needs semantic search later, it
  gets its own spec.
- Automatic provider failover. A failed job fails and retries on schedule.
- Prompt caching in v1. Worth revisiting once the classification prompt stabilises.

## Acceptance criteria

1. The classifier and planner pass their test suites against a fake provider with no
   network access.
2. Each adapter, given the same schema and a recorded provider response, returns the same
   validated structured object.
3. A response that fails schema validation triggers exactly one retry, and a second failure
   surfaces as a job error rather than a partial write.
4. No vendor SDK type appears outside `src/llm/adapters/`.
5. Switching `llm.provider` in config and restarting changes the provider used, with no
   other change.
6. An API key present in config rather than the environment is rejected at startup with a
   clear message.
7. Token usage for every call is recorded, including failed calls that consumed tokens.
