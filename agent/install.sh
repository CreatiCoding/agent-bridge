#!/usr/bin/env bash
# claude-bridge agent installer for macOS: checks what the agent needs, offers to install what is missing,
# downloads the agent and starts it.   curl -fsSL __ORIGIN__/install.sh | bash
set -euo pipefail
SITE="__ORIGIN__"
DIR="$HOME/.claude-bridge"

say() { printf '%s\n' "$*"; }
have() { command -v "$1" >/dev/null 2>&1; }
# The script itself arrives on stdin (curl | bash), so questions are asked on the terminal directly.
# /dev/tty can exist and still not open (no controlling terminal), so it is tried rather than tested.
has_tty() { (exec </dev/tty) 2>/dev/null; }
ask() {
  has_tty || return 1
  printf '%s [Y/n] ' "$1" >/dev/tty
  local a
  read -r a </dev/tty || return 1
  case "$a" in '' | y | Y | yes) return 0 ;; *) return 1 ;; esac
}

[ "$(uname)" = "Darwin" ] || { say "이 설치 스크립트는 macOS 용입니다."; exit 1; }

# Homebrew may be installed without being on this shell's PATH.
if ! have brew; then
  for b in /opt/homebrew/bin/brew /usr/local/bin/brew; do
    if [ -x "$b" ]; then eval "$("$b" shellenv)"; break; fi
  done
fi

MISSING=""
# need <command> <brew package> <how to install by hand>
need() {
  if have "$1"; then
    say "  ✓ $1"
    return
  fi
  if have brew && ask "  $1 이 없습니다. Homebrew 로 설치할까요? (brew install $2)"; then
    if brew install "$2" && have "$1"; then
      say "  ✓ $1 설치됨"
      return
    fi
    say "  ✗ $1 설치에 실패했습니다."
  fi
  say "  ✗ $1 없음 — 직접 설치: $3"
  MISSING="$MISSING $1"
}

say "claude-bridge 에이전트를 준비합니다 ($SITE)"
say "필요한 도구를 확인합니다:"
need node node "https://nodejs.org 에서 설치하거나 brew install node"
need tmux tmux "brew install tmux  (Homebrew 가 없으면 https://brew.sh 먼저)"
need git git "xcode-select --install"
if have claude; then
  say "  ✓ claude"
else
  say "  ✗ claude 없음 — 직접 설치: curl -fsSL https://claude.ai/install.sh | bash  (설치 뒤 claude 를 한 번 실행해 로그인)"
  MISSING="$MISSING claude"
fi

if ! have node; then
  say ""
  say "node 가 없으면 에이전트를 실행할 수 없습니다. 설치한 뒤 다시 실행해 주세요:"
  say "  curl -fsSL $SITE/install.sh | bash"
  exit 1
fi
if ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 18 ? 0 : 1)'; then
  say ""
  say "node $(node -v) 는 너무 오래됐습니다. 18 이상이 필요합니다 (brew upgrade node)."
  exit 1
fi

# Only this user: the folder holds the agent key and every conversation's copy (R1-L11).
mkdir -p "$DIR"
chmod 700 "$DIR"
# Every file is fetched and checked before any is put in place: a half-updated agent would not start.
TMP="$(mktemp -d "$DIR/.update.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT
for f in __FILES__; do
  curl -fsSL "$SITE/agent/$f" -o "$TMP/$f"
  node --check "$TMP/$f"
done
for f in __FILES__; do mv "$TMP/$f" "$DIR/$f"; done
say "  ✓ 에이전트 내려받음: $DIR/agent.mjs"

if [ -n "$MISSING" ]; then
  say ""
  say "아직 없는 도구:$MISSING"
  say "에이전트는 켜지지만, 위 도구를 설치하기 전에는 세션을 시작할 수 없습니다. 설치한 뒤에는 에이전트를 다시 켤 필요 없이 바로 됩니다."
fi
say ""
# The tools were just checked and offered above: the agent need not ask again.
export CLAUDE_BRIDGE_SKIP_TOOL_PROMPT=1
# Installed as a background service by default: after this, only the bridge page has to be open.
# `bash -s -- --foreground` keeps the agent in this terminal instead.
MODE="service install"
ARGS=()
for a in "$@"; do
  if [ "$a" = "--foreground" ]; then MODE=""; else ARGS+=("$a"); fi
done
# shellcheck disable=SC2086
if has_tty; then
  exec node "$DIR/agent.mjs" "$SITE" $MODE ${ARGS[@]+"${ARGS[@]}"} </dev/tty
else
  exec node "$DIR/agent.mjs" "$SITE" $MODE ${ARGS[@]+"${ARGS[@]}"}
fi
