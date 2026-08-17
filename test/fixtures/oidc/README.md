# Recorded second-provider payloads

Spec 13, criterion 27: the whole login flow proven against a second provider's recorded
discovery document and token response, so `src/auth/` is shown to be generic rather than
merely described as generic. The provider here is fictional (`login.fictional-idp.test`,
a reserved test TLD per RFC 2606) and is neither Google nor modelled on any single real
provider; it exists only so the fixture names no Google endpoint.

Two fields a real provider's token response carries cannot be "recorded" as a static value
without either going stale or defeating the protocol property they exist for, so they are not
in these files and are filled in by the test instead:

- `exp`, because a fixed timestamp eventually lands in the past.
- `nonce`, because it is minted per login attempt and echoing back a fixed one is exactly
  what the nonce check exists to catch.

Everything else (the endpoints, the supported methods, the identity claims) is as recorded.

| File                                  | Is                                                                                                                                           |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `discovery-public-client.json`        | A discovery document offering `none` in `token_endpoint_auth_methods_supported`: a public client, PKCE only, no client secret (criterion 30) |
| `discovery-confidential-client.json`  | A discovery document offering no `none` method, only `client_secret_post` and `client_secret_basic` (criterion 30's other half)              |
| `identity-with-verified-email.json`   | An identity claim set with a verified `email`                                                                                                |
| `identity-sub-only.json`              | An identity claim set carrying no `email` at all, matchable only by a `sub:<value>` allowlist entry (criterion 29)                           |
| `identity-with-unverified-email.json` | An identity claim set with an `email` but `email_verified: false`, which matches no address entry (criterion 29)                             |
