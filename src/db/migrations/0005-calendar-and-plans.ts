import type { Migration } from '../migrate.js'

/**
 * What the calendar and the daily plan need: somewhere to keep the events capacity is computed
 * from, and somewhere to keep each day's plan and the ones before it. Specs 02 and 05.
 *
 * As in the earlier migrations, the allowed values are written out literally rather than read
 * from `src/domain`, because a migration is a frozen historical record. `test/db/schema.test.ts`
 * asserts the two stay in step.
 */
export const calendarAndPlans: Migration = {
  id: 5,
  name: 'calendar and plans',
  up(database) {
    /*
     * Calendar events. There is deliberately no task column: spec 02 criterion 7 says an event
     * never becomes a task in any code path, and a table with nowhere to write one is a stronger
     * statement of that than a rule some future connector has to remember.
     *
     * Nor is there a body. An event contributes a start, an end and whether it counts; the
     * summary is shown on the dashboard and nothing else is kept, which is what spec 02's
     * "metadata retained" list comes to.
     */
    database.exec(`
      create table calendar_events (
        id text primary key,
        calendar_id text not null,
        external_id text not null,
        summary text,
        starts_at integer not null,
        ends_at integer not null,
        all_day integer not null check (all_day in (0, 1)),
        -- Yours, not the organiser's. Declining is what releases the time. Spec 05.
        response_status text not null check (
          response_status in ('accepted', 'tentative', 'declined', 'needsAction')
        ),
        -- Google's word for "shows me as busy". Transparent events do not consume capacity.
        transparency text not null check (transparency in ('opaque', 'transparent')),
        status text not null check (status in ('confirmed', 'tentative', 'cancelled')),
        attendee_count integer not null default 0 check (attendee_count >= 0),
        url text,
        -- Which pass last saw it. What lets a pass sweep up events cancelled upstream, which
        -- simply stop appearing rather than arriving as a deletion.
        synced_at integer not null,
        -- An event that ends before it starts would contribute negative busy time.
        check (ends_at >= starts_at)
      )
    `)

    // One row per event per calendar. The same meeting on two calendars is two claims on the
    // day as far as the store is concerned; the union in `computeCapacity` is what counts it once.
    database.exec(
      'create unique index calendar_events_external on calendar_events (calendar_id, external_id)',
    )
    // The only question asked of this table: what is on between these two moments.
    database.exec('create index calendar_events_range on calendar_events (starts_at, ends_at)')

    /*
     * One row per generation, not per day. Spec 05 criterion 8: regenerating creates a new plan
     * and preserves the previous one, so the current plan for a date is the newest row for it
     * rather than the only row for it.
     */
    database.exec(`
      create table daily_plans (
        id text primary key,
        -- The local calendar date, as YYYY-MM-DD. Text rather than an instant, because a plan
        -- belongs to a day on a wall calendar and not to a moment.
        plan_date text not null,
        generated_at integer not null,
        -- The zone the date and the working window were read in, so a plan drawn before a
        -- configuration change still says what it meant.
        time_zone text not null,
        window_minutes integer not null,
        busy_minutes integer not null,
        reserve_minutes integer not null,
        -- Deliberately unconstrained: a day with more meetings in it than working hours has a
        -- negative capacity, and spec 05 asks the plan to say so rather than round it up to nothing.
        capacity_minutes integer not null,
        -- False when no calendar is connected, so the window was assumed free. The plan says
        -- that its capacity is unverified rather than implying a clear diary. Criterion 10.
        capacity_verified integer not null check (capacity_verified in (0, 1)),
        provider text,
        model text,
        -- Which version of the prompt drew this, so a change in behaviour is traceable to a
        -- change in what was asked. As for classifications, spec 04.
        prompt_version text not null,
        summary text,
        -- The warnings, as a JSON array. A plan that had to leave something out says so.
        warnings text
      )
    `)

    database.exec('create index daily_plans_date on daily_plans (plan_date, generated_at)')

    /*
     * The plan's contents. Three kinds in one table because they are one ordered output with
     * three sections, and a reader of a plan wants them together: what is planned, what is there
     * if the day opens up, and who needs chasing.
     */
    database.exec(`
      create table daily_plan_entries (
        id text primary key,
        plan_id text not null references daily_plans (id) on delete cascade,
        kind text not null check (kind in ('plan', 'overflow', 'nudge')),
        rank integer not null check (rank >= 1),
        -- Nulled rather than deleted when the task goes: a plan is a record of what was
        -- proposed on a day, and the record outlives the task it named.
        task_id text references tasks (id) on delete set null,
        -- Snapshotted for the same reason. What the plan called it is what the plan said.
        title text not null,
        rationale text,
        -- The estimate the entry was fitted with, which is not always the task's own: spec 05
        -- fits a task with no estimate at the configured default.
        estimate_minutes integer,
        -- Nudges only. Who it is on, and since when. Spec 05.
        waiting_on text,
        waiting_since integer,
        pushed_since_review integer not null default 0 check (pushed_since_review in (0, 1)),
        -- One entry per position per section. Two entries ranked third in the same list would
        -- leave the order of a plan up to whichever row came back first.
        unique (plan_id, kind, rank)
      )
    `)

    database.exec(
      'create index daily_plan_entries_plan on daily_plan_entries (plan_id, kind, rank)',
    )
  },
}
