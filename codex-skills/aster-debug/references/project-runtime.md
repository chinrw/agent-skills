# Asterinas runtime and regression guidance

The producer reads this reference to design tests and prepare the handoff.
Runtime instructions here address the receiving model; they do not override
[the skill's execution boundary](../SKILL.md#execution-boundary).
Repository paths below are relative to the checkout under investigation.

## Establish the actual build and runtime inputs

- Resolve the requested image first; otherwise consult `DOCKER_IMAGE_VERSION`
  and `rust-toolchain.toml`. Record the resolved image ID or digest and compiler.
- Run builds and guest validation in the project's development environment.
  Choose focused targets from the current Makefiles and runner configuration.
- Inspect the effective Docker endpoint and the failure itself. A sandbox socket
  denial, an unavailable daemon, and a registry TLS error require different
  remedies. Reuse session authorization for a permitted retry.
- This conversation's host had a rootless default endpoint, while an explicitly
  selected rootful endpoint could access the requested image. That is host
  history, not a reason to default every future task to rootful Docker.
- Expose devices individually, such as `/dev/kvm`. Honor the host rule against
  a writable host `/dev` mount. Inspect project launch scripts before reusing
  broad `--privileged` examples.
- Use task-owned source/output directories and disposable filesystem images for
  experiments. Stop only the containers and QEMU processes created for the task.

Resolve and verify the repository, worktree, base, and test paths before script
mutations; a failed directory change must stop subsequent Git commands. Derive
the selected series from its verified base and tip instead of old commit counts
or a deleted scratch ref. When wiring a test into both Makefile and run_test.sh,
validate both anchors before writing either file, then verify the resulting diff.

Inspect the actual kernel path in the QEMU command. Record its hash alongside
the source/build manifest and initramfs or test-binary identity. A directory named
after a commit can contain a kernel reused from another build.

When a base or relevant build input changes, decide which checks are invalidated
and rebuild those inputs. A successful Cargo invocation alone does not identify
the kernel subsequently booted.

Keep each build cache bound to its source workspace; copying `target/` between
worktrees also copies generated OSDK crates and dependency identities. For a
duplicate-OSTD link error, inspect the generated dependency graph before blaming
the patch or clearing caches. At the examined revision, `OSDK_LOCAL_DEV=1` is
read when compiling cargo-osdk (`option_env!`), not when running it. Missing it
can select registry OSTD alongside the path dependency. Check the current
Makefile's OSDK install rule too: it can replace the user's global executable.
Keep the chosen OSDK binary and installation scope explicit in the adapter.

If a build fails around the toolchain, dependencies, or firmware, inspect the
failing stage before adapting it. Prior cases involved OSDK subprocess toolchain
selection, generated runner lockfiles, offline dependency caches, and split OVMF
files. Use local workarounds only when the same cause is demonstrated; record
them as build inputs rather than making them unrelated source changes.

## Check the guest, not just the launch command

- Confirm the test directory is mounted on the intended filesystem. Linux
  `/tmp` and Asterinas `/tmp` need not name the same filesystem implementation.
- Check the guest's CPU count and, when the oracle requires it, participant
  placement and readiness. Host CPU availability does not establish guest SMP.
- Distinguish buffered I/O from `O_DIRECT`; direct I/O adds alignment and path
  constraints. An observation on one path does not validate the other.
- Capture guest case or assertion statuses as well as the QEMU exit code.
QEMU status `33` was an expected shutdown signal for the runner in this case,
  but the follow-up run also used it after individual tests reported failures.

For API contracts, use the relevant primary specification or implementation.
The [readv manual](https://man7.org/linux/man-pages/man2/readv.2.html) defines
iovec ordering; the [getcpu manual](https://man7.org/linux/man-pages/man2/getcpu.2.html)
explains why a CPU report is a snapshot rather than affinity.

## Make the runner return the result it observed

A usable feedback loop preserves failures through logging and cleanup.
Fail prerequisites before booting or running tests against stale outputs.
Keep a test failure or timeout as the final status; use a cleanup failure as the
final status only when the test succeeded. Keep both errors in the log.

For a new or repaired runner, useful control cases are:

| Scenario | Required observation |
|---|---|
| Build or format prerequisite fails | Dependent runtime stage does not run |
| Test fails | Runner returns failure after cleanup |
| Test times out | Timeout remains distinguishable from pass |
| Test passes, cleanup fails | Runner reports cleanup failure |
| Test and cleanup fail | Original test failure is retained; cleanup is logged |

These controls validate runner behavior. They do not count as a kernel test run.
Use the runner's documented exit codes rather than assuming every runner uses
the numeric values from this conversation.

Create a fresh run directory before preparation and bind monitoring to that
run's process and log. A setup failure must not leave an old DONE marker as the
apparent result; process exit without a marker must also terminate the wait.
Record QEMU host-port collisions as launch errors and preserve those attempts
when retrying. Count the framework's actual test summaries, not every line
containing `summary` (exfat tools also print `Media summary`). Report composite
check stages individually: completed clippy passes followed by missing
`cargo udeps` do not make the whole check command pass.

## Regression framework details that affect behavior

Read `test/initramfs/src/regression/common/test.h` before rearranging tests.

For a focused C build, the common Makefile accepts `TEST_PLATFORM=linux`.
The initramfs build exposes `REGRESSION_TEST_PLATFORM=linux`. Inspect these
current definitions before use; a Linux build must preserve the target oracle.
A focused build inside the selected development environment can use:

```sh
make -C "$ASTER_REGRESSION_DIR" TEST_PLATFORM=linux BUILD_DIR="$ASTER_CASE_DIR/linux-build"
```

Set both paths to this case's actual test and output directories. Build the
Asterinas test with the corresponding platform setting. Verify runtime mounts
and executed assertions on both systems; compiling a Linux variant is only the
build stage of the comparison.

- `FN_SETUP` and `FN_TEST` assign constructor priorities using `__COUNTER__`.
  Their relative source order controls setup, test, and cleanup execution.
- `TEST_RES` records an assertion failure and continues. Code after it still
  needs to stop and join workers.
- `SKIP_TEST_IF` returns from the containing function. Keep it in the test
  body; join already-started workers before taking the skip path.
- `CHECK` aborts the process on failure. Understand that behavior when choosing
  between setup failures and ordinary test assertions.
- Pthread functions report positive error numbers. Check the current wrappers
  and use the expected success value, usually `_ret == 0`.
- `pthread_barrier_wait` succeeds with either 0 or
  `PTHREAD_BARRIER_SERIAL_THREAD`. Keep barrier/create/join failures separate
  from the anomaly count; they indicate broken setup or cleanup.

For race tests, publish readiness before starting the measured loop and use
proper synchronization for shared flags. Check the actual scheduler before
relying on startup CPU samples. In the examined Asterinas scheduler, existing
threads kept their last CPU; new-thread placement selected minimum queue load
with round-robin tie breaking. Neither two nor eight spawned writers promised
a particular CPU distribution. Prefer an observed placement check over that
assumption, and keep the snapshot limitation explicit.

Check placement of the actual competing roles: reader versus writer for the
read races, writer versus writer for concurrent extension. An observer on a
third CPU does not establish that the two writers run concurrently. Record
online CPU count separately from allowed CPUs and observed placement; a Linux
affinity restriction can leave `sysconf` reporting more than one online CPU.

Keep the checker separate from both writers when its inline write would finish
before the peer wakes from a barrier. More workers or rounds do not repair an
unreached branch. For barrier-based workers, release the barrier they are waiting
on when stopping, then join before destroying barriers or closing fixtures.
Include the early-skip path and the skip-after-spawn cleanup path in the
receiver's checks when present. Those runs validate skip behavior; they do not
satisfy a race matrix.

Report a skip as a skip. A multi-CPU run with no observed failure remains bounded
evidence; a suitable failing baseline or mutation helps establish sensitivity.
Record assertion counts and loop/activity counts separately. A declared round
budget does not prove that every iteration ran.

## Formatting and narrow edits

Read the nearest `.clang-format`. At the examined revision, regression C used
`ColumnLimit: 80`, `TabWidth: 8`, and `ReflowComments: false`. The formatter could
preserve an overlong comment, so inspect expanded columns when wrapping matters.
Keep repository-wide formatter changes separate from a narrow regression fix.

Use comments for the constraint or test purpose. Keep historical measurements,
rejected alternatives, and why a baseline passes or fails in the commit body or
case report. When simplifying code, preserve the test's oracle and the order
of constructor-based setup and cleanup.
