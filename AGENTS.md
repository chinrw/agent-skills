# agent-skills

This repository ships agent skills and a local PR automation runner.
Helpers use Node ES modules, Python's standard library, Bash, and systemd.

- `codex-skills/babysit-prs-codex/` owns the native babysit skill, prompts,
  scripts, schemas, and fixtures. Keep it self-contained for Nix installation.
- `runners/babysit-auto/` starts top-level controllers. Child reviews and fixes
  use the current session's native tools.
- `skills/codex-implementation/` is a separate Claude/companion workflow.
  Its dependencies do not apply to native babysitting.

Run checks from the repository root:

```bash
bash codex-skills/babysit-prs-codex/tests/run-all.sh
BABYSIT_SKILL_DIR="$PWD/codex-skills/babysit-prs-codex" \
  bash runners/babysit-auto/tests/run-all.sh
```

- Tests use fixtures and fake executables. Do not substitute live model calls,
  GitHub writes, or service starts for these checks.
- Node child-process `EPERM` can be a sandbox failure. Keep blocked execution
  separate from failed assertions.
- Preserve the review-key byte contract and v2 marker/state compatibility.
  `review-key.mjs` and the schemas define accepted evidence.
- Run artifacts need actual task completion and exact identity checks;
  a result file or summary count alone cannot authorize a write.
- `.claude/` policy, run, and worktree paths remain compatibility data paths.
  They do not imply a Claude execution runtime.
- Repository state, installed skill snapshots, and systemd units are separate
  deployment surfaces. See [runner operations](runners/babysit-auto/README.md).
- After an API error, verify the remote branch and exact commit before retrying.
  A closed PR alone is not merge evidence.

The native migration is integrated. Deployment and live PR validation remain
separate gates; inspect their current state before calling the workflow deployed.
