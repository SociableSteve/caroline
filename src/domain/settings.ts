/**
 * The handful of facts about the person using Caroline, as opposed to the deployment they run it
 * in. Spec 09: their name is data about a person, so it lives in the database rather than in
 * `caroline.config.json`, which nothing writes to.
 *
 * Pure. The rules here are the ones the write path enforces and the prompt relies on.
 */

/** The keys the `settings` table may hold. A key not in this union is not a setting. */
export type SettingKey = 'userName'

/**
 * A name is free text from outside the program that ends up inside a system prompt, so it is
 * constrained rather than trusted. Long enough for any name written out in full, short enough
 * that nothing else fits.
 */
export const USER_NAME_MAX = 80

/** Refused rather than stripped: what was typed is what is checked, and the reason is said. */
export type UserNameProblem = 'too-long' | 'not-one-line'

export interface UserNameRejected {
  readonly ok: false
  readonly problem: UserNameProblem
  readonly message: string
}

export interface UserNameAccepted {
  readonly ok: true
  /** Trimmed. Empty is a supported answer and means the preamble names nobody. */
  readonly value: string
}

/**
 * Surrounding whitespace is trimmed, because a trailing space is a typo rather than a decision.
 * Everything else about the text is either accepted as it stands or refused: a name silently
 * rewritten is a name the person did not choose.
 *
 * An empty name is not an error. Someone who would rather not be addressed by name says so by
 * clearing the field, and the preamble then omits that sentence entirely.
 */
export function validateUserName(raw: string): UserNameAccepted | UserNameRejected {
  const value = raw.trim()

  if (value.length > USER_NAME_MAX) {
    return {
      ok: false,
      problem: 'too-long',
      message: `A name is at most ${USER_NAME_MAX} characters.`,
    }
  }

  // One line, and no control characters in it. Both matter for the same reason: this text is
  // rendered into a system prompt, and a line break is how a value starts pretending to be an
  // instruction. `\p{Cc}` covers the newline, the carriage return, the tab and the rest of C0/C1.
  //
  // `\p{Zl}` and `\p{Zp}` are here because `\p{Cc}` does not reach them and neither does the
  // rendering: U+2028 and U+2029 are line boundaries that `JSON.stringify` passes through raw, so a
  // name carrying one would break the preamble's line in the one place a value must not.
  if (/[\p{Cc}\p{Zl}\p{Zp}]/u.test(value)) {
    return {
      ok: false,
      problem: 'not-one-line',
      message: 'A name is a single line of text, with no line breaks or control characters.',
    }
  }

  return { ok: true, value }
}
