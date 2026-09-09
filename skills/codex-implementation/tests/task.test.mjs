import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { launch, operate, assess, diagnose, reconcile } from "../scripts/task.mjs";
import { inspectLock } from "../scripts/lib/repository-lock.mjs";

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

test("launch/status/result keep the pinned cwd, script, job, and requested settings", t => {
  const f = fixture(t);
  launch({ ...f.input, model: "gpt-6-astra", effort: "high" }, f.attempt);
  f.finish(); operate("result", f.attempt);
  const identity = read(path.join(f.attempt, "assignment.json"));
  assert.equal(identity.requestedModel, "gpt-6-astra");
  assert.equal(identity.effectiveModel, null);
  assert.equal(identity.effectiveEffort, null);
  for (const call of read(f.stateFile).calls) {
    assert.equal(call.cwd, f.repo);
    assert.equal(call.args[call.args.indexOf("--cwd") + 1], f.repo);
  }
  const result = spawnSync(process.execPath, [CLI, "status", f.attempt], { cwd: f.root, encoding: "utf8" });
  assert.equal(result.status, 0, result.stdout);
  assert.equal(JSON.parse(result.stdout).result.jobId, "job-1");
  assert.equal(read(f.stateFile).calls.at(-1).cwd, f.repo);
});

test("an empty launch preserves an unknown attempt and refuses a second writer", t => {
  const f = fixture(t);
  f.change(value => { value.emptyLaunch = true; });
  assert.throws(() => launch(f.input, f.attempt), /missing or malformed JSON/);
  assert.equal(read(path.join(f.attempt, "state.json")).status, "unknown");
  assert.throws(() => launch(f.input, path.join(f.root, "second")), /busy|EEXIST/);
  assert.equal(read(f.stateFile).counter, 1);
});

test("a changed companion or mismatched job cannot take over an existing attempt", t => {
  const f = fixture(t); launch(f.input, f.attempt);
  f.change(value => { value.wrongJob = true; });
  assert.throws(() => operate("status", f.attempt), /identity mismatch/);
  f.change(value => { value.wrongJob = false; });
  fs.appendFileSync(f.companion, "\n// changed implementation\n");
  assert.throws(() => operate("status", f.attempt), /pinned companion changed/);
});

test("running output and a cancellation marker cannot release the writer", t => {
  const f = fixture(t); launch(f.input, f.attempt);
  write(path.join(f.attempt, "result.json"), { summary: "done" });
  assert.throws(() => operate("result", f.attempt), /not terminal/);
  operate("cancel", f.attempt);
  operate("result", f.attempt);
  assert.throws(() => assess(f.attempt, f.assessment()), /terminal turn/);
  assert.throws(() => launch(f.input, path.join(f.root, "second")), /busy|EEXIST/);
});

test("required FAIL, NOT RUN, BLOCKED, omissions, and missing independent checks reject completion", t => {
  const f = fixture(t); launch(f.input, f.attempt); f.finish(); operate("result", f.attempt);
  for (const status of ["FAIL", "NOT RUN", "BLOCKED"]) {
    const report = f.assessment(); report.criteria[0].status = status;
    assert.throws(() => assess(f.attempt, report, true), /required criterion/);
  }
  const omitted = f.assessment(); omitted.criteria.pop();
  assert.throws(() => assess(f.attempt, omitted, true), /required criterion/);
  const independent = f.assessment(); independent.independentCheck.status = "NOT RUN";
  assert.throws(() => assess(f.attempt, independent, true), /independent verification/);
  const lifecycle = f.assessment(); lifecycle.processesStopped = false;
  assert.throws(() => assess(f.attempt, lifecycle, true), /termination/);
  assert.equal(assess(f.attempt, f.assessment(), true).complete, true);
});

test("source changes invalidate an earlier assessment", t => {
  const f = fixture(t); launch(f.input, f.attempt); f.finish(); operate("result", f.attempt);
  const report = f.assessment();
  fs.writeFileSync(path.join(f.repo, "file"), "changed after verification\n");
  assert.throws(() => assess(f.attempt, report, true), /assessment does not cover/);
});

test("a settled correction starts fresh even when a different task is latest", t => {
  const f = fixture(t); launch(f.input, f.attempt); f.finish(); operate("result", f.attempt);
  const report = f.assessment(); report.criteria[0].status = "FAIL";
  assert.equal(assess(f.attempt, report).settled, true);
  f.change(value => { value.jobs['latest-other'] = { id:'latest-other',status:'completed',threadId:'wrong-thread' }; });
  assert.throws(() => launch({ ...f.input, previous:f.attempt, criteria:['different'] }, path.join(f.root, "changed-scope")), /approved mode/);
  launch({ ...f.input, previous: f.attempt, prompt: "Same goal, address the prior finding." }, path.join(f.root, "second"));
  const launches = read(f.stateFile).calls.filter(call => call.args[0] === "task");
  assert.equal(launches.length, 2);
  for (const call of launches) {
    assert.ok(call.args.includes("--fresh"));
    assert.ok(!call.args.some(arg => arg.startsWith("--resume")));
  }
});

