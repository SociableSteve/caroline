/**
 * The jobs surface. Spec 06 keeps background work silent, so the requirement is that it is
 * discoverable here: what ran, what it did, what went wrong, and when the next attempt is.
 */
import { describe, expect, it, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { Jobs } from './surfaces/Jobs.js'
import type { JobRun, JobStatus, SpendReport } from './api.js'
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
  render(<Jobs jobs={[]} runs={[]} spend={null} now={NOW} onRun={onRun} {...overrides} />)
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

  /** Issue #47's mockup marks each card "ok" or "failing" beside its name; colour is never the
   *  only carrier, so the word says it too. */
  it('marks a healthy job "ok" and one whose last run failed "failing"', () => {
    renderJobs({
      jobs: [
        aJob({ job: 'sync' }),
        aJob({
          job: 'plan',
          consecutiveFailures: 2,
          lastRun: aRun({ status: 'failure', error: 'the provider is down' }),
        }),
      ],
    })

    const jobs = panel(/background jobs/i)

    expect(within(jobs.querySelector('li') as HTMLElement).getByText('ok')).toBeInTheDocument()
    expect(
      within(jobs.querySelectorAll('li')[1] as HTMLElement).getByText('failing'),
    ).toBeInTheDocument()
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

/** Spec 03, criterion 15: the spend, priced, dated, and legible about what has no ceiling. */
describe('model spend', () => {
  const spend: SpendReport = {
    currency: 'GBP',
    period: 'month',
    since: NOW - 15 * 24 * 60 * MINUTE,
    checkedOn: '2026-08-21',
    byDay: [
      { day: '2026-06-01', usage: { calls: 2, inputTokens: 1000, outputTokens: 500 }, estimate: 4 },
    ],
    byPurpose: [
      {
        purpose: 'classification',
        usage: { calls: 2, inputTokens: 1000, outputTokens: 500 },
        estimate: 4,
      },
    ],
    byModel: [
      {
        provider: 'anthropic',
        model: 'claude-sonnet-5',
        usage: { calls: 2, inputTokens: 1000, outputTokens: 500 },
        estimate: 4,
      },
    ],
    providers: [
      { provider: 'anthropic', limit: 20, tokens: 1500, allowance: 2_000_000, estimate: 4 },
      { provider: 'openai', limit: 'unlimited', tokens: 0, allowance: null, estimate: null },
    ],
  }

  it('shows it by day, by purpose and by model, in the configured currency', () => {
    renderJobs({ spend })
    const section = panel(/model spend/i)

    for (const heading of ['By day', 'By purpose', 'By model']) {
      expect(within(section).getByText(heading)).toBeInTheDocument()
    }
    expect(within(section).getByText('2026-06-01')).toBeInTheDocument()
    expect(within(section).getByText('classification')).toBeInTheDocument()
    expect(within(section).getByText('anthropic claude-sonnet-5')).toBeInTheDocument()
    expect(within(section).getAllByText('£4.00').length).toBeGreaterThan(0)
  })

  it('says it is an estimate and how old the prices behind it are', () => {
    renderJobs({ spend })

    expect(panel(/model spend/i)).toHaveTextContent(/an estimate for this month/i)
    expect(panel(/model spend/i)).toHaveTextContent('2026-08-21')
  })

  it('reads "no ceiling" for an unlimited provider rather than a blank or a zero', () => {
    renderJobs({ spend })
    const openai = within(panel(/model spend/i)).getByRole('region', { name: /openai/i })

    expect(openai).toHaveTextContent('no ceiling')
    expect(
      within(panel(/model spend/i)).getByRole('region', { name: /anthropic/i }),
    ).toHaveTextContent('£20.00')
  })

  it('says nothing has been spent rather than showing empty tables', () => {
    renderJobs({ spend: { ...spend, byDay: [], byPurpose: [], byModel: [] } })

    expect(
      within(panel(/model spend/i)).getByText('No model calls this month.'),
    ).toBeInTheDocument()
  })

  it('shows no panel at all until the read answers', () => {
    renderJobs()

    expect(screen.queryByRole('region', { name: /model spend/i })).not.toBeInTheDocument()
  })
})
