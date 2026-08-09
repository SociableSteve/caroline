import type { FastifyInstance, FastifyReply } from 'fastify'
import { withTransaction } from '../../db/connection.js'
import { getProject } from '../../db/repositories/projects.js'
import { listSourcesForTask } from '../../db/repositories/sources.js'
import {
  bulkAssignProject,
  bulkChangeStatus,
  changeTaskStatus,
  createTask,
  deleteTask,
  getTask,
  getTaskTags,
  listTags,
  listTasks,
  setSyncTracking,
  setTaskTags,
  updateTask,
  type TaskPatch,
  type TaskQuery,
} from '../../db/repositories/tasks.js'
import type { Database } from '../../db/index.js'
import { trackedStatusesFor } from '../../domain/tracking.js'
import type { Task, TaskStatus } from '../../domain/task.js'
import { apiError } from '../errors.js'
import type { ChangeFeed } from '../changes.js'
import {
  bulkBodySchema,
  bulkResponseSchema,
  createTaskBodySchema,
  idParamsSchema,
  patchTaskBodySchema,
  taskListQuerySchema,
  taskListResponseSchema,
  taskResponseSchema,
  trackingBodySchema,
} from '../schemas.js'

export interface RouteContext {
  readonly database: Database
  readonly changes: ChangeFeed
  readonly now: () => number
}

/** The task as the API returns it: the stored row, plus the tags that live beside it. */
export interface TaskResponse extends Task {
  readonly tags: string[]
}

export function toTaskResponse(task: Task, tags: readonly string[] = []): TaskResponse {
  return { ...task, tags: [...tags] }
}

function notFound(reply: FastifyReply, what: string): FastifyReply {
  return reply.status(404).send(apiError('not_found', `No such ${what}`))
}

function badRequest(reply: FastifyReply, message: string): FastifyReply {
  return reply.status(400).send(apiError('bad_request', message))
}

/**
 * A project id that does not exist would otherwise reach the foreign key and come back as a
 * 500. It is a bad request: the caller named something that is not there.
 */
function missingProject(database: Database, projectId: string | null | undefined): boolean {
  return projectId !== null && projectId !== undefined && getProject(database, projectId) === null
}

/**
 * The statuses the task's connector owns, for a task sync still tracks. Passing them is what
 * makes a user filing the task outside that set a permanent opt-out. Spec 01, sync tracking.
 */
function trackedStatuses(database: Database, task: Task): readonly TaskStatus[] | undefined {
  if (!task.syncTracked) return undefined

  for (const source of listSourcesForTask(database, task.id)) {
    const statuses = trackedStatusesFor(source.provider)
    if (statuses !== undefined) return statuses
  }

  return undefined
}

interface TaskListQuery {
  status?: TaskStatus[]
  projectId?: string
  tag?: string
  dueBefore?: number
  search?: string
  includeDeferred: boolean
  limit: number
  offset: number
}

interface TaskBody {
  title?: string
  notes?: string | null
  status?: TaskStatus
  projectId?: string | null
  sortOrder?: number
  estimateMinutes?: number | null
  dueAt?: number | null
  deferUntil?: number | null
  waitingOn?: string | null
  tags?: string[]
}

interface BulkBody {
  ids: string[]
  status?: TaskStatus
  projectId?: string | null
}

/** The writable fields other than status and tags, which take their own paths. */
function toPatch(body: TaskBody): TaskPatch {
  const { title, notes, projectId, sortOrder, estimateMinutes, dueAt, deferUntil, waitingOn } = body

  return {
    ...(title === undefined ? {} : { title: title.trim() }),
    ...(notes === undefined ? {} : { notes }),
    ...(projectId === undefined ? {} : { projectId }),
    ...(sortOrder === undefined ? {} : { sortOrder }),
    ...(estimateMinutes === undefined ? {} : { estimateMinutes }),
    ...(dueAt === undefined ? {} : { dueAt }),
    ...(deferUntil === undefined ? {} : { deferUntil }),
    ...(waitingOn === undefined ? {} : { waitingOn }),
  }
}

