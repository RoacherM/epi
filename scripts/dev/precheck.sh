#!/usr/bin/env bash
# Repository machine checks for Epi (.review.json precheck & commitCheck).
# Review orchestration, sharding, and merge gates live in vibe-coding/scripts/review.sh.
set -euo pipefail

if [[ ${1:-} == "--commit-check" ]]; then
  branch=$(git symbolic-ref --short -q HEAD || true)
  staged_src=$(git diff --cached --name-only -- 'src/**' || true)
  if [[ -z $staged_src ]]; then
    exit 0
  fi
  if [[ $branch == "main" ]]; then
    echo "[pre-commit] refusing direct src/ commit on 'main'." >&2
    echo "  Switch to a feature or fix branch first: git switch -c dev/<topic>" >&2
    exit 1
  fi
  if ! git diff --quiet -- src; then
    echo "[pre-commit] unstaged changes in src/ detected while committing src/." >&2
    echo "  Stage all src/ edits, run 'npm run build', and stage dist/ together." >&2
    exit 1
  fi
  npm run build --silent
  if ! git diff --quiet -- dist || [[ -n $(git ls-files --others --exclude-standard -- dist) ]]; then
    echo "[pre-commit] dist/ does not match staged src/ after 'npm run build'." >&2
    echo "  Stage updated build artifacts with: git add dist" >&2
    exit 1
  fi
  exit 0
fi

run_with_timeout() {
  local limit=$1 pid watcher rc=0; shift
  "$@" & pid=$!
  ( sleep "$limit" && kill -TERM "$pid" 2>/dev/null && sleep 2 && kill -KILL "$pid" 2>/dev/null ) & watcher=$!
  wait "$pid" 2>/dev/null || rc=$?
  kill -TERM "$watcher" 2>/dev/null || true
  wait "$watcher" 2>/dev/null || true
  return "$rc"
}

eslint_dir=${EPI_ESLINT_DIR:-$HOME/.cache/epi-eslint}
if [[ -d ../before/.git ]]; then
  base_tree=$(git -C ../before write-tree)
  head_tree=$(git write-tree)
  changed_ts=$(git diff --diff-filter=d --name-only "$base_tree" "$head_tree" -- ':(glob)src/**/*.ts' || true)
else
  changed_ts=$(git diff --diff-filter=d --name-only "${1:-main}" "${2:-HEAD}" -- ':(glob)src/**/*.ts' || true)
fi

npm run build
git diff --exit-code -- dist
npx tsc -p tsconfig.json --noEmit --noUnusedLocals --noUnusedParameters
node scripts/model-snapshot.mjs --diff test/snapshots/model-visible.json

if [[ -n $changed_ts ]]; then
  if [[ ! -f $eslint_dir/node_modules/eslint/bin/eslint.js ]]; then
    echo "precheck.sh: eslint not found in $eslint_dir; install with: mkdir -p \"$eslint_dir\" && (cd \"$eslint_dir\" && npm i eslint@9 typescript-eslint eslint-plugin-sonarjs)" >&2
    exit 1
  fi
  eslint_cfg="scripts/dev/eslint.config.mjs"
  [[ -f $eslint_cfg ]] || eslint_cfg="../../../../scripts/dev/eslint.config.mjs"
  cp -f "$eslint_cfg" "$eslint_dir/eslint.config.mjs"
  # shellcheck disable=SC2086
  "$eslint_dir/node_modules/.bin/eslint" --config "$eslint_dir/eslint.config.mjs" $changed_ts
fi

t0=$(date +%s)
# shellcheck disable=SC2086
( unset PI_OFFLINE && run_with_timeout "${EPI_TEST_SUITE_TIMEOUT:-600}" \
  sandbox-exec -p '(version 1)(allow default)(deny network-outbound (remote ip))(allow network-outbound (remote ip "localhost:*"))' \
  node --test --test-timeout="${EPI_TEST_TIMEOUT:-60000}" ${EPI_TEST_GLOB:-test/*.test.mjs} )
elapsed=$(( $(date +%s) - t0 ))
echo "full suite elapsed: ${elapsed}s"
if (( elapsed > 240 )); then
  echo "WARNING: full suite took ${elapsed}s (>240s)"
fi
