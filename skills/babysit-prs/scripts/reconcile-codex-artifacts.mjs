#!/usr/bin/env node
/**
 * Dual-channel artifact reconciliation and canonical persistence.
 *
 * Implements, in code rather than as an LLM instruction:
 *
 *   codex_result_valid =
 *       terminal_status == success
 *   AND stdout_sentinel_present
 *   AND stdout_json_schema_valid
 *   AND identity_fields_match
 *   AND resultCompleteness == complete
 *   AND ( staging_artifact_absent
 *         OR canonical_hash(staging_json) == canonical_hash(stdout_json) )
 *
 * Channel roles:
 *   CANONICAL_RUN_DIR  controller-owned, in the main checkout/run workspace
 *   LAUNCH_CWD         the exact checkout/worktree the Codex task ran from
 *   STAGING_ARTIFACT   inside LAUNCH_CWD; only for write-enabled tasks
 *   CANONICAL_ARTIFACT under CANONICAL_RUN_DIR; written by the CONTROLLER only
 *
 * Codex is never asked to write outside LAUNCH_CWD. The controller — not Codex —
 * places a validated result into CANONICAL_ARTIFACT.
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { canonicalHash, readJson, writeJsonAtomic, writeTextAtomic } from "./lib/json-io.mjs";
import { resolveWithinRoot } from "./lib/paths.mjs";
import { runCli } from "./lib/cli.mjs";
import { parseArtifact, summarize, validateArtifactObject } from "./parse-codex-artifact.mjs";

export const DECISIONS = {
  ACCEPT: "ACCEPT",
  BLOCKED_CHANNEL_MISMATCH: "BLOCKED_ARTIFACT_CHANNEL_MISMATCH",
  REJECTED_SCHEMA: "REJECTED_SCHEMA",
  REJECTED_IDENTITY: "REJECTED_IDENTITY_MISMATCH",
  REJECTED_PATH_ESCAPE: "REJECTED_STAGING_PATH_ESCAPE",
  INCOMPLETE: "INCOMPLETE_RERUN_REQUIRED"
};

/**
 * @param {object} input
 * @param {string} input.stdout             raw task stdout
 * @param {string} input.launchCwd          LAUNCH_CWD (containment root for staging)
 * @param {string} input.canonicalArtifact  destination under CANONICAL_RUN_DIR
 * @param {string} [input.stagingArtifactPath] path as reported by the task; untrusted
 * @param {string} [input.diagnosticsDir]   where raw channels are kept on mismatch
 * @param {object} [input.expected]         identity the controller demands
 * @param {string} [input.terminalStatus]   companion terminal status
 * @param {boolean} [input.writeMode]
 * @param {boolean} [input.dryRun]          skip the canonical write
 */
