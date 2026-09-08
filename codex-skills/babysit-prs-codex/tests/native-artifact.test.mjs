import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { acceptArtifact } from "../scripts/validate-artifact.mjs";

const SCRIPT = fileURLToPath(new URL("../scripts/validate-artifact.mjs", import.meta.url));
const expected = {
  taskType: "review", attemptId: "att-native-1", pr: 379,
  headOid: "a".repeat(40), baseOid: "b".repeat(40), reviewKey: "c".repeat(64)
};

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "babysit-native-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const input = path.join(root, "result.json");
  const output = path.join(root, "accepted.json");
  const artifact = { schemaVersion: 1, ...expected, resultCompleteness: "complete", findings: [] };
  fs.writeFileSync(input, JSON.stringify(artifact));
  return { root, input, output, artifact };
}

test("a completed native task publishes its validated file without stdout", (t) => {
  const ws = fixture(t);
  const result = acceptArtifact({ ...ws, expected, status: "completed" });
  assert.equal(result.ok, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(ws.output)), ws.artifact);
  assert.equal(result.sha256.length, 64);
  assert.equal(result.summary.findingCount, 0);
  assert.equal("artifact" in result, false, "the controller receives only a compact summary");
});

test("running, failed and cancelled tasks cannot publish even a complete artifact", (t) => {
  const ws = fixture(t);
  for (const status of [undefined, "running", "failed", "cancelled"]) {
    const result = acceptArtifact({ ...ws, expected, status });
    assert.equal(result.ok, false, String(status));
    assert.equal(fs.existsSync(ws.output), false);
  }
});

test("every assigned identity field is required and must match exactly", (t) => {
  const ws = fixture(t);
  for (const field of Object.keys(expected)) {
    const missing = { ...expected };
    delete missing[field];
    assert.equal(acceptArtifact({ ...ws, expected: missing, status: "completed" }).ok, false, field);
    const changed = { ...expected, [field]: field === "pr" ? 380 : `other-${expected[field]}` };
    assert.equal(acceptArtifact({ ...ws, expected: changed, status: "completed" }).ok, false, field);
  }
  assert.equal(acceptArtifact({ ...ws, expected: { ...expected, attemptId: "ATT-native-1" }, status: "completed" }).ok, false);
  assert.equal(fs.existsSync(ws.output), false);
});

test("partial, count-only, malformed and missing files never replace accepted evidence", (t) => {
  const ws = fixture(t);
  fs.writeFileSync(ws.output, "previous evidence\n");
  for (const content of [
    JSON.stringify({ ...ws.artifact, resultCompleteness: "partial" }),
    JSON.stringify({ blocking: 0 }),
    "{"
  ]) {
    fs.writeFileSync(ws.input, content);
    assert.equal(acceptArtifact({ ...ws, expected, status: "completed" }).ok, false);
    assert.equal(fs.readFileSync(ws.output, "utf8"), "previous evidence\n");
  }
  fs.unlinkSync(ws.input);
  assert.equal(acceptArtifact({ ...ws, expected, status: "completed" }).ok, false);
});

test("a finding cannot smuggle in evidence from another head", (t) => {
  const ws = fixture(t);
  ws.artifact.findings = [{
    id: "R1", severity: "high", file: "src/lib.rs", line: 12,
    claim: "A write can be lost", evidence: "The caller discards the write result",
    headOid: "d".repeat(40), baseOid: expected.baseOid, reviewKey: expected.reviewKey
  }];
  fs.writeFileSync(ws.input, JSON.stringify(ws.artifact));
  const result = acceptArtifact({ ...ws, expected, status: "completed" });
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /headOid/);
  assert.equal(fs.existsSync(ws.output), false);
});

test("complete envelopes still need explicit findings and fix content", (t) => {
  const ws = fixture(t);
  const noFindings = { ...ws.artifact };
  delete noFindings.findings;
  fs.writeFileSync(ws.input, JSON.stringify(noFindings));
  assert.equal(acceptArtifact({ ...ws, expected, status: "completed" }).ok, false);
  fs.writeFileSync(ws.input, JSON.stringify({ ...ws.artifact, taskType: "fix" }));
  assert.equal(acceptArtifact({ ...ws, expected: { ...expected, taskType: "fix" }, status: "completed" }).ok, false);
  assert.equal(fs.existsSync(ws.output), false);
});

test("the installed CLI validates and publishes native results through a symlink", (t) => {
  const ws = fixture(t);
  const link = path.join(ws.root, "validate.mjs");
  fs.symlinkSync(SCRIPT, link);
  const expectations = path.join(ws.root, "expected.json");
  fs.writeFileSync(expectations, JSON.stringify(expected));
  const args = [link, "--input", ws.input, "--expect", expectations, "--status", "completed", "--out", ws.output];
  const run = spawnSync(process.execPath, args, { encoding: "utf8" });
  assert.ifError(run.error);
  assert.equal(run.status, 0, run.stderr);
  assert.equal(JSON.parse(run.stdout).ok, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(ws.output)), ws.artifact);
  fs.writeFileSync(ws.input, JSON.stringify({ ...ws.artifact, attemptId: "att-stale" }));
  const stale = spawnSync(process.execPath, args, { encoding: "utf8" });
  assert.ifError(stale.error);
  assert.equal(stale.status, 1, stale.stderr);
  assert.equal(JSON.parse(stale.stdout).ok, false);
  assert.deepEqual(JSON.parse(fs.readFileSync(ws.output)), ws.artifact);
});
