#!/usr/bin/env node
/**
 * The single Codex task wrapper for /babysit-prs.
 *
 * Responsibilities, all in one place so no prompt has to re-implement them:
 *   - capability normalization (requested effort -> effective effort, preflight)
 *   - launch cwd validation
 *   - launch receipt creation, written BEFORE polling begins
 *   - status / result / cancel / resume in the SAME workspace context
 *   - terminal-state classification
 *   - stdout sentinel extraction + optional staging reconciliation
 *   - canonical artifact persistence
 *   - compact machine-readable handoff
 *
 * ---------------------------------------------------------------------------
 * Why the launch receipt exists
 * ---------------------------------------------------------------------------
 * The companion's job store is workspace-scoped:
 *
 *     resolveStateDir(cwd) -> <stateRoot>/<basename(root)>-<sha256(realpath(root))[0:16]>
 *     resolveWorkspaceRoot(cwd) -> git rev-parse --show-toplevel
 *
 * For a linked worktree, `--show-toplevel` is the WORKTREE, not the main
 * checkout. A task launched from `.claude/worktrees/pr379-read` therefore lands
 * in a different job store than the controller's, and querying it from the main
 * checkout raises:
 *
 *     No job found for "task-...". Run /codex:status to inspect known jobs.
 *
 * That message means "you asked the wrong workspace", NOT "the job crashed".
 * Conflating the two is how a healthy review gets declared dead. Every
 * lifecycle call here replays the recorded `launchCwd`.
 */

import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { readJson, readJsonIfExists, writeJsonAtomic } from "./lib/json-io.mjs";
import { assertValid } from "./lib/schema.mjs";
import { runCli } from "./lib/cli.mjs";
import {
  discoverCompanionPath,
  loadCapabilities,
  normalizeEffort
} from "./probe-codex-capabilities.mjs";
import { reconcile } from "./reconcile-codex-artifacts.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RECEIPT_SCHEMA_PATH = path.join(HERE, "..", "schemas", "codex-launch-receipt-v1.schema.json");

const NO_JOB_RE = /No job found for/i;
const DEFAULT_STALL_SECONDS = 600;

export const JOB_STATES = {
  RUNNING: "RUNNING",
  SUCCESS: "SUCCESS",
  FAILED: "FAILED",
  CANCELLED: "CANCELLED",
  POLLING_CONTEXT_ERROR: "POLLING_CONTEXT_ERROR",
  JOB_RECORD_MISSING: "JOB_RECORD_MISSING",
  JOB_STALE_PID: "JOB_STALE_PID",
  JOB_STALLED: "JOB_STALLED"
};

export class CodexJobError extends Error {}

/* ------------------------------ receipts -------------------------------- */

export function newAttemptId(prefix = "att") {
  return `${prefix}-${crypto.randomBytes(9).toString("hex")}`;
}

function receiptSchema() {
  return readJson(RECEIPT_SCHEMA_PATH);
}

export function writeReceipt(receiptPath, receipt) {
  assertValid(receiptSchema(), receipt, "launch receipt");
  writeJsonAtomic(receiptPath, receipt);
  return receipt;
}

export function readReceipt(receiptPath) {
  const receipt = readJson(receiptPath);
  assertValid(receiptSchema(), receipt, "launch receipt");
  return receipt;
}

/* --------------------------- git / cwd checks ---------------------------- */

function git(cwd, args) {
  return spawnSync("git", args, { cwd, encoding: "utf8", timeout: 30000 });
}

export function inspectLaunchCwd(launchCwd) {
  const resolved = path.resolve(launchCwd);

  if (!fs.existsSync(resolved)) {
    return { ok: false, reason: "launch-cwd-missing", path: resolved, repoRoot: null, head: null };
  }
  if (!fs.statSync(resolved).isDirectory()) {
    return { ok: false, reason: "launch-cwd-not-a-directory", path: resolved, repoRoot: null, head: null };
  }

  const top = git(resolved, ["rev-parse", "--show-toplevel"]);
  if (top.status !== 0) {
    return { ok: false, reason: "launch-cwd-not-a-git-repository", path: resolved, repoRoot: null, head: null };
  }

  const head = git(resolved, ["rev-parse", "HEAD"]);
  const common = git(resolved, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);

  return {
    ok: true,
    reason: null,
    path: resolved,
    repoRoot: top.stdout.trim(),
    head: head.status === 0 ? head.stdout.trim() : null,
    gitCommonDir: common.status === 0 ? common.stdout.trim() : null
  };
}

