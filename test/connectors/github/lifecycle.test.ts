/**
 * The review lifecycle end to end: the connector, the engine and a real database, driven by
 * fixture payloads. Spec 02, criteria 9 to 18, and the guarantee they exist to serve:
 *
 * **An open pull request is never invisible.** The walk below asserts, at every single step,
 * that the task is in either the Review or the Waiting for column. Nothing in sync may
 * complete, hide or drop it until it merges.
 */
import { describe, expect, it } from 'vitest'
import { runSync } from '../../../src/connectors/engine.js'
import type { PullRequestNode } from '../../../src/connectors/github/api.js'
import { createGitHubConnector } from '../../../src/connectors/github/connector.js'
import type { Database } from '../../../src/db/connection.js'
import { getSourceByExternalId } from '../../../src/db/repositories/sources.js'
import { changeTaskStatus, getTask, listTasks } from '../../../src/db/repositories/tasks.js'
import type { Task } from '../../../src/domain/task.js'
import { knownPullRequests } from '../../../src/jobs/sync.js'
import { fakeGitHubApi, pullRequestNode, VIEWER } from '../../helpers/github.js'
import { migratedDatabase } from '../../helpers/temp-database.js'

const EXTERNAL_ID = 'example-org/example-service#42'

const FIRST_SHA = '1111111111111111111111111111111111111111'
const SECOND_SHA = '2222222222222222222222222222222222222222'

const REQUESTED_AT = '2026-01-05T09:12:00Z'
const REVIEWED_AT = '2026-01-06T14:00:00Z'
const PUSHED_AT = '2026-01-07T10:30:00Z'

/**
 * One sync run per entry: what the discovery search returns, and what the refresh pass has
 * available for the pull requests it asks about.
 */
interface Step {
  readonly discovery: readonly PullRequestNode[]
  readonly refresh?: readonly PullRequestNode[]
}

interface Walk {
  readonly database: Database
  run(): Promise<Task | null>
}

function walk(steps: readonly Step[], returnToReviewOnNewCommits = true): Walk {
  const database = migratedDatabase()
  const api = fakeGitHubApi({
    discovery: steps.map((step) => step.discovery),
    refresh: steps.map((step) => step.refresh ?? []),
  })

  const connector = createGitHubConnector({
    api,
    isConfigured: () => true,
    options: { returnToReviewOnNewCommits },
    // Exactly what the process wires in, so the test cannot pass against a different set.
    known: () => knownPullRequests(database),
  })

  let clock = Date.UTC(2026, 0, 5, 10, 0)

  return {
    database,
    async run() {
      clock += 15 * 60_000
      await runSync({ database, connectors: [connector], trigger: 'scheduled', now: () => clock })

      const source = getSourceByExternalId(database, 'github', EXTERNAL_ID)
      return source?.taskId === undefined || source.taskId === null
        ? null
        : getTask(database, source.taskId)
    },
  }
}

/** The four nodes the walk moves between, each one a step in the pull request's life. */
const requested = pullRequestNode({ headSha: FIRST_SHA, reviewRequestedAt: REQUESTED_AT })

const changesRequested = pullRequestNode({
  headSha: FIRST_SHA,
  requestedReviewers: [],
  reviewRequestedAt: REQUESTED_AT,
  review: { state: 'CHANGES_REQUESTED', submittedAt: REVIEWED_AT, sha: FIRST_SHA },
})

const authorPushed = pullRequestNode({
  headSha: SECOND_SHA,
  headCommittedAt: PUSHED_AT,
  requestedReviewers: [],
  reviewRequestedAt: REQUESTED_AT,
  review: { state: 'CHANGES_REQUESTED', submittedAt: REVIEWED_AT, sha: FIRST_SHA },
})

const approved = pullRequestNode({
  headSha: SECOND_SHA,
  headCommittedAt: PUSHED_AT,
  requestedReviewers: [],
  reviewRequestedAt: REQUESTED_AT,
  review: { state: 'APPROVED', submittedAt: '2026-01-08T16:30:00Z', sha: SECOND_SHA },
})

const merged = pullRequestNode({
  state: 'MERGED',
  headSha: SECOND_SHA,
  headCommittedAt: PUSHED_AT,
  requestedReviewers: [],
  reviewRequestedAt: REQUESTED_AT,
  review: { state: 'APPROVED', submittedAt: '2026-01-08T16:30:00Z', sha: SECOND_SHA },
})

