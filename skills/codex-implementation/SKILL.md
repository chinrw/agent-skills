---
name: codex-implementation
description: Orchestrate non-trivial implementation work where Claude plans and reviews while Codex writes the code. Use for features, bug fixes, refactors, substantial tests, behavior-changing configuration, build or CI changes, and security-sensitive implementation.
---

# Codex implementation workflow

Claude is the planner and final validator. Codex is the implementation writer.

## 1. Preflight

Before delegation, Claude must:

- read applicable repository instructions;
- inspect `git status --short`;
- identify pre-existing or unrelated worktree changes;
- explore enough of the repository to choose an implementation approach;
- resolve architecture, API, schema, dependency, compatibility, and security
  decisions before asking Codex to write code;
- capture the relevant failing-test or current-behavior baseline when practical.

Claude may use a read-only Explore subagent for noisy repository exploration,
but Claude must synthesize the findings and choose the plan.

## 2. Define acceptance

Write a small set of observable acceptance criteria before delegation.

Cover, as applicable:

- requested behavior and important edge cases;
- regression behavior that must remain unchanged;
- interface and compatibility constraints;
- required tests or manual verification;
- scope and explicitly excluded work.

Avoid vague criteria such as "works correctly" or "all tests pass."

For a bug fix, require a regression test that would fail for the previous
behavior when practical.

Use these final statuses for every required criterion and validation command:

- PASS: satisfied with concrete evidence;
- FAIL: attempted and failed;
- NOT RUN: not executed, with the reason;
- BLOCKED: could not be executed because of an external dependency or
  environment limitation.

## 3. Create a bounded handoff

Expected files are guidance, not a hard allowlist unless explicitly stated.
Codex may inspect any repository files needed for context and may modify
adjacent tests, fixtures, generated metadata, or supporting files when clearly
required by the approved plan. It must report every additional file.

Codex may make local tactical decisions consistent with the plan and existing
repository patterns.

Codex must stop and report rather than independently changing:

- architecture or component boundaries;
- public APIs or compatibility guarantees;
- database schemas or persistent formats;
- dependencies;
- security or permission models;
- destructive migration or rollback behavior;
- the agreed feature scope.

Use the Agent tool with:

`subagent_type: "codex:codex-rescue"`

For a new implementation slice, begin the delegation message with:

`--wait --fresh`

For review fixes or continuation of the same implementation, use:

`--wait --resume`

Do not use `Skill(codex:rescue)`.

Reasoning effort on this path accepts `none|minimal|low|medium|high|xhigh`
and rejects `max` outright — unlike babysit-prs there is no downgrade
normalization here, so a `--effort max` request fails instead of degrading.
Leave `--effort` unset for the configured default, or pass `--effort xhigh`
explicitly when the task warrants maximum reasoning.

Prefer bounded foreground implementation slices. Split a large implementation
into sequential, independently verifiable slices rather than sending one
open-ended request.

While a delegated task is active, Claude must not edit files that overlap the
delegated edit surface.

Use this handoff structure:

---
--wait --fresh

Implement the approved implementation slice below.

Goal:
<observable outcome>

Current behavior or root cause:
<relevant current behavior and diagnosis>

Chosen approach:
<implementation decision already made by Claude>

Expected edit surface:
<files, directories, symbols, or components likely to change>

Allowed adjacent changes:
<tests, fixtures, generated files, or supporting code that may also change>

Out of scope:
<explicit non-goals>

Required invariants:
<behavior and compatibility that must remain true>

Acceptance criteria:
<numbered, observable criteria>

Validation commands:
<exact focused commands and any broader checks>

Worktree state:
<pre-existing changes that must be preserved>

Decision boundary:
<decisions Codex may make locally and decisions that require stopping>

Implementation constraints:
- preserve unrelated and pre-existing changes;
- follow applicable AGENTS.md and repository conventions;
- avoid unrelated cleanup and opportunistic refactoring;
- do not commit, push, reset, restore, checkout, rebase, or amend;
- do not add dependencies unless explicitly approved.

Return contract:
- summarize the implementation;
- list every changed file;
- report each acceptance criterion as PASS, FAIL, NOT RUN, or BLOCKED;
- report exact validation commands and their results;
- identify deviations from the plan;
- identify assumptions, unresolved concerns, and remaining risks.
---

## 4. Review the implementation

After Codex returns, Claude must:

1. inspect `git status --short`;
2. inspect the complete diff, not only Codex's summary;
3. verify that unrelated or pre-existing changes were preserved;
4. compare the implementation against every acceptance criterion;
5. inspect whether tests meaningfully exercise the changed behavior;
6. check for scope expansion, design drift, regressions, and unnecessary
   complexity;
7. independently rerun the smallest decisive validation;
8. run broader validation proportional to the risk and scope.

Claude does not need to duplicate every expensive command Codex ran.
For ordinary changes, independently rerun the decisive focused tests and one
appropriate broader check. For concurrency, persistence, migrations,
authentication, security, build infrastructure, or widely shared APIs, run
the broader relevant suite when feasible.

Distinguish failures introduced by the change from failures that existed in
the baseline.

## 5. Correction loop

For non-trivial review findings, resume the same Codex task and provide:

- the exact finding;
- affected files or symbols;
- the expected correction;
- acceptance criteria that remain unmet;
- validation commands to rerun.

Do not silently reimplement substantial Codex work in Claude.

Use a fresh Codex task only for a new or materially changed implementation
plan. Use resume for corrections and continuation of the same approved plan.

## 6. Invocation failure handling

If Codex times out, returns an empty response, or reports only that a task was
started:

- do not assume no files were changed;
- inspect the current worktree;
- inspect the Codex job status or stored result when available;
- do not start another write-capable task while the previous task may still be
  active;
- recover completed changes before deciding whether to resume or start fresh.

## 7. Completion

Claude may report completion only after:

- the complete diff has been reviewed;
- all required acceptance criteria have a recorded status;
- decisive validation has been run independently;
- skipped or blocked checks are disclosed;
- remaining limitations and risks are disclosed.
