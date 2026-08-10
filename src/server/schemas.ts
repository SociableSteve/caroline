/**
 * The JSON schemas the routes validate against and serialise through. Spec 08: the schemas
 * are the API contract, so they live in one place rather than being spelled out per route.
 *
 * Response schemas are declared as well as request ones. A field missing from a response
 * schema is dropped from the payload, which makes the schema the definition of what the API
 * returns rather than a description of it.
 */
import {
  calendarEventStatuses,
  calendarResponseStatuses,
  calendarTransparencies,
} from '../domain/calendar.js'
import {
  chatChangeEntities,
  chatConfirmationDecisions,
  chatConfirmationReasons,
  chatRoles,
} from '../domain/chat.js'
import { planEntryKinds } from '../domain/plan.js'
import { jobRunStatuses, jobTriggers } from '../domain/job.js'
import { projectStates } from '../domain/project.js'
import { sourceProviders } from '../domain/source.js'
import { taskStatuses } from '../domain/task.js'

/** Titles are one line of text. The cap is generous, and it stops a body being a novel. */
export const TITLE_MAX = 500
export const NOTES_MAX = 20_000
export const SEARCH_MAX = 200
export const TAG_MAX = 60
export const TAGS_MAX = 20
/** The default page size, and the most a single request may ask for. */
export const PAGE_DEFAULT = 200
export const PAGE_MAX = 500
/** Bulk operations are for a board selection, not for the whole table. */
export const BULK_MAX = 200

const nullableString = (maxLength: number) =>
  ({ type: ['string', 'null'], maxLength }) as unknown as Record<string, unknown>

const nullableInteger = { type: ['integer', 'null'] } as unknown as Record<string, unknown>

/** A title with something in it. `pattern` rather than `minLength`, so spaces do not count. */
const title = { type: 'string', maxLength: TITLE_MAX, pattern: '\\S' } as const

const tags = {
  type: 'array',
  maxItems: TAGS_MAX,
  items: { type: 'string', minLength: 1, maxLength: TAG_MAX },
} as const

/**
 * A task's provenance: which item it came from, with a link out, and where the connector's
 * state machine has it. Spec 08 asks every task show this. `content` is deliberately absent:
 * nothing in the UI reads a stored body, so nothing puts one on the wire (spec 09).
 */
export const sourceResponseSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'provider', 'externalId'],
  properties: {
    id: { type: 'string' },
    provider: { type: 'string', enum: sourceProviders },
    externalId: { type: 'string' },
    url: nullableString(2000),
    title: nullableString(TITLE_MAX),
    lifecycleState: nullableString(60),
    actedAt: nullableInteger,
    actedAtMarker: nullableString(200),
    resolvedAt: nullableInteger,
    requeuedAt: nullableInteger,
    completionProposedAt: nullableInteger,
    // The shape is the connector's, not this layer's, so it is passed through whole rather
    // than enumerated here and silently truncated every time a connector learns a new fact.
    metadata: { type: 'object', additionalProperties: true, nullable: true },
  },
} as const

/**
 * A classifier answer the user has not acted on: below the confidence threshold when it was made,
 * so the task stayed in the inbox with the proposal attached for a one-click accept. Spec 04,
 * criterion 3. Present on a task only while it is waiting on the user.
 */
export const proposalResponseSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'status', 'confidence', 'createdAt'],
  properties: {
    id: { type: 'string' },
    status: { type: 'string', enum: taskStatuses },
    confidence: { type: 'number' },
    reasoning: nullableString(1000),
    suggestedTitle: nullableString(TITLE_MAX),
    estimateMinutes: nullableInteger,
    waitingOn: nullableString(200),
    projectSuggestion: {
      type: ['object', 'null'],
      additionalProperties: false,
      properties: {
        existingProjectId: nullableString(64),
        newProjectTitle: nullableString(200),
      },
    },
    model: nullableString(200),
    promptVersion: { type: 'string' },
    createdAt: { type: 'integer' },
  },
} as const

