import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { validate } from "../scripts/lib/schema.mjs";

const SKILL_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const AGENT_DIR = path.join(SKILL_DIR, "prompts");
const ENTRY = fs.readFileSync(path.join(SKILL_DIR, "SKILL.md"), "utf8");
const SKILL = `${ENTRY}\n${fs.readdirSync(path.join(SKILL_DIR, "references"))
  .filter(name => name.endsWith(".md")).sort()
  .map(name => fs.readFileSync(path.join(SKILL_DIR, "references", name), "utf8")).join("\n")}`;
const VARIANTS = [{ name: "babysit-prs-codex", text: SKILL }];
const AGENTS = ["spec-selector", "finding-judge", "thread-judge", "verifier", "composition-verifier", "critical-composition-verifier"];
function assertShared(rule, label) {
  assert.ok(SKILL.includes(rule), `${label}: ${rule}`);
}

test("the native skill remains explicitly invoked and contains no subprocess task routing", () => {
  assert.match(ENTRY, /^name: babysit-prs(?:-codex)?$/m);
  assert.match(ENTRY, /disable-model-invocation: true/);
  if (/^name: babysit-prs-codex$/m.test(ENTRY)) {
    assert.match(fs.readFileSync(path.join(SKILL_DIR, "agents/openai.yaml"), "utf8"), /allow_implicit_invocation: false/);
    assert.match(ENTRY, /fork_turns="none"/);
  } else {
    assert.match(ENTRY, /native `Agent`/);
    assert.match(ENTRY, /fresh, non-fork subagent/);
  }
  assert.match(SKILL, /Native completion must be observed independently/);
  assert.match(SKILL, /controller owns commits and every GitHub write/);
  assert.match(SKILL, /confirmed the old task has stopped|confirming the old task has stopped/);
  for (const text of [SKILL, ...AGENTS.map(name => fs.readFileSync(path.join(AGENT_DIR, `${name}.md`), "utf8"))]) {
    assert.doesNotMatch(text, /codex-job|codex exec|codex-companion|CLAUDE_SKILL_DIR|GITHUB_WRITES/);
  }
});

test("snapshot-only cannot dispatch children or mutate source or GitHub", () => {
  for (const rule of [
    "`--snapshot-only` implies `--dry-run`",
    "`--snapshot-only` and `--merge-integration` together are contradictory.",
    "dispatch any native subagent, read-only or otherwise",
    "create, modify, or remove a worktree",
    "run project tests, builds, or servers",
    "perform any GitHub write of any kind"
  ]) assertShared(rule, "snapshot-only boundary");
});

function parseJsonStream(text) {
  try {
    return [JSON.parse(text)];
  } catch {
    /* fall through to stream parsing */
  }

  const docs = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];

    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }

    if (ch === '"') {
      inString = true;
    } else if (ch === "{" || ch === "[") {
      if (depth === 0) start = i;
      depth += 1;
    } else if (ch === "}" || ch === "]") {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        docs.push(JSON.parse(text.slice(start, i + 1)));
        start = -1;
      }
    }
  }

  if (depth !== 0 || docs.length === 0) {
    throw new SyntaxError("not a valid JSON document or stream");
  }
  return docs;
}


test("every shipped JSON Schema parses and only uses supported keywords", () => {
  const dir = path.join(SKILL_DIR, "schemas");
  const files = fs.readdirSync(dir).filter((name) => name.endsWith(".schema.json"));
  assert.deepEqual(files.sort(), ["checkpoint-artifact-v1.schema.json", "codex-artifact-v1.schema.json", "mutation-evidence-v1.schema.json"]);

  for (const name of files) {
    const schema = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));
    // A schema that uses an unimplemented keyword throws here rather than
    // silently failing to enforce a constraint at runtime.
    assert.doesNotThrow(() => validate(schema, {}), `${name} must be usable by the validator`);
    assert.equal(schema.$schema, "http://json-schema.org/draft-07/schema#", name);
    assert.ok(schema.$id?.startsWith("babysit-prs/"), name);
  }
});

