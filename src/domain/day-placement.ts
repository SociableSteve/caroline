/**
 * Where the plan's entries sit in the day's free time, once the present moment is taken into
 * account. Spec 05's placement rule, moved out of the rendering file so it can be stated and
 * tested directly: `web/surfaces/Dashboard.tsx` draws the day bar and the agenda from the same
 * walk this module runs, which is what keeps the two from disagreeing about when something is
 * happening (spec 08, criterion 43).
 *
 * Pure: no database, no clock read here, no calendar client. `now` is an argument, the same way
 * every rule in `capacity.ts` takes its clock as one.
 */
import { clipTo, freeIntervals, type Interval } from './capacity.js'

const MINUTE_MS = 60_000

/** What `placeDay` needs to know about an entry: whether it is finished, and how long it takes.
 *  Generic over the entry shape so no web type crosses this boundary. */
export interface PlaceableEntry {
  readonly estimateMinutes: number | null
  readonly done: boolean
}

/** One entry's placement, once its estimate has been walked through the free intervals. Null
 *  where nothing placed it: an entry the day has no room for still has to render somewhere, just
 *  without a time. */
export interface PlacedEntry<Entry extends PlaceableEntry> {
  readonly entry: Entry
  readonly startsAt: number | null
}

/** A stretch of free time still ahead of the present moment that nothing was placed into. Long
 *  enough that an overflow entry might be offered into it. */
export interface Gap {
  readonly startsAt: number
  readonly endsAt: number
  readonly minutes: number
}

/** A stretch of free time that has already gone: nothing placed in it, and nothing gone yet
 *  could have placed anything in it either. A different claim from `Gap` despite the identical
 *  shape, since neither should pass where the other is meant: elapsed time is never offered as
 *  slack and never drawn as available. */
export interface Elapsed {
  readonly startsAt: number
  readonly endsAt: number
  readonly minutes: number
}

/** One walk of `entries` through `free`, rendered twice: as the day bar's track and as the
 *  agenda's clock times. `scheduled` keeps the caller's own rank order; `gaps` is only the free
 *  time still ahead of `now`; `elapsed` is the free time behind `now` that nothing occupies. */
export interface DayPlacement<Entry extends PlaceableEntry> {
  readonly scheduled: readonly PlacedEntry<Entry>[]
  readonly gaps: readonly Gap[]
  readonly elapsed: readonly Elapsed[]
}

export interface PlaceDayInput<Entry extends PlaceableEntry> {
  readonly entries: readonly Entry[]
  readonly free: readonly Interval[]
  readonly now: number
}

/**
 * Walks `entries` (in the order given) through `intervals` (chronological order), consuming
 * each entry's estimate from wherever `cursorFor` puts the cursor at the start of each interval.
 * An entry too big for what remains of an interval waits for the next one; an entry with no
 * estimate is placed at the cursor without moving it, since there is nothing to consume. These
 * are the fit rules `scheduleDay` used to carry alone, now shared by both phases below.
 */
function walk<Entry extends PlaceableEntry>(
  entries: readonly Entry[],
  intervals: readonly Interval[],
  cursorFor: (interval: Interval) => number,
): { readonly placed: PlacedEntry<Entry>[]; readonly nextIndex: number } {
  const placed: PlacedEntry<Entry>[] = []
  let index = 0

  for (const interval of intervals) {
    let cursor = cursorFor(interval)
    let entry = entries[index]
    while (entry !== undefined) {
      const minutes = entry.estimateMinutes ?? 0
      const durationMs = minutes * MINUTE_MS
      // The `durationMs > 0` guard is for the no-estimate case, placed at the cursor without
      // moving it. A negative estimate would skip the fit check and rewind the cursor, but
      // cannot arrive: `estimateFor` in `src/domain/plan.ts` floors every entry at one minute.
      if (durationMs > 0 && cursor + durationMs > interval.end) break
      placed.push({ entry, startsAt: cursor })
      cursor += durationMs
      index += 1
      entry = entries[index]
    }
  }

  return { placed, nextIndex: index }
}

/** `walk`, plus whatever `entries` it never reached: still returned, just without a resolved
 *  time. A subset the day has no room for is not a subset that should disappear. */
