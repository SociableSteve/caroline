import type { Migration } from '../migrate.js'

/**
 * The MCP server's authorisation server, slice 3. Spec 12.
 *
 * Four tables, one per stage of the flow. `mcp_oauth_clients` is one row per client identifier
 * ever approved, keyed by the identifier itself, which is the URL of that client's metadata
 * document (spec 12, "What is deliberately not built": there is no registration endpoint to
 * mint a different kind of id). `mcp_oauth_requests` is the pending authorisation request a
 * `GET /api/mcp/authorize` call creates, which the consent screen on Settings reads and decides.
 * `mcp_oauth_codes` is a single-use authorisation code, redeemable once at the token endpoint.
 * `mcp_oauth_tokens` is an issued access/refresh pair.
 *
 * Every secret value here (an authorisation code, an access token, a refresh token) is stored
 * as a SHA-256 hash and never as the value itself, in exactly the shape `sessions` already uses
 * for a session cookie: the raw value is handed to the caller once, at the moment it is minted,
 * and is not recoverable from the database afterwards. Spec 09, criterion 6, extended to values
 * that arrive after startup (spec 12, criterion 29).
 */
export const mcpOauth: Migration = {
  id: 13,
  name: 'mcp-oauth',
  up(database) {
    database.exec(`
      create table mcp_oauth_clients (
        -- The client identifier: the https URL of its own metadata document. Spec 12: a client
        -- identifier that is a URL to fetch and check, not a credential Caroline mints.
        client_id text primary key,
        -- From the fetched metadata document, for the consent screen and the approved-clients
        -- list on Settings. Null where the document named none.
        client_name text,
        client_uri text,
        redirect_uris text not null default '[]',
        -- Null until a person approves it once on Caroline's own screen (spec 12, criterion 31).
        -- A row can exist unapproved while a request is pending a decision.
        approved_at integer,
        -- Set by a decision that denies the request, or by a later revocation from the approved
        -- clients list. A client is refused once revoked, and re-approving it inserts a fresh
        -- approval by clearing this rather than deleting the row, so its name and history stay
        -- on the Settings screen.
        revoked_at integer,
        created_at integer not null
      )
    `)

    database.exec(`
      create table mcp_oauth_requests (
        id text primary key,
        client_id text not null references mcp_oauth_clients (client_id) on delete cascade,
        redirect_uri text not null,
        code_challenge text not null,
        code_challenge_method text not null,
        state text,
        resource text,
        -- Whether this request found its client already approved, so the route can redirect
        -- straight to a code without landing on the consent screen at all (spec 12, criterion
        -- 31: approved once, not once per connection).
        pre_approved integer not null default 0 check (pre_approved in (0, 1)),
        decided_at integer,
        created_at integer not null,
        -- Short-lived: an authorisation request left undecided is abandoned rather than honoured
        -- indefinitely.
        expires_at integer not null
      )
    `)

    database.exec(`
      create table mcp_oauth_codes (
        id text primary key,
        code_hash text not null,
        client_id text not null references mcp_oauth_clients (client_id) on delete cascade,
        redirect_uri text not null,
        code_challenge text not null,
        code_challenge_method text not null,
        resource text not null,
        -- Single-use: set the moment the code is redeemed, and checked before it is (spec 12,
        -- criterion 27). A second redemption is refused and invalidates nothing else, so this
        -- is read and compared rather than the row being deleted on first use.
        redeemed_at integer,
        created_at integer not null,
        expires_at integer not null
      )
    `)
    database.exec('create index mcp_oauth_codes_hash on mcp_oauth_codes (code_hash)')

    database.exec(`
      create table mcp_oauth_tokens (
        id text primary key,
        client_id text not null references mcp_oauth_clients (client_id) on delete cascade,
        access_token_hash text not null,
        refresh_token_hash text not null,
        -- The resource this pair is valid for: Caroline's own canonical resource URI at the
        -- moment of issue, checked again on every request rather than assumed (spec 12,
        -- criterion 28). Stored rather than recomputed, so a token issued before a reconfigured
        -- bind stops working instead of silently validating against a resource it never named.
        resource text not null,
        access_expires_at integer not null,
        refresh_expires_at integer not null,
        revoked_at integer,
        created_at integer not null
      )
    `)
    database.exec(
      'create index mcp_oauth_tokens_access_hash on mcp_oauth_tokens (access_token_hash)',
    )
    database.exec(
      'create index mcp_oauth_tokens_refresh_hash on mcp_oauth_tokens (refresh_token_hash)',
    )
  },
}
