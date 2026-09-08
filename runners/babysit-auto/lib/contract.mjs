/**
 * What this runner assumes about `/babysit-prs`, pinned and checkable.
 *
 * The runner deliberately does not modify the skill; it drives it as a black
 * box and reads the state it publishes. That only works while both sides agree
 * on two things: the shape of the status-comment marker, and the set of states
 * that marker can carry. Neither is versioned, and a change to either is
 * invisible at runtime — the gate would keep parsing, keep deciding, and keep
 * being wrong.
 *
 * So the assumptions live here as literals, and `verifyContract` checks them
 * against the installed SKILL.md. Drift is reported loudly rather than absorbed.
 */

/** SKILL.md section 8, the marker template line, verbatim. */
export const PINNED_MARKER_TEMPLATE =
  "<!-- babysit-prs:v2 pr=<N> head=<HEAD> base=<BASE> spec=<SPEC_HASH> key=<REVIEW_KEY> state=<STATE> codex=<CODEX_STATE> codexRound=<N> codexNextTriggerAt=<UTC-ISO-8601> -->";

/** SKILL.md section 9, "Use only these states". */
export const PINNED_STATES = [
  "DISCOVERED",
  "NEEDS_REVIEW",
  "REVIEWING",
  "NEEDS_FIX",
  "FIXING",
  "NEEDS_VERIFICATION",
  "WAITING_THREADS",
  "WAITING_CODEX",
  "WAITING_CI",
  "READY_STACKED",
  "READY_ROOT",
  "MERGING",
  "MERGED",
  "BLOCKED",
];

/** Pull the marker template out of an installed SKILL.md. */
export function extractMarkerTemplate(skillMd) {
  const match = /^<!-- babysit-prs:v2 .*-->$/m.exec(skillMd);
  return match ? match[0] : null;
}

/** Pull the state list out of section 9's fenced block. */
export function extractStates(skillMd) {
  const section = sliceSection(skillMd, 9);
  if (!section) {
    return null;
  }
  const fence = /```text\n([\s\S]*?)```/.exec(section);
  if (!fence) {
    return null;
  }
  return fence[1]
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^[A-Z_]+$/.test(line));
}

/**
 * Compare the installed skill against what this runner was built for.
 * Returns `{ ok, drift }`; `drift` is a list of human-readable differences.
 */
export function verifyContract(skillMd) {
  const drift = [];

  const template = extractMarkerTemplate(skillMd);
  if (!template) {
    drift.push("marker template not found in SKILL.md");
  } else if (template !== PINNED_MARKER_TEMPLATE) {
    drift.push(`marker template changed:\n  pinned:    ${PINNED_MARKER_TEMPLATE}\n  installed: ${template}`);
  }

  const states = extractStates(skillMd);
  if (!states || states.length === 0) {
    drift.push("state list not found in SKILL.md section 9");
  } else {
    const added = states.filter((s) => !PINNED_STATES.includes(s));
    const removed = PINNED_STATES.filter((s) => !states.includes(s));
    // An added state reaches the gate as `state-unknown-X`, which is treated as
    // due — safe, but it means every tick re-runs that PR forever until the
    // gate learns where the new state belongs.
    if (added.length > 0) {
      drift.push(`states added since this runner was pinned: ${added.join(", ")}`);
    }
    if (removed.length > 0) {
      drift.push(`states removed: ${removed.join(", ")}`);
    }
  }

  return { ok: drift.length === 0, drift };
}

/** `## <n>. ...` up to, not including, the next `## ` heading. */
function sliceSection(text, n) {
  const heading = text.match(new RegExp(`^## ${n}\\. .*$`, "m"));
  if (!heading) {
    return null;
  }
  const start = heading.index;
  const rest = text.slice(start + heading[0].length);
  const next = rest.search(/^## /m);
  return next === -1 ? text.slice(start) : text.slice(start, start + heading[0].length + next);
}
