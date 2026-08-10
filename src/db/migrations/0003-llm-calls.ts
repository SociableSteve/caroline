import type { Migration } from '../migrate.js'

/**
 * One row per model call, written whether or not the call worked. Spec 03 asks for provider,
 * model, purpose, token usage and duration, and for failed calls that consumed tokens to be
 * recorded too: a call that answered and then failed validation still cost what it cost, and
 * a cost view that quietly dropped those would understate the expensive case.
 *
 * As in `0001` and `0002`, the allowed values are written out literally rather than read
 * from `src/domain`, because a migration is a frozen historical record.
 * `test/db/schema.test.ts` asserts the two stay in step.
 */
export const llmCalls: Migration = {
  id: 3,
  name: 'llm calls',
  up(database) {
    // No `none` in the provider check: `none` is a configuration state, not something that
    // can have made a call.
    database.exec(`
      create table llm_calls (
        id text primary key,
        provider text not null check (provider in ('anthropic', 'openai', 'ollama')),
        model text not null,
        purpose text not null check (purpose in ('classification', 'planning', 'chat')),
        started_at integer not null,
        -- SQLite's column types are affinities, not constraints, so a negative or
        -- fractional count would be stored as given. A negative token count subtracts
        -- from a usage total silently, which is the one way a cost view can be wrong
        -- without looking wrong.
        duration_ms integer not null check (typeof(duration_ms) = 'integer' and duration_ms >= 0),
        input_tokens integer not null check (typeof(input_tokens) = 'integer' and input_tokens >= 0),
        output_tokens integer not null check (
          typeof(output_tokens) = 'integer' and output_tokens >= 0
        ),
        status text not null check (status in ('success', 'invalid', 'error')),
        error text
      )
    `)

    // The two questions the cost view asks: what did today cost, and what did this job cost.
    // Purpose leads the second index because it is the one that is filtered rather than
    // ordered by.
    database.exec('create index llm_calls_started_at on llm_calls (started_at)')
    database.exec('create index llm_calls_purpose on llm_calls (purpose, started_at)')
  },
}
