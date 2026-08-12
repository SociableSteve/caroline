# 13. Authentication

## Purpose

Caroline's posture has always been that the bind address is the boundary: it listens on
`127.0.0.1`, and the operating system decides who can reach it. That is a real boundary, and
on loopback it is the right one. Spec 09 then offered a second answer for the case where the
bind moves, a shared access token, "because the UI has no login". That answer was doing a job
a shared secret cannot do. It identifies nobody, it cannot be withdrawn without a restart, it
never expires, and it was never checked on a request in the first place.

This spec replaces it with the honest version of the same intent. Where Caroline is reachable
from a network, a person proves who they are to an identity provider they already trust before
anything answers. Where Caroline is on loopback, nothing changes, because there the socket
really is the boundary.

Caroline is single user by design, so "login" here means proving you are the one person who
owns this instance. It is not tenancy. Nothing in this spec introduces a second account, a
role, a scope or per-identity data.

## Two roles, layered

Caroline is on both sides of OAuth, and that is deliberate rather than confused.

- **Google authenticates the human.** For the browser session this spec defines, Caroline is a
  relying party: it sends a person to the provider and takes an answer back.
- **Caroline authenticates the machine.** For an MCP client, Caroline remains its own
  authorization server, issuing its own tokens.

That is the ordinary shape of an authorization server: it authenticates the resource owner by
whatever means it likes, and issues its own tokens to clients on the strength of that.

Full federation, where Caroline would accept provider-issued tokens on its own machine-facing
surface, is not available. The MCP revision Caroline targets requires a protected resource to
validate that a token's audience is that resource, and forbids accepting a token the resource
did not issue. A Google access token's audience is a Google client, so a federated Caroline
would be a non-conformant one. It would also be a local tool that cannot answer a local
request while Google is unreachable, which is a worse tool.

Nothing crosses between the two. A machine token is never accepted as a browser session, and a
browser session is never accepted as a machine token. They are different credentials proving
different things about different callers.

## Where the boundary decision is made

There is exactly one derived fact, computed once at startup from the configuration:
`authRequired`. Every check reads it. It is derived rather than configured directly so that
"authentication is required unless this is loopback" is decided in one place instead of being
inferred in several, because a rule inferred in several places is a rule that is wrong in one
of them.

`authRequired` is true when any of these holds:

1. **`server.host` is not a loopback address.** The existing loopback set is the test:
   `127.0.0.1`, `localhost`, `::1`, `::ffff:127.0.0.1`. The wildcards `0.0.0.0` and `::` are
   not in it and are not loopback, and neither is `127.0.0.2`. A wildcard bind accepts
   connections from the network, so a request that happens to arrive over loopback on such a
   bind still requires a session: the boundary cannot be reached round the side.
2. **`server.publicUrl` is set.** This is how an operator says there is a proxy in front of
   Caroline, and it is the answer to the reverse-proxy hole: the socket is loopback, the
   traffic is not, and no request header can be trusted to say which. A declaration in the
   configuration can be.
3. **`auth.mode` is `required`.** Somebody who wants a login on a loopback install can have
   one.

### What startup refuses

Where `authRequired` is true, the process refuses to start unless all three of these hold, and
the refusal names every setting involved in one sentence, in the shape
`allowFullContentToRemoteProvider`'s guard already uses. Refusing to start is better than
quietly serving, and there is no half-open state to reason about later.

| Refused | Because |
| --- | --- |
| No provider configured (`auth.provider.clientId` null, or `auth.provider.issuer` unset) | There would be no way to log in, so the instance would be exposed and unusable at once |
| `auth.allow` empty | The provider will authenticate anybody with an account there. An empty allowlist on an exposed instance is no authentication at all, with ceremony |
| `server.publicUrl` unset | The redirect URI cannot be derived, and Caroline would have to guess its own outside address |
| `server.publicUrl` scheme not `https`, where its host is not loopback | A session cookie over plaintext is the exact failure this spec exists to prevent |

There is deliberately no override for the `https` rule. A Tailscale or VPN-only deployment can
terminate TLS itself, and an override flag for this is the flag that gets pasted out of a forum
post into a public deployment. A loopback public URL may be `http`, because there is no network
between the browser and the socket to protect.

