#!/usr/bin/env bash
set -euo pipefail

exec codex exec --cd "$PWD" --sandbox workspace-write --approve-for-me \
  -c sandbox_workspace_write.network_access=true \
  -c 'model_reasoning_effort="xhigh"' \
  "Use babysit-prs-codex: $*"
