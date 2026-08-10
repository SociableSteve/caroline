/**
 * Everything the UI knows, loaded in one place. One fetch of tasks and one of projects serve
 * every surface, because a single-user process holding a few hundred tasks has nothing to gain
 * from per-view queries and plenty to lose from surfaces disagreeing with each other.
 *
 * The change feed (spec 08) is subscribed to here, so a write from anywhere, including a
 * background job once there are any, reloads what is on screen without a refresh.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  api,
  ApiFailure,
  type CalendarDay,
  type GoogleStatus,
  type Health,
  type JobRun,
  type JobStatus,
  type PlanHistoryDay,
  type PlanView,
  type PrivacyPreview,
  type ProjectView,
  type TaskView,
} from './api.js'

export interface CarolineData {
  readonly tasks: readonly TaskView[]
  readonly projects: readonly ProjectView[]
  readonly health: Health | null
  /** Recent job runs, most recent first. Empty until something has run. */
  readonly jobRuns: readonly JobRun[]
  /** One row per scheduled job: last run, next run, and whether backoff is holding it. */
  readonly jobStatus: readonly JobStatus[]
  /** Today's plan, or null when none has been drawn. Spec 05. */
  readonly plan: PlanView | null
  /** Planned against completed for the last fortnight. */
  readonly planHistory: readonly PlanHistoryDay[]
  /** Today's diary and its capacity. Null until the first read answers. */
  readonly calendar: CalendarDay | null
  /** The date the plan and the calendar are for, which the regenerate button needs. */
  readonly planDate: string | null
  /** The Google connection, and what a classification call would send. Both read on demand. */
  readonly google: GoogleStatus | null
  readonly preview: PrivacyPreview | null
  /** Reloads the two settings answers, which no other write invalidates. */
  readonly reloadSettings: () => Promise<void>
  /** The configured waiting staleness threshold, defaulted until the config arrives. */
  readonly staleDays: number
  readonly loading: boolean
  readonly failure: string | null
  /** How many tasks exist, when that is more than the client fetched. Null when it is not. */
  readonly unfetchedTaskTotal: number | null
  readonly reload: () => Promise<void>
}

/** Spec 02's default, used until `GET /api/config` says otherwise. */
const DEFAULT_STALE_DAYS = 7

function describeFailure(error: unknown): string {
  if (error instanceof ApiFailure) return error.message
  if (error instanceof Error) return error.message
  return 'Something went wrong talking to the server'
}

/**
 * Opens the change stream, if the browser has one. `EventSource` is absent in a jsdom test
 * and in an ancient browser, and in both cases the UI still works: writes reload on their own
 * and nothing else is producing changes yet.
 */
export function subscribeToChanges(onChange: () => void): () => void {
  if (typeof EventSource === 'undefined') return () => {}

  const stream = new EventSource('/api/changes')
  stream.addEventListener('change', onChange)

  return () => stream.close()
}

