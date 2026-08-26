/**
 * The rules spec 05 says are enforced in code after the model returns rather than trusted to
 * the prompt. Pure, so the model is not needed to assert any of them: criteria 5, 6 and 7 are
 * about what the planner does with an answer, whatever the answer was.
 */
import { describe, expect, it } from 'vitest'
import {
  applyPlanRules,
  blockedNudges,
  chaseNudges,
  planCandidates,
  scheduleDay,
  type PlanCandidate,
  type RankedEntry,
  type SchedulableEntry,
  type ScheduledEntry,
  type WaitingItem,
} from '../../src/domain/plan.js'
import type { Interval } from '../../src/domain/capacity.js'
import type { Task } from '../../src/domain/task.js'

const NOW = Date.UTC(2026, 5, 8, 9, 0, 0)
const DAY = 24 * 60 * 60_000
/** The end of the planned day, which is what "due today" is measured against. */
const END_OF_DAY = Date.UTC(2026, 5, 8, 23, 59, 59)

function aTask(overrides: Partial<Task> & { id: string }): Task {
  return {
    title: `Task ${overrides.id}`,
    notes: null,
    status: 'next_action',
    projectId: null,
    sortOrder: 0,
    estimateMinutes: null,
    dueAt: null,
    blockedBy: null,
    deferUntil: null,
    waitingOn: null,
    statusSetBy: 'user',
    statusSetAt: NOW,
    previousStatus: null,
    previousStatusSetBy: null,
    syncTracked: false,
    createdAt: NOW,
    updatedAt: NOW,
    completedAt: null,
    ...overrides,
  }
}

function aCandidate(overrides: Partial<PlanCandidate> & { taskId: string }): PlanCandidate {
  return {
    title: `Task ${overrides.taskId}`,
    status: 'next_action',
    estimateMinutes: null,
    dueAt: null,
    projectId: null,
    ...overrides,
  }
}

function ranked(taskId: string, estimateMinutes: number | null = null): RankedEntry {
  return { taskId, rationale: `because of ${taskId}`, estimateMinutes }
}

function applyTo(
  entries: readonly RankedEntry[],
  candidates: readonly PlanCandidate[],
  capacityMinutes = 240,
) {
  return applyPlanRules({
    ranked: entries,
    candidates,
    capacityMinutes,
    defaultEstimateMinutes: 30,
    dueBy: END_OF_DAY,
  })
}

describe('choosing the candidates', () => {
  it('takes every next action that is not deferred past today', () => {
    const due = aTask({ id: 'today', deferUntil: NOW + 60_000 })
    const later = aTask({ id: 'later', deferUntil: END_OF_DAY + DAY })

    const candidates = planCandidates([due, later], END_OF_DAY, { includeReviews: true })

    expect(candidates.map((candidate) => candidate.taskId)).toEqual(['today'])
  })

  it('takes every review, since the review queue is the day job', () => {
    const candidates = planCandidates([aTask({ id: 'pr', status: 'review' })], END_OF_DAY, {
      includeReviews: true,
    })

    expect(candidates.map((candidate) => candidate.taskId)).toEqual(['pr'])
  })

  it('takes an inbox task that is due today or overdue', () => {
    const overdue = aTask({ id: 'overdue', status: 'inbox', dueAt: NOW - DAY })
    const undated = aTask({ id: 'undated', status: 'inbox' })

    const candidates = planCandidates([overdue, undated], END_OF_DAY, { includeReviews: true })

    expect(candidates.map((candidate) => candidate.taskId)).toEqual(['overdue'])
  })

  it.each(['someday', 'reference', 'waiting', 'done'] as const)(
    'leaves out a %s task even when it is due today',
    (status) => {
      const task = aTask({ id: 'excluded', status, dueAt: NOW })

      expect(planCandidates([task], END_OF_DAY, { includeReviews: true })).toEqual([])
    },
  )

  it('carries the estimate and the due date the rules need', () => {
    const task = aTask({ id: 'a', estimateMinutes: 45, dueAt: NOW })

    expect(planCandidates([task], END_OF_DAY, { includeReviews: true })[0]).toMatchObject({
      taskId: 'a',
      estimateMinutes: 45,
      dueAt: NOW,
      status: 'next_action',
    })
  })
})

