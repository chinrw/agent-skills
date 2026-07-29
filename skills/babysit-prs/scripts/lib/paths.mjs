/**
 * Path containment. A Codex task reports where it thinks it wrote a staging
 * artifact; that claim is untrusted input and must never be able to name a file
 * outside the launch root.
 */

import fs from "node:fs";
import path from "node:path";

/**
 * Resolve `candidate` against `root` and refuse anything that escapes it.
 *
 * Escapes are rejected both lexically (`../`, absolute paths pointing
 * elsewhere) and after symlink resolution, so a symlink planted inside the
 * launch root cannot redirect a write into the canonical run directory.
 *
 * Returns `{ ok, path, reason }`.
 */
export function resolveWithinRoot(root, candidate) {
  if (typeof candidate !== "string" || candidate.trim() === "") {
    return { ok: false, path: null, reason: "empty-path" };
  }
  if (candidate.includes("\0")) {
    return { ok: false, path: null, reason: "nul-byte-in-path" };
  }

  const rootAbs = realpathOrSelf(path.resolve(root));
  const resolved = path.resolve(rootAbs, candidate);

  if (!isInside(rootAbs, resolved)) {
    return { ok: false, path: resolved, reason: "path-escapes-root" };
  }

  // Resolve symlinks on the longest existing prefix. A staging file that is
  // itself a symlink out of the root is an escape, even though its lexical path
  // looks contained.
  const real = realpathOfLongestExistingPrefix(resolved);
  if (!isInside(rootAbs, real.resolvedPath)) {
    return { ok: false, path: resolved, reason: "symlink-escapes-root" };
  }

  return { ok: true, path: resolved, reason: null };
}

export function isInside(root, candidate) {
  const rootAbs = path.resolve(root);
  const candidateAbs = path.resolve(candidate);
  if (candidateAbs === rootAbs) {
    return true;
  }
  return candidateAbs.startsWith(rootAbs.endsWith(path.sep) ? rootAbs : `${rootAbs}${path.sep}`);
}

function realpathOrSelf(target) {
  try {
    return fs.realpathSync.native(target);
  } catch {
    return target;
  }
}

function realpathOfLongestExistingPrefix(target) {
  let current = path.resolve(target);
  const tail = [];

  for (;;) {
    try {
      const real = fs.realpathSync.native(current);
      return { resolvedPath: path.resolve(real, ...tail.reverse()), existingPrefix: current };
    } catch (error) {
      if (!error || (error.code !== "ENOENT" && error.code !== "ENOTDIR")) {
        return { resolvedPath: path.resolve(target), existingPrefix: null };
      }
      const parent = path.dirname(current);
      if (parent === current) {
        return { resolvedPath: path.resolve(target), existingPrefix: null };
      }
      tail.push(path.basename(current));
      current = parent;
    }
  }
}
