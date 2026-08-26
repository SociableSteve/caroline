/**
 * Placing a plan's entries into a day's free time, against the present moment as well as
 * against the intervals themselves. Spec 05, "Placement is not re-planning", criteria 21 to 23.
 *
 * Pure: no database, no clock reading of its own. `now` is an argument, the way every other
 * instant in this codebase is, which is what lets every criterion here be asserted without a
 * fixture that waits for the clock.
 *
 * Moved out of the dashboard's own rendering file so the rule can be stated and unit tested
 * directly, generic over the entry shape so no web type crosses this boundary.
 */
import { clipTo, freeIntervals, type Interval } from './capacity.js'

const MINUTE_MS = 60_000

/** The two facts placement needs from an entry: how long it takes and whether it is done. */
export interface PlaceableEntry {
  readonly estimateMinutes: number | null
  readonly done: boolean
}

/** One entry's placement. Null where nothing placed it: an entry that could not be scheduled
 *  still has to render somewhere, just without a time. */
export interface PlacedEntry<Entry> {
  readonly entry: Entry
  readonly startsAt: number | null
}

/** A stretch of free time still ahead of `now`, nothing scheduled into it. Long enough that an
 *  overflow entry might be offered into it (spec 05's "would fit" slack row). `endsAt` as well
 *  as `minutes` because the day bar draws the gap from its instants and the agenda's row reads
 *  its length in words: rounding the end out of the minutes would put the drawing half a minute
 *  off the clock. */
export interface SlackGap {
  readonly startsAt: number
  readonly endsAt: number
  readonly minutes: number
}

/** A stretch of free time already behind `now` when the plan was read, with nothing placed in
 *  it. Carries the same shape as `SlackGap` despite that, because the two are different claims:
 *  one is time still available, the other is time already gone, and neither should pass where
 *  the other is meant. Spec 05, criterion 23. */
export interface ElapsedStretch {
  readonly startsAt: number
  readonly endsAt: number
  readonly minutes: number
}

/** One walk of the plan through the day's free time, rendered twice: as the day bar's track and
 *  as the agenda's clock times. Spec 08, criterion 43. `scheduled` keeps the caller's rank
 *  order; `gaps` is only the free time still ahead; `elapsed` is the free time behind `now`
 *  that nothing occupies. */
export interface DayPlacement<Entry> {
  readonly scheduled: readonly PlacedEntry<Entry>[]
  readonly gaps: readonly SlackGap[]
  readonly elapsed: readonly ElapsedStretch[]
}

export interface PlaceDayInput<Entry extends PlaceableEntry> {
  readonly entries: readonly Entry[]
  readonly free: readonly Interval[]
  readonly now: number
}

function durationOf(entry: PlaceableEntry): number {
  return (entry.estimateMinutes ?? 0) * MINUTE_MS
}

/**
 * Walks `entries` (in the order given) through `intervals` (chronological order), consuming
 * each entry's estimate from wherever the cursor currently sits. An entry too big for what
 * remains of an interval waits for the next one; an entry with no estimate is placed at the
 * cursor without moving it, since there is nothing to consume. An interval that ends at or
 * before `floor` is skipped outright, and every other interval's cursor starts no earlier than
 * `floor`, which is what keeps outstanding work from ever being placed behind it.
 *
 * The `durationMs > 0` guard is for the no-estimate case, which is placed at the cursor without
 * moving it. A negative estimate would skip the fit check and rewind the cursor, but cannot
 * arrive: `estimateFor` in `src/domain/plan.ts` floors every entry at one minute.
 */
function walk<Entry extends PlaceableEntry>(
  entries: readonly Entry[],
  intervals: readonly Interval[],
  floor: number,
): { readonly placed: ReadonlyMap<Entry, number>; readonly placedSpans: readonly Interval[] } {
  const placed = new Map<Entry, number>()
  const placedSpans: Interval[] = []
  let index = 0

  for (const interval of intervals) {
    if (interval.end <= floor) continue

    let cursor = Math.max(interval.start, floor)
    let entry = entries[index]
    while (entry !== undefined) {
      const durationMs = durationOf(entry)
      if (durationMs > 0 && cursor + durationMs > interval.end) break

      placed.set(entry, cursor)
      if (durationMs > 0) placedSpans.push({ start: cursor, end: cursor + durationMs })
      cursor += durationMs
      index += 1
      entry = entries[index]
    }
  }

  return { placed, placedSpans }
}

/**
 * Places `entries` into `free`, in two phases over the one set of intervals. Phase A places the
 * done entries first, cursor from each interval's start, exactly as a single walk always has;
 * phase B then places the outstanding entries from `floor = max(now, the instant phase A
 * reached)` onwards. Two phases rather than one cursor floored at `now`, because a single cursor
 * drags a completed entry into the future whenever it is ranked after an unfinished one: done
 * work keeps whatever earlier time it was placed in, whatever order the two were ranked in
 * (spec 05, criterion 22), and an unfinished entry never draws before `now` (criterion 21).
 *
 * The leftovers are derived once, after both phases, by subtracting every placed span from each
 * free interval and then splitting what remains at `now`: behind it is elapsed (criterion 23),
 * ahead of it is a gap, and a stretch straddling `now` becomes both. Deriving them during the
 * walk would double count, since "skipped because the cursor jumped" and "left over at the end
 * of an interval" are two producers of the same minutes; done this way, placed plus elapsed plus
 * gap minutes always equal the free minutes.
 */
export function placeDay<Entry extends PlaceableEntry>({
  entries,
  free,
  now,
}: PlaceDayInput<Entry>): DayPlacement<Entry> {
  const intervals = free
    .filter((interval) => interval.end > interval.start)
    .toSorted((first, second) => first.start - second.start)

  const doneEntries = entries.filter((entry) => entry.done)
  const outstandingEntries = entries.filter((entry) => !entry.done)

  const phaseA = walk(doneEntries, intervals, Number.NEGATIVE_INFINITY)

  let furthest = Number.NEGATIVE_INFINITY
  for (const [entry, startsAt] of phaseA.placed) {
    furthest = Math.max(furthest, startsAt + durationOf(entry))
  }
  const floor = Math.max(now, furthest)

  const phaseB = walk(outstandingEntries, intervals, floor)

  const scheduled: PlacedEntry<Entry>[] = entries.map((entry) => ({
    entry,
    startsAt: phaseA.placed.get(entry) ?? phaseB.placed.get(entry) ?? null,
  }))

  const placedSpans = [...phaseA.placedSpans, ...phaseB.placedSpans]

  const gaps: SlackGap[] = []
  const elapsed: ElapsedStretch[] = []

  for (const interval of intervals) {
    for (const leftover of freeIntervals(interval, placedSpans)) {
      const behind = clipTo(leftover, { start: Number.NEGATIVE_INFINITY, end: now })
      if (behind !== null) {
        elapsed.push({
          startsAt: behind.start,
          endsAt: behind.end,
          minutes: Math.round((behind.end - behind.start) / MINUTE_MS),
        })
      }

      const ahead = clipTo(leftover, { start: now, end: Number.POSITIVE_INFINITY })
      if (ahead !== null) {
        gaps.push({
          startsAt: ahead.start,
          endsAt: ahead.end,
          minutes: Math.round((ahead.end - ahead.start) / MINUTE_MS),
        })
      }
    }
  }

  return { scheduled, gaps, elapsed }
}
