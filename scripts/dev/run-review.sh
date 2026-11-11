#!/usr/bin/env bash
# Review runner & precheck helper (docs/dev-workflow.md §1–4, docs/code-quality.md §2, decision WF7).
# Reviews run in parallel via Antigravity CLI (`agy`) using Carbon + Argon (`gemini-4-carbon-high` + `gemini-4-argon-high`).
set -euo pipefail

ROOT=$(cd "$(git rev-parse --show-toplevel 2>/dev/null || pwd)" && pwd -P)
cd "$ROOT"

if [[ -f "$ROOT/.githooks/pre-commit" ]]; then
  current_hooks=$(git config --get core.hooksPath || true)
  if [[ $current_hooks != ".githooks" ]]; then
    git config core.hooksPath .githooks 2>/dev/null || true
  fi
fi

AGY=${EPI_AGY_BIN:-$(command -v agy 2>/dev/null || echo "$HOME/.local/bin/agy")}
REVIEW_SLOTS=(carbon argon)

model_for_slot() {
  case $1 in
    carbon) echo "${EPI_REVIEW_CARBON_MODEL:-gemini-4-carbon-high}" ;;
    argon)  echo "${EPI_REVIEW_ARGON_MODEL:-gemini-4-argon-high}" ;;
    *) echo "run-review.sh: unknown review slot '$1'" >&2; return 1 ;;
  esac
}

peer_for_slot() {
  case $1 in
    carbon) echo "argon" ;;
    argon)  echo "carbon" ;;
    *) return 1 ;;
  esac
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

resolve_eslint_dir() {
  if [[ -n ${EPI_ESLINT_DIR:-} ]]; then
    echo "$EPI_ESLINT_DIR"
    return 0
  fi
  if [[ -f "$HOME/.cache/epi-eslint/node_modules/eslint/bin/eslint.js" ]]; then
    echo "$HOME/.cache/epi-eslint"
    return 0
  fi
  echo "$HOME/.cache/epi-eslint"
}