/**
 * Criterion 18. `planning.includeReviews` is a config value, for somebody whose code review is
 * handled elsewhere. Off means no review reaches the plan at all, and the deadline branch is the
 * case worth naming: a review is taken on its status before its dates are looked at, so excluding
 * reviews has to exclude an overdue one too rather than letting it back in as urgent.
 */
describe('choosing the candidates with reviews excluded', () => {
  it('leaves out a review that has no deadline', () => {
    const reviewWithoutDeadline = aTask({ id: 'pr', status: 'review' })

    expect(planCandidates([reviewWithoutDeadline], END_OF_DAY, { includeReviews: false })).toEqual(
      [],
    )
  })

  it('leaves out a review that is due today or overdue', () => {
    const reviewDueToday = aTask({ id: 'pr-due', status: 'review', dueAt: NOW })
    const overdueReview = aTask({ id: 'pr-overdue', status: 'review', dueAt: NOW - DAY })

    expect(
      planCandidates([reviewDueToday, overdueReview], END_OF_DAY, { includeReviews: false }),
    ).toEqual([])
  })

  it('leaves the rest of the candidates for the day exactly as they were', () => {
    const nextAction = aTask({ id: 'next' })
    const overdueInbox = aTask({ id: 'overdue', status: 'inbox', dueAt: NOW - DAY })
    const review = aTask({ id: 'pr', status: 'review' })
    const tasks = [nextAction, overdueInbox, review]

    const excluded = planCandidates(tasks, END_OF_DAY, { includeReviews: false })
    const included = planCandidates(tasks, END_OF_DAY, { includeReviews: true })

    expect(excluded.map((candidate) => candidate.taskId)).toEqual(['next', 'overdue'])
    expect(included.map((candidate) => candidate.taskId)).toEqual(['next', 'overdue', 'pr'])
  })
})

describe('the estimate a plan entry is fitted with', () => {
  it('uses the one the model gave', () => {
    const result = applyTo([ranked('a', 45)], [aCandidate({ taskId: 'a' })])

    expect(result.entries[0]?.estimateMinutes).toBe(45)
  })

  it('falls back to the task’s own when the model gave none', () => {
    const result = applyTo([ranked('a')], [aCandidate({ taskId: 'a', estimateMinutes: 90 })])

    expect(result.entries[0]?.estimateMinutes).toBe(90)
  })

  /** Spec 05: a task with no estimate uses the configured default so it can still be fitted. */
  it('falls back to the configured default when neither has one', () => {
    const result = applyTo([ranked('a')], [aCandidate({ taskId: 'a' })])

    expect(result.entries[0]?.estimateMinutes).toBe(30)
  })
})

describe('what the model is not allowed to get away with', () => {
  it('drops an entry naming a task that was never a candidate, and says so', () => {
    const result = applyTo([ranked('ghost'), ranked('a')], [aCandidate({ taskId: 'a' })])

    expect(result.entries.map((entry) => entry.taskId)).toEqual(['a'])
    expect(result.warnings.join(' ')).toMatch(/ghost/)
  })

  it('warns only once when the same invented task id is listed twice', () => {
    const result = applyTo([ranked('ghost'), ranked('ghost')], [aCandidate({ taskId: 'a' })])

    expect(result.warnings).toEqual([expect.stringMatching(/ghost/)])
  })

  it('keeps the first of a task listed twice', () => {
    const result = applyTo([ranked('a', 30), ranked('a', 60)], [aCandidate({ taskId: 'a' })])

    expect(result.entries).toHaveLength(1)
    expect(result.entries[0]?.estimateMinutes).toBe(30)
  })

  it('numbers the ranks from one, in the order the entries end up in', () => {
    const result = applyTo(
      [ranked('a'), ranked('b')],
      [aCandidate({ taskId: 'a' }), aCandidate({ taskId: 'b' })],
    )

    expect(result.entries.map((entry) => entry.rank)).toEqual([1, 2])
  })
})

