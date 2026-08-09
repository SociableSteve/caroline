/**
 * The sync job: which connectors exist, and the one place a run is started from. The
 * scheduler that decides *when* arrives in M5 (spec 06); until then a run is started at
 * startup and from `POST /api/jobs/sync/run`, and both go through here so that the manual
 * path is the same path.
 */
import type { Config } from '../config/schema.js'
import type { Database } from '../db/connection.js'
import { listUnresolvedSources } from '../db/repositories/sources.js'
import { runSync, type SyncSummary } from '../connectors/engine.js'
import { createGitHubApi } from '../connectors/github/api.js'
import { createGitHubConnector, type KnownPullRequest } from '../connectors/github/connector.js'
import type { Connector } from '../connectors/types.js'
import type { ReviewState } from '../domain/review.js'
import type { JobTrigger } from '../domain/job.js'
import type { ChangeFeed } from '../server/changes.js'

export const SYNC_JOB = 'sync'

/**
 * Every connector, configured or not. An unconfigured one is still in the list: the engine
 * records it as skipped, which is how the run history says "GitHub has no token" rather
 * than staying silent about it. Spec 02, criterion 6.
 */
export function buildConnectors(config: Config, database: Database): Connector[] {
  return [
    createGitHubConnector({
      api: createGitHubApi({ token: config.integrations.github.token ?? '' }),
      isConfigured: () => config.integrations.github.configured,
      options: {
        returnToReviewOnNewCommits: config.integrations.github.returnToReviewOnNewCommits,
      },
      known: () => knownPullRequests(database),
    }),
  ]
}

/** The refresh pass's input: every pull request known and not yet seen to close. */
export function knownPullRequests(database: Database): KnownPullRequest[] {
  return listUnresolvedSources(database, 'github').map((source) => ({
    externalId: source.externalId,
    state: source.lifecycleState as ReviewState | null,
    actedAt: source.actedAt,
    actedAtMarker: source.actedAtMarker,
  }))
}

export type SyncOutcome =
  | { readonly status: 'ran'; readonly summary: SyncSummary }
  /** A run was already in flight. Spec 06 asks for a clear answer, not a second run. */
  | { readonly status: 'already-running' }

export interface SyncRunner {
  run(trigger: JobTrigger): Promise<SyncOutcome>
  isRunning(): boolean
}

export interface SyncRunnerOptions {
  readonly database: Database
  readonly connectors: readonly Connector[]
  /** Announced to the open UI when a run changed anything. Spec 08, criterion 5. */
  readonly changes?: ChangeFeed
  readonly now?: () => number
}

/**
 * Holds the one guarantee the scheduler is not here yet to provide: a job already running
 * is not started again. In process, because two Caroline instances against one database are
 * unsupported by design (spec 06).
 */
export function createSyncRunner({
  database,
  connectors,
  changes,
  now = () => Date.now(),
}: SyncRunnerOptions): SyncRunner {
  let inFlight: Promise<SyncSummary> | null = null

  return {
    isRunning: () => inFlight !== null,

    async run(trigger) {
      if (inFlight !== null) return { status: 'already-running' }

      inFlight = runSync({ database, connectors, trigger, now })

      try {
        const summary = await inFlight
        if (summary.changed && changes !== undefined) {
          const at = now()
          changes.publish({ kind: 'tasks', at })
          changes.publish({ kind: 'projects', at })
        }
        return { status: 'ran', summary }
      } finally {
        inFlight = null
      }
    },
  }
}
