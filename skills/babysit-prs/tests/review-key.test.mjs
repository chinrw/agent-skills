import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_POLICY_VERSION,
  LEGACY_MARKER_CONTRACTS,
  ReviewKeyError,
  buildPayload,
  canonicalizeRepo,
  classifyMarker,
  computeReviewKey,
  describeReviewKey
} from "../scripts/review-key.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VECTORS = JSON.parse(fs.readFileSync(path.join(HERE, "fixtures", "review-key-vectors.json"), "utf8"));

const NUL = 0x00;

test("byte contract: exactly one NUL between adjacent fields, none leading, none trailing", () => {
  const { payload, fields } = buildPayload({
    repo: "chinrw/stocks",
    pr: 379,
    headOid: "e363a839522e4960d372ce42125cce05c6a64e82",
    baseOid: "7f1bc449f10686a1d013121c81c2c44e65a9637f",
    specHash: "none"
  });

  assert.notEqual(payload[0], NUL, "payload must not begin with a NUL");
  assert.notEqual(payload[payload.length - 1], NUL, "payload must not end with a trailing NUL");
  assert.notEqual(payload[payload.length - 1], 0x0a, "payload must not end with a newline");

  const nulCount = payload.filter((byte) => byte === NUL).length;
  assert.equal(nulCount, fields.length - 1, "one NUL per adjacent pair, no more");

  // No two NULs may be adjacent (that would mean an empty field or a doubled separator).
  for (let i = 1; i < payload.length; i += 1) {
    assert.ok(!(payload[i] === NUL && payload[i - 1] === NUL), `adjacent NULs at offset ${i}`);
  }
});

test("deployed and synthetic vectors reproduce their full expected hashes", () => {
  assert.ok(VECTORS.vectors.length >= 2);
  for (const vector of VECTORS.vectors) {
    const described = describeReviewKey(vector.input);
    assert.equal(described.payloadHex, vector.payloadHex, `${vector.name}: payload hex`);
    assert.equal(described.payloadLength, vector.payloadLength, `${vector.name}: payload length`);
    assert.equal(described.trailingNul, false, `${vector.name}: trailingNul must be false`);
    assert.equal(described.reviewKey, vector.expectedKey, `${vector.name}: review key`);
    assert.equal(vector.expectedKey.length, 64, `${vector.name}: fixtures carry full hashes only`);
  }
});

test("the deployed PR #379 marker is a real compatibility vector, not a synthetic one", () => {
  const deployed = VECTORS.vectors.filter((entry) => entry.kind === "deployed");
  assert.equal(deployed.length, 1, "exactly one deployed compatibility vector is expected");
  assert.equal(
    computeReviewKey(deployed[0].input),
    "90eb74228b4dd711956acd443b74c215d2212192b8ddabc57e499037e8ab0681"
  );
  // Synthetic fixtures must be labelled so they are never mistaken for deployed evidence.
  for (const vector of VECTORS.vectors) {
    assert.ok(["deployed", "synthetic"].includes(vector.kind), `${vector.name}: kind must be labelled`);
  }
});

test("adding a trailing NUL produces a different key and is not the active contract", () => {
  const { payload } = buildPayload(VECTORS.vectors[0].input);
  const withTrailing = Buffer.concat([payload, Buffer.from([NUL])]);
  const rejected = createHash("sha256").update(withTrailing).digest("hex");

  const negative = VECTORS.negativeVectors.find((entry) => entry.name === "trailing-nul-is-a-different-contract");
  assert.equal(withTrailing.toString("hex"), negative.payloadHexWithTrailingNul);
  assert.equal(rejected, negative.rejectedKey);
  assert.notEqual(rejected, VECTORS.vectors[0].expectedKey);
});

test("appending a final newline produces a different key", () => {
  const { payload } = buildPayload(VECTORS.vectors[0].input);
  const withNewline = Buffer.concat([payload, Buffer.from("\n", "utf8")]);
  const rejected = createHash("sha256").update(withNewline).digest("hex");

  const negative = VECTORS.negativeVectors.find((entry) => entry.name === "final-newline-is-a-different-contract");
  assert.equal(rejected, negative.rejectedKey);
  assert.notEqual(rejected, VECTORS.vectors[0].expectedKey);
});

