#!/usr/bin/env node
/**
 * Zero-token admission gate for background `/babysit-prs`.
 *
 * A timer that simply re-runs the skill every N minutes pays a `best`/`xhigh`
 * controller on every tick, including the ticks where GitHub has not moved. The
 * marker in each PR's status comment already carries `state` and
 * `codexNextTriggerAt` (SKILL.md section 8), so "is any work due?" is decidable
 * from two `gh` calls and no model at all.
 *
 *   node tick-gate.mjs due  --repo chinrw/stocks   exit 0 due, 10 idle, 2 error
 *   node tick-gate.mjs lock --acquire --owner <id> exit 0 acquired, 11 held
 *
 * Bias: anything the gate cannot decide is reported DUE. A false DUE wastes one
 * run; a false IDLE stalls every PR silently until a human notices, which is the
 * failure mode this whole change exists to prevent.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { execFileSync } from "node:child_process";

import { runCli } from "./lib/cli.mjs";
import { parseMarker } from "./lib/marker.mjs";
import { verifyContract } from "./lib/contract.mjs";

const DEFAULT_LOCK = path.join(os.homedir(), ".claude", "babysit-prs", "run.lock");
const DEFAULT_SKILL_DIR = path.join(os.homedir(), ".claude", "skills", "babysit-prs");
const DEFAULT_STALE_SECONDS = 900;

/** States that mean the pipeline has unfinished work and must be re-entered. */
const IN_PROGRESS_STATES = new Set([
  "DISCOVERED",
  "NEEDS_REVIEW",
  "REVIEWING",
  "NEEDS_FIX",
  "FIXING",
  "NEEDS_VERIFICATION",
  "WAITING_THREADS",
  "READY_STACKED",
  "MERGING",
]);

/** States that are a correct resting place: only fresh evidence reopens them. */
const PARKED_STATES = new Set(["READY_ROOT", "BLOCKED", "MERGED"]);

// ---------------------------------------------------------------- due

/**
 * Decide, per PR, whether a full invocation is warranted.
 * Pure: `prs` and `now` in, verdict out. The network lives in `collectState`.
 */
export function evaluate(prs, now) {
  const reasons = [];
  let earliestNextDue = null;

  for (const pr of prs) {
    const reason = dueReason(pr, now);
    if (reason) {
      reasons.push({ pr: pr.number, reason });
      continue;
    }
    const next = pr.marker?.fields?.codexNextTriggerAt;
    if (next && (!earliestNextDue || next < earliestNextDue)) {
      earliestNextDue = next;
    }
  }

  return { due: reasons.length > 0, reasons, nextDueAt: earliestNextDue, considered: prs.length };
}

function dueReason(pr, now) {
  if (pr.isDraft) {
    return null;
  }
  if (!pr.marker?.found) {
    return "no-marker";
  }

  const { dialect, fields } = pr.marker;
  if (dialect !== "v2") {
    return `marker-dialect-${dialect}`;
  }
  if (fields.pr && String(fields.pr) !== String(pr.number)) {
    return "marker-pr-mismatch";
  }
  if (fields.head !== pr.headRefOid) {
    return "head-advanced";
  }
  // baseTipOid is resolved from the branch ref, never from GraphQL baseRefOid —
  // that field reports the merge base, so comparing against it flags every
  // stacked PR as changed forever.
  if (pr.baseTipOid && fields.base && fields.base !== pr.baseTipOid) {
    return "base-advanced";
  }

  const state = fields.state;
  if (!state) {
    return "marker-missing-state";
  }
  if (IN_PROGRESS_STATES.has(state)) {
    return `state-${state}`;
  }
  if (state === "WAITING_CODEX") {
    return codexRetryReason(fields, now);
  }
  if (state === "WAITING_CI") {
    return pr.ciPending ? null : "ci-settled";
  }
  if (PARKED_STATES.has(state)) {
    return null;
  }
  return `state-unknown-${state}`;
}

function codexRetryReason(fields, now) {
  const next = fields.codexNextTriggerAt;
  if (!next || next === "n/a") {
    // WAITING_CODEX without a retry clock cannot be scheduled; only a full run
    // can re-derive it from live comments and reactions.
    return "codex-retry-clock-missing";
  }
  return now >= next ? "codex-retry-due" : null;
}

