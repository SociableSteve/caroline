/**
 * The provider and the session, assembled. Spec 13, slice 2. Discovery is fetched lazily on the
 * first login attempt and cached for the life of the process; the login flow's state lives in
 * memory, one at a time, following the pattern `src/connectors/google/auth.ts` sets for the same
 * reason its own comment gives: there is one user and one browser.
 */
import type { Config } from '../config/schema.js'
import type { Database } from '../db/connection.js'
import {
  createSession,
  findValidSession,
  isSessionActive,
  revokeSession,
} from '../db/repositories/sessions.js'
import { checkAndPinSubject, matchAllowlistEntry } from './allowlist.js'
import { DiscoveryError, fetchDiscoveryDocument, type DiscoveryDocument } from './discovery.js'
import { decodeIdToken, validateIdToken } from './id-token.js'
import { redirectUri } from './origin.js'
import { createNonce, createPkce, createState } from './pkce.js'
import { notifySessionEnded } from './revocation.js'
import { exchangeToken } from './token.js'

export class AuthFlowError extends Error {
  override readonly name = 'AuthFlowError'
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

export interface AuthStatus {
  readonly authRequired: boolean
  readonly hasSession: boolean
  readonly providerLabel: string
}

export interface LoginResult {
  readonly url: string
}

export interface CallbackResult {
  readonly sessionId: string
  readonly cookieValue: string
  /** The hash `POST /api/auth/login` was given, so the callback can redirect back to it. */
  readonly hash: string | null
}

export interface AuthService {
  status(sessionValue: string | null): AuthStatus
  checkSession(sessionValue: string): { readonly id: string } | null
  login(hash: string | null): Promise<LoginResult>
  callback(params: { code?: string; state?: string; error?: string }): Promise<CallbackResult>
  /** Returns the id of the session that was revoked, or null where the cookie named none. */
  logout(sessionValue: string): string | null
  /**
   * A stream's own periodic check, by session id rather than by the cookie value it never
   * holds: whether the session it opened with is still on file. False means expired (the row
   * is revoked as a side effect) or already revoked by something else. Spec 13, criterion 22:
   * expiry closes a feed exactly as revocation does, and a feed sitting idle is the one case
   * nothing else visits the row to notice it.
   */
  sessionStillValid(id: string): boolean
}

export interface AuthServiceOptions {
  readonly config: Config
  readonly database: Database
  readonly now?: () => number
  readonly fetch?: typeof globalThis.fetch
  /** So the route can put the refusal in the request log. Spec 13, criterion 16. */
  readonly onLoginRefused?: (subject: string) => void
}

interface PendingFlow {
  readonly state: string
  readonly verifier: string
  readonly nonce: string
  readonly hash: string | null
}

function sessionExpiry(config: Config) {
  return {
    sessionIdleDays: config.auth.sessionIdleDays,
    sessionMaxDays: config.auth.sessionMaxDays,
  }
}

export function createAuthService({
  config,
  database,
  now = () => Date.now(),
  fetch,
  onLoginRefused,
}: AuthServiceOptions): AuthService {
  let discovery: DiscoveryDocument | null = null

  /** One at a time: a second `POST /api/auth/login` replaces the first, as the Google client's
   * own `begin` does, and for the same reason. */
  let pending: PendingFlow | null = null

  async function discover(): Promise<DiscoveryDocument> {
    discovery ??= await fetchDiscoveryDocument({
      issuer: config.auth.provider.issuer,
      ...(fetch === undefined ? {} : { fetch }),
    })
    return discovery
  }

  function checkSession(sessionValue: string): { readonly id: string } | null {
    return findValidSession(database, sessionValue, now(), sessionExpiry(config))
  }

  return {
    status(sessionValue) {
      return {
        authRequired: config.authRequired,
        hasSession: sessionValue !== null && checkSession(sessionValue) !== null,
        providerLabel: config.auth.provider.label,
      }
    },

    checkSession,

    sessionStillValid(id) {
      const active = isSessionActive(database, id, now(), sessionExpiry(config))
      if (!active) notifySessionEnded(id)
      return active
    },

    async login(hash) {
      const { clientId } = config.auth.provider
      if (clientId === null) {
        throw new AuthFlowError(500, 'internal_error', 'auth.provider.clientId is not set.')
      }

      const document = await discover()

      const pkce = createPkce()
      const state = createState()
      const nonce = createNonce()
      pending = { state, verifier: pkce.verifier, nonce, hash }

      const url = new URL(document.authorizationEndpoint)
      url.search = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri(config),
        response_type: 'code',
        scope: config.auth.provider.scopes.join(' '),
        state,
        nonce,
        code_challenge: pkce.challenge,
        code_challenge_method: 'S256',
      }).toString()

      return { url: url.toString() }
    },

