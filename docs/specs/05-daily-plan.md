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
- All `review` tasks, where reviews are included in planning. Whether they are is the configurable
  `planning.includeReviews`, and it defaults to including them. Somebody whose code review is
  handled elsewhere turns it off, and no review is then a candidate: not even one due today or
  overdue, because a review is judged on its status before its dates are looked at.
- Anything else due today or overdue, which in practice means `inbox`: something with a
  deadline that has arrived is work whether or not it has been triaged yet.
- Stalled active projects, as a prompt to define a next action.

`someday`, `reference` and `done` are excluded whatever their deadline says: a someday item
with a date on it is still not a commitment for today. `waiting` is excluded from the work
list for the same reason, since the next move belongs to somebody else, but items waiting
more than a configurable number of days are surfaced separately as chase nudges, because
chasing is itself work. The threshold is `tasks.waitingStaleDays`, the same one the Waiting
for column and the dashboard read, and it defaults to 7.

`blocked` is excluded from the work list too, and for the plainest reason of all: another task
has to finish first, so it cannot be started today. It is excluded at the candidate list rather
than after the model answers, which is where the review exclusion is taken and for the same
reason. That exclusion has to be stated rather than assumed: the candidate rule ends with a
catch-all limb reached by any status with no limb of its own, so a new status added and not named
here would be planned as work on the strength of a deadline alone.

Subtraction alone would make an overdue blocked task vanish, and something vanishing quietly is
the failure the whole of this is meant to avoid. So a blocked task due today or overdue returns as
a nudge, in the same sense a stale wait does: it names the task and the task it is blocked behind,
consumes no capacity, and sits beside the chase nudges. A deadline that has arrived on work that
cannot start is a decision, not a work item.

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
  explicit "if there is time" overflow list rather than dropped, and the plan carries a warning
  saying that something did not fit. The list is what was left out; the warning is what stops a
  plan that is only part of the day from reading as the whole of it.
- Overdue and due-today tasks appear before discretionary work.
- Review items are not starved: at least one review appears in the plan whenever the review
  queue is non-empty and capacity allows. The queue is the day's own review candidates, so with
  reviews excluded from planning there is nothing for this rule to find and it does nothing. It is
  not a second place the decision is taken.
- Tasks with no estimate use a configurable default (30 minutes) so they can still be
  fitted.
- An entry naming a task that was never a candidate is dropped, and the plan carries a warning
  saying so. A plan is acted on, and work nobody put in front of the model is work it invented.
- An entry too large for the whole day goes to overflow without taking the rest of the list
  with it: fitting steps over it and carries on, so one outsized task does not empty the day.
- Where the same task id is named more than once, the first mention wins and the rest are
  dropped. A task planned twice is one task, and the second entry would spend the same capacity
  again on work that is already in the list. The rule is about the id rather than about the task,
  so it holds for an id that names no candidate too: a repeated invented id is still one invented
  id, and it earns one warning rather than one per mention.

## Placement: the clock and the plan

The plan is drawn once and read all day, so reading it at 14:00 must not propose the morning.
Placement reconciles this by accounting for the clock. It is not re-planning, because the entries,
their ranks, their estimates and the capacity they were fitted against are all unchanged and no row
is rewritten. What the clock decides is only where an entry is drawn.

Two phases place entries over the same free intervals, with one boundary between them. Phase A
places done entries first, walking from each interval's start in rank order, so nothing already
done moves. The boundary is `floor = max(now, cursor after the done run)`. Phase B then places
outstanding entries from `floor` onwards. Work completed out of rank order stays in its earlier
time, and work not yet done sits right of the now line.

Free time is split at the present moment and reported separately. Elapsed time behind the clock is
never offered to work the plan could not fit, and an entry that no longer fits anywhere ahead says
so rather than being drawn past the clock. The five numbers on the day bar are meetings, planned,
done, gone and unplanned. "Gone" is the free time that has elapsed with nothing placed in it.

