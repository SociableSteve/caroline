/**
 * Where the jobs are assembled: the connectors, the three steps, the schedules they run on, and
 * the scheduler that owns the timing. One place, so that a manual run from the UI, a scheduled
 * tick and a cold-start catch-up are all the same code path. Specs 02, 04, 06.
 */
import { levelAllows } from '../config/content.js'
import type { Config } from '../config/schema.js'
import type { Database } from '../db/connection.js'
import { runSync, type ConnectorRunResult } from '../connectors/engine.js'
import { createGmailApi, type GmailApi } from '../connectors/gmail/api.js'
import { createGmailConnector, type KnownThread } from '../connectors/gmail/connector.js'
import { threadBody } from '../connectors/gmail/map.js'
import { createGitHubApi } from '../connectors/github/api.js'
import { createGitHubConnector, type KnownPullRequest } from '../connectors/github/connector.js'
import { createGoogleAuth, type GoogleAuth } from '../connectors/google/auth.js'
import type { Connector } from '../connectors/types.js'
import { listUnresolvedSources } from '../db/repositories/sources.js'
import { noCounts, type JobCounts } from '../domain/job.js'
import { reviewStates, type ReviewState } from '../domain/review.js'
import { createLlmRuntime, type LlmRuntime } from '../llm/index.js'
import type { ChangeFeed } from '../server/changes.js'
import { CLASSIFY_JOB, runClassification, type ContentFetchers } from './classify.js'
import { PURGE_JOB, runPurge } from './purge.js'
import { createScheduler, type JobStep, type Schedule, type Scheduler } from './scheduler.js'

export const SYNC_JOB = 'sync'

/**
 * `lifecycle_state` is text in the database and connector-owned, so it is checked rather than
 * asserted: a value the machine does not know is treated as no position at all, which is the same
 * as a pull request being seen for the first time.
 */
function toReviewState(value: string | null): ReviewState | null {
  return value !== null && (reviewStates as readonly string[]).includes(value)
    ? (value as ReviewState)
    : null
}

/** The GitHub refresh pass's input: every pull request known and not yet seen to close. */
export function knownPullRequests(database: Database): KnownPullRequest[] {
  return listUnresolvedSources(database, 'github').map((source) => ({
    externalId: source.externalId,
    state: toReviewState(source.lifecycleState),
    actedAt: source.actedAt,
    actedAtMarker: source.actedAtMarker,
  }))
}

/**
 * The threads Caroline is following. What is carried is what a resolution item has to say to
 * avoid blanking the row it resolves: the upsert writes what the item holds.
 */
export function knownThreads(database: Database): KnownThread[] {
  return listUnresolvedSources(database, 'gmail').map((source) => ({
    externalId: source.externalId,
    title: source.title,
    url: source.url,
    metadata: source.metadata,
  }))
}

/** True when either content policy asks for a body, which is what decides how much is fetched. */
export function needsBody(config: Config): boolean {
  return (
    levelAllows(config.privacy.llmContent, 'snippet') ||
    levelAllows(config.privacy.storeContent, 'snippet')
  )
}

export interface ConnectorSet {
  readonly connectors: readonly Connector[]
  readonly gmail: GmailApi
}

/**
 * Every connector, configured or not. An unconfigured one stays in the list: the engine records it
 * as skipped, which is how the run history says "GitHub has no token" rather than staying silent
 * about it. Spec 02, criterion 6.
 */
export function buildConnectors(
  config: Config,
  database: Database,
  google: GoogleAuth,
  fetch?: typeof globalThis.fetch,
): ConnectorSet {
  const gmail = createGmailApi({
    accessToken: () => google.accessToken(),
    ...(fetch === undefined ? {} : { fetch }),
  })

  return {
    gmail,
    connectors: [
      createGitHubConnector({
        api: createGitHubApi({
          token: config.integrations.github.token ?? '',
          ...(fetch === undefined ? {} : { fetch }),
        }),
        isConfigured: () => config.integrations.github.configured,
        options: {
          returnToReviewOnNewCommits: config.integrations.github.returnToReviewOnNewCommits,
        },
        known: () => knownPullRequests(database),
      }),
      createGmailConnector({
        api: gmail,
        // Credentials alone are not enough: nothing can be fetched until somebody has consented,
        // and a Caroline with a client id and no consent is skipped rather than failed.
        isConfigured: () => config.integrations.google.configured && google.isConnected(),
        query: config.integrations.google.gmailQuery,
        needsBody: () => needsBody(config),
        known: () => knownThreads(database),
      }),
    ],
  }
}

