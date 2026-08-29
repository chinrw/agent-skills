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
| single-flight | `flock` plus the skill's own `run.lock` |
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
#   2  error
```

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

Verified unit behaviour, measured rather than assumed:

| case | Result | ActiveState |
|---|---|---|
| gate exits 10 (idle) | success | inactive |
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
- **Run directories still accumulate.** `<checkout>/.claude/babysit-prs/runs/` is
  per-session and never swept; 27 had piled up before any timer existed.
- **The skill's `allowed-tools` frontmatter is narrower than what it runs.** A
  live `--snapshot-only` run executed `sed`, `grep` and `echo`, none of which
  match its declared patterns. Any attempt to run this under a tightened
  permission profile has to reconcile that first.
- **Only `--snapshot-only` has been exercised end to end headless.** A full
  unattended run that pushes, comments and merges has not been observed yet.
