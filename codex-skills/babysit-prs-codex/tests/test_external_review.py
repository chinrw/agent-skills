#!/usr/bin/env python3
"""Fixture tests for the /babysit-prs external-review retry state machine.

These tests never touch GitHub. Every scenario is a synthetic observation or a
fixture file; the module under test has no network capability at all.

Run:  python3 -m unittest discover -s tests -v
"""

from __future__ import annotations

import copy
import json
import os
import subprocess
import sys
import unittest
from datetime import timedelta

HERE = os.path.dirname(os.path.abspath(__file__))
SKILL_DIR = os.path.dirname(HERE)
SCRIPT = os.path.join(SKILL_DIR, "scripts", "external_review.py")
FIXTURES = os.path.join(HERE, "fixtures")
sys.path.insert(0, os.path.join(SKILL_DIR, "scripts"))

import external_review as er  # noqa: E402

NOW = "2026-07-27T12:00:00Z"
HEAD = "1111111111111111111111111111111111111111"
OLD_HEAD = "0000000000000000000000000000000000000000"
BASE = "2222222222222222222222222222222222222222"
BOT = "chatgpt-codex-connector[bot]"
HEAD_AT = "2026-07-27T09:00:00Z"


def load_fixture(name):
    with open(os.path.join(FIXTURES, name), encoding="utf-8") as handle:
        return json.load(handle)


STOCKS_POLICY = load_fixture("policy-stocks.json")


def ago(minutes, base=NOW):
    moment = er.parse_ts(base) - timedelta(minutes=minutes)
    return er.fmt_ts(moment)


def ahead(minutes, base=NOW):
    return er.fmt_ts(er.parse_ts(base) + timedelta(minutes=minutes))


def observation(**overrides):
    """A root PR on the stocks policy with no external-review history."""
    base = {
        "now": NOW,
        "repo": "chinrw/stocks",
        "pr": 358,
        "prState": "OPEN",
        "isDraft": False,
        "prClass": "integration-root",
        "policy": copy.deepcopy(STOCKS_POLICY),
        "head": {"oid": HEAD, "committedDate": HEAD_AT},
        "base": {"oid": BASE},
        "reactions": [],
        "comments": [],
        "unresolvedCodexThreads": 0,
        "roundsThisInvocation": 0,
        "persisted": {},
    }
    for key, value in overrides.items():
        if key == "policy" and isinstance(value, dict):
            merged = copy.deepcopy(STOCKS_POLICY)
            merged["externalReview"].update(value)
            base["policy"] = merged
        else:
            base[key] = value
    return base


def trigger_comment(at, author="chinrw", body="@codex review", cid=1):
    return {"id": cid, "author": {"login": author}, "body": body, "createdAt": at}


def reaction(at, login=BOT, content="+1", rid=1):
    return {"id": rid, "user": {"login": login}, "content": content, "created_at": at}


def persisted(head=HEAD, **fields):
    state = {"codexHeadOid": head}
    state.update(fields)
    return state


class Scenario01NewHead(unittest.TestCase):
    """1. Root PR, new head, no trigger and no reaction -> round 1 is due."""

    def test_round_one_trigger_due(self):
        decision = er.evaluate(observation())
        self.assertEqual(decision["codexState"], er.S_TRIGGER_DUE)
        self.assertEqual(decision["action"], er.A_POST_TRIGGER)
        self.assertTrue(decision["triggerDue"])
        self.assertEqual(decision["plannedRound"], 1)
        self.assertEqual(decision["postBody"], "@codex review")
        self.assertFalse(decision["externalReviewSatisfied"])
        self.assertEqual(decision["skillState"], "WAITING_CODEX")


