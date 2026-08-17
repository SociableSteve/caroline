/**
 * `useAuthGate` on its own: whether `ready` actually reflects the first status read having
 * answered, and that `logout()` handles its own failure the way its sibling `login()` does.
 * The shell's use of `ready` to gate rendering is covered in App.test.tsx; this is the hook
 * itself.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { useAuthGate } from './auth.js'

/** `GET /api/auth/status` answers once a login is required and a session is present, so
 * `logout()` has something to call; `POST /api/auth/logout` answers with `logoutStatus`. */
function stubAuth(logoutStatus: number) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      const answer = (body: unknown, status = 200) =>
        ({ ok: status < 400, status, json: async () => body }) as unknown as Response

      if (url === '/api/auth/status') {
        return answer({ authRequired: true, hasSession: true, providerLabel: 'Google' })
      }
      if (method === 'POST' && url === '/api/auth/logout') {
        return logoutStatus < 400
          ? answer(undefined, 204)
          : answer(
              { error: { code: 'internal_error', message: 'Something went wrong' } },
              logoutStatus,
            )
      }

      throw new Error(`unstubbed request: ${method} ${url}`)
    }),
  )
}

function Probe() {
  const auth = useAuthGate()

  return (
    <>
      <p data-testid="ready">{auth.ready ? 'ready' : 'waiting'}</p>
      <button type="button" onClick={() => void auth.logout()}>
        Sign out
      </button>
    </>
  )
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('useAuthGate', () => {
  it('answers ready only once the first status check has resolved', async () => {
    stubAuth(204)

    render(<Probe />)

    expect(screen.getByTestId('ready')).toHaveTextContent('waiting')
    await waitFor(() => expect(screen.getByTestId('ready')).toHaveTextContent('ready'))
  })

  /**
   * `login()` catches its own failure and reports it as `failure`. `logout()` has nothing
   * equivalent to report (there is no screen left showing to say it on), but a rejected
   * `api.logout()` still must not become an unhandled promise rejection.
   */
  it('does not leave an unhandled rejection when the server call fails', async () => {
    stubAuth(500)
    const unhandled: unknown[] = []
    const onUnhandledRejection = (reason: unknown) => unhandled.push(reason)
    process.on('unhandledRejection', onUnhandledRejection)

    try {
      render(<Probe />)
      await waitFor(() => expect(screen.getByTestId('ready')).toHaveTextContent('ready'))

      await userEvent.click(screen.getByRole('button', { name: 'Sign out' }))

      // Gives a rejection that escaped the hook a turn to surface before asserting none did.
      await new Promise((resolve) => setImmediate(resolve))

      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandledRejection)
    }
  })
})
