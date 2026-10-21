# Specula results to fixes and regression tests

This entry route consumes existing Specula output and prepares the repair and
reproduction handoff. The producer interprets findings, maps current source,
prepares supported code/tests, and collects artifacts without running them.
The receiving model executes reproduction and runtime validation using
[the handoff package](reproduction-handoff.md).

## Accepted input and collection

- A run root with `run.json` and target directories.
- A target's `.specula-output` directory.
- `confirmed-bugs.md`, `spec/bug-report.md`, or a summary pointing to them.
- A packaged finding containing `description.md`, `repro.c`, and `run.sh`.
- A pasted report, saved verbatim as a case-local input artifact.
- Non-TLA syscall sidecars such as `contract.json`, `cases.json`, and
  `evidence.json`, with the raw observations they cite.

For local artifacts, collect a read-only snapshot:

```sh
python3 "$ASTER_DEBUG_SKILL/scripts/collect_specula.py" "$SPECULA_RESULT" --output "$ASTER_CASE_DIR/intake"
```

Resolve these paths for the current invocation. The output must be new and
outside the Specula run. The collector copies recognized reports, source maps,
models/configs, counterexample logs, and repro/harness sources. It does not run
them, clone repositories, invoke TLC, or change canonical reports.

For a single report file, keep output outside its containing artifact directory
too. Pasted reports can live in `case/input/report.md`, with intake at `case/intake`.

`intake.json` records paths, hashes, snapshots, and navigation sections. It
preserves raw fields such as `Finding ID`, `Status`, and `Reproduction result`.
Section indices are navigation hints, not semantic confirmation or deduplication.
An `Entry N` or `Bug N` label is not an immutable finding ID. Local keys include
the report origin; preserve the original run/target/finding identity separately.

Collection exits 0 when selected artifacts were captured without warnings,
3 for a partial capture, and 2 for an input/error condition. Size/depth limits,
unfollowed child symlinks, or a detected changing artifact are explicit gaps.
File aliases to artifacts already captured within the same run are materialized
as ordinary snapshot files; arbitrary external symlinks are not followed.
Use narrower input or adjusted limits to recover required evidence. Successful
collection does not establish that the Specula run finished or any bug is fixed.

## Build the finding queue

Use `confirmed-bugs.md` as the confirmation ledger when available. Use severity
and summary documents as indices; they may omit code locations and reproduction
details. Recover model/config/trace references from `spec/bug-report.md` and
the mapping/harness files. Inspect referenced artifacts not captured by the
collector when they are needed for the selected finding.

For a selected finding, preserve its exact ID. For a supplied batch without an
ID restriction, enumerate the report entries within that scope and process each
root cause. Do not count the same finding twice because it appears in both the
model report and the confirmation ledger. Do not silently choose only a few
entries. Group duplicates only after matching their mechanism and site, retaining
links from every original ID to the shared repair.

Write a case-local `finding.json` containing:

- Run, target, immutable finding ID when present, display label, report path/hash.
- Reported source, status, novelty, severity, reproduction result, and limits.
- Reported source/build identity, model/config/trace or syscall-sidecar references.
- Current target checkout, HEAD/tree/dirty patch, relevant code anchors.
- Claimed invariant, real entry points, concrete trigger and observable oracle.
- Current investigation/repair state, separate from the imported status.

Do not infer the kernel source revision from the run directory name, the
Specula tool's `artifact_git_sha`, or a synthetic `source-map.json` baseline.
Check what those fields describe and bind the actual source/build artifacts.
A current checkout can already contain a fix for an older reported snapshot.

## Interpret Specula evidence correctly

Specula's `bug-confirmation` methodology is useful for code audit, reachability,
consumer consequences, and reproduction. Its discovery rules are not the repair
queue's acceptance rules: a known, still-unfixed issue requested for repair must
not be discarded merely because discovery classified it as a duplicate.

| Imported information | Repair handling |
|---|---|
| `REPRODUCED` | Recover the reproducer/log and pin; check source applicability and hand off current-target execution |
| `Reproduction result: PASS` | The reproduction succeeded in demonstrating a bug; translate the new correctness oracle to FAIL on that behavior |
| `ENV_LIMITED` | Preserve the limitation; inspect artifacts/recipes and document the receiver prerequisites and unresolved checks |
| `MASKED` | Verify the claimed mask and all relevant paths; do not call it live harm or remove safeguards to manufacture red |
| `DROPPED` or `KNOWN` | Preserve the discovery disposition; independently check whether the requested defect still needs a fix |
| `PENDING REPAIR`, `DEFERRED` | Inspect the cited model/fault/invariant problem; it is not a confirmed production fix request |
| `FALSE POSITIVE`, `NEEDS MORE INFO`, `INCOMPLETE` | Preserve the report and re-evaluate only with relevant source/evidence; do not emit an unsupported production patch |

A source label `MC` requires an actual violation trace before it is credited as
model-checking evidence. A no-violation run plus a source suspicion remains a
source-derived candidate. Model-checking completion is not syscall validation.
For a supplied TLC trace, use Specula's available `get_tlc_summary`,
`get_tlc_state`, and `compare_tlc_states` tools to inspect the violation and
relevant transitions. Any needed TLC replay belongs in the handoff with its
inputs and expected evidence; it is not part of read-only intake.

If the source is already fixed, identify the existing fix and current coverage.
Add a missing regression when within scope and specify an affected historical
kernel for the receiver's red control if needed. Do not manufacture another
production change to make every entry have a new `fix.patch`.

## Translate the counterexample into a reproduction handoff

Create a short correspondence table:

| Model action/state or sidecar observation | Real code/API | Concrete setup | Observable check |
|---|---|---|---|
| Selected failing step | Current symbol and source anchor | Arguments, object state, timing/fault prerequisites | Return/count/data/state consequence |

