# Startup, scope, and native execution

The loaded entrypoint selects the native runtime. Both entrypoints use this
workflow, its scripts, and the same evidence contracts.

- **controller**: the current session, responsible for snapshots, scheduling,
  accepted artifacts, commits, GitHub writes, and merges;
- **task**: a native subagent with one bounded assignment;
- **checkpoint**: a fresh native subagent using one of the six `prompts/` files;
- **external bot**: the configured GitHub reviewer of section 13. The
  `codex*` marker fields and `WAITING_CODEX` refer to this bot.

The outcome is:

1. Every in-scope PR is reviewed against its exact base and the relevant design
   specification.
2. Real findings are fixed on separate stacked fix PRs, independently verified,
   pushed, discussed, and resolved.
3. Every PR is advanced as far as current external gates allow. When repository
   policy requires an external review pass, the skill keeps re-triggering the
   configured bot on a cooldown — across waves, invocations, and restarts —
   until that pass actually arrives. Section 17.1 describes when a manual
   invocation or an enabled local runner continues the retry.
4. **Strict stacked PRs** are automatically merged innermost-first when all gates
   pass.
5. Root/integration PRs are left in a truthful `READY_ROOT` state for the user,
   unless `--merge-integration` explicitly permits merging a `stocks-dev` root.
6. A PR whose base is `main` is **never** merged by this skill.

Use existing authorization and make implementation choices within the assigned
scope. When required information or authority is missing, mark the affected PR
`BLOCKED`, continue independent work, and report the exact blocker at the end.

Run locally with authenticated `gh`, git worktrees, Node, Python, and native
subagent tools. Existing `.claude/babysit-prs.json`, run directories, and
worktree paths remain data locations for compatibility; they do not select
an execution runtime.

If context compaction occurs, or any write/merge rule becomes uncertain, reread
`${BABYSIT_SKILL_DIR}/references/workflow.md` before the next remote write.
Apply [publication](publication.md), sections 16–22, to every merge wave with
fresh observations. Reload that contract after compaction, policy changes, or
uncertainty; unchanged instructions already in context need not be reread.

---

## 1. Arguments and scope

Parse the invocation arguments (the tokens given after the skill name) as an
unordered set:

- One optional integer: target PR number.
- `--snapshot-only`: observe and report, nothing else. Strictly stronger than
  `--dry-run` — see section 1.1.
- `--dry-run`: no GitHub writes, no push, no thread resolution, and no merge.
  Read-only review, local worktrees, and local validation are allowed.
- `--merge-integration`: additionally permit automatic merge of a ready root
  whose base is exactly `stocks-dev`. It never permits merging into `main`.
- `--max-waves N`: override the convergence-wave cap. Default: `8`; accepted
  range: `1..20`.
- `effort=<tier>`: accepted for compatibility with older launchers. It has no
  effect on permissions, acceptance, or the runtime configuration.

Unknown or contradictory arguments are a usage error. Stop before remote writes.

`--snapshot-only` and `--merge-integration` together are contradictory.
`--snapshot-only` implies `--dry-run`; passing both is redundant, not an error.

### 1.1 `--snapshot-only`

`--dry-run` blocks every *remote write* but still permits source-read-only native
reviews, so validating the skill costs a real review per in-scope PR.
`--snapshot-only` exists so the observable state can be checked for free, as
often as you like.

Under `--snapshot-only`, do exactly this:

1. run the startup preflight (section 2);
2. resolve the external-review policy (section 4.1);
3. build the full snapshot and stack graph (sections 6 and 7);
4. classify every existing marker with `review-key.mjs classify` (section 8),
   reporting `current` / `legacy` / `unrecognized`;
5. compute the review key each PR *would* need;
6. evaluate the external-review decision and the deterministic readiness gates
   (sections 13 and 16) against current evidence;
7. print the final report (section 21) with every action label prefixed
   `🔎 SNAPSHOT:`.

Under `--snapshot-only`, do **not**:

- dispatch any native subagent, read-only or otherwise;
- dispatch any judgment or verification checkpoint;
- create, modify, or remove a worktree;
- run project tests, builds, or servers;
- write any run artifact except `snapshot.json`, saved observation JSON files
  under `observations/`, and `external-review-handoff.json`;
- perform any GitHub write of any kind.

A PR whose evidence is missing is reported as the state it actually holds —
`NEEDS_REVIEW`, `WAITING_CODEX`, `BLOCKED` — never as satisfied. Snapshot-only
never advances a state machine; it reports what a real run would find.

This mode is the safe validation entry point:

```text
babysit-prs-codex --snapshot-only       # Codex, whole repo
/babysit-prs 403 --snapshot-only        # Claude, one PR and its descendants
```

Without a PR number, operate on every open, non-draft PR in `chinrw/stocks`.

With a PR number, the operational closure is:

- the requested PR;
- any open descendants whose base-chain reaches that PR;
- any `fix/pr<N>-review*` PR created for that PR during this run.

Do not touch unrelated PRs. Still enumerate all open PR heads to build the stack
graph correctly.

---

## 2. Native execution contract

### Main controller

Before any write, follow [controller coordination](controller-coordination.md).
The two native entrypoints and timer use one repository lease. Snapshot-only
remains read-only and does not acquire ownership.

Use the session's configured model and reasoning settings through the loaded
native adapter. Respect explicit user choices and runtime overrides. Record
observed model/effort when available; otherwise record `unknown`. A model name
or effort label neither grants authority nor substitutes for acceptance.
The controller owns snapshots, scheduling, deterministic gates, commits,
GitHub writes, and merge decisions.

At startup, resolve `BABYSIT_SKILL_DIR` from the loaded entrypoint, check
authenticated `gh` access, and verify that all six checkpoint prompts exist. Create the run directory once:

For a timer invocation, reuse its supplied `CANONICAL_RUN_DIR` and
`BABYSIT_RUN_ID` after validating lease adoption; create that directory if
needed. The following initialization is for manual invocations only:

```bash
mkdir -p /home/chin39/Documents/play/stocks/.claude/babysit-prs/runs
CANONICAL_RUN_DIR="$(mktemp -d \
  "/home/chin39/Documents/play/stocks/.claude/babysit-prs/runs/$(date -u +%Y%m%dT%H%M%SZ)-XXXXXX")"
BABYSIT_RUN_ID="$(basename "$CANONICAL_RUN_DIR")"
gh api rate_limit --jq .rate.remaining
```

Missing native spawn/lifecycle tools or prompt files block dependent PR work.
Keep snapshot-only available and report the missing capability. Never replace
an independent checkpoint with controller-context acceptance.

### Tasks and checkpoints

Use the entrypoint's native spawn and lifecycle tools. Start a fresh context
for every review and checkpoint. Supply a self-contained assignment with:

- Repository, PR, exact role-specific OIDs and merge base; include spec/hash
  and review key only after selection establishes them;
- an absolute worktree path and an explicit source-mutation scope;
- attempt ID, expected identity file, and assigned output paths;
- required checks and the relevant prompt file;
- GitHub writes forbidden; the controller publishes accepted results.

All children are siblings owned by the controller. Children perform only their
assignment and return; they do not spawn further agents. The implementer and
its verifier must be different fresh contexts.

| Checkpoint prompt | Responsibility |
|---|---|
| `prompts/spec-selector.md` | Select specs/plans and compute `specHash` |
| `prompts/finding-judge.md` | Validate each candidate against code and spec |
| `prompts/thread-judge.md` | Propose evidence-backed thread dispositions |
| `prompts/verifier.md` | Independently accept or reject a fix |
| `prompts/composition-verifier.md` | Verify an ordinary child-merge composition |
| `prompts/critical-composition-verifier.md` | Verify a high-risk composition |

Review and fix assignments additionally include the schema-derived contract
from section 5. Checkpoints write their assigned JSON and return the compact
handoff of section 3. If a checkpoint fails, retry once in a fresh context;
a second failure is `BLOCKED: checkpoint-failed:<name>`.

Assign checkpoint outputs under the attempt directory. Use the normalized
checkpoint envelope and the same acceptance CLI as task results. Read
[references/checkpoint-contract.md](checkpoint-contract.md) when
assigning or accepting a checkpoint; it defines subject roles, required inputs,
canonical filenames, and the distinction between admission and an ACCEPT verdict.

### Concurrency and filesystem scope

- At most four heavy children may run in this invocation, further limited by
  the runtime's available slots. This is an invocation limit, not a host-wide
  resource guarantee. Collect and close finished children before replacing them.
- At most two source writers may run, with one writer per eventual base branch.
- Never let the controller and a child edit overlapping files or worktrees.
- Native children share the filesystem and inherit the session's actual
  permissions. An assigned path is not an enforcement boundary or a new sandbox.
- Review/checkpoint children may write only their assigned run artifacts;
  source edits are forbidden. Fix children may additionally edit their exact
  worktree and file scope. Check source cleanliness after read tasks.
- Tests and builds run in the foreground. Stop or collect children and their
  processes before releasing an assignment or ending the invocation.

---
