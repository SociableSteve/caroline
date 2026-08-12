# 12. MCP server

## Purpose

Spec 07 built fourteen tools over Caroline's domain, with the content policy, an audit trail
and an undo behind every one of them. Exactly one thing may call them: the model Caroline
itself configures, through a rail in a browser. Anything an assistant working on the user's
behalf might do to the board, it has to do by being that model.

This spec gives the registry a second caller. An assistant the user already works in captures
a task without their leaving what they are doing, and processes what is already there. Reviews
are the case that motivates it: a pull request in Review carries its URL, its size estimate
and its place in the GitHub connector's state machine, so an assistant that can read the pull
request can read the queue and discharge the user's part of it through the same
`mark_reviewed` the board's button calls, with the same attribution to `sync` and the same
undo that puts the connector's state machine back as well as the task.

The registry is shared rather than copied. A second tool surface would mean two answers to
every content-policy question, two audit trails and two undo implementations, and spec 09's
rule that a level is a property of the boundary rather than of a route through it would be
unenforceable across them.

## Shape

One endpoint in the process Caroline already runs, speaking streamable HTTP on the port
Fastify already listens on, off unless turned on, and loopback only. Same process means one
database handle and one change feed, so a task an assistant creates appears on an open board
without a refresh.

Not stdio, despite stdio being the safer shape: authorisation does not apply to it at all and
nothing is reachable over a port that does not exist. It would mean a second process against
the same SQLite file, which is workable with WAL but means two writers, a scheduler that must
not run twice, and a change feed the running UI never hears about. A task captured by an
assistant would not appear on the open board, which is most of what makes this feel like part
of the application rather than a script.

Not a routable bind. Every other decision here changes with it: TLS stops being moot, rate
limiting and lockout start to matter, and spec 09's paragraph about filesystem permissions
being the boundary stops being defensible. If the endpoint should be reachable from another
machine, the honest answer is a tunnel the user already trusts, terminating on loopback.
Caroline should not be the component that decides it is safe to be on a network. The
authorisation server below does not soften that: it makes the loopback endpoint better
attested, it does not make a routable one sensible, and "we have OAuth now" is exactly the
argument that would otherwise be used later to open the bind.

**The protocol revision implemented is `2026-07-28`**, published as a release candidate on
2026-05-21 and stable since 2026-07-28. It is named here, and asserted by a test, so that
moving to a later revision is a decision somebody makes rather than a drift somebody
discovers. It is a large breaking revision and four of its changes shape this spec.

- **Authorisation is a full OAuth 2.1 story or it is nothing.** See the next section.
- **Protocol sessions are gone.** There is no `initialize`, no `notifications/initialized`, no
  `Mcp-Session-Id`, no GET event stream and no `Last-Event-ID` resumability. Caroline
  therefore derives a session of its own, and says so below.
- **Every request carries its own framing.** The protocol version and the client's
  capabilities travel in `_meta` on each request and the client's identity SHOULD travel
  there too; the `MCP-Protocol-Version` header is required and must agree with the body, or
  the server answers `400` with `HeaderMismatch` (`-32020`); `Mcp-Method` is required on every
  request and `Mcp-Name` on `tools/call`; and `server/discover` is a mandatory RPC.
- **Servers no longer send requests to clients.** Sampling, elicitation and roots come back as
  a result the client answers by retrying the original call, and sampling, roots and logging
  are deprecated. Caroline uses none of them, for reasons given under Confirmation.

The deprecated HTTP+SSE transport is not supported.

## Authorisation

The choice here is binary, and that finding is what settled the design rather than any
preference about ceremony. A protected MCP server acts as an OAuth 2.1 resource server.
Offering authorisation at all is optional, but once offered, protected resource metadata
(RFC 9728) MUST name at least one authorisation server, and a conformant client MUST refuse to
proceed when that server's metadata does not advertise `code_challenge_methods_supported`. So
there is no half of OAuth to adopt: a static token behind published metadata describing an
authorisation server that does not exist is not a shortcut, it is a claim a conformant client
catches. Either Caroline runs a real OAuth 2.1 authorisation server with PKCE, or it does not
claim OAuth. **Caroline runs the authorisation server.**

