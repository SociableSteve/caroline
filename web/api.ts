/**
 * The one place the client talks to the server. Every call goes through `request`, so the
 * standard error shape (spec 08) is unwrapped once and the rest of the UI can deal in
 * ordinary rejected promises.
 *
 * The task and project types come from `src/domain`, which is pure and has no IO in it, so
 * the client and the server describe the same things in the same words rather than keeping
 * two copies of the vocabulary in step by hand.
 */
import type {
  CalendarEventStatus,
  CalendarResponseStatus,
  CalendarTransparency,
} from '../src/domain/calendar.js'
import type { Interval } from '../src/domain/capacity.js'
import type { JobRun } from '../src/domain/job.js'
import type { Project, ProjectState } from '../src/domain/project.js'
import type { Source } from '../src/domain/source.js'
import { taskStatuses, type Task, type TaskStatus } from '../src/domain/task.js'

export type { JobRun, Project, ProjectState, Task, TaskStatus }
export { taskStatuses }

/**
 * A source as the API returns it. The stored body and the hashing internals are not on the
 * wire: `sourceResponseSchema` in `src/server/schemas.ts` is the contract, and this is the
 * same set of fields said in types.
 */
export type SourceView = Omit<
  Source,
  | 'content'
  | 'contentLevel'
  | 'contentStoredAt'
  | 'contentHash'
  | 'taskId'
  | 'firstSeenAt'
  | 'lastSeenAt'
>

/** What the GitHub connector puts in a source's metadata. Spec 02. */
export interface PullRequestMetadata {
  readonly repository?: string
  readonly number?: number
  readonly author?: string | null
  readonly draft?: boolean
  readonly additions?: number
  readonly deletions?: number
  readonly changedFiles?: number
  readonly headSha?: string
  readonly headCommittedAt?: number | null
  readonly lastReviewState?: string | null
  readonly lastReviewAt?: number | null
}

/** The columns the board shows. `done` is not one of them: finished work leaves the board. */
export const boardStatuses: readonly TaskStatus[] = taskStatuses.filter(
  (status) => status !== 'done',
)

/**
 * A classifier answer waiting on the user: below the confidence threshold when it was made, so the
 * task stayed in the inbox with this attached. Spec 04.
 */
export interface ProposalView {
  readonly id: string
  readonly status: TaskStatus
  readonly confidence: number
  readonly reasoning: string | null
  readonly suggestedTitle: string | null
  readonly estimateMinutes: number | null
  readonly waitingOn: string | null
  readonly projectSuggestion: {
    readonly existingProjectId: string | null
    readonly newProjectTitle: string | null
  } | null
  readonly model: string | null
  readonly promptVersion: string
  readonly createdAt: number
}

/** A task as the API returns it: the stored row, its tags, where it came from, and any proposal. */
export interface TaskView extends Task {
  readonly tags: string[]
  readonly sources: SourceView[]
  readonly proposal: ProposalView | null
}

/** One scheduled job, as the jobs surface reads it. Spec 06. */
export interface JobStatus {
  readonly job: string
  readonly cron: string
  readonly running: boolean
  readonly nextRunAt: number | null
  readonly lastRun: JobRun | null
  readonly consecutiveFailures: number
  readonly backoffUntil: number | null
}

/** The Google connection, as Settings reads it. No token ever reaches here. Spec 09. */
export interface GoogleStatus {
  readonly connected: boolean
  readonly configured: boolean
  readonly connectedAt: number | null
  readonly scopes: string[]
  readonly redirectUri: string
}

/** What a classification call would contain for a real item under the current policy. Spec 09. */
export interface PrivacyPreview {
  readonly policy: {
    readonly llmContent: string
    readonly storeContent: string
    readonly snippetChars: number
    readonly llmConsequence?: string
    readonly storeConsequence?: string
  }
  readonly item: {
    readonly taskId: string
    readonly title: string
    readonly provider: string | null
  } | null
  readonly payload: Record<string, unknown> | null
  readonly promptVersion?: string
}

/** One line of a plan, in whichever of the three sections it belongs to. Spec 05. */
export interface PlanEntryView {
  readonly id: string
  readonly kind: 'plan' | 'overflow' | 'nudge'
  readonly rank: number
  /** Null once the task has been deleted. The entry survives, because the plan is a record. */
  readonly taskId: string | null
  readonly title: string
  readonly rationale: string | null
  readonly estimateMinutes: number | null
  readonly waitingOn: string | null
  readonly waitingSince: number | null
  readonly pushedSinceReview: boolean
  readonly taskStatus: TaskStatus | null
  readonly done: boolean
}