function total(results: readonly ConnectorRunResult[]): JobCounts {
  return results.reduce<JobCounts>((sum, result) => {
    const counts = result.counts
    return Object.fromEntries(
      Object.keys(noCounts).map((key) => [
        key,
        sum[key as keyof JobCounts] + counts[key as keyof JobCounts],
      ]),
    ) as unknown as JobCounts
  }, noCounts)
}

/**
 * The sync step's aggregate row, alongside the per-connector rows `runSync` writes itself. The
 * aggregate answers "did the pass work at all", so it fails only when every configured connector
 * failed: that is the case where backing the whole job off is right, and a single broken connector
 * should not slow the others down. Which connector failed is in its own row and in this row's
 * error message. Spec 02, criterion 5.
 */
export function summariseSync(results: readonly ConnectorRunResult[]): {
  status: 'success' | 'failure' | 'skipped'
  counts: JobCounts
  error: string | null
} {
  const attempted = results.filter((result) => result.status !== 'skipped')
  const failed = results.filter((result) => result.status === 'failure')

  const error =
    failed.length === 0
      ? null
      : failed.map((result) => `${result.provider}: ${result.error ?? 'failed'}`).join('; ')

  return {
    status:
      attempted.length === 0
        ? 'skipped'
        : failed.length === attempted.length
          ? 'failure'
          : 'success',
    counts: total(results),
    error,
  }
}

export interface CarolineJobs {
  readonly scheduler: Scheduler
  readonly google: GoogleAuth
  readonly llm: LlmRuntime
  /**
   * How a body is obtained at send time. Shared with the settings preview so that what it shows is
   * what a call would carry, rather than a second answer to the same question. Spec 09, criterion 9.
   */
  readonly content: ContentFetchers
  /** The steps, exposed so the jobs route can say which names it will accept. */
  readonly jobNames: readonly string[]
}

export interface BuildJobsOptions {
  readonly database: Database
  readonly config: Config
  readonly changes?: ChangeFeed
  readonly now?: () => number
  /** Injected in tests so that nothing in the suite reaches a network. */
  readonly fetch?: typeof globalThis.fetch
  readonly onError?: (error: unknown, context: string) => void
}

export function buildJobs({
  database,
  config,
  changes,
  now = () => Date.now(),
  fetch,
  onError,
}: BuildJobsOptions): CarolineJobs {
  const google = createGoogleAuth({ config, now, ...(fetch === undefined ? {} : { fetch }) })
  const { connectors, gmail } = buildConnectors(config, database, google, fetch)

  const llm = createLlmRuntime({
    config,
    database,
    now,
    ...(fetch === undefined ? {} : { fetch }),
    ...(onError === undefined
      ? {}
      : { onRecordingError: (error) => onError(error, 'recording an LLM call') }),
  })

  /**
   * The body at send time, for the case the default policy is in: a snippet may be sent while
   * nothing is stored, so the snippet is computed from a fresh fetch and kept nowhere. Spec 09.
   */
  const content: ContentFetchers = {
    gmail: async (source) => threadBody(await gmail.getThread(source.externalId, 'full')),
  }

  const steps: readonly JobStep[] = [
    {
      name: SYNC_JOB,
      async run(trigger) {
        const summary = await runSync({
          database,
          connectors,
          trigger,
          policy: config.privacy,
          now,
        })
        return summariseSync(summary.results)
      },
    },
    {
      name: CLASSIFY_JOB,
      run: () => runClassification({ database, config, llm, content, now }),
    },
    {
      name: PURGE_JOB,
      run: () => Promise.resolve(runPurge({ database, config, now })),
    },
  ]

  const schedules: readonly Schedule[] = [
    { job: SYNC_JOB, cron: config.jobs.schedules.sync, chain: [SYNC_JOB] },
    // Classification depends on sync, so the tick runs the pair in order rather than racing them.
    // Spec 06. The planner joins this chain in M6.
    { job: CLASSIFY_JOB, cron: config.jobs.schedules.classify, chain: [SYNC_JOB, CLASSIFY_JOB] },
    { job: PURGE_JOB, cron: config.jobs.schedules.purge, chain: [PURGE_JOB] },
  ]

  const scheduler = createScheduler({
    database,
    steps,
    schedules,
    timeZone: config.jobs.timezone,
    backoffBaseMs: config.jobs.backoffBaseMinutes * 60_000,
    backoffCeilingMs: config.jobs.backoffCeilingMinutes * 60_000,
    startupStaggerMs: config.jobs.startupStaggerSeconds * 1000,
    now,
    ...(changes === undefined ? {} : { changes }),
    ...(onError === undefined ? {} : { onError }),
  })

  return { scheduler, google, llm, content, jobNames: steps.map((step) => step.name) }
}
