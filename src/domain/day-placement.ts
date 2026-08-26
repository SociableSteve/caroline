/**
 * Placement of plan entries into the day's free intervals, accounting for elapsed time.
 * Spec 05, criteria 21-23.
 *
 * Two phases over the same free intervals:
 * 1. Place completed entries first, in rank order, walking from interval starts as before
 * 2. Place outstanding entries from `floor = max(now, cursor after completed run)`
 *
 * This keeps completed work in its earlier free time and prevents outstanding entries
 * from being scheduled before the present moment. Free time that has elapsed with nothing
 * placed in it is reported as time gone rather than offered as slack.
 */
import type { Interval } from './capacity.js'

const MINUTE_MS = 60_000

/**
 * What a plan entry needs to be scheduled: an id, an estimate, and a completion flag.
 * Generic over the entry shape so no web type crosses the boundary.
 */
export interface PlaceableEntry {
  readonly id: string
  readonly estimateMinutes: number | null
  readonly done: boolean
}

/**
 * A placed entry: the entry itself and the instant it starts, or null if it could not be placed.
 */
export interface PlacedEntry<Entry extends PlaceableEntry> {
  readonly entry: Entry
  readonly startsAt: number | null
}

/**
 * A stretch of free time after the clock has passed, not offered as slack.
 * `startsAt` and `endsAt` as instants since the placement walk uses them as pixels.
 */
export interface GapSpan {
  readonly startsAt: number
  readonly endsAt: number
}

/**
 * Free time that has elapsed behind the clock, never offered as slack or as a schedulable place.
 * Identical shape to GapSpan, but a different claim: neither should pass where the other is meant.
 */
export interface ElapsedSpan {
  readonly startsAt: number
  readonly endsAt: number
}

/**
 * Result of walking entries through the day's free time. `scheduled` keeps its shape
 * (entry plus startsAt) and the caller's rank order. `gaps` and `elapsed` are the free time
 * that remains, split at the present moment: elapsed behind it, gaps ahead of it.
 */
export interface DayPlacement<Entry extends PlaceableEntry = PlaceableEntry> {
  readonly scheduled: readonly PlacedEntry<Entry>[]
  readonly gaps: readonly GapSpan[]
  readonly elapsed: readonly ElapsedSpan[]
}

/**
 * Place entries into free intervals, returning the scheduled placements, remaining free time
 * ahead of now, and elapsed time behind now.
 *
 * Completed entries are placed first in rank order from interval starts. Outstanding entries
 * are then placed from a floor that respects the clock. Free time that has passed is reported
 * as elapsed; free time still ahead is offered as gaps.
 *
 * @param entries Entries in rank order.
 * @param free Free intervals in chronological order.
 * @param now The present moment.
 * @returns Scheduled placements, gaps ahead of now, and elapsed time behind now.
 */
