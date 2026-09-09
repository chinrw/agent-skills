# agent-skills

This repository ships agent skills and a local PR automation runner.
Helpers use Node ES modules, Python's standard library, Bash, and systemd.

- `codex-skills/babysit-prs-codex/` owns the shared babysit workflow, prompts,
  scripts, schemas, and fixtures, plus the Codex native entrypoint.
- `skills/babysit-prs/` is the Claude native entrypoint. Its resource symlinks
  share that core; do not restore companion routing or duplicate core files.
- Keep the Codex directory self-contained. Use `scripts/package-babysit.py`
  to export either entrypoint with resource links materialized.
- `runners/babysit-auto/` starts top-level controllers. Child reviews and fixes
  use the current session's native tools.
- `skills/codex-implementation/` is a separate Claude/companion workflow.
  Its dependencies do not apply to native babysitting.

Run checks from the repository root:

```bash
bash codex-skills/babysit-prs-codex/tests/run-all.sh
python3 -B -m unittest discover -s tests -v
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
  The loaded entrypoint selects the native runtime.
- Worktree removal requires recorded ownership, observed task/process
  termination, confirmed merge state, and a preserved Git ref for current HEAD.
  `worktree-guard.mjs check` checks local storage only, not merge or lifecycle.
- Repository state, installed skill snapshots, and systemd units are separate
  deployment surfaces. See [runner operations](runners/babysit-auto/README.md).
- After an API error, verify the remote branch and exact commit before retrying.
  A closed PR alone is not merge evidence.

Deployment and live PR validation are separate from repository changes;
inspect their current state before calling either native workflow deployed.
