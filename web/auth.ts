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
  /** What went wrong starting or continuing the login, if anything. Cleared on the next attempt. */
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
  const [failure, setFailure] = useState<string | null>(null)

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
