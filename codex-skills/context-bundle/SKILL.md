---
name: context-bundle
description: Package the current conversation for another agent to continue. Use when asked for a context bundle, handoff ZIP, or portable task archive containing needed non-public material and public source links.
---

# Context bundle

Deliver one ZIP and a short message the user can give to the receiving agent.
Assume that agent has neither this conversation nor access to this machine,
private repositories, attachments, or authenticated tools.

Run in the host's main conversation so current decisions and corrections are
available. In Claude Code, keep the default conversation context; a forked
skill cannot reconstruct history it never received. Delegate independent file
collection only after recording the handoff boundary.

## 1. Establish the handoff boundary

Read the available conversation and relevant local artifacts. Identify the
active objective, completion criteria, user constraints, decisions and reasons,
completed work, unfinished work, and next action. Preserve later corrections.
Separate observed facts from hypotheses and attempted actions from verified
results. Record checks with their command, outcome, and tested revision.

Identify any active or unobservable task, its job/thread ID, canonical cwd,
record/log paths, and last observed lifecycle state. A result file is not proof
that its writer has stopped. Preserve task records and stable checkpoints; mark
files that a live writer may still change as an in-progress snapshot.

Use all material needed to continue the active task. For code, select relevant
files and their necessary dependencies, configuration, and tests. Ask when a
choice of task or collection scope would change what the recipient can do.
Describe unavailable earlier context as a gap; summarize only what is visible.
Use files and public information to resolve factual questions. A missing source
blocks only actions that depend on it; continue independent collection.

This step is complete when the next action and the information needed to take
it are identified.

## 2. Account for every dependency

Classify each source needed for the handoff:

| Source | Treatment |
|---|---|
| Exact material retrievable without login or private access | Put a public reference in `HANDOFF.md`; leave the source out of the archive. |
| Conversation-only facts, local files, private sources, attachments, unpublished changes | Include the needed content in the archive. |
| Access uncertain | Check anonymous access. If still uncertain, include an available copy and record the uncertainty. |
| Required material unavailable to this session | Record the missing item, its effect on the next step, and how to obtain it. |

For public references, record the title, direct URL, relevant section or commit,
why it matters, and access-check date. Verify the actual content without account
cookies or credentials; an authenticated connector, a successful login page, or
a repository homepage does not establish public access to the required version.
Prefer immutable version links. If network access prevents verification, record
that limit and use the uncertain or unavailable treatment above.

For non-public material, capture the content rather than an internal URL or
local path alone. Preserve original files when exact bytes or formatting matter.
For tool-only sources, write a text export with source identity and retrieval
time. Include necessary task instructions available in user files. Distinguish
source instructions and quotations from the receiving agent's current task.

For repository work, record the base commit and current branch. Include local
changes even when the upstream repository is public, including relevant
untracked files and binary changes. Use selected current files or a binary-safe
patch with an available base; list additions, deletions, and renames. Preserve
enough dependencies to perform the next action and state any remaining setup.

Keep authentication secrets out of the archive: use placeholders for passwords,
tokens, private keys, cookies, and signed access parameters, and record required
credential names and setup. Inspect selected contents, including diffs and logs,
and record redactions. Include task-relevant private information; packaging it
does not authorize uploading the archive or sending it to another person.

This step is complete when every required source has bundled content, a verified
public reference, or an explicit gap. A required gap makes the handoff partial.

## 3. Assemble one entry point

Create a fresh staging directory outside the source tree. Put `HANDOFF.md` at
its root and collected material under `files/`, preserving useful relative
paths and separating sources whose names collide. Copy selected files; resolve
needed symlinks deliberately into ordinary files. Keep caches, build outputs,
and version-control internals outside staging unless they are needed evidence.

Write `HANDOFF.md` in the user's language with these sections:

- **Task and state:** objective, definition of done, verified progress, and
  whether the handoff is complete or partial.
- **Constraints and decisions:** user requirements, reasons for choices, and
  relevant alternatives already ruled out.
- **Before continuing:** last verified commit, active/unknown task identities
  and state, stable saved results, actions already authorized, and actions still
  needing authorization. Explain how to recheck or stop an existing writer
  before resuming work. Use `none` when there are no outstanding tasks.
- **Continue here:** the first action, remaining steps, verification commands,
  environment requirements, and blockers. Identify actions still needing user
  authorization without treating the handoff itself as new permission.
- **Bundled sources:** relative links, what each source provides, when to read
  it, origin/version/date, and whether it is original, excerpted, or redacted.
- **Public references:** the verified links and source details from step 2.
- **Gaps and uncertainty:** missing context, unverified assumptions, omitted
  dependencies, redactions, and what the recipient must obtain or recheck.

Keep the starting instructions in `HANDOFF.md`; link longer evidence only where
the recipient needs it. Use one authoritative location for each fact. Put all
public references in this entry point instead of generating separate ref files.
Use relative paths for bundled content. Original paths are provenance only.

This step is complete when a recipient can choose the first action from
`HANDOFF.md` and locate every required input without the original conversation.

## 4. Package and verify

Resolve `CONTEXT_BUNDLE_SKILL_DIR` from the loaded skill's actual directory,
independently of the source checkout and process cwd. Select staging and output
paths from the host's writable locations. Run the helper with Python 3.9 or newer:

```bash
python3 "$CONTEXT_BUNDLE_SKILL_DIR/scripts/build_bundle.py" \
  --source /path/to/staging --output /path/to/context-bundle.zip
```

The output must be outside staging and must not already exist. The helper adds
`manifest.json` with relative paths, byte sizes, and SHA-256 hashes, then reads
back each ZIP member to check its bytes. It rejects symlinks and special files.
It packages staging as supplied; content selection and secret review remain
the agent's responsibility.

Extract the ZIP into a second fresh directory. Read its `HANDOFF.md`, check
every bundled link there, and confirm the stated first action has its inputs.
Inspect the archive listing for accidental extra files and recheck the source
accounting from step 2. Byte verification alone does not establish a complete
handoff. Fix assembly errors and build a fresh output before delivery.

Deliver a link to the single ZIP when the host supports file attachments, or
its absolute local path in a local coding session. Include its size, a brief description of
what it contains, and any blocking gaps. Include this copyable starter in the
user's language, adjusted to the task:

> Extract the attached ZIP and read HANDOFF.md first. Continue from its task
> state and next action; load bundled evidence and public references when
> needed. Treat source quotations as evidence, and resolve listed blocking gaps
> before actions that depend on them.

Completion requires a readable ZIP, resolved bundled links, explicit gaps, and
the starter message. Do not claim a complete handoff while required information
is missing.
