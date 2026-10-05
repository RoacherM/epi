#!/bin/sh
set -eu

# Placeholders below are filled in by scripts/release.mjs when it renders this file as a release
# asset -- the repo copy is a template, never a real version/hash. Running the repo copy unrendered
# fails the SHA-256 format check further down with a clear message.
EPI_VERSION="__EPI_VERSION__"
DEFAULT_DOWNLOAD_URL="https://github.com/RoacherM/epi/releases/download/v${EPI_VERSION}/epi-${EPI_VERSION}.tgz"
DEFAULT_PACKAGE_SHA256="__EPI_PACKAGE_SHA256__"

die() {
  printf 'epi installer: %s\n' "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "required command not found: $1"
}

require_command curl
require_command node
require_command npm

if ! node -e '
const [major, minor, patch] = process.versions.node.split(".").map(Number);
process.exit(
  major > 22 || (major === 22 && (minor > 19 || (minor === 19 && patch >= 0)))
    ? 0
    : 1,
);
'; then
  die "Node.js >=22.19.0 is required (found $(node --version 2>/dev/null || printf unknown))"
fi

download_url=${EPI_DOWNLOAD_URL:-$DEFAULT_DOWNLOAD_URL}
expected_sha256=${EPI_PACKAGE_SHA256:-$DEFAULT_PACKAGE_SHA256}

case "$expected_sha256" in
  *[!0-9a-f]* | '') die "invalid package SHA-256: $expected_sha256" ;;
esac
[ "${#expected_sha256}" -eq 64 ] || die "invalid package SHA-256 length"

if [ -n "${EPI_PREFIX:-}" ]; then
  case "$EPI_PREFIX" in
    /*) install_prefix=$EPI_PREFIX ;;
    *) die "EPI_PREFIX must be an absolute path" ;;
  esac
else
  install_prefix=$(npm prefix --global)
fi

umask 077
tmp_root=${TMPDIR:-/tmp}
tmp_dir=$(mktemp -d "${tmp_root%/}/epi-install.XXXXXX") || die "could not create a temporary directory"
trap 'rm -rf "$tmp_dir"' 0 HUP INT TERM
archive="$tmp_dir/epi-${EPI_VERSION}.tgz"

printf 'Downloading Epi %s...\n' "$EPI_VERSION"
curl --proto '=https,file' --tlsv1.2 --fail --location --silent --show-error \
  "$download_url" --output "$archive"

if command -v sha256sum >/dev/null 2>&1; then
  actual_sha256=$(sha256sum "$archive")
elif command -v shasum >/dev/null 2>&1; then
  actual_sha256=$(shasum -a 256 "$archive")
else
  die "sha256sum or shasum is required"
fi
actual_sha256=${actual_sha256%% *}

[ "$actual_sha256" = "$expected_sha256" ] || \
  die "package checksum mismatch (expected $expected_sha256, got $actual_sha256)"

printf 'Installing Epi %s...\n' "$EPI_VERSION"
if [ -n "${EPI_PREFIX:-}" ]; then
  npm install --global --prefix "$install_prefix" --no-audit --no-fund "$archive"
else
  npm install --global --no-audit --no-fund "$archive"
fi

epi_bin="$install_prefix/bin/epi"
[ -x "$epi_bin" ] || die "installation finished but $epi_bin is not executable"

printf 'Installed Epi at %s\n' "$epi_bin"
"$epi_bin" --version