Criteria 21, 22 and 23 state placement in the dashboard as a contract so the behaviour is
specifiable and testable. Spec 08, criteria 57-60 do the same for the display side.

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
7. A non-empty review queue yields at least one review entry when capacity allows, when reviews are
   included in planning.
8. Regenerating a plan for the same date creates a new plan and preserves the previous one.
9. Generating a plan changes no task row.
10. With no calendar that can be read, planning still runs and says that capacity is
    unverified, in whichever of two cases applies: with no events on record it uses the full
    working window and says the window was assumed free, and with events still on record from
    an earlier sync it deducts them as usual and says the figures came from that sync rather
    than claiming the window was assumed free. A day that is not a working day says only that
    (criterion 13); there is no window there to have assumed anything about.
11. An item in `waiting` past the staleness threshold appears as a nudge naming the person
    and the elapsed time, and does not consume capacity.
12. A reviewed pull request whose author has not responded appears as a nudge rather than
    disappearing from the day's output.
13. A day that is not a working day has no capacity, plans nothing, and says which day it was
    rather than reporting an empty diary as a free one.
14. An entry naming a task that was not a candidate does not reach the plan, and the plan says
    it was left out.
15. Regenerating a date that is not today is refused, so an earlier day's record stands.

The published demonstration day added the following, appended rather than renumbered because the
code and the suite cite these by number.

16. A plan that could not fit everything carries a warning saying so, as well as listing what was
    left over. The warning names no count and no number of minutes, so it cannot come to disagree
    with the list or the capacity drawn beside it.

Issue #21 added the following, appended rather than renumbered for the same reason. The
first-mention-wins rule was enforced in code from the start but written down nowhere, which is part
of why nothing caught the warning being pushed ahead of the duplicate check.

17. An answer naming the same task id more than once yields one entry, or where the id names no
    candidate one warning, whichever mention count it was listed with. First mention wins, and the
    warning that survives names that id, so a model that repeats itself cannot multiply either the
    day's work or what the plan says about it.

The setting for whether reviews are planned added the following, appended rather than renumbered for
the same reason. It exists for somebody whose code review is handled elsewhere, and it is
`planning.includeReviews` in `caroline.config.json`, beside the other planner settings, because it
configures what the planner counts in the same way they do. It takes a restart, like every other
value in that file.

18. With reviews excluded from planning, no review task reaches the plan or the overflow list, even
    with a non-empty review queue and capacity to spare. The exclusion holds at the candidate list,
    so it covers a review that is due today or overdue, and the never-starve rule above cannot put
    one back.
19. The setting defaults to including reviews, so an install where nobody has named it plans exactly
    as it did before the setting existed.

Issue #91 added blocking, and the following with it, appended rather than renumbered for the same
reason.

20. A `blocked` task is never work in the plan or in the overflow list, whatever its deadline says.
    One due today or overdue returns as a nudge naming the task it is blocked behind, and consumes
    no capacity. What a nudge names is read at the same moment as the status it is presented under,
    so a task whose state changed after the plan was drawn cannot be shown as blocked behind a
    person or as worth chasing to a task.

Issue #82 added elapsed time tracking to the day bar and changed placement to account for the
clock, appended rather than renumbered for the same reason.

21. An entry that is not complete is never placed before the present moment: it takes free time at
    or after now, so a plan drawn in the morning and read in the afternoon proposes only time still
    to come. This is placement and not re-planning: the entries, their ranks and their estimates
    are the plan's own and unchanged.
22. An entry already complete keeps the earlier free time it was placed in, and is never moved
    forward by work that is not done, whatever order the two were ranked in. Where the completed
    work is more than the free time that has passed it runs on past the present moment rather than
    being dropped, because those minutes were spent, and the outstanding work starts after it.
23. Free time that has passed with nothing placed in it is time gone rather than capacity: it is
    never offered to work the plan could not fit, and an entry that no longer fits anywhere ahead
    is reported as having no time rather than given one behind the clock. A day whose window has
    closed places no outstanding work at all.
