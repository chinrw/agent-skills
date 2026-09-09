#!/usr/bin/env node
// Local ownership and recovery checks. The controller separately proves merge
// state and native task/process termination before removing a worktree.
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { runCli } from "./lib/cli.mjs";
import { writeJsonAtomic } from "./lib/json-io.mjs";

function git(cwd, ...args) {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 10000,
  }).trim();
}

function inside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function inspect(worktree) {
  const actual = fs.realpathSync(worktree);
  if (fs.realpathSync(git(actual, "rev-parse", "--show-toplevel")) !== actual) {
    throw new Error("expected the worktree root");
  }
  const gitDir = fs.realpathSync(git(actual, "rev-parse", "--absolute-git-dir"));
  const commonDir = fs.realpathSync(git(actual, "rev-parse", "--path-format=absolute", "--git-common-dir"));
  if (gitDir === commonDir) throw new Error("main checkout cannot be reclaimed");
  return { worktree: actual, gitDir, commonDir, headOid: git(actual, "rev-parse", "HEAD") };
}

function subject(repo, pr) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo ?? "") || !Number.isSafeInteger(Number(pr)) || Number(pr) < 1) {
    throw new Error("repository and positive PR number are required");
  }
}

function ownerFile(info) {
  return path.join(info.gitDir, "babysit-owner.json");
}

function readRecord(record, worktree) {
  const saved = JSON.parse(fs.readFileSync(record, "utf8"));
  if (saved.schemaVersion !== 1 || !/^[a-f0-9-]{36}$/.test(saved.id ?? "")) {
    throw new Error("invalid ownership record");
  }
  subject(saved.repo, saved.pr);
  const actual = inspect(worktree);
  for (const field of ["worktree", "gitDir", "commonDir"]) {
    if (saved[field] !== actual[field]) throw new Error(`ownership mismatch: ${field}`);
  }
  const owner = JSON.parse(fs.readFileSync(ownerFile(actual), "utf8"));
  if (owner.id !== saved.id || owner.record !== fs.realpathSync(record)) {
    throw new Error("ownership token mismatch");
  }
  return { saved, actual };
}

function assertClean(actual) {
  if (git(actual.worktree, "status", "--porcelain", "--untracked-files=all", "--ignored")) {
    throw new Error("worktree has changes, untracked files, or ignored files");
  }
}

export function register({ record, worktree, repo, pr, run, purpose }) {
  subject(repo, pr);
  if (!run || !["review", "fix", "composition"].includes(purpose)) {
    throw new Error("run and purpose (review, fix, composition) are required");
  }
  const actual = inspect(worktree);
  fs.mkdirSync(path.dirname(path.resolve(record)), { recursive: true });
  const recordPath = path.join(fs.realpathSync(path.dirname(path.resolve(record))), path.basename(record));
  if (inside(actual.worktree, recordPath) || inside(actual.gitDir, recordPath)) {
    throw new Error("ownership record must survive worktree removal");
  }
  if (fs.existsSync(ownerFile(actual))) throw new Error("worktree already has an owner");
  const saved = {
    schemaVersion: 1, id: randomUUID(), repo, pr: Number(pr), run, purpose,
    worktree: actual.worktree, gitDir: actual.gitDir, commonDir: actual.commonDir,
    startOid: actual.headOid, createdAt: new Date().toISOString(),
  };
  fs.writeFileSync(recordPath, `${JSON.stringify(saved, null, 2)}\n`, { flag: "wx" });
  fs.writeFileSync(ownerFile(actual), JSON.stringify({ id: saved.id, record: recordPath }), { flag: "wx" });
  return saved;
}

export function preserve({ record, worktree }) {
  const { saved, actual } = readRecord(record, worktree);
  assertClean(actual);
  // Each HEAD gets its own ref: saving a later revision cannot discard an
  // earlier unpublished commit, including after a squash merge.
  const savedRef = `refs/babysit-prs/retained/${saved.id}/${actual.headOid}`;
  git(actual.worktree, "update-ref", savedRef, actual.headOid);
  const after = inspect(worktree);
  assertClean(after);
  if (after.headOid !== actual.headOid) throw new Error("HEAD changed while preserving");
  const result = { ...saved, savedOid: actual.headOid, savedRef };
  writeJsonAtomic(fs.realpathSync(record), result);
  return result;
}

export function check({ record, worktree, repo, pr, root, current }) {
  try {
    subject(repo, pr);
    const { saved, actual } = readRecord(record, worktree);
    if (saved.repo !== repo || saved.pr !== Number(pr)) throw new Error("repository/PR ownership mismatch");
    const canonicalRoot = fs.realpathSync(root);
    if (!inside(canonicalRoot, actual.worktree) || canonicalRoot === actual.worktree) {
      throw new Error("worktree is outside the reclamation root");
    }
    if (inside(actual.worktree, fs.realpathSync(current))) throw new Error("current checkout cannot be reclaimed");
    assertClean(actual);
    const expectedRef = `refs/babysit-prs/retained/${saved.id}/${actual.headOid}`;
    if (saved.savedOid !== actual.headOid || saved.savedRef !== expectedRef) {
      throw new Error("current HEAD has not been preserved");
    }
    if (git(actual.worktree, "rev-parse", "--verify", expectedRef) !== actual.headOid) {
      throw new Error("saved ref no longer matches HEAD");
    }
    return { storageSafe: true, repo, pr: Number(pr), worktree: actual.worktree, headOid: actual.headOid, savedRef: expectedRef };
  } catch (error) {
    return { storageSafe: false, reason: error.message };
  }
}

function main(argv) {
  const [command, ...rest] = argv;
  const fields = {
    register: ["record", "worktree", "repo", "pr", "run", "purpose"],
    preserve: ["record", "worktree"],
    check: ["record", "worktree", "repo", "pr", "root", "current"],
  }[command];
  if (!fields) throw new Error("usage: worktree-guard.mjs register|preserve|check --record PATH --worktree PATH ...");
  const args = {};
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i].slice(2);
    if (!rest[i].startsWith("--") || !fields.includes(key) || key in args || !rest[i + 1]) {
      throw new Error(`invalid argument: ${rest[i]}`);
    }
    args[key] = rest[i + 1];
  }
  if (fields.some(field => !args[field])) throw new Error(`required arguments: ${fields.join(", ")}`);
  const result = ({ register, preserve, check })[command](args);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return result.storageSafe === false ? 1 : 0;
}

runCli(import.meta.url, main);
