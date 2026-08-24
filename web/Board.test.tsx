/**
 * Spec 08 criteria 3 and 8: a status change made on the board is the user's, and the whole
 * board is operable from the keyboard alone.
 */
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { Board } from './surfaces/Board.js'
import {
  dateInputValue,
  deferUntilFromDateInput,
  dueAtFromDateInput,
  formatDate,
} from './format.js'
import type { SourceView } from './api.js'
import { aProject, aPullRequestSource, aReviewTask, aTask, DAY, NOW } from './test-fixtures.js'

function renderBoard(overrides: Partial<Parameters<typeof Board>[0]> = {}) {
  const handlers = {
    onStatusChange: vi.fn(),
    onBlockerChange: vi.fn(),
    onComplete: vi.fn(),
    onDelete: vi.fn(),
    onDatesChange: vi.fn(),
    onMarkReviewed: vi.fn(),
    onAcceptProposal: vi.fn(),
    onDismissProposal: vi.fn(),
    onUndoStatus: vi.fn(),
    onSelect: vi.fn(),
  }

  const props = {
    tasks: [],
    projects: [],
    staleDays: 7,
    timezone: 'UTC',
    configLoaded: true,
    now: NOW,
    selected: null,
    ...handlers,
    ...overrides,
  }

  const view = render(<Board {...props} />)

  // Stands in for the parent supplying new props after a handler updates its state, the way the
  // real app does: the board itself never holds task data.
  const rerender = (nextOverrides: Partial<Parameters<typeof Board>[0]> = {}) =>
    view.rerender(<Board {...props} {...nextOverrides} />)

  return { ...handlers, rerender }
}

// A named region, not a list item. Wrapping the columns in list roles would replace the region
// semantics each one already has and cost the headings their place in the outline. Spec 08.
function column(name: string | RegExp) {
  return screen.getByRole('region', { name })
}

