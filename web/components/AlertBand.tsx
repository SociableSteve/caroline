/**
 * The app-level alerts, directly under the header. Issue #47: only broken or overdue things, capped
 * at three, each carrying its reason and the one action that clears it. Expanded on Today, where the
 * full row is shown; collapsed to a one-line strip with a count on every other surface, linking back
 * to Today.
 *
 * Nothing here changes what is fetched: an alert is derived from the job statuses and tasks the
 * shell already holds, the same way the dashboard's own background-jobs strip and stalled-projects
 * panel are.
 */
import type { ReactNode } from 'react'
import type { JobStatus, TaskView } from '../api.js'
import { ago, dueState, formatDate } from '../format.js'
import { surfaceHref } from '../router.js'
import { Badge } from './primitives.js'
import { Button } from './ui/button.js'

export interface AlertItem {
  readonly key: string
  readonly tone: 'alarm' | 'quiet'
  readonly pill: string
  /** The full row, on Today. */
  readonly reason: ReactNode
  /** The same thing, as plain text, for the one-line collapsed strip everywhere else. */
  readonly summary: string
  readonly detail: string | null
  readonly actionLabel: string
  readonly onAction: () => void
}

/** A failing job is broken: it is not doing the thing it is scheduled to do. */
function jobAlerts(
  jobs: readonly JobStatus[],
  now: number,
  onRun: (job: string) => void,
): AlertItem[] {
  return jobs
    .filter((job) => job.lastRun?.status === 'failure')
    .map((job) => {
      const summary = `The ${job.job} job failed ${ago(job.lastRun?.finishedAt ?? now, now)}.`
      return {
        key: `job:${job.job}`,
        tone: 'alarm' as const,
        pill: 'Broken',
        reason: (
          <>
            The <strong>{job.job}</strong> job failed {ago(job.lastRun?.finishedAt ?? now, now)}.
          </>
        ),
        summary,
        detail: job.lastRun?.error ?? null,
        actionLabel: 'Run it now',
        onAction: () => onRun(job.job),
      }
    })
}

/** Overdue and unstarted: due today or earlier, and not yet done. */
function overdueAlerts(
  tasks: readonly TaskView[],
  now: number,
  onOpen: (id: string) => void,
): AlertItem[] {
  return tasks
    .filter(
      (task) =>
        task.status !== 'done' && task.dueAt !== null && dueState(task.dueAt, now) === 'overdue',
    )
    .map((task) => ({
      key: `task:${task.id}`,
      tone: 'alarm' as const,
      pill: 'Overdue',
      reason: (
        <>
          <strong>{task.title}</strong> is overdue.
        </>
      ),
      summary: `${task.title} is overdue.`,
      detail: task.dueAt === null ? null : `due ${formatDate(task.dueAt)}`,
      actionLabel: 'Open',
      onAction: () => onOpen(task.id),
    }))
}

export interface AlertBandProps {
  readonly jobs: readonly JobStatus[]
  readonly tasks: readonly TaskView[]
  readonly now: number
  readonly onRunJob: (job: string) => void
  readonly onOpenTask: (id: string) => void
  /** Full rows on Today; a one-line, collapsed strip with a count everywhere else. */
  readonly expanded: boolean
  readonly hash: string
}

export function AlertBand({
  jobs,
  tasks,
  now,
  onRunJob,
  onOpenTask,
  expanded,
  hash,
}: AlertBandProps) {
  const alerts = [
    ...jobAlerts(jobs, now, onRunJob),
    ...overdueAlerts(tasks, now, onOpenTask),
  ].slice(0, 3)

  if (alerts.length === 0) return null

  if (!expanded) {
    return (
      <div
        className="flex shrink-0 items-center gap-2.5 border-b border-destructive/25 bg-destructive/5 px-5 py-1.5"
        role="region"
        aria-label="Alerts"
      >
        <Badge tone="alarm">
          {alerts.length} {alerts.length === 1 ? 'alert' : 'alerts'}
        </Badge>
        <span className="min-w-0 truncate text-xs">
          {alerts.map((alert) => alert.summary).join(' ')}
        </span>
        <a
          className="ml-auto shrink-0 text-[11px] text-muted-foreground underline underline-offset-[3px]"
          href={surfaceHref('#/', hash)}
        >
          Open Today
        </a>
      </div>
    )
  }

  return (
    <div className="flex shrink-0 flex-col" role="region" aria-label="Alerts">
      {alerts.map((alert) => (
        <div
          key={alert.key}
          className={
            alert.tone === 'alarm'
              ? 'flex flex-wrap items-center gap-x-2.5 gap-y-1 border-b border-destructive/25 bg-destructive/5 px-5 py-2'
              : 'flex flex-wrap items-center gap-x-2.5 gap-y-1 border-b border-border bg-muted/30 px-5 py-2'
          }
        >
          <Badge tone={alert.tone}>{alert.pill}</Badge>
          <span className="min-w-0 text-xs [overflow-wrap:anywhere]">{alert.reason}</span>
          {alert.detail !== null && (
            <span className="font-mono text-[11px] text-muted-foreground">{alert.detail}</span>
          )}
          <Button
            type="button"
            size="sm"
            className="ml-auto h-6 px-2.5 text-[11px]"
            onClick={alert.onAction}
          >
            {alert.actionLabel}
          </Button>
        </div>
      ))}
    </div>
  )
}
