/**
 * Is a `/babysit-prs` run already active on this checkout?
 *
 * The skill has no lock of its own, and the unit's `flock` only stops one tick
 * from overlapping another. Without this check a timer tick would run beside a
 * person driving the skill at a terminal, and both would push, comment and
 * merge against the same PRs at once.
 *
 * Two signals, either of which counts:
 *
 *   - a live process whose cwd is under `<checkout>/.claude/worktrees/`: review
 *     and fix attempts run there, and can go a long time without touching the
 *     run directory;
 *   - anything under `<checkout>/.claude/babysit-prs/runs/` written inside the
 *     window: the controller writes there between attempts.
 *
 * A false busy delays one tick. A false idle is the collision. So the window
 * is generous, and the walk trusts no directory mtime — a directory's mtime
 * moves on entry creation, not on writes to the files below it.
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

export const DEFAULT_BUSY_WINDOW_SECONDS = 1800;

/** Run directories nest attempt artifacts a few levels down; nothing legitimate is deeper. */
const MAX_DEPTH = 8;

/**
 * `{ busy, reason }`. `procCwds` is injected so the decision is testable
 * without a real process; `listProcessCwds()` supplies it in production.
 */
export function findActiveRun({ checkout, now, windowMs, procCwds }) {
  const worktrees = path.join(checkout, ".claude", "worktrees") + path.sep;
  for (const proc of procCwds) {
    if (typeof proc.cwd === "string" && proc.cwd.startsWith(worktrees)) {
      const name = proc.cwd.slice(worktrees.length).split(path.sep)[0];
      return { busy: true, reason: `process-in-worktree:${proc.pid}:${proc.comm}:${name}` };
    }
  }

  const runs = path.join(checkout, ".claude", "babysit-prs", "runs");
  const recent = newestRunWriteSince(runs, now - windowMs);
  if (recent) {
    const ageMinutes = Math.max(0, Math.round((now - recent.mtimeMs) / 60000));
    return { busy: true, reason: `run-dir-written:${recent.runId}:${ageMinutes}m-ago` };
  }

  return { busy: false, reason: null };
}

/** Every process this user can see, with its cwd. Linux only; empty elsewhere. */
export function listProcessCwds() {
  if (process.platform !== "linux") {
    return [];
  }
  let names;
  try {
    names = fs.readdirSync("/proc");
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    if (!/^\d+$/.test(name)) {
      continue;
    }
    const pid = Number(name);
    if (pid === process.pid) {
      continue;
    }
    let cwd;
    try {
      cwd = fs.readlinkSync(`/proc/${name}/cwd`);
    } catch {
      continue; // Another user's process, or one that exited mid-scan.
    }
    out.push({ pid, cwd, comm: processName(name) });
  }
  return out;
}

function newestRunWriteSince(runsDir, thresholdMs) {
  let entries;
  try {
    entries = fs.readdirSync(runsDir, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") {
      return null; // Never run here: nothing to be busy with.
    }
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const hit = firstWriteSince(path.join(runsDir, entry.name), thresholdMs, 0);
    if (hit !== null) {
      return { runId: entry.name, mtimeMs: hit };
    }
  }
  return null;
}

/** Depth-first, short-circuits on the first path written at or after the threshold. */
function firstWriteSince(dir, thresholdMs, depth) {
  const own = mtimeOf(dir);
  if (own !== null && own >= thresholdMs) {
    return own;
  }
  if (depth >= MAX_DEPTH) {
    return null;
  }
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) {
      continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const hit = firstWriteSince(full, thresholdMs, depth + 1);
      if (hit !== null) {
        return hit;
      }
      continue;
    }
    const mtime = mtimeOf(full);
    if (mtime !== null && mtime >= thresholdMs) {
      return mtime;
    }
  }
  return null;
}

function mtimeOf(file) {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * The executable's basename, falling back to `comm`. Node renames its main
 * thread to `MainThread`, so `comm` alone would label every node process the
 * same. Cosmetic either way; the cwd is the evidence.
 */
function processName(pid) {
  try {
    return path.basename(fs.readlinkSync(`/proc/${pid}/exe`));
  } catch {
    // exe is unreadable for another user's process; comm usually is not.
  }
  try {
    return fs.readFileSync(`/proc/${pid}/comm`, "utf8").trim();
  } catch {
    return "?";
  }
}
