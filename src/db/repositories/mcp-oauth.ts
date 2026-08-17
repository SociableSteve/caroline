/**
 * The MCP authorisation server's own tables. Spec 12, slice 3.
 *
 * Every secret value (an authorisation code, an access token, a refresh token) is stored as a
 * SHA-256 hash and matched with `crypto.timingSafeEqual` over every row, in exactly the shape
 * `src/db/repositories/sessions.ts` already uses for a session cookie: the raw value is handed
 * to the caller once, at the moment it is minted, and the database never holds it again.
 */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import type { Database } from '../connection.js'
import type { Row } from '../rows.js'

function hashOf(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

/** 32 bytes of `randomBytes`, base64url-encoded, the same size `createSessionValue` uses. */
function opaqueValue(): string {
  return randomBytes(32).toString('base64url')
}

/**
 * Scans every row's hash with `timingSafeEqual` rather than a `where hash = ?`, for the reason
 * `findValidSession` already gives: a SQL equality on a secret's hash is the comparison spec 09
 * criterion 6 rules out just as much as one on the value itself would be.
 */
function findByHash<T extends { readonly hash: string }>(
  rows: readonly T[],
  presentedValue: string,
): T | null {
  const presented = Buffer.from(hashOf(presentedValue), 'hex')

  for (const row of rows) {
    const stored = Buffer.from(row.hash, 'hex')
    if (stored.length === presented.length && timingSafeEqual(stored, presented)) return row
  }

  return null
}

// ---------------------------------------------------------------------------------------------
// Clients
// ---------------------------------------------------------------------------------------------

export interface McpOauthClient {
  readonly clientId: string
  readonly clientName: string | null
  readonly clientUri: string | null
  readonly redirectUris: readonly string[]
  readonly approvedAt: number | null
  readonly revokedAt: number | null
  readonly createdAt: number
}

function toClient(row: Row): McpOauthClient {
  return {
    clientId: String(row.client_id),
    clientName: row.client_name === null ? null : String(row.client_name),
    clientUri: row.client_uri === null ? null : String(row.client_uri),
    redirectUris: parseStringArray(row.redirect_uris),
    approvedAt: row.approved_at === null ? null : Number(row.approved_at),
    revokedAt: row.revoked_at === null ? null : Number(row.revoked_at),
    createdAt: Number(row.created_at),
  }
}

function parseStringArray(value: unknown): readonly string[] {
  if (typeof value !== 'string') return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === 'string')
      : []
  } catch {
    return []
  }
}

export function findClient(database: Database, clientId: string): McpOauthClient | null {
  const row = database.prepare('select * from mcp_oauth_clients where client_id = ?').get(clientId)
  return row === undefined ? null : toClient(row as Row)
}

/**
 * Records the client this request named, from its freshly fetched metadata document, without
 * approving it: an authorisation request creates or refreshes this row on every attempt (the
 * name and redirect URIs are re-checked each time, spec 12's "The client metadata document
 * fetch"), and only a decision on Caroline's own screen sets `approved_at`.
 */
export function upsertClient(
  database: Database,
  input: {
    readonly clientId: string
    readonly clientName: string | null
    readonly clientUri: string | null
    readonly redirectUris: readonly string[]
  },
  now: number,
): void {
  database
    .prepare(
      `insert into mcp_oauth_clients (client_id, client_name, client_uri, redirect_uris, created_at)
       values (:client_id, :client_name, :client_uri, :redirect_uris, :created_at)
       on conflict (client_id) do update set
         client_name = :client_name, client_uri = :client_uri, redirect_uris = :redirect_uris`,
    )
    .run({
      client_id: input.clientId,
      client_name: input.clientName,
      client_uri: input.clientUri,
      redirect_uris: JSON.stringify(input.redirectUris),
      created_at: now,
    })
}

export function approveClient(database: Database, clientId: string, now: number): void {
  database
    .prepare('update mcp_oauth_clients set approved_at = ?, revoked_at = null where client_id = ?')
    .run(now, clientId)
}

export function revokeClient(database: Database, clientId: string, now: number): void {
  database
    .prepare('update mcp_oauth_clients set revoked_at = ? where client_id = ?')
    .run(now, clientId)
  database
    .prepare(
      'update mcp_oauth_tokens set revoked_at = ? where client_id = ? and revoked_at is null',
    )
    .run(now, clientId)
}