describe('the board columns', () => {
  it('shows one column per status, done excluded', () => {
    renderBoard()

    for (const label of [
      'Inbox',
      'Next actions',
      'Review',
      'Waiting for',
      'Blocked',
      'Someday',
      'Reference',
    ]) {
      expect(screen.getByRole('heading', { name: new RegExp(label) })).toBeInTheDocument()
    }
    expect(screen.queryByRole('heading', { name: /^Done/ })).not.toBeInTheDocument()
  })

  it('shows an empty state per column rather than an error', () => {
    renderBoard()

    expect(screen.getAllByText('Nothing here.')).toHaveLength(7)
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

/**
 * The Blocked column, spec 08 criterion 53. It is a review surface rather than a target: a task
 * is blocked by naming the blocker, and the board has no blocker to name.
 */
describe('the Blocked column', () => {
  const blockedTask = () =>
    aTask({ id: 'task-1', title: 'Book the venue', status: 'blocked', blockedBy: 'blocker' })

  it('names what a blocked card is behind', () => {
    renderBoard({
      tasks: [blockedTask(), aTask({ id: 'blocker', title: 'Sign the contract' })],
    })

    const card = screen.getByRole('article', { name: 'Book the venue' })

    expect(within(card).getByText('Sign the contract')).toBeVisible()
  })

  it('takes no drop', () => {
    const handlers = renderBoard({ tasks: [aTask({ id: 'task-1', title: 'Captured' })] })

    fireEvent.drop(column(/^Blocked/), { dataTransfer: { getData: () => 'task-1' } })

    expect(handlers.onStatusChange).not.toHaveBeenCalled()
  })

  it('takes no digit', () => {
    const handlers = renderBoard({ tasks: [aTask({ id: 'task-1', title: 'Captured' })] })
    const card = screen.getByRole('article', { name: 'Captured' })
    card.focus()

    fireEvent.keyDown(card, { key: '5' })

    expect(handlers.onStatusChange).not.toHaveBeenCalled()
  })

  it('offers blocked in the status control only to a card already in it', async () => {
    renderBoard({
      tasks: [blockedTask(), aTask({ id: 'task-2', title: 'Captured' })],
    })

    const open = async (title: string) => {
      const card = screen.getByRole('article', { name: title })
      await userEvent.click(within(card).getByRole('combobox', { name: /^Status of/ }))
      const options = screen.getAllByRole('option').map((option) => option.textContent)
      await userEvent.keyboard('{Escape}')
      return options
    }

    expect(await open('Captured')).not.toContain('Blocked')
    expect(await open('Book the venue')).toContain('Blocked')
  })

  it('names the blocker from the card, which is the only way a card becomes blocked', async () => {
    const handlers = renderBoard({
      tasks: [
        aTask({ id: 'task-1', title: 'Captured' }),
        aTask({ id: 'blocker', title: 'Sign the contract' }),
      ],
    })

    const card = screen.getByRole('article', { name: 'Captured' })
    await userEvent.click(within(card).getByText('More'))
    await userEvent.click(within(card).getByRole('combobox', { name: /^Blocked by/ }))
    await userEvent.click(screen.getByRole('option', { name: 'Behind: Sign the contract' }))

    expect(handlers.onBlockerChange).toHaveBeenCalledWith('task-1', 'blocker')
  })

  it('clears the blocker from the same control', async () => {
    const handlers = renderBoard({
      tasks: [blockedTask(), aTask({ id: 'blocker', title: 'Sign the contract' })],
    })

    const card = screen.getByRole('article', { name: 'Book the venue' })
    await userEvent.click(within(card).getByText('More'))
    await userEvent.click(within(card).getByRole('combobox', { name: /^Blocked by/ }))
    await userEvent.click(screen.getByRole('option', { name: 'Not blocked' }))

    expect(handlers.onBlockerChange).toHaveBeenCalledWith('task-1', null)
  })

  /**
   * Spec 08, criterion 54. `GET /api/tasks` returns completed work even though no column shows it,
   * so the picker has to drop it rather than assume the board already has: nothing releases a task
   * filed behind something that finished, and the server refuses the write in any case.
   */
  it('does not offer a task that is already done as a blocker', async () => {
    renderBoard({
      tasks: [
        aTask({ id: 'task-1', title: 'Captured' }),
        aTask({ id: 'blocker', title: 'Sign the contract' }),
        aTask({ id: 'finished', title: 'Send the invoice', status: 'done' }),
      ],
    })

    const card = screen.getByRole('article', { name: 'Captured' })
    await userEvent.click(within(card).getByText('More'))
    await userEvent.click(within(card).getByRole('combobox', { name: /^Blocked by/ }))
    const options = screen.getAllByRole('option').map((option) => option.textContent)

    expect(options).toContain('Behind: Sign the contract')
    expect(options).not.toContain('Behind: Send the invoice')
  })

  /**
   * Spec 08, criterion 54. The picker holds part of the board, so the value a blocked card carries
   * is not always among the items: keyed on the value alone the control rendered blank on the one
   * card it exists to describe.
   */
  it('still names the blocker where the picker is not offering it', async () => {
    renderBoard({
      tasks: [blockedTask(), aTask({ id: 'blocker', title: 'Sign the contract', status: 'done' })],
    })

    const card = screen.getByRole('article', { name: 'Book the venue' })
    await userEvent.click(within(card).getByText('More'))

    expect(within(card).getByRole('combobox', { name: /^Blocked by/ })).toHaveTextContent(
      'Behind: Sign the contract',
    )
  })

  /**
   * Out of the column is ordinary, and it is the half of criterion 53 the suite did not exercise:
   * the drop is accepted and the blocker goes with the status the server sets. Spec 08.
   */
  it('takes a drop out of it, like any other column', () => {
    const handlers = renderBoard({ tasks: [blockedTask()] })

    fireEvent.drop(column(/^Next actions/), { dataTransfer: { getData: () => 'task-1' } })

    expect(handlers.onStatusChange).toHaveBeenCalledWith('task-1', 'next_action')
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

    await userEvent.click(screen.getByRole('combobox', { name: 'Status of Captured' }))
    await userEvent.click(await screen.findByRole('option', { name: 'Review' }))

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

  /**
   * Issue 19: completing the focused task takes it off the board, and its card unmounts under
   * the browser's own focus. Left alone the focus falls to `<body>`, which swallows the very
   * next keypress rather than continuing the triage.
   */
  it('lands on the next card down once the completed card leaves the board', async () => {
    const { rerender } = renderBoard({ tasks })
    screen.getByRole('article', { name: 'First inbox' }).focus()

    await userEvent.keyboard('d')

    // Stands in for the parent's response to onComplete: the task moves to `done`, which is not
    // one of the board's columns, so its card disappears the same as a real completion would.
    rerender({ tasks: tasks.filter((task) => task.id !== 'first') })

    expect(screen.getByRole('article', { name: 'Second inbox' })).toHaveFocus()
  })

  it('lands on the card above where the completed card was the last in its column', async () => {
    const { rerender } = renderBoard({ tasks })
    screen.getByRole('article', { name: 'Second inbox' }).focus()

    await userEvent.keyboard('d')
    rerender({ tasks: tasks.filter((task) => task.id !== 'second') })

    expect(screen.getByRole('article', { name: 'First inbox' })).toHaveFocus()
  })

  /**
   * Completing the only card in a column empties it, so there is no neighbour in it to land on.
   * The nearest card in the closest column with one keeps the keyboard grid usable, where
   * falling back to nothing puts the focus on `<body>`: the bug this is all here to prevent.
   */
  it('crosses to the nearest column when the completed card was the only one in its own', async () => {
    const onlyCardPerColumn = [
      aTask({ id: 'first', title: 'First inbox' }),
      aTask({ id: 'next', title: 'A next action', status: 'next_action' }),
    ]
    const { rerender } = renderBoard({ tasks: onlyCardPerColumn })
    screen.getByRole('article', { name: 'First inbox' }).focus()

    await userEvent.keyboard('d')
    rerender({ tasks: onlyCardPerColumn.filter((task) => task.id !== 'first') })

    expect(screen.getByRole('article', { name: 'A next action' })).toHaveFocus()
  })

  /**
   * The write behind a completion is asynchronous, so the render that takes the card off the
   * board is not the next one: an unrelated render (the clock ticking, a rejected write putting
   * a message on the screen) comes first, and must not be treated as the completion landing.
   */
  it('leaves the focus alone where an unrelated render follows the completion', async () => {
    const { rerender } = renderBoard({ tasks })
    screen.getByRole('article', { name: 'First inbox' }).focus()

    await userEvent.keyboard('d')

    // The write was rejected: the task is still on the board, and still under the focus. Moving
    // it now would put a retry on a different task from the one the user is looking at.
    rerender({ now: NOW + DAY })

    expect(screen.getByRole('article', { name: 'First inbox' })).toHaveFocus()
  })

  it('leaves the focus where the user moved it after asking for the completion', async () => {
    const { rerender } = renderBoard({ tasks })
    screen.getByRole('article', { name: 'First inbox' }).focus()

    await userEvent.keyboard('d')
    // The board is still usable while the write is in flight, and where the user has moved on the
    // completion landing must not drag the focus back across the board.
    await userEvent.keyboard('l')
    rerender({ tasks: tasks.filter((task) => task.id !== 'first'), now: NOW + DAY })

    expect(screen.getByRole('article', { name: 'A next action' })).toHaveFocus()
  })

  /**
   * `u` puts the last status change back, and a task that was moved out of `done` has `done` to
   * go back to: the undo takes it off the board exactly as a completion does.
   */
  it('lands on a neighbour when an undo puts the focused task back to done', async () => {
    const undoable = [
      aTask({
        id: 'first',
        title: 'First next',
        status: 'next_action',
        previousStatus: 'done',
        previousStatusSetBy: 'user',
      }),
      aTask({ id: 'second', title: 'Second next', status: 'next_action' }),
    ]
    const { rerender } = renderBoard({ tasks: undoable })
    screen.getByRole('article', { name: 'First next' }).focus()

    await userEvent.keyboard('u')
    rerender({ tasks: undoable.filter((task) => task.id !== 'first') })

    expect(screen.getByRole('article', { name: 'Second next' })).toHaveFocus()
  })

  it('follows the task to its new column when a digit moves it', async () => {
    const { rerender } = renderBoard({ tasks })
    screen.getByRole('article', { name: 'First inbox' }).focus()

    await userEvent.keyboard('4')
    rerender({
      tasks: tasks.map((task) => (task.id === 'first' ? { ...task, status: 'waiting' } : task)),
    })

    const waiting = column(/Waiting for/)
    expect(within(waiting).getByRole('article', { name: 'First inbox' })).toHaveFocus()
  })

  it('lists the shortcuts, so they are discoverable rather than folklore', () => {
    renderBoard({ tasks })

    const help = screen.getByRole('region', { name: 'Keyboard' })

    expect(within(help).getByText('1 to 7')).toBeInTheDocument()
  })
})

/**
 * The card holds a status select and buttons, and their keys bubble to the card. Taking those
 * as board shortcuts made the select unusable from the keyboard: an ArrowDown to pick an option
 * moved the focus to another card instead, and a letter typed to jump within the list completed
 * the task or changed its status.
 */
describe('the keyboard inside a card control', () => {
  const tasks = [
    aTask({ id: 'first', title: 'First inbox' }),
    aTask({ id: 'second', title: 'Second inbox' }),
  ]

  it('leaves the arrow keys to the status select', async () => {
    renderBoard({ tasks })
    const select = screen.getByRole('combobox', { name: 'Status of First inbox' })
    select.focus()

    await userEvent.keyboard('{ArrowDown}')

    // shadcn's `Select` (Radix underneath) opens on an arrow key and moves the roving focus to
    // the highlighted option rather than keeping it on the trigger the way a native `<select>`
    // does; the contract this checks is that the board's own card-to-card arrow navigation never
    // gets the key, not that focus stays on one particular element inside the control that owns it.
    expect(screen.getByRole('listbox')).toBeInTheDocument()
    // `{ hidden: true }`: the open popup marks the rest of the page `aria-hidden`, same as
    // shadcn's `Dialog`.
    expect(screen.getByRole('article', { name: 'First inbox', hidden: true })).not.toHaveFocus()
    expect(screen.getByRole('article', { name: 'Second inbox', hidden: true })).not.toHaveFocus()
  })

  it('does not complete a task when d is typed into the select', async () => {
    const handlers = renderBoard({ tasks })
    screen.getByRole('combobox', { name: 'Status of First inbox' }).focus()

    await userEvent.keyboard('d')

    expect(handlers.onComplete).not.toHaveBeenCalled()
  })

  it('does not change a status when a digit is typed into the select', async () => {
    const handlers = renderBoard({ tasks })
    screen.getByRole('combobox', { name: 'Status of First inbox' }).focus()

    await userEvent.keyboard('4')

    expect(handlers.onStatusChange).not.toHaveBeenCalled()
  })

  it('leaves keys pressed on a card button alone as well', async () => {
    const handlers = renderBoard({ tasks })
    screen.getAllByRole('button', { name: 'Complete' })[0]?.focus()

    await userEvent.keyboard('{ArrowRight}')

    expect(handlers.onStatusChange).not.toHaveBeenCalled()
    expect(screen.getAllByRole('button', { name: 'Complete' })[0]).toHaveFocus()
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

  /**
   * Criterion 14. The column the card is in says its status, and so does the status control; a
   * third telling in the fact list is noise, and on an Inbox, Someday or Reference card it was the
   * fact list's only row.
   */
  it('does not restate its own status as a fact', () => {
    renderBoard({ tasks: [aTask({ id: 'task-1', title: 'Renew the domain' })] })

    const card = screen.getByRole('article', { name: 'Renew the domain' })

    expect(within(card).queryByText('Status')).not.toBeInTheDocument()
  })

  /**
   * Criterion 14, the other half: a fact is never a click away, while a secondary control may be.
   * Spec 08's "nothing is hidden behind a hover" is a rule about information.
   */
  it('keeps every fact visible while the secondary controls are behind a disclosure', () => {
    renderBoard({
      tasks: [
        aTask({
          id: 'task-1',
          title: 'Renew the domain',
          estimateMinutes: 90,
          tags: ['admin'],
        }),
      ],
    })

    const card = screen.getByRole('article', { name: 'Renew the domain' })

    expect(within(card).getByText('1 hour 30 min')).toBeVisible()
    expect(within(card).getByText('admin')).toBeVisible()
    expect(within(card).getByRole('button', { name: 'Complete' })).toBeVisible()
    // Present in the document and reachable, but not taking a third of the card until asked for.
    expect(within(card).getByRole('combobox', { name: /^Status of/ })).not.toBeVisible()
  })

  // Criterion 15: the disclosure is a control, so it is reachable by keyboard like any other.
  it('opens the disclosure from the keyboard', async () => {
    renderBoard({ tasks: [aTask({ id: 'task-1', title: 'Renew the domain' })] })

    const card = screen.getByRole('article', { name: 'Renew the domain' })
    await userEvent.click(within(card).getByText('More'))

    expect(within(card).getByRole('combobox', { name: /^Status of/ })).toBeVisible()
    expect(within(card).getByRole('combobox', { name: /^Blocked by/ })).toBeVisible()
    expect(within(card).getByRole('button', { name: 'Delete' })).toBeVisible()
  })

  /**
   * Criterion 18, and spec 10's rule that a time state says which it is: a date on its own asks
   * the reader to know today's date and do the comparison.
   */
  it('names an overdue date and a date due today, and leaves a later one as the date', () => {
    renderBoard({
      tasks: [
        aTask({ id: 'task-1', title: 'Late', dueAt: NOW - 2 * DAY }),
        aTask({ id: 'task-2', title: 'Now', dueAt: NOW }),
        aTask({ id: 'task-3', title: 'Soon', dueAt: NOW + 5 * DAY }),
      ],
    })

    const due = (title: string) =>
      within(screen.getByRole('article', { name: title })).getByText(/Overdue|Today|\d/, {
        selector: 'dd',
      }).textContent

    expect(due('Late')).toMatch(/^Overdue, /)
    expect(due('Now')).toMatch(/^Today, /)
    expect(due('Soon')).toBe(formatDate(NOW + 5 * DAY))
  })
})

/**
 * Setting, changing and clearing a due date or a defer-until date from the card's "More"
 * disclosure. Issue #44: the fields were displayed but nowhere editable.
 */
describe('editing a due date and a defer-until date', () => {
  it('shows a task with neither date set as two empty date inputs', async () => {
    renderBoard({ tasks: [aTask({ id: 'task-1', title: 'Renew the domain' })] })

    const card = screen.getByRole('article', { name: 'Renew the domain' })
    await userEvent.click(within(card).getByText('More'))

    expect(within(card).getByLabelText('Due')).toHaveValue('')
    expect(within(card).getByLabelText('Defer until')).toHaveValue('')
  })

  it('shows a task with dates already set, filled in as the local day', async () => {
    renderBoard({
      tasks: [
        aTask({
          id: 'task-1',
          title: 'Renew the domain',
          dueAt: NOW + 5 * DAY,
          deferUntil: NOW + 2 * DAY,
        }),
      ],
    })

    const card = screen.getByRole('article', { name: 'Renew the domain' })
    await userEvent.click(within(card).getByText('More'))

    expect(within(card).getByLabelText('Due')).toHaveValue(dateInputValue(NOW + 5 * DAY, 'UTC'))
    expect(within(card).getByLabelText('Defer until')).toHaveValue(
      dateInputValue(NOW + 2 * DAY, 'UTC'),
    )
  })

  it('sets a due date as the end of the day picked', async () => {
    const handlers = renderBoard({ tasks: [aTask({ id: 'task-1', title: 'Renew the domain' })] })

    const card = screen.getByRole('article', { name: 'Renew the domain' })
    await userEvent.click(within(card).getByText('More'))
    const dueInput = within(card).getByLabelText('Due')
    fireEvent.change(dueInput, { target: { value: '2026-07-01' } })
    fireEvent.blur(dueInput)

    expect(handlers.onDatesChange).toHaveBeenCalledWith('task-1', {
      dueAt: dueAtFromDateInput('2026-07-01', 'UTC'),
    })
  })

  it('sets a defer-until date as the start of the day picked', async () => {
    const handlers = renderBoard({ tasks: [aTask({ id: 'task-1', title: 'Renew the domain' })] })

    const card = screen.getByRole('article', { name: 'Renew the domain' })
    await userEvent.click(within(card).getByText('More'))
    const deferInput = within(card).getByLabelText('Defer until')
    fireEvent.change(deferInput, { target: { value: '2026-06-20' } })
    fireEvent.blur(deferInput)

    expect(handlers.onDatesChange).toHaveBeenCalledWith('task-1', {
      deferUntil: deferUntilFromDateInput('2026-06-20', 'UTC'),
    })
  })

  it('clears a due date by clearing the input, rather than leaving it alone', async () => {
    const handlers = renderBoard({
      tasks: [aTask({ id: 'task-1', title: 'Renew the domain', dueAt: NOW + 5 * DAY })],
    })

    const card = screen.getByRole('article', { name: 'Renew the domain' })
    await userEvent.click(within(card).getByText('More'))
    const dueInput = within(card).getByLabelText('Due')
    fireEvent.change(dueInput, { target: { value: '' } })
    fireEvent.blur(dueInput)

    expect(handlers.onDatesChange).toHaveBeenCalledWith('task-1', { dueAt: null })
  })

  it('clears a defer-until date by clearing the input, rather than leaving it alone', async () => {
    const handlers = renderBoard({
      tasks: [aTask({ id: 'task-1', title: 'Renew the domain', deferUntil: NOW + 2 * DAY })],
    })

    const card = screen.getByRole('article', { name: 'Renew the domain' })
    await userEvent.click(within(card).getByText('More'))
    const deferInput = within(card).getByLabelText('Defer until')
    fireEvent.change(deferInput, { target: { value: '' } })
    fireEvent.blur(deferInput)

    expect(handlers.onDatesChange).toHaveBeenCalledWith('task-1', { deferUntil: null })
  })
})

/**
 * Putting a board move back. Spec 08, criteria 16 and 17: a move is one keypress and records
 * `status_set_by = 'user'`, which locks the classifier out of the task from then on, so a mistyped
 * digit does not merely misfile a card.
 */
describe('undoing the last status change', () => {
  it('offers the undo only on a task that has been changed', async () => {
    renderBoard({
      tasks: [
        aTask({
          id: 'task-1',
          title: 'Moved',
          previousStatus: 'inbox',
          previousStatusSetBy: 'llm',
        }),
        aTask({ id: 'task-2', title: 'Never moved' }),
      ],
    })

    const moved = screen.getByRole('article', { name: 'Moved' })
    const untouched = screen.getByRole('article', { name: 'Never moved' })

    await userEvent.click(within(moved).getByText('More'))
    await userEvent.click(within(untouched).getByText('More'))

    expect(within(moved).getByRole('button', { name: 'Undo move' })).toBeVisible()
    expect(within(untouched).queryByRole('button', { name: 'Undo move' })).not.toBeInTheDocument()
  })

  it('asks for it from the card', async () => {
    const handlers = renderBoard({
      tasks: [
        aTask({
          id: 'task-1',
          title: 'Moved',
          previousStatus: 'inbox',
          previousStatusSetBy: 'llm',
        }),
      ],
    })

    const card = screen.getByRole('article', { name: 'Moved' })
    await userEvent.click(within(card).getByText('More'))
    await userEvent.click(within(card).getByRole('button', { name: 'Undo move' }))

    expect(handlers.onUndoStatus).toHaveBeenCalledWith('task-1')
  })

  // A change is one keypress, so putting one back is one too.
  it('asks for it from the keyboard, and is silent where there is nothing to put back', () => {
    const handlers = renderBoard({
      tasks: [
        aTask({
          id: 'task-1',
          title: 'Moved',
          previousStatus: 'inbox',
          previousStatusSetBy: 'llm',
        }),
        aTask({ id: 'task-2', title: 'Never moved' }),
      ],
    })

    fireEvent.keyDown(screen.getByRole('article', { name: 'Moved' }), { key: 'u' })
    expect(handlers.onUndoStatus).toHaveBeenCalledWith('task-1')

    handlers.onUndoStatus.mockClear()
    fireEvent.keyDown(screen.getByRole('article', { name: 'Never moved' }), { key: 'u' })
    expect(handlers.onUndoStatus).not.toHaveBeenCalled()
  })

  // Criterion 15: opening the disclosure must not take the board's own keys away.
  it('leaves the board keys working while the disclosure is open', async () => {
    const handlers = renderBoard({
      tasks: [aTask({ id: 'task-1', title: 'Renew the domain' })],
    })

    const card = screen.getByRole('article', { name: 'Renew the domain' })
    await userEvent.click(within(card).getByText('More'))
    fireEvent.keyDown(card, { key: 'd' })

    expect(handlers.onComplete).toHaveBeenCalledWith('task-1')
  })

  /**
   * And with the focus still on the disclosure, which is where opening it from the keyboard
   * leaves it. A summary is not a text field: a digit typed on it is a board command, not typing,
   * so the shortcuts have to survive the trip into the disclosure and not only the trip back out.
   */
  it('keeps the shortcuts working while the summary itself holds the focus', async () => {
    const handlers = renderBoard({
      tasks: [
        aTask({
          id: 'task-1',
          title: 'Renew the domain',
          previousStatus: 'inbox',
          previousStatusSetBy: 'llm',
        }),
      ],
    })

    const card = screen.getByRole('article', { name: 'Renew the domain' })
    const summary = within(card).getByText('More')
    summary.focus()

    fireEvent.keyDown(summary, { key: 'd' })
    expect(handlers.onComplete).toHaveBeenCalledWith('task-1')

    fireEvent.keyDown(summary, { key: 'u' })
    expect(handlers.onUndoStatus).toHaveBeenCalledWith('task-1')

    // Someday is the sixth column now that Blocked is the fifth. Spec 08, criterion 53.
    fireEvent.keyDown(summary, { key: '6' })
    expect(handlers.onStatusChange).toHaveBeenCalledWith('task-1', 'someday')
  })

  // The controls inside it are a different matter: their keys are theirs, which is why the board
  // reads only from the card and the summary.
  it('still leaves the keys of the controls inside the disclosure alone', async () => {
    const handlers = renderBoard({ tasks: [aTask({ id: 'task-1', title: 'Renew the domain' })] })

    const card = screen.getByRole('article', { name: 'Renew the domain' })
    await userEvent.click(within(card).getByText('More'))
    fireEvent.keyDown(within(card).getByRole('combobox', { name: /^Status of/ }), { key: 'd' })

    expect(handlers.onComplete).not.toHaveBeenCalled()
  })
})

/**
 * Spec 08 criteria 8, 9 and 10, and spec 02's Review and Waiting for columns: the pull
 * request card, the action that moves it on, and what the column says about it afterwards.
 */
describe('a pull request awaiting review', () => {
  const title = 'example-org/example-service#42 Add a retry to the fetch helper'

  it('offers Mark reviewed as the primary action on the card', async () => {
    const handlers = renderBoard({ tasks: [aReviewTask()] })

    await userEvent.click(
      within(screen.getByRole('article', { name: title })).getByRole('button', {
        name: 'Mark reviewed',
      }),
    )

    expect(handlers.onMarkReviewed).toHaveBeenCalledWith('task-pr')
  })

  it('offers the same action from the keyboard alone', () => {
    const handlers = renderBoard({ tasks: [aReviewTask()] })
    const card = screen.getByRole('article', { name: title })

    card.focus()
    fireEvent.keyDown(card, { key: 'r' })

    expect(handlers.onMarkReviewed).toHaveBeenCalledWith('task-pr')
  })

  it('links out to the pull request, so every task shows its provenance', () => {
    renderBoard({ tasks: [aReviewTask()] })

    const link = within(screen.getByRole('article', { name: title })).getByRole('link', {
      name: 'example-org/example-service#42',
    })

    expect(link).toHaveAttribute('href', 'https://github.com/example-org/example-service/pull/42')
  })

  it('offers nothing to mark reviewed on a manually captured task', () => {
    renderBoard({ tasks: [aTask({ id: 'task-1', title: 'Renew the domain', status: 'review' })] })

    expect(screen.queryByRole('button', { name: 'Mark reviewed' })).not.toBeInTheDocument()
  })

  it('offers nothing to mark reviewed once the task has opted out of tracking', () => {
    renderBoard({ tasks: [aReviewTask({ syncTracked: false })] })

    expect(screen.queryByRole('button', { name: 'Mark reviewed' })).not.toBeInTheDocument()
  })

  it('offers nothing to mark reviewed on a pull request that has already closed', () => {
    // There is nothing left to discharge. The server refuses it, so offering it would lie.
    renderBoard({
      tasks: [aReviewTask({ sources: [aPullRequestSource({ resolvedAt: NOW - DAY })] })],
    })

    expect(screen.queryByRole('button', { name: 'Mark reviewed' })).not.toBeInTheDocument()
  })

  it('does nothing on the keyboard for a pull request that has already closed', () => {
    const handlers = renderBoard({
      tasks: [aReviewTask({ sources: [aPullRequestSource({ resolvedAt: NOW - DAY })] })],
    })
    const card = screen.getByRole('article', { name: title })

    card.focus()
    fireEvent.keyDown(card, { key: 'r' })

    expect(handlers.onMarkReviewed).not.toHaveBeenCalled()
  })
})

describe('a pull request waiting on its author', () => {
  const title = 'example-org/example-service#42 Add a retry to the fetch helper'

  /** As the connector leaves it once you have reviewed: acted on, waiting on the author. */
  function reviewed(overrides: Partial<SourceView> = {}) {
    return aReviewTask({
      status: 'waiting',
      waitingOn: 'author-one',
      // Deliberately different from `actedAt`: the age is measured from when you acted, not
      // from when the row was last written.
      statusSetAt: NOW - DAY,
      sources: [
        aPullRequestSource({
          lifecycleState: 'reviewed',
          actedAt: NOW - 9 * DAY,
          actedAtMarker: 'sha-one',
          ...overrides,
        }),
      ],
    })
  }

  it('measures the wait from when you reviewed it, not from the last write', () => {
    renderBoard({ tasks: [reviewed()] })

    expect(
      within(screen.getByRole('article', { name: title })).getByText(/9 days/),
    ).toBeInTheDocument()
  })

  it('is flagged stale once it passes the threshold, in words as well as colour', () => {
    renderBoard({ tasks: [reviewed()] })

    expect(
      within(screen.getByRole('article', { name: title })).getByText('Stale'),
    ).toBeInTheDocument()
  })

  it('says when the author has pushed since you reviewed', () => {
    renderBoard({
      tasks: [
        reviewed({
          metadata: {
            repository: 'example-org/example-service',
            author: 'author-one',
            headSha: 'sha-two',
            headCommittedAt: NOW - 2 * DAY,
          },
        }),
      ],
    })

    expect(screen.getByText('The author has pushed since you reviewed')).toBeInTheDocument()
  })

  it('says nothing about a push when the head is where you left it', () => {
    renderBoard({ tasks: [reviewed()] })

    expect(screen.queryByText('The author has pushed since you reviewed')).not.toBeInTheDocument()
  })
})

describe('a task sync has stopped following', () => {
  it('says so, so it is clear why it stopped moving on its own', () => {
    renderBoard({ tasks: [aReviewTask({ status: 'someday', syncTracked: false })] })

    expect(screen.getByText('Sync tracking off')).toBeInTheDocument()
  })
})

describe('a pull request that closed upstream', () => {
  it('offers the completion sync proposed rather than quietly applying it', () => {
    renderBoard({
      tasks: [
        aReviewTask({
          status: 'waiting',
          statusSetBy: 'user',
          sources: [
            aPullRequestSource({
              lifecycleState: 'closed',
              resolvedAt: NOW - DAY,
              completionProposedAt: NOW - DAY,
            }),
          ],
        }),
      ],
    })

    expect(screen.getByText('Closed upstream. Complete it?')).toBeInTheDocument()
  })
})

/**
 * Spec 02, notification emails as a backup source: the notification produced no task of its own,
 * so the pull request's card is the only place it can be accounted for. Suppressing a duplicate
 * must not mean it silently vanished.
 */
describe('a pull request whose notification email was suppressed', () => {
  const notification: SourceView = {
    id: 'source-2',
    provider: 'gmail',
    externalId: 'thread-github-review-request',
    url: 'https://mail.google.com/mail/u/0/#all/thread-github-review-request',
    title: '[example-org/example-service] Add a retry to the fetch helper (PR #42)',
    lifecycleState: null,
    actedAt: null,
    actedAtMarker: null,
    resolvedAt: null,
    suppressedAt: NOW - DAY,
    requeuedAt: null,
    completionProposedAt: null,
    metadata: {},
  }

  it('shows the notification on the card, linked, as its provenance', () => {
    renderBoard({ tasks: [aReviewTask({ sources: [aPullRequestSource(), notification] })] })

    expect(screen.getByText('Also notified')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: notification.title as string })).toHaveAttribute(
      'href',
      notification.url,
    )
  })

  it('says nothing about the ordinary sources a task came from', () => {
    renderBoard({ tasks: [aReviewTask({ sources: [aPullRequestSource()] })] })

    expect(screen.queryByText('Also notified')).not.toBeInTheDocument()
  })
})

/**
 * Opening a task in the rail. Spec 08, criterion 27: the title is the control, because a card's action
 * row is already at the width a column can afford and the title is the thing being pointed at.
 */
describe('opening a task in the details rail', () => {
  it('opens the task whose title was clicked', async () => {
    const handlers = renderBoard({ tasks: [aTask({ id: 'task-1', title: 'Captured' })] })

    await userEvent.click(screen.getByRole('button', { name: 'Captured' }))

    expect(handlers.onSelect).toHaveBeenCalledWith({ kind: 'task', id: 'task-1' })
  })

  it('opens the focused task from the keyboard', async () => {
    const handlers = renderBoard({ tasks: [aTask({ id: 'task-1', title: 'Captured' })] })
    const card = screen.getByRole('article', { name: 'Captured' })
    card.focus()

    fireEvent.keyDown(card, { key: 'Enter' })

    expect(handlers.onSelect).toHaveBeenCalledWith({ kind: 'task', id: 'task-1' })
  })

  it('says which card is the one that is open', () => {
    renderBoard({
      tasks: [aTask({ id: 'task-1', title: 'Captured' }), aTask({ id: 'task-2', title: 'Other' })],
      selected: { kind: 'task', id: 'task-1' },
    })

    expect(screen.getByRole('button', { name: 'Captured' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'Other' })).toHaveAttribute('aria-pressed', 'false')
  })

  it('lists the key that opens it, so the shortcut is discoverable', () => {
    renderBoard()

    expect(screen.getByText(/open the focused task in the details rail/)).toBeInTheDocument()
  })
})
