/**
 * The classifier: empty the inbox without ever overriding a human decision and without guessing
 * when it is not confident. Spec 04.
 *
 * One call per task, not one per batch, so a bad item cannot corrupt the rest, with bounded
 * concurrency. Each task's writes land in one transaction, so a failure part-way through leaves
 * no half-applied answer.
 */
import { contentAtLevel, levelAllows } from '../config/content.js'
import type { Config } from '../config/schema.js'
import { withTransaction, type Database } from '../db/connection.js'
import { recordClassification } from '../db/repositories/classifications.js'
import { listSourcesForTask } from '../db/repositories/sources.js'
import {
  changeTaskStatus,
  listClassificationCandidates,
  updateTask,
} from '../db/repositories/tasks.js'
import {
  isConfident,
  mayRetitle,
  notesWithOriginalTitle,
  type ClassificationProposal,
  type ProjectSuggestion,
} from '../domain/classification.js'
import { noCounts, type JobCounts, type JobRunStatus } from '../domain/job.js'
import type { Source } from '../domain/source.js'
import type { Task, TaskStatus } from '../domain/task.js'
import type { LlmRuntime } from '../llm/index.js'
import {
  buildClassificationPayload,
  classificationRequestText,
  classificationSchema,
  CLASSIFICATION_PROMPT_VERSION,
  CLASSIFICATION_SYSTEM_PROMPT,
} from '../llm/prompts/classification.js'

export const CLASSIFY_JOB = 'classify'

/**
 * Fetches an item's body at the moment it is needed, for the case spec 09 allows and the default
 * configuration is: `llmContent` above `storeContent`, so a snippet may be sent while nothing is
 * kept. The body cannot come from the row, because by design it is not in it.
 */
export type ContentFetcher = (source: Source) => Promise<string | null>

/** Per provider. A provider with no fetcher contributes whatever is stored, or nothing. */
export type ContentFetchers = Partial<Record<Source['provider'], ContentFetcher>>

export interface ClassifyOptions {
  readonly database: Database
  readonly config: Config
  readonly llm: LlmRuntime
  readonly content?: ContentFetchers
  readonly now: () => number
}

export interface ClassifyResult {
  readonly status: JobRunStatus
  readonly counts: JobCounts
  readonly error: string | null
}

type Tally = { -readonly [K in keyof JobCounts]: JobCounts[K] }

/** What became of one task. Kept per task so the aggregate can be honest about a partial run. */
type Outcome =
  | { readonly kind: 'applied' }
  | { readonly kind: 'proposed' }
  | { readonly kind: 'failed'; readonly error: string }

/**
 * Runs `work` over `items` with at most `limit` in flight. The straightforward pool: each worker
 * takes the next index until there are none, so a slow item does not hold up the others.
 */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array<R>(items.length)
  let next = 0

  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next
      next += 1
      const item = items[index]
      if (index >= items.length || item === undefined) return

      results[index] = await work(item)
    }
  })

  await Promise.all(workers)
  return results
}

/** The item's own source, where it has one. The first is the only one any connector creates. */
function sourceOf(database: Database, task: Task): Source | null {
  return listSourcesForTask(database, task.id)[0] ?? null
}

/**
 * The body to send, under the policy. Read from the row when what is stored is at least what may
 * be sent, and fetched transiently when it is not: the default policy stores no bodies and sends
 * a snippet, and the only way to honour both is to compute the snippet at the moment of sending
 * and keep nothing. Spec 09.
 */
export async function bodyForSending(
  source: Source | null,
  config: Config,
  content: ClassifyOptions['content'],
): Promise<string | null> {
  const { llmContent, storeContent, snippetChars } = config.privacy
  if (!levelAllows(llmContent, 'snippet')) return null
  if (source === null) return null

  if (levelAllows(storeContent, llmContent)) {
    return contentAtLevel(source.content, llmContent, snippetChars)
  }

  const fetcher = content?.[source.provider]
  if (fetcher === undefined) return contentAtLevel(source.content, llmContent, snippetChars)

  const fetched = await fetcher(source)
  return contentAtLevel(fetched ?? source.content, llmContent, snippetChars)
}

/** Narrows the validated answer to the proposal the rest of this file works with. */
function toProposal(structured: unknown): ClassificationProposal {
  const answer = structured as {
    status: TaskStatus
    confidence: number
    reasoning: string
    suggestedTitle?: string | null
    estimateMinutes?: number | null
    waitingOn?: string | null
    projectSuggestion?: ProjectSuggestion | null
  }

  return {
    status: answer.status,
    confidence: answer.confidence,
    reasoning: answer.reasoning,
    suggestedTitle: answer.suggestedTitle ?? null,
    estimateMinutes: answer.estimateMinutes ?? null,
    waitingOn: answer.waitingOn ?? null,
    projectSuggestion: answer.projectSuggestion ?? null,
  }
}

/**
 * Applies a confident answer. The status change goes through the domain rule, which is what
 * refuses to overrule a status the user set: a refused change is recorded as a proposal rather
 * than lost. Spec 01, criterion 2.
 *
 * The suggested title replaces the item's only while the user has not rewritten it themselves,
 * and the original is kept in the notes. The estimate is seeded and never overwritten, for the
 * same reason the GitHub connector seeds one once: it is editable, and a job that reimposed its
 * own guess hourly would not leave it editable for long.
 */
