# Publication, convergence, and final reporting

## 16. Deterministic readiness gates

A PR is review-current only when:

- v2 marker head/base/spec/key exactly match the fresh snapshot;
- a fresh judgment or verification artifact accepts that key;
- artifact commit/OIDs match GitHub;
- no later head/base/spec change exists.

`READY_STACKED` requires all of:

```text
is open and non-draft
strict_stacked == true
leaf == true
review_current == true
independent_acceptance_current == true
unresolved_threads == 0
CI green OR legitimately absent with fresh local gates
external_review_satisfied == true for the current head, per the PR's
  effective mode (section 13.6)
mergeable == MERGEABLE
mergeStateStatus has no unresolved branch-protection blocker
no CHANGES_REQUESTED review
expected head still current
no collision or native capability blocker
```

`READY_ROOT` requires the same gates except `strict_stacked`, and requires no
open child. For a `fresh-pass-retry` root that means a fresh PR-body pass
reaction for the current head — a posted trigger or a silent bot is never
enough.

A root may be ready even though this skill lacks authority to merge it.

---

## 17. Bounded convergence loop

Default limits:

```text
max waves: 8
max live heavy children: min(4, available runtime slots)
max live writers: 2
poll interval: 60 seconds
external-only no-progress limit: 10 minutes
```

For each wave:

1. Snapshot all open non-draft PRs and rebuild the DAG.
2. Restrict actions to the requested operational scope.
3. Validate current review keys and states.
4. Dispatch independent source-read-only reviews within the native child limit.
5. Dispatch the required judgment checkpoints after their input artifacts are
   terminal.
6. Dispatch thread-disposition checkpoints.
7. Batch confirmed fixes per parent.
8. Run native fix -> fresh verifier checkpoint sequentially.
9. Publish accepted fixes and update thread/status state.
10. Refresh snapshots.
11. Evaluate deterministic readiness.
12. Merge eligible strict stacked leaves.
13. Verify each merge and refresh every affected parent.
14. Apply composition verification or full review.
15. Continue until:
    - all in-scope work is `MERGED`, `READY_ROOT`, or `BLOCKED`;
    - only external CI/external-review/review gates remain with no progress for
      ten minutes;
    - no state transition is possible;
    - the wave cap is reached.

Do not stop automatically after one stack level. A three-level stack may land
within one invocation when each newly advanced parent re-passes its gates.

### 17.1 Invocation boundaries vs. the retry loop

The invocation is bounded. The external-review retry loop is not.

- Post at most `retry.maxRoundsPerInvocation` triggers per PR in one
  invocation.
- If `codexNextTriggerAt` falls inside this invocation's remaining runtime
  budget, keep polling and fire the round when it comes due.
- If it does not, end the invocation for that PR and report:

  ```text
  WAITING_CODEX round=<n> nextRetryAt=<timestamp>
  ```

- The external-only no-progress limit ends **this invocation only**. It must
  not clear retry state, must not mark the PR satisfied, and must not mark it
  permanently blocked.
- Always write `codexNextTriggerAt` into the status comment before exiting, so
  the next invocation knows when the next round is due.

The next invocation of either native entrypoint reconstructs external-review
state from the GitHub status comment plus live comments and reactions, and posts the next
round as soon as it is due.

For unattended operation, use `runners/babysit-auto/` from this repository.
Its timer starts a new top-level controller invocation only when the gate
reports due work. It is separate from the controller's native child lifecycle.
Without an installed and enabled runner, report the next due time and leave
retrying to the next manual invocation; never imply a timer exists.

After a process/session restart, discard assumptions and reconstruct state from
GitHub plus committed artifacts. Salvage valid unpushed commits before deleting
leftover worktrees.

---

## 18. Merge execution

Before every merge, fetch a fresh snapshot and reevaluate all gates.

Default:

- merge only `READY_STACKED` strict stacked leaves;
- process innermost-first;
- independent leaves may be handled in the same wave;
- PRs targeting the same base branch merge sequentially.

With `--merge-integration`, a `READY_ROOT` PR whose base is exactly
`stocks-dev` may also merge after all strict descendants are gone.

Never merge a PR whose base is `main`.

Use:

```bash
gh pr merge <N> \
  --repo chinrw/stocks \
  --merge \
  --match-head-commit <expected-head>
```

Never use:

- `--admin`;
- `--delete-branch`;
- force push;
- a merge command without expected-head matching.

After the command:

```bash
gh pr view <N> --repo chinrw/stocks --json state,mergeCommit,headRefOid,baseRefName
```

Verify `state=MERGED`. If branch policy placed the PR into a merge queue
instead, report it as queued and poll its live state; do not claim it merged.
On any other failure, do not blindly retry. Resnapshot, classify the new reason,
and either continue safely or mark `BLOCKED`.

Once `state=MERGED` is verified, reclaim that PR's worktree if it satisfies
`RECLAIMABLE` (section 3.1):

```bash
git -C /home/chin39/Documents/play/stocks worktree remove <path>
git -C /home/chin39/Documents/play/stocks worktree prune
```

Never `--force`. A worktree that is dirty, or that fails any other clause, is
left in place and reported as residual.

Reclamation runs after the merge is already confirmed and is best-effort: a
failed removal never downgrades a merged PR to a failed merge. Report the merge
outcome and the reclamation outcome separately.

---

## 19. Collision and idempotency rules

Before every push, comment, reply, resolution, trigger, status update, or merge:

1. fetch live PR head/base;
2. compare to the expected snapshot/review key;
3. recheck the target thread/comment/branch;
4. detect whether another babysitter session already completed the action;
5. stand down rather than duplicate or overwrite.

Never:

- delete another session's comment;
- replace a remote fix branch with non-fast-forward history;
- resolve a thread already changed by another actor without rereading it;
- reuse a review artifact for another head/base/spec key;
- trust local state over GitHub after restart.

Clean up only worktrees satisfying section 3.1. Ownership records and saved
Git refs carry across runs; directory names do not. If another run may still
own a writer, leave the worktree in place. Use `git worktree remove` and
`git worktree prune` only after every condition has been rechecked.

---

## 20. Dry-run and snapshot-only behavior

With `--snapshot-only` (section 1.1): observe and report only. No native task,
no checkpoint, no worktree, no test, no artifact beyond snapshot and
external-review observation/handoff files, and no GitHub write. Every action label is prefixed `🔎 SNAPSHOT:`.

With `--dry-run`:

- build the complete snapshot and stack graph;
- compute proposed review keys and states;
- read existing artifacts;
- source-read-only native review and local validation are allowed;
- evaluate external review and report
  `would trigger <triggerComment> round <N>`;
- do not post/update comments;
- never post an external-review trigger, in any mode, for any reason;
- do not reply or resolve threads;
- do not push;
- do not create/update PRs;
- do not sweep or remove worktrees (section 3.2);
- do not merge.

Report every write action that would have occurred with exact PR and reason.

---

## 21. Final report

Print a compact table:

```text
PR · type · title · head · review · threads · Codex · CI/local · child · state · action
```

Use these action labels:

- `🚀 AUTO-MERGED`
- `✅ READY ROOT`
- `🛠 FIX PR OPEN`
- `⏳ WAITING: <gate>`
- `❌ BLOCKED: <reason>`
- `🧪 DRY-RUN: <planned action>`
- `🔎 SNAPSHOT: <observed state>`

A PR waiting on external review reports its live retry state:

```text
⏳ WAITING_CODEX round=<n> nextRetryAt=<UTC timestamp>
```

Never report such a PR as satisfied, done, or blocked.

Then explicitly list:

1. PRs auto-merged in this invocation;
2. root/integration PRs ready for the user;
3. open fix PRs and their parent PRs;
4. PRs waiting on CI, Codex, required review, or external input;
5. blockers and exhausted retry ladders;
6. whether the wave cap or no-progress limit stopped convergence, and the
   `nextRetryAt` of every PR still in the external-review retry loop;
7. unavailable capabilities and observed model/effort, using `unknown` when
   unavailable; missing model metadata is informational, not a blocker;
8. worktrees reclaimed this invocation with their paths, and worktrees retained
   as residual with the `RECLAIMABLE` clause each failed.

When any PR is still `WAITING_CODEX`, report its next retry time and whether
an enabled runner has actually been verified. Otherwise another invocation is
needed (section 17.1).

Do not include findings prose, diffs, spec excerpts, or long test logs in the
final report.

---

## 22. Hard rules

- The current host session owns the workflow; all children use its native tools.
- Delegate detailed review and implementation; read decisive evidence as needed.
- Use fresh contexts for review, judgment, and verification. Children do not spawn.
- An implementer claim is not acceptance. A fresh verifier checkpoint and real
  local gates are required before push.
- The controller owns commits and every GitHub write.
- Assigned paths are scope instructions, not a path-scoped sandbox.
- Only completed, schema-valid, identity-matching artifacts can be accepted.
  Native completion must be observed independently of result-file contents.

- A finding count is not a finding. No blocker, GitHub comment, fix task, or
  acceptance may come from summary telemetry, and `blocking=0` without a
  complete artifact never approves a PR.
- An incomplete result earns exactly one fresh attempt with a new attempt ID;
  a second incomplete result is `BLOCKED: codex-output-incomplete`. Never invent
  findings from either attempt.
- The review key comes from `scripts/review-key.mjs` — one NUL between adjacent
  fields, no trailing NUL, no final newline. No agent recomputes it from prose,
  and the algorithm never changes under an unchanged marker version.
- A marker written under a legacy dialect is recognized, never accepted. Only
  `review-key.mjs classify` exit `0` proves review-current. New markers carry
  full lowercase OIDs and a bare spec hash.
- A pure test-coverage claim needs empirical mutation evidence when the
  experiment is safely runnable; otherwise it stays unconfirmed, not blocking.
- Temporary probes live under `mktemp -d "${TMPDIR:-/tmp}/..."`, never in the
  repository. Source cleanliness is verified after every judge/verifier task.
- Specs override parity assumptions. Intentional documented divergence is not a
  bug.
- Never push to the reviewed PR's branch.
- Never force push.
- Never use `--admin`.
- Never merge into `main`.
- By default, auto-merge only strict stacked PRs.
- Never merge without `--match-head-commit`.
- Never resolve a thread without a pushed fix or evidence-backed disposition.
- Never let two writers overlap.
- Never run `bun run build`.
- Run pytest with `-n0`.
- Do not bind reserved ports.
- Do not leave untracked background tests or agents as implicit gates.
- Every acceptance is bound to exact head, base, spec hash, and policy version.
- Be honest: silent Codex, stale reactions, pending CI, required approvals, and
  unknown mergeability are not readiness.
- External review is repository policy, never a hardcoded login or repo name.
- A pass is the configured bot's configured reaction **on the PR body**, fresh
  against the current head. Nothing else passes.
- Post an external-review trigger when `trigger_due` holds. A current-head
  trigger suppresses posting only until `codexNextTriggerAt`; it is never a
  permanent one-shot key.
- `fresh-pass-retry` retries indefinitely across invocations and restarts.
  Per-invocation caps, wave caps, and no-progress limits end an invocation, not
  the retry loop.
- Never deduplicate triggers by deleting comments.
- `--dry-run` never posts an external-review trigger.
- `--snapshot-only` dispatches no native task, no checkpoint, and no worktree.
  It observes and reports; it never advances a state machine.
