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
import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { workingWindowForDate } from '../../src/actions/capacity.js'
import { loadConfig, readConfigFile } from '../../src/config/load.js'
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
import { runPlanning } from '../../src/jobs/plan.js'
import { createFakeProvider } from '../../src/llm/fake.js'
import type { LlmProvider, LlmRuntime } from '../../src/llm/index.js'
import { withSchemaValidation } from '../../src/llm/structured.js'
import { CLASSIFICATION_PROMPT_VERSION } from '../../src/llm/prompts/classification.js'
import { PLAN_PROMPT_VERSION } from '../../src/llm/prompts/plan.js'
import { formatLocalDate, localDateAt } from '../../src/domain/time.js'
// The client's own formatter, so a sentence in the seeded conversation and the capacity bar
// photographed beside it cannot say the same quantity two ways.
import { formatEstimate } from '../../web/format.js'

/**
 * Under the system temporary directory, and refused anywhere else.
 *
 * The README saying "never point this at the real database" is not a control: `SEED_DB` naming
 * `./data/caroline.db` would have this migrate and seed the database somebody actually uses, and
 * the whole reason this file exists is a defect where a test suite wrote into that directory. A
 * check by path rather than by prefix, so `/tmp2` is not mistaken for a child of `/tmp`.
 */
const databasePath = resolve(process.env.SEED_DB ?? join(tmpdir(), 'caroline-demo', 'demo.db'))
const step = relative(resolve(tmpdir()), databasePath)

if (step === '' || step.startsWith('..') || isAbsolute(step)) {
  throw new Error(
    `SEED_DB must be inside ${tmpdir()}, and is ${databasePath}. This script migrates and writes ` +
      'whatever it is given, so it declines to touch anything outside a scratch directory.',
  )
}

// SQLite will not create the directory for us, and on a clean machine there is not one.
mkdirSync(dirname(databasePath), { recursive: true })

/**
 * Every run starts from an empty file, and the refusals below are why it has to.
 *
 * Nothing here is an upsert on a stable key: `createProject` and `createTask` insert a new row with
 * a new id each time, so a second run against the same file dealt six projects and two of every
 * card, and a run that refused halfway left a part of a day for the next one to add itself to.
 * Deleting first makes the seed idempotent and makes a refusal cost nothing, which is what lets the
 * checks below sit after the plan has been drawn, where the plan is the thing being checked. The
 * path is the scratch one validated above, and WAL keeps two files beside it.
 */
for (const suffix of ['', '-wal', '-shm']) rmSync(`${databasePath}${suffix}`, { force: true })

/**
 * The configuration this script and the server share.
 *
 * `CAROLINE_CONFIG` is the same variable `npm start` reads, and the README points both at one file,
 * because the plan written here is fitted against a capacity the server computes: the window, the
 * meetings and the reserve decide what fits, and two configurations that agree today are how a
 * seeded plan came to claim there was no capacity left in two free hours. The database path is this
 * script's own whatever the file says, since it migrates and writes whatever it opens.
 */
const settings = (
  process.env.CAROLINE_CONFIG === undefined
    ? {}
    : (readConfigFile(resolve(process.env.CAROLINE_CONFIG)) ?? {})
) as Record<string, unknown>
const fileDatabase = (settings.database ?? {}) as Record<string, unknown>
const fileJobs = (settings.jobs ?? {}) as Record<string, unknown>

const config = loadConfig({
  file: {
    ...settings,
    database: { ...fileDatabase, path: databasePath },
    jobs: { ...fileJobs, timezone: fileJobs.timezone ?? 'Europe/London' },
  },
  env: {} as NodeJS.ProcessEnv,
})
const database = openCarolineDatabase(config)

const NOW = Date.now()
const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** Today, as the server will read it: from the clock, in the configured timezone. */
const localToday = localDateAt(NOW, config.jobs.timezone)
const planDate = formatLocalDate(localToday)

/**
 * A day the configuration calls a working day, or nothing.
 *
 * The server takes "today" from its own clock, so a seeded day cannot be moved off the weekend:
 * pinning the plan to Friday would leave a Sunday dashboard with no plan and an empty calendar, which
 * is a different wrong picture rather than a fix. At a weekend `workingWindowForDate` returns null and
 * the capacity bar draws "Today is not a working day, so there is no capacity to plan." where
 * `docs/using.md` promises the capacity arithmetic spelled out, above a plan with entries and a
 * warning about capacity. No test can read a PNG, so the suite would stay green over a false picture.
 * Hence a refusal here, where the reason can be said, rather than a picture nobody would question.
 */
