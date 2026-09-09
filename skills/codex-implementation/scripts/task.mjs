#!/usr/bin/env node
// Pin one companion, workspace, and job for the whole attempt. Runtime errors
// retain the attempt so a failed wrapper cannot authorize a second writer.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { acquireLock, assertLock, releaseLock, inspectLock, assertProcessesStopped } from "./lib/repository-lock.mjs";

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
    index: hash(execFileSync("git", ["-C", cwd, "ls-files", "--stage", "-z"])),
    staged: hash(execFileSync("git", ["-C", cwd, "diff", "--cached", "--binary"])),
    unstaged: hash(execFileSync("git", ["-C", cwd, "diff", "--binary"])),
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
function invalidate(state, reason) {
  if (state.settled || state.complete) {
    state.priorSettlement = { status: state.status, settled: state.settled, complete: state.complete,
      terminalTurn: state.terminalTurn, snapshot: state.snapshot, resultHash: state.resultHash };
  }
  Object.assign(state, { status: state.priorSettlement ? "needs-reconciliation" : "unknown",
    settled: false, complete: false, terminalTurn: false, error: reason });
}
function release(identity, assessment) {
  if (identity.lock && fs.existsSync(identity.lock) && fs.readFileSync(identity.lock, "utf8") === identity.attempt) fs.unlinkSync(identity.lock);
  if (identity.controllerLease) releaseLock(identity.cwd, identity.controllerLease.token, {
    ...identity.controllerLease, observedAt: new Date().toISOString(), allTasksStopped: true,
    processesStopped: true, processIds: assessment.processIds ?? [], evidence: assessment.lifecycleEvidence,
  });
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
  if (fs.existsSync(output)) throw new Error("attempt directory already exists");
  const lease = acquireLock(cwd, { runtime: "companion", runId: identity.attemptId, sessionId: identity.sessionId ?? "unknown", recordPath: output });
  if (!lease.acquired) throw new Error(`repository controller busy: ${JSON.stringify(lease.owner)}`);
  identity.controllerLease = lease.owner;
  const state = { status: "launching", jobId: null, threadId: null, settled: false, leaseReleased: false };
  let dispatched = false;
  let createdAttempt = false;
  try {
    fs.mkdirSync(output, { recursive: false, mode: 0o700 });
    createdAttempt = true;
    const promptFile = path.join(output, "prompt.md");
    const prompt = `Attempt ID: ${identity.attemptId}\n\n${input.prompt}`;
    identity.promptHash = hash(prompt);
    write(path.join(output, "assignment.json"), identity);
    fs.writeFileSync(path.join(output, "baseline.patch"), execFileSync("git", ["-C", workspaceRoot, "diff", "HEAD", "--binary"]), { mode: 0o600 });
    fs.writeFileSync(promptFile, prompt, { mode: 0o600 });
    update(output, state);
    const args = ["task", "--background", "--fresh", "--prompt-file", promptFile];
    if (input.mode === "write") args.push("--write");
    if (input.model) args.push("--model", input.model);
    if (input.effort) args.push("--effort", input.effort);
    dispatched = true;
    const receipt = command(identity, args);
    write(path.join(output, "launch.json"), receipt);
    if (typeof receipt.jobId !== "string" || !receipt.jobId || receipt.status !== "queued") throw new Error("invalid launch receipt");
    Object.assign(state, { status: "queued", jobId: receipt.jobId });
    update(output, state);
    return { attempt: output, ...state };
  } catch (error) {
    Object.assign(state, { status: dispatched ? "unknown" : "not-started", error: error.message });
    if (createdAttempt) update(output, state);
    if (!dispatched) release(identity, { lifecycleEvidence: "Preparation failed before companion dispatch", processIds: [] });
    throw error;
  }
}

