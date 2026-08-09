/**
 * The shell, against a stubbed API: the surfaces are tested on their own, so what matters here
 * is the plumbing. Routing, quick capture from anywhere, writes reaching the right route, and
 * the change feed refreshing what is on screen.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { App } from './App.js'
import { aProject, aTask } from './test-fixtures.js'

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
  failListing?: boolean
  failWrites?: boolean
  /** Reported by the server as the total, when it is more than the stubbed rows. */
  taskTotal?: number
}

function stubApi({
  tasks = [],
  projects = [],
  failListing,
  failWrites,
  taskTotal,
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

      if (method !== 'GET') {
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
      if (url.startsWith('/api/health')) return answer(health)
      if (url.startsWith('/api/config')) return answer({ tasks: { waitingStaleDays: 7 } })

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
  it('says how many it is showing of how many there are', async () => {
    stubApi({ taskTotal: 6000 })

    render(<App />)

    expect(await screen.findByRole('status')).toHaveTextContent('Showing 5000 of 6000 tasks')
  })

  it('says nothing when it has them all', async () => {
    stubApi({ tasks: [aTask({ id: 'task-1', title: 'Captured' })] })

    render(<App />)
    await screen.findByRole('region', { name: /where everything is/i })

    expect(screen.queryByRole('status')).not.toBeInTheDocument()
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
