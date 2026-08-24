# 14. Operational logging

## Purpose

Caroline logs carefully and keeps none of it. Every line goes through a field redactor, a message
redactor and a scrubbing stream (spec 09), and then to `process.stdout`, where it exists for as
long as somebody is watching the terminal that started the process. An instance that died last
Tuesday cannot be asked what it did, because the record of what it did was written to a stream
nobody was capturing.

Two things follow from that, and this spec exists for both.

**A fault that has already happened has to be investigable.** An instance that has been running for
a week can be asked what it did, without the operator having had to arrange capture in advance.
Running under `tee`, or under a supervisor that keeps stdout, is a workaround somebody has to
remember before the thing they want to diagnose happens, which is the wrong way round.

**A crash has to be in the record.** An uncaught exception or an unhandled rejection goes to
stderr today, so it is neither scrubbed by the stream that scrubs everything else nor kept by
anything. The one line most worth having is the one least likely to survive.

There is a third thing, and it is half of the same gap. The level knob exists and has nothing
behind it: `logging.level` is read, the README documents it, and across `src/` there was not one
`debug` or `trace` call site. Capturing `info` for a week is a thin record, and a `debug` level
with nothing emitting at it is no record at all. So a durable destination and a level worth turning
up are one subject, which is why they are one document.

## The destination is a stream behind the scrubber, not a transport

The obvious implementation is a pino transport: `pino-roll` or one of its neighbours does rotation,
is maintained by somebody else, and is one line of configuration. It is the wrong answer here, and
the reason is architectural rather than a matter of taste.

Spec 09's guarantee that no secret reaches a log line is enforced at three points, and the last of
them is `scrubbingStream` (`src/server/log-redaction.ts`), which sees every finished line on its
way to the destination. A transport runs in a worker thread and receives lines pino has already
encoded and shipped, which is to say it receives them past that last point. Adding one would
create a second path to a durable destination that the scrubber does not cover, and the durable
destination is the one that most needs covering: a line on a terminal is gone when the terminal is,
and a line in a file is there until somebody deletes it. A log on disk that can hold a secret is
worse than no log.

So the destination is a plain `Writable` sitting **behind** the scrubber, and stdout stays beside
it as a tee, so a supervisor that does capture stdout still works exactly as it did. One scrubber,
one place where a line is made safe, and both destinations downstream of it. The cost is that
rotation is written here rather than depended on, which is a bounded amount of code (open, size,
rename, prune) against a guarantee that cannot be re-established once it is lost.

The writes to the file are synchronous, on a file descriptor opened once, and that is a decision
rather than an accident of implementation. The crash path is the case that pays for it: an
asynchronous flush during `uncaughtException` is how the line most worth having gets lost, and a
destination that is synchronous by construction has no flush to lose.

### What rotates, and what bounds the total

Three bounds, because one is not enough:

- **A per-file size cap** (`logging.file.maxBytes`). When the next line would take the live file
  past it, the file is rotated first, so a line is never split across two files.
- **A file count** (`logging.file.maxFiles`), counting the live file. Rotation cascades the
  renames (`caroline.log` becomes `caroline.log.1`, `.1` becomes `.2`, and so on) and whatever
  falls off the end is removed. This is the bound, and it is a number the operator can read off
  their own configuration: never more than `maxFiles` files, whatever has been written. Size cap
  times file count is the disk that follows from it in the ordinary case, and it is what to plan
  for, but it is not a guarantee about bytes. Rotation happens before a write rather than after
  it, so that a line is never split, and a single line longer than the cap therefore lands whole
  in a file of its own and takes that file past `maxBytes`. A file count is a bound that holds
  unconditionally; a byte ceiling would only hold while every line was shorter than the cap.
- **A day bound** (`logging.file.retainDays`), on the rotated files. A month-old file is not
  evidence anybody is going to read, and the deletion promise (spec 09) is easier to keep about a
  log that is not indefinitely old.

The day bound is pruned at three moments, and the reason is that a bound which only holds while the
process is busy is not a bound. It is applied when the destination opens, so a restart brings an
instance that has been down for a month into compliance; at every rotation, which is the moment the
set of files changes; and at most once an hour on an ordinary write, so an instance left running
for months with a quiet log still ages its files out. What it is deliberately not is a scheduled
job: the purge job (spec 06) runs against the database, and making the log destination a scheduler
dependency would put the file that records a scheduler failure behind the scheduler working.

### When the file cannot be written

The file is a convenience for the operator, not a precondition for serving. A directory that cannot
be created, a file that cannot be opened, a full disk: any of them leaves Caroline serving
requests, logging to stdout exactly as it did before, and saying once on stdout what went wrong and
which path it was trying to use. The alternative, refusing to start because a log file could not be
opened, trades the whole of Caroline for the record of it.

The tee's two sides fail independently, for the same reason. A piped process going away closes
stdout, and `EPIPE` on stdout must not take the file down; a file that cannot be written must not
stop stdout. Each side is disabled on its first failure and the fact is reported once through the
other, rather than on every line for the rest of the process's life.