### Forwarded headers are never trusted

Where `authRequired` is false, a request carrying `X-Forwarded-For` or `Forwarded` is answered
400 with a message naming `server.publicUrl`. Both obvious alternatives are worse. Trusting the
header would let a caller declare itself local, which hands the boundary to whoever is on the
other side of it. Ignoring the header leaves the one misconfiguration this spec exists to
prevent completely silent: Caroline on loopback behind a proxy, believing itself private. A
caller who sends the header can only cause a refusal and never an access, so the guard cannot
be turned into a bypass, and the refusal teaches the operator the exact setting they missed.

Where `authRequired` is true, forwarded headers are not read at all, because no decision
depends on a client address. `request.ip` stays the socket address for logging, and Fastify's
`trustProxy` is left off: an address taken from a header is caller-chosen bytes in a log line,
which is the thing spec 09's URL rule already refuses.

A trusted-proxy mode, for somebody already running an authenticating gateway, is not in this
spec. The honest shape for it is a named header plus a secret shared with the proxy, which is a
design with criteria of its own. A setting that simply turns the boundary off is not.

## One check over the whole route list

A single `onRequest` hook, registered beside `registerRoutes` in `buildServer`, so the boundary
is one function and the suite can assert it over the registered route list rather than route by
route. A boundary remembered per route is a boundary somebody forgets, and the route list is
already centralised for exactly this reason: spec 08 criterion 1's test walks it so a route
cannot slip past by living somewhere the test does not look.

Exempt, and the exemption list is itself asserted:

- `GET /api/auth/status`, `POST /api/auth/login` and `GET /api/auth/callback`. A login flow
  cannot require a session.
- Everything outside `/api`: the built SPA shell and its assets. The shell holds no user
  content, and serving it unauthenticated is what lets the login screen be a state of the
  client rather than a second server-rendered page with its own styling to keep in step.

Not exempt, deliberately: `GET /api/health`. It names the version and which integrations are
configured, and a liveness probe is served just as well by a 401 as by a 200. A monitor that
genuinely needs a 200 wants a route that says nothing but "ok", and that can be added when
somebody asks for it.

## Who is allowed in

Signing in successfully at the provider says nothing about whether you own this instance.
Google will authenticate anybody with a Google account against Caroline's client. So the
authorization decision is Caroline's alone, and it is an allowlist.

- **`auth.allow` is required and non-empty whenever `authRequired` is true**, enforced at
  startup. There is no "allow anyone who can log in" mode.
- An entry is an email address, or `sub:<value>` for a provider that does not return one. An
  address entry matches only when the id_token carries `email_verified: true`, and only for the
  configured issuer. Domain entries such as `@example.com` are not supported in this spec: they
  are one line of code and a much larger blast radius, and the Workspace claim that would make
  one trustworthy (`hd`) is not portable across providers.
- **A second identity that authenticates successfully at the provider is refused by Caroline.**
  No session, a 403, and the login screen says that the account is not permitted to use this
  Caroline. The screen names no address, because that is caller-influenced text in a response
  body, which is the pattern spec 09 already refuses for request URLs. The log line records
  that a login was refused and the provider-attested subject, because the operator needs to
  know who is knocking and they are the one person with the log.
- **Subject pinning.** The first successful login records the id_token's `sub` against the
  allowlist entry it matched. A later login matching that entry with a different subject is
  refused. This is what stops an address reassigned at the provider, or a personal account that
  happens to share a string with a Workspace one, from inheriting the instance. It is the small
  amount of trust on first use worth having, and it is recorded rather than assumed: the
  allowlist is the thing a human can write down, and `sub` is the thing that is actually
  stable.

An allowlist rather than claim-on-first-login, because the window between deploying an exposed
instance and logging into it for the first time is a window in which whoever gets there first
owns the instance. That race is real on a public address, and a configuration file avoids it
entirely.

## The session

An opaque random value in a cookie, with a row in a new `sessions` table.

