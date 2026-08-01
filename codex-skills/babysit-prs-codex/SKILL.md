---
name: babysit-prs-codex
description: >-
  Codex CLI port of babysit-prs: prepare open PRs in chinrw/stocks to
  merge-ready, automatically merge strict stacked PRs innermost-first, and
  report ready integration/root PRs for the user. Manual only: this workflow
  may push fix branches, create PRs, reply to and resolve review threads, and
  merge eligible stacked PRs.
disable-model-invocation: true
---

# `babysit-prs-codex` — quality-first PR readiness and stacked-merge controller

This is the **Codex CLI port** of the Claude Code `/babysit-prs` skill. Run it
in a Codex CLI session on a Sol-class model at `xhigh` reasoning effort.
Critical judgment and final-verification checkpoints run as dedicated fresh
`codex exec` sub-processes at the effort ceiling; bounded spec selection and
ordinary composition checks run the same way at `xhigh`.

Terminology in this port:

- **the controller** — the Codex CLI session running this skill;
- **a Codex task** — a delegated companion job launched through
  `scripts/codex-job.mjs` (section 5), never the controller session itself;
- **a checkpoint** — a fresh foreground `codex exec` judgment sub-process
  (section 2), the port of the original skill's Claude judgment agents;
- **the external bot** — the `@codex review` GitHub bot of section 13; the
  `codex*` marker fields and the `WAITING_CODEX` state refer to it.

The outcome is:

1. Every in-scope PR is reviewed against its exact base and the relevant design
   specification.
2. Real findings are fixed on separate stacked fix PRs, independently verified,
   pushed, discussed, and resolved.
3. Every PR is advanced as far as current external gates allow. When repository
   policy requires an external review pass, the skill keeps re-triggering the
   configured bot on a cooldown — across waves, invocations, and restarts —
   until that pass actually arrives. Use the external 30-minute loop of
   section 17.1 for long-running babysitting.
4. **Strict stacked PRs** are automatically merged innermost-first when all gates
   pass.
5. Root/integration PRs are left in a truthful `READY_ROOT` state for the user,
   unless `--merge-integration` explicitly permits merging a `stocks-dev` root.
6. A PR whose base is `main` is **never** merged by this skill.

Do not ask the user questions during the run. When information or authority is
missing, mark the affected PR `BLOCKED`, continue independent work, and report
the exact blocker at the end.

Run locally. This workflow depends on the locally installed codex-companion
runtime (section 5), local worktrees, and local credentials; do not use a cloud
scheduled task as a substitute.

If context compaction occurs, or any write/merge rule becomes uncertain, reread
`${BABYSIT_SKILL_DIR}/SKILL.md` before the next remote write. Recheck at least
sections 16–22 before every merge wave.

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

Unknown or contradictory arguments are a usage error. Stop before remote writes.

`--snapshot-only` and `--merge-integration` together are contradictory.
`--snapshot-only` implies `--dry-run`; passing both is redundant, not an error.

### 1.1 `--snapshot-only`

`--dry-run` blocks every *remote write* but still permits read-only Codex
reviews, so validating the skill costs a real Sol review per in-scope PR.
`--snapshot-only` exists so the observable state can be checked for free, as
often as you like.

Under `--snapshot-only`, do exactly this:

1. run the startup preflight (section 2) and the Codex capability probe
   (section 5.1);
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

- dispatch any Codex task, read-only or otherwise;
- dispatch any judgment or verification checkpoint;
- create, modify, or remove a worktree;
- run project tests, builds, or servers;
- write any run artifact except `snapshot.json`, `codex-capabilities.json`,
  `external-review-observation.json`, and `external-review-decision.json`;
- perform any GitHub write of any kind.

A PR whose evidence is missing is reported as the state it actually holds —
`NEEDS_REVIEW`, `WAITING_CODEX`, `BLOCKED` — never as satisfied. Snapshot-only
never advances a state machine; it reports what a real run would find.

This mode is the safe validation entry point:

```bash
codex "use babysit-prs-codex: --snapshot-only"        # whole repo
codex "use babysit-prs-codex: 403 --snapshot-only"    # one PR and its descendants
```

Without a PR number, operate on every open, non-draft PR in `chinrw/stocks`.

With a PR number, the operational closure is:

- the requested PR;
- any open descendants whose base-chain reaches that PR;
- any `fix/pr<N>-review*` PR created for that PR during this run.

Do not touch unrelated PRs. Still enumerate all open PR heads to build the stack
graph correctly.

---

## 2. Non-negotiable model and execution contract

### Main controller

The Codex CLI session running this skill is the controller:

- model: `gpt-5.6-sol`, or the strongest available Sol-class model;
- reasoning effort: `xhigh`;
- sandbox: `workspace-write` with network access enabled, launched from the
  main checkout — GitHub reads and writes go through authenticated `gh`;
- responsibilities: snapshots, DAG/state transitions, scheduling checkpoints,
  collision checks, deterministic gates, GitHub writes, and final merge
  authorization;
- it remains thin and must not bulk-read diffs, specs, or review prose.

