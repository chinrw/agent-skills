import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { canonicalHash, readJson } from "../scripts/lib/json-io.mjs";
import {
  JOB_STATES,
  classify,
  collect,
  inspectLaunchCwd,
  launch,
  lifecycle,
  readReceipt,
  recoverScan
} from "../scripts/codex-job.mjs";
import { probe } from "../scripts/probe-codex-capabilities.mjs";
import { SENTINEL } from "../scripts/parse-codex-artifact.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE_COMPANION = path.join(HERE, "fake-companion.mjs");
const COMPANIONS = path.join(HERE, "fixtures", "companions");

const HEAD = "e363a839522e4960d372ce42125cce05c6a64e82";
const BASE = "7f1bc449f10686a1d013121c81c2c44e65a9637f";
const KEY = "90eb74228b4dd711956acd443b74c215d2212192b8ddabc57e499037e8ab0681";

function sh(cmd, args, cwd) {
  const result = spawnSync(cmd, args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} failed in ${cwd}: ${result.stderr}`);
  }
  return result.stdout.trim();
}

/**
 * A real main checkout plus a real linked worktree. The workspace-scoping bug
 * only reproduces against genuine git plumbing, so we do not fake it.
 */
function scaffold() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "babysit-prs-jobs-"));
  const main = path.join(root, "main");
  fs.mkdirSync(main);

  sh("git", ["init", "-q", "-b", "main"], main);
  sh("git", ["config", "user.email", "test@example.invalid"], main);
  sh("git", ["config", "user.name", "Test"], main);
  // The host may sign commits globally; a throwaway fixture must not need an agent.
  sh("git", ["config", "commit.gpgsign", "false"], main);
  sh("git", ["config", "tag.gpgsign", "false"], main);
  fs.writeFileSync(path.join(main, "README.md"), "seed\n");
  sh("git", ["add", "."], main);
  sh("git", ["commit", "-qm", "seed"], main);

  const worktree = path.join(main, ".claude", "worktrees", "pr379-read");
  sh("git", ["worktree", "add", "-q", "--detach", worktree, "HEAD"], main);

  const state = path.join(root, "codex-state");
  const runDir = path.join(root, "run", "pr-379");
  fs.mkdirSync(state, { recursive: true });
  fs.mkdirSync(runDir, { recursive: true });

  const capabilities = probe({ companionPath: path.join(COMPANIONS, "no-max.mjs"), includeCodexVersion: false });
  const capabilitiesPath = path.join(runDir, "codex-capabilities.json");
  fs.writeFileSync(capabilitiesPath, JSON.stringify(capabilities, null, 2));

  return { root, main, worktree, state, runDir, capabilitiesPath };
}

function artifact(overrides = {}) {
  return {
    schemaVersion: 1,
    taskType: "review",
    attemptId: "att-0123456789abcdef01",
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

function writeOutputFixture(dir, body) {
  const file = path.join(dir, "codex-output.txt");
  fs.writeFileSync(file, body);
  return file;
}

function sentinelStdout(value) {
  return `Review complete.\n\n${SENTINEL}\n\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\`\n`;
}

/**
 * Run `fn` with the fake companion's environment applied, then restore. The
 * fake companion reads its state root from the environment, so launch AND every
 * later lifecycle call must see the same values.
 */
function withFakeEnv(env, fn) {
  const previous = { ...process.env };
  Object.assign(process.env, env);
  try {
    return fn();
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in previous)) delete process.env[key];
    }
    Object.assign(process.env, previous);
  }
}

function launchFromWorktree(env, opts = {}) {
  return withFakeEnv(env, () =>
    launch({
      taskType: "review",
      prompt: "review the exact diff",
      requestedEffort: "max",
      requestedModel: "gpt-5.6-sol",
      attemptId: "att-0123456789abcdef01",
      pr: 379,
      headOid: HEAD,
      baseOid: BASE,
      reviewKey: KEY,
      write: false,
      ...opts
    })
  );
}

/* ------------------------- launch cwd + receipt --------------------------- */