test("every shipped JSON fixture parses, as one document or as a paginated stream", () => {
  const dir = path.join(SKILL_DIR, "tests", "fixtures");
  const names = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
  assert.ok(names.length >= 4);

  for (const name of names) {
    const text = fs.readFileSync(path.join(dir, name), "utf8");
    // `gh api --paginate` concatenates one JSON document per page, so some
    // fixtures are deliberately a stream rather than a single document.
    assert.doesNotThrow(() => parseJsonStream(text), name);
  }
});

test("every helper script is syntactically valid ES module code", async () => {
  const dir = path.join(SKILL_DIR, "scripts");
  const scripts = fs.readdirSync(dir).filter((name) => name.endsWith(".mjs"));
  assert.ok(scripts.length >= 4);
  for (const name of scripts) {
    await import(path.join(dir, name));
  }
  for (const name of fs.readdirSync(path.join(dir, "lib")).filter((f) => f.endsWith(".mjs"))) {
    await import(path.join(dir, "lib", name));
  }
});

test("dry-run still means zero remote writes", () => {
  for (const rule of [
    "do not post/update comments",
    "never post an external-review trigger, in any mode, for any reason",
    "do not reply or resolve threads",
    "do not push",
    "do not create/update PRs",
    "do not merge"
  ]) {
    assertShared(rule, "dry-run rule");
  }
  assertShared("`--dry-run` never posts an external-review trigger.", "dry-run rule");
});

test("merge safety rules are intact", () => {
  for (const rule of [
    "--match-head-commit",
    "Never merge without `--match-head-commit`.",
    "Never merge into `main`.",
    "Never use `--admin`.",
    "Never force push.",
    "Never push to the reviewed PR's branch.",
    "By default, auto-merge only strict stacked PRs."
  ]) {
    assertShared(rule, "merge rule");
  }
});

test("collision, independent-verification, and stacked-merge rules are intact", () => {
  for (const rule of [
    "stand down rather than duplicate or overwrite",
    "process innermost-first",
    "Never let two writers overlap.",
    "Never resolve a thread without a pushed fix or evidence-backed disposition."
  ]) {
    assertShared(rule, "rule");
  }
  assertShared("An implementer claim is not acceptance. A fresh verifier checkpoint and real", "independent verification");
});

test("both adapters require ownership and saved commits before worktree reclamation", () => {
  assert.match(SKILL, /scripts\/worktree-guard\.mjs/);
  assert.match(SKILL, /creation-time ownership record/);
  assert.match(SKILL, /controller has observed all tasks and processes using it terminate/);
  assert.match(SKILL, /Skip the sweep entirely under `--dry-run` and `--snapshot-only`/);
  assert.doesNotMatch(SKILL, /digit runs of \*\*three or more\*\* digits/);
});

test("the external-review gate semantics survive the repair", () => {
  for (const rule of [
    "A pass is the configured bot's configured reaction **on the PR body**",
    "`fresh-pass-retry` retries indefinitely across invocations and restarts.",
    "External review is repository policy, never a hardcoded login or repo name.",
    "it is never a\n  permanent one-shot key",
    "Never deduplicate triggers by deleting comments."
  ]) {
    assertShared(rule, "external-review rule");
  }
  // The relaxed strict-stacked rule stays policy-driven.
  assertShared("`strictStackedMode = one-round`", "external-review rule");
  assertShared(
    "Never apply the relaxed strict-stack rule to a root or integration PR.",
    "external-review rule"
  );
});

test("the bounded convergence loop is still bounded", () => {
  assertShared("max waves: 8", "convergence rule");
  assertShared("--max-waves N", "convergence rule");
  assertShared(
    "The invocation is bounded. The external-review retry loop is not.",
    "convergence rule"
  );
});

test("the deployed review-key compatibility vector is pinned in the doc", () => {
  assertShared(
    "90eb74228b4dd711956acd443b74c215d2212192b8ddabc57e499037e8ab0681",
    "review-key vector"
  );
  assertShared("payloadLength 119   trailingNul=false", "review-key vector");
  assertShared("scripts/review-key.mjs", "review-key helper reference");
});

