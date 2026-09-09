import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import test from "node:test";
import { acquireLock, inspectLock, releaseLock } from "../scripts/lib/repository-lock.mjs";

const moduleUrl = new URL("../scripts/lib/repository-lock.mjs", import.meta.url).href;
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "controller-lock-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, "repo"); fs.mkdirSync(repo);
  const git = (...args) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
  git("init", "-b", "main"); git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.invalid"); git("config", "commit.gpgsign", "false");
  git("commit", "--allow-empty", "-m", "fixture");
  return { repo, root, git };
}
const proof = owner => ({ ...owner, observedAt: new Date().toISOString(), allTasksStopped: true,
  processesStopped: true, processIds: [], evidence: "Fixture has no model tasks or surviving subprocesses" });

test("Claude, Codex, and timer contenders acquire only one repository lease", async t => {
  const { repo } = fixture(t);
  const contenders = ["claude", "codex", "timer"].map(runtime => {
    const code = `import {acquireLock} from ${JSON.stringify(moduleUrl)};
      console.log('ready'); await new Promise(resolve=>process.stdin.once('data',resolve));
      console.log(JSON.stringify(acquireLock(${JSON.stringify(repo)}, {runtime:${JSON.stringify(runtime)},runId:${JSON.stringify(runtime)}})));`;
    const child = spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: ["pipe", "pipe", "pipe"] });
    let output = "", error = "";
    const ready = new Promise((resolve, reject) => {
      child.on("error", reject); child.stdout.on("data", data => { output += data; if (output.includes("ready\n")) resolve(); });
      child.stderr.on("data", data => { error += data; });
    });
    const done = new Promise((resolve, reject) => {
      child.on("error", reject); child.on("close", code => code === 0 ? resolve(JSON.parse(output.trim().split("\n").at(-1))) : reject(new Error(error)));
    });
    return { child, ready, done };
  });
  await Promise.all(contenders.map(item => item.ready));
  for (const item of contenders) item.child.stdin.end("go\n");
  const results = await Promise.all(contenders.map(item => item.done));
  assert.equal(results.filter(item => item.acquired).length, 1);
  const winner = results.find(item => item.acquired);
  assert.equal(inspectLock(repo).owner.token, winner.owner.token);
  assert.equal(acquireLock(repo, {runtime:"codex",runId:"after-process-exit"}).acquired, false);
});

test("linked worktrees compete through the same common directory", t => {
  const f = fixture(t); const worktree = path.join(f.root, "linked");
  f.git("worktree", "add", "--detach", worktree, "HEAD");
  const lease = acquireLock(f.repo, {runtime:"claude",runId:"one"});
  const contender = acquireLock(worktree, {runtime:"codex",runId:"two"});
  assert.equal(contender.acquired, false);
  assert.equal(contender.commonDir, lease.commonDir);
});

test("missing owner metadata and old leases are never reclaimed by age", t => {
  const { repo } = fixture(t);
  const lease = acquireLock(repo, {runtime:"timer",runId:"old"});
  const owner = {...lease.owner, createdAt:"1970-01-01T00:00:00Z"};
  fs.writeFileSync(path.join(lease.active,"owner.json"), JSON.stringify(owner));
  assert.equal(acquireLock(repo,{runtime:"claude",runId:"new"}).acquired,false);
  fs.unlinkSync(path.join(lease.active,"owner.json"));
  assert.equal(acquireLock(repo,{runtime:"codex",runId:"new"}).status,"unknown");
  assert.throws(()=>releaseLock(repo,lease.owner.token,proof(lease.owner)),/not owned/);
});

test("release requires exact owner evidence and refuses live processes", t => {
  const { repo } = fixture(t); const lease = acquireLock(repo,{runtime:"codex",runId:"one"});
  assert.throws(()=>releaseLock(repo,lease.owner.token,{...proof(lease.owner),allTasksStopped:false}),/quiescence/);
  assert.throws(()=>releaseLock(repo,lease.owner.token,{...proof(lease.owner),runId:"other"}),/quiescence/);
  assert.throws(()=>releaseLock(repo,lease.owner.token,{...proof(lease.owner),processIds:[process.pid]}),/still alive/);
  assert.equal(inspectLock(repo).status,"held");
});

test("an old release replay cannot remove the next owner's lease", t => {
  const { repo } = fixture(t); const first = acquireLock(repo,{runtime:"claude",runId:"one"});
  releaseLock(repo,first.owner.token,proof(first.owner));
  const second = acquireLock(repo,{runtime:"timer",runId:"two"});
  assert.equal(releaseLock(repo,first.owner.token,proof(first.owner)).alreadyReleased,true);
  assert.equal(inspectLock(repo).owner.token,second.owner.token);
});

test("legacy companion locks block entrypoint migration", t => {
  const { repo } = fixture(t); const state = inspectLock(repo);
  fs.writeFileSync(path.join(state.commonDir,`codex-implementation-${'a'.repeat(64)}.lock`),'/unknown/attempt');
  assert.equal(acquireLock(repo,{runtime:"codex",runId:"one"}).status,"legacy-held");
  assert.equal(inspectLock(repo).status,"free");
});
