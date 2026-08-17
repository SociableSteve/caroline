/**
 * The `sessions` table. Spec 13: an opaque random value in a cookie, with a row here holding
 * only its SHA-256 hash, never the value itself.
 *
 * The presented value is matched against every stored hash with `crypto.timingSafeEqual`
 * (criterion 26), never with `===` and never with a SQL equality on the value or its hash: the
 * rows are read in full and compared here, in code, so the comparison this criterion names is
 * the only one that ever runs.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { randomUUID } from 'node:crypto'
import type { Database } from '../connection.js'
import type { Row } from '../rows.js'

export interface SessionExpiry {
  readonly sessionIdleDays: number
  readonly sessionMaxDays: number
}

const DAY_MS = 24 * 60 * 60 * 1000

function hashOf(value: string): Buffer {
  return createHash('sha256').update(value).digest()
}

/** 32 bytes of `randomBytes`, base64url-encoded. Spec 13: not the Google client's helper, and not
 * its size (that is 16 bytes for a PKCE state; this is 32). */
export function createSessionValue(): string {
  return randomBytes(32).toString('base64url')
}

export interface CreatedSession {
  readonly id: string
  /** Handed to the browser once, in the `Set-Cookie` header, and never stored. */
  readonly value: string
}

export function createSession(
  database: Database,
  now: number,
  value: string = createSessionValue(),
): CreatedSession {
  const id = randomUUID()
  const hash = hashOf(value).toString('hex')

  database
    .prepare('insert into sessions (id, hash, created_at, last_seen_at) values (?, ?, ?, ?)')
    .run(id, hash, now, now)

  return { id, value }
}

interface SessionRow {
  readonly id: string
  readonly createdAt: number
  readonly lastSeenAt: number
}

function expiresAt(row: SessionRow, expiry: SessionExpiry): number {
  const idle = row.lastSeenAt + expiry.sessionIdleDays * DAY_MS
  const cap = row.createdAt + expiry.sessionMaxDays * DAY_MS
  return Math.min(idle, cap)
}

/**
 * Finds the row, if any, whose stored hash matches the presented value's hash, checks its
 * expiry, and touches `last_seen_at` on a hit. Every row is read and every comparison is
 * `timingSafeEqual` on the two (always equal-length, both SHA-256) buffers: there is no `where
 * hash = ?`, because that would be the "other comparison" criterion 26 rules out.
 */
export function findValidSession(
  database: Database,
  presentedValue: string,
  now: number,
  expiry: SessionExpiry,
): { readonly id: string } | null {
  const presented = hashOf(presentedValue)

  const rows = database.prepare('select id, hash, created_at, last_seen_at from sessions').all()

  for (const raw of rows) {
    const row = raw as Row
    const stored = Buffer.from(String(row.hash), 'hex')
    if (stored.length !== presented.length) continue
    if (!timingSafeEqual(stored, presented)) continue

    const session: SessionRow = {
      id: String(row.id),
      createdAt: Number(row.created_at),
      lastSeenAt: Number(row.last_seen_at),
    }

    if (now >= expiresAt(session, expiry)) {
      revokeSession(database, session.id)
      return null
    }

    database.prepare('update sessions set last_seen_at = ? where id = ?').run(now, session.id)
    return { id: session.id }
  }

  return null
}

export function revokeSession(database: Database, id: string): void {
  database.prepare('delete from sessions where id = ?').run(id)
}

/** Whether a session id is still a row on file. Used to tell revocation from expiry apart when
 * a stream's periodic check finds the session it opened with no longer valid. */
export function sessionExists(database: Database, id: string): boolean {
  return database.prepare('select 1 from sessions where id = ?').get(id) !== undefined
}

/**
 * A read-only liveness check by id, for a stream's own periodic check rather than for the
 * request-time credential check above: no hash is presented here, because the caller already
 * holds a session id it was given at a moment `findValidSession` validated. It does not touch
 * `last_seen_at`, deliberately: a heartbeat that kept extending the idle window every time it
 * ran would mean an open tab's session never idles out, which is the property `sessionIdleDays`
 * exists to have. Where the row has expired since it was last checked, it is revoked here so the
 * next reader (a request, or another stream's check) finds it gone rather than re-discovering
 * the same expiry. Spec 13, criterion 22: the row's absence is what a stream's own periodic
 * check has to notice, since nothing else visits it while it sits idle.
 */
export function isSessionActive(
  database: Database,
  id: string,
  now: number,
  expiry: SessionExpiry,
): boolean {
  const row = database.prepare('select created_at, last_seen_at from sessions where id = ?').get(id)
  if (row === undefined) return false

  const session: SessionRow = {
    id,
    createdAt: Number((row as Row).created_at),
    lastSeenAt: Number((row as Row).last_seen_at),
  }

  if (now >= expiresAt(session, expiry)) {
    revokeSession(database, id)
    return false
  }

  return true
}
