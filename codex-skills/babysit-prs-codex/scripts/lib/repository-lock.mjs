import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";

function locations(checkout) {
  const commonDir = fs.realpathSync(execFileSync("git", ["-C", checkout, "rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf8" }).trim());
  const root = path.join(commonDir, "agent-skills-controllers");
  return { commonDir, root, active: path.join(root, "active"), released: path.join(root, "released") };
}

export function inspectLock(checkout) {
  const paths = locations(checkout);
  try {
    if (!fs.lstatSync(paths.active).isDirectory()) return { status: "unknown", owner: null, ...paths };
  } catch (error) {
    if (error.code === "ENOENT") return { status: "free", ...paths };
    return { status: "unknown", owner: null, ...paths };
  }
  try {
    const owner = JSON.parse(fs.readFileSync(path.join(paths.active, "owner.json"), "utf8"));
    if (owner.schemaVersion !== 1 || owner.commonDir !== paths.commonDir || !owner.token || !owner.runId || !owner.runtime) throw new Error("invalid owner");
    return { status: "held", owner, ...paths };
  } catch {
    return { status: "unknown", owner: null, ...paths };
  }
}

export function acquireLock(checkout, { runtime, runId, sessionId = "unknown", recordPath = null }) {
  if (!["codex", "claude", "timer", "companion"].includes(runtime) || typeof runId !== "string" || !runId || typeof sessionId !== "string") throw new Error("runtime and runId are required");
  if (recordPath !== null && (typeof recordPath !== "string" || !path.isAbsolute(recordPath))) throw new Error("recordPath must be absolute");
  const paths = locations(checkout);
  const current = inspectLock(checkout);
  if (current.status !== "free") return { acquired: false, ...current };
  const legacy = fs.readdirSync(paths.commonDir).filter(name => /^codex-implementation-[a-f0-9]+\.lock$/.test(name));
  if (legacy.length) return { acquired: false, status: "legacy-held", owner: { runtime: "companion", locks: legacy }, ...paths };
  fs.mkdirSync(paths.root, { recursive: true });
  try { fs.mkdirSync(paths.active); }
  catch (error) {
    if (error.code === "EEXIST") return { acquired: false, ...inspectLock(checkout) };
    throw error;
  }
  const owner = { schemaVersion: 1, token: randomUUID(), commonDir: paths.commonDir,
    runtime, runId, sessionId, recordPath, hostname: os.hostname(), createdAt: new Date().toISOString() };
  // A crash before this write leaves an unknown owner, never a stealable lease.
  fs.writeFileSync(path.join(paths.active, "owner.json"), JSON.stringify(owner, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  return { acquired: true, status: "held", owner, ...paths };
}

export function assertLock(checkout, token) {
  const current = inspectLock(checkout);
  if (current.status !== "held" || current.owner.token !== token) throw new Error("repository controller lease is not owned by this run");
  return current;
}

export function assertProcessesStopped(ids) {
  if (!Array.isArray(ids)) throw new Error("process IDs are required");
  for (const pid of ids) {
    if (!Number.isSafeInteger(pid) || pid < 1) throw new Error("invalid process ID");
    try { process.kill(pid, 0); }
    catch (error) { if (error.code === "ESRCH") continue; throw new Error(`process ${pid} is unobservable`); }
    throw new Error(`process ${pid} is still alive`);
  }
}

export function releaseLock(checkout, token, proof) {
  const paths = locations(checkout);
  if (!/^[a-f0-9-]{36}$/.test(token ?? "")) throw new Error("invalid lease token");
  const destination = path.join(paths.released, token);
  if (fs.existsSync(destination)) {
    const receipt = JSON.parse(fs.readFileSync(path.join(destination, "release.json"), "utf8"));
    if (receipt.owner.token !== token) throw new Error("release receipt identity mismatch");
    return { released: true, alreadyReleased: true, receipt: destination };
  }
  const { owner } = assertLock(checkout, token);
  if (proof?.token !== token || proof.runId !== owner.runId || proof.commonDir !== owner.commonDir ||
      proof.allTasksStopped !== true || proof.processesStopped !== true || !proof.evidence?.trim() ||
      !Number.isFinite(Date.parse(proof.observedAt)) || Date.parse(proof.observedAt) < Date.parse(owner.createdAt)) {
    throw new Error("lease release requires exact owner and observed quiescence evidence");
  }
  assertProcessesStopped(proof.processIds);
  fs.mkdirSync(paths.released, { recursive: true });
  // Keep the nonempty destination: a concurrent replay cannot rename a later
  // owner's active directory over this receipt. No TTL or unlink-based steal.
  fs.renameSync(paths.active, destination);
  fs.writeFileSync(path.join(destination, "release.json"), JSON.stringify({ owner, proof }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  return { released: true, alreadyReleased: false, receipt: destination };
}
