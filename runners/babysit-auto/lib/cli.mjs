// Installed skill paths are symlinks; compare realpaths so a CLI cannot
// silently exit zero without running its entrypoint.

import { realpathSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export function isMainModule(metaUrl) {
  const entry = process.argv[1];
  if (!entry) {
    return false;
  }

  const modulePath = fileURLToPath(metaUrl);
  try {
    return realpathSync.native(entry) === realpathSync.native(modulePath);
  } catch {
    // One of the paths vanished mid-run; fall back to a lexical comparison
    // rather than throwing out of a module's top level.
    return path.resolve(entry) === path.resolve(modulePath);
  }
}

/**
 * Standard CLI entry wrapper: run `fn`, map a thrown error to exit code 2, and
 * never let an exception escape as an unhandled rejection.
 */
export function runCli(metaUrl, fn) {
  if (!isMainModule(metaUrl)) {
    return;
  }
  try {
    process.exitCode = fn(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}
