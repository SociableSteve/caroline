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
  request and `Mcp-Name` on `tools/call`, enforced strictly when a client sends them but not
  used to refuse a client that omits them (see "Header interoperability" below); and
  `server/discover` is a mandatory RPC.
- **Servers no longer send requests to clients.** Sampling, elicitation and roots come back as
  a result the client answers by retrying the original call, and sampling, roots and logging
  are deprecated. Caroline uses none of them, for reasons given under Confirmation.

The deprecated HTTP+SSE transport is not supported.

## Authorisation

The choice here is binary, and that finding is what settled the design rather than any
preference about ceremony. A protected MCP server acts as an OAuth 2.1 resource server.
Offering authorisation at all is optional, but once offered, the protected resource metadata
document MUST include `authorization_servers` naming at least one authorisation server, and a
conformant client MUST refuse to proceed when that server's metadata does not advertise
`code_challenge_methods_supported`. That first MUST is MCP's own, from its profile of RFC 9728
rather than from RFC 9728, where `authorization_servers` is OPTIONAL: the protocol requires an
MCP server to implement RFC 9728 and then requires the field the RFC leaves optional. It is
attributed here because a reader checking the RFC will not find it there. So there is no half of
OAuth to adopt: a static token behind published metadata describing an authorisation server that
does not exist is not a shortcut, it is a claim a conformant client catches. Either Caroline runs
a real OAuth 2.1 authorisation server with PKCE, or it does not claim OAuth. **Caroline runs the
authorisation server.**

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

### The one knowing deviation: both identifiers are `http`

Caroline's loopback bind and this conformance argument are in direct tension, and the tension is
stated here rather than discovered by whoever implements criterion 26.

Two identifiers are constrained to `https` by the documents this design leans on. RFC 8414
section 2 defines the authorisation server's `issuer` as a URL that uses the `https` scheme. RFC
9728 section 1.2 defines the protected resource's resource identifier the same way, a URL using
the `https` scheme with no fragment, and MCP's canonical server URI is that identifier: every
example the protocol gives of a valid one is `https`. Caroline listens on loopback `http` by a
decision the Shape section refuses to reopen, so both identifiers are
`http://127.0.0.1:<port>`, and both are therefore non-conformant. Neither the protocol nor either
RFC carves out an exception for loopback, and this spec does not pretend one exists.

RFC 8252 is the nearest sanctioned exception and it does not reach. Sections 7.3 and 8.3 permit
the `http` scheme for a native application's loopback **redirect URI**, on the reasoning that the
request never leaves the device, and that is exactly what the port-agnostic redirect matching
above relies on: a client's `http://127.0.0.1:<ephemeral>/callback` is conformant, and Caroline
accepting it is not a deviation. RFC 8252 says nothing about issuer identifiers or resource
identifiers, so it sanctions the redirect and not these two.

So the design is conformant in every respect except the scheme of those two identifiers, and that
one is a deliberate local-only deviation with a consequence that is not argued away: **a client
that validates the scheme of an issuer or a resource identifier will refuse to connect to
Caroline, and there is nothing Caroline can do about it that is worth doing.** A self-signed
certificate on loopback trades a scheme check for a trust-store problem on every client and makes
the setup guide worse; a real certificate needs a name Caroline does not have; and the tunnel
argument in the Shape section is the answer for anybody who needs a `https` origin, because a
tunnel terminating on loopback gives the client the `https` identifier it wants without Caroline
deciding it is safe to be on a network. What Caroline owes the client instead is internal
consistency, which is a real conformance requirement and is criterion 42: the `issuer` in the
authorisation server metadata is byte-identical to the identifier the well-known URL was built
from, which is what a client is required to check, and the `resource` in the protected resource
metadata is the endpoint's own origin and path.

### Header interoperability: `Mcp-Method` and `Mcp-Name` are enforced only when present

The revision requires `Mcp-Method` on every request and `Mcp-Name` on `tools/call`,
`resources/read` and `prompts/get`, and Caroline's route validates both, strictly, when they
arrive. It does not refuse a request for lacking them.

The reason is the same kind of practicality this spec already names for the loopback scheme:
a rule that is correct on paper and refuses the client that actually exists is not a rule worth
enforcing to the letter yet. Claude Code, confirmed on 2.1.233 against a running instance of
this server on 2026-08-17, authenticates successfully against the authorisation server above
and then sends an `initialize` request carrying neither header at all: its MCP client (the
`@modelcontextprotocol/sdk`-derived `StreamableHTTPClientTransport` it ships) predates SEP-2243
and Anthropic's own announcement of the revision says only that support is "rolling out soon,"
with no committed version. Refusing that request outright with `400` (`invalidRequest`) is
correct by the letter of the revision and useless in practice: it means the primary real-world
client this server needs to work with today can never get past its first request, for a gap
that is the client's to close, not a defect in the request it sent.