/** Criterion 6. */
describe('urgency', () => {
  it('puts an overdue task before a discretionary next action the model ranked first', () => {
    const result = applyTo(
      [ranked('discretionary'), ranked('overdue')],
      [
        aCandidate({ taskId: 'discretionary' }),
        aCandidate({ taskId: 'overdue', dueAt: NOW - DAY }),
      ],
    )

    expect(result.entries.map((entry) => entry.taskId)).toEqual(['overdue', 'discretionary'])
  })

  it('treats a task due today as urgent', () => {
    const result = applyTo(
      [ranked('discretionary'), ranked('today')],
      [aCandidate({ taskId: 'discretionary' }), aCandidate({ taskId: 'today', dueAt: END_OF_DAY })],
    )

    expect(result.entries[0]?.taskId).toBe('today')
  })

  it('leaves the model’s order alone within the urgent group', () => {
    const result = applyTo(
      [ranked('second'), ranked('first')],
      [
        aCandidate({ taskId: 'second', dueAt: NOW - DAY }),
        aCandidate({ taskId: 'first', dueAt: NOW - 2 * DAY }),
      ],
    )

    expect(result.entries.map((entry) => entry.taskId)).toEqual(['second', 'first'])
  })

  it('does not treat a task due tomorrow as urgent', () => {
    const result = applyTo(
      [ranked('discretionary'), ranked('tomorrow')],
      [
        aCandidate({ taskId: 'discretionary' }),
        aCandidate({ taskId: 'tomorrow', dueAt: END_OF_DAY + DAY }),
      ],
    )

    expect(result.entries[0]?.taskId).toBe('discretionary')
  })
})

/** Criterion 5. */
describe('fitting the day', () => {
  it('never plans more minutes than there is capacity for', () => {
    const result = applyTo(
      [ranked('a', 120), ranked('b', 120), ranked('c', 120)],
      ['a', 'b', 'c'].map((taskId) => aCandidate({ taskId })),
      240,
    )

    const planned = result.entries.reduce((total, entry) => total + entry.estimateMinutes, 0)

    expect(planned).toBeLessThanOrEqual(240)
    expect(result.entries.map((entry) => entry.taskId)).toEqual(['a', 'b'])
  })

  it('moves what does not fit to overflow rather than dropping it', () => {
    const result = applyTo(
      [ranked('a', 120), ranked('b', 120), ranked('c', 120)],
      ['a', 'b', 'c'].map((taskId) => aCandidate({ taskId })),
      240,
    )

    expect(result.overflow.map((entry) => entry.taskId)).toEqual(['c'])
  })

  it('numbers overflow ranks from one in their own right', () => {
    const result = applyTo(
      [ranked('a', 240), ranked('b', 60), ranked('c', 60)],
      ['a', 'b', 'c'].map((taskId) => aCandidate({ taskId })),
      240,
    )

    expect(result.overflow.map((entry) => entry.rank)).toEqual([1, 2])
  })

  /**
   * An entry too big for the whole day would otherwise block everything behind it. It goes to
   * overflow and the smaller work after it is still planned.
   */
  it('steps over an entry larger than the day and keeps fitting the rest', () => {
    const result = applyTo(
      [ranked('huge', 600), ranked('small', 30)],
      [aCandidate({ taskId: 'huge' }), aCandidate({ taskId: 'small' })],
      240,
    )

    expect(result.entries.map((entry) => entry.taskId)).toEqual(['small'])
    expect(result.overflow.map((entry) => entry.taskId)).toEqual(['huge'])
  })

  /**
   * Criterion 16. The overflow list is on the screen, but a reader is looking at the plan, and
   * "this is all of it" and "this is as much of it as fitted" are different claims.
   */
  it('warns that something did not fit rather than only listing it', () => {
    const result = applyTo(
      [ranked('a', 120), ranked('b', 120), ranked('c', 120)],
      ['a', 'b', 'c'].map((taskId) => aCandidate({ taskId })),
      240,
    )

    const overflowWarning = result.warnings.find((warning) => /did not fit/i.test(warning))
    expect(overflowWarning).toBeDefined()
    // Criterion 16: no count and no number of minutes, so the warning cannot come to disagree
    // with the overflow list or the capacity drawn beside it. Scoped to this specific warning
    // rather than every warning in the scenario: a different warning (an invented task id, for
    // example) interpolates the id verbatim and could legitimately contain digit-like characters.
    expect(overflowWarning).not.toMatch(/\d/)
  })

  it('says nothing of the sort when the whole answer fitted', () => {
    const result = applyTo([ranked('a', 30)], [aCandidate({ taskId: 'a' })], 240)

    expect(result.warnings).toEqual([])
  })

  /**
   * A day with no capacity already has a warning about it, and it is the reason nothing fitted.
   * Two sentences saying so is one more than the reader needs.
   */
  it('leaves a day with no capacity its own single warning', () => {
    const result = applyTo([ranked('a', 30)], [aCandidate({ taskId: 'a' })], 0)

    expect(result.warnings).toHaveLength(1)
    expect(result.warnings.join(' ')).toMatch(/no free capacity/i)
  })

  /** Spec 05: a day with no capacity produces a plan with no work items and says so. */
  it('plans nothing at all when capacity is zero or negative', () => {
    const result = applyTo([ranked('a', 30)], [aCandidate({ taskId: 'a' })], -20)

    expect(result.entries).toEqual([])
    expect(result.overflow.map((entry) => entry.taskId)).toEqual(['a'])
    expect(result.warnings.join(' ')).toMatch(/no free capacity/i)
  })
})

