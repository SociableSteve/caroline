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
