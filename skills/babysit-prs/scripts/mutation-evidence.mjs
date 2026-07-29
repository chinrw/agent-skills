#!/usr/bin/env node
/**
 * Bounded mutation experiment for a test-coverage finding.
 *
 * A candidate finding whose claim is essentially "this test does not actually
 * cover the behavior" must not be confirmed by reading alone when a safe,
 * focused experiment is available. Reading tells you the assertion looks weak;
 * only running tells you whether it fails when the production change is undone.
 *
 * The experiment:
 *   1. assert the worktree is disposable, at the expected HEAD, and clean
 *   2. run the focused baseline test, record it PASSING
 *   3. apply the minimal temporary mutation the claim implies
 *   4. rerun the SAME focused test
 *   5. restore the worktree
 *   6. prove cleanup with `git status --porcelain` + HEAD/tree checks
 *
 * Reading the result:
 *   mutation still passes -> `test-does-not-detect-regression`
 *                            the coverage gap is empirically CONFIRMED
 *   mutation fails        -> `test-detects-regression`
 *                            the coverage finding is REBUTTED
 *   anything else         -> `inconclusive`; the claim stays unconfirmed and
 *                            must not be auto-promoted to blocking
 *
 * Scope limits, deliberately: this runs in a DISPOSABLE exact-head worktree,
 * never the final fix worktree and never the main checkout; it touches no
 * external state; and it only reverts named paths or applies a supplied patch.
 * It is not for correctness/security findings, where reproducing the bug
 * directly is the stronger evidence.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { readJson, sha256Text, writeJsonAtomic } from "./lib/json-io.mjs";
import { assertValid } from "./lib/schema.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.join(HERE, "..", "schemas", "mutation-evidence-v1.schema.json");
const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000;

export class MutationEvidenceError extends Error {}

function git(cwd, args) {
  return spawnSync("git", args, { cwd, encoding: "utf8", timeout: 120000 });
}

function shell(command, cwd, timeoutMs) {
  const started = Date.now();
  const result = spawnSync(command, {
    cwd,
    shell: true,
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  return {
    command,
    exitCode: result.status,
    summary: summarizeOutput(output),
    outputSha256: sha256Text(output),
    durationMs: Date.now() - started,
    timedOut: Boolean(result.error && /ETIMEDOUT|timed out/i.test(String(result.error.message)))
  };
}

/**
 * Concise, non-leaking output summary: the last few meaningful lines only. The
 * full output never enters an artifact or the controller context; the hash
 * pins it instead.
 */
