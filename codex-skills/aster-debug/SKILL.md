---
name: aster-debug
description: Analyze Specula results or Asterinas bug reports, prepare fixes and regression tests, and hand off reproduction to another model. Map findings to current code, audit related paths, and package the source, trigger, oracle, and before/after/Linux validation instructions. Also handle narrower classification or evidence-only requests.
---

# Asterinas analysis, fix, and reproduction handoff

For a full fix request, analyze the mechanism, prepare a supported fix and
registered regression, and deliver a self-contained reproduction handoff.
The receiving model executes the reproducer and runtime validation. A narrower
explanation, classification, or evidence request stays within that scope.

## Execution boundary

This skill's default deliverable is the code and handoff, with runtime evidence
pending. Do not execute reproducers, regression programs, the runtime matrix,
or automatically dispatch another agent to run them. Formatting, static review,
and compile-only checks are allowed when they do not launch the scenario.
A build target that also boots a guest or runs tests belongs in the handoff.

Existing logs may be inspected and attributed to their exact inputs. Planned
results remain `NOT_RUN`; source-supported patches remain
`FIX_PENDING_VALIDATION` until matching execution evidence is returned and
reviewed. A full-fix request or a Specula `REPRODUCED` label does not override
this boundary. An explicit user request to execute tests changes that scope.

Read [the workflow](references/workflow.md) for analysis and implementation.
Read [the handoff requirements](references/reproduction-handoff.md) when
packaging work for the receiving model or reviewing its returned evidence.

## Start from Specula results

A run/result directory, `confirmed-bugs.md`, `spec/bug-report.md`, packaged
finding, or pasted report is a supported input. Unless restricted, invoking
this skill with a Specula path requests analysis, supported code/test changes,
and the handoff for all selected Asterinas findings.

Read [Specula intake and remediation](references/specula-remediation.md).
Use `scripts/collect_specula.py` to snapshot local artifacts into a separate
case directory. It collects evidence without executing imported scripts.
Preserve run/target/finding identities and reported statuses. Map the claimed
counterexample to current entry points before deciding whether a patch is
supported. Model repairs, already-fixed code, and live source candidates need
different dispositions.

## Prepare the change

- Pin checkout, HEAD, tree, base, dirty patch, and target files. Preserve the
  user's work and recheck identity when another task may have changed it.
- State the syscall contract, trigger, expected result, and observable failure.
  Trace caller-visible return values, buffers, cursors, and error behavior.
- Prepare or adapt the reproducer, fixture, and regression source without
  executing them. Read [runtime guidance](references/project-runtime.md) for
  test design and the receiving model's environment instructions.
- Apply the smallest fix supported by source and available evidence. If a
  disputed premise requires an experiment, hand off that question; leave the
  production change undecided rather than inventing a confirmed mechanism.
- Register the regression and freeze its inputs. Keep the test-only baseline
  overlay separate from the fix so the receiver can compare the same test on
  unfixed and fixed kernels.
- Audit callers, sibling implementations, alternate modes, and relevant
  boundary/error paths. Record evidence and disposition; keep independent bugs
  separate from a narrow PR.

## Review and deliver

Check code, naming, comments, formatting, and commit-message drafts against
current project guidelines. Use the project's `aster-code-review` when available;
otherwise record the direct review scope. Runtime neighboring-suite checks go
in the handoff. Review and compilation do not establish a runtime pass.

Deliver `HANDOFF.md` and a ready-to-send `model-prompt.md` with the input bundle,
source identities, exact steps, target oracle, bounded attempts, cleanup, and
required return artifacts. Resolve commands and paths where inspectable; list
missing inputs as concrete receiver prerequisites. Link the
[matrix protocol](references/matrix-protocol.md) and include the runner and
needed references when the receiving model cannot access this skill directory.
The producer prepares the matrix; the receiver runs it.

Report which files and static checks are complete, which runtime cells are
`NOT_RUN`, and where the handoff lives. For Specula, also produce
`remediation.json` linking each selected finding to its disposition and outputs.
Handoff completion is a valid stopping point; it is not a verified fix.

When execution results return, review their source/artifact identity, actual
assertions, and gaps before updating validation status. Further runs go back
into the handoff unless the user explicitly requests local execution.

Draft commit messages as part of a full fix. Commit, rewrite history, publish,
or send the handoff externally only within the user's authorization.

[The conversation summary](references/conversation-summary.md) and
[Claude session lessons](references/claude-session-lessons.md) preserve the EOF,
iovec, lock-lifetime, race-placement, and build-identity lessons. Historical
commands and results are background for the handoff, not current-run proof.
