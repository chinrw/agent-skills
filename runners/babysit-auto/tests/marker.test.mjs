import assert from "node:assert/strict";
import test from "node:test";

import { parseMarker, formatMarker, KNOWN_FIELDS } from "../lib/marker.mjs";

const FULL = "f".repeat(40);
const SHA = "9".repeat(64);

test("a non-marker comment parses as not-found, never as an error", () => {
  for (const body of ["", "plain text", "<!-- unrelated -->", null, undefined]) {
    assert.equal(parseMarker(body).found, false);
  }
});

test("the active contract round-trips through format and parse", () => {
  const fields = {
    pr: "524",
    head: FULL,
    base: FULL,
    spec: "none",
    key: SHA,
    state: "WAITING_CODEX",
    codex: "PENDING",
    codexRound: "3",
    codexNextTriggerAt: "2026-08-29T12:30:00Z",
  };
  const parsed = parseMarker(`${formatMarker(fields)}\n\nbody text`);
  assert.equal(parsed.dialect, "v2");
  assert.deepEqual(parsed.fields, fields);
});

test("field order is the documented order, so two runs emit identical bytes", () => {
  const a = formatMarker({ state: "READY_ROOT", pr: "1", head: FULL });
  const b = formatMarker({ head: FULL, pr: "1", state: "READY_ROOT" });
  assert.equal(a, b);
  assert.equal(a.indexOf("pr=") < a.indexOf("head="), true);
});

test("empty values are omitted, because an empty value changes the payload bytes", () => {
  assert.equal(formatMarker({ pr: "1", spec: "", key: null, state: undefined }), "<!-- babysit-prs:v2 pr=1 -->");
});

test("a value containing whitespace is refused rather than silently truncated on reparse", () => {
  assert.throws(() => formatMarker({ pr: "1", state: "READY ROOT" }), /whitespace/);
});

test("abbreviated OIDs are the legacy dialect, not the active contract", () => {
  const parsed = parseMarker(`<!-- babysit-prs:v2 pr=401 head=abcdef12 base=${FULL} spec=none -->`);
  assert.equal(parsed.dialect, "v2-legacy-trailing-nul");
});

test("a sha256:-prefixed spec is the legacy dialect", () => {
  const parsed = parseMarker(`<!-- babysit-prs:v2 pr=373 head=${FULL} base=${FULL} spec=sha256:${SHA} -->`);
  assert.equal(parsed.dialect, "v2-legacy-trailing-nul");
});

test("a trailing NUL is stripped from values but still parses", () => {
  const NUL = String.fromCharCode(0);
  const parsed = parseMarker(`<!-- babysit-prs:v2 pr=1 head=${FULL}${NUL} -->`);
  assert.equal(parsed.fields.head, FULL);
});

test("an unknown version is unrecognized, never assumed compatible", () => {
  assert.equal(parseMarker(`<!-- babysit-prs:v3 pr=1 head=${FULL} -->`).dialect, "unrecognized");
});

test("a malformed OID is unrecognized rather than quietly accepted", () => {
  assert.equal(parseMarker("<!-- babysit-prs:v2 pr=1 head=not-hex-at-all -->").dialect, "unrecognized");
});

test("malformed and duplicate tokens are reported, not dropped in silence", () => {
  const parsed = parseMarker("<!-- babysit-prs:v2 pr=1 bare pr=2 -->");
  assert.deepEqual(parsed.warnings, ["malformed token: bare", "duplicate field: pr"]);
});

test("unknown fields survive parsing but are not re-emitted by formatMarker", () => {
  const parsed = parseMarker("<!-- babysit-prs:v2 pr=1 futureField=x -->");
  assert.equal(parsed.fields.futureField, "x");
  assert.equal(formatMarker(parsed.fields).includes("futureField"), false);
  assert.equal(KNOWN_FIELDS.includes("futureField"), false);
});