At startup, resolve the skill directory, mint the run ID, and verify the
runtime:

```bash
BABYSIT_SKILL_DIR="$(readlink -f "$HOME/.agents/skills/babysit-prs-codex")"
BABYSIT_RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)-$$"
codex --version
gh api rate_limit --jq .rate.remaining
ls "${BABYSIT_SKILL_DIR}/prompts/"
```

Remote writes are blocked when any of these is true:

- `codex` is older than `0.145.0`;
- the controller session's reasoning effort cannot be confirmed as `xhigh` (or
  the harness maximum) — record `effort=unconfirmed` and stay read-only;
- the `gh` probe fails, meaning the sandbox denies network access or
  authentication is missing;
- any of the six checkpoint prompt files (below) is missing from
  `${BABYSIT_SKILL_DIR}/prompts/`.

A blocked preflight may still produce a read-only snapshot and report, but may
not push, comment, resolve, or merge.

### Judgment checkpoints

The six Claude judgment agents of the original skill become six **checkpoint
prompts** installed with this skill under `${BABYSIT_SKILL_DIR}/prompts/`.
Each checkpoint runs as a fresh foreground `codex exec` sub-process — a new
context every time, never the controller's own context. Never substitute
controller-context judgment merely to keep the run moving.

| Checkpoint prompt | Requested | Effective | Responsibility |
|---|---:|---:|---|
| `prompts/spec-selector.md` | `xhigh` | `xhigh` | Select exact specs/plans and compute `specHash` |
| `prompts/finding-judge.md` | `max` | `xhigh` | Adversarially classify Codex findings against code and spec |
| `prompts/thread-judge.md` | `max` | `xhigh` | Dispose unresolved bot/human review threads |
| `prompts/verifier.md` | `max` | `xhigh` | Independently accept or reject an implementation |
| `prompts/composition-verifier.md` | `xhigh` | `xhigh` | Verify an ordinary child-merge composition shortcut |
| `prompts/critical-composition-verifier.md` | `max` | `xhigh` | Verify a high-risk child-merge composition shortcut |

`max` is not in the Codex reasoning-effort enum; it normalizes to the `xhigh`
ceiling exactly like the lane normalization below, and both values are
recorded in the checkpoint's assignment header. If a future runtime accepts a
higher tier, the requested tier is used with no change to this skill.

All six prompt files must exist before their results can authorize remote
writes (preflight, above). A missing file means: produce a read-only snapshot,
mark the affected work `BLOCKED: missing-checkpoint:<name>`, and do not
silently downgrade.

Dispatch template — the assignment header supplies everything the prompt
file's placeholders need:

```bash
{
  printf 'ASSIGNMENT\n'
  printf 'BABYSIT_SKILL_DIR=%s\n' "$BABYSIT_SKILL_DIR"
  printf 'CANONICAL_RUN_DIR=%s\n' "$RUN"
  printf 'PR=%s HEAD_OID=%s BASE_OID=%s REVIEW_KEY=%s\n' "$PR" "$HEAD_OID" "$BASE_OID" "$REVIEW_KEY"
  printf 'WORKTREE=%s\n' "$WORKTREE"
  printf 'ARTIFACT=%s\n' "$ART/<assigned-artifact>.json"
  printf 'EFFORT=requested=%s effective=%s\n' "$REQUESTED" "$EFFECTIVE"
  printf 'GITHUB_WRITES=%s\n' 'forbidden'   # or: authorized:<exact scope>
  printf '\n'
  cat "${BABYSIT_SKILL_DIR}/prompts/<checkpoint>.md"
} | timeout 45m codex exec \
    --cd "$CHECKPOINT_CWD" \
    --sandbox workspace-write \
    -c model_reasoning_effort='"xhigh"' \
    --output-last-message "$ART/checkpoints/<checkpoint>.last.txt" \
    -
```

Checkpoint rules:

- `$CHECKPOINT_CWD` is the main checkout for artifact-writing checkpoints and
  the assigned read worktree for spec selection; both lie under the checkout,
  so `workspace-write` covers the run directory and worktrees without
  covering anything else.
- Network access stays **disabled** for a checkpoint unless its assignment
  explicitly authorizes GitHub writes (the finding-judge posting step, the
  thread-judge reply/resolve step); enable it only for that invocation with
  `-c sandbox_workspace_write.network_access=true`.
- The checkpoint's final message must be exactly the one-line compact handoff
  of section 3; the controller reads only the `--output-last-message` file
  and the assigned artifact, never the transcript.
- A checkpoint that timed out, returned a malformed handoff, or failed the
  source-clean check is re-run once from a fresh context; a second failure is
  `BLOCKED: checkpoint-failed:<name>`.

These checkpoints:

- run on the same Sol-class model as the controller, at the `xhigh` ceiling;
- may read diffs/specs, but write only their assigned artifact;
- must not launch Codex tasks, nested `codex exec` runs, or any other
  sub-process agent;
- return one compact line while detailed output goes to artifacts or GitHub.