Delegating to Google was considered and is rejected. Caroline is already a Google OAuth
client, but that client is a desktop client with read-only Gmail and Calendar scopes: it
authenticates Caroline to Google, not a caller to Caroline. Using Google here would mean
tokens whose audience is a Google client rather than Caroline, a second client configuration
and consent screen in the setup guide, and a local tool that will not answer a local request
while Google is unreachable. It also puts a third party in charge of access to a database it
has no part in, against spec 00's principle that nothing leaves the machine unless configured
to.

Caroline takes both roles, in process.

**As resource server:** protected resource metadata served at the well-known path, naming
Caroline's canonical resource URI and its authorisation server; `401` with a
`WWW-Authenticate: Bearer` challenge naming that document; audience validation of every token
against the canonical resource URI; refusal of any token Caroline did not issue; and no token
Caroline receives ever forwarded anywhere, which the protocol forbids in as many words.

**As authorisation server:** an authorisation endpoint whose consent screen is on Caroline's
own Settings surface, a token endpoint, PKCE with `S256` mandatory, single-use authorisation
codes, refresh, RFC 8414 metadata advertising `code_challenge_methods_supported` and
`client_id_metadata_document_supported: true`, `iss` in the authorisation response with
`authorization_response_iss_parameter_supported: true`, and port-agnostic matching of loopback
redirect URIs so that a native client's ephemeral callback port works. That last one is not a
courtesy: a native client runs the flow itself over a loopback redirect on a port it picks per
run, and declares `http://localhost/callback` and `http://127.0.0.1/callback` in its own
metadata, so a server matching the port exactly would refuse every client of that shape.

Tokens Caroline issues are runtime secrets and register as such through the mechanism Google's
tokens already use, access tokens as rotating and refresh tokens as lasting, so spec 09's
guarantee that no secret appears in a log line or a response body covers values that arrive
after startup without a second mechanism being invented for them.

### What is deliberately not built

**Dynamic client registration (RFC 7591).** This revision deprecates it, retaining it only for
backwards compatibility, and replaces it with client identifiers that are URLs: the client
publishes an `https` metadata document and the authorisation server fetches and validates it
(CIMD). For once the specification's own advice and the objection coincide. An unauthenticated
endpoint that takes JSON in and hands a credential-bearing record back, on a single-user tool,
is the wrong trade whatever the specification permits. This is a decision with a reason, not
an omission: a reader who finds no registration endpoint has found the intended state.

The practical consequence is that no client id has to be configured by hand. A client selects
the metadata-document route when the authorisation server advertises
`client_id_metadata_document_supported: true` together with `none` in
`token_endpoint_auth_methods_supported`, and falls back to dynamic registration only when it
does not. Caroline advertises exactly that, so the fallback never fires.

### What a client that cannot do OAuth 2.1 gets

Nothing. There is no static token, no header credential and no setting for one.

The milestone's history contains one, and this section says so, so that nobody goes looking
for the setting. Slice 2 accepted a bearer credential of the endpoint's own. It was
scaffolding: it existed so the tool surface could be built and proved before the authorisation
server was in the picture, which is what keeps a fault in one from being mistaken for a fault
in the other. Slice 3 removed it, its setting included rather than left as a dead key, and
because the configuration schema is strict throughout, a configuration file still setting it
fails at startup naming the key. There is no three-way authorisation setting and no rule about
which credential wins, because at no point in the milestone's history were there two.

## Which credential is which

The two are easily conflated, so they are named apart here and everywhere below.

| | What it protects | Where it is stated |
| --- | --- | --- |
| `server.accessToken` | The existing HTTP API and the SPA that uses it, on every route | Spec 09 |
| Tokens Caroline issues through the flow above | The MCP endpoint only | This spec |

Neither substitutes for the other. `server.accessToken` has been a startup precondition since
M0 and was never checked against a request, which is a defect spec 09 now states plainly and
M15's first slice fixes; the fix is described there and in spec 09 rather than here, because
the API's credential is not this surface's. Removing the MCP bearer credential in slice 3 did
nothing to it.

## The client metadata document fetch

