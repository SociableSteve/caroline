/**
 * The jobs surface. Spec 06 keeps background work silent, so this is where it is discoverable
 * instead: what each job is for, when it last ran and how that went, when it runs next, whether
 * failures are holding it back, and a button to run it now.
 */
import type { JobRun, JobStatus } from '../api.js'
import { ago, formatAge } from '../format.js'
import { Badge, Fact, Facts, Panel } from '../components/primitives.js'
import { useSurfaceTitle } from '../title.js'

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
  { key: 'suppressed', label: 'duplicate notifications suppressed' },
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
  useSurfaceTitle('Jobs')

  return (
    <div className="jobs-surface">
      <h1>Jobs</h1>

      {/* The heading is for structure, not for reading: issue #47's mockup goes straight from the
          page's own "Jobs" heading into the four cards, with no second visible heading above
          them. Kept for a11y as a labelled region, just not shown. */}
      <Panel headingLevel={2} heading="Background jobs" headingClassName="visually-hidden">
        {jobs.length === 0 ? (
          <p className="empty">Nothing is scheduled.</p>
        ) : (
          <ul className="job-status-list">
            {jobs.map((job) => (
              <li key={job.job}>
                <Panel
                  headingLevel={3}
                  heading={job.job}
                  headingClassName="job-name"
                  className={job.lastRun?.status === 'failure' ? 'job-failed' : undefined}
                >
                  {/* "ok"/"failing" in words beside the name, matching Board's own stale and
                      pushed pills: colour is never the only carrier. The same condition the
                      card's own alarm tint reads, so the two never disagree. */}
                  <Badge
                    tone={job.lastRun?.status === 'failure' ? 'alarm' : 'quiet'}
                    className="job-status-pill"
                  >
                    {job.lastRun?.status === 'failure' ? 'failing' : 'ok'}
                  </Badge>

                  <p className="job-description">{descriptions[job.job] ?? ''}</p>

                  <Facts>
                    <Fact label="Schedule">
                      <code>{job.cron}</code>
                    </Fact>

                    <Fact label="Next run">
                      {job.running ? 'running now' : when(job.nextRunAt, now)}
                    </Fact>

                    <Fact label="Last run">
                      {job.lastRun === null
                        ? 'never'
                        : `${job.lastRun.status}, ${ago(job.lastRun.finishedAt, now)}`}
                    </Fact>

                    {job.lastRun !== null && <Fact label="It did">{summarise(job.lastRun)}</Fact>}

                    {job.lastRun?.error != null && (
                      <Fact label="Error" className="job-error">
                        {job.lastRun.error}
                      </Fact>
                    )}

                    {/* Said out loud, because a job that looks idle when it is being held back
                      reads as a job that has stopped working. Spec 06, criterion 3. */}
                    {job.consecutiveFailures > 0 && (
                      <Fact label="Backing off">
                        after {job.consecutiveFailures}{' '}
                        {job.consecutiveFailures === 1 ? 'failure' : 'failures'}, next attempt{' '}
                        {when(job.backoffUntil, now)}
                      </Fact>
                    )}
                  </Facts>

                  <button type="button" onClick={() => onRun(job.job)} disabled={job.running}>
                    {job.running ? 'Running' : 'Run now'}
                  </button>
                </Panel>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel headingLevel={2} heading="Run history">
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
                  <td className="run-when">{ago(run.finishedAt, now)}</td>
                  <td>{run.status}</td>
                  <td>{run.error ?? summarise(run)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
    </div>
  )
}