test("unsupported effort fails before launch; backend failures cannot become completion", t => {
  const f = fixture(t);
  assert.throws(() => launch({ ...f.input, effort:"max" }, f.attempt), /does not advertise/);
  assert.equal(fs.existsSync(f.attempt), false);
  for (const effort of ["none", "minimal"]) {
    const attempt = path.join(f.root, effort);
    launch({ ...f.input, model:"gpt-6-astra", effort }, attempt);
    const id = read(path.join(attempt, "state.json")).jobId;
    f.finish("failed", id); operate("result", attempt);
    const report = f.assessment(attempt);
    assert.throws(() => assess(attempt, report, true), /cannot be complete/);
    assess(attempt, report);
  }
});

test("malformed calls emit structured errors and read-only source changes block settlement", t => {
  const f = fixture(t);
  const bad = spawnSync(process.execPath, [CLI, "resume-last", f.attempt], { encoding:"utf8" });
  assert.equal(bad.status, 1);
  assert.equal(JSON.parse(bad.stdout).ok, false);
  launch({ ...f.input, mode:"read" }, f.attempt); f.finish();
  fs.writeFileSync(path.join(f.repo, "file"), "unexpected edit\n"); operate("result", f.attempt);
  assert.throws(() => assess(f.attempt, f.assessment()), /read-only task changed/);
});

test("wrong workspace observations and symlinked output inside source fail before dispatch", t => {
  const f = fixture(t);
  f.change(value => { value.wrongRoot = f.root; });
  assert.throws(() => launch(f.input, f.attempt), /workspace status/);
  f.change(value => { delete value.wrongRoot; });
  const alias = path.join(f.root, "source-alias"); fs.symlinkSync(f.repo, alias, "dir");
  assert.throws(() => launch(f.input, path.join(alias, "attempt")), /outside the source worktree/);
  assert.equal(read(f.stateFile).counter, 0);
});

test("failed-wrapper records and contradictory turn outcomes cannot establish completion", t => {
  const f = fixture(t); launch(f.input, f.attempt); f.finish();
  f.change(value => { value.turnStatus = 1; });
  assert.throws(() => operate("result", f.attempt), /outcome disagree/);
  f.change(value => { delete value.turnStatus; value.noTerminalResult = true; });
  f.finish("failed"); operate("result", f.attempt);
  assert.throws(() => assess(f.attempt, f.assessment()), /terminal turn/);
});

test("continuation budgets stop repeated attempts without discarding settled results", t => {
  const f = fixture(t); launch({ ...f.input, maxAttempts: 1 }, f.attempt);
  f.finish(); operate("result", f.attempt); assess(f.attempt, f.assessment());
  const second = path.join(f.root, "second");
  assert.throws(() => launch({ ...f.input, previous:f.attempt }, second), /budget exhausted/);
  assert.equal(fs.existsSync(second), false);
  launch({ ...f.input, previous:f.attempt, maxAttempts: 2 }, second);
  assert.equal(read(path.join(second, "assignment.json")).attemptNumber, 2);
  const malformed = read(path.join(f.attempt, "assignment.json")); delete malformed.attemptNumber;
  write(path.join(f.attempt, "assignment.json"), malformed);
  assert.throws(() => launch({ ...f.input, previous:f.attempt }, path.join(f.root, "third")), /invalid saved attempt/);
});

test("an assessment cannot be reused for a different thread at the same source snapshot", t => {
  const f = fixture(t); launch(f.input, f.attempt); f.finish(); operate("result", f.attempt);
  const previousReport = f.assessment(); assess(f.attempt, previousReport);
  const second = path.join(f.root, "second");
  launch({ ...f.input, previous:f.attempt }, second); f.finish("completed", "job-2");
  operate("result", second);
  assert.throws(() => assess(second, previousReport, true), /another attempt/);
  assert.equal(assess(second, f.assessment(second), true).complete, true);
});

function recoveryProof(f) {
  const diagnostic = diagnose(f.attempt);
  const identity = read(path.join(f.attempt,"assignment.json"));
  return { diagnosticFile:diagnostic.file, diagnosticHash:diagnostic.hash, attemptId:identity.attemptId,
    snapshot:diagnostic.diagnostic.snapshot, jobId:"job-1", threadId:"thread-1", turnId:"turn-1",
    source:{kind:"app-server",reference:"Independent fixture server-turn observation"},
    observedAt:new Date().toISOString(), serverTurn:{id:"turn-1",threadId:"thread-1",status:"interrupted"},
    processesStopped:true, allTasksStopped:true, processIds:[], lifecycleEvidence:"Fixture worker and all task processes ended",
    launchPromptHash:identity.promptHash, requestCwd:identity.cwd };
}

