/**
 * Spec 04 criterion 3's other half: a proposal below the threshold is on the card, with its
 * reasoning and its confidence, and accepting it is one click. Nothing here talks to a server.
 */
import { describe, expect, it, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { Board } from './surfaces/Board.js'
import { aProposal, aTask, NOW } from './test-fixtures.js'

function renderBoard(overrides: Partial<Parameters<typeof Board>[0]> = {}) {
  const handlers = {
    onStatusChange: vi.fn(),
    onComplete: vi.fn(),
    onDelete: vi.fn(),
    onDatesChange: vi.fn(),
    onMarkReviewed: vi.fn(),
    onAcceptProposal: vi.fn(),
    onDismissProposal: vi.fn(),
    onUndoStatus: vi.fn(),
    onSelect: vi.fn(),
  }

  render(
    <Board
      tasks={[]}
      projects={[]}
      staleDays={7}
      now={NOW}
      selected={null}
      {...handlers}
      {...overrides}
    />,
  )

  return handlers
}

const proposed = aTask({
  id: 'task-1',
  title: 'Hub numbers before Thursday',
  status: 'inbox',
  statusSetBy: 'sync',
  proposal: aProposal(),
})

function card() {
  return screen.getByRole('article', { name: 'Hub numbers before Thursday' })
}

describe('a card carrying a proposal', () => {
  it('says what is suggested and how sure the model was', () => {
    renderBoard({ tasks: [proposed] })

    const suggestion = within(card()).getByRole('region', { name: /suggestion for/i })

    expect(suggestion).toHaveTextContent('Next actions')
    expect(suggestion).toHaveTextContent('42% confident')
    expect(suggestion).toHaveTextContent('It reads like one action, but I cannot tell whose.')
  })

  it('names who a waiting suggestion would be waiting on', () => {
    renderBoard({
      tasks: [
        aTask({
          id: 'task-1',
          title: 'Hub numbers before Thursday',
          proposal: aProposal({ status: 'waiting', waitingOn: 'Sam' }),
        }),
      ],
    })

    expect(within(card()).getByRole('region', { name: /suggestion/i })).toHaveTextContent(
      'waiting on Sam',
    )
  })

  it('shows a title it would use, so accepting is not a surprise', () => {
    renderBoard({
      tasks: [
        aTask({
          id: 'task-1',
          title: 'Hub numbers before Thursday',
          proposal: aProposal({ suggestedTitle: 'Send Sam the hub numbers' }),
        }),
      ],
    })

    expect(within(card()).getByText(/Send Sam the hub numbers/)).toBeInTheDocument()
  })

  /** Spec 04: creating a project is a commitment, so the suggestion says whose call it is. */
  it('shows a project suggestion as a suggestion', () => {
    renderBoard({
      tasks: [
        aTask({
          id: 'task-1',
          title: 'Hub numbers before Thursday',
          proposal: aProposal({
            projectSuggestion: { existingProjectId: null, newProjectTitle: 'Q3 hub reporting' },
          }),
        }),
      ],
    })

    expect(within(card()).getByText(/Q3 hub reporting/)).toHaveTextContent('your call')
  })

  it('accepts on one click', async () => {
    const handlers = renderBoard({ tasks: [proposed] })

    await userEvent.click(within(card()).getByRole('button', { name: 'Accept' }))

    expect(handlers.onAcceptProposal).toHaveBeenCalledWith('task-1')
  })

  it('dismisses on one click', async () => {
    const handlers = renderBoard({ tasks: [proposed] })

    await userEvent.click(within(card()).getByRole('button', { name: 'Dismiss' }))

    expect(handlers.onDismissProposal).toHaveBeenCalledWith('task-1')
  })

  /** Spec 08 criterion 8: the board is operable from the keyboard alone, this action included. */
  it('accepts from the keyboard', async () => {
    const handlers = renderBoard({ tasks: [proposed] })

    card().focus()
    await userEvent.keyboard('a')

    expect(handlers.onAcceptProposal).toHaveBeenCalledWith('task-1')
  })

  it('does nothing on that key for a task with no suggestion', async () => {
    const handlers = renderBoard({
      tasks: [aTask({ id: 'task-2', title: 'Nothing suggested here' })],
    })

    screen.getByRole('article', { name: 'Nothing suggested here' }).focus()
    await userEvent.keyboard('a')

    expect(handlers.onAcceptProposal).not.toHaveBeenCalled()
  })
})

describe('a card with no proposal', () => {
  it('offers nothing to accept', () => {
    renderBoard({ tasks: [aTask({ id: 'task-2', title: 'Typed in by hand' })] })

    expect(screen.queryByRole('button', { name: 'Accept' })).not.toBeInTheDocument()
  })
})
