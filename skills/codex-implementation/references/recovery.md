## Controlled diagnosis and recovery

`diagnose ATTEMPT` writes an immutable diagnostic with its hash, saved identity,
current semantic source snapshot, repository owner, and latest pinned-runtime
observation or error. It does not change settlement or release ownership and
remains available when the pinned plugin is missing or changed.

`reconcile ATTEMPT PROOF_JSON` accepts a controller-supplied proof containing:

- `diagnosticFile`, `diagnosticHash`, `attemptId`, and the exact diagnostic
  `snapshot`; source and assignment bytes must still match.
- `jobId`, `threadId`, and `turnId`, matching every identity already known.
- `source.kind` (`app-server` or `native-lifecycle`) and `source.reference`
  identifying the actual independent host observation.
- `observedAt`, at or after the diagnostic, and `serverTurn` with exact `id`,
  `threadId`, and terminal `status` (`completed`, `failed`, or `interrupted`).
- `allTasksStopped`, `processesStopped`, `processIds`, and `lifecycleEvidence`.
  Every known worker PID must be included. Live or unobservable PIDs reject it.
- For an unknown launch: `launchPromptHash` and canonical `requestCwd`, verified
  against the actual runtime request, including the unique attempt marker.

Fetch this evidence from the host independently of the task's own claims. The
helper checks its bindings and local process liveness; it cannot authenticate
the truth of a caller-supplied remote receipt or prove that a PID list is complete.
Unknown server state, incomplete process inventory, stale source, and guessed
task identity keep the lease. A result file or cancellation marker is insufficient.
Companion 1.0.6's broker can reject concurrent reads during an active turn while
still accepting its interrupt request. After interruption, retry the exact turn
observation; a busy response leaves lifecycle unknown. Check host process exit
separately because an interrupted turn does not prove all commands have stopped.

Successful reconciliation preserves the old state and proof, settles the stable
source, and releases the exact lease. It sets `complete: false`; independent
acceptance remains a separate action. Fresh continuation can then use `previous`.
Direct acceptance of the old attempt still needs its pinned companion. If that
runtime changed or vanished, use fresh continuation with the original assignment,
stable changes, and remaining checks; reconciliation does not bypass runtime
pinning to mark the old attempt complete.
`leaseReleased` is separate from settlement. If release I/O fails, retain the
proof and retry the same recovery; a recorded settlement cannot bypass a held
repository lease. This also covers failure after the lease directory moved:
retry repairs the matching retained receipt without touching a later owner.
Older companion bookkeeping cannot overwrite newer host-derived settlement;
new contradictory lifecycle or source evidence requires reconciliation again.
