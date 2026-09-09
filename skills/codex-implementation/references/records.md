# Export task records for handoff

```bash
node "$CODEX_IMPLEMENTATION_SKILL_DIR/scripts/task.mjs" \
  export-handoff "$ATTEMPT_DIR" "$NEW_RECORDS_DIR"
```

The new destination must be outside the source worktree and attempt directory,
with an existing parent. The helper copies known controller records, default
assessment drafts, diagnostics, recovery proofs, and stable result files. It
rejects symlinked records and existing destinations. Unselected extra files are
not exported; collect anything else needed for the handoff separately.

`manifest.json` is written only after source/destination byte and membership
checks pass. If records change during copying, the command fails and leaves a
partial directory without a manifest for diagnosis. Choose a fresh destination
for a retry; incomplete output is not a completed export.

The manifest declares `scope: task-records-only`, `sourceTreeIncluded: false`,
and `liveLifecycleChecked: false`. This operation does not call a model, query
the companion, release a lease, or establish current task completion. Records
can contain private prompt, diff, and result content; review them before sharing.

Give these records to the context-bundle collector. The final bundle's
`HANDOFF.md` remains the single navigation and decision entrypoint. Link the
exported records there instead of manually copying IDs and snapshots. Account
for needed source files, current host observations, authorization, and gaps
separately. Original paths in the records are provenance, not proof that another
host can safely resume or release the original task.