- **Value.** 32 bytes of `randomBytes`, base64url, from the same helper the existing OAuth
  state uses. The database stores only its SHA-256 hash, so the file holds nothing that can be
  presented as a session. That is not encryption at rest, which spec 09 rules out. It is not
  storing the credential in the first place.
- **Cookie attributes.** `HttpOnly`, `SameSite=Lax`, `Path=/`, no `Domain`. `Secure` and the
  `__Host-` prefix whenever the public URL is `https`, and neither on a loopback `http`
  deployment, because a browser refuses a `__Host-` cookie without `Secure` and such a
  deployment would simply not work. `Max-Age` is set from the idle window so the browser
  forgets it too, but the row is the authority.
- **A cookie rather than a bearer header.** `EventSource` cannot set a request header, and the
  change feed is opened with it. A header-only scheme would mean either a credential in a URL,
  which spec 09 refuses in as many words, or a second mechanism for one route. A cookie carries
  both streams and every ordinary request without the client holding a secret in JavaScript at
  all.
- **Expiry.** A rolling idle window (`auth.sessionIdleDays`) with an absolute cap
  (`auth.sessionMaxDays`), whichever comes first. The row's last-seen stamp is updated on use.
- **Revocation.** `POST /api/auth/logout` revokes the row and clears the cookie. A revoked or
  expired row is a 401 everywhere immediately, because the check reads the row on every
  request. There is no stateless token to outlive its own revocation, which is the main reason
  for a row rather than a signed cookie.
- **How the value is compared.** The presented value is hashed and the hash is compared with the
  stored hash using `crypto.timingSafeEqual`, on equal-length buffers, rather than with `===`.
  The mechanism is named here, and asserted as a mechanism, because the property it exists for
  (that the comparison does not reveal how much of a guess was right) can only be measured with
  a timing experiment, and a timing experiment in a suite is a flaky test rather than a
  guarantee. Naming the function is the thing a test can pin.

### Why there is no CSRF token

Three properties cover it, none of which is a token the client has to carry, and it is worth
writing down why they are sufficient rather than asserting that they are.

1. `SameSite=Lax` means the browser does not send the cookie on a cross-site form post or
   fetch, so a foreign page cannot make an authenticated unsafe request in the ordinary way.
2. No response on any route carries a CORS header, ever. So even where a foreign page can cause
   a request, it cannot read the answer.
3. Any request whose method is not `GET` or `HEAD`, and whose `Origin` header is present and is
   not the public origin, is refused before it reaches a route. That closes the cases where a
   browser sends the cookie on a same-site-but-not-same-origin request, and it is a check on a
   header the browser sets rather than on one the caller chooses to be believed about.

The SPA is same-origin, so nothing about it changes. A CSRF token would add a mechanism, a
second endpoint and a client-side store for a case those three already cover.

## The streams

Both streams are authorised at connect, like every other request, and then have to be dealt
with as long-lived things.

- **The change feed.** Subscriptions are keyed by session. Revoking or expiring a session
  closes the feeds that session opened. `EventSource` reconnects by itself, the reconnect is
  answered 401, and the client turns that into the login screen. A stream that keeps delivering
  task titles to a browser whose session was revoked is the leak the revocation was for.
- **The chat turn.** A turn already streaming when its session is revoked has its stream cut
  and its turn still recorded. That is not a compromise: it is what spec 08 criterion 7 already
  guarantees for an abandoned read, that the turn is recorded as it happens so abandoning the
  read does not abandon the turn, and reloading the conversation gets the rest. Revocation
  therefore keeps that criterion true rather than carving an exception into it. What does not
  happen is a new turn: the next `POST /api/chat` is a 401 like anything else.

## The login flow

Four routes, three of them public.

| Route | Purpose |
| --- | --- |
| `GET /api/auth/status` | Whether authentication is required, whether this request has a session, and the provider's label. Public, and it says nothing about the person |
| `POST /api/auth/login` | Starts the flow. Answers with the provider's authorization URL |
| `GET /api/auth/callback` | The provider's redirect. Exchanges the code, checks the identity, sets the cookie, redirects into the SPA |
| `POST /api/auth/logout` | Revokes the session and clears the cookie |

