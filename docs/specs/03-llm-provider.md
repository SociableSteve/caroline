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
  but OpenAI rejects the whole request when a schema does not meet its rules (every object
  closed, every declared property required) rather than relaxing. Rather than rewrite a
  schema to fit, which would change what was asked for, the adapter turns strict mode on for
  the schemas that already qualify and sends the rest unstrict. Shared validation has the
  final say either way.
- **Ollama**: `format` set to the JSON schema, which recent Ollama versions support; falls
  back to `format: 'json'` plus schema-in-prompt for older servers.

The result is validated against the schema in shared code, not in the adapter. A
validation failure retries once with the validation error appended, then fails the job with
a recorded error. Callers never receive unvalidated output.

## Tool use

Only chat (spec 07) uses tools. The adapter translates the shared `ToolDefinition` shape to
the provider's format and normalises tool calls back. Ollama tool support varies by model,
so the chat surface degrades gracefully: if the configured model cannot call tools, chat
answers questions but reports that it cannot make changes, rather than hallucinating that
it did.

## Configuration

```jsonc
{
  "llm": {
    "provider": "anthropic",
    "model": "claude-sonnet-5",
    "baseUrl": null,              // override for proxies or self-hosted gateways
    "maxTokens": 4096,
    "timeoutMs": 60000
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
the retry that follows it are two calls, and both spent tokens. Each row carries how it
ended, and a schema failure is recorded as its own outcome rather than as a generic error,
because a run of them says the prompt or the schema needs work rather than that the provider
is down. A day is a local calendar day, not a UTC one.

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
