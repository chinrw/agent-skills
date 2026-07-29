#!/usr/bin/env node
/**
 * The one and only implementation of the babysit-prs review-key byte contract.
 *
 * Snapshot, marker, controller, judge, and migration code all call this. No
 * prompt, agent, or prose may reconstruct the byte string by hand — an LLM
 * re-deriving a NUL-separated payload is exactly how a review identity silently
 * forks.
 *
 * ---------------------------------------------------------------------------
 * ACTIVE CONTRACT: v2
 * ---------------------------------------------------------------------------
 *
 *   fields  = [ policyVersion, canonicalRepo, String(prNumber),
 *               headOid.toLowerCase(), baseOid.toLowerCase(), specHash ]
 *   payload = Buffer.from(fields.join("\0"), "utf8")
 *   key     = sha256(payload).hex
 *
 * Normalization, all mandatory:
 *
 *   - encoding            UTF-8
 *   - field order         exactly as listed above
 *   - separator           exactly one NUL (0x00) between adjacent fields
 *   - leading NUL         NO
 *   - trailing NUL        NO      <- the ambiguity this helper exists to kill
 *   - final newline       NO
 *   - PR number           decimal, no sign, no padding, no whitespace
 *   - OIDs                full lowercase hex, 40 (sha1) or 64 (sha256) chars;
 *                         abbreviations are rejected
 *   - specHash            the literal string "none" when no spec governs the
 *                         PR, otherwise 64 lowercase hex chars
 *   - canonicalRepo       GitHub `nameWithOwner`, case preserved. A URL form
 *                         ("https://github.com/o/r", "git@github.com:o/r.git")
 *                         is reduced to "o/r"; case is NOT folded, because the
 *                         deployed markers were computed from the exact
 *                         `nameWithOwner` string GitHub returns.
 *   - policyVersion       the marker version string, e.g. "babysit-prs-v2"
 *
 * v2 has NO policyHash field. This is not an oversight: the deployed PR #379
 * marker verifies against the six-field payload, and adding a field under the
 * same version string would silently invalidate every accepted marker. A future
 * v3 may add `policyHash` — `REVIEW_KEY_VERSIONS` below is where that goes, and
 * it must ship with its own version string.
 *
 * Deployed compatibility vector (chinrw/stocks PR #379, read-only observation):
 *   see tests/fixtures/review-key-vectors.json
 */

import { createHash } from "node:crypto";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const DEFAULT_POLICY_VERSION = "babysit-prs-v2";

/**
 * Field layout per review-key version. `policyHash: false` means the version's
 * payload has no policy-hash field at all — it is not "the empty string".
 */
export const REVIEW_KEY_VERSIONS = {
  "babysit-prs-v2": {
    fields: ["policyVersion", "canonicalRepo", "pr", "headOid", "baseOid", "specHash"],
    policyHash: false,
    trailingNul: false,
    finalNewline: false
  }
};

const OID_RE = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const REPO_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;

export class ReviewKeyError extends Error {}

/**
 * Reduce any accepted repository spelling to canonical `owner/name`.
 * Case is preserved on purpose (see the header note).
 */
export function canonicalizeRepo(raw) {
  if (typeof raw !== "string") {
    throw new ReviewKeyError(`repo must be a string, got ${typeof raw}`);
  }

  let value = raw.trim();
  if (value === "") {
    throw new ReviewKeyError("repo must not be empty");
  }

  value = value.replace(/^(?:https?:\/\/|ssh:\/\/)?(?:[^@/]+@)?github\.com[:/]+/i, "");
  value = value.replace(/\.git$/i, "");
  value = value.replace(/^\/+|\/+$/g, "");

  if (!REPO_RE.test(value)) {
    throw new ReviewKeyError(`repo "${raw}" is not canonical owner/name`);
  }
  return value;
}

export function canonicalizeOid(raw, label) {
  if (typeof raw !== "string") {
    throw new ReviewKeyError(`${label} must be a string, got ${typeof raw}`);
  }
  const value = raw.trim().toLowerCase();
  if (!OID_RE.test(value)) {
    throw new ReviewKeyError(
      `${label} "${raw}" is not a full lowercase git OID (40 or 64 hex chars). Abbreviated OIDs are never accepted.`
    );
  }
  return value;
}

export function canonicalizeSpecHash(raw) {
  const value = raw === undefined || raw === null ? "none" : String(raw).trim();
  if (value === "" || value.toLowerCase() === "none") {
    return "none";
  }
  const lowered = value.toLowerCase();
  if (!SHA256_RE.test(lowered)) {
    throw new ReviewKeyError(`specHash "${raw}" must be "none" or 64 lowercase hex chars`);
  }
  return lowered;
}

