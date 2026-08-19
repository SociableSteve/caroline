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
never pushes code to the PR under review: the only things it writes are review bodies and
inline comments.

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
concurrently. They need the full toolset: worktree checkouts, running the project's tests, and
running commands to check a claim rather than assert it. Read-only is therefore a rule the
prompt states, not a capability the agent lacks, so state it plainly and check the report for
signs it was crossed.

Adapt this prompt:

```
Review pull request <pr url> (repo <owner>/<repo>, PR #<n>).

1. Read the PR's prior history BEFORE you review anything:
   - gh pr view <n> --repo <owner>/<repo> --json reviews,comments,body,title,headRefOid,baseRefName
   - gh api --paginate repos/<owner>/<repo>/pulls/<n>/comments   (inline comment threads)
   - gh api --paginate repos/<owner>/<repo>/pulls/<n>/reviews    (prior review bodies)

   --paginate is not optional. Without it you see the first 30 items only, and a PR with a
   long history hands you a truncated view of what has already been settled.

2. Review the PR with the built-in code-review skill, as a Skill tool call:
   Skill(skill: "code-review", args: "<pr url> medium"). Make the tool call. Do not write a
   literal /code-review line as text, and do not use the code-review:code-review plugin: it
   posts a top-level comment to the PR unconditionally, which would break the read-only rule
   below from the step that promises to keep it.

3. Do not re-raise a finding an earlier cycle settled, UNLESS the defect is still
   present at the current head. A resolved thread is a claim that the fix landed, not
   proof: if the code still shows the defect, raise it again and say the thread claimed
   otherwise. Prior findings that are still open and still valid go in the report marked
   PREVIOUSLY RAISED, each with its review comment id and thread URL, so the main agent can
   answer on the existing thread instead of posting a duplicate inline comment. Also report
   which prior findings you checked and found genuinely fixed.

4. If this is a dependency bump, weigh the new version's breaking changes against this
   repo's actual call sites: the diff alone carries little to review.

You are READ-ONLY. Use the built-in code-review skill, never the code-review:code-review
plugin, and never pass --comment or --fix. Never post anything to GitHub, never modify or
push files. The main agent owns all posting.

Report back:
- One paragraph summarising what the PR does.
- A section on prior review feedback: what was raised, what is fixed, what still stands.
- A finding list. Per finding: file path and line, a one-line summary, the category,
  confidence (CONFIRMED or PLAUSIBLE), a concrete failure scenario, NEW or
  PREVIOUSLY RAISED (with the review comment id and thread URL when PREVIOUSLY RAISED),
  and TRIVIAL or NON-TRIVIAL.
```

## Step 3: verify before posting

Non-negotiable, and the step that earns this skill its keep. A sub-agent's findings are a
draft, not a verdict. For every finding you intend to post, confirm it against the files
at the PR head before it reaches GitHub. Quote the head SHA from
`gh pr view <n> --repo <owner>/<repo> --json headRefOid -q .headRefOid`, then:

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

In practice this has caught a sub-agent describing a defect accurately but framing it
wrongly, claiming two config files both lacked a validation block when only one did.
Correct the framing, or drop the finding, rather than relaying it as received. Anything
you cannot confirm gets downgraded or dropped, never posted as fact.

## Step 4: triage

One verdict per PR:

- Any non-trivial finding: post a `REQUEST_CHANGES` review carrying inline comments for
  **all** NEW findings, trivial ones included. Trivial findings do not get filtered out of a
  round that is happening anyway.
- Only trivial findings: `APPROVE`, with the trivial points recorded in the review body as
  explicitly non-blocking notes.
- No findings at all: `APPROVE`, with a body that says what you looked at and what you checked
  against the prior rounds. An approval that shows its work is evidence, not a rubber stamp.
- A PREVIOUSLY RAISED finding that still stands never becomes a fresh inline comment, whatever
  the verdict. It is answered on its own thread and named in the review body (step 5), so the
  round reads as complete without the author reading the same point twice. Only when the
  sub-agent could not supply a thread reference does it become a new inline comment, and then
  the comment says it was raised before.
- A sub-agent that failed to review its PR, whether it errored, returned nothing, or returned
  something you cannot make sense of: post nothing for that PR, leave its Caroline task
  untouched, and carry it into the step 6 report as not reviewed with the reason. A stated skip
  is worth far more than a silent one.
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
review: `REVIEW_JSON="$(mktemp -t caroline-review-XXXXXX.json)"`. This skill modifies no files
in any repository.

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
    -f body='Still present at <headSha>: ...'
  ```

- The review body should lead with what is good, then name the blockers in priority order,
  and note anything structural (a stacked PR whose base is another feature branch, for
  instance) that affects merge order.
- Write comments to be actionable: the failure scenario, then the suggested fix, with a
  code block where a snippet says it faster than prose.

### When the POST fails

GitHub validates the review as a unit. One comment anchored outside a diff hunk and the whole
call comes back `422 Unprocessable Entity`, so nothing at all reaches the PR. Treat a 422 as
work still to do, never as a posted review:

1. Read the error body. It names the offending comment, usually as
   `pull_request_review_thread.path` or `.line` on a given index into the `comments` array.
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
step 6 happens for a PR until it has. If a PR's review genuinely cannot be posted, leave its
Caroline task untouched and carry it into the step 6 report as not posted with the reason,
exactly as for a sub-agent that failed.

## Step 6: update Caroline, then report

Only for a PR whose review actually posted in step 5, confirmed by the `state` and `html_url`
the POST returned. A PR whose review did not post is left exactly as it was in Caroline and
reported as not reviewed: discharging the task without a review on the PR loses the round in
both places at once.

Caroline tracks your review, not the merge. Spec 02 is explicit that an open PR is never
invisible: it sits in `review` while it needs you and `waiting` while it needs the author, and
completion is proposed only on close, or on being dropped as a reviewer. `done` is inside the
GitHub connector's tracked statuses and sync bails on a `done` task, so completing an open PR
takes it off the board permanently, even when the author pushes and re-requests your review.

- Any verdict on an **open** pull request, an approval included: `mcp__caroline__mark_reviewed(id)`.
  The task moves to `waiting`, named on the author. What separates an approval from a
  needs-changes review is the `event` posted to GitHub in step 5, not which Caroline tool you
  call. Do not reach for `complete_task` because you approved.
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

- A resolved thread is a claim, not proof.
- Approving an open PR is still `mark_reviewed`, never `complete_task`.
- Sub-agent findings can be right about the defect and wrong about its scope, so verify.
- Stacked PRs: check `baseRefName`, since a PR based on another feature branch cannot
  merge until its parent does, and that belongs in the review body.
- `gh pr checks` reporting no checks is not the same as checks passing.
- `gh api` needs `--method GET` alongside any `-f` parameter, or it POSTs and 404s.
- A 422 on the review POST means nothing posted, not that some of it did. Caroline waits.
- Precision in review prose: "out of date" is not "wrong", and a workflow condition
  admitting `cancelled` is a different defect from one admitting `failure`.
- No em-dashes in review bodies or inline comments.
