# From a suspected bug to a fix and reproduction handoff

The producer analyzes source, prepares supported fixes and tests, and packages
runtime work for another model. It does not execute reproduction or the runtime
matrix. The receiver instructions and evidence-return requirements live in
[reproduction-handoff.md](reproduction-handoff.md).
Use narrower portions when the user requests only explanation or classification.

## 1. Make the hypothesis testable

Capture the source identity and write a short case record containing:

- Public syscall or operation, arguments, object type, and relevant environment.
- Expected return value, errno, data, ordering, or state, grounded in the Linux
  contract and a concrete input. Record the Linux version when behavior varies.
- Suspected mechanism and a falsifiable prediction that distinguishes it from
  an alternative explanation.
- Allowed fix scope and callers or sibling implementations that may share the
  invariant.

Read enough implementation to construct the experiment. Caller-state analysis
may be necessary before a useful reproducer exists. Separate source-supported
reasoning from a claim that the scenario has run. Runtime validation remains
pending until attributable execution evidence is returned.

Completion: an observable failure condition and a runnable experiment design.

## 2. Prepare the reproducer without executing it

Create a task-owned case directory with the program, fixture description, and
launch/build adapters. Use stable public interfaces and independent expected
values. Include the operations and interleaving needed to reach the actual bug.

Choose an API that exposes the violated property. A wrapper returning a newly
allocated byte string can hide writes past the reported count; a caller-owned
sentinel buffer exposes them. Keep the reproducer runnable in the target guest
without changing its filesystem or userspace merely to support another language.

Make the fixture enter the failing branch. An already-large file bypasses an
extension race. For a post-write size/data oracle, finish both competing writes
before the checker reads; equal size snapshots around a concurrent read do not
exclude a shrink-and-regrow cycle. Separate writer defects from reader defects
that the observation itself could trigger.

The scripts select a target snapshot, build the program, prepare the required
fixture, run with a timeout, preserve logs and artifact identities, and clean up
task-owned resources. Reuse the project's build and boot tools instead of
reconstructing OSDK or a general VM manager.

For a race, synchronize startup and record progress. If CPU placement matters,
specify how the receiver will establish it with the current scheduler/affinity
behavior. Choose a bounded number of attempts and require all results.

Review the program and adapters statically. Ask the receiver to run the affected
Asterinas version first and distinguish target failure from invalid setup. Any
minimization must preserve the dimensions that make the failure observable.

Completion: source, fixture, oracle, and execution instructions are packaged;
current-run reproduction is `NOT_RUN` unless attributable evidence was supplied.

## 3. Specify the Linux reference for the receiver

The handoff requests the same program or source and oracle on Linux with the
same syscall, argument shape, fixture, filesystem, and I/O mode where they
matter. Prefer one portable static binary when architecture and ABI permit it.
The following runtime requirements belong to the receiving model's plan.

Use a disposable Linux VM or an isolated container/namespace for tests that
alter mounts or devices. A container shares its host's Linux kernel; its
userspace image tag does not identify the kernel. Record `uname`, actual mount
type, available/effective CPUs, and the kernel artifact identity.

Inspect the current `REGRESSION_TEST_PLATFORM` and `TEST_PLATFORM` build
variables. Linux builds omit `__asterinas__`; changing a platform macro must not
remove the target assertion or skip the scenario. Record compiler flags and
binary hashes when the binaries differ.

If libc may select another syscall, fallback, or vDSO path, inspect the wrapper
or use a separate tracing run to confirm dispatch. Record tracing separately
from timing-sensitive race comparisons.

If Linux fails, investigate the oracle, setup, documented behavior, and kernel
version. Do not silently bless Linux output, relax the predicate, or replace a
filesystem-specific comparison with an unrelated filesystem. A tmpfs reference
can establish generic syscall behavior, but is not an ext2 comparison.

Completion: the handoff identifies the Linux setup, commands, expected oracle,
and observations to return. An unavailable matching setup remains an explicit
comparison gap; the producer does not run Linux to fill it.

Error returns do not imply zero side effects. Establish partial-fault and file
growth expectations on the relevant Linux filesystem; tmpfs observations alone
do not define disk-filesystem rollback semantics.

