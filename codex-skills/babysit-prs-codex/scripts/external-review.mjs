#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readJson, writeJsonAtomic, canonicalHash } from "./lib/json-io.mjs";
import { KNOWN_FIELDS, parseMarker, formatMarker } from "./lib/marker.mjs";
import { computeReviewKey } from "./review-key.mjs";
import { runCli } from "./lib/cli.mjs";

const EVALUATOR = fileURLToPath(new URL("./external_review.py", import.meta.url));
const EXTERNAL_FIELDS = KNOWN_FIELDS.filter(name => name.startsWith("codex") && name !== "codex");

function evaluate(command, input) {
  const child = spawnSync("python3", [EVALUATOR, command], {
    input: JSON.stringify(input), encoding: "utf8", maxBuffer: 32 * 1024 * 1024,
    timeout: 60000, env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" }
  });
  if (child.error || child.status !== 0) throw new Error(child.error?.message ?? child.stderr.trim());
  return JSON.parse(child.stdout);
}

export function handoff(inputPath) {
  const manifest = readJson(inputPath);
  const directory = path.dirname(path.resolve(inputPath));
  const sources = {};
  for (const name of ["pr", "base", "comments", "reactions", "threads"]) {
    if (typeof manifest.files?.[name] !== "string") throw new Error(`missing source file: ${name}`);
    sources[name] = fs.readFileSync(path.resolve(directory, manifest.files[name]), "utf8");
  }
  const policy = manifest.policy === undefined ? {} : readJson(path.resolve(directory, manifest.policy));
  const observation = evaluate("normalize", { ...manifest, sources, policy });
  if (!manifest.expected?.headOid || !manifest.expected?.baseOid) throw new Error("expected head/base required");
  const computed = computeReviewKey({ repo: manifest.repo, pr: manifest.pr,
    headOid: manifest.expected.headOid, baseOid: manifest.expected.baseOid, specHash: manifest.marker?.spec });
  if (computed !== manifest.marker?.key) throw new Error("marker review key does not match the assignment");
  if (typeof manifest.marker.state !== "string" || !manifest.marker.state) throw new Error("marker state required");
  for (const comment of [...observation.comments].reverse()) {
    const marker = parseMarker(comment.body);
    if (marker.dialect === "v2" && marker.fields.pr === String(manifest.pr)) {
      observation.persisted = Object.fromEntries(EXTERNAL_FIELDS.filter(key => marker.fields[key] !== undefined).map(key => [key, marker.fields[key]]));
      break;
    }
  }
  let postedTrigger;
  if (manifest.postedTrigger) {
    postedTrigger = { ...manifest.postedTrigger };
    if (postedTrigger.status === "confirmed") postedTrigger.receipt = readJson(path.resolve(directory, postedTrigger.file));
  }
  const transitioned = evaluate("transition", { observation, postedTrigger });
  const decision = transitioned.decision;
  const persisted = Object.fromEntries(EXTERNAL_FIELDS.map(key => [key, decision[key] ?? null]));
  const marker = decision.requiresResnapshot || decision.codexState === "STOPPED_PR_CLOSED" ? null : formatMarker({
    pr: manifest.pr, head: observation.head.oid, base: observation.base.oid,
    spec: manifest.marker.spec, key: manifest.marker.key,
    state: decision.skillState ?? manifest.marker.state, codex: decision.codexState, ...persisted
  });
  return { observation: transitioned.observation, decision, persisted, marker };
}

const USAGE = `Usage:
  node external-review.mjs --input <manifest.json> --out <handoff.json>

Reads local gh output files. Performs no network requests or GitHub writes.
Exit codes: 0 evaluated (inspect decision), 2 invalid input or I/O error.
`;

function main(argv) {
  if (argv.includes("--help")) { process.stdout.write(USAGE); return 0; }
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!["--input", "--out"].includes(argv[i]) || !argv[i + 1]) throw new Error(USAGE);
    args[argv[i].slice(2)] = argv[i + 1];
  }
  if (!args.input || !args.out) throw new Error(USAGE);
  const result = handoff(args.input);
  writeJsonAtomic(args.out, result);
  process.stdout.write(`${JSON.stringify({ action: result.decision.action, codexState: result.decision.codexState,
    codexRound: result.decision.codexRound, codexNextTriggerAt: result.decision.codexNextTriggerAt,
    requiresResnapshot: result.decision.requiresResnapshot, artifact: args.out, sha256: canonicalHash(result) })}\n`);
  return 0;
}

runCli(import.meta.url, main);
