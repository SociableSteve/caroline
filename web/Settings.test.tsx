/**
 * Settings. Spec 09 criterion 9 is the reason this screen exists: the exact payload a
 * classification call would send, for a real item, under the policy as it stands.
 */
import { describe, expect, it, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { Settings } from './surfaces/Settings.js'
import type { GoogleStatus, PrivacyPreview } from './api.js'
import { NOW } from './test-fixtures.js'

const REDIRECT = 'http://127.0.0.1:5123/api/integrations/google/callback'

function google(overrides: Partial<GoogleStatus> = {}): GoogleStatus {
  return {
    connected: false,
    configured: true,
    connectedAt: null,
    scopes: [],
    redirectUri: REDIRECT,
    ...overrides,
  }
}

function preview(overrides: Partial<PrivacyPreview> = {}): PrivacyPreview {
  return {
    policy: {
      llmContent: 'snippet',
      storeContent: 'metadata',
      snippetChars: 300,
      llmConsequence: 'The first part of the message body leaves this machine.',
      storeConsequence: 'No message body is kept on disk.',
    },
    item: { taskId: 'task-1', title: 'Hub numbers before Thursday', provider: 'gmail' },
    payload: {
      taskId: 'task-1',
      source: 'gmail',
      from: 'Sam Reed <sam.reed@example.com>',
      snippet: 'Could you take a look at the hub numbers?',
    },
    promptVersion: '2026-08-10',
    ...overrides,
  }
}

function renderSettings(overrides: Partial<Parameters<typeof Settings>[0]> = {}) {
  const handlers = {
    onConnectGoogle: vi.fn(),
    onDisconnectGoogle: vi.fn(),
    onRefreshPreview: vi.fn(),
  }

  render(
    <Settings
      google={google()}
      preview={preview()}
      googleOutcome={null}
      {...handlers}
      {...overrides}
    />,
  )

  return handlers
}

function panel(name: RegExp) {
  return screen.getByRole('region', { name })
}

describe('the Google account', () => {
  it('offers to connect, and says what access it would ask for', () => {
    renderSettings()

    const section = panel(/google account/i)

    expect(within(section).getByText(/read-only access/i)).toBeInTheDocument()
    expect(within(section).getByText(/never writes/i)).toBeInTheDocument()
    expect(within(section).getByRole('button', { name: 'Connect Google' })).toBeInTheDocument()
  })

  it('starts the flow when asked', async () => {
    const handlers = renderSettings()

    await userEvent.click(screen.getByRole('button', { name: 'Connect Google' }))

    expect(handlers.onConnectGoogle).toHaveBeenCalled()
  })

  it('lists the granted scopes once connected, and offers to disconnect', async () => {
    const handlers = renderSettings({
      google: google({
        connected: true,
        connectedAt: NOW,
        scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
      }),
    })

    const section = panel(/google account/i)
    expect(
      within(section).getByText('https://www.googleapis.com/auth/gmail.readonly'),
    ).toBeInTheDocument()

    await userEvent.click(within(section).getByRole('button', { name: 'Disconnect' }))
    expect(handlers.onDisconnectGoogle).toHaveBeenCalled()
  })

  it('says what to configure, and quotes the redirect URI, when nothing is set up', () => {
    renderSettings({ google: google({ configured: false }) })

    const section = panel(/google account/i)

    expect(within(section).getByText(/GOOGLE_CLIENT_SECRET/)).toBeInTheDocument()
    expect(within(section).getByText(REDIRECT)).toBeInTheDocument()
    expect(
      within(section).queryByRole('button', { name: 'Connect Google' }),
    ).not.toBeInTheDocument()
  })

  it('reports how the last attempt went', () => {
    renderSettings({ googleOutcome: 'connected' })

    expect(screen.getByRole('status')).toHaveTextContent('Google is connected.')
  })

  it('reports a refusal as a refusal rather than a failure', () => {
    renderSettings({ googleOutcome: 'refused' })

    expect(screen.getByRole('status')).toHaveTextContent('Google declined')
  })

  /** The outcome comes from a URL, so an unrecognised one is not put on the page. */
  it('does not show back an outcome it does not recognise', () => {
    renderSettings({ googleOutcome: '<script>alert(1)</script>' })

    expect(screen.getByRole('status')).toHaveTextContent('Something happened while connecting')
    expect(screen.getByRole('status').textContent).not.toContain('script')
  })
})

describe('the content policy', () => {
  it('states each level with its consequence in plain language', () => {
    renderSettings()

    const section = panel(/what leaves this machine/i)

    expect(
      within(section).getByText('The first part of the message body leaves this machine.'),
    ).toBeInTheDocument()
    expect(within(section).getByText('No message body is kept on disk.')).toBeInTheDocument()
    expect(within(section).getByText('300 characters')).toBeInTheDocument()
  })

  it('says where to change it', () => {
    renderSettings()

    expect(
      within(panel(/what leaves this machine/i)).getByText('caroline.config.json'),
    ).toBeInTheDocument()
  })
})

describe('the payload preview', () => {
  /** Spec 09, criterion 9. */
  it('shows the whole payload for a real item', () => {
    renderSettings()

    const section = panel(/what a classification call would send/i)

    expect(within(section).getByText(/Hub numbers before Thursday/)).toBeInTheDocument()
    expect(within(section).getByText(/"snippet": "Could you take a look/)).toBeInTheDocument()
    expect(within(section).getByText(/Prompt version 2026-08-10/)).toBeInTheDocument()
  })

  it('says there is nothing to preview on an empty inbox', () => {
    renderSettings({ preview: preview({ item: null, payload: null }) })

    expect(
      within(panel(/what a classification call would send/i)).getByText(/Nothing is in the inbox/),
    ).toBeInTheDocument()
  })

  it('can be refreshed', async () => {
    const handlers = renderSettings()

    await userEvent.click(screen.getByRole('button', { name: 'Refresh' }))

    expect(handlers.onRefreshPreview).toHaveBeenCalled()
  })

  it('waits for the server rather than showing an empty policy', () => {
    renderSettings({ preview: null, google: null })

    expect(screen.getAllByText('Waiting for the server.')).toHaveLength(3)
  })
})