export function canonicalizePrNumber(raw) {
  const value = typeof raw === "number" ? raw : String(raw ?? "").trim();
  if (typeof value === "string" && !/^\d+$/.test(value)) {
    throw new ReviewKeyError(`pr "${raw}" must be a decimal integer with no whitespace or sign`);
  }
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) {
    throw new ReviewKeyError(`pr "${raw}" must be a positive integer`);
  }
  return String(n);
}

/**
 * Build the exact payload bytes. Exposed separately from the hash so tests can
 * assert the byte contract itself, not merely the digest.
 */
export function buildPayload(input) {
  const policyVersion = String(input.policyVersion ?? DEFAULT_POLICY_VERSION);
  const spec = REVIEW_KEY_VERSIONS[policyVersion];
  if (!spec) {
    throw new ReviewKeyError(
      `Unknown review-key version "${policyVersion}". Known: ${Object.keys(REVIEW_KEY_VERSIONS).join(", ")}`
    );
  }
  if (policyVersion.includes("\0")) {
    throw new ReviewKeyError("policyVersion must not contain a NUL byte");
  }

  const resolved = {
    policyVersion,
    canonicalRepo: canonicalizeRepo(input.repo ?? input.canonicalRepo),
    pr: canonicalizePrNumber(input.pr ?? input.prNumber),
    headOid: canonicalizeOid(input.headOid, "headOid"),
    baseOid: canonicalizeOid(input.baseOid, "baseOid"),
    specHash: canonicalizeSpecHash(input.specHash)
  };

  if (spec.policyHash) {
    if (!input.policyHash) {
      throw new ReviewKeyError(`${policyVersion} requires a policyHash`);
    }
    resolved.policyHash = String(input.policyHash).trim().toLowerCase();
    if (!SHA256_RE.test(resolved.policyHash)) {
      throw new ReviewKeyError("policyHash must be 64 lowercase hex chars");
    }
  } else if (input.policyHash !== undefined && input.policyHash !== null) {
    throw new ReviewKeyError(
      `${policyVersion} has no policyHash field. Passing one would silently change the byte contract under an unchanged marker version; mint a new version instead.`
    );
  }

  const fields = spec.fields.map((name) => resolved[name]);

  // The contract, in one line: single NUL between adjacent fields, nothing
  // appended. Do not "helpfully" terminate the payload.
  let text = fields.join("\0");
  if (spec.trailingNul) {
    text += "\0";
  }
  if (spec.finalNewline) {
    text += "\n";
  }

  return { fields, resolved, payload: Buffer.from(text, "utf8"), spec };
}

export function computeReviewKey(input) {
  const { payload } = buildPayload(input);
  return createHash("sha256").update(payload).digest("hex");
}

/* ------------------------ legacy marker recognition ---------------------- */

/**
 * Deployed `v2` markers are NOT all the same byte contract.
 *
 * Read-only survey of live `chinrw/stocks` markers:
 *
 *   PR 379  full OIDs,        spec "none",              no trailing NUL  <- active
 *   PR 401  ABBREVIATED OIDs, spec "none",              trailing NUL
 *   PR 402  ABBREVIATED OIDs, spec "none",              trailing NUL
 *   PR 373  full OIDs,        spec "sha256:<hex>",      trailing NUL
 *
 * Three mutually incompatible payloads shipped under one version string. The
 * repair does NOT silently reinterpret them: the active contract stays exactly
 * as specified, and the dialects below exist only so a legacy marker is
 * *recognized* rather than mistaken for corruption — while still never counting
 * as current acceptance. A legacy marker forces a fresh review and is rewritten
 * under the active contract.
 *
 * Each recipe hashes the marker's OWN field strings, since an abbreviated-OID
 * marker cannot be reproduced from live full OIDs.
 */
export const LEGACY_MARKER_CONTRACTS = {
  "v2-legacy-trailing-nul": {
    description:
      "Same six fields as v2 but with a trailing NUL after specHash, and the specHash written exactly as it appears in the marker (including a 'sha256:' prefix where present).",
    trailingNul: true,
    useMarkerFieldsVerbatim: true
  }
};

function legacyKey(fields, recipe) {
  let text = fields.join("\0");
  if (recipe.trailingNul) text += "\0";
  return createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
}

/**
 * Decide whether a marker's key proves current acceptance.
 *
 * @param {object} input
 * @param {string} input.repo
 * @param {number|string} input.pr
 * @param {string} input.markerKey     key as written in the marker
 * @param {string} input.markerHead    head string as written in the marker (may be abbreviated)
 * @param {string} input.markerBase    base string as written in the marker
 * @param {string} input.markerSpec    spec string as written in the marker (may carry a prefix)
 * @param {string} input.liveHeadOid   full OID from the fresh snapshot
 * @param {string} input.liveBaseOid   full OID from the fresh snapshot
 * @param {string} input.liveSpecHash  canonical spec hash from the fresh snapshot
 * @param {string} [input.policyVersion]
 * @returns {{contract: string|null, current: boolean, reason: string, expectedKey: string}}
 */