class Scenario02WithinCooldown(unittest.TestCase):
    """2. Root PR, same head, triggered less than 30 minutes ago -> no repeat."""

    def test_no_duplicate_inside_cooldown(self):
        decision = er.evaluate(
            observation(
                comments=[trigger_comment(ago(10))],
                persisted=persisted(codexRound=1, codexLastTriggerAt=ago(10),
                                    codexNextTriggerAt=ahead(20)),
            )
        )
        self.assertEqual(decision["action"], er.A_WAIT)
        self.assertFalse(decision["triggerDue"])
        self.assertEqual(decision["codexState"], er.S_TRIGGER_IN_FLIGHT)
        self.assertEqual(decision["codexRound"], 1)
        self.assertEqual(decision["codexNextTriggerAt"], ahead(20))
        self.assertFalse(decision["externalReviewSatisfied"])

    def test_silence_is_never_satisfaction(self):
        decision = er.evaluate(
            observation(
                comments=[trigger_comment(ago(10))],
                botActivity=[{"login": BOT, "at": ago(5)}],
            )
        )
        self.assertFalse(decision["externalReviewSatisfied"])
        self.assertTrue(decision["gateBlocking"])
        self.assertFalse(decision["terminal"])


class Scenario03CooldownElapsed(unittest.TestCase):
    """3. Root PR, same head, silent for more than 30 minutes -> round 2 due."""

    def test_round_two_due(self):
        decision = er.evaluate(
            observation(
                comments=[trigger_comment(ago(31))],
                persisted=persisted(codexRound=1, codexLastTriggerAt=ago(31),
                                    codexNextTriggerAt=ago(1)),
            )
        )
        self.assertEqual(decision["action"], er.A_POST_TRIGGER)
        self.assertEqual(decision["plannedRound"], 2)
        self.assertEqual(decision["codexRound"], 1)


class Scenario04UnboundedRounds(unittest.TestCase):
    """4. Rounds 2, 3, 4 keep firing across invocations with no total cap."""

    def test_rounds_continue_across_invocations(self):
        planned = []
        state = persisted(codexRound=1, codexLastTriggerAt=ago(31), codexNextTriggerAt=ago(1))
        comments = [trigger_comment(ago(31), cid=1)]
        clock = er.parse_ts(NOW)
        for _ in range(4):
            obs = observation(
                now=er.fmt_ts(clock), comments=list(comments), persisted=copy.deepcopy(state)
            )
            decision = er.evaluate(obs)
            self.assertEqual(decision["action"], er.A_POST_TRIGGER)
            planned.append(decision["plannedRound"])
            posted_at = er.fmt_ts(clock)
            applied = er.apply_posted_trigger(decision, posted_at, STOCKS_POLICY)
            comments.append(trigger_comment(posted_at, cid=len(comments) + 1))
            state = persisted(
                codexRound=applied["codexRound"],
                codexLastTriggerAt=applied["codexLastTriggerAt"],
                codexNextTriggerAt=applied["codexNextTriggerAt"],
            )
            # next invocation, a full cooldown later
            clock = clock + timedelta(minutes=31)
        self.assertEqual(planned, [2, 3, 4, 5])
        self.assertIsNone(STOCKS_POLICY["externalReview"]["retry"]["maxTotalRounds"])

    def test_invocation_cap_is_not_a_total_cap(self):
        decision = er.evaluate(
            observation(
                roundsThisInvocation=2,
                comments=[trigger_comment(ago(31))],
                persisted=persisted(codexRound=1, codexLastTriggerAt=ago(31)),
            )
        )
        self.assertEqual(decision["action"], er.A_WAIT)
        self.assertTrue(decision["triggerDue"])
        self.assertEqual(decision["plannedRound"], 2)
        self.assertFalse(decision["externalReviewSatisfied"])
        self.assertFalse(decision["retryStopped"])
        self.assertIsNotNone(decision["codexNextTriggerAt"])
        self.assertIn("maxRoundsPerInvocation", " ".join(decision["reasons"]))


