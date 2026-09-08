import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { canonicalHash } from "../scripts/lib/json-io.mjs";
import { computeReviewKey } from "../scripts/review-key.mjs";

const CLI = fileURLToPath(new URL("../scripts/validate-artifact.mjs", import.meta.url));
const BASE = "b".repeat(40);
const KEY = "c".repeat(64);

function taskResult(taskType, headOid, extra = {}) {
  return { schemaVersion: 1, taskType, attemptId: "att-input-1", pr: 379,
    headOid, baseOid: BASE, reviewKey: KEY, resultCompleteness: "complete", findings: [], ...extra };
}

function judged(headOid, { pr = 379, key = KEY, verdict = "NEEDS_FIX" } = {}) {
  return { schemaVersion: 1, checkpointType: "finding-judge", attemptId: "att-judge-1", pr,
    subject: { headOid, baseOid: BASE, reviewKey: key, specHash: "none" },
    inputs: { review: "f".repeat(64) }, resultCompleteness: "complete", verdict,
    result: { findings: [{ id: "R1", classification: verdict === "ACCEPT" ? "CONFIRMED_NON_BLOCKING" : "CONFIRMED_BLOCKING", reason: "The write result is discarded", file: "source.txt", line: 1, comment: "Handle the failed write" }], residualRisk: null } };
}

function command(bin, args, cwd) {
  const run = spawnSync(bin, args, { cwd, encoding: "utf8" });
  assert.ifError(run.error);
  assert.equal(run.status, 0, run.stderr);
  return run.stdout.trim();
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "checkpoint-admission-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const worktree = path.join(root, "source");
  fs.mkdirSync(worktree);
  command("git", ["init", "-q", "-b", "main"], worktree);
  command("git", ["config", "user.name", "Test"], worktree);
  command("git", ["config", "user.email", "test@example.invalid"], worktree);
  command("git", ["config", "commit.gpgsign", "false"], worktree);
  fs.writeFileSync(path.join(worktree, "source.txt"), "original\n");
  command("git", ["add", "."], worktree);
  command("git", ["commit", "-qm", "seed"], worktree);
  const head = command("git", ["rev-parse", "HEAD"], worktree);
  const fix = taskResult("fix", BASE, { fix: { commit: head, changedFiles: ["source.txt"], closedFindingIds: ["R1"] } });
  const findings = judged(BASE);
  const inputs = {};
  for (const [role, data] of Object.entries({ fix, findings })) {
    const file = path.join(root, `${role}.json`);
    fs.writeFileSync(file, JSON.stringify(data));
    inputs[role] = { path: file, sha256: canonicalHash(data) };
  }
  const expected = {
    checkpointType: "verifier", attemptId: "att-verify-1", pr: 379,
    subject: { parentHead: BASE, fixCommit: head, baseOid: BASE, reviewKey: KEY, specHash: "none" },
    worktree, inputs
  };
  const result = {
    schemaVersion: 1, checkpointType: expected.checkpointType,
    attemptId: expected.attemptId, pr: expected.pr, subject: structuredClone(expected.subject),
    inputs: Object.fromEntries(Object.entries(inputs).map(([role, entry]) => [role, entry.sha256])),
    resultCompleteness: "complete", verdict: "REJECT",
    result: { closedFindingIds: [], blocking: ["R1 remains reproducible"], changedFiles: ["source.txt"], commands: ["focused check"], results: ["FAIL"], residualRisk: null }
  };
  return { root, worktree, head, expected, result, output: path.join(root, "verification.json") };
}

function admit(ws, { status = "completed" } = {}) {
  const input = path.join(ws.root, "result.json");
  const expected = path.join(ws.root, "expected.json");
  fs.writeFileSync(input, JSON.stringify(ws.result));
  fs.writeFileSync(expected, JSON.stringify(ws.expected));
  const run = spawnSync(process.execPath, [CLI, "--input", input, "--expect", expected, "--status", status, "--out", ws.output], { encoding: "utf8" });
  assert.ifError(run.error);
  return { code: run.status, payload: JSON.parse(run.stdout), stderr: run.stderr };
}

test("a complete REJECT is admitted as correction evidence, not an ACCEPT verdict", (t) => {
  const ws = fixture(t);
  const outcome = admit(ws);
  assert.equal(outcome.code, 0, JSON.stringify(outcome.payload));
  assert.equal(outcome.payload.ok, true);
  assert.equal(outcome.payload.summary.verdict, "REJECT");
  assert.equal(outcome.payload.sha256, canonicalHash(ws.result));
  assert.deepEqual(JSON.parse(fs.readFileSync(ws.output)), ws.result);
});

