import path from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalHash, readJson } from "./json-io.mjs";
import { validate } from "./schema.mjs";
import { checkSourceClean } from "../check-source-clean.mjs";
import { validateArtifactObject } from "./task-artifact.mjs";
import { computeReviewKey } from "../review-key.mjs";

const SCHEMA_PATH = fileURLToPath(new URL("../../schemas/checkpoint-artifact-v1.schema.json", import.meta.url));

export function checkpointSchema() {
  return readJson(SCHEMA_PATH);
}

export function validateCheckpoint(artifact, expected) {
  const errors = validate(checkpointSchema(), artifact).map(error => `schema: ${error}`);
  if (errors.length) return { ok: false, errors, sha256: null };
  for (const field of ["checkpointType", "attemptId", "pr", "subject"]) {
    if (expected[field] === undefined || canonicalHash(expected[field]) !== canonicalHash(artifact[field])) {
      errors.push(`identity-mismatch:${field}`);
    }
  }
  if (artifact.resultCompleteness !== "complete") errors.push(`resultCompleteness=${artifact.resultCompleteness}`);
  if (artifact.verdict === "ACCEPT" && artifact.result.blocking?.length) errors.push("ACCEPT-has-blockers");
  const result = artifact.result;
  if (artifact.checkpointType === "spec-selector") {
    if (artifact.verdict === "NONE" && (result.specPaths.length || result.specHash !== "none")) errors.push("NONE-has-specification");
    if (artifact.verdict === "SELECTED" && (!result.specPaths.length || result.specHash === "none")) errors.push("SELECTED-missing-specification");
  }
  const expectedHashes = {};
  const inputArtifacts = {};
  for (const [role, input] of Object.entries(expected.inputs ?? {})) {
    expectedHashes[role] = input.sha256;
    if (!path.isAbsolute(input.path ?? "") || !/^[0-9a-f]{64}$/.test(input.sha256 ?? "")) {
      errors.push(`invalid-input-reference:${role}`);
      continue;
    }
    try {
      inputArtifacts[role] = readJson(input.path);
      if (canonicalHash(inputArtifacts[role]) !== input.sha256) errors.push(`input-hash-mismatch:${role}`);
    } catch (error) {
      errors.push(`input-unreadable:${role}:${error.message}`);
    }
  }
  if (canonicalHash(expectedHashes) !== canonicalHash(artifact.inputs)) errors.push("input-identities-mismatch");
  const invalidInputs = inputErrors(artifact, inputArtifacts, expected.repo);
  errors.push(...invalidInputs);
  if (!invalidInputs.length) errors.push(...judgmentErrors(artifact, inputArtifacts));
  if (!path.isAbsolute(expected.worktree ?? "")) {
    errors.push("expected-worktree-missing");
  } else {
    const subject = expected.subject ?? {};
    const head = subject.fixCommit ?? subject.newParentHead ?? subject.headOid;
    if (!head) errors.push("expected-source-head-missing");
    else {
      const clean = checkSourceClean(expected.worktree, { expectedHead: head });
      if (!clean.ok) errors.push(`source-not-clean:${clean.reason}`);
    }
  }
  return { ok: errors.length === 0, errors, sha256: errors.length ? null : canonicalHash(artifact) };
}