export function summarizeOutput(output, maxLines = 3, maxLength = 400) {
  const lines = String(output ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return "(no output)";
  return lines.slice(-maxLines).join(" | ").slice(0, maxLength);
}

/** The main worktree has .git as a directory; a linked worktree has a gitdir file. */
export function assertDisposableWorktree(worktree) {
  const resolved = path.resolve(worktree);
  if (!fs.existsSync(resolved)) {
    throw new MutationEvidenceError(`worktree "${resolved}" does not exist`);
  }

  const gitDir = git(resolved, ["rev-parse", "--path-format=absolute", "--git-dir"]);
  const commonDir = git(resolved, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (gitDir.status !== 0 || commonDir.status !== 0) {
    throw new MutationEvidenceError(`"${resolved}" is not a git worktree`);
  }

  const isMain = path.resolve(gitDir.stdout.trim()) === path.resolve(commonDir.stdout.trim());
  if (isMain) {
    throw new MutationEvidenceError(
      `Refusing to mutate "${resolved}": it is the main checkout, not a disposable worktree.`
    );
  }

  return { resolved, isMainCheckout: false };
}

export function worktreeStatus(worktree) {
  const porcelain = git(worktree, ["status", "--porcelain"]);
  const head = git(worktree, ["rev-parse", "HEAD"]);
  const treeMatches = git(worktree, ["diff", "--quiet", "HEAD"]);
  return {
    porcelain: (porcelain.stdout ?? "").trim(),
    clean: (porcelain.stdout ?? "").trim() === "",
    headOid: head.status === 0 ? head.stdout.trim() : null,
    treeMatchesHead: treeMatches.status === 0
  };
}

export function runExperiment(options) {
  const {
    worktree,
    findingId,
    attemptId,
    pr = null,
    reviewKey = null,
    baselineCommand,
    mutationMode,
    mutationRef = null,
    mutationPaths = [],
    patchFile = null,
    mutationDescription = null,
    mutationCommand = null,
    timeoutMs = DEFAULT_TIMEOUT_MS
  } = options;

  const { resolved } = assertDisposableWorktree(worktree);

  const before = worktreeStatus(resolved);
  if (!before.clean) {
    return inconclusive({
      findingId,
      attemptId,
      pr,
      reviewKey,
      worktree: resolved,
      headOid: before.headOid ?? "0".repeat(40),
      reason: "worktree-dirty-before-baseline",
      baseline: { command: baselineCommand, exitCode: null, summary: "(not run)" },
      mutation: {
        description: mutationDescription ?? describeMutation(mutationMode, mutationRef, mutationPaths, patchFile),
        command: mutationCommand ?? "(not run)",
        exitCode: null,
        summary: "(not run)",
        applied: false
      },
      cleanup: { clean: false, headOid: before.headOid ?? "0".repeat(40), porcelain: before.porcelain }
    });
  }

  const headOid = before.headOid;

  /* ------------------------------- baseline ------------------------------ */

  const baseline = shell(baselineCommand, resolved, timeoutMs);

  if (baseline.exitCode !== 0) {
    restore(resolved);
    const after = worktreeStatus(resolved);
    return inconclusive({
      findingId,
      attemptId,
      pr,
      reviewKey,
      worktree: resolved,
      headOid,
      reason: `baseline-test-did-not-pass (exit=${baseline.exitCode}); a coverage claim can only be tested against a passing baseline`,
      baseline,
      mutation: {
        description: mutationDescription ?? describeMutation(mutationMode, mutationRef, mutationPaths, patchFile),
        command: "(not run)",
        exitCode: null,
        summary: "(not run)",
        applied: false
      },
      cleanup: { clean: after.clean, headOid: after.headOid ?? headOid, porcelain: after.porcelain, treeMatchesHead: after.treeMatchesHead }
    });
  }

  /* ------------------------------- mutation ------------------------------ */

  const applied = applyMutation(resolved, { mutationMode, mutationRef, mutationPaths, patchFile });

  let mutationRun;
  if (!applied.ok) {
    mutationRun = {
      description: mutationDescription ?? describeMutation(mutationMode, mutationRef, mutationPaths, patchFile),
      mode: mutationMode,
      command: applied.command,
      exitCode: applied.exitCode,
      summary: applied.summary,
      applied: false,
      changedPaths: []
    };
  } else {
    const run = shell(baselineCommand, resolved, timeoutMs);
    mutationRun = {
      description: mutationDescription ?? describeMutation(mutationMode, mutationRef, mutationPaths, patchFile),
      mode: mutationMode,
      command: run.command,
      exitCode: run.exitCode,
      summary: run.summary,
      outputSha256: run.outputSha256,
      durationMs: run.durationMs,
      timedOut: run.timedOut,
      applied: true,
      changedPaths: applied.changedPaths
    };
  }

  /* ------------------------------- cleanup ------------------------------- */

  restore(resolved);
  const after = worktreeStatus(resolved);
  const cleanupClean = after.clean && after.headOid === headOid && after.treeMatchesHead;

  const cleanup = {
    clean: cleanupClean,
    headOid: after.headOid ?? headOid,
    porcelain: after.porcelain || null,
    treeMatchesHead: after.treeMatchesHead,
    residualRisk: cleanupClean
      ? null
      : "Mutation cleanup could not be proved. Source cleanliness is unestablished; do not publish from this worktree."
  };

  let conclusion;
  let inconclusiveReason = null;
  if (!mutationRun.applied) {
    conclusion = "inconclusive";
    inconclusiveReason = `mutation could not be applied safely: ${mutationRun.summary}`;
  } else if (mutationRun.timedOut) {
    conclusion = "inconclusive";
    inconclusiveReason = "mutation test run timed out";
  } else if (mutationRun.exitCode === 0) {
    conclusion = "test-does-not-detect-regression";
  } else {
    conclusion = "test-detects-regression";
  }

  return build({
    findingId,
    attemptId,
    pr,
    reviewKey,
    worktree: resolved,
    headOid,
    baseline,
    mutation: mutationRun,
    cleanup,
    conclusion,
    inconclusiveReason,
    mutationPaths
  });
}

function describeMutation(mode, ref, paths, patchFile) {
  if (mode === "restore-paths-from-ref") {
    return `temporarily restored ${paths.length} path(s) from ${ref}, reverting the production edits under test`;
  }
  if (mode === "apply-patch") {
    return `temporarily applied the supplied patch ${path.basename(String(patchFile))}`;
  }
  return "temporary minimal mutation";
}

function applyMutation(worktree, { mutationMode, mutationRef, mutationPaths, patchFile }) {
  if (mutationMode === "restore-paths-from-ref") {
    if (!mutationRef || mutationPaths.length === 0) {
      return { ok: false, command: "(none)", exitCode: null, summary: "restore-paths-from-ref requires --mutation-ref and --mutation-paths", changedPaths: [] };
    }
    const args = ["checkout", mutationRef, "--", ...mutationPaths];
    const result = git(worktree, args);
    if (result.status !== 0) {
      return {
        ok: false,
        command: `git ${args.join(" ")}`,
        exitCode: result.status,
        summary: summarizeOutput(`${result.stdout ?? ""}${result.stderr ?? ""}`),
        changedPaths: []
      };
    }
    const status = worktreeStatus(worktree);
    if (status.clean) {
      return {
        ok: false,
        command: `git ${args.join(" ")}`,
        exitCode: 0,
        summary: "mutation produced no change; the named paths are identical at that ref, so the experiment cannot discriminate",
        changedPaths: []
      };
    }
    return { ok: true, command: `git ${args.join(" ")}`, exitCode: 0, summary: "applied", changedPaths: mutationPaths };
  }

  if (mutationMode === "apply-patch") {
    if (!patchFile || !fs.existsSync(patchFile)) {
      return { ok: false, command: "(none)", exitCode: null, summary: "apply-patch requires an existing --patch file", changedPaths: [] };
    }
    const args = ["apply", "--whitespace=nowarn", path.resolve(patchFile)];
    const result = git(worktree, args);
    if (result.status !== 0) {
      return {
        ok: false,
        command: `git ${args.join(" ")}`,
        exitCode: result.status,
        summary: summarizeOutput(`${result.stdout ?? ""}${result.stderr ?? ""}`),
        changedPaths: []
      };
    }
    const status = worktreeStatus(worktree);
    return {
      ok: !status.clean,
      command: `git ${args.join(" ")}`,
      exitCode: 0,
      summary: status.clean ? "patch applied but produced no change" : "applied",
      changedPaths: status.porcelain.split("\n").map((line) => line.slice(3)).filter(Boolean)
    };
  }

  return { ok: false, command: "(none)", exitCode: null, summary: `unsupported mutation mode "${mutationMode}"`, changedPaths: [] };
}

/**
 * Undo the experiment completely.
 *
 * `git checkout <ref> -- <path>` updates the INDEX as well as the working tree,
 * so `git checkout -- .` alone would restore the worktree from an index that is
 * still mutated and leave the experiment half-applied. Reset the index to HEAD
 * first, then the tree, then remove anything untracked.
 *
 * `--hard` is safe here precisely because this only ever runs in a disposable
 * worktree that was proved clean before the baseline.
 */
function restore(worktree) {
  git(worktree, ["reset", "-q", "--hard", "HEAD"]);
  git(worktree, ["clean", "-qfd"]);
}

function inconclusive(ctx) {
  return build({
    ...ctx,
    conclusion: "inconclusive",
    inconclusiveReason: ctx.reason,
    baseline: normalizeRun(ctx.baseline),
    mutation: ctx.mutation,
    cleanup: ctx.cleanup
  });
}

function normalizeRun(run) {
  return {
    command: run.command,
    exitCode: run.exitCode ?? null,
    summary: run.summary ?? "(no summary)",
    outputSha256: run.outputSha256 ?? null,
    durationMs: run.durationMs ?? null,
    timedOut: run.timedOut ?? null
  };
}

function build(ctx) {
  const artifact = {
    schemaVersion: 1,
    findingId: ctx.findingId,
    attemptId: ctx.attemptId,
    pr: ctx.pr ?? null,
    reviewKey: ctx.reviewKey ?? null,
    worktree: ctx.worktree,
    headOid: ctx.headOid,
    baseline: normalizeRun(ctx.baseline),
    mutation: {
      description: ctx.mutation.description,
      mode: ctx.mutation.mode ?? null,
      command: ctx.mutation.command,
      exitCode: ctx.mutation.exitCode ?? null,
      summary: ctx.mutation.summary ?? "(no summary)",
      outputSha256: ctx.mutation.outputSha256 ?? null,
      durationMs: ctx.mutation.durationMs ?? null,
      timedOut: ctx.mutation.timedOut ?? null,
      applied: ctx.mutation.applied ?? null,
      changedPaths: ctx.mutation.changedPaths ?? []
    },
    cleanup: {
      clean: Boolean(ctx.cleanup.clean),
      headOid: ctx.cleanup.headOid,
      porcelain: ctx.cleanup.porcelain || null,
      treeMatchesHead: ctx.cleanup.treeMatchesHead ?? null,
      residualRisk: ctx.cleanup.residualRisk ?? null
    },
    conclusion: ctx.conclusion,
    inconclusiveReason: ctx.inconclusiveReason ?? null,
    safety: {
      disposableWorktree: true,
      isMainCheckout: false,
      mutationScopePaths: ctx.mutationPaths ?? []
    }
  };

  assertValid(readJson(SCHEMA_PATH), artifact, "mutation evidence artifact");
  return artifact;
}

/* --------------------------------- CLI ---------------------------------- */

function parseArgv(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      out._.push(token);
      continue;
    }
    const key = token.slice(2);
    if (key === "json" || key === "help") {
      out[key] = true;
      continue;
    }
    const next = argv[i + 1];
    if (next === undefined) {
      throw new MutationEvidenceError(`--${key} requires a value`);
    }
    out[key] = next;
    i += 1;
  }
  return out;
}

