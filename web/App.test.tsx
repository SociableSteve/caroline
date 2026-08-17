/**
 * The shell, against a stubbed API: the surfaces are tested on their own, so what matters here
 * is the plumbing. Routing, the chat rail beside whichever surface is showing, quick capture from
 * anywhere, writes reaching the right route, and the change feed refreshing what is on screen.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { App } from './App.js'
import type { ChatStreamEvent } from './api.js'
import { aProject, aReviewTask, aTask, chatTurnWire, NOW } from './test-fixtures.js'

interface Call {
  readonly method: string
  readonly url: string
  readonly body: unknown
}

const health = {
  status: 'ok',
  version: '1.0.0',
  uptimeSeconds: 3,
  integrations: {
    github: { configured: false, status: 'not configured' },
    google: { configured: false, status: 'not configured' },
    llm: { configured: false, status: 'not configured' },
  },
}

interface StubOptions {
  tasks?: unknown[]
  projects?: unknown[]
  jobRuns?: unknown[]
  jobStatus?: unknown[]
  google?: unknown
  preview?: unknown
  failListing?: boolean
  failWrites?: boolean
  /** Reported by the server as the total, when it is more than the stubbed rows. */
  taskTotal?: number
  /** What a streamed turn reports, in the order the server would send it. */
  chatEvents?: readonly ChatStreamEvent[]
  /** The turns the server has a record of, which is what the read after a turn answers with. */
  chatTranscript?: readonly unknown[]
  /** `GET /api/auth/status`. Defaults to the shape a loopback, no-login install answers with. */
  authStatus?: { authRequired: boolean; hasSession: boolean; providerLabel: string }
  /** What `POST /api/auth/login` answers with, when the test drives it. */
  loginUrl?: string
  failLogin?: boolean
  /** Every write answered 401, as a revoked session would be. */
  unauthorizedWrites?: boolean
}

const noGoogle = {
  connected: false,
  configured: false,
  connectedAt: null,
  scopes: [],
  redirectUri: 'http://127.0.0.1:5123/api/integrations/google/callback',
}

const nothingToPreview = {
  policy: { llmContent: 'snippet', storeContent: 'metadata', snippetChars: 300 },
  item: null,
  payload: null,
}

/** The one conversation the stubbed server has a record of. */
const aConversation = {
  id: 'conversation-1',
  title: 'Triage my inbox',
  createdAt: NOW,
  updatedAt: NOW,
  messageCount: 2,
  inputTokens: 10,
  outputTokens: 4,
}

/** The day the stubbed server thinks it is, for the plan and calendar routes. */
const PLAN_DATE = '2026-06-10'

/** A working day with nothing booked and no calendar connected. */
const emptyCapacity = {
  windowMinutes: 510,
  busyMinutes: 0,
  reserveMinutes: 102,
  capacityMinutes: 408,
  verified: false,
  workingDay: true,
  windowStart: null,
  windowEnd: null,
  busy: [],
  free: [],
}

