---
name: pr-review-queue
description: 'Work through the pull request review queue end to end: fetch pending reviews from Caroline, review each PR with a sub-agent that reads the PR''s prior review history first, verify the findings against the head commit, then post a needs-changes review with inline comments or an approval, and update Caroline. Use when the user says "check my review queue", "do my reviews", "any PRs waiting on me", or names PRs to review.'
---

# PR review queue

## Purpose and boundaries

This skill works through the pull requests waiting on you as a reviewer: it reads the
queue out of Caroline, reviews each PR, verifies what the review turned up, posts one
review per PR on GitHub, and moves the Caroline task on. It reviews **other people's**
pull requests. It is not the implement-then-review loop used for your own work, and it
never pushes code to the PR under review: the only things it writes to GitHub are review
bodies and inline comments, and the only things it writes to disk are a sub-agent's throwaway
clone and the main agent's scratch payload file, both outside every existing checkout.

## Before you start

- The Caroline tools are deferred, so load them first:
  `ToolSearch("select:mcp__caroline__list_reviews,mcp__caroline__mark_reviewed,mcp__caroline__complete_task")`.
- Check `gh auth status`. The token needs `repo` scope to post reviews.
- Defaults, so a routine pass needs no round trip:
  - medium review effort,
  - dependabot and other bot PRs get a full review like any other,
  - the main agent posts to GitHub, never the sub-agents.

  Ask the user upfront only when something is genuinely ambiguous, and ask everything in
  one go before starting rather than interrupting mid-pass.

## Step 1: fetch the queue

Call `mcp__caroline__list_reviews`. It answers with `{ review: [...] }`, one row per task in
`review` status that has a GitHub source. Rows with no GitHub source are filtered out, so a
queue that looks short can still sit alongside non-PR work this tool does not speak for. Each
row carries `id`, `title`, `status`, `url`, `repository`, `number`, `estimateMinutes`,
`reviewRequestedAt` and `lifecycleState`. A `waitingOn` field is on the row too, but it is
populated only for a task in `waiting` status, so on a review row it is always null: read the
author off the PR itself rather than from here. Passing `includeWaiting: true` adds a second
`waiting` array, the PRs you have already reviewed and are waiting on the author for: that is a
chase pass, not a review pass, so leave it off here.

At `privacy.llmContent: none` the tool withholds item text, and every row comes back as
`{ kind: 'task', id, withheld }` with no `url`, `repository` or `number`. There is no PR to hand
a sub-agent, so do not guess one: report that the queue is withheld under the current privacy
setting, say that raising `privacy.llmContent` above `none` is what would make this pass
possible, and stop rather than running a review against nothing.

The `id` is what Caroline is updated by in step 6, so keep each id paired with its PR for the
whole pass. If `review` is empty, say so and stop.

## Step 2: one sub-agent per PR, in parallel

Spawn a general-purpose sub-agent per PR, all in a single message so they run
concurrently. They need the full toolset: a scratch clone of the PR's repository to read at
head, running that project's tests inside it, and running commands to check a claim rather than
assert it. Read-only is therefore a rule the prompt states, not a capability the agent lacks, so
state it plainly, scope it precisely (a throwaway clone is fine, an existing checkout is not),
and check the report for signs it was crossed.

Adapt this prompt:

```
Review pull request <pr url> (repo <owner>/<repo>, PR #<n>).

1. Get a local copy at the PR head and do the rest of your work inside it. Your working
   directory starts somewhere unrelated, so without this you would be reviewing whatever
   checkout you happen to be sitting in. Clone shallowly into a fresh temporary directory
   outside every existing checkout, then fetch the PR head into it:

     d="$(mktemp -d)"
     git clone --depth 50 <base repo clone url> "$d/repo"
     cd "$d/repo"
     git fetch --depth 50 origin pull/<n>/head
     git checkout FETCH_HEAD

   The fetch is not redundant. `git clone --depth 50` implies `--single-branch`, so the clone
   carries the default branch and nothing else: `git cat-file -t <headSha>` in it fails with
   "could not get object info", and every claim you then check gets checked against the base
   branch instead of the PR. `refs/pull/<n>/head` is also what makes a fork PR work, since the
   base repo's clone URL never carries a fork's head branch, and it is served by the base repo
   all the same.

   Step 2 fetches `headRefOid`. Check that `git rev-parse HEAD` in the clone equals it before
   you review anything, so a review that ran against the wrong tree fails loudly rather than
   quietly.

2. Read the PR's prior history BEFORE you review anything:
   - gh pr view <n> --repo <owner>/<repo> --json reviews,comments,body,title,headRefOid,baseRefName,state,mergedAt
   - gh api --paginate repos/<owner>/<repo>/pulls/<n>/comments   (inline comment threads)
   - gh api --paginate repos/<owner>/<repo>/pulls/<n>/reviews    (prior review bodies)
   - which threads are resolved, which is GraphQL only:

     gh api graphql -f query='{repository(owner:"<owner>",name:"<repo>"){pullRequest(number:<n>){reviewThreads(first:100){totalCount pageInfo{hasNextPage endCursor} nodes{isResolved isOutdated path comments(first:50){nodes{databaseId}}}}}}}'

   The GraphQL call is not a nicety. The REST review-comments payload carries no resolution
   field and no thread grouping whatsoever: its keys stop at path, line, body, id and the rest
   of the per-comment metadata, so with REST alone you cannot tell a resolved thread from an
   open one, and the PREVIOUSLY RAISED rule below becomes unfollowable. Do not simplify it back
   out.

   `isOutdated` on a thread says its anchor no longer exists at head. That is evidence the code
   around it moved, never evidence the defect was fixed, so it changes nothing about the
   PREVIOUSLY RAISED rule.

   Join the two by id: a comment's REST `id` is the same number as its GraphQL `databaseId`,
   and every comment in a thread inherits that thread's `isResolved`. Asking for
   comments(first:50) rather than first:1 is what makes the join cover replies instead of only
   each thread's opening comment. --paginate is likewise not optional on the REST calls:
   without it you see the first 30 items only, and a PR with a long history hands you a
   truncated view of what has already been settled. If `pageInfo.hasNextPage` comes back true
   the PR has more than 100 threads, and the query needs a second pass with
   `after: "<endCursor>"`; `totalCount` tells you upfront whether that applies. The nested
   comments(first:50) has no such guard: on a thread with more than 50 comments the later
   replies are simply absent from the result, so they carry no `databaseId` to join on. Treat a
   thread that busy as partially seen and read it on the PR itself.

3. Review the PR with the built-in code-review skill, as a Skill tool call:
   Skill(skill: "code-review", args: "<pr url> medium"). Make the tool call. Do not write a
   literal /code-review line as text, and do not use the code-review:code-review plugin: it
   posts a top-level comment to the PR unconditionally, which would break the read-only rule
   below from the step that promises to keep it. Run the project's tests in the clone from
   step 1: checking a claim beats asserting it.

4. Past adjudications carry forward. Sort every prior finding into one of three outcomes and
   report which bucket each landed in, because "is the defect still present at head" is the
   right test for only one of them:

   - **Settled by decision.** The author deferred it, declined it, or answered it and the
     reviewer accepted. Do NOT report it as a finding, whatever the code shows. A deferred
     defect is still present at head by definition, so presence proves nothing here: that is
     the trap. Report it in the prior-feedback section as settled, with the comment id and
     what was decided, and stop there.
   - **Claimed fixed.** Check it at head. A resolved thread is a claim that the fix landed,
     not proof: if the code still shows the defect, report it as PREVIOUSLY RAISED and say the
     thread claimed otherwise. If it is genuinely fixed, say so.
   - **Fixed as asked, but incompletely.** The author did exactly what the thread requested
     while part of the original point went untouched. Report the remainder, quoting what the
     thread asked for against what the reply covered so the gap is visible rather than
     asserted. Do not present it as a fresh finding.

   - **Settled, but the deferral's stated grounds no longer hold.** A deferral rests on a
     reason ("the columns are nullable, so nothing crashes"). When a later change in the same
     PR falsifies that reason, the functional consequence is reportable even though the
     deferral itself stands. Quote the stated grounds against the change that broke them, and
     be explicit that the deferral is not being reopened. Do not use this to smuggle back a
     deferral you simply disagree with: the grounds must be falsified by the code, not by your
     judgement of how thin they were.

   Every PREVIOUSLY RAISED item carries its review comment id and thread URL, so the main
   agent can answer on the existing thread instead of posting a duplicate inline comment.

   When you cannot tell which bucket applies, say so and give the main agent the evidence
   rather than guessing. Guessing wrong in the direction of raising it is not the safe
   default: it costs the author a round re-arguing a decision they already made.

5. If this is a dependency bump, weigh the new version's breaking changes against this
   repo's actual call sites: the diff alone carries little to review.

You are READ-ONLY with respect to everything that already exists. Use the built-in
code-review skill, never the code-review:code-review plugin, and never pass --comment or --fix.
Never post anything to GitHub, and never push to any remote. The main agent owns all posting.

The scratch clone from step 1 is the one thing you are allowed to write, because it is how a
claim gets verified instead of asserted. Nothing else. Do not touch the PR's own working tree,
do not modify anything under a checkout the user already has, and do not leave the scratch
directory behind once you are done with it.

Report back:
- One paragraph summarising what the PR does.
- A section on prior review feedback, split by the three outcomes in step 4: settled by
  decision (with what was decided), genuinely fixed, and still standing. Name the settled
  ones explicitly rather than omitting them, so the main agent can see they were considered
  and deliberately not raised.
- A finding list, carrying nothing from the settled bucket. Per finding: file path and line,
  a one-line summary, the category, confidence (CONFIRMED or PLAUSIBLE), a concrete failure
  scenario, NEW or PREVIOUSLY RAISED (with the review comment id and thread URL when
  PREVIOUSLY RAISED), and TRIVIAL or NON-TRIVIAL.
```