export const taskResponseSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'id',
    'title',
    'status',
    'statusSetBy',
    'statusSetAt',
    'syncTracked',
    'tags',
    'sources',
  ],
  properties: {
    id: { type: 'string' },
    title: { type: 'string' },
    notes: nullableString(NOTES_MAX),
    status: { type: 'string', enum: taskStatuses },
    projectId: nullableString(64),
    sortOrder: { type: 'integer' },
    estimateMinutes: nullableInteger,
    dueAt: nullableInteger,
    deferUntil: nullableInteger,
    waitingOn: nullableString(TITLE_MAX),
    statusSetBy: { type: 'string' },
    statusSetAt: { type: 'integer' },
    syncTracked: { type: 'boolean' },
    createdAt: { type: 'integer' },
    updatedAt: { type: 'integer' },
    completedAt: nullableInteger,
    tags: { type: 'array', items: { type: 'string' } },
    sources: { type: 'array', items: sourceResponseSchema },
    proposal: { ...proposalResponseSchema, nullable: true },
  },
} as const

export const taskListQuerySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    status: { type: 'array', items: { type: 'string', enum: taskStatuses } },
    projectId: { type: 'string', maxLength: 64 },
    tag: { type: 'string', maxLength: TAG_MAX },
    dueBefore: { type: 'integer' },
    search: { type: 'string', maxLength: SEARCH_MAX },
    includeDeferred: { type: 'boolean', default: false },
    limit: { type: 'integer', minimum: 1, maximum: PAGE_MAX, default: PAGE_DEFAULT },
    offset: { type: 'integer', minimum: 0, default: 0 },
  },
} as const

export const taskListResponseSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['tasks', 'total', 'limit', 'offset'],
  properties: {
    tasks: { type: 'array', items: taskResponseSchema },
    total: { type: 'integer' },
    limit: { type: 'integer' },
    offset: { type: 'integer' },
  },
} as const

/** The fields a caller may set. `statusSetBy` is deliberately absent: the API is the user. */
const taskWritableProperties = {
  title,
  notes: nullableString(NOTES_MAX),
  status: { type: 'string', enum: taskStatuses },
  projectId: nullableString(64),
  sortOrder: { type: 'integer' },
  estimateMinutes: nullableInteger,
  dueAt: nullableInteger,
  deferUntil: nullableInteger,
  waitingOn: nullableString(TITLE_MAX),
  tags,
} as const

export const createTaskBodySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['title'],
  properties: taskWritableProperties,
} as const

export const patchTaskBodySchema = {
  type: 'object',
  additionalProperties: false,
  // A patch that changes nothing is a mistake on the caller's part, not a no-op to accept.
  minProperties: 1,
  properties: taskWritableProperties,
} as const

export const idParamsSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id'],
  properties: { id: { type: 'string', minLength: 1, maxLength: 64 } },
} as const

/**
 * `null` is allowed alongside an object because re-enabling is the default and a request
 * with no body at all says exactly that: `POST .../tracking` with nothing in it should work.
 */
export const trackingBodySchema = {
  type: ['object', 'null'],
  additionalProperties: false,
  properties: { enabled: { type: 'boolean', default: true } },
} as unknown as Record<string, unknown>

/**
 * A bulk request does exactly one thing. `oneOf` rather than two routes, because the caller
 * is one board selection either way, and a body naming both a status and a project has not
 * said what it wants.
 */
export const bulkBodySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['ids'],
  properties: {
    ids: {
      type: 'array',
      minItems: 1,
      maxItems: BULK_MAX,
      items: { type: 'string', minLength: 1, maxLength: 64 },
    },
    status: { type: 'string', enum: taskStatuses },
    projectId: nullableString(64),
  },
  oneOf: [
    { required: ['status'], not: { required: ['projectId'] } },
    { required: ['projectId'], not: { required: ['status'] } },
  ],
} as const

export const bulkResponseSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['results'],
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'applied'],
        properties: {
          id: { type: 'string' },
          applied: { type: 'boolean' },
          reason: { type: 'string' },
        },
      },
    },
  },
} as const