/** A day's plan as the API returns it. Spec 05. */
export interface PlanView {
  readonly id: string
  readonly planDate: string
  readonly generatedAt: number
  readonly timeZone: string
  readonly windowMinutes: number
  readonly busyMinutes: number
  readonly reserveMinutes: number
  /** May be negative: a day with more meetings in it than hours says so. */
  readonly capacityMinutes: number
  readonly capacityVerified: boolean
  readonly provider: string | null
  readonly model: string | null
  readonly promptVersion: string
  readonly summary: string | null
  readonly warnings: string[]
  readonly entries: PlanEntryView[]
  /** The "if there is time" list. Spec 05: excess is moved here, never dropped. */
  readonly overflow: PlanEntryView[]
  readonly nudges: PlanEntryView[]
}

/** Planned against completed for one day. Spec 05's fortnight. */
export interface PlanHistoryDay {
  readonly planDate: string
  readonly planned: number
  readonly completed: number
}

export interface PlanDay {
  readonly date: string
  readonly plan: PlanView | null
  readonly history: PlanHistoryDay[]
}

export interface CalendarEventView {
  readonly id: string
  readonly calendarId: string
  readonly summary: string | null
  readonly startsAt: number
  readonly endsAt: number
  readonly allDay: boolean
  readonly responseStatus: CalendarResponseStatus
  readonly transparency: CalendarTransparency
  readonly status: CalendarEventStatus
  readonly attendeeCount: number
  readonly url: string | null
  /** Whether it took time off the day, so the column can show why one did not. */
  readonly consumesCapacity: boolean
}

/** The day's capacity, as the capacity bar draws it. Spec 08, criterion 6. */
export interface CapacityView {
  readonly windowMinutes: number
  readonly busyMinutes: number
  readonly reserveMinutes: number
  readonly capacityMinutes: number
  /** False when no calendar is connected, so the window was assumed free. */
  readonly verified: boolean
  readonly workingDay: boolean
  readonly windowStart: number | null
  readonly windowEnd: number | null
  readonly busy: Interval[]
  readonly free: Interval[]
}

export interface CalendarDay {
  readonly date: string
  readonly connected: boolean
  readonly events: CalendarEventView[]
  readonly capacity: CapacityView
}

/** Whether chat can answer, and whether it can change anything. Spec 07, criterion 7. */
export interface ChatStatus {
  readonly configured: boolean
  readonly readOnly: boolean
  readonly maxToolCalls: number
  readonly bulkConfirmThreshold: number
  readonly provider: string | null
  readonly model: string | null
}

export interface ConversationView {
  readonly id: string
  readonly title: string
  readonly createdAt: number
  readonly updatedAt: number
  readonly messageCount: number
  readonly inputTokens: number
  readonly outputTokens: number
}

/** One thing a turn changed, as the transcript renders it. Spec 07's compact record. */
export interface ChatChangeView {
  readonly id: string
  readonly position: number
  readonly tool: string
  readonly summary: string
  readonly entity: 'task' | 'project' | 'plan'
  readonly entityId: string | null
  readonly createdAt: number
  readonly undoneAt: number | null
  /** False for a change with nothing to put back, so undo is offered only where it works. */
  readonly undoable: boolean
}

/** An operation the model proposed and did not perform. Spec 07, criteria 3 and 4. */
export interface ChatConfirmationView {
  readonly id: string
  readonly reason: 'delete' | 'bulk'
  readonly tool: string
  readonly affectedCount: number
  readonly summary: string
  readonly createdAt: number
  readonly decidedAt: number | null
  readonly decision: 'confirmed' | 'rejected' | null
}

export interface ChatMessageView {
  readonly id: string
  readonly conversationId: string
  readonly seq: number
  readonly role: 'user' | 'assistant'
  readonly content: string
  readonly createdAt: number
  readonly toolCalls: number
  readonly toolCallLimitReached: boolean
  readonly readOnly: boolean
  readonly inputTokens: number
  readonly outputTokens: number
  readonly stopReason: string | null
  readonly error: string | null
  readonly changes: ChatChangeView[]
  readonly confirmations: ChatConfirmationView[]
}

export interface TranscriptView {
  readonly conversation: ConversationView
  readonly messages: ChatMessageView[]
}

/**
 * A turn as it arrives. The same records the history route returns, so a live turn and a reopened
 * one are rendered by one piece of code.
 */
