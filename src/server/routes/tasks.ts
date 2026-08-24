import type { FastifyInstance, FastifyReply } from 'fastify'
import { withTransaction } from '../../db/connection.js'
import {
  listPendingProposals,
  markProposalAccepted,
  markProposalDismissed,
  pendingProposal,
} from '../../db/repositories/classifications.js'
import { getProject } from '../../db/repositories/projects.js'
import { listSourcesForTask, listSourcesForTasks } from '../../db/repositories/sources.js'
import { markTaskReviewed, trackedStatuses } from '../../actions/tasks.js'
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
  blockerRefusal,
  setSyncTracking,
  setTaskBlocker,
  setTaskTags,
  undoTaskStatus,
  updateTask,
  type BlockerRefusal,
  type TaskPatch,
  type TaskQuery,
} from '../../db/repositories/tasks.js'
import type { Database } from '../../db/index.js'
import {
  mayRetitle,
  notesWithOriginalTitle,
  type Classification,
  type ProjectSuggestion,
} from '../../domain/classification.js'
import type { Source } from '../../domain/source.js'
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

/**
 * A source as the API returns it. The stored body and the hashing internals are not among
 * them: nothing in the UI reads a body, so nothing puts one on the wire (spec 09).
 */
export type SourceResponse = Omit<
  Source,
  | 'content'
  | 'contentLevel'
  | 'contentStoredAt'
  | 'contentHash'
  | 'taskId'
  | 'firstSeenAt'
  | 'lastSeenAt'
>

/**
 * A pending classifier proposal as the API returns it. The audit fields the UI has no use for are
 * left off: `applied` is false by definition here, and the acceptance stamps are null.
 */
export interface ProposalResponse {
  readonly id: string
  readonly status: TaskStatus
  readonly confidence: number
  readonly reasoning: string | null
  readonly suggestedTitle: string | null
  readonly estimateMinutes: number | null
  readonly waitingOn: string | null
  readonly projectSuggestion: ProjectSuggestion | null
  readonly model: string | null
  readonly promptVersion: string
  readonly createdAt: number
}

/** The task as the API returns it: the stored row, its tags, where it came from, and what the
 * classifier thinks, when it is not confident enough to have acted. */
export interface TaskResponse extends Task {
  readonly tags: string[]
  readonly sources: SourceResponse[]
  readonly proposal: ProposalResponse | null
}

/**
 * Only a proposal with a status and a confidence can be one: a row without them is a record of a
 * failed call, which is audit and not something to offer the user a button for.
 */
function toProposalResponse(classification: Classification): ProposalResponse | null {
  if (classification.proposedStatus === null || classification.confidence === null) return null

  return {
    id: classification.id,
    status: classification.proposedStatus,
    confidence: classification.confidence,
    reasoning: classification.reasoning,
    suggestedTitle: classification.suggestedTitle,
    estimateMinutes: classification.estimateMinutes,
    waitingOn: classification.waitingOn,
    projectSuggestion: classification.projectSuggestion,
    model: classification.model,
    promptVersion: classification.promptVersion,
    createdAt: classification.createdAt,
  }
}

/** Named rather than subtracted, so a field added to `Source` is not published by default. */
function toSourceResponse(source: Source): SourceResponse {
  return {
    id: source.id,
    provider: source.provider,
    externalId: source.externalId,
    url: source.url,
    title: source.title,
    metadata: source.metadata,
    resolvedAt: source.resolvedAt,
    suppressedAt: source.suppressedAt,
    lifecycleState: source.lifecycleState,
    actedAt: source.actedAt,
    actedAtMarker: source.actedAtMarker,
    requeuedAt: source.requeuedAt,
    completionProposedAt: source.completionProposedAt,
  }
}

/**
 * Both lists are required rather than defaulted. A default meant the projects route could
 * return a next action with no provenance while `/api/tasks` returned the same task with
 * its source, and nothing would have said so.
 */
