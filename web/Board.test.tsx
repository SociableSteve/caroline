/**
 * Spec 08 criteria 3, 8 and 56: a status change made on the board is the user's, and the whole board
 * is operable from the keyboard alone, through the tab order and the controls on the cards rather
 * than through a grid of shortcuts the board answers itself.
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
import {
  aProject,
  aProposal,
  aPullRequestSource,
  aReviewTask,
  aTask,
  DAY,
  NOW,
} from './test-fixtures.js'

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

  it('is named and counted in its heading, with no digit offering a way in', () => {
    renderBoard({ tasks: [blockedTask(), aTask({ id: 'blocker', title: 'Sign the contract' })] })

    // Criteria 53 and 56: the number that used to sit beside every column name said which digit
    // filed a card into it, and Blocked was the one it had to make an exception of.
    expect(column(/^Blocked/)).toHaveAccessibleName('Blocked, 1 task')
    expect(within(column(/^Blocked/)).queryByText('5')).not.toBeInTheDocument()
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

/**
 * Criterion 8, as it now reads: the board is operable from the keyboard alone through native focus
 * order and the card's own controls. Every action the board's removed grid performed is asserted here
 * as a keyboard path through the control that performs it, so the contract is checked rather than
 * assumed to have survived the deletion.
 */
describe('the keyboard, through the controls on a card', () => {
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

  /**
   * The card, then what is on its face, then the disclosure. Where the tab order goes after that is
   * not asserted here: jsdom offers no layout, so it leaves the contents of a closed `details` in the
   * tab order where a browser skips them, and a test carried on past `More` would be asserting that
   * artefact rather than the contract. What the disclosure holds is asserted with it open instead, in
   * "puts the controls in the tab order once the disclosure is open".
   */
  it('reaches the card, its title and its actions in that order by tabbing', async () => {
    renderBoard({ tasks })

    await userEvent.tab()
    expect(screen.getByRole('article', { name: 'First inbox' })).toHaveFocus()

    await userEvent.tab()
    expect(screen.getByRole('button', { name: 'First inbox' })).toHaveFocus()

    await userEvent.tab()
    expect(screen.getAllByRole('button', { name: 'Complete' })[0]).toHaveFocus()

    await userEvent.tab()
    expect(screen.getAllByText('More')[0]).toHaveFocus()
  })

  it('completes a task from its button with the keyboard alone', async () => {
    const handlers = renderBoard({ tasks })

    const complete = screen.getAllByRole('button', { name: 'Complete' })[0]
    complete?.focus()
    await userEvent.keyboard('{Enter}')

    expect(handlers.onComplete).toHaveBeenCalledWith('first')
  })

  it('changes a status from the control in the disclosure, with the keyboard alone', async () => {
    const handlers = renderBoard({ tasks })

    const card = screen.getByRole('article', { name: 'First inbox' })
    const summary = within(card).getByText('More')
    summary.focus()
    // A native summary opens on Enter, which is what puts the controls it holds in the tab order.
    await userEvent.keyboard('{Enter}')

    const status = within(card).getByRole('combobox', { name: 'Status of First inbox' })
    status.focus()
    // Enter opens the list on the card's own status, Inbox, and the next option down is the one
    // the task is being filed as.
    await userEvent.keyboard('{Enter}')
    await userEvent.keyboard('{ArrowDown}{Enter}')

    expect(handlers.onStatusChange).toHaveBeenCalledWith('first', 'next_action')
  })

  it('undoes the last move from the control in the disclosure, with the keyboard alone', async () => {
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
    within(card).getByText('More').focus()
    await userEvent.keyboard('{Enter}')

    const undo = within(card).getByRole('button', { name: 'Undo move' })
    undo.focus()
    await userEvent.keyboard('{Enter}')

    expect(handlers.onUndoStatus).toHaveBeenCalledWith('task-1')
  })
})

/**
 * Criterion 56: the board answers no keys of its own. The grid that used to be here moved between
 * cards on the arrows and the vi keys, filed a card with a digit, and completed, reviewed, accepted
 * and undid on single letters. Every key is pressed on its own, from a card the old grid would have
 * acted on, and the focus is put back before each one: a key checked only after an earlier one has
 * already moved the focus proves nothing about itself, since the case fails on the first key and
 * the rest are never really tried. `c` is not among them: quick capture is handled for the whole
 * document in `App`, and `App.test.tsx` is where it is asserted.
 */