test("a job launched from a worktree is found when polled using its launch receipt", () => {
  const ws = scaffold();
  const receiptPath = path.join(ws.runDir, "launch-receipt.json");
  const outputFile = writeOutputFixture(ws.runDir, sentinelStdout(artifact()));

  const { receipt } = launchFromWorktree(
    { FAKE_CODEX_STATE: ws.state, FAKE_CODEX_OUTPUT: outputFile },
    {
      launchCwd: ws.worktree,
      receiptPath,
      capabilitiesPath: ws.capabilitiesPath,
      companionPath: FAKE_COMPANION,
      canonicalArtifactPath: path.join(ws.runDir, "codex-review.json")
    }
  );

  assert.ok(receipt.taskId, "the companion returned a task id");
  assert.equal(receipt.launchStatus, "launched");
  assert.equal(path.resolve(receipt.launchCwd), fs.realpathSync(ws.worktree));

  // The receipt records both requested and effective effort, with the reason.
  assert.equal(receipt.requestedEffort, "max");
  assert.equal(receipt.effectiveEffort, "xhigh");
  assert.equal(receipt.effortDowngradeReason, "companion-ceiling");

  // A read-only task is labelled as such and given no staging path.
  assert.equal(receipt.sourceMutationPolicy, "forbidden");
  assert.equal(receipt.writeMode, false);
  assert.equal(receipt.stagingArtifactPath, null);

  const status = withFakeEnv({ FAKE_CODEX_STATE: ws.state }, () =>
    lifecycle(readReceipt(receiptPath), "status", { companionPath: FAKE_COMPANION })
  );
  assert.equal(status.state, null, "polling from the launch cwd must succeed");
  assert.equal(classify(status.job).state, JOB_STATES.SUCCESS);

  fs.rmSync(ws.root, { recursive: true, force: true });
});

test("the receipt is written BEFORE the task runs, so a crash still leaves a trail", () => {
  const ws = scaffold();
  const receiptPath = path.join(ws.runDir, "launch-receipt.json");

  const { receipt } = launchFromWorktree(
    { FAKE_CODEX_STATE: ws.state },
    {
      launchCwd: ws.worktree,
      receiptPath,
      capabilitiesPath: ws.capabilitiesPath,
      companionPath: FAKE_COMPANION,
      dryRun: true // stops after the pre-launch receipt
    }
  );

  assert.equal(receipt.launchStatus, "pre-launch");
  assert.ok(fs.existsSync(receiptPath), "a pre-launch receipt exists on disk");
  const onDisk = readReceipt(receiptPath);
  assert.equal(onDisk.taskId, null);
  assert.equal(path.resolve(onDisk.launchCwd), fs.realpathSync(ws.worktree));
  assert.ok(onDisk.repoRoot);

  // The prompt itself is never persisted into the receipt's command record.
  assert.ok(!onDisk.command.includes("review the exact diff"));
  assert.ok(onDisk.command.includes("<prompt>"));

  fs.rmSync(ws.root, { recursive: true, force: true });
});

/* ------------------------ the actual reported bug ------------------------- */

test("the SAME job queried from the main checkout reports no job -- a context error, not a crash", () => {
  const ws = scaffold();
  const receiptPath = path.join(ws.runDir, "launch-receipt.json");
  const outputFile = writeOutputFixture(ws.runDir, sentinelStdout(artifact()));

  const { receipt } = launchFromWorktree(
    { FAKE_CODEX_STATE: ws.state, FAKE_CODEX_OUTPUT: outputFile },
    {
      launchCwd: ws.worktree,
      receiptPath,
      capabilitiesPath: ws.capabilitiesPath,
      companionPath: FAKE_COMPANION
    }
  );

  // Reproduce the wrong-cwd poll the old contract performed: ask the main
  // checkout about a job that lives in the worktree's store.
  const wrongCwd = spawnSync(
    process.execPath,
    [FAKE_COMPANION, "status", receipt.taskId, "--cwd", ws.main, "--json"],
    { cwd: ws.main, encoding: "utf8", env: { ...process.env, FAKE_CODEX_STATE: ws.state } }
  );
  assert.notEqual(wrongCwd.status, 0);
  assert.match(wrongCwd.stderr, /No job found for/);

  // The wrapper never does that: it replays the receipt's launchCwd and finds it.
  const right = withFakeEnv({ FAKE_CODEX_STATE: ws.state }, () =>
    lifecycle(readReceipt(receiptPath), "status", { companionPath: FAKE_COMPANION })
  );
  assert.equal(right.state, null);
  assert.equal(classify(right.job).state, JOB_STATES.SUCCESS);
  assert.equal(path.resolve(right.pollingCwd), fs.realpathSync(ws.worktree));

  fs.rmSync(ws.root, { recursive: true, force: true });
});

