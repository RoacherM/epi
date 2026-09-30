# Helpers for driving mmp in a Herdr pane (docs/dev-workflow-herdr.md).
# Usage: P=w9:pX source scripts/dev/herdr.sh; startmmp <worktree> sonnet; say "text"; scr 40
#
# The tool build (a known-good commit, section 2) does the work; MMP_TOOL points at it.
MMP_TOOL=${MMP_TOOL:-$HOME/Desktop/Projects/sides/mmp-tool}
P=${P:?set P to the Herdr pane id, e.g. P=w9:pX}
herdr pane get "$P" >/dev/null 2>&1 || { echo "herdr.sh: pane $P not found" >&2; return 1 2>/dev/null || exit 1; }

say() { herdr pane send-text "$P" "$1" >/dev/null; herdr pane send-keys "$P" enter >/dev/null; }
key() { herdr pane send-keys "$P" "$@" >/dev/null; }
scr() { herdr pane read "$P" --source visible | sed '/^[[:space:]]*$/d' | tail -"${1:-30}"; }

mmp_running() { herdr pane process-info --pane "$P" 2>/dev/null | grep -q '"name":"node"'; }

# Start mmp only from a shell prompt: typed into a running mmp, the command would become a message
# to the model. $1 = worktree, $2 = sonnet | opus, rest = extra mmp arguments.
startmmp() {
  local dir=$1 model=$2; shift 2
  case $model in
    sonnet) model=claude/claude-sonnet-5-5 ;;
    opus) model=claude/claude-opus-5-5 ;;
    *) echo "model must be sonnet or opus" >&2; return 1 ;;
  esac
  if mmp_running; then echo "(mmp already running in $P; not starting another)" >&2; return 1; fi
  herdr pane run "$P" "cd '$dir' && clear && node '$MMP_TOOL/dist/cli.js' --approve --provider magpie --model $model --thinking high $*" >/dev/null
  herdr pane wait-output "$P" --match "Shift+Tab" --source visible --timeout 30000 >/dev/null
}

# Quit mmp only while it is in the foreground: a stray Ctrl+D at the shell prompt closes the pane.
quitmmp() {
  if ! mmp_running; then echo "(mmp not in foreground; not sending Ctrl+D)" >&2; return 0; fi
  key ctrl+d
  for _ in $(seq 1 15); do sleep 1; mmp_running || return 0; done
  echo "(mmp still running after 15s)" >&2; return 1
}

# Wait until a task report ends with a STATUS line (section 4). $1 = report path, $2 = timeout seconds.
waitreport() {
  local report=$1 limit=${2:-3600}
  for _ in $(seq 1 "$limit"); do
    grep -qE '^STATUS: (done|blocked)' "$report" 2>/dev/null && { grep -E '^STATUS:' "$report" | tail -1; return 0; }
    sleep 1
  done
  echo "(no STATUS line in $report after ${limit}s)" >&2; return 1
}
