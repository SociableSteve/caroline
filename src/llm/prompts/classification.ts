/**
 * What the classifier asks, and the shape it insists the answer takes. Versioned in the
 * repository and recorded on every classification, so a change in behaviour is traceable to a
 * change in what was asked. Spec 04.
 *
 * This is also the send boundary for spec 09: the payload is built here, from the policy, so
 * "no body text left the machine" is a property of one function and is asserted by inspecting
 * what it built rather than by reading the prompt template.
 */
import { contentAtLevel, type ContentPolicy } from '../../config/content.js'
import { proposableStatuses } from '../../domain/classification.js'
import type { SourceProvider } from '../../domain/source.js'
import type { JsonSchema } from '../types.js'

/**
 * Bumped whenever the wording, the schema or the assembled payload changes in a way that could
 * change an answer. Dated rather than numbered, because what a reader of the audit trail wants
 * to know is which era of the prompt an answer came from.
 */
export const CLASSIFICATION_PROMPT_VERSION = '2026-08-10'

/**
 * The GTD rules this system uses, spelled out. Spec 04 lists them, and they are worth quoting
 * closely: the prompt is the specification of the behaviour, so the two should read alike.
 */
export const CLASSIFICATION_SYSTEM_PROMPT = `You sort a single item of work into one place in a GTD system. You are given what is known about one item and you answer about that item alone.

Choose exactly one status:
- next_action: a single concrete action that you could do next. If it takes under two minutes, it is a next action and not a project.
- waiting: the next move belongs to someone else. Name who in waitingOn.
- review: it is waiting on you to review something someone else produced.
- someday: a real commitment, but not now.
- reference: information with no action in it.
- inbox: you cannot tell. Prefer this, with a low confidence, over a confident wrong guess.

Rules:
- If finishing it needs more than one action, suggest a project in projectSuggestion and give the first action as the title.
- Never propose done. Completing something is a human act, or a fact reported by a connector.
- Never set a due date. Deadlines come from people and from source metadata.
- suggestedTitle should be action-phrased and short: what would you actually do. Omit it if the existing title is already that.
- estimateMinutes is your honest guess at how long the action takes, or null if you cannot tell.
- confidence is how sure you are of the status, from 0 to 1. Be honest: a wrong confident answer costs more than an admitted uncertainty.
- reasoning is one or two sentences, in plain language.`

/**
 * The answer's shape, as JSON Schema, carried as data. The adapters ask the provider for it and
 * `validate.ts` judges the answer by the same object, so the two cannot drift.
 *
 * Two rules are enforced here rather than in code, because a violation should be fed back to the
 * model and retried rather than turned into an error the user reads (spec 03's one retry):
 * `done` is absent from the statuses, and `waiting` requires a `waitingOn`. Spec 04, criteria 4
 * and 5.
 */
export const classificationSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['status', 'confidence', 'reasoning'],
  properties: {
    status: { type: 'string', enum: [...proposableStatuses] },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    reasoning: { type: 'string', maxLength: 1000 },
    suggestedTitle: { type: ['string', 'null'], maxLength: 500 },
    estimateMinutes: { type: ['integer', 'null'], minimum: 1, maximum: 480 },
    waitingOn: { type: ['string', 'null'], maxLength: 200 },
    projectSuggestion: {
      type: ['object', 'null'],
      additionalProperties: false,
      properties: {
        existingProjectId: { type: ['string', 'null'], maxLength: 64 },
        newProjectTitle: { type: ['string', 'null'], maxLength: 200 },
      },
    },
  },
  if: { properties: { status: { const: 'waiting' } }, required: ['status'] },
  then: {
    properties: { waitingOn: { type: 'string', minLength: 1, maxLength: 200 } },
    required: ['waitingOn'],
  },
}