So the check is asymmetric by design, not by oversight. A header that disagrees with the
request body is still a `400`: a client claiming to speak `tools/list` in `Mcp-Method` while
its body says `tools/call` is sending a malformed request regardless of whether it implements
the header at all, and that case is unchanged. A header that is simply absent is read as "this
client has not implemented this part of revision 2026-07-28 yet," and the request proceeds as
if the check did not apply, exactly as a server tolerates an older client on a feature the
client never adopted. `MCP-Protocol-Version` already worked this way without any change:
`HeaderMismatch` only fires on disagreement, never on absence, so an older or missing protocol
version string was never a problem here.

This is a temporary interoperability accommodation, not a retraction of criterion 10, and it
should be revisited once client-ecosystem support for `Mcp-Method` and `Mcp-Name` is no longer
the exception. When that day comes, the fix is to delete the `!== undefined` guards in
`src/mcp/route.ts` and restore the strict-by-default check, which is exactly what a compliant
client should have been getting all along.

### Handshake interoperability: `initialize` is answered, not refused

Revision `2026-07-28` removed the handshake outright: no `initialize`, no
`notifications/initialized`, no `Mcp-Session-Id`, as "The session, which the protocol no longer
has" already states. Caroline's own derived-session logic was built against exactly that
removal and does not read a handshake result, key anything on a session identifier, or expect
`notifications/initialized` to arrive. None of that changes here.

What changes is that Claude Code, the same client and the same confirmed version and date named
above (2.1.233, confirmed against a running instance of this server on 2026-08-17), does not
implement the removal: its shipped MCP client transport still requires a successful
`initialize` exchange before it will treat a server connection as usable at all, regardless of
what the revision it negotiates says. Before this section's fix, Caroline's method dispatch had
no `initialize` case, so that request fell through to the same `methodNotFound` (`-32601`) any
unrecognised method gets, and the client surfaced that to the user as a failed reconnect rather
than as the successful, sessionless connection the revision intends. Refusing the handshake is
correct by the letter of the revision, which does not require Caroline to answer it, and useless
against the client that actually exists today, which will not proceed without an answer to it.

So `initialize` is now one more case in method dispatch, answered exactly like `server/discover`
answers its own capability query when the request carries an `id`: a pure, stateless echo,
computed fresh on every call, naming the protocol version, the tools capability this server
actually has, and the same server name and version `server/discover` already gives. It
introduces no `Mcp-Session-Id`, stores nothing, and starts no conversation. An `initialize`
request sent without an `id` gets no response at all, and neither does `notifications/initialized`:
both are Notifications under JSON-RPC 2.0 section 4.1 ("a Notification is a Request object
without an `id` member... The Server MUST NOT reply to a Notification"), a rule this server's
dispatch applies generally, not as something specific to the handshake. So
`notifications/initialized` is handled exactly the way any other notification is (accepted,
answered with nothing), not left specifically unhandled. A client that never calls `initialize`
loses nothing, because nothing here depends on it having been called; a client that calls it
first, as a proper request carrying an `id`, gets an answer instead of an error it has no way to
recover from.

This is a temporary interoperability accommodation, not a reintroduction of the session the
revision removed, and it should be revisited once client-ecosystem behaviour for the handshake
catches up to what the revision actually permits. When that day comes, the fix is to delete the
`initialize` case from `handleMethod` in `src/mcp/route.ts` and let it fall back to
`methodNotFound` again, which is exactly what a client built against `2026-07-28` should expect.

### Version interoperability: `initialize` negotiates, it does not just echo

Answering the handshake at all (above) is not the same question as what protocol version that
answer names. The first version of the `initialize` case answered that question the easy, wrong
way: it named `MCP_PROTOCOL_VERSION` unconditionally, never reading what the client had actually
requested. That is correct by the letter of the revision, in the sense that Caroline genuinely
runs `2026-07-28` and is not lying about what it supports, and it is useless against the client
that actually exists today: Claude Code's MCP client (the `@modelcontextprotocol/sdk`-derived
`StreamableHTTPClientTransport` named above) checks the server's answer against its own
`SUPPORTED_PROTOCOL_VERSIONS` allowlist before doing anything else with the response, and
`2026-07-28` is not on it. The reconnect fails at the transport, before Caroline's stateless
handshake logic gets any credit for having answered at all.

The specification's own version negotiation rule is not "echo whatever the client sent," and a
server that did that would not be negotiating, it would be flattering the request. The rule is:
the client states the version it wants, the server names `MCP_PROTOCOL_VERSION` back if the
client asked for exactly that, and otherwise the server names a version *it* has decided to
hold, which the client is then free to accept or disconnect over. So `initialize` now reads what
the client requested and answers one of exactly two things: `MCP_PROTOCOL_VERSION` when the
client asked for it by name, because that is the version Caroline actually runs; otherwise
`MCP_FALLBACK_PROTOCOL_VERSION`, a specific value Caroline has chosen deliberately rather than a
naive echo of whatever string arrived. Naively echoing the client's request back would make the
`initialize` response assert a compatibility with that exact string that Caroline has not
decided to hold, for versions Caroline has never tested against and may not behave correctly
under; picking one fixed fallback is the honest alternative, because it is a claim Caroline can
actually stand behind.

