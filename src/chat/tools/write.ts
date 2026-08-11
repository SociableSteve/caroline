/**
 * The tools that change things. Spec 07's write policy holds for every one of them:
 *
 * - The change is the user's, so it is attributed to the user and the classifier is locked out of
 *   the task from then on, exactly as a manual edit in the UI is. `mark_reviewed` is the one
 *   exception, and for the reason the UI action has it: it is a move inside the connector's own
 *   state machine rather than a decision about where a task belongs (spec 02).
 * - Every change is recorded with the inverse that would put it back, so a turn can be undone.
 * - Deleting waits for the user. `delete_task` never runs on the model's word alone, which is why
 *   it is declared `alwaysConfirm` and not merely careful.
 *
 * None of them reaches an external system: writing back to GitHub, Gmail or Calendar is a
 * non-goal of spec 02 and spec 07 alike, and the absence of any such tool is the enforcement.
 *
 * Every one of them is a send boundary too, and held to `llmContent` exactly as the read tools are: a
 * write tool answers with the row it wrote, which is item text the model never supplied. Spec 09's rule
 * is that a level is a property of the boundary rather than of a route through it, so a title the item
 * context withheld cannot come back through `complete_task`. The summaries recorded against a change
 * are not this: they are written to the database and shown on the user's own screen, and nothing
 * carries them to a provider.
 */
import { markTaskReviewed, trackedStatuses } from '../../actions/tasks.js'
import { WITHHELD_ITEM_TEXT } from '../../config/content.js'
import { withTransaction } from '../../db/connection.js'
import { createProject, getProject, updateProject } from '../../db/repositories/projects.js'
import {
  changeTaskStatus,
  createTask,
  deleteTask,
  getTask,
  updateTask,
} from '../../db/repositories/tasks.js'
import { projectStates, type ProjectState } from '../../domain/project.js'
import { taskStatuses, type Task, type TaskStatus } from '../../domain/task.js'
import {
  restoreProjectInverse,
  restoreTaskInverse,
  snapshotProject,
  snapshotTask,
} from '../snapshot.js'
import { defineTool, type ChatTool, type ChatToolContext } from '../types.js'
import { dateFrom, projectSummary, taskSummary, withholdsText, type DayArgument } from './shared.js'

/** The statuses a task may be filed into from chat. Completing has its own tool. */
const fileableStatuses = taskStatuses.filter((status) => status !== 'done')

const localDate = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' } as const

/** A local date, or `null` to clear the field. Every nullable field a tool sets is clearable. */
const clearableDate = {
  type: ['string', 'null'],
  pattern: '^\\d{4}-\\d{2}-\\d{2}$',
} as unknown as Record<string, unknown>

/** The fields a caller may set on a task, as JSON Schema. Shared by create and update. */
const taskFields = {
  title: { type: 'string', maxLength: 500, pattern: '\\S' },
  notes: { type: ['string', 'null'], maxLength: 20_000 },
  status: { type: 'string', enum: fileableStatuses },
  projectId: { type: ['string', 'null'], maxLength: 64 },
  estimateMinutes: { type: ['integer', 'null'], minimum: 1, maximum: 1440 },
  dueAt: {
    ...clearableDate,
    description: 'A local date, or null to remove the deadline. A deadline is the end of that day.',
  },
  deferUntil: {
    ...clearableDate,
    description:
      'A local date, or null to remove the deferral. A deferred task is hidden from Next actions until that morning.',
  },
  waitingOn: { type: ['string', 'null'], maxLength: 500 },
} as unknown as Record<string, unknown>

interface TaskFieldArguments {
  readonly title?: string
  readonly notes?: string | null
  readonly status?: TaskStatus
  readonly projectId?: string | null
  readonly estimateMinutes?: number | null
  readonly dueAt?: string | null
  readonly deferUntil?: string | null
  readonly waitingOn?: string | null
}

/**
 * The two date fields, read into instants, or the message saying which one is not a date.
 *
 * Three cases each, not two: absent leaves the field alone, a date sets it, and `null` clears it.
 * Without the third there would be no tool that could take a deadline off a task, which is a plain
 * thing to ask for.
 */
