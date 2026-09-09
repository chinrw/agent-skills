# Astra audit disposition

Audit baseline: `6f07b836a1ca7be2ecba56fd5defae7af031e779`.
Reference ZIP SHA-256:
`cba04313845ee2c38e149e47e3b2eb50f952762ee9f05274cd7e8fa99086881c`.
The table records source changes, not deployed or live-model validation.

| Item | Resolution |
|---|---|
| F01: unsafe worktree reclamation | Native babysitting records ownership and preserves current HEAD in a durable Git ref; unknown ownership or lifecycle retains the worktree. |
| F02: dispatch identity drift | The implementation helper pins canonical cwd, workspace, plugin path/version/script hash, Node, session, baseline, and exact job/thread IDs. Unknown launches retain the attempt and lock. |
| F03: resume selects another task | User-selected policy: after source-bound settlement, start a fresh thread with the previous attempt linked and its context supplied. Neither resume flag is used. |
| F04: requested configuration mistaken for effective configuration | Requested settings are recorded separately. Launcher effort admission is checked; backend rejection remains failure. Effective settings stay unknown when the host does not expose them. |
| F05: all design decisions precede investigation | Read-only Codex investigation can inform design. Implementation may choose local details inside the approved behavior, scope, and compatibility constraints. |
| F06: recorded statuses mistaken for completion | Required criterion IDs must each have an evidence-backed PASS, alongside independent verification and source-bound task/process settlement. Attempts are bounded; unknown termination retains the writer lock. |
| F07: oversized native entrypoint | Thin Codex and Claude entries route to one shared workflow and stage-specific contracts. Controller evidence reads are allowed as needed. |
| F08: parallelism and repeated testing | Native sibling/slot/writer limits remain. Independent tasks can be dispatched within available slots; validation is repeated for changed code, failures, or unresolved concerns. |

## Context bundle

The source from `origin/dev` commit
`53c90c1c506770489fb25dac23b8ee127dc354a0` is integrated without replacing the
native babysit changes. The skill retains default discovery and one authoritative
`HANDOFF.md`. It now covers loaded-skill path resolution, host-dependent delivery,
main-conversation collection, active/unknown tasks, stable results, existing
authorization, and gaps that block only their dependent actions.

The existing builder retains its byte manifest, no-overwrite publication,
symlink rejection, and independent extraction check. It does not infer whether
the handoff is complete or a live writer has finished.

## Verification boundaries

- The implementation fixtures use a fake companion and disposable Git repos.
  They cover cwd/script/job drift, empty launches, active results, unconfirmed
  cancellation, fresh continuation, effort errors, required failures, source
  drift, and attempt budgets. They do not call a model.
- The locally inspected companion is version `1.0.6`. Its completed task payload
  does not expose effective model/effort, and cancellation can mark a job ended
  without proving the server turn stopped. Unknown states remain explicit.
- Real Claude/Codex behavior, backend selection, installation migration, timer
  deployment, and live PR publication remain separate validation work. Offline
  checks do not establish those outcomes.
- Controller assertions about process termination and test evidence still need
  actual observations. The helper checks bindings and completeness, not truth.

Run the commands in [AGENTS.md](../AGENTS.md). Runtime details and recovery
limits are in the [implementation contract](../skills/codex-implementation/references/runtime.md)
and [runner operations](../runners/babysit-auto/README.md).
