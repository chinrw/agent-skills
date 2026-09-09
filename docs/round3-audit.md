# Round-three lifecycle fixes

Baseline: `45f547e6dcf00f3e54ffd2b6f2a3c50598e4bc18`.
Input: `agent-skills-round3-review.zip`, SHA-256
`604b2a80946bae701537bb39aa172fde9f99bc377967178635665a6641ba5997`.
The five source/test Git blobs in the supplied verification record match this
baseline. Both package paths resolve to the same shared lock implementation.

## Changes and regression evidence

| Finding | Result |
|---|---|
| Ordinary acceptance omitted a recorded worker | Settlement, completion, and recovery now share one termination check. Missing known workers and listed live or unobservable PIDs reject acceptance. The actual validated list remains in the assessment and release receipt. |
| Release moved the lease but failed to write its receipt | Retry verifies the retained owner and completes that token's receipt. Complete bytes are published without replacing another releaser's receipt. A later owner's active lease is untouched. |
| Acceptance after pinned-plugin drift | Retain the existing contract: reconcile the terminated attempt, then use fresh continuation with its assignment and stable results. Direct acceptance still requires the pinned runtime. |

The two confirmed defects failed targeted assertions before the fixes. Existing
tests remained green. New cases cover missing/empty PID lists, exited workers,
retained PID evidence, failure before/after the lease rename, interrupted receipt
writes, completed receipt publication, wrong retained ownership, and concurrent
receipt publication while a later controller holds the lease.

Local `bash scripts/check-all.sh`: 280 tests passed. This includes 35 companion
tests and 14 shared-lock tests, up from 31 and 6. Tests use disposable repositories,
fake companions, and real local processes; they do not call models.

## Real host validation

Date: 2026-09-09. Node `v24.19.0`, Codex CLI `0.153.4`, companion `1.0.6`.
The host reported model `gpt-6-astra` and reasoning effort `low`. Each probe used
a new local Git repository without a remote, isolated companion state, and a
copy of the installed plugin verified against its original script bytes.
Only those copies were changed to exercise pinned-plugin drift.

Ordinary completion used job `task-mttx7d03-nntp7m`, thread
`01a08595-e5c6-7773-b568-4a3deb19225a`, turn
`01a08595-e888-7d41-a2be-3ec07ad94b16`. The helper refused an empty PID list after
the task finished. Exact server completion, observed process-tree exit, and a
separate Python byte assertion then allowed completion and lease release.

The final timely-cancellation probe used job `task-mttxi35j-zouyk1`, thread
`01a0859d-86f9-73f2-8645-7f6098bc951b`, turn
`01a0859d-8979-70f2-b176-0f346f067602`. After the server reported `interrupted`,
host command PID `1391124` was still alive and the lease remained held. The
output file had not been written. The controller then closed only this isolated
broker/app-server and verified that all 12 observed host PIDs had exited before
reconciliation and release.

Fresh continuation used job `task-mttxid1p-sx2flc`, a different thread
`01a0859d-b954-7a20-bb27-afe2eddc4867`, and turn
`01a0859d-bc1d-7950-9d88-3dc10129f597`. It retained the prior assignment, stable
source, and required criterion through `previous`, with attempt number 2.
The controller independently checked exact output bytes and all nine observed
host PIDs exited before marking the new attempt complete.

The first observers exposed two harness assumptions: sandbox PID `2` needed
mapping to its host PID, and an active companion stream rejected a concurrent
`thread/read` with `Shared Codex broker is busy.` The records retain those failed
observer runs. Their exact tasks were subsequently interrupted, reconciled, and
independently accepted in fresh threads; no old attempt was silently replaced.
Cancellation can preserve already-written source. It is not a rollback.

Recovery used independent `thread/read` evidence bound to the recorded
job/thread/turn, a diagnostic-bound source snapshot, and observed host process
exit. A controlled receipt I/O failure produced `settled: true` with
`leaseReleased: false`; replaying the same proof completed the release. This
fault was injected by the controller after real task termination, not generated
by a fake model response. Reconciliation kept `complete: false`.

No live PR, installed skill, or systemd deployment was changed. These are bounded
Codex companion/app-server probes, not a full Claude UI or native-timer deployment
test. Receipt publication does not establish power-loss durability. Unknown
ownership and unobservable processes remain blocked; retained receipts, refs,
and unknown ignored worktree files retain their existing cleanup policies.

Local evidence is retained under
`.archive/round3-validation-20260909/`: host observer scripts and failed-run logs,
RPC responses, PID inventories, assessments, recovery proofs, retained leases,
source fingerprints, red/green logs, and the final offline suite log. The input
ZIP is retained separately as
`.archive/agent-skills-round3-review-20260909-604b2a80.zip`.