## 4. Implement the focused fix

Change the mechanism supported by source analysis and any attributable existing
evidence, following the relevant project guidance. Keep an untested patch marked
`FIX_PENDING_VALIDATION`. If an unresolved runtime premise determines the fix,
record the decision experiment and defer that production change.

Inspect return values and mutable arguments together. For locking, identify
the protected object, competing mutation, guard lifetime, and existing order.
For I/O, separate requested length, logical EOF, cache capacity, copied length,
and remaining writer capacity. Check relevant error and partial-progress paths.

Follow the same named guard from the size read through the copy. In Rust,
`let _ = mutex.lock();` discards the guard at the statement; a named guard in
an inner block still ends at that block. Call through the live guard instead
of locking a non-reentrant mutex again. Check backend callbacks as well as
direct callees: resize, zero-fill, or writeback can reacquire the inode lock.
Trace warm and cold partial-page paths before declaring a lock change safe.

Cursor progress can count bytes staged into a BIO or discarded after a failed
page operation. Prove which bytes became visible or were committed before
using a cursor delta as the syscall count. Changing a shared I/O method from
Err to Ok requires checking every consumer's count and size publication.

Treat sibling code as a candidate pattern. Check its caller contract and
failure paths, and preserve surrounding effects such as timestamp updates
when replacing a guarded copy with an early return.

Keep refactoring proportional to the fix. A helper should own a common contract;
superficially similar call sites can have different locks, error behavior, or
backing objects.

Retain the unfixed source and test bundle so the receiver cannot accidentally
compare two fixed versions. Include the fixed-source patch and its identity.

Completion: a reviewable candidate fix tied to the mechanism, or an explicit
experiment needed to decide it. Runtime success remains unclaimed.

## 5. Turn the case into an upstream regression

Use the current regression framework and neighboring tests as the integration
point. Add the build registration and suite invocation. Name tests after public
behavior: copied byte counts, untouched tails, ordered iovecs, stable object
state, or the actual bug's equivalent.

Use common role names for common scaffolding (`start_writers`, `stop_writers`)
and action names for different worker bodies. Share a fixture when it improves
the test; retain separate programs for independent setups and failure modes.
A couple of local helpers need not become a new global test framework.

Keep the reproducer and regression oracle aligned. Check payload, return value,
errno, untouched memory, or side effects as needed to distinguish this defect.
Ask the receiver to recheck the discriminating baseline after minimizing a
stress case; code simplification alone does not establish sensitivity.

Preserve `FN_SETUP`/`FN_TEST` order, worker cleanup before fd closure, positive
pthread error checks, and explicit skip semantics. Check that a relevant CI
variant actually executes a multi-CPU or mode-specific test. Record any
remaining CI-wiring gap instead of counting an always-skipped test as coverage.

Run formatting before freezing the final test bundle. Apply the new test to an
unfixed snapshot as a test-only overlay; keep production changes out of that
baseline. This matters when the test did not exist at the base commit.
Specify that the receiver builds the reproducer and regression binaries once
for the Asterinas comparison and executes them on both kernel variants.

Completion: a registered regression with the same target oracle and a test-only
baseline overlay. Its expected failures and passes are planned, not measured.

## 6. Package the comparison matrix for execution elsewhere

Generate the plan and adapters from [matrix-protocol.md](matrix-protocol.md)
when the needed inputs are available. Put unresolved inputs in the handoff as
receiver prerequisites instead of executable placeholder commands. The receiver
runs before, after, and Linux targets with both the reproducer and regression.
An adapter may run both programs in one guest boot.

The following conditions specify what execution evidence must show. They do
not instruct the producer to run the matrix.

For every required context, require baseline failure for both artifacts and
fixed/Linux passes. Choose race attempts in advance and retain every result.
Any target failure on the fixed kernel or Linux defeats that matrix, even if a
later attempt passes.

Prepare a separate plan for each material syscall/filesystem/I/O context.
Instruct the receiver to reuse builds only when their identities match and
return every required plan, including gaps and unsuccessful attempts.

A supplemental test for a bad simplification may need a named mutation as its
red control. Record that source in a separate plan. The primary bug still needs
its original before-fail/after-pass evidence.