export function reconcile(input) {
  const expected = input.expected ?? {};
  const reasons = [];

  const terminalStatus = String(input.terminalStatus ?? "success").toLowerCase();
  const terminalOk = terminalStatus === "success" || terminalStatus === "succeeded" || terminalStatus === "completed";
  if (!terminalOk) {
    reasons.push(`terminal-status=${terminalStatus}`);
  }

  /* ---------------------------- stdout channel ---------------------------- */

  const stdoutResult = parseArtifact(input.stdout ?? "", expected);

  /* ---------------------------- staging channel --------------------------- */

  let staging = { present: false, ok: false, artifact: null, sha256: null, path: null, errors: [] };

  if (input.stagingArtifactPath) {
    const contained = resolveWithinRoot(input.launchCwd, input.stagingArtifactPath);
    if (!contained.ok) {
      return finish({
        decision: DECISIONS.REJECTED_PATH_ESCAPE,
        rerunRequired: true,
        transport: null,
        reasons: [
          ...reasons,
          `staging-artifact-path-rejected:${contained.reason}`,
          "A task may only name a path inside its own LAUNCH_CWD."
        ],
        stdoutResult,
        staging,
        input
      });
    }

    staging.path = contained.path;
    if (fs.existsSync(contained.path)) {
      staging.present = true;
      try {
        const parsed = readJson(contained.path);
        const validated = validateArtifactObject(parsed, expected);
        staging.ok = validated.ok;
        staging.artifact = parsed;
        staging.errors = validated.errors;
        staging.sha256 = validated.ok ? validated.sha256 : safeHash(parsed);
      } catch (error) {
        staging.errors = [`staging-unparseable: ${error instanceof Error ? error.message : String(error)}`];
        staging.sha256 = null;
      }
    }
  }

  /* ------------------------------ decisions ------------------------------- */

  // A write-enabled task with a staging file but no stdout sentinel is
  // INCOMPLETE, not acceptable: every task is required to echo its result.
  if (!stdoutResult.sentinelPresent) {
    return finish({
      decision: DECISIONS.INCOMPLETE,
      rerunRequired: true,
      transport: null,
      reasons: [
        ...reasons,
        "stdout-sentinel-missing",
        ...(staging.present
          ? ["staging-artifact-present-but-file-alone-is-never-sufficient"]
          : [])
      ],
      stdoutResult,
      staging,
      input
    });
  }

  if (!stdoutResult.ok) {
    const identityOnly =
      stdoutResult.errors.length > 0 &&
      stdoutResult.errors.every((entry) => entry.startsWith("identity-mismatch:"));
    const completenessOnly =
      stdoutResult.errors.length > 0 &&
      stdoutResult.errors.every((entry) => entry.startsWith("resultCompleteness="));

    if (identityOnly) {
      return finish({
        decision: DECISIONS.REJECTED_IDENTITY,
        rerunRequired: true,
        transport: null,
        reasons: [...reasons, ...stdoutResult.errors],
        stdoutResult,
        staging,
        input
      });
    }

    return finish({
      decision: completenessOnly ? DECISIONS.INCOMPLETE : DECISIONS.REJECTED_SCHEMA,
      rerunRequired: true,
      transport: null,
      reasons: [...reasons, ...stdoutResult.errors],
      stdoutResult,
      staging,
      input
    });
  }

  // Both channels present: they must agree exactly. Never silently prefer one.
  if (staging.present) {
    const stagingHash = staging.ok ? staging.sha256 : safeHash(staging.artifact);
    if (!staging.ok || stagingHash !== stdoutResult.sha256) {
      return finish({
        decision: DECISIONS.BLOCKED_CHANNEL_MISMATCH,
        rerunRequired: false,
        transport: null,
        reasons: [
          ...reasons,
          "artifact-channel-mismatch",
          `stdout.sha256=${stdoutResult.sha256}`,
          `staging.sha256=${stagingHash ?? "unparseable"}`,
          ...staging.errors
        ],
        stdoutResult,
        staging,
        input
      });
    }
  }

  if (!terminalOk) {
    return finish({
      decision: DECISIONS.INCOMPLETE,
      rerunRequired: true,
      transport: null,
      reasons,
      stdoutResult,
      staging,
      input
    });
  }

  const transport = staging.present ? "stdout+staging" : "stdout-only";

  let canonicalSha256 = stdoutResult.sha256;
  if (!input.dryRun && input.canonicalArtifact) {
    canonicalSha256 = writeJsonAtomic(input.canonicalArtifact, stdoutResult.artifact);
  }

  return finish({
    decision: DECISIONS.ACCEPT,
    rerunRequired: false,
    transport,
    reasons,
    stdoutResult,
    staging,
    input,
    canonicalSha256
  });
}

