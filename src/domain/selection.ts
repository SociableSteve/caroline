/**
 * What can be open in the rail and talked about. Spec 08: tasks and projects, and nothing else.
 *
 * The test is not whether an item has fields worth showing but whether the conversation can then do
 * anything with it, and every tool in spec 07's registry addresses a task or a project. A calendar
 * event, a job run and a plan entry have none.
 *
 * Here in the domain rather than in the client or the chat directory because both ends need the same
 * answer: the client puts a reference in the hash and the server takes one in a turn, and two parsers
 * would be two vocabularies.
 */

export const selectableKinds = ['task', 'project'] as const
export type SelectableKind = (typeof selectableKinds)[number]

/** The item the user has open: what kind of thing it is, and which one. */
export interface ItemRef {
  readonly kind: SelectableKind
  readonly id: string
}

/**
 * The longest id a reference may carry. Ids are uuids, and the bound is here because a reference
 * arrives from a hash somebody can type anything into.
 */
export const ITEM_ID_MAX = 64

/** The text form, which is what travels in the URL: `task:abc`. */
export function formatItemRef(ref: ItemRef): string {
  return `${ref.kind}:${ref.id}`
}

/**
 * A reference read back, or null when the text is not one. Null rather than a throw, because the text
 * comes from the address bar: an unparseable hash is nothing selected, not a crash.
 */
export function parseItemRef(text: string): ItemRef | null {
  const separator = text.indexOf(':')
  if (separator <= 0) return null

  const kind = text.slice(0, separator)
  const id = text.slice(separator + 1)

  if (id === '' || id.length > ITEM_ID_MAX) return null
  if (!(selectableKinds as readonly string[]).includes(kind)) return null

  return { kind: kind as SelectableKind, id }
}

/** Whether two references name the same item. Written once, because three surfaces ask. */
export function sameItem(first: ItemRef | null, second: ItemRef | null): boolean {
  if (first === null || second === null) return first === second
  return first.kind === second.kind && first.id === second.id
}