- **The flow's state lives in memory, one at a time**: the state value, the PKCE verifier, the
  nonce, and the hash the user was heading for. This follows the precedent the Google data
  client already sets, and for the reason its comment gives: there is one user and one browser.
  A restart mid-flow loses it, and the person clicks the button again.
- **Discovery is fetched lazily and cached.** Not at startup, because spec 00 requires the
  process to run with no network access to anything. The first login attempt fetches
  `{issuer}/.well-known/openid-configuration`, and a provider that cannot be reached is
  reported to the login screen as unreachable rather than as an internal error.
- **The redirect URI is derived from `server.publicUrl`**, not from the bind address and port.
  Behind a proxy, only the operator knows the outside address. This is the difference between
  this client and the Gmail and Calendar data client, whose redirect is the loopback address it
  is already listening on.
- **The intended hash survives.** `POST /api/auth/login` takes the hash the person was on, and
  the callback redirects back to it, so a deep link followed while unauthenticated lands where
  it was going.

### The identity token is validated and its signature is not

The identity token here is the OIDC `id_token`. Claims checked: `iss` equals the configured issuer, `aud` equals the configured client id,
`exp` is in the future, and `nonce` is the one issued for this attempt.

The signature is not verified locally. This is a decision rather than an omission, so it is
written down with its reason and its constraint. The token arrives in the response body of a
direct TLS request that Caroline itself made to the provider's own token endpoint, and OIDC
Core explicitly permits that as sufficient in the authorization code flow. It buys three things
worth having: no JWT dependency, no JWKS cache to keep fresh, and no second outbound
destination taken out of a document.

It also constrains the design, and the constraint is a criterion rather than a comment: the
token endpoint is reached directly over `https`, never through a configurable proxy and never
over a plaintext scheme. If that constraint were ever relaxed, local signature verification
would have to arrive in the same change.

## Provider requirements, and what cannot be generic

OIDC discovery is what makes the provider a configuration value. The minimum a provider must
support:

1. A discovery document at `{issuer}/.well-known/openid-configuration` whose own `issuer` field
   equals the configured issuer.
2. `authorization_endpoint` and `token_endpoint`, both `https`.
3. The authorization code flow with PKCE, advertising `S256` in
   `code_challenge_methods_supported`. Refused otherwise, which is the same bar Caroline's own
   MCP clients are held to.
4. An id_token with a stable `sub`, and either a verified `email` or an allowlist entry naming
   the subject.
5. A redirect URI that can be registered as an exact `https` URL.

What Caroline does not need, which is what keeps this surface small: no refresh token, because
Caroline never calls the provider again after login; no userinfo call, because the id_token
carries what the allowlist matches on; no scopes beyond `openid` and `email`; and no logout
endpoint at the provider.

**What cannot be made generic**, stated here so the documentation carries it rather than the
code:

- Registering the client. Every provider's console is different, so the setup guide's provider
  section is written generically with Google as the worked example.
- Google specifically needs a **second client** in the same Cloud project: a Web application
  client with an exact redirect URI, distinct from the Desktop client the Gmail and Calendar
  integration uses. Reusing the data client would mean a loopback redirect URI, which an exposed
  deployment cannot use, and it would attach login to a consent screen carrying Gmail scopes.
- Whether a provider returns `email` at all, and whether it marks it verified.

**Google-specific behaviour that would leak into the design if nobody watched for it**, and how
each is kept out: `hd`, the hosted-domain claim, is not read, because a domain allowlist is a
different feature and a Workspace claim is not portable; `access_type=offline` and
`prompt=consent` are not sent, because they exist to obtain a refresh token this flow has no use
for; and the endpoint constants in the Google data client are not reused, because they are the
data client's. That is proven rather than claimed: the flow runs end to end against a second
provider's recorded documents, and a source-inspection test asserts that no module under
`src/auth/` names a Google host, endpoint or non-standard claim. It is the same style of
enforcement as spec 07 criterion 2's import check.

### The discovery fetch is a user-chosen destination