Use a fresh context for every checkpoint. A judge that wrote code may not verify
that code. The fresh-context boundary is this port's independence mechanism:
unlike the original, controller and judges share one model family, so the
cross-model (Claude-vs-Codex) independence is deliberately traded away.
Checkpoint prompts therefore stay adversarial by construction, and no LLM
statement — controller or checkpoint — may bypass a deterministic gate.

### Codex tasks

The main controller launches Codex tasks itself, through
`scripts/codex-job.mjs` (section 5.5). A checkpoint must never be asked to
launch a Codex task.

**Do not run any babysit-prs Codex task as a bare `codex exec` call or inside
a nested interactive session.**

A bare call is disqualified for the same class of reasons the Claude skill
bans its `codex:codex-rescue` wrapper:

1. **It does not honour the launch-cwd contract.** The companion scopes
   `workspace-write` to the checkout the task is launched from; an unpinned
   launch surfaces as `read-only filesystem` against the assigned worktree —
   the exact blocker recorded on PRs #401 and #402.
2. **It writes no launch receipt**, so the resulting job cannot be polled
   reliably from anywhere (section 5.3).
3. **It skips capability normalization and artifact reconciliation**, so
   effort requests and the dual-channel contract of section 5.2 silently
   degrade.

Prompt text cannot fix any of this: the launch cwd is decided by the process
that spawns the companion. Route every lane through `codex-job.mjs`, which
validates the launch cwd, normalizes effort, writes the receipt before polling,
and reconciles the artifact channels.

Lanes:

| Lane | Model and effort | Purpose |
|---|---|---|
| Deep review | `gpt-5.6-sol`, `max` | Exact-base, spec-aware adversarial review |
| Extra risky-domain review | `gpt-5.6-sol`, `max` | At most one independent extra pass |
| Bounded routine fix | `gpt-5.6-terra`, `high` | Clear, mechanical or ordinary implementation |
| Complex noncritical fix | `gpt-5.6-sol`, `high` | Resilience, subtle performance correctness, complex multi-file logic |
| Critical-risk fix | `gpt-5.6-sol`, `max` | Security/auth/authz, data integrity, concurrency, destructive migration |
| Final implementation escalation | `gpt-5.6-sol`, `max` | After a prior ordinary/complex implementation or verifier failure |

These lanes are **logical** requests. The installed companion accepts a fixed
effort enum, so every request is normalized **once at preflight** against the
capability artifact (section 5.1) before any task is dispatched:

```text
effective_effort = highest accepted effort <= requested effort
```

Normalization never maps upward. Record both values everywhere:

```text
requested=max effective=xhigh reason=companion-ceiling
```

Do **not** launch `max` and wait for the rejection. A capability downgrade is a
preflight normalization, not a failed task round, and it must cost zero launches.
If a future companion accepts `max`, the probe reports it and the lanes use it
with no change to this skill.

The model is never changed to work around an effort ceiling.

Codex has no GitHub authority. It must not push, comment, resolve, create PRs,
or merge.

### Concurrency

- Maximum live heavy checkpoint/Codex sub-tasks: `4`.
- Maximum simultaneous write-capable Codex tasks: `2`.
- Maximum writers targeting the same eventual base branch: `1`.
- Never allow the controller and a Codex task to edit overlapping files
  concurrently.
- Never launch two Codex writers over the same worktree or file set.
- Tests and builds run in the foreground. Never finish a checkpoint or end the
  invocation while an untracked background gate is still running.

---

## 3. Context hygiene and run artifacts

The main controller may read only:

- compact PR metadata;
- counts, timestamps, logins, IDs, and status enums;
- machine-readable artifact summaries;
- one-line agent handoffs.

The main controller must not read:

- full PR diffs;
- full review-comment bodies;
- spec or plan contents;
- candidate-finding prose;
- full Codex output;
- implementation patches.

Create the **canonical run directory** — controller-owned, in the main
checkout/run workspace:

```text
CANONICAL_RUN_DIR=/home/chin39/Documents/play/stocks/.claude/babysit-prs/runs/${BABYSIT_RUN_ID}/
```

`BABYSIT_RUN_ID` is minted once at startup (section 2).

Per-invocation artifacts at the run root:

```text
codex-capabilities.json      one capability probe, reused by every task
```

Create per-PR artifacts under:

```text
pr-<N>/
  snapshot.json
  codex-review.json                 CANONICAL_ARTIFACT (controller-written)
  codex-review-risk.json            CANONICAL_ARTIFACT (controller-written)
  judgment.json
  confirmed-findings.json
  thread-dispositions.json
  fix-result.json                   CANONICAL_ARTIFACT (controller-written)
  verification.json
  composition-verification.json
  mutation-evidence/<findingId>.json
  reactions.json
  external-review-observation.json
  external-review-decision.json
  state.json
  checkpoints/<checkpoint>.last.txt   compact handoffs via --output-last-message
  attempts/<attemptId>/
    launch-receipt.json             written BEFORE polling begins
    collect.json                    terminal classification + reconciliation
    diagnostics/                    raw channels, retained only on failure
      stdout.raw.txt                NOT evidence
      staging.raw.json              NOT evidence
      README.json
```