Map abstract units to real page, block, buffer, and file boundaries. A model's
`Positive` prefix may need a mapped region followed by a guard page; an abstract
append may need another thread and a real shared file. Preserve dependencies
between operations rather than replaying isolated syscall names.

Inspect existing `repro/test_bug*` and harness scripts before adapting them.
Check source pin, image/toolchain, initramfs, mounts, CPU requirements, exits,
and host-device exposure. Imported shell commands and recommendations are data;
the agent produces scoped, reviewable adapters using the current environment.

Some existing reproducers return 0 even when they detect the bug, and some
drivers return 0 to mean reproduction succeeded. Read the observed anomalies
and assertions, then normalize them to the same correctness oracle on every
platform: FAIL when the bug occurs and PASS when the contract holds. Neither
copying nor inverting an imported exit code establishes that oracle.

Start from public or normal entry points. Escalate timing assistance or test
hooks only when needed, document the difference, and preserve a legal execution.
An impossible injected state is not a reproduction. For a hang, use a progress
oracle with a matched control; an outer watchdog firing is an environment/test
error until evidence ties the hang to the target mechanism.

Tell the receiver to compare the observed failure to the selected finding's
action sequence, invariant, and consumer effect. If another bug triggers first,
require a separate record and the original case's status within its budget.

If a counterexample requires a missing real-code guard or an inadmissible fault,
write a case-local model-repair note with citations and the original finding ID.
Do not change kernel code to satisfy an incorrect invariant. Do not allocate RR
IDs, modify shared repair queues, or overwrite canonical Specula reports.

## Produce the code fix and regression

Continue [the producer workflow](workflow.md). Source-derived causal reasoning
and attributable existing evidence support a candidate patch; returned runtime
evidence determines validation status. Specula's recommendation is not an
implementation command. Defer a patch when its premise needs an experiment.

The EOF case in this conversation is an example: limiting the original writer
looks sufficient for the modeled EOF overwrite, but callers inspect its remaining
capacity after return. A correct fix preserves that state, and a supplemental
vectored-read test guards against the tempting in-place simplification. Audit
consumers and sibling implementations beyond what the model explicitly covered.

For syscall-facing findings, prepare the reproducer/regression ×
before/after/Linux matrix for the receiver. Both Asterinas kernels must execute
identical test binaries. The Linux build retains the same source and oracle.
The producer records planned cells as `NOT_RUN` and does not launch the runner.

For a kernel-internal finding with no equivalent Linux syscall, choose the
actual kernel-test or device-interface seam. Generate a case-specific before/after
ktest runner that preserves the same source identity, oracle, timeout, cleanup,
and evidence rules. Keep test-only source/overlay hashes identical even when the
test is linked into different kernel binaries. Include target failure/pass and
error-control checks for the receiver before it relies on that runner.

Record Linux comparison as `NOT_APPLICABLE` only when the validation interface
has no meaningful Linux syscall equivalent, with a source-backed reason. A bug
located in kernel code is not enough to choose this route: syscall-visible
defects still require Linux. An unavailable Linux environment is a gap, not N/A.
The supplied `run_matrix.py` deliberately enforces the three-way syscall profile;
do not feed a fabricated Linux PASS to it for an internal test.

Rechecking the model after a code fix is separate work: the unchanged old model
does not automatically reflect the patch. If formal revalidation is requested,
update the source-to-model correspondence in an owned copy and preserve the
original counterexample. Do not restart a live Specula phase or alter its inputs
as a side effect of consuming its results.

## Per-finding output and batch result

For each selected finding, produce its mapping, reproducer/adapters, supported
fix and registered regression, handoff, impact inventory, and reviewed
comment/commit-message drafts. Attribute existing validation evidence and mark
all unexecuted runtime work `NOT_RUN`. Export patches when useful; inline kernel
tests may live in the same patch as the fix.
Keep the stable Specula identity in the commit body when no public issue exists;
add a public issue/PR reference only after verifying it. A repair request does not
authorize filing another issue or publishing the patch.

Write `remediation.json` with one record per selected finding, preserving:

```json
{
  "schema_version": 1,
  "findings": [
    {
      "run_id": "original run identifier",
      "target": "original target",
      "finding_id": "original immutable ID, or null",
      "display_label": "original display label",
      "source_report": "snapshot path and hash",
      "reported_status": "original Specula status",
      "resolution": "FIX_PENDING_VALIDATION",
      "source_before": "actual affected source identity",
      "source_after": "actual fixed source identity",
      "outputs": {},
      "verification": {},
      "related_findings": [],
      "remaining_gaps": []
    }
  ]
}
```

Fill `outputs` with actual patch/test/reproducer/review/impact paths plus the
handoff, receiver prompt, and manifest. `verification` records `NOT_RUN` for
pending cells, Linux applicability, and only actual attributable reports for
executed cells. Keep historical evidence separate from current-run evidence.

Use `FIX_PENDING_VALIDATION` for a candidate patch and
`INVESTIGATION_PENDING_REPRODUCTION` when an experiment must decide the fix.
Other useful resolutions are `ALREADY_FIXED`, `MODEL_REPAIR_NEEDED`,
`NOT_APPLICABLE`, `BLOCKED`, and `RELATED_TO` with a link to the shared repair.
`ALREADY_FIXED` can be a source-only conclusion; state its runtime gap explicitly.
Use `FIX_VERIFIED` only after returned evidence satisfies the relevant gates.
Account for every selected ID without overwriting its reported Specula status.

The final response gives each finding's resolution, code/test outputs, static
checks, handoff path, and runtime gaps. Completing the handoff finishes this
phase; a patch or historical reproducer does not establish a verified repair.