export function classifyMarker(input) {
  const policyVersion = input.policyVersion ?? DEFAULT_POLICY_VERSION;
  const repo = canonicalizeRepo(input.repo);
  const pr = canonicalizePrNumber(input.pr);
  const markerKey = String(input.markerKey ?? "").trim().toLowerCase();

  const expectedKey = computeReviewKey({
    policyVersion,
    repo,
    pr,
    headOid: input.liveHeadOid,
    baseOid: input.liveBaseOid,
    specHash: input.liveSpecHash
  });

  if (markerKey === expectedKey) {
    return {
      contract: policyVersion,
      current: true,
      reason: "active-contract-match",
      expectedKey
    };
  }

  for (const [name, recipe] of Object.entries(LEGACY_MARKER_CONTRACTS)) {
    const fields = recipe.useMarkerFieldsVerbatim
      ? [
          policyVersion,
          repo,
          pr,
          String(input.markerHead ?? "").trim(),
          String(input.markerBase ?? "").trim(),
          String(input.markerSpec ?? "none").trim()
        ]
      : [
          policyVersion,
          repo,
          pr,
          canonicalizeOid(input.liveHeadOid, "headOid"),
          canonicalizeOid(input.liveBaseOid, "baseOid"),
          canonicalizeSpecHash(input.liveSpecHash)
        ];

    if (legacyKey(fields, recipe) === markerKey) {
      return {
        contract: name,
        current: false,
        reason: "legacy-marker-contract: recognized but never current acceptance; re-review and rewrite the marker",
        expectedKey
      };
    }
  }

  return {
    contract: null,
    current: false,
    reason: "unrecognized-key: the marker does not match the active contract or any known legacy dialect",
    expectedKey
  };
}

export function describeReviewKey(input) {
  const { fields, resolved, payload, spec } = buildPayload(input);
  return {
    policyVersion: resolved.policyVersion,
    fieldNames: spec.fields,
    fields,
    encoding: "utf-8",
    separator: "NUL(0x00) between adjacent fields",
    leadingNul: false,
    trailingNul: spec.trailingNul,
    finalNewline: spec.finalNewline,
    payloadLength: payload.length,
    payloadHex: payload.toString("hex"),
    reviewKey: createHash("sha256").update(payload).digest("hex")
  };
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
    if (key === "debug" || key === "json" || key === "help") {
      out[key] = true;
      continue;
    }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      throw new ReviewKeyError(`--${key} requires a value`);
    }
    out[key] = next;
    i += 1;
  }
  return out;
}

const USAGE = `Usage:
  node review-key.mjs --repo <owner/name> --pr <N> --head <OID> --base <OID> [--spec <hash|none>]
                      [--policy-version babysit-prs-v2] [--debug] [--json]

  node review-key.mjs classify --repo <owner/name> --pr <N> \\
                      --marker-key <hex> --marker-head <str> --marker-base <str> --marker-spec <str> \\
                      --head <full OID> --base <full OID> [--spec <hash|none>]

  --debug prints field values, payload hex, trailing-NUL status, and the key.
          It never prints file contents or credentials.

  classify reports whether a marker proves CURRENT acceptance under the active
  contract, is a recognized LEGACY dialect (never current acceptance), or is
  unrecognized. Exit: 0 current, 1 legacy, 2 error, 3 unrecognized.
`;

function main(argv) {
  const args = parseArgv(argv);
  if (args.help || argv.length === 0) {
    process.stdout.write(USAGE);
    return 0;
  }

  if (args._[0] === "classify") {
    const verdict = classifyMarker({
      policyVersion: args["policy-version"] ?? DEFAULT_POLICY_VERSION,
      repo: args.repo,
      pr: args.pr,
      markerKey: args["marker-key"],
      markerHead: args["marker-head"],
      markerBase: args["marker-base"],
      markerSpec: args["marker-spec"] ?? "none",
      liveHeadOid: args.head,
      liveBaseOid: args.base,
      liveSpecHash: args.spec ?? "none"
    });
    process.stdout.write(`${JSON.stringify(verdict, null, 2)}\n`);
    if (verdict.current) return 0;
    return verdict.contract ? 1 : 3;
  }

  const input = {
    policyVersion: args["policy-version"] ?? DEFAULT_POLICY_VERSION,
    repo: args.repo,
    pr: args.pr,
    headOid: args.head,
    baseOid: args.base,
    specHash: args.spec ?? "none"
  };
  if (args["policy-hash"] !== undefined) {
    input.policyHash = args["policy-hash"];
  }

  if (args.debug) {
    const described = describeReviewKey(input);
    process.stdout.write(`${JSON.stringify(described, null, 2)}\n`);
    return 0;
  }

  const key = computeReviewKey(input);
  process.stdout.write(args.json ? `${JSON.stringify({ reviewKey: key })}\n` : `${key}\n`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}
