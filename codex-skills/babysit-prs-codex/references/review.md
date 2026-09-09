# Independent PR and thread review

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
PR is a review-scoping error, not a cosmetic one. Historical examples are recorded in [history](history.md).

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