`auth.provider.issuer` is named by the **user** in the configuration file, exactly as
`llm.baseUrl` is. So the identity provider joins spec 09's outbound list on the side that list
was already drawn for, beside GitHub, Google and the LLM endpoint. It is explicitly **not**
precedent for a destination whose URL arrives from whoever is trying to connect: that is a
different and higher bar, answered in its own spec, and this paragraph is written so it cannot
be cited in support of it.

The guards apply anyway, because they are cheap and because they keep a user-chosen issuer
honest: `https` only, the discovery document's `issuer` must equal the configured one, the
endpoints it names must be `https`, no redirect is followed to another host, and there is a size
cap and a timeout.

## Configuration

Every key this spec introduces, with its default. Nothing here is written back from the UI, so
each of them takes a restart, as spec 09 says of the file generally.

```jsonc
{
  "server": {
    "host": "127.0.0.1",
    "port": 5123,
    "publicUrl": null // e.g. "https://caroline.example.com"
  },
  "auth": {
    "mode": "auto", // auto | required
    "allow": [], // your own address, or "sub:1234567890"
    "sessionIdleDays": 7,
    "sessionMaxDays": 30,
    "provider": {
      "label": "Google",
      "issuer": "https://accounts.google.com",
      "clientId": null,
      "scopes": ["openid", "email"]
    }
  }
}
```

| Key | Default | Meaning |
| --- | --- | --- |
| `server.publicUrl` | `null` | The URL the browser reaches Caroline at. Setting it makes authentication required, and the redirect URI is derived from it |
| `auth.mode` | `"auto"` | `auto` derives the boundary from the bind and the public URL. `required` demands a session even on loopback |
| `auth.allow` | `[]` | Allowed identities: an email address, or `sub:<value>`. Required and non-empty wherever authentication is required |
| `auth.sessionIdleDays` | `7` | Rolling idle window, in days. At least 1, at most 30 |
| `auth.sessionMaxDays` | `30` | Absolute lifetime, in days, whatever the idle window says. At least `auth.sessionIdleDays`, at most 30 |
| `auth.provider.label` | `"Google"` | What the login button calls the provider |
| `auth.provider.issuer` | `"https://accounts.google.com"` | The OIDC issuer. Discovery is `{issuer}/.well-known/openid-configuration` |
| `auth.provider.clientId` | `null` | The client id registered with the provider |
| `auth.provider.scopes` | `["openid", "email"]` | Scopes requested at login. Nothing beyond these is needed |

`auth.provider.clientSecret` is a secret and so comes only from the environment, as
`CAROLINE_AUTH_CLIENT_SECRET`. Its default is `null`, and null is a supported state: where the
provider's discovery document offers `none` in `token_endpoint_auth_methods_supported`, Caroline
is a public client and PKCE alone protects the code exchange. Where it does not, the secret is
required and startup says so, naming both the setting and the provider's advertised methods.

### `server.accessToken` is removed

The key, the `CAROLINE_ACCESS_TOKEN` environment variable, the startup guard that read it and
its documentation all go, in slice 1.

The argument is design rather than compatibility. Two overlapping credentials on one surface is
the worst of the available options: a shared secret in an environment variable identifies
nobody, cannot be revoked without a restart and has no expiry, and it would sit beside a session
that has all three properties.

`CAROLINE_ACCESS_TOKEN` present in the environment **fails at startup**, naming the variable and
what replaced it. Silently ignoring a credential somebody believes is protecting them is the
worst outcome available. `server.accessToken` in the configuration file continues to fail,
because the ban on secrets in the file predates this spec.

On the non-interactive caller: the capability is real, and this was the wrong shape for it. A
script that needs to reach Caroline runs on the machine over loopback, where nothing is
required, or reaches loopback through an SSH tunnel. If a genuine need for a non-interactive
credential appears, the right shape is a named, revocable key issued from Settings, stored
hashed beside the sessions, with an expiry and an audit row. Nothing here forecloses that: the
`sessions` table and the single request check are exactly what such a key would hang off.

## Secrets

One new configured secret, handled by the mechanisms that already exist rather than by a second
one. `auth.provider.clientSecret` joins the three lists every configured secret joins: the
secrets banned from the configuration file, with `CAROLINE_AUTH_CLIENT_SECRET` as its hint; the
secret environment variables, so the value is scrubbed from logs whether or not this
configuration uses it; and the secret paths, which is what makes `GET /api/config` redact it and
the log scrubber recognise it.