Client identifiers that are URLs work by the authorisation server fetching the client's
metadata document over `https` and validating it. So Caroline's authorisation server makes an
outbound request to a URL supplied by whatever is trying to connect, and that is a server-side
request forgery surface. It is the one place this surface makes Caroline's posture worse rather
than better, and it does so because of the choice to be conformant, so it gets a section rather
than a clause.

Spec 09's outbound rule today limits destinations to the configured providers: GitHub, Google
and the configured LLM endpoint. All three are destinations **the user** chose, by making a
token, walking a consent screen, or naming an endpoint in a file. A client metadata document is
**the first outbound destination a caller chooses**, which is a different kind of entry in the
same list. Spec 09's amended rule says so in those words rather than adding a fourth line to a
list, because a future reader must not be able to treat the next caller-chosen destination as
precedented by this one. Anything of the same kind has to make the argument again from scratch.

The guards, each of which is a criterion below rather than prose:

- `https` only. No `http`, in any spelling.
- Public addresses only: not loopback, not link-local, not RFC 1918, not unique-local, and not
  the IPv4-mapped forms of any of them.
- **Resolve, then check, then connect to the resolved address.** Checking the hostname and then
  handing the URL to a fetch would let a DNS answer smuggle a private address past the guard,
  and re-resolving after the check reopens the same hole. This is the guard most easily
  implemented wrongly, which is why it is its own criterion.
- A response size cap, enforced while the body is read rather than after it has been read.
- A time cap on the whole fetch.
- No redirect followed to a different host.
- Only during an authorisation request a person is at the keyboard for. None on a schedule,
  none at startup, none from a token request.

## Network posture

- Loopback only, enforced at startup: a configuration that enables MCP with `server.host` set
  to anything else fails, naming both settings, in the same shape as the existing full-content
  guard. A tool whose documented posture is that the bind address is the boundary does not get
  to become a service by way of a config key.
- Off by default.
- `Origin` is validated where it is present, and a request naming a host Caroline did not
  expect is answered `403` before any tool runs. `Host` is validated against DNS rebinding.
  Loopback is not a boundary against other software on the machine, and a page in the user's
  own browser can be made to POST to `127.0.0.1`, which is why the protocol requires both
  checks. What such a page cannot do is read the answer or obtain a token, which is what the
  credential is for.

## The session, which the protocol no longer has

Revision `2026-07-28` deleted sessions from the protocol. There is no handshake and no session
identifier to key anything on. **The session below is Caroline's own rule and not the
protocol's**, stated so that a reader in two years does not assume it was inherited and go
looking for the clause that mandates it.

**A session is a conversation.** `executeTool` writes a change record keyed to a message, which
is keyed to a conversation, so an MCP write needs both rows anyway. That is a feature rather
than a cost: the writes appear in the conversation list, render with their change records, and
are undoable by the code that already does it. What it needs is a way to tell the two kinds
apart, so `chat_conversations` carries the source that says which it was and the name of the
client that was talking, and spec 08's conversation list labels it.

**How one is derived.** The client's declared name, from the `clientInfo` the protocol says a
request SHOULD carry, plus an idle window: calls from one client continue one conversation
while they keep arriving inside the window, and a call after a longer gap starts a new one. The
window is thirty minutes by default and configurable. Thirty minutes is a number rather than a
principle; what matters is that it is written down and can be changed.

A request declaring no client name is attributed to an unnamed client rather than refused,
because the field is a SHOULD and refusing a conformant request would be Caroline inventing a
requirement. The honest consequence is weaker attribution for such a client than the audit
records otherwise imply, and that is a property of a stateless protocol rather than something
to work around.

**A turn is the run of writes between one confirmation decision and the next.** The bulk
threshold counts distinct tasks changed within a turn and undo covers the last turn that
changed anything, so a conversation that lasts all day needs a turn to mean something. Two
answers are wrong. A turn per tool call means the gate can never fire and undo covers one
operation. A turn per session means the gate fires once and then holds everything for the rest
of the day. So the first write opens a turn, the turn accumulates until the gate trips, and
once the user has confirmed or rejected, the next write opens a new turn and the count starts
again. The gate then means over MCP what it means in chat: ten tasks may change before a person
looks at the screen, and an agent working unattended cannot get past that without a human
touching Caroline's own UI. Undo stays "the last turn of this conversation", unchanged.

