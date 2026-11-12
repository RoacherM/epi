#!/usr/bin/env bash
# Thin repository entrypoint for the unified review runner (vibe-coding skill).
set -euo pipefail
RUNNER="${VIBE_REVIEW_SH:-$HOME/.agents/skills/vibe-coding/scripts/review.sh}"
if [[ ! -f "$RUNNER" ]]; then
  echo "review.sh: global unified review runner not found at '$RUNNER'." >&2
  echo "Install/sync wayne-skills first (node ~/Projects/sides/wayne-skills/bin/wayne-skills.js sync) or set VIBE_REVIEW_SH." >&2
  exit 1
fi
exec bash "$RUNNER" "$@"
