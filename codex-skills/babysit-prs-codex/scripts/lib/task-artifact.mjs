import { fileURLToPath } from "node:url";
import { canonicalHash, canonicalize, readJson } from "./json-io.mjs";
import { validate } from "./schema.mjs";

const SCHEMA_PATH = fileURLToPath(new URL("../../schemas/codex-artifact-v1.schema.json", import.meta.url));
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