## Step 3: verify before posting

Non-negotiable, and the step that earns this skill its keep. A sub-agent's findings are a
draft, not a verdict. For every finding you intend to post, confirm it against the files
at the PR head before it reaches GitHub. Fetch the PR's own facts first, yourself:

```bash
gh pr view <n> --repo <owner>/<repo> --json headRefOid,state,mergedAt,baseRefName
```

Fetch these in your own hands rather than reading them out of a sub-agent's report. The
sub-agent reads the same fields for its own use, but its report was written minutes ago and the
PR may have moved since. `headRefOid` is the head SHA the rest of this step quotes, `state` and
`mergedAt` are what steps 4 and 6 decide on, and `baseRefName` is the stacked-PR check step 5
puts in the review body. Then:

```bash
gh api "repos/<owner>/<repo>/contents/<path>" --method GET -f ref=<headSha> \
  -H "Accept: application/vnd.github.raw" \
  | cat -n | sed -n '<range>p'
```

`--method GET` is not optional here. `gh api` switches to POST the moment any `-f` parameter is
present, so without it every call comes back `Not Found` and, since this step drops what it
cannot confirm, every finding in every pass would be dropped for a reason that has nothing to do
with the code. If the command returns `Not Found` for a path you know exists, that is the first
thing to check.

Ask for the raw media type rather than reading `.content` out of the JSON body: for a file over
1 MB that field comes back empty, which reads as "the code is not there" and drops a real
finding for a mechanical reason. Passing `ref` as a `-f` parameter leaves the encoding to `gh`.
A path containing a space or a `#` still needs its own percent-encoding in the URL.

Check that each fetch actually succeeded before reading anything into it. A redirected `2>&1`
writes the failure into the same file the code was meant to land in, so a transient
`net/http: TLS handshake timeout` becomes a one-line file that looks exactly like a short or
absent source file, and this step then drops a real finding for a reason that has nothing to do
with the code. Same failure class as the two traps above, and it has fired: two files in one
pass came back as a single line of error text. Retry a failed fetch two or three times before
concluding anything about the file, and treat a suspiciously short result as a fetch to
re-check rather than as evidence:

