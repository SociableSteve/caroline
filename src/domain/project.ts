/**
 * Projects, and the two things about them that are derived rather than stored: the next
 * action and whether the project has stalled. Pure, like the rest of `src/domain`.
 * Spec 01.
 */
import type { Task } from './task.js'

export const projectStates = ['active', 'someday', 'done', 'dropped'] as const
export type ProjectState = (typeof projectStates)[number]

export interface Project {
  readonly id: string
  readonly title: string
  readonly notes: string | null
  readonly state: ProjectState
  readonly createdAt: number
  readonly updatedAt: number
  readonly completedAt: number | null
}

export interface NewProjectInput {
  readonly id: string
  readonly title: string
  readonly notes?: string | null
  readonly state?: ProjectState
}

export function newProject(input: NewProjectInput, now: number): Project {
  return {
    id: input.id,
    title: input.title,
    notes: input.notes ?? null,
    state: input.state ?? 'active',
    createdAt: now,
    updatedAt: now,
    completedAt: input.state === 'done' ? now : null,
  }
}

/**
 * The next action is derived, never stored: the project's `next_action` task with the
 * earliest `sort_order`. Ties break by creation time then id, so the answer does not
 * depend on the order rows came back in.
 */
export function deriveNextAction(tasks: readonly Task[]): Task | null {
  const candidates = tasks.filter((task) => task.status === 'next_action')
  if (candidates.length === 0) return null

  return candidates.reduce((earliest, task) => (comesFirst(task, earliest) ? task : earliest))
}

function comesFirst(task: Task, other: Task): boolean {
  if (task.sortOrder !== other.sortOrder) return task.sortOrder < other.sortOrder
  if (task.createdAt !== other.createdAt) return task.createdAt < other.createdAt
  return task.id < other.id
}

/**
 * An active project with nothing to do next has stalled, which is the single most useful
 * thing a GTD review surfaces. A `someday`, `done` or `dropped` project is not meant to be
 * moving, so it is never stalled.
 */
export function isStalled(project: Pick<Project, 'state'>, tasks: readonly Task[]): boolean {
  return project.state === 'active' && deriveNextAction(tasks) === null
}

/** Completing a project does not complete its tasks. These are the ones left behind. */
export function openTasks(tasks: readonly Task[]): readonly Task[] {
  return tasks.filter((task) => task.status !== 'done')
}

export function completeProject(project: Project, at: number): Project {
  return { ...project, state: 'done', completedAt: at, updatedAt: at }
}
