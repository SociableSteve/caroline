/**
 * Fixtures for the component tests. Named fields rather than partial objects, so a test that
 * cares about an estimate says so and a test that does not is not quietly relying on one.
 */
import type { ProjectView, ProposalView, SourceView, TaskStatus, TaskView } from './api.js'

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
    sources: [],
    proposal: null,
    ...overrides,
  }
}

/** The GitHub source a synced pull request task carries. Spec 02. */
export function aPullRequestSource(overrides: Partial<SourceView> = {}): SourceView {
  return {
    id: 'source-1',
    provider: 'github',
    externalId: 'example-org/example-service#42',
    url: 'https://github.com/example-org/example-service/pull/42',
    title: 'example-org/example-service#42 Add a retry to the fetch helper',
    lifecycleState: 'awaiting_review',
    actedAt: null,
    actedAtMarker: null,
    resolvedAt: null,
    requeuedAt: null,
    completionProposedAt: null,
    metadata: {
      repository: 'example-org/example-service',
      number: 42,
      author: 'author-one',
      headSha: 'sha-one',
      headCommittedAt: NOW - DAY,
    },
    ...overrides,
  }
}

/** A task as sync leaves a pull request awaiting your review. */
export function aReviewTask(overrides: Partial<TaskView> = {}): TaskView {
  return aTask({
    id: 'task-pr',
    title: 'example-org/example-service#42 Add a retry to the fetch helper',
    status: 'review',
    statusSetBy: 'sync',
    syncTracked: true,
    estimateMinutes: 30,
    sources: [aPullRequestSource()],
    ...overrides,
  })
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

/**
 * A classifier suggestion below the threshold, as `GET /api/tasks` returns one. Spec 04: the task
 * stays in the inbox and this is what the card offers to accept.
 */
export function aProposal(overrides: Partial<ProposalView> = {}): ProposalView {
  return {
    id: 'classification-1',
    status: 'next_action',
    confidence: 0.42,
    reasoning: 'It reads like one action, but I cannot tell whose.',
    suggestedTitle: null,
    estimateMinutes: null,
    waitingOn: null,
    projectSuggestion: null,
    model: 'a-model',
    promptVersion: '2026-08-10',
    createdAt: NOW - 60_000,
    ...overrides,
  }
}
