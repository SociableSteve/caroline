/**
 * Spec 08 criterion 4: with no plan, no calendar and no integrations configured, the dashboard
 * renders empty states rather than errors.
 *
 * Issue #47 redesigned the surface: a verdict headline, a to-scale day bar and one merged agenda
 * (the plan's entries and the calendar's events interleaved) replace the separate plan and
 * calendar panels this file used to test; "gone quiet", "worth a chase" and "stalled projects"
 * are now one ranked "Needs you" list in the left rail rather than three panels, capped to its
 * three oldest with a link to the board for the rest. The background-jobs strip and the
 * planned-against-completed history a previous pass kept as an "honest gap" have since been
 * removed to match the mockup: Jobs already has its own surface, and nothing on the dashboard
 * needs plan history repeated.
 */
import { describe, expect, it, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { Dashboard } from './surfaces/Dashboard.js'
import { formatTimeOfDay } from './format.js'
import type { CapacityView } from './api.js'
import { aCalendarDay, aPlan, aPlanEntry, aProject, aTask, DAY, NOW } from './test-fixtures.js'

function renderDashboard(overrides: Partial<Parameters<typeof Dashboard>[0]> = {}) {
  render(
    <Dashboard
      tasks={[]}
      projects={[]}
      plan={null}
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

/** The unified "Today" region: the verdict, the day bar and the agenda, replacing what used to
 *  be two separate regions named "plan" and "calendar". */
function today() {
  return within(screen.getByRole('region', { name: /today/i }))
}

/**
 * Spec 08, criterion 11. The morning question is "what am I doing today, and does it fit", so the
 * surface answers that first. Issue #47 answers it in a left rail (what needs you, then the state
 * of the machine) beside a main column (the verdict, the day bar, the agenda) rather than the
 * three stacked bands this used to be; the reading order claim now is that the rail's headings
 * come before the agenda's content, matching the columns' left-to-right, top-to-bottom order.
 */
describe('the dashboard’s layout', () => {
  it('puts the left rail before the main column in document order', () => {
    renderDashboard({
      plan: aPlan({ entries: [aPlanEntry({ id: 'entry-1', title: 'Write the report' })] }),
      calendar: aCalendarDay(),
      projects: [aProject({ id: 'project-1', title: 'Ship it', stalled: true })],
    })

    const headings = screen
      .getAllByRole('heading', { level: 2 })
      .map((heading) => heading.textContent)

    expect(headings.indexOf('Needs you')).toBeGreaterThanOrEqual(0)
    expect(headings.indexOf('Where everything is')).toBeGreaterThan(headings.indexOf('Needs you'))
  })

  /** The rule the previous version of this spec was missing, and the reason a count led a
   *  surface about work for three milestones. A count is not work: it is still not given the
   *  weight of a bordered card the way the day's own agenda is not bordered either, but "Where
   *  everything is" is explicitly a card per issue #47, so the old blanket rule against any panel
   *  weight in the rail no longer holds; what still holds is that it is not the reading path. */
  it('gives the needs-you list no panel weight of its own, unlike the bordered card beneath it', () => {
    renderDashboard()

    const needsYou = screen.getByText('Needs you').closest('section')
    expect(needsYou).not.toBeNull()
    expect(needsYou?.querySelector('.panel')).toBeNull()
  })
})

describe('an empty Caroline', () => {
  it('renders without raising an alert', () => {
    renderDashboard()

    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('shows an empty state for the plan and the calendar', () => {
    renderDashboard()

    expect(today().getByText(/No plan yet/)).toBeInTheDocument()
    expect(today().getByText(/No calendar yet/)).toBeInTheDocument()
  })

  it('counts nothing as zero rather than leaving the panel blank', () => {
    renderDashboard()

    const counts = screen.getByRole('region', { name: /where everything is/i })

    expect(within(counts).getAllByText('0')).toHaveLength(7)
  })

  it('says so rather than showing an empty list when nothing needs you', () => {
    renderDashboard()

    expect(screen.getByText('Nothing is waiting on anyone else.')).toBeInTheDocument()
  })
})

describe('the verdict', () => {
  it('says today fits, with the numbers the day bar also shows', () => {
    renderDashboard({
      calendar: aCalendarDay({ capacity: { capacityMinutes: 285 } }),
      plan: aPlan({ entries: [aPlanEntry({ estimateMinutes: 180 })] }),
    })

    expect(
      today().getByText(
        /Today fits — 3 hours planned of 4 hours 45 min free, and 1 hour 45 min to spare/,
      ),
    ).toBeInTheDocument()
  })

  it('says today is tight when the plan runs over the free capacity', () => {
    renderDashboard({
      calendar: aCalendarDay({ capacity: { capacityMinutes: 60 } }),
      plan: aPlan({ entries: [aPlanEntry({ estimateMinutes: 90 })] }),
    })

    expect(today().getByText(/Today’s tight/)).toBeInTheDocument()
  })

  it('says nothing when there is no calendar to verdict against', () => {
    renderDashboard({ calendar: null, plan: aPlan({}) })

    expect(today().queryByText(/Today fits/)).not.toBeInTheDocument()
    expect(today().queryByText(/Today’s tight/)).not.toBeInTheDocument()
  })

  /** Issue #47's mockup shows the date beside the verdict headline. */
  it('names today’s date alongside the verdict', () => {
    renderDashboard({ calendar: aCalendarDay(), plan: aPlan({}) })

    // Wednesday 10 June 2026 (the fixtures' NOW). Matched by content rather than a fixed order,
    // since a locale's short weekday/day/month order is its own to choose; no year is asserted,
    // since the verdict is always about today.
    const region = screen.getByRole('region', { name: /today/i })
    const dateElement = region.querySelector('.verdict-date')
    expect(dateElement).not.toBeNull()
    expect(dateElement?.textContent).toMatch(/Wed/)
    expect(dateElement?.textContent).toMatch(/Jun/)
    expect(dateElement?.textContent).toMatch(/\b10\b/)
  })

  /** The window the verdict was drawn from, otherwise dropped entirely by the agenda merge. */
  it('spells out the working window the verdict summarised', () => {
    renderDashboard({
      calendar: aCalendarDay({
        capacity: { windowMinutes: 510, busyMinutes: 60, reserveMinutes: 102 },
      }),
      plan: aPlan({}),
    })

    expect(
      today().getByText(
        /8 hours 30 min of working day, less 1 hour of meetings and 1 hour 42 min held back/,
      ),
    ).toBeInTheDocument()
  })
})

describe('the day bar', () => {
  it('shows the meetings, planned, done, free and held-back minutes in words', () => {
    renderDashboard({
      calendar: aCalendarDay({
        capacity: { busyMinutes: 60, reserveMinutes: 102, capacityMinutes: 348 },
      }),
      plan: aPlan({
        entries: [
          aPlanEntry({ id: 'entry-1', estimateMinutes: 90, done: false }),
          aPlanEntry({ id: 'entry-2', estimateMinutes: 30, done: true }),
        ],
      }),
    })

    expect(today().getByText('meetings 1 hour')).toBeInTheDocument()
    expect(today().getByText('planned 1 hour 30 min')).toBeInTheDocument()
    expect(today().getByText('done 30 min')).toBeInTheDocument()
    expect(today().getByText('free 3 hours 48 min')).toBeInTheDocument()
    expect(today().getByText('held back 1 hour 42 min')).toBeInTheDocument()
  })

  it('says so on a day that is not a working day', () => {
    renderDashboard({
      calendar: aCalendarDay({ capacity: { workingDay: false, windowMinutes: 0 } }),
    })

    expect(today().getByText(/not a working day/i)).toBeInTheDocument()
  })

  it('says the capacity is unverified when no calendar is connected', () => {
    renderDashboard({
      calendar: aCalendarDay({
        connected: false,
        capacity: { verified: false, busyMinutes: 0 },
      }),
    })

    expect(today().getByText(/unverified/i)).toBeInTheDocument()
    expect(today().getByText(/assumes the whole working window is free/i)).toBeInTheDocument()
  })

  it('leaves the unverified notice off a day that is not a working day', () => {
    renderDashboard({
      calendar: aCalendarDay({
        connected: false,
        capacity: { workingDay: false, windowMinutes: 0, verified: false, busyMinutes: 0 },
      }),
    })

    expect(today().queryByText(/unverified/i)).not.toBeInTheDocument()
  })
})

/**
 * Issue #67 replaced the proportion chart with a wall-clock timeline: spec 08, criteria 40 to 46.
 * The window these use is ten hours long, so a minute of it is a sixth of a per cent and the
 * arithmetic in each assertion can be read rather than trusted.
 */
describe('the day bar’s track', () => {
  const MINUTE = 60_000
  const WINDOW_START = NOW
  const WINDOW_MINUTES = 600
  const WINDOW_END = WINDOW_START + WINDOW_MINUTES * MINUTE

  /** A day of the fixed ten-hour window, with whatever busy and free intervals a test asks for. */
  function aTimedDay(capacity: Partial<CapacityView> = {}) {
    return aCalendarDay({
      capacity: {
        windowStart: WINDOW_START,
        windowEnd: WINDOW_END,
        busy: [],
        free: [],
        ...capacity,
      },
    })
  }

  function track(): HTMLElement {
    const strip = screen
      .getByRole('region', { name: /today/i })
      .querySelector<HTMLElement>('.day-bar')
    expect(strip).not.toBeNull()
    return strip as HTMLElement
  }

  function blocksOf(kind: string): HTMLElement[] {
    return [...track().querySelectorAll<HTMLElement>(`[data-block="${kind}"]`)]
  }

  /** Where an element was drawn, as the percentages the component wrote into its own style. */
  function geometryOf(element: HTMLElement) {
    return {
      left: Number.parseFloat(element.style.left),
      width: Number.parseFloat(element.style.width),
    }
  }

  /** The share of the window a run of minutes is, as a percentage: the scale under test. */
  function share(minutes: number): number {
    return (minutes / WINDOW_MINUTES) * 100
  }

  /** Criterion 40: positioned and sized from its own instants, not from a share of a total. */
  it('positions each meeting at its own offset into the window, at its own duration', () => {
    renderDashboard({
      calendar: aTimedDay({
        busy: [
          { start: WINDOW_START + 60 * MINUTE, end: WINDOW_START + 120 * MINUTE },
          { start: WINDOW_START + 300 * MINUTE, end: WINDOW_START + 420 * MINUTE },
        ],
      }),
    })

    const [firstMeeting, secondMeeting] = blocksOf('meeting').map(geometryOf)

    expect(firstMeeting?.left).toBeCloseTo(share(60), 6)
    expect(firstMeeting?.width).toBeCloseTo(share(60), 6)
    // Twice the duration, drawn twice as wide, and after the first rather than beside it.
    expect(secondMeeting?.left).toBeCloseTo(share(300), 6)
    expect(secondMeeting?.width).toBeCloseTo(share(120), 6)
  })

  /** Criterion 40: no floor. Time that is unusable has to look unusable. */
  it('draws a three-minute gap three minutes wide rather than at a minimum width', () => {
    renderDashboard({
      calendar: aTimedDay({
        free: [
          { start: WINDOW_START, end: WINDOW_START + 3 * MINUTE },
          { start: WINDOW_START + 540 * MINUTE, end: WINDOW_END },
        ],
      }),
    })

    const [crack, stretch] = blocksOf('free').map(geometryOf)

    expect(crack?.width).toBeCloseTo(share(3), 6)
    expect(stretch?.width).toBeCloseTo(share(60), 6)
  })

  /** Criterion 41: a day of scattered cracks and a day with one clear stretch do not draw alike. */
  it('draws one element per stretch of free time rather than merging them', () => {
    renderDashboard({
      calendar: aTimedDay({
        free: [
          { start: WINDOW_START, end: WINDOW_START + 10 * MINUTE },
          { start: WINDOW_START + 120 * MINUTE, end: WINDOW_START + 130 * MINUTE },
          { start: WINDOW_START + 480 * MINUTE, end: WINDOW_START + 490 * MINUTE },
        ],
      }),
    })

    const free = blocksOf('free').map(geometryOf)

    expect(free).toHaveLength(3)
    expect(free.map((gap) => gap.left.toFixed(4))).toEqual(
      [share(0), share(120), share(480)].map((offset) => offset.toFixed(4)),
    )
    for (const gap of free) expect(gap.width).toBeCloseTo(share(10), 6)
  })

  /** Criterion 42: a position on the track, not only a figure in the legend. */
  it('marks the present moment where it falls in the window', () => {
    const now = WINDOW_START + 150 * MINUTE
    renderDashboard({ calendar: aTimedDay(), now })

    const marker = track().querySelector<HTMLElement>('[data-marker="now"]')

    expect(marker).not.toBeNull()
    expect(Number.parseFloat(marker?.style.left ?? '')).toBeCloseTo(share(150), 6)
  })

  /** Criterion 42: clamping it to an edge would say the day had started when it has not. */
  it('draws no marker before the window opens, and still states the time in the legend', () => {
    const now = WINDOW_START - 60 * MINUTE
    renderDashboard({ calendar: aTimedDay(), now })

    expect(track().querySelector('[data-marker="now"]')).toBeNull()
    expect(today().getByText(`now ${formatTimeOfDay(now)}`)).toBeInTheDocument()
  })

  it('draws no marker after the window closes', () => {
    renderDashboard({ calendar: aTimedDay(), now: WINDOW_END + MINUTE })

    expect(track().querySelector('[data-marker="now"]')).toBeNull()
  })

  /**
   * Criterion 43, and the assertion that matters most: the bar and the agenda are two renderings
   * of one placement walk, so an entry's offset on the track is the offset of the clock time the
   * agenda prints beside it. Read back from the drawn percentage into an instant rather than
   * recomputed from the fixture, so the two can never drift apart without this failing.
   */
  it('draws a plan entry at the offset of the time the agenda prints beside it', () => {
    const freeStart = WINDOW_START + 97 * MINUTE
    renderDashboard({
      calendar: aTimedDay({ free: [{ start: freeStart, end: freeStart + 120 * MINUTE }] }),
      plan: aPlan({
        entries: [aPlanEntry({ id: 'entry-1', title: 'Write the report', estimateMinutes: 45 })],
      }),
    })

    const [block] = blocksOf('planned').map(geometryOf)
    const drawnAt = WINDOW_START + ((block?.left ?? 0) / 100) * (WINDOW_END - WINDOW_START)
    const row = today().getByText('Write the report').closest('li')

    expect(row?.textContent).toContain(formatTimeOfDay(drawnAt))
    expect(block?.width).toBeCloseTo(share(45), 6)
  })

  /** An entry already done still occupies the minutes it was placed into, in its own fill. */
  it('keeps a done entry on the track, distinct from one still to do', () => {
    renderDashboard({
      calendar: aTimedDay({ free: [{ start: WINDOW_START, end: WINDOW_END }] }),
      plan: aPlan({
        entries: [
          aPlanEntry({ id: 'entry-1', estimateMinutes: 30, done: true }),
          aPlanEntry({ id: 'entry-2', estimateMinutes: 30, done: false }),
        ],
      }),
    })

    const [doneBlock] = blocksOf('done').map(geometryOf)
    const [plannedBlock] = blocksOf('planned').map(geometryOf)

    expect(doneBlock?.left).toBeCloseTo(share(0), 6)
    expect(doneBlock?.width).toBeCloseTo(share(30), 6)
    expect(plannedBlock?.left).toBeCloseTo(share(30), 6)
  })

  /**
   * Criterion 44: the reserve is a flat percentage of the window rather than any particular minutes
   * of it, so it is a legend figure and nothing else. Asserted as the drawn track covering the
   * whole window: with the meetings and the free time between them accounted for, there is no
   * stretch of the clock left over for a reserve to claim.
   */
  it('states the held-back minutes in the legend and draws none of them', () => {
    renderDashboard({
      calendar: aTimedDay({
        busy: [{ start: WINDOW_START, end: WINDOW_START + 60 * MINUTE }],
        free: [{ start: WINDOW_START + 60 * MINUTE, end: WINDOW_END }],
        reserveMinutes: 102,
      }),
    })

    const covered = [...blocksOf('meeting'), ...blocksOf('free')]
      .map((block) => geometryOf(block).width)
      .reduce((total, width) => total + width, 0)

    expect(today().getByText('held back 1 hour 42 min')).toBeInTheDocument()
    expect(track().querySelector('[data-block="reserve"]')).toBeNull()
    expect(covered).toBeCloseTo(100, 6)
  })

  /** Criterion 45: the legend is the text carrier, and the strip reads as a clock. */
  it('hides the track from assistive technology, and labels the window’s ends and its hours', () => {
    renderDashboard({ calendar: aTimedDay() })

    expect(track()).toHaveAttribute('aria-hidden', 'true')
    expect(track().textContent).toContain(formatTimeOfDay(WINDOW_START))
    expect(track().textContent).toContain(formatTimeOfDay(WINDOW_END))

    const ticks = [...track().querySelectorAll<HTMLElement>('[data-tick="hour"]')].map((tick) =>
      Number.parseFloat(tick.style.left),
    )

    expect(ticks.length).toBeGreaterThan(0)
    // An hour apart, whatever the runner's time zone does to where the first one falls.
    for (const [index, tick] of ticks.slice(1).entries()) {
      expect(tick - (ticks[index] as number)).toBeCloseTo(share(60), 6)
    }
  })

  /** Criterion 46: no track where there is no window, and no second proportional drawing either. */
  it('draws no track at all on a day that is not a working day', () => {
    renderDashboard({
      calendar: aCalendarDay({ capacity: { workingDay: false, windowMinutes: 0 } }),
    })

    const region = screen.getByRole('region', { name: /today/i })

    expect(region.querySelector('.day-bar')).toBeNull()
    expect(today().getByText(/not a working day/i)).toBeInTheDocument()
  })

  /** Criterion 46: honest, because the notice beside it says the window was assumed free. */
  it('draws the track on an unverified day, alongside the notice', () => {
    renderDashboard({
      calendar: aTimedDay({ verified: false, busyMinutes: 0 }),
    })

    expect(track()).toBeInTheDocument()
    expect(today().getByText(/unverified/i)).toBeInTheDocument()
  })
})

describe('the agenda', () => {
  it('lists the plan’s entries in rank order with their reasons and estimates', () => {
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

    const rows = today()
      .getAllByRole('listitem')
      .map((item) => item.textContent)
      .filter((text) => text?.includes('Review the retry helper') || text?.includes('Hub numbers'))

    expect(rows[0]).toContain('Review the retry helper')
    expect(rows[0]).toContain('Somebody is blocked')
    expect(rows[0]).toContain('30 min')
    expect(rows[1]).toContain('Hub numbers')
  })

  it('shows the summary the planner wrote', () => {
    renderDashboard({ plan: aPlan({ summary: 'Two reviews and the hub numbers.' }) })

    expect(today().getByText('Two reviews and the hub numbers.')).toBeInTheDocument()
  })

  /** Spec 05: the entry renders as done once the task is, rather than sitting there as work. */
  it('marks an entry whose task is done', () => {
    renderDashboard({
      plan: aPlan({
        entries: [aPlanEntry({ title: 'Already finished', done: true, taskStatus: 'done' })],
      }),
    })

    expect(today().getByText('Already finished').closest('li')).toHaveClass('plan-done')
  })

  it('offers to complete an entry that is not done, and says which task', async () => {
    const onComplete = vi.fn()
    renderDashboard({
      plan: aPlan({ entries: [aPlanEntry({ taskId: 'task-a', title: 'Hub numbers' })] }),
      onComplete,
    })

    await userEvent.click(today().getByRole('button', { name: /complete Hub numbers/i }))

    expect(onComplete).toHaveBeenCalledWith('task-a')
  })

  it('does not offer to complete an entry whose task has been deleted', () => {
    renderDashboard({
      plan: aPlan({ entries: [aPlanEntry({ taskId: null, title: 'Long gone' })] }),
    })

    expect(today().queryByRole('button', { name: /complete/i })).not.toBeInTheDocument()
  })

  /**
   * Steve asked for the "If there is time" panel removed outright, regardless of the mockup: an
   * overflow entry is still offered inline into a fitting agenda gap (spec 05's "would fit" slack
   * row, tested below under "the agenda"), but the panel that used to list the rest of the
   * overflow underneath the agenda is gone, whether or not anything fitted.
   */
  it('does not show an "If there is time" panel for the plan overflow any more', () => {
    renderDashboard({
      plan: aPlan({
        entries: [aPlanEntry({ id: 'entry-1', title: 'Planned work' })],
        overflow: [aPlanEntry({ id: 'entry-2', kind: 'overflow', title: 'Spare capacity work' })],
      }),
    })

    expect(screen.queryByRole('region', { name: /if there is time/i })).not.toBeInTheDocument()
    expect(screen.queryByText('Spare capacity work')).not.toBeInTheDocument()
  })

  it('says nothing about overflow when everything fitted', () => {
    renderDashboard({ plan: aPlan({ entries: [aPlanEntry({})] }) })

    expect(screen.queryByRole('region', { name: /if there is time/i })).not.toBeInTheDocument()
  })

  it('shows the warnings a plan carries rather than leaving them in the database', () => {
    renderDashboard({
      plan: aPlan({ warnings: ['No calendar is connected, so this is a guess.'] }),
    })

    expect(today().getByText(/No calendar is connected/)).toBeInTheDocument()
  })

  it('says the day has no capacity rather than showing an empty list', () => {
    renderDashboard({
      plan: aPlan({
        entries: [],
        capacityMinutes: 0,
        warnings: [
          'There is no free capacity today, so nothing is planned. Everything below is there if the day opens up.',
        ],
      }),
    })

    expect(today().getByText(/no free capacity/i)).toBeInTheDocument()
  })

  /**
   * Issue #22: `applyPlanRules` always warns about a day with no capacity, and that warning
   * renders in the agenda already. The empty state used to repeat "There is no free capacity
   * today, so nothing is planned" verbatim underneath it, saying the same thing twice.
   */
  it('does not repeat the no-capacity message the domain warning already carries', () => {
    renderDashboard({
      plan: aPlan({
        entries: [],
        capacityMinutes: 0,
        warnings: [
          'There is no free capacity today, so nothing is planned. Everything below is there if the day opens up.',
        ],
      }),
    })

    expect(today().getAllByText(/no free capacity/i)).toHaveLength(1)
  })

  /**
   * Issue #22: a zero-capacity day still ranks and returns everything as overflow (nothing can
   * fit), so overflow being non-empty must not make the panel claim "nothing fitted" instead of
   * the more fundamental "no free capacity" reason. This pins the branch order: the capacity
   * check must run before the overflow check.
   */
  it('says there is no free capacity even when a zero-capacity day still has overflow', () => {
    renderDashboard({
      plan: aPlan({
        entries: [],
        capacityMinutes: 0,
        overflow: [aPlanEntry({ id: 'entry-1', kind: 'overflow', title: 'Everything, really' })],
        warnings: [
          'There is no free capacity today, so nothing is planned. Everything below is there if the day opens up.',
        ],
      }),
    })

    expect(today().getByText(/no free capacity/i)).toBeInTheDocument()
    expect(today().queryByText(/nothing fitted/i)).not.toBeInTheDocument()
  })

  /**
   * Issue #22: when there was truly no eligible work, the job's own canned summary already says
   * "Nothing is eligible for planning today." The empty state used to repeat essentially the
   * same claim ("Nothing was eligible for planning today"), so the sentence appeared twice.
   */
  it('does not repeat the job summary when there was nothing eligible to plan', () => {
    renderDashboard({
      plan: aPlan({
        entries: [],
        overflow: [],
        capacityMinutes: 240,
        summary: 'Nothing is eligible for planning today.',
      }),
    })

    expect(today().getAllByText(/nothing (is|was) eligible for planning today/i)).toHaveLength(1)
  })

  /**
   * Issue #22: when the model invented task ids that resolved to nothing, real candidates did
   * exist even though nothing was placed into the plan or its overflow. The empty state used to
   * claim "Nothing was eligible for planning today" regardless, which is false in this case: the
   * job's own summary is what actually explains the (possibly odd) result, and should be shown
   * instead of the blanket claim.
   */
  it('defers to the job summary rather than claiming nothing was eligible, when nothing resolved', () => {
    renderDashboard({
      plan: aPlan({
        entries: [],
        overflow: [],
        capacityMinutes: 240,
        summary: 'Tried to plan two tasks, but neither was one of today’s.',
        warnings: [
          'The model planned "invented-1", which is not one of today\'s tasks, so it was left out.',
        ],
      }),
    })

    expect(
      today().getByText(/Tried to plan two tasks, but neither was one of today’s\./),
    ).toBeInTheDocument()
    expect(today().queryByText(/nothing was eligible/i)).not.toBeInTheDocument()
  })

  /** The one case nothing else on the panel explains: capacity was positive, nothing overflowed,
   * and the job set no summary at all. */
  it('falls back to a neutral empty message when the job set no summary', () => {
    renderDashboard({
      plan: aPlan({ entries: [], overflow: [], capacityMinutes: 240, summary: null }),
    })

    expect(today().getByText(/nothing was placed into today’s plan/i)).toBeInTheDocument()
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

    expect(today().queryByText(/nothing was eligible/i)).not.toBeInTheDocument()
    expect(today().queryByText(/no free capacity/i)).not.toBeInTheDocument()
    expect(today().getByText(/nothing fitted into the free time left/i)).toBeInTheDocument()
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

    expect(today().getByText('Hub weekly')).toBeInTheDocument()
  })

  /** A meeting's end time used to be dropped by the agenda merge: a start time on its own does not
   *  say how much of the day it takes. */
  /** Issue #47's mockup carries a timed event's duration in the trailing label ("30 min,
   *  meeting") rather than a start–end range, matching how a plan entry says its own estimate;
   *  the fact a start time alone cannot give (how much of the day this takes) is still said. */
  it('shows a timed event’s duration alongside its start', () => {
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

    const row = today().getByText('Hub weekly').closest('li')
    expect(row).not.toBeNull()
    expect(row?.textContent).toMatch(/\d{1,2}:\d{2}\s?[AP]?M?/i)
    expect(row?.textContent).toMatch(/1 hour, meeting/)
  })

  /**
   * A real-timed meeting is something to place the "now" rule against whether or not the plan's
   * own entries could be scheduled: `canSchedule` only gates the plan side of the merge, not
   * whether the calendar carried real clock times of its own.
   */
  it('places the "now" marker against a timed meeting even when the plan cannot be scheduled', () => {
    renderDashboard({
      calendar: aCalendarDay({
        capacity: { free: [] },
        events: [
          {
            id: 'event-1',
            calendarId: 'primary',
            summary: 'Hub weekly',
            startsAt: NOW + 30 * 60_000,
            endsAt: NOW + 90 * 60_000,
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
      plan: aPlan({ entries: [aPlanEntry({ id: 'entry-1', title: 'Write the report' })] }),
    })

    const region = screen.getByRole('region', { name: /today/i })
    expect(region.querySelector('.agenda-now')).not.toBeNull()
  })

  /** A declined meeting is still on the diary, and the agenda should say why it costs nothing. */
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

    expect(today().getByText(/declined/i)).toBeInTheDocument()
  })

  it('says the day is clear rather than showing an empty list', () => {
    renderDashboard({ calendar: aCalendarDay({ events: [] }) })

    expect(today().getByText(/nothing in the diary/i)).toBeInTheDocument()
  })

  /**
   * Issue #47: a free gap in the schedule offers the first overflow entry that fits it, sourced
   * from the plan's own overflow list.
   */
  it('offers a fitting overflow entry into a free gap it can be scheduled against', () => {
    const windowStart = NOW
    renderDashboard({
      calendar: aCalendarDay({
        capacity: {
          windowStart,
          windowEnd: windowStart + 120 * 60_000,
          free: [{ start: windowStart, end: windowStart + 120 * 60_000 }],
        },
      }),
      plan: aPlan({
        entries: [aPlanEntry({ id: 'entry-1', estimateMinutes: 20 })],
        overflow: [
          aPlanEntry({
            id: 'overflow-1',
            kind: 'overflow',
            title: 'Tidy the docs index',
            estimateMinutes: 25,
          }),
        ],
      }),
    })

    // Offered exactly once, inline in the gap: there is no "If there is time" panel any more to
    // list it a second time underneath.
    expect(today().getAllByText(/Tidy the docs index/)).toHaveLength(1)
    expect(today().getByText(/would fit/)).toBeInTheDocument()
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

    expect(within(counts).getByText('Inbox').nextElementSibling).toHaveTextContent('2')
    expect(within(counts).getByText('Done').nextElementSibling).toHaveTextContent('1')
  })
})

/** Issue #47: gone quiet, worth a chase and stalled, ranked together, oldest first. */
describe('the needs-you rail', () => {
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

  function rail() {
    return within(screen.getByText('Needs you').closest('section') as HTMLElement)
  }

  /** Criterion 10, on the dashboard: past the threshold, it is listed here as well. */
  it('lists a waiting item past the threshold, naming who and how long, tagged "Gone quiet"', () => {
    renderDashboard({ tasks: [stale, fresh] })

    expect(rail().getByText('Signed contract')).toBeInTheDocument()
    expect(rail().getByText('Legal')).toBeInTheDocument()
    expect(rail().getByText('30 days')).toBeInTheDocument()
    expect(rail().getByText('Gone quiet')).toBeInTheDocument()
  })

  it('leaves out an item that is still within the threshold', () => {
    renderDashboard({ tasks: [stale, fresh] })

    expect(rail().queryByText('Invoice query')).not.toBeInTheDocument()
  })

  /** Exactly three items, one of each kind, so the top-3 cap does not hide any of them: the
   *  ordering claim is about the three kinds sorting together, not about how many fit. */
  it('orders the list oldest first, across gone-quiet, worth-a-chase and stalled alike', () => {
    renderDashboard({
      tasks: [stale],
      projects: [aProject({ id: 'project-1', title: 'Onboarding rewrite', stalled: true })],
      plan: aPlan({
        nudges: [
          aPlanEntry({
            kind: 'nudge',
            id: 'nudge-1',
            title: 'Review: cache eviction (#398)',
            waitingOn: 'Priya',
            waitingSince: NOW - 4 * DAY,
          }),
        ],
      }),
    })

    const titles = rail()
      .getAllByText(/Signed contract|Review: cache eviction|Onboarding rewrite/)
      .map((element) => element.textContent)

    // Oldest first: 30 days, 4 days, then the stalled project with no age at all.
    expect(titles).toEqual([
      'Signed contract',
      'Review: cache eviction (#398)',
      'Onboarding rewrite',
    ])
  })

  it('names a nudge, who it is on, how long, and whether the author has pushed since', () => {
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

    expect(rail().getByText('example-org/example-service#42')).toBeInTheDocument()
    expect(rail().getByText('author-one')).toBeInTheDocument()
    expect(rail().getByText('10 days')).toBeInTheDocument()
    expect(rail().getByText(/pushed since/i)).toBeInTheDocument()
    expect(rail().getByText('Worth a chase')).toBeInTheDocument()
  })

  it('names each stalled project and links to it, tagged "Stalled"', () => {
    renderDashboard({
      projects: [
        aProject({ id: 'project-1', title: 'Ship it', stalled: true }),
        aProject({ id: 'project-2', title: 'Moving along', stalled: false }),
      ],
    })

    expect(rail().getByRole('link', { name: 'Ship it' })).toHaveAttribute(
      'href',
      '#/projects/project-1',
    )
    expect(rail().getByText('Stalled')).toBeInTheDocument()
    expect(rail().queryByText('Moving along')).not.toBeInTheDocument()
  })

  /** Spec 08, criterion 32: the dashboard's stalled-project links carry the rail across too. */
  it('carries the open conversation into the drill-in', () => {
    renderDashboard({
      projects: [aProject({ id: 'project-1', title: 'Ship it', stalled: true, nextAction: null })],
      hash: '#/?conversation=abc',
    })

    expect(rail().getByRole('link', { name: 'Ship it' })).toHaveAttribute(
      'href',
      '#/projects/project-1?conversation=abc',
    )
  })

  /**
   * The rail's one empty message used to claim "nothing is waiting on anyone else" whenever
   * nothing was stale, nudged or stalled, even when a fresher waiting task or an active project
   * was sitting right there. Restoring the old panels' two independent, accurate claims.
   */
  it('says a fresh waiting item is not waited on anyone, distinctly from projects all having a next action', () => {
    renderDashboard({
      tasks: [fresh],
      projects: [aProject({ id: 'project-1', title: 'Moving along', stalled: false })],
    })

    expect(rail().getByText(`Nothing has been waiting longer than 7 days.`)).toBeInTheDocument()
    expect(rail().getByText('Every active project has a next action.')).toBeInTheDocument()
  })

  it('says no projects exist yet, distinctly from nothing waiting at all', () => {
    renderDashboard({ tasks: [], projects: [] })

    expect(rail().getByText('Nothing is waiting on anyone else.')).toBeInTheDocument()
    expect(rail().getByText('No projects yet.')).toBeInTheDocument()
  })

  /** The rail is a triage list, not the whole waiting-on-someone-else set: past three it points
   *  at the board rather than growing without bound. */
  it('shows only the three oldest, oldest first', () => {
    const waitingTasks = ['a', 'b', 'c', 'd', 'e'].map((id, index) =>
      aTask({
        id,
        title: `Waiting ${id}`,
        status: 'waiting',
        waitingOn: 'Someone',
        statusSetAt: NOW - (index + 1) * 10 * DAY,
      }),
    )
    renderDashboard({ tasks: waitingTasks })

    // Oldest first: e (50 days) is oldest, a (10 days) is youngest, so the cap keeps e, d and c.
    expect(rail().getByText('Waiting e')).toBeInTheDocument()
    expect(rail().getByText('Waiting d')).toBeInTheDocument()
    expect(rail().getByText('Waiting c')).toBeInTheDocument()
    expect(rail().queryByText('Waiting b')).not.toBeInTheDocument()
    expect(rail().queryByText('Waiting a')).not.toBeInTheDocument()
  })

  /** Issue #47's exact caption text, now a link so the rest of what is waiting is a click away. */
  it('links the caption to the board, for everything the cap left out', () => {
    renderDashboard({ tasks: [stale, fresh] })

    expect(rail().getByRole('link', { name: 'Everything waiting, oldest first.' })).toHaveAttribute(
      'href',
      '#/board',
    )
  })
})

/**
 * Spec 08, criterion 31. A plan entry is not a fourth kind of item: it names a task, and clicking
 * it opens that task. An entry whose task has been deleted is a record of what was proposed and
 * names nothing to open.
 */
describe('opening a plan entry in the details rail', () => {
  it('opens the entry’s task', async () => {
    const onSelect = vi.fn()
    renderDashboard({
      plan: aPlan({ entries: [aPlanEntry({ taskId: 'task-a', title: 'Hub numbers' })] }),
      onSelect,
    })

    await userEvent.click(today().getByRole('button', { name: 'Hub numbers' }))

    expect(onSelect).toHaveBeenCalledWith({ kind: 'task', id: 'task-a' })
  })

  it('says which entry is the one that is open', () => {
    renderDashboard({
      plan: aPlan({ entries: [aPlanEntry({ taskId: 'task-a', title: 'Hub numbers' })] }),
      selected: { kind: 'task', id: 'task-a' },
    })

    expect(today().getByRole('button', { name: 'Hub numbers' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
  })

  /**
   * Issue #47's mockup draws the open row's own card with the accent border every other open card
   * in the app gets, not only the title inside it with a pressed state: the same `card-open` class
   * Board's task cards use for the rail's currently-open item.
   */
  it('borders the row’s own card, the way every other open card in the app is bordered', () => {
    renderDashboard({
      plan: aPlan({ entries: [aPlanEntry({ taskId: 'task-a', title: 'Hub numbers' })] }),
      selected: { kind: 'task', id: 'task-a' },
    })

    expect(
      today().getByRole('button', { name: 'Hub numbers' }).closest('.agenda-card'),
    ).toHaveClass('card-open')
  })

  it('leaves every other row’s card unbordered', () => {
    renderDashboard({
      plan: aPlan({ entries: [aPlanEntry({ taskId: 'task-a', title: 'Hub numbers' })] }),
      selected: { kind: 'task', id: 'task-b' },
    })

    expect(
      today().getByRole('button', { name: 'Hub numbers' }).closest('.agenda-card'),
    ).not.toHaveClass('card-open')
  })

  it('leaves an entry whose task has been deleted as text', () => {
    renderDashboard({
      plan: aPlan({ entries: [aPlanEntry({ taskId: null, title: 'Something deleted' })] }),
    })

    expect(today().queryByRole('button', { name: 'Something deleted' })).not.toBeInTheDocument()
    expect(today().getByText('Something deleted')).toBeInTheDocument()
  })
})