/** For the Settings surface: every client with an undecided revocation, newest first. A revoked
 * client is not "already approved" any more, so it belongs off this list even though its row
 * still carries the `approved_at` timestamp from before the revocation. */
export function listApprovedClients(database: Database): McpOauthClient[] {
  return database
    .prepare(
      `select * from mcp_oauth_clients
       where approved_at is not null and revoked_at is null
       order by approved_at desc`,
    )
    .all()
    .map((row) => toClient(row as Row))
}

// ---------------------------------------------------------------------------------------------
// Pending authorisation requests: the consent screen's own state
// ---------------------------------------------------------------------------------------------

export interface McpOauthRequest {
  readonly id: string
  readonly clientId: string
  readonly redirectUri: string
  readonly codeChallenge: string
  readonly codeChallengeMethod: string
  readonly state: string | null
  readonly resource: string | null
  readonly preApproved: boolean
  readonly decidedAt: number | null
  readonly expiresAt: number
}

function toRequest(row: Row): McpOauthRequest {
  return {
    id: String(row.id),
    clientId: String(row.client_id),
    redirectUri: String(row.redirect_uri),
    codeChallenge: String(row.code_challenge),
    codeChallengeMethod: String(row.code_challenge_method),
    state: row.state === null ? null : String(row.state),
    resource: row.resource === null ? null : String(row.resource),
    preApproved: Number(row.pre_approved) !== 0,
    decidedAt: row.decided_at === null ? null : Number(row.decided_at),
    expiresAt: Number(row.expires_at),
  }
}

/** Five minutes to look at a consent screen and decide. Not a setting: this is about a person
 * still being at the keyboard, not a rate anybody would tune. */
export const AUTHORIZATION_REQUEST_TTL_MS = 5 * 60_000

export function createOauthRequest(
  database: Database,
  input: {
    readonly clientId: string
    readonly redirectUri: string
    readonly codeChallenge: string
    readonly codeChallengeMethod: string
    readonly state: string | null
    readonly resource: string | null
    readonly preApproved: boolean
  },
  now: number,
): McpOauthRequest {
  const id = randomUUID()
  const expiresAt = now + AUTHORIZATION_REQUEST_TTL_MS

  database
    .prepare(
      `insert into mcp_oauth_requests
         (id, client_id, redirect_uri, code_challenge, code_challenge_method, state, resource,
          pre_approved, created_at, expires_at)
       values (:id, :client_id, :redirect_uri, :code_challenge, :code_challenge_method, :state,
          :resource, :pre_approved, :created_at, :expires_at)`,
    )
    .run({
      id,
      client_id: input.clientId,
      redirect_uri: input.redirectUri,
      code_challenge: input.codeChallenge,
      code_challenge_method: input.codeChallengeMethod,
      state: input.state,
      resource: input.resource,
      pre_approved: input.preApproved ? 1 : 0,
      created_at: now,
      expires_at: expiresAt,
    })

  return {
    id,
    clientId: input.clientId,
    redirectUri: input.redirectUri,
    codeChallenge: input.codeChallenge,
    codeChallengeMethod: input.codeChallengeMethod,
    state: input.state,
    resource: input.resource,
    preApproved: input.preApproved,
    decidedAt: null,
    expiresAt,
  }
}

/** An undecided, unexpired request, or null. The consent screen reads this to render what it is
 * showing; `decideOauthRequest` is what a person's click turns it into. */
export function findPendingOauthRequest(
  database: Database,
  id: string,
  now: number,
): McpOauthRequest | null {
  const row = database.prepare('select * from mcp_oauth_requests where id = ?').get(id)
  if (row === undefined) return null

  const request = toRequest(row as Row)
  if (request.decidedAt !== null || request.expiresAt <= now) return null
  return request
}

export function decideOauthRequest(database: Database, id: string, now: number): void {
  database.prepare('update mcp_oauth_requests set decided_at = ? where id = ?').run(now, id)
}

// ---------------------------------------------------------------------------------------------
// Authorisation codes
// ---------------------------------------------------------------------------------------------

export interface IssuedCode {
  readonly code: string
}

export interface McpOauthCode {
  readonly id: string
  readonly clientId: string
  readonly redirectUri: string
  readonly codeChallenge: string
  readonly codeChallengeMethod: string
  readonly resource: string
  readonly expiresAt: number
}

/** One minute, the usual bound for an authorisation code that is handed off through a redirect
 * rather than typed. */
export const AUTHORIZATION_CODE_TTL_MS = 60_000

