/**
 * The dashboard, redesigned per issue #47. The morning question is "what am I doing today, and
 * does it fit", so the surface answers that first and everything else after:
 *
 * 1. Today. A verdict headline, a to-scale day bar and one time-ordered agenda merging the plan's
 *    entries with the calendar's events, in the main column.
 * 2. A left rail: a ranked "Needs you" list (gone quiet, worth a chase, stalled, oldest first,
 *    capped to the top 3 and pointed at the board for the rest), then a bordered "Where
 *    everything is" card. The background-jobs and planned-against-completed strips a previous
 *    pass kept as an "honest gap" have been dropped: the mockup does not draw them and nothing on
 *    the page needs them replaced. Jobs already has its own surface; plan history is not shown
 *    here at all.
 *
 * Criterion 6: the day bar's numbers are the ones `GET /api/calendar` gave. They are not
 * recomputed here, so the two cannot disagree.
 *
 * Criterion 4: with no plan, no calendar and no integrations configured it shows empty states
 * rather than errors, because that is the state a clean checkout is in.
 *
 * There is no "If there is time" panel for the plan's overflow any more: issue #47's mockup drew
 * one, but Steve asked for it gone outright, not merely hidden behind the mockup's say-so. An
 * overflow entry that also fits a free gap in the agenda is still offered there, inline (spec
 * 05's "would fit" slack row); the rest of the overflow list is simply not shown anywhere on this
 * surface any more, since nothing here needs to replace what the panel used to say.
 */
import { Fragment, type ReactNode } from 'react'
import { taskStatuses } from '../api.js'
import type {
  CalendarDay,
  CalendarEventView,
  CapacityView,
  ItemRef,
  PlanEntryView,
  PlanView,
  ProjectView,
  TaskView,
} from '../api.js'
import {
  byOldestFirst,
  formatAge,
  formatEstimate,
  formatTimeOfDay,
  formatVerdictDate,
  isStale,
  statusLabel,
  waitingAge,
} from '../format.js'
import { unverifiedCapacityNotice } from '../../src/domain/capacity.js'
import type { Interval } from '../../src/domain/capacity.js'
import { cn } from '../lib/utils.js'
import { projectHref, surfaceHref } from '../router.js'
import { Badge, emptyClassName, itemOpenClassName, Panel } from '../components/primitives.js'
import { Button } from '../components/ui/button.js'
import { useSurfaceTitle } from '../title.js'

