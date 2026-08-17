/**
 * The client's half of spec 13: whether a session is required and present, and the two actions
 * that change it. The login screen itself is a component; this is the state it and the shell
 * both read.
 *
 * `GET /api/auth/status` is read once on load, because the shell has to know whether to render a
 * surface or the login screen before it renders either, per spec 08 criterion 33. After that, a
 * 401 from any other call is what moves it into the login state (criterion 35): the status route
 * is not polled, because nothing short of a call actually failing needs to know sooner.
 */
import { useCallback, useEffect, useState } from 'react'
import { api, onUnauthorized } from './api.js'

/**
 * What `GET /api/auth/callback` names in `?login=<code>` on a refusal, mapped to what the login
 * screen says. Spec 13's own wording for the one case it specifies: "the login screen says that
 * the account is not permitted to use this Caroline" (criterion 16, and the subject-pinning
 * mismatch in criterion 17, which is refused the same way). Every other code
 * (`bad_request`, `provider_unreachable`, `internal_error`) is bucketed generically: none of
 * them are something the person looking at the login screen can act on, and the diagnostic that
 * would help an operator act on one is logged server-side rather than carried in the redirect.
 */
const LOGIN_FAILURE_MESSAGES: Readonly<Record<string, string>> = {
  forbidden: 'This account is not permitted to use this Caroline.',
}

const GENERIC_LOGIN_FAILURE_MESSAGE = 'Something went wrong signing in.'

/**
 * Reads `?login=<code>` from the URL the SPA loaded with, which is how a refused
 * `GET /api/auth/callback` reports itself: that route is a top-level browser navigation rather
 * than a call this client makes and can inspect, so the refusal cannot reach here any other
 * way. Returns null where there is nothing to report, which is every load except the one right
 * after a refused callback.
 */
function readLoginFailure(): string | null {
  const code = new URLSearchParams(window.location.search).get('login')
  if (code === null) return null
  return LOGIN_FAILURE_MESSAGES[code] ?? GENERIC_LOGIN_FAILURE_MESSAGE
}

/**
 * Drops `login` from the URL once it has been read, so a reload of this same tab does not show
 * the same failure a second time for a browser event (the callback redirect) that has already
 * happened once and will not happen again on a reload. `replaceState` rather than a navigation:
 * nothing else about the location, including the hash the router owns, should move.
 */
function clearLoginParam(): void {
  const url = new URL(window.location.href)
  url.searchParams.delete('login')
  window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`)
}

export interface AuthGate {
  /** Whether the first status check has answered. Nothing gates on `authenticated` before this
   * is true, so the common case (no login configured) never flashes a login screen while the
   * first request is still in flight. */
  readonly ready: boolean
  /** Whether this deployment requires a session at all. Where it does not, nothing here is
   * visible and nothing here changes behaviour: spec 13's loopback, no-login shape. */
  readonly authRequired: boolean
  readonly authenticated: boolean
  readonly providerLabel: string
  /** What went wrong starting, continuing or being refused a login, if anything. Cleared on the
   * next attempt. Populated on load from `?login=<code>` where the browser has just come back
   * from a refused `GET /api/auth/callback`, as well as by a failed `login()` call. */
  readonly failure: string | null
  /** Starts the flow for the hash the person is on, and sends the browser to the provider. */
  readonly login: (hash: string) => Promise<void>
  readonly logout: () => Promise<void>
}

export function useAuthGate(): AuthGate {
  const [ready, setReady] = useState(false)
  const [authRequired, setAuthRequired] = useState(false)
  const [hasSession, setHasSession] = useState(false)
  const [providerLabel, setProviderLabel] = useState('the provider')
  /** Set by a 401 from anywhere. Cleared only by a status read that finds a session again, which
   * a fresh login's redirect back into the app causes. */
  const [unauthorized, setUnauthorized] = useState(false)
  // The initializer runs once, before the effect below strips the param, so this is the one
  // chance to read it: by the time anything could re-render and re-read the URL, it is gone.
  const [failure, setFailure] = useState<string | null>(() => readLoginFailure())

  useEffect(() => {
    if (new URLSearchParams(window.location.search).has('login')) clearLoginParam()
  }, [])

  const refresh = useCallback(async () => {
    const status = await api.getAuthStatus()
    setAuthRequired(status.authRequired)
    setHasSession(status.hasSession)
    setProviderLabel(status.providerLabel)
    if (status.hasSession) setUnauthorized(false)
    setReady(true)
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    onUnauthorized(() => setUnauthorized(true))
    return () => onUnauthorized(null)
  }, [])

  const login = useCallback(async (hash: string) => {
    setFailure(null)
    try {
      const { url } = await api.login(hash.replace(/^#/, ''))
      // Google, or whichever provider is configured, is opened in this tab: the flow comes back
      // to this server's callback, which redirects into the SPA at the hash it was given.
      window.location.assign(url)
    } catch (error) {
      setFailure(error instanceof Error ? error.message : 'The login could not be started')
    }
  }, [])

  const logout = useCallback(async () => {
    try {
      await api.logout()
    } catch {
      // Deliberately swallowed, like login()'s catch: the point of signing out is to leave the
      // authenticated state, which the finally below does regardless of whether the server's
      // side of it (clearing the session cookie) actually landed. Surfacing this as a `failure`
      // would tell someone who is leaving that something went wrong when nothing they still
      // care about did.
    } finally {
      setUnauthorized(true)
    }
  }, [])

  return {
    ready,
    authRequired,
    // Optimistic until the first status read answers, which is what keeps the common case (no
    // login configured) rendering exactly as it always did rather than waiting a tick on every
    // load. `authRequired` starts false, so this is `true` until the first answer says
    // otherwise. Where authentication is not required at all, nothing about this is visible and
    // nothing behaves differently: spec 13's loopback shape. Where it is, a session is needed and
    // a 401 anywhere else is trusted over the last status read, so a revoked session takes effect
    // at once rather than waiting for the next thing that happens to re-read it.
    authenticated: !authRequired || (hasSession && !unauthorized),
    providerLabel,
    failure,
    login,
    logout,
  }
}
