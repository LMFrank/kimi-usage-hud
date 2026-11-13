#!/bin/bash
# 安装/卸载自动恢复 LaunchAgent：客户端更新替换 desktop-dist 后自动重装补丁。
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LABEL="com.kimi.usage-hud.autorestore"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
TARGET="$HERE/autorestore.sh"
OUT="$HOME/Library/Logs/kimi-usage-hud-autorestore.launchd.out.log"
ERR="$HOME/Library/Logs/kimi-usage-hud-autorestore.launchd.err.log"

if [ "${1:-}" = "--uninstall" ]; then
  launchctl bootout "gui/$UID/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"
  echo "[autorestore] 已卸载 $LABEL"
  exit 0
fi

if [ ! -f "$TARGET" ]; then
  echo "[autorestore] 缺少 $TARGET" >&2
  exit 1
fi

mkdir -p "$HOME/Library/LaunchAgents" "$(dirname "$OUT")"
cat >"$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$TARGET</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>WatchPaths</key>
  <array>
    <string>/Applications/Kimi Code.app/Contents/Resources</string>
    <string>/Applications/Kimi Code.app/Contents/Resources/desktop-dist</string>
  </array>
  <key>ThrottleInterval</key>
  <integer>15</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>StandardOutPath</key>
  <string>$OUT</string>
  <key>StandardErrorPath</key>
  <string>$ERR</string>
</dict>
</plist>
PLIST_EOF

launchctl bootout "gui/$UID/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$UID" "$PLIST"
launchctl kickstart -k "gui/$UID/$LABEL"

echo "[autorestore] 已安装并启动 $LABEL"
echo "[autorestore] plist: $PLIST"
echo "[autorestore] 日志: $HOME/Library/Logs/kimi-usage-hud-autorestore.log"
