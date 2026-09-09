# Companion attempt contract

The controller supplies assignments and assessments. Children write source and
their own results; they do not modify this controller-owned attempt directory.
The helper uses Node and Git. Its repository-lock module shares the native
package's implementation through a source symlink. Materialize links when
copying this skill to a standalone location, for example `cp -RL` into a fresh
destination. Resolve
`CODEX_IMPLEMENTATION_SKILL_DIR` from the loaded skill, independently of cwd.

## Launch and identity

`task.mjs launch ASSIGNMENT_JSON NEW_ATTEMPT_DIR` accepts the assignment in
SKILL.md. Each `criteria` entry is a required ID described in the prompt.
Optional `model`/`effort` values are explicit requests, not effective settings.
Optional `previous` is the absolute path of a settled attempt in the same
workspace at the same source snapshot.
Continuations retain the approved mode and required criterion IDs. The default
budget is three attempts including the first; `maxAttempts` changes that budget
only when the user explicitly authorizes an extension.

Resolve the active plugin once from Claude's loaded plugin metadata. The local
installed registry may help locate it but does not establish active selection.
Pass its actual `scripts/codex-companion.mjs` path; never scan for a maximum
cache version. A changed/missing pinned script tree blocks subsequent calls
instead of routing an old job through a different plugin.

The helper records:

- `assignment.json`: immutable attempt ID, canonical cwd and Git root, baseline
  HEAD/status/diff and untracked-file hashes, plugin path/version/script hash,
  Node path, companion session ID, required criteria, and requested settings.
- `baseline.patch`: pre-existing tracked changes, including binary changes.
  Untracked entries are identified and hashed, not backed up by this helper.
- `prompt.md`: the exact task text sent to the companion.
- `state.json`: last observed lifecycle, exact job/thread identity, collected
  source snapshot, and settled/completion state.
- `launch.json`, `status.json`, `result.json`, `cancel.json`: saved responses
  when those operations return usable JSON.
- `assessment.json`: the controller's source-bound lifecycle/acceptance proof.

The wrapper uses the same recorded Node, companion, `--cwd`, session, and full
job ID for later operations. Both process cwd and companion cwd are pinned.
The companion runs tasks at the Git root, even when its cwd is a subdirectory.
Assignments must account for that actual writable root; paths in a prompt do
not expand sandbox permissions or prevent access to adjacent files.

Source identity includes separate staged/unstaged diffs and semantic index
entries, including conflict stages. Index cache-byte changes alone are not
source changes. Older snapshots without these fields require new evidence.
Unchanged status/result queries preserve settlement and acceptance. Contrary
lifecycle, source, or collected-result evidence clears current acceptance and
retains the old settlement under `priorSettlement` for reconciliation.

A Git-common-dir controller lease covers updated native, timer, and companion
entrypoints. The preflight also inspects
companion jobs across sessions. Neither protects against actors bypassing this
workflow; the controller must establish absence of other writers. Do not remove
a retained lock on age alone. An unknown launch may already have started work.
The helper's attempt ID is included in the dispatched prompt and its hash is
recorded, so an unknown launch can be matched to exact request evidence.

## Runtime capabilities

The locally inspected plugin version is `1.0.6`. Its implementation provides
`task --background --fresh --prompt-file`, `status`, `result`, and `cancel`,
with `--cwd` and `--json` on those commands. The helper's tests use that response
shape; an incompatible future shape is an error, not silent acceptance.

This version advertises `none|minimal|low|medium|high|xhigh` effort values.
The helper reads the actual launcher's help before forwarding an explicit effort;
it does not hardcode this list or downgrade an unsupported request. Backend
model support is separate: a launcher-accepted value can still fail the task.
Requested model/effort remain distinct from effective settings. Version 1.0.6's
task result does not expose effective model/effort, so the record uses null.
If the host provides reliable runtime observations, record them with provenance
in the controller assessment. If the user's acceptance requires a particular
backend, unknown settings cannot satisfy that criterion.