class Scenario05ConcurrentSession(unittest.TestCase):
    """5. Another session triggered inside the cooldown -> stand down."""

    def test_stand_down_and_adopt_live_state(self):
        decision = er.evaluate(
            observation(
                comments=[trigger_comment(ago(90), cid=1), trigger_comment(ago(5), cid=2)],
                persisted=persisted(codexRound=1, codexLastTriggerAt=ago(90),
                                    codexNextTriggerAt=ago(60)),
            )
        )
        self.assertEqual(decision["action"], er.A_STAND_DOWN)
        self.assertFalse(decision["triggerDue"])
        self.assertEqual(decision["codexLastTriggerAt"], ago(5))
        self.assertEqual(decision["codexRound"], 2)
        self.assertEqual(decision["codexNextTriggerAt"], ahead(25))

    def test_stand_down_when_overtaken_while_due(self):
        decision = er.evaluate(
            observation(
                comments=[trigger_comment(ago(5))],
                persisted=persisted(codexRound=0, codexNextTriggerAt=ago(20)),
            )
        )
        self.assertEqual(decision["action"], er.A_STAND_DOWN)
        self.assertEqual(decision["codexNextTriggerAt"], ahead(25))

    def test_recovering_session_waits_rather_than_claiming_a_race(self):
        decision = er.evaluate(observation(comments=[trigger_comment(ago(5))], persisted={}))
        self.assertEqual(decision["action"], er.A_WAIT)
        self.assertFalse(decision["triggerDue"])
        self.assertEqual(decision["codexRound"], 1)


class Scenario06StalePass(unittest.TestCase):
    """6. A +1 older than the latest head commit is not a pass."""

    def test_stale_reaction_keeps_retrying(self):
        decision = er.evaluate(observation(reactions=[reaction(ago(600))]))
        self.assertNotEqual(decision["codexState"], er.S_PASS_FRESH)
        self.assertEqual(decision["action"], er.A_POST_TRIGGER)
        self.assertFalse(decision["externalReviewSatisfied"])
        self.assertIn("stale", " ".join(decision["reasons"]))


class Scenario07FreshPass(unittest.TestCase):
    """7. A fresh PR-body +1 is a pass and stops all retries."""

    def test_fresh_pass_stops_retry(self):
        decision = er.evaluate(observation(reactions=[reaction(ago(30))]))
        self.assertEqual(decision["codexState"], er.S_PASS_FRESH)
        self.assertEqual(decision["action"], er.A_NONE)
        self.assertTrue(decision["externalReviewSatisfied"])
        self.assertFalse(decision["gateBlocking"])
        self.assertTrue(decision["retryStopped"])
        self.assertEqual(decision["codexLatestPassReactionAt"], ago(30))

    def test_bot_login_bracket_suffix_matches_graphql_form(self):
        decision = er.evaluate(
            observation(reactions=[reaction(ago(30), login="chatgpt-codex-connector")])
        )
        self.assertEqual(decision["codexState"], er.S_PASS_FRESH)

    def test_multipage_reactions(self):
        with open(os.path.join(FIXTURES, "reactions-multipage.json"), encoding="utf-8") as fh:
            records = er.flatten_objects(er.load_json_stream(fh.read()))
        self.assertEqual(len(records), 6)
        policy = er.resolve_policy(STOCKS_POLICY)
        latest = er.latest_pass_reaction(records, policy)
        self.assertEqual(er.fmt_ts(latest), "2026-07-27T10:31:00Z")