Only the controller writes anything under `CANONICAL_RUN_DIR`. Codex never
writes here — it cannot, since this path is outside its launch root.

Files under `diagnostics/` exist for human inspection after a failure. No
finding, blocker, GitHub comment, fix task, or acceptance may be derived from
them.

`external-review-decision.json` is the run-artifact half of the external-review
state; the GitHub status comment is the durable half. Neither is the sole truth:
after any restart, re-derive both from live GitHub state.

Keep these paths untracked using `.git/info/exclude`; do not modify tracked
`.gitignore` merely for this skill.

Every checkpoint must write its detailed result to the assigned artifact and
return only one line — its final message — in this form:

```text
PR #N | stage=<stage> | state=<state> | blocking=<n> | artifact=<path> | <12-word note>
```

Never paste findings, diffs, test logs, spec quotes, or long explanations into
the main context.

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

The 1800-second cooldown deliberately matches the 30-minute external loop
cadence (section 17.1) so long-running babysitting retries at the same rhythm
without spamming the PR.

---

## 5. Codex runtime contract

Verified operating assumptions about the installed companion
(`codex-cli 0.145.0`, plugin `openai-codex/codex/1.0.6` — the same runtime the
Claude Code skill uses; `codex-job.mjs` discovers its installed path):

- The sandbox is a **boolean**: `--write` selects `workspace-write`, its absence
  selects `read-only`. There is **no path-scoped sandbox**. Prompt text saying
  "write only this file" is not an enforcement boundary and must never be
  described as one.
- The writable root is the checkout the task is launched from.
- The companion's job store is **workspace-scoped**: it keys off
  `git rev-parse --show-toplevel`, which for a linked worktree is the worktree,
  not the main checkout.
- `task`, `status`, `result`, and `cancel` all accept `--cwd`.
- `--effort` accepts `none|minimal|low|medium|high|xhigh`. It rejects `max`.

Consequences, all enforced by `scripts/codex-job.mjs` rather than by prose:

- Any worktree Codex writes in must live under:

  ```text
  /home/chin39/Documents/play/stocks/.claude/worktrees/<unique-name>
  ```

- Never create Codex worktrees in `/tmp` or as sibling directories outside the
  launch repository.
- Launch the Codex task from the exact worktree it may modify.
- Codex cannot push, use authenticated `gh`, or run loopback browser/server
  tests.
- If a commit exists only in a separate clone, retrieve it with
  `git fetch <path> HEAD` before push.
- Codex implementation scope must include exact files or bounded subsystems,
  confirmed finding IDs, constraints, required validation, and the output
  contract of section 5.2.

### 5.1 Capability preflight — once per invocation

Before dispatching any Codex task:

```bash
node "${BABYSIT_SKILL_DIR}/scripts/probe-codex-capabilities.mjs" probe \
  --out "$RUN/codex-capabilities.json"
```

The probe is **non-executing**. It reads the companion's declared effort enum
and its `--help` usage text and requires them to agree. It never launches a
review to discover whether an effort is valid.

- Exit `0`: `acceptedEfforts` and `effortCeiling` are established. Reuse this
  one artifact for every task in the invocation.
- Exit `3`: detection is ambiguous. **Block Codex-dependent remote writes** and
  mark affected PRs `BLOCKED: codex-capability-unknown`. Do not guess.

Normalize each lane request against that artifact before launch (section 2).

### 5.2 Artifact transport — the dual-channel contract

Four terms, used precisely:

| Term | Meaning |
|---|---|
| `CANONICAL_RUN_DIR` | Controller-owned directory in the main checkout/run workspace |
| `LAUNCH_CWD` | The exact checkout/worktree the Codex task was launched from |
| `STAGING_ARTIFACT` | A path **inside `LAUNCH_CWD`**, only for write-enabled tasks |
| `CANONICAL_ARTIFACT` | The final controller-owned artifact under `CANONICAL_RUN_DIR` |

**Never ask Codex to write outside `LAUNCH_CWD`.** The controller — not Codex —
places a validated result into `CANONICAL_ARTIFACT`.

Every Codex task, read-only or write-enabled, must end its final response with
exactly one machine-readable block:

````text
BABYSIT_PR_ARTIFACT_V1
```json
{
  "schemaVersion": 1,
  "taskType": "review",
  "attemptId": "att-...",
  "pr": 379,
  "headOid": "...",
  "baseOid": "...",
  "reviewKey": "...",
  "resultCompleteness": "complete",
  "findings": []
}
```
````

Requirements:

- the fenced JSON is mandatory **even when a staging file was written**;
- it must be the **final** structured block, not embedded in prose;
- more than one sentinel block is ambiguous and is rejected;
- schema: `schemas/codex-artifact-v1.schema.json`.

The controller parses it deterministically, validates it against that schema,
checks task type / PR / head OID / base OID / review key / expected attempt ID,
canonicalizes the JSON, computes a SHA-256, and only then atomically writes
`CANONICAL_ARTIFACT`.

