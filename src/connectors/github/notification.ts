/**
 * Recognising a GitHub pull request notification email. Pure, and driven by thread metadata only:
 * the default content policy stores no body (spec 09), so a rule that needed one would either not
 * work or would widen what Caroline keeps in order to work. Spec 02, notification emails as a
 * backup source.
 */
import type { BackupReference } from '../types.js'

/**
 * `owner/repo/pull/<number>` optionally followed by what the notification is about, at
 * `github.com`. This, rather than the subject line, is the identifier to read:
 *
 * - It says `pull`. An issue notification is `owner/repo/issues/<number>` and must not match,
 *   because an issue is not a pull request and this connector's scope is review requests.
 * - It names the repository and the number outright, where a subject carries them as
 *   `[owner/repo] Title (#123)`, which a mail client's reply prefix, a localised forward or a
 *   title containing brackets all interfere with.
 * - No human writes it, so it does not drift.
 *
 * The trailing segment covers the subtypes: `/c<id>` for a comment, `/review/<id>` for a review,
 * `/push/<sha>` and so on. All of them share the prefix, which is the part that identifies the
 * pull request.
 */
const PULL_REQUEST_MESSAGE_ID = /^([^/@\s]+)\/([^/@\s]+)\/pull\/(\d+)(?:\/[^@\s]*)?@github\.com$/

/**
 * A sender at github.com, including its subdomains: notifications come from
 * `notifications@github.com`, and the reply and no-reply addresses are on `*.github.com`.
 *
 * A `Message-ID` is written by whoever composed the message, so it is corroborated by who sent the
 * thread rather than trusted on its own. This is not a security boundary and cannot be one without
 * DKIM, which Gmail has already checked and does not report through the metadata; it is what keeps
 * a forwarded or quoted notification from being mistaken for one GitHub sent.
 */
const GITHUB_SENDER = /@(?:[a-z0-9-]+\.)*github\.com>?\s*$/i

/** What the recogniser reads. A subset of the Gmail connector's `ThreadMetadata`. */
interface NotificationMetadata {
  readonly messageIds?: unknown
  readonly from?: unknown
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : []
}

/**
 * Whether the thread was *sent* by GitHub. `from` only, which is the sender of the thread's first
 * message, and for a notification thread is `notifications@github.com` on every message in it.
 *
 * Deliberately not the participant list, which carries To and Cc as well. Anyone can put a
 * `github.com` address in a Cc line and a GitHub-shaped `Message-ID` on their own mail, and the
 * effect would be their email being suppressed instead of triaged, which is the one outcome this
 * rule must not produce by accident.
 */
function hasGitHubSender(metadata: NotificationMetadata): boolean {
  return typeof metadata.from === 'string' && GITHUB_SENDER.test(metadata.from.trim())
}

/**
 * The pull request a thread's metadata names, or null when it names none. Null is the answer to
 * everything that is not unambiguously a GitHub pull request notification: an issue notification,
 * a thread from somebody else quoting one, ordinary mail. Rule 3 of the backup-source rule takes
 * it from there, which is to leave the thread alone.
 */
export function identifyPullRequestNotification(metadata: unknown): BackupReference | null {
  if (typeof metadata !== 'object' || metadata === null) return null

  const fields = metadata as NotificationMetadata
  if (!hasGitHubSender(fields)) return null

  for (const messageId of strings(fields.messageIds)) {
    const match = PULL_REQUEST_MESSAGE_ID.exec(messageId.trim())
    if (match === null) continue

    const [, owner, name, number] = match
    if (owner === undefined || name === undefined || number === undefined) continue

    // The same `owner/name#number` form the connector keys its sources on, so the engine can look
    // the pull request up and the refresh path can parse it back into a ref.
    return { provider: 'github', externalId: `${owner}/${name}#${Number(number)}` }
  }

  return null
}
