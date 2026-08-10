/**
 * The change feed. Every write the API makes announces itself here, and the SSE route in
 * `routes/changes.ts` relays it to whatever browser tabs are open, so a change made in one
 * place appears in another without a refresh. Spec 08.
 *
 * Deliberately not a payload of what changed: the client refetches the view it is showing.
 * A single-user process with one open tab has nothing to gain from diffing, and a kind is
 * enough for a client to decide whether it cares.
 */

/**
 * What changed, coarsely. Enough for a client to know which of its queries went stale. `jobs`
 * covers a run starting or finishing, which changes the jobs surface and the dashboard badge
 * without necessarily changing a single task.
 */
export const changeKinds = ['tasks', 'projects', 'jobs'] as const
export type ChangeKind = (typeof changeKinds)[number]

export interface ChangeEvent {
  readonly kind: ChangeKind
  readonly at: number
}

export type ChangeListener = (event: ChangeEvent) => void

export interface ChangeFeed {
  publish(event: ChangeEvent): void
  /** Returns the unsubscribe function. Calling it twice is harmless. */
  subscribe(listener: ChangeListener): () => void
  /** How many streams are open. Only the tests care, and they care a lot. */
  subscriberCount(): number
}

export function createChangeFeed(): ChangeFeed {
  const listeners = new Set<ChangeListener>()

  return {
    publish(event) {
      for (const listener of listeners) {
        try {
          listener(event)
        } catch {
          // A tab whose socket has gone away throws on write, and one dead socket must not
          // stop a live one being told. The route removes itself on close; this covers the
          // window before that happens.
        }
      }
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    subscriberCount() {
      return listeners.size
    },
  }
}