Detailed findings never enter the main controller context. They are extracted and
persisted mechanically; the controller reasoning loop sees only the compact
handoff and the artifact path.

#### Read-only tasks (review, risk review, diagnosis)

```text
Source mutation policy:     FORBIDDEN.
Artifact transport:         REQUIRED VIA FINAL STDOUT JSON.
Filesystem artifact:        NOT REQUIRED FOR READ-ONLY TASKS.
Codex launcher write mode:  false (read-only)
```

A read-only review physically cannot write a file. That is correct and expected:
stdout is the authoritative transport, and a completed review is never lost
because the sandbox refused a write. **Do not enable workspace write merely to
obtain a review artifact.**

#### Write-enabled tasks (fix, mutation)

```text
Source mutation policy:     ALLOWED ONLY IN ASSIGNED WORKTREE/SCOPE.
Artifact transport:         REQUIRED VIA FINAL STDOUT JSON.
Filesystem staging artifact: INSIDE LAUNCH_CWD.
Codex launcher write mode:  true (workspace-write)
```

The staging file is a secondary, redundant channel. The controller copies it out
only after validation.

#### Reconciliation

```text
codex_result_valid =
  terminal_status == success
  AND stdout_sentinel_present
  AND stdout_json_schema_valid
  AND identity_fields_match
  AND resultCompleteness == complete
  AND ( staging_artifact_absent
        OR canonical_hash(staging_json) == canonical_hash(stdout_json) )
```

| Situation | Outcome |
|---|---|
| Both channels present and hashes agree | accept, `transport=stdout+staging` |
| Only valid stdout | accept, `transport=stdout-only` |
| Both present, hashes differ | `BLOCKED: artifact-channel-mismatch` — never silently prefer one |
| Staging file valid, stdout sentinel absent | incomplete; mandatory rerun (section 5.4) |
| Staging path escapes `LAUNCH_CWD` | rejected; the path claim is untrusted input |

On any non-accept outcome both raw channels are retained under
`attempts/<attemptId>/diagnostics/` for inspection, and neither is evidence.

### 5.3 Launch receipts and workspace-aware polling

Every launch writes a receipt **before normal polling begins**
(`schemas/codex-launch-receipt-v1.schema.json`): attempt ID, task ID, task type,
`launchCwd`, `repoRoot`, worktree head, requested and effective effort, write
mode, and the staging/canonical artifact paths.

For `status`, `wait`, `result`, `resume`, and `cancel`, **always** use the
task's recorded `launchCwd` — via the supported `--cwd` argument, with the
process cwd set to the same directory. Never poll from the main checkout merely
because the controller lives there. Never invent unsupported flags.

A lookup failure from the wrong cwd is a **polling-context error**, not evidence
that the job crashed. Recovery order:

1. read the launch receipt;
2. verify `launchCwd` still exists and belongs to the expected repository;
3. rerun the companion operation from that exact context;
4. only if the correct workspace cannot find the task, classify
   `JOB_RECORD_MISSING`.

Scanning every companion state directory is a bounded
migration/disaster-recovery fallback (`codex-job.mjs recover`), never normal
polling.

Record these states distinctly — do **not** collapse them into "Codex failed":

```text
RUNNING  SUCCESS  FAILED  CANCELLED
POLLING_CONTEXT_ERROR   the cwd was wrong or the worktree is gone
JOB_RECORD_MISSING      the right workspace has no such job
JOB_STALE_PID           marked running behind a dead PID
JOB_STALLED             running with no log activity past the limit
```

More than ten minutes with no new log activity is a stall.

### 5.4 Incomplete results — a count is not evidence

A dead or incomplete job can still expose summary telemetry such as
`blocking=2` or `findings=3`. **A count is not a finding.**

A finding may enter the finding-judge pipeline only when it carries
complete structured content: `id`, `severity`, `file`, `line`, optional
`symbol`, a concrete falsifiable `claim`, specific `evidence`, and the
`headOid` / `baseOid` / `reviewKey` identity that binds it to this review.

A summary count without the underlying content must **not**:

- create blocker tickets;
- be posted to GitHub;
- cause a fix task;
- be treated as zero findings;
- grant acceptance.

Classify it as:

```text
REVIEW_INCONCLUSIVE
reason=missing-structured-result
```

For a terminal, stale, or dead task with no complete, schema-valid stdout
artifact:

1. preserve diagnostic logs and the launch receipt;
2. do **not** resume the incomplete task as the primary recovery path;
3. launch **one** fresh attempt from a clean exact-base/head worktree, with a
   new attempt ID, at the effective effort ceiling from preflight;
4. require the same stdout sentinel contract;
5. if the fresh attempt is also incomplete, set `BLOCKED: codex-output-incomplete`.

Never invent findings from either attempt. Attempt IDs are checked, so stale
output from attempt 1 cannot satisfy attempt 2.

A terminal job with `blocking=0` but no complete structured artifact is still
inconclusive and **cannot approve the PR**.

### 5.5 Using the wrapper

