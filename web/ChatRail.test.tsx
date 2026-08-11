/**
 * The chat rail. Spec 08 asks for a transcript, streamed responses, inline records of what changed
 * with undo, and confirmation prompts for deletes and bulk operations. What matters here is that each
 * of those is on the screen and says what it is, including the two things a person would otherwise
 * have to guess at: that chat is read-only, and that a turn stopped early.
 *
 * It is a rail rather than a surface, so it carries no `h1` and its conversation links keep whichever
 * surface it is open beside.
 */
import { describe, expect, it, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { ChatRail } from './components/ChatRail.js'
import type {
  ChatChangeView,
  ChatConfirmationView,
  ChatMessageView,
  ChatStatus,
  ConversationView,
} from './api.js'
import type { DraftTurn } from './chat.js'
import { NOW } from './test-fixtures.js'

function aStatus(overrides: Partial<ChatStatus> = {}): ChatStatus {
  return {
    configured: true,
    readOnly: false,
    maxToolCalls: 25,
    bulkConfirmThreshold: 10,
    provider: 'ollama',
    model: 'a-model',
    ...overrides,
  }
}

function aConversation(overrides: Partial<ConversationView> = {}): ConversationView {
  return {
    id: 'conversation-1',
    title: 'Triage my inbox',
    createdAt: NOW - 60_000,
    updatedAt: NOW - 60_000,
    messageCount: 2,
    inputTokens: 900,
    outputTokens: 100,
    ...overrides,
  }
}

function aChange(overrides: Partial<ChatChangeView> = {}): ChatChangeView {
  return {
    id: 'change-1',
    position: 1,
    tool: 'complete_task',
    summary: 'Completed “Book the venue”',
    entity: 'task',
    entityId: 'task-1',
    createdAt: NOW,
    undoneAt: null,
    undoable: true,
    ...overrides,
  }
}

function aConfirmation(overrides: Partial<ChatConfirmationView> = {}): ChatConfirmationView {
  return {
    id: 'confirmation-1',
    reason: 'delete',
    tool: 'delete_task',
    affectedCount: 1,
    summary: 'Delete “Book the venue”',
    createdAt: NOW,
    decidedAt: null,
    decision: null,
    ...overrides,
  }
}

function aMessage(overrides: Partial<ChatMessageView> & { id: string }): ChatMessageView {
  return {
    conversationId: 'conversation-1',
    seq: 1,
    role: 'assistant',
    content: 'Answered.',
    createdAt: NOW,
    toolCalls: 0,
    toolCallLimitReached: false,
    readOnly: false,
    inputTokens: 0,
    outputTokens: 0,
    stopReason: 'end_turn',
    error: null,
    changes: [],
    confirmations: [],
    ...overrides,
  }
}

interface Handlers {
  onSend: ReturnType<typeof vi.fn>
  onConfirm: ReturnType<typeof vi.fn>
  onUndo: ReturnType<typeof vi.fn>
  onClose: ReturnType<typeof vi.fn>
}

function draw(
  overrides: {
    status?: ChatStatus | null
    conversations?: readonly ConversationView[]
    conversation?: ConversationView | null
    messages?: readonly ChatMessageView[]
    draft?: DraftTurn | null
    sending?: boolean
    failure?: string | null
    hash?: string
  } = {},
): Handlers {
  const handlers: Handlers = {
    onSend: vi.fn(),
    onConfirm: vi.fn(),
    onUndo: vi.fn(),
    onClose: vi.fn(),
  }

  render(
    <ChatRail
      status={overrides.status === undefined ? aStatus() : overrides.status}
      conversations={overrides.conversations ?? []}
      conversation={overrides.conversation === undefined ? aConversation() : overrides.conversation}
      messages={overrides.messages ?? []}
      draft={overrides.draft ?? null}
      sending={overrides.sending ?? false}
      failure={overrides.failure ?? null}
      now={NOW}
      hash={overrides.hash ?? '#/board'}
      {...handlers}
    />,
  )

  return handlers
}

describe('the chat rail', () => {
  it('invites a first message when there is nothing to show', () => {
    draw({ conversation: null })

    expect(screen.getByText(/Ask about the inbox/)).toBeInTheDocument()
  })

  it('renders the transcript, saying who said what', () => {
    draw({
      messages: [
        aMessage({ id: 'message-1', role: 'user', content: 'What is in my inbox?' }),
        aMessage({ id: 'message-2', content: 'Three things.', seq: 2 }),
      ],
    })

    const turns = screen.getAllByRole('listitem')
    expect(within(turns[0] as HTMLElement).getByText('You')).toBeInTheDocument()
    expect(within(turns[0] as HTMLElement).getByText('What is in my inbox?')).toBeInTheDocument()
    expect(within(turns[1] as HTMLElement).getByText('Caroline')).toBeInTheDocument()
  })

  it('sends what was typed, and clears the box', async () => {
    const user = userEvent.setup()
    const { onSend } = draw()

    await user.type(screen.getByLabelText('Message'), 'Triage my inbox')
    await user.click(screen.getByRole('button', { name: 'Send' }))

    expect(onSend).toHaveBeenCalledWith('Triage my inbox')
    expect(screen.getByLabelText('Message')).toHaveValue('')
  })

  it('sends on enter, and leaves shift and enter to make a new line', async () => {
    const user = userEvent.setup()
    const { onSend } = draw()

    await user.type(screen.getByLabelText('Message'), 'One{Shift>}{Enter}{/Shift}Two')
    expect(onSend).not.toHaveBeenCalled()

    await user.type(screen.getByLabelText('Message'), '{Enter}')
    expect(onSend).toHaveBeenCalledWith('One\nTwo')
  })

  it('will not send an empty message', () => {
    draw()

    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled()
  })

  it('says it is answering while a turn is in flight', () => {
    draw({
      sending: true,
      draft: {
        messageId: 'message-2',
        text: '',
        readOnly: false,
        changes: [],
        confirmations: [],
        tools: [],
        error: null,
      },
    })

    expect(screen.getByRole('button', { name: 'Answering' })).toBeDisabled()
    expect(screen.getByText('Thinking.')).toBeInTheDocument()
  })

  it('shows the text of a turn as it arrives', () => {
    draw({
      sending: true,
      draft: {
        messageId: 'message-2',
        text: 'Your inbox has',
        readOnly: false,
        changes: [],
        confirmations: [],
        tools: ['search_tasks'],
        error: null,
      },
    })

    expect(screen.getByText('Your inbox has')).toBeInTheDocument()
    expect(screen.getByText(/Looked at: search_tasks/)).toBeInTheDocument()
  })

  /** The surface is kept: a conversation opened while reading the board is still about the board. */
  it('lists the conversations, keeping the surface it is open beside', () => {
    draw({
      hash: '#/board',
      conversations: [aConversation(), aConversation({ id: 'conversation-2', title: 'Chase Ana' })],
    })

    // Still open: starting a new conversation is not closing the rail that would hold it.
    expect(screen.getByRole('link', { name: 'New conversation' })).toHaveAttribute(
      'href',
      '#/board?conversation=',
    )
    expect(screen.getByRole('link', { name: 'Chase Ana' })).toHaveAttribute(
      'href',
      '#/board?conversation=conversation-2',
    )
  })

  /** The surface it sits beside owns the one `h1` on the page. Spec 10, criterion 5. */
  it('carries no h1 of its own, because it is not a surface', () => {
    draw()

    expect(screen.queryByRole('heading', { level: 1 })).not.toBeInTheDocument()
  })

  it('can be closed, since it takes width from the surface beside it', async () => {
    const user = userEvent.setup()
    const { onClose } = draw()

    await user.click(screen.getByRole('button', { name: 'Close chat' }))

    expect(onClose).toHaveBeenCalled()
  })

  it('marks the conversation being read as the current page', () => {
    draw({ conversations: [aConversation()] })

    expect(screen.getByRole('link', { name: 'Triage my inbox' })).toHaveAttribute(
      'aria-current',
      'page',
    )
  })

  it('shows what a conversation has cost', () => {
    draw()

    expect(screen.getByText(/1000 tokens in this conversation/)).toBeInTheDocument()
  })
})

describe('what a turn changed', () => {
  it('is listed inline, with an undo control', async () => {
    const user = userEvent.setup()
    const { onUndo } = draw({
      messages: [aMessage({ id: 'message-1', changes: [aChange()] })],
    })

    expect(screen.getByText('Completed “Book the venue”')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Undo the changes this turn made' }))

    expect(onUndo).toHaveBeenCalledWith('message-1')
  })

  /** Spec 07 offers undo for the last batch, so an earlier turn does not carry the control. */
  it('offers undo on the last turn that changed something and no earlier one', () => {
    draw({
      messages: [
        aMessage({ id: 'message-1', changes: [aChange()] }),
        aMessage({
          id: 'message-2',
          seq: 2,
          changes: [aChange({ id: 'change-2', summary: 'Created “Draft the agenda” in inbox' })],
        }),
      ],
    })

    const controls = screen.getAllByRole('button', { name: 'Undo the changes this turn made' })
    expect(controls).toHaveLength(1)
    // Named rather than counted: one control in the wrong place would pass a count on its own.
    const turn = controls[0]?.closest('li') as HTMLElement
    expect(within(turn).getByText('Created “Draft the agenda” in inbox')).toBeInTheDocument()
  })

  /** The record is that it happened and was put back, so it stays on the screen, struck through. */
  it('stays visible once it has been undone, marked as undone', () => {
    draw({
      messages: [aMessage({ id: 'message-1', changes: [aChange({ undoneAt: NOW })] })],
    })

    expect(screen.getByText('Completed “Book the venue”')).toBeInTheDocument()
    expect(screen.getByText('undone')).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Undo the changes this turn made' }),
    ).not.toBeInTheDocument()
  })

  it('offers no undo for a change that cannot be put back', () => {
    draw({
      messages: [
        aMessage({
          id: 'message-1',
          changes: [
            aChange({ tool: 'regenerate_daily_plan', summary: 'Redrew the plan', undoable: false }),
          ],
        }),
      ],
    })

    expect(screen.getByText('Redrew the plan')).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Undo the changes this turn made' }),
    ).not.toBeInTheDocument()
  })
})

