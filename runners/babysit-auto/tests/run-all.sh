#!/usr/bin/env bash
# Every babysit-auto test. Touches no GitHub state and starts no run: the gate
# is exercised against fixtures, and the contract check reads SKILL.md from
# this repo rather than the installed copy.
set -euo pipefail

RUNNER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$RUNNER_DIR"

echo "== node: gate, marker and contract =="
node --test "tests/*.test.mjs"

echo
echo "== shell: wrapper syntax =="
for script in systemd/*.sh; do
  [ -e "$script" ] || continue
  bash -n "$script" && echo "ok  $script"
done

echo
echo "== contract: the installed skill, if there is one =="
if [ -f "${CLAUDE_SKILL_DIR:-$HOME/.claude/skills/babysit-prs}/SKILL.md" ]; then
  node tick-gate.mjs contract
else
  echo "skip: no installed skill to check"
fi

echo
echo "All babysit-auto tests passed."