export interface DashboardProps {
  readonly tasks: readonly TaskView[]
  readonly projects: readonly ProjectView[]
  /** Today's plan, or null when none has been drawn. Spec 05. */
  readonly plan: PlanView | null
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

/** What the plan has committed to, done and not done alike. The verdict compares it against the
 *  capacity it was drawn for. */
function plannedMinutes(plan: PlanView | null): number {
  return (plan?.entries ?? []).reduce((total, entry) => total + (entry.estimateMinutes ?? 0), 0)
}

/** The same total, split by whether the task behind it is already done. The day bar and the
 *  agenda both need the split; the verdict does not, so it keeps using the combined figure. */
function splitPlannedMinutes(plan: PlanView | null): { planned: number; done: number } {
  let planned = 0
  let done = 0
  for (const entry of plan?.entries ?? []) {
    const minutes = entry.estimateMinutes ?? 0
    if (entry.done) done += minutes
    else planned += minutes
  }
  return { planned, done }
}

/**
 * The verdict: whether today fits. Issue #47's headline, computed from the same numbers the day
 * bar already shows (spec 08, criterion 6: never recomputed from anything else), so the two can
 * never disagree. Null where there is nothing to verdict yet: no calendar, or a day with no
 * working window at all.
 */
function verdict(calendar: CalendarDay | null, planned: number): string | null {
  if (calendar === null || !calendar.capacity.workingDay) return null

  const free = Math.max(0, calendar.capacity.capacityMinutes)
  if (free <= 0) return 'Today has no free capacity.'

  if (planned <= free) {
    const spare = free - planned
    return `Today fits — ${formatEstimate(planned)} planned of ${formatEstimate(free)} free, and ${formatEstimate(spare)} to spare.`
  }

  const over = planned - free
  return `Today’s tight — ${formatEstimate(planned)} planned of ${formatEstimate(free)} free, ${formatEstimate(over)} over.`
}

/** The day's working window, spelled out the way the old separate calendar panel used to: the
 *  total working-day minutes are otherwise nowhere on the redesigned surface (issue #47's verdict
 *  headline states only the free/planned split, not the window it was drawn from). */
function capacityDetail(capacity: CapacityView): string {
  return `${formatEstimate(capacity.windowMinutes)} of working day, less ${formatEstimate(capacity.busyMinutes)} of meetings and ${formatEstimate(capacity.reserveMinutes)} held back`
}

/**
 * Why the agenda has no plan entries in it, when it has none. A day with no capacity or no
 * eligible work already says so elsewhere (the domain warning above, or `plan.summary` itself),
 * so this only fills in the one case neither of those covers: capacity was positive, nothing
 * overflowed, and the job never set a summary. Returning `null` means "something else on the page
 * already explains this", not "nothing to show".
 */
function emptyPlanMessage(plan: PlanView): string | null {
  // Criterion 16, issue #22: capacity <= 0 always carries its own domain warning (`plan.ts`'s
  // "There is no free capacity..."), so repeating it here would be the same claim twice.
  if (plan.capacityMinutes <= 0) return null

  if (plan.overflow.length > 0) return 'Nothing fitted into the free time left today.'

  // Nothing overflowed either. That is either because there was truly no eligible work (the
  // job's own summary already says so verbatim), or because the model's picks were all invented
  // ids that resolved to nothing (its summary explains what it tried, even if imperfectly). A
  // blanket "nothing was eligible" would duplicate the first case and misstate the second, so
  // defer to the summary whenever the job set one.
  return plan.summary === null ? 'Nothing was placed into today’s plan.' : null
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

/**
 * The day bar: the capacity meter and the calendar column, merged into one to-scale strip.
 * Issue #47. Five segments, in the order the appearance model's legend reads them rather than
 * the order the day actually runs in: the window's numbers are exact (criterion 6), but the
 * client is not told which minute of the day each one occupies, so the bar draws proportions
 * rather than a literal timeline. The agenda below carries the real clock times.
 */
function DayBar({
  capacity,
  planned,
  done,
  now,
}: {
  readonly capacity: CapacityView
  readonly planned: number
  readonly done: number
  readonly now: number
}) {
  if (!capacity.workingDay) {
    return (
      <p className={emptyClassName}>Today is not a working day, so there is no capacity to plan.</p>
    )
  }

  const meetings = capacity.busyMinutes
  const reserve = Math.max(0, capacity.reserveMinutes)
  const capacityFree = Math.max(0, capacity.capacityMinutes)
  const doneWidth = Math.min(done, capacityFree)
  const plannedWidth = Math.min(planned, Math.max(0, capacityFree - doneWidth))
  const free = Math.max(0, capacityFree - doneWidth - plannedWidth)

  const segments = [
    { key: 'meetings', minutes: meetings, className: 'bg-accent' },
    { key: 'planned', minutes: plannedWidth, className: 'bg-chart-2' },
    { key: 'done', minutes: doneWidth, className: 'bg-chart-2/35' },
    {
      key: 'free',
      minutes: free,
      className: 'border-x border-dashed border-foreground/20',
    },
    {
      key: 'reserve',
      minutes: reserve,
      className: 'bg-foreground/[0.06]',
    },
  ].filter((segment) => segment.minutes > 0)

  const total = segments.reduce((sum, segment) => sum + segment.minutes, 0)

  return (
    <div className="my-1 mb-3 flex flex-col gap-1.5">
      {/* A decoration of the legend below, which is what actually carries the numbers in words:
          colour is never the only carrier of meaning. Spec 08. */}
      {total > 0 && (
        <div className="flex h-6.5 overflow-hidden rounded-md border" aria-hidden="true">
          {segments.map((segment) => (
            <span
              key={segment.key}
              className={segment.className}
              style={{ flexGrow: segment.minutes / total }}
            />
          ))}
        </div>
      )}

      <ul className="m-0 flex flex-wrap items-baseline gap-x-4 gap-y-1 p-0 text-[11px] text-muted-foreground [list-style:none]">
        <li>meetings {formatEstimate(meetings)}</li>
        <li>planned {formatEstimate(plannedWidth)}</li>
        <li>done {formatEstimate(doneWidth)}</li>
        <li>free {formatEstimate(free)}</li>
        {reserve > 0 && <li>held back {formatEstimate(reserve)}</li>}
        <li className="ml-auto font-mono font-medium text-chart-2">now {formatTimeOfDay(now)}</li>
      </ul>
    </div>
  )
}

/** One plan entry's placement in the agenda, once its estimate has been walked through the free
 *  intervals in rank order. Null where nothing placed it: an entry that could not be scheduled
 *  still has to render somewhere, just without a time. */
interface ScheduledEntry {
  readonly entry: PlanEntryView
  readonly startsAt: number | null
}

/** A stretch of free time nothing was scheduled into. Long enough that an overflow entry might
 *  be offered into it, per issue #47's "would fit" slack row. */
interface SlackGap {
  readonly startsAt: number
  readonly minutes: number
}

/**
 * Walks `entries` (rank order) through `freeIntervals` (chronological order), consuming each
 * entry's estimate from wherever the cursor currently sits. An entry too big for what remains of
 * an interval waits for the next one; an entry with no estimate is placed at the cursor without
 * moving it, since there is nothing to consume. Whatever of an interval is left over once entries
 * stop fitting becomes a gap.
 */
function scheduleAgenda(
  entries: readonly PlanEntryView[],
  freeIntervals: readonly Interval[],
): { readonly scheduled: ScheduledEntry[]; readonly gaps: SlackGap[] } {
  const scheduled: ScheduledEntry[] = []
  const gaps: SlackGap[] = []
  let index = 0

  for (const interval of freeIntervals) {
    let cursor = interval.start
    let entry = entries[index]
    while (entry !== undefined) {
      const minutes = entry.estimateMinutes ?? 0
      const durationMs = minutes * 60_000
      if (durationMs > 0 && cursor + durationMs > interval.end) break
      scheduled.push({ entry, startsAt: cursor })
      cursor += durationMs
      index += 1
      entry = entries[index]
    }

    if (cursor < interval.end) {
      gaps.push({ startsAt: cursor, minutes: Math.round((interval.end - cursor) / 60_000) })
    }
  }

  // Nothing left to place it in. Still shown, just without a resolved time: a plan the client
  // cannot schedule is not a plan the client should hide.
  for (let entry = entries[index]; entry !== undefined; index += 1, entry = entries[index]) {
    scheduled.push({ entry, startsAt: null })
  }

  return { scheduled, gaps }
}

/**
 * Each gap's offer, computed once in a single left-to-right pass so the same overflow entry is
 * never offered into two different gaps. Spec: "sourced from the plan's overflow."
 */
function offersForGaps(
  gaps: readonly SlackGap[],
  overflow: readonly PlanEntryView[],
): Array<{ readonly gap: SlackGap; readonly offer: PlanEntryView | null }> {
  const offered = new Set<string>()

  return gaps.map((gap) => {
    const offer =
      overflow.find((entry) => {
        if (offered.has(entry.id)) return false
        const minutes = entry.estimateMinutes ?? 0
        return minutes > 0 && minutes <= gap.minutes
      }) ?? null
    if (offer !== null) offered.add(offer.id)
    return { gap, offer }
  })
}

/**
 * Whether a plan entry is the item currently open in the chat rail: it names a task, and opening
 * one opens that task, so this is true exactly when `selected` is that task. Issue #47's mockup
 * draws the open row's card with the accent border every other open card in the app gets (Board's
 * `card-open`, spec 10): shared here rather than left to `EntryTitle` alone so `AgendaEntryRow`
 * can put the same border on the card around the title, not only on the title's own pressed state.
 */
function isEntryOpen(entry: PlanEntryView, selected: ItemRef | null): boolean {
  return entry.taskId !== null && selected?.kind === 'task' && selected.id === entry.taskId
}

function EntryTitle({
  entry,
  onSelect,
  selected,
}: {
  readonly entry: PlanEntryView
  readonly onSelect: (item: ItemRef) => void
  readonly selected: ItemRef | null
}) {
  // A plan entry is not a fourth kind of item: it names a task, and opening one opens that task.
  // An entry whose task has been deleted is a record of what was proposed and names nothing to
  // open. Spec 08, criterion 31.
  const taskId = entry.taskId
  if (taskId === null) return <>{entry.title}</>

  const open = isEntryOpen(entry, selected)
  return (
    <button
      type="button"
      className={itemOpenClassName}
      aria-pressed={open}
      onClick={() => onSelect({ kind: 'task', id: taskId })}
    >
      {entry.title}
    </button>
  )
}

/**
 * A plan entry's rank, title, rationale, estimate and completion state: everything about the
 * entry itself, as opposed to where it sits (an agenda row carries a clock time beside this).
 * Its own function rather than inlined into `AgendaEntryRow`, the way a single `PlanEntryLine`
 * used to be shared between the main agenda and the now-removed "If there is time" overflow
 * panel: Steve asked for that panel gone outright regardless of what it fitted into, not merely
 * hidden, so this no longer has a second caller, but it still keeps the entry's own rendering out
 * of the row that places it.
 */
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
  return (
    <>
      <span className="font-mono text-muted-foreground [font-variant-numeric:tabular-nums]">
        {entry.rank}
      </span>
      <span
        className={cn(
          'font-medium [overflow-wrap:anywhere]',
          entry.done && 'text-muted-foreground line-through',
        )}
      >
        <EntryTitle entry={entry} onSelect={onSelect} selected={selected} />
      </span>
      {entry.rationale !== null && (
        <span className="text-sm text-muted-foreground">{entry.rationale}</span>
      )}
      {entry.estimateMinutes !== null && (
        <span className="ml-auto whitespace-nowrap font-mono text-sm text-muted-foreground">
          {formatEstimate(entry.estimateMinutes)}
        </span>
      )}
      {/* Done is said in text as well as in the styling: colour is never the only carrier of
          meaning. Spec 08. */}
      {entry.done && <span className="text-sm text-muted-foreground">done</span>}
      {!entry.done && entry.taskId !== null && (
        <Button
          type="button"
          aria-label={`Complete ${entry.title}`}
          onClick={() => onComplete(entry.taskId as string)}
        >
          Complete
        </Button>
      )}
    </>
  )
}

function AgendaEntryRow({
  scheduled,
  onComplete,
  onSelect,
  selected,
}: {
  readonly scheduled: ScheduledEntry
  readonly onComplete: (taskId: string) => void
  readonly onSelect: (item: ItemRef) => void
  readonly selected: ItemRef | null
}) {
  const { entry, startsAt } = scheduled
  const open = isEntryOpen(entry, selected)

  return (
    <li
      className={cn(
        'grid grid-cols-[44px_minmax(0,1fr)] items-start gap-x-3',
        entry.done && 'plan-done',
      )}
    >
      <span className="justify-self-center bg-background py-1.5 font-mono text-[11px] text-muted-foreground [font-variant-numeric:tabular-nums]">
        {startsAt === null ? null : formatTimeOfDay(startsAt)}
      </span>
      <div
        className={cn(
          'agenda-card flex min-w-0 flex-1 flex-wrap items-baseline gap-x-3 gap-y-1 rounded-lg border border-border bg-card px-3 py-2',
          open && 'card-open border-chart-2/50 bg-chart-2/[0.08]',
        )}
      >
        <PlanEntryLine
          entry={entry}
          onComplete={onComplete}
          onSelect={onSelect}
          selected={selected}
        />
      </div>
    </li>
  )
}

/**
 * A meeting's row: single start time in the gutter, like every other row in the spine, with its
 * duration carried in the trailing label instead of a second clock time. Issue #47's mockup shows
 * "30 min, meeting" rather than a start–end range; the duration is still said, just the way a plan
 * entry's estimate is said, so the "how much of the day this takes" fact a start time alone cannot
 * give is not lost, only moved to match the rest of the agenda's own convention.
 */
function AgendaMeetingRow({ event }: { readonly event: CalendarEventView }) {
  const free = whyFree(event)
  const durationMinutes = event.allDay ? null : Math.round((event.endsAt - event.startsAt) / 60_000)

  return (
    <li className="grid grid-cols-[44px_minmax(0,1fr)] items-start gap-x-3">
      <span className="justify-self-center bg-background py-1.5 font-mono text-[11px] text-muted-foreground [font-variant-numeric:tabular-nums]">
        {event.allDay ? 'all day' : formatTimeOfDay(event.startsAt)}
      </span>
      <div className="agenda-card flex min-w-0 flex-1 flex-wrap items-baseline gap-x-3 gap-y-1 rounded-lg border border-border bg-card px-3 py-2">
        <span className={free === null ? undefined : 'text-muted-foreground'}>
          {event.summary ?? 'Busy'}
        </span>
        {/* Why it costs nothing, rather than leaving a declined meeting looking like an hour that
            has gone. */}
        <span className="ml-auto whitespace-nowrap text-sm text-muted-foreground">
          {durationMinutes !== null &&
            durationMinutes > 0 &&
            `${formatEstimate(durationMinutes)}, `}
          {free ?? 'meeting'}
        </span>
      </div>
    </li>
  )
}

function AgendaGapRow({
  gap,
  offer,
  onSelect,
  selected,
}: {
  readonly gap: SlackGap
  readonly offer: PlanEntryView | null
  readonly onSelect: (item: ItemRef) => void
  readonly selected: ItemRef | null
}) {
  return (
    <li className="grid grid-cols-[44px_minmax(0,1fr)] items-start gap-x-3">
      <span className="justify-self-center bg-background py-1.5 font-mono text-[11px] text-muted-foreground [font-variant-numeric:tabular-nums]">
        {formatTimeOfDay(gap.startsAt)}
      </span>
      <div className="agenda-card flex min-w-0 flex-1 flex-wrap items-baseline gap-x-3 gap-y-1 rounded-lg border border-dashed border-chart-2/30 bg-chart-2/[0.04] px-3 py-2 text-muted-foreground">
        <span className="font-medium text-chart-1">{formatEstimate(gap.minutes)} free</span>
        {offer !== null && (
          <span className="text-foreground">
            <EntryTitle entry={offer} onSelect={onSelect} selected={selected} /> (
            {formatEstimate(offer.estimateMinutes ?? 0)}) would fit
          </span>
        )}
      </div>
    </li>
  )
}

/** Whichever row falls first after `now`. Rows without a resolved time never take part: there is
 *  nowhere sensible to put a "now" rule next to a row that carries no clock time of its own. */
function nowIndex(rows: readonly { readonly startsAt: number | null }[], now: number): number {
  return rows.findIndex((row) => row.startsAt !== null && row.startsAt >= now)
}

/**
 * The agenda: one time-ordered spine, plan entries and calendar events interleaved, a "now" rule,
 * and free gaps offered as slack. Issue #47. Falls back to two simple, unscheduled lists — the
 * plan in rank order, the calendar in its own — when the calendar carried no free/busy interval
 * data to schedule against, which every existing fixture that only sets the summary minutes does.
 */
function Agenda({
  plan,
  calendar,
  now,
  onComplete,
  onSelect,
  selected,
}: {
  readonly plan: PlanView | null
  readonly calendar: CalendarDay | null
  readonly now: number
  readonly onComplete: (taskId: string) => void
  readonly onSelect: (item: ItemRef) => void
  readonly selected: ItemRef | null
}) {
  const entries = plan?.entries ?? []
  const events = calendar?.events ?? []
  const freeIntervals = calendar?.capacity.free ?? []
  const canSchedule = freeIntervals.length > 0

  // Two rows, so a meeting keeps its own key even though a plan entry can also carry a
  // `startsAt`: nothing here reuses a calendar event's id for an entry or vice versa.
  interface MeetingRow {
    readonly kind: 'meeting'
    readonly key: string
    readonly startsAt: number | null
    readonly event: CalendarEventView
  }
  interface EntryRow {
    readonly kind: 'entry'
    readonly key: string
    readonly startsAt: number | null
    readonly scheduled: ScheduledEntry
  }
  interface GapRow {
    readonly kind: 'gap'
    readonly key: string
    readonly startsAt: number | null
    readonly gap: SlackGap
    readonly offer: PlanEntryView | null
  }
  type Row = MeetingRow | EntryRow | GapRow

  const meetingRows: MeetingRow[] = events.map((event) => ({
    kind: 'meeting',
    key: `meeting:${event.id}`,
    startsAt: event.allDay ? null : event.startsAt,
    event,
  }))

  let entryRows: EntryRow[]
  let gapRows: GapRow[]

  if (canSchedule) {
    const { scheduled, gaps } = scheduleAgenda(entries, freeIntervals)
    entryRows = scheduled.map((row) => ({
      kind: 'entry',
      key: `entry:${row.entry.id}`,
      startsAt: row.startsAt,
      scheduled: row,
    }))
    gapRows = offersForGaps(gaps, plan?.overflow ?? []).map(({ gap, offer }, index) => ({
      kind: 'gap',
      key: `gap:${index}`,
      startsAt: gap.startsAt,
      gap,
      offer,
    }))
  } else {
    entryRows = entries.map((entry) => ({
      kind: 'entry',
      key: `entry:${entry.id}`,
      startsAt: null,
      scheduled: { entry, startsAt: null },
    }))
    gapRows = []
  }

  const rows: Row[] = [...meetingRows, ...entryRows, ...gapRows]
  const timed = rows
    .filter((row) => row.startsAt !== null)
    .sort((first, second) => (first.startsAt ?? 0) - (second.startsAt ?? 0))
  const untimed = rows.filter((row) => row.startsAt === null)

  // Gated on whether a row has a real clock time, not on `canSchedule`: a calendar's meetings
  // carry their own `startsAt` regardless of whether the plan's entries could be scheduled
  // against free intervals, so the "now" marker still has somewhere real to go among them.
  const nowAt = nowIndex(timed, now)

  const renderRow = (row: Row): ReactNode => {
    if (row.kind === 'meeting') return <AgendaMeetingRow key={row.key} event={row.event} />
    if (row.kind === 'entry')
      return (
        <AgendaEntryRow
          key={row.key}
          scheduled={row.scheduled}
          onComplete={onComplete}
          onSelect={onSelect}
          selected={selected}
        />
      )
    return (
      <AgendaGapRow
        key={row.key}
        gap={row.gap}
        offer={row.offer}
        onSelect={onSelect}
        selected={selected}
      />
    )
  }

  const nowRow = (
    <li
      key="now"
      className="agenda-now grid grid-cols-[44px_minmax(0,1fr)] items-center gap-x-3 py-1 text-xs font-medium text-chart-2"
      aria-hidden="true"
    >
      <span className="justify-self-center font-mono text-[11px] [font-variant-numeric:tabular-nums]">
        {formatTimeOfDay(now)}
      </span>
      <span className="flex items-center gap-2">
        <span className="h-0.5 flex-1 rounded-full bg-chart-2" />
        now
      </span>
    </li>
  )

  if (timed.length === 0 && untimed.length === 0) {
    return <p className={emptyClassName}>Nothing on the agenda yet.</p>
  }

  // A continuous vertical line down the time gutter, per the mockup: an absolutely positioned
  // overlay behind the list rather than a grid spanning every row, so the list stays a plain
  // `<ol>`/`<li>` structure (real list semantics, and the classes `Dashboard.test.tsx` already
  // asserts on) with each row free to lay out its own two columns. The line sits at the gutter's
  // centre (half of the 44px column, plus the row gap before it).
  return (
    <div className="relative">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-y-1 left-[21px] w-px bg-border"
      />
      <ol className="relative m-0 flex flex-col gap-2 p-0 [list-style:none]">
        {timed.map((row, index) => (
          <Fragment key={row.key}>
            {index === nowAt && nowRow}
            {renderRow(row)}
          </Fragment>
        ))}
        {nowAt === -1 && timed.length > 0 && nowRow}
        {untimed.map((row) => renderRow(row))}
      </ol>
    </div>
  )
}

/**
 * One entry in the left rail's ranked "Needs you" list: what has gone quiet, what is worth a
 * chase and which projects are stalled, in one list rather than three panels, oldest first.
 * Issue #47.
 */
interface NeedsYouItem {
  readonly key: string
  readonly tone: 'alarm' | 'accent' | 'quiet'
  readonly pill: string
  readonly ageMs: number | null
  readonly title: ReactNode
  readonly subtitle: ReactNode
  readonly note: ReactNode | null
}

/**
 * Why the rail has nothing in it, when it has nothing: two independent facts, kept apart rather
 * than folded into the one claim "nothing is waiting on anyone else" (which used to be literally
 * false whenever a waiting task just was not stale yet, or a project just was not stalled — the
 * rail only ranks the stale, the nudged and the stalled, not everything waiting or every active
 * project). Issue #47's merge deleted the old "Gone quiet" and "Stalled projects" panels' own
 * accurate, distinct empty states along with the panels; this restores both, as two lines rather
 * than one, since the rail now answers for both at once.
 */
function needsYouEmptyMessages(
  waiting: readonly TaskView[],
  staleDays: number,
  projects: readonly ProjectView[],
): readonly string[] {
  return [
    waiting.length === 0
      ? 'Nothing is waiting on anyone else.'
      : `Nothing has been waiting longer than ${staleDays} days.`,
    projects.length === 0 ? 'No projects yet.' : 'Every active project has a next action.',
  ]
}

function NeedsYouRow({ item }: { readonly item: NeedsYouItem }) {
  return (
    <li className="border-b border-sidebar-border pb-2">
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <Badge tone={item.tone}>{item.pill}</Badge>
        {item.ageMs !== null && (
          <span className="font-mono text-[11px] text-muted-foreground [font-variant-numeric:tabular-nums]">
            {formatAge(item.ageMs)}
          </span>
        )}
      </div>
      <p className="m-0 text-[13px] font-medium [overflow-wrap:anywhere]">{item.title}</p>
      <p className="m-0 text-[11px] text-muted-foreground">{item.subtitle}</p>
      {item.note !== null && <p className="m-0 text-[11px] text-chart-1">{item.note}</p>}
    </li>
  )
}

export function Dashboard({
  tasks,
  projects,
  plan,
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
  useSurfaceTitle('Today')
  const counts = new Map(
    taskStatuses.map((status) => [status, tasks.filter((task) => task.status === status).length]),
  )
  const waiting = tasks.filter((task) => task.status === 'waiting').sort(byOldestFirst)
  const quiet = waiting.filter((task) => isStale(task, now, staleDays))
  const stalled = projects.filter((project) => project.stalled)
  const totalPlanned = plannedMinutes(plan)
  const { planned, done } = splitPlannedMinutes(plan)
  const capacityNotice = calendar === null ? null : unverifiedCapacityNotice(calendar.capacity)
  const todaysVerdict = verdict(calendar, totalPlanned)

  const needsYou: NeedsYouItem[] = [
    ...quiet.map((task): NeedsYouItem => ({
      key: `quiet:${task.id}`,
      tone: 'alarm',
      pill: 'Gone quiet',
      ageMs: waitingAge(task, now),
      title: task.title,
      subtitle: task.waitingOn ?? 'nobody named',
      note: null,
    })),
    ...(plan?.nudges ?? []).map((nudge): NeedsYouItem => ({
      key: `chase:${nudge.id}`,
      tone: 'accent',
      pill: 'Worth a chase',
      ageMs: nudge.waitingSince === null ? null : Math.max(0, now - nudge.waitingSince),
      title: nudge.title,
      subtitle: nudge.waitingOn ?? 'nobody named',
      note: nudge.pushedSinceReview ? 'the author has pushed since you reviewed' : null,
    })),
    ...stalled.map((project): NeedsYouItem => ({
      key: `stalled:${project.id}`,
      tone: 'quiet',
      pill: 'Stalled',
      ageMs: null,
      title: <a href={surfaceHref(projectHref(project.id), hash)}>{project.title}</a>,
      subtitle: 'has no next action',
      note: null,
    })),
    // Oldest first: an item with no age (a stalled project) sorts after every one that has one.
  ].sort((first, second) => (second.ageMs ?? -1) - (first.ageMs ?? -1))

  // The rail is a triage list, not the whole waiting-on-someone-else set: only the three oldest
  // earn a place in it, and everything past that is a click away on the board rather than a rail
  // that grows without bound. Issue #47.
  const needsYouTop = needsYou.slice(0, 3)

  return (
    <div className="flex h-full min-h-0 flex-col gap-5">
      <h1 className="shrink-0">Today</h1>

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-5 md:grid-cols-[minmax(14.5rem,16.25rem)_minmax(0,1fr)]">
        {/* The left rail. Issue #47: ranked "Needs you" first, capped to three, then the bordered
            "Where everything is" card. */}
        <div className="flex min-w-0 flex-col gap-3.5 rounded-lg border border-sidebar-border bg-sidebar p-3.5">
          <section aria-labelledby="needs-you-heading">
            <h2
              id="needs-you-heading"
              className="m-0 mb-2 text-xs font-semibold uppercase tracking-[0.05em] text-muted-foreground"
            >
              Needs you
            </h2>

            {needsYouTop.length === 0 ? (
              needsYouEmptyMessages(waiting, staleDays, projects).map((message) => (
                <p className={emptyClassName} key={message}>
                  {message}
                </p>
              ))
            ) : (
              <ul className="m-0 mb-2 flex flex-col gap-3 p-0 [list-style:none]">
                {needsYouTop.map((item) => (
                  <NeedsYouRow key={item.key} item={item} />
                ))}
              </ul>
            )}

            {/* The rail shows only the top 3; this is where the rest of what is waiting lives.
                Issue #47's exact caption text, now a link rather than a plain caption. */}
            <a
              className="inline-block text-xs text-muted-foreground underline underline-offset-[3px]"
              href={surfaceHref('#/board', hash)}
            >
              Everything waiting, oldest first.
            </a>
          </section>

          {/* Where everything is: a task-status breakdown, and nothing else. Which providers are
              configured and when they last synced is Settings' own subject, not this one's. */}
          <Panel
            headingLevel={2}
            heading="Where everything is"
            className="mt-auto rounded-lg border border-sidebar-border bg-transparent p-3 shadow-none"
            headingClassName="m-0 mb-2 font-mono text-[10px] uppercase tracking-[0.06em] text-muted-foreground"
          >
            <table className="w-full border-collapse text-xs">
              <caption className="sr-only">Task count by status</caption>
              <tbody>
                {taskStatuses.map((status) => (
                  <tr key={status} className="border-b border-sidebar-border last:border-0">
                    <th
                      scope="row"
                      className="py-1 pr-2 text-left font-normal text-muted-foreground"
                    >
                      {statusLabel(status)}
                    </th>
                    <td className="py-1 text-right font-mono text-foreground [font-variant-numeric:tabular-nums]">
                      {counts.get(status) ?? 0}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>
        </div>

        {/* The main column: the verdict, the day bar and the agenda. One region rather than the
            separate plan and calendar panels this replaces, because the agenda interleaves both
            into a single spine. */}
        <section className="flex min-w-0 flex-col gap-3" aria-labelledby="today-heading">
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2">
            <h2 id="today-heading" className="sr-only">
              Today
            </h2>
            {todaysVerdict !== null && (
              <p className="m-0">
                <span className="text-xl font-medium tracking-tight">{todaysVerdict}</span>{' '}
                <span className="verdict-date font-mono text-muted-foreground">
                  {formatVerdictDate(now)}
                </span>
              </p>
            )}
            {/* The window the verdict was drawn from, in words: issue #47's headline states only
                the free/planned split, and the old separate calendar panel's working-day total
                and reserve are otherwise dropped entirely by the merge. */}
            {todaysVerdict !== null && calendar !== null && (
              <p className="mt-1 text-muted-foreground">{capacityDetail(calendar.capacity)}</p>
            )}
            <Button type="button" onClick={onRegeneratePlan} disabled={regenerating}>
              {regenerating ? 'Regenerating' : 'Regenerate'}
            </Button>
          </div>

          {calendar !== null && (
            <DayBar capacity={calendar.capacity} planned={planned} done={done} now={now} />
          )}

          {capacityNotice !== null && (
            <p className="text-sm text-muted-foreground">{capacityNotice}</p>
          )}

          {/* Independent empty states, kept apart rather than folded into one sentence: a plan
              with no calendar and a calendar with no plan are different states of the world, and
              a reader after one should not have to parse a claim about the other. Criterion 4. */}
          {plan === null && (
            <p className={emptyClassName}>
              No plan yet. The planner runs each morning, and needs an LLM provider configured.
            </p>
          )}
          {calendar === null && (
            <p className={emptyClassName}>No calendar yet. Connect a Google account in Settings.</p>
          )}

          {plan !== null && plan.summary !== null && (
            <p className="m-0 mb-2 max-w-[76ch]">{plan.summary}</p>
          )}

          {/* A plan that had to leave something out says so here rather than in the database.
              Spec 05. */}
          {plan !== null && plan.warnings.length > 0 && (
            <ul className="m-0 p-0 text-sm text-muted-foreground [list-style:none]">
              {plan.warnings.map((warning) => (
                <li key={warning} className="py-1">
                  {warning}
                </li>
              ))}
            </ul>
          )}

          {plan !== null && plan.entries.length === 0 && emptyPlanMessage(plan) !== null && (
            <p className={emptyClassName}>{emptyPlanMessage(plan)}</p>
          )}

          {calendar !== null &&
            calendar.events.length === 0 &&
            (plan?.entries.length ?? 0) === 0 && (
              <p className={emptyClassName}>Nothing in the diary today.</p>
            )}

          {(plan !== null || calendar !== null) &&
            ((plan?.entries.length ?? 0) > 0 || (calendar?.events.length ?? 0) > 0) && (
              <Agenda
                plan={plan}
                calendar={calendar}
                now={now}
                onComplete={onComplete}
                onSelect={onSelect}
                selected={selected}
              />
            )}
        </section>
      </div>
    </div>
  )
}
