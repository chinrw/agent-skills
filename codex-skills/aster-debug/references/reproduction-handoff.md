# Reproduction handoff for another model

The producer prepares this package; the receiving model runs the experiments.
The package must work without the original conversation or the producer's local
skill installation. Keep source observations, historical runs, hypotheses, and
planned results separate. Use this reference again when evidence returns.

## What the receiver needs

Use `HANDOFF.md` as the entrypoint, `model-prompt.md` as the ready-to-send task,
and a manifest of the packaged files and their SHA-256 hashes. Reuse existing
case files rather than copying the same explanation into several documents.

### Scope, contract, and prediction

- Selected finding identity, including Specula run, target, and finding ID.
- Symptom, expected syscall contract, relevant source anchors, and the causal
  hypothesis. Include conflicting evidence and unresolved premises.
- A concrete operation sequence: arguments, sizes, offsets, object state,
  thread roles, timing/fault prerequisites, and the predicted target failure.
- A correctness oracle covering the relevant return value, errno, data, buffer
  tail, cursor, or final object state. Distinguish target failure from setup
  failure, timeout, skip, and failure of another test.
- Allowed change scope and related paths already checked or still pending.
  Independent findings remain separate work items.

### Recoverable source and inputs

- Repository origin, checkout/branch, full base and tip OIDs, tree IDs, and
  captured dirty patches. Separate pre-existing changes from the proposed fix.
- Reproducer source, fixtures, expected data, regression source and registration,
  and all required headers/adapters. Record their hashes in the manifest.
- Separate test-only and fix patches, with their application order and resulting
  source identity. Both Asterinas variants must use the final tests; an old
  baseline suite without the new regression is not the before control.
- A recovery path for every source object. An unpushed OID or an absolute path
  on the producer's host is insufficient for another host: include the needed
  patch or local Git bundle, or name the exact missing prerequisite.
- Bundle-relative links and a short host/container path map. Copy required
  runner/protocol resources when they are unavailable to the receiver. Resolve
  dependencies from current source; do not assume an old scratch branch exists.

Keep each case's output outside the source/report input being collected. Large
images and caches can remain external if the package states how to obtain or
rebuild them and what identity to verify. Avoid copying unrelated user changes
or secrets into a transferable bundle.

### Environment and commands

Write the actual commands or task-owned scripts with their working directory,
required environment variables, preparation order, and expected artifacts.
Inspect current build/runner definitions before writing them. Mark generated
commands as `NOT_RUN`; syntax review is not execution evidence.

Record or require the receiving model to discover:

- Architecture, image tag and digest, compiler/toolchain, OSDK build settings,
  kernel/initramfs inputs, and the exact regression selector.
- Guest mounts and filesystem type, I/O mode, alignment, permissions, CPU count,
  and any observed competing-role placement needed by the oracle.
- Linux kernel version/build and matching filesystem/ABI. A container image
  identifies userspace, not the host kernel.
- Output paths, finite attempt/round/timeout budgets, stop conditions, and
  task-owned cleanup. Each attempt gets a new directory and retains failures.

Use [runtime guidance](project-runtime.md) for build and guest pitfalls.
Limit cleanup to resources created for the case. Expose host devices individually
where possible; a host `/dev` mount must be read-only. A denied or unavailable
resource is a reported prerequisite gap, not a reason to broaden privileges.

If a command cannot be resolved from available files, state what the receiver
must inspect before constructing it. Keep such drafts out of an executable plan;
never replace unknown paths, hashes, or measured values with plausible samples.

### Planned comparison and controls

For syscall-visible defects, prepare the plan/adapters using
[the matrix protocol](matrix-protocol.md). Keep expected outcomes in the plan
separate from observed outcomes, which start as `NOT_RUN`:

| Artifact | Asterinas before fix | Asterinas after fix | Matching Linux |
|---|---|---|---|
| Reproducer | Target failure expected | Pass expected | Pass expected |
| Final regression | Target failure expected | Pass expected | Pass expected |

