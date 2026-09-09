# Worktree lifecycle

Ignored files, including test/build outputs, deliberately block reclamation.
A future cleanup policy may register exact per-run rebuildable artifacts;
unknown ignored files remain preserved. Broad `git clean` is not an ownership
proof. Retained Git refs require a separate retention decision and are never
deleted automatically by this workflow.

### 3.1 Reclaimable worktree predicate

Record ownership immediately after creating a worktree, before dispatching a
child, using `scripts/worktree-guard.mjs register`. Store the record outside the
worktree under `$CANONICAL_RUN_DIR/worktrees/`. The helper captures canonical
path, Git common directory, repository, PR, run, purpose, and starting OID.
Do not create retrospective records for an unknown worktree or infer a PR from
its directory name. Existing worktrees without a record remain residual.

`RECLAIMABLE(<worktree>)` requires all of the following:

1. A creation-time ownership record matches the actual linked worktree and
   repository. Its canonical path is under the configured `.claude/worktrees/`
   root, and it is neither the main checkout nor the current run's checkout.
2. GitHub reports that exact recorded repository/PR as `MERGED`. Recheck the
   PR's `number`, `state`, and `headRefOid`; a branch name or directory suffix
   is not ownership evidence.
3. The controller has observed all tasks and processes using it terminate.
   If ownership overlaps another run or its lifecycle is unobservable, retain
   the worktree. Quiet output and a result file do not prove termination.
4. The worktree has no changes, untracked files, or ignored files. Its current
   HEAD is preserved by `worktree-guard.mjs preserve` in a private Git ref in
   the common repository, and `worktree-guard.mjs check` confirms that exact
   ref still resolves to HEAD immediately before removal.

The helper verifies local identity and recoverability; it neither checks
GitHub nor proves process termination. All four conditions are required.
A clean worktree may contain unpublished commits. A merged PR does not prove
those commits were saved. This repository squash-merges, so commit ancestry
alone is also insufficient. The private ref preserves local commits regardless
of the remote merge strategy and survives `git worktree remove` and Git GC.
Keep that ref until a separate, explicitly authorized retention cleanup.

```bash
node "${BABYSIT_SKILL_DIR}/scripts/worktree-guard.mjs" register \
  --record "$RECORD" --worktree "$WORKTREE" --repo "$REPO" --pr "$PR" \
  --run "$BABYSIT_RUN_ID" --purpose review
# After the controller has verified the merge and collected every task/process:
node "${BABYSIT_SKILL_DIR}/scripts/worktree-guard.mjs" preserve \
  --record "$RECORD" --worktree "$WORKTREE"
node "${BABYSIT_SKILL_DIR}/scripts/worktree-guard.mjs" check \
  --record "$RECORD" --worktree "$WORKTREE" --repo "$REPO" --pr "$PR" \
  --root /home/chin39/Documents/play/stocks/.claude/worktrees \
  --current "$PWD"
```

Exit `0` from `check` establishes only condition 4 and the local parts of
condition 1. A failed or missing check leaves the worktree in place. Never
remove with `--force`, and never remove a worktree while a writer can resume.

### 3.2 Startup worktree sweep

Skip the sweep entirely under `--dry-run` and `--snapshot-only` (section 20).
For other modes, enumerate `git worktree list --porcelain` once at startup.
Match worktrees to existing creation records in the run directories. Retain
unknown paths and records whose owner/task lifecycle cannot be established.
Evaluate section 3.1 for the remaining candidates before removing any.
Report scanned, reclaimed, and retained paths with the unmet condition.


---