## The crash is in the record

`SIGINT` and `SIGTERM` already have an orderly, logged shutdown. `uncaughtException` and
`unhandledRejection` did not: they went to stderr, unscrubbed and unkept. They are logged at
`fatal` through the same logger as everything else, so they are scrubbed by the same three points
and land in the same file, carrying the exception, its stack and the fact that the process is going
away.

Nothing about that swallows the crash. The handler logs and then exits non-zero, which is what a
supervisor reads to decide whether to restart, and what the shell reports. A crash that became a
zero exit code because it was logged nicely would be a worse bug than the one being diagnosed.

## The level, and what each one says

`logging.level` sets it, `CAROLINE_LOG_LEVEL` overrides the file the way every other environment
variable overrides the file (spec 09, "Configuration mechanics"), and the default stays `info`: a
default that has to be turned up before it says anything is not a default worth having. A level the
logger does not know is a configuration error named at startup, like any other.

What the levels are for:

- **`info`** is what an operator reads without being asked to: the boot line with the effective
  configuration, one matched pair per request naming the route template and the status, and the
  scheduler's job outcomes.
- **`warn`** and **`error`** are the faults that already had lines, plus the ones the paths below
  discovered they were swallowing.
- **`debug`** answers "why did it do that", which is the question a fault actually asks. The
  scheduler's decisions (due, skipped because a run is in flight, held by backoff and until when),
  each connector pass with its counts and how long it took, each provider call with its model,
  duration, token counts and whether the schema had to be retried, the classifier's decision per
  task (the proposed status, the confidence, the threshold and whether it was applied), the
  planner's arithmetic (capacity, candidates, entries, overflow), the MCP surface's refusals by
  reason and its tool calls by name and item count.
- **`trace`** is the same shape, one step finer, where a line per item is the useful granularity
  rather than a line per pass.

### An item's own text never appears in a log line, at any level

Not a mail subject, not a task title, not a body, not a snippet, not a note, not a plan's rationale.
Not at `info`, and not at `trace` either. Ids, counts, statuses, durations, decisions and outcomes
only: a classifier line says the task id, the proposed status and the confidence, and never the
subject it read that from.

This is a contract with a criterion and a test, not advice, and it buys three things. It keeps a
persisted log out of the content-holding class, so retention is a matter of disk rather than of the
content policy. It keeps deletion simple. And it is what makes a verbose level safe to add at all:
the natural way to make a log more useful is to put more of the item in it, and this is the rule
that says which more.

Two consequences worth stating, because both are places the rule is easy to breach by accident:

- **Caller-chosen bytes are not logged, only what Caroline recognised.** Spec 09 already says no
  part of a request URL is logged, for the reason that every byte of it is the caller's to choose
  and a secret can be smuggled in any encoding literal matching will not find. The same reasoning
  extends to anything else a caller sends: an MCP method name and tool name are logged when they
  name something in the registry and as `(unknown)` when they do not, and a refused `Origin` or
  `Host` is logged as the reason for the refusal rather than as the value that was refused.
- **A model's own answer is not logged where it is derived from an item's text.** A validation
  failure's message names the schema paths that did not match, which is safe and useful; the
  answer that failed is not logged, because a suggested title is an item's text with one hop in
  between.

## Where the log lives, and what deletes it

`logging.file.directory` names the directory, and its default is `logs/` inside Caroline's own data
directory, derived from `database.path` exactly as `google-tokens.json`'s location is
(`src/config/load.ts`). Spec 09's deletion promise is that nothing Caroline creates lives outside
its data directory, and a log directory beside the database is what keeps that true for a
`database.path` pointing somewhere of the user's own: point the database at another disk and the
log follows it there, rather than the two being in different places on the strength of a default.

`npm run delete-data` removes the log files, and the log directory when it is Caroline's, empty
afterwards and not the data directory itself. It removes files it named (`caroline.log` and its
numbered rotations) and nothing else in that directory, by the same rule the rest of that command
follows: it deletes its own files, not a directory it did not create, and anything else it finds is
reported rather than removed. Spec 09 owns that promise and its criteria; this is the half that says
what the files are.

The directory is 0700 and the files 0600, the modes spec 09 sets on the data directory and the
database for the same reason: filesystem permissions are the whole of the protection at rest, and a
default umask leaves a new file world-readable. Applied after creating or opening rather than only
as a creation mode, which the umask masks and which does nothing at all for a path that is already
there: an install upgrading into this has a log file already, and a configured
`logging.file.directory` may be one somebody else made. A directory Caroline did not create is
narrowed no further than the file in it, by the rule the rest of this document follows about a
directory that is not its own. A filesystem that will not carry the mode (a CIFS or exFAT mount)
leaves the log where it is rather than losing it, which is the judgement `src/db/connection.ts`
already makes about the database.

## Configuration

