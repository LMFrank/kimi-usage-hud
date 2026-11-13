'use strict';

// 桌面客户端会话折叠（纯函数，可在 Node 中单测）。
// 1.3.5 读 GET /api/v1/sessions/<sid>/agents/<agent_id>/turns 的 data.turns；
// 旧版兼容 transcript 的 data.items。两者都折叠成与 src/cli-reader.js 同口径的会话指标。
//
// turns 的 step 使用 timing.first_token_ms/stream_ms（若提供）与 snake_case usage；旧
// transcript 使用 llmTiming.llmFirstTokenLatencyMs/llmStreamDurationMs 与 camelCase usage。
// 1.3.5 实测 step 可仅含 started_at/ended_at/usage：此时用首 reasoning/assistant
// item → 首个后续非模型 item（无则 step ended_at）的可见事件窗推导客户端 TTFT/流式。
// 该窗口与 wire 有多组毫秒级对应证据，但不伪装成 wire 精确计时，也不计入后续工具执行。
// 折算与 applyLine 一致：
//   - steps  = 有 usage 或 timing 的 step 数（进行中的步两者皆无，不计）
//   - turns  = 这些 step 的 distinct turnId/turn_id 数
//   - llmMs  = Σ(客户端首 token + 流式时长)；首 token 两项 >0 才计入
//   - turnMs = Σ turn.duration_ms/durationMs（= wire 的 turn.ended.durationMs）
//   - input/output/cache 累计 Σ step.usage；速度用 src/metrics.js 聚合
//
// 与 wire 折叠的差异（README「桌面客户端」一节同步说明）：
//   1. 工具耗时不可得：turn 的 tool frame 只有 state/output，没有时间戳，
//      无法做 tool.call → tool.result 配对；状态条该字段显示「–」。
//      （/messages 的 created_at 是消息开始时间，配对比 wire 大 2.3 倍，不可用。）
//   2. 轮/步/耗时按 wire 口径只算 main；token 是已发现 main 与各子 agent 的逐步
//      usage 之和（子 agent 单独折叠，见 foldAgentTranscript）。
//   3. 服务端计时样本覆盖率不足时，avgServerTtftMs / 解码 TPS 不给值或退回流式口径。
//   4. 折叠范围 = 已拉到的页（hud-app.js 自上而下补齐整会话，上限见该文件）。

import {
  aggregateSpeed,
  cacheHitRate,
  normalizeUsage,
  totalInputTokens
} from '../src/metrics.js';

const RECENT_CAP = 16; // 最近步数样本上限，与 src/cli-reader.js 一致
const MAIN_AGENT_ID = 'main'; // 客户端主 agent 固定 id；其余 id 都是子 agent
const MIN_SAMPLE_COVERAGE = 0.9; // 服务端计时/解码耗时的样本覆盖率下限

