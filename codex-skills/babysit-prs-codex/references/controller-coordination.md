# Repository controller ownership

Every updated write controller uses the same lease under the canonical Git
common directory. Linked worktrees share it. Separate clones and workflows
bypassing these entrypoints are outside this local coordination protocol.
There is no TTL-based takeover. An incomplete owner record is an unknown owner.

Acquire before creating/editing worktrees, running local writes, or publishing
to GitHub. Hold ownership through child tasks, validation, commits, and merges.
Children use the controller's ownership; they do not start new controllers.
Internal independent-child parallelism and per-worktree writer limits remain.
`--snapshot-only` observes without acquiring a write lease.

## Manual Codex and Claude entrypoints

Write an owner request in the run directory using the current runtime and run
ID. Include the actual session ID if exposed, otherwise use `unknown`:

```json
{"runtime":"codex","runId":"current-run-id","sessionId":"current-session-id","recordPath":"absolute run directory"}
```

```bash
node "$BABYSIT_SKILL_DIR/scripts/controller-lock.mjs" acquire "$CHECKOUT" "$OWNER_JSON"
```

Use `runtime: "claude"` in Claude Code. Save the returned owner identity and
token in the controller's run record. Exit 75 means another or unknown owner:
report its runtime/run/session and wait or end this invocation without writes.
Never delete its files or infer ownership from age, PID absence, or quiet logs.

## Timer adoption

The runner obtains the same lease before starting Codex. It supplies
`BABYSIT_CONTROLLER_TOKEN`, `BABYSIT_CONTROLLER_RUN`, `BABYSIT_RUN_ID`, and
`CANONICAL_RUN_DIR`. Reuse that run identity and create its record directory
once; the owner record points there for recovery. Adopt that exact owner:

```bash
node "$BABYSIT_SKILL_DIR/scripts/controller-lock.mjs" adopt "$CHECKOUT" "$BABYSIT_CONTROLLER_TOKEN"
```

Validate the returned run ID against the supplied run before writing. An invalid
token blocks this invocation; do not acquire a second lease as a fallback.
The timer does not release ownership merely because the model process exits.
On timeout, cancellation, or an unobservable child, retain the lease and report
the evidence needed for controlled recovery. OS failure before spawning any
controller is the runner's sole automatic-release case.

## Release and recovery

After observing every child and its processes terminate, prepare a
controller-owned proof with exact lease identity:

```json
{
  "token":"returned token",
  "commonDir":"returned canonical Git common directory",
  "runId":"returned run ID",
  "observedAt":"UTC timestamp of the terminal observation",
  "allTasksStopped":true,
  "processesStopped":true,
  "processIds":[],
  "evidence":"Actual native lifecycle receipts and process collection evidence"
}
```

`processIds` includes known task subprocess PIDs, excluding the controller that
is performing its final release. An empty list is justified only when the host
has established there are no such processes. The helper rejects listed live or
unobservable PIDs; the controller must verify that the list is complete.

```bash
node "$BABYSIT_SKILL_DIR/scripts/controller-lock.mjs" release "$CHECKOUT" "$PROOF_JSON"
```

Release moves the owned lease into a durable receipt directory. Replaying an
old release cannot remove a new owner's lock. Keep receipts; retention is a
separate policy. Controller statements must reflect actual host observations:
valid JSON or a task-authored summary does not prove quiescence.

For a stopped controller, `status CHECKOUT` exposes its exact owner. A recovery
controller may supply fresh host termination evidence for that owner and use
the same guarded release. Incomplete/unknown owners require investigation of
the interrupted acquisition; they cannot be automatically reclaimed.

The companion workflow uses the same lease and has task-specific
`diagnose`/`reconcile` operations for job/thread/turn and source-bound recovery.
Older companion attempt locks also block new acquisition. Stop and migrate old
installed entrypoints before claiming all writers participate in this protocol.
