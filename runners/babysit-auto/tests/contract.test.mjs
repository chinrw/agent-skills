import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  PINNED_MARKER_TEMPLATE,
  PINNED_STATES,
  extractMarkerTemplate,
  extractStates,
  verifyContract,
  readSkillContract,
} from "../lib/contract.mjs";
import { parseMarker } from "../lib/marker.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../../..");
const SKILL_MD = readSkillContract(path.join(REPO, "codex-skills/babysit-prs-codex"));

test("both native entrypoints expose the same current marker and state contract", () => {
  const claude = readSkillContract(path.join(REPO, "skills/babysit-prs"));
  assert.equal(claude, SKILL_MD);
  assert.deepEqual(verifyContract(claude), { ok: true, drift: [] });
});

test("legacy inline contracts remain supported and a missing shared workflow fails", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "babysit-contract-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, "SKILL.md"), SKILL_MD);
  assert.deepEqual(verifyContract(readSkillContract(dir)), { ok: true, drift: [] });
  fs.writeFileSync(path.join(dir, "SKILL.md"), "Read [workflow](references/workflow.md).\n");
  assert.throws(() => readSkillContract(dir), /ENOENT/);
});

// This is the guard that makes a separate runner safe: the runner reads state
// the skill publishes, and nothing at runtime would notice if that shape moved.

test("the pinned marker template still matches the skill in this repo", () => {
  assert.equal(extractMarkerTemplate(SKILL_MD), PINNED_MARKER_TEMPLATE);
});

test("the pinned state list still matches section 9 of the skill in this repo", () => {
  assert.deepEqual(extractStates(SKILL_MD), PINNED_STATES);
});

test("the real skill passes the contract check", () => {
  assert.deepEqual(verifyContract(SKILL_MD), { ok: true, drift: [] });
});

test("every field the template declares is one the parser knows", () => {
  // Only the <PLACEHOLDER> tokens; a looser pattern eats the "<!--" opener too.
  const parsed = parseMarker(PINNED_MARKER_TEMPLATE.replace(/<[A-Z][A-Z0-9_-]*>/g, "x"));
  assert.equal(parsed.found, true);
  assert.deepEqual(parsed.warnings, []);
  for (const field of ["pr", "head", "base", "spec", "key", "state", "codex", "codexRound", "codexNextTriggerAt"]) {
    assert.equal(field in parsed.fields, true, `parser dropped ${field}`);
  }
});

test("a reworded marker template is reported as drift, not absorbed", () => {
  const mutated = SKILL_MD.replace(PINNED_MARKER_TEMPLATE, PINNED_MARKER_TEMPLATE.replace("codexRound=<N>", "round=<N>"));
  const result = verifyContract(mutated);
  assert.equal(result.ok, false);
  assert.match(result.drift.join("\n"), /marker template changed/);
});

test("a new state is reported as drift, because the gate would loop on it forever", () => {
  const mutated = SKILL_MD.replace("WAITING_CI\n", "WAITING_CI\nWAITING_HUMAN\n");
  const result = verifyContract(mutated);
  assert.equal(result.ok, false);
  assert.match(result.drift.join("\n"), /states added since this runner was pinned: WAITING_HUMAN/);
});

test("a removed state is reported as drift", () => {
  const mutated = SKILL_MD.replace("READY_STACKED\n", "");
  const result = verifyContract(mutated);
  assert.equal(result.ok, false);
  assert.match(result.drift.join("\n"), /states removed: READY_STACKED/);
});

test("a SKILL.md with no marker template at all fails loudly", () => {
  const result = verifyContract("# not the skill\n");
  assert.equal(result.ok, false);
  assert.equal(result.drift.length, 2);
});
