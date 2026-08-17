/**
 * The authorisation server, assembled. Spec 12, slice 3: an authorisation endpoint whose consent
 * screen is on Caroline's own Settings surface, a token endpoint, PKCE with `S256` mandatory,
 * single-use authorisation codes, refresh, and port-agnostic matching of loopback redirect URIs.
 *
 * `beginAuthorization` is the one function that fetches a client's metadata document, and it is
 * called from nowhere but `GET /api/mcp/authorize`: no schedule, no startup path and no token
 * request ever reaches it (spec 12, criterion 38).
 */
import type { Config } from '../../config/schema.js'
import type { Database } from '../../db/connection.js'
import {
  approveClient,
  createOauthRequest,
  decideOauthRequest,
  findAccessGrant,
  findClient,
  findPendingOauthRequest,
  findRefreshGrant,
  issueAuthorizationCode,
  issueTokenPair,
  listApprovedClients,
  redeemAuthorizationCode,
  refreshAccessToken,
  revokeClient,
  upsertClient,
  type McpOauthClient,
  type McpOauthRequest,
} from '../../db/repositories/mcp-oauth.js'
import { verifyPkce } from '../../auth/pkce.js'
import { registerRuntimeSecret } from '../../config/redact.js'
import { fetchClientMetadata, ClientMetadataError } from './client-metadata.js'
import {
  isAcceptableRedirectUri,
  isRegisteredRedirectUri,
  redirectUriMatches,
} from './redirect-uri.js'
import { canonicalResourceUri } from './resource.js'