    async callback({ code, state, error }) {
      if (error !== undefined) {
        throw new AuthFlowError(400, 'bad_request', `The provider refused the request: ${error}`)
      }

      const flow = pending
      if (flow === null || state === undefined || state !== flow.state) {
        throw new AuthFlowError(
          400,
          'bad_request',
          'That callback does not match the login Caroline started. Start again from the login screen.',
        )
      }

      // Redeemed here, whatever becomes of the rest of the exchange: a state is single-use
      // (criterion 13), and a verifier kept after one is a credential with nothing to authorise.
      pending = null

      if (code === undefined) {
        throw new AuthFlowError(400, 'bad_request', 'No authorization code was returned.')
      }

      const { clientId, clientSecret } = config.auth.provider
      if (clientId === null) {
        throw new AuthFlowError(500, 'internal_error', 'auth.provider.clientId is not set.')
      }

      let document: DiscoveryDocument
      try {
        document = await discover()
      } catch (discoveryError) {
        throw new AuthFlowError(
          502,
          'provider_unreachable',
          discoveryError instanceof Error ? discoveryError.message : 'The provider is unreachable.',
        )
      }

      const needsSecret = !document.tokenEndpointAuthMethodsSupported.includes('none')
      if (needsSecret && clientSecret === null) {
        throw new AuthFlowError(
          400,
          'bad_request',
          `This provider needs a client secret: set CAROLINE_AUTH_CLIENT_SECRET. It advertises ${
            document.tokenEndpointAuthMethodsSupported.join(', ') || 'no'
          } token endpoint auth method(s).`,
        )
      }

      let idToken: string
      try {
        const exchanged = await exchangeToken({
          tokenEndpoint: document.tokenEndpoint,
          code,
          redirectUri: redirectUri(config),
          codeVerifier: flow.verifier,
          clientId,
          clientSecret,
          ...(fetch === undefined ? {} : { fetch }),
        })
        idToken = exchanged.idToken
      } catch (tokenError) {
        throw new AuthFlowError(
          502,
          'provider_unreachable',
          tokenError instanceof Error ? tokenError.message : 'The token exchange failed.',
        )
      }

      const claims = decodeIdToken(idToken)
      try {
        validateIdToken(claims, {
          issuer: config.auth.provider.issuer,
          clientId,
          nonce: flow.nonce,
          now: now(),
        })
      } catch (claimError) {
        throw new AuthFlowError(
          400,
          'bad_request',
          claimError instanceof Error ? claimError.message : 'The id_token is not valid.',
        )
      }

      const entry = matchAllowlistEntry(config.auth.allow, claims)
      if (entry === null) {
        onLoginRefused?.(claims.sub)
        throw new AuthFlowError(
          403,
          'forbidden',
          'That account is not permitted to use this Caroline.',
        )
      }

      const pin = checkAndPinSubject(database, entry, claims.sub, now())
      if (!pin.ok) {
        onLoginRefused?.(claims.sub)
        throw new AuthFlowError(
          403,
          'forbidden',
          'That account is not permitted to use this Caroline.',
        )
      }

      const session = createSession(database, now())
      return { sessionId: session.id, cookieValue: session.value, hash: flow.hash }
    },

    logout(sessionValue) {
      const found = checkSession(sessionValue)
      if (found === null) return null

      revokeSession(database, found.id)
      notifySessionEnded(found.id)
      return found.id
    },
  }
}

export { DiscoveryError }
