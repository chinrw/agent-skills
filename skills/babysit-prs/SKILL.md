---
name: babysit-prs
description: >-
  Prepare chinrw/stocks PRs for merging with native Claude Code subagents and
  automatically merge eligible strict stacked PRs. Explicit invocation only.
disable-model-invocation: true
---

# PR babysitting in Claude Code

Run the controller in the current Claude Code session. Use the native `Agent`
tool with a fresh, non-fork subagent, such as `general-purpose`, for each review,
fix, and checkpoint. Supply the full assignment and checkpoint prompt. Keep
this controller in the main conversation; a `context: fork` skill or conversation
fork does not provide the independent checkpoint context this workflow needs.

Use the session's configured model and reasoning settings, respecting explicit
user choices and runtime overrides. Do not assume built-in exploration agents
use that model. Record observed settings when exposed, or `unknown` otherwise.
No effort attestation is required.

Record the returned agent/task ID. Use native completion notifications or the
available output/wait tool to collect its terminal result, and the native stop
tool when cancellation is needed. Use the same ID for every lifecycle call;
never infer completion from a file, silence, or a success claim in a summary.
A completed child can leave processes behind: collect those before releasing a
writer's worktree. If termination is unobservable, block that assignment rather
than start another writer. All children remain siblings of this controller.

This entrypoint uses Claude's native children. It shares the core resources
below with the Codex entrypoint and requires no cross-runtime job launcher.

## Shared workflow

Resolve `BABYSIT_SKILL_DIR` to this loaded skill's directory. Read
[the shared workflow](references/workflow.md) sections 1–9 before scheduling
PR work. For `--snapshot-only`, read sections 1.1 and 7 and report without
starting children or changing source or GitHub state.

Load later sections when their stage is reached:

- Review or thread findings: sections 10–11.
- Implement and verify fixes: section 12.
- External review, CI, and composition: sections 13–15.
- Before publishing or merging: sections 16–20 and 22.
- Final report or invocation limit: sections 17 and 21.

The workflow defines arguments, repository policy, run artifacts, the v2
marker/state contract, and exact-identity acceptance. After compaction, reread
this entrypoint and the relevant workflow sections before continuing writes.
Checkpoint assignments include their prompt from `prompts/` and the
[checkpoint contract](references/checkpoint-contract.md). All helper paths are
relative to `BABYSIT_SKILL_DIR`; the caller's checkout is a separate path.

Use existing authorization. The controller owns commits and every GitHub write.
Independent review and verification use fresh children. A completed result must
pass the shared admission checks; a summary or model label cannot approve it.