`MCP_FALLBACK_PROTOCOL_VERSION` is `2025-11-25`: the current `LATEST_PROTOCOL_VERSION` in the
`@modelcontextprotocol/sdk`'s `SUPPORTED_PROTOCOL_VERSIONS` allowlist (`src/mcp/protocol.ts`,
alongside `types.ts` in that SDK), captured against the same client-ecosystem snapshot named
above: Claude Code 2.1.233, confirmed 2026-08-17. It is not the newest string in the abstract; it
is the newest string the SDK a real client is built on already knows how to accept, which is the
entire point of picking a fallback rather than echoing one.

Where the client's request is read from matters as much as what happens with it. Revision
`2026-07-28` moved `protocolVersion` out of `initialize`'s top-level `params` and into
`params._meta.protocolVersion`, alongside the rest of the per-request framing this revision
requires (see the bullet on framing above). Claude Code's shipped client predates that move and
still sends the legacy top-level field, so `readRequestedProtocolVersion`
(`src/mcp/protocol.ts`) reads that field first and falls back to `params._meta.protocolVersion`
only for a hypothetical caller native to `2026-07-28` that uses the new shape. Reading only the
new location, which is what `readMeta` already does for the client name and the rest of the
framing, would mean this negotiation never sees what the client that actually exists today
requests at all, and would always fall through to the "no version specified" case below. A
client naming neither the legacy field nor `_meta` is exactly that case, "no version specified,"
and resolves the same way an unrecognised or absent version does: `MCP_FALLBACK_PROTOCOL_VERSION`,
not `MCP_PROTOCOL_VERSION`, because a server does not get to read silence as agreement with the
version it would prefer to be running.

This changes nothing else that asserts `2026-07-28` as what Caroline actually runs.
`server/discover`'s `protocolVersion`, the protected resource and authorisation server metadata
documents, and criterion 40's assertion are all untouched: they say what Caroline runs, and that
has not changed. Only `initialize`'s interop echo, the one response this spec already carved out
as an accommodation rather than a fact about the server, gets the negotiated value.

This is a temporary interoperability accommodation, not a retraction of criterion 40's assertion,
and it should be revisited once client-ecosystem support for `2026-07-28` is no longer the
exception. When that day comes, the fix is to delete the fallback branch in the `initialize` case
in `src/mcp/route.ts` and answer `MCP_PROTOCOL_VERSION` unconditionally again, which is exactly
what a client built against `2026-07-28` should expect from a server that runs it.

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
| `server.accessToken` | A startup precondition on a non-loopback bind, and nothing more. Spec 13 removes it | Spec 09, spec 13 |
| `mcp.accessToken`, slice 2 only | The MCP endpoint, until slice 3 deletes it | This spec |
| Tokens Caroline issues through the flow above | The MCP endpoint only, from slice 3 | This spec |

None of them substitutes for another. `server.accessToken` has been a startup precondition since M0
and was never checked against a request, which was a defect, and **spec 13 closes it by removing the
credential** rather than by enforcing it: a browser with no login cannot be given a static credential
to carry, so a login replaces it and a session cookie is what the page carries (spec 13 criteria 7
and 8). See the note above criteria 1 to 4. What this milestone does to that credential is nothing at
all, which criterion 33 asserts, and that stays true whether it is present or removed by the time
this surface is built. Removing the MCP bearer credential in slice 3 does nothing to it either.

## Configuration

The settings this surface adds, named here rather than left to whoever writes the code, because
six criteria below require a startup message that names a setting or a value to vary and a
criterion that cannot name its key is a criterion somebody has to invent. They follow spec 09's
mechanics without exception: declared in the strict schema with a default, readable through
`GET /api/config`, and a secret among them comes from the environment only.

| Key | Type and bounds | Default | What it is |
| --- | --- | --- | --- |
| `mcp.enabled` | boolean | `false` | Whether the endpoint and the metadata documents are registered at all. Off by default is criterion 5 |
| `mcp.sessionIdleMinutes` | integer, 1 to 1440 | `30` | The idle window that ends a derived session. Thirty minutes is a number rather than a principle, which is why it is a key |
| `mcp.clientMetadata.maxResponseBytes` | integer, 1024 to 1048576 | `65536` | The size cap on a client metadata document, enforced while the body is read |
| `mcp.clientMetadata.timeoutMs` | integer, 100 to 60000 | `5000` | The time cap on the whole fetch of one |
| `mcp.accessToken` | string or null, environment only | `null` | Slice 2's bearer credential, from `CAROLINE_MCP_ACCESS_TOKEN`. Removed by slice 3 |

Three things about that list.

