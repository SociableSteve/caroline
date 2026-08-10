/**
 * The jobs surface. Spec 06 keeps background work silent, so this is where it is discoverable
 * instead: what each job is for, when it last ran and how that went, when it runs next, whether
 * failures are holding it back, and a button to run it now.
 */
import type { JobRun, JobStatus } from '../api.js'
import { formatAge } from '../format.js'

export interface JobsProps {
  readonly jobs: readonly JobStatus[]
  /** Recent runs across every job, most recent first. */
  readonly runs: readonly JobRun[]
  readonly now: number
  readonly onRun: (job: string) => void
}

/** What each job does, in the words a person would use. Keyed by the scheduler's own names. */
const descriptions: Record<string, string> = {
  sync: 'Pulls review requests from GitHub, threads from Gmail and events from your calendar.',
  classify: 'Sorts the inbox, and asks you about anything it is unsure of.',
  plan: 'Draws the day’s plan against the time your calendar leaves free.',
  purge: 'Drops stored message bodies past their retention window, and old run history.',
}

/** The counts worth showing, in the order they read as a sentence about what a run did. */
const countLabels: ReadonlyArray<{ key: keyof JobRun['counts']; label: string }> = [
  { key: 'itemsSeen', label: 'items seen' },
  { key: 'sourcesCreated', label: 'sources created' },
  { key: 'tasksCreated', label: 'tasks created' },
  { key: 'tasksUpdated', label: 'tasks moved' },
  { key: 'resolved', label: 'resolved' },
  { key: 'requeued', label: 'requeued' },
  { key: 'eventsStored', label: 'calendar events' },
  { key: 'eventsRemoved', label: 'events dropped' },
  { key: 'classified', label: 'classified' },
  { key: 'plansGenerated', label: 'plans drawn' },
  { key: 'proposals', label: 'suggestions' },
  { key: 'llmCalls', label: 'model calls' },
  { key: 'failed', label: 'failed' },
  { key: 'contentPurged', label: 'bodies purged' },
  { key: 'runsPurged', label: 'runs purged' },
]

function summarise(run: JobRun): string {
  const said = countLabels
    .filter((entry) => (run.counts[entry.key] ?? 0) > 0)
    .map((entry) => `${run.counts[entry.key]} ${entry.label}`)

  return said.length === 0 ? 'nothing to do' : said.join(', ')
}

function when(at: number | null, now: number): string {
  if (at === null) return 'not scheduled'
  const difference = at - now
  return difference <= 0 ? 'due now' : `in ${formatAge(difference)}`
}

export function Jobs({ jobs, runs, now, onRun }: JobsProps) {
  return (
    <div className="jobs-surface">
      <section aria-labelledby="schedule-heading">
        <h2 id="schedule-heading">Background jobs</h2>

        {jobs.length === 0 ? (
          <p className="empty">Nothing is scheduled.</p>
        ) : (
          <ul className="job-status-list">
            {jobs.map((job) => (
              <li
                key={job.job}
                className={job.lastRun?.status === 'failure' ? 'job-failed' : undefined}
              >
                <h3>{job.job}</h3>
                <p className="job-description">{descriptions[job.job] ?? ''}</p>

                <dl className="job-facts">
                  <dt>Schedule</dt>
                  <dd>
                    <code>{job.cron}</code>
                  </dd>

                  <dt>Next run</dt>
                  <dd>{job.running ? 'running now' : when(job.nextRunAt, now)}</dd>

                  <dt>Last run</dt>
                  <dd>
                    {job.lastRun === null
                      ? 'never'
                      : `${job.lastRun.status}, ${formatAge(Math.max(0, now - job.lastRun.finishedAt))} ago`}
                  </dd>

                  {job.lastRun !== null && (
                    <>
                      <dt>It did</dt>
                      <dd>{summarise(job.lastRun)}</dd>
                    </>
                  )}

                  {job.lastRun?.error != null && (
                    <>
                      <dt>Error</dt>
                      <dd className="job-error">{job.lastRun.error}</dd>
                    </>
                  )}

                  {/* Said out loud, because a job that looks idle when it is being held back
                      reads as a job that has stopped working. Spec 06, criterion 3. */}
                  {job.consecutiveFailures > 0 && (
                    <>
                      <dt>Backing off</dt>
                      <dd>
                        after {job.consecutiveFailures}{' '}
                        {job.consecutiveFailures === 1 ? 'failure' : 'failures'}, next attempt{' '}
                        {when(job.backoffUntil, now)}
                      </dd>
                    </>
                  )}
                </dl>

                <button type="button" onClick={() => onRun(job.job)} disabled={job.running}>
                  {job.running ? 'Running' : 'Run now'}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="history-heading">
        <h2 id="history-heading">Run history</h2>

        {runs.length === 0 ? (
          <p className="empty">Nothing has run yet.</p>
        ) : (
          <table className="run-history">
            <thead>
              <tr>
                <th scope="col">Job</th>
                <th scope="col">Trigger</th>
                <th scope="col">When</th>
                <th scope="col">Status</th>
                <th scope="col">What it did</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => (
                <tr key={run.id} className={run.status === 'failure' ? 'job-failed' : undefined}>
                  <td>{run.job}</td>
                  <td>{run.trigger}</td>
                  <td>{formatAge(Math.max(0, now - run.finishedAt))} ago</td>
                  <td>{run.status}</td>
                  <td>{run.error ?? summarise(run)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  )
}