describe('a confirmation', () => {
  it('says what it would do, how many items it affects, and that nothing has happened', () => {
    draw({ messages: [aMessage({ id: 'message-1', confirmations: [aConfirmation()] })] })

    expect(screen.getByText(/Delete “Book the venue”/)).toBeInTheDocument()
    expect(screen.getByText(/1 item affected/)).toBeInTheDocument()
    expect(screen.getByText(/Nothing has happened yet/)).toBeInTheDocument()
  })

  /** Criterion 4: the count is the point of a bulk confirmation. */
  it('states the count for a bulk operation', () => {
    draw({
      messages: [
        aMessage({
          id: 'message-1',
          confirmations: [
            aConfirmation({
              reason: 'bulk',
              tool: 'complete_task',
              affectedCount: 14,
              summary: 'This turn would change 14 tasks',
            }),
          ],
        }),
      ],
    })

    expect(screen.getByText(/Bulk change/)).toBeInTheDocument()
    expect(screen.getByText(/14 items affected/)).toBeInTheDocument()
  })

  it('confirms and discards through the handler', async () => {
    const user = userEvent.setup()
    const { onConfirm } = draw({
      messages: [aMessage({ id: 'message-1', confirmations: [aConfirmation()] })],
    })

    await user.click(screen.getByRole('button', { name: 'Confirm' }))
    await user.click(screen.getByRole('button', { name: 'Discard' }))

    expect(onConfirm).toHaveBeenNthCalledWith(1, 'confirmation-1', true)
    expect(onConfirm).toHaveBeenNthCalledWith(2, 'confirmation-1', false)
  })

  it('says what was decided once it has been, and offers no buttons', () => {
    draw({
      messages: [
        aMessage({
          id: 'message-1',
          confirmations: [aConfirmation({ decidedAt: NOW, decision: 'confirmed' })],
        }),
      ],
    })

    expect(screen.getByText('Confirmed and applied.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Confirm' })).not.toBeInTheDocument()
  })
})