/** One item as the classifier knows it, before any policy has been applied to it. */
export interface ClassificationItem {
  readonly taskId: string
  readonly title: string
  /** Null for a task typed in by hand, which has no upstream item behind it. */
  readonly provider: SourceProvider | null
  readonly metadata: unknown
  /** The body as available now: read from the row, or fetched for this call. May be null. */
  readonly content: string | null
  /** When the item was captured, which is what its age is measured from. */
  readonly createdAt: number
}

/**
 * What is actually sent. Every field is optional because the policy decides which of them exist:
 * at `metadata` there is no snippet, and at `none` there is nothing but the id.
 */
export interface ClassificationPayload {
  readonly taskId: string
  readonly source: string
  readonly ageDays?: number
  readonly title?: string
  readonly from?: string
  readonly participants?: readonly string[]
  readonly labels?: readonly string[]
  readonly messageCount?: number
  readonly pullRequest?: {
    readonly repository?: string
    readonly author?: string
    readonly changedFiles?: number
    readonly additions?: number
    readonly deletions?: number
  }
  readonly snippet?: string
}

function text(value: unknown, max = 500): string | undefined {
  if (typeof value !== 'string' || value === '') return undefined
  return value.length <= max ? value : value.slice(0, max)
}

function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function strings(value: unknown, max: number): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const found = value.filter((entry): entry is string => typeof entry === 'string').slice(0, max)
  return found.length === 0 ? undefined : found
}

/**
 * Drops the fields that turned out not to exist. Building the payload by assignment and then
 * removing the absent keys reads better than a spread per field, and it is what puts a fact on the
 * wire only when there is a fact.
 */
function compact<T>(fields: Record<string, unknown>): T {
  return Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== undefined),
  ) as unknown as T
}

/**
 * The metadata `metadata` and above permit: sender or author, recipients, subject or title,
 * timestamps, labels and pull request statistics, and no body. Named explicitly rather than
 * passed through, because a connector that learns a new fact should not start sending it to a
 * third party by inheritance. Spec 09.
 */
function metadataFields(item: ClassificationItem): Partial<ClassificationPayload> {
  const metadata = (item.metadata ?? {}) as Record<string, unknown>

  if (item.provider === 'github') {
    return {
      pullRequest: compact({
        repository: text(metadata.repository),
        author: text(metadata.author),
        changedFiles: count(metadata.changedFiles),
        additions: count(metadata.additions),
        deletions: count(metadata.deletions),
      }),
    }
  }

  return compact({
    from: text(metadata.from, 200),
    participants: strings(metadata.participants, 20),
    labels: strings(metadata.labels, 20),
    messageCount: count(metadata.messageCount),
  })
}

const DAY_MS = 24 * 60 * 60_000

/**
 * The payload, assembled under the policy. This is the only place an item becomes something
 * sent, and `llmContent` is the only thing that decides how much of it there is. Spec 09,
 * criterion 1.
 */
export function buildClassificationPayload(
  item: ClassificationItem,
  policy: Pick<ContentPolicy, 'llmContent' | 'snippetChars'>,
  now: number,
): ClassificationPayload {
  const source = item.provider ?? 'manual'

  // Nothing beyond internal ids. Classification is effectively disabled at this level, and the
  // classifier does not call at all, but the boundary holds even if something did. Spec 09.
  if (policy.llmContent === 'none') return { taskId: item.taskId, source }

  const snippet = contentAtLevel(item.content, policy.llmContent, policy.snippetChars)

  return compact<ClassificationPayload>({
    taskId: item.taskId,
    source,
    ageDays: Math.max(0, Math.floor((now - item.createdAt) / DAY_MS)),
    title: text(item.title),
    ...metadataFields(item),
    snippet: snippet ?? undefined,
  })
}

/**
 * The user turn: the payload as JSON. JSON rather than prose because it is the thing the content
 * policy test inspects, and a template would put the same facts on the wire in a form nothing
 * could assert about.
 */
export function classificationRequestText(payload: ClassificationPayload): string {
  return `Sort this item.\n\n${JSON.stringify(payload, null, 2)}`
}
