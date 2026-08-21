# Using Caroline

The setup guide gets Caroline running. This is what to do with it: what to press, what to say to it,
and what each of those things actually does. If it is not running yet, start at
[setup.md](setup.md).

Everything below is a real screen and a real answer. The pictures are the seeded demonstration day
from [tools/demo](https://github.com/SociableSteve/caroline/tree/main/tools/demo), regenerated with
one command, so nobody's mail is in them: the names, repositories and threads in them are invented.

| If you want to | Read |
| --- | --- |
| Find your way around | [Five screens and a rail](#five-screens-and-a-rail) |
| Know what the six columns mean | [Where work lives](#where-work-lives) |
| Get something out of your head | [Capturing something](#capturing-something) |
| Empty the inbox | [Triaging, by keyboard](#triaging-by-keyboard) |
| Understand what Caroline suggested | [What the classifier proposes](#what-the-classifier-proposes) |
| Work out what to do today | [A worked day](#a-worked-day) |
| Talk to it | [The rail: an item, and a conversation about it](#the-rail-an-item-and-a-conversation-about-it) |
| Keep projects moving | [Projects](#projects) |
| Know what it will refuse to do | [What it will not do](#what-it-will-not-do) |

## Five screens and a rail

The links in the header are the whole of it: **Dashboard**, **Board**, **Projects**, **Jobs** and
**Settings**. Beside them, on the right of the header, three buttons that work from any of the five:
**Sync now**, **Quick capture** and **Chat**.

| Screen | What it is for |
| --- | --- |
| Dashboard | Today: the plan, the calendar, what has gone quiet, what is stalled |
| Board | All the work, in six columns, and where triage happens |
| Projects | Anything that takes more than one action, and whether each has a next one |
| Jobs | The background work: what ran, when, what it did, and what failed |
| Settings | Your name, the Google connection, and what a call to the model would actually carry |

Chat is not a sixth screen. It is a rail that opens beside whichever of the five you are on, because
asking about the board while the board is on screen is the point. On a narrow window it becomes an
overlay instead.

The address bar keeps up with you: `#/board?item=task:abc&conversation=xyz` is the board with that
task open in the rail and that conversation under it. Anything you can see, you can link to and come
back to.

If Caroline is set up with a login ([setup.md, step 8](setup.md#8-reaching-it-from-elsewhere)), a
login screen appears in place of all of that until you sign in: one button naming the provider, and
nothing else, unless the last attempt was refused, in which case a line above the button says so.
Signing in with an address the allowlist does not name reads "This account is not permitted to use
this Caroline."; anything else that can go wrong (a bad request, the provider unreachable, an
internal error) reads the same generic "Something went wrong signing in.", and none of it gives you
anything else to do here. It is not a sixth screen either, and there is nothing to press
until you use it: any call answered "unauthenticated" puts you there instead of retrying. Signed in,
everything above is exactly as described, a **Sign out** button joins the header controls for as
long as a login is required, and a session otherwise simply lasts a while before it asks again.

## Where work lives

Six columns, and every task is in exactly one of them.

| Column | What is in it |
| --- | --- |
| Inbox | Captured, not yet decided about. Everything arrives here |
| Next actions | One concrete thing you could do next |
| Review | Somebody is waiting on you to review something. Pull requests land here |
| Waiting for | The next move belongs to somebody else, who is named on the card |
| Someday | A real commitment, but not now |
| Reference | Information with no action in it |

Done is the seventh status and is not a column: completing something takes it off the board.

![Caroline's board, with six columns and the keyboard reference underneath](images/board.png#gh-light-mode-only)
![Caroline's board, with six columns and the keyboard reference underneath](images/board-dark.png#gh-dark-mode-only)

## Capturing something

Press `c`, from any screen. Three fields: what it is, notes, and a project if it belongs to one.
**Capture** files it, `Enter` in the title field does the same, and `Escape` abandons it whatever has
the focus.

It lands in the inbox and nothing else happens to it until you triage it, or the hourly classify job
proposes somewhere for it to go. That is the whole point of the inbox: capturing is not deciding.

## Triaging, by keyboard

The board lists its own keys along the bottom, which is the copy worth trusting. Every one of them
acts on the focused card, so the first move is to give a card the focus: click one, or `Tab` until one
takes it. As the list stands:

| Key | What it does |
| --- | --- |
| `←` `→` `h` `l` | move between columns |
| `↑` `↓` `j` `k` | move within a column |
| `1` to `6` | move the focused task to that column |
| `d` | complete the focused task |
| `r` | mark the focused review done, moving it to Waiting for |
| `a` | accept the suggestion on the focused inbox task |
| `u` | put the focused task's last status change back |
| `enter` | open the focused task in the details rail |
| `c` | quick capture, from anywhere |

A worked pass at an inbox of three, from the board:

1. Click the first card in the Inbox column. `j` and `k` move down and up it, `h` and `l` across to
   the next column, keeping your place in the row where the column is long enough.
2. Read the card. `2` files it as a next action, `4` as something you are waiting on, `5` as someday,
   `6` as reference. `d` completes it, which is the right answer more often than it looks.
3. Got one wrong? `u` puts that task's last status change back, including the column it came from.
4. Click the next card and go again, until the column is empty. Only the movement keys hand the focus
   on: `d`, a digit, `r` and `u` all take the card out of the column it was in, and the focus goes with
   it rather than moving to what is left, so each triage decision starts with a click or a `Tab`.

Moving a card is a decision by you, and Caroline records it as yours: the classifier will not overrule
a status you set.

Two things that follow from that last rule. Filing a synced item outside the statuses its connector
tracks turns sync tracking off for it permanently, so a pull request you have filed under Reference
stays there rather than being dragged back to Review on the next sync. And a task you complete stays
complete: nothing but you closes work.

## What the classifier proposes

With a model configured, the classify job reads the inbox hourly. What it does with an item depends
on how sure it is:

- **Confident**, at or above `classification.confidenceThreshold`: it moves the task, and the move is
  attributed to the classifier rather than to you, so you can still overrule it.
- **Unsure**: the task stays in the inbox and the suggestion sits on the card, with its confidence,
  its reasoning in a sentence or two, and a better title if it has one. **Accept** takes it, and the
  status becomes yours. **Dismiss** drops the suggestion and leaves the task where it is.

`Re: Q3 capacity numbers for the board pack`, in the Inbox column of the board picture above, is the
unsure case: `Caroline suggests Next actions (62% confident)`, with the reasoning and a proposed
retitle under it. `a` is **Accept** from the keyboard.

It never proposes done, and it never sets a due date. Completing something is a human act, and
deadlines come from people rather than from a model.

## A worked day

The dashboard is the morning screen. Reading it top to bottom:

![The dashboard: today's plan, today's calendar, and the four panels under them](images/dashboard.png#gh-light-mode-only)
![The dashboard: today's plan, today's calendar, and the four panels under them](images/dashboard-dark.png#gh-dark-mode-only)

- **Today's plan** is what the planner proposed: a line about the shape of the day, then any warning
  it has to give, then the entries in order with a sentence each saying why. The two warnings in the
  picture are both the planner's own, and are the two things it wants you to know before you read
  the list: it could not fit everything, and the capacity it was drawn against is unverified. At
  least one review is in there whenever something is waiting on you and the day has room for it,
  whether the model thought of it or not, unless `planning.includeReviews` in the config file is
  off. **Regenerate** redraws it against the tasks and the calendar as they stand now. It is a
  proposal and not a commitment: complete things from it, or ignore it.
- **Today's calendar** is the capacity arithmetic, spelled out: the working window, less the meetings
  you accepted, less the reserve held back for interruptions, and what is left. Declined meetings do
  not count against you. **Unverified** means no calendar is connected, which is not the same as no
  meetings being known: as the picture above shows, the arithmetic still uses whatever events are in
  the database, and what is missing is anything confirming they are current.
- **Gone quiet** is what has been waiting on somebody else longer than the staleness threshold, with
  who it is on and for how long, read as things stand now. **Worth a chase** is the same list as the
  planner saw when it drew the plan, so something that crossed the threshold since this morning is in
  the first and not yet in the second. For a pull request it adds whether the author has pushed
  anything since you reviewed it, which is the case where a review is quietly yours again.
- **If there is time** is what the plan left over, and the warning above it says there was something.
- **Stalled projects** are projects with no next action. That is the one thing tracking work this way
  can tell you that you cannot see by looking at a list.

Under all of it, the state strip: where everything is, when each background job last ran, which
integrations are configured, and how the last few days' plans went against what you completed.

## The rail: an item, and a conversation about it

Click a task or a project anywhere, or press `enter` on a board card, and it opens in the rail on the
right, above the conversation. **Chat** in the header opens the rail without selecting anything. Those
two kinds are what a panel is for and nothing else has one: a meeting, a job run and a plan entry have
no tool that names one, and clicking a plan entry selects the task it names.

![The rail: a pull request's details above a conversation about the day](images/rail.png#gh-light-mode-only)
![The rail: a pull request's details above a conversation about the day](images/rail-dark.png#gh-dark-mode-only)

The panel is the item's facts: status, who set it, estimate, dates, who it waits on, and where it
came from, with a link to the pull request or thread behind it. The rail says the part that matters
in a line: whatever is open there goes to the model with your next message, as far as the content
policy allows. That is what makes "it" mean something in a sentence like "file it under reference".

Two rules about that. The item is resolved when you send, from whatever is open then, so an item you
closed is an item you stopped talking about, and there is no last-selected fallback. And selecting
nothing still sends the message: the turn goes as it always did, simply without an item attached.

**Close details** puts the panel away and leaves the conversation. **Close chat** closes the rail and
takes both with it, so nothing is left in the address bar to reopen a rail you shut.

### What to say, and what happens

Say it however you like: which tool Caroline reaches for is the model's decision, and these are the
ones that answer each question. What no phrasing can do is reach past the tool registry, which is the
whole of what chat can do.

| Say something like | What Caroline does |
| --- | --- |
| What am I waiting on? | `list_waiting`: everything outstanding on somebody else, who it is on, how long it has been, and whether that is past the staleness threshold |
| What is on today? | `get_daily_plan` and `get_capacity`: the plan in order with its reasons, what did not fit, and the free time it was drawn against |
| Anything overdue? | `search_tasks`, filtered by status and by a date. It answers with the total number of matches as well as the matches themselves, and a long list comes back a page at a time, so ask for the rest and Caroline pages through it |
| What is left in the Caroline 1.0 release? | `list_projects` and `search_tasks`: the project, its next action, and whether it is stalled |
| Add a task to chase Legal about the statement of work, ten minutes | `create_task`. The transcript then shows `Created “Chase Legal about the statement of work” in next_action`, with an **Undo** beside it |
| File it under reference | `update_task` on the item open in the rail: `Updated “…”: to reference`. A status set this way is yours, so the classifier leaves it alone |
| That review is done | `mark_reviewed`: the task moves to Waiting for, named on the author, and the review does not come back until the author does something |
| Redraw today's plan | `regenerate_daily_plan`. Today only: an earlier day's plan is the record of what was proposed on the day, and the plan it replaces is kept in history |
| Delete that someday item | `delete_task`, which never runs on the model's word. It is proposed, the transcript says it is held, and it happens when you press **Confirm** |

Four things about a conversation that are rules rather than good intentions:

- **Every change is recorded in the transcript with an Undo**, and the undo is the inverse operation
  that was stored when the change was made rather than a guess at one afterwards.
- **Deleting always waits for you**, however clear the instruction. So does the rest of a turn once it
  has changed more than ten tasks, which is the runaway case: `chat.bulkConfirmThreshold`. That count
  is a session's rather than a browser turn's, so it holds the same way for anything else that reaches
  the same tools: what starts it counting again is your deciding the confirmation, not your sending
  another message.
- **A turn in this rail has a budget**: twenty-five tool calls by default, `chat.maxToolCalls`, and
  Caroline says so if it runs out rather than pretending it finished. The budget is here because the
  calls are on Caroline's model and Caroline's bill, so it is a property of this rail and not of the
  tools themselves.
- **No model, or a model that cannot call tools, degrades rather than breaks.** The rail says which at
  the top, naming the model where there is one: a model that cannot use tools means chat can answer
  questions but cannot change anything, and no model configured at all means it cannot do either yet.

## Projects

A project is anything that takes more than one action. On the **Projects** screen you name one, and
from then on every task you file into it counts towards it.

- **The next action is derived, not chosen.** It is the first task in the project that is in Next
  actions, so a project cannot claim a next action it does not have.
- **A project with none is stalled**, and says so on the list and on the dashboard. That is the one
  thing tracking work this way can tell you that a list of tasks cannot.
- **A project has a state**: Active, Someday, Done or Dropped. Only an active project is ever called
  stalled, because the other three are not meant to be moving.
- **Neither completing nor deleting a project touches its tasks.** Marking it done leaves whatever was
  open still open, and the screen says how many; deleting it leaves those tasks without a project
  rather than taking them with it. A project is a grouping, and the work in it is still work.

The classifier can suggest a project for something, existing or new, and the suggestion arrives on the
card with the rest of its proposal.

## What it will not do

- **It never writes to GitHub, Gmail or Calendar.** The scopes are read-only, and there is no tool in
  the registry that could, which is the enforcement rather than an instruction.
- **It never completes anything on its own**, and no model sets a due date.
- **Nothing leaves the machine except to the providers you configured.** How much of an item goes to
  the model is `privacy.llmContent`, and [content-policy.md](content-policy.md) shows one item at all
  four settings of it, exactly as the call carries it.

## When something looks wrong

- **Jobs** is the first place to look. Every background job, when it last ran, what it did, when it
  goes next, and the error in words if it failed. **Run now** takes the same path a scheduled run
  takes.
- **Sync now** in the header runs the connectors immediately.
- Nothing arriving, a column staying empty, or a Google connection that dies weekly: the
  [troubleshooting table](setup.md#troubleshooting) names the cause of each.
- Anything else is worth reading a [spec](specs/README.md) about. They are the contract the tests hold
  Caroline to, and they are more current than any explanation of them.