/* ------------------------------ companion -------------------------------- */

function runCompanion(companionPath, args, { cwd, timeoutMs = 120000, useProcessCwd = false } = {}) {
  // `--cwd` is a supported value option on task/status/result/cancel in the
  // installed companion. `useProcessCwd` is the equivalent fallback for a build
  // that ever drops the flag: same workspace context, different mechanism. We do
  // not invent flags the companion does not have.
  const finalArgs = useProcessCwd ? args : [...args, "--cwd", cwd];
  const result = spawnSync(process.execPath, [companionPath, ...finalArgs], {
    cwd,
    encoding: "utf8",
    timeout: timeoutMs
  });

  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error ? String(result.error.message) : null,
    argv: [companionPath, ...finalArgs]
  };
}

function parseJsonLoose(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/* -------------------------------- launch --------------------------------- */

export function launch(options) {
  const {
    taskType,
    prompt,
    launchCwd,
    receiptPath,
    capabilitiesPath,
    requestedEffort = "max",
    requestedModel = null,
    write = false,
    pr = null,
    headOid = null,
    baseOid = null,
    reviewKey = null,
    stagingArtifactPath = null,
    canonicalArtifactPath = null,
    attemptId = newAttemptId(),
    attemptNumber = 1,
    supersedesAttemptId = null,
    companionPath: explicitCompanion = null,
    background = true,
    dryRun = false,
    useProcessCwd = false
  } = options;

  const cwdInfo = inspectLaunchCwd(launchCwd);
  if (!cwdInfo.ok) {
    throw new CodexJobError(`Cannot launch from "${launchCwd}": ${cwdInfo.reason}`);
  }

  // A read-only task must never be handed workspace-write merely so it can drop
  // an artifact file. The companion sandbox is a boolean (`workspace-write` vs
  // `read-only`) with no path scoping, so "write only this one file" is prompt
  // text, not an enforcement boundary.
  if (!write && stagingArtifactPath) {
    throw new CodexJobError(
      "A read-only task may not be assigned a staging artifact path. Its result must travel over the stdout sentinel."
    );
  }

  const capabilities = loadCapabilities(capabilitiesPath);
  const effort = normalizeEffort(requestedEffort, capabilities);
  if (effort.blocked) {
    throw new CodexJobError(
      `Effort "${requestedEffort}" cannot be normalized (${effort.reason}). Codex-dependent remote writes are blocked; re-run the capability probe.`
    );
  }

  const companionPath = discoverCompanionPath(explicitCompanion ?? capabilities.companionPath);

  const args = ["task"];
  if (background) args.push("--background");
  if (write) args.push("--write");
  if (requestedModel) args.push("--model", requestedModel);
  args.push("--effort", effort.effective);
  args.push("--json");
  args.push(prompt);

  const receipt = {
    schemaVersion: 1,
    taskId: null,
    attemptId,
    attemptNumber,
    supersedesAttemptId,
    taskType,
    pr,
    launchCwd: cwdInfo.path,
    repoRoot: cwdInfo.repoRoot,
    worktreeHead: cwdInfo.head,
    headOid,
    baseOid,
    reviewKey,
    sourceMutationPolicy: write ? "assigned-worktree-only" : "forbidden",
    writeMode: Boolean(write),
    stagingArtifactPath: write ? stagingArtifactPath : null,
    canonicalArtifactPath,
    requestedModel,
    requestedEffort: effort.requested,
    effectiveEffort: effort.effective,
    effortDowngradeReason: effort.downgraded ? effort.reason : null,
    capabilitiesArtifact: path.resolve(capabilitiesPath),
    companionPath,
    command: [...args.slice(0, args.length - 1), "<prompt>"],
    startedAt: new Date().toISOString(),
    launchStatus: "pre-launch",
    launchError: null
  };

  // Receipt lands on disk BEFORE the task runs: if the process dies between
  // spawn and bookkeeping, recovery still knows which workspace to ask.
  writeReceipt(receiptPath, receipt);

  if (dryRun) {
    return { receipt, dryRun: true, stdout: "", taskId: null };
  }

  const run = runCompanion(companionPath, args, { cwd: cwdInfo.path, useProcessCwd });

  if (run.status !== 0) {
    const failed = {
      ...receipt,
      launchStatus: "launch-failed",
      launchError: `${run.error ?? ""} ${run.stderr}`.trim().slice(0, 4000)
    };
    writeReceipt(receiptPath, failed);
    throw new CodexJobError(`Codex launch failed: ${failed.launchError}`);
  }

  const payload = parseJsonLoose(run.stdout);
  const taskId =
    payload?.jobId ??
    payload?.job?.id ??
    run.stdout.match(/\b(task-[A-Za-z0-9._-]+)\b/)?.[1] ??
    null;

  const launched = { ...receipt, taskId, launchStatus: "launched" };
  writeReceipt(receiptPath, launched);

  return { receipt: launched, dryRun: false, stdout: run.stdout, taskId };
}

/* ------------------------------- lifecycle -------------------------------- */

/**
 * Run a lifecycle operation in the recorded launch context.
 *
 * `status` / `result` / `cancel` all accept `--cwd`; we always pass the
 * receipt's `launchCwd` and additionally set the child process cwd to it, so
 * both mechanisms point at the same workspace.
 */
export function lifecycle(receipt, operation, { companionPath, extraArgs = [], useProcessCwd = false } = {}) {
  if (!["status", "result", "cancel"].includes(operation)) {
    throw new CodexJobError(`Unsupported lifecycle operation "${operation}"`);
  }

  const cwdInfo = inspectLaunchCwd(receipt.launchCwd);
  if (!cwdInfo.ok) {
    return {
      state: JOB_STATES.POLLING_CONTEXT_ERROR,
      reason: cwdInfo.reason,
      raw: null,
      job: null,
      pollingCwd: receipt.launchCwd
    };
  }

  if (receipt.repoRoot && cwdInfo.repoRoot && path.resolve(cwdInfo.repoRoot) !== path.resolve(receipt.repoRoot)) {
    return {
      state: JOB_STATES.POLLING_CONTEXT_ERROR,
      reason: "launch-cwd-belongs-to-a-different-repository",
      raw: null,
      job: null,
      pollingCwd: cwdInfo.path
    };
  }

  const resolvedCompanion = discoverCompanionPath(companionPath ?? receipt.companionPath);
  const args = [operation];
  if (receipt.taskId) args.push(receipt.taskId);
  args.push(...extraArgs, "--json");

  const run = runCompanion(resolvedCompanion, args, { cwd: cwdInfo.path, useProcessCwd });
  const combined = `${run.stdout}\n${run.stderr}`;

  if (run.status !== 0) {
    if (NO_JOB_RE.test(combined)) {
      // We asked the recorded launch workspace and it genuinely has no record.
      return {
        state: JOB_STATES.JOB_RECORD_MISSING,
        reason: "companion-reports-no-job-in-the-recorded-launch-workspace",
        raw: combined.trim().slice(0, 4000),
        job: null,
        pollingCwd: cwdInfo.path
      };
    }
    return {
      state: JOB_STATES.POLLING_CONTEXT_ERROR,
      reason: `companion-${operation}-failed`,
      raw: combined.trim().slice(0, 4000),
      job: null,
      pollingCwd: cwdInfo.path
    };
  }

  const payload = parseJsonLoose(run.stdout);
  return {
    state: null,
    reason: null,
    raw: run.stdout,
    payload,
    job: payload?.job ?? payload?.storedJob ?? null,
    storedJob: payload?.storedJob ?? null,
    pollingCwd: cwdInfo.path
  };
}

export function classify(job, { stallSeconds = DEFAULT_STALL_SECONDS, now = Date.now() } = {}) {
  if (!job) {
    return { state: JOB_STATES.JOB_RECORD_MISSING, reason: "no-job-record" };
  }

  const status = String(job.status ?? "").toLowerCase();

  if (status === "completed") {
    return { state: JOB_STATES.SUCCESS, reason: null };
  }
  if (status === "failed") {
    return { state: JOB_STATES.FAILED, reason: job.error ?? "companion-reports-failed" };
  }
  if (status === "cancelled" || status === "canceled") {
    return { state: JOB_STATES.CANCELLED, reason: null };
  }

  if (status === "queued" || status === "running") {
    if (Number.isFinite(job.pid) && !pidAlive(job.pid)) {
      return { state: JOB_STATES.JOB_STALE_PID, reason: `pid ${job.pid} is not alive` };
    }
    const last = Date.parse(job.updatedAt ?? job.startedAt ?? job.createdAt ?? "");
    if (Number.isFinite(last) && now - last > stallSeconds * 1000) {
      return {
        state: JOB_STATES.JOB_STALLED,
        reason: `no job activity for ${Math.round((now - last) / 1000)}s (limit ${stallSeconds}s)`
      };
    }
    return { state: JOB_STATES.RUNNING, reason: null };
  }

  return { state: JOB_STATES.JOB_RECORD_MISSING, reason: `unknown status "${job.status}"` };
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error && error.code === "EPERM";
  }
}