test("a deleted launch worktree is diagnosed explicitly as a polling-context error", () => {
  const ws = scaffold();
  const receiptPath = path.join(ws.runDir, "launch-receipt.json");

  launchFromWorktree(
    { FAKE_CODEX_STATE: ws.state },
    {
      launchCwd: ws.worktree,
      receiptPath,
      capabilitiesPath: ws.capabilitiesPath,
      companionPath: FAKE_COMPANION
    }
  );

  fs.rmSync(ws.worktree, { recursive: true, force: true });

  const result = lifecycle(readReceipt(receiptPath), "status", { companionPath: FAKE_COMPANION });
  assert.equal(result.state, JOB_STATES.POLLING_CONTEXT_ERROR);
  assert.equal(result.reason, "launch-cwd-missing");
  assert.notEqual(result.state, JOB_STATES.JOB_RECORD_MISSING, "a missing worktree is not a missing job");

  fs.rmSync(ws.root, { recursive: true, force: true });
});

test("a launch cwd that now belongs to a different repository is a polling-context error", () => {
  const ws = scaffold();
  const other = scaffold();
  const receiptPath = path.join(ws.runDir, "launch-receipt.json");

  launchFromWorktree(
    { FAKE_CODEX_STATE: ws.state },
    {
      launchCwd: ws.worktree,
      receiptPath,
      capabilitiesPath: ws.capabilitiesPath,
      companionPath: FAKE_COMPANION
    }
  );

  const receipt = readReceipt(receiptPath);
  const swapped = { ...receipt, repoRoot: other.main };
  const result = lifecycle(swapped, "status", { companionPath: FAKE_COMPANION });

  assert.equal(result.state, JOB_STATES.POLLING_CONTEXT_ERROR);
  assert.equal(result.reason, "launch-cwd-belongs-to-a-different-repository");

  fs.rmSync(ws.root, { recursive: true, force: true });
  fs.rmSync(other.root, { recursive: true, force: true });
});

test("the recorded launch workspace genuinely lacking the job is JOB_RECORD_MISSING", () => {
  const ws = scaffold();
  const receiptPath = path.join(ws.runDir, "launch-receipt.json");

  launchFromWorktree(
    { FAKE_CODEX_STATE: ws.state },
    {
      launchCwd: ws.worktree,
      receiptPath,
      capabilitiesPath: ws.capabilitiesPath,
      companionPath: FAKE_COMPANION
    }
  );

  // Wipe the store the worktree's job lived in.
  fs.rmSync(ws.state, { recursive: true, force: true });
  fs.mkdirSync(ws.state, { recursive: true });

  const previous = process.env.FAKE_CODEX_STATE;
  process.env.FAKE_CODEX_STATE = ws.state;
  try {
    const result = lifecycle(readReceipt(receiptPath), "status", { companionPath: FAKE_COMPANION });
    assert.equal(result.state, JOB_STATES.JOB_RECORD_MISSING);
    assert.match(result.reason, /recorded-launch-workspace/);
  } finally {
    if (previous === undefined) delete process.env.FAKE_CODEX_STATE;
    else process.env.FAKE_CODEX_STATE = previous;
  }

  fs.rmSync(ws.root, { recursive: true, force: true });
});