test("inadmissible checkpoints cannot replace prior canonical evidence", async (t) => {
  const changes = {
    "stale attempt": ws => { ws.result.attemptId = "att-stale-1"; },
    "wrong subject": ws => { ws.result.subject.reviewKey = "d".repeat(64); },
    "partial result": ws => { ws.result.resultCompleteness = "partial"; },
    "missing verdict": ws => { delete ws.result.verdict; },
    "changed input": ws => { fs.writeFileSync(ws.expected.inputs.fix.path, '{}'); },
    "wrong input hash": ws => { ws.result.inputs.fix = "d".repeat(64); },
    "dirty source": ws => { fs.writeFileSync(path.join(ws.worktree, "source.txt"), "changed\n"); },
    "ACCEPT with blockers": ws => { ws.result.verdict = "ACCEPT"; }
  };
  for (const [name, change] of Object.entries(changes)) await t.test(name, (t) => {
    const ws = fixture(t);
    fs.writeFileSync(ws.output, "previous canonical evidence\n");
    change(ws);
    const outcome = admit(ws);
    assert.equal(outcome.code, 1, JSON.stringify(outcome.payload));
    assert.equal(outcome.payload.ok, false);
    assert.equal(fs.readFileSync(ws.output, "utf8"), "previous canonical evidence\n");
  });
});

function assign(ws, kind, subject, inputs, verdict, result) {
  const references = {};
  for (const [role, content] of Object.entries(inputs)) {
    const file = path.join(ws.root, `${role}.json`);
    fs.writeFileSync(file, JSON.stringify(content));
    references[role] = { path: file, sha256: canonicalHash(content) };
  }
  ws.expected = { checkpointType: kind, attemptId: "att-check-1", pr: 379, subject, worktree: ws.worktree, inputs: references };
  ws.result = {
    schemaVersion: 1, checkpointType: kind, attemptId: "att-check-1", pr: 379,
    subject: structuredClone(subject), inputs: Object.fromEntries(Object.entries(references).map(([role, ref]) => [role, ref.sha256])),
    resultCompleteness: "complete", verdict, result
  };
}

test("spec selection is admitted before a review key exists", (t) => {
  const ws = fixture(t);
  assign(ws, "spec-selector", { headOid: ws.head, baseOid: BASE }, {}, "NONE", { specPaths: [], specHash: "none", reason: "No matching specification" });
  const outcome = admit(ws);
  assert.equal(outcome.code, 0, JSON.stringify(outcome.payload));
  assert.equal(outcome.payload.summary.verdict, "NONE");
  ws.result.result.specPaths = ["docs/spec.md"];
  assert.equal(admit(ws).code, 1, "NONE cannot carry selected documents");
});

test("finding and thread judgments cross the same admission CLI", async (t) => {
  for (const kind of ["finding-judge", "thread-judge"]) await t.test(kind, (t) => {
    const ws = fixture(t);
    const subject = { headOid: ws.head, baseOid: BASE, reviewKey: KEY, specHash: "none" };
    if (kind === "finding-judge") {
      assign(ws, kind, subject, { review: taskResult("review", ws.head, { findings: [{ id: "R1", severity: "advisory", file: "source.txt", claim: "The write result is discarded", evidence: "The caller ignores the write result", headOid: ws.head, baseOid: BASE, reviewKey: KEY }] }) }, "ACCEPT", {
        findings: [{ id: "R1", classification: "CONFIRMED_NON_BLOCKING", reason: "A bounded non-blocking concern", file: "source.txt", line: 1, comment: "Explain the bounded concern" }], residualRisk: null
      });
    } else {
      assign(ws, kind, subject, { threads: [{ id: "T1" }] }, "DISPOSED", {
        dispositions: [{ threadId: "T1", classification: "ADVISORY_NON_BLOCKING", reason: "The documented behavior is intentional", reply: "The specification permits this behavior", resolve: true }], residualRisk: null
      });
    }
    const outcome = admit(ws);
    assert.equal(outcome.code, 0, JSON.stringify(outcome.payload));
  });
});

