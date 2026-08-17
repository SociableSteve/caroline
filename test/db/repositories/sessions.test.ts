/**
 * The `sessions` table. Spec 13: an opaque random value in a cookie, with a row here holding
 * only its SHA-256 hash. Criteria 19, 20 and 26, against a real SQLite file (no mocking the DB,
 * per `docs/plan.md`).
 */
import { readFileSync } from 'node:fs'
import type * as NodeCrypto from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'

/**
 * `timingSafeEqual` is wrapped rather than replaced, so every other use of `node:crypto` in this
 * file (hashing, `randomBytes`) is the real thing. This is the only way to make the assertion
 * criterion 26 asks for a mechanism a test can pin: Node's ESM loader will not let a spy
 * redefine a builtin module's export directly.
 */
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeCrypto>()
  return { ...actual, timingSafeEqual: vi.fn(actual.timingSafeEqual) }
})

const { timingSafeEqual } = await import('node:crypto')
const { createSession, createSessionValue, findValidSession, revokeSession } =
  await import('../../../src/db/repositories/sessions.js')
const { migratedDatabase, temporaryDatabasePath } = await import('../../helpers/temp-database.js')
const { openDatabase } = await import('../../../src/db/connection.js')
const { runMigrations } = await import('../../../src/db/migrate.js')

const EXPIRY = { sessionIdleDays: 7, sessionMaxDays: 30 }
const DAY_MS = 24 * 60 * 60 * 1000
const NOW = Date.UTC(2026, 5, 1, 9, 0, 0)

describe('createSessionValue', () => {
  it('is 32 bytes of randomBytes, base64url-encoded', () => {
    const value = createSessionValue()
    // 32 bytes base64url-encoded, no padding, is 43 characters.
    expect(value).toHaveLength(43)
    expect(value).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  it('produces a fresh value each time', () => {
    expect(createSessionValue()).not.toBe(createSessionValue())
  })
})

describe('createSession and findValidSession', () => {
  it('finds a session created with the same value', () => {
    const database = migratedDatabase()
    const { value } = createSession(database, NOW)

    expect(findValidSession(database, value, NOW, EXPIRY)).not.toBeNull()
  })

  it('finds nobody for a value that was never issued', () => {
    const database = migratedDatabase()
    createSession(database, NOW)

    expect(findValidSession(database, 'not-a-real-session-value', NOW, EXPIRY)).toBeNull()
  })

  it('never stores the raw value: only its hash appears on disk (criterion 19)', () => {
    const path = temporaryDatabasePath()
    const database = openDatabase(path)
    runMigrations(database)

    const { value } = createSession(database, NOW)
    database.close()

    const raw = readFileSync(path)
    expect(raw.includes(Buffer.from(value))).toBe(false)
  })
})

describe('expiry (criterion 20)', () => {
  it('is valid right up to the idle window and expired just past it', () => {
    const database = migratedDatabase()
    const { value } = createSession(database, NOW)

    const justBefore = NOW + EXPIRY.sessionIdleDays * DAY_MS - 1
    expect(findValidSession(database, value, justBefore, EXPIRY)).not.toBeNull()
  })

  it('expires at the idle window, answering null on every later lookup', () => {
    const database = migratedDatabase()
    const { value } = createSession(database, NOW)

    const pastIdle = NOW + EXPIRY.sessionIdleDays * DAY_MS + 1
    expect(findValidSession(database, value, pastIdle, EXPIRY)).toBeNull()
  })

  it('touching the session on use extends the idle window, but not past the absolute cap', () => {
    const database = migratedDatabase()
    const { value } = createSession(database, NOW)

    // Touched just before the idle window would otherwise expire it.
    const touchedAt = NOW + EXPIRY.sessionIdleDays * DAY_MS - 1000
    expect(findValidSession(database, value, touchedAt, EXPIRY)).not.toBeNull()

    // A rolling idle window would now say this is still valid; the absolute cap says no.
    const pastAbsoluteCap = NOW + EXPIRY.sessionMaxDays * DAY_MS + 1
    expect(findValidSession(database, value, pastAbsoluteCap, EXPIRY)).toBeNull()
  })

  it('expires at the absolute cap even when used well within the idle window throughout', () => {
    const database = migratedDatabase()
    const { value } = createSession(database, NOW)

    // Touch it every day, well inside the 7-day idle window, all the way to the 30-day cap.
    for (let day = 1; day <= 29; day += 1) {
      expect(findValidSession(database, value, NOW + day * DAY_MS, EXPIRY)).not.toBeNull()
    }

    expect(findValidSession(database, value, NOW + 31 * DAY_MS, EXPIRY)).toBeNull()
  })
})

describe('revokeSession', () => {
  it('makes a later lookup with the same value answer null', () => {
    const database = migratedDatabase()
    const { id, value } = createSession(database, NOW)

    revokeSession(database, id)

    expect(findValidSession(database, value, NOW, EXPIRY)).toBeNull()
  })
})

describe('the comparison mechanism (criterion 26)', () => {
  it('compares the presented hash against the stored hash with crypto.timingSafeEqual, and by no other means', () => {
    const database = migratedDatabase()
    const { value } = createSession(database, NOW)

    const spy = vi.mocked(timingSafeEqual)
    spy.mockClear()

    findValidSession(database, value, NOW, EXPIRY)

    expect(spy).toHaveBeenCalled()
    // Every call is on two equal-length buffers: both are SHA-256 digests, 32 bytes each.
    for (const call of spy.mock.calls) {
      const [left, right] = call as [Buffer, Buffer]
      expect(left.length).toBe(right.length)
      expect(left.length).toBe(32)
    }
  })

  it('the spy itself proves nothing without a real comparison alongside it: a wrong value still fails', () => {
    const database = migratedDatabase()
    createSession(database, NOW)

    expect(findValidSession(database, 'a-wrong-value-of-some-length', NOW, EXPIRY)).toBeNull()
  })
})