/**
 * Bounded disaster-recovery scan of every companion state directory.
 *
 * NOT a polling path. Normal recovery is: read the receipt, verify launchCwd,
 * replay the lifecycle call there. This exists only for a receipt whose launch
 * worktree was deleted, or for migrating jobs from a pre-receipt run.
 */
export function recoverScan(taskId, { stateRoots = defaultStateRoots(), maxDirs = 500 } = {}) {
  const hits = [];
  let scanned = 0;

  for (const root of stateRoots) {
    let entries = [];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory());
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (scanned >= maxDirs) {
        return { hits, scanned, truncated: true };
      }
      scanned += 1;
      const jobFile = path.join(root, entry.name, "jobs", `${taskId}.json`);
      const job = readJsonIfExists(jobFile);
      if (job) {
        hits.push({ stateDir: path.join(root, entry.name), jobFile, workspaceRoot: job.workspaceRoot ?? null });
      }
    }
  }

  return { hits, scanned, truncated: false };
}

function defaultStateRoots() {
  const roots = [];
  if (process.env.CLAUDE_PLUGIN_DATA) {
    roots.push(path.join(process.env.CLAUDE_PLUGIN_DATA, "state"));
  }
  roots.push(path.join(process.env.HOME ?? "", ".claude", "plugins", "data", "codex-openai-codex", "state"));
  roots.push(path.join(process.env.TMPDIR ?? "/tmp", "codex-companion"));
  return roots.filter(Boolean);
}