/** Shell out to `gh` and shape the input `evaluate` expects. */
function collectState(repo) {
  const prs = ghJson([
    "pr",
    "list",
    "--repo",
    repo,
    "--state",
    "open",
    "--limit",
    "100",
    "--json",
    "number,isDraft,headRefOid,baseRefName,statusCheckRollup",
  ]);

  const markers = fetchMarkers(repo, prs.map((pr) => pr.number));
  const baseTips = resolveBaseTips(
    repo,
    [...new Set(prs.map((pr) => pr.baseRefName).filter(Boolean))],
  );

  return prs.map((pr) => ({
    number: pr.number,
    isDraft: pr.isDraft,
    headRefOid: pr.headRefOid,
    baseRefName: pr.baseRefName,
    baseTipOid: baseTips[pr.baseRefName] ?? null,
    ciPending: isCiPending(pr.statusCheckRollup),
    marker: markers[pr.number] ?? { found: false },
  }));
}

/** One GraphQL round trip for every PR's most recent comments. */
function fetchMarkers(repo, numbers) {
  if (numbers.length === 0) {
    return {};
  }
  const [owner, name] = repo.split("/");
  const aliases = numbers
    .map((n) => `p${n}: pullRequest(number: ${n}) { comments(last: 30) { nodes { body } } }`)
    .join("\n    ");
  const data = ghJson([
    "api",
    "graphql",
    "-f",
    `query=query { repository(owner: "${owner}", name: "${name}") {\n    ${aliases}\n  } }`,
  ]);

  const repository = data?.data?.repository ?? {};
  const out = {};
  for (const n of numbers) {
    const bodies = (repository[`p${n}`]?.comments?.nodes ?? []).map((c) => c.body);
    // Last marker wins: the skill keeps one update-in-place comment, but a
    // superseded one from an older contract may still sit above it.
    out[n] = bodies.reduceRight(
      (found, body) => (found.found ? found : parseMarker(body)),
      { found: false },
    );
  }
  return out;
}

/**
 * Branch tips, read from the ref itself. This is the value a marker's `base=`
 * must be compared against; see the note in `dueReason`.
 */
function resolveBaseTips(repo, branches) {
  const tips = {};
  for (const branch of branches) {
    try {
      tips[branch] = ghJson(["api", `repos/${repo}/git/ref/heads/${branch}`])?.object?.sha ?? null;
    } catch {
      tips[branch] = null; // Unresolvable base disables the base check, not the run.
    }
  }
  return tips;
}

function isCiPending(rollup) {
  if (!Array.isArray(rollup) || rollup.length === 0) {
    return false;
  }
  return rollup.some((check) => {
    const status = check.status ?? check.state ?? "";
    return status === "QUEUED" || status === "IN_PROGRESS" || status === "PENDING";
  });
}

function ghJson(args) {
  const stdout = execFileSync("gh", args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  return JSON.parse(stdout);
}

// ---------------------------------------------------------------- lock

/**
 * Cross-invocation mutex. `O_EXCL` create is the atomic part; a recorded pid
 * plus a heartbeat timestamp is what lets a crashed run's lock be reclaimed
 * instead of wedging the timer forever.
 *
 * The systemd unit should still wrap the run in `flock`, which the kernel
 * releases on death. This file is the signal an interactive `/babysit-prs`
 * can read to stand down.
 */
export function readLock(lockPath, staleSeconds, now) {
  let record;
  try {
    record = JSON.parse(fs.readFileSync(lockPath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      return { status: "free", record: null };
    }
    return { status: "stale", record: null, why: "unreadable-lock" };
  }

  if (record.pid && !isProcessAlive(record.pid)) {
    return { status: "stale", record, why: `pid-${record.pid}-gone` };
  }
  const age = (now - Date.parse(record.heartbeatAt ?? record.startedAt ?? 0)) / 1000;
  if (Number.isNaN(age) || age > staleSeconds) {
    return { status: "stale", record, why: `heartbeat-${Math.round(age)}s` };
  }
  return { status: "held", record };
}

function acquireLock(lockPath, owner, staleSeconds, now) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const existing = readLock(lockPath, staleSeconds, now);

  if (existing.status === "held") {
    process.stdout.write(`HELD owner=${existing.record?.owner ?? "?"} pid=${existing.record?.pid ?? "?"}\n`);
    return 11;
  }
  if (existing.status === "stale") {
    process.stderr.write(`reclaiming stale lock (${existing.why})\n`);
    fs.rmSync(lockPath, { force: true });
  }

  const stamp = new Date(now).toISOString();
  const record = { owner, pid: process.pid, startedAt: stamp, heartbeatAt: stamp };
  try {
    fs.writeFileSync(lockPath, `${JSON.stringify(record)}\n`, { flag: "wx" });
  } catch (error) {
    if (error.code === "EEXIST") {
      process.stdout.write("HELD owner=? pid=? race\n");
      return 11;
    }
    throw error;
  }
  process.stdout.write(`ACQUIRED owner=${owner} pid=${process.pid}\n`);
  return 0;
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

// ---------------------------------------------------------------- cli

const USAGE = `Usage:
  node tick-gate.mjs due --repo <owner/name> [--now <iso>] [--input <fixture.json>] [--json]
      exit 0  work is due (reasons on stdout)
      exit 10 nothing due
      exit 2  error

  node tick-gate.mjs lock --acquire|--status|--release|--heartbeat [--owner <id>]
                          [--lock <path>] [--stale-seconds <n>]
      exit 0  acquired / free / released
      exit 11 held by a live run

  node tick-gate.mjs contract [--skill-dir <path>]
      exit 0  the installed skill publishes what this runner reads
      exit 12 the marker or state contract drifted
`;

function parseArgv(argv) {
  const args = { _: [], flags: new Set() };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      args._.push(token);
    } else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
      args[token.slice(2)] = argv[i + 1];
      i += 1;
    } else {
      args.flags.add(token.slice(2));
    }
  }
  return args;
}