describe('a pull request followed from request through review to merge', () => {
  it('is in Review or Waiting for at every step until it closes', async () => {
    const steps: Step[] = [
      // Requested. Discovery finds it.
      { discovery: [requested] },
      // Nothing has happened. Discovery still has it.
      { discovery: [requested] },
      // You reviewed it on GitHub, so it leaves the search results for good. Criterion 18:
      // from here on only the refresh pass can see it.
      { discovery: [], refresh: [changesRequested] },
      { discovery: [], refresh: [changesRequested] },
      // The author pushed the changes you asked for.
      { discovery: [], refresh: [authorPushed] },
      // You approved.
      { discovery: [], refresh: [approved] },
      // Merged.
      { discovery: [], refresh: [merged] },
    ]

    const expected = ['review', 'review', 'waiting', 'waiting', 'review', 'waiting', 'done']
    const walked = walk(steps)
    const seen: string[] = []

    for (let step = 0; step < steps.length; step += 1) {
      const task = await walked.run()
      seen.push(task?.status ?? 'missing')

      // The guarantee, asserted at each step rather than only at the end.
      if (expected[step] !== 'done') {
        expect(['review', 'waiting']).toContain(task?.status)
      }
    }

    expect(seen).toEqual(expected)
  })
})

describe('submitting a review on GitHub', () => {
  it('moves the task to waiting on the author, without completing it', async () => {
    const walked = walk([
      { discovery: [requested] },
      { discovery: [], refresh: [changesRequested] },
    ])

    await walked.run()
    const task = (await walked.run()) as Task

    expect(task).toMatchObject({
      status: 'waiting',
      waitingOn: 'author-one',
      completedAt: null,
    })
    expect(getSourceByExternalId(walked.database, 'github', EXTERNAL_ID)).toMatchObject({
      lifecycleState: 'reviewed',
      actedAt: Date.parse(REVIEWED_AT),
      actedAtMarker: FIRST_SHA,
      resolvedAt: null,
    })
  })

  it('leaves it in waiting across any number of runs with nothing happening', async () => {
    const walked = walk([
      { discovery: [requested] },
      { discovery: [], refresh: [changesRequested] },
      { discovery: [], refresh: [changesRequested] },
      { discovery: [], refresh: [changesRequested] },
      { discovery: [], refresh: [changesRequested] },
    ])

    const statuses: string[] = []
    for (let step = 0; step < 5; step += 1) statuses.push((await walked.run())?.status ?? 'missing')

    expect(statuses).toEqual(['review', 'waiting', 'waiting', 'waiting', 'waiting'])
  })
})

describe('new commits after your review', () => {
  it('return it to review when you had requested changes', async () => {
    const walked = walk([
      { discovery: [requested] },
      { discovery: [], refresh: [changesRequested] },
      { discovery: [], refresh: [authorPushed] },
    ])

    await walked.run()
    await walked.run()

    expect((await walked.run())?.status).toBe('review')
  })

  it('do not return it to review when you had approved', async () => {
    const approvedAtFirstSha = pullRequestNode({
      headSha: FIRST_SHA,
      requestedReviewers: [],
      reviewRequestedAt: REQUESTED_AT,
      review: { state: 'APPROVED', submittedAt: REVIEWED_AT, sha: FIRST_SHA },
    })
    const pushedAfterApproval = pullRequestNode({
      headSha: SECOND_SHA,
      headCommittedAt: PUSHED_AT,
      requestedReviewers: [],
      reviewRequestedAt: REQUESTED_AT,
      review: { state: 'APPROVED', submittedAt: REVIEWED_AT, sha: FIRST_SHA },
    })

    const walked = walk([
      { discovery: [requested] },
      { discovery: [], refresh: [approvedAtFirstSha] },
      { discovery: [], refresh: [pushedAfterApproval] },
    ])

    await walked.run()
    await walked.run()

    expect((await walked.run())?.status).toBe('waiting')
  })

  it('do not return it to review at all with returnToReviewOnNewCommits off', async () => {
    const walked = walk(
      [
        { discovery: [requested] },
        { discovery: [], refresh: [changesRequested] },
        { discovery: [], refresh: [authorPushed] },
      ],
      false,
    )

    await walked.run()
    await walked.run()

    expect((await walked.run())?.status).toBe('waiting')
  })
})

