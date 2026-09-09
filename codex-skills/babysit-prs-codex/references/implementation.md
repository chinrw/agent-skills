# Implementation, local checks, and verification

## 12. Fix pipeline

Never push fixes directly to the reviewed PR's branch.

### 12.1 Reuse or create the stacked fix branch

Preferred remote branch:

```text
fix/pr<N>-review
```

If an open fix PR for the same parent already exists, base new work on its
current head. Otherwise base it on the reviewed PR's exact current head.

Create a unique local worktree/branch under `.claude/worktrees/`. The local
branch name may be session-specific; the remote push target stays explicit.
Register new worktree ownership with purpose `fix` before dispatch (section 3.1).

Fix PR requirements:

- base: the reviewed PR's head branch;
- title: `fix(pr#<N>): address review findings`;
- body references `#<N>`;
- no force push;
- no push to the parent PR branch;
- fall back to another base only when the head branch is an inaccessible fork,
  and then mark the workflow `BLOCKED` for automatic merge rather than silently
  changing semantics.

### 12.2 Bounded implementation

Batch every confirmed finding for the parent into one native fix task. Assign
the exact worktree, file scope, finding IDs, constraints, required tests, and
schema-derived artifact contract. Use the loaded adapter's model configuration.
Let the implementer choose local implementation details within that scope.
Reuse validation for an unchanged revision when its evidence is complete; rerun
affected checks after changes, failures, or a newly identified concern.

Allow at most three sequential implementation rounds for ordinary work and two
for complex or critical work. Critical work includes security/auth/authz, data
integrity, financial correctness, concurrency, and destructive migrations.
Each correction consumes the previous fresh verifier's feedback. Exhaustion
becomes `BLOCKED`; the controller must not bypass independent verification.

The fix child must:

- edit only the assigned worktree and scope;
- implement all confirmed findings and run meaningful focused checks;
- leave changes uncommitted; the controller owns commit creation;
- write its complete result to the assigned attempt's `result.json`;
- omit `fix.commit` or set it null;
- return the compact handoff and perform no GitHub writes.

After native completion, the controller validates the result (section 5.3),
checks the actual changed-file set against the assignment, and creates the
signed commit (`git commit -s`). Record its exact OID as `fix.commit`, recompute
the canonical artifact hash, and hand both to a fresh independent verifier.

### 12.3 Fresh independent verifier

After every implementation round, run a fresh `verifier` checkpoint. It must not edit code or launch nested tasks.

It verifies:

- exact parent head and intended fix base;
- full diff, not only files named by the implementer;
- every confirmed finding closure;
- no hidden unrelated changes;
- spec/plan compliance;
- error paths, tests, concurrency/security implications as applicable;
- `git diff --check`;
- focused project tests in the foreground;
- pytest with `-n0`;
- Rust fmt/clippy/test when Rust is touched;
- no `bun run build`;
- no server unless indispensable.

Write the verifier envelope of
[references/checkpoint-contract.md](checkpoint-contract.md).
The controller admits it as `verification.json`; parentHead and fixCommit live
in `subject`, while closure, blockers and test results live in `result`. A
mechanically valid REJECT is correction evidence and never authorizes publishing.

Return only the compact handoff line.

`REJECT` feeds one bounded correction round into a fresh implementation context.
`BLOCKED` stops that PR pipeline.

### 12.4 Publish only after acceptance

After `ACCEPT`, the main controller performs a collision guard:

- parent head still equals the expected OID;
- remote fix branch did not advance unexpectedly;
- confirmed threads are still unresolved and belong to the same head;
- no other session already pushed an equivalent fix;
- the verification artifact matches the commit to push.

Push explicitly and never force:

```bash
git push origin <accepted-commit>:refs/heads/fix/pr<N>-review
```

Create or update the stacked fix PR. Then:

1. reply to each fixed thread with the pushed commit SHA and fix-PR URL;
2. resolve each disposed fixed thread;
3. create/update the fix PR's v2 status comment using its own head/base/spec/key;
4. record local gates;
5. evaluate the fix PR's own external-review state (section 13) against its new
   head and post the configured trigger when `trigger_due` holds;
6. let the fix PR enter the normal strict-stack gate and merge pipeline.

A parent with a still-open fix child is not ready, even if its review threads
are now resolved.

---

## 14. CI and local gate policy

Interpret `statusCheckRollup` as follows:

- queued/running -> `WAITING_CI`;
- any required failure/cancellation -> `BLOCKED` or `WAITING_CI` with exact
  failing check names;
- all required checks successful -> CI green;
- empty rollup:
  - legitimate only when the PR base is outside
    `main`, `stocks-dev`, and `stocks-rust`;
  - requires fresh recorded local gates from an independent verifier;
  - otherwise it is pending/unknown, not green.

Do not report `no CI` merely because checks have not appeared yet on a branch
that the workflow is configured to cover.

Required GitHub reviews or branch-protection approvals remain external gates.
Never use `--admin` to bypass them.

---

## 15. Composition verification after a child merge

A child merge changes the parent's head and invalidates its old review key.
Avoid a full review only when composition is cryptographically and structurally
proved.

A parent is eligible for the composition shortcut when:

1. the old parent review key was accepted;
2. the child review key was accepted;
3. the new parent head is a merge commit;
4. its first parent is exactly the old parent head;
5. its second parent is exactly the accepted child head;
6. `git merge-tree --write-tree <old-parent> <child-head>` succeeds;
7. that expected tree equals `<new-parent>^{tree}`;
8. the parent's base OID and relevant spec hash are known;
9. fresh relevant local/CI gates pass.

If `git merge-tree --write-tree` is unsupported, reports a conflict, or yields a
different tree, do a full review.

For ordinary non-critical changes, run a fresh `composition-verifier`
checkpoint. For security, auth/authz, data-integrity, financial,
concurrency, destructive-migration, or otherwise high-risk composition, run
the `critical-composition-verifier` checkpoint instead. The selected checkpoint reads only:

- prior accepted parent/child artifacts;
- exact ancestry/tree proof;
- merge delta and relevant specs;
- fresh gate evidence.

It writes `composition-verification.json`. The ordinary verifier may also return
`ESCALATE_MAX`; immediately run the `critical-composition-verifier` checkpoint
on the same immutable evidence. Final composition verdicts are `ACCEPT`,
`REVIEW`, or `BLOCKED`.

On `ACCEPT`, compute the new review key, update the status comment, and apply
the external-review policy to the new head: the round counter resets and
round 1 is immediately due (section 13.3). On `REVIEW`, run the full review
pipeline.

This shortcut applies to any accepted strict child, including a babysitter fix
PR.

---
