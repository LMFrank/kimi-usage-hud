#!/bin/bash
# 检查并恢复 Kimi Code 桌面客户端的用量状态条补丁。
# 客户端自动更新会整体替换 desktop-dist，补丁随之消失；本脚本可重复执行（幂等）。
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(dirname "$HERE")"
LOG="${KUH_AUTORESTORE_LOG:-$HOME/Library/Logs/kimi-usage-hud-autorestore.log}"

DIST="/Applications/Kimi Code.app/Contents/Resources/desktop-dist"
if [ ! -f "$DIST/index.html" ]; then
  ALT="$HOME/Applications/Kimi Code.app/Contents/Resources/desktop-dist"
  if [ -f "$ALT/index.html" ]; then
    DIST="$ALT"
  fi
fi

log() { printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >>"$LOG"; }

mkdir -p "$(dirname "$LOG")"
if [ -f "$LOG" ] && [ "$(stat -f%z "$LOG" 2>/dev/null || echo 0)" -gt 1048576 ]; then
  tail -c 524288 "$LOG" >"$LOG.tmp" && mv "$LOG.tmp" "$LOG"
fi

if [ ! -f "$DIST/index.html" ]; then
  log "skip: desktop-dist/index.html not found"
  exit 0
fi

missing=0
check() { # $1 仓库相对路径，$2 载荷相对路径
  if [ ! -f "$REPO/$1" ] || [ ! -f "$DIST/kuh/$2" ] || ! cmp -s "$REPO/$1" "$DIST/kuh/$2"; then
    missing=1
  fi
}
check desktop/loader.js loader.js
check desktop/hud-app.js desktop/hud-app.js
check desktop/fold.js desktop/fold.js
check desktop/reader.js desktop/reader.js
check src/metrics.js src/metrics.js
check styles/hud.css styles/hud.css

if [ "$missing" -eq 0 ] && grep -q "/kuh/loader.js" "$DIST/index.html"; then
  exit 0
fi

log "repair needed: loader tag or payload missing/stale"
if out="$(bash "$HERE/install.sh" 2>&1)"; then
  log "installer ok: $(printf '%s' "$out" | tr '\n' ' ' | cut -c1-400)"
else
  status=$?
  log "installer failed (exit $status): $(printf '%s' "$out" | tr '\n' ' ' | cut -c1-800)"
  exit "$status"
fi