function toPositiveMs(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function toTimeMs(value) {
  const ms = Date.parse(typeof value === 'string' ? value : '');
  return Number.isFinite(ms) ? ms : null;
}

function timelineTiming(step, items) {
  const isModelItem = (item) => item?.type === 'reasoning' || item?.type === 'assistant_message';
  const firstIndex = items.findIndex((item) => item.step_index === step.index && isModelItem(item));
  if (firstIndex < 0) return null;
  const startedMs = toTimeMs(step.started_at);
  const firstMs = toTimeMs(items[firstIndex].created_at);
  const next = items.slice(firstIndex + 1).find((item) => item.step_index !== step.index || !isModelItem(item));
  const endedMs = next ? toTimeMs(next.created_at) : toTimeMs(step.ended_at);
  if (startedMs == null || firstMs == null || endedMs == null || firstMs < startedMs || endedMs < firstMs) return null;
  return { first_token_ms: firstMs - startedMs, stream_ms: endedMs - firstMs };
}

// 一步只有产生了指标才算一步（进行中的步两者皆无）；hasTiming 记录该步是否带
// 耗时（timing/llmTiming 或已验证的 item 时间窗），供状态条区分「有步但没耗时元数据」。
function stepRecord(step, items) {
  const hasUsage = step?.usage != null;
  const rawTiming = step?.timing ?? step?.llmTiming;
  const hasNativeTiming = rawTiming && typeof rawTiming === 'object';
  const timing = hasNativeTiming ? rawTiming : timelineTiming(step, items);
  if (!hasUsage && timing == null) return null;

  const rawUsage = step.usage;
  const usage = normalizeUsage({
    ...rawUsage,
    inputOther: rawUsage?.inputOther ?? rawUsage?.input_other,
    inputCacheRead: rawUsage?.inputCacheRead ?? rawUsage?.input_cache_read,
    inputCacheCreation: rawUsage?.inputCacheCreation ?? rawUsage?.input_cache_creation
  });
  return {
    hasTiming: timing != null,
    approximateTiming: !hasNativeTiming && timing != null,
    ttftMs: toPositiveMs(timing?.llmFirstTokenLatencyMs ?? timing?.first_token_ms),
    streamMs: toPositiveMs(timing?.llmStreamDurationMs ?? timing?.stream_ms),
    serverTtftMs: toPositiveMs(timing?.llmServerFirstTokenMs ?? timing?.server_first_token_ms),
    decodeMs: toPositiveMs(timing?.llmServerDecodeMs ?? timing?.server_decode_ms),
    output: usage.output,
    inputOther: usage.inputOther,
    cacheRead: usage.cacheRead,
    cacheCreation: usage.cacheCreation,
    ts: toTimeMs(step.endedAt ?? step.ended_at) ?? toTimeMs(step.startedAt ?? step.started_at) ?? 0
  };
}

export function emptyFold() {
  return {
    turns: new Map(), // turnId → { durationMs, steps: Map<stepId, 步指标> }
    model: '',
    agents: new Map() // agentId → 与 main 同构的子状态 { turns, model }
  };
}

// 子 agent 的 token 用与 main 相同的逐步折叠：每个子 agent 一个独立状态，
// 分页/刷新都走 foldTranscript（turnId 整轮覆盖、stepId 步内覆盖）。
export function foldAgentTranscript(state, agentId, payload) {
  if (typeof agentId !== 'string' || !agentId || agentId === MAIN_AGENT_ID) return false;
  let agent = state.agents.get(agentId);
  if (!agent) {
    agent = { turns: new Map(), model: '' };
    state.agents.set(agentId, agent);
  }
  foldTranscript(agent, payload);
  return true;
}

// 增量折叠一页：按 turn_id/turnId 整轮覆盖、轮内按 step_id/stepId/index 覆盖。
// 覆盖而非累加，是因为进行中的轮会被反复拉到——步骤补上 timing、轮补上
// duration_ms 都要能反映出来，而重复拉到同一轮不能重复计数。
export function foldTranscript(state, payload) {
  const turns = Array.isArray(payload?.turns) ? payload.turns : payload?.items;
  if (!Array.isArray(turns)) return state;

  const model = payload?.meta?.agent?.model;
  if (typeof model === 'string' && model) state.model = model;

  for (const item of turns) {
    const turnId = typeof item?.turn_id === 'string'
      ? item.turn_id
      : item?.kind === 'turn' && typeof item?.turnId === 'string' ? item.turnId : null;
    if (turnId == null) continue;
    const steps = new Map();
    const items = Array.isArray(item.items) ? item.items : [];
    for (const step of Array.isArray(item.steps) ? item.steps : []) {
      const record = stepRecord(step, items);
      if (!record) continue;
      const rawStepId = step.step_id ?? step.stepId;
      const stepId = typeof rawStepId === 'string' ? rawStepId : `#${step.ordinal ?? step.index}`;
      steps.set(stepId, record);
    }
    const durationMs = Number(item.duration_ms ?? item.durationMs);
    state.turns.set(turnId, {
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
  let approximateTiming = false;
  let decodeSteps = 0;
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
      if (step.approximateTiming) approximateTiming = true;
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
      if (step.decodeMs > 0) decodeSteps += 1;
      inputOther += step.inputOther;
      output += step.output;
      cacheRead += step.cacheRead;
      cacheCreation += step.cacheCreation;
      recent.push(step);
    }
  }

  recent.sort((a, b) => (b.ts || 0) - (a.ts || 0));
  const samples = recent.slice(0, RECENT_CAP);
  const lastStep = samples.find((step) => step.ttftMs > 0) || null;

  // 子 agent 的 token 同样按 step.usage 逐项累加（与 main 同口径）；轮/步/耗时
  // 仍只取 main，符合 wire「token 聚合所有 agent、轮/步只算 main」。
  let agentCount = 0;
  for (const agent of state.agents.values()) {
    let agentSteps = 0;
    for (const turn of agent.turns.values()) {
      for (const step of turn.steps.values()) {
        agentSteps += 1;
        inputOther += step.inputOther;
        output += step.output;
        cacheRead += step.cacheRead;
        cacheCreation += step.cacheCreation;
      }
    }
    if (agentSteps > 0) agentCount += 1;
  }

  const usage = { inputOther, cacheRead, cacheCreation };
  const serverTtftCoverage = steps > 0 ? serverTtftSteps / steps : 0;
  const decodeCoverage = steps > 0 ? decodeSteps / steps : 0;
  const streamTokPerSec = aggregateSpeed(samples, 'streamMs');

  return {
    model: state.model,
    turnCount: state.turns.size, // 已折叠的轮（含尚无指标的进行中轮）
    turns,
    steps,
    timingSteps, // 带 timing/llmTiming 的步数：为 0 时状态条提示「无耗时元数据」
    approximateTiming, // 至少一个 main step 使用 REST timeline 推导，相关指标需标 ≈
    agentCount, // 有步骤的子 agent 数（0 表示本会话没有子 agent）
    llmMs,
    toolMs: null, // turns/transcript 无工具时间戳，见文件头差异说明 1
    avgTtftMs: ttftSteps > 0 ? Math.round(ttftMs / ttftSteps) : null,
    // 1.1.1 的投影只带少量服务端首 token 样本（实测 3/176），直接平均会被异常
    // 大值带偏；覆盖率不足 90% 时不给值，状态条渲染为「–」。
    avgServerTtftMs: serverTtftCoverage >= MIN_SAMPLE_COVERAGE
      ? Math.round(serverTtftMs / serverTtftSteps)
      : null,
    avgTurnMs: timedTurns > 0 ? Math.round(turnMs / timedTurns) : null,
    input: totalInputTokens(usage),
    output,
    cacheHitRate: cacheHitRate(usage),
    streamTokPerSec,
    // 解码 TPS 同理：服务端解码耗时样本不足时退回流式口径——wire 里两者是同一段
    // 流式窗口（llmStreamDurationMs / llmServerDecodeMs），样本充分时数值一致。
    decodeTokPerSec: decodeCoverage >= MIN_SAMPLE_COVERAGE
      ? aggregateSpeed(samples, 'decodeMs')
      : streamTokPerSec,
    lastTtftMs: lastStep ? lastStep.ttftMs : null
  };
}
