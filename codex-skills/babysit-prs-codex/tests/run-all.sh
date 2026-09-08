#!/usr/bin/env bash
# Offline fixtures only; no model calls or GitHub writes.
set -euo pipefail
SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$SKILL_DIR"
export PYTHONDONTWRITEBYTECODE=1
node --test "tests/*.test.mjs"
python3 -m unittest discover -s tests -q
