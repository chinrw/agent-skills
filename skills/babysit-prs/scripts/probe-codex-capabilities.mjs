#!/usr/bin/env node
/**
 * Probe what the *installed* Codex companion actually accepts, once per
 * invocation, before any task is dispatched.
 *
 * Why this exists: the babysit-prs lanes are specified in logical terms
 * ("deep review runs at max"), but a given companion build accepts only a fixed
 * effort enum. Codex CLI 0.145.0 / companion 1.0.6 accepts
 * none|minimal|low|medium|high|xhigh and rejects `max`. Discovering that by
 * launching a task and watching it fail costs one wasted round *per task* and
 * pollutes the run with a failure that is not a review failure.
 *
 * So: normalize effort at preflight, never at retry.
 *
 * Inspection is non-executing by design. We do not launch a review to find out
 * whether an effort is valid:
 *   1. declared-enum  — parse VALID_REASONING_EFFORTS out of the companion
 *                       source. This is the enum the companion validates
 *                       against, so it is authoritative.
 *   2. usage-text     — run `codex-companion.mjs --help`, which only prints
 *                       usage, and parse the `--effort <a|b|c>` alternation.
 *   3. codex-cli-version — `codex --version`, recorded for the report only.
 *
 * If (1) and (2) disagree, or neither yields a set, the probe is `ambiguous`
 * and Codex-dependent remote writes must be blocked rather than guessed.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { readJson, writeJsonAtomic } from "./lib/json-io.mjs";
import { assertValid } from "./lib/schema.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.join(HERE, "..", "schemas", "codex-capabilities-v1.schema.json");

/**
 * The logical effort ladder, weakest first. `max` sits above `xhigh` and is a
 * legitimate *request* even where no companion accepts it.
 */
export const EFFORT_SCALE = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];

export class CapabilityError extends Error {}

export function effortRank(effort) {
  const index = EFFORT_SCALE.indexOf(String(effort).trim().toLowerCase());
  if (index < 0) {
    throw new CapabilityError(
      `Unknown effort "${effort}". Known ladder: ${EFFORT_SCALE.join(" < ")}`
    );
  }
  return index;
}

/**
 * Highest accepted effort that does not exceed the request.
 *
 * Never maps upward: asking for `low` on a companion that also accepts `xhigh`
 * still yields `low`.
 */
export function normalizeEffort(requested, capabilities) {
  const want = String(requested).trim().toLowerCase();
  const wantRank = effortRank(want);

  if (!capabilities || capabilities.ambiguous) {
    return {
      requested: want,
      effective: null,
      downgraded: false,
      blocked: true,
      reason: "capability-probe-ambiguous"
    };
  }

  const accepted = (capabilities.acceptedEfforts ?? []).filter((entry) =>
    EFFORT_SCALE.includes(entry)
  );
  const candidates = accepted.filter((entry) => effortRank(entry) <= wantRank);

  if (candidates.length === 0) {
    return {
      requested: want,
      effective: null,
      downgraded: false,
      blocked: true,
      reason: accepted.length === 0 ? "no-accepted-efforts" : "no-accepted-effort-at-or-below-request"
    };
  }

  const effective = candidates.reduce((best, entry) =>
    effortRank(entry) > effortRank(best) ? entry : best
  );

  return {
    requested: want,
    effective,
    downgraded: effective !== want,
    blocked: false,
    reason: effective === want ? null : "companion-ceiling"
  };
}

/* ------------------------------ discovery ------------------------------- */

