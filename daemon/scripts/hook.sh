#!/usr/bin/env bash
set -euo pipefail

HOOK_INPUT="$(cat)"
PORT="${WRANGLR_HOOK_PORT:-7421}"

curl -s -X POST "http://127.0.0.1:${PORT}/hook" \
  -H "Content-Type: application/json" \
  -d "$HOOK_INPUT"

exit 0
