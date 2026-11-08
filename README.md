# agent-skills

Install this repository's shared and native agent skills with Home Manager,
or link the Claude Code skills from a local checkout. The repository also
contains a separate PR automation runner; installing skills does not start it.

## Home Manager

Add the flake as an input, import its module, and enable it:

```nix
inputs.agent-skills.url = "github:chinrw/agent-skills";

# In a Home Manager module with access to inputs:
imports = [ inputs.agent-skills.homeManagerModules.default ];
programs.agent-skills.enable = true;
```

The module discovers skills automatically. Adding a directory containing
`SKILL.md` to one of these groups requires no consumer-side path change:

| Source | Installed entrypoints |
| --- | --- |
| `shared-skills/` | `~/.agents/skills/`, plus `~/.claude/skills/` when Claude Code is selected |
| `skills/` | `~/.claude/skills/` |
| `codex-skills/` | `~/.codex/skills/` |

Codex and pi discover the shared Agent Skills location. Native Codex skills
stay out of that shared directory. `lib.skills` exposes the same catalog for
consumers that need to inspect it. Source links retain the entire flake snapshot,
so the Claude babysit entrypoint can resolve its sibling resources.

All three tools are selected by default. To choose tools or omit a skill:

```nix
programs.agent-skills = {
  enable = true;
  tools = [ "claude-code" "codex" "pi" ];
  exclude = [ "codex-implementation" ];
};
```

Activation backs up pre-existing files, directories and foreign symlinks under
`$XDG_STATE_HOME/agent-skills/backups/` before linking. Its manifest removes
only unchanged links that it previously installed; user-replaced paths remain.
Disabling the module or excluding a skill removes those owned links on the next
activation. Dry activation does not create backups, links or state files.
Updating a deployed snapshot requires a commit, push, consumer input update,
and Home Manager activation. Repository edits alone do not change installed skills.

Without Nix, `./install.sh` installs the Claude and shared skills from this
checkout. `--check` reports link state; `--unlink` removes the enumerated links.
The Codex-native directory and runner remain separate installations.

## aster-debug

[`aster-debug`](codex-skills/aster-debug/SKILL.md) analyzes Asterinas bug reports
and Specula results, prepares fixes and regression tests, and packages a handoff
for another agent to run the reproducer. Runtime validation remains pending
until the receiving agent returns evidence.

The skill includes its reference material, artifact collector, matrix runner,
and fixture tests. The Home Manager module installs its Codex entrypoint.

## context-bundle

[`shared-skills/context-bundle/SKILL.md`](shared-skills/context-bundle/SKILL.md)
packages the current task for another agent as one ZIP. It includes the needed
non-public material and a single `HANDOFF.md` with task state, next actions,
source provenance, public references, and explicit gaps. A Python standard-library
helper adds a SHA-256 manifest and verifies the archived bytes.

Example request: `Use $context-bundle to package this conversation for another agent.`
The module and `install.sh` install this shared skill.
`codex-skills/context-bundle` remains a compatibility link for existing callers.

```bash
python3 -m unittest discover -s shared-skills/context-bundle/tests -v
```

## Native PR babysitting

Two entrypoints prepare `chinrw/stocks` PRs for merging and merge eligible
strict stacked leaves. Root PRs retain the integration/main gates.

| Host | Entrypoint | Children |
|---|---|---|
| Codex | [`babysit-prs-codex`](codex-skills/babysit-prs-codex/SKILL.md) | Native Codex subagents |
| Claude Code | [`babysit-prs`](skills/babysit-prs/SKILL.md) | Native Claude subagents |

Each host session owns commits and GitHub writes. Both read one
[shared workflow](codex-skills/babysit-prs-codex/references/workflow.md) and use
the same scripts, schemas, tests, and checkpoint prompts. Resources live in the
Codex package; the Claude entrypoint links to them. Neither starts the other
runtime to delegate a review or fix.

Model/effort metadata is informational. The controller can read decisive
evidence when needed; independent verification and exact-identity admission
remain required. Existing `effort=<tier>` arguments are accepted for launcher
compatibility and have no effect on configuration or permissions.

| Helper | Responsibility |
|---|---|
| `review-key.mjs` | Review identity and legacy-marker classification |
| `validate-artifact.mjs` | Task/checkpoint admission, assigned input and source checks, and canonical publication |
| `mutation-evidence.mjs` | Focused mutation experiments for test-coverage claims |
| `check-source-clean.mjs` | Source cleanliness and temporary-probe checks |
| `worktree-guard.mjs` | Worktree ownership records and durable local commit recovery |
| `controller-lock.mjs` | Shared native/timer/companion controller ownership and guarded release |
| `external-review.mjs` | Local observation, receipt, retry-state and marker handoff |
| `external_review.py` | Deterministic external-review policy used by the handoff |

Existing `.claude/babysit-prs.json`, run directories, worktrees, and v2 GitHub
markers remain compatible. These paths hold state; the entrypoint selects the
runtime. The standalone `codex-implementation` skill below is separate.
Updated entrypoints coordinate through one Git-common-dir lease. Unknown owners
remain blocked until actual termination evidence is available; separate clones
and older installed entrypoints require their own migration/coordination checks.

### Install and verify

The Home Manager module installs both native entrypoints from the same source
snapshot. The runner service and old manually installed links remain separate
deployment surfaces; see the [runner installation notes](runners/babysit-auto/README.md#install).

For a portable directory without a sibling checkout or installed skill, export
to a new path outside this repository. The exporter materializes resource links:

```bash
python3 scripts/package-babysit.py codex /tmp/babysit-prs-codex-package
python3 scripts/package-babysit.py claude /tmp/babysit-prs-package
```

Install the resulting directory under the corresponding host's skills directory.
Copying only the Claude source directory without dereferencing its resource
links is not a standalone installation.

Run fixtures with Node, Python and Bash available:

```bash
bash scripts/check-all.sh
```

These checks use fixtures and a fake controller binary. They neither call a
model nor write to GitHub. Invoke `babysit-prs-codex --snapshot-only` in Codex,
or `/babysit-prs --snapshot-only` in Claude Code, to inspect live PR state
without spawning children, editing worktrees, or writing to GitHub.

Worktrees without creation records or observable task termination are retained.
Before removal, the controller confirms the recorded PR is merged and preserves
local HEAD under `refs/babysit-prs/retained/`. These refs survive worktree removal
and Git garbage collection. Recover one with `git branch <name> <savedRef>`;
deleting retained refs requires a separate retention decision.

For scheduled operation, see [`runners/babysit-auto/`](runners/babysit-auto/README.md).

## codex-implementation

[`skills/codex-implementation/SKILL.md`](skills/codex-implementation/SKILL.md)
is the separate Claude-plans/Codex-implements workflow. It retains its own
companion execution path.

It supports read-only investigation before implementation. The
[attempt helper and runtime contract](skills/codex-implementation/references/runtime.md)
pin the companion, cwd, and job/thread identity, preserve ambiguous outcomes,
and bind completion to required criteria and independent checks. Corrections
use a fresh thread after collecting and settling the previous attempt.

```bash
node --test skills/codex-implementation/tests/*.test.mjs
```

These fixtures use a fake companion; no model is launched. Effective runtime
settings and live task termination still require observations from the host.
`assessment-template` supplies IDs and the snapshot with every judgment left
NOT RUN. `export-handoff` copies selected task records with a byte manifest;
the final context bundle still owns the sole `HANDOFF.md` and source accounting.