export function toTaskResponse(
  task: Task,
  tags: readonly string[],
  sources: readonly Source[],
  proposal: Classification | null = null,
): TaskResponse {
  return {
    ...task,
    tags: [...tags],
    sources: sources.map(toSourceResponse),
    proposal: proposal === null ? null : toProposalResponse(proposal),
  }
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

/** The refusals `setTaskBlocker` returns, in the words a person reads. Spec 08, criterion 52. */
const blockerMessages: Record<BlockerRefusal, string> = {
  'not-found': 'No such task',
  'no-such-blocker': 'No such blocking task',
  cycle: 'That would block the task behind itself, directly or through a chain of blockers',
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
  blockedBy?: string | null
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
  /**
   * A task write announces both kinds. A project's next action and stalled flag are derived
   * from its tasks, so moving, completing, creating or deleting a task can change a project
   * without touching the projects table: a client subscribed only to `projects` would
   * otherwise show a stale next action. The projects routes are symmetric about this, since
   * deleting a project changes its tasks. The feed is deliberately coarse, and the cost of a
   * kind that did not strictly need announcing is one reload of a short list.
   */
  const announce = (at: number) => {
    changes.publish({ kind: 'tasks', at })
    changes.publish({ kind: 'projects', at })
  }

  /** Reads the task back whole, which is what every write responds with. */
  const responseFor = (id: string): TaskResponse | null => {
    const task = getTask(database, id)
    return task === null
      ? null
      : toTaskResponse(
          task,
          getTaskTags(database, id),
          listSourcesForTask(database, id),
          pendingProposal(database, id),
        )
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
      const ids = page.tasks.map((task) => task.id)
      const tags = listTags(database, ids)
      const sources = listSourcesForTasks(database, ids)
      const proposals = listPendingProposals(database, ids)

      return {
        tasks: page.tasks.map((task) =>
          toTaskResponse(
            task,
            tags.get(task.id) ?? [],
            sources.get(task.id) ?? [],
            proposals.get(task.id) ?? null,
          ),
        ),
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

      // A task nothing points at yet cannot be in a cycle, so existence is the whole of the check
      // on the way in. Spec 01, criterion 13.
      if (
        body.blockedBy !== null &&
        body.blockedBy !== undefined &&
        getTask(database, body.blockedBy) === null
      ) {
        return badRequest(reply, blockerMessages['no-such-blocker'])
      }

      const at = now()
      const created = withTransaction(database, () => {
        const task = createTask(
          database,
          {
            ...toPatch(body),
            // Required by the schema, so it is present whatever the optional type says.
            title: body.title ?? '',
            // Naming a blocker files the task as blocked, whatever `status` says: the two are
            // one fact. Spec 01, criterion 12.
            ...(body.blockedBy === undefined ? {} : { blockedBy: body.blockedBy }),
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

      // Asked before anything is written, and answered as a bad request rather than as a
      // constraint violation: a caller that named a blocker that does not exist, or one that
      // would come back round to this task, has named something wrong. Spec 08, criterion 52.
      const refused =
        body.blockedBy === undefined ? null : blockerRefusal(database, id, body.blockedBy)
      if (refused !== null) {
        return refused === 'not-found'
          ? notFound(reply, 'task')
          : badRequest(reply, blockerMessages[refused])
      }

      withTransaction(database, () => {
        // First, because naming a blocker is itself a status change and an explicit `status` in
        // the same request is the later word. Spec 01, criteria 12 and 13.
        if (body.blockedBy !== undefined) setTaskBlocker(database, id, body.blockedBy, at)

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
      // Hard delete, and only ever from here: sync never deletes a task. Spec 01. Anything
      // blocked behind it is released in the same transaction, so nothing is left claiming to
      // be blocked behind a task that has gone. Criterion 15.
      const at = now()
      if (!deleteTask(database, request.params.id, at)) return notFound(reply, 'task')

      announce(at)

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

  /**
   * Discharging your part of a review from Caroline. The action itself is in
   * `src/actions/tasks.ts`, because spec 07 gives chat a `mark_reviewed` tool with the same
   * effect and two implementations of "the same effect" would not stay the same for long. This
   * route turns its refusals into the messages a person reads.
   */
  app.post<{ Params: { id: string } }>(
    '/api/tasks/:id/mark-reviewed',
    {
      schema: {
        params: idParamsSchema,
        response: { 200: taskResponseSchema },
      },
    },
    async (request, reply) => {
      const { id } = request.params
      const at = now()
      const result = markTaskReviewed(database, id, at)

      if (!result.applied) {
        switch (result.reason) {
          case 'no-task':
            return notFound(reply, 'task')
          // Already discharged, so the task as it stands is the answer: a repeated request is a
          // no-op rather than a fresh stamp.
          case 'already-reviewed':
            return responseFor(id)
          case 'not-a-review':
            return badRequest(reply, 'This task is not an open pull request awaiting your review')
          case 'not-tracked':
            return badRequest(
              reply,
              'Sync tracking is off for this task. Turn it back on to follow the review again.',
            )
          case 'unsynced':
            return badRequest(reply, 'This pull request has not been synced yet')
        }
      }

      announce(at)

      return responseFor(id)
    },
  )

  /**
   * Accepting the classifier's proposal. The status becomes the one it suggested, attributed to the
   * user rather than to the model: they read it and agreed, which is a decision of theirs and locks
   * the classifier out of the task from here on. Spec 04, criterion 9.
   *
   * The suggested title is applied on the same terms the classifier itself would have: only while
   * the item's own title has not been rewritten, with the original kept in the notes.
   */
  app.post<{ Params: { id: string } }>(
    '/api/tasks/:id/proposal/accept',
    {
      schema: {
        params: idParamsSchema,
        response: { 200: taskResponseSchema },
      },
    },
    async (request, reply) => {
      const { id } = request.params
      const task = getTask(database, id)
      if (task === null) return notFound(reply, 'task')

      const proposal = pendingProposal(database, id)
      // Narrowed into locals rather than asserted below: the checks are here, and a cast further
      // down would only restate them while hiding a later change to `Classification`.
      const proposedStatus = proposal?.proposedStatus ?? null
      if (proposal === null || proposedStatus === null) {
        return badRequest(reply, 'There is no proposal waiting on this task')
      }

      const at = now()
      const source = listSourcesForTask(database, id)[0] ?? null
      const suggestedTitle = proposal.suggestedTitle
      const retitling =
        suggestedTitle !== null &&
        suggestedTitle.trim() !== '' &&
        suggestedTitle !== task.title &&
        mayRetitle(task.title, source?.title ?? null)

      // The same tracked statuses every other user status change passes. Accepting a suggestion is
      // the user deciding where the task goes, so filing it outside its connector's set is the same
      // permanent opt-out it would be from the status control. Spec 01, sync tracking.
      const statuses = trackedStatuses(database, task)

      withTransaction(database, () => {
        changeTaskStatus(database, id, {
          status: proposedStatus,
          by: 'user',
          at,
          ...(statuses === undefined ? {} : { trackedStatuses: statuses }),
        })
        updateTask(
          database,
          id,
          {
            ...(retitling
              ? {
                  title: suggestedTitle,
                  notes: notesWithOriginalTitle(task.notes, task.title),
                }
              : {}),
            ...(task.estimateMinutes === null && proposal.estimateMinutes !== null
              ? { estimateMinutes: proposal.estimateMinutes }
              : {}),
            ...(proposedStatus === 'waiting' ? { waitingOn: proposal.waitingOn } : {}),
          },
          at,
        )
        markProposalAccepted(database, proposal.id, at)
      })

      announce(at)

      return responseFor(id)
    },
  )

  /**
   * Dismissing it. The task stays exactly where it is, and the row records that the user looked:
   * that is what stops the classifier asking the same question again next hour, and it is the
   * correction the evaluation set is for. Spec 04.
   */
  app.post<{ Params: { id: string } }>(
    '/api/tasks/:id/proposal/dismiss',
    {
      schema: {
        params: idParamsSchema,
        response: { 200: taskResponseSchema },
      },
    },
    async (request, reply) => {
      const { id } = request.params
      if (getTask(database, id) === null) return notFound(reply, 'task')

      const proposal = pendingProposal(database, id)
      if (proposal === null) return badRequest(reply, 'There is no proposal waiting on this task')

      const at = now()
      markProposalDismissed(database, proposal.id, at)
      announce(at)

      return responseFor(id)
    },
  )

  /**
   * Putting the last status change back. Its own route because `PATCH` cannot express it: the API
   * is the user, and a user cannot claim to be the classifier, but restoring the previous actor is
   * the whole point. Spec 08, criteria 16 and 17.
   *
   * One step, and only the most recent change: this is not a history feature.
   */
  app.post<{ Params: { id: string } }>(
    '/api/tasks/:id/undo-status',
    {
      schema: {
        params: idParamsSchema,
        response: { 200: taskResponseSchema },
      },
    },
    async (request, reply) => {
      const { id } = request.params
      const at = now()
      const result = undoTaskStatus(database, id, at)
      if (result === null) return notFound(reply, 'task')

      if (!result.undone) {
        // Two different conflicts, said differently. A move out of `blocked` took the blocker with
        // it, and the status cannot stand without one, so the way back is to name it again rather
        // than to undo. Spec 01, criterion 18.
        const message =
          result.reason === 'blocked-needs-blocker'
            ? 'This task was blocked, and the blocker went with the move. Name the blocker again rather than putting the move back.'
            : 'This task has no status change to put back'

        return reply.status(409).send(apiError('conflict', message))
      }

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
