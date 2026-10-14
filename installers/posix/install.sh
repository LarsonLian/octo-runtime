#!/bin/sh

set -eu
(set -o pipefail) 2>/dev/null && set -o pipefail
set +x

MINIMUM_NODE_MAJOR=24
PACKAGE_NAME="@mininglamp-oss/octo-runtime"
TTY_ECHO_DISABLED=0
ENROLLMENT_TOKEN=""
NODE_BIN_OVERRIDE=""
HOME_LOCK_DIR=""
GLOBAL_LOCK_DIR=""
HOME_LOCK_HELD=0
GLOBAL_LOCK_HELD=0
HOME_HAS_RUNTIME=0
EXISTING_CLI_MODE=""
PREPARED_UPDATE=0

usage() {
  cat <<'EOF'
Install Octo Runtime for the current macOS or Linux user.

Usage:
  curl -fsSL https://SERVER/octo-runtime/install.sh \
    | sh -s -- "https://SERVER" "octo_enroll_..."

On first install, the enrollment token may be omitted and entered securely from the terminal.
An already enrolled profile can be repaired or updated without another token.
Environment overrides:
  OCTO_RUNTIME_CHANNEL       stable (default) or beta
  OCTO_RUNTIME_PROFILE       profile name (default: default)
  OCTO_RUNTIME_HOME          state directory (default: ~/.octo-runtime)
  OCTO_RUNTIME_NPM_SPEC      npm package spec used instead of the channel default
  OCTO_RUNTIME_AGENT_WORK_URL  Agent Worker base (default: SERVER_URL/agentworker)
EOF
}

info() {
  printf '%s\n' "[octo-runtime] $*"
}

die() {
  printf '%s\n' "[octo-runtime] ERROR: $*" >&2
  exit 2
}

cleanup() {
  status=$?
  if [ "$TTY_ECHO_DISABLED" -eq 1 ] && [ -r /dev/tty ]; then
    stty echo < /dev/tty 2>/dev/null || true
    printf '\n' > /dev/tty 2>/dev/null || true
  fi
  ENROLLMENT_TOKEN=""
  export ENROLLMENT_TOKEN
  if [ "$GLOBAL_LOCK_HELD" -eq 1 ]; then
    rm -f "$GLOBAL_LOCK_DIR/pid"
    rmdir "$GLOBAL_LOCK_DIR" 2>/dev/null || true
  fi
  if [ "$HOME_LOCK_HELD" -eq 1 ]; then
    rm -f "$HOME_LOCK_DIR/pid"
    rmdir "$HOME_LOCK_DIR" 2>/dev/null || true
  fi
  exit "$status"
}

trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

case "${1:-}" in
  -h|--help)
    usage
    exit 0
    ;;
esac

[ "$#" -ge 1 ] || {
  usage >&2
  die "SERVER_URL is required"
}
[ "$#" -le 2 ] || die "expected SERVER_URL and an optional enrollment token"

SERVER_URL=$1
ENROLLMENT_TOKEN=${2:-}
CHANNEL=${OCTO_RUNTIME_CHANNEL:-stable}
PROFILE=${OCTO_RUNTIME_PROFILE:-default}
HARNESS_HOME=${OCTO_RUNTIME_HOME:-"$HOME/.octo-runtime"}
AGENT_WORK_URL=${OCTO_RUNTIME_AGENT_WORK_URL:-}

PLATFORM=$(uname -s)
case "$PLATFORM" in
  Darwin|Linux) ;;
  *) die "this installer supports macOS and Linux only" ;;
esac
case "$SERVER_URL" in
  https://*) ;;
  *) die "SERVER_URL must use HTTPS" ;;