export function issueAuthorizationCode(
  database: Database,
  input: {
    readonly clientId: string
    readonly redirectUri: string
    readonly codeChallenge: string
    readonly codeChallengeMethod: string
    readonly resource: string
  },
  now: number,
): IssuedCode {
  const code = opaqueValue()

  database
    .prepare(
      `insert into mcp_oauth_codes
         (id, code_hash, client_id, redirect_uri, code_challenge, code_challenge_method,
          resource, created_at, expires_at)
       values (:id, :code_hash, :client_id, :redirect_uri, :code_challenge,
          :code_challenge_method, :resource, :created_at, :expires_at)`,
    )
    .run({
      id: randomUUID(),
      code_hash: hashOf(code),
      client_id: input.clientId,
      redirect_uri: input.redirectUri,
      code_challenge: input.codeChallenge,
      code_challenge_method: input.codeChallengeMethod,
      resource: input.resource,
      created_at: now,
      expires_at: now + AUTHORIZATION_CODE_TTL_MS,
    })

  return { code }
}

/**
 * Redeems a code, single-use: found by scanning every unredeemed row's hash, and marked redeemed
 * in the same call so a second presentation of the same value finds nothing (spec 12, criterion
 * 27). Expired rows are treated as not found rather than deleted, so they stay diagnosable.
 */
export function redeemAuthorizationCode(
  database: Database,
  presentedCode: string,
  now: number,
): McpOauthCode | null {
  const rows = database
    .prepare('select * from mcp_oauth_codes where redeemed_at is null')
    .all()
    .map((raw) => {
      const row = raw as Row
      return {
        hash: String(row.code_hash),
        id: String(row.id),
        clientId: String(row.client_id),
        redirectUri: String(row.redirect_uri),
        codeChallenge: String(row.code_challenge),
        codeChallengeMethod: String(row.code_challenge_method),
        resource: String(row.resource),
        expiresAt: Number(row.expires_at),
      }
    })

  const found = findByHash(rows, presentedCode)
  if (found === null || found.expiresAt <= now) return null

  const changed = database
    .prepare('update mcp_oauth_codes set redeemed_at = ? where id = ? and redeemed_at is null')
    .run(now, found.id).changes

  // Lost a race to redeem the same code twice at once: the second caller finds nothing, exactly
  // as a second, later presentation of the same value does.
  if (changed === 0) return null

  const { hash, ...code } = found
  void hash
  return code
}

// ---------------------------------------------------------------------------------------------
// Access and refresh tokens
// ---------------------------------------------------------------------------------------------

export interface IssuedTokenPair {
  readonly accessToken: string
  readonly refreshToken: string
  readonly accessExpiresAt: number
}

export interface McpAccessGrant {
  readonly clientId: string
  readonly resource: string
  readonly revokedAt: number | null
  readonly accessExpiresAt: number
}

export interface McpRefreshGrant {
  readonly id: string
  readonly clientId: string
  readonly resource: string
  readonly revokedAt: number | null
  readonly refreshExpiresAt: number
}

/** An hour, the same order of magnitude Google's own access tokens use. */
export const ACCESS_TOKEN_TTL_MS = 60 * 60_000
/** Ninety days: long enough that a native client's refresh loop is never the reason a person
 * has to re-approve, short enough that an abandoned client's grant does not outlive its user. */
export const REFRESH_TOKEN_TTL_MS = 90 * 24 * 60 * 60_000

function insertTokenPair(
  database: Database,
  input: { readonly clientId: string; readonly resource: string },
  now: number,
): IssuedTokenPair {
  const accessToken = opaqueValue()
  const refreshToken = opaqueValue()
  const accessExpiresAt = now + ACCESS_TOKEN_TTL_MS
  const refreshExpiresAt = now + REFRESH_TOKEN_TTL_MS

  database
    .prepare(
      `insert into mcp_oauth_tokens
         (id, client_id, access_token_hash, refresh_token_hash, resource, access_expires_at,
          refresh_expires_at, created_at)
       values (:id, :client_id, :access_token_hash, :refresh_token_hash, :resource,
          :access_expires_at, :refresh_expires_at, :created_at)`,
    )
    .run({
      id: randomUUID(),
      client_id: input.clientId,
      access_token_hash: hashOf(accessToken),
      refresh_token_hash: hashOf(refreshToken),
      resource: input.resource,
      access_expires_at: accessExpiresAt,
      refresh_expires_at: refreshExpiresAt,
      created_at: now,
    })

  return { accessToken, refreshToken, accessExpiresAt }
}