test("v2 refuses a policyHash rather than silently changing the byte contract", () => {
  assert.throws(
    () =>
      computeReviewKey({
        ...VECTORS.vectors[0].input,
        policyHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
      }),
    ReviewKeyError
  );
});

test("an unknown review-key version is rejected, not guessed", () => {
  assert.throws(
    () => computeReviewKey({ ...VECTORS.vectors[0].input, policyVersion: "babysit-prs-v9" }),
    ReviewKeyError
  );
});

test("normalization: repo URL forms, OID case, and PR spelling all reach the same key", () => {
  const expected = VECTORS.vectors[0].expectedKey;
  const variants = [
    { repo: "chinrw/stocks", pr: 379 },
    { repo: "https://github.com/chinrw/stocks", pr: "379" },
    { repo: "https://github.com/chinrw/stocks.git", pr: 379 },
    { repo: "git@github.com:chinrw/stocks.git", pr: " 379 " },
    { repo: "  chinrw/stocks  ", pr: 379 }
  ];

  for (const variant of variants) {
    assert.equal(
      computeReviewKey({
        ...variant,
        headOid: "E363A839522E4960D372CE42125CCE05C6A64E82",
        baseOid: "7F1BC449F10686A1D013121C81C2C44E65A9637F",
        specHash: "NONE"
      }),
      expected,
      `variant ${JSON.stringify(variant)}`
    );
  }
});

test("abbreviated OIDs are rejected outright", () => {
  assert.throws(
    () => computeReviewKey({ ...VECTORS.vectors[0].input, headOid: "e363a83" }),
    /full lowercase git OID/
  );
});

test("a non-decimal PR number is rejected", () => {
  for (const bad of ["37 9", "+379", "0379x", "-379", ""]) {
    assert.throws(() => computeReviewKey({ ...VECTORS.vectors[0].input, pr: bad }), ReviewKeyError, `pr=${bad}`);
  }
  // Zero-padding is not silently accepted as a different spelling of the same PR.
  assert.equal(computeReviewKey({ ...VECTORS.vectors[0].input, pr: "0379" }), VECTORS.vectors[0].expectedKey);
});

test("a malformed spec hash is rejected; absent spec is the literal \"none\"", () => {
  assert.throws(() => computeReviewKey({ ...VECTORS.vectors[0].input, specHash: "abc" }), ReviewKeyError);
  assert.equal(computeReviewKey({ ...VECTORS.vectors[0].input, specHash: undefined }), VECTORS.vectors[0].expectedKey);
  assert.equal(computeReviewKey({ ...VECTORS.vectors[0].input, specHash: "" }), VECTORS.vectors[0].expectedKey);
});

test("a malformed repo is rejected", () => {
  for (const bad of ["stocks", "a/b/c", "", "  ", "chinrw/"]) {
    assert.throws(() => canonicalizeRepo(bad), ReviewKeyError, `repo=${bad}`);
  }
});

test("the default policy version is the deployed marker version", () => {
  assert.equal(DEFAULT_POLICY_VERSION, "babysit-prs-v2");
});

/* --------------------- legacy marker migration ---------------------------- */

test("every live deployed marker is classified, and only the active contract is current", () => {
  const { vectors } = VECTORS.legacyMarkerVectors;
  assert.ok(vectors.length >= 4, "the live survey must be represented");

  for (const vector of vectors) {
    const verdict = classifyMarker({
      repo: "chinrw/stocks",
      pr: vector.pr,
      markerKey: vector.markerKey,
      markerHead: vector.markerHead,
      markerBase: vector.markerBase,
      markerSpec: vector.markerSpec,
      liveHeadOid: vector.liveHeadOid,
      liveBaseOid: vector.liveBaseOid,
      liveSpecHash: vector.liveSpecHash
    });

    assert.equal(verdict.contract, vector.expectedContract, `${vector.name}: contract`);
    assert.equal(verdict.current, vector.expectedCurrent, `${vector.name}: current`);
  }
});

