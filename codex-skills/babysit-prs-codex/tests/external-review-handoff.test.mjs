import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parseMarker } from "../scripts/lib/marker.mjs";

const CLI = fileURLToPath(new URL("../scripts/external-review.mjs", import.meta.url));
const POLICY = fileURLToPath(new URL("./fixtures/policy-stocks.json", import.meta.url));
const HEAD = "e363a839522e4960d372ce42125cce05c6a64e82";
const BASE = "7f1bc449f10686a1d013121c81c2c44e65a9637f";
const KEY = "90eb74228b4dd711956acd443b74c215d2212192b8ddabc57e499037e8ab0681";
const NOW = "2026-09-08T08:00:00Z";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "external-handoff-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sources = {
    pr: { number: 379, state: "OPEN", isDraft: false, headRefOid: HEAD, commits: [{ committedDate: "2026-09-08T07:00:00Z" }], reviews: [] },
    base: { object: { sha: BASE } },
    comments: [], reactions: [],
    threads: { data: { repository: { pullRequest: { reviewThreads: { nodes: [], pageInfo: { hasNextPage: false } } } } } }
  };
  for (const [name, value] of Object.entries(sources)) fs.writeFileSync(path.join(root, `${name}.json`), JSON.stringify(value));
  const manifest = {
    repo: "chinrw/stocks", pr: 379, prClass: "integration-root", now: NOW,
    expected: { headOid: HEAD, baseOid: BASE }, marker: { spec: "none", key: KEY, state: "NEEDS_REVIEW" },
    policy: POLICY, files: Object.fromEntries(Object.keys(sources).map(name => [name, `${name}.json`]))
  };
  return { root, sources, manifest };
}

function run(ws) {
  const input = path.join(ws.root, "input.json");
  const output = path.join(ws.root, "handoff.json");
  fs.writeFileSync(input, JSON.stringify(ws.manifest));
  const child = spawnSync(process.execPath, [CLI, "--input", input, "--out", output], { encoding: "utf8" });
  assert.ifError(child.error);
  return { code: child.status, stderr: child.stderr, stdout: child.stdout, output, value: child.status === 0 ? JSON.parse(fs.readFileSync(output)) : null };
}

function posted(ws) {
  const receipt = { id: 12345, issue_url: "https://api.github.com/repos/chinrw/stocks/issues/379", body: "@codex review", created_at: NOW, user: { login: "chinrw" } };
  fs.writeFileSync(path.join(ws.root, "posted.json"), JSON.stringify(receipt));
  ws.manifest.postedTrigger = { status: "confirmed", headOid: HEAD, baseOid: BASE, file: "posted.json" };
  return receipt;
}

test("raw observations and a confirmed trigger survive the marker and next-invocation round trip", (t) => {
  const ws = fixture(t);
  const first = run(ws);
  assert.equal(first.code, 0, first.stderr);
  assert.equal(first.value.decision.action, "POST_TRIGGER");
  assert.equal(first.value.decision.codexRound, 0);
  const receipt = posted(ws);
  const applied = run(ws);
  assert.equal(applied.code, 0, applied.stderr);
  assert.equal(applied.value.decision.codexRound, 1);
  assert.equal(applied.value.decision.codexNextTriggerAt, "2026-09-08T08:30:00Z");
  const marker = parseMarker(applied.value.marker);
  assert.equal(marker.dialect, "v2");
  assert.equal(marker.fields.key, KEY);
  assert.equal(marker.fields.codexRound, "1");
  assert.equal(marker.fields.codexNextTriggerAt, "2026-09-08T08:30:00Z");
  assert.equal(marker.fields.codexHeadOid, HEAD);
  delete ws.manifest.postedTrigger;
  ws.manifest.now = "2026-09-08T08:10:00Z";
  fs.writeFileSync(path.join(ws.root, "comments.json"), JSON.stringify([receipt, { id: 12346, body: applied.value.marker, created_at: NOW }]));
  const next = run(ws);
  assert.equal(next.code, 0, next.stderr);
  assert.equal(next.value.decision.action, "WAIT");
  assert.equal(next.value.decision.codexRound, 1);
  assert.equal(next.value.decision.codexNextTriggerAt, "2026-09-08T08:30:00Z");
});

test("failed or truncated raw observations cannot become empty successful reads", async (t) => {
  for (const [name, content] of [["comments", ""], ["comments", '[{"id":1,"body":"@codex review"}]'], ["reactions", "null"], ["reactions", '{"message":"Bad credentials"}'], ["threads", '{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[],"pageInfo":{"hasNextPage":true}}}}}}']]) {
    await t.test(`${name}: ${content.slice(0,30) || "empty"}`, (t) => {
      const ws = fixture(t);
      fs.writeFileSync(path.join(ws.root, `${name}.json`), content);
      fs.writeFileSync(path.join(ws.root, "handoff.json"), "previous handoff\n");
      const outcome = run(ws);
      assert.equal(outcome.code, 2, outcome.stdout);
      assert.equal(fs.readFileSync(outcome.output, "utf8"), "previous handoff\n");
    });
  }
});

