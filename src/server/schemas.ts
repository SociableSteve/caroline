/**
 * The JSON schemas the routes validate against and serialise through. Spec 08: the schemas
 * are the API contract, so they live in one place rather than being spelled out per route.
 *
 * Response schemas are declared as well as request ones. A field missing from a response
 * schema is dropped from the payload, which makes the schema the definition of what the API
 * returns rather than a description of it.
 */
import { projectStates } from '../domain/project.js'
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

export const taskResponseSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'title', 'status', 'statusSetBy', 'statusSetAt', 'syncTracked', 'tags'],
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
