/**
 * Fixtures for the component tests. Named fields rather than partial objects, so a test that
 * cares about an estimate says so and a test that does not is not quietly relying on one.
 */
import type { ProjectView, TaskStatus, TaskView } from './api.js'

export const NOW = Date.UTC(2026, 5, 10, 9, 0, 0)
export const DAY = 24 * 60 * 60 * 1000

export function aTask(overrides: Partial<TaskView> & { id: string; title: string }): TaskView {
  return {
    notes: null,
    status: 'inbox' as TaskStatus,
    projectId: null,
    sortOrder: 0,
    estimateMinutes: null,
    dueAt: null,
    deferUntil: null,
    waitingOn: null,
    statusSetBy: 'user',
    statusSetAt: NOW,
    syncTracked: false,
    createdAt: NOW,
    updatedAt: NOW,
    completedAt: null,
    tags: [],
    ...overrides,
  }
}

export function aProject(
  overrides: Partial<ProjectView> & { id: string; title: string },
): ProjectView {
  return {
    notes: null,
    state: 'active',
    createdAt: NOW,
    updatedAt: NOW,
    completedAt: null,
    nextAction: null,
    stalled: true,
    ...overrides,
  }
}
