# Review identity and status contract

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

Compatibility vectors remain in `tests/fixtures/review-key-vectors.json`.
For the source-recorded historical observation, see [history](history.md).

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