/** Criterion 7. */
describe('not starving the review queue', () => {
  const reviewCandidate = aCandidate({ taskId: 'pr', status: 'review', estimateMinutes: 30 })

  it('promotes a review the model buried below the capacity line', () => {
    const result = applyTo(
      [ranked('a', 120), ranked('b', 120), ranked('pr')],
      [aCandidate({ taskId: 'a' }), aCandidate({ taskId: 'b' }), reviewCandidate],
      240,
    )

    expect(result.entries.map((entry) => entry.taskId)).toContain('pr')
  })

  it('plans a review the model left out of its answer entirely', () => {
    const result = applyTo([ranked('a', 120)], [aCandidate({ taskId: 'a' }), reviewCandidate], 240)

    expect(result.entries.map((entry) => entry.taskId)).toContain('pr')
  })

  it('leaves the urgent work in front of the promoted review', () => {
    const result = applyTo(
      [ranked('overdue', 60), ranked('pr')],
      [aCandidate({ taskId: 'overdue', dueAt: NOW - DAY }), reviewCandidate],
      240,
    )

    expect(result.entries.map((entry) => entry.taskId)).toEqual(['overdue', 'pr'])
  })

  it('does not promote one when capacity does not allow it', () => {
    const result = applyTo(
      [ranked('a', 20)],
      [
        aCandidate({ taskId: 'a' }),
        aCandidate({ taskId: 'pr', status: 'review', estimateMinutes: 300 }),
      ],
      20,
    )

    expect(result.entries.map((entry) => entry.taskId)).toEqual(['a'])
  })

  it('does nothing when the review queue is empty', () => {
    const result = applyTo([ranked('a', 30)], [aCandidate({ taskId: 'a' })])

    expect(result.entries).toHaveLength(1)
  })

  it('does nothing when a review is already planned', () => {
    const result = applyTo(
      [ranked('pr', 30)],
      [reviewCandidate, aCandidate({ taskId: 'other', status: 'review' })],
    )

    expect(result.entries.map((entry) => entry.taskId)).toEqual(['pr'])
  })

  /**
   * Criterion 18. With reviews excluded the candidates carry none, and the never-starve rule has
   * to stay quiet rather than be the thing that puts one back. It is asserted here as well as at
   * the candidate list, because this is the rule that could resurrect a review nobody offered:
   * excluding them upstream is only a guarantee if nothing downstream reaches past the list.
   */
  it('plans no review at all when the candidates carry none, whatever the model asked for', () => {
    const result = applyTo([ranked('a', 30), ranked('pr', 30)], [aCandidate({ taskId: 'a' })], 240)

    expect(result.entries.map((entry) => entry.taskId)).toEqual(['a'])
    expect(result.overflow).toEqual([])
    expect(result.warnings.join(' ')).toContain('"pr"')
  })
})

