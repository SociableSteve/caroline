/**
 * GitHub notification emails as a backup source for the GitHub connector: spec 02 criteria 19 to
 * 24. Both connectors, the real engine and a real database, driven by recorded Gmail threads.
 *
 * The connectors are assembled in the order the registry assembles them, GitHub then Gmail, because
 * that is the order the behaviour has to hold in.
 *
 * GitHub is answered from what the world currently holds rather than from a per-call script. What
 * these cases turn on is whether a pull request is discoverable, fetchable or neither, and each of
 * them changes between runs; a list indexed by call number would say the same thing far less
 * legibly, and would have to be recounted every time a test grew a run.
 */
import { describe, expect, it } from 'vitest'
import type { ContentPolicy } from '../../src/config/content.js'
import { runSync, type SyncSummary } from '../../src/connectors/engine.js'
import type { GitHubApi, PullRequestNode, PullRequestRef } from '../../src/connectors/github/api.js'
import { createGmailConnector } from '../../src/connectors/gmail/connector.js'
import { createGitHubConnector } from '../../src/connectors/github/connector.js'
import { identifyPullRequestNotification } from '../../src/connectors/github/notification.js'
import type { Database } from '../../src/db/connection.js'
import { getSourceByExternalId } from '../../src/db/repositories/sources.js'
import { changeTaskStatus, getTask, listTasks } from '../../src/db/repositories/tasks.js'
import { knownPullRequests, knownThreads } from '../../src/jobs/registry.js'
import { pullRequestNode, VIEWER } from '../helpers/github.js'
import { fakeGmailApi } from '../helpers/gmail.js'
import { migratedDatabase } from '../helpers/temp-database.js'

const RUN = Date.UTC(2026, 7, 10, 9, 0, 0)
const LATER = Date.UTC(2026, 7, 10, 9, 15, 0)
const QUERY = 'in:inbox -category:promotions -category:social'

const PULL_REQUEST = 'example-org/example-service#42'
const PULL_REQUEST_REF: PullRequestRef = {
  owner: 'example-org',
  name: 'example-service',
  number: 42,
}
const NOTIFICATION = 'thread-github-review-request'

/** The default policy: a snippet may be sent to a model, and nothing is stored. Spec 09. */
const storeNothing: ContentPolicy = {
  llmContent: 'snippet',
  storeContent: 'metadata',
  snippetChars: 300,
}

/** What GitHub currently holds, and whether Caroline can reach it. Mutable between runs. */
interface GitHubWorld {
  /** Pull requests the discovery search returns. */
  discoverable: PullRequestNode[]
  /** Pull requests a fetch by id will return. Anything else comes back as GitHub refusing. */
  fetchable: PullRequestNode[]
  configured: boolean
}

interface FakeGitHub extends GitHubApi {
  /** The refs of every fetch by id or refresh pass, so a test can assert what was asked for. */
  readonly asked: PullRequestRef[][]
}

function fakeGitHub(world: GitHubWorld): FakeGitHub {
  const asked: PullRequestRef[][] = []

  return {
    asked,
    async viewerLogin() {
      return VIEWER
    },
    async searchReviewRequested() {
      return [...world.discoverable]
    },
    async pullRequests(_viewer, refs) {
      asked.push([...refs])
      const wanted = new Set(refs.map((ref) => `${ref.owner}/${ref.name}#${ref.number}`))
      return world.fetchable.filter((node) =>
        wanted.has(`${node.repository.nameWithOwner}#${node.number}`),
      )
    },
  }
}

interface Scenario {
  readonly discoverable?: PullRequestNode[]
  readonly fetchable?: PullRequestNode[]
  readonly githubConfigured?: boolean
  /** The thread ids each successive Gmail listing returns. */
  readonly listings: ReadonlyArray<readonly string[]>
  readonly policy?: ContentPolicy
}

