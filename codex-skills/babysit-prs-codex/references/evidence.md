# Task evidence and snapshots

## 3. Context hygiene and run artifacts

Read compact metadata and artifact summaries by default. When a decision needs
more evidence, read the relevant diff, spec, thread, finding, or log excerpt.
Delegate detailed review and implementation; reading an excerpt does not replace
fresh independent verification. Keep large bodies in their artifact files;
request bounded excerpts when a decision needs them.

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

Every checkpoint writes its detailed result to the assigned artifact and
returns its initial handoff as one line in this form:

```text
PR #N | stage=<stage> | state=<state> | blocking=<n> | artifact=<path> | <12-word note>
```

Return the initial one-line handoff with its artifact path. On a controller
follow-up that requests evidence, return only the requested bounded excerpt
and artifact references.

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
