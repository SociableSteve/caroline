/**
 * The dashboard. Spec 08 criterion 4: with no plan, no calendar and no integrations, it shows
 * empty states rather than errors, because that is the state a clean checkout is in.
 *
 * The plan, the calendar column and the capacity bar arrive with the daily planner in M6. Their
 * panels are here now, saying what is missing and how to get it, rather than being hidden until the
 * feature lands: an empty state is the honest answer to "what is my day".
 */
import { taskStatuses } from '../api.js'
import type { Health, JobRun, ProjectView, TaskView } from '../api.js'
import { byOldestFirst, formatAge, isStale, statusLabel, waitingAge } from '../format.js'
import { projectHref } from '../router.js'

export interface DashboardProps {
  readonly tasks: readonly TaskView[]
  readonly projects: readonly ProjectView[]
  readonly health: Health | null
  /** Recent runs, most recent first. Only the latest of each job is shown. */
  readonly jobRuns: readonly JobRun[]
  readonly staleDays: number
  readonly now: number
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

export function Dashboard({ tasks, projects, health, jobRuns, staleDays, now }: DashboardProps) {
  const latestRuns = latestRunPerJob(jobRuns)
  const counts = new Map(
    taskStatuses.map((status) => [status, tasks.filter((task) => task.status === status).length]),
  )
  const waiting = tasks.filter((task) => task.status === 'waiting').sort(byOldestFirst)
  const quiet = waiting.filter((task) => isStale(task, now, staleDays))
  const stalled = projects.filter((project) => project.stalled)

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
        <p className="empty">
          No plan yet. The daily planner needs a calendar and an LLM provider, and neither is wired
          up in this version.
        </p>
      </section>

      <section aria-labelledby="calendar-heading">
        <h2 id="calendar-heading">Today’s calendar</h2>
        <p className="empty">No calendar connected, so there is nothing to show against it.</p>
      </section>

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
