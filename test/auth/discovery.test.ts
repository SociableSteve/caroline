/**
 * OIDC discovery. Spec 13, criterion 12: a discovery document is refused with a message naming
 * what was wrong, one case at a time. Nothing here reaches a network: every fetch is a stub.
 */
import { describe, expect, it } from 'vitest'
import {
  DiscoveryError,
  fetchDiscoveryDocument,
  ProviderUnreachableError,
} from '../../src/auth/discovery.js'

const ISSUER = 'https://idp.example.com'

function stub(document: Record<string, unknown>): typeof globalThis.fetch {
  return async () =>
    new Response(JSON.stringify(document), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
}

const validDocument = {
  issuer: ISSUER,
  authorization_endpoint: 'https://idp.example.com/authorize',
  token_endpoint: 'https://idp.example.com/token',
  code_challenge_methods_supported: ['S256'],
}

describe('fetchDiscoveryDocument', () => {
  it('accepts a well-formed document', async () => {
    const document = await fetchDiscoveryDocument({ issuer: ISSUER, fetch: stub(validDocument) })
    expect(document.authorizationEndpoint).toBe(validDocument.authorization_endpoint)
    expect(document.tokenEndpoint).toBe(validDocument.token_endpoint)
  })

  it('refuses no authorization_endpoint, naming it', async () => {
    const rest = Object.fromEntries(
      Object.entries(validDocument).filter(([key]) => key !== 'authorization_endpoint'),
    )
    await expect(fetchDiscoveryDocument({ issuer: ISSUER, fetch: stub(rest) })).rejects.toThrow(
      /authorization_endpoint/,
    )
  })

  it('refuses no token_endpoint, naming it', async () => {
    const rest = Object.fromEntries(
      Object.entries(validDocument).filter(([key]) => key !== 'token_endpoint'),
    )
    await expect(fetchDiscoveryDocument({ issuer: ISSUER, fetch: stub(rest) })).rejects.toThrow(
      /token_endpoint/,
    )
  })

  it('refuses an issuer differing from the configured one, naming both', async () => {
    await expect(
      fetchDiscoveryDocument({
        issuer: ISSUER,
        fetch: stub({ ...validDocument, issuer: 'https://someone-else.example.com' }),
      }),
    ).rejects.toThrow(/issuer/)
  })

  it('refuses an authorization_endpoint that is not https', async () => {
    await expect(
      fetchDiscoveryDocument({
        issuer: ISSUER,
        fetch: stub({
          ...validDocument,
          authorization_endpoint: 'http://idp.example.com/authorize',
        }),
      }),
    ).rejects.toThrow(DiscoveryError)
  })

  it('refuses a token_endpoint that is not https', async () => {
    await expect(
      fetchDiscoveryDocument({
        issuer: ISSUER,
        fetch: stub({ ...validDocument, token_endpoint: 'http://idp.example.com/token' }),
      }),
    ).rejects.toThrow(DiscoveryError)
  })

  it('refuses code_challenge_methods_supported not containing S256, naming it', async () => {
    await expect(
      fetchDiscoveryDocument({
        issuer: ISSUER,
        fetch: stub({ ...validDocument, code_challenge_methods_supported: ['plain'] }),
      }),
    ).rejects.toThrow(/S256/)
  })

  it('reports an unreachable provider as unreachable rather than as an internal error', async () => {
    const refuseNetwork: typeof globalThis.fetch = async () => {
      throw new Error('connection refused')
    }

    await expect(
      fetchDiscoveryDocument({ issuer: ISSUER, fetch: refuseNetwork }),
    ).rejects.toBeInstanceOf(ProviderUnreachableError)
  })

  it('reports a timeout as unreachable', async () => {
    const timesOut: typeof globalThis.fetch = async () => {
      const error = new Error('timed out')
      error.name = 'TimeoutError'
      throw error
    }

    await expect(
      fetchDiscoveryDocument({ issuer: ISSUER, fetch: timesOut }),
    ).rejects.toBeInstanceOf(ProviderUnreachableError)
  })

  it('reports a non-2xx response as unreachable rather than as a document error', async () => {
    const notFound: typeof globalThis.fetch = async () => new Response('not found', { status: 404 })

    await expect(
      fetchDiscoveryDocument({ issuer: ISSUER, fetch: notFound }),
    ).rejects.toBeInstanceOf(ProviderUnreachableError)
  })

  it('refuses discovery redirected to a different host, naming it', async () => {
    const redirectsAway: typeof globalThis.fetch = async () =>
      new Response(null, {
        status: 302,
        headers: { location: 'https://evil.example.com/.well-known/openid-configuration' },
      })

    await expect(fetchDiscoveryDocument({ issuer: ISSUER, fetch: redirectsAway })).rejects.toThrow(
      /evil\.example\.com/,
    )
  })

  it('follows one same-host redirect (its own www vs bare domain) but refuses a second', async () => {
    let calls = 0
    const redirectsOnceOnItsOwnHost: typeof globalThis.fetch = async () => {
      calls += 1
      if (calls === 1) {
        return new Response(null, {
          status: 302,
          headers: {
            location: 'https://idp.example.com/.well-known/openid-configuration/',
          },
        })
      }
      if (calls === 2) {
        return new Response(null, {
          status: 302,
          headers: {
            location: 'https://idp.example.com/.well-known/openid-configuration/again',
          },
        })
      }
      throw new Error('must not be called a third time')
    }

    await expect(
      fetchDiscoveryDocument({ issuer: ISSUER, fetch: redirectsOnceOnItsOwnHost }),
    ).rejects.toThrow(/redirected discovery more than once/)
    expect(calls).toBe(2)
  })

  it('refuses a redirect naming no location', async () => {
    const redirectsWithNoLocation: typeof globalThis.fetch = async () =>
      new Response(null, { status: 302 })

    await expect(
      fetchDiscoveryDocument({ issuer: ISSUER, fetch: redirectsWithNoLocation }),
    ).rejects.toThrow(/naming no location/)
  })

  it('refuses a non-https issuer before ever fetching', async () => {
    const shouldNotBeCalled: typeof globalThis.fetch = async () => {
      throw new Error('must not be called')
    }

    await expect(
      fetchDiscoveryDocument({ issuer: 'http://idp.example.com', fetch: shouldNotBeCalled }),
    ).rejects.toBeInstanceOf(DiscoveryError)
  })
})
