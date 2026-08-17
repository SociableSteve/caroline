/**
 * The vocabulary of a conversation, as a record rather than as an act. The turn loop lives in
 * `src/chat`; this is the part the database, the API and the UI share. Spec 07.
 *
 * Pure: no database, no clock. The lists are what `test/db/schema.test.ts` holds migration 6 to.
 */

/**
 * Who said a thing. The system prompt is not a message: it is assembled per turn from the
 * current counts, plan and capacity, so a stored copy of it would be a stored copy of
 * yesterday's numbers.
 */
export const chatRoles = ['user', 'assistant'] as const
export type ChatRole = (typeof chatRoles)[number]

/** What a recorded change was to. Enough for the transcript to link to the thing it names. */
export const chatChangeEntities = ['task', 'project', 'plan'] as const
export type ChatChangeEntity = (typeof chatChangeEntities)[number]

/**
 * Why an operation was held rather than performed.
 *
 * `delete` is spec 07 criterion 3: a delete is never executed on the model's word alone.
 * `bulk` is criterion 4: past the configured number of tasks in one turn, the rest of the turn
 * is proposed rather than applied.
 */
export const chatConfirmationReasons = ['delete', 'bulk'] as const
export type ChatConfirmationReason = (typeof chatConfirmationReasons)[number]

/** What the user did about it. Absent while it is still on the screen waiting. */
export const chatConfirmationDecisions = ['confirmed', 'rejected'] as const
export type ChatConfirmationDecision = (typeof chatConfirmationDecisions)[number]

/**
 * Which kind of caller a conversation belongs to. Spec 12: a session is a conversation, so
 * `chat_conversations` carries the source that says which it was, and the browser is `browser`
 * exactly as it always was rather than a new value invented for symmetry.
 */
export const chatConversationSources = ['browser', 'mcp'] as const
export type ChatConversationSource = (typeof chatConversationSources)[number]

/**
 * The inverse of one change, decided and written when the change is made, because that is the
 * last moment the previous values exist to be read. Spec 07: undo is a stored inverse
 * operation, not a general history rewind.
 *
 * A restore carries the whole prior row rather than a patch of what moved, so replaying it puts
 * the task back as it was rather than as the difference between two guesses.
 */
export type ChatInverse =
  /** The task existed and held these values. Its tags and source links go back with it. */
  | {
      readonly kind: 'restore-task'
      readonly task: Record<string, unknown>
      readonly tags: readonly string[]
      /** Sources whose link to the task a delete cleared, so undo can reattach them. */
      readonly sourceIds?: readonly string[]
      /** Daily-plan entries whose link a delete cleared, for the same reason. */
      readonly planEntryIds?: readonly string[]
    }
  /** The task did not exist, so putting things back means it does not exist again. */
  | { readonly kind: 'delete-task'; readonly id: string }
  | { readonly kind: 'restore-project'; readonly project: Record<string, unknown> }
  | { readonly kind: 'delete-project'; readonly id: string }
  /**
   * Where a connector's state machine was before the turn moved it. Only the three fields the
   * move touches, so an inverse never carries a stored message body with it (spec 09).
   */
  | {
      readonly kind: 'restore-source-lifecycle'
      readonly id: string
      readonly lifecycleState: string | null
      readonly actedAt: number | null
      readonly actedAtMarker: string | null
    }
