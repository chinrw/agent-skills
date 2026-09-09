# Shared workflow navigation

At invocation, read [startup](startup.md) for arguments, scope, native execution,
and concurrency. Read only the stage needed for the next action. Section numbers
below preserve the original contract references; each section has one home.

| Before this action | Read |
|---|---|
| Acquire/adopt/release write ownership | [Controller coordination](controller-coordination.md) |
| Snapshot-only observation | [Startup](startup.md) §1.1 and [snapshots](evidence.md) §7 |
| Assign a child, collect a result, or verify source cleanliness | [Evidence](evidence.md) §§3,5,7 and [checkpoint admission](checkpoint-contract.md) |
| Compute review identity or read/write status markers | [State contract](state-contract.md) §§8–9 |
| Classify a stack or review PRs/threads | [Review](review.md) §§6,10–11 |
| Implement, run local checks, or verify composition | [Implementation](implementation.md) §§12,14–15 |
| Resolve repository policy or handle external review | [External review](external-review.md) §§4,13 and [handoff](external-review-handoff.md) |
| Publish, merge, advance a wave, or report final state | [Publication](publication.md) §§16–22 |
| Register, preserve, or reclaim a worktree | [Worktrees](worktrees.md) §§3.1–3.2 |

Before the first GitHub write, load publication's complete identity, collision,
and authorization rules. Every merge wave reevaluates all gates against fresh
observations. Reuse loaded instructions; reload after compaction, policy changes,
or uncertainty about the rules.
Reading a stage does not replace independent acceptance or grant broader scope.
After compaction, restore the current run identity and lease ownership from the
existing controller record before continuing writes; do not adopt another run.

[Historical observations](history.md) explain compatibility and past failures.
They are not current PR state. Run artifacts, current GitHub observations, and
the deterministic helpers remain the evidence for current decisions.
