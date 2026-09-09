#!/usr/bin/env node
// Pin one companion, workspace, and job for the whole attempt. Runtime errors
// retain the attempt so a failed wrapper cannot authorize a second writer.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const read = file => JSON.parse(fs.readFileSync(file, "utf8"));
function write(file, value) {
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(temporary, file);
}
function git(cwd, ...args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", timeout: 10000 }).trim();
}
function fingerprint(companion) {
  const scripts = path.dirname(companion);
  const files = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile()) files.push([path.relative(scripts, file), hash(fs.readFileSync(file))]);
      else throw new Error("companion scripts must be ordinary files");
    }
  }
  walk(scripts);
  return hash(JSON.stringify(files));
}
function snapshot(cwd) {
  const untracked = execFileSync("git", ["-C", cwd, "ls-files", "--others", "--exclude-standard", "-z"])
    .toString().split("\0").filter(Boolean).sort().map(name => {
      const file = path.join(cwd, name);
      return [name, hash(fs.lstatSync(file).isSymbolicLink() ? fs.readlinkSync(file) : fs.readFileSync(file))];
    });
  return { head: git(cwd, "rev-parse", "HEAD"),
    diff: hash(execFileSync("git", ["-C", cwd, "diff", "HEAD", "--binary"])),
    status: git(cwd, "status", "--porcelain=v1", "--untracked-files=all"), untracked };
}
function command(identity, args, { allSessions = false } = {}) {
  if (fingerprint(identity.companion) !== identity.companionHash) throw new Error("pinned companion changed");
  if (fs.realpathSync(git(identity.cwd, "rev-parse", "--show-toplevel")) !== identity.workspaceRoot) {
    throw new Error("workspace root changed");
  }
  const env = { ...process.env };
  delete env.CODEX_COMPANION_SESSION_ID;
  if (!allSessions && identity.sessionId) env.CODEX_COMPANION_SESSION_ID = identity.sessionId;
  const result = spawnSync(identity.node, [identity.companion, ...args, "--cwd", identity.cwd, "--json"], {
    cwd: identity.cwd, env, encoding: "utf8", timeout: 60000, maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) throw new Error(result.error?.message || result.stderr || `companion exited ${result.status}`);
  try { return JSON.parse(result.stdout); } catch { throw new Error("companion returned missing or malformed JSON"); }
}
function load(attempt) {
  const identity = read(path.join(attempt, "assignment.json"));
  if (identity.schemaVersion !== 1 || !identity.attemptId || !Array.isArray(identity.criteria) ||
      !Number.isSafeInteger(identity.attemptNumber) || identity.attemptNumber < 1 ||
      !Number.isSafeInteger(identity.maxAttempts) || identity.maxAttempts < 1) throw new Error("invalid saved attempt");
  return { identity, state: read(path.join(attempt, "state.json")) };
}
function update(attempt, state) { write(path.join(attempt, "state.json"), state); }
function sameSnapshot(left, right) { return JSON.stringify(left) === JSON.stringify(right); }
function assertJob(identity, state, job) {
  if (!job || job.id !== state.jobId || job.workspaceRoot !== identity.workspaceRoot) throw new Error("job identity mismatch");
  if (state.threadId && job.threadId && state.threadId !== job.threadId) throw new Error("thread identity mismatch");
}
function release(identity) {
  if (identity.lock && fs.existsSync(identity.lock) && fs.readFileSync(identity.lock, "utf8") === identity.attempt) fs.unlinkSync(identity.lock);
}

export function launch(input, attempt) {
  if (!input.prompt?.trim() || !["read", "write"].includes(input.mode)) throw new Error("prompt and mode (read/write) are required");
  for (const key of ["model", "effort"]) {
    if (input[key] != null && (typeof input[key] !== "string" || !input[key].trim())) throw new Error(`${key} must be a nonempty string`);
  }
  if (input.maxAttempts != null && (!Number.isSafeInteger(input.maxAttempts) || input.maxAttempts < 1)) throw new Error("maxAttempts must be a positive integer");
  if (!Array.isArray(input.criteria) || !input.criteria.length || input.criteria.some(id => typeof id !== "string" || !id.trim()) || new Set(input.criteria).size !== input.criteria.length) {
    throw new Error("unique required criterion IDs are required");
  }
  const cwd = fs.realpathSync(input.cwd);
  const output = path.join(fs.realpathSync(path.dirname(path.resolve(attempt))), path.basename(attempt));
  const workspaceRoot = fs.realpathSync(git(cwd, "rev-parse", "--show-toplevel"));
  // The companion executes from the Git root even when passed a subdirectory.
  // Pin both, and run source snapshots at that root so adjacent files count.
  const companion = fs.realpathSync(input.companion);
  if (input.effort) {
    const help = execFileSync(process.execPath, [companion, "--help"], { encoding: "utf8", timeout: 10000 });
    const efforts = /--effort <([^>]+)>/.exec(help)?.[1].split("|");
    if (!efforts?.includes(input.effort)) throw new Error(`launcher does not advertise effort: ${input.effort}`);
  }
  const pluginFile = path.resolve(path.dirname(companion), "../.claude-plugin/plugin.json");
  const identity = { schemaVersion: 1, attemptId: crypto.randomUUID(), createdAt: new Date().toISOString(), attempt: output, cwd,
    workspaceRoot, companion, companionHash: fingerprint(companion),
    pluginVersion: fs.existsSync(pluginFile) ? read(pluginFile).version : "unknown",
    node: fs.realpathSync(process.execPath), sessionId: process.env.CODEX_COMPANION_SESSION_ID ?? null,
    attemptNumber: 1, maxAttempts: input.maxAttempts ?? 3,
    mode: input.mode, criteria: input.criteria, requestedModel: input.model ?? null,
    requestedEffort: input.effort ?? null, effectiveModel: null, effectiveEffort: null,
    previous: input.previous ? fs.realpathSync(input.previous) : null, baseline: snapshot(workspaceRoot) };
  if (identity.previous) {
    const previous = load(identity.previous);
    identity.attemptNumber = previous.identity.attemptNumber + 1;
    identity.maxAttempts = input.maxAttempts ?? previous.identity.maxAttempts;
    if (previous.identity.workspaceRoot !== workspaceRoot || !previous.state.settled ||
        !sameSnapshot(previous.state.snapshot, identity.baseline)) throw new Error("previous attempt is not settled at the current source state");
    if (previous.identity.mode !== identity.mode || JSON.stringify([...previous.identity.criteria].sort()) !== JSON.stringify([...identity.criteria].sort())) {
      throw new Error("continuation must retain the approved mode and required criteria");
    }
  }
  if (identity.attemptNumber > identity.maxAttempts) throw new Error("implementation attempt budget exhausted");
  const listing = command(identity, ["status", "--all"], { allSessions: true });
  if (listing.workspaceRoot !== workspaceRoot || !Array.isArray(listing.running)) throw new Error("invalid workspace status");
  if (listing.running.length) throw new Error("workspace has active jobs");
  const relative = path.relative(workspaceRoot, output);
  if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) {
    throw new Error("attempt directory must be outside the source worktree");
  }
  fs.mkdirSync(output, { recursive: false, mode: 0o700 });
  const commonDir = fs.realpathSync(git(workspaceRoot, "rev-parse", "--path-format=absolute", "--git-common-dir"));
  identity.lock = path.join(commonDir, `codex-implementation-${hash(workspaceRoot)}.lock`);
  fs.writeFileSync(identity.lock, output, { flag: "wx", mode: 0o600 });
  write(path.join(output, "assignment.json"), identity);
  fs.writeFileSync(path.join(output, "baseline.patch"), execFileSync("git", ["-C", workspaceRoot, "diff", "HEAD", "--binary"]), { mode: 0o600 });
  const promptFile = path.join(output, "prompt.md");
  fs.writeFileSync(promptFile, input.prompt, { mode: 0o600 });
  const state = { status: "launching", jobId: null, threadId: null, settled: false };
  update(output, state);
  try {
    const args = ["task", "--background", "--fresh", "--prompt-file", promptFile];
    if (input.mode === "write") args.push("--write");
    if (input.model) args.push("--model", input.model);
    if (input.effort) args.push("--effort", input.effort);
    const receipt = command(identity, args);
    write(path.join(output, "launch.json"), receipt);
    if (typeof receipt.jobId !== "string" || !receipt.jobId || receipt.status !== "queued") throw new Error("invalid launch receipt");
    Object.assign(state, { status: "queued", jobId: receipt.jobId });
    update(output, state);
    return { attempt: output, ...state };
  } catch (error) {
    Object.assign(state, { status: "unknown", error: error.message });
    update(output, state);
    throw error;
  }
}

