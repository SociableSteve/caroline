# 06. Scheduler

## Purpose

Run sync, classification and daily planning on schedule, in-process, with an honest record
of what ran and what it did.

## Jobs

| Job | Default schedule | Does |
| --- | --- | --- |
| `sync` | Every 15 minutes | Runs every configured connector (spec 02) |
| `classify` | Hourly, at five past | Sorts the inbox (spec 04) |
| `plan` | Daily at a configurable local time, default 07:30 | Generates the day's plan (spec 05) |
| `purge` | Daily, early | Drops content past its retention window, and old run history (spec 09) |

`classify` depends on `sync` and `plan` depends on both. The scheduler runs a chain rather
than racing them: the hourly tick runs sync then classify; the daily tick runs sync, then
classify, then plan. A step that fails does not stop the chain: items already ingested are
still worth sorting, and a classification that never ran because GitHub was unreachable would
be a second failure caused by the first.

`classify` defaults to five past the hour rather than on it, so that its tick and the
quarter-hourly sync tick do not coincide. They would otherwise have the chain's own sync step
skipped as already running, for no reason but arithmetic.

Schedules are configurable per job, in cron syntax, resolved in the configured local
timezone so that a daily 07:30 stays at 07:30 across a DST change.

## Guarantees

- **No overlap.** A job already running is not started again; the tick is skipped and
  recorded as skipped.
- **Missed runs are collapsed.** After downtime, a job with missed occurrences runs once,
  not once per missed slot. Being offline for a day does not produce twenty-four
  classification runs.
- **Backoff on failure.** Consecutive failures push the next attempt back exponentially, up
  to a configurable ceiling (default 1 hour), and reset on success. Backoff moves the next
  attempt rather than skipping ticks, so it writes no rows: a skip means a run that was
  attempted and found the job already going. Skipped runs neither count towards a failure
  streak nor break one, because nothing was attempted.
- **Manual runs are first-class.** Triggering a job from the UI uses the same path and is
  recorded with `trigger: 'manual'`.
- **Silent by default.** Jobs do not notify. Results are discoverable in the UI: last-run
  status per job, counts of what changed, and a badge when the last run failed.

## Run history

Every attempt writes a `job_runs` row: job name, trigger, started-at, finished-at, status
(`success` | `failure` | `skipped`), a counts object (items ingested, tasks created, tasks
reclassified, LLM calls), and the error message and stack on failure. Retained for a
configurable window, default 30 days.

A run announces itself on the change feed (spec 08) twice: once when it starts and once when it
finishes. Announcing only the finish would have every open surface report the job as idle for the
whole time it was running, which is precisely the window somebody watching for a result is looking
at it in. The pair is what a surface reads, so the finish is announced whether the run succeeded,
failed, or could not even have its row written: a tab told that a run started and never told that
it ended reports the job as going until something unrelated happens.

The sync job writes a row per connector, named `sync:<provider>`, and one aggregate row named
`sync`. The aggregate answers "did the pass work at all", so it fails only when every
configured connector failed, which is the case where holding the whole job back is right; a
single broken connector names itself in its own row and in the aggregate's error message
without slowing the others down. The calendar is one of those connectors and writes
`sync:gcal` like the rest, even though it writes to `calendar_events` rather than to
`sources`: it is a pass over a provider, and the history should read that way.

## Startup

On start, the scheduler registers jobs, then checks each job's last successful run. If more
than one interval has elapsed, it runs that job once immediately, staggered so that a cold
start does not fire everything at the same second.

## Non-goals

- A separate worker process or an external queue. One process is enough for one user.
- Distributed locking. Two Caroline instances against one database is unsupported.
- Notifications of any kind in v1. If desktop or email notifications are wanted later, they
  get their own spec rather than being bolted onto job completion.

## Acceptance criteria

1. A job whose previous run is still in flight is skipped, and the skip is recorded.
2. Twenty-four hours of downtime produces exactly one catch-up run per due job on restart.
3. Three consecutive failures produce increasing delays that stop growing at the ceiling,
   and one success resets the delay.
4. A daily job configured for 07:30 fires at 07:30 local time on both sides of a DST
   boundary.
5. Every attempt, including skips and failures, writes a `job_runs` row.
6. A manual trigger of a running job returns a clear "already running" response rather than
   queueing a second run.
7. A job failure never leaves the process in a state where subsequent scheduled runs stop
   firing.

Making a run in progress visible while it is in progress adds the following, appended rather than
renumbered because the code and the suite cite these by number.

8. A run announces itself on the change feed when it starts, as well as when it finishes, whichever
   trigger asked for it. A surface showing whether a job is going is therefore told at the start of
   a scheduled run rather than only at the end of one. The two are paired: once a start has been
   announced the finish is announced too, even where writing the run's row failed, so a surface can
   never be left holding a start it is never told the end of.