When fixes may mask each other or make a failure's cause ambiguous, remove one
mechanism at a time while keeping the final tests and other fixes. Existing
per-case baseline failures can suffice for unrelated fixes. Map each selected
case to its expected failure; a sibling case's failure cannot validate it.
If suite ordering stops the baseline before that case, use a recorded focused
invocation that reaches it. Keep the unchanged full-suite result separate.

Completion: `HANDOFF.md`, `model-prompt.md`, and the hashed input bundle meet
[the handoff requirements](reproduction-handoff.md). The comparison cells are
`NOT_RUN` unless supported by supplied logs; expected baseline failure is a
future acceptance condition, not evidence collected during packaging.

## 7. Audit omissions and related implementations

Build an impact inventory while tracing the bug, then revisit it after the fix.
For each candidate, record path, shared contract, potential trigger, evidence,
and disposition. Search along the mechanism:

- Callers that inspect a changed return value, cursor, capacity, or lifetime.
- Sibling filesystem/device implementations of the same operation.
- Related syscall entry points and their offset/flag modes.
- Buffered/direct paths and relevant alignment constraints.
- Boundary sizes, EOF, zero length, partial faults, allocation failure, and
  resize/append interleavings that can invalidate the argument for the fix.
- Other consumers, such as mmap, when they share the state or invariant changed.

Select checks from the actual mechanism and explain exclusions. A grep match
is a candidate, not a confirmed defect; absence of one lock race does not settle
writer-state correctness.

Add coverage for confirmed in-scope paths. Address all confirmed instances when
the user requested a bug-class fix. Keep independently caused or explicitly
excluded issues in a follow-up inventory. Do not silently broaden a narrow PR
or omit an in-scope affected module.

Interpret imported review verdicts from their evidence, not the vote count.
CONFIRMED can describe duplication or an inaccurate comment rather than a
runtime defect. Separate PR regressions, pre-existing defects, test gaps, and
optional design changes; record source-only and runtime evidence separately.

Completion: every discovered in-scope candidate has a supported disposition;
no unresolved affected path is being claimed as covered.

## 8. Review code, comments, messages, and validation

Use the project review skill when available, verify its premises, and apply
confirmed in-scope findings. Otherwise record the direct static review scope.
Draft messages alongside the code even when committing is not yet authorized.

- Code: small functions, descriptive names, existing interfaces, explicit error
  handling, coherent lock order, and no unnecessary abstraction.
- Comments: one constraint or reason in a few lines. Place the explanation that
  prevents a mistaken simplification next to the relevant code.
- Commit body: why, causal failure, and test behavior important to bisect.
  Follow the applicable user instructions and repository process guidelines
  for body format, subject length, identifier quoting, and configured signoff.
- Measurements: distinguish the stress program from the regression cut;
  attribute counts, CPUs, filesystem, and source version to the actual run.

Run relevant formatting, lint, and compile-only checks that do not execute the
scenario. Put neighboring runtime suites and affected matrix reruns into the
handoff. Preserve source identities and require build/boot attribution in the
receiver's return package. When rewriting history with authorization, back it
up and verify the final tree and each commit.

Prepare the publishable series as independent fixes with their tests following
them; retain deliberately failing experiment trees separately. A message-only
rewrite can reuse evidence after tree and build-input equivalence is checked,
with old/new IDs recorded. A rebase changes the base and needs a fresh impact
assessment even when every range-diff patch is unchanged. Refresh renamed test
selectors, commit ordinals, exported patches, and PR/reply drafts together.

Completion: supported code/test changes, reviewed messages, impact record,
static-check results, and the reproduction handoff. Publishing or sending the
package remains within the user's authorization.

## 9. Review returned evidence when supplied

Use the acceptance rules in [reproduction-handoff.md](reproduction-handoff.md)
and [matrix-protocol.md](matrix-protocol.md). Inspect the raw diagnostics,
source/build/boot mapping, and any changes the receiving model made. A runner
cannot independently prove that an adapter built or booted its claimed source.

Keep incomplete comparisons pending and issue a focused follow-up handoff.
Only attributable results for the final inputs can support `FIX_VERIFIED`;
producing the package already completes the producer's current task.