Three transient values are secrets that never become configuration: the authorization code, the
id_token and the session value. None is registered as a runtime secret, and that is a decision
rather than an oversight. The rotating runtime-secret list is bounded, so registering a value per
login would evict the Google tokens from it, and these three have somewhere better to be: the
code and the id_token never leave the function that handles them, the session value exists only
in a `Set-Cookie` header and an incoming `Cookie` header, and the request serialiser logs no
headers at all. What is asserted is the outcome: none of them appears in any log line or
response body. That is spec 09 criterion 6 applied to this surface, tested the way it is already
tested.

## Recovery

Being locked out is now possible, where before it was not. If the provider is unreachable, an
exposed Caroline cannot be logged into.

The documented answer is a restart on loopback, and there is no break-glass login link. The
operator has shell access to the machine by definition, which is a stronger proof of ownership
than a provider account is, so the path is: stop Caroline; restart it bound to loopback, where
no authentication is required; fix the configuration; restart it. A one-time login link printed
on stdout would also work, but it is a second authentication path that has to be as strong as
the first, and the first real lockout is what should decide whether it is worth building.

## The login screen is not a surface

The screen is what the shell renders instead of a surface when the API says the request is
unauthenticated. It has no route, no navigation entry and no hash of its own. It is one button
and, where a login was refused, one sentence, built from spec 10's existing primitives.

This is worth stating because spec 08's "five surfaces and a companion" and spec 10 criterion
6's count of distinguishable routes both stand unchanged. A 401 from any call puts the client
into that state rather than retrying, which is the one client-side rule this spec adds.

## Non-goals

- Multi-user accounts, roles or scopes, and any per-identity separation of data.
- TLS termination. That is the reverse proxy's job, and it is why `server.publicUrl` must be
  `https` off loopback rather than why Caroline should learn to hold a certificate.
- Local passwords, or any credential Caroline itself issues to a human.
- MFA. That is the provider's job, and delegating login is how Caroline gets it.
- Rate limiting and lockout.
- More than one provider configured at once.
- RP-initiated logout at the provider. Logout ends the Caroline session, not the Google one.
- Domain-wide allowlist entries.
- A trusted-proxy mode that accepts an upstream gateway's word for an identity.
- Any non-interactive API credential, including the removed `server.accessToken` and any
  successor. A named revocable key is a plausible later milestone with criteria of its own.
- **Opening the MCP endpoint's bind.** Authentication changes who may reach the HTTP API a
  browser talks to. It says nothing about whether an unattended agent endpoint should be
  reachable from another machine, which needs its own answers about rate limiting, lockout and
  what a stolen token can do with nobody watching. The loopback-only rule for that surface
  stands, and this entry exists so the next reader finds the decision rather than repeating the
  argument.

## Acceptance criteria

Numbered by slice: 1 to 8 are the boundary, 9 to 26 are the provider and the session, 27 to 30
are the second provider.

**Slice 1: the boundary.**

1. With authentication required, a request to any registered route carrying no valid session is
   answered 401 in the standard error shape, asserted over the registered route list rather than
   route by route. The exempt list is asserted separately, and is exactly the three public auth
   routes.
2. With authentication not required, no request is refused for want of a session, on any route.
3. Where authentication is required, startup fails in each of these cases, each asserted
   separately, with a message naming the setting that is missing: `auth.provider.clientId` null,
   `auth.provider.issuer` unset, `auth.allow` empty, and `server.publicUrl` unset.
4. `server.publicUrl` set makes authentication required whatever the bind address is, and a
   public URL whose scheme is not `https` fails at startup unless its host is loopback.
5. `0.0.0.0` and `::` count as non-loopback, and on such a bind a request arriving over loopback
   still requires a session.
6. With authentication not required, a request carrying `X-Forwarded-For` or `Forwarded` is
   answered 400 with a message naming `server.publicUrl`. No forwarded header is read for any
   other decision, on any path.