export function operate(action, attempt) {
  const { identity, state } = load(attempt);
  let phase = "validate";
  try {
    if (state.settled && !sameSnapshot(state.snapshot, snapshot(identity.workspaceRoot))) throw new Error("source snapshot contradicts settlement");
    if (!state.jobId) throw new Error("launch outcome is unknown; inspect the saved attempt before recovery");
    phase = "query";
    const observation = command(identity, ["status", state.jobId]);
    phase = "validate";
    if (observation.workspaceRoot !== identity.workspaceRoot) throw new Error("workspace identity mismatch");
    assertJob(identity, state, observation.job);
    write(path.join(attempt, "status.json"), observation);
    if (state.reconciliation && state.settled) {
      const newer = Date.parse(observation.job.updatedAt) > Date.parse(state.reconciliation.observedAt);
      if (newer && (observation.job.status !== state.status || (observation.job.turnId && observation.job.turnId !== state.turnId))) {
        throw new Error("new lifecycle observation contradicts recovery");
      }
      state.lastObservation = observation;
      update(attempt, state);
      return state;
    }
    if (state.settled && (observation.job.status !== state.status ||
        !sameSnapshot(state.snapshot, snapshot(identity.workspaceRoot)))) {
      throw new Error("observation contradicts the settled lifecycle or source snapshot");
    }
    Object.assign(state, { status: observation.job.status, threadId: observation.job.threadId ?? state.threadId,
      turnId: observation.job.turnId ?? state.turnId ?? null, workerPid: observation.job.pid ?? state.workerPid ?? null });
    delete state.error;
    update(attempt, state);
    if (action === "status") return state;
    if (action === "cancel") {
      const receipt = command(identity, ["cancel", state.jobId]);
      write(path.join(attempt, "cancel.json"), receipt);
      if (receipt.jobId !== state.jobId) throw new Error("cancel identity mismatch");
      Object.assign(state, { status: "cancel-requested", settled: false, complete: false, terminalTurn: false });
      update(attempt, state);
      return state;
    }
    if (!["completed", "failed", "cancelled"].includes(state.status)) throw new Error("task is not terminal");
    const before = snapshot(identity.workspaceRoot);
    phase = "query";
    const result = command(identity, ["result", state.jobId]);
    phase = "validate";
    assertJob(identity, state, result.job);
    assertJob(identity, state, result.storedJob);
    if (result.storedJob.status !== state.status || result.job.status !== state.status) throw new Error("terminal status mismatch");
    if (!state.threadId || result.storedJob.threadId !== state.threadId) throw new Error("terminal thread identity is missing or changed");
    const after = snapshot(identity.workspaceRoot);
    if (!sameSnapshot(before, after)) throw new Error("source changed while collecting the result");
    const resultHash = hash(JSON.stringify(result));
    if (state.settled && state.resultHash !== resultHash) throw new Error("collected result contradicts settlement");
    state.snapshot = after;
    // A cancellation receipt or a caught launcher error does not prove the
    // server-side turn ended. Preserve evidence without releasing its lock.
    state.terminalTurn = ["completed", "failed"].includes(state.status) && Number.isInteger(result.storedJob.result?.status);
    if (state.terminalTurn && (state.status === "completed") !== (result.storedJob.result.status === 0)) {
      throw new Error("job and returned turn outcome disagree");
    }
    write(path.join(attempt, "result.json"), result);
    state.resultHash = resultHash;
    update(attempt, state);
    return state;
  } catch (error) {
    if (phase === "query" && state.settled) state.observationError = error.message;
    else invalidate(state, error.message);
    update(attempt, state);
    throw error;
  }
}

export function assess(attempt, assessment, complete = false) {
  operate("result", attempt);
  const { identity, state } = load(attempt);
  if (identity.controllerLease && !state.settled) assertLock(identity.cwd, identity.controllerLease.token);
  if (assessment.attemptId !== identity.attemptId || assessment.jobId !== state.jobId || assessment.threadId !== state.threadId) {
    throw new Error("assessment belongs to another attempt, job, or thread");
  }
  if (!state.terminalTurn || !sameSnapshot(state.snapshot, snapshot(identity.workspaceRoot))) throw new Error("terminal turn or stable source evidence is missing");
  if (!sameSnapshot(assessment.snapshot, state.snapshot)) throw new Error("assessment does not cover the current source snapshot");
  if (assessment.processesStopped !== true || !assessment.lifecycleEvidence?.trim()) throw new Error("controller must verify task and process termination");
  assertProcessesStopped(assessment.processIds ?? []);
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
  release(identity, assessment);
  state.leaseReleased = true;
  update(attempt, state);
  return state;
}