function main(argv) {
  const args = parseArgv(argv);
  const command = args._[0];

  if (command === "due") {
    return runDue(args);
  }
  if (command === "lock") {
    return runLock(args);
  }
  if (command === "contract") {
    return runContract(args);
  }
  process.stderr.write(USAGE);
  return 2;
}

function runDue(args) {
  const now = args.now ?? new Date().toISOString();
  const prs = args.input
    ? JSON.parse(fs.readFileSync(args.input, "utf8"))
    : collectState(requireArg(args, "repo"));
  const verdict = evaluate(prs, now);

  if (args.flags.has("json")) {
    process.stdout.write(`${JSON.stringify(verdict)}\n`);
  } else if (verdict.due) {
    process.stdout.write(
      `DUE ${verdict.reasons.map((r) => `#${r.pr}:${r.reason}`).join(" ")}\n`,
    );
  } else {
    process.stdout.write(`IDLE considered=${verdict.considered} nextDueAt=${verdict.nextDueAt ?? "n/a"}\n`);
  }
  return verdict.due ? 0 : 10;
}

function runLock(args) {
  const lockPath = args.lock ?? DEFAULT_LOCK;
  const staleSeconds = Number(args["stale-seconds"] ?? DEFAULT_STALE_SECONDS);
  const now = Date.now();

  if (args.flags.has("acquire")) {
    return acquireLock(lockPath, args.owner ?? `pid-${process.pid}`, staleSeconds, now);
  }
  if (args.flags.has("release")) {
    fs.rmSync(lockPath, { force: true });
    process.stdout.write("RELEASED\n");
    return 0;
  }
  if (args.flags.has("heartbeat")) {
    const state = readLock(lockPath, staleSeconds, now);
    if (state.status !== "held") {
      process.stderr.write(`cannot heartbeat a ${state.status} lock\n`);
      return 2;
    }
    fs.writeFileSync(
      lockPath,
      `${JSON.stringify({ ...state.record, heartbeatAt: new Date(now).toISOString() })}\n`,
    );
    process.stdout.write("HEARTBEAT\n");
    return 0;
  }

  const state = readLock(lockPath, staleSeconds, now);
  process.stdout.write(
    `${state.status.toUpperCase()}${state.why ? ` (${state.why})` : ""} owner=${state.record?.owner ?? "-"}\n`,
  );
  return state.status === "held" ? 11 : 0;
}

/**
 * Check the installed skill still publishes what this runner reads. Drift here
 * does not throw at runtime — the gate would keep parsing and keep deciding —
 * so it has to be an explicit check with an exit code the wrapper can act on.
 */
function runContract(args) {
  const skillDir = args["skill-dir"] ?? DEFAULT_SKILL_DIR;
  const skillMd = path.join(skillDir, "SKILL.md");

  let text;
  try {
    text = fs.readFileSync(skillMd, "utf8");
  } catch {
    process.stderr.write(`cannot read ${skillMd}\n`);
    return 12;
  }

  const { ok, drift } = verifyContract(text);
  if (ok) {
    process.stdout.write("CONTRACT-OK\n");
    return 0;
  }
  process.stderr.write(`CONTRACT-DRIFT\n${drift.map((d) => `  - ${d}`).join("\n")}\n`);
  return 12;
}

function requireArg(args, name) {
  const value = args[name];
  if (!value) {
    throw new Error(`missing --${name}\n${USAGE}`);
  }
  return value;
}

runCli(import.meta.url, main);
