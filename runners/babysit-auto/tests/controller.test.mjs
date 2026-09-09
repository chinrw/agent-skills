import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const RUNNER = fileURLToPath(new URL("../run-controller.sh", import.meta.url));

test("the default contract path uses the installed native skill without a Claude install", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "babysit-native-install-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, ".agents/skills/babysit-prs-codex");
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(fileURLToPath(new URL("../../../codex-skills/babysit-prs-codex/SKILL.md", import.meta.url)), path.join(dir, "SKILL.md"));
  fs.mkdirSync(path.join(dir, "references"));
  fs.copyFileSync(fileURLToPath(new URL("../../../codex-skills/babysit-prs-codex/references/workflow.md", import.meta.url)), path.join(dir, "references/workflow.md"));
  const env = { ...process.env, HOME: root };
  delete env.BABYSIT_SKILL_DIR;
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("../tick-gate.mjs", import.meta.url)), "contract"], { env, encoding: "utf8" });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "CONTRACT-OK");
});

test("the runner configures effort without requiring an operator attestation", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "babysit-controller-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const fake = path.join(root, "codex");
  fs.writeFileSync(fake, '#!/usr/bin/env node\nconsole.log(JSON.stringify({argv:process.argv.slice(2),cwd:process.cwd()}));\nprocess.exitCode=Number(process.env.FAKE_EXIT ?? 0);\n', { mode: 0o755 });
  const env = { ...process.env, PATH: `${root}:${process.env.PATH}` };
  const result = spawnSync("bash", [RUNNER, "--snapshot-only"], { cwd: root, env, encoding: "utf8" });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  const call = JSON.parse(result.stdout);
  assert.equal(call.cwd, root);
  assert.deepEqual(call.argv, [
    "exec", "--cd", root, "--sandbox", "workspace-write", "--approve-for-me",
    "-c", "sandbox_workspace_write.network_access=true",
    "-c", 'model_reasoning_effort="xhigh"',
    "Use babysit-prs-codex: --snapshot-only"
  ]);
  const failed = spawnSync("bash", [RUNNER], { cwd: root, env: { ...env, FAKE_EXIT: "17" }, encoding: "utf8" });
  assert.ifError(failed.error);
  assert.equal(failed.status, 17, "controller failure must reach systemd");
});