class Scenario08NonPassSignals(unittest.TestCase):
    """8. Emoji in a comment body, or a review-comment reaction, is not a pass."""

    def test_thumbsup_in_comment_body_is_not_a_pass(self):
        decision = er.evaluate(
            observation(comments=[trigger_comment(ago(10), author=BOT, body="👍 looks good")])
        )
        self.assertNotEqual(decision["codexState"], er.S_PASS_FRESH)
        self.assertFalse(decision["externalReviewSatisfied"])
        self.assertIsNone(decision["codexLatestPassReactionAt"])

    def test_review_comment_reactions_are_ignored(self):
        obs = observation()
        obs["reviewCommentReactions"] = [reaction(ago(1))]
        obs["issueCommentReactions"] = [reaction(ago(1))]
        decision = er.evaluate(obs)
        self.assertNotEqual(decision["codexState"], er.S_PASS_FRESH)
        self.assertIsNone(decision["codexLatestPassReactionAt"])

    def test_non_exact_trigger_body_is_not_a_trigger(self):
        policy = er.resolve_policy(STOCKS_POLICY)
        comments = [
            {"body": "@codex review please", "createdAt": ago(5)},
            {"body": "see @codex review above", "createdAt": ago(4)},
            {"body": "  @codex review  ", "createdAt": ago(3)},
        ]
        found = er.exact_triggers(comments, policy)
        self.assertEqual(len(found), 1)
        self.assertEqual(er.fmt_ts(found[0]["at"]), ago(3))


class Scenario09FindingsOpen(unittest.TestCase):
    """9. Unresolved bot threads block triggering until disposition."""

    def test_no_trigger_while_threads_open(self):
        decision = er.evaluate(observation(unresolvedCodexThreads=3))
        self.assertEqual(decision["codexState"], er.S_FINDINGS_OPEN)
        self.assertEqual(decision["action"], er.A_NONE)
        self.assertFalse(decision["externalReviewSatisfied"])
        self.assertEqual(decision["skillState"], "WAITING_THREADS")


class Scenario10DispositionComplete(unittest.TestCase):
    """10. All threads disposed with no head change -> schedule a new trigger."""

    def test_reschedule_after_disposition(self):
        decision = er.evaluate(
            observation(
                comments=[trigger_comment(ago(10))],
                dispositionCompletedAt=ago(0),
                persisted=persisted(codexRound=1, codexLastTriggerAt=ago(10),
                                    codexNextTriggerAt=ahead(20)),
            )
        )
        self.assertEqual(decision["action"], er.A_POST_TRIGGER)
        self.assertEqual(decision["plannedRound"], 2)

    def test_minimum_collision_delay_is_respected(self):
        decision = er.evaluate(
            observation(
                comments=[trigger_comment(ago(0.5))],
                dispositionCompletedAt=ago(0),
                persisted=persisted(codexRound=1, codexLastTriggerAt=ago(0.5)),
            )
        )
        self.assertEqual(decision["action"], er.A_WAIT)
        self.assertFalse(decision["triggerDue"])
        self.assertEqual(decision["codexNextTriggerAt"], ahead(0.5))


class Scenario11HeadChanged(unittest.TestCase):
    """11. A merged fix child changes the parent head -> reset and fire round 1."""

    def test_round_resets_on_new_head(self):
        decision = er.evaluate(
            observation(
                comments=[trigger_comment("2026-07-27T08:00:00Z", cid=1)],
                persisted=persisted(
                    head=OLD_HEAD,
                    codexRound=4,
                    codexLastTriggerAt="2026-07-27T08:00:00Z",
                    codexNextTriggerAt=ahead(600),
                    codexState=er.S_WAITING_RETRY,
                ),
            )
        )
        self.assertEqual(decision["action"], er.A_POST_TRIGGER)
        self.assertEqual(decision["codexRound"], 0)
        self.assertEqual(decision["plannedRound"], 1)
        self.assertEqual(decision["codexHeadOid"], HEAD)
        reasons = " ".join(decision["reasons"])
        self.assertIn("no persisted external-review state for head %s" % HEAD, reasons)
        self.assertIn("previous head %s" % OLD_HEAD, reasons)


