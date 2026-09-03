# babysit-auto

Unattended runtime for `/babysit-prs`. It adds no review capability; it supplies
the discipline a timer-driven run needs and the skill does not have: decide
whether anything is due before paying for a model turn, keep two runs from
colliding, bound the wall clock, and fail loudly when its assumptions stop
holding.

`skills/babysit-prs/` is not modified by any of this. The skill is driven as a
black box, and the only coupling is the state it already publishes in each PR's
status comment.

## Why a runner and not a reviewer

`chatgpt-codex-connector[bot]` is already the reviewer, and it is already
webhook-driven. `/babysit-prs` is the conductor that drives that bot, judges its
verdict, and advances the stack. So the thing missing was never review quality —
it was the operational envelope that every merge bot converges on:

| | |
|---|---|
| idempotent writes | the skill's v2 marker, already there |
| state in the forge, not the runner | the status comment, already there |
| single-flight | `flock` for timer against timer; the gate's busy check for timer against a person |
| conditional work | `tick-gate.mjs due` |
| bounded runs | `timeout(1)` inside the unit |
| loud failure | `ExecStartPre` contract check, `OnFailure` |

Webhook or CI-job triggering — the two normal ways to do this — are unavailable
here: `SKILL.md` depends on the local Codex plugin, local worktrees and local
credentials, none of which exist in a GitHub runner. Polling is forced, so the
gate exists to make polling cheap.

## Layout

```
tick-gate.mjs          due / lock / contract
lib/marker.mjs         the v2 status-comment marker
lib/contract.mjs       what this runner assumes about the skill, pinned
systemd/               one timer, one oneshot service
tests/run-all.sh
```

## The gate

```bash
node tick-gate.mjs due --repo chinrw/stocks
#   0  work is due, one reason per PR on stdout
#  10  nothing due, earliest codexNextTriggerAt printed
#  13  a run is already active on this checkout; stand down
#   2  error
```

Before any GitHub call the gate asks whether `/babysit-prs` is already running
on the checkout (cwd, or `--checkout`). The skill has no lock of its own, so
this is what keeps a tick from running beside a person at a terminal. Two
signals, either one counts:

- a live process whose cwd is under `.claude/worktrees/` — review and fix
  attempts run there and can go a long time without writing anywhere else;
- anything under `.claude/babysit-prs/runs/` written in the last 30 minutes
  (`--busy-window-seconds`) — the controller writes there between attempts.

A false busy delays one tick; a false idle is a collision, so the window is
generous and the walk trusts no directory mtime. What it cannot see: a
controller that has neither written nor spawned for 30 minutes. Two runs would
then interleave, which is the mode the skill is built for anyway — every PR's
state lives in its status comment, and each run re-derives from there.

Due when: a PR has no current marker, its head or base moved, its state is
mid-pipeline, its `codexNextTriggerAt` has come due, or CI settled under
`WAITING_CI`. Not due for `READY_ROOT`, `BLOCKED` and `MERGED` unless fresh
evidence arrives.

Anything it cannot decide is reported due. A false "due" wastes one run; a false
"idle" stalls every PR silently, which is the failure this exists to prevent.
That bias also covers a gap the skill would otherwise need a code change for: a
PR left in `WAITING_CODEX` with no retry clock is picked up on the next tick
rather than dropping out of reach.

Base drift compares against the branch ref, never GraphQL `baseRefOid` — that
field reports the merge base, which would mark every stacked PR as changed
forever.

## Contract drift

The runner reads state the skill publishes, and nothing at runtime would notice
if that shape moved. So the marker template and the state list are pinned in
`lib/contract.mjs` and checked:

```bash
node tick-gate.mjs contract     # 0 ok, 12 drifted
```

`tests/contract.test.mjs` pins them against `skills/babysit-prs/SKILL.md` in this
repo, so a change to the skill breaks the test suite rather than the runner at
3am. The unit runs the same check as `ExecStartPre`, where a failure marks the
unit failed and fires `OnFailure`.

## Install

```bash
mkdir -p ~/.config/systemd/user
cp systemd/babysit-auto.{service,timer} ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now babysit-auto.timer
```

On a Nix-managed machine these belong in the home-manager config instead,
alongside the existing `stocks-*-update` units, so they survive a rebuild. The
unit points at the git checkout rather than the Nix store, so the runner can be
iterated without a flake update; the skill it drives still comes from the store.

Verified unit behaviour, measured rather than assumed (systemd 261; a skipped
`ExecCondition` is `Result=exec-condition`, which `is-failed` reports as
`inactive` and `OnFailure` ignores):

| case | Result | ActiveState |
|---|---|---|
| gate exits 10 (idle) or 13 (busy) | exec-condition (skipped, not failed) | inactive |
| contract check fails | exit-code | **failed** |
| lock held by previous tick (`flock -E 75`) | success | inactive |
| wall clock expired (`timeout` → 124) | success | inactive |

`SuccessExitStatus=SIGTERM` does **not** cover a systemd `TimeoutStartSec` kill —
systemd records that as `Result=timeout`, which `SuccessExitStatus` cannot
reclassify. Hence `timeout(1)` inside the unit.

## Watch it

```bash
systemctl --user list-timers babysit-auto.timer
journalctl --user -u babysit-auto.service -f
node tick-gate.mjs due --repo chinrw/stocks --json | jq
```

## Known gaps

- **Spec drift is invisible to the gate.** `specHash` is computed by the
  `babysit-pr-spec-selector` agent, so a spec document edited while no PR head
  moves will not wake the timer.
- **No notifier is wired.** `OnFailure=` in the service is a commented-out hook.
- **Nothing sweeps its own residue.** `<checkout>/.claude/babysit-prs/runs/` is
  per-session, and review worktrees under `.claude/worktrees/` outlive the PRs
  they were cut for. A 2026-09-03 sweep of the manual-era backlog found 31 run
  directories (24 older than a week, 15MB) and 22 worktrees, 8 of which belonged
  to already-merged PRs. Manual operation accumulates this over months; a
  five-minute timer gets up to 288 chances a day.
- **A fix can be built and never delivered.** That same sweep found two complete
  fixes with tests, committed locally at 06:40 by run `76de33f7` and never
  pushed, on PRs that were still open. The run had committed each tree and then
  compacted before its verifier step; the continuation session started #538
  over from review, unaware the fix existed. #535's was re-derived by that
  session and landed as PR #570; #538's was recovered from the dangling object
  and pushed as PR #571. This is the failure the gate cannot see: the skill's
  own state machine reads such PRs as needing work, but nothing notices that a
  run produced a commit and dropped it.
- **The skill's `allowed-tools` frontmatter is narrower than what it runs.** A
  live `--snapshot-only` run executed `sed`, `grep` and `echo`, none of which
  match its declared patterns. Any attempt to run this under a tightened
  permission profile has to reconcile that first.
- **Only `--snapshot-only` has been exercised end to end headless.** A full
  unattended run that pushes, comments and merges has not been observed yet.