Both Asterinas variants use identical test binaries. Linux retains the same
source and oracle; record any necessary build differences. Include relevant
neighboring suites and unaffected controls as separate checks, not artificial
baseline failures. A supplementary guard against a bad simplification uses a
named mutation when the original baseline cannot expose it.

If interacting fixes could mask each other, specify the focused mutations and
case-specific signatures needed to distinguish them. For a race, state how the
receiver will observe that the required roles actually ran, and when to stop
and report an untriggered baseline. More rounds alone do not establish coverage.

If no fix is supported yet, send the before/Linux experiment and the decision
it must resolve; leave after-fix validation pending. For a kernel-internal case,
use the actual kernel/device test seam and explain why Linux is not applicable.
An unavailable Linux environment remains a gap rather than `NOT_APPLICABLE`.
The supplied syscall runner requires all three targets; do not invent missing
cells merely to make its plan executable.

## Ready-to-send task

Write `model-prompt.md` as a complete task addressed to the receiving model:

- Identify the case, `HANDOFF.md`, manifest, and source-recovery instructions.
- Ask it to verify identities and prerequisites, execute the declared experiment
  within the stated budget, and preserve every attempt and target diagnostic.
- Request investigation of oracle/setup mismatches before changing assertions.
  If it changes the test or adapters, require a diff, new hashes, and repeat of
  the affected comparisons with identical inputs.
- Define the permitted repair scope. A reproduction-only assignment asks for
  evidence and recommendations; it does not authorize production edits.
- Specify the return package below and the conditions for an inconclusive or
  environment-error result. State any remaining execution permission needs.

Give actual case-specific steps and success/failure criteria. A prompt saying
only “reproduce this bug” or linking the original conversation is insufficient.
Producing this prompt does not send it or start another agent.

## Required return package

Ask the receiver to return:

- Exact commands, environment observations, source/patch/input hashes, build
  logs, and kernel/initramfs/test-binary identities tied to the launch commands.
- Per-attempt raw logs, original exits, prerequisites and activity observations,
  assertion/skip counts, and the selected case's exact diagnostic.
- Matrix or equivalent structured reports with the actual before/after/Linux
  outcomes. Keep setup errors, timeouts, cleanup errors, and target failures
  distinct; preserve failed attempts even after a later pass.
- Any source/test/adapter changes, their reason and hashes, and the affected
  reruns. Include the status of neighboring checks and cleanup.
- A concise result: reproduced, not observed within budget, contradicted by
  evidence, or blocked by an identified prerequisite. Include remaining gaps.

A headline PASS or another model's assurance is insufficient without the raw
observations and identity mapping. Specula reproduction PASS can mean the bug
was observed; the correctness oracle must mark that behavior as FAIL.

## Handoff readiness and evidence return

Before delivery, review the commands without executing the scenario. Check
relative links, file hashes, patch application order, and recovery instructions.
Mark each runtime cell `NOT_RUN` unless it cites attributable existing evidence.
Report unresolved prerequisites; they limit readiness, not the bug's severity.

The producer can finish after delivering this package and any supported code
changes. Use `FIX_PENDING_VALIDATION` for an unverified patch, or state that the
fix decision awaits the experiment. Keep handoff delivery separate from repair
status and from Specula's imported disposition.

On return, match the executed source, test bundle, oracle, and actual environment
to the handoff. Read raw diagnostics and inspect any receiver changes before
using the result. Apply the acceptance rules in the matrix protocol: skipped or
zero-assertion tests, untriggered baselines, stale outputs, and unrelated failures
cannot verify a fix. A changed production/test input invalidates affected cells.

Mark `FIX_VERIFIED` only when the relevant runtime comparisons and other required
checks are supported for the final inputs. Otherwise retain the pending status
and issue a focused follow-up handoff for the missing evidence.