/* -------------------------------- collect -------------------------------- */

/**
 * Terminal-state handling + artifact reconciliation in one step.
 *
 * A terminal job with no complete, schema-valid stdout artifact is
 * REVIEW_INCONCLUSIVE. Summary telemetry such as `blocking=2 findings=3` is a
 * count, not evidence: it may not create blockers, be posted to GitHub, trigger
 * a fix, be read as zero findings, or grant acceptance.
 */
export function collect(receipt, options = {}) {
  const {
    canonicalArtifact = receipt.canonicalArtifactPath,
    diagnosticsDir = null,
    expected = {},
    stallSeconds = DEFAULT_STALL_SECONDS,
    companionPath = null,
    dryRun = false
  } = options;

  const status = lifecycle(receipt, "status", { companionPath });
  if (status.state) {
    return inconclusive(receipt, status.state, status.reason, { pollingCwd: status.pollingCwd });
  }

  const classified = classify(status.job, { stallSeconds });
  if (classified.state === JOB_STATES.RUNNING) {
    return {
      schemaVersion: 1,
      attemptId: receipt.attemptId,
      taskId: receipt.taskId,
      jobState: JOB_STATES.RUNNING,
      terminal: false,
      accepted: false,
      rerunRequired: false,
      reasons: [],
      reconciliation: null,
      handoff: compactHandoff(receipt, JOB_STATES.RUNNING, null)
    };
  }

  const resultRun = lifecycle(receipt, "result", { companionPath });
  const stdout = extractTaskStdout(resultRun);

  const reconciliation = reconcile({
    stdout,
    launchCwd: receipt.launchCwd,
    canonicalArtifact,
    stagingArtifactPath: receipt.stagingArtifactPath,
    diagnosticsDir,
    expected: {
      taskType: receipt.taskType,
      pr: receipt.pr ?? undefined,
      headOid: receipt.headOid ?? undefined,
      baseOid: receipt.baseOid ?? undefined,
      reviewKey: receipt.reviewKey ?? undefined,
      attemptId: receipt.attemptId,
      ...expected
    },
    terminalStatus: classified.state === JOB_STATES.SUCCESS ? "success" : classified.state,
    writeMode: receipt.writeMode,
    dryRun
  });

  const rerunRequired =
    reconciliation.rerunRequired || classified.state !== JOB_STATES.SUCCESS;

  return {
    schemaVersion: 1,
    attemptId: receipt.attemptId,
    taskId: receipt.taskId,
    jobState: classified.state,
    terminal: true,
    accepted: reconciliation.accepted && classified.state === JOB_STATES.SUCCESS,
    rerunRequired: reconciliation.accepted && classified.state === JOB_STATES.SUCCESS ? false : rerunRequired,
    reasons: [
      ...(classified.reason ? [`job:${classified.reason}`] : []),
      ...reconciliation.reasons
    ],
    reconciliation,
    handoff: compactHandoff(receipt, classified.state, reconciliation)
  };
}

