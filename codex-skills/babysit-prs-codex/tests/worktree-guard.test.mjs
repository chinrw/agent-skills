import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { register, preserve, check } from "../scripts/worktree-guard.mjs";

function git(cwd, ...args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "babysit-recovery-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const checkout = path.join(dir, "repo");
  fs.mkdirSync(checkout);
  git(checkout, "init", "-b", "main");
  git(checkout, "config", "user.name", "Fixture");
  git(checkout, "config", "user.email", "fixture@example.invalid");
  git(checkout, "config", "commit.gpgsign", "false");
  fs.writeFileSync(path.join(checkout, "file"), "base\n");
  git(checkout, "add", ".");
  git(checkout, "commit", "-m", "base");
  const root = path.join(dir, "worktrees");
  const worktree = path.join(root, "judge-123abc");
  git(checkout, "worktree", "add", "--detach", worktree, "HEAD");
  const args = { record: path.join(dir, "records/owner.json"), worktree,
    repo: "owner/repo", pr: 456, run: "run-1", purpose: "review",
    root, current: checkout };
  return { ...args, checkout, dir };
}

test("a clean detached directory containing a merged PR number proves no ownership", t => {
  const f = fixture(t);
  assert.equal(git(f.worktree, "status", "--porcelain"), "");
  // This is the audit's ambiguous directory shape; no GitHub fact about PR 123
  // can establish that this worktree belongs to that PR.
  assert.equal(check({ ...f, pr: 123 }).storageSafe, false);
  register(f);
  preserve(f);
  assert.match(check({ ...f, pr: 123 }).reason, /ownership mismatch/);
  assert.equal(check(f).storageSafe, true);
});

test("unpublished commits survive worktree removal and Git garbage collection", t => {
  const f = fixture(t);
  const owned = register(f);
  fs.writeFileSync(path.join(f.worktree, "file"), "unpublished\n");
  git(f.worktree, "commit", "-am", "local only");
  const head = git(f.worktree, "rev-parse", "HEAD");
  assert.notEqual(head, owned.startOid);
  assert.match(check(f).reason, /has not been preserved/);
  const saved = preserve(f);
  assert.equal(check(f).storageSafe, true);
  git(f.checkout, "worktree", "remove", f.worktree);
  git(f.checkout, "reflog", "expire", "--expire=now", "--all");
  git(f.checkout, "gc", "--prune=now");
  assert.equal(git(f.checkout, "show", `${saved.savedRef}:file`), "unpublished");
});

test("dirty, ignored, or untracked files cannot be discarded, and HEAD drift needs a new save", t => {
  const f = fixture(t);
  register(f);
  preserve(f);
  const scratch = path.join(f.worktree, "scratch");
  fs.writeFileSync(scratch, "untracked");
  assert.equal(check(f).storageSafe, false);
  assert.throws(() => preserve(f), /untracked/);
  fs.appendFileSync(path.join(f.checkout, ".git/info/exclude"), "\nscratch\n");
  assert.equal(git(f.worktree, "status", "--porcelain"), "");
  assert.equal(check(f).storageSafe, false);
  fs.unlinkSync(scratch);
  fs.writeFileSync(path.join(f.worktree, "file"), "changed\n");
  assert.equal(check(f).storageSafe, false);
  git(f.worktree, "commit", "-am", "new head");
  assert.match(check(f).reason, /has not been preserved/);
  preserve(f);
  assert.equal(check(f).storageSafe, true);
});

test("canonical paths exclude the main/current checkout, wrong root, and recreated worktrees", t => {
  const f = fixture(t);
  assert.throws(() => register({ ...f, worktree: f.checkout }), /main checkout/);
  register(f);
  const saved = preserve(f);
  assert.equal(check({ ...f, current: f.worktree }).storageSafe, false);
  assert.equal(check({ ...f, root: f.checkout }).storageSafe, false);
  const link = path.join(f.dir, "alias");
  fs.symlinkSync(f.worktree, link, "dir");
  assert.equal(check({ ...f, current: link }).storageSafe, false);
  git(f.checkout, "worktree", "remove", f.worktree);
  git(f.checkout, "worktree", "add", "--detach", f.worktree, saved.savedOid);
  assert.equal(check(f).storageSafe, false);
});

test("a deleted or moved recovery ref fails the storage check", t => {
  const f = fixture(t);
  register(f);
  const saved = preserve(f);
  git(f.checkout, "update-ref", "-d", saved.savedRef);
  assert.equal(check(f).storageSafe, false);
  assert.throws(() => register(f), /already has an owner/);
});