function readDates(
  context: ChatToolContext,
  args: TaskFieldArguments,
): { readonly dueAt?: number | null; readonly deferUntil?: number | null } | string {
  const due = readDate(context, args.dueAt)
  if (typeof due === 'string') return due

  const defer = readDate(context, args.deferUntil)
  if (typeof defer === 'string') return defer

  return {
    // A deadline is the end of the day named; a deferral lifts at the start of it.
    ...(due === undefined ? {} : { dueAt: due === null ? null : due.endOfDay }),
    ...(defer === undefined ? {} : { deferUntil: defer === null ? null : defer.startOfDay }),
  }
}

/** One of them: the day, `null` to clear, `undefined` to leave alone, or the complaint. */
function readDate(
  context: ChatToolContext,
  raw: string | null | undefined,
): DayArgument | null | undefined | string {
  if (raw === undefined) return undefined
  if (raw === null) return null

  const day = dateFrom(context, raw)
  return day === null ? `"${raw}" is not a date. Use YYYY-MM-DD.` : day
}

/**
 * How a task is named in a message the model reads. A refusal is prose about the item, so it is held to
 * the level the answer is held to: at `none` the task is named by the id the model called the tool with
 * and nothing else. Spec 09, criterion 13.
 */
function named(context: ChatToolContext, task: Task): string {
  return withholdsText(context) ? task.id : `“${task.title}”`
}

/** A project id that names nothing is the model's mistake, and is worth saying so plainly. */
function missingProject(context: ChatToolContext, projectId: string | null | undefined): boolean {
  return (
    projectId !== null &&
    projectId !== undefined &&
    getProject(context.database, projectId) === null
  )
}

const createTaskTool = defineTool<TaskFieldArguments & { readonly title: string }>({
  name: 'create_task',
  kind: 'write',
  description:
    'Create a task. It lands in the inbox unless a status is given. Use complete_task to finish something rather than creating it done.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['title'],
    properties: taskFields,
  },
  execute(context, args) {
    if (missingProject(context, args.projectId)) {
      return { ok: false, message: `There is no project with the id ${String(args.projectId)}.` }
    }

    const dates = readDates(context, args)
    if (typeof dates === 'string') return { ok: false, message: dates }

    const task = createTask(
      context.database,
      {
        title: args.title.trim(),
        ...(args.notes === undefined ? {} : { notes: args.notes }),
        ...(args.status === undefined ? {} : { status: args.status }),
        ...(args.projectId === undefined ? {} : { projectId: args.projectId }),
        ...(args.estimateMinutes === undefined ? {} : { estimateMinutes: args.estimateMinutes }),
        ...(args.waitingOn === undefined ? {} : { waitingOn: args.waitingOn }),
        ...dates,
        // Not passed as an option: `newTask` attributes a status to the user by default, which is
        // what a task created at the user's instruction is. Spec 07, criterion 1.
      },
      context.now,
    )

    return {
      ok: true,
      data: taskSummary(context, task),
      mutations: [
        {
          summary: `Created “${task.title}” in ${task.status}`,
          entity: 'task',
          entityId: task.id,
          inverse: [{ kind: 'delete-task', id: task.id }],
          taskIds: [task.id],
        },
      ],
    }
  },
})

const updateTaskTool = defineTool<{ readonly id: string } & TaskFieldArguments>({
  name: 'update_task',
  kind: 'write',
  description:
    'Change a task. Name only the fields that should change; the rest are left alone. A status change here is the user filing the task, which locks the classifier out of it.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['id'],
    // The id alone is not a change. A call that says nothing has not asked for anything.
    minProperties: 2,
    properties: { id: { type: 'string', maxLength: 64 }, ...taskFields },
  },
  execute(context, args) {
    const before = snapshotTask(context.database, args.id)
    if (before === null) return { ok: false, message: `There is no task with the id ${args.id}.` }

    if (missingProject(context, args.projectId)) {
      return { ok: false, message: `There is no project with the id ${String(args.projectId)}.` }
    }

    const dates = readDates(context, args)
    if (typeof dates === 'string') return { ok: false, message: dates }

    const patch = {
      ...(args.title === undefined ? {} : { title: args.title.trim() }),
      ...(args.notes === undefined ? {} : { notes: args.notes }),
      ...(args.projectId === undefined ? {} : { projectId: args.projectId }),
      ...(args.estimateMinutes === undefined ? {} : { estimateMinutes: args.estimateMinutes }),
      ...(args.waitingOn === undefined ? {} : { waitingOn: args.waitingOn }),
      ...dates,
    }

    const updated = withTransaction(context.database, () => {
      if (Object.keys(patch).length > 0) {
        updateTask(context.database, args.id, patch, context.now)
      }

      if (args.status !== undefined) {
        // The same tracked statuses the API passes, so filing a synced task outside its
        // connector's set is the same permanent opt-out here as it is on the board. Spec 01.
        const statuses = trackedStatuses(context.database, before.task)
        changeTaskStatus(context.database, args.id, {
          status: args.status,
          by: 'user',
          at: context.now,
          ...(statuses === undefined ? {} : { trackedStatuses: statuses }),
        })
      }

      return getTask(context.database, args.id)
    })

    if (updated === null) return { ok: false, message: `There is no task with the id ${args.id}.` }

    return {
      ok: true,
      data: taskSummary(context, updated),
      mutations: [
        {
          summary: describeUpdate(before.task, updated),
          entity: 'task',
          entityId: updated.id,
          inverse: [restoreTaskInverse(before)],
          taskIds: [updated.id],
        },
      ],
    }
  },
})