export function operate(action, attempt) {
  const { identity, state } = load(attempt);
  try {
    if (!state.jobId) throw new Error("launch outcome is unknown; inspect the saved attempt before recovery");
    const observation = command(identity, ["status", state.jobId]);
    if (observation.workspaceRoot !== identity.workspaceRoot) throw new Error("workspace identity mismatch");
    assertJob(identity, state, observation.job);
    write(path.join(attempt, "status.json"), observation);
    Object.assign(state, { status: observation.job.status, threadId: observation.job.threadId ?? state.threadId, settled: false, terminalTurn: false });
    delete state.error;
    update(attempt, state);
    if (action === "status") return state;
    if (action === "cancel") {
      const receipt = command(identity, ["cancel", state.jobId]);
      write(path.join(attempt, "cancel.json"), receipt);
      if (receipt.jobId !== state.jobId) throw new Error("cancel identity mismatch");
      state.status = "cancel-requested";
      update(attempt, state);
      return state;
    }
    if (!["completed", "failed", "cancelled"].includes(state.status)) throw new Error("task is not terminal");
    const before = snapshot(identity.workspaceRoot);
    const result = command(identity, ["result", state.jobId]);
    assertJob(identity, state, result.job);
    assertJob(identity, state, result.storedJob);
    if (result.storedJob.status !== state.status || result.job.status !== state.status) throw new Error("terminal status mismatch");
    if (!state.threadId || result.storedJob.threadId !== state.threadId) throw new Error("terminal thread identity is missing or changed");
    write(path.join(attempt, "result.json"), result);
    const after = snapshot(identity.workspaceRoot);
    if (!sameSnapshot(before, after)) throw new Error("source changed while collecting the result");
    state.snapshot = after;
    // A cancellation receipt or a caught launcher error does not prove the
    // server-side turn ended. Preserve evidence without releasing its lock.
    state.terminalTurn = ["completed", "failed"].includes(state.status) && Number.isInteger(result.storedJob.result?.status);
    if (state.terminalTurn && (state.status === "completed") !== (result.storedJob.result.status === 0)) {
      throw new Error("job and returned turn outcome disagree");
    }
    update(attempt, state);
    return state;
  } catch (error) {
    Object.assign(state, { status: "unknown", settled: false, error: error.message });
    update(attempt, state);
    throw error;
  }
}