test("composition keeps old-parent, child, and new-parent identities distinct", async (t) => {
  for (const kind of ["composition-verifier", "critical-composition-verifier"]) await t.test(kind, (t) => {
    const ws = fixture(t);
    const subject = { oldParentHead: BASE, newParentHead: ws.head, childHead: "d".repeat(40), baseOid: BASE, parentReviewKey: KEY, childReviewKey: "e".repeat(64), specHash: "none" };
    assign(ws, kind, subject, { parent: judged(BASE, { verdict: "ACCEPT" }), child: judged("d".repeat(40), { pr: 380, key: "e".repeat(64), verdict: "ACCEPT" }) }, "REVIEW", {
      evidence: ["The composition requires a full review"], checkedInvariants: [], blocking: [], residualRisk: "Proof remains incomplete"
    });
    const outcome = admit(ws);
    assert.equal(outcome.code, 0, JSON.stringify(outcome.payload));
    assert.equal(outcome.payload.summary.verdict, "REVIEW");
    [ws.result.subject.parentReviewKey, ws.result.subject.childReviewKey] = [ws.result.subject.childReviewKey, ws.result.subject.parentReviewKey];
    assert.equal(admit(ws).code, 1, "role swaps cannot satisfy the assignment");
  });
});

test("a judgment cannot silently omit assigned findings or resolve a real fix", (t) => {
  const ws = fixture(t);
  const subject = { headOid: ws.head, baseOid: BASE, reviewKey: KEY, specHash: "none" };
  assign(ws, "finding-judge", subject, { review: { findings: [{ id: "R1" }] } }, "ACCEPT", { findings: [], residualRisk: null });
  assert.equal(admit(ws).code, 1, "complete judgment must account for its input findings");
  assign(ws, "thread-judge", subject, { threads: [{ id: "T1" }] }, "NEEDS_FIX", {
    dispositions: [{ threadId: "T1", classification: "REAL_FIX_REQUIRED", reason: "The write is lost", reply: "Fixed", resolve: true }], residualRisk: null
  });
  assert.equal(admit(ws).code, 1, "a real fix cannot be resolved by a disposition claim");
});

test("valid input hashes cannot substitute for current identity or verifier closure", async (t) => {
  for (const name of ["stale fix identity", "missing closure"]) await t.test(name, (t) => {
    const ws = fixture(t);
    ws.result.verdict = "ACCEPT";
    ws.result.result.blocking = [];
    ws.result.result.closedFindingIds = name === "missing closure" ? [] : ["R1"];
    if (name === "stale fix identity") {
      const wrong = taskResult("fix", "d".repeat(40), { fix: { commit: ws.head, changedFiles: ["source.txt"], closedFindingIds: ["R1"] } });
      fs.writeFileSync(ws.expected.inputs.fix.path, JSON.stringify(wrong));
      ws.expected.inputs.fix.sha256 = ws.result.inputs.fix = canonicalHash(wrong);
    }
    fs.writeFileSync(ws.output, "prior evidence\n");
    const outcome = admit(ws);
    assert.equal(outcome.code, 1, JSON.stringify(outcome.payload));
    assert.equal(fs.readFileSync(ws.output, "utf8"), "prior evidence\n");
  });
});

test("a stale review cannot become a current judgment just by matching its hash", (t) => {
  const ws = fixture(t);
  const subject = { headOid: ws.head, baseOid: BASE, reviewKey: KEY, specHash: "none" };
  assign(ws, "finding-judge", subject, { review: taskResult("review", BASE) }, "ACCEPT", { findings: [], residualRisk: null });
  const outcome = admit(ws);
  assert.equal(outcome.code, 1, JSON.stringify(outcome.payload));
  assert.match(outcome.payload.errors.join("\n"), /invalid-input-evidence:review/);
});

test("composition cannot use an admitted BLOCKED result as prior acceptance", (t) => {
  const ws = fixture(t);
  const subject = { oldParentHead: BASE, newParentHead: ws.head, childHead: "d".repeat(40), baseOid: BASE, parentReviewKey: KEY, childReviewKey: "e".repeat(64), specHash: "none" };
  const parent = judged(BASE, { verdict: "BLOCKED" });
  parent.result.findings = [];
  assign(ws, "composition-verifier", subject, { parent, child: judged("d".repeat(40), { pr: 380, key: "e".repeat(64), verdict: "ACCEPT" }) }, "REVIEW", {
    evidence: [], checkedInvariants: [], blocking: [], residualRisk: "Needs review"
  });
  const outcome = admit(ws);
  assert.equal(outcome.code, 1, JSON.stringify(outcome.payload));
  assert.match(outcome.payload.errors.join("\n"), /input-not-accepted:parent/);
});

