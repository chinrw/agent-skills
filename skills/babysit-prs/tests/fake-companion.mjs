#!/usr/bin/env node
/**
 * Test double for codex-companion.mjs.
 *
 * It deliberately reproduces the two real behaviours the babysit-prs runtime
 * has to survive:
 *
 *   1. The job store is WORKSPACE-SCOPED — keyed by `git rev-parse
 *      --show-toplevel` of the effective cwd. A job launched from a linked
 *      worktree is therefore invisible from the main checkout, which reports
 *      "No job found for ...". Same as the real companion.
 *   2. `--effort` is validated against a fixed enum. The accepted set is
 *      configurable here so tests can cover both a companion that rejects
 *      `max` (today) and one that accepts it (a future build).
 *
 * Configuration via environment:
 *   FAKE_CODEX_STATE      state root directory (required)
 *   FAKE_CODEX_EFFORTS    comma list; default none,minimal,low,medium,high,xhigh
 *   FAKE_CODEX_OUTPUT     file whose contents become the job's stdout result
 *   FAKE_CODEX_STATUS     completed | failed | cancelled | running (default completed)
 *   FAKE_CODEX_PID        pid recorded on a running job (to simulate a stale pid)
 *   FAKE_CODEX_UPDATED_AT ISO timestamp for the job's updatedAt (to simulate a stall)
 */

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const DEFAULT_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh"];

function acceptedEfforts() {
  const raw = process.env.FAKE_CODEX_EFFORTS;
  return raw ? raw.split(",").map((s) => s.trim()).filter(Boolean) : DEFAULT_EFFORTS;
}

function printUsage() {
  console.log(
    [
      "Usage:",
      "  node fake-companion.mjs setup [--json]",
      `  node fake-companion.mjs task [--background] [--write] [--model <model>] [--effort <${acceptedEfforts().join("|")}>] [prompt]`,
      "  node fake-companion.mjs status [job-id] [--all] [--json]",
      "  node fake-companion.mjs result [job-id] [--json]",
      "  node fake-companion.mjs cancel [job-id] [--json]"
    ].join("\n")
  );
}

function parseArgs(argv) {
  const options = {};
  const positionals = [];
  const valueKeys = new Set(["cwd", "model", "effort", "prompt-file"]);
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "-C") {
      options.cwd = argv[i + 1];
      i += 1;
      continue;
    }
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    const key = token.slice(2);
    if (valueKeys.has(key)) {
      options[key] = argv[i + 1];
      i += 1;
    } else {
      options[key] = true;
    }
  }
  return { options, positionals };
}

function resolveCwd(options) {
  return options.cwd ? path.resolve(process.cwd(), options.cwd) : process.cwd();
}

/** Mirrors the real `resolveWorkspaceRoot`: git toplevel, which for a linked worktree is the worktree. */
function resolveWorkspaceRoot(cwd) {
  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8" });
  if (result.status !== 0) return cwd;
  return result.stdout.trim();
}