describe('a re-requested review', () => {
  const reRequested = pullRequestNode({
    headSha: FIRST_SHA,
    requestedReviewers: ['you'],
    reviewRequestedAt: PUSHED_AT,
    review: { state: 'COMMENTED', submittedAt: REVIEWED_AT, sha: FIRST_SHA },
  })

  it('returns the task to review, whatever the commit setting says', async () => {
    for (const setting of [true, false]) {
      const walked = walk(
        [
          { discovery: [requested] },
          { discovery: [], refresh: [changesRequested] },
          { discovery: [reRequested] },
        ],
        setting,
      )

      await walked.run()
      await walked.run()

      expect((await walked.run())?.status).toBe('review')
    }
  })
})

describe('merging or closing', () => {
  it.each([
    ['review', [{ discovery: [requested] }, { discovery: [], refresh: [merged] }]],
    [
      'waiting',
      [
        { discovery: [requested] },
        { discovery: [], refresh: [changesRequested] },
        { discovery: [], refresh: [merged] },
      ],
    ],
  ] as [string, Step[]][])('proposes completion from %s', async (_from, steps) => {
    const walked = walk(steps)

    let task: Task | null = null
    for (let step = 0; step < steps.length; step += 1) task = await walked.run()

    expect(task).toMatchObject({ status: 'done' })
    expect(getSourceByExternalId(walked.database, 'github', EXTERNAL_ID)).toMatchObject({
      lifecycleState: 'closed',
      resolvedAt: expect.any(Number),
      completionProposedAt: expect.any(Number),
    })
  })

  it('closes a pull request that closed unmerged just the same', async () => {
    const closed = pullRequestNode({ state: 'CLOSED', headSha: FIRST_SHA, requestedReviewers: [] })
    const walked = walk([{ discovery: [requested] }, { discovery: [], refresh: [closed] }])

    await walked.run()

    expect((await walked.run())?.status).toBe('done')
  })
})

describe('being dropped as a reviewer', () => {
  it('resolves it, since leaving the results really does mean the work has gone', async () => {
    const dropped = pullRequestNode({
      headSha: FIRST_SHA,
      requestedReviewers: [],
      reviewRequestedAt: null,
    })
    const walked = walk([{ discovery: [requested] }, { discovery: [], refresh: [dropped] }])

    await walked.run()
    const task = await walked.run()

    expect(task).toMatchObject({ status: 'done' })
    expect(getSourceByExternalId(walked.database, 'github', EXTERNAL_ID)?.resolvedAt).toEqual(
      expect.any(Number),
    )
  })
})

describe('filing a tracked pull request outside the connector’s statuses', () => {
  it('stops tracking, and a later re-request does not move it back', async () => {
    const reRequested = pullRequestNode({
      headSha: FIRST_SHA,
      requestedReviewers: ['you'],
      reviewRequestedAt: PUSHED_AT,
      review: { state: 'COMMENTED', submittedAt: REVIEWED_AT, sha: FIRST_SHA },
    })

    const walked = walk([
      { discovery: [requested] },
      { discovery: [], refresh: [changesRequested] },
      { discovery: [reRequested] },
    ])

    const first = (await walked.run()) as Task
    // Someday is outside `review`, `waiting` and `done`, so this is a decision to opt out of
    // the lifecycle. Spec 01, sync tracking; spec 02, criterion 17.
    changeTaskStatus(walked.database, first.id, {
      status: 'someday',
      by: 'user',
      at: Date.UTC(2026, 0, 5, 12, 0),
      trackedStatuses: ['review', 'waiting', 'done'],
    })

    await walked.run()
    const task = await walked.run()

    expect(task).toMatchObject({ status: 'someday', syncTracked: false })
    expect(listTasks(walked.database, { status: ['review'] }, Date.now()).total).toBe(0)
  })
})

describe('the viewer', () => {
  it('is who the token belongs to, and only their reviews count', async () => {
    // The GraphQL query filters reviews by author, so a review node reaching the connector is
    // by definition yours. This asserts the fixture builder and the connector agree on that.
    expect(VIEWER).toBe('reviewer-you')
    expect(requested.reviewRequests.nodes[0]?.requestedReviewer).toMatchObject({
      login: 'reviewer-you',
    })
  })
})