export type ChatStreamEvent =
  | { readonly type: 'conversation'; readonly conversation: ConversationView }
  | { readonly type: 'user-message'; readonly message: ChatMessageView }
  | { readonly type: 'turn'; readonly messageId: string; readonly readOnly: boolean }
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'tool'; readonly name: string; readonly outcome: string }
  | { readonly type: 'change'; readonly change: ChatChangeView }
  | { readonly type: 'confirmation'; readonly confirmation: ChatConfirmationView }
  | {
      readonly type: 'done'
      readonly message: ChatMessageView
      readonly conversation: ConversationView
    }
  | { readonly type: 'error'; readonly message: string }

/** A project as the API returns it, with the two fields spec 01 derives rather than stores. */
export interface ProjectView extends Project {
  readonly nextAction: TaskView | null
  readonly stalled: boolean
}

export interface TaskPage {
  readonly tasks: TaskView[]
  readonly total: number
  readonly limit: number
  readonly offset: number
}

/** Every matching task the client could fetch, and whether that was all of them. */
export interface TaskCollection {
  readonly tasks: TaskView[]
  readonly total: number
  /** True when the ceiling was hit and `tasks` is therefore not the whole answer. */
  readonly truncated: boolean
}

export interface IntegrationStatus {
  readonly configured: boolean
  readonly status: string
}

export interface Health {
  readonly status: string
  readonly version: string
  readonly uptimeSeconds: number
  readonly database?: { status: string }
  readonly integrations: Record<string, IntegrationStatus>
}

/** Only the parts of the redacted config the UI reads. The route returns rather more. */
export interface ClientConfig {
  readonly tasks: { readonly waitingStaleDays: number }
}

export interface TaskFilter {
  readonly status?: TaskStatus
  readonly projectId?: string
  readonly tag?: string
  readonly search?: string
}

export interface TaskInput {
  readonly title?: string
  readonly notes?: string | null
  readonly status?: TaskStatus
  readonly projectId?: string | null
  readonly sortOrder?: number
  readonly estimateMinutes?: number | null
  readonly dueAt?: number | null
  readonly deferUntil?: number | null
  readonly waitingOn?: string | null
  readonly tags?: string[]
}

export interface ProjectInput {
  readonly title?: string
  readonly notes?: string | null
  readonly state?: ProjectState
}

export interface BulkResult {
  readonly id: string
  readonly applied: boolean
  readonly reason?: string
}

/** A request the server refused, carrying what it said about why. */
export class ApiFailure extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'ApiFailure'
    this.status = status
    this.code = code
  }
}

/**
 * A single-user process with one browser tab has no use for paging in the UI, so the board
 * fetches everything and groups it client-side. It still has to fetch it: done tasks
 * accumulate for as long as Caroline is used, so one page is not a safe assumption. The page
 * size is the server's own maximum.
 */
const PAGE = 500

/**
 * The most the client will fetch in one pass, as a guard rather than an expectation: without
 * one, a database far larger than this design anticipates would have the UI issue requests
 * until the tab gave up. Hitting it is reported rather than hidden, so the screen never
 * quietly shows a subset.
 */
const MAX_TASKS = 5_000

function errorFrom(status: number, body: unknown): ApiFailure {
  const error = (body as { error?: { code?: unknown; message?: unknown } } | null)?.error
  const code = typeof error?.code === 'string' ? error.code : 'unknown'
  const message =
    typeof error?.message === 'string' ? error.message : `The server answered ${status}`

  return new ApiFailure(status, code, message)
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    ...(init?.body === undefined ? {} : { headers: { 'content-type': 'application/json' } }),
  })

  if (!response.ok) {
    // A body that is not the standard shape is still a failure worth reporting, so parsing
    // it is allowed to fail without taking the failure itself with it.
    const body = await response.json().catch(() => null)
    throw errorFrom(response.status, body)
  }

  // 204 has no body, and asking for one throws.
  if (response.status === 204) return undefined as T

  return (await response.json()) as T
}

