/**
 * The scheduler: in-process, one timer, and an honest record of what ran. Spec 06.
 *
 * It owns four guarantees and nothing else, so that the jobs themselves stay ignorant of when
 * they run:
 *
 * - **No overlap.** A job already running is not started again; the attempt is recorded as
 *   skipped (criterion 1).
 * - **Missed runs collapse.** The next firing is computed from now, not from the slots that went
 *   by while the process was down, so a day of downtime is one catch-up run and not twenty-four
 *   (criterion 2).
 * - **Backoff.** Consecutive failures push the next attempt back exponentially to a ceiling, and
 *   one success clears it (criterion 3).
 * - **Every attempt writes a row**, including the skips and the failures (criterion 5).
 *
 * A job is a step with a name. A schedule is a cron expression and the chain of steps to run when
 * it fires: `classify` depends on `sync`, so the hourly tick runs sync then classify rather than
 * racing them.
 */
import {
  failureStreak,
  lastSuccessfulRun,
  latestJobRun,
  recordJobRun,
} from '../db/repositories/job-runs.js'
import type { Database } from '../db/connection.js'
import { cronInterval, nextCronTime, parseCron, type CronFields } from '../domain/cron.js'
import type { JobCounts, JobRun, JobRunStatus, JobTrigger } from '../domain/job.js'
import type { ChangeFeed } from '../server/changes.js'

/** What a job reports. Recording it is the scheduler's, so that every path records it alike. */
export interface StepResult {
  readonly status: JobRunStatus
  readonly counts?: Partial<JobCounts>
  readonly error?: string | null
  readonly errorStack?: string | null
}

export interface JobStep {
  readonly name: string
  run(trigger: JobTrigger): Promise<StepResult>
}

export interface Schedule {
  /** The job the schedule belongs to, and the last step of its chain. */
  readonly job: string
  readonly cron: string
  /**
   * The steps to run when it fires, in order. A dependency is expressed by putting it first:
   * `['sync', 'classify']` is spec 06's "the hourly tick runs sync then classify".
   */
  readonly chain: readonly string[]
}

export type RunOutcome =
  | { readonly status: 'ran'; readonly run: JobRun }
  /** Spec 06, criterion 6: a clear answer rather than a second run. */
  | { readonly status: 'already-running' }
  | { readonly status: 'unknown' }

export interface JobStatus {
  readonly job: string
  readonly cron: string
  readonly running: boolean
  /** When the schedule next fires, or null for a job with no schedule. */
  readonly nextRunAt: number | null
  readonly lastRun: JobRun | null
  readonly consecutiveFailures: number
  /** When backoff will let it run again, when that is later than the next firing. */
  readonly backoffUntil: number | null
}

export interface Scheduler {
  /** Registers the timer and the staggered catch-up runs. Nothing runs before this is called. */
  start(): void
  stop(): void
  /** The one path a job runs by, whether a tick, a manual trigger or a cold start asked for it. */
  run(job: string, trigger: JobTrigger): Promise<RunOutcome>
  isRunning(job: string): boolean
  status(): JobStatus[]
  /** Waits for whatever is in flight, up to `timeoutMs`. Resolves either way. */
  drain(timeoutMs?: number): Promise<void>
}

export interface SchedulerOptions {
  readonly database: Database
  readonly steps: readonly JobStep[]
  readonly schedules: readonly Schedule[]
  readonly timeZone: string
  readonly backoffBaseMs: number
  readonly backoffCeilingMs: number
  /** The gap between catch-up runs on a cold start, so they do not all fire at once. */
  readonly startupStaggerMs: number
  readonly now?: () => number
  /** Announced so an open tab sees a background run's results without a refresh. Spec 08. */
  readonly changes?: ChangeFeed
  /** Somewhere for a failure the scheduler itself could not record to go. */
  readonly onError?: (error: unknown, context: string) => void
}

/** How long shutdown waits for a job in flight before giving up on it. */
export const DRAIN_TIMEOUT_MS = 10_000

interface Registered extends Schedule {
  readonly fields: CronFields
  nextAt: number
}

/**
 * `setTimeout` treats a delay above this as 1ms, so a long wait is taken in stages. A monthly
 * schedule such as `0 3 1 * *` exceeds it, and without the clamp the timer would fire at once,
 * find nothing due, re-arm with the same overflowing delay, and spin for the life of the process.
 */
const MAX_TIMEOUT_MS = 2_147_483_647