/** Criteria 11 and 12. Nudges are prompts to decide, so none of them consumes capacity. */
describe('chase nudges', () => {
  function waiting(overrides: Partial<WaitingItem> & { taskId: string }): WaitingItem {
    return {
      title: `Waiting ${overrides.taskId}`,
      waitingOn: 'Sam',
      waitingSince: NOW - 30 * DAY,
      pushedSinceReview: false,
      isPullRequest: false,
      ...overrides,
    }
  }

  it('names the item, the person and how long it has been', () => {
    const nudges = chaseNudges([waiting({ taskId: 'a' })], NOW, 7)

    expect(nudges[0]).toMatchObject({
      taskId: 'a',
      waitingOn: 'Sam',
      waitingDays: 30,
    })
  })

  it('leaves out an item still inside the threshold', () => {
    expect(chaseNudges([waiting({ taskId: 'a', waitingSince: NOW - DAY })], NOW, 7)).toEqual([])
  })

  it('includes one exactly on the threshold, since that is when it becomes a chase', () => {
    expect(
      chaseNudges([waiting({ taskId: 'a', waitingSince: NOW - 7 * DAY })], NOW, 7),
    ).toHaveLength(1)
  })

  it('orders them oldest first, which is the point of a chase list', () => {
    const nudges = chaseNudges(
      [
        waiting({ taskId: 'newer', waitingSince: NOW - 10 * DAY }),
        waiting({ taskId: 'older', waitingSince: NOW - 40 * DAY }),
      ],
      NOW,
      7,
    )

    expect(nudges.map((nudge) => nudge.taskId)).toEqual(['older', 'newer'])
  })

  /** Criterion 12: a reviewed pull request the author has not answered is still a nudge. */
  it('says whether the author has pushed since you reviewed', () => {
    const nudges = chaseNudges(
      [waiting({ taskId: 'pr', isPullRequest: true, pushedSinceReview: true })],
      NOW,
      7,
    )

    expect(nudges[0]).toMatchObject({ isPullRequest: true, pushedSinceReview: true })
  })

  it('says nobody is named rather than inventing a person', () => {
    const nudges = chaseNudges([waiting({ taskId: 'a', waitingOn: null })], NOW, 7)

    expect(nudges[0]?.waitingOn).toBeNull()
  })
})

/**
 * Criterion 20. Blocked work is never today's work, and an overdue one comes back as a nudge
 * rather than vanishing, because something vanishing quietly is the failure this is here to stop.
 */
