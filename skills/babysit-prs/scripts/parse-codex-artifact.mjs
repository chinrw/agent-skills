#!/usr/bin/env node
/**
 * Extract and validate the mandatory stdout result block from a Codex task.
 *
 * Every Codex task — read-only review or write-enabled fix — must end its final
 * response with exactly one machine-readable block:
 *
 *     BABYSIT_PR_ARTIFACT_V1
 *     ```json
 *     { "schemaVersion": 1, ... }
 *     ```
 *
 * stdout is the *authoritative* transport. A read-only review runs with the
 * companion sandbox at `read-only`, so it physically cannot write a file
 * anywhere; a completed review must not be lost because of that. A write-
 * enabled task additionally leaves a staging file inside its launch cwd, but
 * that file is the redundant channel, not the primary one.
 *
 * This module is deliberately strict:
 *   - more than one sentinel block  -> ambiguous, rejected (never "prefer the
 *     last one" — silently picking a channel is how wrong evidence lands)
 *   - anything but whitespace after the closing fence -> not the FINAL block
 *   - schema failure, identity mismatch, or resultCompleteness != "complete"
 *     -> rejected
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { canonicalHash, canonicalize, readJson } from "./lib/json-io.mjs";
import { validate } from "./lib/schema.mjs";
import { runCli } from "./lib/cli.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.join(HERE, "..", "schemas", "codex-artifact-v1.schema.json");

export const SENTINEL = "BABYSIT_PR_ARTIFACT_V1";

let cachedSchema = null;
export function artifactSchema() {
  if (!cachedSchema) {
    cachedSchema = readJson(SCHEMA_PATH);
  }
  return cachedSchema;
}

/**
 * Locate every sentinel-introduced fenced JSON block in `text`.
 * Returns `[{ json, start, end, endsAtEof }]` in document order.
 */
export function findSentinelBlocks(text, sentinel = SENTINEL) {
  const source = String(text ?? "");
  const blocks = [];

  // Sentinel must sit alone on its own line; a fenced ```json block must follow,
  // separated only by blank lines.
  const sentinelRe = new RegExp(`^[ \\t]*${escapeRe(sentinel)}[ \\t]*$`, "gm");

  for (const match of source.matchAll(sentinelRe)) {
    const afterSentinel = match.index + match[0].length;
    const rest = source.slice(afterSentinel);

    const fenceMatch = rest.match(/^(?:[ \t]*\r?\n)*[ \t]*```[ \t]*(?:json)?[ \t]*\r?\n/i);
    if (!fenceMatch) {
      blocks.push({ json: null, start: match.index, end: afterSentinel, malformed: "no-json-fence-after-sentinel" });
      continue;
    }

    const bodyStart = afterSentinel + fenceMatch[0].length;
    const closeMatch = source.slice(bodyStart).match(/^[ \t]*```[ \t]*$/m);
    if (!closeMatch) {
      blocks.push({ json: null, start: match.index, end: source.length, malformed: "unterminated-json-fence" });
      continue;
    }

    const bodyEnd = bodyStart + closeMatch.index;
    const blockEnd = bodyEnd + closeMatch[0].length;

    blocks.push({
      json: source.slice(bodyStart, bodyEnd),
      start: match.index,
      end: blockEnd,
      endsAtEof: source.slice(blockEnd).trim() === "",
      malformed: null
    });
  }

  return blocks;
}