## Tools

The registry is spec 07's, by reference rather than restated, reached through the same
`executeTool`, so the content policy, the change records, the confirmation gate and undo apply
without being written twice. `tools/list` answers with the same JSON Schema object
`executeTool` validates against, rather than a copy of it that could drift.

Two differences from what chat sees.

- **One addition, `list_reviews`.** Getting the review queue otherwise means
  `search_tasks(status: 'review')` and then a `get_task` per row for the pull request URL, the
  size estimate and the lifecycle position: N+1 calls to answer the first question a
  review-processing agent asks. `list_reviews(includeWaiting?)` answers it in one, optionally
  with the waiting side too, which is the "you reviewed it and nothing has happened since"
  list. It goes in the shared registry rather than an MCP-only list, so chat gains it as well,
  which it arguably should have had for the chase conversation `list_waiting` was written for.
- **One substitution, `get_overview`.** Chat sends the day's context unasked on every message,
  and Caroline does not own an external client's system prompt, so there is nowhere for it to
  go. It becomes a tool the client may call, returning the object the prompt assembles today.

Annotations are derived from the registry rather than written per tool: a read tool is
`readOnlyHint: true`, a write tool is not, `delete_task` is the only `destructiveHint: true`,
and `complete_task` and `mark_reviewed` are `idempotentHint: true`. `destructiveHint` defaults
to true when `readOnlyHint` is false, so saying nothing would advertise every write as
destructive and invite a confirmation prompt on `create_task`. Deriving them means a tool added
later cannot be annotated wrongly by omission.

## Confirmation, and where the human is

A held operation answers the client with what is waiting and where it is decided, and says
plainly that nothing happened, so a model does not report a change it did not make. The
decision happens on Caroline's own screen.

**Elicitation is not used for it**, and the reason is spec 09's rather than a preference. The
protocol offers a way to ask the user a question through their own client's interface, which
looks like the obvious way to confirm a delete. Spec 09's existing rule is that a confirmation
is not a send boundary precisely because it is rendered on the user's own screen from their own
database, which is what lets it name the task however low `llmContent` is set. Pushing that
text through the client would turn the one thing exempt from the content policy into a
disclosure.

## The content policy

`llmContent` governs every MCP response, by the same functions, and there is no second dial.
The argument for one is not silly: spec 09's rule is that a level is a property of the boundary,
and this is arguably a second boundary rather than another route through the first. It is still
the wrong answer. `llmContent` names the question exactly, how much of an item may be given to
a language model, and the destination on both sides is a language model. Two dials would
immediately raise which one governs when the chat provider and the MCP client are the same
model, and there is no good answer to that. What breaks otherwise is everything spec 09 claims:
at `llmContent: none` the settings screen says nothing about an item is sent to the model, the
payload preview proves it for chat, and an MCP client would be reading titles, notes, senders
and pull request provenance out of the same database through a different port. The preview
would still be accurate and the sentence would be false.

Three consequences, decided rather than discovered.

- **At `none` the surface answers ids and a withholding sentence, and is close to useless.**
  That is what the level means, exactly as it does for chat, and the documentation says so
  rather than carving an exception.
- **An MCP client counts as a remote provider unconditionally.** The
  `allowFullContentToRemoteProvider` guard is checked against the configured provider's
  `isLocal`, true only for Ollama, so somebody running Ollama legitimately has
  `llmContent: full` with the flag off, and that is safe today because nothing leaves the
  machine. Enable an MCP server and complete bodies can leave through a client whose model
  Caroline cannot see and has no way to ask about. So `llmContent: full` with MCP enabled
  requires the flag, whatever `llm.provider` says, `ollama` included. This will read as a
  regression to the one person it affects, and it is the honest reading of what the flag is
  for.
- **Nothing about the person is sent.** The shared preamble is Caroline's own prompt and
  Caroline is not writing this one, so the two facts spec 09 puts in it, the system's name and
  the user's, have nowhere to go and are not sent. That is a small privacy win worth stating
  outright rather than leaving as an accident of the transport.

