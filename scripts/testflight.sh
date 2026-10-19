#!/bin/bash
# TestFlight 자동 올리기 (REQ-F-762). Runs on a Mac with Xcode, from a clone kept only for this (it checks out
# origin/main in place). When origin/main has changed ios/ since the last upload, it archives the app and uploads
# it to App Store Connect. The build number is minutes since 2026-01-01 UTC, past the last upload, so it only goes up.
#
#   scripts/testflight.sh           build and upload if ios/ changed since the last upload
#   scripts/testflight.sh --force   build and upload origin/main anyway
#   scripts/testflight.sh install   check every 10 minutes through a LaunchAgent
#   scripts/testflight.sh status    the last result and the last lines of the log
#
# Signing uses the Xcode account (Settings → Accounts) unless ~/.claude-bridge/testflight/api.env sets an App Store
# Connect API key (ASC_KEY_PATH, ASC_KEY_ID, ASC_ISSUER_ID), which does not log out the way an Xcode account can.

# Everything is in main so that checking out a newer copy of this file mid-run cannot change what bash reads next.
main() {
  set -eo pipefail
  local dir="$HOME/.claude-bridge/testflight"
  local repo
  repo="$(cd "$(dirname "$0")/.." && pwd)"
  mkdir -p "$dir"
  case "${1:-}" in
    install) install "$dir" "$repo"; return ;;
    status) cat "$dir/result" 2>/dev/null || echo '아직 돌지 않았어요'; tail -n 20 "$dir/log" 2>/dev/null || true; return ;;
  esac
  # One run at a time: a build takes longer than the 10 minutes between checks. A lock whose run is gone (killed,
  # or left by the first version of this script) is taken over.
  local lock="$dir/lock"
  if ! mkdir "$lock" 2>/dev/null; then
    local pid
    pid="$(cat "$lock/pid" 2>/dev/null || true)"
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then echo '이미 돌고 있어요'; return 0; fi
    echo "$(date '+%F %T') 남은 lock 을 이어받아요 (pid ${pid:-없음})" >> "$dir/log"
  fi
  echo $$ > "$lock/pid"
  # Expanded now: the EXIT trap runs after main has returned and its locals are gone.
  trap "rm -f '$lock/pid'; rmdir '$lock'" EXIT
  # launchd's PATH finds the Command Line Tools' xcodebuild, which cannot archive; use Xcode's.
  if [ -z "${DEVELOPER_DIR:-}" ] && [ -d /Applications/Xcode.app/Contents/Developer ]; then
    export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
  fi
  cd "$repo"
  if [ -n "$(git status --porcelain)" ]; then
    echo "$repo 에 고친 파일이 있어 멈춰요. 이 스크립트는 올리기 전용 클론에서 돌려요" >&2
    return 1
  fi
  git fetch -q origin main
  local head last
  head="$(git rev-parse origin/main)"
  last="$(cat "$dir/last" 2>/dev/null || true)"
  if [ "${1:-}" != --force ] && [ -n "$last" ] && git diff --quiet "$last" "$head" -- ios; then
    return 0
  fi
  git checkout -q --detach "$head"
  # Minutes since 2026-01-01 UTC, and always past the last upload. It was the commit count, which fell to 1 when the
  # history was squashed, and App Store Connect refuses a build number lower than one it has. Stays under the
  # server's 10,000,000 (REQ-F-781) until about 2045.
  local build out prev
  build=$(( ($(date -u +%s) - 1767225600) / 60 ))
  prev="$(cat "$dir/build" 2>/dev/null || sed -nE 's/.* 올림 [0-9a-f]+ build ([0-9]+)$/\1/p' "$dir/result" 2>/dev/null || true)"
  if [[ "$prev" =~ ^[0-9]+$ ]] && [ "$build" -le "$prev" ]; then build=$((prev + 1)); fi
  out="$(mktemp -d)"
  local auth=()
  if [ -f "$dir/api.env" ]; then
    # shellcheck disable=SC1091
    source "$dir/api.env"
    auth=(-authenticationKeyPath "$ASC_KEY_PATH" -authenticationKeyID "$ASC_KEY_ID" -authenticationKeyIssuerID "$ASC_ISSUER_ID")
  fi
  cat > "$out/export.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>method</key><string>app-store-connect</string>
  <key>destination</key><string>upload</string>
  <key>teamID</key><string>26THSK9ZBX</string>
  <key>signingStyle</key><string>automatic</string>
</dict>
</plist>
PLIST
  {
    echo "== $(date '+%F %T') ${head:0:7} build $build"
    xcodebuild -quiet -project ios/Bridge.xcodeproj -scheme Bridge -configuration Release \
      -destination generic/platform=iOS -archivePath "$out/Bridge.xcarchive" \
      CURRENT_PROJECT_VERSION="$build" -allowProvisioningUpdates "${auth[@]}" archive
    xcodebuild -exportArchive -archivePath "$out/Bridge.xcarchive" -exportPath "$out/export" \
      -exportOptionsPlist "$out/export.plist" -allowProvisioningUpdates "${auth[@]}"
  } >> "$dir/log" 2>&1 || {
    echo "$(date '+%F %T') 실패 ${head:0:7} build $build (로그: $dir/log)" > "$dir/result"
    return 1
  }
  echo "$head" > "$dir/last"
  echo "$build" > "$dir/build"
  echo "$(date '+%F %T') 올림 ${head:0:7} build $build" > "$dir/result"
  rm -rf "$out"
}

install() {
  local dir="$1" repo="$2"
  local plist="$HOME/Library/LaunchAgents/dev.creco.bridge.testflight.plist"
  cat > "$plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>dev.creco.bridge.testflight</string>
  <key>ProgramArguments</key><array><string>/bin/bash</string><string>$repo/scripts/testflight.sh</string></array>
  <key>StartInterval</key><integer>600</integer>
  <key>RunAtLoad</key><true/>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string></dict>
  <key>StandardOutPath</key><string>$dir/launchd.log</string>
  <key>StandardErrorPath</key><string>$dir/launchd.log</string>
</dict>
</plist>
PLIST
  launchctl bootout "gui/$(id -u)/dev.creco.bridge.testflight" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$plist"
  echo "10분마다 확인해요: $plist"
}

main "$@"
