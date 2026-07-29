import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  EFFORT_SCALE,
  normalizeEffort,
  parseDeclaredEnum,
  parseUsageText,
  probe
} from "../scripts/probe-codex-capabilities.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const COMPANIONS = path.join(HERE, "fixtures", "companions");

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "babysit-prs-effort-"));
}

test("the effort ladder places max above xhigh", () => {
  assert.deepEqual(EFFORT_SCALE, ["none", "minimal", "low", "medium", "high", "xhigh", "max"]);
});

test("a companion that stops at xhigh normalizes a max request BEFORE launch", () => {
  const capabilities = probe({
    companionPath: path.join(COMPANIONS, "no-max.mjs"),
    includeCodexVersion: false
  });

  assert.equal(capabilities.ambiguous, false);
  assert.equal(capabilities.effortCeiling, "xhigh");
  assert.deepEqual(capabilities.acceptedEfforts, ["none", "minimal", "low", "medium", "high", "xhigh"]);

  const decision = normalizeEffort("max", capabilities);
  assert.deepEqual(decision, {
    requested: "max",
    effective: "xhigh",
    downgraded: true,
    blocked: false,
    reason: "companion-ceiling"
  });
});

test("a companion that accepts max keeps max", () => {
  const capabilities = probe({
    companionPath: path.join(COMPANIONS, "with-max.mjs"),
    includeCodexVersion: false
  });

  assert.equal(capabilities.ambiguous, false);
  assert.equal(capabilities.effortCeiling, "max");

  const decision = normalizeEffort("max", capabilities);
  assert.equal(decision.effective, "max");
  assert.equal(decision.downgraded, false);
  assert.equal(decision.blocked, false);
});

test("normalization never maps upward", () => {
  const capabilities = probe({
    companionPath: path.join(COMPANIONS, "with-max.mjs"),
    includeCodexVersion: false
  });

  for (const requested of ["none", "minimal", "low", "medium", "high", "xhigh"]) {
    const decision = normalizeEffort(requested, capabilities);
    assert.equal(decision.effective, requested, `${requested} must not be raised`);
    assert.equal(decision.downgraded, false);
  }
});

test("disagreeing inspection sources are ambiguous and block, rather than guessing", () => {
  const capabilities = probe({
    companionPath: path.join(COMPANIONS, "disagree.mjs"),
    includeCodexVersion: false
  });

  assert.equal(capabilities.ambiguous, true);
  assert.equal(capabilities.effortCeiling, null);
  assert.deepEqual(capabilities.acceptedEfforts, []);
  assert.match(capabilities.ambiguityReason, /disagree/i);

  const decision = normalizeEffort("max", capabilities);
  assert.equal(decision.blocked, true);
  assert.equal(decision.effective, null);
  assert.equal(decision.reason, "capability-probe-ambiguous");
});

test("an opaque companion is ambiguous and blocks", () => {
  const capabilities = probe({
    companionPath: path.join(COMPANIONS, "opaque.mjs"),
    includeCodexVersion: false
  });

  assert.equal(capabilities.ambiguous, true);
  assert.equal(normalizeEffort("high", capabilities).blocked, true);
});

test("the probe never launches a task: inspection is source + usage text only", () => {
  const capabilities = probe({
    companionPath: path.join(COMPANIONS, "no-max.mjs"),
    includeCodexVersion: false
  });

  const names = capabilities.sources.map((entry) => entry.name).sort();
  assert.deepEqual(names, ["declared-enum", "usage-text"]);
  // Both non-executing sources independently agreed; no review was dispatched.
  assert.ok(capabilities.sources.every((entry) => entry.ok));
});

test("the capability artifact is generated once and reused for every task in the invocation", () => {
  const dir = tmpdir();
  const artifactPath = path.join(dir, "codex-capabilities.json");

  const first = probe({ companionPath: path.join(COMPANIONS, "no-max.mjs"), includeCodexVersion: false });
  fs.writeFileSync(artifactPath, JSON.stringify(first, null, 2));

  const loadedA = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
  const loadedB = JSON.parse(fs.readFileSync(artifactPath, "utf8"));

  // Every lane request in the invocation resolves against the same artifact,
  // producing the same effective effort with no extra probing.
  assert.equal(loadedA.probedAt, loadedB.probedAt);
  for (const lane of ["max", "max", "high", "max"]) {
    assert.equal(normalizeEffort(lane, loadedA).effective, lane === "max" ? "xhigh" : lane);
  }

  fs.rmSync(dir, { recursive: true, force: true });
});

test("declared-enum and usage-text parsers read the real installed companion consistently", () => {
  const real = "/home/chin39/.claude/plugins/cache/openai-codex/codex/1.0.6/scripts/codex-companion.mjs";
  if (!fs.existsSync(real)) {
    return; // Environment-dependent; the fixture cases already cover the logic.
  }
  const declared = parseDeclaredEnum(fs.readFileSync(real, "utf8"));
  assert.deepEqual(declared, ["none", "minimal", "low", "medium", "high", "xhigh"]);
  assert.equal(declared.includes("max"), false, "companion 1.0.6 does not accept max");
});

test("usage-text parsing extracts the --effort alternation", () => {
  assert.deepEqual(
    parseUsageText("  task [--effort <none|minimal|low|medium|high|xhigh>] [prompt]"),
    ["none", "minimal", "low", "medium", "high", "xhigh"]
  );
  assert.equal(parseUsageText("task [prompt]"), null);
});

test("an unknown effort name is an error, not a silent pass-through", () => {
  const capabilities = probe({ companionPath: path.join(COMPANIONS, "no-max.mjs"), includeCodexVersion: false });
  assert.throws(() => normalizeEffort("ludicrous", capabilities), /Unknown effort/);
});
