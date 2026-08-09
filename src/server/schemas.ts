/**
 * The JSON schemas the routes validate against and serialise through. Spec 08: the schemas
 * are the API contract, so they live in one place rather than being spelled out per route.
 *
 * Response schemas are declared as well as request ones. A field missing from a response
 * schema is dropped from the payload, which makes the schema the definition of what the API
 * returns rather than a description of it.
 */
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

export const jobRunTriggeredResponseSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['job', 'results'],
  properties: {
    job: { type: 'string' },
    results: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['provider', 'status', 'counts'],
        properties: {
          provider: { type: 'string', enum: sourceProviders },
          status: { type: 'string', enum: jobRunStatuses },
          counts: jobCountsSchema,
          error: nullableString(2000),
        },
      },
    },
  },
} as const