export function assess(attempt, assessment, complete = false) {
  operate("result", attempt);
  const { identity, state } = load(attempt);
  if (assessment.attemptId !== identity.attemptId || assessment.jobId !== state.jobId || assessment.threadId !== state.threadId) {
    throw new Error("assessment belongs to another attempt, job, or thread");
  }
  if (!state.terminalTurn || !sameSnapshot(state.snapshot, snapshot(identity.workspaceRoot))) throw new Error("terminal turn or stable source evidence is missing");
  if (!sameSnapshot(assessment.snapshot, state.snapshot)) throw new Error("assessment does not cover the current source snapshot");
  if (assessment.processesStopped !== true || !assessment.lifecycleEvidence?.trim()) throw new Error("controller must verify task and process termination");
  if (identity.mode === "read" && !sameSnapshot(identity.baseline, state.snapshot)) throw new Error("read-only task changed source");
  if (complete) {
    if (state.status !== "completed") throw new Error("failed or unknown task cannot be complete");
    for (const id of identity.criteria) {
      const matches = (assessment.criteria ?? []).filter(item => item.id === id);
      if (matches.length !== 1 || matches[0].status !== "PASS" || !matches[0].evidence?.trim()) throw new Error(`required criterion has not passed: ${id}`);
    }
    if (assessment.independentCheck?.status !== "PASS" || !assessment.independentCheck.evidence?.trim()) throw new Error("independent verification has not passed");
  }
  write(path.join(attempt, "assessment.json"), assessment);
  state.settled = true;
  state.complete = complete;
  update(attempt, state);
  release(identity);
  return state;
}

function main(argv) {
  const [action, first, second] = argv;
  if (action === "launch" && first && second && argv.length === 3) return launch(read(first), second);
  if (["status", "result", "cancel"].includes(action) && first && argv.length === 2) return operate(action, first);
  if (["settle", "complete"].includes(action) && first && second && argv.length === 3) return assess(first, read(second), action === "complete");
  throw new Error("usage: task.mjs launch ASSIGNMENT NEW_ATTEMPT | status|result|cancel ATTEMPT | settle|complete ATTEMPT ASSESSMENT");
}
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify({ ok: true, result: main(process.argv.slice(2)) })); }
  catch (error) { console.log(JSON.stringify({ ok: false, error: { code: "TASK_CONTRACT_ERROR", message: error.message } })); process.exitCode = 1; }
}
