/**
 * Spec 13's public origin, acceptable-origins set and redirect URI. Criterion 34 is the point of
 * this file: every derivation is checked by parsing both the derived value and the expected one
 * and comparing the parsed origins, never by matching strings, because an IPv4-mapped IPv6
 * address is the one case where the two differ and a string comparison would fail on a value
 * that is in fact right.
 */
import { describe, expect, it } from 'vitest'
import { loadConfig } from '../../src/config/load.js'
import {
  isAcceptableOrigin,
  originFromHostPort,
  publicOrigin,
  redirectUri,
} from '../../src/auth/origin.js'

const noEnv = {} as NodeJS.ProcessEnv

function configWithHost(host: string, port = 5123) {
  return loadConfig({ file: { server: { host, port } }, env: noEnv })
}

describe('originFromHostPort (criterion 34)', () => {
  it.each([
    ['127.0.0.1', 'http://127.0.0.1:5123'],
    ['localhost', 'http://localhost:5123'],
    ['::1', 'http://[::1]:5123'],
    // The one case where the configured string and the parsed origin differ: WHATWG parsing
    // normalises an IPv4-mapped IPv6 literal, so the expected value here is parsed too rather
    // than pasted as the literal `http://[::ffff:127.0.0.1]:5123`, which would fail on a
    // derivation that is in fact correct.
    ['::ffff:127.0.0.1', 'http://[::ffff:127.0.0.1]:5123'],
  ])('derives a well-formed origin for %s', (host, expectedLiteral) => {
    const derived = originFromHostPort('http', host, 5123)

    expect(new URL(derived).origin).toBe(new URL(expectedLiteral).origin)
  })

  it('gives the unbracketed forms this criterion says would be a bug', () => {
    // These do not parse at all, which is exactly what makes them wrong: a bracket-free IPv6
    // literal in a URL is not a well-formed one.
    expect(() => new URL('http://::1:5123')).toThrow()
    expect(() => new URL('http://::ffff:127.0.0.1:5123')).toThrow()
  })
})

describe('publicOrigin', () => {
  it('is the bind and port over http where server.publicUrl is unset', () => {
    const config = configWithHost('127.0.0.1', 5999)
    expect(new URL(publicOrigin(config)).origin).toBe(new URL('http://127.0.0.1:5999').origin)
  })

  it('is the configured publicUrl origin where it is set', () => {
    const config = loadConfig({
      file: {
        server: { publicUrl: 'https://caroline.example.com/' },
        auth: { allow: ['owner@example.com'], provider: { clientId: 'a-client-id' } },
      },
      env: noEnv,
    })
    expect(publicOrigin(config)).toBe('https://caroline.example.com')
  })

  it('derives an IPv6 redirect URI in brackets (criterion 34)', () => {
    const config = configWithHost('::1', 5123)
    expect(new URL(redirectUri(config)).origin).toBe(new URL('http://[::1]:5123').origin)
    expect(redirectUri(config)).toBe('http://[::1]:5123/api/auth/callback')
  })
})

