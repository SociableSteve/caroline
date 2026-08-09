/**
 * Which statuses a provider's connector owns transitions within. Spec 01 makes this the
 * connector's declaration, so it lives beside the connectors conceptually but is kept here,
 * pure, because the API needs it before any connector exists: the user filing a tracked
 * item outside its set is a permanent opt-out, and the API is where the user does that.
 */
import type { SourceProvider } from './source.js'
import { githubTrackedStatuses, type TaskStatus } from './task.js'

/**
 * `undefined` means the provider declares no set. That is not the same as an empty one: a
 * connector with no lifecycle to own cannot have an opt-out from it, so a user status
 * change leaves tracking alone rather than switching it off. Gmail is the case in point,
 * spec 02 gives it no state machine, only inbox capture.
 */
export function trackedStatusesFor(provider: SourceProvider): readonly TaskStatus[] | undefined {
  return provider === 'github' ? githubTrackedStatuses : undefined
}
