/**
 * Deterministic JSON canonicalization, hashing, and atomic writes.
 *
 * Every artifact this skill accepts as evidence is hashed through
 * `canonicalHash`, so two channels that carry the same logical result produce
 * the same digest regardless of key order or whitespace.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * RFC-8785-style canonical JSON: object keys sorted by UTF-16 code unit, no
 * insignificant whitespace, no non-finite numbers.
 */
export function canonicalize(value) {
  return serialize(value, new Set());
}

function serialize(value, seen) {
  if (value === null) {
    return "null";
  }

  const kind = typeof value;

  if (kind === "boolean") {
    return value ? "true" : "false";
  }

  if (kind === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`Non-finite number cannot be canonicalized: ${value}`);
    }
    // JSON.stringify already emits the shortest round-tripping form.
    return JSON.stringify(value);
  }

  if (kind === "string") {
    return JSON.stringify(value);
  }

  if (kind !== "object") {
    throw new Error(`Unsupported JSON type: ${kind}`);
  }

  if (seen.has(value)) {
    throw new Error("Cyclic structure cannot be canonicalized.");
  }
  seen.add(value);

  let out;
  if (Array.isArray(value)) {
    out = `[${value.map((entry) => serialize(entry, seen)).join(",")}]`;
  } else {
    const keys = Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort();
    out = `{${keys
      .map((key) => `${JSON.stringify(key)}:${serialize(value[key], seen)}`)
      .join(",")}}`;
  }

  seen.delete(value);
  return out;
}

export function canonicalHash(value) {
  return createHash("sha256").update(Buffer.from(canonicalize(value), "utf8")).digest("hex");
}

export function sha256Text(text) {
  return createHash("sha256").update(Buffer.from(String(text ?? ""), "utf8")).digest("hex");
}

export function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

export function readJsonIfExists(filePath) {
  try {
    return readJson(filePath);
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

/**
 * Write JSON with a temp-file + fsync + rename sequence so a reader never sees
 * a torn artifact. Returns the canonical SHA-256 of the written value.
 */
export function writeJsonAtomic(filePath, value, { pretty = true } = {}) {
  const target = path.resolve(filePath);
  const dir = path.dirname(target);
  fs.mkdirSync(dir, { recursive: true });

  const body = pretty ? `${JSON.stringify(value, null, 2)}\n` : `${canonicalize(value)}\n`;
  const tmp = path.join(dir, `.${path.basename(target)}.${process.pid}.${counter()}.tmp`);

  const fd = fs.openSync(tmp, "wx", 0o600);
  try {
    fs.writeFileSync(fd, body, "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }

  fs.renameSync(tmp, target);
  fsyncDirBestEffort(dir);

  return canonicalHash(value);
}

export function writeTextAtomic(filePath, text) {
  const target = path.resolve(filePath);
  const dir = path.dirname(target);
  fs.mkdirSync(dir, { recursive: true });

  const tmp = path.join(dir, `.${path.basename(target)}.${process.pid}.${counter()}.tmp`);
  const fd = fs.openSync(tmp, "wx", 0o600);
  try {
    fs.writeFileSync(fd, String(text ?? ""), "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, target);
  fsyncDirBestEffort(dir);
}

let writeCounter = 0;
function counter() {
  writeCounter += 1;
  return writeCounter;
}

function fsyncDirBestEffort(dir) {
  let dirFd = null;
  try {
    dirFd = fs.openSync(dir, "r");
    fs.fsyncSync(dirFd);
  } catch {
    // Directory fsync is unavailable on some filesystems; the rename itself is
    // still atomic, so this is a durability nicety rather than a correctness
    // requirement.
  } finally {
    if (dirFd !== null) {
      try {
        fs.closeSync(dirFd);
      } catch {
        /* ignore */
      }
    }
  }
}