/**
 * A world the sync runs in, kept across runs so that a second pass sees what the first left behind.
 * Both apis are fakes, so nothing here reaches a network. Spec 02, criterion 8.
 */
function world({
  discoverable = [],
  fetchable = [],
  githubConfigured = true,
  listings,
  policy = storeNothing,
}: Scenario) {
  const database = migratedDatabase()
  const github: GitHubWorld = { discoverable, fetchable, configured: githubConfigured }
  const api = fakeGitHub(github)
  const gmail = fakeGmailApi({ listings })

  const connectors = [
    createGitHubConnector({
      api,
      isConfigured: () => github.configured,
      options: { returnToReviewOnNewCommits: true },
      known: () => knownPullRequests(database),
    }),
    createGmailConnector({
      api: gmail,
      isConfigured: () => true,
      query: QUERY,
      needsBody: () => true,
      known: () => knownThreads(database),
      backupFor: identifyPullRequestNotification,
    }),
  ]

  const sync = (now = RUN): Promise<SyncSummary> =>
    runSync({ database, connectors, trigger: 'scheduled', policy, now: () => now })

  return { database, github, api, sync }
}

/** The tasks on the board, whatever status they are in. */
function board(database: Database) {
  return listTasks(database, { limit: 50 }, RUN).tasks
}

function suppressedCount(summary: SyncSummary): number {
  return summary.results.reduce((sum, result) => sum + result.counts.suppressed, 0)
}

describe('a notification for a pull request already on the board', () => {
  it('creates no task, and records the thread against the pull request instead', async () => {
    const { database, sync, api } = world({
      discoverable: [pullRequestNode()],
      listings: [[NOTIFICATION]],
    })

    const summary = await sync()

    const tasks = board(database)
    expect(tasks).toHaveLength(1)
    expect(tasks[0]).toMatchObject({ status: 'review', statusSetBy: 'sync' })

    const thread = getSourceByExternalId(database, 'gmail', NOTIFICATION)
    expect(thread?.suppressedAt).toBe(RUN)
    // The provenance moves onto the pull request's card rather than vanishing. Spec 02.
    expect(thread?.taskId).toBe(tasks[0]?.id)
    expect(suppressedCount(summary)).toBe(1)

    // Rule 1 needs no fetch: the pull request is already followed. The only call is the refresh
    // pass's own, which asks for nothing because discovery returned everything known.
    expect(api.asked).toEqual([[]])
  })

  it('keeps no body for it, since nothing will ever read one', async () => {
    const { database, sync } = world({
      discoverable: [pullRequestNode()],
      listings: [[NOTIFICATION]],
      policy: { llmContent: 'snippet', storeContent: 'snippet', snippetChars: 300 },
    })

    await sync()

    expect(getSourceByExternalId(database, 'gmail', NOTIFICATION)?.content).toBeNull()
  })

  it('suppresses it once, however many times the thread is seen again', async () => {
    const { database, sync } = world({
      discoverable: [pullRequestNode()],
      listings: [[NOTIFICATION]],
    })

    await sync()
    const second = await sync(LATER)

    expect(suppressedCount(second)).toBe(0)
    expect(getSourceByExternalId(database, 'gmail', NOTIFICATION)?.suppressedAt).toBe(RUN)
    expect(board(database)).toHaveLength(1)
  })

  it('retires an untriaged inbox task already created for the thread', async () => {
    // The first run has no GitHub at all, so the backup source cannot do its job and the email is
    // captured as mail. That is rule 3, and spec 02 criterion 23.
    const { database, sync, github } = world({
      discoverable: [pullRequestNode()],
      listings: [[NOTIFICATION]],
      githubConfigured: false,
    })

    await sync()

    const captured = board(database)
    expect(captured).toHaveLength(1)
    expect(captured[0]).toMatchObject({ status: 'inbox', statusSetBy: 'sync' })
    const emailTask = captured[0]?.id as string

    // Now GitHub answers, and the thread turns out to be a second telling of a card on the board.
    github.configured = true
    await sync(LATER)

    expect(getTask(database, emailTask)).toBeNull()

    const tasks = board(database)
    expect(tasks).toHaveLength(1)
    expect(tasks[0]).toMatchObject({ status: 'review' })

    // Retired, not deleted without trace: the thread is still there, on the pull request's card.
    const thread = getSourceByExternalId(database, 'gmail', NOTIFICATION)
    expect(thread?.suppressedAt).toBe(LATER)
    expect(thread?.taskId).toBe(tasks[0]?.id)
    expect(thread?.title).toBe(
      '[example-org/example-service] Add a retry to the fetch helper (PR #42)',
    )
  })
})

