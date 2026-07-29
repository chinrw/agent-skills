/**
 * Non-regression guard for contracts that live in prose.
 *
 * Several invariants of this skill are enforced by SKILL.md and the agent
 * definitions rather than by code: dry-run does no remote writes, merges are
 * head-matched, `main` is never merged into. Editing a 1600-line document is
 * exactly how such a rule quietly disappears, so they are asserted here.
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
    assert.ok(SKILL.includes(rule), `dry-run rule missing: ${rule}`);
  }
  assert.ok(SKILL.includes("`--dry-run` never posts an external-review trigger."));
});

test("--snapshot-only is defined as strictly stronger than --dry-run", () => {
  const { scalars } = frontmatter(SKILL);
  assert.ok(
    scalars["argument-hint"].includes("--snapshot-only"),
    "the flag must be discoverable from the argument hint"
  );

  assert.ok(SKILL.includes("### 1.1 `--snapshot-only`"));
  assert.ok(SKILL.includes("`--snapshot-only` implies `--dry-run`"));
  assert.ok(
    SKILL.includes("`--snapshot-only` and `--merge-integration` together are contradictory."),
    "snapshot-only must not coexist with a merge-enabling flag"
  );

  // Everything the mode is forbidden to do.
  for (const prohibition of [
    "dispatch any Codex task, read-only or otherwise",
    "dispatch any Claude judgment or verification agent",
    "create, modify, or remove a worktree",
    "run project tests, builds, or servers",
    "perform any GitHub write of any kind"
  ]) {
    assert.ok(SKILL.includes(prohibition), `snapshot-only prohibition missing: ${prohibition}`);
  }

  assert.ok(SKILL.includes("🔎 SNAPSHOT:"), "the report label must exist");
  assert.ok(
    SKILL.includes("Snapshot-only\nnever advances a state machine"),
    "snapshot-only must be read-only with respect to state"
  );
  assert.ok(
    SKILL.includes("never as satisfied"),
    "missing evidence must not be reported as a satisfied gate"
  );
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
    assert.ok(SKILL.includes(rule), `merge rule missing: ${rule}`);
  }
});

test("collision, independent-verification, and stacked-merge rules are intact", () => {
  for (const rule of [
    "stand down rather than duplicate or overwrite",
    "A Codex claim is not acceptance. A fresh Claude verifier and real local gates",
    "process innermost-first",
    "Never let two writers overlap.",
    "Never resolve a thread without a pushed fix or evidence-backed disposition."
  ]) {
    assert.ok(SKILL.includes(rule), `rule missing: ${rule}`);
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
    assert.ok(SKILL.includes(rule), `external-review rule missing: ${rule}`);
  }
  // The relaxed strict-stacked rule stays policy-driven.
  assert.ok(SKILL.includes("`strictStackedMode = one-round`"));
  assert.ok(SKILL.includes("Never apply the relaxed strict-stack rule to a root or integration PR."));
});

test("the bounded convergence loop is still bounded", () => {
  assert.ok(SKILL.includes("max waves: 8"));
  assert.ok(SKILL.includes("--max-waves N"));
  assert.ok(SKILL.includes("The invocation is bounded. The external-review retry loop is not."));
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
    assert.ok(SKILL.includes(rule), `repaired contract missing: ${rule}`);
  }
});

test("the ambiguous read-only phrasing is gone", () => {
  assert.ok(!/STRICTLY READ-ONLY/.test(SKILL));
  assert.ok(
    !/source read-only;\s*write assigned artifact/i.test(SKILL),
    "the 'read-only except write your artifact' phrasing must not return"
  );
  // Replaced by the explicit three-line labels.
  assert.ok(SKILL.includes("Source mutation policy:     FORBIDDEN."));
  assert.ok(SKILL.includes("Filesystem artifact:        NOT REQUIRED FOR READ-ONLY TASKS."));
  assert.ok(SKILL.includes("Source mutation policy:      ALLOWED ONLY IN ASSIGNED WORKTREE/SCOPE."));
});

test("Codex tasks route through codex-job.mjs, never the codex-rescue wrapper", () => {
  assert.ok(
    SKILL.includes("**Do not use the `codex:codex-rescue` agent for any babysit-prs Codex task.**"),
    "the prohibition must be explicit"
  );
  assert.ok(SKILL.includes("It cannot pin the launch cwd."));
  assert.ok(
    SKILL.includes("Prompt text cannot fix any of this"),
    "the reason must be stated as structural, not a prompting problem"
  );

  // The wrapper must never be named as the mechanism for launching a lane.
  assert.ok(
    !/Use `codex:codex-rescue` with these lanes/.test(SKILL),
    "the old 'use codex-rescue with these lanes' instruction must be gone"
  );

  // Every surviving mention is a prohibition, not an instruction.
  const mentions = SKILL.split("\n").filter((line) => line.includes("codex-rescue"));
  assert.ok(mentions.length > 0);
  for (const line of mentions) {
    assert.ok(
      /Do not use|never|cannot|not use/i.test(line),
      `codex-rescue mentioned without a prohibition: ${line.trim()}`
    );
  }
});

test("the launcher's sandbox is described honestly", () => {
  assert.ok(SKILL.includes("There is **no path-scoped sandbox**"));
  assert.ok(SKILL.includes("is not an enforcement boundary"));
  assert.ok(
    SKILL.includes("**Do not enable workspace write merely to\nobtain a review artifact.**"),
    "the prohibition on widening write mode for an artifact must remain"
  );
});

test("the deployed review-key compatibility vector is pinned in the doc", () => {
  assert.ok(SKILL.includes("90eb74228b4dd711956acd443b74c215d2212192b8ddabc57e499037e8ab0681"));
  assert.ok(SKILL.includes("payloadLength 119   trailingNul=false"));
  assert.ok(SKILL.includes("scripts/review-key.mjs"));
});

test("the legacy marker migration is documented and never grants acceptance", () => {
  assert.ok(SKILL.includes("v2-legacy-trailing-nul"));
  assert.ok(SKILL.includes("Legacy marker dialects — recognize, never accept"));
  assert.ok(SKILL.includes("Only exit `0` proves review-current."));
  assert.ok(SKILL.includes('Do not "repair" a legacy marker by copying its old key forward.'));
  assert.ok(SKILL.includes("A marker written under a legacy dialect is recognized, never accepted."));
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

  for (const value of severity) {
    assert.ok(
      SKILL.includes(value),
      `SKILL.md must name the legal severity "${value}" so prompt authors cannot drift`
    );
  }
  assert.match(
    SKILL,
    /"non-blocking" is NOT in the enum/,
    "SKILL.md must call out the specific value that was observed failing"
  );
});

test("the review range is three-dot, and identity still binds the base tip", () => {
  // A live run found every in-scope PR's baseRefOid was NOT the merge base:
  // stocks-dev had advanced, so the two-dot range reported 32-34 files where
  // the PR authored 1-3. Scoping a review two-dot attributes base drift to the
  // PR -- and lets the spec selector bind to spec files that arrived from the
  // base, which is the exact wrong-spec failure the selector exists to prevent.
  const section = SKILL.slice(SKILL.indexOf("### 10.1"), SKILL.indexOf("### 10.2"));
  assert.ok(section.length > 0, "section 10.1 must exist");

  assert.match(section, /three-dot/i, "10.1 must name the three-dot range");
  assert.match(
    section,
    /<baseRefOid>\.\.\.<headRefOid>/,
    "10.1 must show the three-dot range literally"
  );
  assert.match(section, /merge-base/, "10.1 must resolve the merge base explicitly");

  // The bare two-dot form must not survive as the stated review range.
  assert.ok(
    !/```text\s*\n<baseRefOid>\.\.<headRefOid>\s*\n```/.test(section),
    "the two-dot range must not be presented as the review range"
  );

  // Scope and identity are deliberately different: an advancing base must still
  // invalidate acceptance, so the KEY keeps using baseRefOid.
  assert.match(
    section,
    /binds `baseRefOid`, not the merge base/,
    "10.1 must state the review key still binds baseRefOid, not the merge base"
  );
});
