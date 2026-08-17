/**
 * `auth.allow`: an email address, matched against a verified, matching-issuer id_token email,
 * or `sub:<value>`, matched against the id_token's subject directly. Spec 13, "Who is allowed
 * in". No domain entries, no claim-on-first-login: an allowlist decided in the configuration
 * file, checked here.
 */
import { getPinnedSubject, setPinnedSubject } from '../db/repositories/settings.js'
import type { Database } from '../db/connection.js'
import type { IdTokenClaims } from './id-token.js'

const SUBJECT_PREFIX = 'sub:'

/**
 * The entry an id_token matches, or null where none does. An address entry matches only an
 * `email_verified: true` claim for the same address; a `sub:` entry matches the subject
 * directly, for a provider that returns no email at all.
 */
export function matchAllowlistEntry(
  allow: readonly string[],
  claims: IdTokenClaims,
): string | null {
  for (const entry of allow) {
    if (entry.startsWith(SUBJECT_PREFIX)) {
      if (entry.slice(SUBJECT_PREFIX.length) === claims.sub) return entry
      continue
    }
    if (claims.emailVerified && claims.email === entry) return entry
  }
  return null
}

export type PinOutcome =
  { readonly ok: true } | { readonly ok: false; readonly reason: 'subject-mismatch' }

/**
 * The first successful login against an entry pins the id_token's `sub` to it; a later login
 * matching the same entry with a different subject is refused. The pin is a `settings` row, so
 * it survives logout, every session's expiry and a restart. Spec 13, criterion 17.
 */
export function checkAndPinSubject(
  database: Database,
  entry: string,
  subject: string,
  now: number,
): PinOutcome {
  const pinned = getPinnedSubject(database, entry)

  if (pinned === null) {
    setPinnedSubject(database, entry, subject, now)
    return { ok: true }
  }

  if (pinned !== subject) return { ok: false, reason: 'subject-mismatch' }

  return { ok: true }
}