/** What changed, in the words the transcript shows. Named fields, so nothing is implied. */
function describeUpdate(before: Task, after: Task): string {
  const said: string[] = []

  if (before.status !== after.status) said.push(`to ${after.status}`)
  if (before.title !== after.title) said.push(`retitled “${after.title}”`)
  if (before.notes !== after.notes) said.push('notes changed')
  if (before.projectId !== after.projectId) {
    said.push(after.projectId === null ? 'out of its project' : 'into a project')
  }
  if (before.estimateMinutes !== after.estimateMinutes) {
    said.push(
      after.estimateMinutes === null
        ? 'estimate cleared'
        : `estimated at ${after.estimateMinutes} minutes`,
    )
  }
  if (before.dueAt !== after.dueAt)
    said.push(after.dueAt === null ? 'due date cleared' : 'due date set')
  if (before.deferUntil !== after.deferUntil) {
    said.push(after.deferUntil === null ? 'deferral cleared' : 'deferred')
  }
  if (before.waitingOn !== after.waitingOn) {
    said.push(
      after.waitingOn === null ? 'no longer waiting on anybody' : `waiting on ${after.waitingOn}`,
    )
  }

  // A patch that set a field to the value it already had is a change that changed nothing, and
  // saying so is more use than an empty record.
  return said.length === 0
    ? `Left “${after.title}” as it was`
    : `Updated “${before.title}”: ${said.join(', ')}`
}

const completeTaskTool = defineTool<{ readonly id: string }>({
  name: 'complete_task',
  kind: 'write',
  description:
    'Mark a task done. This is how work finishes: it leaves the board and counts as completed.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['id'],
    properties: { id: { type: 'string', maxLength: 64 } },
  },
  execute(context, args) {
    const before = snapshotTask(context.database, args.id)
    if (before === null) return { ok: false, message: `There is no task with the id ${args.id}.` }

    if (before.task.status === 'done') {
      // Not a refusal: the task is done, which is what was asked for. Recording a change would
      // put an undo control against a turn that changed nothing.
      return { ok: true, data: { ...taskSummary(context, before.task), alreadyDone: true } }
    }

    const statuses = trackedStatuses(context.database, before.task)
    const result = changeTaskStatus(context.database, args.id, {
      status: 'done',
      by: 'user',
      at: context.now,
      ...(statuses === undefined ? {} : { trackedStatuses: statuses }),
    })

    if (result === null || !result.applied) {
      return { ok: false, message: `${named(context, before.task)} could not be completed.` }
    }

    return {
      ok: true,
      data: taskSummary(context, result.task),
      mutations: [
        {
          summary: `Completed “${result.task.title}”`,
          entity: 'task',
          entityId: result.task.id,
          inverse: [restoreTaskInverse(before)],
          taskIds: [result.task.id],
        },
      ],
    }
  },
})

