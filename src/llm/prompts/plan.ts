/**
 * What the planner asks, and the shape it insists the answer takes. Versioned in the
 * repository and recorded on every plan, so a change in behaviour is traceable to a change in
 * what was asked. Spec 05.
 *
 * This is also a send boundary for spec 09, and a narrow one: a plan is drawn from titles,
 * statuses, estimates and deadlines, and there is no field here a message body could reach.
 * The payload is built from named fields rather than passed through, so a connector learning
 * a new fact does not start sending it to a third party by inheritance.
 */
import type { PlanCandidate } from '../../domain/plan.js'
import type { JsonSchema } from '../types.js'

/**
 * Bumped whenever the wording, the schema or the assembled payload changes in a way that could
 * change a plan. Dated rather than numbered, because what a reader of the history wants to
 * know is which era of the prompt a plan came from.
 */
export const PLAN_PROMPT_VERSION = '2026-08-10'

/**
 * The rules are stated even though they are enforced in code afterwards. A model told what
 * the constraints are produces an answer that needs less correcting, and an answer that needed
 * no correcting is one whose ordering is the model's judgement rather than a rearrangement of
 * it. Spec 05 lists them; they are worth quoting closely.
 */
export const PLAN_SYSTEM_PROMPT = `You draw one day's plan for one person, from the work they already have and the time they actually have free.

You are given the free capacity for the day in minutes, and the tasks that are eligible for it. Rank the tasks you would do, in order, and say why for each in one short sentence.

Rules:
- Overdue and due-today work comes before anything discretionary.
- Do not plan more minutes than the capacity you were given. Rank the rest below the line anyway: what does not fit is offered as "if there is time" rather than dropped.
- If there are reviews waiting, plan at least one. Somebody else is blocked on a review, and a review queue that is never planned is one that never empties.
- estimateMinutes is your honest guess at how long the task takes. Use the estimate given where there is one and you have no reason to doubt it.
- Only ever name a taskId you were given. Do not invent work, and do not merge two tasks into one entry.
- rationale is one short sentence in plain language, addressed to the person doing the work.
- summary is one or two sentences describing the shape of the day.

You are proposing, not deciding. Nothing you answer changes any task.`

/**
 * The answer's shape, as JSON Schema, carried as data. The adapters ask the provider for it
 * and `validate.ts` judges the answer by the same object, so the two cannot drift.
 */
export const planSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'entries'],
  properties: {
    summary: { type: 'string', maxLength: 1000 },
    entries: {
      type: 'array',
      // A plan longer than this is not a plan for a day. The capacity fit would cut it back
      // anyway; the cap is what stops a model spending its whole output budget on the attempt.
      maxItems: 50,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['taskId', 'rationale'],
        properties: {
          taskId: { type: 'string', maxLength: 64 },
          rationale: { type: 'string', maxLength: 500 },
          estimateMinutes: { type: ['integer', 'null'], minimum: 1, maximum: 480 },
        },
      },
    },
  },
}

/** What is actually sent about one candidate. Named fields only. */
export interface PlanCandidatePayload {
  readonly taskId: string
  readonly title: string
  readonly status: string
  readonly estimateMinutes?: number
  /** Negative when overdue, zero when due today. Absent when the task has no deadline. */
  readonly dueInDays?: number
  readonly project?: string
}

export interface PlanPayload {
  readonly date: string
  readonly capacityMinutes: number
  readonly workingWindowMinutes: number
  readonly busyMinutes: number
  /** False when no calendar was available, so the day may be busier than it looks. */
  readonly capacityVerified: boolean
  /** How many items are being chased. Context for the summary; nudges are not planned work. */
  readonly chases: number
  readonly candidates: readonly PlanCandidatePayload[]
}

const DAY_MS = 24 * 60 * 60_000

export interface PlanPayloadInput {
  readonly date: string
  readonly capacityMinutes: number
  readonly workingWindowMinutes: number
  readonly busyMinutes: number
  readonly capacityVerified: boolean
  readonly chases: number
  readonly candidates: readonly PlanCandidate[]
  /** Project titles by id, so the model reads a name rather than a uuid. */
  readonly projectTitles: ReadonlyMap<string, string>
  /** The end of the day being planned, which is what a deadline is measured against. */
  readonly dueBy: number
}

/**
 * The payload, assembled. Deadlines are sent as whole days from today rather than as instants:
 * "two days late" is the fact the ordering turns on, and an epoch millisecond is a number a
 * model has to do arithmetic on to reach it.
 */
export function buildPlanPayload(input: PlanPayloadInput): PlanPayload {
  return {
    date: input.date,
    capacityMinutes: input.capacityMinutes,
    workingWindowMinutes: input.workingWindowMinutes,
    busyMinutes: input.busyMinutes,
    capacityVerified: input.capacityVerified,
    chases: input.chases,
    candidates: input.candidates.map((candidate) => toCandidatePayload(candidate, input)),
  }
}

function toCandidatePayload(
  candidate: PlanCandidate,
  { projectTitles, dueBy }: PlanPayloadInput,
): PlanCandidatePayload {
  const project =
    candidate.projectId === null || candidate.projectId === undefined
      ? undefined
      : projectTitles.get(candidate.projectId)

  return {
    taskId: candidate.taskId,
    title: candidate.title,
    status: candidate.status,
    ...(candidate.estimateMinutes === null ? {} : { estimateMinutes: candidate.estimateMinutes }),
    ...(candidate.dueAt === null
      ? {}
      : { dueInDays: Math.ceil((candidate.dueAt - dueBy) / DAY_MS) }),
    ...(project === undefined ? {} : { project }),
  }
}

/**
 * The user turn: the payload as JSON. JSON rather than prose because it is the thing the
 * content-policy test inspects, and a template would put the same facts on the wire in a form
 * nothing could assert about.
 */
export function planRequestText(payload: PlanPayload): string {
  return `Plan this day.\n\n${JSON.stringify(payload, null, 2)}`
}
