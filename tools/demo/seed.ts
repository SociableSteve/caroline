/**
 * A seeded day's work, for looking at Caroline rather than testing it.
 *
 * Its reason for existing is M9: eight layout defects on that milestone were invisible in the
 * source and obvious in a render, and none of them could have been caught by the suite, because
 * jsdom lays nothing out. A screenshot is only worth taking against a populated screen, and six
 * empty states are what a clean checkout gives you. So: one plausible day, seeded into a throwaway
 * database, with the states that are easy to get wrong actually present. A stale wait and a fresh
 * one, an overdue task and one due today, a pull request the author has pushed to since you
 * reviewed it, a proposal below the confidence threshold, a job that failed.
 *
 * Never point this at the real database. It writes into a path of its own and says which.
 */
import { loadConfig } from '../../src/config/load.js'
import { openCarolineDatabase } from '../../src/db/index.js'
import { createProject } from '../../src/db/repositories/projects.js'
import { createTask, setTaskTags } from '../../src/db/repositories/tasks.js'
import { upsertSource } from '../../src/db/repositories/sources.js'
import { recordDailyPlan } from '../../src/db/repositories/daily-plans.js'
import { upsertCalendarEvent } from '../../src/db/repositories/calendar-events.js'
import { recordJobRun } from '../../src/db/repositories/job-runs.js'
import { recordClassification } from '../../src/db/repositories/classifications.js'
import { createConversation, appendMessage, finishMessage } from '../../src/db/repositories/chat.js'
import type { StatusActor, TaskStatus } from '../../src/domain/task.js'
import type { CalendarResponseStatus } from '../../src/domain/calendar.js'
import type { JobRunStatus } from '../../src/domain/job.js'

const databasePath = process.env.SEED_DB ?? '/tmp/caroline-demo/demo.db'
const config = loadConfig({
  file: { database: { path: databasePath }, jobs: { timezone: 'Europe/London' } },
  env: {} as NodeJS.ProcessEnv,
})
const database = openCarolineDatabase(config)

const NOW = Date.now()
const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** Today at a wall-clock hour, so the calendar column reads like a working day. */
function today(hour: number, minute = 0): number {
  const date = new Date(NOW)
  date.setHours(hour, minute, 0, 0)
  return date.getTime()
}

const planDate = new Date(NOW).toISOString().slice(0, 10)

// ---- Projects ----

const hub = createProject(database, { title: 'Technology Hub H2 review' }, NOW - 40 * DAY)
const release = createProject(database, { title: 'Caroline 1.0 release' }, NOW - 20 * DAY)
const onboarding = createProject(database, { title: 'Onboarding refresh' }, NOW - 60 * DAY)

// ---- Tasks ----

interface Seed {
  readonly title: string
  readonly status: TaskStatus
  readonly by?: StatusActor
  readonly project?: string | null
  readonly estimate?: number | null
  readonly due?: number | null
  readonly waitingOn?: string | null
  readonly setAt?: number
  readonly tags?: readonly string[]
  readonly notes?: string | null
}

const seeds: Seed[] = [
  // Inbox: untriaged, which is where the classifier's proposals land.
  { title: 'Re: Q3 capacity numbers for the board pack', status: 'inbox', by: 'sync' },
  { title: 'Invitation: architecture guild, Thursday', status: 'inbox', by: 'sync' },
  { title: 'Expenses for the Lisbon trip need submitting', status: 'inbox', by: 'user' },

  // Next actions, including the two due states the cards now name.
  {
    title: 'Write the H2 throughput section',
    status: 'next_action',
    project: hub.id,
    estimate: 90,
    due: today(17),
    tags: ['writing'],
  },
  {
    title: 'Reply to the procurement questionnaire',
    status: 'next_action',
    estimate: 30,
    due: NOW - 2 * DAY,
    tags: ['admin'],
  },
  {
    title: 'Draft the setup guide for the Google Cloud project',
    status: 'next_action',
    project: release.id,
    estimate: 45,
  },
  { title: 'Book the venue for the hub offsite', status: 'next_action', estimate: 15 },

  // Waiting, one of them well past the staleness threshold.
  {
    title: 'Signed statement of work from Legal',
    status: 'waiting',
    waitingOn: 'Legal',
    setAt: NOW - 31 * DAY,
  },
  {
    title: 'Budget sign-off for the two new bench seats',
    status: 'waiting',
    waitingOn: 'Finance',
    setAt: NOW - 9 * DAY,
  },
  {
    title: 'Answers on the NetSuite export format',
    status: 'waiting',
    waitingOn: 'People Ops',
    setAt: NOW - 2 * DAY,
  },

  { title: 'Look at whether the planner could learn from corrections', status: 'someday' },
  { title: 'A hub dashboard that reads itself out on a Monday', status: 'someday' },

  { title: 'Nearform brand guidelines', status: 'reference' },
  { title: 'GitHub token scopes Caroline needs', status: 'reference', project: release.id },
]

