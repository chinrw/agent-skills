#!/usr/bin/env bash
set -euo pipefail

# The attestation must match the configuration of this top-level session.
exec codex exec --cd "$PWD" --sandbox workspace-write --approve-for-me \
  -c sandbox_workspace_write.network_access=true \
  -c 'model_reasoning_effort="xhigh"' \
  "Use babysit-prs-codex: effort=xhigh $*"
