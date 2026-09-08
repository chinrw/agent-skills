/**
 * The artifact contract a Codex task sees must be generated from the schema
 * itself, not restated by hand in prompts or prose.
 *
 * Background (chinrw/agent-skills#1, migrated from chinrw/stocks#483): two
 * full Codex runs were wasted because the prompt-level contract and
 * codex-artifact-v1.schema.json disagreed — a fix task put commit fields at
 * the top level, a review task put pr/attemptId inside findings, and both were
 * REJECTED_SCHEMA at collect. These tests pin the same-source guarantee.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { renderArtifactContract } from "../scripts/validate-artifact.mjs";
import { validate } from "../scripts/lib/schema.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.join(HERE, "..", "schemas", "codex-artifact-v1.schema.json");
const SCHEMA = JSON.parse(fs.readFileSync(SCHEMA_PATH, "utf8"));

const OID = "e363a839522e4960d372ce42125cce05c6a64e82";
const KEY = "90eb74228b4dd711956acd443b74c215d2212192b8ddabc57e499037e8ab0681";

/* --------------------------- contract rendering --------------------------- */

test("the rendered contract enumerates every top-level schema key", () => {
  const text = renderArtifactContract("review");
  for (const key of Object.keys(SCHEMA.properties)) {
    assert.ok(text.includes(key), `top-level key ${key} missing from contract`);
  }
  for (const key of SCHEMA.required) {
    assert.ok(text.includes(key), `required key ${key} missing from contract`);
  }
});

test("the rendered contract enumerates finding keys and the identity split", () => {
  const text = renderArtifactContract("review");
  for (const key of Object.keys(SCHEMA.definitions.finding.properties)) {
    assert.ok(text.includes(key), `finding key ${key} missing from contract`);
  }
  // The exact ambiguity that wasted a Sol review: pr/attemptId are top-level
  // only, while headOid/baseOid/reviewKey repeat inside every finding.
  assert.ok(/pr and attemptId are TOP-LEVEL ONLY/.test(text));
  for (const sev of SCHEMA.definitions.finding.properties.severity.enum) {
    assert.ok(text.includes(sev), `severity ${sev} missing from contract`);
  }
});

test("a fix task additionally gets the fix nesting and the no-commit rule", () => {
  const text = renderArtifactContract("fix");
  for (const key of Object.keys(SCHEMA.definitions.fix.properties)) {
    assert.ok(text.includes(key), `fix key ${key} missing from contract`);
  }
  assert.ok(/Do NOT run git commit/.test(text));
  // A read-only review must not carry fix-lane instructions.
  assert.ok(!/Do NOT run git commit/.test(renderArtifactContract("review")));
});

/* ------------------------- schema: optional commit ------------------------ */

function fixArtifact(fix) {
  return {
    schemaVersion: 1,
    taskType: "fix",
    attemptId: "att-0123456789abcdef01",
    pr: 483,
    headOid: OID,
    baseOid: OID,
    reviewKey: KEY,
    resultCompleteness: "complete",
    findings: [],
    fix
  };
}

test("a fix artifact without fix.commit validates (the controller owns the commit)", () => {
  const errors = validate(SCHEMA, fixArtifact({ changedFiles: ["a.rs"], closedFindingIds: ["R1"] }));
  assert.deepEqual(errors, []);
});

test("a fix artifact with fix.commit null validates", () => {
  const errors = validate(
    SCHEMA,
    fixArtifact({ commit: null, changedFiles: ["a.rs"], closedFindingIds: ["R1"] })
  );
  assert.deepEqual(errors, []);
});

test("a fix artifact still requires changedFiles and closedFindingIds", () => {
  assert.notDeepEqual(validate(SCHEMA, fixArtifact({ closedFindingIds: [] })), []);
  assert.notDeepEqual(validate(SCHEMA, fixArtifact({ changedFiles: [] })), []);
});

test("a controller-recorded fix.commit still validates as a full OID", () => {
  const errors = validate(
    SCHEMA,
    fixArtifact({ commit: OID, changedFiles: ["a.rs"], closedFindingIds: ["R1"] })
  );
  assert.deepEqual(errors, []);
  assert.notDeepEqual(
    validate(SCHEMA, fixArtifact({ commit: "abc123", changedFiles: ["a.rs"], closedFindingIds: [] })),
    []
  );
});
