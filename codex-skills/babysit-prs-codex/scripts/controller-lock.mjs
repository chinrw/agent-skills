#!/usr/bin/env node
import fs from "node:fs";
import { acquireLock, assertLock, inspectLock, releaseLock } from "./lib/repository-lock.mjs";
import { runCli } from "./lib/cli.mjs";

function main(argv) {
  const [action, checkout, argument] = argv;
  if (!checkout || argv.length > 3) throw new Error("usage: controller-lock.mjs acquire|adopt|status|release CHECKOUT [OWNER_JSON|TOKEN|PROOF_JSON]");
  let result;
  if (action === "status") result = inspectLock(checkout);
  else if (action === "acquire") result = acquireLock(checkout, JSON.parse(fs.readFileSync(argument, "utf8")));
  else if (action === "adopt") result = assertLock(checkout, argument);
  else if (action === "release") {
    const proof = JSON.parse(fs.readFileSync(argument, "utf8"));
    result = releaseLock(checkout, proof.token, proof);
  } else throw new Error(`unknown controller-lock operation: ${action}`);
  process.stdout.write(JSON.stringify(result) + "\n");
  return result.acquired === false ? 75 : 0;
}

runCli(import.meta.url, main);
