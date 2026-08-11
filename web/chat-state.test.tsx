/**
 * The chat state, in `chat.ts`. Named apart from `Chat.test.tsx`, which is the surface, because the
 * two would otherwise differ only in the case of one letter.
 *
 * The state: a turn arrives in pieces, and what is on screen while it does has to become what
 * was recorded once it is over. The draft is the only place in the client where a response is
 * assembled, so the thing worth proving is that it is thrown away in favour of the server's record
 * rather than left standing beside it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { useChat } from './chat.js'
import type { ChatStreamEvent } from './api.js'
import { chatTurnWire, NOW } from './test-fixtures.js'

const conversation = {
  id: 'conversation-1',
  title: 'Triage my inbox',
  createdAt: NOW,
  updatedAt: NOW,
  messageCount: 2,
  inputTokens: 10,
  outputTokens: 4,
}

const change = {
  id: 'change-1',
  position: 1,
  tool: 'complete_task',
  summary: 'Completed “Book the venue”',
  entity: 'task' as const,
  entityId: 'task-1',
  createdAt: NOW,
  undoneAt: null,
  undoable: true,
}

function aMessage(overrides: Record<string, unknown> = {}) {
  return {
    id: 'message-2',
    conversationId: 'conversation-1',
    seq: 2,
    role: 'assistant',
    content: 'Recorded answer.',
    createdAt: NOW,
    toolCalls: 1,
    toolCallLimitReached: false,
    readOnly: false,
    inputTokens: 10,
    outputTokens: 4,
    stopReason: 'end_turn',
    error: null,
    changes: [],
    confirmations: [],
    ...overrides,
  }
}

interface StubOptions {
  /** What the streamed turn reports, in order. */
  readonly events?: readonly ChatStreamEvent[]
  readonly failStream?: boolean
}

function stubApi({ events = [], failStream = false }: StubOptions = {}) {
  const calls: Array<{ url: string; body: unknown }> = []

  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const body = init?.body === undefined ? undefined : JSON.parse(String(init.body))
      calls.push({ url, body })

      const answer = (payload: unknown) =>
        ({ ok: true, status: 200, json: async () => payload }) as unknown as Response

      if (url === '/api/chat') {
        if (failStream) {
          return {
            ok: false,
            status: 500,
            json: async () => ({ error: { code: 'internal_error', message: 'it broke' } }),
          } as unknown as Response
        }

        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(chatTurnWire(events)))
            controller.close()
          },
        })

        return { ok: true, status: 200, body: stream } as unknown as Response
      }

      if (url === '/api/chat/conversations') return answer({ conversations: [conversation] })
      if (url.startsWith('/api/chat/conversations/') && url.endsWith('/undo')) {
        return answer({ changes: [{ ...change, undoneAt: NOW }] })
      }
      if (url.startsWith('/api/chat/conversations/')) {
        return answer({ conversation, messages: [aMessage({ id: 'message-1', role: 'user' })] })
      }
      if (url.startsWith('/api/chat/confirmations/')) {
        return answer({ confirmation: {}, changes: [change], failures: [] })
      }

      return answer({
        configured: true,
        readOnly: false,
        maxToolCalls: 25,
        bulkConfirmThreshold: 10,
      })
    }),
  )

  return { calls }
}

interface ProbeOptions {
  readonly conversationId?: string | null
  readonly onDataChanged?: () => void
  readonly onConversationStarted?: (id: string) => void
}

