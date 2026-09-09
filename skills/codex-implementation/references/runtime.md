# Companion attempt contract

The controller supplies assignments and assessments. Children write source and
their own results; they do not modify this controller-owned attempt directory.
The helper is self-contained and uses Node and Git. Resolve
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

A workspace lock covers helper-managed attempts. The preflight also inspects
companion jobs across sessions. Neither protects against actors bypassing this
workflow; the controller must establish absence of other writers. Do not remove
a retained lock on age alone. An unknown launch may already have started work.

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