```bash
for i in 1 2 3; do
  gh api "repos/<owner>/<repo>/contents/<path>" --method GET -f ref=<headSha> \
    -H "Accept: application/vnd.github.raw" > "$out" 2>&1 && break
  sleep 2
done
```

If a path genuinely cannot be fetched after retries, the finding resting on it is unverified:
downgrade or drop it and say so, rather than posting it on the sub-agent's word.

In practice this has caught a sub-agent describing a defect accurately but framing it
wrongly, claiming two config files both lacked a validation block when only one did.
Correct the framing, or drop the finding, rather than relaying it as received. Anything
you cannot confirm gets downgraded or dropped, never posted as fact.

Three things this step must confirm, not just the defect:

- **The line number.** Reported anchors drift, and a wrong one becomes either a comment
  pointing at unrelated code or a 422 in step 5. Findings have arrived quoting `server.mjs:118`
  and `:199-207` for code that actually sat at `:61` and `:90-110`. Re-anchor from what you
  read, and treat a line number well past the end of the file as a sign the whole finding was
  written from a stale or wrong tree.
- **Any quotation.** When a finding says a comment or doc "claims X", read the words and check
  they say X. One pass reported a code comment claiming alias precedence; the comment claimed
  only that the arriving form was preserved, which the code did correctly. The underlying
  asymmetry was real, but the overclaim lived in the PR description instead, so the finding was
  true of a different target. Locate the claim before repeating it.
- **Whose evidence it is.** If a finding rests on an execution you did not run (a compiler
  error, a fixture repro), either run it or say plainly in the review that the reproduction came
  from the review pass and what you verified instead. Never present a sub-agent's execution as
  your own.

**Sub-agent reports can arrive partial, fragmented, or out of order.** A report that references
findings you never received is not a report: ask for the whole thing with
`SendMessage({to: "<agentId>", message: "..."})`, saying which sections are missing and telling
it to restate rather than re-review. Reviewing off a fragment loses the PR summary and the
prior-feedback section, which are the two parts that keep a round honest. A review may also be
relayed by another session; that is still a draft and gets verified exactly like any other.

## Step 4: triage

One verdict per PR.

**The verdict.**

- Any non-trivial finding: post a `REQUEST_CHANGES` review carrying inline comments for
  **all** NEW findings, trivial ones included. Trivial findings do not get filtered out of a
  round that is happening anyway.
- Only trivial findings: `APPROVE`, with the trivial points recorded in the review body as
  explicitly non-blocking notes.
- No findings at all: `APPROVE`, with a body that says what you looked at and what you checked
  against the prior rounds. An approval that shows its work is evidence, not a rubber stamp.

**Post nothing at all, whatever the findings say.** Both of these skip step 5 entirely.

- A pull request that is no longer open. Re-read the `state` you fetched in step 3 before
  posting, particularly when the pass has run long, and carry the PR straight into step 6,
  which owns what happens next.
- A sub-agent that failed to review its PR, whether it errored, returned nothing, or returned
  something you cannot make sense of: leave its Caroline task untouched, and carry it into the
  step 6 report as not reviewed with the reason. A stated skip is worth far more than a silent
  one.

**Adjudicated is settled, and this is the easiest rule in the skill to get wrong.** "Still
present at head" is the test for an unfixed defect, never for a decision someone took
deliberately. Before any PREVIOUSLY RAISED finding reaches a review body, sort it into one of
three cases:

- **The author explicitly deferred, declined, or answered it.** Settled. Do not raise it, do
  not reply pressing it, and do not restate it as a blocker because you find the reasoning
  thin. At most note in passing that it is deferred and known. Re-raising asks the author to
  re-litigate a decision they already took, and it makes the review read as not having read
  the history.
- **The author claimed a fix and the defect is still there at head.** Raise it again, saying
  the thread claimed otherwise. This is the case the pass exists for.
