#!/bin/sh
set -eu

# Placeholders below are filled in by scripts/release.mjs when it renders this file as a release
# asset -- the repo copy is a template, never a real version/hash. Running the repo copy unrendered
# fails the SHA-256 format check further down with a clear message.
EPI_VERSION="__EPI_VERSION__"
DEFAULT_DOWNLOAD_URL="https://github.com/RoacherM/epi/releases/download/v${EPI_VERSION}/epi-${EPI_VERSION}-bundle.tar.gz"
DEFAULT_PACKAGE_SHA256="__EPI_PACKAGE_SHA256__"

# Pinned Bun runtime downloaded privately into <install-dir>/runtime/bun only when no usable Bun is
# already installed on the machine. Checksums come from oven-sh/bun's official SHASUMS256.txt.
BUN_VERSION="1.4.5"
DEFAULT_BUN_BASE_URL="https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}"

die() {
  printf 'epi installer: %s\n' "$*" >&2
  exit 1
}

show_usage() {
  cat <<'EOF'
Usage: install.sh [options]

Options:
  -d, --dir <path>    Directory to install the `epi` launcher (default: ~/.local/bin)
  -h, --help          Show this help message

Environment:
  EPI_BIN_DIR         Same as --dir
  EPI_INSTALL_DIR     Base directory for Epi releases and private Bun runtime (default: ~/.epi)
  EPI_BUN             Explicit path to a `bun` executable (skips detection/download)
EOF
}

sh_quote() {
  printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "required command not found: $1"
}

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    actual=$(sha256sum "$1")
  elif command -v shasum >/dev/null 2>&1; then
    actual=$(shasum -a 256 "$1")
  else
    die "sha256sum or shasum is required"
  fi
  printf '%s\n' "${actual%% *}"
}

verify_sha256() {
  file_path=$1
  expected=$2
  label=$3
  actual=$(sha256_file "$file_path")
  [ "$actual" = "$expected" ] || \
    die "${label} checksum mismatch (expected ${expected}, got ${actual})"
}

detect_bun_target() {
  os_raw=$(uname -s)
  arch_raw=$(uname -m)

  case "$os_raw" in
    Darwin) os="darwin" ;;
    Linux) os="linux" ;;
    *) die "unsupported operating system: $os_raw (macOS and Linux are supported)" ;;
  esac

  case "$arch_raw" in
    arm64|aarch64) arch="aarch64" ;;
    x86_64|amd64) arch="x64" ;;
    *) die "unsupported architecture: $arch_raw (arm64 and x86_64 are supported)" ;;
  esac

  # Use native arm64 Bun when running inside a Rosetta x86_64 shell on Apple Silicon.
  if [ "$os" = "darwin" ] && [ "$arch" = "x64" ]; then
    if [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || printf 0)" = "1" ]; then
      arch="aarch64"
    fi
  fi

  suffix=""
  if [ "$os" = "linux" ]; then
    if [ -f /lib/libc.musl-x86_64.so.1 ] || [ -f /lib/libc.musl-aarch64.so.1 ] || \
       (command -v ldd >/dev/null 2>&1 && ldd --version 2>&1 | grep -qi musl); then
      suffix="-musl"
    fi
  fi

  if [ "$arch" = "x64" ]; then
    has_avx2=0
    if [ "$os" = "darwin" ]; then
      [ "$(sysctl -n hw.optional.avx2_0 2>/dev/null || printf 0)" = "1" ] && has_avx2=1
    elif [ -r /proc/cpuinfo ] && grep -qw avx2 /proc/cpuinfo 2>/dev/null; then
      has_avx2=1
    fi
    if [ "$has_avx2" -eq 0 ]; then
      suffix="${suffix}-baseline"
    fi
  fi

  printf '%s-%s%s\n' "$os" "$arch" "$suffix"
}

