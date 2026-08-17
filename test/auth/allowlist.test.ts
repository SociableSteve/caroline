/**
 * `auth.allow` matching and subject pinning. Spec 13, "Who is allowed in" and criterion 17.
 * Pinning is against a real database, since it is a `settings` row.
 */
import { describe, expect, it } from 'vitest'
import { checkAndPinSubject, matchAllowlistEntry } from '../../src/auth/allowlist.js'
import { getPinnedSubject } from '../../src/db/repositories/settings.js'
import { migratedDatabase } from '../helpers/temp-database.js'

function claims(overrides: Record<string, unknown> = {}) {
  return {
    iss: 'https://idp.example.com',
    aud: 'client',
    exp: 0,
    sub: 'subject-1',
    nonce: null,
    email: 'owner@example.com',
    emailVerified: true,
    ...overrides,
  }
}

describe('matchAllowlistEntry', () => {
  it('matches a verified email against an address entry', () => {
    expect(matchAllowlistEntry(['owner@example.com'], claims())).toBe('owner@example.com')
  })

  it('does not match an email that is not verified', () => {
    expect(matchAllowlistEntry(['owner@example.com'], claims({ emailVerified: false }))).toBeNull()
  })

  it('matches sub: against the subject directly, with no email needed', () => {
    const noEmail = claims({ email: null, emailVerified: false, sub: 'subject-9' })
    expect(matchAllowlistEntry(['sub:subject-9'], noEmail)).toBe('sub:subject-9')
  })

  it('matches nobody when no entry fits', () => {
    expect(matchAllowlistEntry(['someone-else@example.com'], claims())).toBeNull()
  })

  it('does not treat a domain as a match: only exact address entries are supported', () => {
    expect(matchAllowlistEntry(['@example.com'], claims())).toBeNull()
  })
})

describe('checkAndPinSubject (criterion 17)', () => {
  it('pins the first successful login', () => {
    const database = migratedDatabase()

    const outcome = checkAndPinSubject(database, 'owner@example.com', 'subject-1', 1000)

    expect(outcome).toEqual({ ok: true })
    expect(getPinnedSubject(database, 'owner@example.com')).toBe('subject-1')
  })

  it('accepts a later login with the same subject', () => {
    const database = migratedDatabase()
    checkAndPinSubject(database, 'owner@example.com', 'subject-1', 1000)

    expect(checkAndPinSubject(database, 'owner@example.com', 'subject-1', 2000)).toEqual({
      ok: true,
    })
  })

  it('refuses a later login matching the same entry with a different subject', () => {
    const database = migratedDatabase()
    checkAndPinSubject(database, 'owner@example.com', 'subject-1', 1000)

    expect(checkAndPinSubject(database, 'owner@example.com', 'subject-2', 2000)).toEqual({
      ok: false,
      reason: 'subject-mismatch',
    })
    // The pin itself is unchanged by the refused attempt.
    expect(getPinnedSubject(database, 'owner@example.com')).toBe('subject-1')
  })

  it('is a settings row keyed by the allowlist entry, not anything tied to a session', () => {
    const database = migratedDatabase()
    checkAndPinSubject(database, 'owner@example.com', 'subject-1', 1000)

    expect(
      database.prepare("select value from settings where key = 'authPin:owner@example.com'").get(),
    ).toMatchObject({ value: 'subject-1' })
  })
})
