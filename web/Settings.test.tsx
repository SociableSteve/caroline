/**
 * Settings. Spec 09 criterion 9 is the reason this screen exists: the exact payload a
 * classification call would send, for a real item, under the policy as it stands.
 */
import { describe, expect, it, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { Settings } from './surfaces/Settings.js'
import type { GoogleStatus, Health, PrivacyPreview } from './api.js'
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

function health(overrides: Partial<Health['integrations']> = {}): Health {
  return {
    status: 'ok',
    version: '1.0.0',
    uptimeSeconds: 3,
    integrations: {
      github: { configured: true, status: 'configured' },
      llm: { configured: true, status: 'configured' },
      ...overrides,
    },
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
    promptVersion: '2026-08-11',
    itemContext: {
      kind: 'task' as const,
      id: 'task-1',
      found: true,
      fields: ['kind', 'id', 'title', 'status'],
      contentLevel: 'snippet',
      policyVersion: '2026-08-11',
      rendered: 'The person you are talking to has one item open. {"title": "Hub numbers"}',
    },
    preamble:
      'You are Caroline, one person\'s task assistant. The person you are talking to has this name: "Steve".',
    ...overrides,
  }
}

function renderSettings(overrides: Partial<Parameters<typeof Settings>[0]> = {}) {
  const handlers = {
    onConnectGoogle: vi.fn(),
    onDisconnectGoogle: vi.fn(),
    onRefreshPreview: vi.fn(),
    onSaveUserName: vi.fn(async () => true),
    onRevokeMcpClient: vi.fn(),
    onDecideMcpConsent: vi.fn(),
  }

  render(
    <Settings
      google={google()}
      health={health()}
      preview={preview()}
      userName=""
      googleOutcome={null}
      mcpClients={null}
      mcpConsent={undefined}
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

describe('GitHub and LLM provider', () => {
  it('shows each as configured or not', () => {
    renderSettings({
      health: health({
        github: { configured: true, status: 'configured' },
        llm: { configured: false, status: 'not configured' },
      }),
    })

    const section = panel(/github and llm provider/i)

    expect(within(section).getByText('configured')).toBeInTheDocument()
    expect(within(section).getByText('not configured')).toBeInTheDocument()
  })

  it('waits for the server rather than showing a status it does not have yet', () => {
    renderSettings({ health: null })

    expect(
      within(panel(/github and llm provider/i)).getByText('Waiting for the server.'),
    ).toBeInTheDocument()
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
    expect(within(section).getByText(/Prompt version 2026-08-11/)).toBeInTheDocument()
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
    renderSettings({ preview: null, google: null, health: null })

    // One per panel that has nothing to show yet: the account, GitHub and LLM status, the policy,
    // the preamble, the item context and the payload. Counted rather than named, so a panel added
    // without an empty state is noticed.
    expect(screen.getAllByText('Waiting for the server.')).toHaveLength(6)
  })
})

/**
 * Spec 09: the name is data about a person, it goes to the model on every call, and the payload
 * preview is where what leaves the machine is proved rather than described.
 */
describe('who Caroline is talking to', () => {
  it('shows the name it has, and saves a new one', async () => {
    const handlers = renderSettings({ userName: 'Steve' })

    const section = panel(/who caroline is talking to/i)
    expect(within(section).getByLabelText('Your name')).toHaveValue('Steve')

    await userEvent.clear(within(section).getByLabelText('Your name'))
    await userEvent.type(within(section).getByLabelText('Your name'), 'Ana')
    await userEvent.click(within(section).getByRole('button', { name: 'Save' }))

    expect(handlers.onSaveUserName).toHaveBeenCalledWith('Ana')
  })

  /** Clearing the field is how somebody says they would rather not be addressed by name. */
  it('saves an empty name, and says what that means', async () => {
    const handlers = renderSettings({ userName: 'Steve' })

    const section = panel(/who caroline is talking to/i)
    expect(within(section).getByText(/will not address you by name/i)).toBeInTheDocument()

    await userEvent.clear(within(section).getByLabelText('Your name'))
    await userEvent.click(within(section).getByRole('button', { name: 'Save' }))

    expect(handlers.onSaveUserName).toHaveBeenCalledWith('')
  })

  it('says the name goes to the model, including a remote one', () => {
    renderSettings()

    expect(
      within(panel(/who caroline is talking to/i)).getByText(/remote provider/i),
    ).toBeInTheDocument()
  })

  it('does not claim to have saved a name the server refused', async () => {
    renderSettings({ userName: 'Steve', onSaveUserName: vi.fn(async () => false) })

    await userEvent.click(screen.getByRole('button', { name: 'Save' }))

    expect(screen.queryByText(/^Saved\./)).not.toBeInTheDocument()
  })

  /**
   * Criterion 9 again, for the one thing every call carries. A preview that does not show the name
   * is a preview that no longer proves what it claims to prove.
   */
  it('shows the preamble that will actually be sent, word for word', () => {
    renderSettings()

    const section = panel(/what every chat and planning call says about you/i)

    expect(within(section).getByText(/"Steve"/)).toBeInTheDocument()
  })

  it('says it is waiting rather than showing an empty preamble', () => {
    renderSettings({ preview: null })

    expect(
      within(panel(/what every chat and planning call says about you/i)).getByText(
        'Waiting for the server.',
      ),
    ).toBeInTheDocument()
  })
})

/**
 * Spec 09, criterion 14. The item sent as context is the newest thing leaving the machine, so the
 * screen that claims to show what leaves it has to show that too.
 */
describe('the item context preview', () => {
  it('shows what a message about an open item would send, and at which level', () => {
    renderSettings()

    const section = panel(/what a message about an open item would send/i)

    expect(within(section).getByText(/Fields sent: kind, id, title, status/)).toBeInTheDocument()
    expect(within(section).getByText(/at content level.*snippet/)).toBeInTheDocument()
    expect(within(section).getByText(/"title": "Hub numbers"/)).toBeInTheDocument()
    expect(within(section).getByText(/Content policy version 2026-08-11/)).toBeInTheDocument()
  })

  it('says there is nothing to show where there is no real item', () => {
    renderSettings({ preview: preview({ itemContext: null }) })

    expect(
      within(panel(/what a message about an open item would send/i)).getByText(
        /Nothing is captured yet/,
      ),
    ).toBeInTheDocument()
  })

  /**
   * A preview that has not arrived is not a preview saying nothing is captured. The distinction is the
   * one every other panel on this screen already draws, and getting it wrong tells a person with a
   * task open that they have none.
   */
  it('waits for the server rather than claiming nothing is captured', () => {
    renderSettings({ preview: null })

    const section = panel(/what a message about an open item would send/i)

    expect(within(section).getByText('Waiting for the server.')).toBeInTheDocument()
    expect(within(section).queryByText(/Nothing is captured yet/)).not.toBeInTheDocument()
  })
})

describe('the MCP consent screen', () => {
  it('shows nothing about it when the URL names no pending request', () => {
    renderSettings({ mcpConsent: undefined })

    expect(
      screen.queryByRole('heading', { name: /An assistant is asking to connect/ }),
    ).not.toBeInTheDocument()
  })

  it('names the client asking, and approves or denies on request', async () => {
    const user = userEvent.setup()
    const handlers = renderSettings({
      mcpConsent: {
        requestId: 'req-1',
        clientId: 'https://example.com/client.json',
        clientName: 'Example assistant',
        clientUri: 'https://example.com',
        redirectUri: 'http://127.0.0.1:51820/callback',
      },
    })

    expect(
      screen.getByRole('heading', { name: /An assistant is asking to connect/ }),
    ).toBeInTheDocument()
    expect(screen.getByText(/Example assistant/)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Approve' }))
    expect(handlers.onDecideMcpConsent).toHaveBeenCalledWith(true)

    await user.click(screen.getByRole('button', { name: 'Deny' }))
    expect(handlers.onDecideMcpConsent).toHaveBeenCalledWith(false)
  })

  it('says a request has expired or was already decided, for a request found to be gone', () => {
    renderSettings({ mcpConsent: null })

    expect(screen.getByText(/expired, was already decided, or does not exist/)).toBeInTheDocument()
  })
})

describe('assistants connected over MCP', () => {
  it('shows nothing at all where the list has not been read (mcp.enabled false, or not yet loaded)', () => {
    renderSettings({ mcpClients: null })

    expect(screen.queryByText(/Assistants connected over MCP/)).not.toBeInTheDocument()
  })

  it('says nothing has been approved yet, on an empty list', () => {
    renderSettings({ mcpClients: [] })

    expect(screen.getByText('No assistant has been approved yet.')).toBeInTheDocument()
  })

  it('lists an approved client and revokes it on request', async () => {
    const user = userEvent.setup()
    const handlers = renderSettings({
      mcpClients: [
        {
          clientId: 'https://example.com/client.json',
          clientName: 'Example assistant',
          clientUri: 'https://example.com',
          approvedAt: NOW,
        },
      ],
    })

    expect(screen.getByText('Example assistant')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Revoke' }))
    expect(handlers.onRevokeMcpClient).toHaveBeenCalledWith('https://example.com/client.json')
  })
})
