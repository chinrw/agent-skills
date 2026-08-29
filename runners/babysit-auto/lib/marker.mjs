/**
 * The `<!-- babysit-prs:v2 ... -->` status-comment marker: the durable half of
 * external-review state (SKILL.md section 8).
 *
 * Until now nothing parsed it. The controller read the comment by eye and fed
 * fields into `review-key.mjs classify`, which is how the same `v2` version
 * string came to cover three mutually incompatible byte contracts on live PRs
 * (SKILL.md, "Legacy marker dialects"). One parser, used by every caller, is
 * the only way that stops recurring.
 *
 * This module decides nothing about acceptance. Dialect classification here is
 * about *bytes*; `review-key.mjs classify` remains the sole authority on
 * whether a marker proves a current review.
 */

const MARKER_RE = /<!--\s*babysit-prs:(?<version>[A-Za-z0-9._-]+)\s+(?<fields>[^>]*?)\s*-->/;
const FULL_OID_RE = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;
const ABBREV_OID_RE = /^[0-9a-f]{7,39}$/;

/** Fields the state machine and the tick gate read. Anything else is kept raw. */
export const KNOWN_FIELDS = [
  "pr",
  "head",
  "base",
  "spec",
  "key",
  "state",
  "codex",
  "codexHeadOid",
  "codexMode",
  "codexState",
  "codexRound",
  "codexLastTriggerAt",
  "codexNextTriggerAt",
  "codexLastBotActivityAt",
  "codexLatestPassReactionAt",
  "codexLastDispositionCompletedAt",
];

/**
 * Parse the first marker in `body`.
 *
 * Returns `{ found, version, dialect, fields, raw, warnings }`. `found:false`
 * is an ordinary outcome — most comments are not markers — never an error.
 *
 * `dialect` is one of:
 *   "v2"                      the active byte contract
 *   "v2-legacy-trailing-nul"  abbreviated OIDs and/or `sha256:`-prefixed spec
 *   "unrecognized"            a marker-shaped comment under another contract
 *
 * A caller must treat anything other than "v2" as "not proven current".
 */
export function parseMarker(body) {
  if (typeof body !== "string" || body === "") {
    return notFound();
  }

  const match = MARKER_RE.exec(body);
  if (!match?.groups) {
    return notFound();
  }

  const { version, fields: fieldText } = match.groups;
  const { fields, warnings } = parseFields(fieldText);

  return {
    found: true,
    version,
    dialect: classifyDialect(version, fields),
    fields,
    raw: match[0],
    warnings,
  };
}

/**
 * Render the first-line marker. Field order follows SKILL.md section 8; absent
 * values are omitted rather than written as an empty string, because an empty
 * value would change the payload bytes a review key is computed over.
 */
export function formatMarker(fields, version = "v2") {
  const parts = [];
  for (const name of KNOWN_FIELDS) {
    const value = fields[name];
    if (value === undefined || value === null || value === "") {
      continue;
    }
    const text = String(value);
    if (/[\s>]/.test(text)) {
      throw new Error(`marker field ${name} contains whitespace or ">": ${text}`);
    }
    parts.push(`${name}=${text}`);
  }
  return `<!-- babysit-prs:${version} ${parts.join(" ")} -->`;
}

function notFound() {
  return { found: false, version: null, dialect: null, fields: {}, raw: null, warnings: [] };
}

function parseFields(fieldText) {
  const fields = {};
  const warnings = [];

  for (const token of fieldText.split(/\s+/)) {
    if (token === "") {
      continue;
    }
    const eq = token.indexOf("=");
    if (eq <= 0) {
      warnings.push(`malformed token: ${token}`);
      continue;
    }
    const name = token.slice(0, eq);
    const value = token.slice(eq + 1).replace(/\0+$/, "");
    if (name in fields) {
      warnings.push(`duplicate field: ${name}`);
    }
    fields[name] = value;
  }

  return { fields, warnings };
}

/**
 * Byte-contract classification. The three live dialects differ only in OID
 * width, `spec=` prefixing, and a trailing NUL — none of which is visible in a
 * rendered comment, which is exactly why they drifted unnoticed.
 */
function classifyDialect(version, fields) {
  if (version !== "v2") {
    return "unrecognized";
  }

  const abbreviated = ["head", "base", "codexHeadOid"].some(
    (name) => fields[name] && !FULL_OID_RE.test(fields[name]) && ABBREV_OID_RE.test(fields[name]),
  );
  const prefixedSpec = typeof fields.spec === "string" && fields.spec.startsWith("sha256:");

  if (abbreviated || prefixedSpec) {
    return "v2-legacy-trailing-nul";
  }

  const oidsWellFormed = ["head", "base"].every(
    (name) => !fields[name] || FULL_OID_RE.test(fields[name]),
  );
  return oidsWellFormed ? "v2" : "unrecognized";
}