test("verifier closure includes an assigned risk judgment", (t) => {
  const ws = fixture(t);
  ws.result.verdict = "ACCEPT";
  ws.result.result.blocking = [];
  ws.result.result.closedFindingIds = ["R1"];
  const risk = judged(BASE);
  risk.result.findings[0].id = "K1";
  const file = path.join(ws.root, "risk.json");
  fs.writeFileSync(file, JSON.stringify(risk));
  ws.expected.inputs.riskFindings = { path: file, sha256: canonicalHash(risk) };
  ws.result.inputs.riskFindings = canonicalHash(risk);
  assert.equal(admit(ws).code, 1);
  ws.result.result.closedFindingIds = ["R1", "K1"];
  assert.equal(admit(ws).code, 0);
});

test("an admitted thread finding can supply verifier closure evidence", (t) => {
  const ws = fixture(t);
  const threads = { schemaVersion: 1, checkpointType: "thread-judge", attemptId: "att-thread-1", pr: 379,
    subject: { headOid: BASE, baseOid: BASE, reviewKey: KEY, specHash: "none" }, inputs: { threads: "f".repeat(64) },
    resultCompleteness: "complete", verdict: "NEEDS_FIX", result: { dispositions: [{
      threadId: "T1", classification: "REAL_FIX_REQUIRED", reason: "The write result is discarded", reply: null, resolve: false,
      finding: { id: "R1", file: "source.txt", claim: "The write result is discarded", evidence: "The caller ignores the write result" }
    }], residualRisk: null } };
  fs.writeFileSync(ws.expected.inputs.findings.path, JSON.stringify(threads));
  ws.expected.inputs.findings.sha256 = ws.result.inputs.findings = canonicalHash(threads);
  ws.result.verdict = "ACCEPT";
  ws.result.result.blocking = [];
  ws.result.result.closedFindingIds = ["R1"];
  const outcome = admit(ws);
  assert.equal(outcome.code, 0, JSON.stringify(outcome.payload));
});

