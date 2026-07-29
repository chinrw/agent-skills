/**
 * P0-C: a count is not evidence.
 *
 * A dead or incomplete Codex job can still expose summary telemetry such as
 * `blocking=2 findings=3` in its log preview. That number must never create a
 * blocker ticket, reach GitHub, spawn a fix task, be read as "zero findings", or
 * grant acceptance. The only thing it may do is trigger one fresh rerun.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { readJson } from "../scripts/lib/json-io.mjs";
import {
  JOB_STATES,
  collect,
  launch,
  newAttemptId,
  readReceipt
} from "../scripts/codex-job.mjs";
import { SENTINEL } from "../scripts/parse-codex-artifact.mjs";
import { probe } from "../scripts/probe-codex-capabilities.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE_COMPANION = path.join(HERE, "fake-companion.mjs");
const COMPANIONS = path.join(HERE, "fixtures", "companions");

const HEAD = "e363a839522e4960d372ce42125cce05c6a64e82";
const BASE = "7f1bc449f10686a1d013121c81c2c44e65a9637f";
const KEY = "90eb74228b4dd711956acd443b74c215d2212192b8ddabc57e499037e8ab0681";

function sh(cmd, args, cwd) {
  const result = spawnSync(cmd, args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`${cmd} ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

function scaffold() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "babysit-prs-evidence-"));
  const main = path.join(root, "main");
  fs.mkdirSync(main);
  sh("git", ["init", "-q", "-b", "main"], main);
  sh("git", ["config", "user.email", "test@example.invalid"], main);
  sh("git", ["config", "user.name", "Test"], main);
  sh("git", ["config", "commit.gpgsign", "false"], main);
  fs.writeFileSync(path.join(main, "README.md"), "seed\n");
  sh("git", ["add", "."], main);
  sh("git", ["commit", "-qm", "seed"], main);

  const worktree = path.join(main, ".claude", "worktrees", "read");
  sh("git", ["worktree", "add", "-q", "--detach", worktree, "HEAD"], main);

  const state = path.join(root, "codex-state");
  const runDir = path.join(root, "run", "pr-379");
  fs.mkdirSync(state, { recursive: true });
  fs.mkdirSync(runDir, { recursive: true });

  const capabilitiesPath = path.join(runDir, "codex-capabilities.json");
  fs.writeFileSync(
    capabilitiesPath,
    JSON.stringify(probe({ companionPath: path.join(COMPANIONS, "no-max.mjs"), includeCodexVersion: false }), null, 2)
  );

  return { root, main, worktree, state, runDir, capabilitiesPath };
}

function withFakeEnv(env, fn) {
  const previous = { ...process.env };
  Object.assign(process.env, env);
  try {
    return fn();
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
  }
}

function completeArtifact(attemptId, findings = []) {
  return {
    schemaVersion: 1,
    taskType: "review",
    attemptId,
    pr: 379,
    headOid: HEAD,
    baseOid: BASE,
    reviewKey: KEY,
    specHash: "none",
    resultCompleteness: "complete",
    findings
  };
}

function finding(id = "R1") {
  return {
    id,
    severity: "blocking",
    file: "src/api/runs.py",
    line: 88,
    claim: "The listing endpoint drops the LIMIT clause when a cursor is supplied.",
    evidence: "build_query() branches on cursor and returns the unbounded SELECT.",
    headOid: HEAD,
    baseOid: BASE,
    reviewKey: KEY
  };
}

function sentinelStdout(value) {
  return `Done.\n\n${SENTINEL}\n\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\`\n`;
}

/** Run one attempt end-to-end and return the collect() outcome. */
function runAttempt(ws, { attemptId, output, status = "completed", supersedes = null, pid = null }) {
  const receiptPath = path.join(ws.runDir, `launch-receipt-${attemptId}.json`);
  const canonical = path.join(ws.runDir, "codex-review.json");
  const outputFile = path.join(ws.runDir, `output-${attemptId}.txt`);
  fs.writeFileSync(outputFile, output);

  return withFakeEnv(
    {
      FAKE_CODEX_STATE: ws.state,
      FAKE_CODEX_OUTPUT: outputFile,
      FAKE_CODEX_STATUS: status,
      ...(pid ? { FAKE_CODEX_PID: String(pid) } : {})
    },
    () => {
      launch({
        taskType: "review",
        prompt: "review the exact diff",
        launchCwd: ws.worktree,
        receiptPath,
        capabilitiesPath: ws.capabilitiesPath,
        companionPath: FAKE_COMPANION,
        requestedEffort: "max",
        requestedModel: "gpt-5.6-sol",
        attemptId,
        attemptNumber: supersedes ? 2 : 1,
        supersedesAttemptId: supersedes,
        pr: 379,
        headOid: HEAD,
        baseOid: BASE,
        reviewKey: KEY,
        canonicalArtifactPath: canonical
      });
      return {
        outcome: collect(readReceipt(receiptPath), {
          canonicalArtifact: canonical,
          diagnosticsDir: path.join(ws.runDir, "diagnostics", attemptId)
        }),
        canonical,
        receiptPath
      };
    }
  );
}