export function registerTaskRoutes(
  app: FastifyInstance,
  { database, changes, now }: RouteContext,
): void {
  const announce = (at: number) => changes.publish({ kind: 'tasks', at })

  /** Reads the task back with its tags, which is what every write responds with. */
  const responseFor = (id: string): TaskResponse | null => {
    const task = getTask(database, id)
    return task === null ? null : toTaskResponse(task, getTaskTags(database, id))
  }

  app.get<{ Querystring: TaskListQuery }>(
    '/api/tasks',
    {
      schema: {
        querystring: taskListQuerySchema,
        response: { 200: taskListResponseSchema },
      },
    },
    async (request) => {
      const { status, projectId, tag, dueBefore, search, includeDeferred, limit, offset } =
        request.query

      const query: TaskQuery = {
        ...(status === undefined ? {} : { status }),
        ...(projectId === undefined ? {} : { projectId }),
        ...(tag === undefined ? {} : { tag }),
        ...(dueBefore === undefined ? {} : { dueBefore }),
        ...(search === undefined ? {} : { search }),
        includeDeferred,
        limit,
        offset,
      }

      const page = listTasks(database, query, now())
      const tags = listTags(
        database,
        page.tasks.map((task) => task.id),
      )

      return {
        tasks: page.tasks.map((task) => toTaskResponse(task, tags.get(task.id) ?? [])),
        total: page.total,
        limit,
        offset,
      }
    },
  )

  app.post<{ Body: TaskBody }>(
    '/api/tasks',
    {
      schema: {
        body: createTaskBodySchema,
        response: { 201: taskResponseSchema },
      },
    },
    async (request, reply) => {
      const body = request.body
      if (missingProject(database, body.projectId)) {
        return badRequest(reply, 'No such project')
      }

      const at = now()
      const created = withTransaction(database, () => {
        const task = createTask(
          database,
          {
            ...toPatch(body),
            // Required by the schema, so it is present whatever the optional type says.
            title: body.title ?? '',
            // Attribution is not the caller's to give: a status set through the API is the
            // user's, which is what `newTask` defaults to.
            ...(body.status === undefined ? {} : { status: body.status }),
          },
          at,
        )
        if (body.tags !== undefined) setTaskTags(database, task.id, body.tags)
        return task.id
      })

      announce(at)

      return reply.status(201).send(responseFor(created))
    },
  )

  /**
   * Bulk is registered before `/:id` routes are reachable for it, since `bulk` would
   * otherwise be a plausible task id. Fastify's router prefers the static segment, but the
   * ordering makes that explicit rather than incidental.
   */
  app.post<{ Body: BulkBody }>(
    '/api/tasks/bulk',
    {
      schema: {
        body: bulkBodySchema,
        response: { 200: bulkResponseSchema },
      },
    },
    async (request, reply) => {
      const { ids, status, projectId } = request.body
      if (missingProject(database, projectId)) return badRequest(reply, 'No such project')

      const at = now()
      const results =
        status === undefined
          ? bulkAssignProject(database, ids, projectId ?? null, at)
          : bulkChangeStatus(database, ids, { status, by: 'user', at })

      announce(at)

      return { results }
    },
  )

  app.patch<{ Params: { id: string }; Body: TaskBody }>(
    '/api/tasks/:id',
    {
      schema: {
        params: idParamsSchema,
        body: patchTaskBodySchema,
        response: { 200: taskResponseSchema },
      },
    },
    async (request, reply) => {
      const { id } = request.params
      const body = request.body

      const existing = getTask(database, id)
      if (existing === null) return notFound(reply, 'task')
      if (missingProject(database, body.projectId)) return badRequest(reply, 'No such project')

      const at = now()
      withTransaction(database, () => {
        const patch = toPatch(body)
        if (Object.keys(patch).length > 0) updateTask(database, id, patch, at)
        if (body.tags !== undefined) setTaskTags(database, id, body.tags)
        if (body.status !== undefined) {
          const statuses = trackedStatuses(database, existing)
          changeTaskStatus(database, id, {
            status: body.status,
            by: 'user',
            at,
            ...(statuses === undefined ? {} : { trackedStatuses: statuses }),
          })
        }
      })

      announce(at)

      return responseFor(id)
    },
  )

  app.delete<{ Params: { id: string } }>(
    '/api/tasks/:id',
    {
      schema: {
        params: idParamsSchema,
        response: { 204: { type: 'null' } },
      },
    },
    async (request, reply) => {
      // Hard delete, and only ever from here: sync never deletes a task. Spec 01.
      if (!deleteTask(database, request.params.id)) return notFound(reply, 'task')

      announce(now())

      return reply.status(204).send()
    },
  )

  app.post<{ Params: { id: string } }>(
    '/api/tasks/:id/complete',
    {
      schema: {
        params: idParamsSchema,
        response: { 200: taskResponseSchema },
      },
    },
    async (request, reply) => {
      const { id } = request.params
      const existing = getTask(database, id)
      if (existing === null) return notFound(reply, 'task')

      const at = now()
      const statuses = trackedStatuses(database, existing)
      changeTaskStatus(database, id, {
        status: 'done',
        by: 'user',
        at,
        ...(statuses === undefined ? {} : { trackedStatuses: statuses }),
      })

      announce(at)

      return responseFor(id)
    },
  )

  app.post<{ Params: { id: string }; Body?: { enabled?: boolean } }>(
    '/api/tasks/:id/tracking',
    {
      schema: {
        params: idParamsSchema,
        body: trackingBodySchema,
        response: { 200: taskResponseSchema },
      },
    },
    async (request, reply) => {
      const at = now()
      // Opting back in is explicit, which is the whole reason this route exists: sync never
      // re-enables itself. Spec 01, sync tracking.
      // Re-enabling is the default, and a request with no body at all says exactly that.
      const enabled = request.body?.enabled ?? true
      const updated = setSyncTracking(database, request.params.id, enabled, at)
      if (updated === null) return notFound(reply, 'task')

      announce(at)

      return responseFor(updated.id)
    },
  )
}
