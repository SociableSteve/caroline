/**
 * The rules spec 05 says are enforced in code after the model returns rather than trusted to
 * the prompt. Pure, so the model is not needed to assert any of them: criteria 5, 6 and 7 are
 * about what the planner does with an answer, whatever the answer was.
 */
import { describe, expect, it } from 'vitest'
import {
  applyPlanRules,
  chaseNudges,
  planCandidates,
  type PlanCandidate,
  type RankedEntry,
  type WaitingItem,
} from '../../src/domain/plan.js'
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

    const candidates = planCandidates([due, later], END_OF_DAY)

    expect(candidates.map((candidate) => candidate.taskId)).toEqual(['today'])
  })

  it('takes every review, since the review queue is the day job', () => {
    const candidates = planCandidates([aTask({ id: 'pr', status: 'review' })], END_OF_DAY)

    expect(candidates.map((candidate) => candidate.taskId)).toEqual(['pr'])
  })

  it('takes an inbox task that is due today or overdue', () => {
    const overdue = aTask({ id: 'overdue', status: 'inbox', dueAt: NOW - DAY })
    const undated = aTask({ id: 'undated', status: 'inbox' })

    const candidates = planCandidates([overdue, undated], END_OF_DAY)

    expect(candidates.map((candidate) => candidate.taskId)).toEqual(['overdue'])
  })

  it.each(['someday', 'reference', 'waiting', 'done'] as const)(
    'leaves out a %s task even when it is due today',
    (status) => {
      const task = aTask({ id: 'excluded', status, dueAt: NOW })

      expect(planCandidates([task], END_OF_DAY)).toEqual([])
    },
  )

  it('carries the estimate and the due date the rules need', () => {
    const task = aTask({ id: 'a', estimateMinutes: 45, dueAt: NOW })

    expect(planCandidates([task], END_OF_DAY)[0]).toMatchObject({
      taskId: 'a',
      estimateMinutes: 45,
      dueAt: NOW,
      status: 'next_action',
    })
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

    expect(result.warnings).toHaveLength(1)
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

    expect(result.warnings.join(' ')).toMatch(/did not fit/i)
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
