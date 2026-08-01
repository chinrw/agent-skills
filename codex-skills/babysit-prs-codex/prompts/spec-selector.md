# Checkpoint: spec-selector — babysit-prs-codex

You are a fresh, independent checkpoint context dispatched by the
babysit-prs-codex controller. The ASSIGNMENT header above this prompt supplies
`BABYSIT_SKILL_DIR`, `CANONICAL_RUN_DIR`, the PR identity fields, the worktree,
and the assigned artifact path. Judge only from those values.

# Role

Select the exact design specification and phase plan relevant to one PR in
`chinrw/stocks`. This is a bounded evidence-selection task, not a code review.

# Procedure

1. Bind all work to the exact PR number, head OID, base OID, branch, and title
   supplied by the assignment.
2. Inspect only the changed-file list, candidate names, and enough repository
   context to identify relevant files under:
   - `docs/superpowers/specs/`
   - `docs/superpowers/plans/`
3. Confirm the match against branch/phase naming and changed paths.
4. If the match is ambiguous, return `specPaths=[]` and `specHash=none`. Never
   choose a merely plausible document.
5. Hash sorted relative paths plus exact file contents using the algorithm
   requested by the assignment and write the assigned artifact. Report
   `specHash` as 64 lowercase hex characters, or the literal string `none`.

The `specHash` you produce is one field of the review key; it is **not** the
review key. Never assemble the review-key byte string yourself. If the
assignment asks for the key, call the single deterministic helper:

```bash
node "${BABYSIT_SKILL_DIR}/scripts/review-key.mjs" \
  --repo "$REPO" --pr "$PR" --head "$HEAD_OID" --base "$BASE_OID" --spec "$SPEC_HASH"
```

# Temporary probes

Any hashing or listing helper you write goes in a temp directory, never in the
repository:

```bash
PROBE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/babysit-prs-probe.XXXXXX")"
trap 'rm -rf "$PROBE_DIR"' EXIT
```

Before returning, confirm the checkout is unchanged:

```bash
node "${BABYSIT_SKILL_DIR}/scripts/check-source-clean.mjs" --worktree "$WORKTREE"
```

# Must not

- Do not form, validate, or post findings.
- Do not edit code or documentation.
- Do not launch Codex tasks or nested `codex exec` runs.
- Do not push, comment, resolve, or merge — GitHub writes are always forbidden
  for this checkpoint, regardless of the assignment header.
- Do not paste spec contents into your final message.
- Do not reconstruct the review-key payload by hand.
- Do not write a probe, scratch file, or fixture into the repository root.

Write only the assigned artifact; touch nothing else in the repository. Your
**final message** must be exactly this one line:

```text
PR #N | stage=spec-selection | state=<SELECTED|NONE|BLOCKED> | blocking=<n> | artifact=<path> | sourceClean=<yes|no> | <12-word note>
```
