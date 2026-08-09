/**
 * Spec 08 criteria 3 and 8: a status change made on the board is the user's, and the whole
 * board is operable from the keyboard alone.
 */
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { Board } from './surfaces/Board.js'
import { formatDate } from './format.js'
import { aProject, aTask, DAY, NOW } from './test-fixtures.js'

function renderBoard(overrides: Partial<Parameters<typeof Board>[0]> = {}) {
  const handlers = {
    onStatusChange: vi.fn(),
    onComplete: vi.fn(),
    onDelete: vi.fn(),
  }

  render(<Board tasks={[]} projects={[]} staleDays={7} now={NOW} {...handlers} {...overrides} />)

  return handlers
}

function column(name: string | RegExp) {
  return screen.getByRole('listitem', { name })
}

describe('the board columns', () => {
  it('shows one column per status, done excluded', () => {
    renderBoard()

    for (const label of [
      'Inbox',
      'Next actions',
      'Review',
      'Waiting for',
      'Someday',
      'Reference',
    ]) {
      expect(screen.getByRole('heading', { name: new RegExp(label) })).toBeInTheDocument()
    }
    expect(screen.queryByRole('heading', { name: /^Done/ })).not.toBeInTheDocument()
  })

  it('shows an empty state per column rather than an error', () => {
    renderBoard()

    expect(screen.getAllByText('Nothing here.')).toHaveLength(6)
  })

  it('puts each task in the column for its status, and counts them', () => {
    renderBoard({
      tasks: [
        aTask({ id: 'task-1', title: 'Captured' }),
        aTask({ id: 'task-2', title: 'Do the thing', status: 'next_action' }),
      ],
    })

    expect(within(column(/^Inbox/)).getByText('Captured')).toBeInTheDocument()
    expect(within(column(/^Next actions/)).getByText('Do the thing')).toBeInTheDocument()
    expect(column(/^Inbox, 1 task$/)).toBeInTheDocument()
  })

  it('names the project a task belongs to on the card', () => {
    renderBoard({
      tasks: [aTask({ id: 'task-1', title: 'Captured', projectId: 'project-1' })],
      projects: [aProject({ id: 'project-1', title: 'Ship it' })],
    })

    expect(screen.getByText('Ship it')).toBeInTheDocument()
  })
})

describe('the waiting column as a chase list', () => {
  const waiting = [
    aTask({
      id: 'recent',
      title: 'Chased yesterday',
      status: 'waiting',
      waitingOn: 'Accounts',
      statusSetAt: NOW - DAY,
    }),
    aTask({
      id: 'ancient',
      title: 'Chased last month',
      status: 'waiting',
      waitingOn: 'Legal',
      statusSetAt: NOW - 30 * DAY,
    }),
  ]

  it('orders it oldest first', () => {
    renderBoard({ tasks: waiting })

    const titles = within(column(/^Waiting for/))
      .getAllByRole('heading', { level: 3 })
      .map((heading) => heading.textContent)

    expect(titles).toEqual(['Chased last month', 'Chased yesterday'])
  })

  it('names who it is on and how long it has been waiting', () => {
    renderBoard({ tasks: waiting })

    const card = screen.getByRole('article', { name: 'Chased last month' })

    expect(within(card).getByText('Legal')).toBeInTheDocument()
    expect(within(card).getByText(/30 days/)).toBeInTheDocument()
  })

  /** Criterion 10, in the column. Colour is not the only carrier: the word is there too. */
  it('flags an item past the staleness threshold in text, not only in colour', () => {
    renderBoard({ tasks: waiting })

    expect(
      within(screen.getByRole('article', { name: 'Chased last month' })).getByText('Stale'),
    ).toBeInTheDocument()
    expect(
      within(screen.getByRole('article', { name: 'Chased yesterday' })).queryByText('Stale'),
    ).not.toBeInTheDocument()
  })

  it('follows the configured threshold rather than a built-in week', () => {
    renderBoard({ tasks: waiting, staleDays: 1 })

    expect(
      within(screen.getByRole('article', { name: 'Chased yesterday' })).getByText('Stale'),
    ).toBeInTheDocument()
  })
})

describe('changing a status', () => {
  it('asks for the change when a card is dragged to another column', () => {
    const handlers = renderBoard({ tasks: [aTask({ id: 'task-1', title: 'Captured' })] })

    fireEvent.drop(column(/^Someday/), {
      dataTransfer: { getData: () => 'task-1' },
    })

    expect(handlers.onStatusChange).toHaveBeenCalledWith('task-1', 'someday')
  })

  it('ignores a drop carrying no task', () => {
    const handlers = renderBoard({ tasks: [aTask({ id: 'task-1', title: 'Captured' })] })

    fireEvent.drop(column(/^Someday/), { dataTransfer: { getData: () => '' } })

    expect(handlers.onStatusChange).not.toHaveBeenCalled()
  })

  it('offers the same change from a select on the card', async () => {
    const handlers = renderBoard({ tasks: [aTask({ id: 'task-1', title: 'Captured' })] })

    await userEvent.selectOptions(
      screen.getByRole('combobox', { name: 'Status of Captured' }),
      'review',
    )

    expect(handlers.onStatusChange).toHaveBeenCalledWith('task-1', 'review')
  })
})

