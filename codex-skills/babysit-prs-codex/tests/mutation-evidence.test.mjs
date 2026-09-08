/**
 * P2-A / P2-B: empirical evidence for test-coverage claims, and probe hygiene.
 *
 * The fixture repo below is a miniature of the real situation: a production
 * module with a guard, plus two tests — one that genuinely exercises the guard
 * and one that passes either way. Reverting the guard must fail the first and
 * pass the second, which is exactly what separates a real coverage gap from a
 * reviewer's hunch.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { checkSourceClean } from "../scripts/check-source-clean.mjs";
import { assertDisposableWorktree, runExperiment, summarizeOutput } from "../scripts/mutation-evidence.mjs";

function sh(cmd, args, cwd) {
  const result = spawnSync(cmd, args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`${cmd} ${args.join(" ")} in ${cwd}: ${result.stderr}`);
  return result.stdout.trim();
}

const BEFORE_FIX = `export function clamp(limit) {
  return limit;
}
`;

const AFTER_FIX = `export function clamp(limit) {
  if (limit > 100) return 100;
  return limit;
}
`;

/** Asserts the clamp actually caps: fails when the guard is reverted. */
const STRONG_TEST = `import assert from "node:assert/strict";
import { clamp } from "./clamp.mjs";
assert.equal(clamp(500), 100);
console.log("1 passed");
`;

/** Only asserts the pass-through case: passes with or without the guard. */
const WEAK_TEST = `import assert from "node:assert/strict";
import { clamp } from "./clamp.mjs";
assert.equal(clamp(5), 5);
console.log("1 passed");
`;

function scaffold(testBody) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "babysit-prs-mutation-"));
  const main = path.join(root, "main");
  fs.mkdirSync(main);

  sh("git", ["init", "-q", "-b", "main"], main);
  sh("git", ["config", "user.email", "test@example.invalid"], main);
  sh("git", ["config", "user.name", "Test"], main);
  sh("git", ["config", "commit.gpgsign", "false"], main);

  // Commit 1: the pre-fix production code.
  fs.writeFileSync(path.join(main, "clamp.mjs"), BEFORE_FIX);
  fs.writeFileSync(path.join(main, "clamp.test.mjs"), testBody);
  sh("git", ["add", "."], main);
  sh("git", ["commit", "-qm", "before fix"], main);
  const beforeOid = sh("git", ["rev-parse", "HEAD"], main);

  // Commit 2: the production fix under review.
  fs.writeFileSync(path.join(main, "clamp.mjs"), AFTER_FIX);
  sh("git", ["add", "."], main);
  sh("git", ["commit", "-qm", "apply the clamp guard"], main);
  const headOid = sh("git", ["rev-parse", "HEAD"], main);

  // The experiment runs in a DISPOSABLE exact-head worktree, never the fix worktree.
  const worktree = path.join(main, ".claude", "worktrees", "mutation-R3");
  sh("git", ["worktree", "add", "-q", "--detach", worktree, headOid], main);

  return { root, main, worktree, beforeOid, headOid };
}

const BASELINE_CMD = "node clamp.test.mjs";

/* -------------------------------------------------------------------------- */

test("baseline passes and the mutation FAILS it => the coverage finding is rebutted", () => {
  const ws = scaffold(STRONG_TEST);

  const artifact = runExperiment({
    worktree: ws.worktree,
    findingId: "R3",
    attemptId: "att-0123456789abcdef01",
    pr: 379,
    baselineCommand: BASELINE_CMD,
    mutationMode: "restore-paths-from-ref",
    mutationRef: ws.beforeOid,
    mutationPaths: ["clamp.mjs"]
  });

  assert.equal(artifact.baseline.exitCode, 0, "the baseline must pass first");
  assert.equal(artifact.mutation.applied, true);
  assert.notEqual(artifact.mutation.exitCode, 0, "reverting the guard must break the strong test");
  assert.equal(artifact.conclusion, "test-detects-regression");

  fs.rmSync(ws.root, { recursive: true, force: true });
});

