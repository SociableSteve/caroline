/**
 * The one place the client talks to the server. Every call goes through `request`, so the
 * standard error shape (spec 08) is unwrapped once and the rest of the UI can deal in
 * ordinary rejected promises.
 *
 * The task and project types come from `src/domain`, which is pure and has no IO in it, so
 * the client and the server describe the same things in the same words rather than keeping
 * two copies of the vocabulary in step by hand.
 */
import type { Project, ProjectState } from '../src/domain/project.js'
import { taskStatuses, type Task, type TaskStatus } from '../src/domain/task.js'

export type { Project, ProjectState, Task, TaskStatus }
export { taskStatuses }

/** The columns the board shows. `done` is not one of them: finished work leaves the board. */
export const boardStatuses: readonly TaskStatus[] = taskStatuses.filter(
  (status) => status !== 'done',
)

/** A task as the API returns it: the stored row plus its tags. */
export interface TaskView extends Task {
  readonly tags: string[]
}

/** A project as the API returns it, with the two fields spec 01 derives rather than stores. */
export interface ProjectView extends Project {
  readonly nextAction: TaskView | null
  readonly stalled: boolean
}

export interface TaskPage {
  readonly tasks: TaskView[]
  readonly total: number
  readonly limit: number
  readonly offset: number
}

/** Every matching task the client could fetch, and whether that was all of them. */
export interface TaskCollection {
  readonly tasks: TaskView[]
  readonly total: number
  /** True when the ceiling was hit and `tasks` is therefore not the whole answer. */
  readonly truncated: boolean
}

export interface IntegrationStatus {
  readonly configured: boolean
  readonly status: string
}

export interface Health {
  readonly status: string
  readonly version: string
  readonly uptimeSeconds: number
  readonly database?: { status: string }
  readonly integrations: Record<string, IntegrationStatus>
}

/** Only the parts of the redacted config the UI reads. The route returns rather more. */
export interface ClientConfig {
  readonly tasks: { readonly waitingStaleDays: number }
}

export interface TaskFilter {
  readonly status?: TaskStatus
  readonly projectId?: string
  readonly tag?: string
  readonly search?: string
}

export interface TaskInput {
  readonly title?: string
  readonly notes?: string | null
  readonly status?: TaskStatus
  readonly projectId?: string | null
  readonly sortOrder?: number
  readonly estimateMinutes?: number | null
  readonly dueAt?: number | null
  readonly deferUntil?: number | null
  readonly waitingOn?: string | null
  readonly tags?: string[]
}

export interface ProjectInput {
  readonly title?: string
  readonly notes?: string | null
  readonly state?: ProjectState
}

export interface BulkResult {
  readonly id: string
  readonly applied: boolean
  readonly reason?: string
}

/** A request the server refused, carrying what it said about why. */
export class ApiFailure extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'ApiFailure'
    this.status = status
    this.code = code
  }
}

/**
 * A single-user process with one browser tab has no use for paging in the UI, so the board
 * fetches everything and groups it client-side. It still has to fetch it: done tasks
 * accumulate for as long as Caroline is used, so one page is not a safe assumption. The page
 * size is the server's own maximum.
 */
const PAGE = 500

/**
 * The most the client will fetch in one pass, as a guard rather than an expectation: without
 * one, a database far larger than this design anticipates would have the UI issue requests
 * until the tab gave up. Hitting it is reported rather than hidden, so the screen never
 * quietly shows a subset.
 */
const MAX_TASKS = 5_000

function errorFrom(status: number, body: unknown): ApiFailure {
  const error = (body as { error?: { code?: unknown; message?: unknown } } | null)?.error
  const code = typeof error?.code === 'string' ? error.code : 'unknown'
  const message =
    typeof error?.message === 'string' ? error.message : `The server answered ${status}`

  return new ApiFailure(status, code, message)
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    ...(init?.body === undefined ? {} : { headers: { 'content-type': 'application/json' } }),
  })

  if (!response.ok) {
    // A body that is not the standard shape is still a failure worth reporting, so parsing
    // it is allowed to fail without taking the failure itself with it.
    const body = await response.json().catch(() => null)
    throw errorFrom(response.status, body)
  }

  // 204 has no body, and asking for one throws.
  if (response.status === 204) return undefined as T

  return (await response.json()) as T
}

function send<T>(method: string, path: string, body?: unknown): Promise<T> {
  return request<T>(path, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

/** Ids reach the path, so they are escaped: a task id is opaque text, not a path fragment. */
function taskPath(id: string, suffix = ''): string {
  return `/api/tasks/${encodeURIComponent(id)}${suffix}`
}

function projectPath(id: string): string {
  return `/api/projects/${encodeURIComponent(id)}`
}

export const api = {
  /** One page. Exposed for the tests and for anything that genuinely wants a window. */
  listTaskPage(filter: TaskFilter = {}, offset = 0): Promise<TaskPage> {
    const query = new URLSearchParams({ limit: String(PAGE), offset: String(offset) })
    for (const [key, value] of Object.entries(filter)) {
      if (value !== undefined) query.set(key, String(value))
    }

    return request<TaskPage>(`/api/tasks?${query.toString()}`)
  },

  /**
   * Every matching task, following the pages until the server's own total is met: the board
   * and the dashboard read from one call and each decides what to show. Deferred tasks are
   * left out by the server unless asked for, and the filter is the caller's, which is what
   * the project drill-in uses.
   */
  async listTasks(filter: TaskFilter = {}): Promise<TaskCollection> {
    const tasks: TaskView[] = []
    let total = 0

    for (;;) {
      const page = await api.listTaskPage(filter, tasks.length)
      total = page.total
      tasks.push(...page.tasks)

      // An empty page ends it whatever the total says, so a total that disagrees with the rows
      // cannot spin here.
      if (page.tasks.length === 0) break
      if (tasks.length >= total) break
      if (tasks.length >= MAX_TASKS) return { tasks, total, truncated: true }
    }

    return { tasks, total, truncated: false }
  },

  createTask(input: TaskInput): Promise<TaskView> {
    return send<TaskView>('POST', '/api/tasks', input)
  },

  patchTask(id: string, input: TaskInput): Promise<TaskView> {
    return send<TaskView>('PATCH', taskPath(id), input)
  },

  completeTask(id: string): Promise<TaskView> {
    return send<TaskView>('POST', taskPath(id, '/complete'))
  },

  deleteTask(id: string): Promise<void> {
    return send<void>('DELETE', taskPath(id))
  },

  setTracking(id: string, enabled: boolean): Promise<TaskView> {
    return send<TaskView>('POST', taskPath(id, '/tracking'), { enabled })
  },

  bulkTasks(input: {
    ids: string[]
    status?: TaskStatus
    projectId?: string | null
  }): Promise<{ results: BulkResult[] }> {
    return send('POST', '/api/tasks/bulk', input)
  },

  listProjects(): Promise<{ projects: ProjectView[] }> {
    return request('/api/projects')
  },

  createProject(input: ProjectInput): Promise<ProjectView> {
    return send<ProjectView>('POST', '/api/projects', input)
  },

  patchProject(id: string, input: ProjectInput): Promise<ProjectView> {
    return send<ProjectView>('PATCH', projectPath(id), input)
  },

  deleteProject(id: string): Promise<void> {
    return send<void>('DELETE', projectPath(id))
  },

  getHealth(): Promise<Health> {
    return request<Health>('/api/health')
  },

  getConfig(): Promise<ClientConfig> {
    return request<ClientConfig>('/api/config')
  },
}