esac
case "$SERVER_URL" in
  *[[:space:]?#]*) die "SERVER_URL must not contain spaces, a query, or a fragment" ;;
esac
while [ "${SERVER_URL%/}" != "$SERVER_URL" ]; do
  SERVER_URL=${SERVER_URL%/}
done
[ -n "$AGENT_WORK_URL" ] || AGENT_WORK_URL="$SERVER_URL/agentworker"
case "${SERVER_URL#https://}" in
  ""|/*) die "SERVER_URL must include a host" ;;
esac
server_authority=${SERVER_URL#https://}
server_authority=${server_authority%%/*}
case "$server_authority" in
  *@*) die "SERVER_URL must not contain user info" ;;
esac
case "$CHANNEL" in
  stable|beta) ;;
  *) die "OCTO_RUNTIME_CHANNEL must be stable or beta" ;;
esac
case "$PROFILE" in
  ""|[!A-Za-z0-9]*|*[!A-Za-z0-9._-]*) die "OCTO_RUNTIME_PROFILE must start with a letter or digit and contain only letters, digits, dot, underscore, or hyphen" ;;
esac
[ "${#PROFILE}" -le 64 ] || die "OCTO_RUNTIME_PROFILE must not exceed 64 characters"
profile_key=$(printf '%s' "$PROFILE" | tr '[:upper:]' '[:lower:]')
case "$profile_key" in
  config.json|credentials|identity|machine.json|logs|octo-daemon.pid|profiles|run|setup|sockets|state.db)
    die "OCTO_RUNTIME_PROFILE conflicts with Runtime Home infrastructure"
    ;;
esac
case "$HARNESS_HOME" in
  /*) ;;
  *) die "OCTO_RUNTIME_HOME must be an absolute path" ;;
esac

PROFILE_IDENTITY="$HARNESS_HOME/$PROFILE/identity/runtime.json"
LEGACY_PROFILE_IDENTITY="$HARNESS_HOME/identity/runtime.json"
HAS_EXISTING_IDENTITY=0
if [ -f "$PROFILE_IDENTITY" ] || { [ "$PROFILE" = "default" ] && [ -f "$LEGACY_PROFILE_IDENTITY" ]; }; then
  HAS_EXISTING_IDENTITY=1
fi
if [ -z "$ENROLLMENT_TOKEN" ] && [ "$HAS_EXISTING_IDENTITY" -eq 0 ]; then
  [ -r /dev/tty ] || die "no enrollment token was provided and no terminal is available"
  printf 'Enrollment token: ' > /dev/tty
  stty -echo < /dev/tty
  TTY_ECHO_DISABLED=1
  IFS= read -r ENROLLMENT_TOKEN < /dev/tty || die "could not read the enrollment token"
  stty echo < /dev/tty
  TTY_ECHO_DISABLED=0
  printf '\n' > /dev/tty
fi
[ -n "$ENROLLMENT_TOKEN" ] || [ "$HAS_EXISTING_IDENTITY" -eq 1 ] || die "enrollment token must not be empty on first install"

node_major() {
  command -v node >/dev/null 2>&1 || return 1
  node -p "Number(process.versions.node.split('.')[0])" 2>/dev/null
}

ensure_node() {
  major=$(node_major || true)
  case "$major" in
    ""|*[!0-9]*) major=0 ;;
  esac
  if [ "$major" -lt "$MINIMUM_NODE_MAJOR" ]; then
    if ! command -v brew >/dev/null 2>&1; then
      if [ "$PLATFORM" = "Linux" ]; then
        die "Node.js 24+ is required. Install it with your trusted distribution or version manager; this installer does not use sudo or add package repositories."
      fi
      die "Node.js 24+ is required. Install it first, or install Homebrew so this script can install node@24."
    fi
    info "Installing Node.js 24 with Homebrew"
    brew install node@24
    NODE_BIN_OVERRIDE="$(brew --prefix node@24)/bin"
    PATH="$NODE_BIN_OVERRIDE:$PATH"
    export PATH
    major=$(node_major || true)
  fi
  case "$major" in
    ""|*[!0-9]*) die "could not determine the installed Node.js version" ;;
  esac
  [ "$major" -ge "$MINIMUM_NODE_MAJOR" ] || die "Node.js 24+ is required; found Node.js $major"
  command -v npm >/dev/null 2>&1 || die "npm is required but was not installed with Node.js"
}

persist_path_entry() {
  path_entry=$1
  persist_even_if_active=${2:-0}
  case "$path_entry" in
    /*) ;;
    *) die "npm returned a non-absolute global prefix" ;;
  esac
  case "$path_entry" in
    *:*|*"'"*) die "npm global bin contains characters that cannot be written safely to PATH" ;;
  esac
  if printf '%s' "$path_entry" | LC_ALL=C grep '[[:cntrl:]]' >/dev/null 2>&1; then
    die "npm global bin contains control characters"
  fi

  case ":$PATH:" in
    *":$path_entry:"*)
      [ "$persist_even_if_active" -eq 1 ] || return
      ;;
    *)
      PATH="$path_entry:$PATH"
      export PATH
      ;;
  esac

  case "${SHELL:-}" in
    */zsh) shell_profile="$HOME/.zprofile" ;;
    */bash)
      if [ "$PLATFORM" = "Darwin" ]; then
        shell_profile="$HOME/.bash_profile"
      else
        shell_profile="$HOME/.profile"
      fi
      ;;
    *) shell_profile="$HOME/.profile" ;;
  esac
  path_line="export PATH='$path_entry':\$PATH"
  if [ ! -f "$shell_profile" ] || ! grep -Fqx "$path_line" "$shell_profile"; then
    {
      printf '\n# Added by the Octo Runtime installer.\n'
      printf '%s\n' "$path_line"
    } >> "$shell_profile"
    info "Added npm global bin to $shell_profile"
  fi
}

