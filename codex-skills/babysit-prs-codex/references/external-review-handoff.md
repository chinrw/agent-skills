# Local external-review handoff

The controller saves raw GitHub output, calls the local handoff module, and
performs authorized GitHub writes. The module performs no network requests.

## Saved observations

Save successful, complete responses for these sources:

| File role | GitHub data |
|---|---|
| pr | `gh pr view --json number,state,isDraft,headRefOid,commits,reviews` |
| base | `gh api repos/<repo>/git/ref/heads/<base-branch>` |
| comments | Paginated issue comments, including the status marker and exact triggers |
| reactions | Paginated PR-body reactions |
| threads | Paginated GraphQL reviewThreads with id, isResolved, first comment author/createdAt and pageInfo |

Comments and reactions accept arrays, arrays of pages, or concatenated JSON
arrays from `gh api --paginate`. An actual empty array is valid; empty output,
null and error objects are not successful empty responses.

Thread responses use the GraphQL shape
`data.repository.pullRequest.reviewThreads`. The final page must explicitly
report hasNextPage=false. Each unresolved thread must include its first comment's
author. Submitted reviews retain configured-bot activity even without inline
threads; pending reviews do not count. Unknown actors are never treated as
configured-bot activity.

For an enabled policy, the controller can collect threads with:

```bash
gh api graphql --paginate -F owner="$OWNER" -F name="$NAME" -F number="$PR" \
  -f query='query($owner:String!, $name:String!, $number:Int!, $endCursor:String) {
    repository(owner:$owner, name:$name) {
      pullRequest(number:$number) {
        reviewThreads(first:100, after:$endCursor) {
          nodes { id isResolved comments(first:1) { nodes { author { login } createdAt } } }
          pageInfo { hasNextPage endCursor }
        }
      }
    }
  }' > "$ART/threads.json"
```

Under disabled policy, retain the existing no-bot-query rule. Explicit empty
responses may represent deliberately unqueried bot data; they must not mask
a failed collection command. Check every collection exit status before handoff.

## Manifest and decision

Save a manifest next to those files. Paths are relative to the manifest or absolute:

```json
{
  "repo": "chinrw/stocks",
  "pr": 379,
  "prClass": "integration-root",
  "now": "2026-09-08T08:00:00Z",
  "expected": {"headOid": "<full expected head>", "baseOid": "<full expected base>"},
  "marker": {"spec": "none", "key": "<review-key.mjs output>", "state": "NEEDS_REVIEW"},
  "policy": "<repository policy JSON path>",
  "files": {
    "pr": "pr.json", "base": "base.json", "comments": "comments.json",
    "reactions": "reactions.json", "threads": "threads.json"
  }
}
```

Optional fields are policy, roundsThisInvocation, dispositionCompletedAt and
dryRun. An omitted policy uses the existing disabled defaults; a named policy
file that cannot be read is an error.
The controller supplies the PR state it has established; an external-review
pass alone cannot create READY_ROOT or READY_STACKED.

```bash
node "$BABYSIT_SKILL_DIR/scripts/external-review.mjs" \
  --input "$ART/observations/input.json" \
  --out "$ART/external-review-handoff.json"
```

The file contains observation, decision, persisted external-review fields, and
the complete marker string. Stdout contains a compact decision and file hash.
Exit 0 means evaluation completed; inspect decision.action and
decision.requiresResnapshot. Exit 2 means invalid input or I/O failure and
leaves the prior output file untouched.

The helper checks expected head/base independently of policy shortcuts and
validates the marker key with the existing review-key implementation. Changed
identity produces STAND_DOWN and a null marker; it never attaches an old key
to a new head.

## Confirmed or uncertain writes

Immediately before a trigger, refresh the raw observations and rerun handoff.
Only a fresh POST_TRIGGER decision permits the controller to perform the write.
Save the returned comment object. Update now after receiving it and add:

```json
{
  "postedTrigger": {
    "status": "confirmed",
    "headOid": "<head used for the write>",
    "baseOid": "<base used for the write>",
    "file": "posted-trigger.json"
  }
}
```

Rerun the same handoff command. The receipt needs a positive comment id,
matching issue_url and trigger body, and a timestamp between the head's commit
time and now. A receipt already present in observed comments is not counted
twice. Fresh passes and changed observations are reevaluated after the fold.

For an uncertain or failed write, set postedTrigger.status to `unknown` or
`failed` without a receipt file. The result requires a fresh observation,
does not advance the round, and supplies no marker. Never synthesize a successful
receipt from a requested timestamp or a planned round.

After confirmed evaluation, the controller places the returned marker at the
start of its existing status comment. Preserve the human-readable body and the
single-comment collision rules. Reuse the marker's persisted fields on the next
invocation through saved live comments; do not hand-copy retry counters.
