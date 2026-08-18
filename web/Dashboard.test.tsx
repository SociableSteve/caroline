/**
 * Spec 08 criterion 4: with no plan, no calendar and no integrations configured, the dashboard
 * renders empty states rather than errors.
 */
import { describe, expect, it, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { Dashboard } from './surfaces/Dashboard.js'
import type { Health } from './api.js'
import { aCalendarDay, aPlan, aPlanEntry, aProject, aTask, DAY, NOW } from './test-fixtures.js'
import { noCounts } from '../src/domain/job.js'

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
      jobRuns={[]}
      plan={null}
      history={[]}
      calendar={null}
      staleDays={7}
      now={NOW}
      selected={null}
      onSelect={vi.fn()}
      hash="#/"
      onRegeneratePlan={() => {}}
      onComplete={() => {}}
      {...overrides}
    />,
  )
}

/**
 * Spec 08, criterion 11. The morning question is "what am I doing today, and does it fit", so the
 * surface answers that first and everything else after. The bands are fixed rows rather than one
 * reflowing grid, because a reading path that changes with the window width is not a reading path.
 */
describe('the three bands', () => {
  const bands = () => [...document.querySelectorAll('.band')]

  it('reads today first, what wants a decision second, and the machine last', () => {
    renderDashboard({
      plan: aPlan({ entries: [aPlanEntry({ id: 'entry-1', title: 'Write the report' })] }),
      calendar: aCalendarDay(),
      projects: [aProject({ id: 'project-1', title: 'Ship it', stalled: true })],
      health: nothingConfigured,
    })

    // By the class that identifies each band rather than the whole attribute: what is asserted
    // is the reading order, and a modifier class added later does not change it.
    const names = ['band-today', 'band-decisions', 'state-strip']
    expect(
      bands().map((band) => names.find((name) => band.classList.contains(name)) ?? band.className),
    ).toEqual(names)
  })

  it('leads with the plan and the calendar, and not with a count', () => {
    renderDashboard({ plan: aPlan({ entries: [] }), calendar: aCalendarDay() })

    const first = bands()[0] as HTMLElement
    const headings = within(first)
      .getAllByRole('heading')
      .map((heading) => heading.textContent)

    expect(headings).toEqual(['Today’s plan', 'Today’s calendar'])
  })

  /**
   * The rule the previous version of this spec was missing, and the reason a count led a surface
   * about work for three milestones. A count is not work.
   */
  it('gives nothing in the state of the machine the weight of a panel', () => {
    renderDashboard({ health: nothingConfigured })

    const strip = document.querySelector('.state-strip')
    // Asserted rather than asserted-away: a missing strip should read as a missing strip, not as
    // a null dereference on the next line.
    expect(strip).not.toBeNull()
    const sections = [...(strip as HTMLElement).querySelectorAll('section')]

    expect(sections.length).toBeGreaterThan(0)
    for (const section of sections) {
      expect(section.classList.contains('panel')).toBe(false)
    }
  })
})

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
      within(screen.getByRole('region', { name: /calendar/i })).getByText(/No calendar yet/),
    ).toBeInTheDocument()
    expect(
      within(screen.getByRole('region', { name: /jobs/i })).getByText(/Nothing has run yet/),
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

describe('today’s plan', () => {
  function planPanel() {
    return within(screen.getByRole('region', { name: /plan/i }))
  }

  it('lists the entries in rank order with their reasons and estimates', () => {
    renderDashboard({
      plan: aPlan({
        entries: [
          aPlanEntry({
            id: 'entry-1',
            rank: 1,
            title: 'Review the retry helper',
            rationale: 'Somebody is blocked',
            estimateMinutes: 30,
          }),
          aPlanEntry({
            id: 'entry-2',
            rank: 2,
            title: 'Hub numbers',
            rationale: 'Due today',
            estimateMinutes: 60,
          }),
        ],
      }),
    })

    const titles = planPanel()
      .getAllByRole('listitem')
      .map((item) => item.textContent)

    expect(titles[0]).toContain('Review the retry helper')
    expect(titles[0]).toContain('Somebody is blocked')
    expect(titles[0]).toContain('30 min')
    expect(titles[1]).toContain('Hub numbers')
  })

  it('shows the summary the planner wrote', () => {
    renderDashboard({ plan: aPlan({ summary: 'Two reviews and the hub numbers.' }) })

    expect(planPanel().getByText('Two reviews and the hub numbers.')).toBeInTheDocument()
  })

  /** Spec 05: the entry renders as done once the task is, rather than sitting there as work. */
  it('marks an entry whose task is done', () => {
    renderDashboard({
      plan: aPlan({
        entries: [aPlanEntry({ title: 'Already finished', done: true, taskStatus: 'done' })],
      }),
    })

    expect(planPanel().getByText('Already finished').closest('li')).toHaveClass('plan-done')
  })

  it('offers to complete an entry that is not done, and says which task', async () => {
    const onComplete = vi.fn()
    renderDashboard({
      plan: aPlan({ entries: [aPlanEntry({ taskId: 'task-a', title: 'Hub numbers' })] }),
      onComplete,
    })

    await userEvent.click(planPanel().getByRole('button', { name: /complete Hub numbers/i }))

    expect(onComplete).toHaveBeenCalledWith('task-a')
  })

  it('does not offer to complete an entry whose task has been deleted', () => {
    renderDashboard({
      plan: aPlan({ entries: [aPlanEntry({ taskId: null, title: 'Long gone' })] }),
    })

    expect(planPanel().queryByRole('button', { name: /complete/i })).not.toBeInTheDocument()
  })

  /** Spec 05: excess is offered as "if there is time" rather than dropped. */
  it('lists the overflow separately, under its own heading', () => {
    renderDashboard({
      plan: aPlan({
        entries: [aPlanEntry({ id: 'entry-1', title: 'Planned work' })],
        overflow: [aPlanEntry({ id: 'entry-2', kind: 'overflow', title: 'Spare capacity work' })],
      }),
    })

    const overflow = within(screen.getByRole('region', { name: /if there is time/i }))

    expect(overflow.getByText('Spare capacity work')).toBeInTheDocument()
    expect(overflow.queryByText('Planned work')).not.toBeInTheDocument()
  })

  it('says nothing about overflow when everything fitted', () => {
    renderDashboard({ plan: aPlan({ entries: [aPlanEntry({})] }) })

    expect(screen.queryByRole('region', { name: /if there is time/i })).not.toBeInTheDocument()
  })

  it('shows the warnings a plan carries rather than leaving them in the database', () => {
    renderDashboard({
      plan: aPlan({ warnings: ['No calendar is connected, so this is a guess.'] }),
    })

    expect(planPanel().getByText(/No calendar is connected/)).toBeInTheDocument()
  })

  it('says the day has no capacity rather than showing an empty list', () => {
    renderDashboard({ plan: aPlan({ entries: [], capacityMinutes: 0 }) })

    expect(planPanel().getByText(/no free capacity/i)).toBeInTheDocument()
  })

  /**
   * Issue #22: capacity was positive and every candidate overflowed, so "Nothing was eligible for
   * planning today" sat directly under the criterion-16 warning saying work did not fit. The
   * items were eligible, ranked and listed as overflow, so the empty state must not claim
   * otherwise.
   */
  it('says nothing fitted rather than nothing was eligible, when capacity is positive but everything overflowed', () => {
    renderDashboard({
      plan: aPlan({
        entries: [],
        capacityMinutes: 30,
        overflow: [aPlanEntry({ id: 'entry-1', kind: 'overflow', title: 'Too big for today' })],
        warnings: [
          "Some of today's work did not fit into the free time left, so it is below rather than in the plan.",
        ],
      }),
    })

    expect(planPanel().queryByText(/nothing was eligible/i)).not.toBeInTheDocument()
    expect(planPanel().queryByText(/no free capacity/i)).not.toBeInTheDocument()
    expect(planPanel().getByText(/nothing fitted into the free time left/i)).toBeInTheDocument()
  })

  it('regenerates on demand', async () => {
    const onRegeneratePlan = vi.fn()
    renderDashboard({ plan: aPlan({}), onRegeneratePlan })

    await userEvent.click(screen.getByRole('button', { name: /regenerate/i }))

    expect(onRegeneratePlan).toHaveBeenCalled()
  })

  /** One regeneration at a time: a second click would only earn a 409 from the scheduler. */
  it('refuses a second regeneration while one is in flight', async () => {
    const onRegeneratePlan = vi.fn()
    renderDashboard({ plan: aPlan({}), regenerating: true, onRegeneratePlan })

    const button = screen.getByRole('button', { name: /regenerating/i })

    expect(button).toBeDisabled()
    await userEvent.click(button)
    expect(onRegeneratePlan).not.toHaveBeenCalled()
  })
})

/** Criteria 11 and 12, on the dashboard. */
describe('the plan’s chase nudges', () => {
  it('names the item, who it is on and how long it has been', () => {
    renderDashboard({
      plan: aPlan({
        nudges: [
          aPlanEntry({
            kind: 'nudge',
            title: 'Signed contract',
            waitingOn: 'Legal',
            waitingSince: NOW - 30 * DAY,
            estimateMinutes: null,
          }),
        ],
      }),
    })

    const panel = within(screen.getByRole('region', { name: /chase/i }))

    expect(panel.getByText('Signed contract')).toBeInTheDocument()
    expect(panel.getByText('Legal')).toBeInTheDocument()
    expect(panel.getByText('30 days')).toBeInTheDocument()
  })

  it('says whether the author has pushed since you reviewed', () => {
    renderDashboard({
      plan: aPlan({
        nudges: [
          aPlanEntry({
            kind: 'nudge',
            title: 'example-org/example-service#42',
            waitingOn: 'author-one',
            waitingSince: NOW - 10 * DAY,
            pushedSinceReview: true,
          }),
        ],
      }),
    })

    expect(screen.getByText(/pushed since/i)).toBeInTheDocument()
  })
})

/** Criterion 6: the bar's numbers are the ones `GET /api/calendar` gave. */
describe('the capacity bar', () => {
  function capacityPanel() {
    return within(screen.getByRole('region', { name: /calendar/i }))
  }

  it('shows planned against available in minutes', () => {
    renderDashboard({
      calendar: aCalendarDay({
        capacity: {
          windowMinutes: 510,
          busyMinutes: 60,
          reserveMinutes: 102,
          capacityMinutes: 348,
        },
      }),
      plan: aPlan({
        capacityMinutes: 348,
        entries: [aPlanEntry({ estimateMinutes: 90 })],
      }),
    })

    const bar = capacityPanel().getByRole('meter', { name: /capacity/i })

    expect(bar).toHaveAttribute('aria-valuenow', '90')
    expect(bar).toHaveAttribute('aria-valuemax', '348')
  })

  it('spells the numbers out in text as well, so colour is not the only carrier', () => {
    renderDashboard({
      calendar: aCalendarDay({}),
      plan: aPlan({ capacityMinutes: 348, entries: [aPlanEntry({ estimateMinutes: 90 })] }),
    })

    expect(
      capacityPanel().getByText(/1 hour 30 min planned of 5 hours 48 min/i),
    ).toBeInTheDocument()
  })

  /**
   * A meter whose minimum and maximum are both zero is not a range, and assistive technology
   * has nothing to announce for it. The text carries the answer on its own.
   */
  it('renders no meter at all on a day with no free capacity', () => {
    renderDashboard({
      calendar: aCalendarDay({ capacity: { capacityMinutes: 0, busyMinutes: 408 } }),
      plan: aPlan({ capacityMinutes: 0 }),
    })

    expect(capacityPanel().queryByRole('meter')).not.toBeInTheDocument()
    expect(capacityPanel().getByText(/0 min planned of 0 min free/i)).toBeInTheDocument()
  })

  it('says the capacity is unverified when no calendar is connected', () => {
    renderDashboard({
      calendar: aCalendarDay({
        connected: false,
        capacity: { verified: false, busyMinutes: 0 },
      }),
    })

    expect(capacityPanel().getByText(/unverified/i)).toBeInTheDocument()
    expect(
      capacityPanel().getByText(/assumes the whole working window is free/i),
    ).toBeInTheDocument()
  })

  /**
   * A connection that has since dropped does not erase events already synced into the database:
   * they are still deducted from the capacity bar's numbers, so the notice must not claim the
   * whole day was assumed free when it plainly was not.
   */
  it('says the notice is drawn from a stale sync, not an assumed-free day, when events were deducted', () => {
    renderDashboard({
      calendar: aCalendarDay({
        connected: false,
        capacity: { verified: false, busyMinutes: 60 },
      }),
    })

    expect(capacityPanel().getByText(/unverified/i)).toBeInTheDocument()
    expect(capacityPanel().queryByText(/assumes the whole/i)).not.toBeInTheDocument()
    expect(capacityPanel().getByText(/last synced/i)).toBeInTheDocument()
  })

  it('says so on a day that is not a working day', () => {
    renderDashboard({
      calendar: aCalendarDay({ capacity: { workingDay: false, windowMinutes: 0 } }),
    })

    expect(capacityPanel().getByText(/not a working day/i)).toBeInTheDocument()
  })

  /**
   * A day with no working window has nothing that could have been assumed free and nothing drawn
   * from a stale sync, so the unverified notice has no distinction left to draw and sits oddly
   * beside "not a working day".
   */
  it('leaves the unverified notice off a day that is not a working day', () => {
    renderDashboard({
      calendar: aCalendarDay({
        connected: false,
        capacity: { workingDay: false, windowMinutes: 0, verified: false, busyMinutes: 0 },
      }),
    })

    expect(capacityPanel().queryByText(/unverified/i)).not.toBeInTheDocument()
  })
})

describe('the calendar column', () => {
  function calendarPanel() {
    return within(screen.getByRole('region', { name: /calendar/i }))
  }

  it('lists the day’s events with their times', () => {
    renderDashboard({
      calendar: aCalendarDay({
        events: [
          {
            id: 'event-1',
            calendarId: 'primary',
            summary: 'Hub weekly',
            startsAt: NOW,
            endsAt: NOW + 60 * 60_000,
            allDay: false,
            responseStatus: 'accepted',
            transparency: 'opaque',
            status: 'confirmed',
            attendeeCount: 3,
            url: null,
            consumesCapacity: true,
          },
        ],
      }),
    })

    expect(calendarPanel().getByText('Hub weekly')).toBeInTheDocument()
  })

  /** A declined meeting is still on the diary, and the column should say why it costs nothing. */
  it('says when an event takes no time off the day', () => {
    renderDashboard({
      calendar: aCalendarDay({
        events: [
          {
            id: 'event-1',
            calendarId: 'primary',
            summary: 'Vendor call',
            startsAt: NOW,
            endsAt: NOW + 60 * 60_000,
            allDay: false,
            responseStatus: 'declined',
            transparency: 'opaque',
            status: 'confirmed',
            attendeeCount: 2,
            url: null,
            consumesCapacity: false,
          },
        ],
      }),
    })

    expect(calendarPanel().getByText(/declined/i)).toBeInTheDocument()
  })

  it('says the day is clear rather than showing an empty list', () => {
    renderDashboard({ calendar: aCalendarDay({ events: [] }) })

    expect(calendarPanel().getByText(/nothing in the diary/i)).toBeInTheDocument()
  })
})

describe('planned against completed', () => {
  it('shows the fortnight', () => {
    renderDashboard({
      history: [
        { planDate: '2026-06-09', planned: 4, completed: 3 },
        { planDate: '2026-06-10', planned: 5, completed: 1 },
      ],
    })

    const panel = within(screen.getByRole('region', { name: /planned against completed/i }))

    expect(panel.getAllByRole('listitem')).toHaveLength(2)
    expect(panel.getByText('3 of 4')).toBeInTheDocument()
  })

  /** Spec 05: Caroline records the gap and draws no conclusion from it. */
  it('says nothing about a fortnight with no plans in it', () => {
    renderDashboard({ history: [] })

    expect(
      screen.queryByRole('region', { name: /planned against completed/i }),
    ).not.toBeInTheDocument()
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

/** Spec 02, criterion 5: a connector's failure is surfaced, not left in a log line. */
describe('the background jobs panel', () => {
  const run = {
    id: 'run-1',
    job: 'sync:github',
    trigger: 'manual' as const,
    startedAt: NOW - 2 * 60_000,
    finishedAt: NOW - 60_000,
    counts: { ...noCounts, itemsSeen: 3, sourcesCreated: 1, tasksCreated: 1 },
    error: null,
    errorStack: null,
  }

  it('shows the last run of each job with how long ago it was', () => {
    renderDashboard({ jobRuns: [{ ...run, status: 'success' }] })

    const panel = screen.getByRole('region', { name: /jobs/i })

    expect(within(panel).getByText('sync:github')).toBeInTheDocument()
    expect(within(panel).getByText('success')).toBeInTheDocument()
    expect(within(panel).getByText('1 minute ago')).toBeInTheDocument()
  })

  it('shows a failure with the error message the connector gave', () => {
    renderDashboard({
      jobRuns: [{ ...run, status: 'failure', error: 'GitHub answered 401 Unauthorized' }],
    })

    expect(screen.getByText('GitHub answered 401 Unauthorized')).toBeInTheDocument()
  })

  /**
   * Criterion 19. The rows are a grid, so a row carrying an error keeps the same three columns as
   * one that does not, and the error takes the width beneath them rather than squeezing the rest
   * of the row into nothing.
   */
  it('lays a row out the same whether or not it carries an error', () => {
    renderDashboard({
      jobRuns: [
        { ...run, id: 'run-1', job: 'classify', status: 'success' },
        { ...run, id: 'run-2', job: 'sync', status: 'failure', error: 'GitHub answered 401' },
      ],
    })

    const rows = within(screen.getByRole('region', { name: /jobs/i })).getAllByRole('listitem')
    const columns = (row: HTMLElement) =>
      [...row.children].filter((child) => !child.classList.contains('job-error')).length

    // Pinned to three rather than only to each other: two rows that had both lost their columns
    // would be equal, and equal is not the claim. The claim is that the job, its status and its
    // age are all still there whether or not an error follows them.
    expect(rows).toHaveLength(2)
    expect(columns(rows[0] as HTMLElement)).toBe(3)
    expect(columns(rows[1] as HTMLElement)).toBe(3)
    expect(rows.some((row) => row.querySelector('.job-error') !== null)).toBe(true)
  })

  it('shows only the most recent run of a job, since the history has its own surface', () => {
    renderDashboard({
      jobRuns: [
        { ...run, id: 'run-2', status: 'failure', error: 'the latest' },
        { ...run, id: 'run-1', status: 'success' },
      ],
    })

    const panel = screen.getByRole('region', { name: /jobs/i })

    expect(within(panel).getByText('failure')).toBeInTheDocument()
    expect(within(panel).queryByText('success')).not.toBeInTheDocument()
  })
})

/**
 * Spec 08, criterion 31. A plan entry is not a fourth kind of item: it names a task, and clicking it
 * opens that task. An entry whose task has been deleted is a record of what was proposed, and names
 * nothing to open.
 */
describe('opening a plan entry in the details rail', () => {
  it('opens the entry’s task', async () => {
    const onSelect = vi.fn()
    renderDashboard({
      plan: aPlan({ entries: [aPlanEntry({ taskId: 'task-a', title: 'Hub numbers' })] }),
      onSelect,
    })

    await userEvent.click(screen.getByRole('button', { name: 'Hub numbers' }))

    expect(onSelect).toHaveBeenCalledWith({ kind: 'task', id: 'task-a' })
  })

  it('says which entry is the one that is open', () => {
    renderDashboard({
      plan: aPlan({ entries: [aPlanEntry({ taskId: 'task-a', title: 'Hub numbers' })] }),
      selected: { kind: 'task', id: 'task-a' },
    })

    expect(screen.getByRole('button', { name: 'Hub numbers' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
  })

  it('leaves an entry whose task has been deleted as text', () => {
    renderDashboard({
      plan: aPlan({ entries: [aPlanEntry({ taskId: null, title: 'Something deleted' })] }),
    })

    expect(screen.queryByRole('button', { name: 'Something deleted' })).not.toBeInTheDocument()
    expect(screen.getByText('Something deleted')).toBeInTheDocument()
  })
})

/** Spec 08, criterion 32: the dashboard's stalled-project links carry the rail across too. */
describe('the dashboard’s drill-in links', () => {
  it('carries the open conversation into the drill-in', () => {
    renderDashboard({
      projects: [aProject({ id: 'project-1', title: 'Ship it', stalled: true, nextAction: null })],
      hash: '#/?conversation=abc',
    })

    expect(screen.getByRole('link', { name: 'Ship it' })).toHaveAttribute(
      'href',
      '#/projects/project-1?conversation=abc',
    )
  })
})