export function diagnose(attempt) {
  const { identity, state } = load(attempt);
  let observation;
  try { observation = command(identity, state.jobId ? ["status", state.jobId] : ["status", "--all"], { allSessions: !state.jobId }); }
  catch (error) { observation = { error: error.message }; }
  const diagnostic = { schemaVersion: 1, id: crypto.randomUUID(), attemptId: identity.attemptId,
    createdAt: new Date().toISOString(), assignmentHash: hash(fs.readFileSync(path.join(attempt, "assignment.json"))),
    snapshot: snapshot(identity.workspaceRoot), state, observation, lease: inspectLock(identity.cwd) };
  const directory = path.join(attempt, "diagnostics");
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, `${diagnostic.id}.json`);
  write(file, diagnostic);
  return { file, hash: hash(fs.readFileSync(file)), diagnostic };
}

export function reconcile(attempt, proof) {
  const { identity, state } = load(attempt);
  const file = fs.realpathSync(proof.diagnosticFile);
  if (path.dirname(file) !== fs.realpathSync(path.join(attempt, "diagnostics")) ||
      hash(fs.readFileSync(file)) !== proof.diagnosticHash) throw new Error("diagnostic identity mismatch");
  const diagnostic = read(file);
  if (diagnostic.attemptId !== identity.attemptId || proof.attemptId !== identity.attemptId ||
      diagnostic.assignmentHash !== hash(fs.readFileSync(path.join(attempt, "assignment.json"))) ||
      !sameSnapshot(diagnostic.snapshot, proof.snapshot) || !sameSnapshot(proof.snapshot, snapshot(identity.workspaceRoot))) {
    throw new Error("recovery identity or source snapshot changed");
  }
  if (state.settled && state.reconciliation?.proofHash === hash(JSON.stringify(proof))) {
    release(identity, proof);
    state.leaseReleased = true;
    update(attempt, state);
    return state;
  }
  if (!["native-lifecycle", "app-server"].includes(proof.source?.kind) || !proof.source.reference?.trim() ||
      !Number.isFinite(Date.parse(proof.observedAt)) || Date.parse(proof.observedAt) < Date.parse(diagnostic.createdAt)) {
    throw new Error("fresh host lifecycle evidence is required");
  }
  for (const field of ["jobId", "threadId", "turnId"]) {
    if (typeof proof[field] !== "string" || !proof[field] || (state[field] && state[field] !== proof[field])) throw new Error(`recovery ${field} mismatch`);
  }
  if (!state.jobId && (!identity.promptHash || proof.launchPromptHash !== identity.promptHash || proof.requestCwd !== identity.cwd)) {
    throw new Error("unknown launch requires exact request evidence");
  }
  if (proof.serverTurn?.threadId !== proof.threadId || proof.serverTurn?.id !== proof.turnId ||
      !["completed", "failed", "interrupted"].includes(proof.serverTurn.status) ||
      proof.processesStopped !== true || proof.allTasksStopped !== true || !proof.lifecycleEvidence?.trim()) {
    throw new Error("server turn and all task processes must be proven terminal");
  }
  assertProcessesStopped(proof.processIds);
  if (state.workerPid && !proof.processIds.includes(state.workerPid)) throw new Error("known worker process is missing from recovery evidence");
  if (identity.controllerLease) assertLock(identity.cwd, identity.controllerLease.token);
  const recoveryFile = path.join(attempt, `recovery-${crypto.randomUUID()}.json`);
  write(recoveryFile, { previousState: state, proof });
  Object.assign(state, { jobId: proof.jobId, threadId: proof.threadId, turnId: proof.turnId,
    status: proof.serverTurn.status === "interrupted" ? "cancelled" : proof.serverTurn.status,
    terminalTurn: true, settled: true, complete: false, snapshot: proof.snapshot,
    reconciliation: { file: recoveryFile, observedAt: proof.observedAt, proofHash: hash(JSON.stringify(proof)) } });
  delete state.error;
  update(attempt, state);
  release(identity, proof);
  state.leaseReleased = true;
  update(attempt, state);
  return state;
}

function outputPath(identity, candidate) {
  const output = path.join(fs.realpathSync(path.dirname(path.resolve(candidate))), path.basename(candidate));
  const relative = path.relative(identity.workspaceRoot, output);
  if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) {
    throw new Error("output must be outside the source worktree");
  }
  return output;
}

