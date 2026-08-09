/**
 * Spec 08 criterion 4: with no plan, no calendar and no integrations configured, the dashboard
 * renders empty states rather than errors.
 */
import { describe, expect, it } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { Dashboard } from './surfaces/Dashboard.js'
import type { Health } from './api.js'
import { aProject, aTask, DAY, NOW } from './test-fixtures.js'

const nothingConfigured: Health = {
  status: 'ok',
  version: '1.0.0',
  uptimeSeconds: 3,
  integrations: {
    github: { configured: false, status: 'not configured' },
    google: { configured: false, status: 'not configured' },
    llm: { configured: false, status: 'not configured' },
  },
}

function renderDashboard(overrides: Partial<Parameters<typeof Dashboard>[0]> = {}) {
  render(
    <Dashboard
      tasks={[]}
      projects={[]}
      health={nothingConfigured}
      staleDays={7}
      now={NOW}
      {...overrides}
    />,
  )
}

describe('an empty Caroline', () => {
  it('renders without raising an alert', () => {
    renderDashboard({ health: null })

    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('shows an empty state for the plan, the calendar and the jobs', () => {
    renderDashboard()

    expect(
      within(screen.getByRole('region', { name: /plan/i })).getByText(/No plan yet/),
    ).toBeInTheDocument()
    expect(
      within(screen.getByRole('region', { name: /calendar/i })).getByText(/No calendar connected/),
    ).toBeInTheDocument()
    expect(
      within(screen.getByRole('region', { name: /jobs/i })).getByText(/No jobs run/),
    ).toBeInTheDocument()
  })

  it('counts nothing as zero rather than leaving the panel blank', () => {
    renderDashboard()

    const counts = screen.getByRole('region', { name: /where everything is/i })

    expect(within(counts).getAllByText('0')).toHaveLength(7)
  })

  it('names every integration and its status', () => {
    renderDashboard()

    expect(screen.getByText('GitHub')).toBeInTheDocument()
    expect(screen.getAllByText('not configured')).toHaveLength(3)
  })

  it('says so rather than showing an empty list when nothing is waiting', () => {
    renderDashboard()

    expect(screen.getByText('Nothing is waiting on anyone else.')).toBeInTheDocument()
  })
})

describe('the counts', () => {
  it('counts tasks per status, done included', () => {
    renderDashboard({
      tasks: [
        aTask({ id: 'a', title: 'One' }),
        aTask({ id: 'b', title: 'Two' }),
        aTask({ id: 'c', title: 'Three', status: 'done' }),
      ],
    })

    const counts = screen.getByRole('region', { name: /where everything is/i })

    expect(within(counts).getByText('Inbox').previousSibling).toHaveTextContent('2')
    expect(within(counts).getByText('Done').previousSibling).toHaveTextContent('1')
  })
})

describe('the quiet-waiting panel', () => {
  const stale = aTask({
    id: 'stale',
    title: 'Signed contract',
    status: 'waiting',
    waitingOn: 'Legal',
    statusSetAt: NOW - 30 * DAY,
  })
  const fresh = aTask({
    id: 'fresh',
    title: 'Invoice query',
    status: 'waiting',
    waitingOn: 'Accounts',
    statusSetAt: NOW - DAY,
  })

  /** Criterion 10, on the dashboard: past the threshold, it is listed here as well. */
  it('lists a waiting item past the threshold, naming who and how long', () => {
    renderDashboard({ tasks: [stale, fresh] })

    const panel = screen.getByRole('region', { name: /gone quiet/i })

    expect(within(panel).getByText('Signed contract')).toBeInTheDocument()
    expect(within(panel).getByText('Legal')).toBeInTheDocument()
    expect(within(panel).getByText('30 days')).toBeInTheDocument()
  })

  it('leaves out an item that is still within the threshold', () => {
    renderDashboard({ tasks: [stale, fresh] })

    const panel = screen.getByRole('region', { name: /gone quiet/i })

    expect(within(panel).queryByText('Invoice query')).not.toBeInTheDocument()
  })

  it('says how long the threshold is when everything is inside it', () => {
    renderDashboard({ tasks: [fresh] })

    expect(screen.getByText('Nothing has been waiting longer than 7 days.')).toBeInTheDocument()
  })

  it('orders the chase list oldest first', () => {
    const older = aTask({
      id: 'older',
      title: 'Older still',
      status: 'waiting',
      waitingOn: 'Finance',
      statusSetAt: NOW - 60 * DAY,
    })
    renderDashboard({ tasks: [stale, older] })

    const panel = screen.getByRole('region', { name: /gone quiet/i })
    const titles = within(panel)
      .getAllByText(/Older still|Signed contract/)
      .map((element) => element.textContent)

    expect(titles).toEqual(['Older still', 'Signed contract'])
  })
})

describe('stalled projects', () => {
  it('names each stalled project and links to it', () => {
    renderDashboard({
      projects: [
        aProject({ id: 'project-1', title: 'Ship it', stalled: true }),
        aProject({ id: 'project-2', title: 'Moving along', stalled: false }),
      ],
    })

    const panel = screen.getByRole('region', { name: /stalled projects/i })

    expect(within(panel).getByRole('link', { name: 'Ship it' })).toHaveAttribute(
      'href',
      '#/projects/project-1',
    )
    expect(within(panel).queryByText('Moving along')).not.toBeInTheDocument()
  })

  it('says every project has a next action when none are stalled', () => {
    renderDashboard({ projects: [aProject({ id: 'project-1', title: 'Ship it', stalled: false })] })

    expect(screen.getByText('Every active project has a next action.')).toBeInTheDocument()
  })
})
