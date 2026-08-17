/**
 * The id_token's claims, validated without its signature ever being checked. Spec 13, criterion
 * 14: `iss`, `aud`, `exp` and `nonce`, each failing case asserted separately.
 */
import { describe, expect, it } from 'vitest'
import { decodeIdToken, IdTokenError, validateIdToken } from '../../src/auth/id-token.js'
import { fakeIdToken } from '../helpers/oidc.js'

const ISSUER = 'https://idp.example.com'
const CLIENT_ID = 'a-client-id'
const NONCE = 'the-nonce'
const NOW = Date.UTC(2026, 5, 1, 9, 0, 0)

function validClaims() {
  return {
    iss: ISSUER,
    aud: CLIENT_ID,
    exp: Math.floor(NOW / 1000) + 3600,
    sub: 'subject-1',
    nonce: NONCE,
    email: 'owner@example.com',
    email_verified: true,
  }
}

function validate(overrides: Record<string, unknown> = {}) {
  const claims = decodeIdToken(fakeIdToken({ ...validClaims(), ...overrides }))
  validateIdToken(claims, { issuer: ISSUER, clientId: CLIENT_ID, nonce: NONCE, now: NOW })
}

describe('decodeIdToken', () => {
  it('reads the claims without checking a signature', () => {
    const claims = decodeIdToken(fakeIdToken(validClaims()))
    expect(claims).toMatchObject({
      iss: ISSUER,
      aud: CLIENT_ID,
      sub: 'subject-1',
      email: 'owner@example.com',
      emailVerified: true,
    })
  })

  it('refuses a token that is not three segments', () => {
    expect(() => decodeIdToken('not-a-jwt')).toThrow(IdTokenError)
  })

  it('reports no email as null rather than throwing', () => {
    const claims = decodeIdToken(fakeIdToken({ iss: ISSUER, aud: CLIENT_ID, exp: 1, sub: 's' }))
    expect(claims.email).toBeNull()
    expect(claims.emailVerified).toBe(false)
  })
})

describe('validateIdToken (criterion 14)', () => {
  it('accepts a token whose iss, aud, exp and nonce all match', () => {
    expect(() => validate()).not.toThrow()
  })

  it('refuses iss not matching the configured issuer', () => {
    expect(() => validate({ iss: 'https://someone-else.example.com' })).toThrow(IdTokenError)
  })

  it('refuses aud not equal to the client id', () => {
    expect(() => validate({ aud: 'a-different-client' })).toThrow(IdTokenError)
  })

  it('refuses exp in the past', () => {
    expect(() => validate({ exp: Math.floor(NOW / 1000) - 10 })).toThrow(IdTokenError)
  })

  it('refuses a nonce that is not the one issued', () => {
    expect(() => validate({ nonce: 'a-different-nonce' })).toThrow(IdTokenError)
  })
})
