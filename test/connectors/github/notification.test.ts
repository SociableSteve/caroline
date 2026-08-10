/**
 * Recognising a GitHub pull request notification from a Gmail thread's metadata. Spec 02,
 * notification emails as a backup source: the recognition half of criteria 19 to 23.
 *
 * Driven from the recorded threads rather than from hand-built metadata, so what is asserted is
 * what the connector actually produces for a real notification. The negatives vary one field of
 * that at a time, which is the only way to know which field the answer turned on.
 */
import { describe, expect, it } from 'vitest'
import { toThreadMetadata } from '../../../src/connectors/gmail/map.js'
import { identifyPullRequestNotification } from '../../../src/connectors/github/notification.js'
import { gmailFixture } from '../../helpers/gmail.js'

/** The metadata the Gmail connector puts on a source, for a recorded thread. */
function metadataOf(fixture: string): Record<string, unknown> {
  return { ...toThreadMetadata(gmailFixture(fixture)) }
}

const reviewRequest = (): Record<string, unknown> => metadataOf('thread-github-review-request')

describe('a GitHub review-request notification', () => {
  it('names the pull request it is about, in the form the connector keys sources on', () => {
    expect(identifyPullRequestNotification(reviewRequest())).toEqual({
      provider: 'github',
      externalId: 'example-org/example-service#42',
    })
  })

  it('is recognised from a later comment on the thread as well as the first message', () => {
    const commentOnly = {
      ...reviewRequest(),
      messageIds: ['example-org/example-service/pull/42/c2211334455@github.com'],
    }

    expect(identifyPullRequestNotification(commentOnly)).toEqual({
      provider: 'github',
      externalId: 'example-org/example-service#42',
    })
  })

  it.each([
    ['a review', 'example-org/example-service/pull/42/review/9988776@github.com'],
    ['a push', 'example-org/example-service/pull/42/push/abc123@github.com'],
    ['the pull request itself', 'example-org/example-service/pull/42@github.com'],
  ])('is recognised when the notification is about %s', (_what, messageId) => {
    const metadata = { ...reviewRequest(), messageIds: [messageId] }

    expect(identifyPullRequestNotification(metadata)?.externalId).toBe(
      'example-org/example-service#42',
    )
  })
})

describe('what is not a pull request notification', () => {
  it('is not an issue notification, whose id says issues rather than pull', () => {
    expect(identifyPullRequestNotification(metadataOf('thread-github-issue'))).toBeNull()
  })

  it('is not ordinary correspondence', () => {
    expect(identifyPullRequestNotification(metadataOf('thread-hub-numbers'))).toBeNull()
  })

  it('is not a GitHub-shaped message id from somebody who is not GitHub', () => {
    const forwarded = {
      ...metadataOf('thread-hub-numbers'),
      messageIds: ['example-org/example-service/pull/42@github.com'],
    }

    expect(identifyPullRequestNotification(forwarded)).toBeNull()
  })

  it('is not a GitHub sender with nothing to identify a pull request by', () => {
    expect(identifyPullRequestNotification({ ...reviewRequest(), messageIds: [] })).toBeNull()
  })

  it.each([
    ['a lookalike host', 'example-org/example-service/pull/42@github.com.example'],
    ['no number', 'example-org/example-service/pull/@github.com'],
    ['no repository', 'example-service/pull/42@github.com'],
    ['a discussion', 'example-org/example-service/discussions/42@github.com'],
  ])('is not a message id with %s', (_what, messageId) => {
    const metadata = { ...reviewRequest(), messageIds: [messageId] }

    expect(identifyPullRequestNotification(metadata)).toBeNull()
  })

  it('is not metadata of the wrong shape, which a stored row could still hold', () => {
    expect(identifyPullRequestNotification(null)).toBeNull()
    expect(identifyPullRequestNotification('a string')).toBeNull()
    expect(identifyPullRequestNotification({ messageIds: 'not a list', from: 1 })).toBeNull()
  })
})