The rescue forwarding agent maps resume to workspace/session-latest selection,
and its background worker selects the target later. A matching
`task-resume-candidate` observation cannot close that race. This workflow uses
fresh continuation after settlement instead of either resume flag. The full
previous assignment, findings, stable changes, and verification gaps must be
included in the new prompt; the helper does not invent the continuation context.

## Collect, settle, and complete

`status ATTEMPT` observes the exact job. `result ATTEMPT` refuses active jobs,
checks the stored result's identity and terminal status, and records the complete
source snapshot before and after collection. Neither command approves the work.

`cancel ATTEMPT` records a request, then requires fresh lifecycle observations.
The inspected plugin marks a job cancelled even if its interrupt request fails.
A cancelled marker or launcher exception therefore does not establish a terminal
server turn. The helper retains the lock in those cases. Preserve the record,
inspect the actual server turn and processes, and report unresolved termination;
do not start another writer or infer safety from a quiet log.
Use the controlled recovery operations below when an independent host interface
can establish the missing terminal facts.

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

Successful reconciliation preserves the old state and proof, settles the stable
source, and releases the exact lease. It sets `complete: false`; independent
acceptance remains a separate action. Fresh continuation can then use `previous`.
`leaseReleased` is separate from settlement. If release I/O fails, retain the
proof and retry the same recovery; a recorded settlement cannot bypass a held
repository lease.
Older companion bookkeeping cannot overwrite newer host-derived settlement;
new contradictory lifecycle or source evidence requires reconciliation again.

After collecting a terminal result, prepare an assessment outside the worktree:

```json
{
  "attemptId": "Exact attemptId from assignment.json",
  "jobId": "Exact jobId from state.json",
  "threadId": "Exact threadId from state.json",
  "snapshot": "Copy the complete snapshot object from state.json before review",
  "processesStopped": true,
  "lifecycleEvidence": "Actual observed task completion and process cleanup evidence",
  "criteria": [
    {"id": "behavior", "status": "PASS", "evidence": "Observed behavior/check result"},
    {"id": "regression", "status": "PASS", "evidence": "Focused regression result"}
  ],
  "independentCheck": {"status": "PASS", "evidence": "Controller's decisive independent check"}
}
```

Replace the snapshot placeholder with the actual JSON object. Produce evidence
after inspecting the full diff and running the checks; copying a previous PASS
or filling a template without observation is not verification. Record any
optional NOT RUN/BLOCKED check and its reason alongside these required checks.

- `settle ATTEMPT ASSESSMENT_JSON` verifies current terminal/source identity and
  the controller's process-termination evidence, then releases this attempt's
  workspace lock. It does not require all criteria to pass or declare completion.
  Use it before a correction in a new thread.
- `complete ATTEMPT ASSESSMENT_JSON` additionally requires a successful task,
  exactly one evidence-backed PASS for each assigned criterion, and independent
  verification PASS. It rereads the exact result and rejects source drift.

The helper validates records and bindings; it cannot independently establish
the truth of controller-supplied lifecycle or test evidence. Inspect real task
and process state before making those assertions. An ordinary `failed` job
without a returned terminal turn result remains unknown for writer release.

## Errors and recovery

Every CLI result is JSON: `{ "ok": true, "result": ... }` or
`{ "ok": false, "error": { "code": "TASK_CONTRACT_ERROR", "message": ... } }`.
Failures exit nonzero. An ambiguous launch keeps its attempt and lock; inspect
the pinned runtime's job records for that cwd/session and launch interval.
Do not relaunch, replace the record's job ID, or choose a latest thread to
make the error disappear. Preserve material for a human or an exact native
recovery interface when the available runtime cannot establish termination.

Validation is offline against fake companion responses and real disposable Git
repositories. It does not establish live model, provider, or Claude behavior.
