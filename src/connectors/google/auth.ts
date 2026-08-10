/**
 * Google authentication as the rest of the process sees it: "give me an access token", "is this
 * connected", and the two halves of the consent flow. The token file and the HTTP calls live
 * next door; this is where they meet the configuration. Spec 09.
 */
import { registerRuntimeSecret } from '../../config/redact.js'
import type { Config } from '../../config/schema.js'
import {
  authorizationUrl,
  createPkce,
  createState,
  exchangeCode,
  GoogleAuthError,
  isExpired,
  refreshAccessToken,
  type TokenSet,
} from './oauth.js'
import { deleteTokens, readTokens, writeTokens, type StoredTokens } from './tokens.js'

/**
 * Where Google sends the browser back to. The desktop flow's loopback redirect, which is the
 * one address a local single-user tool can offer: Caroline is already listening on it.
 */
export function redirectUriFor(config: Config): string {
  const host = config.server.host === '::1' ? '[::1]' : config.server.host
  return `http://${host}:${config.server.port}/api/integrations/google/callback`
}

export interface GoogleConnection {
  readonly connected: boolean
  readonly connectedAt: number | null
  readonly scopes: readonly string[]
  /** True when a client id and secret are configured, which consent needs before it can start. */
  readonly configured: boolean
}

export interface GoogleAuth {
  /** True when there is a refresh token to work with. */
  isConnected(): boolean
  status(): GoogleConnection
  /**
   * A valid access token, refreshing and re-persisting if the cached one has expired. Throws
   * `GoogleAuthError` when nothing is connected, so a caller asks `isConnected` first.
   */
  accessToken(): Promise<string>
  /** Starts consent: returns the URL to open. The PKCE verifier is kept in memory until it. */
  begin(): { readonly url: string; readonly state: string }
  /** Finishes consent. Rejects a callback whose state is not the one `begin` handed out. */
  complete(code: string, state: string): Promise<void>
  /** Forgets the tokens. Returns false when there were none. */
  disconnect(): boolean
}

export interface GoogleAuthOptions {
  readonly config: Config
  readonly fetch?: typeof globalThis.fetch
  readonly now?: () => number
}

export function createGoogleAuth({
  config,
  fetch,
  now = () => Date.now(),
}: GoogleAuthOptions): GoogleAuth {
  const { tokenPath } = config.integrations.google

  /**
   * Read once and kept, because every Gmail call asks for a token and reading a file each time
   * would be a syscall per request for a value that only this process changes.
   */
  let tokens: StoredTokens | null = readTokens(tokenPath)
  register(tokens)

  /** The flow in progress. One at a time: there is one user and one browser. */
  let pending: { state: string; verifier: string } | null = null

  function register(stored: StoredTokens | null): void {
    if (stored === null) return
    // Neither token is in the configuration, so the log scrubber has to be told about them or
    // it could not scrub what it has never seen. Spec 09, criterion 6.
    registerRuntimeSecret(config, stored.refreshToken)
    registerRuntimeSecret(config, stored.accessToken)
  }

  function credentials(): { clientId: string; clientSecret: string } {
    const { clientId, clientSecret } = config.integrations.google
    if (clientId === null || clientSecret === null) {
      throw new GoogleAuthError(
        'Google is not configured. Set integrations.google.clientId and the GOOGLE_CLIENT_SECRET environment variable, then connect the account.',
      )
    }
    return { clientId, clientSecret }
  }

  /**
   * `connectedAt` is when consent was given, so a refresh keeps the previous moment and a fresh
   * consent takes now. `previous` is what a response with no refresh token in it falls back to:
   * a refresh never returns one, and a repeat consent sometimes does not either.
   */
  function persist(set: TokenSet, previous: StoredTokens | null, connectedAt?: number): void {
    const refreshToken = set.refreshToken ?? previous?.refreshToken
    if (refreshToken === undefined) {
      throw new GoogleAuthError(
        'Google returned no refresh token, so Caroline could not keep access. Remove Caroline from your Google account permissions and connect it again.',
      )
    }

    const stored: StoredTokens = {
      refreshToken,
      accessToken: set.accessToken,
      expiresAt: set.expiresAt,
      scope: set.scope ?? previous?.scope ?? null,
      connectedAt: connectedAt ?? previous?.connectedAt ?? now(),
    }

    writeTokens(tokenPath, stored)
    tokens = stored
    register(stored)
  }

  return {
    isConnected: () => tokens !== null,

    status() {
      return {
        connected: tokens !== null,
        connectedAt: tokens?.connectedAt ?? null,
        scopes:
          tokens?.scope === null || tokens?.scope === undefined ? [] : tokens.scope.split(' '),
        configured: config.integrations.google.configured,
      }
    },

    async accessToken() {
      const current = tokens
      if (current === null) {
        throw new GoogleAuthError('No Google account is connected. Connect one from Settings.')
      }

      if (
        current.accessToken !== null &&
        current.expiresAt !== null &&
        !isExpired(current.expiresAt, now())
      ) {
        return current.accessToken
      }

      const { clientId, clientSecret } = credentials()
      const refreshed = await refreshAccessToken({
        refreshToken: current.refreshToken,
        clientId,
        clientSecret,
        now,
        ...(fetch === undefined ? {} : { fetch }),
      })

      persist(refreshed, current)
      return refreshed.accessToken
    },

    begin() {
      const { clientId } = credentials()
      const pkce = createPkce()
      const state = createState()

      // A second attempt replaces the first rather than queueing: the user pressed the button
      // again because the first one did not work, and the stale verifier is of no use to anyone.
      pending = { state, verifier: pkce.verifier }

      return {
        url: authorizationUrl({
          clientId,
          redirectUri: redirectUriFor(config),
          state,
          codeChallenge: pkce.challenge,
        }),
        state,
      }
    },

    async complete(code, state) {
      const flow = pending
      if (flow === null) {
        throw new GoogleAuthError(
          'There is no Google authorisation in progress. Start again from Settings.',
        )
      }
      if (state !== flow.state) {
        throw new GoogleAuthError('That Google callback does not match the request Caroline made.')
      }

      const { clientId, clientSecret } = credentials()
      const set = await exchangeCode({
        code,
        redirectUri: redirectUriFor(config),
        codeVerifier: flow.verifier,
        clientId,
        clientSecret,
        now,
        ...(fetch === undefined ? {} : { fetch }),
      })

      // Spent, whatever became of the exchange: an authorisation code is single-use, and a
      // verifier kept after one is a credential with nothing to authorise.
      pending = null
      persist(set, tokens, now())
    },

    disconnect() {
      const had = tokens !== null
      const removed = deleteTokens(tokenPath)
      tokens = null
      return had || removed
    },
  }
}