export class McpOauthError extends Error {
  override readonly name = 'McpOauthError'
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

function issuer(config: Config): string {
  return canonicalResourceUri(config).replace(/\/api\/mcp$/, '')
}

export interface AuthorizeParams {
  readonly responseType: string | undefined
  readonly clientId: string | undefined
  readonly redirectUri: string | undefined
  readonly codeChallenge: string | undefined
  readonly codeChallengeMethod: string | undefined
  readonly state: string | undefined
  readonly resource: string | undefined
}

export type BeginAuthorizationResult =
  | { readonly kind: 'redirect'; readonly url: string }
  | { readonly kind: 'consent'; readonly requestId: string; readonly client: McpOauthClient }

export interface McpOauthDeps {
  readonly config: Config
  readonly database: Database
  readonly now: () => number
  /** Injected in tests so the client metadata fetch never reaches a real network. */
  readonly fetchClientMetadata?: typeof fetchClientMetadata
}

function badRequest(message: string): never {
  throw new McpOauthError(400, 'invalid_request', message)
}

/**
 * `GET /api/mcp/authorize`. Validates the request, fetches and checks the client's metadata
 * document (the one guarded outbound fetch this surface makes), and either redirects straight
 * back with a code, for a client already approved, or hands back a pending request id for the
 * consent screen to read and decide. Spec 12, criterion 31: no client is issued a token until a
 * person has approved it once, but an approval already on file is not asked for twice.
 */
export async function beginAuthorization(
  deps: McpOauthDeps,
  params: AuthorizeParams,
): Promise<BeginAuthorizationResult> {
  const { config, database, now } = deps
  const fetchMetadata = deps.fetchClientMetadata ?? fetchClientMetadata

  if (params.responseType !== 'code') badRequest('response_type must be "code".')
  if (params.codeChallengeMethod !== 'S256' || !params.codeChallenge) {
    badRequest('code_challenge is required and code_challenge_method must be "S256".')
  }
  if (params.clientId === undefined || !/^https:\/\//.test(params.clientId)) {
    badRequest('client_id must be an https URL: the metadata document to fetch and check.')
  }
  if (params.redirectUri === undefined || !isAcceptableRedirectUri(params.redirectUri)) {
    badRequest('redirect_uri must be https, or http on a loopback host.')
  }

  const resource = params.resource ?? canonicalResourceUri(config)
  if (resource !== canonicalResourceUri(config)) {
    throw new McpOauthError(
      400,
      'invalid_target',
      'This authorisation server issues tokens for its own MCP endpoint only.',
    )
  }

  let document
  try {
    document = await fetchMetadata(params.clientId, {
      maxResponseBytes: config.mcp.clientMetadata.maxResponseBytes,
      timeoutMs: config.mcp.clientMetadata.timeoutMs,
    })
  } catch (error) {
    const detail = error instanceof ClientMetadataError ? error.message : String(error)
    throw new McpOauthError(
      400,
      'invalid_client',
      `The client metadata document could not be used: ${detail}`,
    )
  }

  if (!isRegisteredRedirectUri(params.redirectUri, document.redirectUris)) {
    badRequest('redirect_uri is not one this client declares in its own metadata document.')
  }

  upsertClient(
    database,
    {
      clientId: document.clientId,
      clientName: document.clientName,
      clientUri: document.clientUri,
      redirectUris: document.redirectUris,
    },
    now(),
  )

  const client = findClient(database, params.clientId)
  if (client === null) throw new Error('client row missing immediately after upsert')

  const preApproved = client.approvedAt !== null && client.revokedAt === null

  const request = createOauthRequest(
    database,
    {
      clientId: params.clientId,
      redirectUri: params.redirectUri,
      codeChallenge: params.codeChallenge,
      codeChallengeMethod: params.codeChallengeMethod,
      state: params.state ?? null,
      resource,
      preApproved,
    },
    now(),
  )

  if (!preApproved) return { kind: 'consent', requestId: request.id, client }

  decideOauthRequest(database, request.id, now())
  return { kind: 'redirect', url: redirectWithCode(deps, request) }
}

function redirectWithCode(deps: McpOauthDeps, request: McpOauthRequest): string {
  const { database, now, config } = deps
  const issued = issueAuthorizationCode(
    database,
    {
      clientId: request.clientId,
      redirectUri: request.redirectUri,
      codeChallenge: request.codeChallenge,
      codeChallengeMethod: request.codeChallengeMethod,
      resource: request.resource ?? canonicalResourceUri(config),
    },
    now(),
  )

  const url = new URL(request.redirectUri)
  url.searchParams.set('code', issued.code)
  if (request.state !== null) url.searchParams.set('state', request.state)
  // RFC 9207, advertised as supported in the authorisation server metadata: names which
  // authorisation server answered, so a client talking to more than one cannot be confused
  // about which one this response came from.
  url.searchParams.set('iss', issuer(config))
  return url.toString()
}

export interface ConsentView {
  readonly requestId: string
  readonly clientId: string
  readonly clientName: string | null
  readonly clientUri: string | null
  readonly redirectUri: string
}

/** What the consent screen on Settings reads to render itself. Null for a request that has
 * already been decided, has expired, or never existed. */
export function getConsentView(
  database: Database,
  requestId: string,
  now: number,
): ConsentView | null {
  const request = findPendingOauthRequest(database, requestId, now)
  if (request === null) return null

  const client = findClient(database, request.clientId)
  if (client === null) return null

  return {
    requestId: request.id,
    clientId: client.clientId,
    clientName: client.clientName,
    clientUri: client.clientUri,
    redirectUri: request.redirectUri,
  }
}

/**
 * A person's decision on the consent screen. Approving records the approval (remembered for
 * every future connection from this client, spec 12 criterion 31) and issues a code; denying
 * issues nothing. Either way the browser is sent back to the client's own redirect URI, which is
 * what lets a native client's loopback listener see the outcome at all.
 */
export function decideAuthorization(
  deps: McpOauthDeps,
  requestId: string,
  approve: boolean,
): string {
  const { database, now } = deps
  const request = findPendingOauthRequest(database, requestId, now())
  if (request === null) {
    throw new McpOauthError(
      400,
      'invalid_request',
      'That authorisation request has expired or was already decided.',
    )
  }

  decideOauthRequest(database, requestId, now())

  if (!approve) {
    const url = new URL(request.redirectUri)
    url.searchParams.set('error', 'access_denied')
    if (request.state !== null) url.searchParams.set('state', request.state)
    return url.toString()
  }

  approveClient(database, request.clientId, now())
  return redirectWithCode(deps, request)
}

export interface TokenResponse {
  readonly access_token: string
  readonly token_type: 'Bearer'
  readonly expires_in: number
  readonly refresh_token: string
}

function tokenError(message: string): never {
  throw new McpOauthError(400, 'invalid_grant', message)
}

export interface AuthorizationCodeGrant {
  readonly grantType: 'authorization_code'
  readonly code: string
  readonly redirectUri: string
  readonly clientId: string
  readonly codeVerifier: string
}

export interface RefreshTokenGrant {
  readonly grantType: 'refresh_token'
  readonly refreshToken: string
  readonly clientId: string | undefined
}

/** `POST /api/mcp/token`. Registers every issued value as a runtime secret through the same
 * mechanism Google's tokens already use, so the "no secret in a log line" guarantee covers a
 * value that exists only from here on, with no second mechanism invented for it (spec 12,
 * criterion 29). */
export function exchangeToken(
  deps: McpOauthDeps,
  grant: AuthorizationCodeGrant | RefreshTokenGrant,
): TokenResponse {
  const { database, now, config } = deps

  if (grant.grantType === 'authorization_code') {
    const redeemed = redeemAuthorizationCode(database, grant.code, now())
    if (redeemed === null)
      tokenError('That authorization code is unknown, already used, or expired.')

    if (redeemed.clientId !== grant.clientId)
      tokenError('client_id does not match the code that was issued.')
    if (!redirectUriMatches(grant.redirectUri, redeemed.redirectUri)) {
      tokenError('redirect_uri does not match the authorisation request.')
    }
    if (!verifyPkce(grant.codeVerifier, redeemed.codeChallenge)) {
      tokenError('code_verifier does not match the code_challenge from the authorisation request.')
    }

    const issued = issueTokenPair(
      database,
      { clientId: redeemed.clientId, resource: redeemed.resource },
      now(),
    )
    registerRuntimeSecret(config, issued.accessToken, 'rotating')
    registerRuntimeSecret(config, issued.refreshToken, 'lasting')

    return {
      access_token: issued.accessToken,
      token_type: 'Bearer',
      expires_in: Math.round((issued.accessExpiresAt - now()) / 1000),
      refresh_token: issued.refreshToken,
    }
  }

  const found = findRefreshGrant(database, grant.refreshToken, now())
  if (found === null) tokenError('That refresh token is unknown, revoked, or expired.')
  if (grant.clientId !== undefined && grant.clientId !== found.clientId) {
    tokenError('client_id does not match the token that was issued.')
  }

  const refreshed = refreshAccessToken(database, found.id, now())
  registerRuntimeSecret(config, refreshed.accessToken, 'rotating')

  return {
    access_token: refreshed.accessToken,
    token_type: 'Bearer',
    expires_in: Math.round((refreshed.accessExpiresAt - now()) / 1000),
    refresh_token: grant.refreshToken,
  }
}

export interface ValidatedToken {
  readonly clientId: string
}

/**
 * The resource server's own check (spec 12, criterion 28): a token found here is one Caroline
 * issued, unrevoked and unexpired; the audience check is against the canonical resource URI as
 * it is *now*, so a token issued before a reconfigured bind refuses rather than validating
 * against a resource it no longer names.
 */
export function validateAccessToken(
  config: Config,
  database: Database,
  presentedToken: string,
  now: number,
): ValidatedToken | null {
  const grant = findAccessGrant(database, presentedToken, now)
  if (grant === null) return null
  if (grant.resource !== canonicalResourceUri(config)) return null
  return { clientId: grant.clientId }
}

export { listApprovedClients, revokeClient }
