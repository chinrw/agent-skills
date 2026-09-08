#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalHash, canonicalize, readJson, writeJsonAtomic } from "./lib/json-io.mjs";
import { validate } from "./lib/schema.mjs";
import { runCli } from "./lib/cli.mjs";

const SCHEMA_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "schemas", "codex-artifact-v1.schema.json");
const IDENTITY_FIELDS = ["taskType", "pr", "headOid", "baseOid", "reviewKey", "attemptId"];
export function artifactSchema() {
  return readJson(SCHEMA_PATH);
}

function identityErrors(artifact, expected) {
  const errors = [];
  const check = (field, want, got) => {
    if (want === undefined || want === null) return;
    if (want !== got) {
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
  };
}

/**
 * Validate result identity and completeness before publishing evidence.
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
  };
}

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

export function renderArtifactContract(taskType) {
  const schema = readJson(SCHEMA_PATH);
  const finding = schema.definitions.finding;
  const lines = [
    "ARTIFACT CONTRACT (schemas/codex-artifact-v1.schema.json defines the allowed keys and validation rules):",
    `- Top-level allowed keys: ${Object.keys(schema.properties).join(", ")}.`,
    `- Top-level required keys: ${schema.required.join(", ")}. schemaVersion is the constant 1.`,
    "- pr and attemptId are TOP-LEVEL ONLY — they must never appear inside a finding.",
    `- Each finding allows only: ${Object.keys(finding.properties).join(", ")}. Required: ${finding.required.join(", ")} — headOid, baseOid, reviewKey are the per-finding identity fields, echoed exactly as given.`,
    `- finding.severity must be one of: ${finding.properties.severity.enum.join(", ")}.`,
    `- resultCompleteness must be one of: ${schema.properties.resultCompleteness.enum.join(", ")}.`
  ];
  if (taskType === "fix") {
    const fix = schema.definitions.fix;
    lines.push(
      `- Fix results nest under the top-level "fix" object. Allowed keys: ${Object.keys(fix.properties).join(", ")}. Required: ${fix.required.join(", ")}.`,
      "- Do NOT run git commit. Leave changes uncommitted and omit fix.commit (or set it null); the controller owns the signed commit and records its OID after validation."
    );
  }
  return lines.join("\n");
}

// Task completion comes from the native lifecycle tool, never from result JSON.
export function acceptArtifact({ input, output, expected = {}, status }) {
  const errors = [];
  if (status !== "completed") errors.push(`task-status=${status ?? "missing"}`);
  for (const field of IDENTITY_FIELDS) {
    if (expected[field] === undefined || expected[field] === null || expected[field] === "") {
      errors.push(`expected-identity-missing:${field}`);
    }
  }
  if (errors.length) return { ok: false, errors, sha256: null, summary: null };
  let artifact;
  try {
    artifact = readJson(input);
  } catch (error) {
    return { ok: false, errors: [`artifact-unreadable:${error.message}`], sha256: null, summary: null };
  }
  const result = validateArtifactObject(artifact, expected);
  if (result.ok && output) writeJsonAtomic(output, artifact);
  return { ok: result.ok, errors: result.errors, sha256: result.sha256, summary: result.ok ? summarize(artifact) : null };
}

const USAGE = `Usage:
  node validate-artifact.mjs --input <result.json> --expect <identity.json> --status completed [--out <canonical.json>]
  node validate-artifact.mjs contract --task-type <review|risk-review|fix|diagnosis|mutation>

Exit codes: 0 accepted, 1 rejected, 2 usage error.
`;

function main(argv) {
  if (argv.includes("--help")) {
    process.stdout.write(USAGE);
    return 0;
  }
  const command = argv[0] === "contract" ? argv.shift() : "validate";
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i].startsWith("--") || !argv[i + 1] || argv[i + 1].startsWith("--")) throw new Error(USAGE);
    args[argv[i].slice(2)] = argv[i + 1];
  }
  if (command === "contract") {
    if (!artifactSchema().properties.taskType.enum.includes(args["task-type"])) throw new Error(USAGE);
    process.stdout.write(`${renderArtifactContract(args["task-type"])}\n`);
    return 0;
  }
  if (!args.input || !args.expect || !args.status) throw new Error(USAGE);
  const result = acceptArtifact({ input: args.input, output: args.out, expected: readJson(args.expect), status: args.status });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result.ok ? 0 : 1;
}

runCli(import.meta.url, main);
