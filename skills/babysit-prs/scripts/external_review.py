#!/usr/bin/env python3
"""Deterministic external-review (Codex) retry state machine for /babysit-prs.

Pure stdlib. No network, no GitHub writes, no side effects. The skill assembles
an *observation* document from live GitHub state plus the persisted marker
fields of the single update-in-place babysit status comment, and this module
returns the next external-review decision.

The point of this module is that the retry decision is a deterministic
predicate, not an LLM judgement call. The controller may not override a
decision returned here; it may only re-observe and re-evaluate.

Subcommands:
  evaluate        decide the next external-review action for one PR
  fresh-pass      report the latest configured pass reaction and its freshness
  resolve-policy  print the effective policy after defaults are applied

Exit codes are 0 for a successful evaluation regardless of the decision, and 2
for malformed input. A non-zero exit never means "trigger" or "do not trigger".
"""

from __future__ import annotations

import argparse
import copy
import json
import sys
from datetime import datetime, timedelta, timezone

POLICY_VERSION = "babysit-prs-external-review-v1"

# A very short delay applied when a re-review is wanted immediately (all Codex
# threads disposed on an unchanged head). It exists only so two concurrent
# babysitter sessions cannot post the same trigger in the same instant.
MIN_COLLISION_DELAY_SECONDS = 60

MODE_FRESH_PASS_RETRY = "fresh-pass-retry"
MODE_ONE_ROUND = "one-round"
MODE_DISABLED = "disabled"
VALID_MODES = (MODE_FRESH_PASS_RETRY, MODE_ONE_ROUND, MODE_DISABLED)

# Conservative repository-agnostic default: a repository that has not opted in
# is never queried for a bot, never triggered, and never gated on one.
DEFAULT_POLICY = {
    "enabled": False,
    "botLogin": None,
    "triggerComment": None,
    "passReaction": "+1",
    "reactionTarget": "pr-body",
    "rootMode": MODE_DISABLED,
    "strictStackedMode": MODE_DISABLED,
    "retry": {
        "enabled": False,
        "intervalSeconds": 1800,
        "maxRoundsPerInvocation": 2,
        "maxTotalRounds": None,
        "minCollisionDelaySeconds": MIN_COLLISION_DELAY_SECONDS,
    },
}

# External-review states persisted in the status-comment marker.
S_DISABLED = "DISABLED"
S_PASS_FRESH = "PASS_FRESH"
S_FINDINGS_OPEN = "FINDINGS_OPEN"
S_TRIGGER_DUE = "TRIGGER_DUE"
S_TRIGGER_IN_FLIGHT = "TRIGGER_IN_FLIGHT"
S_WAITING_RETRY = "WAITING_RETRY"
S_ONE_ROUND_SATISFIED = "ONE_ROUND_SATISFIED"
S_STOPPED_PR_CLOSED = "STOPPED_PR_CLOSED"
S_BLOCKED_SNAPSHOT_STALE = "BLOCKED_SNAPSHOT_STALE"
S_EXHAUSTED_TOTAL_ROUNDS = "EXHAUSTED_TOTAL_ROUNDS"
S_POLICY_INVALID = "POLICY_INVALID"

# Decision actions.
A_NONE = "NONE"
A_WAIT = "WAIT"
A_POST_TRIGGER = "POST_TRIGGER"
A_STAND_DOWN = "STAND_DOWN"
A_DRY_RUN_WOULD_POST = "DRY_RUN_WOULD_POST"

# Mapping to the skill's own PR state machine. Bot silence maps to
# WAITING_CODEX and never to a terminal blocker.
SKILL_STATE = {
    S_FINDINGS_OPEN: "WAITING_THREADS",
    S_TRIGGER_DUE: "WAITING_CODEX",
    S_TRIGGER_IN_FLIGHT: "WAITING_CODEX",
    S_WAITING_RETRY: "WAITING_CODEX",
    S_EXHAUSTED_TOTAL_ROUNDS: "WAITING_CODEX",
    S_POLICY_INVALID: "BLOCKED",
}

SATISFYING_STATES = (S_DISABLED, S_PASS_FRESH, S_ONE_ROUND_SATISFIED)


# --------------------------------------------------------------------------
# primitives
# --------------------------------------------------------------------------


