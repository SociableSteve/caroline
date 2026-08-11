import type { Migration } from '../migrate.js'

/**
 * Where facts about the person go, as distinct from facts about the deployment. Spec 09.
 *
 * A key-value table rather than a one-row table with a column per setting: there is one setting
 * today, the next one is a row rather than a migration, and nothing here is queried by anything
 * other than its key.
 */
export const settings: Migration = {
  id: 9,
  name: 'settings',
  up(database) {
    database.exec(`
      create table settings (
        key text primary key,
        value text not null,
        updated_at integer not null
      )
    `)
  },
}