bun_sha256_for_target() {
  case "$1" in
    darwin-aarch64)         printf '%s\n' "b5d6bc2e13caf14e57c89661e89efd073ff16165b41bfe43882616410609cd10" ;;
    darwin-x64)             printf '%s\n' "a4972e778cce4b6a194d7d289f326aa61576d71d80b7a53e9da2f3739566e5fd" ;;
    darwin-x64-baseline)    printf '%s\n' "fb0121739a7e80e7511b6bfe4d2116422b48ba18a013acadef0c425348e95891" ;;
    linux-aarch64)          printf '%s\n' "18656a3bf0ea5641f5796ae4213b75255579a70a0fded2f337933785568cdf84" ;;
    linux-aarch64-musl)     printf '%s\n' "d655765d3a0c0fdf707e27c7aa1a4f2c84f1bbc1f759db7e6e3d3c5be414396c" ;;
    linux-x64)              printf '%s\n' "94559b3b528995a49452f9f2404cec74f2efd7d06e0a000a8cd214b02c3666eb" ;;
    linux-x64-baseline)     printf '%s\n' "dcb23a18a1c2fff12d57bcef696dbbb42eb67fde29f43816ecb595459a24c463" ;;
    linux-x64-musl)         printf '%s\n' "9b6bdba1fa0914b6adfe48e4438212e2c106d9199b77ba642a9b8a3968a49a59" ;;
    linux-x64-musl-baseline) printf '%s\n' "96fb94108eed872ff623ed39007d6b5699a83a5d0086fcfba84921c18145e3e6" ;;
    *) die "no pinned Bun checksum for platform: $1" ;;
  esac
}

extract_zip_file() {
  zip_path=$1
  dest_dir=$2
  if command -v unzip >/dev/null 2>&1; then
    unzip -q -o "$zip_path" -d "$dest_dir"
  elif command -v python3 >/dev/null 2>&1; then
    python3 -m zipfile -e "$zip_path" "$dest_dir"
  else
    die "unzip or python3 is required to extract the Bun runtime"
  fi
}

ensure_bun() {
  install_dir=$1
  tmp_dir=$2
  private_bun="$install_dir/runtime/bun/bin/bun"

  if [ -n "${EPI_BUN:-}" ]; then
    [ -x "$EPI_BUN" ] || die "EPI_BUN is not executable: $EPI_BUN"
    printf '%s\n' "$EPI_BUN"
    return 0
  fi

  if command -v bun >/dev/null 2>&1; then
    command -v bun
    return 0
  fi

  if [ -x "$HOME/.bun/bin/bun" ]; then
    printf '%s\n' "$HOME/.bun/bin/bun"
    return 0
  fi

  if [ -x "$private_bun" ]; then
    printf '%s\n' "$private_bun"
    return 0
  fi

  target=$(detect_bun_target)
  bun_asset="bun-${target}.zip"
  bun_base_url=${EPI_BUN_BASE_URL:-$DEFAULT_BUN_BASE_URL}
  bun_url="${bun_base_url%/}/${bun_asset}"
  bun_expected_sha256=${EPI_BUN_SHA256:-$(bun_sha256_for_target "$target")}

  case "$bun_expected_sha256" in
    *[!0-9a-f]* | '') die "invalid Bun SHA-256: $bun_expected_sha256" ;;
  esac
  [ "${#bun_expected_sha256}" -eq 64 ] || die "invalid Bun SHA-256 length"

  printf 'Downloading Bun %s runtime (%s)...\n' "$BUN_VERSION" "$target" >&2
  bun_zip="$tmp_dir/${bun_asset}"
  curl --proto '=https,file' --tlsv1.2 --fail --location --silent --show-error \
    "$bun_url" --output "$bun_zip"
  verify_sha256 "$bun_zip" "$bun_expected_sha256" "Bun runtime"

  bun_extract="$tmp_dir/bun-extract"
  mkdir -p "$bun_extract"
  extract_zip_file "$bun_zip" "$bun_extract"

  extracted_bun="$bun_extract/bun-${target}/bun"
  [ -f "$extracted_bun" ] || die "extracted Bun archive did not contain bun-${target}/bun"

  mkdir -p "$install_dir/runtime/bun/bin"
  bun_tmp="$install_dir/runtime/bun/bin/.bun.tmp.$$"
  cp "$extracted_bun" "$bun_tmp"
  chmod 755 "$bun_tmp"
  mv -f "$bun_tmp" "$private_bun"
  printf '%s\n' "$private_bun"
}

custom_dir=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -d|--dir)
      [ "$#" -ge 2 ] && [ -n "$2" ] || die "missing path for $1"
      custom_dir=$2
      shift 2
      ;;
    -h|--help)
      show_usage
      exit 0
      ;;
    *)
      die "unknown option: $1 (run with --help for usage)"
      ;;
  esac
done

require_command curl
require_command tar

download_url=${EPI_DOWNLOAD_URL:-$DEFAULT_DOWNLOAD_URL}
expected_sha256=${EPI_PACKAGE_SHA256:-$DEFAULT_PACKAGE_SHA256}

case "$expected_sha256" in
  *[!0-9a-f]* | '') die "invalid package SHA-256: $expected_sha256" ;;
esac
[ "${#expected_sha256}" -eq 64 ] || die "invalid package SHA-256 length"

