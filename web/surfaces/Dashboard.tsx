/**
 * The dashboard: today's plan, today's calendar with the busy and free blocks visible, a
 * capacity bar showing planned against available, counts per status, the chase list, stalled
 * projects and the last-run state of each job. Spec 08.
 *
 * Criterion 4: with no plan, no calendar and no integrations configured it shows empty states
 * rather than errors, because that is the state a clean checkout is in.
 *
 * Criterion 6: the capacity bar's numbers are the ones `GET /api/calendar` gave. They are not
 * recomputed here, so the two cannot disagree.
 */
import { taskStatuses } from '../api.js'
import type {
  CalendarDay,
  CalendarEventView,
  CapacityView,
  Health,
  JobRun,
  PlanEntryView,
  PlanHistoryDay,
  PlanView,
  ProjectView,
  TaskView,
} from '../api.js'
import {
  byOldestFirst,
  formatAge,
  formatEstimate,
  formatTimeOfDay,
  isStale,
  statusLabel,
  waitingAge,
} from '../format.js'
import { projectHref } from '../router.js'

export interface DashboardProps {
  readonly tasks: readonly TaskView[]
  readonly projects: readonly ProjectView[]
  readonly health: Health | null
  /** Recent runs, most recent first. Only the latest of each job is shown. */
  readonly jobRuns: readonly JobRun[]
  /** Today's plan, or null when none has been drawn. Spec 05. */
  readonly plan: PlanView | null
  /** Planned against completed for the last fortnight. Spec 05. */
  readonly history: readonly PlanHistoryDay[]
  readonly calendar: CalendarDay | null
  readonly staleDays: number
  readonly now: number
  readonly onRegeneratePlan: () => void
  /** True while a regeneration is in flight, so a second click cannot start another. */
  readonly regenerating?: boolean
  readonly onComplete: (taskId: string) => void
}

/** One row per job: the history is long, and what the dashboard answers is "is it working". */
function latestRunPerJob(runs: readonly JobRun[]): JobRun[] {
  const latest = new Map<string, JobRun>()
  for (const run of runs) {
    if (!latest.has(run.job)) latest.set(run.job, run)
  }

  return [...latest.values()].sort((first, second) => (first.job < second.job ? -1 : 1))
}

const integrationNames: Record<string, string> = {
  github: 'GitHub',
  google: 'Google',
  llm: 'LLM provider',
}

/** What the plan has committed to. The bar compares it against the capacity it was drawn for. */
function plannedMinutes(plan: PlanView | null): number {
  return (plan?.entries ?? []).reduce((total, entry) => total + (entry.estimateMinutes ?? 0), 0)
}

/** Why an event took no time off the day, in the words the calendar itself used. */
function whyFree(event: CalendarEventView): string | null {
  if (event.consumesCapacity) return null
  if (event.status === 'cancelled') return 'cancelled'
  if (event.responseStatus === 'declined') return 'declined'
  if (event.transparency === 'transparent') return 'marked free'
  if (event.allDay) return 'all day'

  return 'not counted'
}

function PlanEntryLine({
  entry,
  onComplete,
}: {
  readonly entry: PlanEntryView
  readonly onComplete: (taskId: string) => void
}) {
  return (
    <li className={entry.done ? 'plan-entry plan-done' : 'plan-entry'}>
      <span className="plan-rank">{entry.rank}</span>
      <span className="plan-title">{entry.title}</span>
      {entry.rationale !== null && <span className="plan-why">{entry.rationale}</span>}
      {entry.estimateMinutes !== null && (
        <span className="plan-estimate">{formatEstimate(entry.estimateMinutes)}</span>
      )}
      {/* Done is said in text as well as in the styling: colour is never the only carrier of
          meaning. Spec 08. */}
      {entry.done && <span className="plan-state">done</span>}
      {/* An entry whose task has been deleted is a record of what was proposed, and there is
          nothing left to complete. */}
      {!entry.done && entry.taskId !== null && (
        <button type="button" onClick={() => onComplete(entry.taskId as string)}>
          Complete {entry.title}
        </button>
      )}
    </li>
  )
}

/**
 * Planned against available. Spec 08 criterion 6: the numbers are the ones `GET /api/calendar`
 * gave, never recomputed here, so the bar and the route cannot disagree.
 */