if (workingWindowForDate(config, localToday) === null) {
  const weekday = new Date(NOW).toLocaleDateString('en-GB', {
    weekday: 'long',
    timeZone: config.jobs.timezone,
  })

  throw new Error(
    `${planDate} is a ${weekday}, which planning.workingDays does not include, so there is no ` +
      'capacity to plan into and the dashboard would show none. The pictures in docs/images are of ' +
      'a working day and docs/using.md reads the arithmetic out of them, so seed and shoot on a ' +
      'working day, or add this weekday to planning.workingDays in the config file both this script ' +
      'and the server read (CAROLINE_CONFIG).',
  )
}

/** Today at a wall-clock hour, so the calendar column reads like a working day. */
function today(hour: number, minute = 0): number {
  const date = new Date(NOW)
  date.setHours(hour, minute, 0, 0)
  return date.getTime()
}

// ---- Projects ----

const hub = createProject(database, { title: 'Platform team H2 review' }, NOW - 40 * DAY)
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

  /**
   * Next actions, including the two due states the cards now name.
   *
   * The estimates are what makes the plan below have an overflow: three of them come to more than the
   * day's capacity less the fourth, so the fourth does not fit and the plan says so. The seed checks
   * that rather than trusting it, because both the warning and the "If there is time" panel are
   * published pictures and `docs/using.md` reads them out.
   */
  {
    title: 'Write the H2 throughput section',
    status: 'next_action',
    project: hub.id,
    estimate: 150,
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
    estimate: 90,
  },
  { title: 'Book the venue for the team offsite', status: 'next_action', estimate: 45 },

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
    title: 'Answers on the payroll export format',
    status: 'waiting',
    waitingOn: 'People Ops',
    setAt: NOW - 2 * DAY,
  },

  { title: 'Look at whether the planner could learn from corrections', status: 'someday' },
  { title: 'A team dashboard that reads itself out on a Monday', status: 'someday' },

  { title: 'Brand guidelines', status: 'reference' },
  { title: 'GitHub token scopes Caroline needs', status: 'reference', project: release.id },
]

/**
 * A distinct creation time each, in the order this file lists them.
 *
 * A column is read back `order by sort_order, created_at, id`, and `createTask` gives every task the
 * same `sortOrder`. One shared `createdAt` for the whole list therefore left the tiebreak to a random
 * UUID: every reseed dealt each column in a different order, and a picture of it was one shuffle out
 * of many, which is not something a document can say anything positional about. A minute apart is
 * enough to decide the order and small enough that the cards still read as three days old.
 */