test("baseline passes and the mutation STILL passes => the coverage gap is confirmed", () => {
  const ws = scaffold(WEAK_TEST);

  const artifact = runExperiment({
    worktree: ws.worktree,
    findingId: "R3",
    attemptId: "att-0123456789abcdef01",
    baselineCommand: BASELINE_CMD,
    mutationMode: "restore-paths-from-ref",
    mutationRef: ws.beforeOid,
    mutationPaths: ["clamp.mjs"]
  });

  assert.equal(artifact.baseline.exitCode, 0);
  assert.equal(artifact.mutation.exitCode, 0, "the weak test cannot tell the difference");
  assert.equal(artifact.conclusion, "test-does-not-detect-regression");

  // The artifact records commands, exit statuses, and concise output hashes.
  assert.match(artifact.baseline.command, /node clamp\.test\.mjs/);
  assert.match(artifact.baseline.outputSha256, /^[0-9a-f]{64}$/);
  assert.match(artifact.mutation.outputSha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(artifact.safety.mutationScopePaths, ["clamp.mjs"]);

  fs.rmSync(ws.root, { recursive: true, force: true });
});

test("cleanup is proved: porcelain empty, HEAD unchanged, tree matches HEAD", () => {
  const ws = scaffold(WEAK_TEST);

  const artifact = runExperiment({
    worktree: ws.worktree,
    findingId: "R3",
    attemptId: "att-0123456789abcdef01",
    baselineCommand: BASELINE_CMD,
    mutationMode: "restore-paths-from-ref",
    mutationRef: ws.beforeOid,
    mutationPaths: ["clamp.mjs"]
  });

  assert.equal(artifact.cleanup.clean, true);
  assert.equal(artifact.cleanup.headOid, ws.headOid);
  assert.equal(artifact.cleanup.treeMatchesHead, true);
  assert.equal(artifact.cleanup.porcelain, null);
  assert.equal(artifact.cleanup.residualRisk, null);

  // Independently confirmed by the source-cleanliness checker.
  const check = checkSourceClean(ws.worktree, { expectedHead: ws.headOid });
  assert.equal(check.ok, true);
  assert.deepEqual(check.entries, []);
  assert.equal(fs.readFileSync(path.join(ws.worktree, "clamp.mjs"), "utf8"), AFTER_FIX);

  fs.rmSync(ws.root, { recursive: true, force: true });
});

test("a mutation that cannot be isolated leaves the claim unconfirmed rather than blocking", () => {
  const ws = scaffold(WEAK_TEST);

  // The named path is identical at that ref, so the experiment cannot discriminate.
  const artifact = runExperiment({
    worktree: ws.worktree,
    findingId: "R3",
    attemptId: "att-0123456789abcdef01",
    baselineCommand: BASELINE_CMD,
    mutationMode: "restore-paths-from-ref",
    mutationRef: ws.headOid,
    mutationPaths: ["clamp.mjs"]
  });

  assert.equal(artifact.conclusion, "inconclusive");
  assert.equal(artifact.mutation.applied, false);
  assert.match(artifact.inconclusiveReason, /cannot discriminate|could not be applied/);
  assert.equal(artifact.cleanup.clean, true, "an aborted experiment still cleans up");

  fs.rmSync(ws.root, { recursive: true, force: true });
});

test("a failing baseline is inconclusive: a coverage claim needs a passing baseline", () => {
  const ws = scaffold(STRONG_TEST);
  // Break the baseline before the experiment starts.
  sh("git", ["checkout", "-q", ws.beforeOid, "--", "clamp.mjs"], ws.worktree);
  sh("git", ["stash", "-q", "-u"], ws.worktree);

  const artifact = runExperiment({
    worktree: ws.worktree,
    findingId: "R3",
    attemptId: "att-0123456789abcdef01",
    baselineCommand: "node -e 'process.exit(1)'",
    mutationMode: "restore-paths-from-ref",
    mutationRef: ws.beforeOid,
    mutationPaths: ["clamp.mjs"]
  });

  assert.equal(artifact.conclusion, "inconclusive");
  assert.match(artifact.inconclusiveReason, /baseline-test-did-not-pass/);
  assert.equal(artifact.mutation.applied, false, "no mutation runs against a red baseline");

  fs.rmSync(ws.root, { recursive: true, force: true });
});

test("the main checkout is refused as a mutation target", () => {
  const ws = scaffold(WEAK_TEST);

  assert.throws(() => assertDisposableWorktree(ws.main), /main checkout, not a disposable worktree/);
  assert.throws(
    () =>
      runExperiment({
        worktree: ws.main,
        findingId: "R3",
        attemptId: "att-0123456789abcdef01",
        baselineCommand: BASELINE_CMD,
        mutationMode: "restore-paths-from-ref",
        mutationRef: ws.beforeOid,
        mutationPaths: ["clamp.mjs"]
      }),
    /main checkout/
  );

  // A linked worktree is accepted.
  assert.equal(assertDisposableWorktree(ws.worktree).isMainCheckout, false);

  fs.rmSync(ws.root, { recursive: true, force: true });
});

test("a dirty worktree is refused before any baseline runs", () => {
  const ws = scaffold(WEAK_TEST);
  fs.writeFileSync(path.join(ws.worktree, "clamp.mjs"), "// tampered\n");

  const artifact = runExperiment({
    worktree: ws.worktree,
    findingId: "R3",
    attemptId: "att-0123456789abcdef01",
    baselineCommand: BASELINE_CMD,
    mutationMode: "restore-paths-from-ref",
    mutationRef: ws.beforeOid,
    mutationPaths: ["clamp.mjs"]
  });

  assert.equal(artifact.conclusion, "inconclusive");
  assert.match(artifact.inconclusiveReason, /worktree-dirty-before-baseline/);
  assert.equal(artifact.baseline.exitCode, null);

  fs.rmSync(ws.root, { recursive: true, force: true });
});

/* ------------------------------ probe hygiene ----------------------------- */

test("probe scripts belong under TMPDIR, and residue in the repo is detected", () => {
  const ws = scaffold(WEAK_TEST);

  // The sanctioned pattern: mktemp -d under TMPDIR, cleaned by a trap.
  const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), "babysit-prs-probe."));
  fs.writeFileSync(path.join(probeDir, "probe_runs.py"), "print('scratch')\n");

  assert.ok(probeDir.startsWith(os.tmpdir()), "the probe dir must live under TMPDIR");
  assert.ok(!probeDir.startsWith(ws.main), "never inside the repository");
  assert.equal(checkSourceClean(ws.worktree).ok, true, "a TMPDIR probe leaves the checkout clean");

  // The failure mode this guards against: the same probe written into the repo.
  fs.writeFileSync(path.join(ws.worktree, "probe_runs.py"), "print('scratch')\n");
  const dirty = checkSourceClean(ws.worktree);
  assert.equal(dirty.ok, false);
  assert.equal(dirty.reason, "probe-residue-in-repository");
  assert.deepEqual(dirty.probeResidue, ["probe_runs.py"]);

  fs.rmSync(probeDir, { recursive: true, force: true });
  fs.rmSync(ws.root, { recursive: true, force: true });
});