bin_dir=${custom_dir:-${EPI_BIN_DIR:-$HOME/.local/bin}}
install_dir=${EPI_INSTALL_DIR:-${EPI_HOME:-$HOME/.epi}}

case "$bin_dir" in
  /*) ;;
  *) die "install bin directory must be an absolute path: $bin_dir" ;;
esac
case "$install_dir" in
  /*) ;;
  *) die "EPI_INSTALL_DIR must be an absolute path: $install_dir" ;;
esac

umask 077
tmp_root=${TMPDIR:-/tmp}
tmp_dir=$(mktemp -d "${tmp_root%/}/epi-install.XXXXXX") || die "could not create a temporary directory"
trap 'rm -rf "$tmp_dir"' 0 HUP INT TERM

bun_bin=$(ensure_bun "$install_dir" "$tmp_dir")
"$bun_bin" --version >/dev/null 2>&1 || die "Bun runtime at $bun_bin failed to execute"

archive="$tmp_dir/epi-${EPI_VERSION}-bundle.tar.gz"
printf 'Downloading Epi %s...\n' "$EPI_VERSION"
curl --proto '=https,file' --tlsv1.2 --fail --location --silent --show-error \
  "$download_url" --output "$archive"
verify_sha256 "$archive" "$expected_sha256" "package"

printf 'Installing Epi %s...\n' "$EPI_VERSION"
releases_dir="$install_dir/releases"
mkdir -p "$releases_dir"
stage_dir="$releases_dir/.tmp-${EPI_VERSION}-$$"
rm -rf "$stage_dir"
mkdir -p "$stage_dir"
tar -xzf "$archive" --strip-components=1 -C "$stage_dir"
[ -f "$stage_dir/dist/cli.js" ] || die "archive is missing dist/cli.js"

target_release="$releases_dir/${EPI_VERSION}"
if [ -e "$target_release" ]; then
  rm -rf "$target_release"
fi
mv "$stage_dir" "$target_release"
ln -sfn "releases/${EPI_VERSION}" "$install_dir/current"

for entry in "$releases_dir"/*; do
  [ -e "$entry" ] || continue
  base=$(basename "$entry")
  if [ "$base" != "$EPI_VERSION" ]; then
    rm -rf "$entry"
  fi
done

mkdir -p "$bin_dir"
epi_bin="${bin_dir%/}/epi"
launcher_tmp="${bin_dir%/}/.epi.tmp.$$"
quoted_install_dir=$(sh_quote "$install_dir")
quoted_bun_bin=$(sh_quote "$bun_bin")
cat > "$launcher_tmp" <<EOF
#!/bin/sh
set -eu
INSTALL_DIR=${quoted_install_dir}
DETECTED_BUN=${quoted_bun_bin}
if [ -n "\${EPI_BUN:-}" ] && [ -x "\$EPI_BUN" ]; then
  BUN_BIN="\$EPI_BUN"
elif [ -x "\$INSTALL_DIR/runtime/bun/bin/bun" ]; then
  BUN_BIN="\$INSTALL_DIR/runtime/bun/bin/bun"
elif command -v bun >/dev/null 2>&1; then
  BUN_BIN=\$(command -v bun)
elif [ -x "\$DETECTED_BUN" ]; then
  BUN_BIN="\$DETECTED_BUN"
elif [ -x "\$HOME/.bun/bin/bun" ]; then
  BUN_BIN="\$HOME/.bun/bin/bun"
else
  printf 'epi: Bun runtime not found. Re-run the Epi installer to restore it.\n' >&2
  exit 1
fi
exec "\$BUN_BIN" "\$INSTALL_DIR/current/dist/cli.js" "\$@"
EOF
chmod 755 "$launcher_tmp"
mv -f "$launcher_tmp" "$epi_bin"

[ -x "$epi_bin" ] || die "installation finished but $epi_bin is not executable"

printf 'Installed Epi at %s (runtime: %s)\n' "$epi_bin" "$bun_bin"
"$epi_bin" --version

case ":${PATH:-}:" in
  *":${bin_dir%/}:"*) ;;
  *)
    printf '\nAdd %s to your PATH to run epi directly:\n' "${bin_dir%/}"
    printf "  export PATH=\"%s:\$PATH\"\n" "${bin_dir%/}"
    ;;
esac

resolved_epi=$(command -v epi 2>/dev/null || true)
if [ -n "$resolved_epi" ] && [ "$resolved_epi" != "$epi_bin" ]; then
  printf '\nNote: another epi was found earlier in PATH at %s.\n' "$resolved_epi"
  printf 'If it is from an older npm install, remove it with "npm uninstall -g epi" or place %s earlier in PATH.\n' "${bin_dir%/}"
fi