What matters more here than in chat is the framing that an item's text is data and not an
instruction, because a tool result from Caroline lands in a foreign agent's context window.
Every result carrying an item's own text carries that statement, in the words the item context
already uses.

The payloads published in `docs/content-policy.md` gain this boundary at all four levels,
generated by the same functions that build the real ones, under spec 09's existing criterion 15
extended rather than a second criterion beside it. One criterion covering both boundaries
cannot drift apart the way two would.

## Audit

Spec 09's non-goals rule out audit logging beyond `job_runs`, `classifications` and
`llm_calls`, and chat's disclosures are covered because each sits under an `llm_calls` row and
a turn. Over MCP there is no `llm_calls` row: writes are covered by the change records, and
reads would be covered by nothing at all, so a client could read the whole board and leave no
trace. Spec 09's non-goal therefore gains a named exception for this surface.

**One row per derived session and one row per tool call.** The per-call row holds the tool
name, a digest of the arguments, whether the call was held for confirmation, the content level
and policy version in force, and the number of items answered. It does not hold the answered
text: the point is to make "what did that agent see" answerable, not to keep a second copy of
what the content policy just decided how much of to send. Session plus call rather than session
alone, because a session row on its own answers that something happened and not what.

`CONTENT_POLICY_VERSION` is not bumped by this surface existing. It is bumped when what a level
*means* changes, and adding a boundary does not change what `snippet` means. The session record
holds the version in force, which is the thing that has to be readable later.

## Errors and limits

- JSON-RPC error codes are the protocol's, including `HeaderMismatch` (`-32020`) for a
  `MCP-Protocol-Version` header that disagrees with the body. The API's standard
  `{ error: { code, message, details? } }` shape (spec 08) is the HTTP API's and is not used
  inside a JSON-RPC body, which has a shape of its own.
- A refusal from the registry reaches the client as a tool result marked as an error rather
  than as a protocol error, because a tool that declined to do something is a tool that
  answered. A held operation is one of those.
- **Chat's tool-call cap does not apply here, and is not faked.** `chat.maxToolCalls` bounds a
  model's loop within one turn to bound Caroline's cost. Over MCP the model and the cost are
  the client's, and a cap Caroline cannot connect to a bill it pays is a number with no
  argument behind it. The confirmation gate is the protection that matters on this surface, and
  `docs/using.md` says which caller the budget is about.
- Every tool answers in one step. There is no progress reporting and no long-running task.

## Non-goals

- No tool that reaches GitHub, Gmail or Calendar. Spec 07 criterion 2 holds across both
  callers, and the registry test that asserts it by inspecting what the tool modules import is
  the enforcement for this surface too. A client that wants a diff has its own GitHub access.
- No tool that posts a review or writes anything back to an external system, per spec 00's
  read-only ingestion principle.
- No dynamic client registration, for the reasons above.
- No credential other than a token Caroline issued. A client that cannot run an authorisation
  code flow with PKCE cannot connect. This locks out anything that connected during slice 2,
  which is the deliberate consequence of the decision rather than an oversight.
- No multi-client identity and no scopes. One user, one approval. A second caller is not
  distinguishable from the first in any way that grants it different access, and a scope that
  cannot be refused is decoration.
- No non-loopback operation, no TLS termination, no rate limiting, no lockout.
- No elicitation, no sampling, no roots. Sampling and roots are deprecated in this revision in
  any case; elicitation is refused for the reason under Confirmation.
- No MCP prompts and no resources. Everything is a tool, so one policy and one gate cover the
  surface.
- No support for the deprecated HTTP+SSE transport.
- No second content policy, and no MCP-only exemption from the first.
- **No screenshot of the client approval screen.** The two visible surfaces this spec adds are
  the conversation list's label and that screen; both are described in prose. Spec 11's rule is
  that every published image is in the shot list, exists in both palettes and is shown by some
  document, and the seeded demonstration day has no MCP client in it, so a shot would mean
  seeding an approval purely to photograph it. Recorded as a decision so that it is cheap to
  reverse deliberately rather than discovered at the end.