function inputErrors(artifact, inputs, repo) {
  const errors = [];
  const subject = artifact.subject;
  const task = (role, types, head) => {
    const input = inputs[role];
    const checked = validateArtifactObject(input, {
      pr: artifact.pr, headOid: head, baseOid: subject.baseOid, reviewKey: subject.reviewKey
    });
    if (!checked.ok || !types.includes(input?.taskType)) errors.push(`invalid-input-evidence:${role}`);
    if (input?.specHash !== undefined && input.specHash !== subject.specHash) errors.push(`input-spec-mismatch:${role}`);
    return checked.ok;
  };
  const prior = (role) => {
    const input = inputs[role];
    if (validate(checkpointSchema(), input).length || input.resultCompleteness !== "complete") {
      errors.push(`invalid-input-evidence:${role}`);
      return null;
    }
    return input;
  };
  if (artifact.checkpointType === "finding-judge") task("review", ["review", "risk-review"], subject.headOid);
  if (artifact.checkpointType === "verifier") {
    task("fix", ["fix"], subject.parentHead);
    if (inputs.fix?.fix?.commit !== subject.fixCommit) errors.push("input-fix-commit-mismatch");
    const required = new Set();
    const seen = new Map();
    for (const role of ["findings", ...["riskFindings", "threadFindings"].filter(name => inputs[name] !== undefined)]) {
      const findings = prior(role);
      if (!findings) continue;
      if (!["finding-judge", "thread-judge"].includes(findings.checkpointType) || findings.pr !== artifact.pr ||
          findings.subject.headOid !== subject.parentHead || findings.subject.baseOid !== subject.baseOid ||
          findings.subject.reviewKey !== subject.reviewKey || findings.subject.specHash !== subject.specHash) {
        errors.push(`input-findings-identity-mismatch:${role}`);
        continue;
      }
      const dispositions = findings.checkpointType === "finding-judge" ? findings.result.findings : findings.result.dispositions;
      if (artifact.verdict === "ACCEPT" &&
          (["BLOCKED", "INCONCLUSIVE", "NEEDS_HUMAN"].includes(findings.verdict) ||
           dispositions.some(row => row.classification === "NEEDS_HUMAN"))) {
        errors.push(`unresolved-input-judgment:${role}`);
      }
      const rows = findings.checkpointType === "finding-judge"
        ? dispositions.filter(row => row.classification.startsWith("CONFIRMED_"))
        : dispositions.filter(row => row.classification === "REAL_FIX_REQUIRED").map(row => row.finding);
      for (const row of rows) {
        if (!row) { errors.push(`input-thread-finding-missing:${role}`); continue; }
        const hash = canonicalHash(row);
        if (seen.has(row.id) && seen.get(row.id) !== hash) errors.push(`ambiguous-finding-id:${row.id}`);
        seen.set(row.id, hash);
        required.add(row.id);
      }
    }
    if ((inputs.fix?.fix?.closedFindingIds ?? []).some(id => !required.has(id))) errors.push("fix-claims-unassigned-finding");
    if (artifact.result.closedFindingIds.some(id => !required.has(id))) errors.push("verifier-claims-unassigned-finding");
    if (artifact.verdict === "ACCEPT" && canonicalHash([...required].sort()) !== canonicalHash([...artifact.result.closedFindingIds].sort())) errors.push("ACCEPT-missing-finding-closure");

  }
  if (artifact.checkpointType.endsWith("composition-verifier")) {
    for (const role of ["parent", "child"]) {
      const input = prior(role);
      if (!input) continue;
      if (input.verdict !== "ACCEPT" || input.result.blocking?.length ||
          input.result.findings?.some(row => ["CONFIRMED_BLOCKING", "NEEDS_HUMAN"].includes(row.classification))) {
        errors.push(`input-not-accepted:${role}`);
        continue;
      }
      const identity = input.subject;
      const head = identity.headOid ?? identity.fixCommit ?? identity.newParentHead;
      let key = identity.reviewKey;
      if (!key && identity.newParentHead) {
        try {
          key = computeReviewKey({ repo, pr: input.pr, headOid: head, baseOid: identity.baseOid, specHash: identity.specHash });
        } catch { errors.push(`input-review-key-unavailable:${role}`); }
      }
      const parent = role === "parent";
      if (head !== (parent ? subject.oldParentHead : subject.childHead) ||
          key !== (parent ? subject.parentReviewKey : subject.childReviewKey) ||
          identity.baseOid !== (parent ? subject.baseOid : subject.oldParentHead) ||
          (parent && (input.pr !== artifact.pr || identity.specHash !== subject.specHash)) ||
          (!parent && input.pr === artifact.pr)) errors.push(`input-role-identity-mismatch:${role}`);
    }
  }
  return errors;
}

