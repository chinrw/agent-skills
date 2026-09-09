---
name: babysit-prs-codex
description: >-
  Prepare chinrw/stocks PRs for merging with native Codex subagents and
  automatically merge eligible strict stacked PRs. Explicit invocation only.
disable-model-invocation: true
---

# PR babysitting in Codex

Run the controller in the current Codex session. Use the native spawn, message,
wait, and stop/close tools available in this session. Reviews and checkpoints
start with `fork_turns="none"` when that option exists; supply the full assignment
and checkpoint prompt instead of inheriting the controller's conversation.

Use the session's configured model and reasoning settings, respecting explicit
user choices and runtime overrides. Record observed settings when exposed, or
`unknown` otherwise. No effort attestation is required.

Record the returned native agent ID and use it for lifecycle operations. Wait
for native completion before accepting artifacts. Before retrying or releasing
a writer's worktree, confirm the old child and its processes have terminated.
If the necessary native capability is missing, block that assignment and keep
snapshot-only available. All children remain siblings of this controller.

## Controller ownership

Before any local source/worktree or GitHub write, read and follow
[controller coordination](references/controller-coordination.md). Acquire the
repository lease, or adopt the timer's exact supplied token. Hold it through
all children and publication; release only with observed quiescence evidence.
`--snapshot-only` takes no write lease.

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