function placeSubset<Entry extends PlaceableEntry>(
  entries: readonly Entry[],
  intervals: readonly Interval[],
  cursorFor: (interval: Interval) => number,
): PlacedEntry<Entry>[] {
  const { placed, nextIndex } = walk(entries, intervals, cursorFor)

  for (let index = nextIndex; index < entries.length; index += 1) {
    placed.push({ entry: entries[index] as Entry, startsAt: null })
  }

  return placed
}

function stretchOf(interval: Interval): {
  readonly startsAt: number
  readonly endsAt: number
  readonly minutes: number
} {
  return {
    startsAt: interval.start,
    endsAt: interval.end,
    minutes: Math.round((interval.end - interval.start) / MINUTE_MS),
  }
}

/**
 * Two phases over the same free intervals, with one boundary between them (spec 05, criteria 21
 * to 23). Completed entries are placed first, in the order given, walking the free intervals
 * from their own start exactly as before, so nothing already done moves. The boundary is
 * `floor = max(now, the furthest instant completed work reached)`. Outstanding entries are then
 * placed from `floor` onwards, so an entry not yet done is never drawn before the present moment,
 * and completed work that ran past `now` is never dragged forward by work that is not done.
 *
 * A single cursor floored at `now` cannot make both promises at once: ranked `[A not done, B
 * done]`, free from 09:00, read at 11:00, a floored single cursor gives A at 11:00 and B at
 * 11:30, dragging finished work into time that has not happened. Completed work out of rank
 * order is the normal case by mid-afternoon, which is exactly what this guards.
 *
 * Leftover free time is derived once, after both phases, by subtracting every placed span from
 * each free interval and splitting what remains at `now`: behind it is elapsed, ahead of it is a
 * gap, and a stretch straddling `now` becomes both. Doing it this way rather than during the walk
 * is what keeps `placed + elapsed + gaps === free`: "skipped because the cursor jumped ahead" and
 * "left over at the end of an interval" would otherwise be two producers of the same minutes.
 */
export function placeDay<Entry extends PlaceableEntry>({
  entries,
  free,
  now,
}: PlaceDayInput<Entry>): DayPlacement<Entry> {
  const sortedFree = free
    .filter((interval) => interval.end > interval.start)
    .toSorted((first, second) => first.start - second.start)

  const doneEntries = entries.filter((entry) => entry.done)
  const placedDone = placeSubset(doneEntries, sortedFree, (interval) => interval.start)

  const furthestInstant = placedDone.reduce(
    (furthest, { entry, startsAt }) =>
      startsAt === null
        ? furthest
        : Math.max(furthest, startsAt + (entry.estimateMinutes ?? 0) * MINUTE_MS),
    -Infinity,
  )
  const floor = Math.max(now, furthestInstant)

  const outstandingEntries = entries.filter((entry) => !entry.done)
  const placeableIntervals = sortedFree.filter((interval) => interval.end > floor)
  const placedOutstanding = placeSubset(outstandingEntries, placeableIntervals, (interval) =>
    Math.max(interval.start, floor),
  )

  const startsAtByEntry = new Map<Entry, number | null>()
  for (const { entry, startsAt } of [...placedDone, ...placedOutstanding]) {
    startsAtByEntry.set(entry, startsAt)
  }
  const scheduled: PlacedEntry<Entry>[] = entries.map((entry) => ({
    entry,
    startsAt: startsAtByEntry.get(entry) ?? null,
  }))

  const placedSpans: Interval[] = scheduled
    .filter(({ startsAt }) => startsAt !== null)
    .map(({ entry, startsAt }) => ({
      start: startsAt as number,
      end: (startsAt as number) + (entry.estimateMinutes ?? 0) * MINUTE_MS,
    }))
    .filter((span) => span.end > span.start)

  const gaps: Gap[] = []
  const elapsed: Elapsed[] = []

  for (const interval of sortedFree) {
    for (const leftover of freeIntervals(interval, placedSpans)) {
      if (leftover.end <= now) {
        elapsed.push(stretchOf(leftover))
        continue
      }
      if (leftover.start >= now) {
        gaps.push(stretchOf(leftover))
        continue
      }
      const before = clipTo({ start: leftover.start, end: now }, leftover)
      const after = clipTo({ start: now, end: leftover.end }, leftover)
      if (before !== null) elapsed.push(stretchOf(before))
      if (after !== null) gaps.push(stretchOf(after))
    }
  }

  return { scheduled, gaps, elapsed }
}
