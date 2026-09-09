# Historical observations

These excerpts were present in source commit
`c703134bcc806c5a18af8e10bdbef66b2b0c3a30`, reviewed on 2026-09-09. The original
observation dates were not recorded. They explain compatibility and past
failures; they do not describe current PR state. Read them when investigating
legacy evidence, not as current acceptance or cleanup authority.

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


Observed on a live run: PRs
363/366/373/377 each showed 32-34 changed files two-dot, versus 1-3 files
three-dot. A review scoped two-dot would have reported findings against
unrelated frontend work — and, worse, the spec selector would have bound to
spec files that arrived from base drift rather than from the PR.
