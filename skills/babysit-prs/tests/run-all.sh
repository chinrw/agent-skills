#!/usr/bin/env bash
# Run every /babysit-prs test suite. Touches no GitHub state and launches no
# real Codex task: the companion is faked and all inputs are fixtures.
set -euo pipefail

SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$SKILL_DIR"

# The suite practises the hygiene it enforces: leave no residue behind.
export PYTHONDONTWRITEBYTECODE=1

echo "== node: helper and runtime-contract tests =="
node --test "tests/*.test.mjs"

echo
echo "== python: external-review retry state machine =="
python3 -m unittest discover -s tests -q

echo
echo "== frontmatter and schema validation =="
python3 tests/validate-frontmatter.py

echo
echo "All /babysit-prs test suites passed."