- **The deferral stands but its stated grounds no longer hold.** A later change in the same
  PR can falsify the reason a deferral rested on, and the consequence is then fair to raise.
  On nearform/techbase#2912 the writer-role `created_by` gap was deferred on the express
  grounds that "Columns are nullable, so there is no crash"; the same PR then added an IDE
  update filter requiring `created_by`, which made a Platform-created row report
  "Update target row was not found" for a row that exists. Quote the grounds against the
  change that broke them, say plainly the deferral is not being reopened, invite the author to
  push back if they read it as still in scope, and surface it to the user as a judgement call
  rather than settling it silently. The grounds must be falsified by the code, not by your
  view of how thin they were.

- **The author fixed exactly what was asked, but part of the original point is untouched.**
  That remainder is fair, framed as the unfixed half rather than as a fresh finding. Quote what
  the original thread asked for and what the reply covered, so the gap is visible rather than
  asserted.

A point the user settled somewhere you cannot see (a Slack call, a conversation in a meeting)
is adjudicated too. If an author pushes back saying something was already agreed, treat that as
probably true: concede it, and take it back to the user rather than defending the finding.

**Withdrawing a finding you should not have posted.** Do it properly rather than quietly. Edit
the review body to say what was withdrawn and why
(`gh api repos/<owner>/<repo>/pulls/<n>/reviews/<reviewId> --method PUT --input <file>`, which
keeps the review's `state`), and delete any thread reply that pressed the point
(`gh api repos/<owner>/<repo>/pulls/comments/<commentId> --method DELETE`). A withdrawn blocker
left standing in the body keeps blocking the PR in the author's eyes.

**Calibration behind the call.**

- A PREVIOUSLY RAISED finding that still stands never becomes a fresh inline comment, whatever
  the verdict. It is answered on its own thread and named in the review body (step 5), so the
  round reads as complete without the author reading the same point twice. Only when the
  sub-agent could not supply a thread reference does it become a new inline comment, and then
  the comment says it was raised before.
  Where the author has not replied on that thread at all, because the whole round went
  unanswered, a reply repeating the point adds nothing they have not already had a chance to
  read. Name those findings in the review body with their thread links, say in the body that
  you are deliberately not re-posting on unanswered threads, and confirm they are still
  present at the new head rather than assuming. Reply on the thread only where you have
  something genuinely new to add: the point moved, its cause changed, or a later commit
  altered what it depends on. A whole PR of unanswered rounds is a signal to keep the round
  compact, not to restate every prior finding at length.
- **A red check is not automatically a blocker.** Before writing that a PR "cannot merge as
  is", read the branch's actual protection:
  `gh api repos/<owner>/<repo>/branches/<base>/protection --jq '.required_status_checks.contexts'`.
  A failing check that is not in that list blocks nothing, and claiming otherwise is a factual
  error the author will correct. Worth checking `gh pr view <n> --json mergeable,mergeStateStatus,reviewDecision`
  too: a `BLOCKED` state is often your own prior `CHANGES_REQUESTED` rather than anything in CI.
- Trivial means wording, naming, style, a missing optional field. Non-trivial means it
  changes behaviour, correctness, security, or maintainability in a way that warrants a
  change before merge.
- Do not flag missing optional or "encouraged" fields, especially where merged code
  already omits them. If the codebase does not follow a convention, that convention is
  aspirational.
- Findings verifiable inside the diff itself are not judgement calls and should carry
  weight: wrong API usage, an example contradicting the same file's guidance, added but
  unreferenced files, verbatim duplicates.

## Step 5: post one review per PR

Post a single review per PR through the API, not a scatter of loose comments. Write the payload
to a scratch file outside every checkout, so nothing lands in the working tree of the PR under
review: `REVIEW_JSON="$(mktemp -t caroline-review-XXXXXX.json)"`. This skill modifies no file
in any existing checkout.

```bash
gh api repos/<owner>/<repo>/pulls/<n>/reviews --method POST --input "$REVIEW_JSON" \
  -q '.state, .html_url'
```

`$REVIEW_JSON`:

```json
{
  "commit_id": "<headSha>",
  "event": "REQUEST_CHANGES",
  "body": "The extracted planner reads well and the tests cover both branches.\n\nTwo blockers:\n\n1. `planCandidates` drops overdue reviews when `includeReviews` is off (src/domain/plan.ts).\n2. The example config names a key the schema does not accept.\n\nStructural note: this PR is based on `feat/planner-split`, so it cannot merge until that one does.",
  "comments": [
    {
      "path": "src/domain/plan.ts",
      "line": 84,
      "side": "RIGHT",
      "body": "With `includeReviews` false this returns before the deadline check, so an overdue review never reaches the plan. Move the status test below the deadline branch."
    },
    {
      "path": "caroline.config.example.json",
      "line": 12,
      "side": "RIGHT",
      "body": "`planning.reviewLimit` is not in the config schema, so an install that copies this example fails validation on startup."
    }
  ]
}
```

Inline anchoring rules, learned the hard way:

- An inline comment must land on a line **inside a diff hunk** for that file. Get the hunk
  ranges with `gh pr diff <n> --repo <owner>/<repo>` and read the `@@` headers: for a new
  file every line is valid, otherwise only the lines the hunk covers.
- When the line you want to talk about sits outside the diff, anchor to the nearest
  changed line in the same file and name the real line in the comment text, or put the
  point in the review body instead.
- Two comments may share a line where two distinct findings genuinely sit there.
- A PREVIOUSLY RAISED finding that still stands is answered on its existing thread rather than
  duplicated, and summarised in the review body among the blockers. Post the review first, then
  the replies, so each reply sits under a round that already exists:

  ```bash
  gh api repos/<owner>/<repo>/pulls/<n>/comments/<commentId>/replies --method POST \
    --input "$REPLY_JSON"
  ```

  Write the reply body to a JSON file the same way as the review payload, rather than passing it
  as `-f body='...'`. Review prose is full of backticks, quotes and apostrophes, and a shell-quoted
  body containing them comes back as `HTTP 400 malformed request` after the review has already
  posted, which is the worst moment to be debugging quoting. The same applies to the review POST
  itself: build the JSON with a file write, never a heredoc.

- The review body should lead with what is good, then name the blockers in priority order,
  and note anything structural (a stacked PR whose base is another feature branch, for
  instance) that affects merge order.
- Write comments to be actionable: the failure scenario, then the suggested fix, with a
  code block where a snippet says it faster than prose.

### When the POST fails

GitHub validates the review as a unit. One comment anchored outside a diff hunk and the whole
call comes back `422 Unprocessable Entity`, so nothing at all reaches the PR. Treat a 422 as
work still to do, never as a posted review:

1. Read the error body. It carries a `message` plus an `errors[]` array whose entries name a
   `resource`, a `field` (typically `pull_request_review_thread.path` or
   `pull_request_review_thread.line`) and a `code`. There is no index back into the `comments`
   array you submitted, so work out which comment is meant from the field name plus your own
   hunk ranges: it is the one whose anchor those ranges do not cover.
2. Re-anchor that comment to the nearest changed line in the same file and name the real line
   in the comment text. If nothing in that file is inside a hunk, drop the comment from the
   array and move its point into the review body instead: the finding still gets reported,
   just not inline.
3. Re-POST the whole payload. Repeat if a second comment is rejected. GitHub reports one
   problem at a time, so a fixed payload can fail again on the next bad anchor.
4. If it still will not post after the anchors are exhausted, post the review with an empty
   `comments` array and the findings written out in the body. A review in the body is worth
   far more than no review.

A review has posted only when the call returns the review's `state` and `html_url`. Nothing in
step 6 happens for an **open** PR until it has. A PR that is no longer open never reaches this
step at all; step 6 owns that case. If a PR's review genuinely cannot be posted, leave its
Caroline task untouched and carry it into the step 6 report as not posted with the reason,
exactly as for a sub-agent that failed.

## Step 6: update Caroline, then report

This step owns the rule for a PR that is no longer open, and steps 4 and 5 defer to it. A pull
request that merged or closed while the pass was running gets no review posted: a round on a PR
that is no longer open changes nothing and asks the author to re-read a decision already taken.
It is completed here on the strength of its GitHub state, with no review to have posted.

The `state` and `mergedAt` that decide this are the ones you fetched yourself in step 3, not
anything a sub-agent reported. Re-fetch them with the same command if the pass has run long
enough for the PR to have moved since. `state` is GitHub's own (`OPEN`, `MERGED` or `CLOSED`).
It is not the `lifecycleState` on the Caroline row from step 1, which is the connector's
lifecycle for the task and says nothing about whether GitHub still has the pull request open.

An **open** PR reaches Caroline only once its review actually posted in step 5, confirmed by
the review's own `state` and `html_url` in the POST response. That `state` is the review's
(`CHANGES_REQUESTED`, `APPROVED`), not the PR's. A PR whose review did not post is left exactly
as it was in Caroline and reported as not reviewed: discharging the task without a review on
the PR loses the round in both places at once.

Caroline tracks your review, not the merge. Spec 02 is explicit that an open PR is never
invisible: it sits in `review` while it needs you and `waiting` while it needs the author, and
completion is proposed only on close, or on being dropped as a reviewer. `done` is inside the
GitHub connector's tracked statuses and sync bails on a `done` task, so completing an open PR
takes it off the board permanently, even when the author pushes and re-requests your review.

- Any verdict on an **open** pull request, an approval included:
  `mcp__caroline__mark_reviewed(id)`. The task moves to `waiting`, named on the author. What
  separates an approval from a needs-changes review is the `event` posted to GitHub in step 5,
  not which Caroline tool you call. Do not reach for `complete_task` because you approved.
- A pull request that is **already merged or closed**: `mcp__caroline__complete_task(id)`. That
  is the only case for it in this pass, and sync would propose the same completion on its next
  run anyway.
- `mark_reviewed` can refuse, with a reason. `already-reviewed` is not a failure: the review was
  discharged before, so note it and move on. `not-a-review` (the task carries no GitHub pull
  request source), `not-tracked` (the task is not sync tracked) and `unsynced` (the source has no
  head SHA yet, so no sync has seen the PR) each mean the task is not in the state this pass
  assumed. Leave it where it is, report the reason, and never substitute `complete_task` to
  force the row off the board.
- Report back a table of PR, verdict, comment count and Caroline status, then the blockers
  in priority order across the whole pass. Say plainly where you corrected or dropped a
  sub-agent's finding, and surface anything that is the maintainer's call rather than
  yours.

## Gotchas

- A resolved thread is a claim, not proof. An explicit deferral, though, is a decision: settled,
  and not yours to reopen. The one exception is a deferral whose stated grounds a later change
  in the same PR falsified: that consequence is reportable, the deferral still is not.
- Approving an open PR is still `mark_reviewed`, never `complete_task`.
- Sub-agent findings can be right about the defect and wrong about its scope, its line number,
  or which file the overclaim lives in, so verify all four.
- A failing check blocks nothing unless it is in the base branch's
  `required_status_checks.contexts`. Check before writing "cannot merge".
- The environment may not be able to run the language's own toolchain (no Linux `node`, an `npx`
  that resolves to a Windows install). When a claim needs execution you cannot do, say whose
  execution it was rather than borrowing it.
- Stacked PRs: check `baseRefName`, since a PR based on another feature branch cannot
  merge until its parent does, and that belongs in the review body.
- `gh pr checks` reporting no checks is not the same as checks passing.
- A `-f` parameter switches `gh api` to POST. Any call that is meant to be a GET therefore
  needs an explicit `--method GET` alongside it; a call that is meant to POST does not, and
  `--method POST` is only ever redundant, never wrong. Read each call's own flags rather than
  assuming.
- A 422 on the review POST means nothing posted, not that some of it did. Caroline waits.
- A verification fetch that fails into its own output file reads as a short or missing source
  file. Retry before believing it, or a network blip silently drops real findings.
- An unanswered prior round wants its findings named in the body with links, not restated at
  length on threads the author has not read yet.
- Precision in review prose: "out of date" is not "wrong", and a workflow condition
  admitting `cancelled` is a different defect from one admitting `failure`.
- No em-dashes in review bodies or inline comments.
