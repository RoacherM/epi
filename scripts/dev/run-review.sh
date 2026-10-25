#!/usr/bin/env bash
# Review runner & precheck helper (docs/dev-workflow.md §2–3, docs/code-quality.md §3).
set -euo pipefail
ROOT=$(cd "$(git rev-parse --show-toplevel 2>/dev/null || pwd)" && pwd -P)
cd "$ROOT"
EPI=$(command -v epi >/dev/null 2>&1 && echo "epi" || echo "node $ROOT/dist/cli.js")

resolve_model() {
  local tier=${1:-1} models m t
  models=$($EPI --list-models 2>/dev/null | awk '$1 == "magpie" { print $2 }')
  for t in "$tier" 1 2 3; do
    (( t < tier )) && continue
    case $t in
      1) for m in auto/gemini-4-argon devin/gemini-4-argon factory/gemini-4-argon; do
           grep -qx "$m" <<<"$models" && { echo "$m"; return 0; }
         done; m=$(grep -E '(^|/)gemini-4-argon$' <<<"$models" | grep -v 'disabled' | head -1 || true) ;;
      2) for m in auto/claude-opus-5-5 devin/claude-opus-5-5 factory/claude-opus-5-5; do
           grep -qx "$m" <<<"$models" && { echo "$m"; return 0; }
         done; m=$(grep -E '(^|/)claude-opus-5-5$' <<<"$models" | head -1 || true) ;;
      3) for m in factory/deepseek-v4.1-flash devin/deepseek-v4-1-flash-1017; do
           grep -qx "$m" <<<"$models" && { echo "$m"; return 0; }
         done; m=$(grep -E 'deepseek-v4([.-]1)?-flash' <<<"$models" | head -1 || true) ;;
    esac
    [[ -n ${m:-} ]] && { echo "$m"; return 0; }
  done
  echo "run-review.sh: no matching magpie review model found" >&2; return 1
}

run_with_timeout() {
  local limit=$1 pid watcher rc=0; shift
  "$@" & pid=$!
  ( sleep "$limit" && kill -TERM "$pid" 2>/dev/null && sleep 2 && kill -KILL "$pid" 2>/dev/null ) & watcher=$!
  wait "$pid" 2>/dev/null || rc=$?
  kill -TERM "$watcher" 2>/dev/null || true; wait "$watcher" 2>/dev/null || true
  return "$rc"
}

export_copy() {
  local ref=$1 dest=$2
  rm -rf "$dest" && mkdir -p "$dest/.git/objects/info" "$dest/.git/refs"
  git archive "$ref" | tar -x -C "$dest"
  printf 'ref: refs/heads/detached\n' >"$dest/.git/HEAD"
  printf '[core]\n\trepositoryformatversion = 0\n\tbare = false\n' >"$dest/.git/config"
  printf '%s/objects\n' "$(cd "$(git rev-parse --git-common-dir)" && pwd -P)" >"$dest/.git/objects/info/alternates"
  GIT_INDEX_FILE="$dest/.git/index" git read-tree "$ref"
  ln -s "$ROOT/node_modules" "$dest/node_modules"
}

