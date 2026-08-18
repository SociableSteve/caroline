/**
 * The dashboard. The morning question is "what am I doing today, and does it fit", so the surface
 * answers that first and everything else after, in the three bands spec 08 sets out:
 *
 * 1. Today. The plan, with the capacity bar and the calendar column beside it, at the full width.
 * 2. Wants a decision. What has gone quiet, what is worth a chase, the plan's overflow, and the
 *    stalled projects: each of these is something only the user can resolve.
 * 3. State of the machine. Counts, the last run of each job, and what is configured, condensed
 *    into one strip. It is scanned to confirm nothing is broken and read no further when nothing
 *    is. A count is not work, and it should not lead a surface about work.
 *
 * The bands are fixed rows rather than one reflowing grid, because a reading path that changes
 * with the window width is not a reading path. Spec 08, criterion 11.
 *
 * Criterion 4: with no plan, no calendar and no integrations configured it shows empty states
 * rather than errors, because that is the state a clean checkout is in.
 *
 * Criterion 6: the capacity bar's numbers are the ones `GET /api/calendar` gave. They are not
 * recomputed here, so the two cannot disagree.
 */
import { useId, type ReactNode } from 'react'
import { taskStatuses } from '../api.js'
import type {
  CalendarDay,
  CalendarEventView,
  CapacityView,
  Health,
  ItemRef,
  JobRun,
  PlanEntryView,
  PlanHistoryDay,
  PlanView,
  ProjectView,
  TaskView,
} from '../api.js'
import {
  ago,
  byOldestFirst,
  formatAge,
  formatEstimate,
  formatTimeOfDay,
  isStale,
  statusLabel,
  waitingAge,
} from '../format.js'
import { unverifiedCapacityNotice } from '../../src/domain/capacity.js'
import { projectHref, surfaceHref } from '../router.js'
import { Panel } from '../components/primitives.js'
import { useSurfaceTitle } from '../title.js'

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
  /** Opens a plan entry's task in the rail's details region. Spec 08, criterion 31. */
  readonly onSelect: (item: ItemRef) => void
  readonly selected: ItemRef | null
  /** The hash the stalled-project links are built from, so a drill-in keeps the rail. Spec 08. */
  readonly hash: string
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
  onSelect,
  selected,
}: {
  readonly entry: PlanEntryView
  readonly onComplete: (taskId: string) => void
  readonly onSelect: (item: ItemRef) => void
  readonly selected: ItemRef | null
}) {
  // A plan entry is not a fourth kind of item: it names a task, and opening one opens that task. An
  // entry whose task has been deleted is a record of what was proposed and names nothing to open.
  // Spec 08, criterion 31.
  const taskId = entry.taskId
  const open = taskId !== null && selected?.kind === 'task' && selected.id === taskId

  return (
    <li className={entry.done ? 'plan-entry plan-done' : 'plan-entry'}>
      <span className="plan-rank">{entry.rank}</span>
      <span className="plan-title">
        {taskId === null ? (
          entry.title
        ) : (
          <button
            type="button"
            className="item-open"
            aria-pressed={open}
            onClick={() => onSelect({ kind: 'task', id: taskId })}
          >
            {entry.title}
          </button>
        )}
      </span>
      {entry.rationale !== null && <span className="plan-why">{entry.rationale}</span>}
      {entry.estimateMinutes !== null && (
        <span className="plan-estimate">{formatEstimate(entry.estimateMinutes)}</span>
      )}
      {/* Done is said in text as well as in the styling: colour is never the only carrier of
          meaning. Spec 08. */}
      {entry.done && <span className="plan-state">done</span>}
      {/* An entry whose task has been deleted is a record of what was proposed, and there is
          nothing left to complete.

          The label is a word and the name of the thing goes to the accessible name: a button
          whose visible label is a whole sentence is a button nobody can find twice. */}
      {!entry.done && entry.taskId !== null && (
        <button
          type="button"
          aria-label={`Complete ${entry.title}`}
          onClick={() => onComplete(entry.taskId as string)}
        >
          Complete
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

/**
 * One entry in band 3's strip. A named region, so it is navigable and testable, but deliberately
 * not a `Panel`: it has no ground, no border and no padding of its own, which is what keeps it
 * from being laid out at the weight of a band 1 panel. Spec 08, criterion 11.
 */
function StripSection({
  heading,
  children,
}: {
  readonly heading: string
  readonly children: ReactNode
}) {
  const headingId = useId()

  return (
    <section className="strip-section" aria-labelledby={headingId}>
      <h2 id={headingId} className="strip-heading">
        {heading}
      </h2>
      {children}
    </section>
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
  onSelect,
  selected,
  hash,
}: DashboardProps) {
  useSurfaceTitle('Dashboard')
  const latestRuns = latestRunPerJob(jobRuns)
  const counts = new Map(
    taskStatuses.map((status) => [status, tasks.filter((task) => task.status === status).length]),
  )
  const waiting = tasks.filter((task) => task.status === 'waiting').sort(byOldestFirst)
  const quiet = waiting.filter((task) => isStale(task, now, staleDays))
  const stalled = projects.filter((project) => project.stalled)
  const planned = plannedMinutes(plan)
  const capacityNotice =
    calendar === null
      ? null
      : unverifiedCapacityNotice(calendar.capacity.verified, calendar.capacity.busyMinutes)

  return (
    <div className="dashboard">
      <h1>Dashboard</h1>

      {/* Band 1. Today: the answer to the question the surface exists to answer. */}
      <div className="band band-today">
        <Panel headingLevel={2} heading="Today’s plan">
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
                    <PlanEntryLine
                      key={entry.id}
                      entry={entry}
                      onComplete={onComplete}
                      onSelect={onSelect}
                      selected={selected}
                    />
                  ))}
                </ul>
              )}
            </>
          )}
        </Panel>

        <Panel headingLevel={2} heading="Today’s calendar">
          {calendar === null ? (
            <p className="empty">No calendar yet. Connect a Google account in Settings.</p>
          ) : (
            <>
              <CapacityBar capacity={calendar.capacity} planned={planned} />

              {capacityNotice !== null && <p className="capacity-unverified">{capacityNotice}</p>}

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
        </Panel>
      </div>

      {/* Band 2. Each of these is something only the user can resolve. */}
      <div className="band band-decisions">
        {/* A chase list, not a count: it names the item, who it is on, and for how long. */}
        <Panel headingLevel={2} heading="Gone quiet">
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
        </Panel>

        {/* A nudge names the item, who it is waiting on and for how long, and for a reviewed
            pull request whether the author has pushed since. Spec 05, criteria 11 and 12. */}
        {plan !== null && plan.nudges.length > 0 && (
          <Panel headingLevel={2} heading="Worth a chase">
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
          </Panel>
        )}

        {/* Spec 05: excess is offered rather than dropped, and offered as what it is. */}
        {plan !== null && plan.overflow.length > 0 && (
          <Panel headingLevel={2} heading="If there is time">
            <ul className="plan-list">
              {plan.overflow.map((entry) => (
                <PlanEntryLine
                  key={entry.id}
                  entry={entry}
                  onComplete={onComplete}
                  onSelect={onSelect}
                  selected={selected}
                />
              ))}
            </ul>
          </Panel>
        )}

        <Panel headingLevel={2} heading="Stalled projects">
          {stalled.length === 0 ? (
            <p className="empty">
              {projects.length === 0
                ? 'No projects yet.'
                : 'Every active project has a next action.'}
            </p>
          ) : (
            <ul className="stalled-list">
              {stalled.map((project) => (
                <li key={project.id}>
                  <a href={surfaceHref(projectHref(project.id), hash)}>{project.title}</a>
                  <span> has no next action</span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>

      {/*
       * Band 3. One strip, not a panel each: this is scanned to confirm nothing is broken. Nothing
       * here is given the weight of a band 1 panel, which is the rule the previous version of this
       * surface was missing and why counts led it for three milestones.
       */}
      <div className="band state-strip">
        <StripSection heading="Where everything is">
          <ul className="counts">
            {taskStatuses.map((status) => (
              <li key={status}>
                <span className="count">{counts.get(status) ?? 0}</span>
                <span className="count-label">{statusLabel(status)}</span>
              </li>
            ))}
          </ul>
        </StripSection>

        {/* The last run of each job, so a failed sync is visible rather than silent (spec 02,
            criterion 5). The Jobs surface is where the schedule and the whole history live.

            The rows are a grid: their columns line up whether or not a row carries an error, and
            the error takes the width beneath them rather than squeezing the row. Criterion 19. */}
        <StripSection heading="Background jobs">
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
                  <span className="job-when">{ago(run.finishedAt, now)}</span>
                  {run.error !== null && <span className="job-error">{run.error}</span>}
                </li>
              ))}
            </ul>
          )}
        </StripSection>

        <StripSection heading="Integrations">
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
        </StripSection>

        {/* Spec 05 records what was planned and what was completed, and draws no conclusion
            from the gap. */}
        {history.length > 0 && (
          <StripSection heading="Planned against completed">
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
          </StripSection>
        )}
      </div>
    </div>
  )
}
