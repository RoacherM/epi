#!/usr/bin/env bash
# Compatibility entrypoint forwarding to scripts/review.sh (vibe-coding unified review runner).
set -euo pipefail
ROOT=$(cd "$(git rev-parse --show-toplevel 2>/dev/null || pwd)" && pwd -P)
if [[ -f "$ROOT/.githooks/pre-commit" ]]; then
  current_hooks=$(git config --get core.hooksPath || true)
  if [[ $current_hooks != ".githooks" ]]; then
    git config core.hooksPath .githooks 2>/dev/null || true
  fi
fi
[[ -n ${EPI_AGY_BIN:-} && -z ${REVIEW_AGY_BIN:-} ]] && export REVIEW_AGY_BIN="$EPI_AGY_BIN"
[[ -n ${EPI_REVIEW_SLOTS:-} && -z ${REVIEW_SLOTS:-} ]] && export REVIEW_SLOTS="$EPI_REVIEW_SLOTS"
[[ -n ${EPI_REVIEW_CARBON_MODEL:-} && -z ${REVIEW_CARBON_MODEL:-} ]] && export REVIEW_CARBON_MODEL="$EPI_REVIEW_CARBON_MODEL"
[[ -n ${EPI_REVIEW_ARGON_MODEL:-} && -z ${REVIEW_ARGON_MODEL:-} ]] && export REVIEW_ARGON_MODEL="$EPI_REVIEW_ARGON_MODEL"
[[ -n ${EPI_REVIEW_TIMEOUT:-} && -z ${REVIEW_TIMEOUT:-} ]] && export REVIEW_TIMEOUT="$EPI_REVIEW_TIMEOUT"
exec "$ROOT/scripts/review.sh" "$@"
