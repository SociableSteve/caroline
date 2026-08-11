import type { Migration } from '../migrate.js'

/**
 * What a turn sent about the item the user had open. Spec 07: the record is of the resolved context
 * rather than of an id, because the content policy can suppress a field or truncate it, so the same
 * task reaches the provider differently depending on settings the user can change between one turn
 * and the next.
 *
 * One row per turn, so the message id is the key: a turn resolves one context, at the moment it is
 * sent. It cascades with the message, as the changes and confirmations of a turn do.
 *
 * `rendered` is the text the provider was handed, word for word. It can be kept because nothing is
 * fetched to build it: the context is assembled from rows already on disk under `storeContent`.
 */
export const turnContext: Migration = {
  id: 10,
  name: 'turn-context',
  up(database) {
    database.exec(`
      create table chat_turn_contexts (
        message_id text primary key references chat_messages (id) on delete cascade,
        -- The two kinds the rail can open, written out literally: a migration is a frozen record and
        -- must not change when a domain constant does. The schema tests keep the two honest.
        item_kind text not null check (item_kind in ('task', 'project')),
        item_id text not null,
        -- False where the item had gone by the time the message was sent, which the model was told.
        item_found integer not null check (item_found in (0, 1)),
        -- The fields that actually went, as a JSON array. Absent fields are not listed, so this reads
        -- as an audit rather than as a schema.
        fields text not null,
        content_level text not null
          check (content_level in ('none', 'metadata', 'snippet', 'full')),
        policy_version text not null,
        rendered text not null,
        created_at integer not null
      )
    `)
  },
}