`mcp.accessToken` follows `server.accessToken` exactly: it is a field of the effective
configuration and never of the file, it is fed only by its environment variable, it is in the
secret paths so redaction and the log scrubber both cover it, and a configuration file naming it
fails at startup pointing at the variable instead. That is spec 09's rule about secrets rather
than a choice made here, and it is why criterion 32's assertion about the removed setting is
about the environment variable and the file key together.

The canonical resource URI is not a setting. It is derived from `server.host` and `server.port`
and the endpoint's path, because a configurable identifier is an identifier that can be
configured to disagree with the address the process is actually reachable at, which is the one
thing criterion 42 exists to prevent.

`chat.bulkConfirmThreshold` governs this surface too, unchanged, and `chat.maxToolCalls` does not
apply to it at all: see Errors and limits. Neither gets an MCP-side twin.

## The client metadata document fetch

Client identifiers that are URLs work by the authorisation server fetching the client's
metadata document over `https` and validating it. So Caroline's authorisation server makes an
outbound request to a URL supplied by whatever is trying to connect, and that is a server-side
request forgery surface. It is the one place this surface makes Caroline's posture worse rather
than better, and it does so because of the choice to be conformant, so it gets a section rather
than a clause.

Spec 09's outbound rule today limits destinations to the ones the user named in the
configuration: GitHub, Google, the configured LLM endpoint, and the identity provider's
discovery document and token endpoint. All four are destinations **the user** chose, by making a
token, walking a consent screen, naming an endpoint in a file, or naming an issuer in a file. A
client metadata document is **the first outbound destination a caller chooses**, which is a
different kind of entry in the same list. Spec 09's amended rule says so in those words rather
than adding a fifth line to a list, because a future reader must not be able to treat the next
caller-chosen destination as precedented by this one. Anything of the same kind has to make the
argument again from scratch.

The guards, each of which is a criterion below rather than prose:

- `https` only. No `http`, in any spelling.
- The default `https` port only. A metadata document is something published on the web, and one
  published on another port is not a thing that happens; what naming a port would buy a caller is
  a request made from Caroline's own network position at some other service listening on a host
  whose address passes the check below. The scheme was constrained from the start for that reason
  and the port is the other half of the same authority.
- Public addresses only: not loopback, not link-local, not RFC 1918, not unique-local, not the
  shared address space a carrier-grade NAT hands out (100.64.0.0/10), not the protocol-assignment
  (192.0.0.0/24) or benchmarking (198.18.0.0/15) ranges, not multicast or broadcast (224.0.0.0/4,
  255.255.255.255, ff00::/8), not the NAT64 prefix (64:ff9b::/96), and not the IPv4-mapped or
  IPv4-compatible forms of any of them. Every one of those reaches a machine the user did not
  choose, and the guard's own convention is that an address it cannot classify is not one it can
  call public: a group that is not one to four hexadecimal digits makes the whole address
  unparsable, rather than being read as far as it parses. That last point is not fussiness. The
  IPv4-compatible spelling `::192.168.1.1` was read with `Number.parseInt(group, 16)`, which
  answers 0x192 without complaining, and the address then expanded into something that read as an
  ordinary public one.
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

- Loopback only, enforced at startup: a configuration setting `mcp.enabled` to `true` with
  `server.host` set to anything but a loopback name fails, naming both of those settings, in the
  same shape as the existing full-content guard. A tool whose documented posture is that the bind
  address is the boundary does not get to become a service by way of a config key.
- Off by default, which is `mcp.enabled` defaulting to `false`.
- `Origin` is validated where it is present, and a request naming a host Caroline did not
  expect is answered `403` before any tool runs. `Host` is validated against DNS rebinding.
  Loopback is not a boundary against other software on the machine, and a page in the user's
  own browser can be made to POST to `127.0.0.1`, which is why the protocol requires both
  checks. What such a page cannot do is read the answer or obtain a token, which is what the
  credential is for.
- These two checks stay narrower than the request-level ones spec 09 describes, and both stay
  loopback-only: this endpoint answers a client on the machine and nothing else. "Loopback only"
  is a constraint on the bind rather than on `server.publicUrl`, so an install fronted by a proxy
  registers this endpoint exactly as a bare loopback one does, and a request addressed to the
  public host is accepted by the request-level check (which answers to that name) and refused
  here. That combination went untested for one release and was unreachable throughout it: the
  request-level `Host` and `Origin` checks demanded the public origin and refused loopback, these
  demanded loopback, and nothing satisfied both. Spec 09's checks now accept the loopback names
  beside the public one for that reason, and it is asserted with `server.publicUrl` and
  `mcp.enabled` set together, which is the combination whose absence let the endpoint break
  silently.

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
window is `mcp.sessionIdleMinutes`, thirty minutes by default. Thirty minutes is a number rather
than a principle; what matters is that it is written down, named, and can be changed.

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

