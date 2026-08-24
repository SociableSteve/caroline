/**
 * Where the jobs are assembled: the connectors, the three steps, the schedules they run on, and
 * the scheduler that owns the timing. One place, so that a manual run from the UI, a scheduled
 * tick and a cold-start catch-up are all the same code path. Specs 02, 04, 06.
 */
import { levelAllows } from '../config/content.js'
import type { Config } from '../config/schema.js'
import type { Database } from '../db/connection.js'
import { runSync, type ConnectorRunResult } from '../connectors/engine.js'
import { createCalendarApi, type CalendarApi } from '../connectors/gcal/api.js'
import { calendarWindowFor, runCalendarSync } from '../connectors/gcal/sync.js'
import { createGmailApi, type GmailApi } from '../connectors/gmail/api.js'
import { createGmailConnector, type KnownThread } from '../connectors/gmail/connector.js'
import { threadBody } from '../connectors/gmail/map.js'
import { createGitHubApi } from '../connectors/github/api.js'
import { createGitHubConnector, type KnownPullRequest } from '../connectors/github/connector.js'
import { identifyPullRequestNotification } from '../connectors/github/notification.js'
import { createGoogleAuth, type GoogleAuth } from '../connectors/google/auth.js'
import type { Connector } from '../connectors/types.js'
import { listUnresolvedSources } from '../db/repositories/sources.js'
import { noCounts, type JobCounts } from '../domain/job.js'
import { reviewStates, type ReviewState } from '../domain/review.js'
import type { LocalDate as PlanDate } from '../domain/time.js'
import { createLlmRuntime, type LlmRuntime } from '../llm/index.js'
import type { ChangeFeed } from '../server/changes.js'
import type { OperationalLog } from '../server/log.js'
import { CLASSIFY_JOB, runClassification, type ContentFetchers } from './classify.js'
import { PLAN_JOB, runPlanning, type PlanResult } from './plan.js'
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
  /**
   * Kept apart from `connectors` because it does not produce `SourceItem`s: a calendar event
   * is a fact about a day rather than a piece of work, and it goes to `calendar_events`
   * without ever passing through the engine's task creation. Spec 02, criterion 7.
   */
  readonly calendar: CalendarApi
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
    calendar: createCalendarApi({
      accessToken: () => google.accessToken(),
      ...(fetch === undefined ? {} : { fetch }),
    }),
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
        // Where the two connectors meet. A notification email about a pull request is a second
        // telling of GitHub's work rather than mail to deal with, and this is the only place that
        // knows both: the Gmail connector recognises nothing on its own, and the GitHub connector
        // knows nothing about mail. Spec 02.
        backupFor: identifyPullRequestNotification,
      }),
    ],
  }
}

/**
 * The connectors' counts, added up. Accumulated key by key rather than rebuilt from entries: a cast
 * back to `JobCounts` would hide a missing key, and a missing key makes the sum `NaN` with nothing
 * to say it happened.
 */
function total(results: readonly ConnectorRunResult[]): JobCounts {
  return results.reduce<JobCounts>((sum, result) => {
    const next = { ...sum }
    for (const key of Object.keys(noCounts) as Array<keyof JobCounts>) {
      next[key] = sum[key] + result.counts[key]
    }
    return next
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
   * Draws a plan for a day, outside the scheduler. The regenerate route uses the scheduler for
   * today, so a manual run is recorded and guarded against overlap like any other; this is for
   * a date that is not today, which is a read of history being redrawn rather than a job.
   */
  readonly plan: (date?: PlanDate) => Promise<PlanResult>
  /** True when a calendar can actually be read. What makes a plan's capacity verified. */
  readonly calendarConnected: () => boolean
  /**
   * How a body is obtained at send time. Shared with the settings preview so that what it shows is
   * what a call would carry, rather than a second answer to the same question. Spec 09, criterion 9.
   */
  readonly content: ContentFetchers
}

export interface BuildJobsOptions {
  readonly database: Database
  readonly config: Config
  readonly changes?: ChangeFeed
  readonly now?: () => number
  /** Injected in tests so that nothing in the suite reaches a network. */
  readonly fetch?: typeof globalThis.fetch
  readonly onError?: (error: unknown, context: string) => void
  /**
   * Where every job, connector and provider call says what it decided. Spec 14. Optional, because
   * the suite builds jobs without a server and a job with nowhere to log still runs; `main.ts`
   * passes a handle that becomes the server's logger.
   */
  readonly log?: OperationalLog
}

export function buildJobs({
  database,
  config,
  changes,
  now = () => Date.now(),
  fetch,
  onError,
  log,
}: BuildJobsOptions): CarolineJobs {
  const google = createGoogleAuth({ config, now, ...(fetch === undefined ? {} : { fetch }) })
  const { connectors, gmail, calendar } = buildConnectors(config, database, google, fetch)

  const llm = createLlmRuntime({
    config,
    database,
    now,
    ...(log === undefined ? {} : { log }),
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

  /** Whether the calendar can actually be read, which is what makes a capacity verified. */
  const calendarConnected = (): boolean =>
    config.integrations.google.configured && google.isConnected()

  const plan = (date?: PlanDate): Promise<PlanResult> =>
    runPlanning({
      database,
      config,
      llm,
      calendarConnected,
      now,
      ...(log === undefined ? {} : { log }),
      ...(date === undefined ? {} : { date }),
    })

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
          ...(log === undefined ? {} : { log }),
        })

        // The calendar is part of the sync pass, and its own row in the history, but it writes
        // to `calendar_events` rather than to `sources`, so it runs beside the engine rather
        // than inside it. Its result joins the others in the aggregate all the same.
        const events = await runCalendarSync({
          database,
          api: calendar,
          isConfigured: calendarConnected,
          calendarIds: config.integrations.google.calendarIds,
          timeZone: config.jobs.timezone,
          range: calendarWindowFor(now(), config.jobs.timezone, {
            lookbackDays: config.integrations.google.calendarLookbackDays,
            lookaheadDays: config.integrations.google.calendarLookaheadDays,
          }),
          trigger,
          now,
          ...(log === undefined ? {} : { log }),
        })

        return summariseSync([...summary.results, events])
      },
    },
    {
      name: CLASSIFY_JOB,
      run: () =>
        runClassification({
          database,
          config,
          llm,
          content,
          now,
          ...(log === undefined ? {} : { log }),
        }),
    },
    {
      name: PLAN_JOB,
      run: () => plan(),
    },
    {
      name: PURGE_JOB,
      run: () => {
        const result = runPurge({ database, config, now })
        // Counts only, which is all a purge has to say: how much went, of what. Spec 14.
        log?.debug(
          { ...result.counts, retainContentDays: config.privacy.retainContentDays },
          'purge finished',
        )
        return Promise.resolve(result)
      },
    },
  ]

  const schedules: readonly Schedule[] = [
    { job: SYNC_JOB, cron: config.jobs.schedules.sync, chain: [SYNC_JOB] },
    // Classification depends on sync, so the tick runs the pair in order rather than racing them.
    // Spec 06.
    { job: CLASSIFY_JOB, cron: config.jobs.schedules.classify, chain: [SYNC_JOB, CLASSIFY_JOB] },
    // The planner depends on both, so the daily tick runs all three in order: a plan drawn
    // before the morning's sync would be a plan of yesterday's work. Spec 06.
    {
      job: PLAN_JOB,
      cron: config.jobs.schedules.plan,
      chain: [SYNC_JOB, CLASSIFY_JOB, PLAN_JOB],
    },
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
    ...(log === undefined ? {} : { log }),
  })

  return { scheduler, google, llm, content, plan, calendarConnected }
}