describe('blocked work', () => {
  it('is never a candidate, even due today', () => {
    const candidates = planCandidates(
      [
        aTask({ id: 'blocked', status: 'blocked', blockedBy: 'blocker', dueAt: END_OF_DAY }),
        aTask({ id: 'open', status: 'next_action' }),
      ],
      END_OF_DAY,
      { includeReviews: true },
    )

    expect(candidates.map((candidate) => candidate.taskId)).toEqual(['open'])
  })

  /**
   * The catch-all limb at the foot of the candidate rule is what this is really about: a status
   * absent from `neverPlanned` falls into it and is planned on the strength of a deadline alone.
   */
  it('is not a candidate when it is overdue either', () => {
    const overdue = aTask({
      id: 'blocked',
      status: 'blocked',
      blockedBy: 'blocker',
      dueAt: END_OF_DAY - DAY,
    })

    expect(planCandidates([overdue], END_OF_DAY, { includeReviews: true })).toEqual([])
  })

  const blocked = (overrides: { taskId: string; dueAt: number | null; blockerTitle?: string }) => ({
    title: `Task ${overrides.taskId}`,
    blockedSince: NOW - DAY,
    blockerTitle: overrides.blockerTitle ?? 'Sign the contract',
    ...overrides,
  })

  it('returns as a nudge once its deadline has arrived, naming what it is behind', () => {
    const nudges = blockedNudges([blocked({ taskId: 'a', dueAt: END_OF_DAY })], END_OF_DAY)

    expect(nudges).toEqual([
      expect.objectContaining({ taskId: 'a', blockerTitle: 'Sign the contract' }),
    ])
  })

  it('is not a nudge while its deadline is still ahead, or absent', () => {
    const items = [
      blocked({ taskId: 'later', dueAt: END_OF_DAY + DAY }),
      blocked({ taskId: 'undated', dueAt: null }),
    ]

    expect(blockedNudges(items, END_OF_DAY)).toEqual([])
  })

  it('puts the most urgent deadline first', () => {
    const nudges = blockedNudges(
      [
        blocked({ taskId: 'today', dueAt: END_OF_DAY }),
        blocked({ taskId: 'last week', dueAt: END_OF_DAY - 7 * DAY }),
      ],
      END_OF_DAY,
    )

    expect(nudges.map((nudge) => nudge.taskId)).toEqual(['last week', 'today'])
  })
})

/**
 * Spec 05, criteria 21 to 24: the plan is generated once, but placing it against a clock time is a
 * walk done wherever it is read, and it has to answer honestly for whatever moment that is. Issue
 * #82: reading a plan generated in the morning, later in the day, used to draw outstanding work
 * behind the present moment because the walk had no notion of "now" at all.
 */