Two differences from what chat has today, and only one of them is a difference between the two
callers: `list_reviews` goes into the shared registry, so both callers get it and `tools/list` is
the registry unchanged in that respect, while `get_overview` exists on this surface alone. That
distinction is what criterion 11 counts, so it is drawn here rather than left to be inferred.

- **One addition to the shared registry, `list_reviews`.** Getting the review queue otherwise means
  `search_tasks(status: 'review')` and then a `get_task` per row for the pull request URL, the
  size estimate and the lifecycle position: N+1 calls to answer the first question a
  review-processing agent asks. `list_reviews(includeWaiting?)` answers it in one, optionally
  with the waiting side too, which is the "you reviewed it and nothing has happened since"
  list. It goes in the shared registry rather than an MCP-only list, so chat gains it as well,
  which it arguably should have had for the chase conversation `list_waiting` was written for.
- **One substitution, `get_overview`, on this surface only.** Chat sends the day's context unasked
  on every message, and Caroline does not own an external client's system prompt, so there is
  nowhere for it to go. It becomes a tool the client may call, returning the object the prompt
  assembles today, defined in the same shape every other tool is and executed through the same
  `executeTool`, so the content policy, the audit row and the derived annotations reach it without
  an exception. It is not added to chat's list, because chat is already sent what it answers.

Annotations are derived from the tool definition rather than written per tool: `readOnlyHint` from
`kind`, `destructiveHint` from `alwaysConfirm`, so `delete_task` is the only
`destructiveHint: true`, and `idempotentHint` from an idempotency field this milestone adds to the
definition, declared `true` on `complete_task` and `mark_reviewed`. That field is the one piece
the registry does not already carry: `kind` and `alwaysConfirm` are there, idempotency is not, and
deriving an annotation from nothing is how a claim about a tool gets invented. It is required on
every write tool rather than optional, so a write tool added without an idempotency decision fails
to compile and then fails criterion 12, which is the whole point of deriving rather than writing
them out. `destructiveHint` defaults to true when `readOnlyHint` is false, so saying nothing would
advertise every write as destructive and invite a confirmation prompt on `create_task`.

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
- **On this one route, JSON-RPC framing wins over the API's error envelope, and that is a
  decision rather than an omission.** Spec 08 criterion 1 requires every route to declare a
  schema and a request violating it to be answered `400` in the standard shape, which the global
  `setErrorHandler` does for every Fastify validation failure. Applied here it would answer a
  malformed JSON-RPC body with the one thing an MCP client cannot parse, so the two rules collide
  and this is the resolution: the endpoint still declares a schema, but it validates and answers
  its own errors, so no response leaves it in the API's shape. Concretely the route carries its
  own error handler rather than falling through to the shared one, and its schema failure becomes
  a JSON-RPC error object. Spec 08 names this route as criterion 1's one exception and pins it
  with a criterion of its own, so the exception is a named list rather than a loosened assertion,
  in exactly the way that spec already treats the `/api` prefix.
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

- **Slice 2 takes the protocol from the MCP TypeScript SDK and the credential work is Caroline's
  own.** The SDK is a scope of packages rather than one, and which of them ships what decides how
  much is written here, so they are named: `@modelcontextprotocol/server` for the protocol and the
  tool surface, `@modelcontextprotocol/node` for the streamable HTTP transport over Node's request
  and response, and `@modelcontextprotocol/fastify` for the `Host` and `Origin` validation hooks,
  which is a Fastify plugin and fits Caroline's existing app. This revision's required headers,
  error codes and `server/discover` are precisely what a hand roll gets wrong, and taking them
  from the SDK is the reason for the dependency.
- **The bearer verification and the protected resource metadata document are not taken from the
  SDK, because it ships them for Express only.** `requireBearerAuth` and `mcpAuthMetadataRouter`
  are exports of `@modelcontextprotocol/express`; the Fastify package's exports are
  `createMcpFastifyApp`, `hostHeaderValidation`, `localhostHostValidation`, `originValidation` and
  `localhostOriginValidation`, and none of them touches a token. Mounting Express middleware
  inside Fastify to get them is a worse trade than writing a `401` with a `WWW-Authenticate`
  header and a small JSON document, both of which are pinned by criteria here. This is stated
  because the earlier draft of this spec staked slice 2 on an SDK "resource-server package with
  its Fastify middleware", and there is no such package: a slice planned against it would have
  been planned against something that does not exist.
- **The authorisation server is Caroline's own code in slice 3.** The SDK's authorisation server
  half lives in a package named for legacy support, and the consent screen belongs on the Settings
  surface. Caroline's dependency list is short and the three packages above add to it, which is
  the cost being accepted.
- **The endpoint is served under `/api`; only the well-known metadata documents are not.** Spec
  08 owns that exception and names it, because the discovery order a client follows requires
  them at the root.

## Acceptance criteria

Numbered by slice, and each is asserted from the slice that introduces it onwards unless it says
otherwise. Two say otherwise.