7. `CAROLINE_ACCESS_TOKEN` in the environment fails at startup, naming the variable and what
   replaced it. `server.accessToken` in the configuration file fails as it always did, and no
   code reads either value for any decision.
8. The SPA shell and its assets are served without a session, and every route under `/api` other
   than the three public auth routes is not.

**Slice 2: the provider and the session.**

9. `GET /api/auth/status` answers without a session, states whether authentication is required
   and whether this request has one, names the provider's label, and carries nothing about the
   person and no other configuration.
10. `POST /api/auth/login` answers with an authorization URL carrying `response_type=code`,
    `code_challenge_method=S256`, a state, a nonce, and a redirect URI derived from
    `server.publicUrl`. It carries no client secret and no PKCE verifier.
11. The discovery document is fetched on the first login attempt and never at startup or on a
    schedule, is cached thereafter, and a provider that cannot be reached is reported to the
    login screen as unreachable rather than as an internal error.
12. A discovery document is refused with a message naming what was wrong in each of these cases,
    each asserted separately: no authorization endpoint, no token endpoint, an `issuer` differing
    from the configured one, either endpoint not `https`, and
    `code_challenge_methods_supported` not containing `S256`.
13. A callback whose state is not the one issued is refused and creates no session, and a state
    is redeemable once.
14. The id_token is accepted only when `iss` matches the configured issuer, `aud` equals the
    client id, `exp` is in the future and `nonce` is the one issued. Each of the four failing is
    asserted separately.
15. The token endpoint is reached directly over `https`, asserted against the built outbound
    request rather than against a comment, so the reason the signature is not verified locally
    stays true.
16. An identity that is not on `auth.allow` is refused: no session, a 403 whose body names no
    address, and a log line recording that a login was refused and for which subject.
17. The first successful login pins the id_token's `sub` to the allowlist entry it matched, and a
    later login matching that entry with a different subject is refused.
18. The session cookie is `HttpOnly`, `SameSite=Lax` and `Path=/` with no `Domain`, carries
    `Secure` and the `__Host-` prefix whenever the public URL is `https`, and carries neither on
    a loopback `http` deployment.
19. The `sessions` row holds a hash of the session value and never the value, asserted by
    searching the database file for the value handed to the browser.
20. A session expires at the idle window or at the absolute cap, whichever is sooner, and an
    expired session is answered 401 on every route.
21. `POST /api/auth/logout` revokes the session and clears the cookie, and a request replaying
    the old cookie is answered 401.
22. Revoking or expiring a session closes the change feed that session opened, and a reconnect
    carrying it is answered 401 rather than served events.
23. A chat turn streaming when its session is revoked has its stream cut and its turn still
    recorded, so reloading the conversation shows it complete. This is spec 08 criterion 7 under
    revocation.
24. A request whose method is not `GET` or `HEAD` and whose `Origin` is present and is not the
    public origin is refused before it reaches a route, and no response on any route carries a
    CORS header.
25. No session value, authorization code, id_token or client secret appears in any log line or
    response body, and `GET /api/config` returns the `auth` block with `clientSecret` redacted by
    `secretPaths` and everything else present.
26. The session value presented by a request is matched against the stored hash by
    `crypto.timingSafeEqual` on equal-length buffers and by no other comparison, asserted over
    the lookup itself rather than by measuring how long it took.

**Slice 3: the second provider, proven.**

27. The whole flow runs against a second provider's recorded discovery document and token
    response with no code change, asserted by a fixture-driven test that names neither Google
    endpoint.
28. No module under `src/auth/` contains a Google host, endpoint or non-standard claim name,
    asserted by inspecting the source as spec 07 criterion 2 does for connector imports.
29. A provider returning no `email` claim is usable through an allowlist entry naming a subject,
    and an `email` without `email_verified: true` matches no address entry.
30. A provider whose discovery document offers `none` in `token_endpoint_auth_methods_supported`
    authenticates with PKCE and no client secret, and a provider whose document does not offer it
    fails at startup where no secret is configured, with a message naming
    `CAROLINE_AUTH_CLIENT_SECRET` and the methods the document did advertise.
