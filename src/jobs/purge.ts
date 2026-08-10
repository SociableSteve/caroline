/**
 * The nightly tidy. Three things nobody should have to remember to do:
 *
 * - Content stored above what the policy now allows is brought down to it, and the count is
 *   reported. Spec 09, criterion 4.
 * - Content older than the retention window is dropped, while its source row and task survive.
 *   Spec 09, criterion 5.
 * - Run history older than its retention window is deleted. Spec 06.
 *
 * Synchronous, because all three are SQLite writes and there is nothing to wait for.
 */
import { purgedContent } from '../config/content.js'
import type { Config } from '../config/schema.js'
import { withTransaction, type Database } from '../db/connection.js'
import { purgeJobRunsBefore } from '../db/repositories/job-runs.js'
import { listSourcesWithContent, setSourceContent } from '../db/repositories/sources.js'
import { noCounts, type JobCounts, type JobRunStatus } from '../domain/job.js'

export const PURGE_JOB = 'purge'

export interface PurgeResult {
  readonly status: JobRunStatus
  readonly counts: JobCounts
  readonly error: string | null
}

export interface PurgeOptions {
  readonly database: Database
  readonly config: Config
  readonly now: () => number
}

const DAY_MS = 24 * 60 * 60_000

export function runPurge({ database, config, now }: PurgeOptions): PurgeResult {
  const at = now()
  const { privacy, jobs } = config

  const contentPurged = withTransaction(database, () => {
    const retentionCutoff = at - privacy.retainContentDays * DAY_MS
    let purged = 0

    for (const source of listSourcesWithContent(database)) {
      // Age first: a body past the window goes whatever level it was written at, and there is
      // nothing left for the downgrade to cut. `contentStoredAt` is null only for a row written
      // before the column existed, which has no age to judge and is left to the downgrade.
      if (source.contentStoredAt !== null && source.contentStoredAt < retentionCutoff) {
        setSourceContent(database, source.id, null, 'none', at)
        purged += 1
        continue
      }

      const purgedTo = purgedContent(source.content, source.contentLevel, privacy)
      if (purgedTo === null) continue

      // The row's own stamp, not now: cutting a body back is not writing a new one, and stamping it
      // afresh would restart the retention window every time the policy was lowered. Spec 09,
      // criterion 5 measures from when the body was written.
      setSourceContent(
        database,
        source.id,
        purgedTo.content,
        purgedTo.level,
        source.contentStoredAt ?? at,
      )
      purged += 1
    }

    return purged
  })

  const runsPurged = purgeJobRunsBefore(database, at - jobs.retainRunDays * DAY_MS)

  return {
    status: 'success',
    counts: { ...noCounts, contentPurged, runsPurged },
    error: null,
  }
}