## Implementation notes that are decisions

- **Slice 2 uses the MCP TypeScript SDK's resource-server package with its Fastify middleware;
  slice 3 is Caroline's own code.** The SDK ships the bearer verification, the protected
  resource metadata, and the `Origin` and `Host` helpers, and this revision's required headers,
  error codes and `server/discover` are precisely what a hand roll gets wrong. The
  authorisation server half lives in a package named for legacy support, and the consent screen
  belongs on the Settings surface, so slice 3 is written here instead. Caroline's dependency
  list is short and this adds to it, which is the cost being accepted.
- **The endpoint is served under `/api`; only the well-known metadata documents are not.** Spec
  08 owns that exception and names it, because the discovery order a client follows requires
  them at the root.

## Acceptance criteria

Numbered by slice. Criteria 5 to 8 concern slice 2's scaffolding credential and are superseded
by criterion 32: they assert that it behaved while it existed, not that it will exist.

**Slice 1: the API's credential check.** Spec 09 owns the posture; these are its tests.

1. With `server.accessToken` configured, a request to any route in the process that does not
   present it is refused, and every route behaves identically in that respect, asserted over
   the registered route list rather than route by route.
2. With `server.accessToken` configured, a request presenting it is answered normally, and the
   comparison of the presented value against the configured one takes time independent of how
   much of it matches.
3. With no `server.accessToken` configured, no request is refused for want of one, so a
   loopback install with no token behaves exactly as it did before this milestone.
4. The browser reaches the change feed and the streamed chat turn under a configured token, and
   the token appears in no log line and in no response body, which is spec 09 criterion 6
   applied to however it is carried.

**Slice 2: the surface.**

5. With MCP disabled, no MCP endpoint and no metadata document is registered at all, asserted
   over the registered routes rather than by requesting one.
6. With MCP enabled and `server.host` not loopback, startup fails with a message naming both
   settings.
7. With MCP enabled and no MCP credential available, startup fails whatever the bind address:
   loopback is not a substitute for the credential on this surface.
8. A request with no credential is answered `401` with a `WWW-Authenticate: Bearer` header, and
   one bearing a credential that is not accepted is answered `401`.
9. A request whose `Origin` header is present and names a host Caroline did not expect is
   answered `403` before any tool runs, and one whose `Host` header does not name a loopback
   name is refused.
10. A request whose `MCP-Protocol-Version` header disagrees with the protocol version in its
    body is answered `400` with the protocol's `HeaderMismatch` code, and a request omitting the
    required `Mcp-Method` header is refused.
11. `server/discover` and `tools/list` answer without a tool being run, and `tools/list` returns
    exactly the tools of spec 07's registry plus `list_reviews`, each carrying the same JSON
    Schema object `executeTool` validates against rather than a copy of it.
12. Every tool's annotations are derived from the registry: a read tool is `readOnlyHint: true`,
    a write tool is not, `delete_task` is the only `destructiveHint: true`, and `complete_task`
    and `mark_reviewed` are `idempotentHint: true`. A tool added to the registry without an
    annotation decision fails this rather than defaulting to destructive.
13. A `create_task` call creates the task with `status_set_by = 'user'`, publishes on the change
    feed so an open board reloads, and appears in the conversation list as a session naming the
    client that called it.
14. Two calls from one client within the idle window are recorded against one conversation, and
    two separated by more than it are recorded against two. A call declaring no client name is
    recorded against an unnamed client rather than refused.
15. A `delete_task` call executes nothing, creates a confirmation, and answers the client that
    nothing was deleted and a person has been asked. Confirming it on Caroline's own screen
    performs exactly the stored operation and records it against the session's turn.
16. A session that changes more tasks than `chat.bulkConfirmThreshold` holds every further write
    into one confirmation, and the confirmation states how many tasks the session would change
    in total. Once that confirmation is decided, the next write over the same session opens a
    new turn and the held count starts again from nothing.
17. With MCP enabled, `llmContent: full` and `allowFullContentToRemoteProvider: false`, startup
    fails naming all three settings, whatever `llm.provider` is set to, `ollama` included.