function CapacityBar({
  capacity,
  planned,
}: {
  readonly capacity: CapacityView
  readonly planned: number
}) {
  if (!capacity.workingDay) {
    return <p className="empty">Today is not a working day, so there is no capacity to plan.</p>
  }

  const free = Math.max(0, capacity.capacityMinutes)

  return (
    <p className="capacity">
      {/* The numbers in text as well as in the bar, so the bar is not the only carrier of the
          meaning. Spec 08's accessibility rules. */}
      <span>
        {formatEstimate(planned)} planned of {formatEstimate(free)} free
      </span>
      {/* A day with no free capacity gets no meter. A meter whose minimum and maximum are both
          zero is not a range, and a screen reader announcing it has nothing to say; the text
          above and the detail below carry the whole answer on their own. */}
      {free > 0 && (
        <span
          role="meter"
          aria-label="Capacity used"
          aria-valuenow={planned}
          aria-valuemin={0}
          aria-valuemax={free}
          className="capacity-bar"
        >
          <span
            className="capacity-used"
            style={{ width: `${Math.min(100, (planned / free) * 100)}%` }}
          />
        </span>
      )}
      <span className="capacity-detail">
        {formatEstimate(capacity.windowMinutes)} of working day, less{' '}
        {formatEstimate(capacity.busyMinutes)} of meetings and{' '}
        {formatEstimate(capacity.reserveMinutes)} held back
      </span>
    </p>
  )
}

