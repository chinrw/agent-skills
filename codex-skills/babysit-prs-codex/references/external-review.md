# Repository policy and external review

## 4. Repository policy — already established for this workflow

- Repository: `chinrw/stocks`
- Remote: `origin`
- Main checkout: `/home/chin39/Documents/play/stocks`
- Default/release branch: `main`
- Integration branch: `stocks-dev`
- `stocks-dev -> main` is a human-gated release promotion.
- Other known branch/worktree port reservations:
  - main checkout: `5001`
  - `stocks-dev`: `5002`
  - `stocks-rust`: `5006`
- Static review normally needs no server.
- Never bind ports `5002` or `5006`.
- If a server is indispensable in an ephemeral worktree, use a confirmed-free
  port `>=5100`.
- Never run `bun run build`; its `emptyOutDir` can remove shared
  `static/dist` output and break sibling worktrees.
- Run pytest checks with `-n0`; do not trust xdist for this workflow.
- If Rust is touched, select meaningful `cargo fmt --check`, `cargo clippy`,
  and `cargo test` commands appropriate to the changed scope.
- Hot reload is enabled; do not restart servers by habit.
- CI workflow: `CI`, workflow id `296221856`.
- The workflow filters pull requests by base branch:
  `main`, `stocks-dev`, and `stocks-rust`.
- A PR based on another feature branch can legitimately have no GitHub CI; such
  a PR requires recorded local gates before readiness.
- Design specs and plans are intended-behavior ground truth:
  - `docs/superpowers/specs/`
  - `docs/superpowers/plans/`
- Specs explicitly document intentional divergences. A spec-sanctioned
  divergence is not a finding. Only a contradiction is actionable.
- Commits created by this workflow must use the repository's normal author and
  DCO sign-off (`git commit -s`) and must not add AI attribution.

### 4.1 Effective external-review policy

External review (the `@codex review` bot loop) is **not** hardcoded. It is
expressed as repository policy so this skill stays repository-agnostic.

Resolution order, first hit wins:

1. `<repo-checkout>/.claude/babysit-prs.json`
2. built-in defaults

Schema, with the built-in defaults shown:

```json
{
  "externalReview": {
    "enabled": false,
    "botLogin": null,
    "triggerComment": null,
    "passReaction": "+1",
    "reactionTarget": "pr-body",
    "rootMode": "disabled",
    "strictStackedMode": "disabled",
    "retry": {
      "enabled": false,
      "intervalSeconds": 1800,
      "maxRoundsPerInvocation": 2,
      "maxTotalRounds": null,
      "minCollisionDelaySeconds": 60
    }
  }
}
```

Mode semantics:

| Mode | Meaning |
|---|---|
| `fresh-pass-retry` | Only a **fresh pass reaction on the PR body** satisfies the gate. Retry on a fixed cooldown, with no total round cap, until pass, close/merge, an unrecoverable block, or the user stops it. |
| `one-round` | One current-head round plus disposed threads satisfies the gate. Continued bot silence does not block. |
| `disabled` | Never query the bot, never trigger, never gate on it. |

- `maxTotalRounds: null` means **unlimited across invocations**.
- `maxRoundsPerInvocation` bounds a single invocation only. It is never a
  total round cap and never marks a PR satisfied.
- `minCollisionDelaySeconds` is the floor between two triggers when a
  disposition round earns an immediate re-review.

**Default is conservative.** A repository with no policy file has external
review disabled: no bot query, no trigger, and no external-review gate. Only an
explicitly configured repository runs the bot loop.

Resolve and validate the policy once at startup:

```bash
python3 "${BABYSIT_SKILL_DIR}/scripts/external_review.py" resolve-policy \
  --input "<repo-checkout>/.claude/babysit-prs.json"
```

A non-empty `errors` array is a configuration blocker. Mark affected PRs
`BLOCKED: external-review-policy` and do not guess a bot login or trigger text.

### 4.2 `chinrw/stocks` effective policy

`/home/chin39/Documents/play/stocks/.claude/babysit-prs.json`:

```json
{
  "externalReview": {
    "enabled": true,
    "botLogin": "chatgpt-codex-connector[bot]",
    "triggerComment": "@codex review",
    "passReaction": "+1",
    "reactionTarget": "pr-body",
    "rootMode": "fresh-pass-retry",
    "strictStackedMode": "one-round",
    "retry": {
      "enabled": true,
      "intervalSeconds": 1800,
      "maxRoundsPerInvocation": 2,
      "maxTotalRounds": null,
      "minCollisionDelaySeconds": 60
    }
  }
}
```

The 1800-second cooldown limits retries across invocations (section 17.1).

---

## 13. External review — persistent retry state machine

This is the `@codex review` loop. It is driven by the effective external-review
policy (section 4.1), not by hardcoded logins, and it is **persistent**: for a
`fresh-pass-retry` PR the skill keeps re-triggering on a cooldown across waves,
across invocations, and across controller restarts until the bot actually
passes the current head.

### 13.1 What a pass is

A pass is a **reaction left by the configured `botLogin`, with the configured
`passReaction` content, on the PR body** — that is, on
`repos/<repo>/issues/<N>/reactions`. For `chinrw/stocks` that is a `+1` from
`chatgpt-codex-connector[bot]`.

None of the following is a pass:

- an emoji inside a comment body;
- a reaction on an issue comment or on a review comment (different endpoints);
- a submitted review with no pass reaction;
- bot silence;
- a pass reaction older than the current head.

