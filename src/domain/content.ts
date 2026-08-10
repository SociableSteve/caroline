/**
 * How much of an item's content is in play, as a vocabulary rather than as a setting. Spec 09
 * sets two of these independently, one for what is stored and one for what is sent, and both
 * the configuration and the source row speak in these terms.
 *
 * Here rather than in `src/config` because a source row records the level its body was written
 * under, and a domain type that reached into the configuration for its vocabulary would have
 * the two directories importing each other.
 */

/** Ordered from least to most exposure. */
export const contentLevels = ['none', 'metadata', 'snippet', 'full'] as const
export type ContentLevel = (typeof contentLevels)[number]

export const contentLevelRank: Record<ContentLevel, number> = {
  none: 0,
  metadata: 1,
  snippet: 2,
  full: 3,
}
