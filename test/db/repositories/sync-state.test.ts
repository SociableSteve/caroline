import { describe, expect, it } from 'vitest'
import { getSyncCursor, setSyncCursor } from '../../../src/db/repositories/sync-state.js'
import { migratedDatabase } from '../../helpers/temp-database.js'

const AT = Date.UTC(2026, 0, 5, 9, 0)

describe('the sync cursor', () => {
  it('is null before a connector has ever run', () => {
    expect(getSyncCursor(migratedDatabase(), 'github')).toBeNull()
  })

  it('is kept per provider, so one connector cannot move another one along', () => {
    const database = migratedDatabase()

    setSyncCursor(database, 'github', AT, AT)

    expect(getSyncCursor(database, 'github')).toBe(AT)
    expect(getSyncCursor(database, 'gmail')).toBeNull()
  })

  it('is overwritten rather than duplicated', () => {
    const database = migratedDatabase()

    setSyncCursor(database, 'github', AT, AT)
    setSyncCursor(database, 'github', AT + 900_000, AT + 900_000)

    expect(getSyncCursor(database, 'github')).toBe(AT + 900_000)
  })

  it('refuses a provider the domain does not define', () => {
    const database = migratedDatabase()

    expect(() => setSyncCursor(database, 'jira' as unknown as 'github', AT, AT)).toThrow(
      /constraint/i,
    )
  })
})