function judgmentErrors(artifact, inputs) {
  const errors = [];
  const covers = (wanted, actual) => {
    if (!Array.isArray(wanted) || wanted.some(id => typeof id !== "string") ||
        new Set(actual).size !== actual.length ||
        canonicalHash([...wanted].sort()) !== canonicalHash([...actual].sort())) errors.push("judgment-does-not-cover-assignment");
  };
  if (artifact.checkpointType === "finding-judge") {
    const rows = artifact.result.findings;
    covers(inputs.review?.findings?.map(row => row.id), rows.map(row => row.id));
    const blocking = rows.some(row => row.classification === "CONFIRMED_BLOCKING");
    if (artifact.verdict === "ACCEPT" && (blocking || rows.some(row => row.classification === "NEEDS_HUMAN"))) errors.push("ACCEPT-has-unresolved-findings");
    if (artifact.verdict === "NEEDS_FIX" && !blocking) errors.push("NEEDS_FIX-missing-finding");
    for (const row of rows) {
      if (row.classification.startsWith("CONFIRMED_") && (!row.file || !row.line || !row.comment)) errors.push(`finding-location-or-comment-missing:${row.id}`);
    }
  }
  if (artifact.checkpointType === "thread-judge") {
    const rows = artifact.result.dispositions;
    const assigned = Array.isArray(inputs.threads) ? inputs.threads : inputs.threads?.threads;
    covers(assigned?.map(row => row.id), rows.map(row => row.threadId));
    for (const row of rows) {
      const unresolved = ["REAL_FIX_REQUIRED", "NEEDS_HUMAN"].includes(row.classification);
      if (row.resolve && (unresolved || !row.reply?.trim())) errors.push(`thread-not-resolvable:${row.threadId}`);
      if (row.classification === "REAL_FIX_REQUIRED" && !row.finding) errors.push(`thread-finding-missing:${row.threadId}`);
      if (artifact.verdict === "DISPOSED" && unresolved) errors.push("DISPOSED-has-unresolved-thread");
    }
  }
  return errors;
}

export function checkpointSummary(artifact) {
  return {
    checkpointType: artifact.checkpointType, attemptId: artifact.attemptId,
    pr: artifact.pr, verdict: artifact.verdict, resultCompleteness: artifact.resultCompleteness
  };
}

export function renderCheckpointContract(kind) {
  const schema = checkpointSchema();
  const variant = schema.oneOf.find(entry => entry.properties.checkpointType.const === kind);
  if (!variant) throw new Error(`unknown checkpoint: ${kind}`);
  const subject = schema.definitions[variant.properties.subject.$ref.split("/").at(-1)];
  const result = schema.definitions[variant.properties.result.$ref.split("/").at(-1)];
  return [
    "CHECKPOINT CONTRACT (schemas/checkpoint-artifact-v1.schema.json):",
    `Envelope keys: ${schema.required.join(", ")}. No other envelope keys.`,
    `checkpointType=${kind}; schemaVersion=1. Echo attemptId, pr and subject exactly.`,
    `Subject keys: ${subject.required.join(", ")}.`,
    `Required input roles: ${(variant.properties.inputs.required ?? []).join(", ") || "none"}. Echo each assigned input's canonical SHA-256 in inputs.`,
    `Verdicts: ${variant.properties.verdict.enum.join(", ")}. Admission does not turn REJECT or BLOCKED into ACCEPT.`,
    `Result keys: ${Object.keys(result.properties).join(", ")}. Required: ${result.required.join(", ")}.`,
    'Read the schema for nested result fields. Set resultCompleteness="complete" only after finishing.'
  ].join("\n");
}
