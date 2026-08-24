/**
 * The jobs surface. Spec 06 keeps background work silent, so this is where it is discoverable
 * instead: what each job is for, when it last ran and how that went, when it runs next, whether
 * failures are holding it back, and a button to run it now.
 */
import type { JobRun, JobStatus, SpendEstimate, SpendReport } from '../api.js'
import { ago, formatAge } from '../format.js'
import { cn } from '../lib/utils.js'
import {
  Badge,
  emptyClassName,
  Fact,
  Facts,
  Panel,
  tableHeaderClassName,
} from '../components/primitives.js'
import { Button } from '../components/ui/button.js'
import { useSurfaceTitle } from '../title.js'

export interface JobsProps {
  readonly jobs: readonly JobStatus[]
  /** Recent runs across every job, most recent first. */
  readonly runs: readonly JobRun[]
  /** What the models have cost this budget period. Null until the read answers. Spec 03. */
  readonly spend: SpendReport | null
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

/**
 * An amount, or "not priced" where the price table does not carry the model. Said in words rather
 * than shown as a zero: an unpriced call cost something, and a zero would say it did not.
 * Spec 03, criterion 15.
 */
function money(estimate: SpendEstimate, currency: string): string {
  if (estimate === null) return 'not priced'

  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(estimate)
  } catch {
    // A currency the runtime does not know would otherwise take the whole panel down over a
    // formatting detail. The number is the point; the code beside it still says which currency.
    return `${estimate.toFixed(2)} ${currency}`
  }
}

/** What a provider's ceiling is, in words. Spec 03: "no ceiling" rather than a blank or a zero. */
function ceiling(limit: number | string, currency: string): string {
  return typeof limit === 'number' ? money(limit, currency) : 'no ceiling'
}

const tokens = new Intl.NumberFormat()

/**
 * What the models have cost, by day, by purpose and by model, over the current budget period.
 * Shown as an estimate with the date its prices were checked, because a figure about money should
 * say what it is. Spec 03, criterion 15.
 */
