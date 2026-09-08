import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { findActiveRun, listProcessCwds } from "../lib/busy.mjs";

const GATE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "tick-gate.mjs");
const WINDOW_MS = 30 * 60 * 1000;

function checkout() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "babysit-busy-"));
  fs.mkdirSync(path.join(root, ".claude", "babysit-prs", "runs"), { recursive: true });
  fs.mkdirSync(path.join(root, ".claude", "worktrees"), { recursive: true });
  return root;
}

function writeRunFile(root, runId, rel, ageMs = 0) {
  const file = path.join(root, ".claude", "babysit-prs", "runs", runId, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "{}\n");
  if (ageMs > 0) {
    const then = new Date(Date.now() - ageMs);
    // Directories get their mtime from entry creation, so age them too or the
    // walk would trust the directory and never look at the file.
    let dir = path.dirname(file);
    fs.utimesSync(file, then, then);
    while (dir.length >= root.length) {
      fs.utimesSync(dir, then, then);
      dir = path.dirname(dir);
    }
  }
  return file;
}

function probe(root, overrides = {}) {
  return findActiveRun({ checkout: root, now: Date.now(), windowMs: WINDOW_MS, procCwds: [], ...overrides });
}

// ---------------------------------------------------------------- run dir

test("an empty checkout has no active run", () => {
  const root = checkout();
  assert.deepEqual(probe(root).busy, false);
});

test("a run directory written inside the window means a session is active", () => {
  const root = checkout();
  writeRunFile(root, "sess-1", "pr-538/snapshot.json");
  const verdict = probe(root);
  assert.equal(verdict.busy, true);
  assert.match(verdict.reason, /^run-dir-written:sess-1:/);
});

test("a run directory older than the window does not count", () => {
  const root = checkout();
  writeRunFile(root, "sess-old", "pr-1/snapshot.json", 2 * WINDOW_MS);
  assert.equal(probe(root).busy, false);
});

test("a fresh file deep inside an old run directory still counts", () => {
  const root = checkout();
  writeRunFile(root, "sess-2", "pr-1/attempts/att-1/launch.json", 2 * WINDOW_MS);
  writeRunFile(root, "sess-2", "pr-1/attempts/att-9/collect.json");
  // Re-age the parents so only the leaf is fresh; the walk must not trust
  // directory mtimes.
  const then = new Date(Date.now() - 2 * WINDOW_MS);
  for (const rel of ["", "pr-1", "pr-1/attempts", "pr-1/attempts/att-9"]) {
    fs.utimesSync(path.join(root, ".claude", "babysit-prs", "runs", "sess-2", rel), then, then);
  }
  assert.equal(probe(root).busy, true);
});

test("a missing runs directory is not an error, just not busy", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "babysit-busy-bare-"));
  assert.equal(probe(root).busy, false);
});

// ---------------------------------------------------------------- processes

test("a process whose cwd is under the checkout's worktrees means work is in flight", () => {
  const root = checkout();
  const cwd = path.join(root, ".claude", "worktrees", "rv538-abc");
  const verdict = probe(root, { procCwds: [{ pid: 4242, cwd, comm: "codex" }] });
  assert.equal(verdict.busy, true);
  assert.equal(verdict.reason, "process-in-worktree:4242:codex:rv538-abc");
});

test("a process elsewhere is ignored", () => {
  const root = checkout();
  const verdict = probe(root, { procCwds: [{ pid: 1, cwd: "/tmp/elsewhere", comm: "node" }] });
  assert.equal(verdict.busy, false);
});

test("a sibling directory that merely shares the prefix is not a worktree", () => {
  const root = checkout();
  const verdict = probe(root, {
    procCwds: [{ pid: 7, cwd: `${path.join(root, ".claude", "worktrees")}-other/x`, comm: "node" }],
  });
  assert.equal(verdict.busy, false);
});

// The signal has to be proven to exist, not assumed: spawn a real process in a
// worktree directory and make the real /proc scan find it, then lose it.
test("the live process scan finds a real process in a worktree and forgets it once it exits", { skip: process.platform !== "linux" && "reads /proc" }, async () => {
  const root = checkout();
  const cwd = path.join(root, ".claude", "worktrees", "rvlive-xyz");
  fs.mkdirSync(cwd);
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 20000)"], { cwd, stdio: "ignore" });
  try {
    await new Promise((resolve) => setTimeout(resolve, 200));
    const seen = listProcessCwds().filter((p) => p.pid === child.pid);
    assert.equal(seen.length, 1, "the child must be visible in /proc");
    assert.equal(seen[0].cwd, cwd);
    const busy = findActiveRun({ checkout: root, now: Date.now(), windowMs: WINDOW_MS, procCwds: listProcessCwds() });
    assert.equal(busy.busy, true);
    assert.equal(busy.reason, `process-in-worktree:${child.pid}:node:rvlive-xyz`);
  } finally {
    child.kill("SIGKILL");
  }
  await new Promise((resolve) => child.on("exit", resolve));
  const after = findActiveRun({ checkout: root, now: Date.now(), windowMs: WINDOW_MS, procCwds: listProcessCwds() });
  assert.equal(after.busy, false);
});

// ---------------------------------------------------------------- cli

function runGate(args) {
  try {
    const stdout = execFileSync(process.execPath, [GATE, ...args], { encoding: "utf8" });
    return { code: 0, stdout };
  } catch (error) {
    return { code: error.status, stdout: error.stdout ?? "" };
  }
}

function fixture(root) {
  const file = path.join(root, "prs.json");
  fs.writeFileSync(file, JSON.stringify([{ number: 1, isDraft: false, headRefOid: "x", baseTipOid: null, ciPending: false, marker: { found: false } }]));
  return file;
}

test("due exits 13 and says BUSY before touching GitHub when a run is active", () => {
  const root = checkout();
  writeRunFile(root, "sess-3", "pr-1/snapshot.json");
  const result = runGate(["due", "--input", fixture(root), "--checkout", root]);
  assert.equal(result.code, 13);
  assert.match(result.stdout, /^BUSY run-dir-written:sess-3:/);
});

test("due still reports DUE when the checkout is quiet", () => {
  const root = checkout();
  const result = runGate(["due", "--input", fixture(root), "--checkout", root]);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /^DUE #1:no-marker/);
});

test("due --json carries the busy verdict", () => {
  const root = checkout();
  writeRunFile(root, "sess-4", "pr-1/snapshot.json");
  const result = runGate(["due", "--input", fixture(root), "--checkout", root, "--json"]);
  assert.equal(result.code, 13);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.busy, true);
  assert.match(parsed.reason, /^run-dir-written:sess-4:/);
});
