# 更新记录

## 0.2.1（2026-10-19）

桌面客户端（Kimi Code Desktop）支持：

- 新增桌面补丁模式：把同一条用量状态条注入客户端页面，数据直接读客户端自己的本地 API（`/api/v1/sessions/<sid>/transcript` 与各 agent 的用量），不需要浏览器扩展、Native Messaging host 或额外进程。
- 面板覆盖整会话：先渲染最新一页立即出数，再用 `before_turn` 逐页向更早补齐（20 轮/页，最多 50 页防呆），边补边更新。
- 子 agent token 纳入统计：读每个 agent 的 `meta.agent.usage.total`，状态条标题标「子 agent N」。
- 工具耗时在桌面端不可得：transcript 的工具帧不带时间戳；`/messages` 的消息时间是「消息开始时间」，与工具调用时刻不同基准（配对结果偏大约 2.3 倍），故该位显示 `–`。浏览器扩展路径不受影响。
- 新增 `desktop/install.sh` / `desktop/install.mjs`：幂等安装、备份 `index.html` 为 `index.html.bak-kuh`、`--uninstall` 逐字节还原；优先借客户端自带 Node 运行，无需系统 Node。
- 新增 `desktop/verify.mjs`：按扩展（wire.jsonl）口径打印某个会话的同一行字段，用于逐项对照面板数字。
- 桌面端状态条下移（`--kuh-top: 48px`），避免压住客户端标签栏。
- 测试增至 28 个（折叠聚合、分页、子 agent 用量、跨页覆盖）。

## 0.1.1（2026-09-11）

- native host 启动脚本改为运行期解析 Node，修复切换 Node 版本后启动失败。
- 内容脚本支持 `0.0.0.0` 与带端口地址。
- `npm test` 改为把测试文件传给 Node test runner。

## 0.1.0（2026-08-20）

- 首个版本：页面右上角会话用量状态条（轮/步、LLM 与工具耗时、TTFT、缓存命中、token、流式与解码 TPS），三档显示与明暗主题。