A pass is **fresh** only when its `created_at` is at or after the current head's
last commit `committedDate`.

Collect complete raw GitHub responses and run the local handoff described in
[references/external-review-handoff.md](external-review-handoff.md).
It preserves pagination, normalizes bot identity, and uses the existing evaluator.
Always quote a bot login containing `[bot]` when using shell tools.

### 13.2 The `trigger_due` predicate

Whether to post a trigger is a deterministic predicate, not a judgement call:

```text
trigger_due =
  externalReview.enabled
  AND mode == fresh-pass-retry
  AND no fresh pass for the current head
  AND no unresolved bot-authored thread requiring disposition
  AND PR is open and non-draft
  AND current head/base still equal the expected snapshot
  AND now >= codexNextTriggerAt
  AND no exact trigger was posted by another session inside the current
      cooldown window
```

Do not evaluate this by hand. Use the local handoff manifest and saved raw
observations (reference above):

```bash
node "${BABYSIT_SKILL_DIR}/scripts/external-review.mjs" \
  --input "$ART/observations/input.json" \
  --out "$ART/external-review-handoff.json"
```

The output's `decision` carries `action`, `codexState`, `codexRound`,
`codexNextTriggerAt`, `externalReviewSatisfied`, and `reasons`. A null marker or
`requiresResnapshot=true` forbids publication until observations are refreshed.
The controller may not override a decision; it may only re-observe and
re-evaluate. Allowed `codexState` values:

```text
DISABLED
PASS_FRESH
FINDINGS_OPEN
TRIGGER_DUE
TRIGGER_IN_FLIGHT
WAITING_RETRY
ONE_ROUND_SATISFIED
STOPPED_PR_CLOSED
BLOCKED_SNAPSHOT_STALE
EXHAUSTED_TOTAL_ROUNDS
POLICY_INVALID
```

### 13.3 Round accounting

A new head starts at round zero with round one immediately due. After an
actual successful post, supply its confirmed receipt to the handoff. The module
folds the comment's creation time into persisted state and derives the next
retry time; the controller does not increment counters or invent timestamps.
Unknown or failed write outcomes require refreshed observations and no marker.

An existing current-head trigger **suppresses posting only until
`codexNextTriggerAt`**. It is not a permanent one-shot key. A head that has
already been triggered once and stayed silent for a full cooldown is due for the
next round, and the round after that, indefinitely.

When every bot finding has been disposed and the head did not change, supply
the confirmed `dispositionCompletedAt` in the handoff manifest. The module
applies the policy's collision delay and derives the retry timestamp.

This re-reviews as soon as possible rather than waiting out the full cooldown,
while still keeping a short window so two sessions cannot double-post. A pure
rebuttal round with no head change still earns a new trigger — never skip it on
the grounds that the old trigger still belongs to the current head.

When a fix child merges and the parent head changes, the round counter resets
and round 1 is immediately due against the new head.

### 13.4 Exact trigger and collision guard

Each round posts **one new issue comment whose body, trimmed, equals the
configured `triggerComment` exactly**. No prefix, no suffix, no explanation.

Immediately before the write, re-query live state and confirm:

- the PR is still open, non-draft, and at the expected head/base;
- no fresh pass has appeared;
- unresolved bot threads are still zero;
- the latest exact trigger comment and its `createdAt`;
- `codexLastTriggerAt` / `codexRound` in the status comment;
- no other babysitter session triggered inside the cooldown window.

Rerun the handoff on these refreshed observations. If its decision no longer returns
`POST_TRIGGER` — because a pass landed, the head moved, or another session got
there first — abandon the write and adopt the returned live state. When another
session triggered inside the cooldown, this session stands down.

Never delete another session's trigger comment to "deduplicate". Deduplication
is the cooldown window, not comment deletion.

### 13.5 Findings take priority

While any unresolved bot-authored thread exists, the state is `FINDINGS_OPEN`
and no new trigger is posted. Route those threads through the normal
disposition / fix / independent-verification pipeline (sections 11 and 12).
Only after every bot thread has an evidence-backed reply and resolution does
the retry clock resume, per section 13.3.

Do not read bot thread bodies in the main context.

### 13.6 Gate semantics per mode

`rootMode = fresh-pass-retry` (roots and integration PRs):

```text
external_review_satisfied = fresh PR-body pass reaction for the current head
```

A trigger having been posted, the bot being silent, an elapsed timeout, or the
absence of threads **do not** satisfy this gate.

`strictStackedMode = one-round` (strict stacked PRs, the default relaxed rule):

```text
external_review_satisfied =
  a current-head exact trigger / reaction / review exists
  AND all resulting review threads are disposed
```

Bot silence after one current-head round is acceptable here. A stale trigger
from an older head is not. Only when repo policy explicitly sets
`strictStackedMode: "fresh-pass-retry"` does a strict stacked PR also wait for
the pass reaction.

Never apply the relaxed strict-stack rule to a root or integration PR.

### 13.7 Stop conditions

The retry loop for a PR ends only when one of these is true:

1. a fresh PR-body pass reaction appears for the current head;
2. the PR is closed or merged;
3. head/base/scope is blocked unrecoverably;
4. the user explicitly stops the loop;
5. policy sets a non-null `retry.maxTotalRounds` and it is reached.

Nothing else ends it. Not the wave cap, not the no-progress limit, not the
per-invocation round cap, not bot silence.

### 13.8 Dry run

With `--dry-run`, external review is evaluated but never written. The decision
reports:

```text
would trigger @codex review round <N>
```

and no comment is posted.

---