export const projectResponseSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'title', 'state', 'stalled', 'nextAction'],
  properties: {
    id: { type: 'string' },
    title: { type: 'string' },
    notes: nullableString(NOTES_MAX),
    state: { type: 'string', enum: projectStates },
    createdAt: { type: 'integer' },
    updatedAt: { type: 'integer' },
    completedAt: nullableInteger,
    /** Derived, never stored. Spec 01, criterion 4. */
    nextAction: { ...taskResponseSchema, nullable: true },
    stalled: { type: 'boolean' },
  },
} as const

export const projectListQuerySchema = {
  type: 'object',
  additionalProperties: false,
  properties: { state: { type: 'string', enum: projectStates } },
} as const

export const projectListResponseSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['projects'],
  properties: { projects: { type: 'array', items: projectResponseSchema } },
} as const

const projectWritableProperties = {
  title,
  notes: nullableString(NOTES_MAX),
  state: { type: 'string', enum: projectStates },
} as const

export const createProjectBodySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['title'],
  properties: projectWritableProperties,
} as const

export const patchProjectBodySchema = {
  type: 'object',
  additionalProperties: false,
  minProperties: 1,
  properties: projectWritableProperties,
} as const

/** How many runs `GET /api/jobs` returns by default, and the most it will return. */
export const RUNS_DEFAULT = 50
export const RUNS_MAX = 200

const jobCountsSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    itemsSeen: { type: 'integer' },
    sourcesCreated: { type: 'integer' },
    tasksCreated: { type: 'integer' },
    tasksUpdated: { type: 'integer' },
    resolved: { type: 'integer' },
    requeued: { type: 'integer' },
    classified: { type: 'integer' },
    proposals: { type: 'integer' },
    llmCalls: { type: 'integer' },
    failed: { type: 'integer' },
    contentPurged: { type: 'integer' },
    runsPurged: { type: 'integer' },
  },
} as const

/**
 * The run history. The error message is part of it: a failed run whose reason is only in a
 * log line is not a run history. Spec 02, criterion 5. The stack is deliberately not
 * returned, since it is of no use in the UI and is the sort of thing that leaks paths.
 */
export const jobRunResponseSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'job', 'trigger', 'startedAt', 'finishedAt', 'status', 'counts'],
  properties: {
    id: { type: 'string' },
    job: { type: 'string' },
    trigger: { type: 'string', enum: jobTriggers },
    startedAt: { type: 'integer' },
    finishedAt: { type: 'integer' },
    status: { type: 'string', enum: jobRunStatuses },
    counts: jobCountsSchema,
    error: nullableString(2000),
  },
} as const

export const jobListQuerySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    job: { type: 'string', maxLength: 60 },
    limit: { type: 'integer', minimum: 1, maximum: RUNS_MAX, default: RUNS_DEFAULT },
  },
} as const

export const jobListResponseSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['runs'],
  properties: { runs: { type: 'array', items: jobRunResponseSchema } },
} as const

export const jobNameParamsSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['name'],
  properties: { name: { type: 'string', minLength: 1, maxLength: 60 } },
} as const

/**
 * What a manual trigger answers with: the row that was written. The per-connector detail of a sync
 * is in the history under `sync:<provider>`, so it is not repeated here.
 */
export const jobRunTriggeredResponseSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['job', 'run'],
  properties: {
    job: { type: 'string' },
    run: jobRunResponseSchema,
  },
} as const

/** One row per scheduled job: is it working, is it going now, and when does it go next. Spec 06. */
export const jobStatusResponseSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['jobs'],
  properties: {
    jobs: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['job', 'cron', 'running', 'consecutiveFailures'],
        properties: {
          job: { type: 'string' },
          cron: { type: 'string' },
          running: { type: 'boolean' },
          nextRunAt: nullableInteger,
          lastRun: { ...jobRunResponseSchema, nullable: true },
          consecutiveFailures: { type: 'integer' },
          backoffUntil: nullableInteger,
        },
      },
    },
  },
} as const

/**
 * The Google connection as the settings screen sees it. No token, no client secret, nothing that
 * would be a secret on the wire: only whether consent exists and what it covers. Spec 09.
 */
