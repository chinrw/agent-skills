import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { canonicalHash, canonicalize } from "../scripts/lib/json-io.mjs";
import { SENTINEL, parseArtifact } from "../scripts/parse-codex-artifact.mjs";
import { DECISIONS, reconcile } from "../scripts/reconcile-codex-artifacts.mjs";

const HEAD = "e363a839522e4960d372ce42125cce05c6a64e82";
const BASE = "7f1bc449f10686a1d013121c81c2c44e65a9637f";
const KEY = "90eb74228b4dd711956acd443b74c215d2212192b8ddabc57e499037e8ab0681";
const ATTEMPT = "att-0123456789abcdef01";

const EXPECTED = {
  taskType: "review",
  pr: 379,
  headOid: HEAD,
  baseOid: BASE,
  reviewKey: KEY,
  attemptId: ATTEMPT
};

function artifact(overrides = {}) {
  return {
    schemaVersion: 1,
    taskType: "review",
    attemptId: ATTEMPT,
    pr: 379,
    headOid: HEAD,
    baseOid: BASE,
    reviewKey: KEY,
    specHash: "none",
    resultCompleteness: "complete",
    findings: [],
    ...overrides
  };
}

function finding(overrides = {}) {
  return {
    id: "R1",
    severity: "blocking",
    file: "src/api/runs.py",
    line: 88,
    claim: "The listing endpoint drops the LIMIT clause when a cursor is supplied.",
    evidence: "build_query() branches on cursor and returns the unbounded SELECT at line 88.",
    headOid: HEAD,
    baseOid: BASE,
    reviewKey: KEY,
    ...overrides
  };
}

function stdoutWith(value, { prose = "Review complete.\n\n", trailing = "" } = {}) {
  return `${prose}${SENTINEL}\n\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\`${trailing}`;
}

function workspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "babysit-prs-transport-"));
  const launchCwd = path.join(root, "worktree");
  const runDir = path.join(root, "run", "pr-379");
  const diagnostics = path.join(root, "run", "pr-379", "diagnostics");
  fs.mkdirSync(launchCwd, { recursive: true });
  fs.mkdirSync(runDir, { recursive: true });
  return { root, launchCwd, runDir, diagnostics, canonical: path.join(runDir, "codex-review.json") };
}

/* ------------------------------ read-only lane ---------------------------- */

test("a read-only review that cannot write a file is still accepted from stdout", () => {
  const ws = workspace();
  const value = artifact({ findings: [finding()] });

  const decision = reconcile({
    stdout: stdoutWith(value),
    launchCwd: ws.launchCwd,
    canonicalArtifact: ws.canonical,
    stagingArtifactPath: null, // read-only: sandbox is `read-only`, no file is possible
    expected: EXPECTED,
    terminalStatus: "success",
    writeMode: false
  });

  assert.equal(decision.decision, DECISIONS.ACCEPT);
  assert.equal(decision.accepted, true);
  assert.equal(decision.transport, "stdout-only");
  assert.equal(decision.staging.present, false);

  // The controller — not Codex — placed the result in the canonical run dir.
  assert.ok(fs.existsSync(ws.canonical));
  assert.deepEqual(JSON.parse(fs.readFileSync(ws.canonical, "utf8")), value);
  assert.equal(decision.canonicalSha256, canonicalHash(value));
  assert.equal(decision.summary.findingCount, 1);
  assert.equal(decision.summary.blockingCount, 1);

  fs.rmSync(ws.root, { recursive: true, force: true });
});

/* ---------------------------- write-enabled lane -------------------------- */

test("a write-enabled task with matching stdout and staging file is accepted", () => {
  const ws = workspace();
  const value = artifact({ taskType: "fix", findings: [] });
  const expected = { ...EXPECTED, taskType: "fix" };

  // Staging file written with different key order and whitespace: canonicalization
  // must make the two channels compare equal.
  const reordered = { findings: [], ...value };
  fs.writeFileSync(path.join(ws.launchCwd, "fix-result.json"), JSON.stringify(reordered));

  const decision = reconcile({
    stdout: stdoutWith(value),
    launchCwd: ws.launchCwd,
    canonicalArtifact: ws.canonical,
    stagingArtifactPath: "fix-result.json",
    expected,
    terminalStatus: "success",
    writeMode: true
  });

  assert.equal(decision.decision, DECISIONS.ACCEPT);
  assert.equal(decision.transport, "stdout+staging");
  assert.equal(decision.staging.sha256, decision.stdout.sha256);
  assert.ok(fs.existsSync(ws.canonical));

  fs.rmSync(ws.root, { recursive: true, force: true });
});

