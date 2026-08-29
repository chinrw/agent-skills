/**
 * "Was this module run directly?" — symlink-safe.
 *
 * The obvious spelling is broken:
 *
 *     path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
 *
 * `path.resolve` does not resolve symlinks, but Node resolves `import.meta.url`
 * to the module's REAL path. So when the skill is installed as a symlink —
 * `~/.claude/skills/babysit-prs -> ~/Documents/play/skills/skills/babysit-prs` —
 * the two sides never match, `main()` never runs, and the CLI exits 0 having
 * done nothing at all.
 *
 * A silent success is the worst possible failure here: a caller that shells out
 * to `review-key.mjs classify` and switches on the exit code would read that 0
 * as "marker is current" and grant acceptance it never verified.
 *
 * Compare realpaths on both sides.
 */

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