const created = seeds.map((seed, index) => {
  const at = seed.setAt ?? NOW - 3 * DAY + index * MINUTE
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

/**
 * The repository is a field rather than being spelled into the title twice. Two of these are the
 * same repository and one is not, which is the point of having a third: the board should show a
 * review from somewhere else, with provenance that points at somewhere else.
 *
 * `example-org` is an invented owner used consistently, and not a reserved one: GitHub reserves no
 * example namespace, and that account exists. So the names are a convention and the links are the
 * safeguard: every URL here is on `github.invalid`, which RFC 2606 keeps permanently unresolvable, so
 * neither a published screenshot nor a card in the demo can send anybody into a real namespace. A slug
 * that happens to 404 today would not do, because somebody can register one tomorrow.
 */
const pullRequests = [
  {
    repository: 'example-org/caroline',
    summary: 'Add the retry to the Gmail fetch helper',
    author: 'avery-dev',
    number: 41,
    ageDays: 1,
    pushed: false,
  },
  {
    repository: 'example-org/caroline',
    summary: 'Rework the scheduler’s catch-up pass',
    author: 'jordan-eng',
    number: 39,
    ageDays: 4,
    pushed: true,
  },
  {
    repository: 'example-org/hub-tools',
    summary: 'Bump the payroll client',
    author: 'avery-dev',
    number: 12,
    ageDays: 2,
    pushed: false,
  },
]

for (const pr of pullRequests) {
  const at = NOW - pr.ageDays * DAY
  const externalId = `${pr.repository}#${pr.number}`
  const title = `${externalId} ${pr.summary}`
  const task = createTask(
    database,
    { title, status: 'review', statusSetBy: 'sync', estimateMinutes: 25 },
    at,
  )

  upsertSource(
    database,
    {
      provider: 'github',
      externalId,
      url: `https://github.invalid/${pr.repository}/pull/${pr.number}`,
      title,
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

/**
 * A pull request already reviewed, now waiting on its author, with a push since.
 *
 * Past the staleness threshold on purpose, and by the age rather than by being listed: this is the
 * item the chase list exists for, since a review the author has pushed to is quietly yours again,
 * and `chaseNudges` selects it only if `isStaleWait` says so. At six days it was inside the default
 * seven and the seeded plan named it anyway, which is a picture of a rule the code does not have.
 * The wait runs from `actedAt` for a pull request and from the status change for anything else, so
 * both are the same moment here and the two dashboard panels agree about its age.
 */
const REVIEWED_WAIT_DAYS = 8

const reviewed = createTask(
  database,
  {
    title: 'example-org/caroline#37 Split the connector interface',
    status: 'waiting',
    statusSetBy: 'sync',
    waitingOn: 'jordan-eng',
  },
  NOW - REVIEWED_WAIT_DAYS * DAY,
)
upsertSource(
  database,
  {
    provider: 'github',
    externalId: 'example-org/caroline#37',
    url: 'https://github.invalid/example-org/caroline/pull/37',
    title: 'Split the connector interface',
    taskId: reviewed.id,
    lifecycleState: 'reviewed',
    actedAt: NOW - REVIEWED_WAIT_DAYS * DAY,
    actedAtMarker: 'sha-old',
    metadata: { author: 'jordan-eng', headSha: 'sha-new', headCommittedAt: NOW - 2 * HOUR },
  },
  NOW - REVIEWED_WAIT_DAYS * DAY,
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
      // The version the classify job would have stamped on it, not a name invented here.
      promptVersion: CLASSIFICATION_PROMPT_VERSION,
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
  { summary: 'Team standup', start: today(9, 30), end: today(9, 45), response: 'accepted' },
  { summary: 'Client architecture review', start: today(11), end: today(12), response: 'accepted' },
  {
    summary: 'Lunch and learn: observability',
    start: today(13),
    end: today(14),
    response: 'declined',
  },
  { summary: 'One to one with Jordan', start: today(15, 30), end: today(16), response: 'accepted' },
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

/**
 * Why the planner put an entry where it did, read off the task rather than off its rank.
 *
 * By rank it said "Overdue since Monday" about whatever happened to be second or third, and the
 * third entry here has no due date at all. Both the plan and the same task's card are published, in
 * one document, so a reason that contradicts the card reads as the planner inventing reasons. The
 * weekday comes from the date as well, so it cannot drift from it either, and the project decides
 * which undated sentence applies, so the offsite is not told the release is waiting on it.
 */
function rationaleFor(task: { readonly dueAt: number | null; readonly projectId: string | null }) {
  if (task.dueAt === null) {
    return task.projectId === release.id
      ? 'Nothing forcing the date, but the release is waiting on it'
      : 'Nothing forcing the date, and nobody else is blocked on it'
  }
  if (task.dueAt < today(0)) {
    const weekday = new Date(task.dueAt).toLocaleDateString('en-GB', { weekday: 'long' })

    return `Overdue since ${weekday}`
  }
  if (task.dueAt < today(0) + DAY) return 'Due today, and the longest single block you have'

  return 'Due later this week, so it is worth starting before the deadline week'
}

/**
 * The model's part of a plan, and only the model's part: an order, and one sentence each.
 *
 * Everything else about the plan below is the planner's, because the planner is what draws it. This
 * is a scripted answer standing in for a provider, so no shoot touches a network, and it names the
 * next actions in the order this file lists them; the ordering rule, the review entry, the fit, the
 * overflow, the nudges and the warnings are then whatever the code makes of that.
 */
const nextActions = created.filter((task) => task.status === 'next_action')

const plannerAnswer = {
  summary: 'Two meetings in the middle of the day, so the writing goes first thing.',
  entries: nextActions.map((task) => ({
    taskId: task.id,
    rationale: rationaleFor(task),
    estimateMinutes: task.estimateMinutes,
  })),
}

const planner = withSchemaValidation(
  createFakeProvider({
    answers: [{ structured: plannerAnswer, text: JSON.stringify(plannerAnswer) }],
    // The provider the demo configuration names, so the plan row records what somebody following
    // tools/demo/README.md would get. Nothing is sent: the answer above is the whole of the call.
    name: 'ollama',
    model: 'llama3.1',
  }),
)

const llm: LlmRuntime = {
  isConfigured: () => true,
  budgetRefusal: () => null,
  for: (): LlmProvider => planner,
}

/**
 * The plan, drawn by the code that draws plans.
 *
 * `runPlanning` is what the scheduler runs and what **Regenerate** runs, so the entries, their
 * order, the review criterion 7 guarantees, the chase nudges, the overflow and every warning are
 * the application's own output rather than a picture of one. Written out by hand they drifted: the
 * published dashboard showed a plan with no review in it, a warning about the reserve that no line
 * of Caroline can emit, none of the unverified-capacity warning that a real run does emit, and a
 * chase list holding an item the chase rule would not have selected.
 *
 * `false` for connected, because nothing here connects a calendar: the diary is seeded directly,
 * which is exactly the Unverified case `docs/using.md` describes. Seven in the morning for the
 * clock, because that is when the plan job runs, and the capacity is read from the events just
 * written rather than from four numbers repeated here.
 */
const planning = await runPlanning({
  database,
  config,
  llm,
  calendarConnected: () => false,
  now: () => today(7, 5),
  date: localToday,
})

const plan = planning.plan

if (plan === null) {
  throw new Error(
    `The planner drew no plan for ${planDate}: ${planning.error ?? 'it reported no reason'}.`,
  )
}

const plannedMinutes = plan.entries.reduce(
  (total, entry) => total + (entry.estimateMinutes ?? 0),
  0,
)
const unplanned = plan.capacityMinutes - plannedMinutes

/**
 * The states these pictures exist to show, checked rather than hoped for.
 *
 * The README lists them among what the seed puts on one screen, and `docs/using.md` reads each of
 * them out of a published PNG. No test can read a PNG, so a day that quietly lost one would leave
 * the suite green over a document describing something the picture does not show. Hence a refusal
 * here, where the reason can be said. Nothing before this point is left behind by it: the database
 * file is deleted at the top of this script, so a refused run leaves no half-seeded day.
 */
const absent = [
  ['an overflow, which is the "If there is time" panel', plan.overflow.length > 0],
  ['a warning, which is the sentence under the plan', plan.warnings.length > 0],
  [
    'a review entry, which spec 05 criterion 7 promises',
    plan.entries.some((entry) => entry.taskStatus === 'review'),
  ],
  ['a chase nudge, which is the "Worth a chase" panel', plan.nudges.length > 0],
] as const

const missing = absent.filter(([, present]) => !present).map(([what]) => what)

if (missing.length > 0) {
  throw new Error(
    `The plan drawn for ${planDate} has no ${missing.join(', and no ')}. Raise the estimates in ` +
      'this file, lower the capacity, or age a wait past tasks.waitingStaleDays until each is back, ' +
      'because docs/using.md reads all of them out of the pictures in docs/images.',
  )
}

// A fortnight of history behind it, so the strip has something to show. A quieter diary than today's,
// in the same window and against the same reserve, so no row of it contradicts any other.
const historicBusyMinutes = 90

for (let back = 1; back <= 5; back += 1) {
  const date = formatLocalDate(localDateAt(NOW - back * DAY, config.jobs.timezone))
  recordDailyPlan(database, {
    planDate: date,
    generatedAt: NOW - back * DAY,
    timeZone: config.jobs.timezone,
    windowMinutes: plan.windowMinutes,
    busyMinutes: historicBusyMinutes,
    reserveMinutes: plan.reserveMinutes,
    capacityMinutes: plan.windowMinutes - historicBusyMinutes - plan.reserveMinutes,
    capacityVerified: plan.capacityVerified,
    provider: plan.provider,
    model: plan.model,
    // What today's run stamped on its own plan, so a history row cannot claim an era of the
    // prompt that never existed.
    promptVersion: PLAN_PROMPT_VERSION,
    summary: null,
    warnings: [],
    // The titles of today's plan, with no task behind them: these are a record of what was
    // proposed on a day that has gone, which is what the strip draws.
    entries: plan.entries.map((entry) => ({
      taskId: null,
      title: entry.title,
      rank: entry.rank,
      rationale: null,
      estimateMinutes: entry.estimateMinutes,
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
    /**
     * The answer the rail publishes, against the same figures the capacity bar beside it draws, and
     * through the same formatter, because the two are photographed together: this sentence used to
     * say five and a half hours free where the bar said five hours three minutes.
     */
    content:
      `Today's plan takes ${formatEstimate(plannedMinutes)} of the ` +
      `${formatEstimate(plan.capacityMinutes)} free, with the architecture review taking the ` +
      'middle of your day.\n\nThe procurement questionnaire is two days overdue and only needs half ' +
      'an hour, so it is worth taking first if the writing can wait until tomorrow.',
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
console.log(
  `  ${planDate}: ${plan.capacityMinutes} free minutes, ${plannedMinutes} planned, ` +
    `${plan.overflow.length} left over with ${unplanned} to spare`,
)

/**
 * The plan read back out of the database, because it is the part of this day nobody can check by
 * reading this file: the entries, the review, the chase list, the overflow and the warnings are the
 * planner's, and this is what the pictures and `docs/using.md` have to agree with.
 */
for (const entry of plan.entries) {
  console.log(`  ${entry.rank}. ${entry.title} (${entry.estimateMinutes ?? '?'} min)`)
}
for (const entry of plan.overflow) console.log(`  if there is time: ${entry.title}`)
for (const nudge of plan.nudges) console.log(`  worth a chase: ${nudge.title}`)
for (const warning of plan.warnings) console.log(`  warning: ${warning}`)
