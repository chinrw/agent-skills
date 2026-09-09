# agent-skills

Version-controlled agent skills and a local PR automation runner.

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
| `external-review.mjs` | Local observation, receipt, retry-state and marker handoff |
| `external_review.py` | Deterministic external-review policy used by the handoff |

Existing `.claude/babysit-prs.json`, run directories, worktrees, and v2 GitHub
markers remain compatible. These paths hold state; the entrypoint selects the
runtime. The standalone `codex-implementation` skill below is separate.

### Install and verify

Home Manager consumes `codex-skills/babysit-prs-codex` through shell-config's
`agent-skills` flake input and links it at `~/.agents/skills/babysit-prs-codex`.
Updating the deployed copy requires commit, push, a flake-input update, and a
Home Manager switch. Repository edits alone do not change that snapshot.
The Claude entrypoint can be linked from `skills/babysit-prs` by `./install.sh`
or Home Manager. Nix links must resolve resources inside the same repository
snapshot. The runner service and old Claude links require separate migration checks;
see the [runner installation notes](runners/babysit-auto/README.md#install).

For a portable directory without a sibling checkout or installed skill, export
to a new path outside this repository. The exporter materializes resource links:

```bash
python3 scripts/package-babysit.py codex /tmp/babysit-prs-codex-package
python3 scripts/package-babysit.py claude /tmp/babysit-prs-package
```

Install the resulting directory under the corresponding host's skills directory.
Copying only the Claude source directory without dereferencing its resource
links is not a standalone installation.

Run fixtures from this checkout:

```bash
bash codex-skills/babysit-prs-codex/tests/run-all.sh
python3 -B -m unittest discover -s tests -v
BABYSIT_SKILL_DIR="$PWD/codex-skills/babysit-prs-codex" \
  bash runners/babysit-auto/tests/run-all.sh
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

`./install.sh` links `skills/` entries into `~/.claude/skills`;
it does not install `codex-skills/`. `--check` reports link state and `--unlink`
removes links for entries still present in this checkout. Retired custom agent
links are not enumerated by either option. Existing real files are backed up
before linking.
