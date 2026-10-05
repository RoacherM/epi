# Helpers for driving epi in a Herdr pane (docs/dev-workflow-herdr.md).
# Usage: P=w9:pX source scripts/dev/herdr.sh; startepi <worktree> opus; say "text"; scr 40
#
# The tool build (a known-good commit, section 2) does the work; EPI_TOOL points at it.
EPI_TOOL=${EPI_TOOL:-$HOME/Projects/sides/epi-tool}
P=${P:?set P to the Herdr pane id, e.g. P=w9:pX}
herdr pane get "$P" >/dev/null 2>&1 || { echo "herdr.sh: pane $P not found" >&2; return 1 2>/dev/null || exit 1; }

# The workflow-graph log (docs/dev-workflow-herdr.md section 3.2) lives in the main checkout, also
# when this file is sourced from a worktree.
WORKFLOW_LOG=${WORKFLOW_LOG:-$(cd "$(git rev-parse --git-common-dir)/.." && pwd -P)/.workflow/log.jsonl}

# Append one fact to the log. $1 = task, $2 = event, $3 = node, rest = key=value (by defaults to
# 主控; round and cap are numbers; a gate's result is pass or fail). node writes the JSON so quoting
# in notes cannot break a line, and refuses a malformed fact instead of writing it.
fact() {
  local task=$1 event=$2 where=$3; shift 3
  mkdir -p "$(dirname "$WORKFLOW_LOG")"
  node -e '
    process.on("uncaughtException", (err) => { console.error(err.message); process.exit(1) })
    const [task, event, node, ...pairs] = process.argv.slice(1)
    const now = new Date(), offset = -now.getTimezoneOffset()
    const pad = (n) => String(Math.trunc(Math.abs(n))).padStart(2, "0")
    const local = new Date(now.getTime() + offset * 60000).toISOString().slice(0, 23)
    const fact = { time: local + (offset < 0 ? "-" : "+") + pad(offset / 60) + ":" + pad(offset % 60), task, event, node, by: "主控" }
    for (const pair of pairs) {
      const i = pair.indexOf("=")
      if (i < 1) throw new Error("fact: expected key=value, got " + JSON.stringify(pair))
      const key = pair.slice(0, i), value = pair.slice(i + 1)
      if ((key === "round" || key === "cap") && !/^[0-9]+$/.test(value)) throw new Error("fact: " + key + " must be a number, got " + JSON.stringify(value))
      fact[key] = key === "round" || key === "cap" ? Number(value) : value
    }
    if (event === "gate" && fact.result !== "pass" && fact.result !== "fail") throw new Error("fact: a gate needs result=pass or result=fail")
    process.stdout.write(JSON.stringify(fact) + "\n")
  ' "$task" "$event" "$where" "$@" >> "$WORKFLOW_LOG"
}

say() { herdr pane send-text "$P" "$1" >/dev/null; herdr pane send-keys "$P" enter >/dev/null; }
key() { herdr pane send-keys "$P" "$@" >/dev/null; }
scr() { herdr pane read "$P" --source visible | sed '/^[[:space:]]*$/d' | tail -"${1:-30}"; }

epi_running() { herdr pane process-info --pane "$P" 2>/dev/null | grep -q '"name":"node"'; }

# Start epi only from a shell prompt: typed into a running epi, the command would become a message
# to the model. $1 = worktree, $2 = sonnet | opus, rest = extra epi arguments.
startepi() {
  local dir=$1 model=$2; shift 2
  case $model in
    sonnet) model=claude/claude-sonnet-5-5 ;;
    opus) model=claude/claude-opus-5-5 ;;
    *) echo "model must be sonnet or opus" >&2; return 1 ;;
  esac
  if epi_running; then echo "(epi already running in $P; not starting another)" >&2; return 1; fi
  herdr pane run "$P" "cd '$dir' && clear && node '$EPI_TOOL/dist/cli.js' --approve --provider magpie --model $model --thinking high $*" >/dev/null
  herdr pane wait-output "$P" --match "Shift+Tab" --source visible --timeout 30000 >/dev/null
}

# Quit epi only while it is in the foreground: a stray Ctrl+D at the shell prompt closes the pane.
quitepi() {
  if ! epi_running; then echo "(epi not in foreground; not sending Ctrl+D)" >&2; return 0; fi
  key ctrl+d
  for _ in $(seq 1 15); do sleep 1; epi_running || return 0; done
  echo "(epi still running after 15s)" >&2; return 1
}

# Wait until a task report ends with a STATUS line (section 3). $1 = report path, $2 = timeout seconds.
# epi gives no signal when it finishes, so this waiter is the one that sees the worker's hand-off
# files and writes the worker's facts to the log: done or blocked (exit 0), or a new question.md
# (exit 3, the main session answers). It also stops early (exit 2) when the worker in $P needs
# attention, so a stuck worker is noticed:
# - it is idle (footer shows Shift+Tab:effort) for 2 minutes without having written the STATUS line;
# - "Compacting…" has been on screen for 10 minutes or more;
# - epi is no longer running in the pane.
waitreport() {
  local report=$1 limit=${2:-3600} idle=0 i screen compacting seen
  local dir=${report%/*}; local task=${dir##*/}
  for i in $(seq 1 "$limit"); do
    seen=$(grep -oE '^STATUS: (done|blocked)' "$report" 2>/dev/null | tail -1)
    if [[ -n $seen ]]; then
      [[ -e $dir/question.md ]] && echo "(warning: $dir/question.md is still there; answer it and rename it before re-dispatching)" >&2
      fact "$task" "${seen#STATUS: }" 实现 by=worker
      echo "$seen"; return 0
    fi
    if [[ -e $dir/question.md ]]; then
      fact "$task" question 实现 by=worker to=主控
      echo "(question: $dir/question.md)"; return 3
    fi
    if (( i % 30 == 0 )); then
      screen=$(herdr pane read "$P" --source visible 2>/dev/null)
      if ! epi_running; then echo "(epi is not running in $P)" >&2; return 2; fi
      compacting=$(grep -oE 'Compacting… [0-9]+m' <<<"$screen" | grep -oE '[0-9]+' | tail -1)
      if [[ -n $compacting && $compacting -ge 10 ]]; then
        echo "(worker in $P has been compacting for ${compacting} minutes)" >&2; return 2
      fi
      if tail -3 <<<"$screen" | grep -q 'Shift+Tab'; then idle=$((idle + 30)); else idle=0; fi
      if (( idle >= 120 )); then echo "(worker in $P is idle without a STATUS line)" >&2; return 2; fi
    fi
    sleep 1
  done
  echo "(no STATUS line in $report after ${limit}s)" >&2; return 1
}
