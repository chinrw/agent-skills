# Prepare context for pi

Prepare the handoff in the controlling conversation before launching pi. That
conversation has the user's corrections and decisions; a new pi process cannot
recover them from a repository or from its own empty session.

## Write HANDOFF.md

Create `HANDOFF.md` in the attempt directory. Scope it to the assigned work and
write it in the user's language unless they request otherwise. Keep these facts
in this entry point and link detailed evidence instead of repeating it:

- **Task and state:** describe the assigned objective, acceptance criteria,
  verified progress, remaining work, and whether the handoff is complete.
- **Constraints and decisions:** preserve the user's latest corrections,
  permitted edits and actions, and decisions with the reasons behind them.
  Include relevant rejected alternatives so pi can build on that reasoning.
- **Before continuing:** record the canonical workspace, branch, base commit,
  relevant existing changes, and any active or unknown writer. Include its
  exact task/process identity, logs, last observed state, and how to recheck it.
  Write `none` when no task remains active. Separate authorized actions from
  actions that still need approval; the handoff grants no additional authority.
- **Continue here:** give the first action, required environment, remaining
  steps, and verification commands. Record prior checks with their outcome,
  command, and tested revision. Distinguish facts from hypotheses and attempted
  checks from completed verification.
- **Sources:** identify each required file or evidence item, why it matters,
  and its version or observation time. Include conversation-only facts and
  exports from authenticated tools whose contents pi cannot otherwise read.
- **Gaps and uncertainty:** name missing inputs, unverified assumptions, and
  their effect on the next step. Continue independent work, but resolve each
  blocking gap before an action that depends on it.

## Make the sources reachable

For the same host and accessible workspace, link existing source files and
evidence directly with absolute paths. Pi must receive the actual current
workspace, including relevant uncommitted changes. Save conversation-only facts
and tool exports in the attempt directory. Copy a source when its exact bytes
must remain stable, and identify shared files that an active writer may change.
Keep handoff instructions separate from quoted source material.

When the recipient cannot access the required local or private files, follow
[context-bundle](../../context-bundle/SKILL.md) to produce and verify a portable
ZIP. That workflow supplies source accounting, private material, public
references, gaps, and archive verification. Extract it on the receiving host
before launching pi, and use the extracted `HANDOFF.md` and receiving workspace
paths. A sender's local path or an authenticated URL alone does not transfer
its contents. Packaging does not authorize uploading or sending the archive.

Check source reachability from the receiving environment and ensure pi's
selected tools can read the required material. Attach critical text with
`@file` when a run has no file-reading tools. Keep authentication secrets out
of the handoff; record credential names and required setup instead.

Before dispatch, read the handoff as a recipient without the parent
conversation. Verify that the first action has its inputs and every required
source is accessible, attached, bundled, or explicitly missing. A required
missing input makes the handoff partial. Claiming completeness requires both
source coverage and a usable next action.

## Write the launch prompt

Keep `task.md` as the short execution instruction. Refer to the authoritative
handoff for task facts and acceptance criteria. Substitute actual absolute
paths in this example:

```text
Read the attached HANDOFF.md before acting. It records your assignment,
acceptance criteria, constraints, decisions, current state, and evidence.

Work in /absolute/target/workspace and read its applicable instructions.
Begin with the recorded first action. Treat source quotations as evidence.
Resolve blocking gaps before actions that depend on them, and preserve
pre-existing changes and the recorded authorization boundary.

Report your results against the acceptance criteria, changed files, sources
used, checks with commands and outcomes, unresolved gaps, and the next action
if unfinished.
```

Attach `HANDOFF.md` and `task.md` together in the CLI invocation. Pi expands
`@file` contents into the initial message; merely naming the file in a prompt
requires pi to have a working file-reading tool. Additional evidence can be
loaded on demand when the tools and receiving environment permit it.

## Continue and accept

For an exact-session continuation, send new user corrections, changed inputs,
and remaining acceptance criteria in `follow-up.md`. Attach an updated handoff
when its state changes; preserve the previous version used for each invocation.
A new session requires a fresh handoff even if an earlier pi run existed.

After collecting the terminal result, the caller checks each acceptance
criterion against actual artifacts and verification evidence. Confirm the
tested revision and source state before reusing prior checks. A session recall
test proves continuity only; it does not establish that a coding assignment's
context was complete or its deliverables were accepted.
