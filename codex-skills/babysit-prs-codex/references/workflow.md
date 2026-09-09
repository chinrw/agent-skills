# Shared PR babysitting workflow

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
Recheck sections 16–22 before every merge wave.

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

## 3. Context hygiene and run artifacts

Read compact metadata and artifact summaries by default. When a decision needs
more evidence, read the relevant diff, spec, thread, finding, or log excerpt.
Delegate detailed review and implementation; reading an excerpt does not replace
fresh independent verification. Keep large bodies in their artifact files and
include only decisive excerpts in handoffs.

The **canonical run directory** — controller-owned, in the main checkout/run
workspace — is minted once at startup (section 2, `mktemp -d`), together with
`BABYSIT_RUN_ID`:

```text
CANONICAL_RUN_DIR=/home/chin39/Documents/play/stocks/.claude/babysit-prs/runs/${BABYSIT_RUN_ID}/
```

Per-PR artifacts:

```text
pr-<N>/
  snapshot.json
  codex-review.json
  codex-review-risk.json
  judgment.json
  judgment-risk.json
  thread-dispositions.json
  fix-result.json
  verification.json
  composition-verification.json
  mutation-evidence/<findingId>.json
  observations/<source>.json
  external-review-handoff.json
  state.json
  attempts/<attemptId>/
    assignment.json       controller-owned identity, scope, paths, native agent ID
    expected.json         controller-owned expected result identity
    result.json           child-owned result until it completes
    validation.json       controller-owned validation summary
    diagnostics/          rejected output; never acceptance evidence
```

The controller owns accepted artifacts and assignment metadata. Each child
writes only its assigned result paths, which must be writable under the actual
session permissions. If that capability is absent, block the task and report
the path; prompt text cannot grant filesystem access.

Detailed results stay on disk. Children return a compact handoff; the controller
validates files mechanically before promoting them to canonical artifacts.

`external-review-handoff.json` is the run-artifact half of the external-review
state; the GitHub status comment is the durable half. Neither is the sole truth:
after any restart, re-derive both from live GitHub state.

Keep these paths untracked using `.git/info/exclude`; do not modify tracked
`.gitignore` merely for this skill.

Every checkpoint must write its detailed result to the assigned artifact and
return only one line — its final message — in this form:

```text
PR #N | stage=<stage> | state=<state> | blocking=<n> | artifact=<path> | <12-word note>
```

Return concise handoffs with artifact paths. Include a bounded excerpt when
the controller needs it to resolve a decision or diagnose a failure.

### 3.1 Reclaimable worktree predicate

Record ownership immediately after creating a worktree, before dispatching a
child, using `scripts/worktree-guard.mjs register`. Store the record outside the
worktree under `$CANONICAL_RUN_DIR/worktrees/`. The helper captures canonical
path, Git common directory, repository, PR, run, purpose, and starting OID.
Do not create retrospective records for an unknown worktree or infer a PR from
its directory name. Existing worktrees without a record remain residual.

`RECLAIMABLE(<worktree>)` requires all of the following:

1. A creation-time ownership record matches the actual linked worktree and
   repository. Its canonical path is under the configured `.claude/worktrees/`
   root, and it is neither the main checkout nor the current run's checkout.
2. GitHub reports that exact recorded repository/PR as `MERGED`. Recheck the
   PR's `number`, `state`, and `headRefOid`; a branch name or directory suffix
   is not ownership evidence.
3. The controller has observed all tasks and processes using it terminate.
   If ownership overlaps another run or its lifecycle is unobservable, retain
   the worktree. Quiet output and a result file do not prove termination.
4. The worktree has no changes, untracked files, or ignored files. Its current
   HEAD is preserved by `worktree-guard.mjs preserve` in a private Git ref in
   the common repository, and `worktree-guard.mjs check` confirms that exact
   ref still resolves to HEAD immediately before removal.

The helper verifies local identity and recoverability; it neither checks
GitHub nor proves process termination. All four conditions are required.
A clean worktree may contain unpublished commits. A merged PR does not prove
those commits were saved. This repository squash-merges, so commit ancestry
alone is also insufficient. The private ref preserves local commits regardless
of the remote merge strategy and survives `git worktree remove` and Git GC.
Keep that ref until a separate, explicitly authorized retention cleanup.

```bash
node "${BABYSIT_SKILL_DIR}/scripts/worktree-guard.mjs" register \
  --record "$RECORD" --worktree "$WORKTREE" --repo "$REPO" --pr "$PR" \
  --run "$BABYSIT_RUN_ID" --purpose review
# After the controller has verified the merge and collected every task/process:
node "${BABYSIT_SKILL_DIR}/scripts/worktree-guard.mjs" preserve \
  --record "$RECORD" --worktree "$WORKTREE"
node "${BABYSIT_SKILL_DIR}/scripts/worktree-guard.mjs" check \
  --record "$RECORD" --worktree "$WORKTREE" --repo "$REPO" --pr "$PR" \
  --root /home/chin39/Documents/play/stocks/.claude/worktrees \
  --current "$PWD"
```

Exit `0` from `check` establishes only condition 4 and the local parts of
condition 1. A failed or missing check leaves the worktree in place. Never
remove with `--force`, and never remove a worktree while a writer can resume.

### 3.2 Startup worktree sweep

Skip the sweep entirely under `--dry-run` and `--snapshot-only` (section 20).
For other modes, enumerate `git worktree list --porcelain` once at startup.
Match worktrees to existing creation records in the run directories. Retain
unknown paths and records whose owner/task lifecycle cannot be established.
Evaluate section 3.1 for the remaining candidates before removing any.
Report scanned, reclaimed, and retained paths with the unmet condition.


---

## 4. Repository policy — already established for this workflow

- Repository: `chinrw/stocks`
- Remote: `origin`
- Main checkout: `/home/chin39/Documents/play/stocks`
- Default/release branch: `main`
- Integration branch: `stocks-dev`
- `stocks-dev -> main` is a human-gated release promotion.
- Other known branch/worktree port reservations:
  - main checkout: `5001`
  - `stocks-dev`: `5002`
  - `stocks-rust`: `5006`
- Static review normally needs no server.
- Never bind ports `5002` or `5006`.
- If a server is indispensable in an ephemeral worktree, use a confirmed-free
  port `>=5100`.
- Never run `bun run build`; its `emptyOutDir` can remove shared
  `static/dist` output and break sibling worktrees.
- Run pytest checks with `-n0`; do not trust xdist for this workflow.
- If Rust is touched, select meaningful `cargo fmt --check`, `cargo clippy`,
  and `cargo test` commands appropriate to the changed scope.
- Hot reload is enabled; do not restart servers by habit.
- CI workflow: `CI`, workflow id `296221856`.
- The workflow filters pull requests by base branch:
  `main`, `stocks-dev`, and `stocks-rust`.
- A PR based on another feature branch can legitimately have no GitHub CI; such
  a PR requires recorded local gates before readiness.
- Design specs and plans are intended-behavior ground truth:
  - `docs/superpowers/specs/`
  - `docs/superpowers/plans/`
