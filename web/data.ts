/**
 * Everything the UI knows, loaded in one place. One fetch of tasks and one of projects serve
 * every surface, because a single-user process holding a few hundred tasks has nothing to gain
 * from per-view queries and plenty to lose from surfaces disagreeing with each other.
 *
 * The change feed (spec 08) is subscribed to here, so a write from anywhere, including a
 * background job once there are any, reloads what is on screen without a refresh.
 */
import { useCallback, useEffect, useState } from 'react'
import { api, ApiFailure, type Health, type ProjectView, type TaskView } from './api.js'

export interface CarolineData {
  readonly tasks: readonly TaskView[]
  readonly projects: readonly ProjectView[]
  readonly health: Health | null
  /** The configured waiting staleness threshold, defaulted until the config arrives. */
  readonly staleDays: number
  readonly loading: boolean
  readonly failure: string | null
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
  const [staleDays, setStaleDays] = useState(DEFAULT_STALE_DAYS)
  const [loading, setLoading] = useState(true)
  const [failure, setFailure] = useState<string | null>(null)

  const reload = useCallback(async () => {
    try {
      const [taskPage, projectList] = await Promise.all([api.listTasks(), api.listProjects()])
      setTasks(taskPage.tasks)
      setProjects(projectList.projects)
      setFailure(null)
    } catch (error) {
      setFailure(describeFailure(error))
    } finally {
      setLoading(false)
    }
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

  return { tasks, projects, health, staleDays, loading, failure, reload }
}