test("result and cancel also use the recorded launch context", () => {
  const ws = scaffold();
  const receiptPath = path.join(ws.runDir, "launch-receipt.json");
  const outputFile = writeOutputFixture(ws.runDir, sentinelStdout(artifact()));

  launchFromWorktree(
    { FAKE_CODEX_STATE: ws.state, FAKE_CODEX_OUTPUT: outputFile },
    {
      launchCwd: ws.worktree,
      receiptPath,
      capabilitiesPath: ws.capabilitiesPath,
      companionPath: FAKE_COMPANION
    }
  );

  const previous = process.env.FAKE_CODEX_STATE;
  process.env.FAKE_CODEX_STATE = ws.state;
  try {
    const receipt = readReceipt(receiptPath);

    const resultRun = lifecycle(receipt, "result", { companionPath: FAKE_COMPANION });
    assert.equal(resultRun.state, null);
    assert.equal(path.resolve(resultRun.pollingCwd), fs.realpathSync(ws.worktree));
    assert.match(resultRun.storedJob.output, new RegExp(SENTINEL));

    const cancelRun = lifecycle(receipt, "cancel", { companionPath: FAKE_COMPANION });
    assert.equal(cancelRun.state, null);
    assert.equal(path.resolve(cancelRun.pollingCwd), fs.realpathSync(ws.worktree));
  } finally {
    if (previous === undefined) delete process.env.FAKE_CODEX_STATE;
    else process.env.FAKE_CODEX_STATE = previous;
  }

  fs.rmSync(ws.root, { recursive: true, force: true });
});

test("global state-directory scanning is an explicit recovery path, not a polling path", () => {
  const ws = scaffold();
  const receiptPath = path.join(ws.runDir, "launch-receipt.json");

  const { receipt } = launchFromWorktree(
    { FAKE_CODEX_STATE: ws.state },
    {
      launchCwd: ws.worktree,
      receiptPath,
      capabilitiesPath: ws.capabilitiesPath,
      companionPath: FAKE_COMPANION
    }
  );

  // Normal polling never touches the scanner; it must be called by name.
  const scan = recoverScan(receipt.taskId, { stateRoots: [ws.state] });
  assert.equal(scan.hits.length, 1);
  assert.equal(scan.truncated, false);
  assert.ok(scan.hits[0].jobFile.endsWith(`${receipt.taskId}.json`));

  // The scan is bounded.
  const bounded = recoverScan(receipt.taskId, { stateRoots: [ws.state], maxDirs: 0 });
  assert.equal(bounded.truncated, true);
  assert.equal(bounded.hits.length, 0);

  fs.rmSync(ws.root, { recursive: true, force: true });
});

/* -------------------------- terminal classification ----------------------- */

test("a running job with a dead pid is stale, not live", () => {
  const job = { status: "running", pid: 2 ** 30, updatedAt: new Date().toISOString() };
  assert.equal(classify(job).state, JOB_STATES.JOB_STALE_PID);
});

test("a running job with no recent activity is stalled", () => {
  const job = {
    status: "running",
    pid: process.pid,
    updatedAt: new Date(Date.now() - 3600 * 1000).toISOString()
  };
  assert.equal(classify(job, { stallSeconds: 600 }).state, JOB_STATES.JOB_STALLED);
  assert.equal(classify(job, { stallSeconds: 7200 }).state, JOB_STATES.RUNNING);
});

test("terminal statuses map to distinct states, never collapsed into \"Codex failed\"", () => {
  assert.equal(classify({ status: "completed" }).state, JOB_STATES.SUCCESS);
  assert.equal(classify({ status: "failed" }).state, JOB_STATES.FAILED);
  assert.equal(classify({ status: "cancelled" }).state, JOB_STATES.CANCELLED);
  assert.equal(classify(null).state, JOB_STATES.JOB_RECORD_MISSING);

  const distinct = new Set([
    JOB_STATES.POLLING_CONTEXT_ERROR,
    JOB_STATES.JOB_RECORD_MISSING,
    JOB_STATES.JOB_STALE_PID,
    JOB_STATES.JOB_STALLED,
    JOB_STATES.FAILED
  ]);
  assert.equal(distinct.size, 5, "the five diagnoses stay separate");
});

/* ------------------------------ safety rails ------------------------------ */