export function assessmentTemplate(attempt, destination) {
  const { identity, state } = load(attempt);
  const output = outputPath(identity, destination ?? path.join(attempt, `assessment-draft-${crypto.randomUUID()}.json`));
  const assessment = { attemptId: identity.attemptId, jobId: state.jobId, threadId: state.threadId,
    snapshot: state.snapshot ?? snapshot(identity.workspaceRoot), processesStopped: false,
    processIds: state.workerPid ? [state.workerPid] : [], lifecycleEvidence: "",
    criteria: identity.criteria.map(id => ({ id, status: "NOT RUN", evidence: "" })),
    independentCheck: { status: "NOT RUN", evidence: "" } };
  fs.writeFileSync(output, JSON.stringify(assessment, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  return { file: output, assessment };
}

function recordFiles(attempt) {
  const fixed = new Set(["assignment.json", "state.json", "prompt.md", "baseline.patch", "launch.json",
    "status.json", "result.json", "cancel.json", "assessment.json"]);
  const files = [];
  for (const entry of fs.readdirSync(attempt, { withFileTypes: true })) {
    if (fixed.has(entry.name) || /^(assessment-draft|recovery)-.+\.json$/.test(entry.name)) {
      if (!entry.isFile()) throw new Error("task records must be ordinary files");
      files.push(entry.name);
    } else if (entry.name === "diagnostics") {
      if (!entry.isDirectory()) throw new Error("diagnostics must be an ordinary directory");
      for (const child of fs.readdirSync(path.join(attempt, entry.name), { withFileTypes: true })) {
        if (!child.isFile() || !child.name.endsWith(".json")) throw new Error("diagnostics must contain ordinary JSON records");
        files.push(`diagnostics/${child.name}`);
      }
    }
  }
  return files.sort();
}

export function exportHandoff(attempt, destination) {
  const { identity } = load(attempt);
  const output = outputPath(identity, destination);
  const source = fs.realpathSync(attempt);
  const relative = path.relative(source, output);
  if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) throw new Error("export must be outside the attempt directory");
  const files = recordFiles(source);
  fs.mkdirSync(output, { recursive: false, mode: 0o700 });
  const records = [];
  for (const name of files) {
    const content = fs.readFileSync(path.join(source, name));
    const target = path.join(output, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, { flag: "wx", mode: 0o600 });
    records.push({ path: name, bytes: content.length, sha256: hash(content) });
  }
  if (JSON.stringify(recordFiles(source)) !== JSON.stringify(files)) throw new Error("task records changed during export; partial output has no manifest");
  for (const record of records) {
    if (hash(fs.readFileSync(path.join(source, record.path))) !== record.sha256 ||
        hash(fs.readFileSync(path.join(output, record.path))) !== record.sha256) throw new Error("task records changed during export; partial output has no manifest");
  }
  const manifest = { schemaVersion: 1, scope: "task-records-only", attemptId: identity.attemptId,
    exportedAt: new Date().toISOString(), sourceTreeIncluded: false, liveLifecycleChecked: false, files: records };
  fs.writeFileSync(path.join(output, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  return { directory: output, manifest };
}

function main(argv) {
  const [action, first, second] = argv;
  if (action === "launch" && first && second && argv.length === 3) return launch(read(first), second);
  if (["status", "result", "cancel"].includes(action) && first && argv.length === 2) return operate(action, first);
  if (action === "diagnose" && first && argv.length === 2) return diagnose(first);
  if (action === "reconcile" && first && second && argv.length === 3) return reconcile(first, read(second));
  if (action === "assessment-template" && first && argv.length <= 3) return assessmentTemplate(first, second);
  if (action === "export-handoff" && first && second && argv.length === 3) return exportHandoff(first, second);
  if (["settle", "complete"].includes(action) && first && second && argv.length === 3) return assess(first, read(second), action === "complete");
  throw new Error("usage: task.mjs launch ASSIGNMENT NEW_ATTEMPT | status|result|cancel|diagnose ATTEMPT | settle|complete|reconcile ATTEMPT PROOF | assessment-template ATTEMPT [OUTPUT] | export-handoff ATTEMPT NEW_DIRECTORY");
}
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify({ ok: true, result: main(process.argv.slice(2)) })); }
  catch (error) { console.log(JSON.stringify({ ok: false, error: { code: "TASK_CONTRACT_ERROR", message: error.message } })); process.exitCode = 1; }
}