```jsonc
{
  "logging": {
    "level": "info",          // fatal | error | warn | info | debug | trace | silent
    "file": {
      "enabled": true,
      "directory": null,      // null: <data directory>/logs
      "maxBytes": 5242880,    // rotate the live file past this
      "maxFiles": 5,          // counting the live one, and the bound that always holds
      "retainDays": 14        // a rotated file older than this is removed
    }
  }
}
```

Every key has a default, so a configuration file naming no `logging` block, which is every one in
existence today, keeps the level it always had and gains a durable log. `CAROLINE_LOG_LEVEL`
overrides `logging.level` and nothing else.

## Non-goals

- **Log shipping, aggregation, or a metrics endpoint.** Caroline is one process on one machine, and
  spec 09's outbound rule is that nothing leaves it that the user did not name a destination for. A
  log that goes somewhere is a telemetry decision, and the answer to that is still no.
- **A log viewer in the UI.** The file is a file, and `tail` and `jq` are better at it than
  anything worth building here. It would also be a second surface answering with content the
  content policy governs, which is a cost with no return.
- **Structured querying, indexing, or per-subsystem levels.** One level for the process. A knob per
  subsystem is a configuration surface for a fault Caroline has not had.
- **Audit logging.** What was done and by whom is spec 09's, through `job_runs`,
  `classifications`, `llm_calls` and the MCP surface's own rows. This document is about diagnosing
  the process, and the two must not be conflated: an audit row is a fact about the user's data with
  a retention policy of its own, and a log line is a fact about the machine.
- **Time-based rotation, compression, or a log per day.** Size and count are the bound that matters
  for a disk, and a date-stamped file per day is a second naming scheme for the deletion command to
  know about.

## Acceptance criteria

1. With the default configuration, a running instance writes its log lines to a file under its own
   data directory as well as to stdout, and both sides carry the same lines. No operator action
   arranges it.
2. Every line reaching the file has been through the same redaction stdout's lines have: a
   configured secret written at any level, in a message, a field value or a field name, appears in
   the file as `[redacted]` and never in the form it was written. Asserted against the file on
   disk, which is spec 09 criterion 6 over this destination.
3. The live file is rotated before a write that would take it past `logging.file.maxBytes`, so no
   line is split across two files, and the renames cascade (`caroline.log` to `caroline.log.1`, and
   each rotation one further along).
4. No more than `logging.file.maxFiles` files exist at any moment, counting the live one, however
   many lines have been written. Asserted after writing many times the total bound, by size of the
   directory rather than by counting rotations.
5. A rotated file whose last modification is older than `logging.file.retainDays` is removed, and
   the live file never is. Asserted at open, so an instance restarted after a long absence prunes
   what it finds.
6. A log directory that cannot be created or written leaves the server serving and logging to
   stdout, and says so once on stdout, naming the path and what the filesystem said.
7. A failure on one side of the tee does not disable the other: stdout closing leaves the file
   being written, and a file that cannot be written leaves stdout being written.
8. An uncaught exception and an unhandled rejection are each logged at `fatal` with the error, its
   stack and the fact that the process is going away, through the same redaction as every other
   line, and the process then exits non-zero.
9. `logging.level` sets the level, `CAROLINE_LOG_LEVEL` overrides it, and a level neither of them
   recognises is a startup error naming the setting and the value.
10. No item's own text appears in any log line at any level: with the level at `trace`, a task
    whose title, notes and stored body are distinctive is taken through ingestion,
    classification, planning and an MCP tool call, and none of those strings appears in any line
    the logger produced, while the task's id does. Asserted on the finished lines, which is what
    both destinations receive: criterion 1 is what says the file and stdout carry the same bytes,
    so a rule about the lines is a rule about the file.
11. Turning the level to `debug` says materially more than `info` in the paths a fault is likely to
    be in: the scheduler's decisions (a schedule firing, a run skipped for being in flight, a run's
    outcome, the rearm), each connector pass, each provider call (its outcome, and a refusal by the
    spending ceiling), the classifier's per-task decision, the planner's arithmetic, the purge's
    counts, and the MCP surface's refusals and calls. Asserted as lines at `debug` from each of
    those subsystems, by the message each of them writes, not as a count.
12. An MCP request refused for its `Origin` or its `Host`, or for a missing or invalid token, is
    logged with the reason and without the refused value, and a `tools/call` naming a tool that is
    not in the registry is logged as `(unknown)` rather than with the name the caller sent.
13. The default log directory follows `database.path`: a database configured onto another disk has
    its logs in a `logs` directory beside it, not in the default layout's `data`.
14. `npm run delete-data` removes the log files and, where it is Caroline's and empty afterwards,
    the log directory, and leaves anything else in that directory alone and reported. Spec 09
    criterion 10 covers this destination as well as the others.
15. An authorised MCP request is logged by an identifier Caroline assigned, the id of the grant the
    presented token was found in, and not by the client identifier, which is an https URL the
    client chose and is therefore caller-chosen bytes like any other. Criterion 12's rule about a
    refusal, held to over the requests that are not refused.
