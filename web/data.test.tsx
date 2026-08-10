/**
 * The data layer's ordering guarantee. Mounting, the change feed and every write can each set
 * a reload going, so more than one can be in flight at once. Without a generation guard an
 * older response finishing last puts stale tasks back on the screen, and nothing looks wrong
 * until the next reload happens to fix it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { useCarolineData } from './data.js'
import { aTask } from './test-fixtures.js'

/** Hands out a deferred response per task request, so the test controls what lands when. */
function deferredTaskFetch() {
  const pending: Array<(tasks: unknown[]) => void> = []

  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const answer = (body: unknown) =>
        ({ ok: true, status: 200, json: async () => body }) as unknown as Response

      if (url.startsWith('/api/tasks')) {
        return new Promise<Response>((resolve) => {
          pending.push((tasks) =>
            resolve(answer({ tasks, total: tasks.length, limit: 500, offset: 0 })),
          )
        })
      }
      if (url.startsWith('/api/projects')) return answer({ projects: [] })
      if (url.startsWith('/api/health')) return answer({ integrations: {} })

      return answer({ tasks: { waitingStaleDays: 7 } })
    }),
  )

  return {
    /** Resolves the nth outstanding task request, oldest first from zero. */
    settle: (index: number, tasks: unknown[]) => pending[index]?.(tasks),
    count: () => pending.length,
  }
}

function Probe() {
  const { tasks, reload, loading } = useCarolineData()

  return (
    <>
      <p data-testid="titles">{tasks.map((task) => task.title).join(', ')}</p>
      <p data-testid="loading">{loading ? 'loading' : 'ready'}</p>
      <button type="button" onClick={() => void reload()}>
        Reload
      </button>
    </>
  )
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('overlapping reloads', () => {
  it('keeps the newest result when an older reload finishes last', async () => {
    const fetches = deferredTaskFetch()
    render(<Probe />)
    await waitFor(() => expect(fetches.count()).toBe(1))

    // A second reload starts while the first is still out.
    screen.getByRole('button', { name: 'Reload' }).click()
    await waitFor(() => expect(fetches.count()).toBe(2))

    // The newer one lands first, then the older one arrives with what is now stale.
    fetches.settle(1, [aTask({ id: 'new', title: 'Current' })])
    await waitFor(() => expect(screen.getByTestId('titles')).toHaveTextContent('Current'))

    fetches.settle(0, [aTask({ id: 'old', title: 'Stale' })])

    await waitFor(() => expect(screen.getByTestId('loading')).toHaveTextContent('ready'))
    expect(screen.getByTestId('titles')).toHaveTextContent('Current')
    expect(screen.getByTestId('titles')).not.toHaveTextContent('Stale')
  })

  it('stops loading once any reload has answered', async () => {
    const fetches = deferredTaskFetch()
    render(<Probe />)
    await waitFor(() => expect(fetches.count()).toBe(1))

    fetches.settle(0, [])

    await waitFor(() => expect(screen.getByTestId('loading')).toHaveTextContent('ready'))
  })
})

/**
 * The plan and the calendar are asked for independently, so a reload can straddle the server's
 * midnight and get two different days back. A capacity bar comparing one day's plan against
 * another day's calendar is silently wrong, which is worse than a panel that is one beat late.
 */
function PlanProbe() {
  const { plan, calendar, planDate, failure } = useCarolineData()

  return (
    <>
      <p data-testid="plan-date">{planDate ?? 'none'}</p>
      <p data-testid="plan-summary">{plan?.summary ?? 'no plan'}</p>
      <p data-testid="calendar-date">{calendar?.date ?? 'no calendar'}</p>
      <p data-testid="failure">{failure ?? 'no failure'}</p>
    </>
  )
}

interface DayStubOptions {
  readonly planDate: string
  /** What the unqualified `/api/calendar` answers, which may be a different day. */
  readonly calendarDate: string
  /** Which routes should refuse, so a panel failure can be told from an empty answer. */
  readonly failing?: readonly string[]
}

/** Serves a plan and a calendar, recording every calendar URL asked for. */
function stubDay({ planDate, calendarDate, failing = [] }: DayStubOptions) {
  const calendarUrls: string[] = []
  const refuses = (url: string) => failing.some((prefix) => url.startsWith(prefix))

  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const answer = (body: unknown) =>
        ({ ok: true, status: 200, json: async () => body }) as unknown as Response

      // Recorded before anything can return, so a refused request is still a request that was
      // made. A test asserting on what was asked for wants the whole list, not the part of it
      // that happened to succeed.
      if (url.startsWith('/api/calendar')) calendarUrls.push(url)

      if (refuses(url)) {
        return {
          ok: false,
          status: 503,
          json: async () => ({ error: { code: 'unavailable', message: 'the server is down' } }),
        } as unknown as Response
      }

      if (url.startsWith('/api/tasks')) {
        return answer({ tasks: [], total: 0, limit: 500, offset: 0 })
      }
      if (url.startsWith('/api/projects')) return answer({ projects: [] })
      if (url.startsWith('/api/health')) return answer({ integrations: {} })

      if (url.startsWith('/api/plan')) {
        return answer({ date: planDate, plan: { summary: `plan for ${planDate}` }, history: [] })
      }

      if (url.startsWith('/api/calendar')) {
        // A qualified request answers for the date it was asked about; the bare one answers
        // with whatever the server thinks today is, which is the case under test.
        const asked = new URL(url, 'http://localhost').searchParams.get('date')
        return answer({ date: asked ?? calendarDate, connected: true, events: [], capacity: {} })
      }

      return answer({ tasks: { waitingStaleDays: 7 } })
    }),
  )

  return { calendarUrls }
}