test("a leftover source modification is detected and reported", () => {
  const ws = scaffold(WEAK_TEST);
  fs.writeFileSync(path.join(ws.worktree, "clamp.mjs"), "// half-reverted\n");

  const report = checkSourceClean(ws.worktree, { expectedHead: ws.headOid });
  assert.equal(report.ok, false);
  assert.equal(report.reason, "unexpected-working-tree-changes");
  assert.equal(report.entries.length, 1);
  assert.equal(report.entries[0].pathname, "clamp.mjs");
  assert.equal(report.headMatches, true, "HEAD is fine; it is the tree that is dirty");

  fs.rmSync(ws.root, { recursive: true, force: true });
});

test("a moved HEAD is reported distinctly from a dirty tree", () => {
  const ws = scaffold(WEAK_TEST);
  const report = checkSourceClean(ws.worktree, { expectedHead: ws.beforeOid });
  assert.equal(report.ok, false);
  assert.equal(report.reason, "head-moved");
  assert.equal(report.headMatches, false);
  assert.deepEqual(report.entries, []);
  fs.rmSync(ws.root, { recursive: true, force: true });
});

test("output summaries stay short and never carry full logs", () => {
  const noisy = Array.from({ length: 500 }, (_, i) => `line ${i}`).join("\n");
  const summary = summarizeOutput(noisy);
  assert.ok(summary.length <= 400);
  assert.match(summary, /line 499/);
  assert.ok(!summary.includes("line 0\n"));
  assert.equal(summarizeOutput(""), "(no output)");
});