describe('the keyboard grid the board used to carry', () => {
  const tasks = [
    aTask({
      id: 'first',
      title: 'First inbox',
      previousStatus: 'next_action',
      previousStatusSetBy: 'llm',
      proposal: aProposal({ status: 'next_action', confidence: 0.62 }),
    }),
    aTask({ id: 'next-first', title: 'First next action', status: 'next_action' }),
    aTask({ id: 'next-middle', title: 'Middle next action', status: 'next_action' }),
    aTask({ id: 'next-last', title: 'Last next action', status: 'next_action' }),
    aReviewTask(),
  ]

  /** The handlers the grid called, so a key that has come back names itself in the failure. */
  const expectNoActionRan = (handlers: ReturnType<typeof renderBoard>, key: string) => {
    const ran = (
      [
        ['onStatusChange', handlers.onStatusChange],
        ['onComplete', handlers.onComplete],
        ['onMarkReviewed', handlers.onMarkReviewed],
        ['onAcceptProposal', handlers.onAcceptProposal],
        ['onUndoStatus', handlers.onUndoStatus],
        ['onSelect', handlers.onSelect],
      ] as const
    ).filter(([, handler]) => handler.mock.calls.length > 0)

    expect(
      ran.map(([name]) => name),
      key,
    ).toEqual([])
  }

  /**
   * The focused card is the middle of three in Next actions, with Inbox and Review holding one each,
   * so every direction has a card to land on: down and up within the column, left to Inbox and right
   * to Review. That is what makes each of the eight a real test. The grid clamped at the edges, so a
   * movement key pressed on the first card of the leftmost column left the focus where it was, and
   * six of the eight would have held with the grid still in place.
   */
  it('moves the focus nowhere on any of its movement keys', async () => {
    renderBoard({ tasks })
    const card = screen.getByRole('article', { name: 'Middle next action' })

    for (const key of [
      '{ArrowDown}',
      '{ArrowUp}',
      '{ArrowRight}',
      '{ArrowLeft}',
      'h',
      'j',
      'k',
      'l',
    ]) {
      card.focus()
      await userEvent.keyboard(key)
      expect(card, key).toHaveFocus()
    }
  })

  /**
   * The Inbox card is the one the grid had most to do with: it carries a proposal for `a` and a
   * previous status for `u`, and every digit but its own column names a column a move was allowed
   * into. `1`, its own column, and `5`, Blocked, are pressed for the sake of the whole contract
   * rather than as proof of the removal: the grid was silent on both of those too.
   */
  it('calls no action on any of its action keys', async () => {
    const handlers = renderBoard({ tasks })
    const card = screen.getByRole('article', { name: 'First inbox' })

    for (const key of ['1', '2', '3', '4', '5', '6', '7', 'd', 'a', 'u', '{Enter}']) {
      card.focus()
      await userEvent.keyboard(key)
      expect(card, key).toHaveFocus()
      expectNoActionRan(handlers, key)
    }

    // `r` has to be pressed on a card the action actually applied to. The removed branch was gated
    // on the same predicate as the card's button, which an inbox task fails, so `r` on the card
    // above was silent before the grid went too and proves nothing about its removal.
    const reviewCard = screen.getByRole('article', { name: aReviewTask().title })
    reviewCard.focus()
    await userEvent.keyboard('r')
    expect(reviewCard).toHaveFocus()
    expectNoActionRan(handlers, 'r')
  })

  it('shows no shortcut legend under the columns', () => {
    renderBoard({ tasks })

    expect(screen.queryByRole('region', { name: 'Keyboard' })).not.toBeInTheDocument()
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
 * Putting a board move back. Spec 08, criteria 16 and 17: a move is one drag or one pick from the
 * status control, and it records `status_set_by = 'user'`, which locks the classifier out of the task
 * from then on, so a card dropped in the wrong column does not merely sit in the wrong column.
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

  /**
   * Criterion 15: the controls the disclosure holds join the tab order with it, which is what makes
   * the undo, the blocker picker and the dates reachable without a shortcut of their own.
   */
  it('puts the controls in the tab order once the disclosure is open', async () => {
    renderBoard({
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
    const summary = within(card).getByText('More')
    summary.focus()
    await userEvent.keyboard('{Enter}')

    await userEvent.tab()
    expect(within(card).getByRole('combobox', { name: 'Status of Moved' })).toHaveFocus()

    await userEvent.tab()
    expect(within(card).getByRole('combobox', { name: 'Blocked by, for Moved' })).toHaveFocus()

    await userEvent.tab()
    expect(within(card).getByRole('button', { name: 'Undo move' })).toHaveFocus()
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

  /** Criterion 8: marking a review done is named in it, so its keyboard path is asserted. */
  it('offers the same action from the keyboard alone', async () => {
    const handlers = renderBoard({ tasks: [aReviewTask()] })
    const card = screen.getByRole('article', { name: title })

    within(card).getByRole('button', { name: 'Mark reviewed' }).focus()
    await userEvent.keyboard('{Enter}')

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

  /** Criterion 8: the title is a button, so the keyboard opens the task the same way a click does. */
  it('opens the task from the keyboard, on the title itself', async () => {
    const handlers = renderBoard({ tasks: [aTask({ id: 'task-1', title: 'Captured' })] })

    screen.getByRole('button', { name: 'Captured' }).focus()
    await userEvent.keyboard('{Enter}')

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
})