export function useCarolineData(): CarolineData {
  const [tasks, setTasks] = useState<readonly TaskView[]>([])
  const [projects, setProjects] = useState<readonly ProjectView[]>([])
  const [health, setHealth] = useState<Health | null>(null)
  const [jobRuns, setJobRuns] = useState<readonly JobRun[]>([])
  const [jobStatus, setJobStatus] = useState<readonly JobStatus[]>([])
  const [plan, setPlan] = useState<PlanView | null>(null)
  const [planHistory, setPlanHistory] = useState<readonly PlanHistoryDay[]>([])
  const [planDate, setPlanDate] = useState<string | null>(null)
  const [calendar, setCalendar] = useState<CalendarDay | null>(null)
  const [google, setGoogle] = useState<GoogleStatus | null>(null)
  const [preview, setPreview] = useState<PrivacyPreview | null>(null)
  const [staleDays, setStaleDays] = useState(DEFAULT_STALE_DAYS)
  const [loading, setLoading] = useState(true)
  const [failure, setFailure] = useState<string | null>(null)
  const [unfetchedTaskTotal, setUnfetchedTaskTotal] = useState<number | null>(null)
  /**
   * Which reload is the current one. Mounting, the change feed and every write can all have
   * one in flight at once, and without this an older response finishing last would put stale
   * tasks back on the screen until something else happened to reload.
   */
  const generation = useRef(0)
  /** The same, for the settings reads, which are on their own schedule. */
  const settingsGeneration = useRef(0)

  const reload = useCallback(async () => {
    generation.current += 1
    const mine = generation.current

    try {
      // The run history is reloaded alongside the tasks: a sync that just finished changed
      // both, and the dashboard should not be a refresh behind on either.
      // The plan and the calendar reload alongside the tasks: completing something from the
      // plan changes how the entry renders, and a sync that just finished may have changed the
      // diary. Each is defended on its own, so one failing panel does not blank the board.
      const [taskCollection, projectList, runs, status, day, diary] = await Promise.all([
        api.listTasks(),
        api.listProjects(),
        api.listJobRuns().catch(() => ({ runs: [] })),
        api.listJobStatus().catch(() => ({ jobs: [] })),
        api.getPlan().catch(() => null),
        api.getCalendar().catch(() => null),
      ])
      if (mine !== generation.current) return

      setTasks(taskCollection.tasks)
      setProjects(projectList.projects)
      setJobRuns(runs.runs)
      setPlan(day?.plan ?? null)
      setPlanHistory(day?.history ?? [])
      // The server's idea of today, not the browser's: they can differ across midnight, and the
      // regenerate button has to name the date the plan was actually read for.
      setPlanDate(day?.date ?? diary?.date ?? null)
      setCalendar(diary)
      // Defended rather than trusted: the board must not go blank because one panel's answer was
      // not the shape it should have been.
      setJobStatus(status.jobs ?? [])
      setUnfetchedTaskTotal(taskCollection.truncated ? taskCollection.total : null)
      setFailure(null)
    } catch (error) {
      if (mine !== generation.current) return
      setFailure(describeFailure(error))
    } finally {
      // Loading is about the first answer arriving, so a superseded reload still ends it.
      setLoading(false)
    }
  }, [])

  /**
   * The settings answers, which nothing else invalidates: the Google connection changes only when
   * somebody connects or disconnects, and the payload preview only when the policy or the inbox
   * does. Kept out of `reload` so that every board write does not fetch a Gmail thread.
   */
  const reloadSettings = useCallback(async () => {
    settingsGeneration.current += 1
    const mine = settingsGeneration.current

    const [connection, payload] = await Promise.all([
      api.getGoogleStatus().catch(() => null),
      api.getPrivacyPreview().catch(() => null),
    ])

    // The same guard `reload` uses, for the same reason: opening Settings and pressing Refresh can
    // have two of these in flight, and the slower one finishing last would put the older answer
    // back on the screen.
    if (mine !== settingsGeneration.current) return

    setGoogle(connection)
    setPreview(payload)
  }, [])

  useEffect(() => {
    void reload()

    // Health and config are read once. Neither changes without a restart, and a failure to
    // read either is not a reason to withhold the tasks: the dashboard shows what it has.
    void api
      .getHealth()
      .then(setHealth)
      .catch(() => setHealth(null))
    void api
      .getConfig()
      .then((config) => setStaleDays(config.tasks.waitingStaleDays))
      .catch(() => setStaleDays(DEFAULT_STALE_DAYS))
  }, [reload])

  useEffect(() => subscribeToChanges(() => void reload()), [reload])

  return {
    tasks,
    projects,
    health,
    jobRuns,
    jobStatus,
    plan,
    planHistory,
    planDate,
    calendar,
    google,
    preview,
    staleDays,
    loading,
    failure,
    unfetchedTaskTotal,
    reload,
    reloadSettings,
  }
}