function escapeRe(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * @param {string} stdout raw task stdout
 * @param {object} expected identity the controller demands
 * @returns {{ok:boolean, errors:string[], artifact:object|null, canonicalJson:string|null, sha256:string|null, sentinelPresent:boolean}}
 */
export function parseArtifact(stdout, expected = {}) {
  const errors = [];
  const blocks = findSentinelBlocks(stdout, expected.sentinel ?? SENTINEL);

  if (blocks.length === 0) {
    return fail(["stdout-sentinel-missing"], { sentinelPresent: false });
  }
  if (blocks.length > 1) {
    return fail(
      [`multiple-sentinel-blocks:${blocks.length}`],
      { sentinelPresent: true }
    );
  }

  const [block] = blocks;
  if (block.malformed) {
    return fail([`malformed-sentinel-block:${block.malformed}`], { sentinelPresent: true });
  }
  if (!block.endsAtEof) {
    return fail(["sentinel-block-is-not-the-final-structured-block"], { sentinelPresent: true });
  }

  let artifact;
  try {
    artifact = JSON.parse(block.json);
  } catch (error) {
    return fail(
      [`stdout-json-unparseable: ${error instanceof Error ? error.message : String(error)}`],
      { sentinelPresent: true }
    );
  }

  let schemaErrors;
  try {
    schemaErrors = validate(artifactSchema(), artifact);
  } catch (error) {
    return fail(
      [`schema-engine-error: ${error instanceof Error ? error.message : String(error)}`],
      { sentinelPresent: true }
    );
  }
  if (schemaErrors.length > 0) {
    return fail(schemaErrors.map((entry) => `schema: ${entry}`), { sentinelPresent: true, artifact });
  }

  errors.push(...identityErrors(artifact, expected));

  if (artifact.resultCompleteness !== "complete") {
    errors.push(`resultCompleteness=${artifact.resultCompleteness} (only "complete" is evidence)`);
  }

  errors.push(...findingIdentityErrors(artifact));

  if (errors.length > 0) {
    return fail(errors, { sentinelPresent: true, artifact });
  }

  return {
    ok: true,
    errors: [],
    artifact,
    canonicalJson: canonicalize(artifact),
    sha256: canonicalHash(artifact),
    sentinelPresent: true
  };
}

function identityErrors(artifact, expected) {
  const errors = [];
  const check = (field, want, got) => {
    if (want === undefined || want === null) return;
    const a = typeof want === "string" ? want.toLowerCase() : want;
    const b = typeof got === "string" ? got.toLowerCase() : got;
    if (a !== b) {
      errors.push(`identity-mismatch:${field} expected=${want} got=${got}`);
    }
  };

  check("taskType", expected.taskType, artifact.taskType);
  check("pr", expected.pr, artifact.pr);
  check("headOid", expected.headOid, artifact.headOid);
  check("baseOid", expected.baseOid, artifact.baseOid);
  check("reviewKey", expected.reviewKey, artifact.reviewKey);
  check("attemptId", expected.attemptId, artifact.attemptId);

  return errors;
}

/**
 * A finding carries its own head/base/reviewKey so stale output from attempt N
 * cannot be laundered into attempt N+1 by wrapping it in a fresh envelope.
 */
function findingIdentityErrors(artifact) {
  const errors = [];
  for (const finding of artifact.findings ?? []) {
    if (finding.headOid !== artifact.headOid) {
      errors.push(`finding ${finding.id}: headOid does not match the artifact envelope`);
    }
    if (finding.baseOid !== artifact.baseOid) {
      errors.push(`finding ${finding.id}: baseOid does not match the artifact envelope`);
    }
    if (finding.reviewKey !== artifact.reviewKey) {
      errors.push(`finding ${finding.id}: reviewKey does not match the artifact envelope`);
    }
  }
  return errors;
}

function fail(errors, extra = {}) {
  return {
    ok: false,
    errors,
    artifact: extra.artifact ?? null,
    canonicalJson: null,
    sha256: null,
    sentinelPresent: Boolean(extra.sentinelPresent)
  };
}

/**
 * Validate a staging/canonical artifact object that did not arrive over stdout.
 */
export function validateArtifactObject(artifact, expected = {}) {
  let schemaErrors;
  try {
    schemaErrors = validate(artifactSchema(), artifact);
  } catch (error) {
    return fail([`schema-engine-error: ${error instanceof Error ? error.message : String(error)}`]);
  }
  if (schemaErrors.length > 0) {
    return fail(schemaErrors.map((entry) => `schema: ${entry}`), { artifact });
  }

  const errors = [...identityErrors(artifact, expected), ...findingIdentityErrors(artifact)];
  if (artifact.resultCompleteness !== "complete") {
    errors.push(`resultCompleteness=${artifact.resultCompleteness} (only "complete" is evidence)`);
  }
  if (errors.length > 0) {
    return fail(errors, { artifact });
  }

  return {
    ok: true,
    errors: [],
    artifact,
    canonicalJson: canonicalize(artifact),
    sha256: canonicalHash(artifact),
    sentinelPresent: false
  };
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
    if (key === "json" || key === "help") {
      out[key] = true;
      continue;
    }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      throw new Error(`--${key} requires a value`);
    }
    out[key] = next;
    i += 1;
  }
  return out;
}

const USAGE = `Usage:
  node parse-codex-artifact.mjs --stdout <file> [--expect <expectations.json>] [--json]

Exit codes: 0 accepted, 1 rejected, 2 usage error.
`;

function main(argv) {
  const args = parseArgv(argv);
  if (args.help || !args.stdout) {
    process.stdout.write(USAGE);
    return args.help ? 0 : 2;
  }

  const expected = args.expect ? readJson(args.expect) : {};
  const result = parseArtifact(fs.readFileSync(args.stdout, "utf8"), expected);

  process.stdout.write(
    `${JSON.stringify(
      {
        ok: result.ok,
        errors: result.errors,
        sentinelPresent: result.sentinelPresent,
        sha256: result.sha256,
        summary: summarize(result.artifact)
      },
      null,
      2
    )}\n`
  );

  return result.ok ? 0 : 1;
}

/**
 * Compact handoff shape. Detailed findings stay in the artifact on disk and
 * never enter the controller's context.
 */
export function summarize(artifact) {
  if (!artifact) return null;
  return {
    taskType: artifact.taskType,
    attemptId: artifact.attemptId,
    pr: artifact.pr,
    headOid: artifact.headOid,
    baseOid: artifact.baseOid,
    reviewKey: artifact.reviewKey,
    resultCompleteness: artifact.resultCompleteness,
    findingCount: Array.isArray(artifact.findings) ? artifact.findings.length : 0,
    blockingCount: Array.isArray(artifact.findings)
      ? artifact.findings.filter((f) => f.severity === "blocking").length
      : 0,
    findingIds: Array.isArray(artifact.findings) ? artifact.findings.map((f) => f.id) : []
  };
}

runCli(import.meta.url, main);