function Probe({
  conversationId = null,
  onDataChanged = () => {},
  onConversationStarted = () => {},
}: ProbeOptions) {
  const chat = useChat({ conversationId, active: true, onDataChanged, onConversationStarted })

  return (
    <>
      <p data-testid="draft">{chat.draft === null ? 'none' : chat.draft.text}</p>
      <p data-testid="messages">{chat.messages.map((message) => message.content).join(' | ')}</p>
      <p data-testid="changes">
        {chat.draft?.changes.map((entry) => entry.summary).join(', ') ?? ''}
      </p>
      <p data-testid="failure">{chat.failure ?? ''}</p>
      <p data-testid="status">{chat.status === null ? 'unknown' : String(chat.status.readOnly)}</p>
      <button type="button" onClick={() => chat.send('Triage my inbox')}>
        Send
      </button>
      <button type="button" onClick={() => chat.confirm('confirmation-1', true)}>
        Confirm
      </button>
      <button type="button" onClick={() => chat.undo('message-2')}>
        Undo
      </button>
    </>
  )
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('useChat', () => {
  it('reads the conversation list and the status when the surface opens', async () => {
    const { calls } = stubApi()

    render(<Probe />)

    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('false'))
    expect(calls.map((call) => call.url)).toContain('/api/chat/conversations')
  })

  it('reads the transcript of the conversation the route is on', async () => {
    stubApi()

    render(<Probe conversationId="conversation-1" />)

    await waitFor(() =>
      expect(screen.getByTestId('messages')).toHaveTextContent('Recorded answer.'),
    )
  })

  it('appends the text of a turn as it arrives', async () => {
    const user = userEvent.setup()
    stubApi({
      events: [
        { type: 'text', text: 'Your inbox ' },
        { type: 'text', text: 'has three things.' },
      ] as ChatStreamEvent[],
    })
    render(<Probe />)

    await user.click(screen.getByRole('button', { name: 'Send' }))

    await waitFor(() =>
      expect(screen.getByTestId('draft')).toHaveTextContent('Your inbox has three things.'),
    )
  })

  it('replaces the draft with the recorded turn when it is done', async () => {
    const user = userEvent.setup()
    stubApi({
      events: [
        { type: 'text', text: 'Streamed text' },
        { type: 'done', message: aMessage(), conversation },
      ] as unknown as ChatStreamEvent[],
    })
    render(<Probe conversationId="conversation-1" />)

    await user.click(screen.getByRole('button', { name: 'Send' }))

    await waitFor(() => expect(screen.getByTestId('draft')).toHaveTextContent('none'))
    expect(screen.getByTestId('messages')).toHaveTextContent('Recorded answer.')
  })

  /**
   * The user's own turn arrives as an event of its own, and what the server sends is the message
   * itself rather than a wrapper around it. Reading it as a bag of fields left `undefined` in the
   * transcript, and rendering that is what blanked the page on send.
   */
  it('appends the user message the server recorded for the turn', async () => {
    const user = userEvent.setup()
    stubApi({
      events: [
        { type: 'conversation', conversation },
        {
          type: 'user-message',
          message: aMessage({ id: 'message-2', role: 'user', content: 'Triage my inbox' }),
        },
        { type: 'text', text: 'Three things.' },
      ] as unknown as ChatStreamEvent[],
    })
    // A turn in a conversation that did not exist yet, which is the first thing anybody does: the
    // route change owns the read that follows, so what the stream said is still on screen.
    render(<Probe />)

    await user.click(screen.getByRole('button', { name: 'Send' }))

    await waitFor(() => expect(screen.getByTestId('messages')).toHaveTextContent('Triage my inbox'))
  })

  it('shows what the turn changed while it is still running', async () => {
    const user = userEvent.setup()
    stubApi({ events: [{ type: 'change', change }] as ChatStreamEvent[] })
    render(<Probe />)

    await user.click(screen.getByRole('button', { name: 'Send' }))

    await waitFor(() =>
      expect(screen.getByTestId('changes')).toHaveTextContent('Completed “Book the venue”'),
    )
  })

  /** Spec 08, criterion 5: a change from chat reaches the board without a refresh. */
  it('tells the rest of the UI to reload when a turn changed something', async () => {
    const user = userEvent.setup()
    const onDataChanged = vi.fn()
    stubApi({ events: [{ type: 'change', change }] as ChatStreamEvent[] })
    render(<Probe onDataChanged={onDataChanged} />)

    await user.click(screen.getByRole('button', { name: 'Send' }))

    await waitFor(() => expect(onDataChanged).toHaveBeenCalled())
  })

  it('says nothing to the rest of the UI when the turn only talked', async () => {
    const user = userEvent.setup()
    const onDataChanged = vi.fn()
    stubApi({ events: [{ type: 'text', text: 'Three.' }] as ChatStreamEvent[] })
    render(<Probe onDataChanged={onDataChanged} />)

    await user.click(screen.getByRole('button', { name: 'Send' }))

    await waitFor(() => expect(screen.getByTestId('draft')).toHaveTextContent('Three.'))
    expect(onDataChanged).not.toHaveBeenCalled()
  })

  /** A new conversation has to become the route, or the next turn would start another one. */
  it('reports the conversation a first turn created', async () => {
    const user = userEvent.setup()
    const onConversationStarted = vi.fn()
    stubApi({ events: [{ type: 'conversation', conversation }] as ChatStreamEvent[] })
    render(<Probe onConversationStarted={onConversationStarted} />)

    await user.click(screen.getByRole('button', { name: 'Send' }))

    await waitFor(() => expect(onConversationStarted).toHaveBeenCalledWith('conversation-1'))
  })

  /**
   * The refresh that follows a turn is bound to the conversation the surface was opened with. For a
   * turn that created one, that is no conversation at all, so refreshing from here would answer with
   * an empty transcript and blank the turn that just finished. The route change owns that read.
   */
  it('does not blank the finished turn when it created the conversation', async () => {
    const user = userEvent.setup()
    const { calls } = stubApi({
      events: [
        { type: 'conversation', conversation },
        { type: 'text', text: 'Streamed text' },
        { type: 'done', message: aMessage(), conversation },
      ] as unknown as ChatStreamEvent[],
    })
    render(<Probe />)

    await user.click(screen.getByRole('button', { name: 'Send' }))

    await waitFor(() => expect(screen.getByTestId('draft')).toHaveTextContent('none'))
    expect(screen.getByTestId('messages')).toHaveTextContent('Recorded answer.')
    // No transcript read from this closure: it would have been for the conversation that did not
    // exist when the turn started.
    expect(calls.filter((call) => call.url === '/api/chat/conversations/conversation-1')).toEqual(
      [],
    )
  })

  it('reports a turn that could not be started', async () => {
    const user = userEvent.setup()
    stubApi({ failStream: true })
    render(<Probe />)

    await user.click(screen.getByRole('button', { name: 'Send' }))

    await waitFor(() => expect(screen.getByTestId('failure')).toHaveTextContent('it broke'))
  })

  it('confirms through the route and reloads afterwards', async () => {
    const user = userEvent.setup()
    const onDataChanged = vi.fn()
    const { calls } = stubApi()
    render(<Probe conversationId="conversation-1" onDataChanged={onDataChanged} />)

    await user.click(screen.getByRole('button', { name: 'Confirm' }))

    await waitFor(() => expect(onDataChanged).toHaveBeenCalled())
    expect(
      calls.find((call) => call.url === '/api/chat/confirmations/confirmation-1'),
    ).toMatchObject({ body: { confirmed: true } })
  })

  it('undoes a turn through the route, naming the turn', async () => {
    const user = userEvent.setup()
    const { calls } = stubApi()
    render(<Probe conversationId="conversation-1" />)

    await user.click(screen.getByRole('button', { name: 'Undo' }))

    await waitFor(() =>
      expect(
        calls.find((call) => call.url === '/api/chat/conversations/conversation-1/undo'),
      ).toMatchObject({ body: { messageId: 'message-2' } }),
    )
  })

  it('cannot undo when no conversation is open, since there is nothing to undo in', async () => {
    const user = userEvent.setup()
    const { calls } = stubApi()
    render(<Probe />)

    await user.click(screen.getByRole('button', { name: 'Undo' }))

    expect(calls.some((call) => call.url.endsWith('/undo'))).toBe(false)
  })
})
