/**
 * The content policy, applied. Spec 09 sets two levels independently: how much of an item is
 * persisted, and how much is sent to a model. Both are answered here, so that the store
 * boundary and the send boundary cannot come to different conclusions about what `snippet`
 * means.
 *
 * Pure. Nothing here reads a database or a clock.
 */
import { contentLevelRank, type ContentLevel } from '../domain/content.js'

export interface ContentPolicy {
  readonly llmContent: ContentLevel
  readonly storeContent: ContentLevel
  readonly snippetChars: number
}

/**
 * Bumped whenever what a level means changes: which fields a level lets through, or how a body is
 * cut. Recorded alongside anything this policy shaped, because a record saying `snippet` is only
 * readable later if it also says what `snippet` meant at the time. Dated, as the prompts are.
 */
export const CONTENT_POLICY_VERSION = '2026-08-11'

/** True when `level` permits at least as much as `needed`. */
export function levelAllows(level: ContentLevel, needed: ContentLevel): boolean {
  return contentLevelRank[level] >= contentLevelRank[needed]
}

/** The lower of two levels, which is what "never more than either allows" comes down to. */
export function lowerLevel(first: ContentLevel, second: ContentLevel): ContentLevel {
  return contentLevelRank[first] <= contentLevelRank[second] ? first : second
}

/**
 * The body as a given level permits it. `none` and `metadata` permit no body at all, `snippet`
 * the first `snippetChars` of it, `full` the whole thing.
 *
 * Truncation is by characters rather than by words, because the cap is a disclosure limit and
 * not a display one: rounding it up to a word boundary would send characters the policy did
 * not allow.
 */
export function contentAtLevel(
  content: string | null | undefined,
  level: ContentLevel,
  snippetChars: number,
): string | null {
  if (content === null || content === undefined || content === '') return null
  if (!levelAllows(level, 'snippet')) return null
  if (level === 'full') return content

  return content.length <= snippetChars ? content : content.slice(0, snippetChars)
}

/** A body-shaped field on its way to a model, and whether the policy cut it short. */
export interface TextToSend {
  readonly text: string | null
  /** True where there was more of it than the level allowed, so a model is not told a part is whole. */
  readonly truncated: boolean
}

/**
 * One of Caroline's own body-shaped fields, as `llmContent` permits it. A task's notes are the case:
 * spec 09 counts a title as metadata and notes as the body, so `metadata` sends the one and not the
 * other.
 *
 * Both senders of a note call this, the item context and `get_task`, because two answers to whether a
 * note may leave the machine would mean the policy is decoration.
 */
export function textToSend(
  text: string | null | undefined,
  policy: Pick<ContentPolicy, 'llmContent' | 'snippetChars'>,
): TextToSend {
  const sent = contentAtLevel(text, policy.llmContent, policy.snippetChars)

  return {
    text: sent,
    truncated: sent !== null && sent !== text,
  }
}

/**
 * What may be persisted, and the level it is persisted under. The level is recorded alongside
 * the text because the text alone cannot say which it is: three hundred characters may be a
 * truncated snippet or a short body in full, and lowering the policy later has to tell them
 * apart. Spec 09, criterion 4.
 */
export interface StoredContent {
  readonly content: string | null
  readonly level: ContentLevel
}

/** The store boundary. With `storeContent: none` this returns null for every item. Spec 09. */
export function contentToStore(
  content: string | null | undefined,
  policy: Pick<ContentPolicy, 'storeContent' | 'snippetChars'>,
): StoredContent {
  return {
    content: contentAtLevel(content, policy.storeContent, policy.snippetChars),
    level: policy.storeContent,
  }
}

/**
 * Re-applying the policy to a body already stored, for the case where `storeContent` has been
 * lowered since it was written. Returns null when nothing needs doing, so the purge can count
 * the rows it actually changed. Spec 09, criterion 4.
 */
export function purgedContent(
  content: string | null,
  storedLevel: ContentLevel,
  policy: Pick<ContentPolicy, 'storeContent' | 'snippetChars'>,
): StoredContent | null {
  if (levelAllows(policy.storeContent, storedLevel)) return null

  const next = contentAtLevel(content, policy.storeContent, policy.snippetChars)
  // A row whose body is already within the new level has nothing to purge, however it was
  // labelled: a full body of two words is its own snippet. Reporting it as purged would inflate
  // the count spec 09 criterion 4 asks be honest.
  return next === content ? null : { content: next, level: policy.storeContent }
}

/**
 * What each level means, in the words the settings screen shows. Spec 09 asks that every
 * control which changes exposure state its consequence in plain language rather than only its
 * name, so the sentence lives next to the rule it describes rather than in the UI.
 */
export const llmLevelConsequences: Readonly<Record<ContentLevel, string>> = {
  none: 'Nothing about an item is sent to the model, so classification cannot work.',
  metadata:
    'Sender, subject, labels, timestamps and pull request statistics are sent. No message body leaves this machine.',
  snippet: 'The above, plus the first part of the message body, leaves this machine.',
  full: 'The above, plus the complete message body, leaves this machine.',
}

export const storeLevelConsequences: Readonly<Record<ContentLevel, string>> = {
  none: 'No item content is written to the database at all.',
  metadata: 'Sender, subject, labels and timestamps are stored. No message body is kept on disk.',
  snippet: 'The above, plus the first part of the message body, is kept on disk.',
  full: 'The above, plus the complete message body, is kept on disk.',
}