const created = seeds.map((seed) => {
  const at = seed.setAt ?? NOW - 3 * DAY
  const task = createTask(
    database,
    {
      title: seed.title,
      status: seed.status,
      statusSetBy: seed.by ?? 'user',
      projectId: seed.project ?? null,
      estimateMinutes: seed.estimate ?? null,
      dueAt: seed.due ?? null,
      waitingOn: seed.waitingOn ?? null,
      notes: seed.notes ?? null,
    },
    at,
  )
  if (seed.tags !== undefined) setTaskTags(database, task.id, [...seed.tags])
  return task
})

/** The onboarding project deliberately gets no next action, so it reads as stalled. */
createTask(
  database,
  { title: 'Old onboarding deck', status: 'reference', projectId: onboarding.id },
  NOW - 50 * DAY,
)

// ---- Pull requests in Review, with their sources ----

const pullRequests = [
  {
    title: 'nearform/caroline#41 Add the retry to the Gmail fetch helper',
    author: 'ana-dev',
    number: 41,
    ageDays: 1,
    pushed: false,
  },
  {
    title: 'nearform/caroline#39 Rework the scheduler’s catch-up pass',
    author: 'sam-eng',
    number: 39,
    ageDays: 4,
    pushed: true,
  },
  {
    title: 'nearform/hub-tools#12 Bump the NetSuite client',
    author: 'ana-dev',
    number: 12,
    ageDays: 2,
    pushed: false,
  },
]

for (const pr of pullRequests) {
  const at = NOW - pr.ageDays * DAY
  const task = createTask(
    database,
    { title: pr.title, status: 'review', statusSetBy: 'sync', estimateMinutes: 25 },
    at,
  )

  upsertSource(
    database,
    {
      provider: 'github',
      externalId: `nearform/caroline#${pr.number}`,
      url: `https://github.com/nearform/caroline/pull/${pr.number}`,
      title: pr.title,
      taskId: task.id,
      lifecycleState: 'awaiting_review',
      metadata: {
        author: pr.author,
        headSha: pr.pushed ? 'sha-two' : 'sha-one',
        headCommittedAt: at + HOUR,
        additions: 120,
        deletions: 40,
        changedFiles: 6,
      },
      ...(pr.pushed ? { actedAt: at, actedAtMarker: 'sha-one' } : {}),
    },
    at,
  )
}

/** A pull request already reviewed, now waiting on its author, with a push since. */
const reviewed = createTask(
  database,
  {
    title: 'nearform/caroline#37 Split the connector interface',
    status: 'waiting',
    statusSetBy: 'sync',
    waitingOn: 'sam-eng',
  },
  NOW - 6 * DAY,
)
upsertSource(
  database,
  {
    provider: 'github',
    externalId: 'nearform/caroline#37',
    url: 'https://github.com/nearform/caroline/pull/37',
    title: 'Split the connector interface',
    taskId: reviewed.id,
    lifecycleState: 'reviewed',
    actedAt: NOW - 6 * DAY,
    actedAtMarker: 'sha-old',
    metadata: { author: 'sam-eng', headSha: 'sha-new', headCommittedAt: NOW - 2 * HOUR },
  },
  NOW - 6 * DAY,
)

// ---- A classifier proposal below the threshold, on the first inbox item ----

const inboxItem = created[0]
if (inboxItem !== undefined) {
  recordClassification(
    database,
    {
      taskId: inboxItem.id,
      proposedStatus: 'next_action',
      confidence: 0.62,
      reasoning: 'Asks you for a number by Friday, so it reads as an action rather than reference.',
      suggestedTitle: 'Send Q3 capacity numbers for the board pack',
      estimateMinutes: 20,
      waitingOn: null,
      projectSuggestion: null,
      applied: false,
      model: 'claude-sonnet-5',
      promptVersion: 'classify-v1',
      error: null,
    },
    NOW - 2 * HOUR,
  )
}

// ---- Today's calendar ----

const events: ReadonlyArray<{
  summary: string
  start: number
  end: number
  response: CalendarResponseStatus
}> = [
  { summary: 'Hub standup', start: today(9, 30), end: today(9, 45), response: 'accepted' },
  { summary: 'Client architecture review', start: today(11), end: today(12), response: 'accepted' },
  {
    summary: 'Lunch and learn: observability',
    start: today(13),
    end: today(14),
    response: 'declined',
  },
  { summary: 'One to one with Ana', start: today(15, 30), end: today(16), response: 'accepted' },
]

for (const [index, event] of events.entries()) {
  upsertCalendarEvent(
    database,
    {
      calendarId: 'primary',
      externalId: `event-${index}`,
      summary: event.summary,
      startsAt: event.start,
      endsAt: event.end,
      allDay: false,
      responseStatus: event.response,
      transparency: 'opaque',
      status: 'confirmed',
      attendeeCount: 4,
      url: null,
    },
    NOW,
  )
}

// ---- Today's plan ----

const planned = created.filter((task) => task.status === 'next_action')

