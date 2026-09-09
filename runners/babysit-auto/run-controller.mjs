#!/usr/bin/env node
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

const skillDir = process.env.BABYSIT_SKILL_DIR ?? path.join(os.homedir(), ".agents/skills/babysit-prs-codex");
const { acquireLock, inspectLock, releaseLock } = await import(pathToFileURL(path.join(skillDir, "scripts/lib/repository-lock.mjs")));
const runId = randomUUID();
const runPath = path.join(process.cwd(), ".claude/babysit-prs/runs", runId);
const lease = process.argv.includes("--snapshot-only") ? null : acquireLock(process.cwd(), { runtime: "timer", runId, sessionId: runId, recordPath: runPath });
if (lease && !lease.acquired) {
  console.log(JSON.stringify({ blocked: "repository-controller-busy", ...lease }));
  process.exitCode = 75;
} else {
  const env = { ...process.env, BABYSIT_SKILL_DIR: skillDir };
  delete env.BABYSIT_CONTROLLER_TOKEN;
  delete env.BABYSIT_CONTROLLER_RUN;
  delete env.CANONICAL_RUN_DIR;
  delete env.BABYSIT_RUN_ID;
  if (lease) Object.assign(env, { BABYSIT_CONTROLLER_TOKEN: lease.owner.token, BABYSIT_CONTROLLER_RUN: runId,
    CANONICAL_RUN_DIR: runPath, BABYSIT_RUN_ID: runId });
  const child = spawn("codex", ["exec", "--cd", process.cwd(), "--sandbox", "workspace-write", "--approve-for-me",
    "-c", "sandbox_workspace_write.network_access=true", "-c", 'model_reasoning_effort="xhigh"',
    `Use babysit-prs-codex: ${process.argv.slice(2).join(" ")}`], {
    stdio: "inherit", env,
  });
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
  child.on("error", error => {
    console.error(error.message);
    if (lease) releaseLock(process.cwd(), lease.owner.token, { ...lease.owner,
      allTasksStopped: true, processesStopped: true, processIds: [], observedAt: new Date().toISOString(),
      evidence: `OS spawn failed before controller execution: ${error.code}` });
    process.exitCode = 2;
  });
  child.on("exit", (code, signal) => {
    const current = lease ? inspectLock(process.cwd()) : null;
    const unreleased = lease && (current.status === "unknown" || current.owner?.token === lease.owner.token);
    if (unreleased) console.error("Controller lease retained: collect task termination evidence before recovery.");
    process.exitCode = code || (signal || unreleased ? 2 : 0);
  });
}
