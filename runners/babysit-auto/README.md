# babysit-auto

A local timer for `babysit-prs-codex`. The gate reads PR markers and live state
before starting a model session. When work is due, `run-controller.sh` starts
one top-level Codex controller; reviews and checkpoints use native subagents
inside that session.

## Gate and controller

```bash
node tick-gate.mjs due --repo chinrw/stocks
# 0 due, 10 idle, 13 an interactive run is active, 2 error
node tick-gate.mjs contract
# 0 compatible, 12 skill contract missing or changed
```

The default skill path is `~/.agents/skills/babysit-prs-codex`, overridable with
`BABYSIT_SKILL_DIR` or `contract --skill-dir`. The contract check pins the v2
marker template and the 14 states in SKILL.md section 9.

The due gate detects missing or stale markers, head/base changes, unfinished
pipeline work, due external-review retries, and CI transitions. Base drift
uses the branch tip. `READY_ROOT`, `BLOCKED`, and `MERGED` remain parked until
fresh evidence arrives. A missing retry clock in `WAITING_CODEX` is due.

Before querying GitHub, the gate checks for a live process under the checkout's
`.claude/worktrees/` or a file written under `.claude/babysit-prs/runs/` in the
last 30 minutes. `--checkout` and `--busy-window-seconds` override the defaults.
These state paths are retained for existing runs and policy files.

The controller starts with `workspace-write`, network access, automatic
approval review, and `model_reasoning_effort="xhigh"`. Its `effort=xhigh`
attestation matches that explicit configuration. The model comes from the
operator's Codex configuration. Native child tools, authenticated `gh`, and
write access to the checkout/run paths are required. No sandbox bypass is used.

## Install

The example service expects this checkout at
`~/Documents/play/agent-skills`, stocks at `~/Documents/play/stocks`, and Codex
on the configured service PATH. The CLI must support `--approve-for-me`.
Run the commands below from `runners/babysit-auto/`.

```bash
mkdir -p ~/.config/systemd/user
cp systemd/babysit-auto.{service,timer} ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now babysit-auto.timer
```

Check who owns each installed file before deploying. Update the `agent-skills`
flake input and switch Home Manager for the installed Codex skill. A manually
copied systemd unit needs a separate replacement and daemon reload; a unit
managed by Home Manager needs its declarative source updated instead.

Retired `~/.claude/skills/babysit-prs` and `~/.claude/agents/babysit-pr-*.md`
links also need a migration decision. The current shell-config activation
only prunes dead links into the current input store path, and returns early
when a source directory is absent. Valid links into an older Nix snapshot
therefore survive a flake update. Inspect their targets before removing any;
the repository's `install.sh --unlink` cannot enumerate deleted entries.

Before enabling the native timer, verify the installed skill content and the
unit's actual `ExecStart`. `tick-gate.mjs contract` checks only markers and
states; it cannot distinguish the retired runtime from the native one.

```bash
readlink -f ~/.agents/skills/babysit-prs-codex
cmp ../../codex-skills/babysit-prs-codex/SKILL.md \
  ~/.agents/skills/babysit-prs-codex/SKILL.md
systemctl --user show babysit-auto.service -p FragmentPath -p ExecStart
systemctl --user show babysit-auto.timer -p ActiveState -p UnitFileState
```

Editing the checkout affects the gate on the next tick because the example
unit points at this working tree. It does not replace an installed unit or
switch an installed skill snapshot.

The timer checks every five minutes with jitter. The unit holds `flock` during
the controller run and bounds it with `timeout --signal=INT 3300`.

| Event | Unit outcome |
|---|---|
| Gate exits 10 or 13 | Skipped, `Result=exec-condition` |
| Skill contract check fails | Failed |
| Lock is already held | Success via exit 75 |
| Controller reaches its wall-clock budget | Success via exit 124 |
| Controller exits with another failure | Failed |

`timeout(1)` supplies exit 124; a systemd `TimeoutStartSec` kill remains a unit
failure. Process cleanup applies to the service's control group.

```bash
systemctl --user list-timers babysit-auto.timer
journalctl --user -u babysit-auto.service -f
node tick-gate.mjs due --repo chinrw/stocks --json
```

## Verification and limits

```bash
BABYSIT_SKILL_DIR="$PWD/../../codex-skills/babysit-prs-codex" bash tests/run-all.sh
```

Tests use PR fixtures, a real local process for busy detection, and a fake
Codex binary to check controller arguments and failure propagation. They also
validate the marker/state contract against the in-repo Codex skill.

- The native controller has not been exercised end to end against live PRs.
  Publishing, thread resolution, and merging remain unverified in unattended use.
- Busy detection is heuristic. A controller with no recent artifact write or
  worktree process can be missed; two manual invocations do not share `flock`.
- A gate error exiting 2 is also skipped by `ExecCondition`; no notifier is wired.
- Spec-only drift does not wake the gate until another signal changes.
- The gate cannot identify fixes committed locally but never pushed. The skill
  must recover such work before discarding residual worktrees.
- Native child concurrency is bounded per invocation, not across the host.