function stubApi({
  tasks = [],
  projects = [],
  jobRuns = [],
  jobStatus = [],
  google = noGoogle,
  preview = nothingToPreview,
  failListing,
  failWrites,
  taskTotal,
  chatEvents,
  chatTranscript = [],
  authStatus = { authRequired: false, hasSession: false, providerLabel: 'Google' },
  loginUrl = 'https://provider.example/authorize',
  failLogin = false,
  unauthorizedWrites = false,
}: StubOptions = {}) {
  const calls: Call[] = []

  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      calls.push({
        method,
        url,
        body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
      })

      const answer = (body: unknown, status = 200) =>
        ({ ok: status < 400, status, json: async () => body }) as unknown as Response

      // A turn is the one response that is a stream rather than a document, and it is served in the
      // format the server really writes: see `chatTurnWire`.
      if (method === 'POST' && url === '/api/chat' && chatEvents !== undefined) {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(chatTurnWire(chatEvents)))
            controller.close()
          },
        })

        return { ok: true, status: 200, body } as unknown as Response
      }
      if (method === 'POST' && url === '/api/auth/login') {
        return failLogin
          ? answer(
              { error: { code: 'provider_unreachable', message: 'The provider is unreachable' } },
              502,
            )
          : answer({ url: loginUrl })
      }
      if (method === 'POST' && url === '/api/auth/logout') return answer(undefined, 204)
      if (method !== 'GET') {
        if (unauthorizedWrites === true) {
          return answer({ error: { code: 'unauthorized', message: 'Sign in to continue' } }, 401)
        }
        return failWrites === true
          ? answer({ error: { code: 'bad_request', message: 'The server said no' } }, 400)
          : answer({}, 200)
      }
      if (url.startsWith('/api/tasks')) {
        if (failListing === true) {
          return answer({ error: { code: 'internal_error', message: 'Everything is broken' } }, 500)
        }
        const offset = Number(new URL(url, 'http://localhost').searchParams.get('offset') ?? 0)
        const total = taskTotal ?? tasks.length

        // With a total of its own, the stub serves that many rows across as many pages as the
        // client asks for, which is the only way to reach its fetch ceiling. Otherwise the
        // named tasks are the whole list and arrive on the first page.
        if (taskTotal !== undefined) {
          const page = Array.from({ length: Math.max(0, Math.min(500, total - offset)) }, (_, i) =>
            aTask({ id: `generated-${offset + i}`, title: `Generated ${offset + i}` }),
          )
          return answer({ tasks: page, total, limit: 500, offset })
        }

        return answer({ tasks: offset === 0 ? tasks : [], total, limit: 500, offset })
      }
      if (url.startsWith('/api/projects')) return answer({ projects })
      if (url.startsWith('/api/jobs/status')) return answer({ jobs: jobStatus })
      if (url.startsWith('/api/jobs')) return answer({ runs: jobRuns })
      // A server with nothing planned and no calendar connected, which is what these tests are
      // about. Served rather than left unstubbed: a panel whose request fails now says so, and
      // an incomplete harness would put a second alert on the screen in every test.
      if (url.startsWith('/api/plan')) return answer({ date: PLAN_DATE, plan: null, history: [] })
      if (url.startsWith('/api/calendar')) {
        return answer({ date: PLAN_DATE, connected: false, events: [], capacity: emptyCapacity })
      }
      if (url.startsWith('/api/chat/status')) {
        return answer({
          configured: false,
          readOnly: true,
          maxToolCalls: 25,
          bulkConfirmThreshold: 10,
          provider: null,
          model: null,
        })
      }
      // A named conversation is a transcript; the bare route is the list.
      if (url.startsWith('/api/chat/conversations/')) {
        return answer({ conversation: aConversation, messages: chatTranscript })
      }
      if (url.startsWith('/api/chat/conversations')) {
        return answer({ conversations: [aConversation] })
      }
      if (url.startsWith('/api/integrations/google')) return answer(google)
      if (url.startsWith('/api/privacy/preview')) return answer(preview)
      if (url.startsWith('/api/settings')) return answer({ userName: '' })
      if (url.startsWith('/api/health')) return answer(health)
      if (url.startsWith('/api/config')) return answer({ tasks: { waitingStaleDays: 7 } })
      if (url.startsWith('/api/auth/status')) return answer(authStatus)

      throw new Error(`unstubbed request: ${method} ${url}`)
    }),
  )

  return calls
}

/** A stand-in for the browser's change stream, so a published change can be simulated. */
function stubEventSource(): { emit: () => void; closed: () => boolean } {
  const listeners: Array<() => void> = []
  let closed = false

  class FakeEventSource {
    addEventListener(_type: string, listener: () => void) {
      listeners.push(listener)
    }
    close() {
      closed = true
    }
  }

  vi.stubGlobal('EventSource', FakeEventSource)

  return {
    emit: () => listeners.forEach((listener) => listener()),
    closed: () => closed,
  }
}

