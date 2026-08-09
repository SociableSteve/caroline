import type { FastifyInstance, FastifyReply } from 'fastify'
import {
  createProject,
  deleteProject,
  getProject,
  listProjects,
  updateProject,
  type ProjectPatch,
} from '../../db/repositories/projects.js'
import { listSourcesForTask } from '../../db/repositories/sources.js'
import { listProjectTasks, getTaskTags } from '../../db/repositories/tasks.js'
import {
  deriveNextAction,
  isStalled,
  type Project,
  type ProjectState,
} from '../../domain/project.js'
import { apiError } from '../errors.js'
import {
  createProjectBodySchema,
  idParamsSchema,
  patchProjectBodySchema,
  projectListQuerySchema,
  projectListResponseSchema,
  projectResponseSchema,
} from '../schemas.js'
import { toTaskResponse, type RouteContext, type TaskResponse } from './tasks.js'

/** The project as the API returns it: the row, plus the two fields spec 01 derives. */
export interface ProjectResponse extends Project {
  readonly nextAction: TaskResponse | null
  readonly stalled: boolean
}

interface ProjectBody {
  title?: string
  notes?: string | null
  state?: ProjectState
}

/**
 * The create body, where the schema makes `title` required. Typed separately so the compiler
 * knows it is there rather than the handler defaulting it: a fallback would turn a schema
 * change into a project with an empty title instead of the 400 it should be.
 */
interface CreateProjectBody extends ProjectBody {
  title: string
}

function notFound(reply: FastifyReply): FastifyReply {
  return reply.status(404).send(apiError('not_found', 'No such project'))
}

function toPatch(body: ProjectBody): ProjectPatch {
  return {
    ...(body.title === undefined ? {} : { title: body.title.trim() }),
    ...(body.notes === undefined ? {} : { notes: body.notes }),
    ...(body.state === undefined ? {} : { state: body.state }),
  }
}

export function registerProjectRoutes(
  app: FastifyInstance,
  { database, changes, now }: RouteContext,
): void {
  const announce = (at: number) => changes.publish({ kind: 'projects', at })

  /**
   * The next action and the stalled flag are computed here on every read rather than stored,
   * so they cannot go stale behind a task that moved. Spec 01, criterion 4.
   */
  const describe = (project: Project): ProjectResponse => {
    const tasks = listProjectTasks(database, project.id)
    const nextAction = deriveNextAction(tasks)

    return {
      ...project,
      nextAction:
        nextAction === null
          ? null
          : toTaskResponse(
              nextAction,
              getTaskTags(database, nextAction.id),
              listSourcesForTask(database, nextAction.id),
            ),
      stalled: isStalled(project, tasks),
    }
  }

  app.get<{ Querystring: { state?: ProjectState } }>(
    '/api/projects',
    {
      schema: {
        querystring: projectListQuerySchema,
        response: { 200: projectListResponseSchema },
      },
    },
    async (request) => {
      const { state } = request.query
      const projects = state === undefined ? listProjects(database) : listProjects(database, state)

      return { projects: projects.map(describe) }
    },
  )

  app.post<{ Body: CreateProjectBody }>(
    '/api/projects',
    {
      schema: {
        body: createProjectBodySchema,
        response: { 201: projectResponseSchema },
      },
    },
    async (request, reply) => {
      const at = now()
      // No `?? ''` anywhere: the type carries the schema's promise that a title is present,
      // so a schema that stopped requiring one would fail to compile rather than quietly
      // creating a project with no title.
      const project = createProject(
        database,
        { ...toPatch(request.body), title: request.body.title.trim() },
        at,
      )

      announce(at)

      return reply.status(201).send(describe(project))
    },
  )

  app.get<{ Params: { id: string } }>(
    '/api/projects/:id',
    {
      schema: {
        params: idParamsSchema,
        response: { 200: projectResponseSchema },
      },
    },
    async (request, reply) => {
      const project = getProject(database, request.params.id)
      if (project === null) return notFound(reply)

      return describe(project)
    },
  )

  app.patch<{ Params: { id: string }; Body: ProjectBody }>(
    '/api/projects/:id',
    {
      schema: {
        params: idParamsSchema,
        body: patchProjectBodySchema,
        response: { 200: projectResponseSchema },
      },
    },
    async (request, reply) => {
      const at = now()
      const updated = updateProject(database, request.params.id, toPatch(request.body), at)
      if (updated === null) return notFound(reply)

      announce(at)

      return describe(updated)
    },
  )

  app.delete<{ Params: { id: string } }>(
    '/api/projects/:id',
    {
      schema: {
        params: idParamsSchema,
        response: { 204: { type: 'null' } },
      },
    },
    async (request, reply) => {
      const at = now()
      // The tasks are not deleted with it, they are orphaned by the foreign key. Spec 01,
      // criterion 6. Which is why this announces a task change as well: cards that were
      // showing a project no longer are.
      if (!deleteProject(database, request.params.id)) return notFound(reply)

      announce(at)
      changes.publish({ kind: 'tasks', at })

      return reply.status(204).send()
    },
  )
}
