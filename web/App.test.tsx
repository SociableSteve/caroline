import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { App } from './App.js'

function stubHealth(body: unknown, ok = true) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok, json: async () => body }) as unknown as Response),
  )
}

afterEach(() => {
  vi.unstubAllGlobals()
})

const noIntegrations = {
  status: 'ok',
  version: '1.0.0',
  uptimeSeconds: 3,
  integrations: {
    github: { configured: false, status: 'not configured' },
    google: { configured: false, status: 'not configured' },
    llm: { configured: false, status: 'not configured' },
  },
}

describe('App', () => {
  it('names every integration and its status when nothing is configured', async () => {
    stubHealth(noIntegrations)

    render(<App />)

    expect(await screen.findByText('GitHub')).toBeInTheDocument()
    expect(screen.getByText('Google')).toBeInTheDocument()
    expect(screen.getByText('LLM provider')).toBeInTheDocument()
    expect(screen.getAllByText('not configured')).toHaveLength(3)
  })

  it('shows an empty state rather than an error when nothing is configured', async () => {
    stubHealth(noIntegrations)

    render(<App />)

    expect(await screen.findByRole('heading', { name: /caroline/i })).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('reports the status when an integration is configured', async () => {
    stubHealth({
      ...noIntegrations,
      integrations: {
        ...noIntegrations.integrations,
        github: { configured: true, status: 'configured' },
      },
    })

    render(<App />)

    expect(await screen.findByText('configured')).toBeInTheDocument()
  })

  it('surfaces an alert when the health check cannot be reached', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down')
      }),
    )

    render(<App />)

    expect(await screen.findByRole('alert')).toBeInTheDocument()
  })
})
