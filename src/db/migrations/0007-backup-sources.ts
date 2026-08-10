import type { Migration } from '../migrate.js'

/**
 * What a backup source needs: somewhere to record that an item turned out to be a second telling
 * of one another connector already covers. A GitHub notification email about a pull request on the
 * board is the case. Spec 02, notification emails as a backup source.
 */
export const backupSources: Migration = {
  id: 7,
  name: 'backup sources',
  up(database) {
    /*
     * Deliberately not `resolved_at`. Resolution says the upstream item has ended, and a
     * suppressed thread has not ended: it is still sitting in the inbox, still fetched on every
     * pass. What has ended is Caroline's interest in it as work of its own, and the two need
     * telling apart, because resolution is what proposes completing a task and suppression must
     * never do that.
     */
    database.exec('alter table sources add column suppressed_at integer')

    /*
     * The set each connector follows is "unresolved and not suppressed", read on every run, so
     * the index covers both. The `(provider, resolved_at)` index from migration 2 stays: it is
     * still the one a resolution query alone wants.
     */
    database.exec('create index sources_followed on sources (provider, resolved_at, suppressed_at)')
  },
}