test("controlled reconciliation settles proven cancellation without accepting the work", t => {
  const f=fixture(t);launch(f.input,f.attempt);operate("cancel",f.attempt);
  const proof=recoveryProof(f);
  assert.throws(()=>reconcile(f.attempt,{...proof,serverTurn:{...proof.serverTurn,status:"unknown"}}),/proven terminal/);
  assert.equal(inspectLock(f.repo).status,"held");
  const recovered=reconcile(f.attempt,proof);
  assert.equal(recovered.settled,true);assert.equal(recovered.complete,false);
  assert.equal(inspectLock(f.repo).status,"free");
  assert.equal(operate("status",f.attempt).settled,true);
  assert.equal(operate("result",f.attempt).terminalTurn,true);
  assert.equal(reconcile(f.attempt,proof).settled,true);
  launch({...f.input,previous:f.attempt},path.join(f.root,"fresh"));
  assert.equal(read(f.stateFile).counter,2);
  const nextOwner=inspectLock(f.repo).owner.token;
  reconcile(f.attempt,proof);
  assert.equal(inspectLock(f.repo).owner.token,nextOwner);
});

test("unknown launch recovery needs the exact request, task identity, and fresh source", t => {
  const f=fixture(t);f.change(value=>{value.emptyLaunch=true;});
  assert.throws(()=>launch(f.input,f.attempt),/malformed JSON/);
  const proof=recoveryProof(f);
  assert.throws(()=>reconcile(f.attempt,{...proof,launchPromptHash:"wrong"}),/exact request/);
  assert.throws(()=>reconcile(f.attempt,{...proof,diagnosticHash:"wrong"}),/diagnostic identity/);
  assert.throws(()=>reconcile(f.attempt,{...proof,observedAt:"1970-01-01T00:00:00Z"}),/fresh host/);
  fs.writeFileSync(path.join(f.repo,"file"),"new source\n");
  assert.throws(()=>reconcile(f.attempt,proof),/snapshot changed/);
  assert.equal(inspectLock(f.repo).status,"held");
  const current=recoveryProof(f);
  assert.equal(reconcile(f.attempt,current).settled,true);
  assert.equal(inspectLock(f.repo).status,"free");
});

test("diagnosis stays available after plugin drift and does not change task state", t => {
  const f=fixture(t);launch(f.input,f.attempt);
  const before=fs.readFileSync(path.join(f.attempt,"state.json"),"utf8");
  fs.appendFileSync(f.companion,"\n// new plugin bytes\n");
  const diagnostic=diagnose(f.attempt);
  assert.match(diagnostic.diagnostic.observation.error,/pinned companion changed/);
  assert.equal(fs.readFileSync(path.join(f.attempt,"state.json"),"utf8"),before);
  assert.equal(inspectLock(f.repo).status,"held");
  assert.equal(reconcile(f.attempt,recoveryProof(f)).settled,true);
});

test("a live or omitted known worker prevents recovery despite a claimed terminal turn", t => {
  const f=fixture(t);launch(f.input,f.attempt);
  f.change(value=>{value.jobs['job-1'].pid=process.pid;});operate("status",f.attempt);
  const proof=recoveryProof(f);
  assert.throws(()=>reconcile(f.attempt,proof),/known worker/);
  assert.throws(()=>reconcile(f.attempt,{...proof,processIds:[process.pid]}),/still alive/);
  assert.equal(inspectLock(f.repo).status,"held");
});

test("a recorded worker that has exited can be reconciled with host terminal evidence", t => {
  const f=fixture(t);launch(f.input,f.attempt);
  const pid=Number(execFileSync(process.execPath,["-e","console.log(process.pid)"],{encoding:"utf8"}).trim());
  f.change(value=>{value.jobs['job-1'].pid=pid;});operate("status",f.attempt);
  const proof={...recoveryProof(f),processIds:[pid]};
  assert.throws(()=>reconcile(f.attempt,{...proof,jobId:"other"}),/jobId mismatch/);
  assert.throws(()=>reconcile(f.attempt,{...proof,source:{kind:"task-summary",reference:"claims done"}}),/host lifecycle/);
  assert.equal(reconcile(f.attempt,proof).settled,true);
  assert.equal(inspectLock(f.repo).status,"free");
});

test("new lifecycle evidence revokes a recovered settlement", t => {
  const f=fixture(t);launch(f.input,f.attempt);operate("cancel",f.attempt);
  reconcile(f.attempt,recoveryProof(f));
  f.change(value=>{value.jobs['job-1'].status='running';value.jobs['job-1'].updatedAt=new Date(Date.now()+1000).toISOString();});
  assert.throws(()=>operate("status",f.attempt),/contradicts recovery/);
  assert.equal(read(path.join(f.attempt,"state.json")).settled,false);
});

test("a failed lease release can be retried without inventing a new recovery", t => {
  const f=fixture(t);launch(f.input,f.attempt);operate("cancel",f.attempt);
  const proof=recoveryProof(f), rename=fs.renameSync;
  const mocked=t.mock.method(fs,"renameSync",(from,to)=>{
    if(String(from).endsWith('/agent-skills-controllers/active')) throw new Error('fixture release I/O failure');
    return rename(from,to);
  });
  assert.throws(()=>reconcile(f.attempt,proof),/release I\/O failure/);
  assert.equal(inspectLock(f.repo).status,"held");
  assert.equal(read(path.join(f.attempt,"state.json")).leaseReleased,false);
  mocked.mock.restore();
  assert.equal(reconcile(f.attempt,proof).leaseReleased,true);
  assert.equal(inspectLock(f.repo).status,"free");
});