test("channels that differ are BLOCKED, never silently reconciled to one side", () => {
  const ws = workspace();
  const fromStdout = artifact({ findings: [finding()] });
  const fromFile = artifact({ findings: [finding({ severity: "low" })] });

  fs.writeFileSync(path.join(ws.launchCwd, "codex-review.json"), JSON.stringify(fromFile, null, 2));

  const decision = reconcile({
    stdout: stdoutWith(fromStdout),
    launchCwd: ws.launchCwd,
    canonicalArtifact: ws.canonical,
    stagingArtifactPath: "codex-review.json",
    diagnosticsDir: ws.diagnostics,
    expected: EXPECTED,
    terminalStatus: "success",
    writeMode: true
  });

  assert.equal(decision.decision, DECISIONS.BLOCKED_CHANNEL_MISMATCH);
  assert.equal(decision.decision, "BLOCKED_ARTIFACT_CHANNEL_MISMATCH");
  assert.equal(decision.accepted, false);
  assert.equal(decision.canonicalArtifactPath, null);
  assert.ok(!fs.existsSync(ws.canonical), "no canonical artifact may be written on mismatch");
  assert.notEqual(decision.stdout.sha256, decision.staging.sha256);

  // Both raw channels are retained for inspection, explicitly marked non-evidence.
  assert.ok(fs.existsSync(path.join(ws.diagnostics, "stdout.raw.txt")));
  assert.ok(fs.existsSync(path.join(ws.diagnostics, "staging.raw.json")));
  const readme = JSON.parse(fs.readFileSync(path.join(ws.diagnostics, "README.json"), "utf8"));
  assert.match(readme.warning, /NOT evidence/);

  fs.rmSync(ws.root, { recursive: true, force: true });
});

test("a staging file without a stdout sentinel is incomplete and triggers a rerun", () => {
  const ws = workspace();
  fs.writeFileSync(path.join(ws.launchCwd, "fix-result.json"), JSON.stringify(artifact(), null, 2));

  const decision = reconcile({
    stdout: "I finished the work and wrote the file.\n",
    launchCwd: ws.launchCwd,
    canonicalArtifact: ws.canonical,
    stagingArtifactPath: "fix-result.json",
    expected: EXPECTED,
    terminalStatus: "success",
    writeMode: true
  });

  assert.equal(decision.decision, DECISIONS.INCOMPLETE);
  assert.equal(decision.decision, "INCOMPLETE_RERUN_REQUIRED");
  assert.equal(decision.rerunRequired, true);
  assert.equal(decision.accepted, false);
  assert.ok(decision.reasons.includes("stdout-sentinel-missing"));
  assert.ok(decision.reasons.some((r) => /file-alone-is-never-sufficient/.test(r)));
  assert.ok(!fs.existsSync(ws.canonical));

  fs.rmSync(ws.root, { recursive: true, force: true });
});

/* -------------------------------- identity -------------------------------- */

test("wrong head / base / review key / attempt id are each rejected", () => {
  const cases = [
    ["headOid", { headOid: "1".repeat(40) }],
    ["baseOid", { baseOid: "2".repeat(40) }],
    ["reviewKey", { reviewKey: "3".repeat(64) }],
    ["attemptId", { attemptId: "att-ffffffffffffffffff" }],
    ["pr", { pr: 380 }],
    ["taskType", { taskType: "fix" }]
  ];

  for (const [label, override] of cases) {
    const ws = workspace();
    const value = artifact(override);
    // Keep envelope-vs-finding consistency so we isolate the identity check.
    const decision = reconcile({
      stdout: stdoutWith(value),
      launchCwd: ws.launchCwd,
      canonicalArtifact: ws.canonical,
      expected: EXPECTED,
      terminalStatus: "success",
      writeMode: false
    });

    assert.equal(decision.accepted, false, `${label} must be rejected`);
    assert.equal(decision.decision, "REJECTED_IDENTITY_MISMATCH", `${label}`);
    assert.ok(decision.reasons.some((r) => r.startsWith(`identity-mismatch:${label}`)), `${label}: ${decision.reasons}`);
    assert.ok(!fs.existsSync(ws.canonical));
    fs.rmSync(ws.root, { recursive: true, force: true });
  }
});

test("stale output from attempt 1 cannot satisfy attempt 2", () => {
  const ws = workspace();
  const attempt1 = artifact({ attemptId: "att-111111111111111111" });

  const decision = reconcile({
    stdout: stdoutWith(attempt1),
    launchCwd: ws.launchCwd,
    canonicalArtifact: ws.canonical,
    expected: { ...EXPECTED, attemptId: "att-222222222222222222" },
    terminalStatus: "success"
  });

  assert.equal(decision.accepted, false);
  assert.ok(decision.reasons.some((r) => r.startsWith("identity-mismatch:attemptId")));

  fs.rmSync(ws.root, { recursive: true, force: true });
});