describe('scheduleDay', () => {
  const MINUTE = 60_000
  const WINDOW_START = NOW
  const WINDOW_END = WINDOW_START + 480 * MINUTE

  interface Entry extends SchedulableEntry {
    readonly id: string
  }

  function entry(id: string, estimateMinutes: number | null, done = false): Entry {
    return { id, estimateMinutes, done }
  }

  /** `[id, minutes from WINDOW_START, or null]` for each scheduled entry, in the order returned. */
  function placements(scheduled: readonly ScheduledEntry<Entry>[]): Array<[string, number | null]> {
    return scheduled.map(({ entry: placed, startsAt }) => [
      placed.id,
      startsAt === null ? null : (startsAt - WINDOW_START) / MINUTE,
    ])
  }

  /** `[minutes from WINDOW_START, minutes long]` for each gap, in order. */
  function gapShapes(
    gaps: readonly { startsAt: number; endsAt: number }[],
  ): Array<[number, number]> {
    return gaps.map((gap) => [
      (gap.startsAt - WINDOW_START) / MINUTE,
      (gap.endsAt - gap.startsAt) / MINUTE,
    ])
  }

  it('places an outstanding entry at or after now rather than at the top of the window (criterion 21)', () => {
    const now = WINDOW_START + 300 * MINUTE
    const result = scheduleDay([entry('a', 30)], [{ start: WINDOW_START, end: WINDOW_END }], now)

    expect(placements(result.scheduled)).toEqual([['a', 300]])
  })

  it('keeps a completed entry at its own placement once now has moved past it (criterion 22)', () => {
    const now = WINDOW_START + 300 * MINUTE
    const result = scheduleDay(
      [entry('done', 30, true)],
      [{ start: WINDOW_START, end: WINDOW_END }],
      now,
    )

    // Not dragged to `now`: it happened at the top of the window, and stays there.
    expect(placements(result.scheduled)).toEqual([['done', 0]])
  })

  it('places a done entry at the top of the window even when it ranks after an outstanding one (criterion 22)', () => {
    // Nothing has elapsed, so any difference from a single-pass rank-order walk comes from the
    // done entry taking the top of the window regardless of its rank, not from the clock.
    const now = WINDOW_START
    const freeIntervals: Interval[] = [{ start: WINDOW_START, end: WINDOW_START + 100 * MINUTE }]

    const result = scheduleDay(
      [entry('outstanding', 40), entry('done', 20, true)],
      freeIntervals,
      now,
    )

    // The done entry claims the first 20 minutes regardless of rank; the outstanding entry, ranked
    // first, is placed into what is left rather than at the top.
    expect(placements(result.scheduled)).toEqual([
      ['outstanding', 20],
      ['done', 0],
    ])
  })

  it("does not place outstanding work into minutes a done entry's block already consumed, including where that block straddles now (criterion 23)", () => {
    // A 30-minute done entry from the top of the window, with `now` fifteen minutes in: the block
    // straddles the present moment. A floor at `now` alone would offer the outstanding entry the
    // minutes from 15 to 30, which the done entry already has.
    const now = WINDOW_START + 15 * MINUTE
    const freeIntervals: Interval[] = [{ start: WINDOW_START, end: WINDOW_START + 100 * MINUTE }]

    const result = scheduleDay(
      [entry('outstanding', 20), entry('done', 30, true)],
      freeIntervals,
      now,
    )

    expect(placements(result.scheduled)).toEqual([
      ['outstanding', 30],
      ['done', 0],
    ])
  })

  it('offers no gap for a free interval entirely behind now, and trims one that straddles it (criterion 23)', () => {
    const now = WINDOW_START + 50 * MINUTE
    const freeIntervals: Interval[] = [
      // Wholly elapsed: offers nothing, and is not reported as a gap at all.
      { start: WINDOW_START, end: WINDOW_START + 20 * MINUTE },
      // Straddles now: only the part still ahead of it is a gap.
      { start: WINDOW_START + 30 * MINUTE, end: WINDOW_START + 80 * MINUTE },
    ]

    const result = scheduleDay([], freeIntervals, now)

    expect(gapShapes(result.gaps)).toEqual([[50, 30]])
  })

  it('returns an outstanding entry without a placement, rather than dropping it, when it no longer fits past now (criterion 24)', () => {
    const now = WINDOW_START + 470 * MINUTE
    const result = scheduleDay(
      [entry('too-big-now', 30)],
      [{ start: WINDOW_START, end: WINDOW_END }],
      now,
    )

    expect(placements(result.scheduled)).toEqual([['too-big-now', null]])
    // The ten minutes left past `now` are real free time, just not enough for this entry: they are
    // still reported as a gap rather than swallowed along with the entry that could not use them.
    expect(gapShapes(result.gaps)).toEqual([[470, 10]])
  })

  it('behaves exactly as a single top-of-window walk when now is before the window opens', () => {
    const now = WINDOW_START - 60 * MINUTE
    const freeIntervals: Interval[] = [{ start: WINDOW_START, end: WINDOW_START + 100 * MINUTE }]

    const result = scheduleDay([entry('a', 30), entry('b', 45)], freeIntervals, now)

    expect(placements(result.scheduled)).toEqual([
      ['a', 0],
      ['b', 30],
    ])
    expect(gapShapes(result.gaps)).toEqual([[75, 25]])
  })

  it('places no outstanding work and offers no gaps once now is past the window, while a done entry keeps its own placement', () => {
    const now = WINDOW_END + MINUTE
    const freeIntervals: Interval[] = [{ start: WINDOW_START, end: WINDOW_END }]

    const result = scheduleDay(
      [entry('done', 30, true), entry('outstanding', 30)],
      freeIntervals,
      now,
    )

    expect(placements(result.scheduled)).toEqual([
      ['done', 0],
      ['outstanding', null],
    ])
    expect(result.gaps).toEqual([])
  })
})
