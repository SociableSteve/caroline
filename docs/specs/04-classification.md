# 04. Inbox classification

## Purpose

Empty the inbox automatically, hourly, without ever overriding a human decision and
without silently guessing when it is not confident.

## Trigger

Scheduled hourly (spec 06), and on demand from the UI. Runs after sync so that newly
ingested items are included in the same cycle.

## Input selection

Tasks where `status = 'inbox'` and `status_set_by != 'user'`, ordered oldest first, capped
at a configurable batch size per run (default 50). A task the user has touched is never a
candidate, even if it is still in the inbox: leaving something in the inbox on purpose is a
decision.

The payload sent per task is assembled under the LLM content policy (spec 09). At the
default policy that is: title, sender or author, source type, a snippet, and the age of the
item. Never more than the policy allows, regardless of what is stored.

## Output

One structured result per task:

```jsonc
{
  "status": "next_action",           // one of the seven, excluding done
  "confidence": 0.0,                  // 0 to 1
  "reasoning": "one or two sentences",
  "suggestedTitle": "Reply to X about Y",   // action-phrased, optional
  "estimateMinutes": 15,              // optional
  "projectSuggestion": {              // optional
    "existingProjectId": null,
    "newProjectTitle": "Q3 hub reporting"
  },
  "waitingOn": null                   // required when status is waiting
}
```

Classification is per task, not per batch, so one bad item cannot corrupt the rest. Calls
run with bounded concurrency.

## Applying results

- `confidence >= threshold` (default 0.75, configurable): apply the status with
  `status_set_by = 'llm'`. Apply the suggested title only if the task's title has not been
  edited by the user, and keep the original in `notes`.
- Below the threshold: the task stays in the inbox, flagged `needs_review` with the
  proposal attached, so the UI can offer a one-click accept.
- Never proposes `done`. Completing things is a human act, or a fact reported by sync.
- Project suggestions are never applied automatically. They surface as a suggestion the
  user accepts or dismisses, because creating a project is a commitment.

Every result is written to `classifications` (task id, proposed status, confidence,
reasoning, model, prompt version, applied yes/no, timestamp) whether applied or not. This
table is the audit trail and the evaluation set.

## Guidance given to the model

The system prompt encodes the GTD rules this system uses:

- If it takes under two minutes, it is a next action, not a project.
- If the next move belongs to someone else, it is `waiting`, and name who.
- If it needs more than one action to finish, suggest a project and give the first action.
- If it is information with no action, it is `reference`.
- If it is a real commitment but not now, it is `someday`.
- Prefer `inbox` with low confidence over a confident wrong guess.

The prompt is versioned in the repo, and its version is recorded on every classification so
that behaviour changes are traceable.

## Non-goals

- Re-classifying tasks that have left the inbox.
- Setting due dates. Deadlines come from humans and from source metadata.
- Deleting, archiving or completing anything.
- Learning or fine-tuning from corrections in v1. The `classifications` table exists so
  that few-shot examples from real corrections can be added later.

## Acceptance criteria

1. A task with `status_set_by = 'user'` is never selected, regardless of status.
2. A result at or above the threshold changes the status and sets `status_set_by = 'llm'`.
3. A result below the threshold leaves status untouched and records the proposal.
4. A proposed status of `done` is rejected and treated as a validation failure.
5. A result with `status: 'waiting'` and no `waitingOn` fails validation and retries once.
6. Every run writes one `classifications` row per task processed, including failures.
7. A provider outage leaves every candidate task in `inbox` with no partial writes, and
   records the failure in the run history.
8. Running the classifier twice with no new input produces no further status changes.
9. Accepting a low-confidence proposal from the UI sets `status_set_by = 'user'`.