export function Dashboard({
  tasks,
  projects,
  health,
  jobRuns,
  plan,
  history,
  calendar,
  staleDays,
  now,
  onRegeneratePlan,
  regenerating = false,
  onComplete,
}: DashboardProps) {
  const latestRuns = latestRunPerJob(jobRuns)
  const counts = new Map(
    taskStatuses.map((status) => [status, tasks.filter((task) => task.status === status).length]),
  )
  const waiting = tasks.filter((task) => task.status === 'waiting').sort(byOldestFirst)
  const quiet = waiting.filter((task) => isStale(task, now, staleDays))
  const stalled = projects.filter((project) => project.stalled)
  const planned = plannedMinutes(plan)

  return (
    <div className="dashboard">
      <section aria-labelledby="counts-heading">
        <h2 id="counts-heading">Where everything is</h2>
        <ul className="counts">
          {taskStatuses.map((status) => (
            <li key={status}>
              <span className="count">{counts.get(status) ?? 0}</span>
              <span>{statusLabel(status)}</span>
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="plan-heading">
        <h2 id="plan-heading">Today’s plan</h2>
        <button type="button" onClick={onRegeneratePlan} disabled={regenerating}>
          {regenerating ? 'Regenerating' : 'Regenerate'}
        </button>

        {plan === null ? (
          <p className="empty">
            No plan yet. The planner runs each morning, and needs an LLM provider configured.
          </p>
        ) : (
          <>
            {plan.summary !== null && <p className="plan-summary">{plan.summary}</p>}

            {/* A plan that had to leave something out says so here rather than in the
                database. Spec 05. */}
            {plan.warnings.length > 0 && (
              <ul className="plan-warnings">
                {plan.warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            )}

            {plan.entries.length === 0 ? (
              <p className="empty">
                {plan.capacityMinutes <= 0
                  ? 'There is no free capacity today, so nothing is planned.'
                  : 'Nothing was eligible for planning today.'}
              </p>
            ) : (
              <ul className="plan-list">
                {plan.entries.map((entry) => (
                  <PlanEntryLine key={entry.id} entry={entry} onComplete={onComplete} />
                ))}
              </ul>
            )}
          </>
        )}
      </section>

      {/* Spec 05: excess is offered rather than dropped, and offered as what it is. */}
      {plan !== null && plan.overflow.length > 0 && (
        <section aria-labelledby="overflow-heading">
          <h2 id="overflow-heading">If there is time</h2>
          <ul className="plan-list">
            {plan.overflow.map((entry) => (
              <PlanEntryLine key={entry.id} entry={entry} onComplete={onComplete} />
            ))}
          </ul>
        </section>
      )}

      {/* A nudge names the item, who it is waiting on and for how long, and for a reviewed
          pull request whether the author has pushed since. Spec 05, criteria 11 and 12. */}
      {plan !== null && plan.nudges.length > 0 && (
        <section aria-labelledby="chase-heading">
          <h2 id="chase-heading">Worth a chase</h2>
          <ul className="chase-list">
            {plan.nudges.map((nudge) => (
              <li key={nudge.id}>
                <span className="chase-title">{nudge.title}</span>
                <span className="chase-who">{nudge.waitingOn ?? 'nobody named'}</span>
                {nudge.waitingSince !== null && (
                  <span className="chase-age">
                    {formatAge(Math.max(0, now - nudge.waitingSince))}
                  </span>
                )}
                {nudge.pushedSinceReview && (
                  <span className="chase-pushed">the author has pushed since you reviewed</span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section aria-labelledby="calendar-heading">
        <h2 id="calendar-heading">Today’s calendar</h2>

        {calendar === null ? (
          <p className="empty">No calendar yet. Connect a Google account in Settings.</p>
        ) : (
          <>
            <CapacityBar capacity={calendar.capacity} planned={planned} />

            {!calendar.capacity.verified && (
              <p className="capacity-unverified">
                No calendar is connected, so this capacity is unverified: it assumes the whole
                working day is free.
              </p>
            )}

            {calendar.events.length === 0 ? (
              <p className="empty">Nothing in the diary today.</p>
            ) : (
              <ul className="calendar-column">
                {calendar.events.map((event) => {
                  const free = whyFree(event)

                  return (
                    <li key={event.id} className={free === null ? 'event-busy' : 'event-free'}>
                      <span className="event-time">
                        {event.allDay
                          ? 'all day'
                          : `${formatTimeOfDay(event.startsAt)}–${formatTimeOfDay(event.endsAt)}`}
                      </span>
                      <span className="event-summary">{event.summary ?? 'Busy'}</span>
                      {/* Why it costs nothing, rather than leaving a declined meeting looking
                          like an hour that has gone. */}
                      {free !== null && <span className="event-free-reason">{free}</span>}
                    </li>
                  )
                })}
              </ul>
            )}
          </>
        )}
      </section>

      {/* Spec 05 records what was planned and what was completed, and draws no conclusion
          from the gap. */}
      {history.length > 0 && (
        <section aria-labelledby="history-heading">
          <h2 id="history-heading">Planned against completed</h2>
          <ul className="plan-history">
            {history.map((day) => (
              <li key={day.planDate}>
                <span className="history-date">{day.planDate}</span>
                <span className="history-count">
                  {day.completed} of {day.planned}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* A chase list, not a count: it names the item, who it is on, and for how long. */}
      <section aria-labelledby="quiet-heading">
        <h2 id="quiet-heading">Gone quiet</h2>
        {quiet.length === 0 ? (
          <p className="empty">
            {waiting.length === 0
              ? 'Nothing is waiting on anyone else.'
              : `Nothing has been waiting longer than ${staleDays} days.`}
          </p>
        ) : (
          <ul className="chase-list">
            {quiet.map((task) => (
              <li key={task.id}>
                <span className="chase-title">{task.title}</span>
                <span className="chase-who">{task.waitingOn ?? 'nobody named'}</span>
                <span className="chase-age">{formatAge(waitingAge(task, now))}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="stalled-heading">
        <h2 id="stalled-heading">Stalled projects</h2>
        {stalled.length === 0 ? (
          <p className="empty">
            {projects.length === 0 ? 'No projects yet.' : 'Every active project has a next action.'}
          </p>
        ) : (
          <ul className="stalled-list">
            {stalled.map((project) => (
              <li key={project.id}>
                <a href={projectHref(project.id)}>{project.title}</a>
                <span> has no next action</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* The last run of each job, so a failed sync is visible rather than silent (spec 02,
          criterion 5). The Jobs surface is where the schedule and the whole history live. */}
      <section aria-labelledby="jobs-heading">
        <h2 id="jobs-heading">Background jobs</h2>
        {latestRuns.length === 0 ? (
          <p className="empty">
            Nothing has run yet. Sync runs every quarter of an hour; see Jobs for the schedule.
          </p>
        ) : (
          <ul className="job-list">
            {latestRuns.map((run) => (
              <li key={run.job} className={run.status === 'failure' ? 'job-failed' : undefined}>
                <span>{run.job}</span>
                <span>{run.status}</span>
                <span>{formatAge(Math.max(0, now - run.finishedAt))} ago</span>
                {run.error !== null && <span className="job-error">{run.error}</span>}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="integrations-heading">
        <h2 id="integrations-heading">Integrations</h2>
        {health === null ? (
          <p className="empty">Waiting for the server.</p>
        ) : (
          <ul className="integration-list">
            {Object.entries(health.integrations).map(([key, integration]) => (
              <li key={key}>
                <span>{integrationNames[key] ?? key}</span>
                <span>{integration.status}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
