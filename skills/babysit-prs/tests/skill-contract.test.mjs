/**
 * Non-regression guard for contracts that live in prose.
 *
 * Several invariants of this skill are enforced by SKILL.md and the agent
 * definitions rather than by code: dry-run does no remote writes, merges are
 * head-matched, `main` is never merged into. Editing a 1600-line document is
 * exactly how such a rule quietly disappears, so they are asserted here.
 *
 * The Codex CLI port (codex-skills/babysit-prs-codex) restates almost every
 * one of these invariants; shared pins therefore run against both variants,
 * so a rule cannot survive in one file while quietly dying in the other.
 *
 * This also validates every YAML frontmatter block, JSON Schema, and fixture
 * the skill ships.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { validate } from "../scripts/lib/schema.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = path.join(HERE, "..");
const AGENT_DIR = path.join(process.env.HOME ?? "", ".claude", "agents");

const SKILL = fs.readFileSync(path.join(SKILL_DIR, "SKILL.md"), "utf8");
const CODEX_SKILL = fs.readFileSync(
  path.join(SKILL_DIR, "..", "..", "codex-skills", "babysit-prs-codex", "SKILL.md"),
  "utf8"
);

const VARIANTS = [
  { name: "skills/babysit-prs/SKILL.md", text: SKILL },
  { name: "codex-skills/babysit-prs-codex/SKILL.md", text: CODEX_SKILL }
];

/** A rule both variants must state verbatim; the failure names the file. */
function assertShared(rule, label) {
  for (const { name, text } of VARIANTS) {
    assert.ok(text.includes(rule), `${label} missing from ${name}: ${rule}`);
  }
}

/**
 * Same invariant, deliberately renamed per harness (Claude agents vs Codex
 * checkpoints, codex-rescue vs bare `codex exec`). Each side is pinned
 * against its own file so neither phrasing can quietly disappear.
 */
function assertTwin(claudeRule, codexRule, label) {
  assert.ok(
    SKILL.includes(claudeRule),
    `${label} missing from ${VARIANTS[0].name}: ${claudeRule}`
  );
  assert.ok(
    CODEX_SKILL.includes(codexRule),
    `${label} missing from ${VARIANTS[1].name}: ${codexRule}`
  );
}

const AGENTS = [
  "babysit-pr-spec-selector",
  "babysit-pr-finding-judge",
  "babysit-pr-thread-judge",
  "babysit-pr-verifier",
  "babysit-pr-composition-verifier",
  "babysit-pr-critical-composition-verifier"
];

/** Minimal frontmatter reader: enough to assert the fields we care about. */
function frontmatter(text) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  assert.ok(match, "file must start with a YAML frontmatter block");
  const body = match[1];

  const scalars = {};
  for (const line of body.split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/);
    if (kv && kv[2] !== "" && !kv[2].startsWith(">") && !kv[2].startsWith("|")) {
      scalars[kv[1]] = kv[2].trim();
    }
  }
  return { body, scalars };
}

/* ------------------------------ frontmatter ------------------------------- */

test("SKILL.md frontmatter keeps the model and effort contract", () => {
  const { scalars } = frontmatter(SKILL);
  assert.equal(scalars.name, "babysit-prs");
  assert.equal(scalars.model, "best", "the outer controller must stay on the strongest model");
  assert.equal(scalars.effort, "xhigh");
  assert.equal(scalars["disable-model-invocation"], "true");
  assert.equal(scalars["user-invocable"], "true");
});

test("SKILL.md still permits the tools the helper scripts need", () => {
  const { body } = frontmatter(SKILL);
  for (const tool of ['Bash(node *)', 'Bash(git *)', 'Bash(gh *)', "Agent", "Write"]) {
    assert.ok(body.includes(tool), `allowed-tools must include ${tool}`);
  }
});

test("every babysit-pr agent keeps its model and effort, and none was downgraded", () => {
  const expectedEffort = {
    "babysit-pr-spec-selector": "xhigh",
    "babysit-pr-finding-judge": "max",
    "babysit-pr-thread-judge": "max",
    "babysit-pr-verifier": "max",
    "babysit-pr-composition-verifier": "xhigh",
    "babysit-pr-critical-composition-verifier": "max"
  };

  for (const name of AGENTS) {
    const file = path.join(AGENT_DIR, `${name}.md`);
    assert.ok(fs.existsSync(file), `${name} must exist`);
    const { scalars } = frontmatter(fs.readFileSync(file, "utf8"));
    assert.equal(scalars.name, name);
    assert.equal(scalars.model, "inherit", `${name} must inherit the outer best model`);
    assert.equal(scalars.effort, expectedEffort[name], `${name} effort`);
  }
});

