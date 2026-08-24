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
    "timeoutMs": 60000
    // "supportsTools": true     // ollama only, false by default: does this model call tools?
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
table. The UI shows usage per day, per job and per model, and prices it against the
committed table below. There is no billing integration: the figure is Caroline's own
estimate from the tokens it recorded, not a statement of what the provider will invoice.

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

## The spending ceiling

A bound on what Caroline may spend on model calls. It is **configured in currency and enforced
in tokens**, because those are answers to two different questions: currency is the only unit a
person can meaningfully choose, and tokens are the only unit that can be enforced honestly.

```jsonc
{
  "llm": {
    "budget": {
      "currency": "GBP",       // USD | GBP | EUR, one for the install
      "period": "month",       // day | month, one for the install
      "anthropic": 20,         // a positive amount in `currency`, or "unlimited"
      "openai": "unlimited",
      "ollama": "unlimited"
    }
  }
}
```

**Every provider defaults to `unlimited`**, and so does an install with no `llm.budget` block at
all, which is every configuration file in existence today. Nothing about this feature changes what
such an install does, and nothing about it consults a price for a provider nobody has capped.

### The price table

Prices are a table committed to this repository, keyed by provider and model, each entry carrying
its price and the date the vendor's own pricing page was read. Ollama is priced at zero, so the
local provider is never billed by a feature about money. The currencies other than USD are reached
through a committed exchange rate, carrying its own date, and the date shown beside an estimate is
the older of the two: an estimate is only as fresh as its stalest input.

Nothing is fetched, at boot or on a schedule. Four reasons, and they are an argument spec 09's
network posture depends on rather than a preference:

- Neither vendor publishes a pricing API. The de facto sources are third parties, so a fetch does
  not get closer to the authoritative number, it adds a hop.
- A fetch relocates staleness rather than removing it. It fails on an offline or firewalled
  install, so a bundled table is needed anyway, and then two prices are in force and the figure has
  to say which one it used.
- It hands a third party silent control over the number that decides when Caroline stops working.
  An upstream typo becomes a spend incident or a spurious halt with no review step in between. A
  committed table gets the review every other change to this repository gets.
- It is a new outbound call for a number that changes a few times a year.

Updating the table is an ordinary reviewed pull request. A scheduled refresh is a non-goal below.

### What is counted, and against what

The ceiling and the reported estimate are computed differently, on purpose.

**Enforcement** converts the ceiling into a token allowance at config load, and counts tokens
against it. For a provider with a numeric ceiling, the allowance is the number of tokens that
amount would buy at the **output** rate of the **most expensive model configured for that
provider**, across the base settings and every override. Output is the dearer of the two rates and
the dearest configured model is the dearest a call could use, so a token can never cost more than
the allowance priced it at: whatever the mix of input and output turns out to be, the allowance is
a bound on the money and not an estimate of it.

What a ceiling is not is a figure the spend cannot reach. The check refuses once the tokens already
recorded, together with the reservations held for the calls in flight, reach the allowance, so the
call that crosses the line has been made and charged by the
time anything can know it crossed. Reaching the ceiling stops the next call, not the one in
progress, which is the property the issue behind this asked for: "reaching it stops further calls
rather than slowing them". The overshoot is bounded rather than open-ended, at the cost of the
calls that were in flight when the line was crossed, and the reservation described below is what
bounds it.

The conversion also inherits the exchange rate. A ceiling written in GBP or EUR is priced through
the committed rate, so a stale rate moves the enforced ceiling and not only the reported estimate.
That is the same staleness the estimate carries a date for, on a figure the spend view does not
date, and it is a known limit rather than a hidden one.

Tokens are what is counted because they are exact, and because `llm_calls` already holds them. A
row only exists once a call has returned, though, so counting rows alone would let every call
started before the first response lands read the same total and pass. Each call that passes the
check therefore **holds a reservation** for its own estimated cost, taken in the same synchronous
step as the reading and released once the call's own rows are written. Nothing can interleave
between the reading and the reservation, because the runtime is single threaded and `node:sqlite`
is synchronous, so there is no await between them for another call to arrive in. That, rather than
a database transaction, is what stops a classification run with several calls in flight having all
of them pass a check only one should have passed.

The reservation is deliberately generous: the request's own prompt, counted in characters and
converted at a rate that overstates the tokens, plus the output cap the caller asked for, and both
again for the one retry the validate-and-retry rule permits. The prompt is everything the request
puts on the wire and not only its prose: the system prompt, each message's text, the tool calls and
tool results the messages carry, the tool definitions and the output schema. On a chat turn the
tool traffic is the larger part, so leaving it out would undercount by more than the character rate
deliberately overcounts by, and turn a hold meant to overstate into one that understates. Overstating it can only refuse a call
close to the ceiling that would in fact have fitted, which is the safe direction for a guard about
money, and it is reconciled the moment the call's rows are written, so it never affects a call made
after the previous one has finished.