export const googleStatusResponseSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['connected', 'configured', 'scopes'],
  properties: {
    connected: { type: 'boolean' },
    configured: { type: 'boolean' },
    connectedAt: nullableInteger,
    scopes: { type: 'array', items: { type: 'string' } },
    /** Where Google must be told to send the browser back to, so the setup guide can quote it. */
    redirectUri: { type: 'string' },
  },
} as const

export const googleConnectResponseSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['url'],
  properties: { url: { type: 'string' } },
} as const

export const googleCallbackQuerySchema = {
  type: 'object',
  // Google adds `scope`, `authuser` and `prompt` to the callback, and a request carrying them is
  // not a bad request. They are ignored rather than rejected.
  additionalProperties: true,
  properties: {
    code: { type: 'string', maxLength: 2000 },
    state: { type: 'string', maxLength: 200 },
    error: { type: 'string', maxLength: 200 },
  },
} as const

/** `YYYY-MM-DD`. The pattern catches the shape; the route checks it is a date that exists. */
const localDate = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' } as const

export const planParamsSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['date'],
  properties: { date: localDate },
} as const

/** One entry of a plan, whichever of the three sections it belongs to. Spec 05. */
const planEntryResponseSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'kind', 'rank', 'title', 'done'],
  properties: {
    id: { type: 'string' },
    kind: { type: 'string', enum: planEntryKinds },
    rank: { type: 'integer' },
    /** Null once the task has been deleted. The entry survives, because the plan is a record. */
    taskId: nullableString(64),
    title: { type: 'string' },
    rationale: nullableString(500),
    estimateMinutes: nullableInteger,
    waitingOn: nullableString(TITLE_MAX),
    waitingSince: nullableInteger,
    pushedSinceReview: { type: 'boolean' },
    /** As it stands now, so a completed entry renders as done rather than as still to do. */
    taskStatus: nullableString(20),
    done: { type: 'boolean' },
  },
} as const

export const planResponseSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'id',
    'planDate',
    'generatedAt',
    'capacityMinutes',
    'capacityVerified',
    'entries',
    'overflow',
    'nudges',
    'warnings',
  ],
  properties: {
    id: { type: 'string' },
    planDate: { type: 'string' },
    generatedAt: { type: 'integer' },
    timeZone: { type: 'string' },
    windowMinutes: { type: 'integer' },
    busyMinutes: { type: 'integer' },
    reserveMinutes: { type: 'integer' },
    /** May be negative: a day with more meetings than hours says so. Spec 05. */
    capacityMinutes: { type: 'integer' },
    capacityVerified: { type: 'boolean' },
    provider: nullableString(20),
    model: nullableString(200),
    promptVersion: { type: 'string' },
    summary: nullableString(1000),
    warnings: { type: 'array', items: { type: 'string' } },
    entries: { type: 'array', items: planEntryResponseSchema },
    overflow: { type: 'array', items: planEntryResponseSchema },
    nudges: { type: 'array', items: planEntryResponseSchema },
  },
} as const

/**
 * The plan for a day, and the fortnight of planned against completed the dashboard draws
 * beside it. Carried together because the dashboard reads them together, and a second route
 * for two numbers a day would be a second round trip for one panel. Spec 05.
 */
export const planDayResponseSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['date', 'plan', 'history'],
  properties: {
    date: { type: 'string' },
    plan: { ...planResponseSchema, nullable: true },
    history: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['planDate', 'planned', 'completed'],
        properties: {
          planDate: { type: 'string' },
          planned: { type: 'integer' },
          completed: { type: 'integer' },
        },
      },
    },
  },
} as const

export const calendarQuerySchema = {
  type: 'object',
  additionalProperties: false,
  properties: { date: localDate },
} as const

/**
 * An event as the API returns it. No description and no attendee list: neither is fetched
 * (spec 02's retained metadata), so neither can be published. Spec 09.
 */
const calendarEventResponseSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'startsAt', 'endsAt', 'allDay', 'responseStatus', 'transparency', 'status'],
  properties: {
    id: { type: 'string' },
    calendarId: { type: 'string' },
    summary: nullableString(TITLE_MAX),
    startsAt: { type: 'integer' },
    endsAt: { type: 'integer' },
    allDay: { type: 'boolean' },
    responseStatus: { type: 'string', enum: calendarResponseStatuses },
    transparency: { type: 'string', enum: calendarTransparencies },
    status: { type: 'string', enum: calendarEventStatuses },
    attendeeCount: { type: 'integer' },
    url: nullableString(2000),
    /** Whether this event took time off the day, so the column can show why one did not. */
    consumesCapacity: { type: 'boolean' },
  },
} as const

const intervalSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['start', 'end'],
  properties: { start: { type: 'integer' }, end: { type: 'integer' } },
} as const

/**
 * The day's capacity, as the capacity bar reads it. Spec 08 criterion 6 is that the bar's
 * numbers match this route, which holds because both are this one computation.
 */
export const calendarResponseSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['date', 'connected', 'events', 'capacity'],
  properties: {
    date: { type: 'string' },
    /** Whether a calendar could be read at all. False makes the capacity a guess. */
    connected: { type: 'boolean' },
    events: { type: 'array', items: calendarEventResponseSchema },
    capacity: {
      type: 'object',
      additionalProperties: false,
      required: ['windowMinutes', 'busyMinutes', 'reserveMinutes', 'capacityMinutes', 'verified'],
      properties: {
        /** Zero on a day that is not a working day, which `workingDay` is what says. */
        windowMinutes: { type: 'integer' },
        busyMinutes: { type: 'integer' },
        reserveMinutes: { type: 'integer' },
        capacityMinutes: { type: 'integer' },
        verified: { type: 'boolean' },
        workingDay: { type: 'boolean' },
        windowStart: nullableInteger,
        windowEnd: nullableInteger,
        busy: { type: 'array', items: intervalSchema },
        free: { type: 'array', items: intervalSchema },
      },
    },
  },
} as const

/** The most a chat message may be. Long enough to paste a paragraph, short of an essay. */
export const CHAT_MESSAGE_MAX = 8_000
/** How many conversations the list returns. One person does not have more open than this. */
export const CONVERSATIONS_DEFAULT = 30
export const CONVERSATIONS_MAX = 100

export const chatTurnBodySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['message'],
  properties: {
    /** Omitted to start a new conversation, which is titled from the message. */
    conversationId: { type: 'string', minLength: 1, maxLength: 64 },
    message: { type: 'string', minLength: 1, maxLength: CHAT_MESSAGE_MAX, pattern: '\\S' },
  },
} as const

/**
 * What a turn changed, as the transcript shows it. The stored inverse is deliberately absent: it
 * exists for undo and nothing on the wire has any use for it.
 */
const chatChangeResponseSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'position', 'tool', 'summary', 'entity', 'undoable'],
  properties: {
    id: { type: 'string' },
    position: { type: 'integer' },
    tool: { type: 'string' },
    summary: { type: 'string' },
    entity: { type: 'string', enum: chatChangeEntities },
    entityId: nullableString(64),
    createdAt: { type: 'integer' },
    undoneAt: nullableInteger,
    /** False for a change with nothing to put back, so undo is offered only where it works. */
    undoable: { type: 'boolean' },
  },
} as const

/** An operation the model proposed and did not perform. Spec 07, criteria 3 and 4. */
const chatConfirmationResponseSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'reason', 'tool', 'affectedCount', 'summary'],
  properties: {
    id: { type: 'string' },
    reason: { type: 'string', enum: chatConfirmationReasons },
    tool: { type: 'string' },
    /** How many items confirming would affect. Criterion 4 asks this be stated. */
    affectedCount: { type: 'integer' },
    summary: { type: 'string' },
    createdAt: { type: 'integer' },
    decidedAt: nullableInteger,
    decision: { type: ['string', 'null'], enum: [...chatConfirmationDecisions, null] },
  },
} as unknown as Record<string, unknown>