/** Whether a run changed anything a tab might be showing. */
function changedAnything(counts: Partial<JobCounts>): boolean {
  return (
    (counts.sourcesCreated ?? 0) > 0 ||
    (counts.tasksCreated ?? 0) > 0 ||
    (counts.tasksUpdated ?? 0) > 0 ||
    (counts.resolved ?? 0) > 0 ||
    (counts.requeued ?? 0) > 0 ||
    (counts.proposals ?? 0) > 0 ||
    (counts.contentPurged ?? 0) > 0 ||
    (counts.eventsStored ?? 0) > 0 ||
    (counts.eventsRemoved ?? 0) > 0 ||
    (counts.plansGenerated ?? 0) > 0
  )
}

export function createScheduler({
  database,
  steps,
  schedules,
  timeZone,
  backoffBaseMs,
  backoffCeilingMs,
  startupStaggerMs,
  now = () => Date.now(),
  changes,
  onError,
}: SchedulerOptions): Scheduler {
  const byName = new Map(steps.map((step) => [step.name, step]))
  const inFlight = new Map<string, Promise<unknown>>()
  const registered: Registered[] = []
  let timer: ReturnType<typeof setTimeout> | null = null
  let started = false

  for (const schedule of schedules) {
    // A schedule naming a step nothing can run is a configuration error worth refusing at
    // startup rather than a tick that quietly does nothing every quarter of an hour.
    for (const step of schedule.chain) {
      if (!byName.has(step)) {
        throw new Error(
          `The schedule for "${schedule.job}" names a step "${step}" that no job provides`,
        )
      }
    }

    registered.push({ ...schedule, fields: parseCron(schedule.cron), nextAt: 0 })
  }

  /**
   * How long after its last failure a job may try again. Doubles per consecutive failure to the
   * ceiling, and is nothing at all after a success. Spec 06, criterion 3.
   */
  function backoffUntil(job: string): number | null {
    const streak = failureStreak(database, job)
    if (streak.count === 0 || streak.lastFailureAt === null) return null

    // Exponent capped before the shift so that a long outage cannot overflow its way back to a
    // small delay.
    const doublings = Math.min(streak.count - 1, 30)
    const delay = Math.min(backoffBaseMs * 2 ** doublings, backoffCeilingMs)

    return streak.lastFailureAt + delay
  }

  /**
   * The next moment a schedule may fire: its next cron firing, or the end of its backoff if that
   * is later. Computed from now, which is what collapses the slots missed during downtime into
   * one (criterion 2).
   */
  function nextFor(schedule: Registered, from: number): number {
    const cron = nextCronTime(schedule.fields, from, timeZone)
    const held = backoffUntil(schedule.job)
    return held === null ? cron : Math.max(cron, held)
  }

  function announce(counts: Partial<JobCounts>): void {
    if (changes === undefined) return

    const at = now()
    changes.publish({ kind: 'jobs', at })
    if (!changedAnything(counts)) return

    changes.publish({ kind: 'tasks', at })
    changes.publish({ kind: 'projects', at })
  }

  function record(job: string, trigger: JobTrigger, startedAt: number, result: StepResult): JobRun {
    return recordJobRun(database, {
      job,
      trigger,
      startedAt,
      finishedAt: now(),
      status: result.status,
      ...(result.counts === undefined ? {} : { counts: result.counts }),
      ...(result.error === undefined || result.error === null ? {} : { error: result.error }),
      ...(result.errorStack === undefined || result.errorStack === null
        ? {}
        : { errorStack: result.errorStack }),
    })
  }

  async function runStep(job: string, trigger: JobTrigger): Promise<RunOutcome> {
    const step = byName.get(job)
    if (step === undefined) return { status: 'unknown' }

    const startedAt = now()

    if (inFlight.has(job)) {
      // Not started again, and the skip is a row: a schedule that keeps being skipped is a fact
      // about the schedule worth reading. Spec 06, criteria 1 and 5.
      record(job, trigger, startedAt, {
        status: 'skipped',
        error: 'A run of this job was already in flight, so this one was skipped.',
      })
      return { status: 'already-running' }
    }

    const running = (async (): Promise<StepResult> => {
      try {
        return await step.run(trigger)
      } catch (error) {
        // A job that throws is a failed run, not a dead scheduler: the row is written and the
        // next firing is computed as usual. Spec 06, criterion 7.
        return {
          status: 'failure',
          error: error instanceof Error ? error.message : String(error),
          ...(error instanceof Error && error.stack !== undefined
            ? { errorStack: error.stack }
            : {}),
        }
      }
    })()

    inFlight.set(job, running)

    try {
      const result = await running
      const run = record(job, trigger, startedAt, result)
      announce(result.counts ?? {})
      return { status: 'ran', run }
    } finally {
      inFlight.delete(job)
    }
  }

  /** One schedule firing: its chain, in order, each step recorded in its own right. */
  async function fire(schedule: Registered, trigger: JobTrigger): Promise<void> {
    for (const step of schedule.chain) {
      // A step that fails does not stop the chain. Items already ingested are still worth
      // sorting, and a classify that never ran because sync could not reach GitHub would be a
      // second failure caused by the first.
      await runStep(step, trigger)
    }
  }

  function arm(): void {
    if (!started) return
    if (timer !== null) clearTimeout(timer)
    if (registered.length === 0) return

    const at = now()
    const soonest = Math.min(...registered.map((schedule) => schedule.nextAt))

    // A clamped wake-up is harmless: `tick` finds nothing due and re-arms with what is left.
    timer = setTimeout(
      () => {
        void tick()
      },
      Math.min(Math.max(0, soonest - at), MAX_TIMEOUT_MS),
    )
    // The process should not be held open by a schedule alone; the server is what keeps it alive.
    timer.unref?.()
  }

  async function tick(): Promise<void> {
    const at = now()
    const due = registered.filter((schedule) => schedule.nextAt <= at)

    for (const schedule of due) {
      try {
        await fire(schedule, 'scheduled')
      } catch (error) {
        onError?.(error, `firing the schedule for ${schedule.job}`)
      }
      // Recomputed after the run rather than before it, so that a job which took longer than its
      // interval does not immediately fire again, and so that a failure's backoff is in force.
      schedule.nextAt = nextFor(schedule, now())
    }

    arm()
  }

  function isOverdue(schedule: Registered): boolean {
    const at = now()
    const success = lastSuccessfulRun(database, schedule.job)
    if (success === null) return true

    return at - success.finishedAt > cronInterval(schedule.fields, at, timeZone)
  }

  function pause(milliseconds: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, milliseconds)
      timer.unref?.()
    })
  }

  /**
   * The cold start. A job whose last success is older than one of its intervals is overdue, and
   * runs once. Spec 06, criterion 2 and startup.
   *
   * The overdue chains are flattened into one list of steps and deduplicated, because on a cold
   * start every job is usually overdue and their chains overlap: sync appears in its own schedule
   * and at the head of classification's. Running the list once, in order and one at a time, is
   * what makes "exactly one catch-up run per due job" true rather than nearly true, and the pause
   * between them is the stagger, so a restart does not fire everything in the same second.
   */
  async function catchUp(): Promise<void> {
    const steps: string[] = []
    for (const schedule of registered.filter(isOverdue)) {
      for (const step of schedule.chain) {
        if (!steps.includes(step)) steps.push(step)
      }
    }

    for (const [index, step] of steps.entries()) {
      if (index > 0) await pause(startupStaggerMs)

      try {
        await runStep(step, 'startup')
      } catch (error) {
        onError?.(error, `the startup run of ${step}`)
      }
    }
  }

  return {
    start() {
      if (started) return
      started = true

      const at = now()
      for (const schedule of registered) schedule.nextAt = nextFor(schedule, at)

      // Deliberately not awaited: `start` is called once the server is listening, and a catch-up
      // that has to fetch from two providers must not hold that up. Each step records its own
      // outcome, so nothing is lost by not waiting for it.
      void catchUp()
      arm()
    },

    stop() {
      started = false
      if (timer !== null) clearTimeout(timer)
      timer = null
    },

    run: runStep,

    isRunning: (job) => inFlight.has(job),

    status() {
      const at = now()

      return registered.map((schedule) => ({
        job: schedule.job,
        cron: schedule.cron,
        running: inFlight.has(schedule.job),
        // Recomputed rather than reported from state, so a status read before `start` still says
        // when the schedule would fire.
        nextRunAt: started ? schedule.nextAt : nextCronTime(schedule.fields, at, timeZone),
        lastRun: latestJobRun(database, schedule.job),
        consecutiveFailures: failureStreak(database, schedule.job).count,
        backoffUntil: backoffUntil(schedule.job),
      }))
    },

    async drain(timeoutMs = DRAIN_TIMEOUT_MS) {
      const running = [...inFlight.values()]
      if (running.length === 0) return

      let expiry: ReturnType<typeof setTimeout> | undefined
      const deadline = new Promise<void>((resolve) => {
        expiry = setTimeout(resolve, timeoutMs)
      })

      try {
        // Each job's own failure is already recorded, so nothing here reports one: all that is
        // being waited for is that they have stopped writing.
        await Promise.race([
          Promise.all(running.map((promise) => promise.then(undefined, () => undefined))),
          deadline,
        ])
      } finally {
        if (expiry !== undefined) clearTimeout(expiry)
      }
    },
  }
}
