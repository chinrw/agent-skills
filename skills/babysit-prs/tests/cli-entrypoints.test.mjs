/**
 * Every helper must work when invoked as a CLI *through a symlink*.
 *
 * This suite exists because of a real bug. The skill is installed as
 * `~/.claude/skills/babysit-prs -> ~/Documents/play/skills/skills/babysit-prs`,
 * and the original main-guard compared `path.resolve(process.argv[1])` with
 * `path.resolve(fileURLToPath(import.meta.url))`. `path.resolve` does not follow
 * symlinks but Node resolves `import.meta.url` to the real path, so through the
 * link the two never matched: every CLI parsed nothing, ran nothing, printed
 * nothing, and **exited 0**.
 *
 * A caller switching on that exit code read "success". `review-key.mjs classify`
 * silently reported three legacy markers as current acceptance.
 *
 * The rest of the test suite missed it because every other test imports the
 * modules directly, which never exercises the main guard. So: these tests shell
 * out, and they treat "exit 0 with empty stdout" as a failure rather than a
 * pass.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = path.join(HERE, "..");

const HEAD = "e363a839522e4960d372ce42125cce05c6a64e82";
const BASE = "7f1bc449f10686a1d013121c81c2c44e65a9637f";
const KEY = "90eb74228b4dd711956acd443b74c215d2212192b8ddabc57e499037e8ab0681";

/** A symlinked view of the whole skill directory, mimicking the installed layout. */
function linkedSkill() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "babysit-prs-cli-"));
  const link = path.join(root, "babysit-prs");
  fs.symlinkSync(fs.realpathSync(SKILL_DIR), link, "dir");
  return { root, link };
}