describe('a notification for a pull request the discovery query missed', () => {
  it('brings the pull request in by id, in the status its lifecycle gives it', async () => {
    const { database, sync, api } = world({
      fetchable: [pullRequestNode()],
      listings: [[NOTIFICATION]],
    })

    await sync()

    const tasks = board(database)
    expect(tasks).toHaveLength(1)
    expect(tasks[0]).toMatchObject({
      title: 'example-org/example-service#42 Add a retry to the fetch helper',
      status: 'review',
      statusSetBy: 'sync',
    })

    const pullRequest = getSourceByExternalId(database, 'github', PULL_REQUEST)
    expect(pullRequest?.lifecycleState).toBe('awaiting_review')
    expect(pullRequest?.taskId).toBe(tasks[0]?.id)

    // Fetched by name, which is the only way to reach a pull request the search never returned.
    expect(api.asked).toContainEqual([PULL_REQUEST_REF])

    const thread = getSourceByExternalId(database, 'gmail', NOTIFICATION)
    expect(thread?.suppressedAt).toBe(RUN)
    expect(thread?.taskId).toBe(tasks[0]?.id)
  })

  it('follows it from then on, without needing the email again', async () => {
    const { database, sync } = world({
      fetchable: [pullRequestNode()],
      // The thread is archived after the first run. The pull request is Caroline's now.
      listings: [[NOTIFICATION], []],
    })

    await sync()
    await sync(LATER)

    const pullRequest = getSourceByExternalId(database, 'github', PULL_REQUEST)
    expect(pullRequest?.resolvedAt).toBeNull()
    expect(pullRequest?.lastSeenAt).toBe(LATER)
  })

  it('creates nothing at all when nobody is asking for a review', async () => {
    const { database, sync } = world({
      fetchable: [pullRequestNode({ requestedReviewers: [], reviewRequestedAt: null })],
      listings: [[NOTIFICATION]],
    })

    await sync()

    // The lifecycle's last rule: nobody is asking and no review was ever submitted, so there is no
    // work here to put on a board. Spec 02, criterion 22.
    expect(board(database)).toHaveLength(0)

    const pullRequest = getSourceByExternalId(database, 'github', PULL_REQUEST)
    expect(pullRequest?.resolvedAt).toBe(RUN)

    const thread = getSourceByExternalId(database, 'gmail', NOTIFICATION)
    expect(thread?.suppressedAt).toBe(RUN)
    expect(thread?.taskId).toBeNull()
  })
})

