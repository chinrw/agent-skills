import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { parseMarker, formatMarker } from "../lib/marker.mjs";
import { evaluate, readLock } from "../tick-gate.mjs";

const HEAD_A = "a".repeat(40);
const HEAD_B = "b".repeat(40);
const BASE_A = "c".repeat(40);
const BASE_B = "d".repeat(40);
const KEY = "e".repeat(64);
const NOW = "2026-08-29T12:00:00Z";

function pr(overrides = {}) {
  const { markerFields, ...rest } = overrides;
  const number = rest.number ?? 524;
  const fields = {
    pr: number,
    head: HEAD_A,
    base: BASE_A,
    spec: "none",
    key: KEY,
    state: "READY_ROOT",
    ...markerFields,
  };
  return {
    number,
    isDraft: false,
    headRefOid: HEAD_A,
    baseRefName: "stocks-dev",
    baseTipOid: BASE_A,
    ciPending: false,
    marker: parseMarker(formatMarker(fields)),
    ...rest,
  };
}

function reasonFor(input) {
  const verdict = evaluate([input], NOW);
  return verdict.due ? verdict.reasons[0].reason : null;
}

// ---------------------------------------------------------------- markers

test("a comment with no marker is due: the PR has never been reviewed", () => {
  assert.equal(reasonFor(pr({ marker: { found: false } })), "no-marker");
});

test("a legacy byte dialect never counts as acceptance", () => {
  const legacy = parseMarker("<!-- babysit-prs:v2 pr=524 head=abcdef12 base=99887766 spec=none state=READY_ROOT -->");
  assert.equal(legacy.dialect, "v2-legacy-trailing-nul");
  assert.equal(reasonFor(pr({ marker: legacy })), "marker-dialect-v2-legacy-trailing-nul");
});

test("a marker naming a different PR is not this PR's evidence", () => {
  assert.equal(reasonFor(pr({ markerFields: { pr: 999 } })), "marker-pr-mismatch");
});

test("a marker without a state cannot be scheduled", () => {
  const marker = parseMarker("<!-- babysit-prs:v2 pr=524 head=" + HEAD_A + " base=" + BASE_A + " spec=none -->");
  assert.equal(reasonFor(pr({ marker })), "marker-missing-state");
});

// ---------------------------------------------------------------- drift

test("a new push reopens even a parked PR", () => {
  assert.equal(reasonFor(pr({ headRefOid: HEAD_B })), "head-advanced");
});

test("a base branch that moved under a stacked PR reopens it", () => {
  assert.equal(reasonFor(pr({ baseTipOid: BASE_B })), "base-advanced");
});

test("an unresolvable base tip disables the base check rather than the run", () => {
  assert.equal(reasonFor(pr({ baseTipOid: null })), null);
});

// ---------------------------------------------------------------- states

test("in-progress states are always due", () => {
  for (const state of ["NEEDS_REVIEW", "REVIEWING", "NEEDS_FIX", "FIXING", "NEEDS_VERIFICATION", "WAITING_THREADS", "READY_STACKED", "MERGING", "DISCOVERED"]) {
    assert.equal(reasonFor(pr({ markerFields: { state } })), `state-${state}`, state);
  }
});

test("parked states rest until fresh evidence arrives", () => {
  for (const state of ["READY_ROOT", "BLOCKED", "MERGED"]) {
    assert.equal(reasonFor(pr({ markerFields: { state } })), null, state);
  }
});

test("an unknown state is due, not silently parked", () => {
  assert.equal(reasonFor(pr({ markerFields: { state: "SOMETHING_NEW" } })), "state-unknown-SOMETHING_NEW");
});

test("a draft PR is out of scope", () => {
  assert.equal(reasonFor(pr({ isDraft: true, marker: { found: false } })), null);
});

// ---------------------------------------------------------------- codex clock

test("WAITING_CODEX before its cooldown expires stays idle and reports when it is next due", () => {
  const verdict = evaluate(
    [pr({ markerFields: { state: "WAITING_CODEX", codexNextTriggerAt: "2026-08-29T12:30:00Z" } })],
    NOW,
  );
  assert.equal(verdict.due, false);
  assert.equal(verdict.nextDueAt, "2026-08-29T12:30:00Z");
});

test("WAITING_CODEX past its cooldown is due — the case pure event-watching misses", () => {
  assert.equal(
    reasonFor(pr({ markerFields: { state: "WAITING_CODEX", codexNextTriggerAt: "2026-08-29T11:30:00Z" } })),
    "codex-retry-due",
  );
});

test("WAITING_CODEX with no retry clock is due, never parked", () => {
  assert.equal(reasonFor(pr({ markerFields: { state: "WAITING_CODEX" } })), "codex-retry-clock-missing");
});

// ---------------------------------------------------------------- ci

test("WAITING_CI waits while checks are still running", () => {
  assert.equal(reasonFor(pr({ markerFields: { state: "WAITING_CI" }, ciPending: true })), null);
});

test("WAITING_CI is due once checks settle", () => {
  assert.equal(reasonFor(pr({ markerFields: { state: "WAITING_CI" }, ciPending: false })), "ci-settled");
});

// ---------------------------------------------------------------- aggregate

test("one due PR makes the whole tick due, and every reason is reported", () => {
  const verdict = evaluate(
    [pr(), pr({ number: 525, headRefOid: HEAD_B }), pr({ number: 526, marker: { found: false } })],
    NOW,
  );
  assert.equal(verdict.due, true);
  assert.equal(verdict.considered, 3);
  assert.deepEqual(verdict.reasons.map((r) => r.reason), ["head-advanced", "no-marker"]);
});

test("an empty repository is idle, not an error", () => {
  assert.deepEqual(evaluate([], NOW), { due: false, reasons: [], nextDueAt: null, considered: 0 });
});

// ---------------------------------------------------------------- lock

function tmpLock() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "tick-gate-")), "run.lock");
}

test("a missing lock file is free", () => {
  assert.equal(readLock(tmpLock(), 900, Date.now()).status, "free");
});

test("a lock held by a live process blocks a second run", () => {
  const lockPath = tmpLock();
  const stamp = new Date().toISOString();
  fs.writeFileSync(lockPath, JSON.stringify({ owner: "live", pid: process.pid, startedAt: stamp, heartbeatAt: stamp }));
  assert.equal(readLock(lockPath, 900, Date.now()).status, "held");
});

test("a lock whose owner died is reclaimable, so a crash cannot wedge the timer", () => {
  const lockPath = tmpLock();
  const stamp = new Date().toISOString();
  // PID 2^22 is above the default pid_max and cannot be live.
  fs.writeFileSync(lockPath, JSON.stringify({ owner: "dead", pid: 4194304, startedAt: stamp, heartbeatAt: stamp }));
  const state = readLock(lockPath, 900, Date.now());
  assert.equal(state.status, "stale");
  assert.match(state.why, /pid-4194304-gone/);
});

test("a live process that stopped heartbeating is stale — a hung run is not a held lock", () => {
  const lockPath = tmpLock();
  fs.writeFileSync(
    lockPath,
    JSON.stringify({ owner: "hung", pid: process.pid, startedAt: "2020-01-01T00:00:00Z", heartbeatAt: "2020-01-01T00:00:00Z" }),
  );
  const state = readLock(lockPath, 900, Date.now());
  assert.equal(state.status, "stale");
  assert.match(state.why, /^heartbeat-/);
});

test("an unparseable lock file is stale, never held", () => {
  const lockPath = tmpLock();
  fs.writeFileSync(lockPath, "not json");
  assert.equal(readLock(lockPath, 900, Date.now()).status, "stale");
});
