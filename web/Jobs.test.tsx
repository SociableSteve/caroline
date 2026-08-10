/**
 * The jobs surface. Spec 06 keeps background work silent, so the requirement is that it is
 * discoverable here: what ran, what it did, what went wrong, and when the next attempt is.
 */
import { describe, expect, it, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { Jobs } from './surfaces/Jobs.js'
import type { JobRun, JobStatus } from './api.js'
import { noCounts } from '../src/domain/job.js'
import { NOW } from './test-fixtures.js'

const MINUTE = 60_000

function aRun(overrides: Partial<JobRun> = {}): JobRun {
  return {
    id: 'run-1',
    job: 'sync',
    trigger: 'scheduled',
    startedAt: NOW - 2 * MINUTE,
    finishedAt: NOW - MINUTE,
    status: 'success',
    counts: { ...noCounts },
    error: null,
    errorStack: null,
    ...overrides,
  }
}

function aJob(overrides: Partial<JobStatus> = {}): JobStatus {
  return {
    job: 'sync',
    cron: '*/15 * * * *',
    running: false,
    nextRunAt: NOW + 5 * MINUTE,
    lastRun: aRun(),
    consecutiveFailures: 0,
    backoffUntil: null,
    ...overrides,
  }
}

function renderJobs(overrides: Partial<Parameters<typeof Jobs>[0]> = {}) {
  const onRun = vi.fn()
  render(<Jobs jobs={[]} runs={[]} now={NOW} onRun={onRun} {...overrides} />)
  return { onRun }
}

function panel(name: RegExp) {
  return screen.getByRole('region', { name })
}

describe('the schedule', () => {
  it('says what each job is for, when it next runs and how the last one went', () => {
    renderJobs({ jobs: [aJob()] })

    const jobs = panel(/background jobs/i)

    expect(within(jobs).getByText(/Pulls review requests/)).toBeInTheDocument()
    expect(within(jobs).getByText('*/15 * * * *')).toBeInTheDocument()
    expect(within(jobs).getByText('in 5 minutes')).toBeInTheDocument()
    expect(within(jobs).getByText('success, 1 minute ago')).toBeInTheDocument()
  })

  it('says a job has never run rather than leaving it blank', () => {
    renderJobs({ jobs: [aJob({ lastRun: null })] })

    expect(within(panel(/background jobs/i)).getByText('never')).toBeInTheDocument()
  })

  it('summarises what the last run did', () => {
    renderJobs({
      jobs: [
        aJob({
          lastRun: aRun({ counts: { ...noCounts, itemsSeen: 4, tasksCreated: 2, classified: 2 } }),
        }),
      ],
    })

    expect(
      within(panel(/background jobs/i)).getByText('4 items seen, 2 tasks created, 2 classified'),
    ).toBeInTheDocument()
  })

  /**
   * A sync that discovered items without creating tasks has done something. Leaving the count out
   * of the summary made that read as "nothing to do".
   */
  it('counts sources created as work done', () => {
    renderJobs({
      jobs: [aJob({ lastRun: aRun({ counts: { ...noCounts, sourcesCreated: 2 } }) })],
    })

    const jobs = panel(/background jobs/i)

    expect(within(jobs).getByText('2 sources created')).toBeInTheDocument()
    expect(within(jobs).queryByText('nothing to do')).not.toBeInTheDocument()
  })

  it('says a run that did nothing did nothing', () => {
    renderJobs({ jobs: [aJob()] })

    expect(within(panel(/background jobs/i)).getByText('nothing to do')).toBeInTheDocument()
  })

  it('shows a failure with the message and the job is marked', () => {
    renderJobs({
      jobs: [
        aJob({
          lastRun: aRun({ status: 'failure', error: 'GitHub answered 401 Unauthorized' }),
        }),
      ],
    })

    expect(
      within(panel(/background jobs/i)).getByText('GitHub answered 401 Unauthorized'),
    ).toBeInTheDocument()
  })

  /** Spec 06, criterion 3: a job being held back should not read as one that has stopped. */
  it('says when failures are holding a job back, and until when', () => {
    renderJobs({
      jobs: [
        aJob({
          consecutiveFailures: 3,
          backoffUntil: NOW + 4 * MINUTE,
          lastRun: aRun({ status: 'failure', error: 'the provider is down' }),
        }),
      ],
    })

    expect(within(panel(/background jobs/i)).getByText(/after 3 failures/)).toHaveTextContent(
      'in 4 minutes',
    )
  })

  it('says a job is running rather than offering to run it again', () => {
    renderJobs({ jobs: [aJob({ running: true })] })

    expect(screen.getByRole('button', { name: 'Running' })).toBeDisabled()
  })

  it('runs a job on demand', async () => {
    const { onRun } = renderJobs({ jobs: [aJob()] })

    await userEvent.click(screen.getByRole('button', { name: 'Run now' }))

    expect(onRun).toHaveBeenCalledWith('sync')
  })

  it('says nothing is scheduled rather than showing an empty list', () => {
    renderJobs()

    expect(within(panel(/background jobs/i)).getByText('Nothing is scheduled.')).toBeInTheDocument()
  })
})

describe('the run history', () => {
  it('lists runs with their trigger, status and what they did', () => {
    renderJobs({
      runs: [
        aRun({
          id: 'run-1',
          job: 'sync:gmail',
          trigger: 'manual',
          counts: { ...noCounts, itemsSeen: 3 },
        }),
        aRun({ id: 'run-2', job: 'classify', status: 'skipped' }),
      ],
    })

    const history = panel(/run history/i)
    const rows = within(history).getAllByRole('row')

    expect(rows[1]).toHaveTextContent('sync:gmail')
    expect(rows[1]).toHaveTextContent('manual')
    expect(rows[1]).toHaveTextContent('3 items seen')
    expect(rows[2]).toHaveTextContent('skipped')
  })

  it('shows a failure’s message in place of its counts', () => {
    renderJobs({ runs: [aRun({ status: 'failure', error: 'Gmail answered 401' })] })

    expect(within(panel(/run history/i)).getByText('Gmail answered 401')).toBeInTheDocument()
  })

  it('says nothing has run rather than showing an empty table', () => {
    renderJobs()

    expect(within(panel(/run history/i)).getByText('Nothing has run yet.')).toBeInTheDocument()
  })
})
