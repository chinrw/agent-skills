import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { launch, operate, assess } from "../scripts/task.mjs";

const CLI = fileURLToPath(new URL("../scripts/task.mjs", import.meta.url));
const read = file => JSON.parse(fs.readFileSync(file, "utf8"));
const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value));

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "implementation-contract-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, "repo");
  fs.mkdirSync(repo);
  const git = (...args) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
  git("init", "-b", "main");
  git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.invalid");
  git("config", "commit.gpgsign", "false");
  fs.writeFileSync(path.join(repo, "file"), "baseline\n");
  git("add", "."); git("commit", "-m", "baseline");
  const stateFile = path.join(root, "fake.json");
  write(stateFile, { jobs: {}, calls: [], counter: 0 });
  const scriptDir = path.join(root, "plugin/scripts");
  fs.mkdirSync(scriptDir, { recursive: true });
  const companion = path.join(scriptDir, "codex-companion.mjs");
  fs.writeFileSync(companion, `import fs from 'node:fs';
const file=${JSON.stringify(stateFile)};
const state=JSON.parse(fs.readFileSync(file,'utf8'));
const args=process.argv.slice(2), action=args[0];
if(action==='--help'){console.log('--effort <none|minimal|low|medium|high|xhigh>');process.exit(0);}
const cwd=args[args.indexOf('--cwd')+1];
state.calls.push({args,cwd:process.cwd(),session:process.env.CODEX_COMPANION_SESSION_ID??null});
const save=()=>fs.writeFileSync(file,JSON.stringify(state));
const output=x=>{save();console.log(JSON.stringify(x));};
if(action==='status'&&args.includes('--all'))output({workspaceRoot:state.wrongRoot??${JSON.stringify(repo)},running:state.otherRunning??[]});
else if(action==='task'){
 const id='job-'+(++state.counter);
 state.jobs[id]={id,workspaceRoot:${JSON.stringify(repo)},status:'running',threadId:'thread-'+state.counter};
 if(state.emptyLaunch){save();process.exit(0);}
 output({jobId:id,status:'queued'});
}else{
 const job=state.jobs[args[1]];
 if(!job)throw new Error('wrong job ID');
 if(action==='status')output({workspaceRoot:${JSON.stringify(repo)},job:state.wrongJob?{...job,id:'another-job'}:job});
 else if(action==='result')output({job,storedJob:{...job,result:state.noTerminalResult?undefined:{status:state.turnStatus??(job.status==='completed'?0:1),rawOutput:'result'}}});
 else if(action==='cancel'){job.status='cancelled';output({jobId:job.id,status:'cancelled',turnInterrupted:false});}
 else throw new Error('unexpected command '+action);
}
`);
  const input = { cwd: repo, companion, mode: "write", criteria: ["behavior", "regression"], prompt: "Implement the approved change." };
  const attempt = path.join(root, "attempt");
  const change = fn => { const value = read(stateFile); fn(value); write(stateFile, value); };
  const finish = (status = "completed", id = "job-1") => change(value => { value.jobs[id].status = status; });
  const assessment = (target = attempt) => ({
    attemptId: read(path.join(target, "assignment.json")).attemptId,
    jobId: read(path.join(target, "state.json")).jobId,
    threadId: read(path.join(target, "state.json")).threadId,
    snapshot: read(path.join(target, "state.json")).snapshot,
    processesStopped: true, lifecycleEvidence: "Fixture turn returned and no worker processes remain",
    criteria: input.criteria.map(id => ({ id, status: "PASS", evidence: "Observed fixture check" })),
    independentCheck: { status: "PASS", evidence: "Independent fixture verification" } });
  return { root, repo, input, companion, attempt, change, finish, assessment, stateFile };
}


// Independent regression expectations added during the c703134 review.
test("REGRESSION: status polling preserves a settled attempt and permits continuation", t => {
  const f = fixture(t);
  launch(f.input, f.attempt); f.finish(); operate("result", f.attempt);
  assess(f.attempt, f.assessment());
  assert.equal(read(path.join(f.attempt, "state.json")).settled, true);
  const queried = operate("status", f.attempt);
  let continuationError = null;
  try { launch({ ...f.input, previous: f.attempt }, path.join(f.root,"second")); }
  catch (error) { continuationError = error.message; }
  t.diagnostic(`continuation after status: ${continuationError ?? "started"}`);
  assert.equal(queried.settled, true, "a read-only status query must not revoke settlement");
  assert.equal(continuationError, null);
});