/* --------------------------- schemas and fixtures ------------------------- */

test("every shipped JSON Schema parses and only uses supported keywords", () => {
  const dir = path.join(SKILL_DIR, "schemas");
  const files = fs.readdirSync(dir).filter((name) => name.endsWith(".schema.json"));
  assert.ok(files.length >= 4, "the four v1 schemas must be present");

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

/**
 * Parse one JSON document, or several concatenated ones.
 *
 * Splits on top-level bracket depth, tracking string state so a `{` inside a
 * string literal does not shift the depth.
 */
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

test("every helper script is syntactically valid ES module code", async () => {
  const dir = path.join(SKILL_DIR, "scripts");
  const scripts = fs.readdirSync(dir).filter((name) => name.endsWith(".mjs"));
  assert.ok(scripts.length >= 6);
  for (const name of scripts) {
    await import(path.join(dir, name));
  }
  for (const name of fs.readdirSync(path.join(dir, "lib")).filter((f) => f.endsWith(".mjs"))) {
    await import(path.join(dir, "lib", name));
  }
});

/* ------------------------- preserved hard invariants ---------------------- */

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

test("--snapshot-only is defined as strictly stronger than --dry-run", () => {
  // Only the Claude skill carries an argument-hint; the port's frontmatter
  // has no such field.
  const { scalars } = frontmatter(SKILL);
  assert.ok(
    scalars["argument-hint"].includes("--snapshot-only"),
    "the flag must be discoverable from the argument hint"
  );

  assertShared("### 1.1 `--snapshot-only`", "snapshot-only section");
  assertShared("`--snapshot-only` implies `--dry-run`", "snapshot-only rule");
  assertShared(
    "`--snapshot-only` and `--merge-integration` together are contradictory.",
    "snapshot-only must not coexist with a merge-enabling flag"
  );

  // Everything the mode is forbidden to do.
  for (const prohibition of [
    "dispatch any Codex task, read-only or otherwise",
    "create, modify, or remove a worktree",
    "run project tests, builds, or servers",
    "perform any GitHub write of any kind"
  ]) {
    assertShared(prohibition, "snapshot-only prohibition");
  }
  // The judgment layer is Claude agents in the skill, checkpoints in the port.
  assertTwin(
    "dispatch any Claude judgment or verification agent",
    "dispatch any judgment or verification checkpoint",
    "snapshot-only judgment prohibition"
  );

  assertShared("🔎 SNAPSHOT:", "the report label");
  assertShared(
    "Snapshot-only\nnever advances a state machine",
    "snapshot-only must be read-only with respect to state"
  );
  assertShared("never as satisfied", "missing evidence must not satisfy a gate");
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
  // The verifier is a fresh Claude agent in the skill and a fresh checkpoint
  // in the port; both must refuse an implementer's own claim as acceptance.
  assertTwin(
    "A Codex claim is not acceptance. A fresh Claude verifier and real local gates",
    "An implementer claim is not acceptance. A fresh verifier checkpoint and real",
    "independent-verification rule"
  );
});

test("merged worktrees are reclaimed, and only on authoritative merge state", () => {
  for (const rule of [
    // The collision constraint stays; the exception to it is what is new.
    "Clean up only worktrees owned by this run.",
    "may be removed by\nany run, not only its owner",
    // All four clauses of the predicate.
    "`git -C <worktree> status --porcelain` prints nothing",
    "the PR that owns it is `MERGED` on GitHub",
    "it is neither the main checkout nor the worktree this run executes from",
    // PR resolution is branch-first: worktree names follow no convention, so a
    // name-pattern rule resolves almost nothing and the sweep goes inert.
    "gh pr list --repo chinrw/stocks --head <branch> --state all --json number,state",
    "`OPEN` outranks `MERGED`",
    "gh pr view <N> --repo chinrw/stocks --json state --jq .state",
    "not a `pr<N>-` prefix",
    "`worktree-agent-*`",
    // The 3-digit floor and the no-guess branch. Dropping either lets a random
    // suffix resolve to a real merged low-numbered PR and deletes an unrelated
    // worktree; the `gh pr view` confirmation cannot catch it, the PR is real.
    "digit runs of **three or more** digits",
    "two or more distinct runs — unresolved",
    "PR numbers here are three digits",
    // Squash merges make ancestry useless here; keep the reason in the doc.
    "This repository squash-merges",
    "`git merge-base --is-ancestor` reports",
    // Both call sites, plus the modes that must not reclaim anything.
    "Once `state=MERGED` is verified, reclaim that PR's worktree",
    "### 3.2 Startup worktree sweep",
    "do not sweep or remove worktrees (section 3.2)",
    "Skip the sweep entirely under `--dry-run` and `--snapshot-only`",
    "Never `--force`."
  ]) {
    assertShared(rule, "worktree reclamation rule");
  }
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

/* --------------------------- newly repaired rules ------------------------- */

test("the repaired runtime contracts are documented", () => {
  for (const rule of [
    "Never ask Codex to write outside `LAUNCH_CWD`",
    "BABYSIT_PR_ARTIFACT_V1",
    "BLOCKED: artifact-channel-mismatch",
    "BLOCKED: codex-output-incomplete",
    "REVIEW_INCONCLUSIVE",
    "POLLING_CONTEXT_ERROR",
    "JOB_RECORD_MISSING",
    "JOB_STALE_PID",
    "JOB_STALLED",
    "effective_effort = highest accepted effort <= requested effort",
    "requested=max effective=xhigh reason=companion-ceiling",
    "NO TRAILING NUL",
    "babysit-prs-probe.XXXXXX"
  ]) {
    assertShared(rule, "repaired contract");
  }
});

test("the ambiguous read-only phrasing is gone", () => {
  for (const { name, text } of VARIANTS) {
    assert.ok(!/STRICTLY READ-ONLY/.test(text), `ambiguous phrasing returned in ${name}`);
    assert.ok(
      !/source read-only;\s*write assigned artifact/i.test(text),
      `the 'read-only except write your artifact' phrasing must not return in ${name}`
    );
  }
  // Replaced by the explicit three-line labels.
  assertShared("Source mutation policy:     FORBIDDEN.", "sandbox label");
  assertShared(
    "Filesystem artifact:        NOT REQUIRED FOR READ-ONLY TASKS.",
    "sandbox label"
  );
  assertShared(
    "Source mutation policy:      ALLOWED ONLY IN ASSIGNED WORKTREE/SCOPE.",
    "sandbox label"
  );
});

test("Codex tasks route through codex-job.mjs, never the codex-rescue wrapper", () => {
  // Same invariant, per-harness phrasing: the Claude skill bans its
  // codex-rescue wrapper, the port bans the equivalent unpinned launch — a
  // bare `codex exec` — and both must state the launch-cwd reason.
  assertTwin(
    "**Do not use the `codex:codex-rescue` agent for any babysit-prs Codex task.**",
    "Do not run any babysit-prs Codex task as a bare `codex exec` call",
    "unpinned-launch prohibition"
  );
  assertTwin(
    "It cannot pin the launch cwd.",
    "It does not honour the launch-cwd contract.",
    "launch-cwd reason"
  );
  assertShared(
    "Prompt text cannot fix any of this",
    "the reason must be stated as structural, not a prompting problem"
  );

  for (const { name, text } of VARIANTS) {
    // The wrapper must never be named as the mechanism for launching a lane.
    assert.ok(
      !/Use `codex:codex-rescue` with these lanes/.test(text),
      `the old 'use codex-rescue with these lanes' instruction must be gone from ${name}`
    );

    // Every surviving mention is a prohibition, not an instruction. The port
    // names the wrapper once while attributing the ban to the Claude skill;
    // that exact line is the only permitted non-prohibition phrasing there.
    const codexExemptLine = "bans its `codex:codex-rescue` wrapper:";
    const mentions = text.split("\n").filter((line) => line.includes("codex-rescue"));
    assert.ok(mentions.length > 0, `${name} must still state the wrapper ban`);
    for (const line of mentions) {
      if (name.startsWith("codex-skills/") && line.trim() === codexExemptLine) continue;
      assert.ok(
        /Do not use|never|cannot|not use/i.test(line),
        `codex-rescue mentioned without a prohibition in ${name}: ${line.trim()}`
      );
    }
  }
});

test("the launcher's sandbox is described honestly", () => {
  assertShared("There is **no path-scoped sandbox**", "sandbox honesty rule");
  assertShared("is not an enforcement boundary", "sandbox honesty rule");
  assertShared(
    "**Do not enable workspace write merely to\nobtain a review artifact.**",
    "the prohibition on widening write mode for an artifact must remain"
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
    "babysit-pr-finding-judge",
    "babysit-pr-thread-judge",
    "babysit-pr-verifier",
    "babysit-pr-critical-composition-verifier"
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
  const text = fs.readFileSync(path.join(AGENT_DIR, "babysit-pr-finding-judge.md"), "utf8");
  assert.ok(text.includes("requiresMutationEvidence"));
  assert.ok(text.includes("test-does-not-detect-regression"));
  assert.ok(text.includes("test-detects-regression"));
  assert.ok(text.includes("Reading alone never confirms it."));
});

test("the mandated review prompt states the schema's severity enum verbatim", () => {
  // A live run lost a completed Sol review to `severity: "non-blocking"`, which
  // is not in the schema enum. The prompt text in 10.3 is what task authors copy,
  // so if it does not name the legal values they drift -- and the failure only
  // surfaces on the first review that returns a genuinely non-blocking finding,
  // long after the prompt was written.
  const schema = JSON.parse(
    fs.readFileSync(path.join(SKILL_DIR, "schemas", "codex-artifact-v1.schema.json"), "utf8")
  );
  const severity = schema.definitions?.finding?.properties?.severity?.enum;
  assert.ok(Array.isArray(severity) && severity.length > 0, "the schema must pin a severity enum");

  for (const { name, text } of VARIANTS) {
    for (const value of severity) {
      assert.ok(
        text.includes(value),
        `${name} must name the legal severity "${value}" so prompt authors cannot drift`
      );
    }
    assert.match(
      text,
      /"non-blocking" is NOT in the enum/,
      `${name} must call out the specific value that was observed failing`
    );
  }
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

/* ------------------------- cross-variant drift guard ---------------------- */

// Shared mechanism sections must not silently diverge between the two
// variants; divergence must be an explicit decision that moves the section
// out of this list.
const IDENTICAL_SECTIONS = [6, 9, 14, 18, 19];

/** Extract `## <n>. ...` up to, not including, the next `## ` heading. */
function section(text, n) {
  const heading = text.match(new RegExp(`^## ${n}\\. .*$`, "m"));
  if (!heading) return null;
  const start = heading.index;
  const rest = text.slice(start + heading[0].length);
  const next = rest.search(/^## /m);
  return next === -1
    ? text.slice(start)
    : text.slice(start, start + heading[0].length + next);
}

test("shared mechanism sections are byte-identical across both variants", () => {
  for (const n of IDENTICAL_SECTIONS) {
    const a = section(SKILL, n);
    const b = section(CODEX_SKILL, n);
    assert.ok(a, `section ${n} missing from ${VARIANTS[0].name}`);
    assert.ok(b, `section ${n} missing from ${VARIANTS[1].name}`);
    if (a === b) continue;

    const aLines = a.split("\n");
    const bLines = b.split("\n");
    let i = 0;
    while (i < aLines.length && i < bLines.length && aLines[i] === bLines[i]) i += 1;
    assert.fail(
      `section ${n} ("${aLines[0]}") diverged at line ${i + 1}:\n` +
        `  ${VARIANTS[0].name}: ${aLines[i] ?? "<end of section>"}\n` +
        `  ${VARIANTS[1].name}: ${bLines[i] ?? "<end of section>"}`
    );
  }
});

/* ---------------- fix lane and artifact contract (agent-skills#1) ---------------- */

test("fix tasks are told not to commit; the controller owns the fix commit", () => {
  assertShared("a linked-worktree sandbox cannot write", "fix-task no-commit rule");
  assertShared(
    "The controller — not the Codex task — creates the signed commit",
    "controller-owned fix commit"
  );
  assertShared("schema-derived `ARTIFACT CONTRACT` block", "schema-derived prompt contract");
});

test("the identity-field split is explicit, not 'the same identity fields'", () => {
  assertShared("pr and attemptId are top-level", "identity split");
  for (const { name, text } of VARIANTS) {
    assert.ok(
      !text.includes("the same identity\nfields"),
      `ambiguous identity phrasing survives in ${name}`
    );
  }
});

test("the controller preflight exports and canaries CLAUDE_SKILL_DIR", () => {
  assert.ok(
    SKILL.includes('export CLAUDE_SKILL_DIR="${CLAUDE_SKILL_DIR:-$HOME/.claude/skills/babysit-prs}"'),
    "CLAUDE_SKILL_DIR export missing from controller preflight"
  );
  assert.ok(
    SKILL.includes("BLOCKED: CLAUDE_SKILL_DIR canary failed"),
    "CLAUDE_SKILL_DIR canary missing from controller preflight"
  );
});