export function discoverCompanionPath(explicit) {
  const candidates = [];

  if (explicit) {
    candidates.push(explicit);
  }
  if (process.env.BABYSIT_PRS_CODEX_COMPANION) {
    candidates.push(process.env.BABYSIT_PRS_CODEX_COMPANION);
  }
  if (process.env.CLAUDE_PLUGIN_ROOT) {
    candidates.push(path.join(process.env.CLAUDE_PLUGIN_ROOT, "scripts", "codex-companion.mjs"));
  }

  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) {
      return path.resolve(candidate);
    }
  }

  // Newest installed plugin version wins.
  const cacheRoot = path.join(os.homedir(), ".claude", "plugins", "cache", "openai-codex", "codex");
  let versions = [];
  try {
    versions = fs.readdirSync(cacheRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort(compareVersionsDesc);
  } catch {
    versions = [];
  }

  for (const version of versions) {
    const candidate = path.join(cacheRoot, version, "scripts", "codex-companion.mjs");
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  throw new CapabilityError(
    "Could not locate codex-companion.mjs. Pass --companion <path> or set BABYSIT_PRS_CODEX_COMPANION."
  );
}

function compareVersionsDesc(a, b) {
  const pa = String(a).split(".").map((n) => Number.parseInt(n, 10) || 0);
  const pb = String(b).split(".").map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const diff = (pb[i] ?? 0) - (pa[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return String(b).localeCompare(String(a));
}

/* ------------------------------ inspection ------------------------------ */

export function parseDeclaredEnum(source) {
  // e.g. const VALID_REASONING_EFFORTS = new Set(["none", "minimal", ...]);
  const match = source.match(
    /VALID_REASONING_EFFORTS\s*=\s*new\s+Set\s*\(\s*\[([^\]]*)\]\s*\)/
  );
  if (!match) {
    return null;
  }
  const efforts = [...match[1].matchAll(/["'`]([a-zA-Z]+)["'`]/g)].map((m) => m[1].toLowerCase());
  return efforts.length > 0 ? efforts : null;
}

export function parseUsageText(text) {
  // e.g. [--effort <none|minimal|low|medium|high|xhigh>]
  const match = String(text).match(/--effort\s*<([^>]+)>/);
  if (!match) {
    return null;
  }
  const efforts = match[1]
    .split("|")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => /^[a-z]+$/.test(entry));
  return efforts.length > 0 ? efforts : null;
}

function runCompanionHelp(companionPath) {
  const result = spawnSync(process.execPath, [companionPath, "--help"], {
    encoding: "utf8",
    timeout: 20000
  });
  return {
    ok: result.status === 0 && !result.error,
    text: `${result.stdout ?? ""}\n${result.stderr ?? ""}`,
    detail: result.error ? String(result.error.message) : `exit=${result.status}`
  };
}

function readCodexVersion() {
  const result = spawnSync("codex", ["--version"], { encoding: "utf8", timeout: 20000 });
  if (result.error || result.status !== 0) {
    return { ok: false, version: null, detail: result.error ? String(result.error.message) : `exit=${result.status}` };
  }
  const text = `${result.stdout ?? ""}`.trim();
  const line = text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean).pop() ?? null;
  return { ok: true, version: line, detail: null };
}

export function probe({ companionPath, includeCodexVersion = true } = {}) {
  const resolvedCompanion = discoverCompanionPath(companionPath);
  const sources = [];

  let declared = null;
  try {
    declared = parseDeclaredEnum(fs.readFileSync(resolvedCompanion, "utf8"));
    sources.push({
      name: "declared-enum",
      ok: declared !== null,
      efforts: declared,
      detail: declared ? null : "VALID_REASONING_EFFORTS not found in companion source"
    });
  } catch (error) {
    sources.push({
      name: "declared-enum",
      ok: false,
      efforts: null,
      detail: `unreadable companion source: ${error instanceof Error ? error.message : String(error)}`
    });
  }

  const help = runCompanionHelp(resolvedCompanion);
  const fromUsage = help.ok ? parseUsageText(help.text) : null;
  sources.push({
    name: "usage-text",
    ok: fromUsage !== null,
    efforts: fromUsage,
    detail: fromUsage ? null : `no --effort alternation in usage (${help.detail})`
  });

  let codexVersion = null;
  if (includeCodexVersion) {
    const cli = readCodexVersion();
    codexVersion = cli.version;
    sources.push({ name: "codex-cli-version", ok: cli.ok, efforts: null, detail: cli.detail ?? cli.version });
  }

  const { accepted, ambiguous, ambiguityReason } = reconcileSources(declared, fromUsage);

  const artifact = {
    schemaVersion: 1,
    codexVersion,
    companionPath: resolvedCompanion,
    companionVersion: inferCompanionVersion(resolvedCompanion),
    acceptedEfforts: accepted,
    effortCeiling: accepted.length > 0
      ? accepted.reduce((best, entry) => (effortRank(entry) > effortRank(best) ? entry : best))
      : null,
    ambiguous,
    ambiguityReason,
    sources,
    probedAt: new Date().toISOString()
  };

  assertValid(readJson(SCHEMA_PATH), artifact, "capability artifact");
  return artifact;
}

function reconcileSources(declared, fromUsage) {
  const clean = (list) =>
    (list ?? []).filter((entry) => EFFORT_SCALE.includes(entry)).sort((a, b) => effortRank(a) - effortRank(b));

  const a = clean(declared);
  const b = clean(fromUsage);

  if (a.length === 0 && b.length === 0) {
    return {
      accepted: [],
      ambiguous: true,
      ambiguityReason:
        "Neither the declared companion enum nor its usage text yielded an accepted-effort set. Codex-dependent remote writes are blocked; pass --companion or upgrade the plugin."
    };
  }

  if (a.length > 0 && b.length > 0 && a.join(",") !== b.join(",")) {
    return {
      accepted: [],
      ambiguous: true,
      ambiguityReason: `Inspection sources disagree: declared-enum=[${a.join(",")}] usage-text=[${b.join(",")}]. Refusing to guess.`
    };
  }

  return { accepted: a.length > 0 ? a : b, ambiguous: false, ambiguityReason: null };
}

function inferCompanionVersion(companionPath) {
  const match = path.resolve(companionPath).match(/\/codex\/([0-9][^/]*)\/scripts\//);
  return match ? match[1] : null;
}

export function loadCapabilities(artifactPath) {
  const artifact = readJson(artifactPath);
  assertValid(readJson(SCHEMA_PATH), artifact, "capability artifact");
  return artifact;
}

/* --------------------------------- CLI ---------------------------------- */

function parseArgv(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      out._.push(token);
      continue;
    }
    const key = token.slice(2);
    if (key === "json" || key === "help" || key === "no-codex-version") {
      out[key] = true;
      continue;
    }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      throw new CapabilityError(`--${key} requires a value`);
    }
    out[key] = next;
    i += 1;
  }
  return out;
}

const USAGE = `Usage:
  node probe-codex-capabilities.mjs probe [--companion <path>] [--out <artifact.json>] [--json]
  node probe-codex-capabilities.mjs normalize --requested <effort> --capabilities <artifact.json> [--json]

Exit codes:
  0  ok
  2  usage / internal error
  3  capability detection ambiguous, or no accepted effort at or below the
     request -- Codex-dependent remote writes must be blocked
`;

function main(argv) {
  const args = parseArgv(argv);
  const command = args._[0] ?? "probe";

  if (args.help) {
    process.stdout.write(USAGE);
    return 0;
  }

  if (command === "probe") {
    const artifact = probe({
      companionPath: args.companion,
      includeCodexVersion: !args["no-codex-version"]
    });
    if (args.out) {
      writeJsonAtomic(args.out, artifact);
    }
    process.stdout.write(`${JSON.stringify(artifact, null, 2)}\n`);
    return artifact.ambiguous ? 3 : 0;
  }

  if (command === "normalize") {
    if (!args.requested || !args.capabilities) {
      throw new CapabilityError("normalize requires --requested and --capabilities");
    }
    const decision = normalizeEffort(args.requested, loadCapabilities(args.capabilities));
    process.stdout.write(`${JSON.stringify(decision, null, 2)}\n`);
    return decision.blocked ? 3 : 0;
  }

  process.stderr.write(USAGE);
  return 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}