test("the legacy marker migration is documented and never grants acceptance", () => {
  assertShared("v2-legacy-trailing-nul", "legacy marker rule");
  assertShared("Legacy marker dialects — recognize, never accept", "legacy marker rule");
  assertShared("Only exit `0` proves review-current.", "legacy marker rule");
  assertShared(
    'Do not "repair" a legacy marker by copying its old key forward.',
    "legacy marker rule"
  );
  assertShared(
    "A marker written under a legacy dialect is recognized, never accepted.",
    "legacy marker rule"
  );
});

test("every agent definition carries the evidence and probe-hygiene rules", () => {
  for (const name of AGENTS) {
    const text = fs.readFileSync(path.join(AGENT_DIR, `${name}.md`), "utf8");
    assert.ok(
      /babysit-prs-probe\.XXXXXX/.test(text),
      `${name} must document the mktemp probe pattern`
    );
    assert.ok(
      /check-source-clean\.mjs/.test(text),
      `${name} must verify source cleanliness`
    );
    assert.ok(
      /repository root/.test(text),
      `${name} must forbid probe files in the repository root`
    );
    assert.ok(
      /review-key\.mjs/.test(text),
      `${name} must defer review-key computation to the helper`
    );
  }
});

test("judge and verifier agents explicitly reject count-only evidence", () => {
  for (const name of [
    "finding-judge",
    "thread-judge",
    "verifier",
    "critical-composition-verifier"
  ]) {
    const text = fs.readFileSync(path.join(AGENT_DIR, `${name}.md`), "utf8");
    // All four share the same canonical sentence, so this rule cannot drift
    // into four subtly different standards.
    assert.ok(
      text.includes("A count is never evidence."),
      `${name} must carry the canonical count-is-not-evidence rule`
    );
    assert.ok(/diagnostics/.test(text), `${name} must know diagnostics are not evidence`);
  }
});

test("the finding judge requires mutation evidence for pure coverage claims", () => {
  const text = fs.readFileSync(path.join(AGENT_DIR, "finding-judge.md"), "utf8");
  assert.ok(text.includes("requiresMutationEvidence"));
  assert.ok(text.includes("test-does-not-detect-regression"));
  assert.ok(text.includes("test-detects-regression"));
  assert.ok(text.includes("Reading alone never confirms it."));
});

test("the review range is three-dot, and identity still binds the base tip", () => {
  // A live run found every in-scope PR's baseRefOid was NOT the merge base:
  // stocks-dev had advanced, so the two-dot range reported 32-34 files where
  // the PR authored 1-3. Scoping a review two-dot attributes base drift to the
  // PR -- and lets the spec selector bind to spec files that arrived from the
  // base, which is the exact wrong-spec failure the selector exists to prevent.
  for (const { name, text } of VARIANTS) {
    const section = text.slice(text.indexOf("### 10.1"), text.indexOf("### 10.2"));
    assert.ok(section.length > 0, `section 10.1 must exist in ${name}`);

    assert.match(section, /three-dot/i, `10.1 must name the three-dot range in ${name}`);
    assert.match(
      section,
      /<baseRefOid>\.\.\.<headRefOid>/,
      `10.1 must show the three-dot range literally in ${name}`
    );
    assert.match(section, /merge-base/, `10.1 must resolve the merge base explicitly in ${name}`);

    // The bare two-dot form must not survive as the stated review range.
    assert.ok(
      !/```text\s*\n<baseRefOid>\.\.<headRefOid>\s*\n```/.test(section),
      `the two-dot range must not be presented as the review range in ${name}`
    );

    // Scope and identity are deliberately different: an advancing base must
    // still invalidate acceptance, so the KEY keeps using baseRefOid.
    assert.match(
      section,
      /binds `baseRefOid`, not the merge base/,
      `10.1 must state the review key still binds baseRefOid, not the merge base, in ${name}`
    );
  }
});