Criterion 7 is asserted against slice 2 only, because it is a startup precondition on a credential
that is configured, and slice 3's only credential is a token issued at runtime, so there is nothing
left for startup to require. Criterion 32 is what holds in its place from slice 3 on.

**Criteria 1 to 4 are superseded by spec 13 and are not to be implemented as written.** They are
left in place, because these specs append rather than renumber and a superseded criterion is said
to be superseded rather than removed, and the paragraph under the slice 1 heading says what went
wrong with them. Numbering is unaffected: slice 2 is the first slice of this milestone that gets
built.

Nothing else here is kept as a record of an earlier state. Criteria stay in place once code and
tests cite them by number, which is why the specs append rather than renumber, and none of this
document is cited yet.

**Slice 1: the API's credential check. Superseded by spec 13, and withdrawn.** Spec 09 owns the
posture, and these were meant to be its tests.

They could not be built as written, which is a stronger statement than the one this milestone
originally made about them. Criterion 1 asks for the token on any route in the process.
`buildApp` registers `@fastify/static` at the root before `registerRoutes`, so the SPA shell is a
registered route, and requiring the token on it means the browser cannot fetch `index.html` at all.
Scoping the check to `/api` did not rescue it either: spec 09 said at the time that the UI has no
login, and nothing in specs 08, 09 or 12 said how a page with no login obtains the token it is then
asked to carry. The sentence about the token reaching the change feed as a cookie set once from the
page presupposes the page already has it, which is the same circle drawn smaller. A browser SPA
cannot be protected by a static credential the browser has no way to be given.

Spec 13 has since answered it, and not by making the token a request requirement. It removes
`server.accessToken` outright, with `CAROLINE_ACCESS_TOKEN` in the environment failing at startup
rather than being ignored, which is its criterion 7; and it puts a session behind a login in its
place, checked on every route under `/api` other than the three public auth routes, with the SPA
shell and its assets served without one, which is its criterion 8. So the defect these criteria were
written against is closed by removal rather than by enforcement, and there is nothing left here for
them to assert. Spec 09's own third appended criterion, which asked for the same request-level check,
is dropped for the same reason: it was never merged, so nothing cites it.

1. **Superseded by spec 13 criteria 7 and 8. Not to be implemented as written.** With
   `server.accessToken` configured, a request to any route in the process that does not present it is
   refused, and every route behaves identically in that respect, asserted over the registered route
   list rather than route by route.
2. **Superseded by spec 13 criteria 7 and 8. Not to be implemented as written.** With
   `server.accessToken` configured, a request presenting it is answered normally, and the comparison
   of the presented value against the configured one takes time independent of how much of it matches.
3. **Superseded by spec 13 criteria 7 and 8. Not to be implemented as written.** With no
   `server.accessToken` configured, no request is refused for want of one, so a loopback install with
   no token behaves exactly as it did before this milestone.
4. **Superseded by spec 13 criteria 7 and 8. Not to be implemented as written.** The browser reaches
   the change feed and the streamed chat turn under a configured token, and the token appears in no
   log line and in no response body, which is spec 09 criterion 6 applied to however it is carried.

**Slice 2: the surface.** The first slice built.

5. With `mcp.enabled` false, no MCP endpoint and no metadata document is registered at all, asserted
   over the registered routes rather than by requesting one.
6. With `mcp.enabled` true and `server.host` not loopback, startup fails with a message naming both
   `mcp.enabled` and `server.host`.
7. **Slice 2 only, replaced by criterion 32.** With `mcp.enabled` true and no `mcp.accessToken` in
   the environment, startup fails whatever the bind address, naming `CAROLINE_MCP_ACCESS_TOKEN`:
   loopback is not a substitute for the credential on this surface. It is asserted while the
   credential is a configured one, and stops being asserted when slice 3 makes the only credential
   a token issued at runtime.
8. A request with no credential is answered `401` with a `WWW-Authenticate: Bearer` header, and
   one bearing a credential that is not accepted is answered `401`. This holds under both
   credentials: from slice 3 the challenge also names the protected resource metadata document,
   which is criterion 26.
9. A request whose `Origin` header is present and names a host Caroline did not expect is
   answered `403` before any tool runs, and one whose `Host` header does not name a loopback
   name is refused.
10. A request whose `MCP-Protocol-Version` header disagrees with the protocol version in its
    body is answered `400` with the protocol's `HeaderMismatch` code, and a request whose
    `Mcp-Method` header disagrees with the request body's method is refused. A request that
    omits `Mcp-Method` (or, on `tools/call`, `Mcp-Name`) entirely is accepted rather than
    refused, per "Header interoperability" below.
11. `server/discover` and `tools/list` answer without a tool being run, and `tools/list` returns
    exactly the tools of spec 07's registry, `list_reviews` included because this milestone adds it
    there, plus `get_overview` and nothing else. Asserted against the registry itself rather than a
    written-out list of names, so that a tool added to the registry appears here without the test
    being edited and a tool that is neither in the registry nor `get_overview` cannot appear at all.
    Each carries the same JSON Schema object `executeTool` validates against rather than a copy of
    it.