describe('the things a person would otherwise have to guess at', () => {
  /** Criterion 7. */
  it('says chat is read-only when the model cannot use tools', () => {
    draw({ status: aStatus({ readOnly: true, model: 'a-small-model' }) })

    expect(screen.getByRole('status')).toHaveTextContent(
      /Read-only: a-small-model cannot use tools/,
    )
  })

  it('says why when nothing is configured at all', () => {
    draw({ status: aStatus({ configured: false, readOnly: true, model: null }) })

    expect(screen.getByRole('status')).toHaveTextContent(/no language model is configured/i)
  })

  it('says nothing about read-only when chat can write', () => {
    draw()

    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  /** Criterion 6. */
  it('says when a turn stopped at its tool-call limit, and that what it did stands', () => {
    draw({
      messages: [aMessage({ id: 'message-1', toolCallLimitReached: true, changes: [aChange()] })],
    })

    expect(screen.getByRole('status')).toHaveTextContent(/reached its tool-call limit/)
    expect(screen.getByRole('status')).toHaveTextContent(/changes above were made/)
  })

  it('shows the error of a turn that failed', () => {
    draw({
      messages: [aMessage({ id: 'message-1', content: '', error: 'the provider is down' })],
    })

    expect(screen.getByRole('alert')).toHaveTextContent('the provider is down')
  })

  it('shows a failure from the last request', () => {
    draw({ failure: 'Cannot reach the server' })

    expect(screen.getByRole('alert')).toHaveTextContent('Cannot reach the server')
  })
})
