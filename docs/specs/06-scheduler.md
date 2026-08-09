# 06. Scheduler

## Purpose

Run sync, classification and daily planning on schedule, in-process, with an honest record
of what ran and what it did.

## Jobs

| Job | Default schedule | Does |
| --- | --- | --- |
| `sync` | Every 15 minutes | Runs every configured connector (spec 02) |
| `classify` | Hourly | Sorts the inbox (spec 04) |
| `plan` | Daily at a configurable local time | Generates the day's plan (spec 05) |

`classify` depends on `sync` and `plan` depends on both. The scheduler runs a chain rather
than racing them: the hourly tick runs sync then classify; the daily tick runs sync, then
classify, then plan.

Schedules are configurable per job, in cron syntax, resolved in the configured local
timezone so that a daily 07:30 stays at 07:30 across a DST change.

## Guarantees

- **No overlap.** A job already running is not started again; the tick is skipped and
  recorded as skipped.
- **Missed runs are collapsed.** After downtime, a job with missed occurrences runs once,
  not once per missed slot. Being offline for a day does not produce twenty-four
  classification runs.
- **Backoff on failure.** Consecutive failures push the next attempt back exponentially, up
  to a configurable ceiling (default 1 hour), and reset on success.
- **Manual runs are first-class.** Triggering a job from the UI uses the same path and is
  recorded with `trigger: 'manual'`.
- **Silent by default.** Jobs do not notify. Results are discoverable in the UI: last-run
  status per job, counts of what changed, and a badge when the last run failed.

## Run history

Every attempt writes a `job_runs` row: job name, trigger, started-at, finished-at, status
(`success` | `failure` | `skipped`), a counts object (items ingested, tasks created, tasks
reclassified, LLM calls), and the error message and stack on failure. Retained for a
configurable window, default 30 days.

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
