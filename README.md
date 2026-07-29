# skills

Version-controlled Claude Code skills and their companion subagents.

Everything here is installed into `~/.claude` by symlink, so the working copy
and the committed copy cannot drift.

```bash
./install.sh           # link skills/ and agents/ into ~/.claude
./install.sh --check   # report link state
./install.sh --unlink  # remove the links
```

`install.sh` never deletes a real file: if `~/.claude/skills/<name>` already
exists as a directory rather than a symlink, it is moved to
`~/.claude/backups/install-<timestamp>/` before the link is created.

## Layout

```
skills/<skill-name>/SKILL.md    the skill itself
skills/<skill-name>/scripts/    deterministic helpers the skill shells out to
skills/<skill-name>/schemas/    JSON Schemas for every artifact it validates
skills/<skill-name>/tests/      fixture tests; no network, no real PRs
agents/<agent-name>.md          subagent definitions the skills dispatch
```

## babysit-prs

Quality-first PR readiness and stacked-merge controller. See
`skills/babysit-prs/SKILL.md`.

Its judgment layers are LLM agents, but the runtime contracts underneath them
are plain code with tests, because the failures worth preventing were all
contract failures rather than reasoning failures:

| Helper | Responsibility |
|---|---|
| `review-key.mjs` | The one implementation of the review-identity byte contract, plus legacy-marker classification |
| `probe-codex-capabilities.mjs` | Non-executing probe of the installed Codex companion; normalizes effort at preflight |
| `codex-job.mjs` | Launch receipts and workspace-aware `status`/`result`/`cancel`; terminal-state classification |
| `parse-codex-artifact.mjs` | Extracts and validates the mandatory stdout result block |
| `reconcile-codex-artifacts.mjs` | Dual-channel reconciliation and atomic canonical persistence |
| `mutation-evidence.mjs` | Bounded mutation experiment for test-coverage claims |
| `check-source-clean.mjs` | Post-task probe-residue and working-tree check |
| `external_review.py` | External-review retry state machine |

### Running the tests

```bash
cd skills/babysit-prs && bash tests/run-all.sh
```

No GitHub state is touched and no real Codex task is launched: the companion is
faked and every input is a fixture.

### Safe manual validation

```bash
/babysit-prs --snapshot-only        # observe and report; no Codex, no writes
```

`--dry-run` blocks remote writes but still permits read-only Codex reviews, so
prefer `--snapshot-only` for routine checks.