const markReviewedTool = defineTool<{ readonly id: string }>({
  name: 'mark_reviewed',
  kind: 'write',
  description:
    'Discharge your part of a pull request review. The task moves to Waiting for, named on the author, and the review will not come back until the author does something. Only for a task that is an open pull request awaiting your review.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['id'],
    properties: { id: { type: 'string', maxLength: 64 } },
  },
  execute(context, args) {
    const before = snapshotTask(context.database, args.id)
    if (before === null) return { ok: false, message: `There is no task with the id ${args.id}.` }

    const result = markTaskReviewed(context.database, args.id, context.now)

    if (!result.applied) {
      if (result.reason === 'already-reviewed') {
        return {
          ok: true,
          data: {
            ...taskSummary(context, before.task),
            note: 'This review was already discharged, so nothing changed.',
          },
        }
      }

      return { ok: false, message: refusalMessage(context, result.reason, before.task) }
    }

    return {
      ok: true,
      data: taskSummary(context, result.task),
      mutations: [
        {
          summary: `Marked “${result.task.title}” reviewed`,
          entity: 'task',
          entityId: result.task.id,
          // Both halves of the move. Putting the task back without putting the state machine back
          // would leave the next sync treating a review that never happened as discharged.
          inverse: [
            restoreTaskInverse(before),
            { kind: 'restore-source-lifecycle', ...result.previous },
          ],
          taskIds: [result.task.id],
        },
      ],
    }
  },
})

function refusalMessage(context: ChatToolContext, reason: string, task: Task): string {
  const subject = named(context, task)

  if (reason === 'not-a-review') {
    return `${subject} is not an open pull request awaiting your review.`
  }
  if (reason === 'not-tracked') {
    return `Sync tracking is off for ${subject}, so its review is no longer followed. The user can turn it back on from the board.`
  }
  if (reason === 'unsynced') {
    return `${subject} has not been synced from GitHub yet, so there is nothing to mark against.`
  }
  return `${subject} could not be marked reviewed.`
}

const deleteTaskTool = defineTool<{ readonly id: string }>({
  name: 'delete_task',
  kind: 'write',
  // Never executed on the model's word alone: the user confirms first. Spec 07, criterion 3.
  alwaysConfirm: true,
  description:
    'Delete a task outright. This is not the same as completing it: nothing is kept but the source row it came from, and its classification history goes with it. The user is asked to confirm before it happens, so propose it and say why.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['id'],
    properties: { id: { type: 'string', maxLength: 64 } },
  },
  describe(context, args) {
    const task = getTask(context.database, args.id)
    return task === null ? `Delete the task ${args.id}` : `Delete “${task.title}”`
  },
  execute(context, args) {
    const before = snapshotTask(context.database, args.id)
    if (before === null) return { ok: false, message: `There is no task with the id ${args.id}.` }

    if (!deleteTask(context.database, args.id)) {
      return { ok: false, message: `There is no task with the id ${args.id}.` }
    }

    return {
      ok: true,
      // The id of what went either way, and its title only as far as the policy allows: the model has
      // to be able to say what it did, and at `none` what it did was delete an id.
      data: {
        deleted: args.id,
        ...(withholdsText(context)
          ? { withheld: WITHHELD_ITEM_TEXT }
          : { title: before.task.title }),
      },
      mutations: [
        {
          summary: `Deleted “${before.task.title}”`,
          entity: 'task',
          entityId: before.task.id,
          // The tags and the source links go back with the row. The classification history does
          // not: it cascaded with the delete, and an inverse that invented rows would be worse
          // than one that admits the loss.
          inverse: [restoreTaskInverse(before, { withLinks: true })],
          taskIds: [before.task.id],
        },
      ],
    }
  },
})

const createProjectTool = defineTool<{ readonly title: string; readonly notes?: string | null }>({
  name: 'create_project',
  kind: 'write',
  touchesTasks: false,
  description:
    'Create a project: an outcome that takes more than one action to reach. Tasks are filed into it.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['title'],
    properties: {
      title: { type: 'string', maxLength: 500, pattern: '\\S' },
      notes: { type: ['string', 'null'], maxLength: 20_000 },
    } as unknown as Record<string, unknown>,
  },
  execute(context, args) {
    const project = createProject(
      context.database,
      { title: args.title.trim(), ...(args.notes === undefined ? {} : { notes: args.notes }) },
      context.now,
    )

    return {
      ok: true,
      data: projectSummary(context, project),
      mutations: [
        {
          summary: `Created the project “${project.title}”`,
          entity: 'project',
          entityId: project.id,
          inverse: [{ kind: 'delete-project', id: project.id }],
          taskIds: [],
        },
      ],
    }
  },
})