function run(scriptPath, args, options = {}) {
  const result = spawnSync(process.execPath, [scriptPath, ...args], {
    encoding: "utf8",
    timeout: 60000,
    ...options
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? ""
  };
}

const CLIS = [
  "review-key.mjs",
  "probe-codex-capabilities.mjs",
  "parse-codex-artifact.mjs",
  "reconcile-codex-artifacts.mjs",
  "codex-job.mjs",
  "mutation-evidence.mjs",
  "check-source-clean.mjs"
];

test("every CLI produces output through a symlinked install, never a silent exit 0", () => {
  const ws = linkedSkill();

  for (const name of CLIS) {
    const viaLink = path.join(ws.link, "scripts", name);
    const result = run(viaLink, ["--help"]);

    assert.ok(
      result.stdout.trim().length > 0,
      `${name}: --help produced NO stdout through the symlink (the silent no-op bug)`
    );
    assert.match(result.stdout, /Usage:/, `${name}: --help must print usage`);
    assert.equal(result.status, 0, `${name}: --help must exit 0`);
  }

  fs.rmSync(ws.root, { recursive: true, force: true });
});

test("a CLI invoked with no arguments does not silently succeed", () => {
  const ws = linkedSkill();

  // Each of these requires arguments; none may exit 0 having done nothing.
  for (const [name, args] of [
    ["parse-codex-artifact.mjs", []],
    ["reconcile-codex-artifacts.mjs", []],
    ["codex-job.mjs", []],
    ["check-source-clean.mjs", []],
    ["mutation-evidence.mjs", []]
  ]) {
    const result = run(path.join(ws.link, "scripts", name), args);
    assert.notEqual(result.status, 0, `${name}: missing required args must not exit 0`);
    assert.ok(
      (result.stdout + result.stderr).trim().length > 0,
      `${name}: must explain itself rather than exiting silently`
    );
  }

  fs.rmSync(ws.root, { recursive: true, force: true });
});

test("review-key.mjs computes the deployed key identically via symlink and real path", () => {
  const ws = linkedSkill();
  const args = ["--repo", "chinrw/stocks", "--pr", "379", "--head", HEAD, "--base", BASE, "--spec", "none"];

  const direct = run(path.join(SKILL_DIR, "scripts", "review-key.mjs"), args);
  const linked = run(path.join(ws.link, "scripts", "review-key.mjs"), args);

  assert.equal(direct.status, 0);
  assert.equal(linked.status, 0);
  assert.equal(direct.stdout.trim(), KEY);
  assert.equal(linked.stdout.trim(), KEY, "the symlinked invocation must produce the same key");

  fs.rmSync(ws.root, { recursive: true, force: true });
});

test("review-key.mjs classify exit codes are meaningful through the symlink", () => {
  const ws = linkedSkill();
  const cli = path.join(ws.link, "scripts", "review-key.mjs");

  // Exit 0 -- the active contract, PR 379.
  const current = run(cli, [
    "classify", "--repo", "chinrw/stocks", "--pr", "379",
    "--marker-key", KEY, "--marker-head", HEAD, "--marker-base", BASE, "--marker-spec", "none",
    "--head", HEAD, "--base", BASE, "--spec", "none"
  ]);
  assert.equal(current.status, 0);
  assert.equal(JSON.parse(current.stdout).current, true);

  // Exit 1 -- a recognized legacy dialect, PR 373. Under the broken guard this
  // returned exit 0 with no output, which a caller would read as "current".
  const legacy = run(cli, [
    "classify", "--repo", "chinrw/stocks", "--pr", "373",
    "--marker-key", "9ddeb2306d3984aa126ffab1ef76938edb859cd1a3c8e29a6518230733eb3c9d",
    "--marker-head", "375a4c5affafa00b98e25c5c44f314ea086f9add",
    "--marker-base", "be36e82d938a857917d7883e18eea26c1961c34f",
    "--marker-spec", "sha256:8360e882d80a89050577e33f99e7685e55c42ff11401c01178dc339f06300fe1",
    "--head", "375a4c5affafa00b98e25c5c44f314ea086f9add",
    "--base", "be36e82d938a857917d7883e18eea26c1961c34f",
    "--spec", "8360e882d80a89050577e33f99e7685e55c42ff11401c01178dc339f06300fe1"
  ]);
  assert.equal(legacy.status, 1, "a legacy marker must NOT exit 0");
  const legacyVerdict = JSON.parse(legacy.stdout);
  assert.equal(legacyVerdict.current, false);
  assert.equal(legacyVerdict.contract, "v2-legacy-trailing-nul");

  // Exit 3 -- unrecognized.
  const unknown = run(cli, [
    "classify", "--repo", "chinrw/stocks", "--pr", "379",
    "--marker-key", "f".repeat(64), "--marker-head", HEAD, "--marker-base", BASE, "--marker-spec", "none",
    "--head", HEAD, "--base", BASE, "--spec", "none"
  ]);
  assert.equal(unknown.status, 3);
  assert.equal(JSON.parse(unknown.stdout).contract, null);

  // The three outcomes must be distinguishable by exit code alone.
  assert.equal(new Set([current.status, legacy.status, unknown.status]).size, 3);

  fs.rmSync(ws.root, { recursive: true, force: true });
});

test("probe-codex-capabilities.mjs writes its artifact through the symlink", () => {
  const ws = linkedSkill();
  const out = path.join(ws.root, "caps.json");

  const result = run(path.join(ws.link, "scripts", "probe-codex-capabilities.mjs"), [
    "probe",
    "--companion", path.join(ws.link, "tests", "fixtures", "companions", "no-max.mjs"),
    "--no-codex-version",
    "--out", out
  ]);

  assert.equal(result.status, 0);
  assert.ok(fs.existsSync(out), "the capability artifact must actually be written");
  const artifact = JSON.parse(fs.readFileSync(out, "utf8"));
  assert.equal(artifact.effortCeiling, "xhigh");
  assert.equal(artifact.ambiguous, false);

  // An ambiguous probe must exit 3 so a caller can block on it.
  const ambiguous = run(path.join(ws.link, "scripts", "probe-codex-capabilities.mjs"), [
    "probe",
    "--companion", path.join(ws.link, "tests", "fixtures", "companions", "disagree.mjs"),
    "--no-codex-version"
  ]);
  assert.equal(ambiguous.status, 3, "an ambiguous probe must not exit 0");

  fs.rmSync(ws.root, { recursive: true, force: true });
});

test("parse-codex-artifact.mjs distinguishes accept from reject by exit code", () => {
  const ws = linkedSkill();
  const cli = path.join(ws.link, "scripts", "parse-codex-artifact.mjs");

  const good = {
    schemaVersion: 1,
    taskType: "review",
    attemptId: "att-0123456789abcdef01",
    pr: 379,
    headOid: HEAD,
    baseOid: BASE,
    reviewKey: KEY,
    resultCompleteness: "complete",
    findings: []
  };

  const stdoutFile = path.join(ws.root, "stdout.txt");
  fs.writeFileSync(
    stdoutFile,
    `Done.\n\nBABYSIT_PR_ARTIFACT_V1\n\`\`\`json\n${JSON.stringify(good, null, 2)}\n\`\`\`\n`
  );
  assert.equal(run(cli, ["--stdout", stdoutFile]).status, 0);

  // Count-only telemetry: no sentinel at all.
  const countOnly = path.join(ws.root, "count-only.txt");
  fs.writeFileSync(countOnly, "Review interrupted.\nblocking=2\nfindings=3\n");
  const rejected = run(cli, ["--stdout", countOnly]);
  assert.equal(rejected.status, 1, "count-only output must exit non-zero");
  assert.match(rejected.stdout, /stdout-sentinel-missing/);

  fs.rmSync(ws.root, { recursive: true, force: true });
});

test("the main guard resolves symlinks on both sides", async () => {
  const { isMainModule } = await import("../scripts/lib/cli.mjs");
  const { pathToFileURL } = await import("node:url");

  // Under `node --test <file>`, this test file IS process.argv[1].
  assert.equal(isMainModule(import.meta.url), true, "the entry module is main");

  // A module that is not the entry point is not main.
  const other = path.join(SKILL_DIR, "scripts", "review-key.mjs");
  assert.equal(isMainModule(pathToFileURL(other).href), false);

  // The property that was broken: a symlinked argv[1] and the real module path
  // are lexically different but resolve to the same file. The old guard compared
  // them lexically and therefore never matched through an installed symlink.
  const ws = linkedSkill();
  const linkedSelf = path.join(ws.link, "scripts", "review-key.mjs");
  const realSelf = fs.realpathSync(other);

  assert.notEqual(
    path.resolve(linkedSelf),
    path.resolve(realSelf),
    "the fixture must differ lexically, or it proves nothing"
  );
  assert.equal(
    fs.realpathSync(linkedSelf),
    realSelf,
    "but they resolve to the same real file -- which is what the guard compares"
  );

  fs.rmSync(ws.root, { recursive: true, force: true });
});