test("disabled policy cannot publish a live head with a stale review key", (t) => {
  const ws = fixture(t);
  fs.writeFileSync(path.join(ws.root, "policy.json"), JSON.stringify({ externalReview: { enabled: false } }));
  ws.manifest.policy = "policy.json";
  ws.sources.pr.headRefOid = "a".repeat(40);
  fs.writeFileSync(path.join(ws.root, "pr.json"), JSON.stringify(ws.sources.pr));
  const outcome = run(ws);
  assert.equal(outcome.code, 0, outcome.stderr);
  assert.equal(outcome.value.decision.requiresResnapshot, true);
  assert.equal(outcome.value.decision.action, "STAND_DOWN");
  assert.equal(outcome.value.marker, null);
});

test("a confirmed receipt predating the head cannot satisfy one-round review", (t) => {
  const ws = fixture(t);
  ws.manifest.prClass = "strict-stacked";
  const receipt = posted(ws);
  receipt.created_at = "2026-09-07T08:00:00Z";
  fs.writeFileSync(path.join(ws.root, "posted.json"), JSON.stringify(receipt));
  const outcome = run(ws);
  assert.equal(outcome.code, 2, outcome.stdout);
  assert.match(outcome.stderr, /predates/);
});

test("unknown comment authors cannot become configured-bot activity", (t) => {
  const ws = fixture(t);
  ws.manifest.prClass = "strict-stacked";
  fs.writeFileSync(path.join(ws.root, "comments.json"), JSON.stringify([{ id: 321, body: "A human comment", user: null, created_at: NOW }]));
  const outcome = run(ws);
  assert.equal(outcome.code, 0, outcome.stderr);
  assert.equal(outcome.value.decision.externalReviewSatisfied, false);
  assert.equal(outcome.value.decision.action, "POST_TRIGGER");
  assert.deepEqual(outcome.value.observation.botActivity, []);
});

test("unknown posting outcomes stop for observation without advancing the round", (t) => {
  const ws = fixture(t);
  ws.manifest.postedTrigger = { status: "unknown" };
  const outcome = run(ws);
  assert.equal(outcome.code, 0, outcome.stderr);
  assert.equal(outcome.value.decision.codexRound, 0);
  assert.equal(outcome.value.decision.action, "STAND_DOWN");
  assert.equal(outcome.value.decision.requiresResnapshot, true);
  assert.equal(outcome.value.marker, null);
});

test("a receipt already present in live comments is not counted twice", (t) => {
  const ws = fixture(t);
  const receipt = posted(ws);
  const first = run(ws);
  assert.equal(first.code, 0, first.stderr);
  fs.writeFileSync(path.join(ws.root, "comments.json"), JSON.stringify([receipt, { id: 12346, body: first.value.marker, created_at: NOW }]));
  const repeat = run(ws);
  assert.equal(repeat.code, 0, repeat.stderr);
  assert.equal(repeat.value.decision.codexRound, 1);
  assert.equal(repeat.value.decision.action, "WAIT");
});

test("paginated fresh pass and unresolved bot threads reach the evaluator intact", (t) => {
  const ws = fixture(t);
  const old = [{ id: 1, user: { login: "chatgpt-codex-connector[bot]" }, content: "+1", created_at: "2026-09-07T08:00:00Z" }];
  const fresh = [{ id: 2, user: { login: "chatgpt-codex-connector[bot]" }, content: "+1", created_at: NOW }];
  fs.writeFileSync(path.join(ws.root, "reactions.json"), `${JSON.stringify(old)}\n${JSON.stringify(fresh)}`);
  const pass = run(ws);
  assert.equal(pass.code, 0, pass.stderr);
  assert.equal(pass.value.decision.codexState, "PASS_FRESH");
  assert.equal(pass.value.decision.externalReviewSatisfied, true);
  fs.writeFileSync(path.join(ws.root, "reactions.json"), "[]");
  ws.sources.threads.data.repository.pullRequest.reviewThreads.nodes = [{ id: "T1", isResolved: false, comments: { nodes: [{ author: { login: "chatgpt-codex-connector" }, createdAt: NOW }] } }];
  fs.writeFileSync(path.join(ws.root, "threads.json"), JSON.stringify(ws.sources.threads));
  const blocked = run(ws);
  assert.equal(blocked.code, 0, blocked.stderr);
  assert.equal(blocked.value.decision.codexState, "FINDINGS_OPEN");
  assert.equal(blocked.value.decision.externalReviewSatisfied, false);
});

test("a submitted bot review without inline threads still satisfies one-round", (t) => {
  const ws = fixture(t);
  ws.manifest.prClass = "strict-stacked";
  ws.sources.pr.reviews = [{ author: { login: "chatgpt-codex-connector" }, submittedAt: NOW, state: "COMMENTED" }];
  fs.writeFileSync(path.join(ws.root, "pr.json"), JSON.stringify(ws.sources.pr));
  const outcome = run(ws);
  assert.equal(outcome.code, 0, outcome.stderr);
  assert.equal(outcome.value.decision.codexState, "ONE_ROUND_SATISFIED");
  assert.equal(outcome.value.decision.action, "NONE");
  assert.equal(outcome.value.decision.externalReviewSatisfied, true);
});