cmd_precheck() {
  local id=${1:?usage: precheck <id> <base> <head>} base=${2:?missing <base>} head=${3:?missing <head>}
  local dir=".dev/reviews/$id" log=".dev/reviews/$id/precheck.log" eslint_dir="${EPI_ESLINT_DIR:-/tmp/epi-eslint}" changed_ts src_lines t0 elapsed
  src_lines=$(git diff --numstat "$base" "$head" -- 'src/**/*.ts' | awk '{ s += $1 + $2 } END { print s + 0 }')
  if (( src_lines > 800 )) && [[ ${EPI_ALLOW_LARGE_DIFF:-} != 1 ]]; then
    echo "need split (>800 lines in src/: $src_lines lines)" >&2
    return 2
  fi
  mkdir -p "$dir"
  rm -f "$dir/precheck.sha"
  {
    echo "=== precheck $id ($base..$head) ==="
    git diff --stat "$base" "$head" -- src
    export_copy "$head" "$dir/repo"; export_copy "$base" "$dir/before"
    ( cd "$dir/repo" && npm run build && git diff --exit-code -- dist \
      && npx tsc -p tsconfig.json --noEmit --noUnusedLocals --noUnusedParameters \
      && node scripts/model-snapshot.mjs --diff test/snapshots/model-visible.json )
    changed_ts=$(git diff --name-only "$base" "$head" -- 'src/**/*.ts' || true)
    if [[ -n $changed_ts ]]; then
      if [[ ${EPI_SKIP_COMPLEXITY:-} == 1 ]]; then
        echo "COMPLEXITY SKIPPED (EPI_SKIP_COMPLEXITY=1)"
      elif [[ ! -x $eslint_dir/node_modules/.bin/eslint ]]; then
        echo "run-review.sh: $eslint_dir/node_modules/.bin/eslint not found; install with: mkdir -p \"$eslint_dir\" && (cd \"$eslint_dir\" && npm i eslint@9 typescript-eslint eslint-plugin-sonarjs) (eslint.config.mjs is copied automatically from scripts/dev/eslint.config.mjs; or set EPI_SKIP_COMPLEXITY=1)" >&2
        return 1
      else
        [[ -f $eslint_dir/eslint.config.mjs ]] || cp "$ROOT/scripts/dev/eslint.config.mjs" "$eslint_dir/eslint.config.mjs"
        ( cd "$dir/repo" && "$eslint_dir/node_modules/.bin/eslint" --config "$eslint_dir/eslint.config.mjs" $changed_ts )
      fi
    fi
    t0=$(date +%s)
    ( cd "$dir/repo" && unset PI_OFFLINE && run_with_timeout "${EPI_TEST_SUITE_TIMEOUT:-600}" \
      sandbox-exec -p '(version 1)(allow default)(deny network-outbound (remote ip))(allow network-outbound (remote ip "localhost:*"))' \
      node --test --test-timeout="${EPI_TEST_TIMEOUT:-60000}" test/*.test.mjs )
    elapsed=$(( $(date +%s) - t0 ))
    echo "full suite elapsed: ${elapsed}s"
    if (( elapsed > 240 )); then
      echo "WARNING: full suite took ${elapsed}s (>240s)"
    fi
    git rev-parse "$head" >"$dir/precheck.sha"
    echo "=== precheck passed ==="
  } >"$log" 2>&1
  echo "$log"
}

cmd_start() {
  local id=${1:?usage: start <id> [tier] [head]} tier=${2:-1} head=${3:-HEAD} dir=".dev/reviews/$1" expected_sha actual_sha model prompt
  [[ -f $dir/precheck.sha ]] || { echo "run-review.sh: $dir/precheck.sha not found (run precheck first)" >&2; return 1; }
  expected_sha=$(git rev-parse "$head")
  actual_sha=$(cat "$dir/precheck.sha")
  [[ $actual_sha == "$expected_sha" ]] || { echo "run-review.sh: precheck.sha ($actual_sha) does not match $head ($expected_sha)" >&2; return 1; }
  [[ -f $dir/precheck.log ]] && grep -q "=== precheck passed ===" "$dir/precheck.log" || { echo "run-review.sh: $dir/precheck.log missing '=== precheck passed ==='" >&2; return 1; }
  [[ -f $dir/pack.md ]] || { echo "run-review.sh: $dir/pack.md not found" >&2; return 1; }
  model=$(resolve_model "$tier")
  echo "$model" | tee "$dir/model.txt"
  prompt="Read $dir/pack.md and conduct the review under its budget and rules. Write notes to $dir/review-notes.md and final report to $dir/review.md."
  nohup $EPI -p --provider magpie --model "$model" --thinking medium "$prompt" >"$dir/run.out" 2>"$dir/run.err" &
  echo $! >"$dir/pid"
}

cmd_wait() {
  local id=${1:?usage: wait <id> [seconds]} limit=${2:-1200} elapsed=0 dir=".dev/reviews/$1" pidfile=".dev/reviews/$1/pid" pid
  [[ -f $pidfile ]] || { echo "run-review.sh: $pidfile not found" >&2; return 1; }
  pid=$(cat "$pidfile")
  [[ $pid =~ ^[0-9]+$ ]] || { echo "run-review.sh: invalid pid in $pidfile" >&2; return 1; }
  while kill -0 "$pid" 2>/dev/null; do
    if (( elapsed >= limit )); then
      echo "run-review.sh: timeout (${limit}s) reached for pid $pid; sending TERM then KILL" >&2
      kill -TERM "$pid" 2>/dev/null || true; sleep 10; kill -KILL "$pid" 2>/dev/null || true
      return 124
    fi
    sleep 10; elapsed=$((elapsed + 10))
  done
  if [[ ! -f $dir/review.md ]]; then
    echo "run-review.sh: warning: process $pid exited without producing $dir/review.md" >&2
    return 3
  fi
}

cmd_stop() {
  local id=${1:?usage: stop <id>} pidfile=".dev/reviews/$1/pid" pid
  [[ -f $pidfile ]] || { echo "run-review.sh: $pidfile not found" >&2; return 1; }
  pid=$(cat "$pidfile")
  if kill -0 "$pid" 2>/dev/null; then
    kill -TERM "$pid" 2>/dev/null || true; sleep 2; kill -KILL "$pid" 2>/dev/null || true
  fi
  rm -f "$pidfile"
}

case ${1:-} in
  precheck) shift; cmd_precheck "$@" ;;
  start)    shift; cmd_start "$@" ;;
  wait)     shift; cmd_wait "$@" ;;
  stop)     shift; cmd_stop "$@" ;;
  *) echo "usage: $0 {precheck <id> <base> <head>|start <id> [tier] [head]|wait <id> [seconds]|stop <id>}" >&2; exit 1 ;;
esac