describe('the keyboard', () => {
  const tasks = [
    aTask({ id: 'first', title: 'First inbox' }),
    aTask({ id: 'second', title: 'Second inbox' }),
    aTask({ id: 'next', title: 'A next action', status: 'next_action' }),
  ]

  it('focuses a card by tabbing to it', async () => {
    renderBoard({ tasks })

    await userEvent.tab()

    expect(screen.getByRole('article', { name: 'First inbox' })).toHaveFocus()
  })

  it('moves down and up a column', async () => {
    renderBoard({ tasks })
    screen.getByRole('article', { name: 'First inbox' }).focus()

    await userEvent.keyboard('{ArrowDown}')
    expect(screen.getByRole('article', { name: 'Second inbox' })).toHaveFocus()

    await userEvent.keyboard('{ArrowUp}')
    expect(screen.getByRole('article', { name: 'First inbox' })).toHaveFocus()
  })

  it('moves across columns, and stays put where there is nothing to move to', async () => {
    renderBoard({ tasks })
    screen.getByRole('article', { name: 'First inbox' }).focus()

    await userEvent.keyboard('{ArrowRight}')
    expect(screen.getByRole('article', { name: 'A next action' })).toHaveFocus()

    // Review is empty, so the focus has nowhere to go and does not go there.
    await userEvent.keyboard('{ArrowRight}')
    expect(screen.getByRole('article', { name: 'A next action' })).toHaveFocus()
  })

  it('lands on the last card when the next column is shorter', async () => {
    renderBoard({ tasks })
    screen.getByRole('article', { name: 'Second inbox' }).focus()

    await userEvent.keyboard('{ArrowRight}')

    expect(screen.getByRole('article', { name: 'A next action' })).toHaveFocus()
  })

  it('accepts the vi keys as well as the arrows', async () => {
    renderBoard({ tasks })
    screen.getByRole('article', { name: 'First inbox' }).focus()

    await userEvent.keyboard('j')
    expect(screen.getByRole('article', { name: 'Second inbox' })).toHaveFocus()

    await userEvent.keyboard('k')
    expect(screen.getByRole('article', { name: 'First inbox' })).toHaveFocus()
  })

  it('changes the status of the focused task with a digit', async () => {
    const handlers = renderBoard({ tasks })
    screen.getByRole('article', { name: 'First inbox' }).focus()

    await userEvent.keyboard('4')

    expect(handlers.onStatusChange).toHaveBeenCalledWith('first', 'waiting')
  })

  it('does nothing when the digit is the column the task is already in', async () => {
    const handlers = renderBoard({ tasks })
    screen.getByRole('article', { name: 'First inbox' }).focus()

    await userEvent.keyboard('1')

    expect(handlers.onStatusChange).not.toHaveBeenCalled()
  })

  it('ignores a digit with no column behind it', async () => {
    const handlers = renderBoard({ tasks })
    screen.getByRole('article', { name: 'First inbox' }).focus()

    await userEvent.keyboard('9')

    expect(handlers.onStatusChange).not.toHaveBeenCalled()
  })

  it('completes the focused task', async () => {
    const handlers = renderBoard({ tasks })
    screen.getByRole('article', { name: 'First inbox' }).focus()

    await userEvent.keyboard('d')

    expect(handlers.onComplete).toHaveBeenCalledWith('first')
  })

  it('lists the shortcuts, so they are discoverable rather than folklore', () => {
    renderBoard({ tasks })

    const help = screen.getByRole('region', { name: 'Keyboard' })

    expect(within(help).getByText('1 to 6')).toBeInTheDocument()
  })
})

describe('the card actions', () => {
  it('completes a task from its button', async () => {
    const handlers = renderBoard({ tasks: [aTask({ id: 'task-1', title: 'Captured' })] })

    await userEvent.click(screen.getByRole('button', { name: 'Complete' }))

    expect(handlers.onComplete).toHaveBeenCalledWith('task-1')
  })

  it('asks before deleting, and deletes on the second click', async () => {
    const handlers = renderBoard({ tasks: [aTask({ id: 'task-1', title: 'Captured' })] })

    await userEvent.click(screen.getByRole('button', { name: 'Delete' }))
    expect(handlers.onDelete).not.toHaveBeenCalled()

    await userEvent.click(screen.getByRole('button', { name: 'Confirm delete' }))
    expect(handlers.onDelete).toHaveBeenCalledWith('task-1')
  })

  it('lets the question be answered no', async () => {
    const handlers = renderBoard({ tasks: [aTask({ id: 'task-1', title: 'Captured' })] })

    await userEvent.click(screen.getByRole('button', { name: 'Delete' }))
    await userEvent.click(screen.getByRole('button', { name: 'Keep' }))

    expect(handlers.onDelete).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument()
  })
})

describe('what a card shows without being asked', () => {
  it('shows the estimate, the due date and the tags', () => {
    renderBoard({
      tasks: [
        aTask({
          id: 'task-1',
          title: 'Renew the domain',
          estimateMinutes: 90,
          dueAt: Date.UTC(2026, 5, 20),
          tags: ['admin', 'finance'],
        }),
      ],
    })

    const card = screen.getByRole('article', { name: 'Renew the domain' })

    expect(within(card).getByText('1 hour 30 min')).toBeInTheDocument()
    // Through the shared formatter: the date is rendered in the reader's locale, and which
    // locale that is has nothing to do with what this test is about.
    expect(within(card).getByText(formatDate(Date.UTC(2026, 5, 20)))).toBeInTheDocument()
    expect(within(card).getByText('admin, finance')).toBeInTheDocument()
  })

  it('says when a task is deferred, so a missing next action is explicable', () => {
    renderBoard({
      tasks: [
        aTask({
          id: 'task-1',
          title: 'Later',
          status: 'next_action',
          deferUntil: NOW + 3 * DAY,
        }),
      ],
    })

    expect(screen.getByText('Deferred until')).toBeInTheDocument()
  })
})
