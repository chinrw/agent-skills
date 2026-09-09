import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const RUNNER = fileURLToPath(new URL("../run-controller.sh", import.meta.url));
const SKILL_DIR = fileURLToPath(new URL("../../../codex-skills/babysit-prs-codex", import.meta.url));

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
  execFileSync("git", ["init", "-b", "main", root], {stdio:"pipe"});
  const env = { ...process.env, PATH: `${root}:${process.env.PATH}`, BABYSIT_SKILL_DIR: SKILL_DIR };
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

test("a controller exiting without quiescence retains its shared lease", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "babysit-controller-lease-"));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  execFileSync("git",["init","-b","main",root],{stdio:"pipe"});
  fs.writeFileSync(path.join(root,"codex"),'#!/usr/bin/env node\nconsole.log(JSON.stringify({token:process.env.BABYSIT_CONTROLLER_TOKEN}));\n',{mode:0o755});
  const env={...process.env,PATH:`${root}:${process.env.PATH}`,BABYSIT_SKILL_DIR:SKILL_DIR};
  const first=spawnSync("bash",[RUNNER],{cwd:root,env,encoding:"utf8"});
  assert.equal(first.status,2,first.stderr);
  assert.ok(JSON.parse(first.stdout).token);
  const second=spawnSync("bash",[RUNNER],{cwd:root,env,encoding:"utf8"});
  assert.equal(second.status,75,second.stderr);
  assert.equal(JSON.parse(second.stdout).owner.runtime,"timer");
  const snapshot=spawnSync("bash",[RUNNER,"--snapshot-only"],{cwd:root,env,encoding:"utf8"});
  assert.equal(snapshot.status,0,snapshot.stderr);
  assert.equal(JSON.parse(snapshot.stdout).token,undefined);
});

test("the timer's token can be adopted and released by its native controller", t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"babysit-controller-adopt-"));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  execFileSync("git",["init","-b","main",root],{stdio:"pipe"});
  fs.writeFileSync(path.join(root,"codex"),`#!/usr/bin/env node
(async()=>{
 const {pathToFileURL}=require('node:url');
 const {assertLock,releaseLock}=await import(pathToFileURL(process.env.BABYSIT_SKILL_DIR+'/scripts/lib/repository-lock.mjs'));
 const token=process.env.BABYSIT_CONTROLLER_TOKEN;
 const {owner}=assertLock(process.cwd(),token);
 if(owner.runId!==process.env.BABYSIT_CONTROLLER_RUN)throw new Error('wrong run');
 releaseLock(process.cwd(),token,{...owner,observedAt:new Date().toISOString(),allTasksStopped:true,processesStopped:true,processIds:[],evidence:'Fake controller started no child tasks'});
 console.log(JSON.stringify({token}));
})().catch(error=>{console.error(error);process.exitCode=1;});
`,{mode:0o755});
  const env={...process.env,PATH:`${root}:${process.env.PATH}`,BABYSIT_SKILL_DIR:SKILL_DIR};
  const first=spawnSync("bash",[RUNNER],{cwd:root,env,encoding:"utf8"});
  const second=spawnSync("bash",[RUNNER],{cwd:root,env,encoding:"utf8"});
  assert.equal(first.status,0,first.stderr);assert.equal(second.status,0,second.stderr);
  assert.notEqual(JSON.parse(first.stdout).token,JSON.parse(second.stdout).token);
});
