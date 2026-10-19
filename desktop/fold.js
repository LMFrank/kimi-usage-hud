'use strict';

// 桌面客户端 transcript 折叠（纯函数，可在 Node 中单测）。
// 职责：把 GET /api/v1/sessions/<sid>/transcript 的 data 折叠成状态条要的
// 会话级指标，口径对齐 src/cli-reader.js 对 wire.jsonl 的折叠。
//
// 为什么是 transcript 而不是 messages：客户端自己的会话视图走 transcript
// （turn → steps），每个 step 直接带 usage 与 llmTiming，字段与 wire.jsonl 的
// step.end 逐项对齐（llmFirstTokenLatencyMs / llmStreamDurationMs /
// llmServerFirstTokenMs / llmServerDecodeMs + usage）；而 /messages 的投影
// （kap-server toProtocolMessage）不带 llmTiming、也不带 prompt_id，
// 服务端自身前端也从不调用它。折算因此与 applyLine 一致：
//   - steps  = 有 usage 或 llmTiming 的 step 数（进行中的步两者皆无，不计）
//   - turns  = 这些 step 的 distinct turnId 数
//   - llmMs  = Σ(客户端首 token + 流式时长)；首 token 两项 >0 才计入
//   - turnMs = Σ turn.durationMs（= wire 的 turn.ended.durationMs）
//   - input/output/cache 累计 Σ step.usage；速度用 src/metrics.js 聚合
//
// 与 wire 折叠的差异（README「桌面客户端」一节同步说明）：
//   1. 工具耗时不可得：transcript 的 tool frame 只有 state/output，没有时间戳，
//      无法做 tool.call → tool.result 配对；状态条该字段显示「–」。
//      （/messages 的 created_at 是消息开始时间，配对比 wire 大 2.3 倍，不可用。）
//   2. 轮/步/耗时按 wire 口径只算 main；token 是 main 的逐步折叠加其余 agent 的
//      meta.agent.usage.total（各自都与 wire 逐项一致），子 agent 缺该字段时不计入。
//   3. 折叠范围 = 已拉到的页（hud-app.js 自上而下补齐整会话，上限见该文件）。

import {
  aggregateSpeed,
  cacheHitRate,
  normalizeUsage,
  totalInputTokens
} from '../src/metrics.js';

const RECENT_CAP = 16; // 最近步数样本上限，与 src/cli-reader.js 一致
const MAIN_AGENT_ID = 'main'; // 客户端主 agent 固定 id；其余 id 都是子 agent

