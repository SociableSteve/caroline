import type { Database } from '../connection.js'
import type { Row } from '../rows.js'
import type { SettingKey } from '../../domain/settings.js'

/**
 * The settings table: facts about the person using Caroline, as distinct from the configuration of
 * the deployment they run it in. Spec 09.
 *
 * An unset key reads as its default rather than as an absence, because every caller of these wants
 * a value and none of them wants to decide what a missing row means.
 */
export function getSetting(database: Database, key: SettingKey): string | null {
  const row = database.prepare('select value from settings where key = ?').get(key)
  if (row === undefined) return null

  const value = (row as Row).value
  return typeof value === 'string' ? value : null
}

export function setSetting(database: Database, key: SettingKey, value: string, now: number): void {
  database
    .prepare(
      `insert into settings (key, value, updated_at) values (?, ?, ?)
       on conflict (key) do update set value = excluded.value, updated_at = excluded.updated_at`,
    )
    .run(key, value, now)
}

/**
 * What the model is told to call the person it is talking to. Empty when nobody has said, which
 * is a supported state: the preamble then omits that sentence rather than greeting nobody.
 */
export function getUserName(database: Database): string {
  return getSetting(database, 'userName') ?? ''
}

export function setUserName(database: Database, name: string, now: number): void {
  setSetting(database, 'userName', name, now)
}

/**
 * The subject pinned to an `auth.allow` entry, or null where that entry has never matched a
 * successful login. Spec 13: the first successful login pins the id_token's `sub` to the
 * allowlist entry it matched, and the pin lives here rather than on the `sessions` row so it
 * survives logout, every session's expiry, and a restart.
 */
export function getPinnedSubject(database: Database, allowEntry: string): string | null {
  return getSetting(database, `authPin:${allowEntry}`)
}

export function setPinnedSubject(
  database: Database,
  allowEntry: string,
  subject: string,
  now: number,
): void {
  setSetting(database, `authPin:${allowEntry}`, subject, now)
}