function inconclusive(receipt, state, reason, extra = {}) {
  return {
    schemaVersion: 1,
    attemptId: receipt.attemptId,
    taskId: receipt.taskId,
    jobState: state,
    terminal: state !== JOB_STATES.RUNNING,
    accepted: false,
    // A polling-context error says nothing about the job, so it must not trigger
    // a rerun; fix the polling context and ask again.
    rerunRequired: state === JOB_STATES.JOB_RECORD_MISSING || state === JOB_STATES.JOB_STALE_PID,
    reasons: [`${state}:${reason ?? "unspecified"}`],
    reconciliation: null,
    handoff: compactHandoff(receipt, state, null),
    ...extra
  };
}

function extractTaskStdout(resultRun) {
  if (resultRun.state) {
    return "";
  }
  const stored = resultRun.storedJob ?? resultRun.payload?.storedJob ?? null;
  return (
    stored?.output ??
    stored?.result ??
    stored?.stdout ??
    stored?.finalMessage ??
    resultRun.payload?.job?.output ??
    resultRun.raw ??
    ""
  );
}

/**
 * One line for the controller. Artifact identity and hash, never finding
 * counts pulled from telemetry.
 */
export function compactHandoff(receipt, jobState, reconciliation) {
  const parts = [
    `attempt=${receipt.attemptId}`,
    `task=${receipt.taskId ?? "none"}`,
    `type=${receipt.taskType}`,
    `job=${jobState}`,
    `effort=${receipt.requestedEffort}->${receipt.effectiveEffort}`,
    `transport=${reconciliation?.transport ?? "none"}`,
    `decision=${reconciliation?.decision ?? "n/a"}`,
    `artifactSha256=${reconciliation?.canonicalSha256 ?? "none"}`,
    `artifact=${reconciliation?.canonicalArtifactPath ?? "none"}`
  ];
  return parts.join(" | ");
}

/* --------------------------------- CLI ---------------------------------- */

function parseArgv(argv) {
  const out = { _: [] };
  const flags = new Set([
    "json",
    "help",
    "write",
    "dry-run",
    "background",
    "use-process-cwd",
    "recover-scan"
  ]);
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      out._.push(token);
      continue;
    }
    const key = token.slice(2);
    if (flags.has(key)) {
      out[key] = true;
      continue;
    }
    const next = argv[i + 1];
    if (next === undefined) {
      throw new CodexJobError(`--${key} requires a value`);
    }
    out[key] = next;
    i += 1;
  }
  return out;
}