- Specs explicitly document intentional divergences. A spec-sanctioned
  divergence is not a finding. Only a contradiction is actionable.
- Commits created by this workflow must use the repository's normal author and
  DCO sign-off (`git commit -s`) and must not add AI attribution.

### 4.1 Effective external-review policy

External review (the `@codex review` bot loop) is **not** hardcoded. It is
expressed as repository policy so this skill stays repository-agnostic.

Resolution order, first hit wins:

1. `<repo-checkout>/.claude/babysit-prs.json`
2. built-in defaults

Schema, with the built-in defaults shown:

```json
{
  "externalReview": {
    "enabled": false,
    "botLogin": null,
    "triggerComment": null,
    "passReaction": "+1",
    "reactionTarget": "pr-body",
    "rootMode": "disabled",
    "strictStackedMode": "disabled",
    "retry": {
      "enabled": false,
      "intervalSeconds": 1800,
      "maxRoundsPerInvocation": 2,
      "maxTotalRounds": null,
      "minCollisionDelaySeconds": 60
    }
  }
}
```

Mode semantics:

| Mode | Meaning |
|---|---|
| `fresh-pass-retry` | Only a **fresh pass reaction on the PR body** satisfies the gate. Retry on a fixed cooldown, with no total round cap, until pass, close/merge, an unrecoverable block, or the user stops it. |
| `one-round` | One current-head round plus disposed threads satisfies the gate. Continued bot silence does not block. |
| `disabled` | Never query the bot, never trigger, never gate on it. |

- `maxTotalRounds: null` means **unlimited across invocations**.
- `maxRoundsPerInvocation` bounds a single invocation only. It is never a
  total round cap and never marks a PR satisfied.
- `minCollisionDelaySeconds` is the floor between two triggers when a
  disposition round earns an immediate re-review.

**Default is conservative.** A repository with no policy file has external
review disabled: no bot query, no trigger, and no external-review gate. Only an
explicitly configured repository runs the bot loop.

Resolve and validate the policy once at startup:

```bash
python3 "${BABYSIT_SKILL_DIR}/scripts/external_review.py" resolve-policy \
  --input "<repo-checkout>/.claude/babysit-prs.json"
```

A non-empty `errors` array is a configuration blocker. Mark affected PRs
`BLOCKED: external-review-policy` and do not guess a bot login or trigger text.

### 4.2 `chinrw/stocks` effective policy

`/home/chin39/Documents/play/stocks/.claude/babysit-prs.json`:

```json
{
  "externalReview": {
    "enabled": true,
    "botLogin": "chatgpt-codex-connector[bot]",
    "triggerComment": "@codex review",
    "passReaction": "+1",
    "reactionTarget": "pr-body",
    "rootMode": "fresh-pass-retry",
    "strictStackedMode": "one-round",
    "retry": {
      "enabled": true,
      "intervalSeconds": 1800,
      "maxRoundsPerInvocation": 2,
      "maxTotalRounds": null,
      "minCollisionDelaySeconds": 60
    }
  }
}
```

The 1800-second cooldown limits retries across invocations (section 17.1).

---

## 5. Native task results

### 5.1 Assignment and lifecycle

Before spawning a task, write its immutable identity and scope to
`attempts/<attemptId>/assignment.json` and the six expected identity fields to
`expected.json`: `taskType`, `attemptId`, `pr`, `headOid`, `baseOid`, `reviewKey`.
Use a new attempt ID and unused result path for every attempt. Record the native
agent ID immediately after spawning; wait, message, and stop using that ID.

The controller takes completion status from the native lifecycle tool, never
from a child's artifact or a quiet terminal. Record running, completed, failed,
cancelled, and unobservable separately. Before retrying, stop the prior child
and confirm it has terminated. If termination cannot be confirmed, block that
assignment rather than launch a second writer.

### 5.2 Structured results

Review, risk-review, diagnosis, fix, and mutation tasks write JSON to their
assigned `result.json`, using `schemas/codex-artifact-v1.schema.json`. Generate
the contract from that schema and include it in the native assignment:

```bash
node "${BABYSIT_SKILL_DIR}/scripts/validate-artifact.mjs" contract --task-type review
```

The schema defines allowed keys, severity values, per-finding identity, and fix
nesting. Each task echoes the expected identity exactly. A count without the
complete findings is not evidence; `resultCompleteness` must be `complete`.
Source policy and artifact writes are separate: reviews cannot edit source,
but can write their assigned result under the session's existing permissions.

### 5.3 Accepting a result

After the native tool reports completion, validate and atomically publish:

```bash
node "${BABYSIT_SKILL_DIR}/scripts/validate-artifact.mjs" \
  --input "$ART/attempts/$ATTEMPT/result.json" \
  --expect "$ART/attempts/$ATTEMPT/expected.json" \
  --status completed \
  --out "$ART/codex-review.json"
```

Exit `0` means schema, identity, completeness, and each finding's identity all
passed. The output includes a canonical JSON SHA-256 and compact counts; full
findings remain in the file. Exit `1` rejects the result without replacing prior
canonical evidence. Exit `2` is a usage or I/O error, not acceptance. Run the
source-clean check for read tasks before allowing judgment or remote writes.

Only the controller supplies `--status completed`, after observing native
completion. A file written by a running or failed task cannot authorize work.
Hash JSON with `canonicalHash` from `scripts/lib/json-io.mjs`; raw file-byte
hashes differ when formatting changes.

### 5.4 Incomplete results

Missing, malformed, partial, stale, and count-only outputs are
`REVIEW_INCONCLUSIVE`, never zero findings. Preserve the assignment and rejected
result under the attempt directory. Neither diagnostics nor summary counts may
create a blocker, GitHub comment, fix task, or acceptance.

After confirming the old task has stopped, allow exactly one fresh attempt from
the exact head/base with a new attempt ID and result path. If that result is
also incomplete, set `BLOCKED: codex-output-incomplete`. Checkpoints likewise
get one fresh retry. Never infer success from `blocking=0` alone.

### 5.5 Temporary probes never live in the repository

Any temporary Python, Node, shell, SQL, or data probe written by a judgment or
verification step goes in a temporary directory, not the repository:

```bash
PROBE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/babysit-prs-probe.XXXXXX")"
trap 'rm -rf "$PROBE_DIR"' EXIT
```

- helper scripts go under `$PROBE_DIR`;
- import project code with `PYTHONPATH`, an explicit cwd, or equivalent — never
  by copying the probe into the source tree;
- disposable source mutation happens only in a disposable worktree;
- after every judge/verifier task, verify no unexpected untracked file appeared:

  ```bash
  node "${BABYSIT_SKILL_DIR}/scripts/check-source-clean.mjs" \
    --worktree "$WORKTREE" --expected-head "$HEAD_OID"
  ```

- cleanup failure is reported as residual risk and blocks publishing when source
  cleanliness cannot be established.

---

## 6. Strict stack graph

Build the graph from **all** open non-draft PRs.