**The reported estimate** prices each recorded call at its own model's own two rates, input and
output separately, which is the more accurate figure and the right one for a number a person
reads. It is shown as an estimate, in the configured currency, with the date its prices were
checked beside it, so the figure is never a bare claim about money. A provider with no ceiling
reads "no ceiling" rather than a blank or a zero, because a decision not to cap and a gap where
nobody configured anything should not look the same.

The window is the current period in `jobs.timezone`, for the reason a usage day is resolved that
way rather than by a fixed offset. `day` and `month` are the two periods offered, because a
calendar day and a calendar month have unambiguous boundaries and a week would need a
start-of-week decision nothing else in the configuration makes.

### Reaching it

Reaching a provider's ceiling stops further calls **to that provider** and nothing else. What
happens then is spec 04 criterion 7's rule, the provider outage, applied to a self-inflicted
outage:

- A scheduled job skips, with a reason naming the provider and the ceiling, recorded in the run
  history it already writes. No partial writes and no unhandled error.
- Chat answers in words that it cannot, in the same shape as chat with no provider configured. An
  MCP tool that would have spent tokens (`regenerate_daily_plan`) refuses with that same reason,
  because the tool registry is shared and the refusal is written once.

### Why `unlimited` is a literal and not `null`

This is the config schema's first `z.union`, and the alternative would have fitted the file's
existing idiom better: `model`, `baseUrl` and `auth.provider.clientId` are all nullable with null a
documented state. It is still wrong here, on the file's own stated principle that absent has to
stay distinguishable from set. Null is what an absent field would default to, so reading null as
unlimited collapses "I have chosen not to cap this" into "I never configured it", and only the
first of those is worth telling anybody about. A literal also survives an environment variable,
where everything arrives as a string.

The rules that stop a mistake reading as unlimited follow from the same concern:

- `0` is rejected. It is ambiguous between no cap and no spending, and `provider: "none"` already
  says the second one properly.
- Negatives and non-finite values are rejected, and an unrecognised string fails config load, the
  way a malformed content policy refuses to start rather than falling back to a default.
- A model missing from the price table is a start-up error **only** where that provider has a
  numeric ceiling. Where it is `unlimited` the table is never consulted for it, so a stale or
  incomplete table cannot break an install that has not asked for a cap.

## Non-goals

- Streaming for scheduled jobs. Only chat streams.
- Embeddings, vector search, or retrieval. If a task list needs semantic search later, it
  gets its own spec.
- Automatic provider failover. A failed job fails and retries on schedule.
- Prompt caching in v1. Worth revisiting once the classification prompt stabilises.
- Fetching prices, at boot or on a schedule. Argued above: it converts a reviewed number into an
  unreviewed one. If the committed table turns out to be a burden in practice, that is a separate
  issue and a separate decision.
- A billing integration, or any reconciliation against what a provider actually invoiced. The
  estimate is built from the tokens Caroline recorded and says so.
- Per-job or per-purpose ceilings. The ceiling is per provider, which is the granularity at which
  the money is actually spent.

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

The spending ceiling adds the following, appended rather than renumbered because criterion numbers
are cited by the code and the suite.

8. A configuration with no `llm.budget` block, and one whose block names no entry for a provider,
   leave that provider unlimited: no call is refused, and no price is looked up for it. Asserted on
   the loaded configuration and on a call made against a model the price table does not carry.
9. A model absent from the price table is a start-up error naming the provider, the model and the
   key that asked for the cap, and only where that provider's ceiling is a number. With the ceiling
   `unlimited` the same configuration starts.
10. `0`, a negative amount, a non-finite amount and any string other than `unlimited` are each
    refused at config load with the offending key named. `unlimited` is the only string accepted.
11. Once a provider's recorded tokens for the current period, together with the reservations held
    for its calls in flight, reach its allowance, further calls for that provider are refused
    before anything reaches the network, and a call to a different provider under its own ceiling
    still goes through.
12. A call that passes the check holds a reservation for its own estimated cost until its usage
    rows are written, and the reading, the comparison and the reservation are taken in one
    synchronous step with no await between them. Calls in flight together therefore cannot each
    pass a check only one of them should have passed: asserted by driving several concurrent calls
    through the runtime against a headroom that admits one, and observing that exactly one reaches
    the provider and records a row. A reservation is released on every exit path, including a
    provider error, so a failed call consumes no allowance beyond what it actually spent.
13. A scheduled job that cannot call its provider because the ceiling is reached is recorded as
    skipped, with a reason naming the provider, in the run history, leaving no partial write and
    raising no unhandled error. Spec 04 criterion 7's rule for a provider outage, applied to this
    one. Asserted for the classifier and for the planner.
14. Chat, and the MCP tool that would have spent tokens, answer with the reason rather than
    failing, in the same shape as chat with no provider configured. Asserted once, because one
    registry serves both surfaces.
15. Spend is reported by day, by purpose and by model, in the configured currency, labelled an
    estimate and carrying the date its prices were checked, which is the older of the model price's
    date and the exchange rate's. A provider with no ceiling reports "no ceiling" rather than a
    blank or a zero.
