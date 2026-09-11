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
# 启动脚本不写死单一版本：nvm 换版本（如 23.x → 22.x）后旧路径消失，
# 宿主会启动即退出，扩展侧看到的是 “Native host has exited.”。
NODE_BIN="$(command -v node || true)"
if [[ -z "${NODE_BIN}" ]]; then
  echo "当前环境找不到 node，无法生成宿主启动脚本" >&2
  exit 1
fi

cat > "${LAUNCHER}" <<EOF
#!/bin/sh
# 由 host/install.sh 生成：按 nvm default → 安装时记录的 node → 其它 nvm 版本 → 系统 node 的顺序解析。
NODE_BIN=""
if [ -r "\$HOME/.nvm/alias/default" ]; then
  NVM_DEFAULT="\$(cat "\$HOME/.nvm/alias/default" 2>/dev/null)"
  [ -n "\${NVM_DEFAULT}" ] && NODE_BIN="\$HOME/.nvm/versions/node/v\${NVM_DEFAULT}/bin/node"
fi
if [ ! -x "\${NODE_BIN}" ]; then
  for candidate in \\
    "${NODE_BIN}" \\
    "\$HOME"/.nvm/versions/node/*/bin/node \\
    /opt/homebrew/bin/node \\
    /usr/local/bin/node; do
    if [ -x "\${candidate}" ]; then NODE_BIN="\${candidate}"; break; fi
  done
fi
if [ ! -x "\${NODE_BIN}" ]; then
  echo "kimi-usage-hud: 找不到可用的 node，请重跑 host/install.sh" >&2
  exit 127
fi
exec "\${NODE_BIN}" "${HOST_JS}" "\$@"
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