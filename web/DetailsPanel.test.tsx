/**
 * The details of the item that is open, at the top of the rail. Spec 08: a reading surface rather than
 * a second place to act, because a control in two places is two places to keep in step.
 */
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { DetailsPanel } from './components/DetailsPanel.js'
import { aProject, aPullRequestSource, aTask, DAY, NOW } from './test-fixtures.js'

function renderTask(overrides: Partial<Parameters<typeof aTask>[0]> = {}) {
  const task = aTask({ id: 'task-1', title: 'Review the contract', ...overrides })
  const onClose = vi.fn()

  render(
    <DetailsPanel
      item={{ kind: 'task', id: task.id }}
      subject={{ kind: 'task', task, projectTitle: null }}
      staleDays={7}
      now={NOW}
      onClose={onClose}
    />,
  )

  return { onClose }
}

describe('a task in the details panel', () => {
  it('names the item, and the region is named after it', () => {
    renderTask()

    expect(screen.getByRole('heading', { name: 'Review the contract' })).toBeInTheDocument()
    expect(
      screen.getByRole('region', { name: 'Details of Review the contract' }),
    ).toBeInTheDocument()
  })

  /**
   * Unlike a card, the panel does say the status: no column around it does, and criterion 14's rule
   * about not restating a status is a rule about the board.
   */
  it('states its status and who set it', () => {
    renderTask()

    expect(screen.getByText('Status')).toBeInTheDocument()
    expect(screen.getByText('Inbox')).toBeInTheDocument()
    expect(screen.getByText('you')).toBeInTheDocument()
  })

  it('shows the notes a card has no room for', () => {
    renderTask({ notes: 'Ring Ada about the indemnity clause.' })

    expect(screen.getByText('Ring Ada about the indemnity clause.')).toBeInTheDocument()
  })

  /** Spec 08: every task shows its provenance, which source it came from and a link out. */
  it('shows where it came from, with the link out', () => {
    renderTask({
      sources: [aPullRequestSource({ url: 'https://example.test/pr/12', title: 'Add a retry' })],
    })

    expect(screen.getByRole('link', { name: 'Add a retry' })).toHaveAttribute(
      'href',
      'https://example.test/pr/12',
    )
  })

  /** Spec 10: a due date names its state rather than asking the reader to compare dates. */
  it('names an overdue date rather than leaving the reader to work it out', () => {
    renderTask({ dueAt: NOW - 3 * DAY })

    expect(screen.getByText(/overdue/i)).toBeInTheDocument()
  })

  it('says the panel is what the next message sends, which is why it is more than a card', () => {
    renderTask()

    expect(screen.getByText(/goes to the model with your next message/i)).toBeInTheDocument()
  })

  it('closes from its own control', async () => {
    const { onClose } = renderTask()

    await userEvent.click(screen.getByRole('button', { name: 'Close details' }))

    expect(onClose).toHaveBeenCalled()
  })
})

describe('a project in the details panel', () => {
  it('shows its state, its next action and its counts', () => {
    const nextAction = aTask({ id: 'task-1', title: 'Draft the terms' })
    const project = aProject({ id: 'project-1', title: 'Northwind renewal', nextAction })

    render(
      <DetailsPanel
        item={{ kind: 'project', id: project.id }}
        subject={{ kind: 'project', project, tasks: [nextAction] }}
        staleDays={7}
        now={NOW}
        onClose={vi.fn()}
      />,
    )

    expect(screen.getByRole('heading', { name: 'Northwind renewal' })).toBeInTheDocument()
    expect(screen.getByText('Draft the terms')).toBeInTheDocument()
    expect(screen.getByText('1 open, 0 done')).toBeInTheDocument()
  })
})

/** Spec 08, criterion 26: an item that has gone says so rather than falling back to another. */
describe('an item that is not there', () => {
  it('says so rather than rendering as empty', () => {
    render(
      <DetailsPanel
        item={{ kind: 'task', id: 'gone' }}
        subject={null}
        staleDays={7}
        now={NOW}
        onClose={vi.fn()}
      />,
    )

    expect(screen.getByRole('heading', { name: 'Not here any more' })).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent(/completed or deleted/i)
  })
})