/** The token endpoint's `grant_type=authorization_code` path: a fresh pair, tied to the code's
 * client and resource. */
export function issueTokenPair(
  database: Database,
  input: { readonly clientId: string; readonly resource: string },
  now: number,
): IssuedTokenPair {
  return insertTokenPair(database, input, now)
}

interface TokenRow {
  readonly id: string
  readonly clientId: string
  readonly resource: string
  readonly revokedAt: number | null
  readonly accessExpiresAt: number
  readonly refreshExpiresAt: number
}

function activeTokenRows(database: Database): TokenRow[] {
  return database
    .prepare('select * from mcp_oauth_tokens where revoked_at is null')
    .all()
    .map((raw) => {
      const row = raw as Row
      return {
        id: String(row.id),
        clientId: String(row.client_id),
        resource: String(row.resource),
        revokedAt: row.revoked_at === null ? null : Number(row.revoked_at),
        accessExpiresAt: Number(row.access_expires_at),
        refreshExpiresAt: Number(row.refresh_expires_at),
      }
    })
}

/**
 * The resource server's own check: does this bearer value match an access token Caroline issued
 * and has not revoked or expired. Spec 12, criterion 28: the audience (resource) check is the
 * caller's to make against the returned grant, not this function's, so a token issued for a
 * different resource is still found here and refused where it is checked.
 */
export function findAccessGrant(
  database: Database,
  presentedToken: string,
  now: number,
): McpAccessGrant | null {
  const rows = database
    .prepare('select * from mcp_oauth_tokens where revoked_at is null')
    .all()
    .map((raw) => {
      const row = raw as Row
      return { hash: String(row.access_token_hash), ...toGrantFields(row) }
    })

  const found = findByHash(rows, presentedToken)
  if (found === null || found.accessExpiresAt <= now) return null

  return {
    clientId: found.clientId,
    resource: found.resource,
    revokedAt: found.revokedAt,
    accessExpiresAt: found.accessExpiresAt,
  }
}

function toGrantFields(row: Row) {
  return {
    clientId: String(row.client_id),
    resource: String(row.resource),
    revokedAt: row.revoked_at === null ? null : Number(row.revoked_at),
    accessExpiresAt: Number(row.access_expires_at),
  }
}

/** The token endpoint's `grant_type=refresh_token` path: finds the row the presented value
 * matches, checked live rather than cached, so a revocation from the Settings screen takes
 * effect on the very next refresh. */
export function findRefreshGrant(
  database: Database,
  presentedToken: string,
  now: number,
): McpRefreshGrant | null {
  const rows = database
    .prepare('select * from mcp_oauth_tokens where revoked_at is null')
    .all()
    .map((raw) => {
      const row = raw as Row
      return {
        hash: String(row.refresh_token_hash),
        id: String(row.id),
        ...toGrantFields(row),
        refreshExpiresAt: Number(row.refresh_expires_at),
      }
    })

  const found = findByHash(rows, presentedToken)
  if (found === null || found.refreshExpiresAt <= now) return null

  return {
    id: found.id,
    clientId: found.clientId,
    resource: found.resource,
    revokedAt: found.revokedAt,
    refreshExpiresAt: found.refreshExpiresAt,
  }
}

/**
 * Mints a new access token against an existing, still-valid refresh token, rather than a new
 * pair: the refresh token is not rotated, so a client that has cached it keeps working, and
 * revocation reaches every access token a refresh has ever produced through `revokeClient`
 * naming the client rather than a chain of grants to walk.
 */
export function refreshAccessToken(
  database: Database,
  refreshGrantId: string,
  now: number,
): { readonly accessToken: string; readonly accessExpiresAt: number } {
  const accessToken = opaqueValue()
  const accessExpiresAt = now + ACCESS_TOKEN_TTL_MS

  database
    .prepare(
      'update mcp_oauth_tokens set access_token_hash = ?, access_expires_at = ? where id = ?',
    )
    .run(hashOf(accessToken), accessExpiresAt, refreshGrantId)

  return { accessToken, accessExpiresAt }
}

/** For tests and the Settings screen: whether anything has been issued for a client at all. */
export function hasActiveGrant(database: Database, clientId: string): boolean {
  return activeTokenRows(database).some((row) => row.clientId === clientId)
}
