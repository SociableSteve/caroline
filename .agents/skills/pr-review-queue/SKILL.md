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

Call `mcp__caroline__list_reviews`. Each row carries the task id, the PR URL, the
repository, the PR number and an estimate. The task id is what Caroline is updated by in
step 6, so keep each id paired with its PR for the whole pass. If the queue is empty, say
so and stop.

## Step 2: one sub-agent per PR, in parallel

Spawn a general-purpose sub-agent per PR, all in a single message so they run
concurrently. Adapt this prompt:

```
Review pull request <pr url> (repo <owner>/<repo>, PR #<n>).

1. Read the PR's prior history BEFORE you review anything:
   - gh pr view <n> --repo <owner>/<repo> --json reviews,comments,body,title,headRefOid,baseRefName
   - gh api repos/<owner>/<repo>/pulls/<n>/comments   (inline comment threads)
   - gh api repos/<owner>/<repo>/pulls/<n>/reviews    (prior review bodies)

2. Run /code-review <pr url> medium.

3. Do not re-raise a finding an earlier cycle settled, UNLESS the defect is still
   present at the current head. A resolved thread is a claim that the fix landed, not
   proof: if the code still shows the defect, raise it again and say the thread claimed
   otherwise. Prior findings that are still open and still valid go in the report marked
   PREVIOUSLY RAISED with the thread reference, so the main agent does not post a
   duplicate. Also report which prior findings you checked and found genuinely fixed.

4. If this is a dependency bump, weigh the new version's breaking changes against this
   repo's actual call sites: the diff alone carries little to review.

You are READ-ONLY. Never pass --comment or --fix to /code-review, never post anything to
GitHub, never modify or push files. The main agent owns all posting.

Report back:
- One paragraph summarising what the PR does.
- A section on prior review feedback: what was raised, what is fixed, what still stands.
- A finding list. Per finding: file path and line, a one-line summary, the category,
  confidence (CONFIRMED or PLAUSIBLE), a concrete failure scenario, NEW or
  PREVIOUSLY RAISED, and TRIVIAL or NON-TRIVIAL.
```

## Step 3: verify before posting

Non-negotiable, and the step that earns this skill its keep. A sub-agent's findings are a
draft, not a verdict. For every finding you intend to post, confirm it against the files
at the PR head before it reaches GitHub. Quote the head SHA from
`gh pr view <n> --repo <owner>/<repo> --json headRefOid`, then:

```bash
gh api "repos/<owner>/<repo>/contents/<path>?ref=<headSha>" -q '.content' \
  | base64 -d | cat -n | sed -n '<range>p'
```

In practice this has caught a sub-agent describing a defect accurately but framing it
wrongly, claiming two config files both lacked a validation block when only one did.
Correct the framing, or drop the finding, rather than relaying it as received. Anything
you cannot confirm gets downgraded or dropped, never posted as fact.

## Step 4: triage

- Any non-trivial finding: post a `REQUEST_CHANGES` review carrying inline comments for
  **all** findings, trivial ones included. Trivial findings do not get filtered out of a
  round that is happening anyway.
- Only trivial findings: `APPROVE`, with the trivial points recorded in the review body as
  explicitly non-blocking notes.
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

Post a single review per PR through the API, not a scatter of loose comments:

```bash
gh api repos/<owner>/<repo>/pulls/<n>/reviews --method POST --input review.json \
  -q '.state, .html_url'
```

`review.json`:

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
- The review body should lead with what is good, then name the blockers in priority order,
  and note anything structural (a stacked PR whose base is another feature branch, for
  instance) that affects merge order.
- Write comments to be actionable: the failure scenario, then the suggested fix, with a
  code block where a snippet says it faster than prose.

## Step 6: update Caroline, then report

- Needs changes: `mcp__caroline__mark_reviewed(id)`. The task moves to waiting, named on
  the author.
- Approved: `mcp__caroline__complete_task(id)`. The task leaves the board.
- Report back a table of PR, verdict, comment count and Caroline status, then the blockers
  in priority order across the whole pass. Say plainly where you corrected or dropped a
  sub-agent's finding, and surface anything that is the maintainer's call rather than
  yours.

## Gotchas

- A resolved thread is a claim, not proof.
- Sub-agent findings can be right about the defect and wrong about its scope, so verify.
- Stacked PRs: check `baseRefName`, since a PR based on another feature branch cannot
  merge until its parent does, and that belongs in the review body.
- `gh pr checks` reporting no checks is not the same as checks passing.
- Precision in review prose: "out of date" is not "wrong", and a workflow condition
  admitting `cancelled` is a different defect from one admitting `failure`.
- No em-dashes in review bodies or inline comments.