test("a read-only task may not be assigned a staging artifact path", () => {
  const ws = scaffold();
  assert.throws(
    () =>
      launchFromWorktree(
        { FAKE_CODEX_STATE: ws.state },
        {
          launchCwd: ws.worktree,
          receiptPath: path.join(ws.runDir, "r.json"),
          capabilitiesPath: ws.capabilitiesPath,
          companionPath: FAKE_COMPANION,
          write: false,
          stagingArtifactPath: "codex-review.json",
          dryRun: true
        }
      ),
    /read-only task may not be assigned a staging artifact path/
  );
  fs.rmSync(ws.root, { recursive: true, force: true });
});

test("launching from a non-repository or missing directory is refused up front", () => {
  const ws = scaffold();
  const notRepo = path.join(ws.root, "plain");
  fs.mkdirSync(notRepo);

  assert.equal(inspectLaunchCwd(notRepo).reason, "launch-cwd-not-a-git-repository");
  assert.equal(inspectLaunchCwd(path.join(ws.root, "nope")).reason, "launch-cwd-missing");

  fs.rmSync(ws.root, { recursive: true, force: true });
});

test("an ambiguous capability probe blocks the launch instead of guessing an effort", () => {
  const ws = scaffold();
  const ambiguous = probe({ companionPath: path.join(COMPANIONS, "disagree.mjs"), includeCodexVersion: false });
  const capPath = path.join(ws.runDir, "ambiguous-capabilities.json");
  fs.writeFileSync(capPath, JSON.stringify(ambiguous, null, 2));

  assert.throws(
    () =>
      launchFromWorktree(
        { FAKE_CODEX_STATE: ws.state },
        {
          launchCwd: ws.worktree,
          receiptPath: path.join(ws.runDir, "r.json"),
          capabilitiesPath: capPath,
          companionPath: FAKE_COMPANION,
          dryRun: true
        }
      ),
    /remote writes are blocked/
  );

  fs.rmSync(ws.root, { recursive: true, force: true });
});

/* ------------------------- end-to-end collect ----------------------------- */

test("collect: a worktree-launched review is polled, reconciled, and persisted canonically", () => {
  const ws = scaffold();
  const receiptPath = path.join(ws.runDir, "launch-receipt.json");
  const canonical = path.join(ws.runDir, "codex-review.json");
  const value = artifact({
    findings: [
      {
        id: "R1",
        severity: "blocking",
        file: "src/api/runs.py",
        line: 88,
        claim: "The listing endpoint drops the LIMIT clause when a cursor is supplied.",
        evidence: "build_query() branches on cursor and returns the unbounded SELECT.",
        headOid: HEAD,
        baseOid: BASE,
        reviewKey: KEY
      }
    ]
  });
  const outputFile = writeOutputFixture(ws.runDir, sentinelStdout(value));

  launchFromWorktree(
    { FAKE_CODEX_STATE: ws.state, FAKE_CODEX_OUTPUT: outputFile },
    {
      launchCwd: ws.worktree,
      receiptPath,
      capabilitiesPath: ws.capabilitiesPath,
      companionPath: FAKE_COMPANION,
      canonicalArtifactPath: canonical
    }
  );

  const previous = process.env.FAKE_CODEX_STATE;
  process.env.FAKE_CODEX_STATE = ws.state;
  try {
    const outcome = collect(readReceipt(receiptPath), { canonicalArtifact: canonical });

    assert.equal(outcome.jobState, JOB_STATES.SUCCESS);
    assert.equal(outcome.accepted, true);
    assert.equal(outcome.rerunRequired, false);
    assert.equal(outcome.reconciliation.transport, "stdout-only");
    assert.equal(readJson(canonical).findings.length, 1);
    assert.equal(outcome.reconciliation.canonicalSha256, canonicalHash(value));

    // The handoff carries artifact identity and hash, never raw findings.
    assert.match(outcome.handoff, /effort=max->xhigh/);
    assert.match(outcome.handoff, /transport=stdout-only/);
    assert.match(outcome.handoff, new RegExp(`artifactSha256=${canonicalHash(value)}`));
    assert.ok(!outcome.handoff.includes("LIMIT clause"), "no finding prose in the handoff");
  } finally {
    if (previous === undefined) delete process.env.FAKE_CODEX_STATE;
    else process.env.FAKE_CODEX_STATE = previous;
  }

  fs.rmSync(ws.root, { recursive: true, force: true });
});