export const chatMessageResponseSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'role', 'seq', 'content', 'createdAt', 'changes', 'confirmations'],
  properties: {
    id: { type: 'string' },
    conversationId: { type: 'string' },
    seq: { type: 'integer' },
    role: { type: 'string', enum: chatRoles },
    content: { type: 'string' },
    createdAt: { type: 'integer' },
    toolCalls: { type: 'integer' },
    /** The turn stopped on its budget rather than because it had finished. Criterion 6. */
    toolCallLimitReached: { type: 'boolean' },
    /** The turn was answered by a model that cannot use tools. Criterion 7. */
    readOnly: { type: 'boolean' },
    inputTokens: { type: 'integer' },
    outputTokens: { type: 'integer' },
    stopReason: nullableString(60),
    error: nullableString(2000),
    changes: { type: 'array', items: chatChangeResponseSchema },
    confirmations: { type: 'array', items: chatConfirmationResponseSchema },
  },
} as const

export const conversationResponseSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'title', 'createdAt', 'updatedAt', 'messageCount'],
  properties: {
    id: { type: 'string' },
    title: { type: 'string' },
    createdAt: { type: 'integer' },
    updatedAt: { type: 'integer' },
    messageCount: { type: 'integer' },
    /** Spec 07: token usage per conversation is recorded and shown. */
    inputTokens: { type: 'integer' },
    outputTokens: { type: 'integer' },
  },
} as const

export const conversationListQuerySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    limit: {
      type: 'integer',
      minimum: 1,
      maximum: CONVERSATIONS_MAX,
      default: CONVERSATIONS_DEFAULT,
    },
  },
} as const

export const conversationListResponseSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['conversations'],
  properties: {
    conversations: { type: 'array', items: conversationResponseSchema },
  },
} as const

export const transcriptResponseSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['conversation', 'messages'],
  properties: {
    conversation: conversationResponseSchema,
    messages: { type: 'array', items: chatMessageResponseSchema },
  },
} as const

/** Whether chat can answer at all, and whether it can change anything. Criterion 7. */
export const chatStatusResponseSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['configured', 'readOnly', 'maxToolCalls', 'bulkConfirmThreshold'],
  properties: {
    configured: { type: 'boolean' },
    readOnly: { type: 'boolean' },
    /** Named so the UI can say what the limits are rather than describing them vaguely. */
    maxToolCalls: { type: 'integer' },
    bulkConfirmThreshold: { type: 'integer' },
    provider: nullableString(20),
    model: nullableString(200),
  },
} as const

export const chatConfirmBodySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['confirmed'],
  properties: { confirmed: { type: 'boolean' } },
} as const

export const chatConfirmResponseSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['confirmation', 'changes', 'failures'],
  properties: {
    confirmation: chatConfirmationResponseSchema,
    changes: { type: 'array', items: chatChangeResponseSchema },
    /** What could not be carried out after all, in the words the user should see. */
    failures: { type: 'array', items: { type: 'string' } },
  },
} as const

export const chatUndoBodySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['messageId'],
  properties: { messageId: { type: 'string', minLength: 1, maxLength: 64 } },
} as const

export const chatUndoResponseSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['changes'],
  properties: { changes: { type: 'array', items: chatChangeResponseSchema } },
} as const

export const privacyPreviewQuerySchema = {
  type: 'object',
  additionalProperties: false,
  properties: { taskId: { type: 'string', minLength: 1, maxLength: 64 } },
} as const

/**
 * Exactly what a classification call would contain for a real item, under the configuration as it
 * stands. Spec 09, criterion 9: shown before the policy is used, not described.
 */
export const privacyPreviewResponseSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['policy', 'item', 'payload'],
  properties: {
    policy: {
      type: 'object',
      additionalProperties: false,
      required: ['llmContent', 'storeContent', 'snippetChars'],
      properties: {
        llmContent: { type: 'string' },
        storeContent: { type: 'string' },
        snippetChars: { type: 'integer' },
        llmConsequence: { type: 'string' },
        storeConsequence: { type: 'string' },
      },
    },
    item: {
      type: ['object', 'null'],
      additionalProperties: false,
      required: ['taskId', 'title'],
      properties: {
        taskId: { type: 'string' },
        title: { type: 'string' },
        provider: nullableString(20),
      },
    },
    /** The connectors own the shape, so it is passed through whole rather than enumerated. */
    payload: { type: ['object', 'null'], additionalProperties: true },
    /** The system prompt and its version, because they are part of what is sent. */
    promptVersion: { type: 'string' },
  },
} as const