test("verifier ACCEPT cannot discard unresolved prerequisite judgments", async (t) => {
  const cases = [
    ["findings", "finding-judge", "BLOCKED", ["NEEDS_HUMAN"], []],
    ["findings", "finding-judge", "INCONCLUSIVE", ["FALSE_POSITIVE"], []],
    ["riskFindings", "finding-judge", "NEEDS_FIX", ["CONFIRMED_BLOCKING", "NEEDS_HUMAN"], ["R1"]],
    ["findings", "thread-judge", "BLOCKED", ["ADVISORY_NON_BLOCKING"], []],
    ["threadFindings", "thread-judge", "NEEDS_HUMAN", ["NEEDS_HUMAN"], []],
    ["threadFindings", "thread-judge", "NEEDS_FIX", ["REAL_FIX_REQUIRED", "NEEDS_HUMAN"], ["R1"]]
  ];
  for (const [role, kind, verdict, classifications, closedFindingIds] of cases) {
    await t.test(`${role}: ${kind} ${verdict}`, (t) => {
      const ws = fixture(t);
      const parentHead = ws.head;
      const subject = { headOid: parentHead, baseOid: BASE, reviewKey: KEY, specHash: "none" };
      const publishJudgment = (checkpointType, priorVerdict, classes) => {
        let inputs;
        let result;
        if (checkpointType === "finding-judge") {
          const review = taskResult("review", parentHead, { findings: classes.map((_, index) => ({
            id: `R${index + 1}`, severity: "high", file: "source.txt",
            claim: "Approval intent cannot be established", evidence: "The approval record lacks its intent",
            headOid: parentHead, baseOid: BASE, reviewKey: KEY
          })) });
          const reviewPath = path.join(ws.root, "accepted-review.json");
          const admittedReview = admit({ ...ws, result: review, output: reviewPath, expected: {
            taskType: "review", attemptId: review.attemptId, pr: 379,
            headOid: parentHead, baseOid: BASE, reviewKey: KEY
          } });
          assert.equal(admittedReview.code, 0, JSON.stringify(admittedReview.payload));
          inputs = { review: JSON.parse(fs.readFileSync(reviewPath)) };
          result = { findings: classes.map((classification, index) => ({
            id: `R${index + 1}`, classification, reason: "The assigned evidence determines this disposition",
            file: classification.startsWith("CONFIRMED_") ? "source.txt" : null,
            line: classification.startsWith("CONFIRMED_") ? 1 : null,
            comment: classification.startsWith("CONFIRMED_") ? "Handle the failed write" : null
          })), residualRisk: null };
        } else {
          inputs = { threads: classes.map((_, index) => ({ id: `T${index + 1}` })) };
          result = { dispositions: classes.map((classification, index) => ({
            threadId: `T${index + 1}`, classification, reason: "The assigned evidence determines this disposition",
            reply: null, resolve: false,
            ...(classification === "REAL_FIX_REQUIRED" ? { finding: {
              id: `R${index + 1}`, file: "source.txt", claim: "The write result is discarded",
              evidence: "The caller ignores the write result"
            } } : {})
          })), residualRisk: null };
        }
        assign(ws, checkpointType, subject, inputs, priorVerdict, result);
        const admitted = admit(ws);
        assert.equal(admitted.code, 0, JSON.stringify(admitted.payload));
        assert.equal(admitted.payload.summary.verdict, priorVerdict);
        return JSON.parse(fs.readFileSync(ws.output));
      };
      const prerequisite = publishJudgment(kind, verdict, classifications);
      const findings = role === "findings" ? prerequisite : publishJudgment("finding-judge", "ACCEPT", []);
      fs.writeFileSync(path.join(ws.worktree, "source.txt"), "known findings corrected\n");
      command("git", ["add", "."], ws.worktree);
      command("git", ["commit", "-qm", "correct known findings"], ws.worktree);
      const fixCommit = command("git", ["rev-parse", "HEAD"], ws.worktree);
      const fix = taskResult("fix", parentHead, { fix: { commit: fixCommit, changedFiles: ["source.txt"], closedFindingIds } });
      assign(ws, "verifier", { parentHead, fixCommit, baseOid: BASE, reviewKey: KEY, specHash: "none" },
        { fix, findings, ...(role === "findings" ? {} : { [role]: prerequisite }) }, "ACCEPT", {
          closedFindingIds, blocking: [], changedFiles: ["source.txt"],
          commands: ["focused check"], results: ["PASS"], residualRisk: null
        });
      fs.writeFileSync(ws.output, "previous canonical evidence\n");
      const rejected = admit(ws);
      assert.equal(rejected.code, 1, JSON.stringify(rejected.payload));
      assert.equal(rejected.payload.ok, false);
      assert.equal(fs.readFileSync(ws.output, "utf8"), "previous canonical evidence\n");
      for (const outcome of ["REJECT", "BLOCKED"]) {
        ws.result.verdict = outcome;
        ws.result.result.blocking = ["A prerequisite decision remains unresolved"];
        const admitted = admit(ws);
        assert.equal(admitted.code, 0, JSON.stringify(admitted.payload));
        assert.equal(admitted.payload.summary.verdict, outcome);
        assert.deepEqual(JSON.parse(fs.readFileSync(ws.output)), ws.result);
      }
    });
  }
});

test("a prior composition is identified by its new head and derived key", (t) => {
  const ws = fixture(t);
  const parentKey = computeReviewKey({ repo: "chinrw/stocks", pr: 379, headOid: BASE, baseOid: BASE, specHash: "none" });
  const parent = { schemaVersion: 1, checkpointType: "composition-verifier", attemptId: "att-prior-composition", pr: 379,
    subject: { oldParentHead: "f".repeat(40), newParentHead: BASE, childHead: "e".repeat(40), baseOid: BASE, parentReviewKey: KEY, childReviewKey: "e".repeat(64), specHash: "none" },
    inputs: { parent: "a".repeat(64), child: "b".repeat(64) }, resultCompleteness: "complete", verdict: "ACCEPT",
    result: { evidence: ["Prior composition was accepted"], checkedInvariants: ["Prior tree proof"], blocking: [], residualRisk: null } };
  const subject = { oldParentHead: BASE, newParentHead: ws.head, childHead: "d".repeat(40), baseOid: BASE, parentReviewKey: parentKey, childReviewKey: "e".repeat(64), specHash: "none" };
  assign(ws, "composition-verifier", subject, { parent, child: judged("d".repeat(40), { pr: 380, key: "e".repeat(64), verdict: "ACCEPT" }) }, "REVIEW", {
    evidence: [], checkedInvariants: [], blocking: [], residualRisk: "Needs a full review"
  });
  assert.equal(admit(ws).code, 1, "the prior composition key needs repository identity");
  ws.expected.repo = "chinrw/stocks";
  const outcome = admit(ws);
  assert.equal(outcome.code, 0, JSON.stringify(outcome.payload));
  ws.result.subject.parentReviewKey = KEY;
  assert.equal(admit(ws).code, 1, "the old input key cannot stand in for the composed key");
});