describe('a notification the backup source cannot place', () => {
  it('is left to classification when GitHub will not return the pull request', async () => {
    const { database, sync, api } = world({ listings: [[NOTIFICATION]] })

    await sync()

    const tasks = board(database)
    expect(tasks).toHaveLength(1)
    expect(tasks[0]).toMatchObject({ status: 'inbox', statusSetBy: 'sync' })
    expect(getSourceByExternalId(database, 'gmail', NOTIFICATION)?.suppressedAt).toBeNull()
    // It did try, which is what makes this a refusal rather than a rule never reached.
    expect(api.asked).toContainEqual([PULL_REQUEST_REF])
  })

  it('is left to classification when the notification is about an issue', async () => {
    const { database, sync, api } = world({
      discoverable: [pullRequestNode()],
      listings: [['thread-github-issue']],
    })

    await sync()

    const inbox = board(database).filter((task) => task.status === 'inbox')
    expect(inbox).toHaveLength(1)
    expect(getSourceByExternalId(database, 'gmail', 'thread-github-issue')?.suppressedAt).toBeNull()
    // An issue is not a pull request, so nothing was fetched on its behalf.
    expect(api.asked).toEqual([[]])
  })

  it('is left to classification when GitHub is not configured', async () => {
    const { database, sync } = world({
      fetchable: [pullRequestNode()],
      listings: [[NOTIFICATION]],
      githubConfigured: false,
    })

    await sync()

    expect(board(database).map((task) => task.status)).toEqual(['inbox'])
    expect(getSourceByExternalId(database, 'gmail', NOTIFICATION)?.suppressedAt).toBeNull()
  })

  it('is left to classification when the fetch throws, and does not fail the Gmail run', async () => {
    const { database, sync, api } = world({ listings: [[NOTIFICATION]] })

    api.pullRequests = () => Promise.reject(new Error('GitHub answered 502 Bad Gateway'))

    const summary = await sync()

    // GitHub's own pass fails and says so in its own row; the Gmail pass is not where a GitHub
    // outage is reported, and the email is captured rather than swallowed.
    expect(summary.results.find((result) => result.provider === 'github')?.status).toBe('failure')
    expect(summary.results.find((result) => result.provider === 'gmail')?.status).toBe('success')
    expect(board(database).map((task) => task.status)).toEqual(['inbox'])
  })
})

describe('a thread the user has triaged themselves', () => {
  it('is neither retired nor suppressed, and the pull request still comes in', async () => {
    const { database, sync, github } = world({
      listings: [[NOTIFICATION]],
      githubConfigured: false,
    })

    await sync()

    const captured = board(database)
    expect(captured).toHaveLength(1)
    const emailTask = captured[0]?.id as string

    // The user files it themselves. That is a decision, and spec 01 says sync does not overturn it.
    changeTaskStatus(database, emailTask, { status: 'next_action', by: 'user', at: RUN })

    github.configured = true
    github.fetchable = [pullRequestNode()]
    await sync(LATER)

    expect(getTask(database, emailTask)).toMatchObject({
      status: 'next_action',
      statusSetBy: 'user',
    })

    const thread = getSourceByExternalId(database, 'gmail', NOTIFICATION)
    expect(thread?.suppressedAt).toBeNull()
    expect(thread?.taskId).toBe(emailTask)

    // The other half of the rule is about GitHub rather than about their mail: the pull request the
    // search missed is still brought in, beside the task they filed.
    const pullRequest = getSourceByExternalId(database, 'github', PULL_REQUEST)
    expect(pullRequest).not.toBeNull()
    expect(getTask(database, pullRequest?.taskId ?? '')).toMatchObject({ status: 'review' })
  })
})

describe('a suppressed thread later archived in Gmail', () => {
  it('does not propose completing the pull request it pointed at', async () => {
    const { database, sync } = world({
      discoverable: [pullRequestNode()],
      // Gone from the second listing, which for an ordinary thread is the resolution signal that
      // proposes completing its task.
      listings: [[NOTIFICATION], []],
    })

    await sync()
    await sync(LATER)

    const pullRequest = getSourceByExternalId(database, 'github', PULL_REQUEST)
    expect(pullRequest?.completionProposedAt).toBeNull()
    expect(getTask(database, pullRequest?.taskId ?? '')).toMatchObject({ status: 'review' })

    // The thread's own row is untouched: it left the set sync follows when it was suppressed.
    const thread = getSourceByExternalId(database, 'gmail', NOTIFICATION)
    expect(thread?.resolvedAt).toBeNull()
    expect(thread?.completionProposedAt).toBeNull()
  })
})