function toPositiveMs(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function toTimeMs(value) {
  const ms = Date.parse(typeof value === 'string' ? value : '');
  return Number.isFinite(ms) ? ms : null;
}

// 一步只有产生了指标才算一步（进行中的步两者皆无）；hasTiming 记录该步是否带
// 耗时（llmTiming），供状态条区分「有步但没耗时元数据」。
function stepRecord(step) {
  const hasUsage = step?.usage != null;
  const timing = step?.llmTiming && typeof step.llmTiming === 'object' ? step.llmTiming : null;
  if (!hasUsage && timing == null) return null;

  const usage = normalizeUsage(step.usage);
  return {
    hasTiming: timing != null,
    ttftMs: toPositiveMs(timing?.llmFirstTokenLatencyMs),
    streamMs: toPositiveMs(timing?.llmStreamDurationMs),
    serverTtftMs: toPositiveMs(timing?.llmServerFirstTokenMs),
    decodeMs: toPositiveMs(timing?.llmServerDecodeMs),
    output: usage.output,
    inputOther: usage.inputOther,
    cacheRead: usage.cacheRead,
    cacheCreation: usage.cacheCreation,
    ts: toTimeMs(step.endedAt) ?? toTimeMs(step.startedAt) ?? 0
  };
}

export function emptyFold() {
  return {
    turns: new Map(), // turnId → { durationMs, steps: Map<stepId, 步指标> }
    model: '',
    agentUsage: new Map() // agentId → 该 agent 的会话累计用量（meta.agent.usage.total）
  };
}

// 子 agent 的 token 只从 meta.agent.usage.total 取（一次请求即可，不必翻页）；
// 其字段与 wire 的 usage.record 同名同义，实测与各 agent 的 wire 折叠逐项一致。
export function foldAgentUsage(state, agentId, payload) {
  const total = payload?.meta?.agent?.usage?.total;
  if (typeof agentId !== 'string' || !agentId) return false;
  if (!total || typeof total !== 'object') return false;
  state.agentUsage.set(agentId, normalizeUsage(total));
  return true;
}

// 增量折叠 transcript 的一页：按 turnId 整轮覆盖、轮内按 stepId 覆盖。
// 覆盖而非累加，是因为进行中的轮会被反复拉到——步骤补上 llmTiming、轮补上
// durationMs 都要能反映出来，而重复拉到同一轮不能重复计数。
export function foldTranscript(state, payload) {
  if (!Array.isArray(payload?.items)) return state;

  const model = payload?.meta?.agent?.model;
  if (typeof model === 'string' && model) state.model = model;

  for (const item of payload.items) {
    if (item?.kind !== 'turn' || typeof item.turnId !== 'string') continue;
    const steps = new Map();
    for (const step of Array.isArray(item.steps) ? item.steps : []) {
      const record = stepRecord(step);
      if (!record) continue;
      const stepId = typeof step.stepId === 'string' ? step.stepId : `#${step.ordinal}`;
      steps.set(stepId, record);
    }
    const durationMs = Number(item.durationMs);
    state.turns.set(item.turnId, {
      durationMs: Number.isFinite(durationMs) && durationMs > 0 ? durationMs : null,
      steps
    });
  }
  return state;
}

// 输出状态条渲染用的视图字段（与 src/cli-reader.js 的 finalizeSession 同形）。
export function summarizeFold(state) {
  let turns = 0;
  let steps = 0;
  let timingSteps = 0;
  let llmMs = 0;
  let ttftMs = 0;
  let ttftSteps = 0;
  let serverTtftMs = 0;
  let serverTtftSteps = 0;
  let inputOther = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheCreation = 0;
  let turnMs = 0;
  let timedTurns = 0;
  const recent = [];

  for (const turn of state.turns.values()) {
    if (turn.steps.size > 0) turns += 1;
    if (turn.durationMs != null) {
      turnMs += turn.durationMs;
      timedTurns += 1;
    }
    for (const step of turn.steps.values()) {
      steps += 1;
      if (step.hasTiming) timingSteps += 1;
      llmMs += step.ttftMs + step.streamMs;
      if (step.ttftMs > 0) {
        ttftMs += step.ttftMs;
        ttftSteps += 1;
      }
      if (step.serverTtftMs > 0) {
        serverTtftMs += step.serverTtftMs;
        serverTtftSteps += 1;
      }
      inputOther += step.inputOther;
      output += step.output;
      cacheRead += step.cacheRead;
      cacheCreation += step.cacheCreation;
      recent.push(step);
    }
  }

  recent.sort((a, b) => (b.ts || 0) - (a.ts || 0));
  const samples = recent.slice(0, RECENT_CAP);
  const lastStep = samples[0] || null;

  // 子 agent 的 token 从 meta.agent.usage.total 汇总（wire 口径是 token 聚合所有
  // agent、轮/步只算 main）；main 自己不走这里，避免与上面的逐步折叠重复计入。
  let agentCount = 0;
  for (const [agentId, agentUsage] of state.agentUsage) {
    if (agentId === MAIN_AGENT_ID) continue;
    agentCount += 1;
    inputOther += agentUsage.inputOther;
    output += agentUsage.output;
    cacheRead += agentUsage.cacheRead;
    cacheCreation += agentUsage.cacheCreation;
  }

  const usage = { inputOther, cacheRead, cacheCreation };

  return {
    model: state.model,
    turnCount: state.turns.size, // 已折叠的轮（含尚无指标的进行中轮）
    turns,
    steps,
    timingSteps, // 带 llmTiming 的步数：为 0 时状态条提示「无耗时元数据」
    agentCount, // 计入 token 的子 agent 数（0 表示本会话没有子 agent）
    llmMs,
    toolMs: null, // transcript 无工具时间戳，见文件头差异说明 1
    avgTtftMs: ttftSteps > 0 ? Math.round(ttftMs / ttftSteps) : null,
    avgServerTtftMs: serverTtftSteps > 0 ? Math.round(serverTtftMs / serverTtftSteps) : null,
    avgTurnMs: timedTurns > 0 ? Math.round(turnMs / timedTurns) : null,
    input: totalInputTokens(usage),
    output,
    cacheHitRate: cacheHitRate(usage),
    streamTokPerSec: aggregateSpeed(samples, 'streamMs'),
    decodeTokPerSec: aggregateSpeed(samples, 'decodeMs'),
    lastTtftMs: lastStep ? lastStep.ttftMs : null
  };
}