function stateDir(cwd) {
  const root = resolveWorkspaceRoot(cwd);
  let canonical = root;
  try {
    canonical = fs.realpathSync.native(root);
  } catch {
    /* keep root */
  }
  const slug = (path.basename(root) || "workspace").replace(/[^a-zA-Z0-9._-]+/g, "-");
  const hash = createHash("sha256").update(canonical).digest("hex").slice(0, 16);
  const dir = path.join(process.env.FAKE_CODEX_STATE, `${slug}-${hash}`, "jobs");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function jobFile(cwd, id) {
  return path.join(stateDir(cwd), `${id}.json`);
}

function normalizeEffort(value) {
  if (value == null) return null;
  const normalized = String(value).trim().toLowerCase();
  if (!acceptedEfforts().includes(normalized)) {
    throw new Error(
      `Unsupported reasoning effort "${value}". Use one of: ${acceptedEfforts().join(", ")}.`
    );
  }
  return normalized;
}

function handleTask(argv) {
  const { options, positionals } = parseArgs(argv);
  const cwd = resolveCwd(options);
  const effort = normalizeEffort(options.effort);

  const id = `task-${createHash("sha256")
    .update(`${cwd}|${positionals.join(" ")}|${Date.now()}|${Math.random()}`)
    .digest("hex")
    .slice(0, 12)}`;

  const status = process.env.FAKE_CODEX_STATUS ?? "completed";
  const output = process.env.FAKE_CODEX_OUTPUT && fs.existsSync(process.env.FAKE_CODEX_OUTPUT)
    ? fs.readFileSync(process.env.FAKE_CODEX_OUTPUT, "utf8")
    : "";

  const now = new Date().toISOString();
  const job = {
    id,
    kind: "task",
    jobClass: "task",
    title: "Codex Task",
    workspaceRoot: resolveWorkspaceRoot(cwd),
    status,
    write: Boolean(options.write),
    model: options.model ?? null,
    effort,
    pid: process.env.FAKE_CODEX_PID ? Number(process.env.FAKE_CODEX_PID) : process.pid,
    createdAt: now,
    startedAt: now,
    updatedAt: process.env.FAKE_CODEX_UPDATED_AT ?? now,
    completedAt: status === "completed" || status === "failed" || status === "cancelled" ? now : null,
    output
  };

  fs.writeFileSync(jobFile(cwd, id), JSON.stringify(job, null, 2), "utf8");
  process.stdout.write(`${JSON.stringify({ jobId: id, title: job.title, status: job.status })}\n`);
}

function loadJob(cwd, reference) {
  const file = jobFile(cwd, reference);
  if (!fs.existsSync(file)) {
    throw new Error(`No job found for "${reference}". Run /codex:status to inspect known jobs.`);
  }
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function handleStatus(argv) {
  const { options, positionals } = parseArgs(argv);
  const cwd = resolveCwd(options);
  const job = loadJob(cwd, positionals[0] ?? "");
  process.stdout.write(`${JSON.stringify({ workspaceRoot: resolveWorkspaceRoot(cwd), job }, null, 2)}\n`);
}

function handleResult(argv) {
  const { options, positionals } = parseArgs(argv);
  const cwd = resolveCwd(options);
  const job = loadJob(cwd, positionals[0] ?? "");
  // Mirror the INSTALLED companion's shape exactly. `storedJob.result` is an
  // OBJECT and the model's text lives at `.rawOutput`; there is no bare
  // `storedJob.output` string. An earlier version of this fake invented one,
  // and that fiction let a real bug through a green suite: the collector
  // returned the object, it stringified to "[object Object]", and three
  // completed Sol reviews were reported as `stdout-sentinel-missing`.
  const { output, ...rest } = job;
  process.stdout.write(
    `${JSON.stringify(
      {
        job: rest,
        storedJob: {
          ...rest,
          result: {
            status: job.status === "failed" ? 1 : 0,
            threadId: job.threadId ?? "thread-fake",
            rawOutput: output,
            touchedFiles: [],
            reasoningSummary: []
          },
          rendered: output
        }
      },
      null,
      2
    )}\n`
  );
}

function handleCancel(argv) {
  const { options, positionals } = parseArgs(argv);
  const cwd = resolveCwd(options);
  const job = loadJob(cwd, positionals[0] ?? "");
  job.status = "cancelled";
  job.completedAt = new Date().toISOString();
  fs.writeFileSync(jobFile(cwd, job.id), JSON.stringify(job, null, 2), "utf8");
  process.stdout.write(`${JSON.stringify({ job }, null, 2)}\n`);
}

function main() {
  const [subcommand, ...argv] = process.argv.slice(2);
  if (!subcommand || subcommand === "help" || subcommand === "--help") {
    printUsage();
    return;
  }
  switch (subcommand) {
    case "task":
      handleTask(argv);
      break;
    case "status":
      handleStatus(argv);
      break;
    case "result":
      handleResult(argv);
      break;
    case "cancel":
      handleCancel(argv);
      break;
    default:
      throw new Error(`Unknown subcommand: ${subcommand}`);
  }
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