interface UpdateProjectArguments {
  readonly id: string
  readonly title?: string
  readonly notes?: string | null
  readonly state?: ProjectState
}

const updateProjectTool = defineTool<UpdateProjectArguments>({
  name: 'update_project',
  kind: 'write',
  touchesTasks: false,
  description:
    'Change a project. Completing one does not complete its tasks: the open ones stay, which is deliberate.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['id'],
    minProperties: 2,
    properties: {
      id: { type: 'string', maxLength: 64 },
      title: { type: 'string', maxLength: 500, pattern: '\\S' },
      notes: { type: ['string', 'null'], maxLength: 20_000 },
      state: { type: 'string', enum: projectStates },
    } as unknown as Record<string, unknown>,
  },
  execute(context, args) {
    const before = snapshotProject(context.database, args.id)
    if (before === null) {
      return { ok: false, message: `There is no project with the id ${args.id}.` }
    }

    const updated = updateProject(
      context.database,
      args.id,
      {
        ...(args.title === undefined ? {} : { title: args.title.trim() }),
        ...(args.notes === undefined ? {} : { notes: args.notes }),
        ...(args.state === undefined ? {} : { state: args.state }),
      },
      context.now,
    )

    if (updated === null) {
      return { ok: false, message: `There is no project with the id ${args.id}.` }
    }

    const said = [
      ...(before.title === updated.title ? [] : [`retitled “${updated.title}”`]),
      ...(before.state === updated.state ? [] : [`to ${updated.state}`]),
      ...(before.notes === updated.notes ? [] : ['notes changed']),
    ]

    return {
      ok: true,
      data: projectSummary(context, updated),
      mutations: [
        {
          summary:
            said.length === 0
              ? `Left the project “${updated.title}” as it was`
              : `Updated the project “${before.title}”: ${said.join(', ')}`,
          entity: 'project',
          entityId: updated.id,
          inverse: [restoreProjectInverse(before)],
          taskIds: [],
        },
      ],
    }
  },
})

const regeneratePlanTool = defineTool<{ readonly date?: string }>({
  name: 'regenerate_daily_plan',
  kind: 'write',
  touchesTasks: false,
  description:
    "Redraw today's plan against the tasks and the calendar as they stand now. Today only: an earlier day's plan is a record of what was proposed on it. The previous plan for today is kept in history.",
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: { date: localDate as unknown as Record<string, unknown> },
  },
  async execute(context, args) {
    const today = dateFrom(context, undefined)
    if (args.date !== undefined) {
      const asked = dateFrom(context, args.date)
      if (asked === null) return { ok: false, message: `"${args.date}" is not a date.` }
      if (today !== null && asked.text !== today.text) {
        return {
          ok: false,
          message: `Only today's plan can be regenerated. ${asked.text} is history, and redrawing it would rewrite what was proposed on the day.`,
        }
      }
    }

    const outcome = await context.regeneratePlan()

    if (outcome.status === 'already-running') {
      return {
        ok: false,
        message: 'The planner is already running. Nothing was redrawn; try again in a moment.',
      }
    }
    if (outcome.status === 'refused') return { ok: false, message: outcome.detail }

    return {
      ok: true,
      data: {
        date: today?.text ?? null,
        // A plan's summary is prose about the day's tasks and can name one. The planner will not draw a
        // plan at all at `none` (spec 05), so a summary arriving here means the level changed under it,
        // and it is the level in force now that decides. Spec 09, criterion 13.
        ...(withholdsText(context)
          ? { withheld: WITHHELD_ITEM_TEXT }
          : { summary: outcome.summary }),
      },
      mutations: [
        {
          summary: `Redrew the plan for ${today?.text ?? 'today'}`,
          entity: 'plan',
          entityId: null,
          // A plan is a record, and the one it replaced is still in history. There is nothing to
          // put back, so this change is not undoable rather than pretending to be.
          inverse: null,
          taskIds: [],
        },
      ],
    }
  },
})

/** Every write tool, in the order spec 07 lists them. */
export const writeTools: readonly ChatTool[] = [
  createTaskTool,
  updateTaskTool,
  completeTaskTool,
  markReviewedTool,
  deleteTaskTool,
  createProjectTool,
  updateProjectTool,
  regeneratePlanTool,
]
