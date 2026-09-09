#!/usr/bin/env bash
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"
export PYTHONDONTWRITEBYTECODE=1

bash codex-skills/babysit-prs-codex/tests/run-all.sh
python3 -B -m unittest discover -s tests -v
python3 -B -m unittest discover -s codex-skills/context-bundle/tests -v
node --test skills/codex-implementation/tests/*.test.mjs
BABYSIT_SKILL_DIR="$REPO/codex-skills/babysit-prs-codex" \
  bash runners/babysit-auto/tests/run-all.sh