acquire_lock() {
  lock_dir=$1
  lock_name=$2
  if ! mkdir "$lock_dir" 2>/dev/null; then
    existing_pid=""
    if [ -r "$lock_dir/pid" ]; then
      IFS= read -r existing_pid < "$lock_dir/pid" || true
    fi
    case "$existing_pid" in
      ""|*[!0-9]*)
        die "$lock_name lock exists at $lock_dir; another installer may be starting"
        ;;
      *)
        if kill -0 "$existing_pid" 2>/dev/null; then
          die "$lock_name is already held by process $existing_pid"
        fi
        rm -f "$lock_dir/pid"
        rmdir "$lock_dir" 2>/dev/null || die "stale $lock_name lock at $lock_dir could not be removed"
        mkdir "$lock_dir" || die "could not acquire $lock_name lock"
        ;;
    esac
  fi
  printf '%s\n' "$$" > "$lock_dir/pid"
}

run_existing_cli() {
  case "$EXISTING_CLI_MODE" in
    shim) "$CLI" "$@" ;;
    entrypoint) node "$CLI_ENTRYPOINT" "$@" ;;
    *) return 127 ;;
  esac
}

ensure_node

case "$CHANNEL" in
  stable) npm_tag=latest ;;
  beta) npm_tag=beta ;;
