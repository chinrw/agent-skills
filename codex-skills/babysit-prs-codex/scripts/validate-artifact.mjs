#!/usr/bin/env node
import { readJson, writeJsonAtomic } from "./lib/json-io.mjs";
import { runCli } from "./lib/cli.mjs";
import { checkpointSummary, renderCheckpointContract, validateCheckpoint } from "./lib/checkpoint.mjs";
import { artifactSchema, renderArtifactContract, summarize, validateArtifactObject } from "./lib/task-artifact.mjs";
export { artifactSchema, renderArtifactContract, summarize, validateArtifactObject } from "./lib/task-artifact.mjs";

const IDENTITY_FIELDS = ["taskType", "pr", "headOid", "baseOid", "reviewKey", "attemptId"];

// Task completion comes from the native lifecycle tool, never from result JSON.
export function acceptArtifact({ input, output, expected = {}, status }) {
  const errors = [];
  if (status !== "completed") errors.push(`task-status=${status ?? "missing"}`);
  const checkpoint = expected.checkpointType !== undefined;
  for (const field of checkpoint ? ["checkpointType", "attemptId", "pr", "subject"] : IDENTITY_FIELDS) {
    if (expected[field] === undefined || expected[field] === null || expected[field] === "") {
      errors.push(`expected-identity-missing:${field}`);
    }
  }
  if (errors.length) return { ok: false, errors, sha256: null, summary: null };
  let artifact;
  try {
    artifact = readJson(input);
  } catch (error) {
    return { ok: false, errors: [`artifact-unreadable:${error.message}`], sha256: null, summary: null };
  }
  const result = checkpoint ? validateCheckpoint(artifact, expected) : validateArtifactObject(artifact, expected);
  if (result.ok && output) writeJsonAtomic(output, artifact);
  return { ok: result.ok, errors: result.errors, sha256: result.sha256, summary: result.ok ? (checkpoint ? checkpointSummary(artifact) : summarize(artifact)) : null };
}

const USAGE = `Usage:
  node validate-artifact.mjs --input <result.json> --expect <identity.json> --status completed [--out <canonical.json>]
  node validate-artifact.mjs contract --task-type <review|risk-review|fix|diagnosis|mutation>
  node validate-artifact.mjs contract --checkpoint-type <kind>

Exit codes: 0 accepted, 1 rejected, 2 usage error.
`;

function main(argv) {
  if (argv.includes("--help")) {
    process.stdout.write(USAGE);
    return 0;
  }
  const command = argv[0] === "contract" ? argv.shift() : "validate";
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i].startsWith("--") || !argv[i + 1] || argv[i + 1].startsWith("--")) throw new Error(USAGE);
    args[argv[i].slice(2)] = argv[i + 1];
  }
  if (command === "contract") {
    if (args["checkpoint-type"]) {
      process.stdout.write(`${renderCheckpointContract(args["checkpoint-type"])}\n`);
      return 0;
    }
    if (!artifactSchema().properties.taskType.enum.includes(args["task-type"])) throw new Error(USAGE);
    process.stdout.write(`${renderArtifactContract(args["task-type"])}\n`);
    return 0;
  }
  if (!args.input || !args.expect || !args.status) throw new Error(USAGE);
  const result = acceptArtifact({ input: args.input, output: args.out, expected: readJson(args.expect), status: args.status });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result.ok ? 0 : 1;
}

runCli(import.meta.url, main);