export function placeDay<Entry extends PlaceableEntry>(input: {
  readonly entries: readonly Entry[]
  readonly free: readonly Interval[]
  readonly now: number
}): DayPlacement<Entry> {
  const { entries, free: rawFree, now } = input

  // Drop zero-length intervals and sort defensively
  const free = rawFree
    .filter((interval) => interval.end > interval.start)
    .toSorted((a, b) => a.start - b.start)

  const scheduled: PlacedEntry<Entry>[] = []
  let phaseAIndex = 0
  let phaseACursor = free.length > 0 ? free[0]!.start : now
  let phaseAFurthest = phaseACursor

  // Phase A: Place done entries from each interval's start
  for (const entry of entries) {
    if (!entry.done) continue

    const placed = placeEntryInPhase(entry, free, phaseAIndex, phaseACursor, free[0]?.start ?? now)
    scheduled.push(placed)

    if (placed.startsAt !== null) {
      const minutes = entry.estimateMinutes ?? 0
      phaseAFurthest = placed.startsAt + minutes * MINUTE_MS
      // Update cursor and index for next entry
      phaseACursor = phaseAFurthest
      // Update phaseAIndex if we moved to a new interval
      while (phaseAIndex < free.length && free[phaseAIndex]!.end <= phaseACursor) {
        phaseAIndex += 1
      }
      if (phaseAIndex < free.length) {
        phaseACursor = Math.max(free[phaseAIndex]!.start, phaseACursor)
      }
    }
  }

  // Calculate floor
  const floor = Math.max(now, phaseAFurthest)

  // Phase B: Place outstanding entries from floor onwards
  let phaseBIndex = 0
  // Find which interval floor is in
  while (phaseBIndex < free.length && free[phaseBIndex]!.end <= floor) {
    phaseBIndex += 1
  }
  let phaseBCursor = phaseBIndex < free.length ? Math.max(free[phaseBIndex]!.start, floor) : floor

  for (const entry of entries) {
    if (entry.done) {
      // Already handled in phase A, check if we scheduled it
      if (scheduled.some((s) => s.entry.id === entry.id)) continue
    }

    const placed = placeEntryInPhase(entry, free, phaseBIndex, phaseBCursor, floor)
    scheduled.push(placed)

    if (placed.startsAt !== null) {
      const minutes = entry.estimateMinutes ?? 0
      phaseBCursor = placed.startsAt + minutes * MINUTE_MS
      // Update phaseBIndex if we moved to a new interval
      while (phaseBIndex < free.length && free[phaseBIndex]!.end <= phaseBCursor) {
        phaseBIndex += 1
      }
      if (phaseBIndex < free.length) {
        phaseBCursor = Math.max(free[phaseBIndex]!.start, phaseBCursor)
      }
    }
  }

  // Derive gaps and elapsed: for each free interval, subtract all placed spans
  const gaps: GapSpan[] = []
  const elapsed: ElapsedSpan[] = []

  for (const interval of free) {
    // Find all scheduled entries that fall in this interval
    const placedInInterval = scheduled
      .filter((s) => s.startsAt !== null)
      .map((s) => {
        const minutes = s.entry.estimateMinutes ?? 0
        const start = s.startsAt as number
        return { start, end: start + minutes * MINUTE_MS }
      })
      .filter((span) => span.start < interval.end && span.end > interval.start)

    const remainders = subtractSpans(interval, placedInInterval)

    for (const remainder of remainders) {
      if (remainder.end <= now) {
        elapsed.push({ startsAt: remainder.start, endsAt: remainder.end })
      } else if (remainder.start >= now) {
        gaps.push({ startsAt: remainder.start, endsAt: remainder.end })
      } else {
        // Remainder straddles now
        elapsed.push({ startsAt: remainder.start, endsAt: now })
        gaps.push({ startsAt: now, endsAt: remainder.end })
      }
    }
  }

  return { scheduled, gaps, elapsed }
}

/**
 * Place an entry in one of the phases. Walks from the current cursor through intervals.
 */
function placeEntryInPhase<Entry extends PlaceableEntry>(
  entry: Entry,
  free: readonly Interval[],
  startIndex: number,
  startCursor: number,
  minStart: number,
): PlacedEntry<Entry> {
  const minutes = entry.estimateMinutes ?? 0
  const durationMs = minutes * MINUTE_MS

  if (durationMs === 0) {
    // No estimate: place at cursor without consuming time
    return { entry, startsAt: startCursor }
  }

  // Try to fit this entry starting from startIndex and startCursor
  let cursor = Math.max(startCursor, minStart)
  for (let i = startIndex; i < free.length; i++) {
    const interval = free[i]!

    // Skip intervals that end at or before cursor
    if (interval.end <= cursor) continue

    // Adjust cursor to be within this interval
    cursor = Math.max(cursor, interval.start)

    // Check if entry fits in the remainder of this interval
    if (cursor + durationMs <= interval.end) {
      return { entry, startsAt: cursor }
    }

    // Entry doesn't fit in this interval, try next
    cursor = interval.end
  }

  // Entry didn't fit anywhere
  return { entry, startsAt: null }
}

/**
 * Subtract a list of spans from an interval, returning the remaining free parts.
 * Spans are assumed to be sorted and non-overlapping.
 */
function subtractSpans(interval: Interval, spans: readonly Interval[]): Interval[] {
  const remainders: Interval[] = []
  let cursor = interval.start

  for (const span of spans) {
    // Clip span to interval
    if (span.end <= interval.start || span.start >= interval.end) continue

    const clippedStart = Math.max(span.start, interval.start)
    const clippedEnd = Math.min(span.end, interval.end)

    // Add any gap before this span
    if (clippedStart > cursor) {
      remainders.push({ start: cursor, end: clippedStart })
    }

    cursor = clippedEnd
  }

  // Add any remaining time after the last span
  if (cursor < interval.end) {
    remainders.push({ start: cursor, end: interval.end })
  }

  // If nothing was subtracted, return the whole interval
  return remainders.length > 0 ? remainders : [interval]
}
