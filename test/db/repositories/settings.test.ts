/**
 * The settings table: facts about the person, as distinct from the configuration of the deployment.
 * Spec 09. Against a real database and the real migrations, as every repository test here is.
 */
import { describe, expect, it } from 'vitest'
import {
  getSetting,
  getUserName,
  setSetting,
  setUserName,
} from '../../../src/db/repositories/settings.js'
import { migratedDatabase } from '../../helpers/temp-database.js'

const NOW = Date.UTC(2026, 5, 1, 9, 0, 0)

describe('settings', () => {
  /** Every caller wants a value, and none of them wants to decide what a missing row means. */
  it('reads an unset key as null and an unset name as empty', () => {
    const database = migratedDatabase()

    expect(getSetting(database, 'userName')).toBeNull()
    expect(getUserName(database)).toBe('')
  })

  it('writes a value and reads it back', () => {
    const database = migratedDatabase()

    setUserName(database, 'Steve', NOW)

    expect(getUserName(database)).toBe('Steve')
  })

  it('replaces a value rather than accumulating rows for the key', () => {
    const database = migratedDatabase()

    setSetting(database, 'userName', 'Steve', NOW)
    setSetting(database, 'userName', 'Ana', NOW + 1000)

    expect(getUserName(database)).toBe('Ana')
    expect(database.prepare('select count(*) as n from settings').get()).toMatchObject({ n: 1 })
  })

  it('stamps when it was last written, so a later change is distinguishable', () => {
    const database = migratedDatabase()

    setSetting(database, 'userName', 'Steve', NOW)
    setSetting(database, 'userName', 'Ana', NOW + 1000)

    expect(
      database.prepare('select updated_at from settings where key = ?').get('userName'),
    ).toMatchObject({ updated_at: NOW + 1000 })
  })

  /** An empty name is a value, not an absence: it is how somebody declines to be named. */
  it('keeps an empty name as a written value', () => {
    const database = migratedDatabase()

    setUserName(database, 'Steve', NOW)
    setUserName(database, '', NOW + 1000)

    expect(getSetting(database, 'userName')).toBe('')
    expect(getUserName(database)).toBe('')
  })
})
