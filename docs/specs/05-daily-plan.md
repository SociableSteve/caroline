# 05. Daily plan

## Purpose

Once a day, propose a realistic list of what to do, sized to the free time the calendar
actually leaves, and ordered with a stated reason.

## Trigger

Scheduled daily at a configurable local time (default 07:30), and regenerable on demand
from the UI. Runs after sync and classification so it sees a current picture.

## Capacity

Computed from `calendar_events` for the target day:

```
capacity = workingWindow - busyTime - reserve
```

- `workingWindow`: configurable start and end in local time, default 09:00 to 17:30, with
  configurable working days (default Monday to Friday).
- `busyTime`: union of event intervals that are inside the window, accepted or unanswered,
  not marked free, clipped to the window. Overlapping meetings count once.
- `reserve`: a configurable percentage held back for interruptions, default 20%. Nobody
  gets to spend every free minute on planned work.

A day whose capacity is zero or negative produces a plan with no work items and says so.

## Candidates

- All `next_action` tasks not deferred past today. A deferral to later the same day is not a
  deferral past today, so the task is a candidate.
- All `review` tasks.
- Anything else due today or overdue, which in practice means `inbox`: something with a
  deadline that has arrived is work whether or not it has been triaged yet.
- Stalled active projects, as a prompt to define a next action.

`someday`, `reference` and `done` are excluded whatever their deadline says: a someday item
with a date on it is still not a commitment for today. `waiting` is excluded from the work
list for the same reason, since the next move belongs to somebody else, but items waiting
more than a configurable number of days are surfaced separately as chase nudges, because
chasing is itself work. The threshold is `tasks.waitingStaleDays`, the same one the Waiting
for column and the dashboard read, and it defaults to 7.

A nudge names the item, who it is waiting on and for how long, and offers the chase as a
one-click next action. For a reviewed pull request it also says whether the author has
pushed since. Nudges do not consume capacity, because a nudge is a prompt to decide, not a
scheduled block of work.

## Output

A `daily_plans` row: date, generated-at, capacity minutes, model, prompt version, and an
ordered list of entries. Each entry has a task id, a rank, a one-line rationale, and the
estimate used. The plan also carries a short summary and any warnings.

Rules the plan must obey, enforced in code after the model returns rather than trusted to
the prompt:

- Total estimated minutes must not exceed capacity. Entries beyond capacity are moved to an
  explicit "if there is time" overflow list rather than dropped.
- Overdue and due-today tasks appear before discretionary work.
- Review items are not starved: at least one review appears in the plan whenever the review
  queue is non-empty and capacity allows.
- Tasks with no estimate use a configurable default (30 minutes) so they can still be
  fitted.
- An entry naming a task that was never a candidate is dropped, and the plan carries a warning
  saying so. A plan is acted on, and work nobody put in front of the model is work it invented.
- An entry too large for the whole day goes to overflow without taking the rest of the list
  with it: fitting steps over it and carries on, so one outsized task does not empty the day.

## Relationship to task state

The plan is a proposal. Generating it changes no task's status, and no task is "assigned"
to a day. Regenerating replaces the day's plan and keeps the previous one in history.

Only today's plan can be regenerated. An earlier day's plan is a record of what was proposed
on that day, and redrawing it against today's tasks would rewrite that record, and the
fortnight of planned against completed with it.

Completing a task from within the plan view completes the task; the plan entry then renders
as done. Yesterday's plan is retained, and the dashboard shows planned against completed
for the last fourteen days.

## Non-goals

- Time-blocking or writing entries to the calendar.
- Multi-day or weekly planning.
- Re-planning automatically as the day changes. Regeneration is on demand.
- Judging performance. Caroline records what was planned and what was completed, and draws
  no conclusion from the gap.

## Acceptance criteria

1. A day with no calendar events yields capacity equal to the working window minus the
   reserve.
2. Two overlapping meetings reduce capacity by the length of their union, not their sum.
3. An event marked free, or declined, does not reduce capacity.
4. An event partly outside the working window reduces capacity only by its overlap.
5. The sum of planned entry estimates is never greater than capacity; excess goes to
   overflow.
6. An overdue task always outranks a discretionary next action.
7. A non-empty review queue yields at least one review entry when capacity allows.
8. Regenerating a plan for the same date creates a new plan and preserves the previous one.
9. Generating a plan changes no task row.
10. With no calendar configured, planning still runs using the full working window and says
    that capacity is unverified.
11. An item in `waiting` past the staleness threshold appears as a nudge naming the person
    and the elapsed time, and does not consume capacity.
12. A reviewed pull request whose author has not responded appears as a nudge rather than
    disappearing from the day's output.
13. A day that is not a working day has no capacity, plans nothing, and says which day it was
    rather than reporting an empty diary as a free one.
14. An entry naming a task that was not a candidate does not reach the plan, and the plan says
    it was left out.
15. Regenerating a date that is not today is refused, so an earlier day's record stands.
