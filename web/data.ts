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
  type McpClientView,
  type PlanHistoryDay,
  type PlanView,
  type PrivacyPreview,
  type ProjectView,
  type SettingsView,
  type SpendReport,
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
  /** What the models have cost this budget period. Null until the first read answers. Spec 03. */
  readonly spend: SpendReport | null
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
  /** Every MCP client already approved once. Spec 08: "a list of the clients already approved
   * with a way to revoke one." */
  readonly mcpClients: readonly McpClientView[] | null
  /** What Caroline calls the person using it, which goes to the model on every call. Spec 09. */
  readonly userName: string
  /** Reloads the settings answers, which no other write invalidates. */
  readonly reloadSettings: () => Promise<void>
  /** The configured waiting staleness threshold, defaulted until the config arrives. */
  readonly staleDays: number
  /** The zone a due or defer-until date typed into the board resolves in, defaulted to UTC
   *  until the config arrives. Kept the same as `jobs.timezone` so the board and the chat
   *  tool agree on what a calendar date means. */
  readonly timezone: string
  /** Whether `GET /api/config` has settled, one way or the other. `reload()` clearing `loading`
   *  says the board is on screen; it says nothing about whether `timezone` is the deployment's
   *  real zone yet or still the UTC default. A date typed and submitted in that gap would be
   *  silently resolved against the wrong zone, so callers that let a date be set gate on this
   *  too, not just on `loading`. */
  readonly configLoaded: boolean
  readonly loading: boolean
  readonly failure: string | null
  /** How many tasks exist, when that is more than the client fetched. Null when it is not. */
  readonly unfetchedTaskTotal: number | null
  readonly reload: () => Promise<void>
}

/** Spec 02's default, used until `GET /api/config` says otherwise. */
const DEFAULT_STALE_DAYS = 7

/** Used until `GET /api/config` says otherwise: a date typed before then resolves in UTC
 *  rather than in whatever zone the deployment is actually configured for. */
const DEFAULT_TIMEZONE = 'UTC'

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

/**
 * `enabled` gates the fetches rather than the hook itself, because hooks cannot be called
 * conditionally: while a login is required and not yet complete, nothing here is fetched, so an
 * unauthenticated load does not spend its first render as a wall of 401s before the login screen
 * appears. Defaults to true, which is every existing caller: a deployment with no login needed
 * reads exactly as it always has.
 */