For PR `P`, define its parent as the unique open PR `Q` for which:

```text
P.baseRefName == Q.headRefName
```

Definitions:

- **strict stacked PR**: a PR with such a parent;
- **root PR**: no open PR has a head branch equal to its base branch;
- **child**: an open PR whose base branch equals this PR's head branch;
- **leaf**: no open child;
- **integration root**: a root whose base is `stocks-dev`;
- **release root**: a root whose base is `main`.

Block automatic action for a connected component when the graph has:

- a cycle;
- duplicate open PRs with the same head branch;
- an inaccessible fork head/base needed for exact verification;
- ambiguous parent identity;
- a base or head that changes while the snapshot is being constructed.

Default merge authority:

- strict stacked leaf: auto-merge when `READY_STACKED`;
- integration root (`base=stocks-dev`): prepare to `READY_ROOT`; merge only with
  `--merge-integration`;
- release root (`base=main`): prepare to `READY_ROOT`; never merge;
- any other root: prepare to `READY_ROOT`; do not merge automatically.

A babysitter fix PR whose base is the reviewed PR's head branch is a strict
stacked PR.

---

## 7. Snapshot contract

At the start of every wave, fetch a fresh snapshot and save it as JSON. Include:

- PR number, title, URL, author, draft state;
- head ref and `headRefOid`;
- base ref and `baseRefOid`;
- latest head commit timestamp;
- parent PR, child PRs, graph depth, leaf/root/type;
- `mergeable`, `mergeStateStatus`, and `reviewDecision`;
- `statusCheckRollup`;
- unresolved review-thread count and first-comment author login for each thread;
- existing babysitter status-comment ID and parsed marker fields, including all
  persisted external-review fields;
- PR-body reactions from `repos/<repo>/issues/<N>/reactions` (paginated);
- every issue comment whose trimmed body equals the configured
  `triggerComment` exactly, with `createdAt` and author;
- the latest configured-bot activity timestamp (reaction, review, or comment);
- unresolved review threads authored by the configured bot;
- matching spec/plan paths and `specHash`;
- computed `reviewKey`;
- current classification state;
- observed controller model/effort (section 2), or `unknown`.

Fetch thread bodies in the judgment checkpoint by default. The controller may
read relevant excerpts when needed under section 3.

Use GraphQL where needed for `baseRefOid`, review threads, and merge status.
Treat GitHub as the source of truth after any process restart.

---

## 8. Review identity v2 and the single status comment

A head-only marker is insufficient because a stacked PR's base can advance.

For each PR, identify the relevant spec and plan in a fresh review worktree:

1. Match branch/title phase names to files under the spec and plan directories.
2. Confirm the match against changed paths.
3. If no match is unambiguous, use `specPaths=[]` and `specHash=none`; never
   choose a plausible but wrong spec.
4. Hash the sorted path names and file contents.

Compute the review key with the **single deterministic helper**. Never
reconstruct the byte string by hand, in a prompt, or in an agent:

```bash
node "${BABYSIT_SKILL_DIR}/scripts/review-key.mjs" \
  --repo "$REPO" --pr "$PR" \
  --head "$HEAD_OID" --base "$BASE_OID" --spec "$SPEC_HASH"
```

Snapshot, marker, controller, judge, and migration code all call this one
implementation. `--debug` prints the field values, payload hex, trailing-NUL
status, and the resulting key; it never prints file contents or credentials.

The **v2 byte contract**, pinned and covered by an executable compatibility
vector:

```js
const fields = [
  policyVersion,          // "babysit-prs-v2"
  canonicalRepo,          // GitHub nameWithOwner, case preserved
  String(prNumber),       // decimal, no sign, no padding, no whitespace
  headOid.toLowerCase(),  // full 40/64 hex; abbreviations rejected
  baseOid.toLowerCase(),
  specHash,               // 64 lowercase hex, or the literal "none"
];

const payload = Buffer.from(fields.join("\0"), "utf8");
// UTF-8. Exactly one NUL between adjacent fields.
// No leading NUL, NO TRAILING NUL, and no final newline.
const key = createHash("sha256").update(payload).digest("hex");
```

v2 has **no** `policyHash` field. Passing one is an error, not an extension:
adding a field under an unchanged marker version would silently invalidate every
accepted marker in the wild. A future contract change mints a new version string
and an explicit migration.