describe('the plan and the calendar describing one day', () => {
  it('re-reads the calendar for the plan’s date when the two disagree', async () => {
    const { calendarUrls } = stubDay({ planDate: '2026-06-08', calendarDate: '2026-06-09' })
    render(<PlanProbe />)

    await waitFor(() => expect(screen.getByTestId('calendar-date')).toHaveTextContent('2026-06-08'))
    expect(calendarUrls.some((url) => url.includes('date=2026-06-08'))).toBe(true)
  })

  it('asks only once when they already agree', async () => {
    const { calendarUrls } = stubDay({ planDate: '2026-06-08', calendarDate: '2026-06-08' })
    render(<PlanProbe />)

    await waitFor(() => expect(screen.getByTestId('plan-date')).toHaveTextContent('2026-06-08'))
    expect(calendarUrls).toHaveLength(1)
  })
})

/**
 * A panel that could not be read keeps what it last showed, so the rest of the screen stays
 * usable. It must also say so: quietly keeping stale data is how a dashboard comes to be
 * trusted while being wrong, and it is worse than the empty state it replaced.
 */
describe('a panel whose request failed', () => {
  it('says which panel could not be read', async () => {
    stubDay({ planDate: '2026-06-08', calendarDate: '2026-06-08', failing: ['/api/plan'] })
    render(<PlanProbe />)

    await waitFor(() => expect(screen.getByTestId('failure')).toHaveTextContent(/today's plan/i))
  })

  it('does not report a failure when every panel answered', async () => {
    stubDay({ planDate: '2026-06-08', calendarDate: '2026-06-08' })
    render(<PlanProbe />)

    await waitFor(() => expect(screen.getByTestId('plan-date')).toHaveTextContent('2026-06-08'))
    expect(screen.getByTestId('failure')).toHaveTextContent('no failure')
  })

  it('does not blank the panel it could not read', async () => {
    const { calendarUrls } = stubDay({
      planDate: '2026-06-08',
      calendarDate: '2026-06-08',
      failing: ['/api/calendar'],
    })
    render(<PlanProbe />)

    // The plan still landed, so the screen is useful; the calendar simply has nothing yet.
    await waitFor(() => expect(screen.getByTestId('plan-summary')).toHaveTextContent('plan for'))
    expect(screen.getByTestId('failure')).toHaveTextContent(/calendar/i)
    // Asked for once and refused, rather than not asked for: the reload must not skip a panel
    // just because the previous attempt failed.
    expect(calendarUrls).toHaveLength(1)
  })
})
