# Checkpoint evidence admission

The controller observes native completion, then runs the same acceptance CLI
used for task results. A valid REJECT, BLOCKED, REVIEW, or ESCALATE_MAX result
is evidence for that outcome. It is not an ACCEPT verdict.

## Assignment

Save one controller-owned expected.json per attempt:

```json
{
  "repo": "chinrw/stocks",
  "checkpointType": "verifier",
  "attemptId": "att-verifier-1",
  "pr": 379,
  "subject": {
    "parentHead": "<full OID>",
    "fixCommit": "<full OID>",
    "baseOid": "<full OID>",
    "reviewKey": "<64 lowercase hex>",
    "specHash": "none"
  },
  "worktree": "<absolute assigned worktree>",
  "inputs": {
    "fix": {"path": "<absolute canonical fix result>", "sha256": "<canonical JSON hash>"},
    "findings": {"path": "<absolute admitted judgment>", "sha256": "<canonical JSON hash>"}
  }
}
```

- Paths and input hashes come from the controller's accepted evidence.
- Input references use absolute paths. The child receives them for reading;
  its result echoes only the role-to-hash map.
- `repo` is needed to derive a prior composition's new review key.
- Use a new attempt ID and output path for every attempt.
- Generate the kind-specific instructions from the schema:

```bash
node "$BABYSIT_SKILL_DIR/scripts/validate-artifact.mjs" contract \
  --checkpoint-type verifier
```

## Result

Every checkpoint writes this envelope to its assigned attempt result path:

```json
{
  "schemaVersion": 1,
  "checkpointType": "verifier",
  "attemptId": "att-verifier-1",
  "pr": 379,
  "subject": {"<kind-specific role>": "<assigned value>"},
  "inputs": {"fix": "<assigned hash>", "findings": "<assigned hash>"},
  "resultCompleteness": "complete",
  "verdict": "REJECT",
  "result": {"<kind-specific fields>": "<values>"}
}
```

The placeholders above illustrate nesting; the actual required fields and
enums are in `schemas/checkpoint-artifact-v1.schema.json`. Existing review/fix
task results continue using `codex-artifact-v1.schema.json` unchanged.

| Kind | Subject | Required input roles | Result |
|---|---|---|---|
| spec-selector | headOid, baseOid | none | specPaths, specHash, reason |
| finding-judge | headOid, baseOid, reviewKey, specHash | review | findings with classification, reason, location and proposed comment; residualRisk |
| thread-judge | headOid, baseOid, reviewKey, specHash | threads | dispositions with threadId, classification, reason, reply and resolve; residualRisk |
| verifier | parentHead, fixCommit, baseOid, reviewKey, specHash | fix, findings | closedFindingIds, blocking, changedFiles, commands, results, residualRisk |
| composition-verifier | oldParentHead, newParentHead, childHead, baseOid, parentReviewKey, childReviewKey, specHash | parent, child | evidence, checkedInvariants, blocking, residualRisk |
| critical-composition-verifier | same composition roles | parent, child | same composition fields |

- Spec selection has no review key yet. NONE requires empty specPaths and
  specHash=none. This change does not redefine specification hashing; retain
  the assignment's existing algorithm.
- Each finding judge covers every finding in its one assigned review artifact.
  Judge a risk-review artifact separately. Keep confirmed IDs unambiguous when
  combining judgments for a fix.
- `threads` is a saved array of assigned thread metadata with string `id`
  fields, or an object containing that array under `threads`.
- REAL_FIX_REQUIRED includes `finding` with id, file, claim and evidence. It cannot
  recommend resolution. Conclusive resolution recommendations need a reply.
- A verifier consumes the committed v1 fix result and admitted finding/thread
  judgment under `findings`. Add `riskFindings` or `threadFindings` input roles
  when those sources also contributed to the assignment. Its ACCEPT must close
  all confirmed findings, and neither the fix nor verifier may invent closure
  IDs. Conflicting uses of the same ID across judgments are rejected.
- Composition inputs must be admitted ACCEPT checkpoints with the assigned
  parent/child roles. BLOCKED and REVIEW inputs cannot prove prior acceptance.
- A prior composition's accepted head is newParentHead; its new key is derived
  through `review-key.mjs`. Do not substitute either old input key.

## Controller acceptance

After the native tool reports completion:

```bash
node "$BABYSIT_SKILL_DIR/scripts/validate-artifact.mjs" \
  --input "$ART/attempts/$ATTEMPT/result.json" \
  --expect "$ART/attempts/$ATTEMPT/expected.json" \
  --status completed --out "$ART/verification.json"
```

- Exit 0 admits the result and returns its actual verdict and canonical hash.
- Exit 1 rejects incomplete results, stale identity, changed inputs, inconsistent
  verdicts, or dirty/moved source. Prior canonical evidence stays untouched.
- Exit 2 reports invalid invocation or I/O failure; it never grants acceptance.
- The helper checks actual input schemas, identities and hashes, and runs the
  source-clean check itself. A child-supplied sourceClean label is not evidence.
- The controller retains ownership of commits and GitHub writes. A verdict
  still needs the pipeline's live collision and readiness checks before action.

Keep canonical filenames such as judgment.json, thread-dispositions.json,
verification.json and composition-verification.json. The finding judgment's
`result.findings` is authoritative; confirmed findings are the rows classified
CONFIRMED_BLOCKING or CONFIRMED_NON_BLOCKING. Do not maintain a second independent
confirmed-findings.json that can diverge from its admitted judgment.

Historical checkpoint files remain available for inspection. Files without the
new envelope cannot be admitted through this path; obtain a fresh checkpoint
when new evidence is required. Never rewrite old artifacts to invent provenance.