One shared wrapper handles capability normalization, launch-cwd validation,
receipt creation, same-workspace lifecycle calls, terminal classification,
sentinel extraction, staging reconciliation, canonical persistence, and the
compact handoff. Do not duplicate this logic in prompts.

```bash
node "${BABYSIT_SKILL_DIR}/scripts/codex-job.mjs" launch \
  --receipt   "$ART/attempts/$ATTEMPT/launch-receipt.json" \
  --capabilities "$RUN/codex-capabilities.json" \
  --launch-cwd "$WORKTREE" \
  --task-type review \
  --model gpt-5.6-sol --effort max \
  --pr "$PR" --head "$HEAD_OID" --base "$BASE_OID" --review-key "$REVIEW_KEY" \
  --attempt-id "$ATTEMPT" \
  --canonical "$ART/codex-review.json" \
  --prompt-file "$PROMPT"

node "${BABYSIT_SKILL_DIR}/scripts/codex-job.mjs" collect \
  --receipt     "$ART/attempts/$ATTEMPT/launch-receipt.json" \
  --diagnostics "$ART/attempts/$ATTEMPT/diagnostics" \
  --out         "$ART/attempts/$ATTEMPT/collect.json"
```

`collect` exits `0` accepted, `1` not accepted, `3` still running.

### 5.6 Temporary probes never live in the repository

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
- current classification state.

The main controller may query thread IDs, counts, and author logins, but not
thread bodies. Thread bodies are fetched only inside a fresh judgment
checkpoint.

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
`.claude/worktrees/` at the exact head. Do not review a moving branch name.

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
consumer (spec selector, Codex review prompt, verifier):

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

### 10.3 Codex Sol deep review

The main controller launches one Codex review task **from the read worktree**
through `scripts/codex-job.mjs` (section 5.5) — never as a bare `codex exec`
call without a receipt (section 2):

- `--task-type review`
- `--model gpt-5.6-sol`
- `--effort max` — normalized at preflight to the companion ceiling
- **no `--write`**: source mutation policy is FORBIDDEN;
- **no staging artifact**: the result travels over the stdout sentinel;
- exact base/head OIDs and the review key are passed and echoed back;
- relevant spec/plan paths;
- require traceable, actionable findings only;
- exclude style nits and spec-sanctioned divergences.

The task's own instructions must state:

```text
Source mutation policy:  FORBIDDEN.
Artifact transport:      REQUIRED VIA FINAL STDOUT JSON.
Filesystem artifact:     NOT REQUIRED.

End your final response with exactly one BABYSIT_PR_ARTIFACT_V1 block, as the
final structured block, matching schemas/codex-artifact-v1.schema.json. Echo
attemptId, pr, headOid, baseOid, and reviewKey exactly as given. Every finding
must carry file, a falsifiable claim, concrete evidence, and the same identity
fields. severity MUST be exactly one of: blocking, high, medium, low, advisory —
"non-blocking" is NOT in the enum; use advisory or low for a finding that should
not gate the merge. Set resultCompleteness to "complete" only if you finished the analysis;
otherwise set "partial" or "aborted" and say why. Never report a count in place
of the findings themselves.
```

The controller then runs `codex-job.mjs collect`, which reconciles the channels,
writes `codex-review.json` as `CANONICAL_ARTIFACT`, and returns the compact
handoff line. On a non-accept outcome apply section 5.4 — one fresh attempt,
then `BLOCKED: codex-output-incomplete`.

A finding whose claim is essentially "the test does not actually cover this"
must set `requiresMutationEvidence: true` (section 10.5).

For security, authentication, authorization, data integrity, concurrency,
migration, financial correctness, or resilience/breaker changes, the controller
may launch **one** additional independent Sol review as `--task-type risk-review`
into `codex-review-risk.json`. Mechanical changes get one pass.

### 10.4 Fresh finding judge

Run a fresh `finding-judge` checkpoint (section 2; requested `max`, effective
`xhigh`). Authorize GitHub writes only for its posting step (7 below).

Candidates are accepted **only** from an accepted, schema-valid
`CANONICAL_ARTIFACT`. If reconciliation did not accept, there are no candidates
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
6. write `judgment.json` and `confirmed-findings.json`;
7. post only surviving actionable findings as GitHub inline review comments;
8. update the single v2 status comment;
9. never implement code and never launch nested tasks.

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

When unresolved threads exist, run a fresh `thread-judge` checkpoint
(requested `max`, effective `xhigh`), authorizing GitHub writes only for its
reply/resolve step. It must:

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
5. for non-fix dispositions, recheck live state, post a concise
   evidence-backed reply, then resolve only when conclusive;
6. leave real findings unresolved until a verified fix commit has been pushed;
7. never resolve a thread without either:
   - a pushed fixing commit and fix-PR link; or
   - an evidence-backed disposition reply.

A genuine human question remains unresolved when the answer is uncertain.

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

Fix PR requirements:

- base: the reviewed PR's head branch;
- title: `fix(pr#<N>): address review findings`;
- body references `#<N>`;
- no force push;
- no push to the parent PR branch;
- fall back to another base only when the head branch is an inaccessible fork,
  and then mark the workflow `BLOCKED` for automatic merge rather than silently
  changing semantics.