recordDailyPlan(database, {
  planDate,
  generatedAt: today(7, 5),
  timeZone: 'Europe/London',
  windowMinutes: 510,
  busyMinutes: 105,
  reserveMinutes: 60,
  capacityMinutes: 345,
  capacityVerified: true,
  provider: 'anthropic',
  model: 'claude-sonnet-5',
  promptVersion: 'plan-v1',
  summary: 'Two meetings in the middle of the day, so the writing goes first thing.',
  warnings: ['One next action was left out: there is no capacity left after the reserve.'],
  entries: planned.slice(0, 3).map((task, index) => ({
    taskId: task.id,
    title: task.title,
    rank: index + 1,
    rationale:
      index === 0 ? 'Due today, and the longest single block you have' : 'Overdue since Monday',
    estimateMinutes: task.estimateMinutes,
  })),
  overflow: planned.slice(3).map((task, index) => ({
    taskId: task.id,
    title: task.title,
    rank: index + 1,
    rationale: 'Would not fit inside the capacity left',
    estimateMinutes: task.estimateMinutes,
  })),
  nudges: [
    {
      taskId: null,
      title: 'Signed statement of work from Legal',
      rank: 1,
      waitingOn: 'Legal',
      waitingSince: NOW - 31 * DAY,
      pushedSinceReview: false,
    },
    {
      taskId: reviewed.id,
      title: 'nearform/caroline#37 Split the connector interface',
      rank: 2,
      waitingOn: 'sam-eng',
      waitingSince: NOW - 6 * DAY,
      pushedSinceReview: true,
    },
  ],
})

// A fortnight of history behind it, so the strip has something to show.
for (let back = 1; back <= 5; back += 1) {
  const date = new Date(NOW - back * DAY).toISOString().slice(0, 10)
  recordDailyPlan(database, {
    planDate: date,
    generatedAt: NOW - back * DAY,
    timeZone: 'Europe/London',
    windowMinutes: 510,
    busyMinutes: 90,
    reserveMinutes: 60,
    capacityMinutes: 360,
    capacityVerified: true,
    provider: 'anthropic',
    model: 'claude-sonnet-5',
    promptVersion: 'plan-v1',
    summary: null,
    warnings: [],
    entries: planned.slice(0, 3).map((task, index) => ({
      taskId: null,
      title: task.title,
      rank: index + 1,
      rationale: null,
      estimateMinutes: task.estimateMinutes,
    })),
    overflow: [],
    nudges: [],
  })
}

// ---- Job runs, including the failure the dashboard has to render ----

const runs: ReadonlyArray<{
  job: string
  status: JobRunStatus
  finishedAt: number
  counts: Record<string, number>
  error: string | null
}> = [
  {
    job: 'sync',
    status: 'success',
    finishedAt: NOW - 6 * MINUTE,
    counts: { itemsSeen: 34, sourcesCreated: 2, tasksCreated: 2, tasksUpdated: 1 },
    error: null,
  },
  {
    job: 'classify',
    status: 'success',
    finishedAt: NOW - 42 * MINUTE,
    counts: { classified: 6, proposals: 1, llmCalls: 6 },
    error: null,
  },
  {
    job: 'plan',
    status: 'success',
    finishedAt: NOW - 3 * HOUR,
    counts: { plansGenerated: 1, llmCalls: 1 },
    error: null,
  },
  {
    job: 'purge',
    status: 'failure',
    finishedAt: NOW - 9 * HOUR,
    counts: {},
    error: 'SQLITE_BUSY: database is locked while the retention pass was running',
  },
]

for (const [index, run] of runs.entries()) {
  recordJobRun(database, {
    job: run.job,
    trigger: 'scheduled',
    startedAt: run.finishedAt - 20_000,
    finishedAt: run.finishedAt,
    status: run.status,
    counts: run.counts,
    error: run.error,
  })
  // A little history behind each, so the Jobs table is not one row per job.
  recordJobRun(database, {
    job: run.job,
    trigger: 'scheduled',
    startedAt: run.finishedAt - DAY - 20_000,
    finishedAt: run.finishedAt - DAY,
    status: 'success',
    counts: { itemsSeen: 12 + index },
    error: null,
  })
}

// ---- A conversation, so the chat rail has something in it ----

const conversation = createConversation(
  database,
  { title: 'What does today look like?' },
  NOW - 25 * MINUTE,
)
appendMessage(
  database,
  { conversationId: conversation.id, role: 'user', content: 'What does today look like?' },
  NOW - 25 * MINUTE,
)
const answer = appendMessage(
  database,
  { conversationId: conversation.id, role: 'assistant', content: '' },
  NOW - 25 * MINUTE,
)
finishMessage(
  database,
  answer.id,
  {
    content:
      'Three things planned against five and a half hours free, with the architecture review taking the middle of your day.\n\nThe procurement questionnaire is two days overdue and only needs half an hour, so it is worth taking first if the writing can wait until tomorrow.',
    toolCalls: 3,
    toolCallLimitReached: false,
    readOnly: false,
    inputTokens: 2140,
    outputTokens: 180,
    stopReason: 'end_turn',
    error: null,
  },
  NOW - 24 * MINUTE,
)

console.log(`Seeded ${databasePath}`)
console.log(`  ${created.length + pullRequests.length + 2} tasks, 3 projects, a plan and 8 runs`)