function Spend({ spend }: { readonly spend: SpendReport }) {
  const { currency } = spend
  const nothingYet = spend.byDay.length === 0

  const groups: ReadonlyArray<{ heading: string; rows: ReadonlyArray<[string, SpendEstimate]> }> = [
    { heading: 'By day', rows: spend.byDay.map((entry) => [entry.day, entry.estimate]) },
    {
      heading: 'By purpose',
      rows: spend.byPurpose.map((entry) => [entry.purpose, entry.estimate]),
    },
    {
      heading: 'By model',
      rows: spend.byModel.map((entry) => [`${entry.provider} ${entry.model}`, entry.estimate]),
    },
  ]

  return (
    <Panel headingLevel={2} heading="Model spend">
      <p className="m-0 mb-3 text-[11px] leading-relaxed text-muted-foreground">
        An estimate for this {spend.period}, priced from a table committed to the repository
        {spend.checkedOn === null ? '' : `, last checked ${spend.checkedOn}`}. It is what Caroline
        recorded, not what the provider will invoice.
      </p>

      <ul className="m-0 mb-4 grid grid-cols-1 gap-3 p-0 sm:grid-cols-3 [list-style:none]">
        {spend.providers.map((provider) => (
          <li key={provider.provider}>
            <Panel
              headingLevel={3}
              heading={provider.provider}
              headingClassName="m-0 mb-1 font-mono text-[13px] font-medium"
              className="flex h-full flex-col rounded-xl shadow-sm"
            >
              <Facts>
                <Fact label="Ceiling">{ceiling(provider.limit, currency)}</Fact>
                <Fact label="Spent">{money(provider.estimate, currency)}</Fact>
                <Fact label="Tokens">
                  {tokens.format(provider.tokens)}
                  {provider.allowance === null ? '' : ` of ${tokens.format(provider.allowance)}`}
                </Fact>
              </Facts>
            </Panel>
          </li>
        ))}
      </ul>

      {nothingYet ? (
        <p className={emptyClassName}>No model calls this {spend.period}.</p>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          {groups.map((group) => (
            <div key={group.heading}>
              <h3 className="m-0 mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                {group.heading}
              </h3>
              <table className="w-full border-collapse text-xs">
                <tbody>
                  {group.rows.map(([label, estimate]) => (
                    <tr key={label} className="[&>td]:border-b [&>td]:border-border/60 [&>td]:py-1">
                      <td className="font-mono">{label}</td>
                      <td className="text-right [font-variant-numeric:tabular-nums]">
                        {money(estimate, currency)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </div>
      )}
    </Panel>
  )
}

export function Jobs({ jobs, runs, spend, now, onRun }: JobsProps) {
  useSurfaceTitle('Jobs')

  return (
    <div className="flex flex-col gap-5">
      <h1>Jobs</h1>

      {/* The heading is for structure, not for reading: issue #47's mockup goes straight from the
          page's own "Jobs" heading into the four cards, with no second visible heading above
          them. Kept for a11y as a labelled region, just not shown. */}
      <Panel headingLevel={2} heading="Background jobs" headingClassName="sr-only">
        {jobs.length === 0 ? (
          <p className={emptyClassName}>Nothing is scheduled.</p>
        ) : (
          <ul className="m-0 grid grid-cols-1 gap-3 p-0 sm:grid-cols-2 md:grid-cols-4 [list-style:none]">
            {jobs.map((job) => (
              <li key={job.job} className="h-full">
                <Panel
                  headingLevel={3}
                  heading={job.job}
                  headingClassName="m-0 mb-1 mr-6 font-mono text-[13px] font-medium"
                  className={cn(
                    'relative flex h-full flex-col rounded-xl',
                    job.lastRun?.status === 'failure'
                      ? 'border-destructive/40 bg-destructive/5'
                      : 'shadow-sm',
                  )}
                >
                  {/* "ok"/"failing" in words beside the name, matching Board's own stale and
                      pushed pills: colour is never the only carrier. The same condition the
                      card's own alarm tint reads, so the two never disagree. */}
                  <Badge
                    tone={job.lastRun?.status === 'failure' ? 'alarm' : 'quiet'}
                    className="absolute right-3 top-3"
                  >
                    {job.lastRun?.status === 'failure' ? 'failing' : 'ok'}
                  </Badge>

                  <p className="m-0 mb-2 text-[11px] leading-relaxed text-muted-foreground">
                    {descriptions[job.job] ?? ''}
                  </p>

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
                      <Fact label="Error" className="text-sm text-destructive">
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

                  <Button
                    type="button"
                    variant={job.lastRun?.status === 'failure' ? 'default' : 'outline'}
                    size="sm"
                    className="mt-auto h-6.5 self-start px-2.5 text-[11px]"
                    onClick={() => onRun(job.job)}
                    disabled={job.running}
                  >
                    {job.running ? 'Running' : 'Run now'}
                  </Button>
                </Panel>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      {spend !== null && <Spend spend={spend} />}

      <Panel headingLevel={2} heading="Run history">
        {runs.length === 0 ? (
          <p className={emptyClassName}>Nothing has run yet.</p>
        ) : (
          <table className="w-full border-collapse overflow-hidden rounded-xl border text-xs">
            <thead>
              <tr>
                <th scope="col" className={tableHeaderClassName}>
                  Job
                </th>
                <th scope="col" className={tableHeaderClassName}>
                  Trigger
                </th>
                <th scope="col" className={tableHeaderClassName}>
                  When
                </th>
                <th scope="col" className={tableHeaderClassName}>
                  Status
                </th>
                <th scope="col" className={tableHeaderClassName}>
                  What it did
                </th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => (
                <tr
                  key={run.id}
                  className={cn(
                    '[&>td]:border-b [&>td]:border-border/60 [&>td]:p-2',
                    run.status === 'failure' && 'bg-destructive/[0.04]',
                  )}
                >
                  <td className="font-mono">{run.job}</td>
                  <td className="text-muted-foreground">{run.trigger}</td>
                  <td className="text-muted-foreground [font-variant-numeric:tabular-nums]">
                    {ago(run.finishedAt, now)}
                  </td>
                  <td className={run.status === 'failure' ? 'text-destructive' : undefined}>
                    {run.status}
                  </td>
                  <td
                    className={
                      run.status === 'failure' ? 'text-destructive' : 'text-muted-foreground'
                    }
                  >
                    {run.error ?? summarise(run)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
    </div>
  )
}
