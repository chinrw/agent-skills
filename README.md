# agent-skills

Version-controlled agent skills and a local PR automation runner.

## babysit-prs-codex

[`codex-skills/babysit-prs-codex/SKILL.md`](codex-skills/babysit-prs-codex/SKILL.md)
prepares `chinrw/stocks` PRs for merging and merges eligible strict stacked
leaves. Root PRs remain subject to the skill's integration/main gates.

The current Codex session coordinates native subagents for review, fixes, and
fresh independent judgment. The controller owns commits and GitHub writes.
The skill includes its own scripts, schemas, tests, and checkpoint prompts.

| Helper | Responsibility |
|---|---|
| `review-key.mjs` | Review identity and legacy-marker classification |
| `validate-artifact.mjs` | Task/checkpoint admission, assigned input and source checks, and canonical publication |
| `mutation-evidence.mjs` | Focused mutation experiments for test-coverage claims |
| `check-source-clean.mjs` | Source cleanliness and temporary-probe checks |
| `external-review.mjs` | Local observation, receipt, retry-state and marker handoff |
| `external_review.py` | Deterministic external-review policy used by the handoff |

Existing `.claude/babysit-prs.json`, run directories, worktrees, and v2 GitHub
markers remain compatible. Those paths hold state; Claude Code is no longer
a babysit runtime. The standalone `codex-implementation` skill below is separate.

### Install and verify

Home Manager consumes `codex-skills/babysit-prs-codex` through shell-config's
`agent-skills` flake input and links it at `~/.agents/skills/babysit-prs-codex`.
Updating the deployed copy requires commit, push, a flake-input update, and a
Home Manager switch. Repository edits alone do not change that snapshot.
The runner service and retired Claude links require separate migration checks;
see the [runner installation notes](runners/babysit-auto/README.md#install).

Run fixtures from this checkout:

```bash
bash codex-skills/babysit-prs-codex/tests/run-all.sh
BABYSIT_SKILL_DIR="$PWD/codex-skills/babysit-prs-codex" \
  bash runners/babysit-auto/tests/run-all.sh
```

These checks use fixtures and a fake controller binary. They neither call a
model nor write to GitHub. In an existing Codex session, invoke
`babysit-prs-codex --snapshot-only` to inspect live PR state without spawning
children, editing worktrees, or writing to GitHub.

For scheduled operation, see [`runners/babysit-auto/`](runners/babysit-auto/README.md).

## codex-implementation

[`skills/codex-implementation/SKILL.md`](skills/codex-implementation/SKILL.md)
is the separate Claude-plans/Codex-implements workflow. It retains its own
companion execution path.

`./install.sh` links the remaining `skills/` entries into `~/.claude/skills`;
it does not install `codex-skills/`. `--check` reports link state and `--unlink`
removes links for entries still present in this checkout. Retired babysit links
are not enumerated by either option. Existing real files are backed up before
linking.
