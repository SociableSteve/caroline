/**
 * Turning a Gmail thread into a `SourceItem`. Pure, so what a thread becomes can be asserted
 * against a recorded fixture with no client and no database near it. Spec 02.
 *
 * The body is carried on the item as fetched. What is *stored* is the engine's decision, and
 * what is *sent* is the classifier's: one store boundary and one send boundary, rather than a
 * policy each connector applies its own way. Spec 09.
 */
import type { SourceItem } from '../types.js'
import type { GmailMessage, GmailPart, GmailThread } from './api.js'

/** The metadata spec 02 asks be retained for a thread. No body: that is `content`. */
export interface ThreadMetadata {
  readonly threadId: string
  readonly subject: string | null
  /** Everyone on the thread, from and to alike, deduplicated and in the order first seen. */
  readonly participants: readonly string[]
  readonly from: string | null
  readonly messageCount: number
  readonly lastMessageAt: number | null
  readonly labels: readonly string[]
}

function header(message: GmailMessage, name: string): string | null {
  const found = message.payload?.headers?.find(
    (candidate) => candidate.name?.toLowerCase() === name.toLowerCase(),
  )
  return found?.value ?? null
}

/** Gmail sends `internalDate` as epoch milliseconds in a string. */
function internalDate(message: GmailMessage): number | null {
  const raw = message.internalDate
  if (raw === undefined) return null
  const parsed = Number(raw)
  return Number.isFinite(parsed) ? parsed : null
}

/** Every address on a header, as Gmail wrote it. Not parsed: the display name is part of who. */
function addresses(value: string | null): string[] {
  if (value === null) return []
  return value
    .split(',')
    .map((address) => address.trim())
    .filter((address) => address !== '')
}

export function toThreadMetadata(thread: GmailThread): ThreadMetadata {
  const messages = thread.messages ?? []
  const first = messages[0]
  const last = messages.at(-1)

  const participants: string[] = []
  for (const message of messages) {
    for (const name of ['From', 'To', 'Cc']) {
      for (const address of addresses(header(message, name))) {
        if (!participants.includes(address)) participants.push(address)
      }
    }
  }

  const labels = new Set<string>()
  for (const message of messages) {
    for (const label of message.labelIds ?? []) labels.add(label)
  }

  return {
    threadId: thread.id,
    subject: first === undefined ? null : header(first, 'Subject'),
    participants,
    from: first === undefined ? null : header(first, 'From'),
    messageCount: messages.length,
    lastMessageAt: last === undefined ? null : internalDate(last),
    labels: [...labels].sort(),
  }
}

/**
 * The first readable text of the thread's last message, decoded. Plain text is preferred over
 * HTML because it is what the model reads better and what a snippet cap measures sensibly;
 * Gmail's own one-line preview is the fallback, since a thread with no decodable part still has
 * a subject and a sender worth classifying.
 *
 * The last message rather than the first: what a thread needs doing about is whatever was said
 * most recently in it.
 */
export function threadBody(thread: GmailThread): string | null {
  const last = thread.messages?.at(-1)
  if (last === undefined) return null

  // Two whole passes rather than one with a fallback inside it. A single pass that fell back to
  // HTML wherever plain text ran out would return the first HTML part it reached, and a plain
  // alternative in a later branch of the tree would never be visited.
  const payload = last.payload
  const text =
    payload === undefined
      ? null
      : (findText(payload, 'text/plain') ?? findText(payload, 'text/html'))
  if (text !== null) return text

  const snippet = last.snippet
  return snippet === undefined || snippet === '' ? null : snippet
}

/**
 * Walks the MIME tree for a part of one type. Attachments are skipped whatever their type: spec 02
 * makes attachment contents a non-goal, and a text attachment is still an attachment.
 */
function findText(part: GmailPart, wanted: string): string | null {
  if (part.filename !== undefined && part.filename !== '') return null

  if (part.mimeType === wanted) {
    const decoded = decode(part.body?.data)
    if (decoded !== null) return decoded
  }

  for (const child of part.parts ?? []) {
    const found = findText(child, wanted)
    if (found !== null) return found
  }

  return null
}

function decode(data: string | undefined): string | null {
  if (data === undefined || data === '') return null
  const decoded = Buffer.from(data, 'base64url').toString('utf8').trim()
  return decoded === '' ? null : decoded
}

/** Where the thread is in Gmail. The account index is not knowable here, so it is left to Gmail. */
export function threadUrl(threadId: string): string {
  return `https://mail.google.com/mail/u/0/#all/${threadId}`
}

/** A thread with no subject still needs something on the card. */
export const NO_SUBJECT = '(no subject)'

/**
 * A thread becomes an inbox task attributed to sync, awaiting classification. Gmail declares no
 * tracked statuses (spec 02), so where the task goes after capture is the user's decision and
 * not something reasserted every fifteen minutes.
 */
export function toSourceItem(thread: GmailThread): SourceItem {
  const metadata = toThreadMetadata(thread)
  const body = threadBody(thread)

  return {
    externalId: thread.id,
    url: threadUrl(thread.id),
    title: metadata.subject ?? NO_SUBJECT,
    metadata: { ...metadata },
    ...(body === null ? {} : { content: body }),
    occurredAt: metadata.lastMessageAt ?? 0,
    task: { status: 'inbox' },
  }
}
