# PR babysitting

The workflow prepares pull requests for independent acceptance and advances
eligible stacked changes while preserving evidence for each exact revision.

## Language

**Review identity**:
The repository, PR, head, base, selected specification, and policy version
that identify one review. A change to any of them requires fresh acceptance.

**Checkpoint**:
An independent selection, judgment, or verification of assigned evidence.
Its conclusion may accept a change, request correction, or require more review.

**Native adapter**:
The host-specific skill entrypoint that starts and observes native children.
Codex and Claude share the workflow and evidence contracts; the adapter does
not launch the other runtime.

**Worktree ownership record**:
Creation-time repository, PR, run, path, and starting revision bound to a linked
worktree. It identifies whose lifecycle must be checked before removal.

**Recovery ref**:
A private Git ref preserving a worktree's current HEAD independently of a
remote merge. Storage checks do not prove task termination or merge state.

**Checkpoint subject**:
The revisions and review identities a checkpoint examines. Spec selection
precedes a review identity; composition distinguishes parent and child identities.

**Evidence admission**:
Establishing that a completed result is structurally valid, belongs to its
assignment, and has intact inputs. Admission does not make its conclusion ACCEPT.

**Observation**:
PR facts collected for one evaluation, including the observed revisions,
reactions, comments, threads, and previously recorded external-review state.

**Posting receipt**:
A confirmed GitHub result identifying the trigger comment that was created.
An attempted write with an unknown outcome is not a posting receipt.

**External-review decision**:
The next action and retry state derived from an observation and repository policy.

**Status marker**:
The durable review identity and external-review state carried by the PR's
status comment. Live GitHub observations take precedence over recorded state.