class Scenario12StrictStackedOneRound(unittest.TestCase):
    """12. Strict stacked, one round done, bot silent -> satisfied."""

    def test_silence_after_one_round_is_enough(self):
        decision = er.evaluate(
            observation(
                prClass="strict-stacked",
                comments=[trigger_comment(ago(45))],
                unresolvedCodexThreads=0,
            )
        )
        self.assertEqual(decision["codexState"], er.S_ONE_ROUND_SATISFIED)
        self.assertTrue(decision["externalReviewSatisfied"])
        self.assertFalse(decision["gateBlocking"])
        self.assertEqual(decision["action"], er.A_NONE)

    def test_open_threads_still_block_one_round_mode(self):
        decision = er.evaluate(
            observation(
                prClass="strict-stacked",
                comments=[trigger_comment(ago(45))],
                unresolvedCodexThreads=1,
            )
        )
        self.assertEqual(decision["codexState"], er.S_FINDINGS_OPEN)
        self.assertFalse(decision["externalReviewSatisfied"])


class Scenario13StrictStackedStaleTrigger(unittest.TestCase):
    """13. A strict stacked PR is not satisfied by an older-head trigger."""

    def test_stale_trigger_does_not_satisfy(self):
        decision = er.evaluate(
            observation(
                prClass="strict-stacked",
                comments=[trigger_comment("2026-07-27T08:00:00Z")],
            )
        )
        self.assertNotEqual(decision["codexState"], er.S_ONE_ROUND_SATISFIED)
        self.assertFalse(decision["externalReviewSatisfied"])
        self.assertEqual(decision["action"], er.A_POST_TRIGGER)
        self.assertEqual(decision["plannedRound"], 1)


class Scenario14StrictStackedFreshPassMode(unittest.TestCase):
    """14. Policy may put strict stacked PRs on fresh-pass-retry too."""

    def test_strict_stacked_waits_for_thumbsup(self):
        obs = observation(
            prClass="strict-stacked",
            policy={"strictStackedMode": "fresh-pass-retry"},
            comments=[trigger_comment(ago(5))],
        )
        decision = er.evaluate(obs)
        self.assertEqual(decision["codexMode"], "fresh-pass-retry")
        self.assertFalse(decision["externalReviewSatisfied"])
        self.assertEqual(decision["action"], er.A_WAIT)

        obs["comments"] = [trigger_comment(ago(31))]
        later = er.evaluate(obs)
        self.assertEqual(later["action"], er.A_POST_TRIGGER)

        obs["reactions"] = [reaction(ago(1))]
        passed = er.evaluate(obs)
        self.assertEqual(passed["codexState"], er.S_PASS_FRESH)


class Scenario15Disabled(unittest.TestCase):
    """15. Disabled external review: no bot query, no trigger, no gate."""

    def test_disabled_policy_is_inert(self):
        obs = observation(
            policy={"enabled": False},
            reactions=[reaction(ago(1))],
            comments=[trigger_comment(ago(1))],
        )
        decision = er.evaluate(obs)
        self.assertEqual(decision["codexState"], er.S_DISABLED)
        self.assertEqual(decision["action"], er.A_NONE)
        self.assertFalse(decision["queriedBot"])
        self.assertTrue(decision["externalReviewSatisfied"])
        self.assertFalse(decision["gateBlocking"])
        self.assertIsNone(decision["codexLatestPassReactionAt"])

    def test_default_policy_is_disabled(self):
        policy = er.resolve_policy(None)
        self.assertFalse(policy["enabled"])
        self.assertEqual(policy["rootMode"], "disabled")
        self.assertEqual(policy["strictStackedMode"], "disabled")
        self.assertEqual(er.policy_errors(policy), [])

    def test_mode_level_disable(self):
        decision = er.evaluate(
            observation(prClass="strict-stacked", policy={"strictStackedMode": "disabled"})
        )
        self.assertEqual(decision["codexState"], er.S_DISABLED)
        self.assertFalse(decision["queriedBot"])

    def test_enabled_policy_requires_bot_and_trigger(self):
        errors = er.policy_errors(er.resolve_policy({"externalReview": {"enabled": True}}))
        self.assertTrue(any("botLogin" in e for e in errors))
        self.assertTrue(any("triggerComment" in e for e in errors))
        decision = er.evaluate(observation(policy={"botLogin": None}))
        self.assertEqual(decision["codexState"], er.S_POLICY_INVALID)
        self.assertEqual(decision["action"], er.A_NONE)