describe('isAcceptableOrigin (criterion 24)', () => {
  it('accepts the publicUrl origin, and refuses another site, when it is set', () => {
    const config = loadConfig({
      file: {
        server: { publicUrl: 'https://caroline.example.com' },
        auth: { allow: ['owner@example.com'], provider: { clientId: 'a-client-id' } },
      },
      env: noEnv,
    })

    expect(isAcceptableOrigin(config, 'https://caroline.example.com')).toBe(true)
    expect(isAcceptableOrigin(config, 'https://evil.example.com')).toBe(false)
    expect(isAcceptableOrigin(config, 'http://caroline.example.com')).toBe(false)
    // The fully qualified spelling of the same name, which is what a browser puts in `Origin`
    // when the address bar carries the root label's dot. Accepted for the reason
    // `isAcceptableHost` accepts it: otherwise a write from the SPA is refused on a name this
    // install does answer to. The scheme still has to match, and only one dot is normalised.
    expect(isAcceptableOrigin(config, 'https://caroline.example.com.')).toBe(true)
    expect(isAcceptableOrigin(config, 'http://caroline.example.com.')).toBe(false)
    expect(isAcceptableOrigin(config, 'https://caroline.example.com..')).toBe(false)
  })

  it('accepts the loopback origins beside the publicUrl origin, rather than instead of them', () => {
    // One set, whatever the public URL says, for the reason the `Host` check has one rule: the
    // MCP endpoint accepts a loopback `Origin` and nothing else, so a gate that refused every
    // loopback origin on an install naming a public URL left the two checks unsatisfiable
    // together and the endpoint permanently unreachable. What the loopback origins concede is
    // software already running on the user's own machine, which spec 09 says loopback was never
    // a boundary against in the first place.
    const config = loadConfig({
      file: {
        server: { publicUrl: 'https://caroline.example.com' },
        auth: { allow: ['owner@example.com'], provider: { clientId: 'a-client-id' } },
      },
      env: noEnv,
    })

    expect(isAcceptableOrigin(config, 'http://127.0.0.1:5123')).toBe(true)
    expect(isAcceptableOrigin(config, 'http://localhost:5173')).toBe(true)
  })

  it('accepts a loopback origin on a loopback publicUrl reached by another loopback name', () => {
    // `server.publicUrl: "http://127.0.0.1:5123"` is permitted by the startup guards, and the SPA
    // served at `http://localhost:5123` sends `Origin: http://localhost:5123` on every write. A
    // rule naming only the public URL's own origin refused all of them.
    const config = loadConfig({
      file: {
        server: { publicUrl: 'http://127.0.0.1:5123' },
        auth: { allow: ['owner@example.com'], provider: { clientId: 'a-client-id' } },
      },
      env: noEnv,
    })

    expect(isAcceptableOrigin(config, 'http://localhost:5123')).toBe(true)
    expect(isAcceptableOrigin(config, 'https://evil.example.com')).toBe(false)
  })

  it('accepts every loopback origin on any port and either scheme when publicUrl is unset (criterion 33)', () => {
    const config = configWithHost('127.0.0.1', 5123)

    expect(isAcceptableOrigin(config, 'http://127.0.0.1:5123')).toBe(true)
    // The exact bind string is not privileged: a different loopback name on a different port
    // (the Vite dev server's own) is accepted just the same.
    expect(isAcceptableOrigin(config, 'http://localhost:5173')).toBe(true)
    expect(isAcceptableOrigin(config, 'https://localhost:5123')).toBe(true)
    expect(isAcceptableOrigin(config, 'http://[::1]:9999')).toBe(true)
  })

  it('accepts the normalised form of an IPv4-mapped IPv6 loopback origin (criterion 34)', () => {
    // A browser reaching a `::ffff:127.0.0.1` bind sends `Origin: http://[::ffff:7f00:1]:<port>`,
    // because WHATWG URL parsing normalises the IPv4-mapped literal. The redirect URI this
    // install derives for itself is normalised the same way, so a login started from that origin
    // must not be refused by the very check the login flow itself has to pass.
    const config = configWithHost('::ffff:127.0.0.1', 5123)
    expect(isAcceptableOrigin(config, 'http://[::ffff:7f00:1]:5123')).toBe(true)
    expect(isAcceptableOrigin(config, redirectUri(config).replace('/api/auth/callback', ''))).toBe(
      true,
    )
  })

  it('refuses a non-loopback origin when publicUrl is unset', () => {
    const config = configWithHost('127.0.0.1', 5123)
    expect(isAcceptableOrigin(config, 'http://example.com')).toBe(false)
  })

  it('refuses a malformed Origin header rather than throwing', () => {
    const config = configWithHost('127.0.0.1', 5123)
    expect(isAcceptableOrigin(config, 'not a url')).toBe(false)
  })
})