function apply(
  database: Database,
  task: Task,
  source: Source | null,
  proposal: ClassificationProposal,
  at: number,
): boolean {
  return withTransaction(database, () => {
    const result = changeTaskStatus(database, task.id, {
      status: proposal.status,
      by: 'llm',
      at,
    })
    if (result === null || !result.applied) return false

    const retitling =
      proposal.suggestedTitle !== null &&
      proposal.suggestedTitle.trim() !== '' &&
      proposal.suggestedTitle !== task.title &&
      mayRetitle(task.title, source?.title ?? null)

    updateTask(
      database,
      task.id,
      {
        ...(retitling
          ? {
              title: proposal.suggestedTitle as string,
              notes: notesWithOriginalTitle(task.notes, task.title),
            }
          : {}),
        ...(task.estimateMinutes === null && proposal.estimateMinutes !== null
          ? { estimateMinutes: proposal.estimateMinutes }
          : {}),
        ...(proposal.status === 'waiting' ? { waitingOn: proposal.waitingOn } : {}),
      },
      at,
    )

    return true
  })
}

async function classifyOne(
  { database, config, llm, content, now }: ClassifyOptions,
  task: Task,
): Promise<Outcome> {
  const source = sourceOf(database, task)
  const provider = llm.for('classification')

  try {
    const body = await bodyForSending(source, config, content)
    const payload = buildClassificationPayload(
      {
        taskId: task.id,
        title: task.title,
        provider: source?.provider ?? null,
        metadata: source?.metadata ?? null,
        content: body,
        createdAt: task.createdAt,
      },
      config.privacy,
      now(),
    )

    const result = await provider.complete({
      system: CLASSIFICATION_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: classificationRequestText(payload) }],
      schema: classificationSchema,
      maxTokens: config.llm.overrides.classification?.maxTokens ?? config.llm.maxTokens,
    })

    const proposal = toProposal(result.structured)
    const confident = isConfident(proposal.confidence, config.classification.confidenceThreshold)
    const at = now()
    const applied = confident && apply(database, task, source, proposal, at)

    recordClassification(
      database,
      {
        taskId: task.id,
        proposedStatus: proposal.status,
        confidence: proposal.confidence,
        reasoning: proposal.reasoning,
        suggestedTitle: proposal.suggestedTitle,
        estimateMinutes: proposal.estimateMinutes,
        waitingOn: proposal.waitingOn,
        projectSuggestion: proposal.projectSuggestion,
        provider: provider.name,
        model: provider.model,
        promptVersion: CLASSIFICATION_PROMPT_VERSION,
        applied,
      },
      at,
    )

    return applied ? { kind: 'applied' } : { kind: 'proposed' }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)

    // The failure is a row of its own: spec 04 criterion 6 asks for one row per task processed,
    // including the ones that failed, and a run that could not reach the provider should leave a
    // record of having tried rather than a silence. The task itself is untouched.
    recordClassification(
      database,
      {
        taskId: task.id,
        provider: provider.name,
        model: provider.model,
        promptVersion: CLASSIFICATION_PROMPT_VERSION,
        applied: false,
        error: message,
      },
      now(),
    )

    return { kind: 'failed', error: message }
  }
}

/**
 * One classification run. Returns what happened rather than recording it: the scheduler owns the
 * `job_runs` row, so that a manual run and a scheduled one are recorded the same way.
 *
 * The aggregate status is `failure` only when every task attempted failed, which is what a
 * provider outage looks like and what spec 04 criterion 7 asks be recorded. A run where some
 * tasks failed and others were sorted is a success that says how many did not, because backing
 * the whole job off for one malformed item would delay the ones that work.
 */
export async function runClassification(options: ClassifyOptions): Promise<ClassifyResult> {
  const { database, config, llm } = options
  const tally: Tally = { ...noCounts }

  // At `none` there is nothing the model could be told about an item, so classification is
  // disabled rather than attempted with an empty payload. Spec 09.
  if (config.privacy.llmContent === 'none') {
    return {
      status: 'skipped',
      counts: { ...tally },
      error: 'privacy.llmContent is "none", so there is nothing to classify with.',
    }
  }

  if (!llm.isConfigured('classification')) {
    return {
      status: 'skipped',
      counts: { ...tally },
      error: 'No LLM provider is configured, so the inbox cannot be sorted.',
    }
  }

  const candidates = listClassificationCandidates(database, config.classification.batchSize)
  if (candidates.length === 0) return { status: 'success', counts: { ...tally }, error: null }

  const outcomes = await mapWithConcurrency(candidates, config.classification.concurrency, (task) =>
    classifyOne(options, task),
  )

  const failures: string[] = []
  for (const outcome of outcomes) {
    // One call started per task. A schema retry is a second provider call, and it is `llm_calls`
    // that records those: this count is what the job attempted, not what the wire saw.
    tally.llmCalls += 1

    if (outcome.kind === 'failed') {
      tally.failed += 1
      failures.push(outcome.error)
      continue
    }

    tally.classified += 1
    if (outcome.kind === 'applied') tally.tasksUpdated += 1
    else tally.proposals += 1
  }

  if (failures.length === 0) return { status: 'success', counts: { ...tally }, error: null }

  const first = failures[0] ?? 'unknown error'
  const summary =
    failures.length === outcomes.length
      ? `Every classification failed: ${first}`
      : `${failures.length} of ${outcomes.length} classifications failed: ${first}`

  return {
    status: failures.length === outcomes.length ? 'failure' : 'success',
    counts: { ...tally },
    error: summary,
  }
}
