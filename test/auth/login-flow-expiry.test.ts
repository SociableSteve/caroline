/**
 * Spec 13, "One login flow at a time": the pending flow now expires. It holds a state, a PKCE
 * verifier and a nonce, and it held them for as long as the process ran, so a flow somebody
 * abandoned at the provider's password screen in the morning was still redeemable in the evening.
 * Every other bounded thing in this codebase says how long it is good for, and the MCP
 * authorisation request next door is the same shape of fact with the same reasoning behind its
 * bound: a person at a keyboard, not a rate anybody would tune.
 */
import { describe, expect, it } from 'vitest'
import { loadConfig } from '../../src/config/load.js'
import { createAuthService, LOGIN_FLOW_TTL_MS } from '../../src/auth/service.js'
import { migratedDatabase } from '../helpers/temp-database.js'
import { stubProvider, TEST_ISSUER } from '../helpers/oidc.js'

/**
 * Real time rather than a pinned instant, unusually for this suite: the stub provider mints an
 * `exp` an hour from the wall clock, and this test's whole subject is a clock it moves itself, so
 * a fixed `NOW` would put the injected clock hours away from the token's own validity and fail on
 * the id_token rather than on the flow. The offsets below are what matters here, not the instant.
 */
const NOW = Date.now()

function service(now: () => number) {
  const config = loadConfig({
    file: {
      auth: {
        mode: 'required',
        allow: ['owner@example.com'],
        provider: { issuer: TEST_ISSUER, clientId: 'a-client-id' },
      },
    },
    env: {} as NodeJS.ProcessEnv,
  })

  return createAuthService({
    config,
    database: migratedDatabase(),
    now,
    fetch: stubProvider().fetch,
  })
}

/** The stub carries the nonce through as the authorization code, as the route tests do. */
function flowFrom(url: string) {
  const parsed = new URL(url)
  return {
    state: parsed.searchParams.get('state') ?? '',
    code: parsed.searchParams.get('nonce') ?? '',
  }
}

describe('the pending login flow (criterion 35)', () => {
  it('is redeemable inside the window', async () => {
    let clock = NOW
    const auth = service(() => clock)

    const { url } = await auth.login(null)
    const { state, code } = flowFrom(url)
    clock = NOW + LOGIN_FLOW_TTL_MS - 1

    await expect(auth.callback({ code, state })).resolves.toMatchObject({
      sessionId: expect.any(String),
    })
  })

  it('is refused once the window has passed, in the wording a stale state already gets', async () => {
    let clock = NOW
    const auth = service(() => clock)

    const { url } = await auth.login(null)
    const { state, code } = flowFrom(url)
    clock = NOW + LOGIN_FLOW_TTL_MS + 1

    await expect(auth.callback({ code, state })).rejects.toThrow(
      /Start again from the login screen/,
    )
  })

  it('discards the expired flow rather than leaving it to be redeemed at the right moment', async () => {
    let clock = NOW
    const auth = service(() => clock)

    const { url } = await auth.login(null)
    const { state, code } = flowFrom(url)
    clock = NOW + LOGIN_FLOW_TTL_MS + 1
    await expect(auth.callback({ code, state })).rejects.toThrow()

    // Back inside a window it can no longer be inside: the verifier is gone, not merely hidden.
    clock = NOW
    await expect(auth.callback({ code, state })).rejects.toThrow(
      /Start again from the login screen/,
    )
  })

  it('bounds the flow at ten minutes', () => {
    expect(LOGIN_FLOW_TTL_MS).toBe(10 * 60_000)
  })
})
