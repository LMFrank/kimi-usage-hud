# 更新记录

## 0.2.3（2026-11-13）

桌面客户端（Kimi Code 1.3.5）兼容与更新后自动恢复：

- 数据源切换到 `GET /api/v1/sessions/<sid>/agents/<agent_id>/turns`，按客户端页面自身方式复用 `kimi-web.server-credential` 并携带 Bearer；模型名改从会话接口的 `agent_config.model` 读取。凭据只用于同源本地请求，不另行持久化或输出。
- 新分页游标改为 `before_ordinal`，每页仍取 20 轮；折叠层适配新版 `turn_id` / `step_id` / `duration_ms`、snake_case `usage` 与 `timing`，保留跨页去重和进行中轮覆盖更新。
- 仅在 `turns` 返回 404 时回退旧版 `/transcript` 与 `before_turn`；401 等其他错误直接显示，不通过回退吞错。
- 新版 `turns` 不带旧版 `agents` roster 时，复用 1.3.5 前端同一 `/api/v1/ws`、Bearer 子协议和 `subscribe` 订阅，只从 `task.list` / `task` 的 `child_agent_id` 发现并递归订阅 agent；各 agent 历史回填、15s 最新页刷新和 token 汇总仍使用 turns REST，WS 不作为第二份用量数据源。
- 初次模型/turns 加载失败后由后续路由轮询在原会话内自动重试；模型名随 2s 主轮询刷新，支持会话内切换模型。子 agent 历史回填按 agent 去重，空历史或失败在后续节拍重试。
- WS 增加 ping→pong 与单层指数退避重连（250ms 起始、4s 封顶）；重连重新读取最新凭据并恢复 main 与已知 roster 订阅，stop 后不重连，旧 socket 的延迟回调隔离在当前会话状态之外。
- 实证修正 1.3.5 turns 的指标缺口：部分 step 仅含 `started_at/ended_at/usage`，HUD 不再因此整体停留在「无耗时元数据」。优先使用原生 timing；缺失时按首 reasoning/assistant item 到首个后续非模型 item 的时间窗推导客户端 TTFT/流式，不把工具时长计入 LLM。该 REST 事件窗与 wire 存在毫秒级记录差，不作为 wire 精确计时；无模型 item 的步骤不伪造 timing，最近 TTFT 取最近有效正样本。
- 修复重载后旧 fold 仍执行的问题：loader 和 HUD 已更新版本 hash 时，Electron 仍可能按无查询参数的模块 URL 复用旧 ES module；现在 HUD 将自身查询参数透传给 metrics / fold / reader，保证三者与当前载荷一致。
- 补齐已完成子 agent roster：WS `task.list` 仅含活动任务，不能单独恢复历史 agent。现同时发现 main turns 中 `tool_call.agent_refs` 的真实 `agent_id`，已完成 agent 也走同一历史回填、15s 最新页刷新和去重流程；引用只用于 roster，不读取 prompt 或工具输出。
- 近似计时显式标识：summary 含 REST timeline 推导时，LLM、客户端 TTFT、流式/解码速度显示 `≈`；原生 timing 不标近似，保留毫秒级记录差及无模型 item 不造 timing 的边界。
- 新增可选的用户级 LaunchAgent：监听客户端 `desktop-dist` 变化并在登录时自检，补丁被客户端更新清除或载荷过期时自动调用原安装器恢复；提供卸载入口，幂等检查避免完整补丁被重复写入。
- `npm run check` 纳入 `desktop/reader.js` 与两个自动恢复 shell 脚本的语法检查，自动恢复完整性清单同步覆盖 reader；测试增至 48 个，覆盖凭据复用、`before_ordinal`、仅限 404 的回退、新版字段折叠、初次失败自动重试、模型刷新、WS agent roster 回填/汇总，以及 ping/pong、鉴权重读、断线重连、旧回调隔离、模型 item 时间窗恢复、HUD 子模块版本缓存隔离、已完成 agent_refs 回填和 timeline 近似的可见标记。

## 0.2.2（2026-10-22）

桌面客户端（Kimi Code 1.1.1 / host 2.2.0）数值修正：

- 子 agent token 改为**折叠各子 agent transcript 的步骤 `usage`**（与 main 同一口径）：
  1.1.1 起子 agent 的 `meta.agent.usage.total` 为 null，旧实现永远拿不到；现在按 agent
  各自分页回填（20 轮/页、最多 20 页）并每 15s 重拉最新一页覆盖更新，面板的
  输入/输出/缓存重新覆盖所有 agent。
- 服务端 TTFT 加**样本覆盖率守卫**：1.1.1 的 transcript 投影只保留少量服务端计时样本
  （实测 3/176 步），直接平均会被异常大值带偏（面板曾显示 32.4s，wire 真值 2.6s）；
  覆盖率低于 90% 时该位显示 `–`。
- 解码 TPS 同样加覆盖率守卫：服务端解码耗时样本不足 90% 时退回流式口径
  （两者是同一段流式窗口的耗时）。
- 删除了对 `meta.agent.usage.total` 的全部依赖；README 口径表同步更新，并补充
  「面板包含进行中的轮已完成步骤、wire 的 usage.record 轮结束才落盘」的对照须知。
- 测试增至 30 个（子 agent 多页合并/覆盖、覆盖率守卫、原有分页与覆盖用例）。

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