test("a recognized legacy marker is never treated as current acceptance", () => {
  const legacy = VECTORS.legacyMarkerVectors.vectors.filter((v) => v.expectedCurrent === false);
  assert.ok(legacy.length >= 3, "three live markers use the legacy dialect");

  for (const vector of legacy) {
    const verdict = classifyMarker({
      repo: "chinrw/stocks",
      pr: vector.pr,
      markerKey: vector.markerKey,
      markerHead: vector.markerHead,
      markerBase: vector.markerBase,
      markerSpec: vector.markerSpec,
      liveHeadOid: vector.liveHeadOid,
      liveBaseOid: vector.liveBaseOid,
      liveSpecHash: vector.liveSpecHash
    });

    assert.equal(verdict.current, false, `${vector.name} must not prove readiness`);
    assert.ok(verdict.contract in LEGACY_MARKER_CONTRACTS, `${vector.name}: named dialect`);
    assert.match(verdict.reason, /never current acceptance/);
    // The active contract would have produced a different key entirely.
    assert.notEqual(verdict.expectedKey, vector.markerKey, vector.name);
    assert.match(verdict.expectedKey, /^[0-9a-f]{64}$/);
  }
});

test("an unrecognized key is reported as such, not silently reinterpreted", () => {
  const verdict = classifyMarker({
    repo: "chinrw/stocks",
    pr: 379,
    markerKey: "f".repeat(64),
    markerHead: "e363a839522e4960d372ce42125cce05c6a64e82",
    markerBase: "7f1bc449f10686a1d013121c81c2c44e65a9637f",
    markerSpec: "none",
    liveHeadOid: "e363a839522e4960d372ce42125cce05c6a64e82",
    liveBaseOid: "7f1bc449f10686a1d013121c81c2c44e65a9637f",
    liveSpecHash: "none"
  });

  assert.equal(verdict.contract, null);
  assert.equal(verdict.current, false);
  assert.match(verdict.reason, /unrecognized-key/);
});

test("a marker for a stale head is not current even under the active contract", () => {
  const verdict = classifyMarker({
    repo: "chinrw/stocks",
    pr: 379,
    markerKey: VECTORS.vectors[0].expectedKey,
    markerHead: "e363a839522e4960d372ce42125cce05c6a64e82",
    markerBase: "7f1bc449f10686a1d013121c81c2c44e65a9637f",
    markerSpec: "none",
    // The head advanced since the marker was written.
    liveHeadOid: "a".repeat(40),
    liveBaseOid: "7f1bc449f10686a1d013121c81c2c44e65a9637f",
    liveSpecHash: "none"
  });

  assert.equal(verdict.current, false);
  assert.notEqual(verdict.expectedKey, VECTORS.vectors[0].expectedKey);
});

test("the active contract itself is unchanged by legacy recognition", () => {
  // Recognizing a trailing-NUL dialect must not make it computable as current.
  assert.equal(computeReviewKey(VECTORS.vectors[0].input), VECTORS.vectors[0].expectedKey);
  assert.equal(buildPayload(VECTORS.vectors[0].input).spec.trailingNul, false);
  assert.deepEqual(Object.keys(LEGACY_MARKER_CONTRACTS), ["v2-legacy-trailing-nul"]);
});

test("debug output exposes the contract but never file contents or credentials", () => {
  const described = describeReviewKey(VECTORS.vectors[0].input);
  assert.deepEqual(Object.keys(described).sort(), [
    "encoding",
    "fieldNames",
    "fields",
    "finalNewline",
    "leadingNul",
    "payloadHex",
    "payloadLength",
    "policyVersion",
    "reviewKey",
    "separator",
    "trailingNul"
  ]);
  assert.equal(described.trailingNul, false);
  assert.equal(described.leadingNul, false);
  assert.equal(described.finalNewline, false);
});