test("a finding whose identity disagrees with its envelope is rejected", () => {
  const ws = workspace();
  const value = artifact({ findings: [finding({ headOid: "9".repeat(40) })] });

  const decision = reconcile({
    stdout: stdoutWith(value),
    launchCwd: ws.launchCwd,
    canonicalArtifact: ws.canonical,
    expected: EXPECTED,
    terminalStatus: "success"
  });

  assert.equal(decision.accepted, false);
  assert.ok(decision.reasons.some((r) => /headOid does not match the artifact envelope/.test(r)));

  fs.rmSync(ws.root, { recursive: true, force: true });
});

/* --------------------------------- schema --------------------------------- */

test("malformed or schema-incomplete stdout JSON is rejected", () => {
  const ws = workspace();

  const malformed = reconcile({
    stdout: `${SENTINEL}\n\`\`\`json\n{ "schemaVersion": 1, \n\`\`\``,
    launchCwd: ws.launchCwd,
    canonicalArtifact: ws.canonical,
    expected: EXPECTED,
    terminalStatus: "success"
  });
  assert.equal(malformed.accepted, false);
  assert.ok(malformed.reasons.some((r) => /stdout-json-unparseable/.test(r)));

  const incomplete = reconcile({
    stdout: stdoutWith({ schemaVersion: 1, taskType: "review", pr: 379 }),
    launchCwd: ws.launchCwd,
    canonicalArtifact: ws.canonical,
    expected: EXPECTED,
    terminalStatus: "success"
  });
  assert.equal(incomplete.decision, "REJECTED_SCHEMA");
  assert.ok(incomplete.reasons.some((r) => /missing required property/.test(r)));

  assert.ok(!fs.existsSync(ws.canonical));
  fs.rmSync(ws.root, { recursive: true, force: true });
});

test("a partial finding without file / evidence / identity is rejected", () => {
  const ws = workspace();
  const value = artifact({
    findings: [{ id: "R1", severity: "blocking", claim: "something is wrong here" }]
  });

  const decision = reconcile({
    stdout: stdoutWith(value),
    launchCwd: ws.launchCwd,
    canonicalArtifact: ws.canonical,
    expected: EXPECTED,
    terminalStatus: "success"
  });

  assert.equal(decision.decision, "REJECTED_SCHEMA");
  for (const field of ["file", "evidence", "headOid", "baseOid", "reviewKey"]) {
    assert.ok(
      decision.reasons.some((r) => r.includes(`missing required property "${field}"`)),
      `missing ${field} must be reported`
    );
  }

  fs.rmSync(ws.root, { recursive: true, force: true });
});

test("resultCompleteness other than \"complete\" is inconclusive, not evidence", () => {
  for (const completeness of ["partial", "aborted"]) {
    const ws = workspace();
    const decision = reconcile({
      stdout: stdoutWith(artifact({ resultCompleteness: completeness, findings: [finding()] })),
      launchCwd: ws.launchCwd,
      canonicalArtifact: ws.canonical,
      expected: EXPECTED,
      terminalStatus: "success"
    });

    assert.equal(decision.accepted, false, completeness);
    assert.equal(decision.decision, "INCOMPLETE_RERUN_REQUIRED", completeness);
    assert.equal(decision.rerunRequired, true, completeness);
    assert.ok(!fs.existsSync(ws.canonical));
    fs.rmSync(ws.root, { recursive: true, force: true });
  }
});

/* ------------------------------ sentinel rules ---------------------------- */

test("the sentinel block must be the FINAL structured block", () => {
  const value = artifact();
  const trailing = parseArtifact(stdoutWith(value, { trailing: "\n\nOne more thought: consider refactoring.\n" }), EXPECTED);
  assert.equal(trailing.ok, false);
  assert.deepEqual(trailing.errors, ["sentinel-block-is-not-the-final-structured-block"]);

  const clean = parseArtifact(stdoutWith(value, { trailing: "\n  \n" }), EXPECTED);
  assert.equal(clean.ok, true, "trailing whitespace alone is fine");
});

test("more than one sentinel block is ambiguous and rejected", () => {
  const value = artifact();
  const twice = `${stdoutWith(value)}\n\n${stdoutWith(value)}`;
  const result = parseArtifact(twice, EXPECTED);
  assert.equal(result.ok, false);
  assert.deepEqual(result.errors, ["multiple-sentinel-blocks:2"]);
});

test("a sentinel with no JSON fence is malformed", () => {
  const result = parseArtifact(`${SENTINEL}\nno fence here\n`, EXPECTED);
  assert.equal(result.ok, false);
  assert.match(result.errors[0], /malformed-sentinel-block/);
});