12. Every tool's annotations are derived from its definition rather than written per tool:
    `readOnlyHint` from `kind`, `destructiveHint` from `alwaysConfirm` so that `delete_task` is the
    only `destructiveHint: true`, and `idempotentHint` from the idempotency field the definition
    gains in this milestone, which is `true` on `complete_task` and `mark_reviewed`. That field is
    required on a write tool, so a write tool added without an idempotency decision fails this
    rather than being advertised on a default nobody chose.
13. A `create_task` call creates the task with `status_set_by = 'user'`, publishes on the change
    feed so an open board reloads, and appears in the conversation list as a session naming the
    client that called it.
14. Two calls from one client within `mcp.sessionIdleMinutes` are recorded against one conversation,
    and two separated by more than it are recorded against two, asserted by varying that setting
    rather than by waiting. A call declaring no client name is recorded against an unnamed client
    rather than refused.
15. A `delete_task` call executes nothing, creates a confirmation, and answers the client that
    nothing was deleted and a person has been asked. Confirming it on Caroline's own screen
    performs exactly the stored operation and records it against the session's turn.
16. A turn of a session that changes more tasks than `chat.bulkConfirmThreshold` holds every further
    write into one confirmation, and **the number the confirmation states as what confirming applies
    is the held batch: the writes waiting, and not the ones already done.** That is the number
    `chat_confirmations.affected_count` holds, which `src/chat/turn.ts` sets from the held operations
    for a reason worth not undoing: a card reading eleven waiting when ten of them have already
    happened is a card that misreports the decision being asked for. Three counts are in play across
    the turn and this criterion asserts each in its place rather than asserting they are one number.
    The threshold is compared against the tasks the turn has already changed. `affected_count` is the
    held batch. The summary sentence names the turn's total, which is those two added together, and
    then says how many are already done and how many confirming applies, which is what makes the
    total legible rather than alarming. The MCP surface needs no different number from the browser's:
    it is the same confirmation record, written by the same code, decided on Caroline's own screen,
    and the point of naming the three here is that a test can pin each one. Once the confirmation is
    decided, the next write over the same session opens a new turn and the count starts again from
    nothing, per spec 07 criterion 14.
17. With `mcp.enabled` true, `llmContent: full` and `allowFullContentToRemoteProvider: false`,
    startup fails naming all three of `mcp.enabled`, `privacy.llmContent` and
    `privacy.allowFullContentToRemoteProvider`, whatever `llm.provider` is set to, `ollama`
    included.
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
24. Each session, and each tool call within it, is recorded with the tool name, a digest of the
    arguments, whether the call was held, the content level and policy version in force, and the
    number of items answered. No answered item text is in that record. The digest is asserted
    because both this spec's Audit section and spec 09's amended non-goal name it, and a row without
    it does not answer what the agent asked for.
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
    token Caroline did not issue is refused. No token presented to Caroline's MCP endpoint is ever
    forwarded to an outbound destination, the identity provider included. The subject is deliberately
    narrow: a token Caroline obtained through one of its own OAuth flows is a different thing, and is
    forwarded by design (`src/connectors/google/http.ts` sends its Google access token to
    googleapis.com, which is what makes that connector work). What this criterion forbids is the
    onward use of a client's bearer token. It is asserted over the one outbound request the MCP
    surface builds, the client metadata document fetch, whose headers are read at the far end in
    `test/mcp/oauth/client-metadata.test.ts` and carry no credential-bearing header and no body.
    Spec 13's criterion 28 is an unrelated criterion that happens to share the number; nothing in
    that spec's source-inspection test asserts this one.
29. A refresh token exchanges for a new access token, a revoked or expired one does not, and both
    are registered as runtime secrets so that no issued token appears in any log line or
    response body, which is spec 09 criterion 6 extended to values arriving after startup.
30. A redirect URI on a loopback host is matched without regard to its port, so a native client's
    ephemeral callback port works, and a redirect URI that is neither loopback nor `https` is
    refused.
31. No client is issued a token until the user has approved it once on Caroline's own screen, and
    the approval names the client. There is no endpoint by which a client registers itself, asserted
    the way a client would find out: the authorisation server metadata document advertises no
    `registration_endpoint`. That is the testable form of it, because RFC 7591 defines no fixed
    path, only a registration endpoint discovered through that field, so there is no path to request
    and a guess at one would in any case be answered by the SPA shell wherever the built site is
    present.
32. The bearer credential is gone, and this is what stands in criterion 7's place. No credential is
    accepted on the MCP endpoint but a token Caroline issued, the value slice 2 accepted is refused,
    and slice 2's setting fails at startup rather than being ignored in either of the two places it
    could still be named: `CAROLINE_MCP_ACCESS_TOKEN` in the environment is reported as a removed
    setting naming the variable, and `mcp.accessToken` in the configuration file is refused by the
    strict schema naming the key.
