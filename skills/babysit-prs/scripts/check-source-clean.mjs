#!/usr/bin/env node
/**
 * Post-task source-cleanliness check.
 *
 * Judgment and verification steps routinely need a throwaway probe — a Python
 * snippet, a node one-liner, a SQL scratch file. Those belong in a mktemp
 * directory, never in the repository:
 *
 *     PROBE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/babysit-prs-probe.XXXXXX")"
 *     trap 'rm -rf "$PROBE_DIR"' EXIT
 *
 * A probe left in the repo root pollutes the diff under review, can be swept
 * into a fix commit, and makes "is this worktree clean?" unanswerable. Run this
 * after every judge/verifier task and after every mutation experiment.
 *
 * Exit 0 = clean. Exit 1 = residue found; report it as residual risk, and treat
 * it as a publish blocker when source cleanliness cannot be established.
 */

import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { writeJsonAtomic } from "./lib/json-io.mjs";

/** Names that scream "temporary probe" when found untracked in a checkout. */
const PROBE_HINTS = [
  /^probe[-_.]/i,
  /^scratch[-_.]/i,
  /^tmp[-_.]/i,
  /^debug[-_.]/i,
  /^check[-_.].*\.(py|mjs|cjs|js|sh|sql)$/i,
  /^test[-_.]probe/i,
  /\.probe\.(py|mjs|cjs|js|sh|sql)$/i,
  /^repro[-_.]/i
];

export function parsePorcelain(text) {
  return String(text ?? "")
    .split("\n")
    .filter(Boolean)
    .map((line) => ({
      status: line.slice(0, 2),
      pathname: line.slice(3).trim(),
      untracked: line.startsWith("??")
    }));
}

export function checkSourceClean(worktree, { expectedHead = null, allow = [] } = {}) {
  const cwd = path.resolve(worktree);
  const porcelain = spawnSync("git", ["status", "--porcelain"], { cwd, encoding: "utf8", timeout: 60000 });
  if (porcelain.status !== 0) {
    return {
      schemaVersion: 1,
      worktree: cwd,
      ok: false,
      reason: "not-a-git-worktree",
      entries: [],
      probeResidue: [],
      headOid: null,
      headMatches: null
    };
  }

  const entries = parsePorcelain(porcelain.stdout).filter(
    (entry) => !allow.some((pattern) => new RegExp(pattern).test(entry.pathname))
  );

  const probeResidue = entries.filter(
    (entry) => entry.untracked && PROBE_HINTS.some((re) => re.test(path.basename(entry.pathname)))
  );

  const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8", timeout: 60000 });
  const headOid = head.status === 0 ? head.stdout.trim() : null;
  const headMatches = expectedHead ? headOid === expectedHead : null;

  return {
    schemaVersion: 1,
    worktree: cwd,
    ok: entries.length === 0 && (expectedHead === null || headMatches === true),
    reason:
      entries.length > 0
        ? probeResidue.length > 0
          ? "probe-residue-in-repository"
          : "unexpected-working-tree-changes"
        : expectedHead && !headMatches
          ? "head-moved"
          : null,
    entries,
    probeResidue: probeResidue.map((entry) => entry.pathname),
    headOid,
    headMatches
  };
}

/* --------------------------------- CLI ---------------------------------- */

function parseArgv(argv) {
  const out = { _: [], allow: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      out._.push(token);
      continue;
    }
    const key = token.slice(2);
    if (key === "json" || key === "help") {
      out[key] = true;
      continue;
    }
    const next = argv[i + 1];
    if (next === undefined) throw new Error(`--${key} requires a value`);
    if (key === "allow") out.allow.push(next);
    else out[key] = next;
    i += 1;
  }
  return out;
}

const USAGE = `Usage:
  node check-source-clean.mjs --worktree <dir> [--expected-head <OID>] [--allow <regex>]... [--out <report.json>]

Exit codes: 0 clean, 1 residue or head moved, 2 usage error.
`;

function main(argv) {
  const args = parseArgv(argv);
  if (args.help || !args.worktree) {
    process.stdout.write(USAGE);
    return args.help ? 0 : 2;
  }

  const report = checkSourceClean(args.worktree, {
    expectedHead: args["expected-head"] ?? null,
    allow: args.allow
  });

  if (args.out) writeJsonAtomic(args.out, report);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  return report.ok ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}