def parse_ts(value):
    """Parse a UTC ISO-8601 timestamp. Returns an aware datetime or None."""
    if value is None:
        return None
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    text = str(value).strip()
    if not text or text.lower() == "null":
        return None
    if text.endswith("Z") or text.endswith("z"):
        text = text[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError as exc:
        raise ValueError("bad ISO-8601 timestamp: %r" % value) from exc
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def fmt_ts(value):
    """Render a datetime as UTC ISO-8601 with a trailing Z."""
    if value is None:
        return None
    return value.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def normalize_login(login):
    """Fold a GitHub login so `x[bot]` (REST) and `x` (GraphQL) compare equal."""
    if not login:
        return ""
    text = str(login).strip().lower()
    if text.endswith("[bot]"):
        text = text[: -len("[bot]")]
    return text


def login_matches(candidate, configured):
    normalized = normalize_login(candidate)
    return normalized != "" and normalized == normalize_login(configured)


def load_json_stream(text):
    """Decode one JSON value, or several concatenated ones.

    `gh api --paginate` emits one JSON array per page with no separator, and
    `gh api --paginate --slurp` emits a single array of arrays. Both forms, and
    the plain single-page form, decode correctly here.
    """
    decoder = json.JSONDecoder()
    index = 0
    length = len(text)
    values = []
    while index < length:
        while index < length and text[index].isspace():
            index += 1
        if index >= length:
            break
        value, index = decoder.raw_decode(text, index)
        values.append(value)
    return values


def flatten_objects(values):
    """Flatten arbitrarily nested lists of JSON objects into a flat list."""
    flat = []

    def walk(node):
        if isinstance(node, list):
            for item in node:
                walk(item)
        elif isinstance(node, dict):
            flat.append(node)

    for value in values:
        walk(value)
    return flat


def read_records(path):
    """Read a reactions/comments payload from a file or `-` for stdin."""
    raw = sys.stdin.read() if path in ("-", None) else open(path, encoding="utf-8").read()
    return flatten_objects(load_json_stream(raw))


# --------------------------------------------------------------------------
# policy
# --------------------------------------------------------------------------


def resolve_policy(raw):
    """Merge a repo-local policy onto the conservative defaults."""
    policy = copy.deepcopy(DEFAULT_POLICY)
    source = raw or {}
    if isinstance(source, dict) and isinstance(source.get("externalReview"), dict):
        source = source["externalReview"]
    if not isinstance(source, dict):
        source = {}
    for key, value in source.items():
        if key == "retry" and isinstance(value, dict):
            policy["retry"].update(value)
        else:
            policy[key] = value
    policy["policyVersion"] = POLICY_VERSION
    return policy


def policy_errors(policy):
    """Return configuration errors that must block writes rather than be guessed."""
    errors = []
    if not policy.get("enabled"):
        return errors
    if not policy.get("botLogin"):
        errors.append("externalReview.botLogin is required when enabled")
    if not str(policy.get("triggerComment") or "").strip():
        errors.append("externalReview.triggerComment is required when enabled")
    if not str(policy.get("passReaction") or "").strip():
        errors.append("externalReview.passReaction is required when enabled")
    if policy.get("reactionTarget") != "pr-body":
        errors.append(
            "externalReview.reactionTarget must be 'pr-body'; got %r"
            % (policy.get("reactionTarget"),)
        )
    for key in ("rootMode", "strictStackedMode"):
        if policy.get(key) not in VALID_MODES:
            errors.append("externalReview.%s must be one of %s" % (key, ", ".join(VALID_MODES)))
    retry = policy.get("retry") or {}
    interval = retry.get("intervalSeconds")
    if not isinstance(interval, (int, float)) or interval <= 0:
        errors.append("externalReview.retry.intervalSeconds must be a positive number")
    per_invocation = retry.get("maxRoundsPerInvocation")
    if not isinstance(per_invocation, int) or per_invocation < 1:
        errors.append("externalReview.retry.maxRoundsPerInvocation must be an integer >= 1")
    total = retry.get("maxTotalRounds")
    if total is not None and (not isinstance(total, int) or total < 1):
        errors.append("externalReview.retry.maxTotalRounds must be null or an integer >= 1")
    return errors


def select_mode(observation, policy):
    """Pick rootMode or strictStackedMode from the PR's position in the stack."""
    explicit = observation.get("mode")
    if explicit:
        return explicit
    pr_class = str(observation.get("prClass") or "").strip().lower()
    if pr_class in ("strict-stacked", "strict_stacked", "stacked"):
        return policy.get("strictStackedMode")
    return policy.get("rootMode")


# --------------------------------------------------------------------------
# evidence extraction
# --------------------------------------------------------------------------


def latest_pass_reaction(reactions, policy):
    """Latest configured pass reaction left by the configured bot on the PR body.

    Callers must pass reactions from `repos/{repo}/issues/{pr}/reactions`, which
    is the PR body. Reactions on issue comments or review comments live on
    different endpoints and are not a pass signal.
    """
    latest = None
    for reaction in reactions or []:
        user = reaction.get("user") or reaction.get("author") or {}
        if not login_matches(user.get("login"), policy.get("botLogin")):
            continue
        if str(reaction.get("content", "")) != str(policy.get("passReaction")):
            continue
        created = parse_ts(reaction.get("created_at") or reaction.get("createdAt"))
        if created is None:
            continue
        if latest is None or created > latest:
            latest = created
    return latest


def exact_triggers(comments, policy, since=None):
    """Issue comments whose trimmed body equals the configured trigger exactly."""
    wanted = str(policy.get("triggerComment") or "").strip()
    found = []
    if not wanted:
        return found
    for comment in comments or []:
        body = str(comment.get("body") or "").strip()
        if body != wanted:
            continue
        created = parse_ts(comment.get("createdAt") or comment.get("created_at"))
        if created is None:
            continue
        if since is not None and created < since:
            continue
        author = comment.get("author") or comment.get("user") or {}
        found.append(
            {
                "at": created,
                "author": author.get("login"),
                "id": comment.get("id") or comment.get("databaseId"),
            }
        )
    found.sort(key=lambda item: item["at"])
    return found


def unresolved_codex_threads(observation, policy):
    """Count unresolved review threads authored by the configured bot."""
    value = observation.get("unresolvedCodexThreads")
    if isinstance(value, int):
        return value
    if isinstance(value, list):
        if not value:
            return 0
        if all(isinstance(item, dict) for item in value):
            return sum(
                1
                for item in value
                if item.get("author") is None
                or login_matches(
                    (item.get("author") or {}).get("login")
                    if isinstance(item.get("author"), dict)
                    else item.get("author"),
                    policy.get("botLogin"),
                )
            )
        return len(value)
    return 0


def latest_bot_activity(observation, policy):
    """Most recent evidence that the bot did anything on the current head."""
    latest = parse_ts(observation.get("lastBotActivityAt"))
    for event in observation.get("botActivity") or []:
        if isinstance(event, dict):
            login = event.get("login") or (event.get("author") or {}).get("login")
            if login is not None and not login_matches(login, policy.get("botLogin")):
                continue
            when = parse_ts(event.get("at") or event.get("createdAt") or event.get("created_at"))
        else:
            when = parse_ts(event)
        if when is None:
            continue
        if latest is None or when > latest:
            latest = when
    return latest


# --------------------------------------------------------------------------
# evaluation
# --------------------------------------------------------------------------


def _decision(**overrides):
    base = {
        "policyVersion": POLICY_VERSION,
        "codexHeadOid": None,
        "codexMode": None,
        "codexState": None,
        "codexRound": 0,
        "codexLastTriggerAt": None,
        "codexNextTriggerAt": None,
        "codexLastBotActivityAt": None,
        "codexLatestPassReactionAt": None,
        "codexLastDispositionCompletedAt": None,
        "triggerDue": False,
        "action": A_NONE,
        "externalReviewSatisfied": False,
        "gateBlocking": True,
        "terminal": False,
        "retryStopped": False,
        "requiresResnapshot": False,
        "queriedBot": False,
        "plannedRound": None,
        "skillState": None,
        "message": None,
        "reasons": [],
    }
    base.update(overrides)
    return base


def _finish(decision):
    state = decision["codexState"]
    decision["externalReviewSatisfied"] = state in SATISFYING_STATES
    if state in SATISFYING_STATES or state == S_STOPPED_PR_CLOSED:
        decision["gateBlocking"] = False
    if state in (S_DISABLED, S_PASS_FRESH, S_STOPPED_PR_CLOSED):
        decision["retryStopped"] = True
    decision["skillState"] = SKILL_STATE.get(state)
    decision["markerFragment"] = (
        "codexState=%s codexRound=%s codexNextTriggerAt=%s"
        % (
            decision["codexState"],
            decision["codexRound"],
            decision["codexNextTriggerAt"] or "-",
        )
    )
    return decision


def evaluate(observation, now=None):
    """Return the external-review decision for one PR. Pure function."""
    policy = resolve_policy(observation.get("policy"))
    now = parse_ts(now) if now is not None else parse_ts(observation.get("now"))
    if now is None:
        raise ValueError("observation.now (or --now) is required")

    mode = select_mode(observation, policy)
    head = observation.get("head") or {}
    head_oid = head.get("oid")
    head_at = parse_ts(head.get("committedDate"))
    dry_run = bool(observation.get("dryRun"))
    persisted = observation.get("persisted") or {}

    errors = policy_errors(policy)
    if errors:
        return _finish(
            _decision(
                codexHeadOid=head_oid,
                codexMode=mode,
                codexState=S_POLICY_INVALID,
                terminal=True,
                reasons=errors,
            )
        )

    # 1. Repository has not opted in, or this position in the stack is exempt.
    #    Nothing is queried, nothing is triggered, nothing is gated.
    if not policy.get("enabled") or mode == MODE_DISABLED:
        return _finish(
            _decision(
                codexHeadOid=head_oid,
                codexMode=MODE_DISABLED,
                codexState=S_DISABLED,
                reasons=["external review disabled by effective repository policy"],
            )
        )

    if mode not in VALID_MODES:
        return _finish(
            _decision(
                codexHeadOid=head_oid,
                codexMode=mode,
                codexState=S_POLICY_INVALID,
                terminal=True,
                reasons=["unknown external-review mode: %r" % (mode,)],
            )
        )

    # 2. A closed or merged PR ends the retry loop for good.
    pr_state = str(observation.get("prState") or "OPEN").upper()
    if pr_state not in ("OPEN",):
        return _finish(
            _decision(
                codexHeadOid=head_oid,
                codexMode=mode,
                codexState=S_STOPPED_PR_CLOSED,
                terminal=True,
                reasons=["PR state is %s; retries stop" % pr_state],
            )
        )

    # 3. The observation must describe the head/base the caller expects. A PR
    #    that moved underneath the snapshot is re-snapshotted, never written to.
    expected = observation.get("expected") or {}
    base_oid = (observation.get("base") or {}).get("oid")
    mismatches = []
    if expected.get("headOid") and expected["headOid"] != head_oid:
        mismatches.append("head %s != expected %s" % (head_oid, expected["headOid"]))
    if expected.get("baseOid") and base_oid and expected["baseOid"] != base_oid:
        mismatches.append("base %s != expected %s" % (base_oid, expected["baseOid"]))
    if mismatches:
        return _finish(
            _decision(
                codexHeadOid=head_oid,
                codexMode=mode,
                codexState=S_BLOCKED_SNAPSHOT_STALE,
                requiresResnapshot=True,
                reasons=["snapshot is stale: " + "; ".join(mismatches)],
            )
        )

    if observation.get("isDraft"):
        return _finish(
            _decision(
                codexHeadOid=head_oid,
                codexMode=mode,
                codexState=S_WAITING_RETRY,
                reasons=["PR is a draft; no trigger is posted"],
            )
        )

    if head_at is None:
        raise ValueError("observation.head.committedDate is required")

    reasons = []

    # 4. A new head resets the round counter and makes round 1 due immediately.
    same_head = bool(head_oid) and persisted.get("codexHeadOid") == head_oid
    if not same_head:
        previous = persisted.get("codexHeadOid")
        reasons.append(
            "no persisted external-review state for head %s (%s): codexRound=0, "
            "codexNextTriggerAt=now"
            % (head_oid, ("previous head %s" % previous) if previous else "new or legacy marker")
        )

    # 5. Fresh pass wins over everything else, including a trigger already
    #    scheduled for this instant.
    reactions = observation.get("reactions") or []
    latest_pass = latest_pass_reaction(reactions, policy)
    fresh_pass = latest_pass is not None and latest_pass >= head_at
    bot_activity = latest_bot_activity(observation, policy)

    common = {
        "codexHeadOid": head_oid,
        "codexMode": mode,
        "queriedBot": True,
        "codexLatestPassReactionAt": fmt_ts(latest_pass),
        "codexLastBotActivityAt": fmt_ts(bot_activity),
    }

    if fresh_pass:
        return _finish(
            _decision(
                codexState=S_PASS_FRESH,
                codexRound=int(persisted.get("codexRound") or 0) if same_head else 0,
                codexLastTriggerAt=persisted.get("codexLastTriggerAt") if same_head else None,
                terminal=True,
                reasons=reasons
                + [
                    "fresh %s from %s at %s >= head committedDate %s"
                    % (
                        policy["passReaction"],
                        policy["botLogin"],
                        fmt_ts(latest_pass),
                        fmt_ts(head_at),
                    )
                ],
                **common,
            )
        )

    if latest_pass is not None:
        reasons.append(
            "stale %s at %s predates head committedDate %s"
            % (policy["passReaction"], fmt_ts(latest_pass), fmt_ts(head_at))
        )

    # 6. Findings take priority over triggering another round.
    open_threads = unresolved_codex_threads(observation, policy)
    if open_threads > 0:
        return _finish(
            _decision(
                codexState=S_FINDINGS_OPEN,
                codexRound=int(persisted.get("codexRound") or 0) if same_head else 0,
                codexLastTriggerAt=persisted.get("codexLastTriggerAt") if same_head else None,
                codexNextTriggerAt=persisted.get("codexNextTriggerAt") if same_head else None,
                codexLastDispositionCompletedAt=(
                    persisted.get("codexLastDispositionCompletedAt") if same_head else None
                ),
                reasons=reasons
                + ["%d unresolved bot thread(s) require disposition first" % open_threads],
                **common,
            )
        )

    # 7. Trigger accounting. Live GitHub evidence outranks persisted state so a
    #    concurrent session, or a restart, converges on the same answer.
    live_triggers = exact_triggers(observation.get("comments"), policy, since=head_at)
    live_last = live_triggers[-1]["at"] if live_triggers else None
    persisted_last = parse_ts(persisted.get("codexLastTriggerAt")) if same_head else None
    persisted_round = int(persisted.get("codexRound") or 0) if same_head else 0

    last_trigger = max([t for t in (live_last, persisted_last) if t is not None], default=None)
    codex_round = max(persisted_round, len(live_triggers))

    retry = policy["retry"]
    interval = timedelta(seconds=float(retry["intervalSeconds"]))
    collision_delay = timedelta(
        seconds=float(retry.get("minCollisionDelaySeconds") or MIN_COLLISION_DELAY_SECONDS)
    )

    # one-round mode: a single current-head round plus clean threads is enough,
    # and continued bot silence does not block.
    if mode == MODE_ONE_ROUND:
        has_round = last_trigger is not None or (bot_activity is not None and bot_activity >= head_at)
        if has_round:
            return _finish(
                _decision(
                    codexState=S_ONE_ROUND_SATISFIED,
                    codexRound=max(codex_round, 1),
                    codexLastTriggerAt=fmt_ts(last_trigger),
                    codexNextTriggerAt=None,
                    reasons=reasons
                    + [
                        "one-round policy satisfied: current-head round exists and "
                        "no bot thread is unresolved"
                    ],
                    **common,
                )
            )
        reasons.append("one-round policy: no current-head round yet")

    # Next-due computation.
    persisted_next = parse_ts(persisted.get("codexNextTriggerAt")) if same_head else None
    if last_trigger is not None:
        next_trigger = last_trigger + interval
    elif persisted_next is not None:
        next_trigger = persisted_next
    else:
        next_trigger = now

    # A completed disposition round on an unchanged head earns a prompt
    # re-review rather than waiting out the full cooldown.
    disposition_at = parse_ts(observation.get("dispositionCompletedAt"))
    if disposition_at is None and same_head:
        disposition_at = parse_ts(persisted.get("codexLastDispositionCompletedAt"))
    if disposition_at is not None and (last_trigger is None or disposition_at > last_trigger):
        earliest = (last_trigger + collision_delay) if last_trigger is not None else now
        next_trigger = min(next_trigger, max(now, earliest))
        reasons.append(
            "all bot threads disposed at %s with no head change: re-review scheduled at %s"
            % (fmt_ts(disposition_at), fmt_ts(next_trigger))
        )

    if not retry.get("enabled") and last_trigger is not None:
        return _finish(
            _decision(
                codexState=S_WAITING_RETRY,
                codexRound=codex_round,
                codexLastTriggerAt=fmt_ts(last_trigger),
                codexNextTriggerAt=None,
                codexLastDispositionCompletedAt=fmt_ts(disposition_at),
                reasons=reasons + ["retry disabled by policy; one trigger per head only"],
                **common,
            )
        )

    max_total = retry.get("maxTotalRounds")
    if max_total is not None and codex_round >= max_total:
        return _finish(
            _decision(
                codexState=S_EXHAUSTED_TOTAL_ROUNDS,
                codexRound=codex_round,
                codexLastTriggerAt=fmt_ts(last_trigger),
                codexNextTriggerAt=fmt_ts(next_trigger),
                codexLastDispositionCompletedAt=fmt_ts(disposition_at),
                reasons=reasons
                + ["maxTotalRounds=%s reached at round %d" % (max_total, codex_round)],
                **common,
            )
        )

    due = now >= next_trigger
    state_common = dict(
        codexRound=codex_round,
        codexLastTriggerAt=fmt_ts(last_trigger),
        codexNextTriggerAt=fmt_ts(next_trigger),
        codexLastDispositionCompletedAt=fmt_ts(disposition_at),
    )

    if not due:
        # Another session that triggered inside the cooldown window means this
        # session stands down and adopts the live trigger state. This is only
        # reported when our own recorded state shows we were overtaken: either
        # we had an older trigger for this head, or we were already due. A
        # session with no recorded state is recovering, not racing, and simply
        # waits.
        overtaken = live_last is not None and (
            (persisted_last is not None and live_last > persisted_last)
            or (
                persisted_last is None
                and persisted_next is not None
                and persisted_next <= live_last
            )
        )
        if overtaken:
            return _finish(
                _decision(
                    codexState=S_WAITING_RETRY,
                    action=A_STAND_DOWN,
                    reasons=reasons
                    + [
                        "another session posted the exact trigger at %s, inside the "
                        "%ss cooldown; standing down and adopting live state"
                        % (fmt_ts(live_last), int(interval.total_seconds()))
                    ],
                    **state_common,
                    **common,
                )
            )
        in_flight = last_trigger is not None and (
            bot_activity is None or bot_activity < last_trigger
        )
        return _finish(
            _decision(
                codexState=S_TRIGGER_IN_FLIGHT if in_flight else S_WAITING_RETRY,
                action=A_WAIT,
                reasons=reasons
                + ["next trigger is due at %s" % fmt_ts(next_trigger)],
                **state_common,
                **common,
            )
        )

    planned_round = codex_round + 1

    rounds_this_invocation = int(observation.get("roundsThisInvocation") or 0)
    per_invocation = int(retry["maxRoundsPerInvocation"])
    if rounds_this_invocation >= per_invocation:
        # An invocation cap only ends this invocation. It never marks the PR
        # satisfied and never clears the retry state.
        return _finish(
            _decision(
                codexState=S_WAITING_RETRY,
                action=A_WAIT,
                triggerDue=True,
                plannedRound=planned_round,
                reasons=reasons
                + [
                    "maxRoundsPerInvocation=%d reached; the next /babysit-prs "
                    "invocation resumes at round %d" % (per_invocation, planned_round)
                ],
                **state_common,
                **common,
            )
        )

    if dry_run:
        return _finish(
            _decision(
                codexState=S_TRIGGER_DUE,
                action=A_DRY_RUN_WOULD_POST,
                triggerDue=True,
                plannedRound=planned_round,
                message="would trigger %s round %d"
                % (policy["triggerComment"], planned_round),
                reasons=reasons + ["dry run: no remote write is performed"],
                **state_common,
                **common,
            )
        )

    projected_next = now + interval
    result = _decision(
        codexState=S_TRIGGER_DUE,
        action=A_POST_TRIGGER,
        triggerDue=True,
        plannedRound=planned_round,
        message="post %s (round %d)" % (policy["triggerComment"], planned_round),
        reasons=reasons + ["trigger is due at %s" % fmt_ts(next_trigger)],
        **state_common,
        **common,
    )
    result["postBody"] = str(policy["triggerComment"]).strip()
    result["projectedNextTriggerAt"] = fmt_ts(projected_next)
    return _finish(result)


def apply_posted_trigger(decision, posted_at, policy):
    """Fold a successfully posted trigger back into the persisted state."""
    policy = resolve_policy(policy)
    posted = parse_ts(posted_at)
    if posted is None:
        raise ValueError("posted_at is required; use the comment's createdAt from GitHub")
    interval = timedelta(seconds=float(policy["retry"]["intervalSeconds"]))
    updated = dict(decision)
    updated["codexRound"] = decision.get("plannedRound") or (decision.get("codexRound", 0) + 1)
    updated["codexLastTriggerAt"] = fmt_ts(posted)
    updated["codexNextTriggerAt"] = fmt_ts(posted + interval)
    updated["codexState"] = S_TRIGGER_IN_FLIGHT
    updated["action"] = A_NONE
    updated["triggerDue"] = False
    return _finish(updated)


# --------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------


def _load_observation(path):
    raw = sys.stdin.read() if path in ("-", None) else open(path, encoding="utf-8").read()
    return json.loads(raw)


def cmd_evaluate(args):
    observation = _load_observation(args.input)
    if args.policy:
        with open(args.policy, encoding="utf-8") as handle:
            observation["policy"] = json.load(handle)
    if args.dry_run:
        observation["dryRun"] = True
    decision = evaluate(observation, now=args.now)
    json.dump(decision, sys.stdout, indent=2, sort_keys=True)
    sys.stdout.write("\n")
    return 0


def cmd_fresh_pass(args):
    with open(args.policy, encoding="utf-8") as handle:
        policy = resolve_policy(json.load(handle))
    reactions = read_records(args.reactions)
    head_at = parse_ts(args.head_committed_date)
    latest = latest_pass_reaction(reactions, policy)
    result = {
        "botLogin": policy.get("botLogin"),
        "passReaction": policy.get("passReaction"),
        "reactionTarget": policy.get("reactionTarget"),
        "reactionsScanned": len(reactions),
        "latestPassReactionAt": fmt_ts(latest),
        "headCommittedDate": fmt_ts(head_at),
        "freshPass": latest is not None and head_at is not None and latest >= head_at,
    }
    json.dump(result, sys.stdout, indent=2, sort_keys=True)
    sys.stdout.write("\n")
    return 0


def cmd_resolve_policy(args):
    raw = None
    if args.input:
        with open(args.input, encoding="utf-8") as handle:
            raw = json.load(handle)
    policy = resolve_policy(raw)
    output = {"policy": policy, "errors": policy_errors(policy)}
    json.dump(output, sys.stdout, indent=2, sort_keys=True)
    sys.stdout.write("\n")
    return 0


def main(argv=None):
    parser = argparse.ArgumentParser(
        description="Deterministic external-review retry state machine for /babysit-prs."
    )
    sub = parser.add_subparsers(dest="command", required=True)

    p_eval = sub.add_parser("evaluate", help="decide the next external-review action")
    p_eval.add_argument("--input", default="-", help="observation JSON file, or - for stdin")
    p_eval.add_argument("--policy", help="override observation.policy with this JSON file")
    p_eval.add_argument("--now", help="UTC ISO-8601 override for the current time")
    p_eval.add_argument("--dry-run", action="store_true", help="never emit POST_TRIGGER")
    p_eval.set_defaults(func=cmd_evaluate)

    p_fresh = sub.add_parser("fresh-pass", help="report the latest pass reaction")
    p_fresh.add_argument("--policy", required=True)
    p_fresh.add_argument("--reactions", default="-", help="PR-body reactions JSON, or - for stdin")
    p_fresh.add_argument("--head-committed-date", required=True)
    p_fresh.set_defaults(func=cmd_fresh_pass)

    p_policy = sub.add_parser("resolve-policy", help="print the effective policy")
    p_policy.add_argument("--input", help="repo-local policy JSON file")
    p_policy.set_defaults(func=cmd_resolve_policy)

    args = parser.parse_args(argv)
    try:
        return args.func(args)
    except (ValueError, json.JSONDecodeError) as exc:
        sys.stderr.write("external_review: %s\n" % exc)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
