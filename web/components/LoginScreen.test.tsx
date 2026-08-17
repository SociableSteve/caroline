/**
 * The screen itself, on its own: one button naming the provider, and, only when a login attempt
 * failed, one sentence saying so. Spec 13.
 */
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { LoginScreen } from './LoginScreen.js'

describe('the login screen', () => {
  it('names the configured provider on its one button', () => {
    render(<LoginScreen providerLabel="Google" failure={null} onLogin={vi.fn()} />)

    expect(screen.getByRole('button', { name: /sign in with google/i })).toBeInTheDocument()
  })

  it('says nothing went wrong when nothing has', () => {
    render(<LoginScreen providerLabel="Google" failure={null} onLogin={vi.fn()} />)

    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('reports a failed attempt in words rather than leaving the button to be pressed again blind', () => {
    render(
      <LoginScreen
        providerLabel="Google"
        failure="The provider is unreachable"
        onLogin={vi.fn()}
      />,
    )

    expect(screen.getByRole('alert')).toHaveTextContent('The provider is unreachable')
  })

  it('starts the flow when pressed', async () => {
    const onLogin = vi.fn()
    render(<LoginScreen providerLabel="Google" failure={null} onLogin={onLogin} />)

    await userEvent.click(screen.getByRole('button', { name: /sign in with google/i }))

    expect(onLogin).toHaveBeenCalledTimes(1)
  })
})
