#!/usr/bin/env bash
set -euo pipefail

HOST_NAME="com.kimi.usage.hud"
MANIFEST_DIR="${HOME}/Library/Application Support/Google/Chrome/NativeMessagingHosts"
HOST_DIR="$(cd "$(dirname "$0")" && pwd)"
HOST_JS="${HOST_DIR}/host.mjs"
LAUNCHER="${HOST_DIR}/host-launcher"
MANIFEST_PATH="${MANIFEST_DIR}/${HOST_NAME}.json"

EXT_ID="${1:-}"
if [[ -z "${EXT_ID}" ]]; then
  echo "用法: $0 <扩展ID>"
  echo ""
  echo "扩展ID 获取方式：chrome://extensions 打开开发者模式，找到「Kimi Code Usage HUD」，"
  echo "复制条目里显示的那串 ID（如 abcdefghijklmnop...）。"
  exit 1
fi

if [[ ! -f "${HOST_JS}" ]]; then
  echo "找不到 host 脚本: ${HOST_JS}" >&2
  exit 1
fi

# GUI 启动的 Chrome 没有 shell/nvm 的 PATH，`#!/usr/bin/env node` 会失败；
# 这里解析出 node 的绝对路径，写进启动脚本，让 Chrome 直接用它来 exec host.mjs。
NODE_BIN="$(command -v node || true)"
if [[ -z "${NODE_BIN}" ]]; then
  echo "当前环境找不到 node，无法生成宿主启动脚本" >&2
  exit 1
fi

cat > "${LAUNCHER}" <<EOF
#!/bin/sh
exec "${NODE_BIN}" "${HOST_JS}" "\$@"
EOF
chmod +x "${LAUNCHER}"

mkdir -p "${MANIFEST_DIR}"

cat > "${MANIFEST_PATH}" <<EOF
{
  "name": "${HOST_NAME}",
  "description": "Kimi Code Usage HUD native host",
  "path": "${LAUNCHER}",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://${EXT_ID}/"]
}
EOF

echo "已写入    : ${MANIFEST_PATH}"
echo "启动脚本   : ${LAUNCHER}"
echo "宿主 脚本  : ${HOST_JS}"
echo "Node       : ${NODE_BIN}"
echo "授权       : chrome-extension://${EXT_ID}/"
echo ""
echo "装完后彻底退出并重开 Chrome（Quit，不是关窗口），再刷新 kimi 页面。"