function send<T>(method: string, path: string, body?: unknown): Promise<T> {
  return request<T>(path, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

/** Ids reach the path, so they are escaped: a task id is opaque text, not a path fragment. */
function taskPath(id: string, suffix = ''): string {
  return `/api/tasks/${encodeURIComponent(id)}${suffix}`
}

function projectPath(id: string): string {
  return `/api/projects/${encodeURIComponent(id)}`
}

/** The event names a turn sends. Anything else is not something this client knows how to render. */
const chatEventTypes: readonly string[] = [
  'conversation',
  'user-message',
  'turn',
  'text',
  'tool',
  'change',
  'confirmation',
  'done',
  'error',
]

/**
 * One server-sent event, as a chat event. Comments and keep-alives have no `data:` line and are
 * skipped; so is an event whose data will not parse, because half an event is not one, and so is
 * one whose name this client does not know: passing it on would have the reader treat it as
 * whichever type it tests for last.
 */
function parseEvent(block: string): ChatStreamEvent | null {
  let name = ''
  const data: string[] = []

  for (const line of block.split('\n')) {
    if (line.startsWith('event:')) name = line.slice('event:'.length).trim()
    // A multi-line data field is legal SSE and is rejoined with newlines, as the standard says.
    if (line.startsWith('data:')) data.push(line.slice('data:'.length).trimStart())
  }

  if (name === '' || data.length === 0 || !chatEventTypes.includes(name)) return null

  try {
    return { type: name, ...(JSON.parse(data.join('\n')) as object) } as ChatStreamEvent
  } catch {
    return null
  }
}

export const api = {
  /** One page. Exposed for the tests and for anything that genuinely wants a window. */
  listTaskPage(filter: TaskFilter = {}, offset = 0): Promise<TaskPage> {
    const query = new URLSearchParams({ limit: String(PAGE), offset: String(offset) })
    for (const [key, value] of Object.entries(filter)) {
      if (value !== undefined) query.set(key, String(value))
    }

    return request<TaskPage>(`/api/tasks?${query.toString()}`)
  },

  /**
   * Every matching task, following the pages until the server's own total is met: the board
   * and the dashboard read from one call and each decides what to show. Deferred tasks are
   * left out by the server unless asked for, and the filter is the caller's, which is what
   * the project drill-in uses.
   */
  async listTasks(filter: TaskFilter = {}): Promise<TaskCollection> {
    const tasks: TaskView[] = []
    let total = 0

    for (;;) {
      const page = await api.listTaskPage(filter, tasks.length)
      total = page.total
      tasks.push(...page.tasks)

      // An empty page ends it whatever the total says, so a total that disagrees with the rows
      // cannot spin here.
      if (page.tasks.length === 0) break
      if (tasks.length >= total) break
      if (tasks.length >= MAX_TASKS) return { tasks, total, truncated: true }
    }

    return { tasks, total, truncated: false }
  },

  createTask(input: TaskInput): Promise<TaskView> {
    return send<TaskView>('POST', '/api/tasks', input)
  },

  patchTask(id: string, input: TaskInput): Promise<TaskView> {
    return send<TaskView>('PATCH', taskPath(id), input)
  },

  completeTask(id: string): Promise<TaskView> {
    return send<TaskView>('POST', taskPath(id, '/complete'))
  },

  deleteTask(id: string): Promise<void> {
    return send<void>('DELETE', taskPath(id))
  },

  setTracking(id: string, enabled: boolean): Promise<TaskView> {
    return send<TaskView>('POST', taskPath(id, '/tracking'), { enabled })
  },

  /** Discharge your part of a review. Moves the card to Waiting for. Spec 02. */
  markReviewed(id: string): Promise<TaskView> {
    return send<TaskView>('POST', taskPath(id, '/mark-reviewed'))
  },

  /**
   * Put the last status change back, the actor with it, so a task moved by mistake is once again a
   * task the classifier may act on. Spec 08, criterion 16.
   */
  undoStatus(id: string): Promise<TaskView> {
    return send<TaskView>('POST', taskPath(id, '/undo-status'))
  },

  /** Accept the classifier's proposal. The status becomes the user's own. Spec 04, criterion 9. */
  acceptProposal(id: string): Promise<TaskView> {
    return send<TaskView>('POST', taskPath(id, '/proposal/accept'))
  },

  /** Dismiss it. The task stays where it is and stops being asked about. */
  dismissProposal(id: string): Promise<TaskView> {
    return send<TaskView>('POST', taskPath(id, '/proposal/dismiss'))
  },

  listJobRuns(limit = 20): Promise<{ runs: JobRun[] }> {
    return request(`/api/jobs?limit=${limit}`)
  },

  listJobStatus(): Promise<{ jobs: JobStatus[] }> {
    return request('/api/jobs/status')
  },

  runJob(name: string): Promise<unknown> {
    return send('POST', `/api/jobs/${encodeURIComponent(name)}/run`)
  },

  /** The plan for a day, and the fortnight beside it. Defaults to today. Spec 05. */
  getPlan(date?: string): Promise<PlanDay> {
    return request<PlanDay>(
      date === undefined ? '/api/plan' : `/api/plan/${encodeURIComponent(date)}`,
    )
  },

  /** Redraws today's plan. The previous one stays in history. Spec 05, criterion 8. */
  regeneratePlan(date: string): Promise<PlanDay> {
    return send<PlanDay>('POST', `/api/plan/${encodeURIComponent(date)}/regenerate`)
  },

  getCalendar(date?: string): Promise<CalendarDay> {
    return request<CalendarDay>(
      date === undefined ? '/api/calendar' : `/api/calendar?date=${encodeURIComponent(date)}`,
    )
  },

  getGoogleStatus(): Promise<GoogleStatus> {
    return request<GoogleStatus>('/api/integrations/google')
  },

  connectGoogle(): Promise<{ url: string }> {
    return send('POST', '/api/integrations/google/connect')
  },

  disconnectGoogle(): Promise<void> {
    return send<void>('DELETE', '/api/integrations/google')
  },

  getPrivacyPreview(): Promise<PrivacyPreview> {
    return request<PrivacyPreview>('/api/privacy/preview')
  },

  bulkTasks(input: {
    ids: string[]
    status?: TaskStatus
    projectId?: string | null
  }): Promise<{ results: BulkResult[] }> {
    return send('POST', '/api/tasks/bulk', input)
  },

  listProjects(): Promise<{ projects: ProjectView[] }> {
    return request('/api/projects')
  },

  createProject(input: ProjectInput): Promise<ProjectView> {
    return send<ProjectView>('POST', '/api/projects', input)
  },

  patchProject(id: string, input: ProjectInput): Promise<ProjectView> {
    return send<ProjectView>('PATCH', projectPath(id), input)
  },

  deleteProject(id: string): Promise<void> {
    return send<void>('DELETE', projectPath(id))
  },

  getChatStatus(): Promise<ChatStatus> {
    return request<ChatStatus>('/api/chat/status')
  },

  listConversations(): Promise<{ conversations: ConversationView[] }> {
    return request('/api/chat/conversations')
  },

  getConversation(id: string): Promise<TranscriptView> {
    return request<TranscriptView>(`/api/chat/conversations/${encodeURIComponent(id)}`)
  },

  /**
   * Sends a turn and reads the stream it answers with. `EventSource` cannot post a body, so the
   * stream is read off `fetch` and cut into events here.
   *
   * A turn is recorded as it happens, so abandoning the read does not abandon the turn: the caller
   * that gives up gets the rest by reloading the conversation.
   */
  async streamChat(
    input: { conversationId?: string; message: string },
    onEvent: (event: ChatStreamEvent) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
      ...(signal === undefined ? {} : { signal }),
    })

    if (!response.ok) {
      const body = await response.json().catch(() => null)
      throw errorFrom(response.status, body)
    }
    if (response.body === null) throw new ApiFailure(500, 'unknown', 'The turn sent no stream')

    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
    let buffered = ''

    for (;;) {
      const { value, done } = await reader.read()
      if (done) break

      // Normalised, because SSE allows CRLF and a boundary of `\r\n\r\n` contains no `\n\n` to
      // split on: a stream through something that rewrote the line endings would never yield an event.
      buffered += (value ?? '').replace(/\r\n/g, '\n')

      // Events are separated by a blank line. Anything after the last one is a partial event and
      // stays in the buffer until the rest of it arrives.
      let boundary = buffered.indexOf('\n\n')
      while (boundary !== -1) {
        const block = buffered.slice(0, boundary)
        buffered = buffered.slice(boundary + 2)

        const event = parseEvent(block)
        if (event !== null) onEvent(event)

        boundary = buffered.indexOf('\n\n')
      }
    }
  },

  confirmChat(
    id: string,
    confirmed: boolean,
  ): Promise<{
    confirmation: ChatConfirmationView
    changes: ChatChangeView[]
    failures: string[]
  }> {
    return send('POST', `/api/chat/confirmations/${encodeURIComponent(id)}`, { confirmed })
  },

  undoChatTurn(conversationId: string, messageId: string): Promise<{ changes: ChatChangeView[] }> {
    return send('POST', `/api/chat/conversations/${encodeURIComponent(conversationId)}/undo`, {
      messageId,
    })
  },

  getHealth(): Promise<Health> {
    return request<Health>('/api/health')
  },

  getConfig(): Promise<ClientConfig> {
    return request<ClientConfig>('/api/config')
  },
}
