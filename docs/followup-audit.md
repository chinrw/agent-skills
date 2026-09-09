# Follow-up audit closeout

Baseline: `c703134bcc806c5a18af8e10bdbef66b2b0c3a30`.
Input ZIP SHA-256:
`2b35e22fe5f03559fb7c3b92dec9851c56d74d6cfa9d7b0666875d5ca6e3ca3a`.

The subsequent [round-three audit](round3-audit.md) fixes two remaining lifecycle
boundaries and records separate validation against the real local host.

| Round | Changes | Evidence |
|---|---|---|
| Correctness | Preserve settlement during unchanged observations; include staged/unstaged diffs and index stages in source identity. | The original 13 tests stayed green. The supplied three regressions failed before the fix and passed afterward; additional cases cover repeated collection, contrary evidence, and conflict-stage changes. |
| Coordination and recovery | One Git-common-dir lease for updated native/timer/companion entries; retained unknown ownership; exact diagnosis and host-evidence reconciliation. | Independent Claude/Codex/timer fixture processes compete for one lease. Tests cover linked worktrees, old release replay, live workers, unknown launches, and recovery after release I/O failure. |
| Records and context | NOT RUN assessment drafts, verified task-record export, stage-specific contracts, and one offline check entrypoint in CI. | Tests reject default-draft acceptance, overwrites, source-directory output, symlinked records, and mutation during export. Marker/state compatibility and standalone packaging remain checked. |

## Operational boundaries

- The lease coordinates updated participants sharing one Git common directory.
  Older installed entrypoints and separate clones are outside that protocol.
- Reconciliation requires an actual independent host/server observation, exact
  job/thread/turn identity, a current source snapshot, and complete process
  termination evidence. Schema validity cannot authenticate a remote receipt
  or prove the caller included every process. Reconciliation does not approve
  task results.
- Assessment templates never generate PASS. Exported records are not a source
  checkout and do not recheck live lifecycle. The final context bundle retains
  one `HANDOFF.md` and accounts for remaining source and runtime dependencies.
- Local validation uses fake companions/controllers and real disposable Git
  repositories/processes. Real Claude/Codex behavior, installed snapshots,
  systemd migration, and live PR writes require separate validation.

## Deferred cleanup policy

Ignored test/build artifacts can keep a worktree non-reclaimable. A future
policy may remove exact artifacts registered by that run and proven rebuildable.
Unknown ignored files remain preserved; broad cleanup cannot replace ownership
proof. Retained Git refs need a separate retention decision and are not deleted
automatically. Released controller receipts are likewise retained.

Run [the unified checks](../scripts/check-all.sh). Read the
[workflow navigation](../codex-skills/babysit-prs-codex/references/workflow.md),
[controller contract](../codex-skills/babysit-prs-codex/references/controller-coordination.md),
and [task recovery contract](../skills/codex-implementation/references/recovery.md)
for the action-specific rules.
