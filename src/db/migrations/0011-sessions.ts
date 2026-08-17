import type { Migration } from '../migrate.js'

/**
 * Browser sessions. Spec 13: an opaque random value in a cookie, with a row here holding only its
 * SHA-256 hash. The database never holds the value a browser presents, and criterion 19's test
 * proves that by searching the file for it.
 *
 * The only migration this milestone adds. The subject pin lives in the existing `settings` table,
 * keyed by the allowlist entry it matched, because a pin has to outlive a session row's own
 * lifetime (logout, expiry) and `settings` is already the place for a fact about the person rather
 * than about the deployment.
 */
export const sessions: Migration = {
  id: 11,
  name: 'sessions',
  up(database) {
    database.exec(`
      create table sessions (
        id text primary key,
        hash text not null unique,
        created_at integer not null,
        last_seen_at integer not null
      )
    `)
  },
}