function finish(ctx) {
  const {
    decision,
    rerunRequired,
    transport,
    reasons,
    stdoutResult,
    staging,
    input,
    canonicalSha256
  } = ctx;

  const accepted = decision === DECISIONS.ACCEPT;

  // On any non-accept outcome, retain BOTH raw channels for inspection. They are
  // diagnostics, never evidence: nothing downstream may read them as findings.
  let diagnostics = null;
  if (!accepted && input.diagnosticsDir) {
    diagnostics = persistDiagnostics(input, staging, decision);
  }

  return {
    schemaVersion: 1,
    decision,
    accepted,
    rerunRequired: Boolean(rerunRequired),
    transport,
    reasons,
    canonicalArtifactPath: accepted && input.canonicalArtifact ? path.resolve(input.canonicalArtifact) : null,
    canonicalSha256: accepted ? (canonicalSha256 ?? stdoutResult.sha256) : null,
    stdout: {
      sentinelPresent: stdoutResult.sentinelPresent,
      valid: stdoutResult.ok,
      sha256: stdoutResult.sha256,
      errors: stdoutResult.errors
    },
    staging: {
      present: staging.present,
      valid: staging.ok,
      sha256: staging.sha256,
      path: staging.path,
      errors: staging.errors
    },
    diagnosticsDir: diagnostics,
    summary: accepted ? summarize(stdoutResult.artifact) : null
  };
}

function persistDiagnostics(input, staging, decision) {
  const dir = path.resolve(input.diagnosticsDir);
  try {
    fs.mkdirSync(dir, { recursive: true });
    writeTextAtomic(path.join(dir, "stdout.raw.txt"), input.stdout ?? "");
    if (staging.present && staging.path && fs.existsSync(staging.path)) {
      writeTextAtomic(path.join(dir, "staging.raw.json"), fs.readFileSync(staging.path, "utf8"));
    }
    writeJsonAtomic(path.join(dir, "README.json"), {
      schemaVersion: 1,
      decision,
      warning:
        "Diagnostic copies of the raw Codex channels. NOT evidence. No finding, blocker, GitHub comment, fix task, or acceptance may be derived from these files.",
      capturedAt: new Date().toISOString()
    });
    return dir;
  } catch {
    return null;
  }
}

function safeHash(value) {
  try {
    return value === null || value === undefined ? null : canonicalHash(value);
  } catch {
    return null;
  }
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
    if (key === "json" || key === "help" || key === "write-mode" || key === "dry-run") {
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
  node reconcile-codex-artifacts.mjs \\
    --stdout <task-stdout.txt> \\
    --launch-cwd <LAUNCH_CWD> \\
    --canonical <CANONICAL_RUN_DIR/pr-N/codex-review.json> \\
    [--staging <path-relative-to-launch-cwd>] \\
    [--diagnostics <dir>] \\
    [--expect <expectations.json>] \\
    [--terminal-status success] [--write-mode] [--dry-run] \\
    [--decision-out <decision.json>]

Exit codes: 0 ACCEPT, 1 rejected/incomplete, 4 BLOCKED artifact-channel-mismatch, 2 usage error.
`;

function main(argv) {
  const args = parseArgv(argv);
  if (args.help || !args.stdout || !args["launch-cwd"]) {
    process.stdout.write(USAGE);
    return args.help ? 0 : 2;
  }

  const decision = reconcile({
    stdout: fs.readFileSync(args.stdout, "utf8"),
    launchCwd: args["launch-cwd"],
    canonicalArtifact: args.canonical,
    stagingArtifactPath: args.staging,
    diagnosticsDir: args.diagnostics,
    expected: args.expect ? readJson(args.expect) : {},
    terminalStatus: args["terminal-status"] ?? "success",
    writeMode: Boolean(args["write-mode"]),
    dryRun: Boolean(args["dry-run"])
  });

  if (args["decision-out"]) {
    writeJsonAtomic(args["decision-out"], decision);
  }
  process.stdout.write(`${JSON.stringify(decision, null, 2)}\n`);

  if (decision.decision === DECISIONS.BLOCKED_CHANNEL_MISMATCH) return 4;
  return decision.accepted ? 0 : 1;
}

runCli(import.meta.url, main);