33. The API's own credential is exactly as this milestone found it, and removing the MCP bearer
    credential changes nothing about it. Asserted, because the two credentials are easily conflated
    and this is the assertion that says they were not. It is phrased about whatever the API's
    credential is at the time rather than about `server.accessToken` by name, because spec 13
    criterion 7 removes that key and this criterion is about this milestone touching nothing on the
    API's side, which holds either way: with the key present, nothing here reads or changes it; with
    the key gone and a session in its place, nothing here reads or changes that either.
34. A client metadata document is fetched only over `https`. An `http` URL is refused, in any
    spelling.
35. The address a client metadata URL resolves to is checked before anything connects to it, and
    the connection is made to that checked address, so a name resolving to a loopback,
    link-local, RFC 1918 or unique-local address is refused and a second resolution cannot
    substitute one. Asserted for each of those ranges and for their IPv4-mapped forms. Extended by
    the security review of 2026-08-21, rather than joined by a second criterion, to the rest of the
    ranges the guard section above now lists: shared address space, protocol assignments,
    benchmarking, multicast, broadcast, the NAT64 prefix, and the IPv4-compatible spelling of an
    embedded address. One case per range, table-driven.
36. A client metadata response larger than `mcp.clientMetadata.maxResponseBytes` is refused while it
    is being read rather than after, and one that has not completed within
    `mcp.clientMetadata.timeoutMs` is abandoned. Both are asserted by lowering the setting rather
    than by producing a large or slow response at the default.
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

The review of this spec added the following, appended rather than renumbered for the reason spec
README's conventions give. Criteria 41, 43, 44 and 45 belong to slice 2 and criterion 42 to slice 3,
and each is asserted from that slice onwards like the rest.

41. `get_overview` is a tool `tools/list` carries, it answers with the day's context object chat's
    prompt assembles today and through the same code that assembles it, it is `readOnlyHint: true`
    by criterion 12's derivation like any other read tool, and its answer is subject to the content
    policy and recorded by an audit row like any other call. It is absent from what chat is offered,
    because chat is already sent what it answers.
42. The `issuer` in the authorisation server metadata document is byte-identical to the identifier a
    client builds the well-known URL from, and the `resource` in the protected resource metadata
    document is the MCP endpoint's own origin and path, both derived from `server.host` and
    `server.port` rather than configured. Both are `http` on loopback, which is a knowing deviation
    from RFC 8414 and RFC 9728 that this spec states with its justification, and the assertion is
    the internal consistency a client is required to check rather than a scheme this design cannot
    satisfy.
43. A malformed JSON-RPC body on `POST /api/mcp` is answered as a JSON-RPC error object and never in
    the API's `{ error: { code, message, details? } }` shape, asserted by sending a body that
    violates the route's schema and parsing the answer as JSON-RPC. This is the resolution of the
    collision between that shape and spec 08 criterion 1, which spec 08 criterion 37 states from its
    own side.
44. An `initialize` request that carries an `id`, with or without the headers named in criterion
    10, is answered `200` with a JSON-RPC result naming `protocolVersion`, a `capabilities`
    object whose `tools` key is the tools capability this surface actually has, and `serverInfo`
    identical to what `server/discover` names as `server`, rather than with `methodNotFound`. An
    `initialize` request without an `id` gets no response (`202`, empty body), per the general
    JSON-RPC 2.0 rule against replying to a Notification that this surface's dispatch applies to
    every method, `initialize` included; `notifications/initialized` is handled under that same
    general rule rather than as a case this surface refuses or handles specially. The call
    creates no session, no `Mcp-Session-Id`, no conversation and no other row, asserted by
    counting `mcp_sessions` and the conversation list before and after, and a `tools/list` call
    on the same connection afterwards answers exactly as it does when no `initialize` call
    preceded it. Per "Handshake interoperability" above.
45. The `protocolVersion` criterion 44 requires is negotiated, not a fixed echo: a request naming
    `MCP_PROTOCOL_VERSION` (`2026-07-28`) exactly, in the legacy top-level
    `params.protocolVersion` field or, absent that, in `params._meta.protocolVersion`, is
    answered with `MCP_PROTOCOL_VERSION`; a request naming any other version, or none at all, in
    either location, is answered with `MCP_FALLBACK_PROTOCOL_VERSION` (`2025-11-25`) instead,
    never with the client's own string parroted back. The legacy top-level field is read first
    because Claude Code's shipped client, built before revision `2026-07-28` moved the field,
    sends only that one. Per "Version interoperability" above.
46. A client identifier naming a port other than the `https` default is refused before anything is
    resolved or connected to, and the default port written out explicitly is accepted because a URL
    parser reads it as the same address. Per "The client metadata document fetch" above.
