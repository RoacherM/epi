#!/usr/bin/env bash
# Local CI: the same steps as .github/workflows/ci.yml (and release.yml with --release), run on this
# machine against a clean checkout of one commit, so a slow GitHub runner is not on the path.
#
#   scripts/dev/local-ci.sh [<ref>]              # CI only (default ref: HEAD)
#   scripts/dev/local-ci.sh --release [<ref>]    # CI, then push <ref> to origin/main and publish
#
# The checkout is a fresh `git worktree` at the exact commit (nothing from your working tree leaks
# in), with its own `npm ci --ignore-scripts`, exactly like the runner. Differences from GitHub, on
# purpose: macOS instead of ubuntu-latest, your local Node instead of setup-node's.
#
# --release: after CI passes, pushes <ref> to origin/main and runs scripts/release.mjs here (gh must
# be logged in). release.yml then also runs on GitHub for that push; it finds the tag already
# published and exits 0 (release.mjs skips an existing tag), so nothing is released twice.
set -euo pipefail
ROOT=$(cd "$(git rev-parse --show-toplevel)" && pwd -P)
cd "$ROOT"

release=0
if [[ ${1:-} == --release ]]; then release=1; shift; fi
ref=${1:-HEAD}
sha=$(git rev-parse --verify "$ref^{commit}")
short=${sha:0:7}
dir=$(mktemp -d "${TMPDIR:-/tmp}/epi-local-ci.XXXXXX")
log="$dir.log"
cleanup() { git worktree remove --force "$dir" >/dev/null 2>&1 || rm -rf "$dir"; }
trap cleanup EXIT

step() { printf '\n== %s\n' "$*"; }
t0=$(date +%s)
# `set -e` would stop the script the moment the pipe below fails, before the FAILED line prints:
# turn it off around the pipe and read the step's own status from PIPESTATUS.
set +e
{
  set -e
  step "checkout $short"
  git worktree add --detach "$dir" "$sha" >/dev/null
  cd "$dir"
  step "node $(node --version), npm $(npm --version) (package.json engines: $(node -p 'JSON.stringify(require("./package.json").engines)'))"
  step "npm ci --ignore-scripts"
  npm ci --ignore-scripts --no-audit --no-fund
  step "npm run build"
  npm run build
  step "dist/ is committed and matches the build"
  git diff --exit-code -- dist
  step "npm test"
  npm test
} 2>&1 | tee "$log"
status=${PIPESTATUS[0]}
set -e
elapsed=$(( $(date +%s) - t0 ))
if (( status != 0 )); then
  echo "LOCAL CI FAILED for $short after ${elapsed}s (log: $log)" >&2
  exit "$status"
fi
echo "LOCAL CI PASSED for $short in ${elapsed}s (log: $log)"
(( release )) || exit 0

step "release $short"
version=$(git show "$sha:package.json" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).version))')
git fetch -q origin main
if ! git merge-base --is-ancestor origin/main "$sha"; then
  echo "refusing to release: origin/main is not an ancestor of $short (pull/rebase first)" >&2
  exit 1
fi
git push origin "$sha:refs/heads/main"
# release.mjs reads package.json from cwd and tags --target GITHUB_SHA; run it in the CI checkout.
cd "$dir"
GITHUB_SHA=$sha npm run release
echo "released v$version at $short"