test("REGRESSION: observing a completed attempt retains its consistent terminal state", t => {
  const f = fixture(t);
  launch(f.input, f.attempt); f.finish(); operate("result", f.attempt);
  assess(f.attempt, f.assessment(), true);
  const queried = operate("status", f.attempt);
  assert.ok(queried.complete && queried.settled && queried.terminalTurn,
    `unexpected completed state after status: ${JSON.stringify({complete:queried.complete, settled:queried.settled, terminalTurn:queried.terminalTurn})}`);
});

test("REGRESSION: read-only settlement detects staged-content changes with identical worktree bytes", t => {
  const f = fixture(t);
  const git = (...args) => execFileSync("git", ["-C", f.repo, ...args], {encoding:"utf8"});
  fs.writeFileSync(path.join(f.repo,"file"), "staged-before\n"); git("add","file");
  fs.writeFileSync(path.join(f.repo,"file"), "unchanged-working-tree\n");
  const stagedBefore = git("show",":file");
  const beforeStatus = git("status","--porcelain=v1");
  launch({...f.input, mode:"read"}, f.attempt);
  const stagedOid = execFileSync("git", ["-C",f.repo,"hash-object","-w","--stdin"],
    {input:"staged-after\n",encoding:"utf8"}).trim();
  git("update-index","--cacheinfo",`100644,${stagedOid},file`);
  assert.notEqual(git("show",":file"),stagedBefore);
  assert.equal(git("status","--porcelain=v1"),beforeStatus);
  assert.equal(fs.readFileSync(path.join(f.repo,"file"),"utf8"),"unchanged-working-tree\n");
  f.finish(); operate("result",f.attempt);
  assert.throws(() => assess(f.attempt,f.assessment(),true), /read-only task changed|snapshot/,
    "read-only completion must reject a changed pre-existing index");
});

test("repeated result collection preserves acceptance but contrary lifecycle revokes it", t => {
  const f = fixture(t);
  launch(f.input, f.attempt); f.finish(); operate("result", f.attempt);
  assess(f.attempt, f.assessment(), true);
  for (let i = 0; i < 2; i++) assert.equal(operate("result", f.attempt).complete, true);
  f.change(value => { value.jobs['job-1'].status = 'running'; });
  assert.throws(() => operate("status", f.attempt), /contradicts/);
  const state = read(path.join(f.attempt, "state.json"));
  assert.equal(state.status, "needs-reconciliation");
  assert.equal(state.complete, false);
  assert.equal(state.settled, false);
  assert.equal(state.priorSettlement.complete, true);
});

test("a changed source snapshot cannot retain an earlier settlement", t => {
  const f = fixture(t);
  launch(f.input, f.attempt); f.finish(); operate("result", f.attempt);
  assess(f.attempt, f.assessment(), true);
  fs.writeFileSync(path.join(f.repo, "file"), "new source\n");
  assert.throws(() => operate("status", f.attempt), /snapshot/);
  assert.equal(read(path.join(f.attempt, "state.json")).complete, false);
  assert.throws(() => launch({...f.input,previous:f.attempt},path.join(f.root,'next')), /not settled/);
});

test("conflict-stage entries are part of the source identity", t => {
  const f = fixture(t);
  const oid = execFileSync('git',['-C',f.repo,'rev-parse','HEAD:file'],{encoding:'utf8'}).trim();
  execFileSync('git',['-C',f.repo,'update-index','--index-info'],{
    input:`0 ${'0'.repeat(40)}\tfile\n100644 ${oid} 1\tfile\n100644 ${oid} 2\tfile\n100644 ${oid} 3\tfile\n`
  });
  launch({...f.input,mode:'read'},f.attempt);
  const changed = execFileSync('git',['-C',f.repo,'hash-object','-w','--stdin'],{input:'changed stage\n',encoding:'utf8'}).trim();
  execFileSync('git',['-C',f.repo,'update-index','--index-info'],{input:`100644 ${changed} 2\tfile\n`});
  f.finish();operate('result',f.attempt);
  assert.throws(() => assess(f.attempt,f.assessment(),true), /read-only task changed|snapshot/);
});