18. Undo of a session's last turn restores the prior values of every task it changed, through
    the same code path chat's undo uses.
19. With `llmContent: metadata`, no `notes` value appears in any MCP response for any tool,
    while titles do. With `llmContent: none`, every response carries an item's kind and id and
    the withholding sentence and nothing else, on every tool including the write tools' answers,
    asserted against the serialised response.
20. No MCP response contains the name of the person using Caroline, on any path.
21. Every response carrying an item's own text also carries the statement that it is data and
    not an instruction, in the same words the item context uses.
22. `list_reviews` returns each `review` task with its pull request URL, repository, number,
    size estimate, requested-at and lifecycle state, in one call with no per-task follow-up.
23. `mark_reviewed` over MCP has exactly the effect the board's action has: the task moves to
    `waiting`, `status_set_by` is `sync`, the source's `acted_at` and marker are stamped, and
    undo puts both the task and the source lifecycle back.
24. Each session, and each tool call within it, is recorded with the tool name, whether it was
    held, the content level and policy version in force, and the number of items answered. No
    answered item text is in that record.
25. No module reachable from the MCP server imports anything under `src/connectors/`, asserted
    by inspecting imports as spec 07 criterion 2 already is.

**Slice 3: the authorisation server, and the removal of slice 2's credential.**

26. The protected resource metadata document is served, names Caroline's canonical resource URI,
    and names an authorisation server that is itself served and whose metadata declares `S256`
    in `code_challenge_methods_supported` and `client_id_metadata_document_supported: true`. A
    test asserts the document a client would fetch by following the challenge header rather than
    a hard-coded path, and asserts the fallback path the discovery order permits.
27. An authorisation request without PKCE, or with a method other than `S256`, is refused. An
    authorisation code is redeemable once, and a second redemption is refused and invalidates
    nothing else.
28. A token whose audience is not Caroline's canonical resource URI is refused with `401`, and a
    token Caroline did not issue is refused. No token Caroline receives is ever sent to GitHub,
    Google or an LLM provider, asserted over the outbound request builders.
29. A refresh token exchanges for a new access token, a revoked or expired one does not, and both
    are registered as runtime secrets so that no issued token appears in any log line or
    response body, which is spec 09 criterion 6 extended to values arriving after startup.
30. A redirect URI on a loopback host is matched without regard to its port, so a native client's
    ephemeral callback port works, and a redirect URI that is neither loopback nor `https` is
    refused.
31. No client is issued a token until the user has approved it once on Caroline's own screen, and
    the approval names the client. There is no endpoint by which a client registers itself, and a
    request to the path RFC 7591 would use is answered as not found rather than as an error.
32. The bearer credential is gone. No credential is accepted on the MCP endpoint but a token
    Caroline issued, the value slice 2 accepted is refused, and a configuration file still
    carrying slice 2's setting fails at startup naming that key rather than being ignored.
33. `server.accessToken` still governs every other route exactly as slice 1 left it, and removing
    the MCP bearer credential changes nothing about it. Asserted, because the two credentials are
    easily conflated and this is the assertion that says they were not.
34. A client metadata document is fetched only over `https`. An `http` URL is refused, in any
    spelling.
35. The address a client metadata URL resolves to is checked before anything connects to it, and
    the connection is made to that checked address, so a name resolving to a loopback,
    link-local, RFC 1918 or unique-local address is refused and a second resolution cannot
    substitute one. Asserted for each of those ranges and for their IPv4-mapped forms.
36. A client metadata response larger than the cap is refused while it is being read rather than
    after, and one that has not completed within the time cap is abandoned.
37. A redirect to a different host is not followed, and the fetch is refused rather than retried.
38. No client metadata fetch happens outside an authorisation request a person is present for:
    none at startup, none on a schedule, and none during a token request. Asserted by driving the
    other paths and observing no outbound attempt.
39. The only outbound destinations the process attempts are the configured providers and a client
    metadata URL during an authorisation request, asserted over the whole process rather than
    over this module, so that a later addition cannot slip in beside it.
40. The protocol revision this surface implements is named in this spec and asserted against what
    the server advertises, so that moving to a later revision is a change somebody makes rather
    than a drift somebody finds.
