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
import { reviewStates, type ReviewState } from '../domain/review.js'
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

/**
 * `lifecycle_state` is text in the database and connector-owned, so it is checked rather
 * than asserted: a value the machine does not know is treated as no position at all, which
 * is the same as a pull request being seen for the first time.
 */
function toReviewState(value: string | null): ReviewState | null {
  return value !== null && (reviewStates as readonly string[]).includes(value)
    ? (value as ReviewState)
    : null
}

/** The refresh pass's input: every pull request known and not yet seen to close. */
export function knownPullRequests(database: Database): KnownPullRequest[] {
  return listUnresolvedSources(database, 'github').map((source) => ({
    externalId: source.externalId,
    state: toReviewState(source.lifecycleState),
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
  /**
   * Waits for a run in flight to finish, up to `timeoutMs`. Shutdown calls this before
   * closing the database: a run still applying items to a closed handle is how a clean
   * stop turns into a stack trace and a half-applied pass. Resolves either way, because a
   * shutdown that will not shut down is worse than one that gives up waiting.
   */
  drain(timeoutMs?: number): Promise<void>
}

/** How long shutdown waits for a sync in flight before closing the database regardless. */
export const DRAIN_TIMEOUT_MS = 5_000

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

    async drain(timeoutMs = DRAIN_TIMEOUT_MS) {
      const running = inFlight
      if (running === null) return

      let timer: ReturnType<typeof setTimeout> | undefined
      const expiry = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs)
      })

      try {
        // The run's own failure is already recorded by `runSync`, so it is not this
        // caller's to report: all that is being waited for here is that it has stopped.
        await Promise.race([running.then(undefined, () => undefined), expiry])
      } finally {
        if (timer !== undefined) clearTimeout(timer)
      }
    },

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
