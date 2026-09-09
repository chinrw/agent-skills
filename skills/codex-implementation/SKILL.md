---
name: codex-implementation
description: Delegate bounded investigation or implementation to Codex while Claude owns scope and independent acceptance. Use for non-trivial features, fixes, refactors, tests, configuration, or build changes that benefit from a separate Codex task.
---

# Codex implementation workflow

Claude owns the goal, authority, and independent acceptance. Codex investigates
or implements within that boundary. This skill uses the installed companion;
it is separate from the two native babysit entrypoints.

## 1. Establish the task

Read applicable repository instructions and inspect existing changes. Record
the actual target repository, canonical cwd, base commit, relevant current
behavior, and pre-existing changes before a writer starts.

Choose a bounded task:

- **Investigation:** read-only diagnosis, repository exploration, or comparison
  of implementation approaches. Let Codex gather facts before choosing a design.
- **Implementation:** state the approved behavior, constraints, compatibility,
  acceptance criteria, and allowed edit scope. Codex may choose local structure,
  algorithms, and tests, including necessary adjacent files within that scope.

Ask only for a material choice not already settled by the user: public contracts,
persistent formats, dependencies, permissions, destructive migration behavior,
or scope expansion. Continue independent authorized work while resolving it.
Split by independently verifiable behavior and conflicting writers, not file
count or a historical foreground timeout.

Define explicit required criterion IDs and their expected observable outcomes.
Record checks as PASS, FAIL, NOT RUN, or BLOCKED with evidence and the tested
revision. An unavailable optional check needs a reason; a required missing check
prevents completion.

## 2. Pin the runtime and assignment

Before dispatch, read [the runtime contract](references/runtime.md).
Resolve the companion from the active Claude plugin's path or runtime metadata.
An installed-plugin registry is a candidate location, not proof of which version
is loaded. Never choose the greatest cached version. If the active plugin cannot
be identified, block dispatch and continue independent preparation.

Use `scripts/task.mjs` from this loaded skill directory. It records one canonical
cwd/workspace, companion path/version/script hash, Node executable, session ID,
baseline, criteria, requested settings, and exact job/thread identity. Later
commands use that record even when the controller's cwd or plugin cache changes.

Use current configured model/effort unless the user chooses otherwise. Explicit
flags must be supported by both the launcher and selected model. The helper
checks the launcher's advertised effort values; backend validation still applies.
A launcher accepting a value does not prove the model accepts it. Keep requested
and effective settings separate. Unknown effective settings remain unknown;
never announce an Astra migration from a requested model or wrapper name alone.

Create a JSON assignment outside the source tree:

```json
{
  "cwd": "/absolute/target/repo",
  "companion": "/loaded/plugin/scripts/codex-companion.mjs",
  "mode": "write",
  "criteria": ["behavior", "regression"],
  "prompt": "Goal, current behavior, constraints, allowed edits, required criteria and tests. Preserve pre-existing changes. Leave changes uncommitted. Report every changed file and criterion with evidence."
}
```

Use `mode: "read"` for investigation. Add `model` and `effort` only for an
explicit choice; describe each criterion and test in the full prompt. Supply
relevant source paths and baseline details, not merely this example sentence.
The attempt directory must be new, outside the target source tree, with an
existing writable parent. Its contents may include private code and results.

```bash
node "$CODEX_IMPLEMENTATION_SKILL_DIR/scripts/task.mjs" \
  launch "$ASSIGNMENT_JSON" "$NEW_ATTEMPT_DIR"
```

The controller launches the companion directly. The rescue forwarding agent
cannot preserve this contract: its installed version omits cwd forwarding,
turns resume into resume-last, and may return empty output on wrapper errors.
Background launch avoids coupling task size to the host shell's foreground
limit. A queued receipt means execution started, not that work is done.

## 3. Observe and collect

Read [collection and assessment](references/assessment.md) before collecting
results or recording acceptance.

Use only the saved attempt path for `status`, `result`, and `cancel`:

```bash
node "$CODEX_IMPLEMENTATION_SKILL_DIR/scripts/task.mjs" status "$ATTEMPT_DIR"
node "$CODEX_IMPLEMENTATION_SKILL_DIR/scripts/task.mjs" result "$ATTEMPT_DIR"
```

The helper checks exact job/workspace/thread identity and collects a terminal
result with a source snapshot. Errors return structured JSON and a nonzero exit;
an unknown launch outcome keeps its record and workspace lock. Do not launch
another writer while the old task or its lifecycle is unknown.

A stored result file, quiet output, elapsed timeout, or cancellation request
cannot establish termination. Collect the task and any processes it started.
Verify the complete diff and preserve unrelated changes. The helper's lock
coordinates this workflow's attempts only; inspect other runtime tasks and
writers too. Neither a path assignment nor this lock adds sandbox permissions.
All updated native, timer, and companion entries share the repository lease.
For missing or contradictory lifecycle evidence, use `diagnose` and the
evidence-bound `reconcile` operation in [recovery](references/recovery.md). It can settle
proven termination without marking the work complete.

## 4. Review and correct

Claude reviews the complete diff against every required criterion and performs
independent decisive validation. Reuse complete evidence for unchanged code;
repeat or broaden tests after new changes, failures, or unresolved concerns.
Keep the relevant broader checks for concurrency, persistence, migrations,
authentication, security, and widely shared interfaces.

For a correction, confirm the old task and its processes have ended and collect
stable results first. Run `settle` with controller-owned lifecycle evidence as
described in the assessment contract. Start a fresh attempt with `previous` pointing
to the settled attempt; preserve the same authorized goal and include the old
assignment, stable results, exact findings, current diff, and remaining checks.
A fresh continuation is not an exact-thread resume and grants no new authority.

Do not use `--resume` or `--resume-last`. The current companion selects the
latest task inside a background worker, so even a matching preflight candidate
can change before dispatch. Exact-thread restoration needs a separately verified
host interface; never invent a companion `--resume-id` option.

Allow at most three implementation attempts for one approved slice, including
its first attempt. Stop earlier when the same unresolved finding recurs without
new evidence. Exhaustion means partial or blocked work; it never authorizes
acceptance. The user may explicitly extend this budget.

## 5. Complete or hand off

Generate the assessment draft with `assessment-template`; its defaults do not
approve anything. For a portable handoff, use [record export](references/records.md)
and let context-bundle collect source and current runtime state separately.

Use `complete` with the controller's assessment only when all required criteria
are PASS, independent verification is PASS, task/process termination is verified,
and the final source snapshot is unchanged. The helper checks these conditions
against the assigned criterion IDs. Evidence paths and statements must refer to
actual observed results; schema validity cannot establish their truth.

Report the actual changed files, acceptance and test results, requested versus
observed runtime settings, deviations, and remaining risks. Required FAIL,
BLOCKED, or NOT RUN means incomplete work. Optional checks may be skipped with
reasons. Do not commit or publish unless the user authorized it.

If work cannot finish, preserve the attempt directory, stable source changes,
job/thread/cwd identity, last observation, and exact recovery blocker. Do not
reset the workspace or delete the attempt to make a stuck task look finished.