beforeEach(() => {
  window.location.hash = ''
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('the shell', () => {
  it('lands on the dashboard', async () => {
    stubApi()

    render(<App />)

    expect(await screen.findByRole('region', { name: /where everything is/i })).toBeInTheDocument()
  })

  it('marks the current surface in the navigation', async () => {
    stubApi()

    render(<App />)
    await screen.findByRole('region', { name: /where everything is/i })

    expect(screen.getByRole('link', { name: 'Dashboard' })).toHaveAttribute('aria-current', 'page')
  })

  it('shows the board when the hash asks for it', async () => {
    stubApi({ tasks: [aTask({ id: 'task-1', title: 'Captured' })] })
    window.location.hash = '#/board'

    render(<App />)

    expect(await screen.findByRole('heading', { name: /^Inbox/ })).toBeInTheDocument()
    expect(screen.getByRole('article', { name: 'Captured' })).toBeInTheDocument()
  })

  it('follows a hash change without a reload', async () => {
    stubApi()

    render(<App />)
    await screen.findByRole('region', { name: /where everything is/i })

    window.location.hash = '#/projects'
    window.dispatchEvent(new HashChangeEvent('hashchange'))

    expect(await screen.findByRole('heading', { name: 'Projects' })).toBeInTheDocument()
  })

  it('shows only the drilled-into project’s tasks', async () => {
    stubApi({
      tasks: [
        aTask({ id: 'mine', title: 'In the project', projectId: 'project-1' }),
        aTask({ id: 'other', title: 'Somewhere else' }),
      ],
      projects: [aProject({ id: 'project-1', title: 'Ship it' })],
    })
    window.location.hash = '#/projects/project-1'

    render(<App />)

    expect(await screen.findByRole('article', { name: 'In the project' })).toBeInTheDocument()
    expect(screen.queryByRole('article', { name: 'Somewhere else' })).not.toBeInTheDocument()
  })
})

describe('failures', () => {
  it('reports a failed listing and offers to try again', async () => {
    stubApi({ failListing: true })

    render(<App />)

    expect(await screen.findByRole('alert')).toHaveTextContent('Everything is broken')
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument()
  })

  /**
   * A create that landed is a success even if the refresh after it did not. Reporting the
   * refresh as a failed write would have the form offer a retry of something that already
   * happened, and the retry would create a second one.
   */
  it('counts a create as done when the refresh after it fails', async () => {
    // Writes succeed; the listing that follows does not.
    stubApi({ failListing: true })

    render(<App />)
    await screen.findByRole('button', { name: 'Try again' })
    await userEvent.keyboard('c')
    await userEvent.type(screen.getByLabelText('What is it?'), 'Renew the domain')
    await userEvent.click(screen.getByRole('button', { name: 'Capture' }))

    // Closed, so the capture is not offered for a second attempt.
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    // And the stale screen is still reported, as itself.
    expect(screen.getByRole('alert')).toHaveTextContent('Everything is broken')
  })

  /** A capture whose write is refused keeps the dialog and the typing, and says why. */
  it('keeps the capture dialog open and its text when the write is refused', async () => {
    stubApi({ failWrites: true })

    render(<App />)
    await screen.findByRole('region', { name: /where everything is/i })
    await userEvent.keyboard('c')
    await userEvent.type(screen.getByLabelText('What is it?'), 'Renew the domain')
    await userEvent.click(screen.getByRole('button', { name: 'Capture' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('The server said no')
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(screen.getByLabelText('What is it?')).toHaveValue('Renew the domain')
  })

  it('reports what the server said about a refused write', async () => {
    const calls = stubApi({ tasks: [aTask({ id: 'task-1', title: 'Captured' })], failWrites: true })
    window.location.hash = '#/board'

    render(<App />)
    await userEvent.click(await screen.findByRole('button', { name: 'Complete' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('The server said no')
    expect(calls.some((call) => call.url === '/api/tasks/task-1/complete')).toBe(true)
  })
})

describe('quick capture', () => {
  it('opens from the header button and creates an inbox task', async () => {
    const calls = stubApi()

    render(<App />)
    await screen.findByRole('region', { name: /where everything is/i })
    await userEvent.click(screen.getByRole('button', { name: 'Quick capture' }))
    await userEvent.type(screen.getByLabelText('What is it?'), 'Renew the domain')
    await userEvent.click(screen.getByRole('button', { name: 'Capture' }))

    await waitFor(() =>
      expect(calls).toContainEqual({
        method: 'POST',
        url: '/api/tasks',
        body: { title: 'Renew the domain' },
      }),
    )
  })

  it('opens from anywhere with the c key', async () => {
    stubApi()

    render(<App />)
    await screen.findByRole('region', { name: /where everything is/i })
    await userEvent.keyboard('c')

    expect(screen.getByRole('dialog', { name: 'Quick capture' })).toBeInTheDocument()
  })

  it('takes a c typed into its own field as text, not as a shortcut', async () => {
    stubApi()

    render(<App />)
    await screen.findByRole('region', { name: /where everything is/i })
    await userEvent.keyboard('c')
    await userEvent.type(screen.getByLabelText('What is it?'), 'call the accountant')

    expect(screen.getByLabelText('What is it?')).toHaveValue('call the accountant')
  })

  it('closes on Escape without capturing anything', async () => {
    const calls = stubApi()

    render(<App />)
    await screen.findByRole('region', { name: /where everything is/i })
    await userEvent.keyboard('c')
    await userEvent.type(screen.getByLabelText('What is it?'), 'Never mind{Escape}')

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(calls.filter((call) => call.method === 'POST')).toEqual([])
  })

  it('assigns the captured task to the chosen project', async () => {
    const calls = stubApi({ projects: [aProject({ id: 'project-1', title: 'Ship it' })] })

    render(<App />)
    await screen.findByRole('region', { name: /where everything is/i })
    await userEvent.keyboard('c')
    await userEvent.type(screen.getByLabelText('What is it?'), 'Write the notes')
    await userEvent.selectOptions(screen.getByLabelText('Project'), 'project-1')
    await userEvent.click(screen.getByRole('button', { name: 'Capture' }))

    await waitFor(() =>
      expect(calls).toContainEqual({
        method: 'POST',
        url: '/api/tasks',
        body: { title: 'Write the notes', projectId: 'project-1' },
      }),
    )
  })
})

describe('writes from the board', () => {
  /** Criterion 3: the API attributes this to the user, and the board is how it is asked for. */
  it('patches the status when a card is moved between columns', async () => {
    const calls = stubApi({ tasks: [aTask({ id: 'task-1', title: 'Captured' })] })
    window.location.hash = '#/board'

    render(<App />)
    await userEvent.selectOptions(
      await screen.findByRole('combobox', { name: 'Status of Captured' }),
      'next_action',
    )

    await waitFor(() =>
      expect(calls).toContainEqual({
        method: 'PATCH',
        url: '/api/tasks/task-1',
        body: { status: 'next_action' },
      }),
    )
  })

  it('refetches after a write, so the board shows the result', async () => {
    const calls = stubApi({ tasks: [aTask({ id: 'task-1', title: 'Captured' })] })
    window.location.hash = '#/board'

    render(<App />)
    await userEvent.click(await screen.findByRole('button', { name: 'Complete' }))

    await waitFor(() =>
      expect(
        calls.filter((call) => call.method === 'GET' && call.url.startsWith('/api/tasks')),
      ).toHaveLength(2),
    )
  })

  it('marks a review done from the card, moving it to Waiting for', async () => {
    const calls = stubApi({ tasks: [aReviewTask()] })
    window.location.hash = '#/board'

    render(<App />)
    await userEvent.click(await screen.findByRole('button', { name: 'Mark reviewed' }))

    await waitFor(() =>
      expect(calls).toContainEqual({
        method: 'POST',
        url: '/api/tasks/task-pr/mark-reviewed',
        body: undefined,
      }),
    )
  })

  it('deletes a project from the projects surface', async () => {
    const calls = stubApi({ projects: [aProject({ id: 'project-1', title: 'Ship it' })] })
    window.location.hash = '#/projects'

    render(<App />)
    await userEvent.click(await screen.findByRole('button', { name: 'Delete' }))
    await userEvent.click(screen.getByRole('button', { name: 'Confirm delete' }))

    await waitFor(() =>
      expect(calls).toContainEqual({
        method: 'DELETE',
        url: '/api/projects/project-1',
        body: undefined,
      }),
    )
  })

  /** Spec 06: a manual run is first-class, and takes the same path a scheduled one does. */
  it('triggers a sync from the header and refetches when it finishes', async () => {
    const calls = stubApi()

    render(<App />)
    await userEvent.click(await screen.findByRole('button', { name: 'Sync now' }))

    await waitFor(() =>
      expect(calls).toContainEqual({
        method: 'POST',
        url: '/api/jobs/sync/run',
        body: undefined,
      }),
    )
    await waitFor(() =>
      expect(
        calls.filter((call) => call.method === 'GET' && call.url.startsWith('/api/tasks')),
      ).toHaveLength(2),
    )
  })
})

/**
 * The change feed exists so that a write made elsewhere shows up here. Nothing else writes
 * yet, so what is asserted is the mechanism: a change on the stream refetches.
 */
describe('the change feed', () => {
  it('refetches when the server announces a change', async () => {
    const stream = stubEventSource()
    const calls = stubApi()

    render(<App />)
    await screen.findByRole('region', { name: /where everything is/i })
    const before = calls.filter((call) => call.url.startsWith('/api/tasks')).length

    stream.emit()

    await waitFor(() =>
      expect(calls.filter((call) => call.url.startsWith('/api/tasks')).length).toBeGreaterThan(
        before,
      ),
    )
  })

  it('closes the stream when the app goes away', async () => {
    const stream = stubEventSource()
    stubApi()

    const { unmount } = render(<App />)
    await screen.findByRole('region', { name: /where everything is/i })
    unmount()

    expect(stream.closed()).toBe(true)
  })

  it('works without a change stream at all', async () => {
    vi.stubGlobal('EventSource', undefined)
    stubApi({ tasks: [aTask({ id: 'task-1', title: 'Captured' })] })
    window.location.hash = '#/board'

    render(<App />)

    expect(await screen.findByRole('article', { name: 'Captured' })).toBeInTheDocument()
  })
})

/**
 * The client fetches every task by following the pages, and where it cannot, it says so. A
 * screen quietly showing a subset of the tasks is the failure worth guarding against, since
 * nothing about it looks wrong.
 */
describe('more tasks than the client will fetch', () => {
  // Scoped to the surface: the rail beside it is open by default and says its own read-only state
  // through a status of its own, which is not what these two are about.
  it('says how many it is showing of how many there are', async () => {
    stubApi({ taskTotal: 6000 })

    render(<App />)

    expect(await within(await screen.findByRole('main')).findByRole('status')).toHaveTextContent(
      'Showing 5000 of 6000 tasks',
    )
  })

  it('says nothing when it has them all', async () => {
    stubApi({ tasks: [aTask({ id: 'task-1', title: 'Captured' })] })

    render(<App />)
    await screen.findByRole('region', { name: /where everything is/i })

    expect(within(screen.getByRole('main')).queryByRole('status')).not.toBeInTheDocument()
  })
})

describe('the dashboard through the shell', () => {
  it('shows the integrations the server reported', async () => {
    stubApi()

    render(<App />)
    const panel = await screen.findByRole('region', { name: /integrations/i })

    expect(within(panel).getByText('GitHub')).toBeInTheDocument()
    expect(within(panel).getAllByText('not configured')).toHaveLength(3)
  })
})

describe('the jobs surface through the shell', () => {
  it('shows what the scheduler reported and runs a job on demand', async () => {
    const calls = stubApi({
      jobStatus: [
        {
          job: 'classify',
          cron: '5 * * * *',
          running: false,
          nextRunAt: Date.now() + 300_000,
          lastRun: null,
          consecutiveFailures: 0,
          backoffUntil: null,
        },
      ],
    })
    window.location.hash = '#/jobs'

    render(<App />)
    await userEvent.click(await screen.findByRole('button', { name: 'Run now' }))

    await waitFor(() =>
      expect(calls).toContainEqual({
        method: 'POST',
        url: '/api/jobs/classify/run',
        body: undefined,
      }),
    )
  })
})

describe('settings through the shell', () => {
  /** Spec 09, criterion 9: the preview is fetched for the screen that shows it, and not before. */
  it('reads the connection and the payload preview only when Settings is open', async () => {
    const calls = stubApi()

    render(<App />)
    await screen.findByRole('region', { name: /where everything is/i })
    expect(calls.some((call) => call.url.startsWith('/api/privacy/preview'))).toBe(false)

    window.location.hash = '#/settings'
    window.dispatchEvent(new HashChangeEvent('hashchange'))

    await waitFor(() =>
      expect(calls.some((call) => call.url.startsWith('/api/privacy/preview'))).toBe(true),
    )
    expect(calls.some((call) => call.url.startsWith('/api/integrations/google'))).toBe(true)
  })

  /**
   * Spec 09: the name goes to the model on every call, so saving it re-reads the payload preview.
   * A preview that did not move would no longer be showing what would actually be sent.
   */
  it('saves the name and re-reads what would be sent', async () => {
    const calls = stubApi()
    window.location.hash = '#/settings'

    render(<App />)
    await userEvent.type(await screen.findByLabelText('Your name'), 'Steve')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() =>
      expect(calls).toContainEqual({
        method: 'PATCH',
        url: '/api/settings',
        body: { userName: 'Steve' },
      }),
    )
    await waitFor(() =>
      expect(
        calls.filter((call) => call.url.startsWith('/api/privacy/preview')).length,
      ).toBeGreaterThan(1),
    )
  })

  it('disconnects the account and reads the connection back', async () => {
    const calls = stubApi({
      google: {
        connected: true,
        configured: true,
        connectedAt: Date.now(),
        scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
        redirectUri: 'http://127.0.0.1:5123/api/integrations/google/callback',
      },
    })
    window.location.hash = '#/settings'

    render(<App />)
    await userEvent.click(await screen.findByRole('button', { name: 'Disconnect' }))

    await waitFor(() =>
      expect(calls).toContainEqual({
        method: 'DELETE',
        url: '/api/integrations/google',
        body: undefined,
      }),
    )
  })
})

/**
 * The chat rail. Spec 08: chat is a companion to whichever surface is showing rather than a route,
 * because asking about the board while the board is on screen is the whole point and a route swap
 * takes the board away to do it.
 */
describe('the chat rail', () => {
  it('is not in the navigation, because it is not a surface', async () => {
    stubApi()

    render(<App />)
    await screen.findByRole('region', { name: /where everything is/i })

    const nav = screen.getByRole('navigation', { name: 'Surfaces' })
    expect(within(nav).queryByRole('link', { name: 'Chat' })).not.toBeInTheDocument()
    expect(within(nav).getAllByRole('link')).toHaveLength(5)
  })

  /**
   * Open is the default. Chat is the thing you are meant to be talking to, and a rail you have to
   * open on every surface you land on is one you end up not using.
   */
  it('is open beside the board with nothing in the hash asking for it', async () => {
    stubApi({ tasks: [aTask({ id: 'task-1', title: 'Captured' })] })
    window.location.hash = '#/board'

    render(<App />)

    expect(await screen.findByRole('complementary', { name: 'Chat' })).toBeInTheDocument()
    expect(screen.getByLabelText('Message')).toBeInTheDocument()
    // The point of a rail: the surface it sits beside is still there.
    expect(screen.getByRole('article', { name: 'Captured' })).toBeInTheDocument()
  })

  it('reads what chat needs on load, since the rail is on screen', async () => {
    const calls = stubApi()

    render(<App />)
    await screen.findByRole('complementary', { name: 'Chat' })

    await waitFor(() => {
      expect(calls.some((call) => call.url.startsWith('/api/chat/conversations'))).toBe(true)
      // Both, so the test would notice either read being dropped rather than only the list.
      expect(calls.some((call) => call.url.startsWith('/api/chat/status'))).toBe(true)
    })
  })

  it('reads nothing for chat where the hash says the rail was closed', async () => {
    const calls = stubApi()
    window.location.hash = '#/board?chat=closed'

    render(<App />)
    await screen.findByRole('heading', { name: /^Inbox/ })

    expect(screen.queryByRole('complementary', { name: 'Chat' })).not.toBeInTheDocument()
    expect(calls.some((call) => call.url.startsWith('/api/chat'))).toBe(false)
  })

  /**
   * A companion to whichever surface is showing, so changing surface is not closing it. The two
   * things the hash says about the rail travel with the link rather than being dropped at the door.
   */
  it('keeps the rail and its conversation across a change of surface', async () => {
    stubApi()
    window.location.hash = '#/board?conversation=conversation-1'

    render(<App />)
    await screen.findByRole('complementary', { name: 'Chat' })

    expect(screen.getByRole('link', { name: 'Projects' })).toHaveAttribute(
      'href',
      '#/projects?conversation=conversation-1',
    )

    window.location.hash = '#/projects?conversation=conversation-1'
    window.dispatchEvent(new HashChangeEvent('hashchange'))

    expect(await screen.findByRole('heading', { name: 'Projects' })).toBeInTheDocument()
    expect(screen.getByRole('complementary', { name: 'Chat' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Triage my inbox' })).toBeInTheDocument()
  })

  it('keeps a closed rail closed across a change of surface', async () => {
    stubApi()
    window.location.hash = '#/board?chat=closed'

    render(<App />)
    await screen.findByRole('heading', { name: /^Inbox/ })

    expect(screen.getByRole('link', { name: 'Projects' })).toHaveAttribute(
      'href',
      '#/projects?chat=closed',
    )
  })

  /** A conversation keeps a URL: one you cannot link to is one you cannot come back to. */
  it('opens itself on the conversation the hash names', async () => {
    stubApi()
    window.location.hash = '#/board?conversation=conversation-1'

    render(<App />)

    expect(await screen.findByRole('complementary', { name: 'Chat' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: /^Inbox/ })).toBeInTheDocument()
  })

  /** The rail's openness is in the hash, so a reload comes back to it rather than to a bare board. */
  it('opens itself for a hash that asks for the rail without naming a conversation', async () => {
    stubApi()
    window.location.hash = '#/board?conversation='

    render(<App />)

    expect(await screen.findByRole('complementary', { name: 'Chat' })).toBeInTheDocument()
  })

  it('puts a close in the URL, and an open back to the default of saying nothing', async () => {
    stubApi()
    window.location.hash = '#/board'

    render(<App />)
    await userEvent.click(await screen.findByRole('button', { name: 'Chat' }))

    expect(window.location.hash).toBe('#/board?chat=closed')

    await userEvent.click(screen.getByRole('button', { name: 'Chat' }))

    expect(window.location.hash).toBe('#/board')
  })

  it('closes from its own control, taking the conversation out of the URL with it', async () => {
    stubApi()
    window.location.hash = '#/board?conversation=conversation-1'

    render(<App />)
    await userEvent.click(await screen.findByRole('button', { name: 'Close chat' }))

    expect(screen.queryByRole('complementary', { name: 'Chat' })).not.toBeInTheDocument()
    expect(window.location.hash).toBe('#/board?chat=closed')
  })

  /**
   * Sending a message, end to end against the bytes the server writes. What blanked the page was an
   * event whose payload the client read under a name the server never sent it under, which left an
   * `undefined` in the transcript for the render to walk into.
   */
  it('renders the turn when a message is sent, rather than blanking the page', async () => {
    const user = userEvent.setup()
    const userTurn = {
      id: 'message-1',
      conversationId: 'conversation-1',
      seq: 1,
      role: 'user' as const,
      content: 'What is in my inbox?',
      createdAt: NOW,
      toolCalls: 0,
      toolCallLimitReached: false,
      readOnly: false,
      inputTokens: 0,
      outputTokens: 0,
      stopReason: null,
      error: null,
      changes: [],
      confirmations: [],
      context: null,
    }
    const answered = {
      ...userTurn,
      id: 'message-2',
      seq: 2,
      role: 'assistant' as const,
      content: 'Three things.',
    }

    stubApi({
      chatEvents: [
        { type: 'conversation', conversation: aConversation },
        { type: 'user-message', message: userTurn },
        { type: 'text', text: 'Three things.' },
        { type: 'done', message: answered, conversation: aConversation },
      ] as ChatStreamEvent[],
      // What the server has written down by the time the read that follows the turn asks it, so
      // the assertions are about the turn being rendered rather than about a race with that read.
      chatTranscript: [userTurn, answered],
    })
    window.location.hash = '#/board?conversation=conversation-1'

    render(<App />)
    await screen.findByRole('complementary', { name: 'Chat' })

    await user.type(screen.getByLabelText('Message'), 'What is in my inbox?')
    await user.click(screen.getByRole('button', { name: 'Send' }))

    // Both turns on screen, and the surface beside them still standing.
    expect(await screen.findByText('What is in my inbox?')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByText('Three things.')).toBeInTheDocument())
    expect(screen.getByRole('heading', { name: /^Inbox/ })).toBeInTheDocument()
  })
})

/**
 * The details panel, in the rail, beside whichever surface is showing. Spec 08's selection model: it
 * lives in the hash, opening an item opens the rail, and closing the rail clears both.
 */
describe('the details panel', () => {
  it('opens beside the board when a card’s title is clicked, leaving the board on screen', async () => {
    stubApi({ tasks: [aTask({ id: 'task-1', title: 'Captured' })] })
    window.location.hash = '#/board'

    render(<App />)
    await userEvent.click(await screen.findByRole('button', { name: 'Captured' }))

    expect(await screen.findByRole('region', { name: 'Details of Captured' })).toBeInTheDocument()
    // The point of one rail: the board it was opened from is still there.
    expect(screen.getByRole('article', { name: 'Captured' })).toBeInTheDocument()
    expect(window.location.hash).toContain('item=task')
  })

  /** Criterion 28: a hash naming an item opens the rail on it, so a reload comes back to it. */
  it('opens itself on the item the hash names', async () => {
    stubApi({ tasks: [aTask({ id: 'task-1', title: 'Captured' })] })
    window.location.hash = '#/board?item=task%3Atask-1'

    render(<App />)

    expect(await screen.findByRole('region', { name: 'Details of Captured' })).toBeInTheDocument()
    expect(screen.getByRole('complementary', { name: 'Chat' })).toBeInTheDocument()
  })

  /** Criterion 29: gone is said, not fallen back from. */
  it('says an item that is no longer here is gone', async () => {
    stubApi({ tasks: [aTask({ id: 'task-1', title: 'Captured' })] })
    window.location.hash = '#/board?item=task%3Adeleted'

    render(<App />)

    expect(
      await screen.findByRole('region', { name: 'Details of Not here any more' }),
    ).toBeInTheDocument()
  })

  it('closes the panel on a second click of the same title, and clears the hash', async () => {
    stubApi({ tasks: [aTask({ id: 'task-1', title: 'Captured' })] })
    window.location.hash = '#/board?item=task%3Atask-1'

    render(<App />)
    await userEvent.click(await screen.findByRole('button', { name: 'Captured' }))

    await waitFor(() => expect(window.location.hash).toBe('#/board'))
    expect(screen.queryByRole('region', { name: /^Details of/ })).not.toBeInTheDocument()
  })

  /** Criterion 28: closing the rail takes the item with the conversation. */
  it('is cleared when the rail is closed', async () => {
    stubApi({ tasks: [aTask({ id: 'task-1', title: 'Captured' })] })
    window.location.hash = '#/board?conversation=conversation-1&item=task%3Atask-1'

    render(<App />)
    await userEvent.click(await screen.findByRole('button', { name: 'Close chat' }))

    // The close is what the hash records, the rail being open by default, and it takes the item and
    // the conversation with it.
    expect(window.location.hash).toBe('#/board?chat=closed')
    expect(screen.queryByRole('complementary', { name: 'Chat' })).not.toBeInTheDocument()
  })

  it('opens a project from the projects list', async () => {
    stubApi({ projects: [aProject({ id: 'project-1', title: 'Ship it' })] })
    window.location.hash = '#/projects'

    render(<App />)
    await userEvent.click(await screen.findByRole('button', { name: 'Details' }))

    expect(await screen.findByRole('region', { name: 'Details of Ship it' })).toBeInTheDocument()
  })

  /** Spec 07, rule 1: whatever is open goes with the next message, resolved when it is sent. */
  it('sends the open item with the next message', async () => {
    const calls = stubApi({ tasks: [aTask({ id: 'task-1', title: 'Captured' })] })
    window.location.hash = '#/board?conversation=&item=task%3Atask-1'

    render(<App />)
    await userEvent.type(await screen.findByLabelText('Message'), 'What is this?')
    await userEvent.click(screen.getByRole('button', { name: 'Send' }))

    await waitFor(() => {
      expect(calls.find((call) => call.url === '/api/chat')?.body).toMatchObject({
        message: 'What is this?',
        selected: { kind: 'task', id: 'task-1' },
      })
    })
  })
})

describe('the login screen', () => {
  it('is not shown where a login is not required', async () => {
    stubApi({ authStatus: { authRequired: false, hasSession: false, providerLabel: 'Google' } })

    render(<App />)

    expect(await screen.findByRole('region', { name: /where everything is/i })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /sign in with/i })).not.toBeInTheDocument()
    // Nothing about this is visible on that shape, per spec 13: no sign-out control either.
    expect(screen.queryByRole('button', { name: 'Sign out' })).not.toBeInTheDocument()
  })

  it('is shown instead of a surface where a session is required and this request has none', async () => {
    stubApi({ authStatus: { authRequired: true, hasSession: false, providerLabel: 'Google' } })

    render(<App />)

    expect(await screen.findByRole('button', { name: 'Sign in with Google' })).toBeInTheDocument()
    // Not a surface: nothing that assumes data has loaded is on screen, and the nav's own list of
    // surfaces is untouched.
    expect(screen.queryByRole('region', { name: /where everything is/i })).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Dashboard' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Settings' })).toBeInTheDocument()
  })

  it('renders the surface as usual where a session is required and present', async () => {
    stubApi({ authStatus: { authRequired: true, hasSession: true, providerLabel: 'Google' } })

    render(<App />)

    expect(await screen.findByRole('region', { name: /where everything is/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument()
  })

  it('starts the flow with the hash the person is on, and follows the authorization url', async () => {
    // jsdom's own `location.assign` is neither writable nor configurable, so the whole object is
    // replaced with one that is, keeping every other property `App` reads from it, and restored
    // once the test is done so nothing later in this file navigates against a stand-in.
    const original = Object.getOwnPropertyDescriptor(window, 'location')
    const assign = vi.fn()
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...window.location, assign },
    })

    try {
      const calls = stubApi({
        authStatus: { authRequired: true, hasSession: false, providerLabel: 'Google' },
        loginUrl: 'https://provider.example/authorize?state=abc',
      })
      window.location.hash = '#/board'

      render(<App />)
      await userEvent.click(await screen.findByRole('button', { name: 'Sign in with Google' }))

      await waitFor(() => {
        expect(calls.find((call) => call.url === '/api/auth/login')?.body).toEqual({
          hash: '/board',
        })
      })
      expect(assign).toHaveBeenCalledWith('https://provider.example/authorize?state=abc')
    } finally {
      if (original !== undefined) Object.defineProperty(window, 'location', original)
    }
  })

  it('reports a login that could not be started rather than leaving the button to be pressed blind', async () => {
    stubApi({
      authStatus: { authRequired: true, hasSession: false, providerLabel: 'Google' },
      failLogin: true,
    })

    render(<App />)
    await userEvent.click(await screen.findByRole('button', { name: 'Sign in with Google' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('The provider is unreachable')
  })

  it('signs out and returns to the login screen', async () => {
    const calls = stubApi({
      authStatus: { authRequired: true, hasSession: true, providerLabel: 'Google' },
    })

    render(<App />)
    await userEvent.click(await screen.findByRole('button', { name: 'Sign out' }))

    expect(await screen.findByRole('button', { name: 'Sign in with Google' })).toBeInTheDocument()
    expect(calls.some((call) => call.method === 'POST' && call.url === '/api/auth/logout')).toBe(
      true,
    )
  })

  /**
   * `authenticated` is optimistic until the first status read answers (see the doc comment on
   * `ready` in auth.ts), so nothing below that must not be shown to an unauthenticated visitor,
   * and nothing that fetches data ahead of knowing whether it is allowed to, may render or fire
   * before that first answer lands.
   */
  it('renders only a loading state, and fetches no data, before the status check resolves', async () => {
    let resolveStatus: () => void = () => {}
    const calls: Call[] = []

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        const method = init?.method ?? 'GET'
        calls.push({ method, url, body: undefined })
        const answer = (body: unknown, status = 200) =>
          ({ ok: status < 400, status, json: async () => body }) as unknown as Response

        if (url === '/api/auth/status') {
          return new Promise<Response>((resolve) => {
            resolveStatus = () =>
              resolve(answer({ authRequired: true, hasSession: false, providerLabel: 'Google' }))
          })
        }

        // Nothing else should be asked for while the first status check is still in flight.
        throw new Error(`unexpected request while waiting on the status check: ${method} ${url}`)
      }),
    )

    render(<App />)

    expect(await screen.findByText('Loading.')).toBeInTheDocument()
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /sign in with/i })).not.toBeInTheDocument()
    expect(calls.some((call) => call.url !== '/api/auth/status')).toBe(false)

    resolveStatus()

    expect(await screen.findByRole('button', { name: 'Sign in with Google' })).toBeInTheDocument()
  })

  /** Spec 08, criterion 35: a 401 from any call, not only the initial status check. */
  it('moves to the login state on a 401 from an ordinary write rather than retrying it', async () => {
    stubApi({
      authStatus: { authRequired: true, hasSession: true, providerLabel: 'Google' },
      tasks: [aTask({ id: 'task-1', title: 'Captured' })],
      unauthorizedWrites: true,
    })
    window.location.hash = '#/board'

    render(<App />)
    await userEvent.click(await screen.findByRole('button', { name: 'Complete' }))

    expect(await screen.findByRole('button', { name: 'Sign in with Google' })).toBeInTheDocument()
  })
})