class Scenario16RestartRecovery(unittest.TestCase):
    """16. After a restart, round and nextRetryAt come back from live state."""

    def test_recovers_round_from_github_comments_alone(self):
        decision = er.evaluate(
            observation(
                comments=[
                    trigger_comment(ago(95), cid=1),
                    trigger_comment(ago(63), cid=2),
                    trigger_comment(ago(31), cid=3),
                ],
                persisted={},
            )
        )
        self.assertEqual(decision["codexRound"], 3)
        self.assertEqual(decision["codexLastTriggerAt"], ago(31))
        self.assertEqual(decision["plannedRound"], 4)
        self.assertEqual(decision["action"], er.A_POST_TRIGGER)

    def test_recovers_next_retry_at_from_status_comment(self):
        decision = er.evaluate(
            observation(
                persisted=persisted(codexRound=2, codexNextTriggerAt=ahead(12)),
            )
        )
        self.assertEqual(decision["codexRound"], 2)
        self.assertEqual(decision["codexNextTriggerAt"], ahead(12))
        self.assertEqual(decision["action"], er.A_WAIT)

    def test_live_state_outranks_stale_persisted_round(self):
        decision = er.evaluate(
            observation(
                comments=[trigger_comment(ago(95), cid=1), trigger_comment(ago(31), cid=2)],
                persisted=persisted(codexRound=1, codexLastTriggerAt=ago(95)),
            )
        )
        self.assertEqual(decision["codexRound"], 2)
        self.assertEqual(decision["codexLastTriggerAt"], ago(31))


class Scenario17DryRun(unittest.TestCase):
    """17. Dry run announces the round and performs zero remote writes."""

    def test_dry_run_message(self):
        decision = er.evaluate(
            observation(
                dryRun=True,
                comments=[trigger_comment(ago(31))],
                persisted=persisted(codexRound=1, codexLastTriggerAt=ago(31)),
            )
        )
        self.assertEqual(decision["action"], er.A_DRY_RUN_WOULD_POST)
        self.assertEqual(decision["message"], "would trigger @codex review round 2")
        self.assertNotIn("postBody", decision)
        self.assertTrue(decision["triggerDue"])

    def test_cli_dry_run_on_regression_fixture(self):
        result = subprocess.run(
            [
                sys.executable,
                SCRIPT,
                "evaluate",
                "--input",
                os.path.join(FIXTURES, "obs-pr358-regression.json"),
                "--dry-run",
            ],
            capture_output=True,
            text=True,
            check=True,
        )
        decision = json.loads(result.stdout)
        self.assertEqual(decision["action"], er.A_DRY_RUN_WOULD_POST)
        self.assertEqual(decision["message"], "would trigger @codex review round 2")
        self.assertEqual(decision["codexRound"], 1)

    def test_regression_fixture_would_retry_not_stall(self):
        decision = er.evaluate(load_fixture("obs-pr358-regression.json"))
        self.assertEqual(decision["action"], er.A_POST_TRIGGER)
        self.assertEqual(decision["plannedRound"], 2)
        self.assertFalse(decision["externalReviewSatisfied"])
        self.assertEqual(decision["skillState"], "WAITING_CODEX")


class Scenario18PassBeatsPendingTrigger(unittest.TestCase):
    """18. A pass landing before the write guard cancels the pending trigger."""

    def test_fresh_pass_cancels_due_trigger(self):
        due = observation(
            comments=[trigger_comment(ago(31))],
            persisted=persisted(codexRound=1, codexLastTriggerAt=ago(31)),
        )
        self.assertEqual(er.evaluate(due)["action"], er.A_POST_TRIGGER)

        recheck = copy.deepcopy(due)
        recheck["reactions"] = [reaction(ago(0))]
        decision = er.evaluate(recheck)
        self.assertEqual(decision["codexState"], er.S_PASS_FRESH)
        self.assertEqual(decision["action"], er.A_NONE)
        self.assertFalse(decision["triggerDue"])
        self.assertTrue(decision["retryStopped"])