const USAGE = `Usage:
  node mutation-evidence.mjs run \\
    --worktree <disposable exact-head worktree> \\
    --finding-id R3 --attempt-id <id> \\
    --baseline-cmd "<focused test command>" \\
    --mutation-mode restore-paths-from-ref --mutation-ref <sha> --mutation-paths "a.py,b.py" \\
    [--mutation-mode apply-patch --patch <file>] \\
    [--pr N] [--review-key <hex>] [--timeout-ms N] \\
    --out <mutation-evidence.json>

Exit codes:
  0  conclusive (see .conclusion)
  1  inconclusive -- the finding stays unconfirmed / needs evidence
  2  usage or safety error (e.g. the target is the main checkout)
`;

function main(argv) {
  const args = parseArgv(argv);
  if (args.help || args._[0] !== "run") {
    process.stdout.write(USAGE);
    return args.help ? 0 : 2;
  }

  const artifact = runExperiment({
    worktree: args.worktree,
    findingId: args["finding-id"],
    attemptId: args["attempt-id"],
    pr: args.pr ? Number(args.pr) : null,
    reviewKey: args["review-key"] ?? null,
    baselineCommand: args["baseline-cmd"],
    mutationMode: args["mutation-mode"],
    mutationRef: args["mutation-ref"] ?? null,
    mutationPaths: args["mutation-paths"]
      ? String(args["mutation-paths"]).split(",").map((s) => s.trim()).filter(Boolean)
      : [],
    patchFile: args.patch ?? null,
    mutationDescription: args["mutation-description"] ?? null,
    timeoutMs: args["timeout-ms"] ? Number(args["timeout-ms"]) : DEFAULT_TIMEOUT_MS
  });

  if (args.out) {
    writeJsonAtomic(args.out, artifact);
  }
  process.stdout.write(`${JSON.stringify(artifact, null, 2)}\n`);
  return artifact.conclusion === "inconclusive" ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}
