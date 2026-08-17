/**
 * The in-memory registry a long-lived stream uses to hear about its own session ending. Spec
 * 13: "Revoking or expiring a session closes the feeds that session opened" (criterion 22) and
 * cuts a chat turn's stream (criterion 23). One process, one database, so a registry kept in
 * memory here is the whole mechanism: nothing here is persisted, and nothing needs to be.
 */

const listeners = new Map<string, Set<() => void>>()

/**
 * Registers `listener` against `sessionId`, and returns the function that stops listening. A
 * route with no session to watch (`authRequired` false) passes `null` or `undefined`, and gets
 * a no-op back, so every streaming route's own guard against that case collapses to one call
 * here rather than a ternary repeated at each call site.
 */
export function onSessionEnded(
  sessionId: string | null | undefined,
  listener: () => void,
): () => void {
  if (sessionId === null || sessionId === undefined) return () => {}

  let set = listeners.get(sessionId)
  if (set === undefined) {
    set = new Set()
    listeners.set(sessionId, set)
  }
  set.add(listener)

  return () => {
    set?.delete(listener)
    if (set?.size === 0) listeners.delete(sessionId)
  }
}

/** Fires every listener registered for `sessionId`, once, and forgets them. Called on logout,
 * and by anything that discovers on its own that a session it holds has expired. */
export function notifySessionEnded(sessionId: string): void {
  const set = listeners.get(sessionId)
  if (set === undefined) return

  listeners.delete(sessionId)
  for (const listener of set) listener()
}

/** For tests: how many listeners a session still has registered. */
export function listenerCount(sessionId: string): number {
  return listeners.get(sessionId)?.size ?? 0
}
