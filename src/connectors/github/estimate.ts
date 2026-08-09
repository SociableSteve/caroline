/**
 * How long a pull request will take to review, from its size. Spec 02 asks for a fixed,
 * documented heuristic that seeds `estimate_minutes` and is then editable, and this is it.
 *
 *     minutes = 10 + 2 per changed file + 1 per 20 changed lines
 *
 * rounded to the nearest five minutes and clamped between ten minutes and four hours.
 *
 * The three terms are the three costs: opening it and reading what it is for, moving
 * between files, and reading the lines themselves. Files are weighted more heavily than
 * lines because a diff spread over twenty files is a harder read than the same number of
 * lines in one, and a generated lockfile is the case the clamp exists for.
 *
 * It is a starting point, deliberately crude. The point is that a Review column of twenty
 * pull requests has some notion of its own size before anybody has estimated anything.
 */
export interface PullRequestSize {
  readonly additions: number
  readonly deletions: number
  readonly changedFiles: number
}

export const MINIMUM_REVIEW_MINUTES = 10
export const MAXIMUM_REVIEW_MINUTES = 240

const BASE_MINUTES = 10
const MINUTES_PER_FILE = 2
const LINES_PER_MINUTE = 20
const ROUNDING = 5

export function estimateReviewMinutes(size: PullRequestSize): number {
  const lines = Math.max(0, size.additions) + Math.max(0, size.deletions)
  const raw =
    BASE_MINUTES + MINUTES_PER_FILE * Math.max(0, size.changedFiles) + lines / LINES_PER_MINUTE

  const rounded = Math.round(raw / ROUNDING) * ROUNDING

  return Math.min(MAXIMUM_REVIEW_MINUTES, Math.max(MINIMUM_REVIEW_MINUTES, rounded))
}