esac
NPM_SPEC=${OCTO_RUNTIME_NPM_SPEC:-"$PACKAGE_NAME@$npm_tag"}
case "$NPM_SPEC" in
  *://*)
    spec_without_scheme=${NPM_SPEC#*://}
    spec_authority=${spec_without_scheme%%/*}
    case "$spec_authority" in
      *@*) die "OCTO_RUNTIME_NPM_SPEC URL must not contain user info" ;;
    esac
    case "$NPM_SPEC" in
      *\?*|*\#*) die "OCTO_RUNTIME_NPM_SPEC URL must not contain a query or fragment" ;;
    esac
    ;;
esac

NPM_PREFIX=$(npm prefix --global)
[ -n "$NPM_PREFIX" ] || die "npm did not return a global prefix"
case "$NPM_PREFIX" in
  /*) ;;
  *) die "npm returned a non-absolute global prefix" ;;
esac
case "$NPM_PREFIX" in
  *:*|*"'"*) die "npm global prefix contains characters that cannot be used safely" ;;
esac
if printf '%s' "$NPM_PREFIX" | LC_ALL=C grep '[[:cntrl:]]' >/dev/null 2>&1; then
  die "npm global prefix contains control characters"
fi

for runtime_marker in config.json profiles state.db agent-work.db octo-daemon.pid sockets; do
  if [ -e "$HARNESS_HOME/$runtime_marker" ]; then
    HOME_HAS_RUNTIME=1
    break
  fi
done
if [ -d "$HARNESS_HOME/$PROFILE" ]; then
  HOME_HAS_RUNTIME=1
fi

mkdir -p "$HARNESS_HOME/run" "$NPM_PREFIX"
chmod 700 "$HARNESS_HOME" "$HARNESS_HOME/run"
HOME_LOCK_DIR="$HARNESS_HOME/run/installer.lock"
GLOBAL_LOCK_DIR="$NPM_PREFIX/.octo-runtime-installer.lock"
acquire_lock "$HOME_LOCK_DIR" "Runtime Home installer"
HOME_LOCK_HELD=1
acquire_lock "$GLOBAL_LOCK_DIR" "npm global package installer"
GLOBAL_LOCK_HELD=1

CLI="$NPM_PREFIX/bin/octo-runtime"
CLI_ENTRYPOINT="$NPM_PREFIX/lib/node_modules/$PACKAGE_NAME/apps/cli/dist/index.js"
if [ -x "$CLI" ]; then
  EXISTING_CLI_MODE=shim
elif [ -f "$CLI_ENTRYPOINT" ]; then
  EXISTING_CLI_MODE=entrypoint
fi

if [ -n "$EXISTING_CLI_MODE" ]; then
  if ! EXISTING_LOGIN_HELP=$(run_existing_cli login --help 2>&1); then
    die "the installed CLI cannot describe its login contract; no npm files were changed"
  fi
  case "$EXISTING_LOGIN_HELP" in
    *--prepare-update*--recover-update*|*--recover-update*--prepare-update*) ;;
    *)
      die "the installed CLI predates safe updates. Stop its foreground daemon, remove any legacy npm link, then rerun this installer"
      ;;
  esac
  EXISTING_LOGIN_HELP=""
  info "Draining the existing daemon before updating the npm package"
  if ! run_existing_cli \
    --home "$HARNESS_HOME" \
    --profile "$PROFILE" \
    login --prepare-update --wait-drained; then
    die "the installed CLI could not prepare a safe package update; no npm files were changed"
  fi
  PREPARED_UPDATE=1
elif [ "$HOME_HAS_RUNTIME" -eq 1 ]; then
  die "Runtime Home contains Runtime state but the current npm prefix has no usable CLI. Stop the existing daemon and repair or remove the legacy npm link before retrying"
fi

if [ -n "${OCTO_RUNTIME_NPM_SPEC:-}" ]; then
  info "Installing the configured OCTO_RUNTIME_NPM_SPEC with npm"
else
  info "Installing $PACKAGE_NAME@$npm_tag with npm"
fi
if npm install --global --no-audit --no-fund "$NPM_SPEC"; then
  :
else
  npm_status=$?
  printf '%s\n' "[octo-runtime] ERROR: npm install failed with exit $npm_status" >&2
  if [ "$PREPARED_UPDATE" -eq 1 ]; then
    if run_existing_cli \
      --home "$HARNESS_HOME" \
      --profile "$PROFILE" \
      login --recover-update --start; then
      info "Restored the previous service after the failed npm update"
    else
      printf '%s\n' "[octo-runtime] ERROR: automatic service recovery failed; repair the npm package, then run 'octo-runtime login --recover-update --start'" >&2
    fi
  fi
  exit "$npm_status"
fi

persist_path_entry "$NPM_PREFIX/bin" 0
if [ -n "$NODE_BIN_OVERRIDE" ]; then
  persist_path_entry "$NODE_BIN_OVERRIDE" 1
fi
[ -x "$CLI" ] || die "npm completed but $CLI is missing or not executable"

if ! LOGIN_HELP=$("$CLI" login --help 2>&1); then
  die "the installed package does not provide 'octo-runtime login'"
fi
case "$LOGIN_HELP" in
  *--enroll-token-stdin*) ;;
  *) die "the installed login command is missing --enroll-token-stdin" ;;
esac
case "$LOGIN_HELP" in
  *--prepare-update*) ;;
  *) die "the installed login command is missing --prepare-update" ;;
esac
case "$LOGIN_HELP" in
  *--recover-update*) ;;
  *) die "the installed login command is missing --recover-update" ;;
esac
LOGIN_HELP=""

info "Logging in this device"
if ! printf '%s\n' "$ENROLLMENT_TOKEN" | "$CLI" \
  --home "$HARNESS_HOME" \
  --profile "$PROFILE" \
  login \
  --server-url "$SERVER_URL" \
  --agent-work-url "$AGENT_WORK_URL" \
  --channel "$CHANNEL" \
  --enroll-token-stdin; then
  if [ "$PREPARED_UPDATE" -eq 1 ]; then
    if "$CLI" --home "$HARNESS_HOME" --profile "$PROFILE" login --recover-update --start; then
      info "Restored the service after the updated login failed"
    else
      printf '%s\n' "[octo-runtime] ERROR: service recovery also failed; repair the package, then run 'octo-runtime login --recover-update --start'" >&2
    fi
  fi
  die "octo-runtime login failed; rerun this installer after correcting the reported problem"
fi

ENROLLMENT_TOKEN=""
export ENROLLMENT_TOKEN
info "Installing the current-user daemon service"
if ! "$CLI" --home "$HARNESS_HOME" --profile "$PROFILE" daemon install; then
  if [ "$PREPARED_UPDATE" -eq 1 ]; then
    "$CLI" --home "$HARNESS_HOME" --profile "$PROFILE" login --recover-update --start || true
  fi
  die "daemon service installation failed; run 'octo-runtime daemon install' after correcting the reported problem"
fi

info "Starting the daemon and waiting for cloud readiness"
if ! "$CLI" --home "$HARNESS_HOME" --profile "$PROFILE" daemon start --wait-online; then
  if [ "$PREPARED_UPDATE" -eq 1 ]; then
    "$CLI" --home "$HARNESS_HOME" --profile "$PROFILE" login --recover-update --start || true
  fi
  die "daemon startup failed; run 'octo-runtime daemon start --wait-online' after correcting the reported problem"
fi

info "Installation complete"
info "Run: octo-runtime --home '$HARNESS_HOME' --profile '$PROFILE' doctor"