const USAGE = `Usage:
  node codex-job.mjs launch  --receipt <r.json> --capabilities <c.json> --launch-cwd <dir> \\
                             --task-type <review|risk-review|fix|mutation|diagnosis> \\
                             --prompt-file <f> [--model gpt-5.6-sol] [--effort max] [--write] \\
                             [--pr N] [--head OID] [--base OID] [--review-key KEY] \\
                             [--staging <rel-path>] [--canonical <path>] [--attempt-id ID] [--dry-run]

  node codex-job.mjs status  --receipt <r.json> [--json]
  node codex-job.mjs collect --receipt <r.json> [--diagnostics <dir>] [--canonical <path>] [--json]
  node codex-job.mjs cancel  --receipt <r.json>
  node codex-job.mjs recover --task-id task-xxx        # bounded disaster-recovery scan only

Exit codes: 0 ok/accepted, 1 not accepted, 3 running, 2 usage/internal error.
`;

function main(argv) {
  const args = parseArgv(argv);
  const command = args._[0];

  if (args.help || !command) {
    process.stdout.write(USAGE);
    return args.help ? 0 : 2;
  }

  if (command === "launch") {
    const out = launch({
      taskType: args["task-type"],
      prompt: args["prompt-file"] ? fs.readFileSync(args["prompt-file"], "utf8") : args.prompt,
      launchCwd: args["launch-cwd"],
      receiptPath: args.receipt,
      capabilitiesPath: args.capabilities,
      requestedEffort: args.effort ?? "max",
      requestedModel: args.model ?? null,
      write: Boolean(args.write),
      pr: args.pr ? Number(args.pr) : null,
      headOid: args.head ?? null,
      baseOid: args.base ?? null,
      reviewKey: args["review-key"] ?? null,
      stagingArtifactPath: args.staging ?? null,
      canonicalArtifactPath: args.canonical ?? null,
      attemptId: args["attempt-id"] ?? newAttemptId(),
      attemptNumber: args["attempt-number"] ? Number(args["attempt-number"]) : 1,
      supersedesAttemptId: args.supersedes ?? null,
      background: args.background !== undefined ? Boolean(args.background) : true,
      dryRun: Boolean(args["dry-run"]),
      useProcessCwd: Boolean(args["use-process-cwd"])
    });
    process.stdout.write(`${JSON.stringify({ taskId: out.taskId, receipt: out.receipt }, null, 2)}\n`);
    return 0;
  }

  if (command === "status") {
    const receipt = readReceipt(args.receipt);
    const status = lifecycle(receipt, "status", { useProcessCwd: Boolean(args["use-process-cwd"]) });
    const classified = status.state ? { state: status.state, reason: status.reason } : classify(status.job);
    process.stdout.write(
      `${JSON.stringify({ ...classified, pollingCwd: status.pollingCwd, taskId: receipt.taskId }, null, 2)}\n`
    );
    return classified.state === JOB_STATES.RUNNING ? 3 : 0;
  }

  if (command === "collect") {
    const receipt = readReceipt(args.receipt);
    const out = collect(receipt, {
      canonicalArtifact: args.canonical ?? receipt.canonicalArtifactPath,
      diagnosticsDir: args.diagnostics ?? null,
      dryRun: Boolean(args["dry-run"])
    });
    if (args["out"]) {
      writeJsonAtomic(args.out, out);
    }
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    if (out.jobState === JOB_STATES.RUNNING) return 3;
    return out.accepted ? 0 : 1;
  }

  if (command === "cancel") {
    const receipt = readReceipt(args.receipt);
    const out = lifecycle(receipt, "cancel");
    process.stdout.write(`${JSON.stringify({ state: out.state, reason: out.reason, pollingCwd: out.pollingCwd }, null, 2)}\n`);
    return 0;
  }

  if (command === "recover") {
    if (!args["task-id"]) throw new CodexJobError("recover requires --task-id");
    const out = recoverScan(args["task-id"]);
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    return out.hits.length > 0 ? 0 : 1;
  }

  process.stderr.write(USAGE);
  return 2;
}

runCli(import.meta.url, main);