class Scenario19PrClosed(unittest.TestCase):
    """19. A closed or merged PR stops the retry loop."""

    def test_merged_stops_retry(self):
        for state in ("MERGED", "CLOSED"):
            with self.subTest(state=state):
                decision = er.evaluate(
                    observation(prState=state, comments=[trigger_comment(ago(600))])
                )
                self.assertEqual(decision["codexState"], er.S_STOPPED_PR_CLOSED)
                self.assertEqual(decision["action"], er.A_NONE)
                self.assertTrue(decision["retryStopped"])
                self.assertFalse(decision["gateBlocking"])


class Scenario20SnapshotStale(unittest.TestCase):
    """20. Never post a trigger against a head or base that has moved."""

    def test_head_change_blocks_write(self):
        decision = er.evaluate(observation(expected={"headOid": OLD_HEAD, "baseOid": BASE}))
        self.assertEqual(decision["codexState"], er.S_BLOCKED_SNAPSHOT_STALE)
        self.assertEqual(decision["action"], er.A_NONE)
        self.assertTrue(decision["requiresResnapshot"])
        self.assertFalse(decision["triggerDue"])

    def test_base_change_blocks_write(self):
        decision = er.evaluate(
            observation(expected={"headOid": HEAD, "baseOid": "deadbeef" * 5})
        )
        self.assertEqual(decision["codexState"], er.S_BLOCKED_SNAPSHOT_STALE)
        self.assertFalse(decision["triggerDue"])

    def test_matching_snapshot_allows_write(self):
        decision = er.evaluate(observation(expected={"headOid": HEAD, "baseOid": BASE}))
        self.assertEqual(decision["action"], er.A_POST_TRIGGER)

    def test_draft_never_triggers(self):
        decision = er.evaluate(observation(isDraft=True))
        self.assertEqual(decision["action"], er.A_NONE)
        self.assertFalse(decision["triggerDue"])


class PolicySchema(unittest.TestCase):
    """The stocks effective policy is what the prompt specifies."""

    def test_stocks_policy_resolves(self):
        policy = er.resolve_policy(STOCKS_POLICY)
        self.assertEqual(er.policy_errors(policy), [])
        self.assertTrue(policy["enabled"])
        self.assertEqual(policy["botLogin"], BOT)
        self.assertEqual(policy["triggerComment"], "@codex review")
        self.assertEqual(policy["passReaction"], "+1")
        self.assertEqual(policy["reactionTarget"], "pr-body")
        self.assertEqual(policy["rootMode"], "fresh-pass-retry")
        self.assertEqual(policy["strictStackedMode"], "one-round")
        self.assertTrue(policy["retry"]["enabled"])
        self.assertEqual(policy["retry"]["intervalSeconds"], 1800)
        self.assertEqual(policy["retry"]["maxRoundsPerInvocation"], 2)
        self.assertIsNone(policy["retry"]["maxTotalRounds"])

    def test_partial_policy_keeps_defaults(self):
        policy = er.resolve_policy({"externalReview": {"retry": {"intervalSeconds": 600}}})
        self.assertEqual(policy["retry"]["intervalSeconds"], 600)
        self.assertEqual(policy["retry"]["maxRoundsPerInvocation"], 2)

    def test_installed_repo_policy_matches_when_present(self):
        path = "/home/chin39/Documents/play/stocks/.claude/babysit-prs.json"
        if not os.path.exists(path):
            self.skipTest("stocks repo policy not installed here")
        with open(path, encoding="utf-8") as handle:
            installed = json.load(handle)
        policy = er.resolve_policy(installed)
        self.assertEqual(er.policy_errors(policy), [])
        self.assertEqual(policy["rootMode"], "fresh-pass-retry")
        self.assertEqual(policy["retry"]["intervalSeconds"], 1800)
        self.assertIsNone(policy["retry"]["maxTotalRounds"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