/* -------------------------------------------------------------------------- */

test("a dead job reporting blocking=2 with no structured findings creates no blockers", () => {
  const ws = scaffold();
  const telemetryOnly = "Codex review interrupted.\nblocking=2\nfindings=3\n";

  const { outcome, canonical } = runAttempt(ws, {
    attemptId: newAttemptId(),
    output: telemetryOnly,
    status: "failed"
  });

  assert.equal(outcome.accepted, false);
  assert.equal(outcome.jobState, JOB_STATES.FAILED);
  assert.equal(outcome.rerunRequired, true, "a fresh rerun is mandatory");
  assert.equal(outcome.reconciliation.decision, "INCOMPLETE_RERUN_REQUIRED");

  // No canonical artifact, so nothing downstream can read a finding.
  assert.ok(!fs.existsSync(canonical));
  assert.equal(outcome.reconciliation.summary, null);

  // The counts appear nowhere in the structured outcome the controller consumes.
  const serialized = JSON.stringify({
    accepted: outcome.accepted,
    summary: outcome.reconciliation.summary,
    handoff: outcome.handoff
  });
  assert.ok(!/blocking=2/.test(serialized));
  assert.ok(!/findings=3/.test(serialized));

  fs.rmSync(ws.root, { recursive: true, force: true });
});

test("a terminal job with blocking=0 and no artifact grants no acceptance", () => {
  const ws = scaffold();

  const { outcome, canonical } = runAttempt(ws, {
    attemptId: newAttemptId(),
    output: "Review finished.\nblocking=0\nfindings=0\n",
    status: "completed"
  });

  assert.equal(outcome.jobState, JOB_STATES.SUCCESS, "the job itself ended cleanly");
  assert.equal(outcome.accepted, false, "clean exit is still not acceptance without an artifact");
  assert.equal(outcome.rerunRequired, true);
  assert.ok(outcome.reconciliation.reasons.includes("stdout-sentinel-missing"));
  assert.ok(!fs.existsSync(canonical), "no artifact means no accepted review evidence");

  fs.rmSync(ws.root, { recursive: true, force: true });
});

test("a fresh rerun supersedes the incomplete attempt and only rerun evidence is used", () => {
  const ws = scaffold();

  const attempt1 = newAttemptId("a1");
  const first = runAttempt(ws, { attemptId: attempt1, output: "blocking=2\nfindings=3\n", status: "failed" });
  assert.equal(first.outcome.accepted, false);
  assert.equal(first.outcome.rerunRequired, true);

  // Attempt 2 runs fresh, at the effort ceiling from preflight, with a new id.
  const attempt2 = newAttemptId("a2");
  const second = runAttempt(ws, {
    attemptId: attempt2,
    output: sentinelStdout(completeArtifact(attempt2, [finding("R1")])),
    supersedes: attempt1
  });

  assert.equal(second.outcome.accepted, true);
  assert.equal(second.outcome.reconciliation.summary.attemptId, attempt2);

  const persisted = readJson(second.canonical);
  assert.equal(persisted.attemptId, attempt2, "only the rerun's evidence is persisted");
  assert.equal(persisted.findings.length, 1);

  // The superseding relationship is recorded on the receipt.
  const receipt2 = readReceipt(second.receiptPath);
  assert.equal(receipt2.supersedesAttemptId, attempt1);
  assert.equal(receipt2.attemptNumber, 2);
  assert.equal(receipt2.effectiveEffort, "xhigh", "the rerun uses the preflight ceiling, not a guess");

  fs.rmSync(ws.root, { recursive: true, force: true });
});