test("a missing sentinel is reported distinctly from a malformed one", () => {
  const result = parseArtifact("Review complete. Found 3 issues.\n", EXPECTED);
  assert.equal(result.sentinelPresent, false);
  assert.deepEqual(result.errors, ["stdout-sentinel-missing"]);
});

/* ------------------------------ path containment -------------------------- */

test("a staging path that escapes the launch root is rejected", () => {
  const escapes = ["../outside.json", "../../etc/passwd", "/etc/passwd", "sub/../../escape.json"];

  for (const candidate of escapes) {
    const ws = workspace();
    const decision = reconcile({
      stdout: stdoutWith(artifact()),
      launchCwd: ws.launchCwd,
      canonicalArtifact: ws.canonical,
      stagingArtifactPath: candidate,
      expected: EXPECTED,
      terminalStatus: "success",
      writeMode: true
    });

    assert.equal(decision.decision, "REJECTED_STAGING_PATH_ESCAPE", candidate);
    assert.equal(decision.accepted, false, candidate);
    assert.ok(!fs.existsSync(ws.canonical), candidate);
    fs.rmSync(ws.root, { recursive: true, force: true });
  }
});

test("a symlink out of the launch root is rejected even though the path looks contained", () => {
  const ws = workspace();
  const outside = path.join(ws.root, "outside.json");
  fs.writeFileSync(outside, JSON.stringify(artifact(), null, 2));
  fs.symlinkSync(outside, path.join(ws.launchCwd, "sneaky.json"));

  const decision = reconcile({
    stdout: stdoutWith(artifact()),
    launchCwd: ws.launchCwd,
    canonicalArtifact: ws.canonical,
    stagingArtifactPath: "sneaky.json",
    expected: EXPECTED,
    terminalStatus: "success",
    writeMode: true
  });

  assert.equal(decision.decision, "REJECTED_STAGING_PATH_ESCAPE");
  assert.ok(decision.reasons.some((r) => /symlink-escapes-root/.test(r)));

  fs.rmSync(ws.root, { recursive: true, force: true });
});

/* --------------------------- atomicity and hashing ------------------------ */

test("the canonical write is atomic and records a canonical SHA-256", () => {
  const ws = workspace();
  const value = artifact({ findings: [finding()] });

  const decision = reconcile({
    stdout: stdoutWith(value),
    launchCwd: ws.launchCwd,
    canonicalArtifact: ws.canonical,
    expected: EXPECTED,
    terminalStatus: "success"
  });

  assert.equal(decision.canonicalSha256, canonicalHash(value));
  assert.equal(canonicalHash(JSON.parse(fs.readFileSync(ws.canonical, "utf8"))), decision.canonicalSha256);

  // The temp file used by the rename dance must be gone.
  const leftovers = fs.readdirSync(ws.runDir).filter((name) => name.includes(".tmp"));
  assert.deepEqual(leftovers, [], "atomic write must leave no temp files");

  fs.rmSync(ws.root, { recursive: true, force: true });
});

test("canonicalization is key-order and whitespace independent", () => {
  const a = { b: 2, a: 1, nested: { y: [1, 2], x: "s" } };
  const b = { nested: { x: "s", y: [1, 2] }, a: 1, b: 2 };
  assert.equal(canonicalize(a), canonicalize(b));
  assert.equal(canonicalHash(a), canonicalHash(b));
  // Array order still matters — it is data, not formatting.
  assert.notEqual(canonicalHash({ x: [1, 2] }), canonicalHash({ x: [2, 1] }));
});

test("a non-success terminal status is never accepted, even with a valid artifact", () => {
  const ws = workspace();
  const decision = reconcile({
    stdout: stdoutWith(artifact()),
    launchCwd: ws.launchCwd,
    canonicalArtifact: ws.canonical,
    expected: EXPECTED,
    terminalStatus: "failed"
  });

  assert.equal(decision.accepted, false);
  assert.equal(decision.rerunRequired, true);
  assert.ok(decision.reasons.some((r) => /terminal-status=failed/.test(r)));

  fs.rmSync(ws.root, { recursive: true, force: true });
});

test("--dry-run reconciliation writes no canonical artifact", () => {
  const ws = workspace();
  const decision = reconcile({
    stdout: stdoutWith(artifact()),
    launchCwd: ws.launchCwd,
    canonicalArtifact: ws.canonical,
    expected: EXPECTED,
    terminalStatus: "success",
    dryRun: true
  });

  assert.equal(decision.accepted, true);
  assert.ok(!fs.existsSync(ws.canonical), "dry-run must not write");

  fs.rmSync(ws.root, { recursive: true, force: true });
});