Deployed compatibility vector (verified read-only against the live accepted
marker on `chinrw/stocks` PR #379, `state=READY_ROOT`):

```text
policyVersion babysit-prs-v2
repo          chinrw/stocks
pr            379
head          e363a839522e4960d372ce42125cce05c6a64e82
base          7f1bc449f10686a1d013121c81c2c44e65a9637f
spec          none
payloadLength 119   trailingNul=false
key           90eb74228b4dd711956acd443b74c215d2212192b8ddabc57e499037e8ab0681
```

Full vectors, including the *rejected* trailing-NUL and final-newline variants,
live in `tests/fixtures/review-key-vectors.json`.

#### Legacy marker dialects — recognize, never accept

A read-only survey of live `chinrw/stocks` markers found the `v2` version string
used for **three mutually incompatible byte contracts**:

| PR | OIDs in the marker | `spec=` form | trailing NUL |
|---|---|---|---|
| 379 | full | `none` | no — **active contract** |
| 401, 402 | abbreviated (8 hex) | `none` | yes |
| 373 | full | `sha256:<hex>` prefixed | yes |

The active contract is not changed to accommodate them. Instead they are
*recognized* as the named legacy dialect `v2-legacy-trailing-nul`, so a legacy
marker is never mistaken for corruption — and never counts as acceptance:

```bash
node "${BABYSIT_SKILL_DIR}/scripts/review-key.mjs" classify \
  --repo "$REPO" --pr "$PR" \
  --marker-key "$MARKER_KEY" --marker-head "$MARKER_HEAD" \
  --marker-base "$MARKER_BASE" --marker-spec "$MARKER_SPEC" \
  --head "$LIVE_HEAD_OID" --base "$LIVE_BASE_OID" --spec "$LIVE_SPEC_HASH"
```

Exit `0` current, `1` recognized legacy, `3` unrecognized.

Only exit `0` proves review-current. A legacy or unrecognized marker means
`NEEDS_REVIEW`: run the full pipeline and rewrite the marker under the active
contract. Do not "repair" a legacy marker by copying its old key forward.

Practical consequence today: PR 379's acceptance survives; the markers on PRs
373, 401, and 402 do not, and those PRs will be reviewed again before any gate
treats them as ready.

Maintain one update-in-place status comment per PR. Its first line must be:

```html
<!-- babysit-prs:v2 pr=<N> head=<HEAD> base=<BASE> spec=<SPEC_HASH> key=<REVIEW_KEY> state=<STATE> codex=<CODEX_STATE> codexRound=<N> codexNextTriggerAt=<UTC-ISO-8601> -->
```

This comment is the **durable external-review state**. It survives waves,
invocations, and controller restarts, so it must carry the full retry state,
not just a summary. Persist all of:

```text
codexHeadOid
codexMode
codexState
codexRound
codexLastTriggerAt
codexNextTriggerAt
codexLastBotActivityAt
codexLatestPassReactionAt
codexLastDispositionCompletedAt
```

Every timestamp is UTC ISO-8601 (`YYYY-MM-DDTHH:MM:SSZ`). GitHub live state is
the source of truth; these fields are a cache and a cross-session handshake.
When live comments/reactions disagree with the marker, the live values win and
the marker is corrected.

Suggested body:

```markdown
### babysit-prs

- Review key: `<short-key>`
- State: `<STATE>`
- Exact diff: `<base-short>..<head-short>`
- Spec/plan: `<paths or none>`
- Review: `<verified / changes requested / blocked>`
- Fix PR: `<url or none>`
- Local gates: `<summary>`
- External review: `<codexState>` round `<codexRound>` for head `<codexHeadOid-short>`
- Last trigger: `<codexLastTriggerAt or none>`
- Next retry: `<codexNextTriggerAt or n/a>`
- Latest pass reaction: `<codexLatestPassReactionAt or none>`
- Updated: `<UTC timestamp>`
```

Find this comment by the stable prefix
`<!-- babysit-prs:v2 pr=<N> `. Update it by comment ID; do not create a new
summary comment each wave.

A marker is current only when all of `head`, `base`, `spec`, and `key` match the
fresh snapshot, `review-key.mjs classify` returns the active contract, and its
state represents accepted review evidence. Write full lowercase OIDs and a bare
`specHash` (or `none`) into every new marker — never abbreviations and never a
`sha256:` prefix.

Any change to head OID, base OID, spec hash, or policy version invalidates the
old acceptance.

Legacy `<!-- babysit-prs reviewed:<head> -->` markers are migration hints only;
they do not prove v2 readiness.

---

## 9. State machine

Use only these states:

```text
DISCOVERED
NEEDS_REVIEW
REVIEWING
NEEDS_FIX
FIXING
NEEDS_VERIFICATION
WAITING_THREADS
WAITING_CODEX
WAITING_CI
READY_STACKED
READY_ROOT
MERGING
MERGED
BLOCKED
```

Transition rules are evidence-based:

- no current v2 acceptance -> `NEEDS_REVIEW`, unless composition verification
  is provably applicable;
- current acceptance + unresolved threads -> `WAITING_THREADS`;
- confirmed actionable findings -> `NEEDS_FIX`;
- fix commit exists but no fresh independent acceptance -> `NEEDS_VERIFICATION`;
- review/thread/local gates satisfied but the external-review gate is
  unsatisfied for the current head -> `WAITING_CODEX`;
- all non-CI gates satisfied but CI incomplete -> `WAITING_CI`;
- all gates satisfied and strict stacked leaf -> `READY_STACKED`;
- all gates satisfied and root -> `READY_ROOT`;
- irreconcilable ambiguity, capability failure, external required approval, or
  exhausted retry ladder -> `BLOCKED`.

`WAITING_CODEX` is the only state for an unsatisfied external-review gate. In
particular:

- bot silence is always `WAITING_CODEX`, never satisfied, and never `BLOCKED`;
- an elapsed invocation budget, a wave cap, or the no-progress limit ends the
  invocation while the PR stays `WAITING_CODEX` with a live `codexNextTriggerAt`;
- only a closed/merged PR, an unrecoverable head/base/scope block, or an
  explicit user stop ends the retry loop.

No LLM statement may bypass a deterministic gate.

---

## 10. Full review pipeline

Run this when the v2 review identity is not current and composition verification
does not apply.

### 10.1 Create an exact read worktree

Fetch the exact PR head and base OIDs. Create a detached worktree under
`.claude/worktrees/` at the exact head and register its ownership (section 3.1).
Do not review a moving branch name.

The review range is the **three-dot** range, i.e. what this PR actually authors:

```text
<baseRefOid>...<headRefOid>      # == mergeBase(base, head)..head
```

Never assume `main`.

`baseRefOid` is the *current tip* of the base branch, which is almost never the
merge base — a long-lived base like `stocks-dev` advances continuously while a
branch is open. The two-dot range `<baseRefOid>..<headRefOid>` therefore reports
every file the base advanced independently, and attributing that drift to this
PR is a review-scoping error, not a cosmetic one. Observed on a live run: PRs
363/366/373/377 each showed 32-34 changed files two-dot, versus 1-3 files
three-dot. A review scoped two-dot would have reported findings against
unrelated frontend work — and, worse, the spec selector would have bound to
spec files that arrived from base drift rather than from the PR.

Resolve and record the merge base explicitly, and pass it to every downstream
consumer (spec selector, native review prompt, verifier):

```bash
MERGE_BASE="$(git -C "$WORKTREE" merge-base "$BASE_OID" "$HEAD_OID")"
git -C "$WORKTREE" diff --name-only "$MERGE_BASE".."$HEAD_OID"
```

The review **key** still binds `baseRefOid`, not the merge base — an advancing
base must invalidate acceptance (section 8). Scope and identity are deliberately
different things: identity tracks the base tip, scope tracks authorship.

### 10.2 Discover and hash intended-behavior documents

Run a fresh `spec-selector` checkpoint (section 2) from the read worktree. It
reads the branch/title, changed-file list, and candidate spec/plan names to
select the relevant documents and calculate `specHash`. It must not form
findings yet.

### 10.3 Native deep review

Spawn one fresh review subagent, assigned the exact read worktree, three-dot
range, selected specs, expected identity, and generated artifact contract
(section 5.2). Forbid source mutation and GitHub writes. Require traceable,
actionable findings; exclude style nits and spec-sanctioned divergences.

Validate its completed result with section 5.3 and publish `codex-review.json`.
An incomplete result follows section 5.4. A claim that a test does not cover the
behavior must set `requiresMutationEvidence: true` (section 10.5).

For security, authentication, authorization, data integrity, concurrency,
migration, financial correctness, or resilience/breaker changes, allow one
additional fresh `risk-review` subagent into `codex-review-risk.json`.
Mechanical changes get one pass.

### 10.4 Fresh finding judge

Run a fresh `finding-judge` checkpoint (section 2). It produces the proposed
inline findings; the controller owns publication.

Candidates are accepted **only** from an accepted, schema-valid
`CANONICAL_ARTIFACT`. If validation did not accept, there are no candidates
— there is an inconclusive review. Count-only telemetry is never a candidate.

The judge is given the exact attempt ID, head/base OIDs, review key, canonical
artifact path and its SHA-256, and any mutation-evidence artifact paths. It must:

1. read the exact spec/plan first;
2. read the candidate review artifact;
3. perform a bounded spot-check of every cited path and execution path;
4. classify each candidate as:
   - `CONFIRMED_BLOCKING`
   - `CONFIRMED_NON_BLOCKING`
   - `FALSE_POSITIVE`
   - `SPEC_SANCTIONED`
   - `NEEDS_HUMAN`
5. merge duplicate findings;
6. write the assigned checkpoint envelope with every disposition in
   `result.findings`;
7. supply only surviving actionable findings with inline locations;
8. return the compact handoff without implementing code or spawning children.

The controller admits the result as `judgment.json`, publishes the surviving
findings, and updates the single v2 status comment. Judge a risk-review artifact
separately as `judgment-risk.json`; include both admitted judgments in the fix
assignment. Confirmed IDs must be unambiguous across the judgments.

Before each GitHub write, recheck current head/base and whether another
babysitter session already posted the same marker/finding. Stand down on
collision.

If no blocking finding survives, record accepted review evidence for the
current review key. If blocking findings survive, transition to `NEEDS_FIX`.

### 10.5 Mutation evidence for test-coverage findings

A candidate whose claim is essentially "the test does not actually cover the
behavior" must **not** be confirmed by reading alone when a safe focused
experiment is possible. Typical claims:

- the test still passes when the claimed production fix is reverted;
- an assertion does not distinguish correct from broken behavior;
- the exercised path bypasses the changed branch entirely.

Before the finding judge may mark such a claim blocking, run the bounded
experiment:

```bash
node "${BABYSIT_SKILL_DIR}/scripts/mutation-evidence.mjs" run \
  --worktree "$DISPOSABLE_WORKTREE" \
  --finding-id R3 --attempt-id "$ATTEMPT" \
  --baseline-cmd "<focused test command>" \
  --mutation-mode restore-paths-from-ref \
  --mutation-ref "$PARENT_OID" --mutation-paths "src/a.py,src/b.py" \
  --out "$ART/mutation-evidence/R3.json"
```

It must satisfy all of:

- a **disposable exact-head worktree**, never the final fix worktree, never the
  main checkout;
- the focused baseline test runs first and is recorded **passing**;
- only the minimal temporary mutation the claim implies is applied;
- the same focused test is rerun;
- the worktree is restored, and cleanup is **proved** with `git status
  --porcelain` plus expected HEAD/tree checks;
- commands, exit statuses, and concise output hashes are saved to the artifact
  (`schemas/mutation-evidence-v1.schema.json`);
- no broad destructive mutation, and no external state is touched.

Reading the result:

| `conclusion` | Meaning |
|---|---|
| `test-does-not-detect-regression` | The coverage gap is empirically **confirmed** |
| `test-detects-regression` | The coverage finding is **rebutted** |
| `inconclusive` | The claim stays **unconfirmed / needs evidence** — never auto-blocking |

A fresh `finding-judge` checkpoint assesses the empirical result. If mutation
is unsafe or cannot be isolated, classify the claim as unconfirmed rather than
inventing certainty.

Do **not** require mutation for unrelated correctness or security findings, or
where reproducing the bug directly is the stronger evidence.

---

## 11. Unresolved-thread pipeline

Every unresolved review thread matters, regardless of author:

- `chatgpt-codex-connector[bot]`;
- a prior babysitter inline finding;
- a human reviewer;
- another automation.

When unresolved threads exist, run a fresh `thread-judge` checkpoint. It must:

1. fetch bodies inside its isolated context;
2. read relevant specs and code paths;
3. classify each thread:
   - `REAL_FIX_REQUIRED`
   - `FALSE_POSITIVE`
   - `SPEC_SANCTIONED`
   - `ANSWERED`
   - `ADVISORY_NON_BLOCKING`
   - `NEEDS_HUMAN`
4. write `thread-dispositions.json`;
5. for non-fix dispositions, propose a concise evidence-backed reply and
   indicate whether resolution is conclusive;
6. leave real findings unresolved until a verified fix commit has been pushed;
7. never resolve a thread without either:
   - a pushed fixing commit and fix-PR link; or
   - an evidence-backed disposition reply.

The controller rechecks live state, posts accepted replies, and resolves only
conclusive dispositions. A genuine human question remains unresolved when the
answer is uncertain.

Batch all real findings for one parent PR into one implementation task.

---

## 12. Fix pipeline

Never push fixes directly to the reviewed PR's branch.

### 12.1 Reuse or create the stacked fix branch

Preferred remote branch:

```text
fix/pr<N>-review
```

If an open fix PR for the same parent already exists, base new work on its
current head. Otherwise base it on the reviewed PR's exact current head.

Create a unique local worktree/branch under `.claude/worktrees/`. The local
branch name may be session-specific; the remote push target stays explicit.
Register new worktree ownership with purpose `fix` before dispatch (section 3.1).

Fix PR requirements:

- base: the reviewed PR's head branch;
- title: `fix(pr#<N>): address review findings`;
- body references `#<N>`;
- no force push;
- no push to the parent PR branch;
- fall back to another base only when the head branch is an inaccessible fork,
  and then mark the workflow `BLOCKED` for automatic merge rather than silently
  changing semantics.

### 12.2 Bounded implementation

Batch every confirmed finding for the parent into one native fix task. Assign
the exact worktree, file scope, finding IDs, constraints, required tests, and
schema-derived artifact contract. Use the loaded adapter's model configuration.
Let the implementer choose local implementation details within that scope.
Reuse validation for an unchanged revision when its evidence is complete; rerun
affected checks after changes, failures, or a newly identified concern.

Allow at most three sequential implementation rounds for ordinary work and two
for complex or critical work. Critical work includes security/auth/authz, data
integrity, financial correctness, concurrency, and destructive migrations.
Each correction consumes the previous fresh verifier's feedback. Exhaustion
becomes `BLOCKED`; the controller must not bypass independent verification.

The fix child must:

- edit only the assigned worktree and scope;
- implement all confirmed findings and run meaningful focused checks;
- leave changes uncommitted; the controller owns commit creation;
- write its complete result to the assigned attempt's `result.json`;
- omit `fix.commit` or set it null;
- return the compact handoff and perform no GitHub writes.

After native completion, the controller validates the result (section 5.3),
checks the actual changed-file set against the assignment, and creates the
signed commit (`git commit -s`). Record its exact OID as `fix.commit`, recompute
the canonical artifact hash, and hand both to a fresh independent verifier.

### 12.3 Fresh independent verifier

After every implementation round, run a fresh `verifier` checkpoint. It must not edit code or launch nested tasks.

It verifies:

- exact parent head and intended fix base;
- full diff, not only files named by the implementer;
- every confirmed finding closure;
- no hidden unrelated changes;
- spec/plan compliance;
- error paths, tests, concurrency/security implications as applicable;
- `git diff --check`;
- focused project tests in the foreground;
- pytest with `-n0`;
- Rust fmt/clippy/test when Rust is touched;
- no `bun run build`;
- no server unless indispensable.

Write the verifier envelope of
[references/checkpoint-contract.md](checkpoint-contract.md).
The controller admits it as `verification.json`; parentHead and fixCommit live
in `subject`, while closure, blockers and test results live in `result`. A
mechanically valid REJECT is correction evidence and never authorizes publishing.

Return only the compact handoff line.

`REJECT` feeds one bounded correction round into a fresh implementation context.
`BLOCKED` stops that PR pipeline.

### 12.4 Publish only after acceptance

After `ACCEPT`, the main controller performs a collision guard:

- parent head still equals the expected OID;
- remote fix branch did not advance unexpectedly;
- confirmed threads are still unresolved and belong to the same head;
- no other session already pushed an equivalent fix;
- the verification artifact matches the commit to push.

Push explicitly and never force:

```bash
git push origin <accepted-commit>:refs/heads/fix/pr<N>-review
```

Create or update the stacked fix PR. Then:

1. reply to each fixed thread with the pushed commit SHA and fix-PR URL;
2. resolve each disposed fixed thread;
3. create/update the fix PR's v2 status comment using its own head/base/spec/key;
4. record local gates;
5. evaluate the fix PR's own external-review state (section 13) against its new
   head and post the configured trigger when `trigger_due` holds;
6. let the fix PR enter the normal strict-stack gate and merge pipeline.

A parent with a still-open fix child is not ready, even if its review threads
are now resolved.

---

## 13. External review — persistent retry state machine

This is the `@codex review` loop. It is driven by the effective external-review
policy (section 4.1), not by hardcoded logins, and it is **persistent**: for a
`fresh-pass-retry` PR the skill keeps re-triggering on a cooldown across waves,
across invocations, and across controller restarts until the bot actually
passes the current head.

### 13.1 What a pass is

A pass is a **reaction left by the configured `botLogin`, with the configured
`passReaction` content, on the PR body** — that is, on
`repos/<repo>/issues/<N>/reactions`. For `chinrw/stocks` that is a `+1` from
`chatgpt-codex-connector[bot]`.

None of the following is a pass:

- an emoji inside a comment body;
- a reaction on an issue comment or on a review comment (different endpoints);
- a submitted review with no pass reaction;
- bot silence;
- a pass reaction older than the current head.

A pass is **fresh** only when its `created_at` is at or after the current head's
last commit `committedDate`.

Collect complete raw GitHub responses and run the local handoff described in
[references/external-review-handoff.md](external-review-handoff.md).
It preserves pagination, normalizes bot identity, and uses the existing evaluator.
Always quote a bot login containing `[bot]` when using shell tools.

### 13.2 The `trigger_due` predicate

Whether to post a trigger is a deterministic predicate, not a judgement call:

```text
trigger_due =
  externalReview.enabled
  AND mode == fresh-pass-retry
  AND no fresh pass for the current head
  AND no unresolved bot-authored thread requiring disposition
  AND PR is open and non-draft
  AND current head/base still equal the expected snapshot
  AND now >= codexNextTriggerAt
  AND no exact trigger was posted by another session inside the current
      cooldown window
```

Do not evaluate this by hand. Use the local handoff manifest and saved raw
observations (reference above):

```bash
node "${BABYSIT_SKILL_DIR}/scripts/external-review.mjs" \
  --input "$ART/observations/input.json" \
  --out "$ART/external-review-handoff.json"
```

The output's `decision` carries `action`, `codexState`, `codexRound`,
`codexNextTriggerAt`, `externalReviewSatisfied`, and `reasons`. A null marker or
`requiresResnapshot=true` forbids publication until observations are refreshed.
The controller may not override a decision; it may only re-observe and
re-evaluate. Allowed `codexState` values:

```text
DISABLED
PASS_FRESH
FINDINGS_OPEN
TRIGGER_DUE
TRIGGER_IN_FLIGHT
WAITING_RETRY
ONE_ROUND_SATISFIED
STOPPED_PR_CLOSED
BLOCKED_SNAPSHOT_STALE
EXHAUSTED_TOTAL_ROUNDS
POLICY_INVALID
```

### 13.3 Round accounting

A new head starts at round zero with round one immediately due. After an
actual successful post, supply its confirmed receipt to the handoff. The module
folds the comment's creation time into persisted state and derives the next
retry time; the controller does not increment counters or invent timestamps.
Unknown or failed write outcomes require refreshed observations and no marker.

An existing current-head trigger **suppresses posting only until
`codexNextTriggerAt`**. It is not a permanent one-shot key. A head that has
already been triggered once and stayed silent for a full cooldown is due for the
next round, and the round after that, indefinitely.

When every bot finding has been disposed and the head did not change, supply
the confirmed `dispositionCompletedAt` in the handoff manifest. The module
applies the policy's collision delay and derives the retry timestamp.

This re-reviews as soon as possible rather than waiting out the full cooldown,
while still keeping a short window so two sessions cannot double-post. A pure
rebuttal round with no head change still earns a new trigger — never skip it on
the grounds that the old trigger still belongs to the current head.

When a fix child merges and the parent head changes, the round counter resets
and round 1 is immediately due against the new head.

### 13.4 Exact trigger and collision guard

Each round posts **one new issue comment whose body, trimmed, equals the
configured `triggerComment` exactly**. No prefix, no suffix, no explanation.

Immediately before the write, re-query live state and confirm:

- the PR is still open, non-draft, and at the expected head/base;
- no fresh pass has appeared;
- unresolved bot threads are still zero;
- the latest exact trigger comment and its `createdAt`;
- `codexLastTriggerAt` / `codexRound` in the status comment;
- no other babysitter session triggered inside the cooldown window.

Rerun the handoff on these refreshed observations. If its decision no longer returns
`POST_TRIGGER` — because a pass landed, the head moved, or another session got
there first — abandon the write and adopt the returned live state. When another
session triggered inside the cooldown, this session stands down.

Never delete another session's trigger comment to "deduplicate". Deduplication
is the cooldown window, not comment deletion.

### 13.5 Findings take priority

While any unresolved bot-authored thread exists, the state is `FINDINGS_OPEN`
and no new trigger is posted. Route those threads through the normal
disposition / fix / independent-verification pipeline (sections 11 and 12).
Only after every bot thread has an evidence-backed reply and resolution does
the retry clock resume, per section 13.3.

Do not read bot thread bodies in the main context.

### 13.6 Gate semantics per mode

`rootMode = fresh-pass-retry` (roots and integration PRs):

```text
external_review_satisfied = fresh PR-body pass reaction for the current head
```

A trigger having been posted, the bot being silent, an elapsed timeout, or the
absence of threads **do not** satisfy this gate.

`strictStackedMode = one-round` (strict stacked PRs, the default relaxed rule):

```text
external_review_satisfied =
  a current-head exact trigger / reaction / review exists
  AND all resulting review threads are disposed
```

Bot silence after one current-head round is acceptable here. A stale trigger
from an older head is not. Only when repo policy explicitly sets
`strictStackedMode: "fresh-pass-retry"` does a strict stacked PR also wait for
the pass reaction.

Never apply the relaxed strict-stack rule to a root or integration PR.

### 13.7 Stop conditions

The retry loop for a PR ends only when one of these is true:

1. a fresh PR-body pass reaction appears for the current head;
2. the PR is closed or merged;
3. head/base/scope is blocked unrecoverably;
4. the user explicitly stops the loop;
5. policy sets a non-null `retry.maxTotalRounds` and it is reached.

Nothing else ends it. Not the wave cap, not the no-progress limit, not the
per-invocation round cap, not bot silence.

### 13.8 Dry run

With `--dry-run`, external review is evaluated but never written. The decision
reports:

```text
would trigger @codex review round <N>
```

and no comment is posted.

---

## 14. CI and local gate policy

Interpret `statusCheckRollup` as follows:

- queued/running -> `WAITING_CI`;
- any required failure/cancellation -> `BLOCKED` or `WAITING_CI` with exact
  failing check names;
- all required checks successful -> CI green;
- empty rollup:
  - legitimate only when the PR base is outside
    `main`, `stocks-dev`, and `stocks-rust`;
  - requires fresh recorded local gates from an independent verifier;
  - otherwise it is pending/unknown, not green.

Do not report `no CI` merely because checks have not appeared yet on a branch
that the workflow is configured to cover.

Required GitHub reviews or branch-protection approvals remain external gates.
Never use `--admin` to bypass them.

---

## 15. Composition verification after a child merge

A child merge changes the parent's head and invalidates its old review key.
Avoid a full review only when composition is cryptographically and structurally
proved.

A parent is eligible for the composition shortcut when:

1. the old parent review key was accepted;
2. the child review key was accepted;
3. the new parent head is a merge commit;
4. its first parent is exactly the old parent head;
5. its second parent is exactly the accepted child head;
6. `git merge-tree --write-tree <old-parent> <child-head>` succeeds;
7. that expected tree equals `<new-parent>^{tree}`;
8. the parent's base OID and relevant spec hash are known;
9. fresh relevant local/CI gates pass.

If `git merge-tree --write-tree` is unsupported, reports a conflict, or yields a
different tree, do a full review.

For ordinary non-critical changes, run a fresh `composition-verifier`
checkpoint. For security, auth/authz, data-integrity, financial,
concurrency, destructive-migration, or otherwise high-risk composition, run
the `critical-composition-verifier` checkpoint instead. The selected checkpoint reads only:

- prior accepted parent/child artifacts;
- exact ancestry/tree proof;
- merge delta and relevant specs;
- fresh gate evidence.

It writes `composition-verification.json`. The ordinary verifier may also return
`ESCALATE_MAX`; immediately run the `critical-composition-verifier` checkpoint
on the same immutable evidence. Final composition verdicts are `ACCEPT`,
`REVIEW`, or `BLOCKED`.

On `ACCEPT`, compute the new review key, update the status comment, and apply
the external-review policy to the new head: the round counter resets and
round 1 is immediately due (section 13.3). On `REVIEW`, run the full review
pipeline.

This shortcut applies to any accepted strict child, including a babysitter fix
PR.

---

## 16. Deterministic readiness gates

A PR is review-current only when:

- v2 marker head/base/spec/key exactly match the fresh snapshot;
- a fresh judgment or verification artifact accepts that key;
- artifact commit/OIDs match GitHub;
- no later head/base/spec change exists.

`READY_STACKED` requires all of:

```text
is open and non-draft
strict_stacked == true
leaf == true
review_current == true
independent_acceptance_current == true
unresolved_threads == 0
CI green OR legitimately absent with fresh local gates
external_review_satisfied == true for the current head, per the PR's
  effective mode (section 13.6)
mergeable == MERGEABLE
mergeStateStatus has no unresolved branch-protection blocker
no CHANGES_REQUESTED review
expected head still current
no collision or native capability blocker
```

`READY_ROOT` requires the same gates except `strict_stacked`, and requires no
open child. For a `fresh-pass-retry` root that means a fresh PR-body pass
reaction for the current head — a posted trigger or a silent bot is never
enough.

A root may be ready even though this skill lacks authority to merge it.

---

## 17. Bounded convergence loop

Default limits:

```text
max waves: 8
max live heavy children: min(4, available runtime slots)
max live writers: 2
poll interval: 60 seconds
external-only no-progress limit: 10 minutes
```

For each wave:

1. Snapshot all open non-draft PRs and rebuild the DAG.
2. Restrict actions to the requested operational scope.
3. Validate current review keys and states.
4. Dispatch independent source-read-only reviews within the native child limit.
5. Dispatch the required judgment checkpoints after their input artifacts are
   terminal.
6. Dispatch thread-disposition checkpoints.
7. Batch confirmed fixes per parent.
8. Run native fix -> fresh verifier checkpoint sequentially.
9. Publish accepted fixes and update thread/status state.
10. Refresh snapshots.
11. Evaluate deterministic readiness.
12. Merge eligible strict stacked leaves.
13. Verify each merge and refresh every affected parent.
14. Apply composition verification or full review.
15. Continue until:
    - all in-scope work is `MERGED`, `READY_ROOT`, or `BLOCKED`;
    - only external CI/external-review/review gates remain with no progress for
      ten minutes;
    - no state transition is possible;
    - the wave cap is reached.

Do not stop automatically after one stack level. A three-level stack may land
within one invocation when each newly advanced parent re-passes its gates.

### 17.1 Invocation boundaries vs. the retry loop

The invocation is bounded. The external-review retry loop is not.

- Post at most `retry.maxRoundsPerInvocation` triggers per PR in one
  invocation.
- If `codexNextTriggerAt` falls inside this invocation's remaining runtime
  budget, keep polling and fire the round when it comes due.
- If it does not, end the invocation for that PR and report:

  ```text
  WAITING_CODEX round=<n> nextRetryAt=<timestamp>
  ```

- The external-only no-progress limit ends **this invocation only**. It must
  not clear retry state, must not mark the PR satisfied, and must not mark it
  permanently blocked.
- Always write `codexNextTriggerAt` into the status comment before exiting, so
  the next invocation knows when the next round is due.

The next invocation of either native entrypoint reconstructs external-review
state from the GitHub status comment plus live comments and reactions, and posts the next
round as soon as it is due.

For unattended operation, use `runners/babysit-auto/` from this repository.
Its timer starts a new top-level controller invocation only when the gate
reports due work. It is separate from the controller's native child lifecycle.
Without an installed and enabled runner, report the next due time and leave
retrying to the next manual invocation; never imply a timer exists.

After a process/session restart, discard assumptions and reconstruct state from
GitHub plus committed artifacts. Salvage valid unpushed commits before deleting
leftover worktrees.

---

## 18. Merge execution

Before every merge, fetch a fresh snapshot and reevaluate all gates.

Default:

- merge only `READY_STACKED` strict stacked leaves;
- process innermost-first;
- independent leaves may be handled in the same wave;
- PRs targeting the same base branch merge sequentially.

With `--merge-integration`, a `READY_ROOT` PR whose base is exactly
`stocks-dev` may also merge after all strict descendants are gone.

Never merge a PR whose base is `main`.

Use:

```bash
gh pr merge <N> \
  --repo chinrw/stocks \
  --merge \
  --match-head-commit <expected-head>
```

Never use:

- `--admin`;
- `--delete-branch`;
- force push;
- a merge command without expected-head matching.

After the command:

```bash
gh pr view <N> --repo chinrw/stocks --json state,mergeCommit,headRefOid,baseRefName
```

Verify `state=MERGED`. If branch policy placed the PR into a merge queue
instead, report it as queued and poll its live state; do not claim it merged.
On any other failure, do not blindly retry. Resnapshot, classify the new reason,
and either continue safely or mark `BLOCKED`.

Once `state=MERGED` is verified, reclaim that PR's worktree if it satisfies
`RECLAIMABLE` (section 3.1):

```bash
git -C /home/chin39/Documents/play/stocks worktree remove <path>
git -C /home/chin39/Documents/play/stocks worktree prune
```

Never `--force`. A worktree that is dirty, or that fails any other clause, is
left in place and reported as residual.

Reclamation runs after the merge is already confirmed and is best-effort: a
failed removal never downgrades a merged PR to a failed merge. Report the merge
outcome and the reclamation outcome separately.

---

## 19. Collision and idempotency rules

Before every push, comment, reply, resolution, trigger, status update, or merge:

1. fetch live PR head/base;
2. compare to the expected snapshot/review key;
3. recheck the target thread/comment/branch;
4. detect whether another babysitter session already completed the action;
5. stand down rather than duplicate or overwrite.

Never:

- delete another session's comment;
- replace a remote fix branch with non-fast-forward history;
- resolve a thread already changed by another actor without rereading it;
- reuse a review artifact for another head/base/spec key;
- trust local state over GitHub after restart.

Clean up only worktrees satisfying section 3.1. Ownership records and saved
Git refs carry across runs; directory names do not. If another run may still
own a writer, leave the worktree in place. Use `git worktree remove` and
`git worktree prune` only after every condition has been rechecked.

---

## 20. Dry-run and snapshot-only behavior

With `--snapshot-only` (section 1.1): observe and report only. No native task,
no checkpoint, no worktree, no test, no artifact beyond snapshot and
external-review observation/handoff files, and no GitHub write. Every action label is prefixed `🔎 SNAPSHOT:`.

With `--dry-run`:

- build the complete snapshot and stack graph;
- compute proposed review keys and states;
- read existing artifacts;
- source-read-only native review and local validation are allowed;
- evaluate external review and report
  `would trigger <triggerComment> round <N>`;
- do not post/update comments;
- never post an external-review trigger, in any mode, for any reason;
- do not reply or resolve threads;
- do not push;
- do not create/update PRs;
- do not sweep or remove worktrees (section 3.2);
- do not merge.

Report every write action that would have occurred with exact PR and reason.

---

## 21. Final report

Print a compact table:

```text
PR · type · title · head · review · threads · Codex · CI/local · child · state · action
```

Use these action labels:

- `🚀 AUTO-MERGED`
- `✅ READY ROOT`
- `🛠 FIX PR OPEN`
- `⏳ WAITING: <gate>`
- `❌ BLOCKED: <reason>`
- `🧪 DRY-RUN: <planned action>`
- `🔎 SNAPSHOT: <observed state>`

A PR waiting on external review reports its live retry state:

```text
⏳ WAITING_CODEX round=<n> nextRetryAt=<UTC timestamp>
```

Never report such a PR as satisfied, done, or blocked.

Then explicitly list:

1. PRs auto-merged in this invocation;
2. root/integration PRs ready for the user;
3. open fix PRs and their parent PRs;
4. PRs waiting on CI, Codex, required review, or external input;
5. blockers and exhausted retry ladders;
6. whether the wave cap or no-progress limit stopped convergence, and the
   `nextRetryAt` of every PR still in the external-review retry loop;
7. unavailable capabilities and observed model/effort, using `unknown` when
   unavailable; missing model metadata is informational, not a blocker;
8. worktrees reclaimed this invocation with their paths, and worktrees retained
   as residual with the `RECLAIMABLE` clause each failed.

When any PR is still `WAITING_CODEX`, report its next retry time and whether
an enabled runner has actually been verified. Otherwise another invocation is
needed (section 17.1).

Do not include findings prose, diffs, spec excerpts, or long test logs in the
final report.

---

## 22. Hard rules

- The current host session owns the workflow; all children use its native tools.
- Delegate detailed review and implementation; read decisive evidence as needed.
- Use fresh contexts for review, judgment, and verification. Children do not spawn.
- An implementer claim is not acceptance. A fresh verifier checkpoint and real
  local gates are required before push.
- The controller owns commits and every GitHub write.
- Assigned paths are scope instructions, not a path-scoped sandbox.
- Only completed, schema-valid, identity-matching artifacts can be accepted.
  Native completion must be observed independently of result-file contents.

- A finding count is not a finding. No blocker, GitHub comment, fix task, or
  acceptance may come from summary telemetry, and `blocking=0` without a
  complete artifact never approves a PR.
- An incomplete result earns exactly one fresh attempt with a new attempt ID;
  a second incomplete result is `BLOCKED: codex-output-incomplete`. Never invent
  findings from either attempt.
- The review key comes from `scripts/review-key.mjs` — one NUL between adjacent
  fields, no trailing NUL, no final newline. No agent recomputes it from prose,
  and the algorithm never changes under an unchanged marker version.
- A marker written under a legacy dialect is recognized, never accepted. Only
  `review-key.mjs classify` exit `0` proves review-current. New markers carry
  full lowercase OIDs and a bare spec hash.
- A pure test-coverage claim needs empirical mutation evidence when the
  experiment is safely runnable; otherwise it stays unconfirmed, not blocking.
- Temporary probes live under `mktemp -d "${TMPDIR:-/tmp}/..."`, never in the
  repository. Source cleanliness is verified after every judge/verifier task.
- Specs override parity assumptions. Intentional documented divergence is not a
  bug.
- Never push to the reviewed PR's branch.
- Never force push.
- Never use `--admin`.
- Never merge into `main`.
- By default, auto-merge only strict stacked PRs.
- Never merge without `--match-head-commit`.
- Never resolve a thread without a pushed fix or evidence-backed disposition.
- Never let two writers overlap.
- Never run `bun run build`.
- Run pytest with `-n0`.
- Do not bind reserved ports.
- Do not leave untracked background tests or agents as implicit gates.
- Every acceptance is bound to exact head, base, spec hash, and policy version.
- Be honest: silent Codex, stale reactions, pending CI, required approvals, and
  unknown mergeability are not readiness.
- External review is repository policy, never a hardcoded login or repo name.
- A pass is the configured bot's configured reaction **on the PR body**, fresh
  against the current head. Nothing else passes.
- Post an external-review trigger when `trigger_due` holds. A current-head
  trigger suppresses posting only until `codexNextTriggerAt`; it is never a
  permanent one-shot key.
- `fresh-pass-retry` retries indefinitely across invocations and restarts.
  Per-invocation caps, wave caps, and no-progress limits end an invocation, not
  the retry loop.
- Never deduplicate triggers by deleting comments.
- `--dry-run` never posts an external-review trigger.
- `--snapshot-only` dispatches no native task, no checkpoint, and no worktree.
  It observes and reports; it never advances a state machine.