cmd_precheck() {
  local id=${1:?usage: precheck <id> <base> <head>} base=${2:?missing <base>} head=${3:?missing <head>}
  local dir=".dev/reviews/$id" log=".dev/reviews/$id/precheck.log" eslint_dir changed_ts src_lines t0 elapsed
  eslint_dir=$(resolve_eslint_dir)
  src_lines=$(git diff --numstat "$base" "$head" -- ':(glob)src/**/*.ts' | awk '{ s += $1 + $2 } END { print s + 0 }')
  if (( src_lines > 2000 )); then
    echo "need split (>2000 lines in src/: $src_lines lines; hard cap per WF4/WF7/WF8)" >&2
    return 2
  fi
  mkdir -p "$dir"
  rm -f "$dir/precheck.sha" "$dir/verified.sha"
  {
    echo "=== precheck $id ($base..$head) ==="
    git diff --stat "$base" "$head" -- src
    export_copy "$head" "$dir/repo"; export_copy "$base" "$dir/before"
    ( cd "$dir/repo" && npm run build && git diff --exit-code -- dist \
      && npx tsc -p tsconfig.json --noEmit --noUnusedLocals --noUnusedParameters \
      && node scripts/model-snapshot.mjs --diff test/snapshots/model-visible.json )
    changed_ts=$(git diff --name-only "$base" "$head" -- ':(glob)src/**/*.ts' || true)
    if [[ -n $changed_ts ]]; then
      if [[ ! -f $eslint_dir/node_modules/eslint/bin/eslint.js ]]; then
        echo "run-review.sh: eslint not found in $eslint_dir; install with: mkdir -p \"$eslint_dir\" && (cd \"$eslint_dir\" && npm i eslint@9 typescript-eslint eslint-plugin-sonarjs)" >&2
        return 1
      fi
      cp -f "$ROOT/scripts/dev/eslint.config.mjs" "$eslint_dir/eslint.config.mjs"
      ( cd "$dir/repo" && "$eslint_dir/node_modules/.bin/eslint" --config "$eslint_dir/eslint.config.mjs" $changed_ts )
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
  local id=${1:?usage: start <id> [head]} head=${2:-HEAD}
  # Backward-compatible arg handling if legacy numeric tier was passed as $2:
  if [[ $head =~ ^[123]$ ]] && [[ -n ${3:-} ]]; then
    head=$3
  elif [[ $head =~ ^[123]$ ]]; then
    head=HEAD
  fi
  local dir=".dev/reviews/$id" abs_dir="$ROOT/.dev/reviews/$id" expected_sha actual_sha slot peer model timeout_sec prompt
  [[ -f $dir/precheck.sha ]] || { echo "run-review.sh: $dir/precheck.sha not found (run precheck first)" >&2; return 1; }
  expected_sha=$(git rev-parse "$head")
  actual_sha=$(cat "$dir/precheck.sha")
  [[ $actual_sha == "$expected_sha" ]] || { echo "run-review.sh: precheck.sha ($actual_sha) does not match $head ($expected_sha)" >&2; return 1; }
  [[ -f $dir/precheck.log ]] && grep -q "=== precheck passed ===" "$dir/precheck.log" || { echo "run-review.sh: $dir/precheck.log missing '=== precheck passed ==='" >&2; return 1; }
  [[ -f $dir/pack.md ]] || { echo "run-review.sh: $dir/pack.md not found" >&2; return 1; }
  [[ -x $AGY ]] || { echo "run-review.sh: agy binary not executable at '$AGY'" >&2; return 1; }

  rm -f "$dir/verified.sha" "$dir/review.md"
  : >"$dir/model.txt"
  timeout_sec=${EPI_REVIEW_TIMEOUT:-1200}

  for slot in "${REVIEW_SLOTS[@]}"; do
    peer=$(peer_for_slot "$slot")
    model=$(model_for_slot "$slot")
    printf '%s=%s\n' "$slot" "$model" >>"$dir/model.txt"
    rm -f "$dir/review-$slot.md" "$dir/notes-$slot.md" "$dir/pid-$slot"
    prompt="You are independent blind reviewer [$slot] ($model) for Epi. Read $abs_dir/pack.md and conduct the code review strictly under its rules and budget using the isolated copies in $abs_dir/repo and $abs_dir/before plus $abs_dir/precheck.log. Hard rules: (1) Do NOT modify any tracked repository files; only write inside $abs_dir. (2) Do NOT read or check any *$peer* files in $abs_dir (blind dual review). (3) Write your working notes to $abs_dir/notes-$slot.md and your final report to $abs_dir/review-$slot.md. (4) Line 1 of $abs_dir/review-$slot.md MUST be literally '可接受' (only when P0=0, P1=0, P2=0) or '不可接受' (whenever any P0, P1, or P2 exists), and Line 2 MUST be literally 'COUNTS: P0=<n> P1=<n> P2=<n> P3=<n>'. Every open P0/P1/P2 finding must be marked CONFIRMED with a reproducible probe."
    nohup "$AGY" --model "$model" --dangerously-skip-permissions --disable-slash-commands --print-timeout "${timeout_sec}s" -p "$prompt" >"$dir/run-$slot.out" 2>"$dir/run-$slot.err" &
    echo $! >"$dir/pid-$slot"
  done
  cat "$dir/model.txt"
}

write_combined_summary() {
  local dir=$1 slot line1
  {
    echo "# Dual Review Summary ($(basename "$dir"))"
    echo ""
    for slot in "${REVIEW_SLOTS[@]}"; do
      line1=$(awk 'NF { print; exit }' "$dir/review-$slot.md" 2>/dev/null || echo "(missing)")
      echo "- **$slot** (\`$(model_for_slot "$slot")\`): $line1 — see \`review-$slot.md\`"
    done
  } >"$dir/review.md"
}

cmd_wait() {
  local id=${1:?usage: wait <id> [seconds]} limit=${2:-1200} elapsed=0 dir=".dev/reviews/$1" slot pid alive missing=0
  for slot in "${REVIEW_SLOTS[@]}"; do
    [[ -f "$dir/pid-$slot" ]] || { echo "run-review.sh: $dir/pid-$slot not found" >&2; return 1; }
  done
  while true; do
    alive=0
    for slot in "${REVIEW_SLOTS[@]}"; do
      pid=$(cat "$dir/pid-$slot")
      [[ $pid =~ ^[0-9]+$ ]] || { echo "run-review.sh: invalid pid in $dir/pid-$slot" >&2; return 1; }
      if kill -0 "$pid" 2>/dev/null; then
        alive=1
      fi
    done
    (( alive == 0 )) && break
    if (( elapsed >= limit )); then
      echo "run-review.sh: timeout (${limit}s) reached; terminating remaining reviewers" >&2
      cmd_stop "$id" || true
      return 124
    fi
    sleep 5; elapsed=$((elapsed + 5))
  done

  for slot in "${REVIEW_SLOTS[@]}"; do
    if [[ ! -s "$dir/review-$slot.md" ]]; then
      echo "run-review.sh: reviewer [$slot] exited without producing non-empty $dir/review-$slot.md (check $dir/run-$slot.err)" >&2
      missing=1
    fi
  done
  (( missing == 0 )) || return 3
  write_combined_summary "$dir"
}

check_single_report() {
  local file=$1 label=$2 first_line counts_line bad_lines
  [[ -s $file ]] || { echo "verify [$label]: missing or empty $file" >&2; return 4; }
  first_line=$(awk 'NF { gsub(/^[#*[:space:]`]+|[[:space:]`]+$/, ""); print; exit }' "$file")
  if [[ ! $first_line =~ ^可接受 ]]; then
    echo "verify [$label]: verdict is '$first_line' (expected '可接受')" >&2
    return 4
  fi
  counts_line=$(grep -E '^COUNTS:[[:space:]]*P0=[0-9]+[[:space:]]+P1=[0-9]+[[:space:]]+P2=[0-9]+' "$file" | head -1 || true)
  if [[ -n $counts_line ]] && [[ ! $counts_line =~ ^COUNTS:[[:space:]]*P0=0[[:space:]]+P1=0[[:space:]]+P2=0([[:space:]]|$) ]]; then
    echo "verify [$label]: non-zero P0–P2 count in '$counts_line'" >&2
    return 4
  fi
  # Reject open P0/P1/P2 findings in bullets, headings, or markdown tables even if line 1 claimed 可接受 (paste-image-eperm guard).
  bad_lines=$(grep -nE '(\[P[012](-[0-9]+)?\]|^[[:space:]]*\|[[:space:]]*\*{0,2}\[?P[012](-[0-9]+)?\]?[[:space:]\*]*\||^[[:space:]]*(#+|-|\*|[0-9]+\.)[[:space:]]*\*{0,2}\[?P[012](-[0-9]+)?\]?([:：[:space:]\*\.\)]|$))' "$file" \
    | grep -vEi '(无|没有|未发现|零|0[[:space:]]*个?|no|none|zero)[[:space:]]*(P0|P1|P2|CONFIRMED)' \
    | grep -vEi '(已修复|已解决|已验证|RESOLVED|FIXED|VERIFIED|CLOSED|P0[[:space:]]*/[[:space:]]*P1)' || true)
  if [[ -n $bad_lines ]]; then
    echo "verify [$label]: found unresolved P0–P2 finding(s) in $file despite '可接受' header:" >&2
    printf '%s\n' "$bad_lines" | sed 's/^/  line /' >&2
    return 4
  fi
  echo "verify [$label]: PASS ($first_line, P0–P2 = 0)"
}

cmd_verify() {
  local id=${1:?usage: verify <id> [head]} head=${2:-HEAD} dir=".dev/reviews/$1" expected_sha actual_sha slot rc=0
  [[ -f $dir/precheck.sha ]] || { echo "run-review.sh: $dir/precheck.sha not found" >&2; return 1; }
  expected_sha=$(git rev-parse "$head")
  actual_sha=$(cat "$dir/precheck.sha")
  [[ $actual_sha == "$expected_sha" ]] || { echo "run-review.sh: precheck.sha ($actual_sha) != $head ($expected_sha)" >&2; return 1; }
  rm -f "$dir/verified.sha"
  for slot in "${REVIEW_SLOTS[@]}"; do
    check_single_report "$dir/review-$slot.md" "$slot" || rc=$?
  done
  if (( rc != 0 )); then
    return "$rc"
  fi
  write_combined_summary "$dir"
  printf '%s\n' "$expected_sha" >"$dir/verified.sha"
  echo "verified: stamped $dir/verified.sha ($expected_sha)"
}

cmd_stop() {
  local id=${1:?usage: stop <id>} dir=".dev/reviews/$1" slot pidfile pid
  for slot in "${REVIEW_SLOTS[@]}"; do
    pidfile="$dir/pid-$slot"
    [[ -f $pidfile ]] || continue
    pid=$(cat "$pidfile")
    if [[ $pid =~ ^[0-9]+$ ]] && kill -0 "$pid" 2>/dev/null; then
      kill -TERM "$pid" 2>/dev/null || true
    fi
  done
  sleep 2
  for slot in "${REVIEW_SLOTS[@]}"; do
    pidfile="$dir/pid-$slot"
    [[ -f $pidfile ]] || continue
    pid=$(cat "$pidfile")
    if [[ $pid =~ ^[0-9]+$ ]] && kill -0 "$pid" 2>/dev/null; then
      kill -KILL "$pid" 2>/dev/null || true
    fi
    rm -f "$pidfile"
  done
}

case ${1:-} in
  precheck) shift; cmd_precheck "$@" ;;
  start)    shift; cmd_start "$@" ;;
  wait)     shift; cmd_wait "$@" ;;
  verify)   shift; cmd_verify "$@" ;;
  stop)     shift; cmd_stop "$@" ;;
  *) echo "usage: $0 {precheck <id> <base> <head>|start <id> [head]|wait <id> [seconds]|verify <id> [head]|stop <id>}" >&2; exit 1 ;;
esac