export function useCarolineData(enabled = true): CarolineData {
  const [tasks, setTasks] = useState<readonly TaskView[]>([])
  const [projects, setProjects] = useState<readonly ProjectView[]>([])
  const [health, setHealth] = useState<Health | null>(null)
  const [jobRuns, setJobRuns] = useState<readonly JobRun[]>([])
  const [jobStatus, setJobStatus] = useState<readonly JobStatus[]>([])
  const [spend, setSpend] = useState<SpendReport | null>(null)
  const [plan, setPlan] = useState<PlanView | null>(null)
  const [planHistory, setPlanHistory] = useState<readonly PlanHistoryDay[]>([])
  const [planDate, setPlanDate] = useState<string | null>(null)
  const [calendar, setCalendar] = useState<CalendarDay | null>(null)
  const [google, setGoogle] = useState<GoogleStatus | null>(null)
  const [preview, setPreview] = useState<PrivacyPreview | null>(null)
  const [mcpClients, setMcpClients] = useState<readonly McpClientView[] | null>(null)
  const [userName, setUserName] = useState('')
  const [staleDays, setStaleDays] = useState(DEFAULT_STALE_DAYS)
  const [timezone, setTimezone] = useState(DEFAULT_TIMEZONE)
  const [configLoaded, setConfigLoaded] = useState(false)
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

    /**
     * What each secondary panel's request said if it failed. A panel that could not be read
     * keeps whatever it last showed, so the screen stays useful, but the failure is reported:
     * silently keeping stale data is how a dashboard comes to be trusted while being wrong.
     */
    const panelFailures: string[] = []

    const panel = async <T>(what: string, request: Promise<T>): Promise<T | null> => {
      try {
        return await request
      } catch (error) {
        panelFailures.push(`${what} could not be loaded (${describeFailure(error)})`)
        return null
      }
    }

    try {
      // The run history, the plan and the calendar reload alongside the tasks: a sync that just
      // finished changed several of them at once, and completing something from the plan
      // changes how the entry renders. Each is defended on its own, so one failing panel does
      // not blank the board. The tasks and the projects are not: they are the board, and a
      // board that cannot be read is the whole screen failing rather than a panel of it.
      const [taskCollection, projectList, runs, status, day, diary, models] = await Promise.all([
        api.listTasks(),
        api.listProjects(),
        panel('the run history', api.listJobRuns()),
        panel('the job status', api.listJobStatus()),
        panel("today's plan", api.getPlan()),
        panel('the calendar', api.getCalendar()),
        panel('the model spend', api.getSpend()),
      ])
      if (mine !== generation.current) return

      setTasks(taskCollection.tasks)
      setProjects(projectList.projects)
      if (runs !== null) setJobRuns(runs.runs)
      if (models !== null) setSpend(models)

      // The two were asked independently, so they can straddle the server's midnight and
      // describe different days. The plan's date wins and the diary is re-read for it: a
      // capacity bar comparing one day's plan against another day's calendar is worse than a
      // panel that is one beat late.
      const diaryForPlanDay =
        day !== null && diary !== null && diary.date !== day.date
          ? await panel('the calendar', api.getCalendar(day.date))
          : diary
      if (mine !== generation.current) return

      // A failed request is not an empty day. Blanking on failure would report "No plan yet"
      // for a route that is merely unreachable, so the last good answer stands and the banner
      // says which panel could not be read.
      if (day !== null) {
        setPlan(day.plan)
        setPlanHistory(day.history)
        // The server's idea of today, not the browser's: they can differ across midnight, and
        // the regenerate button has to name the date the plan was actually read for.
        setPlanDate(day.date)
      }
      if (diaryForPlanDay !== null) setCalendar(diaryForPlanDay)
      if (day === null && diary !== null) setPlanDate(diary.date)
      // Defended rather than trusted: the board must not go blank because one panel's answer was
      // not the shape it should have been.
      if (status !== null) setJobStatus(status.jobs ?? [])
      setUnfetchedTaskTotal(taskCollection.truncated ? taskCollection.total : null)
      setFailure(panelFailures.length === 0 ? null : panelFailures.join('; '))
    } catch (error) {
      if (mine !== generation.current) return
      // The board itself could not be read, which is a different failure from a panel of it.
      setFailure(`Cannot reach the server: ${describeFailure(error)}`)
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

    const [connection, payload, settings, clients] = await Promise.all([
      api.getGoogleStatus().catch(() => null),
      api.getPrivacyPreview().catch(() => null),
      api.getSettings().catch((): SettingsView | null => null),
      api
        .listMcpClients()
        .then((response) => response.clients)
        .catch(() => null),
    ])

    // The same guard `reload` uses, for the same reason: opening Settings and pressing Refresh can
    // have two of these in flight, and the slower one finishing last would put the older answer
    // back on the screen.
    if (mine !== settingsGeneration.current) return

    setGoogle(connection)
    setMcpClients(clients)
    setPreview(payload)
    // A failed read leaves the last answer standing rather than blanking the field, which would
    // read as "nobody has said" and invite the name being typed in again.
    if (settings !== null) setUserName(settings.userName)
  }, [])

  useEffect(() => {
    if (!enabled) return

    void reload()

    // Health and config are read once. Neither changes without a restart, and a failure to
    // read either is not a reason to withhold the tasks: the dashboard shows what it has.
    void api
      .getHealth()
      .then(setHealth)
      .catch(() => setHealth(null))
    void api
      .getConfig()
      .then((config) => {
        setStaleDays(config.tasks.waitingStaleDays)
        setTimezone(config.jobs.timezone)
      })
      .catch(() => {
        setStaleDays(DEFAULT_STALE_DAYS)
        setTimezone(DEFAULT_TIMEZONE)
      })
      // Either way, the answer this render is going to get has arrived: a refusal settles on the
      // UTC default deliberately, the same as a slow-but-eventual success settles on the real
      // zone. `configLoaded` is what a write path gates on, not `timezone` itself, because a
      // caller cannot tell a resolved UTC default apart from an unresolved one by its value alone.
      .finally(() => setConfigLoaded(true))
  }, [reload, enabled])

  useEffect(() => {
    if (!enabled) return () => {}
    return subscribeToChanges(() => void reload())
  }, [reload, enabled])

  return {
    tasks,
    projects,
    health,
    jobRuns,
    jobStatus,
    spend,
    plan,
    planHistory,
    planDate,
    calendar,
    google,
    preview,
    mcpClients,
    userName,
    staleDays,
    timezone,
    configLoaded,
    loading,
    failure,
    unfetchedTaskTotal,
    reload,
    reloadSettings,
  }
}