test("stale attempt-1 output cannot satisfy attempt 2", () => {
  const ws = scaffold();
  const attempt1 = newAttemptId("a1");
  const attempt2 = newAttemptId("a2");

  // Attempt 2 is launched, but the transcript still carries attempt 1's artifact.
  const { outcome, canonical } = runAttempt(ws, {
    attemptId: attempt2,
    output: sentinelStdout(completeArtifact(attempt1, [finding("R1")])),
    supersedes: attempt1
  });

  assert.equal(outcome.accepted, false);
  assert.equal(outcome.reconciliation.decision, "REJECTED_IDENTITY_MISMATCH");
  assert.ok(outcome.reconciliation.reasons.some((r) => r.startsWith("identity-mismatch:attemptId")));
  assert.ok(!fs.existsSync(canonical));

  fs.rmSync(ws.root, { recursive: true, force: true });
});

test("both attempts incomplete => BLOCKED: codex-output-incomplete, with no invented findings", () => {
  const ws = scaffold();

  const attempt1 = newAttemptId("a1");
  const first = runAttempt(ws, { attemptId: attempt1, output: "blocking=2\n", status: "failed" });

  const attempt2 = newAttemptId("a2");
  const second = runAttempt(ws, {
    attemptId: attempt2,
    output: "still nothing structured\nfindings=3\n",
    status: "failed",
    supersedes: attempt1
  });

  assert.equal(first.outcome.accepted, false);
  assert.equal(second.outcome.accepted, false);

  // The controller's rule: two incomplete attempts terminate as a hard block.
  const attempts = [first.outcome, second.outcome];
  const terminalBlock =
    attempts.length >= 2 && attempts.every((a) => !a.accepted && a.rerunRequired)
      ? "BLOCKED: codex-output-incomplete"
      : null;
  assert.equal(terminalBlock, "BLOCKED: codex-output-incomplete");

  assert.ok(!fs.existsSync(path.join(ws.runDir, "codex-review.json")), "no artifact was ever accepted");
  for (const outcome of attempts) {
    assert.equal(outcome.reconciliation.summary, null, "no findings may be synthesized from either attempt");
  }

  fs.rmSync(ws.root, { recursive: true, force: true });
});

test("diagnostic logs and the launch receipt are preserved for an incomplete attempt", () => {
  const ws = scaffold();
  const attemptId = newAttemptId();

  const { outcome, receiptPath } = runAttempt(ws, {
    attemptId,
    output: "blocking=2\nfindings=3\n",
    status: "failed"
  });

  assert.ok(fs.existsSync(receiptPath), "the launch receipt survives for diagnosis");
  const diagnostics = outcome.reconciliation.diagnosticsDir;
  assert.ok(diagnostics && fs.existsSync(path.join(diagnostics, "stdout.raw.txt")));

  // The retained raw channel is explicitly labelled non-evidence.
  const readme = readJson(path.join(diagnostics, "README.json"));
  assert.match(readme.warning, /NOT evidence/);
  assert.match(readme.warning, /No finding, blocker, GitHub comment, fix task, or acceptance/);

  fs.rmSync(ws.root, { recursive: true, force: true });
});

test("a job that is still running is neither accepted nor rerun", () => {
  const ws = scaffold();

  const { outcome } = runAttempt(ws, {
    attemptId: newAttemptId(),
    output: "",
    status: "running",
    pid: process.pid // a genuinely live pid
  });

  assert.equal(outcome.jobState, JOB_STATES.RUNNING);
  assert.equal(outcome.terminal, false);
  assert.equal(outcome.accepted, false);
  assert.equal(outcome.rerunRequired, false, "a live job must not be restarted");

  fs.rmSync(ws.root, { recursive: true, force: true });
});

test("a job marked running behind a dead pid is stale, and rerunnable, not live", () => {
  const ws = scaffold();

  const { outcome } = runAttempt(ws, {
    attemptId: newAttemptId(),
    output: "blocking=1\n",
    status: "running",
    pid: 2 ** 30 // no such process
  });

  assert.equal(outcome.jobState, JOB_STATES.JOB_STALE_PID);
  assert.equal(outcome.accepted, false);
  assert.equal(outcome.rerunRequired, true);
  assert.equal(outcome.reconciliation.decision, "INCOMPLETE_RERUN_REQUIRED");
  assert.equal(outcome.reconciliation.summary, null, "a stale job yields no findings");
  assert.ok(outcome.reconciliation.reasons.includes("terminal-status=job_stale_pid"));

  fs.rmSync(ws.root, { recursive: true, force: true });
});