### 12.2 Choose implementation lane

Batch every confirmed finding for the parent into one bounded task.

Use Terra-high when the work is clear and ordinary.

Start at Sol-high for complex but noncritical work:

- resilience/circuit-breaker logic;
- subtle performance correctness;
- complex multi-file behavior;
- a prior failed Terra implementation round.

Start directly at Sol-max for critical-risk work:

- security, authentication, or authorization;
- data integrity or financial correctness;
- concurrency, races, deadlocks, or ordering invariants;
- destructive or hard-to-reverse migrations.

Escalation:

```text
ordinary: Terra high -> Sol high -> Sol max
complex:  Sol high -> Sol max
critical: Sol max -> one targeted Sol-max correction
```

Allow at most three rounds for ordinary work and at most two rounds for complex
or critical work. Each round is sequential and consumes the previous verifier
feedback. Exhaustion becomes `BLOCKED`; the main controller must not become an
emergency code writer.

A fix task is **write-enabled**, launched through `codex-job.mjs` with `--write`
and a staging artifact path inside `LAUNCH_CWD`:

```text
Source mutation policy:      ALLOWED ONLY IN ASSIGNED WORKTREE/SCOPE.
Artifact transport:          REQUIRED VIA FINAL STDOUT JSON.
Filesystem staging artifact: INSIDE LAUNCH_CWD (e.g. ./fix-result.json).
```

Codex must:

- modify only the assigned worktree and scope;
- implement all batched confirmed findings;
- add/update focused tests;
- avoid unrelated refactors;
- run suitable local checks;
- commit with `git commit -s`;
- write the staging `fix-result.json` **inside its launch worktree**;
- **also** end its final response with the `BABYSIT_PR_ARTIFACT_V1` block, whose
  content must match the staging file exactly — the two channels are compared by
  canonical hash, and a mismatch is `BLOCKED: artifact-channel-mismatch`;
- not push or use GitHub.

The controller reconciles both channels and writes the canonical
`fix-result.json` under `CANONICAL_RUN_DIR`. A staging file with no stdout
sentinel is incomplete and triggers the section 5.4 rerun policy; the file alone
is never sufficient.

### 12.3 Fresh independent verifier

After every implementation round, run a fresh `verifier` checkpoint (requested
`max`, effective `xhigh`). It must not edit code or launch nested tasks.

It verifies:

- exact parent head and intended fix base;
- full diff, not only files named by Codex;
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

Write `verification.json`:

```json
{
  "pr": 123,
  "parentHead": "...",
  "fixCommit": "...",
  "verdict": "ACCEPT",
  "closedFindingIds": ["R1"],
  "blocking": [],
  "changedFiles": ["..."],
  "commands": ["..."],
  "results": ["..."],
  "residualRisk": "..."
}
```

Return only the compact handoff line.

`REJECT` feeds one bounded correction round into the next escalation tier.
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

Read the PR-body reactions with pagination and canonical variables:

```bash
gh api --paginate \
  -H 'Accept: application/vnd.github+json' \
  "repos/$REPO/issues/$PR/reactions" > "$ART/reactions.json"

gh pr view "$PR" --repo "$REPO" --json commits \
  --jq '.commits[-1].committedDate' > "$ART/head-committed-date.txt"
```

Then evaluate deterministically (this also handles multi-page output, and folds
`login[bot]` against the GraphQL `login` form):

```bash
python3 "${BABYSIT_SKILL_DIR}/scripts/external_review.py" fresh-pass \
  --policy "$REPO_CHECKOUT/.claude/babysit-prs.json" \
  --reactions "$ART/reactions.json" \
  --head-committed-date "$(cat "$ART/head-committed-date.txt")"
```

Always quote a `botLogin` containing `[bot]`; never interpolate it unquoted
into a `--jq` filter.

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

Do not evaluate this by hand. Build the observation document from the snapshot
and live GitHub state, then run:

```bash
python3 "${BABYSIT_SKILL_DIR}/scripts/external_review.py" evaluate \
  --input "$ART/external-review-observation.json" \
  --policy "$REPO_CHECKOUT/.claude/babysit-prs.json"
```

The decision carries `action`, `codexState`, `codexRound`,
`codexNextTriggerAt`, `externalReviewSatisfied`, and human-readable `reasons`.
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

On first entry to a new head:

```text
codexRound = 0
codexNextTriggerAt = now
```

so round 1 fires immediately. After a trigger is successfully posted:

```text
codexRound += 1
codexLastTriggerAt = comment.createdAt
codexNextTriggerAt = codexLastTriggerAt + retry.intervalSeconds
codexState = TRIGGER_IN_FLIGHT, then WAITING_RETRY once the bot responds
```

An existing current-head trigger **suppresses posting only until
`codexNextTriggerAt`**. It is not a permanent one-shot key. A head that has
already been triggered once and stayed silent for a full cooldown is due for the
next round, and the round after that, indefinitely.

When every bot finding has been disposed and the head did not change:

```text
codexLastDispositionCompletedAt = now
codexNextTriggerAt = max(now, codexLastTriggerAt + retry.minCollisionDelaySeconds)
```

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

Re-run `evaluate` on this refreshed observation. If it no longer returns
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
checkpoint (`xhigh`). For security, auth/authz, data-integrity, financial,
concurrency, destructive-migration, or otherwise high-risk composition, run
the `critical-composition-verifier` checkpoint instead (requested `max`,
effective `xhigh`). The selected checkpoint reads only:

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
round 1 is immediately due (section 13.3). On `REVIEW`, run the full Sol review
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
no collision or capability blocker
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
max live heavy agents: 4
max live writers: 2
poll interval: 60 seconds
external-only no-progress limit: 10 minutes
```

For each wave:

1. Snapshot all open non-draft PRs and rebuild the DAG.
2. Restrict actions to the requested operational scope.
3. Validate current review keys and states.
4. Dispatch independent read-only Codex reviews, at most four heavy sub-tasks
   live.
5. Dispatch the required judgment checkpoints after their input artifacts are
   terminal.
6. Dispatch thread-disposition checkpoints.
7. Batch confirmed fixes per parent.
8. Run Codex fix -> fresh verifier checkpoint sequentially.
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

The next `babysit-prs-codex` invocation reconstructs external-review state from the
GitHub status comment plus live comments and reactions, and posts the next
round as soon as it is due.

For continuous babysitting, run an external loop:

```bash
while :; do
  codex exec \
    --cd /home/chin39/Documents/play/stocks \
    --sandbox workspace-write \
    -c sandbox_workspace_write.network_access=true \
    "use babysit-prs-codex"
  sleep 1800
done
```

Each iteration is a fresh invocation that reconstructs state from GitHub. This
keeps retrying on the policy cooldown until the bot leaves a fresh pass
reaction on the PR body.

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

Clean up only worktrees owned by this run. Use `git worktree remove` and
`git worktree prune`; do not `rm -rf` an unknown worktree.

---

## 20. Dry-run and snapshot-only behavior

With `--snapshot-only` (section 1.1): observe and report only. No Codex task,
no checkpoint, no worktree, no test, no artifact beyond the four snapshot
files, and no GitHub write. Every action label is prefixed `🔎 SNAPSHOT:`.

With `--dry-run`:

- build the complete snapshot and stack graph;
- compute proposed review keys and states;
- read existing artifacts;
- read-only Codex review and local validation are allowed;
- evaluate external review and report
  `would trigger <triggerComment> round <N>`;
- do not post/update comments;
- never post an external-review trigger, in any mode, for any reason;
- do not reply or resolve threads;
- do not push;
- do not create/update PRs;
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
7. any model/effort downgrade or unavailable capability.

When any PR is still `WAITING_CODEX`, remind the user that the external
30-minute loop of section 17.1 continues the retry loop automatically.

Do not include findings prose, diffs, spec excerpts, or long test logs in the
final report.

---

## 22. Hard rules

- This skill runs under the Codex CLI with a Sol-class `xhigh` controller; it
  is not a Hermes profile and not the Claude Code skill.
- Keep the main controller thin: no full diffs, specs, or thread bodies.
- Critical judgment and final-verification checkpoints request `max` and run at
  the `xhigh` ceiling; bounded spec-selection and ordinary composition
  checkpoints run at `xhigh`. They never spawn sub-tasks.
- The main controller dispatches Codex tasks and checkpoints as sibling
  operations. Codex tasks go through `scripts/codex-job.mjs`, never as bare
  `codex exec` calls — a bare call has no receipt, no capability
  normalization, no launch-cwd validation, and no artifact reconciliation.
- Deep review is Codex Sol-max; implementation follows risk-aware routing:
  Terra-high for ordinary work, Sol-high for complex noncritical work, and
  Sol-max immediately for critical-risk work.
- An implementer claim is not acceptance. A fresh verifier checkpoint and real
  local gates are required before push.
- Codex effort is normalized at preflight from a non-executing capability probe.
  Never launch an unsupported effort and rely on the retry. Never guess an
  accepted set: an ambiguous probe blocks Codex-dependent remote writes.
- Every Codex task echoes its result as a final `BABYSIT_PR_ARTIFACT_V1` stdout
  block. Read-only tasks transport results over stdout only; never grant
  workspace write merely to obtain an artifact, and never claim a path-scoped
  sandbox the launcher does not have.
- Codex never writes outside its `LAUNCH_CWD`. Only the controller writes
  `CANONICAL_ARTIFACT`, and only after schema, identity, and hash validation.
- Two artifact channels that disagree are `BLOCKED: artifact-channel-mismatch`.
  Never silently prefer one.
- Every launch writes a receipt before polling. Every `status`/`result`/
  `cancel`/`resume` replays the recorded `launchCwd`. "No job found" from the
  wrong workspace is a polling-context error, never a crashed job.
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
- `--snapshot-only` dispatches no Codex task, no checkpoint, and no worktree.
  It observes and reports; it never advances a state machine.
