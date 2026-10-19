import test from 'node:test';
import assert from 'node:assert/strict';

import { emptyFold, foldAgentUsage, foldTranscript, summarizeFold } from '../desktop/fold.js';

// fixture 形状取自客户端 /api/v1/sessions/<sid>/transcript 的实测响应：
// data.items 是「轮」，每轮的 steps[] 带 usage 与 llmTiming（字段与 wire.jsonl
// 的 step.end 一致），轮上带 durationMs。
function step(stepId, { usage, llmTiming, endedAt, startedAt } = {}) {
  return {
    kind: 'step',
    stepId,
    turnId: stepId.split('-')[0],
    ordinal: Number(stepId.split('-')[1]),
    state: 'completed',
    ...(usage === undefined ? {} : { usage }),
    ...(llmTiming === undefined ? {} : { llmTiming }),
    ...(startedAt === undefined ? {} : { startedAt }),
    ...(endedAt === undefined ? {} : { endedAt })
  };
}

function turn(turnId, steps, durationMs, extra = {}) {
  return {
    kind: 'turn',
    turnId,
    ordinal: Number(String(turnId).slice(1)),
    state: durationMs == null ? 'running' : 'completed',
    steps,
    ...(durationMs == null ? {} : { durationMs }),
    ...extra
  };
}

function payload(turns, model = 'kimi-k2-local') {
  return { items: turns, has_more: false, meta: { agent: { model } } };
}

const usage = (inputOther, output, cacheRead = 0, cacheCreation = 0) => ({
  inputOther,
  output,
  inputCacheRead: cacheRead,
  inputCacheCreation: cacheCreation
});

test('多轮多步：轮按 turnId 去重，步数/LLM 耗时/首 token/均轮按步与轮累计', () => {
  const state = foldTranscript(emptyFold(), payload([
    turn('t0', [
      step('t0-0', {
        usage: usage(100, 90, 300, 50),
        llmTiming: { llmFirstTokenLatencyMs: 200, llmStreamDurationMs: 1800, llmServerDecodeMs: 1900 },
        endedAt: '2026-10-16T10:00:05.000Z'
      }),
      step('t0-1', {
        usage: usage(20, 10, 480, 0),
        llmTiming: { llmFirstTokenLatencyMs: 300, llmStreamDurationMs: 1700, llmServerDecodeMs: 1600 },
        endedAt: '2026-10-16T10:00:10.000Z'
      })
    ], 30_000),
    turn('t1', [
      step('t1-0', {
        usage: usage(30, 200, 100, 10),
        llmTiming: { llmFirstTokenLatencyMs: 500, llmStreamDurationMs: 1500, llmServerDecodeMs: 1400 },
        endedAt: '2026-10-16T10:00:40.000Z'
      })
    ], 20_000)
  ]));

  const s = summarizeFold(state);
  assert.equal(s.model, 'kimi-k2-local');
  assert.equal(s.turnCount, 2);
  assert.equal(s.turns, 2);
  assert.equal(s.steps, 3);
  assert.equal(s.llmMs, 6000); // (200+1800) + (300+1700) + (500+1500)
  assert.equal(s.avgTtftMs, 333); // (200 + 300 + 500) / 3
  assert.equal(s.avgServerTtftMs, null); // 该页元数据不含服务端首 token
  assert.equal(s.input, 1090); // Σ(inputOther + cacheRead + cacheCreation)
  assert.equal(s.output, 300);
  assert.equal(s.cacheHitRate, (880 / 1090) * 100);
  assert.equal(s.avgTurnMs, 25_000); // (30s + 20s) / 2 轮
  assert.equal(s.toolMs, null); // transcript 无工具时间戳
});

test('进行中的轮被覆盖更新：补上 llmTiming 与 durationMs 后重算，不重复计数', () => {
  const state = emptyFold();
  // 第一次拉到：只有 usage，没有 llmTiming，轮还未结束
  foldTranscript(state, payload([turn('t0', [step('t0-0', { usage: usage(10, 5) })], null)]));
  const before = summarizeFold(state);
  assert.equal(before.steps, 1);
  assert.equal(before.llmMs, 0);
  assert.equal(before.avgTurnMs, null); // 还没 durationMs

  // 同一轮再拉到：步补上耗时、轮补上 durationMs
  foldTranscript(state, payload([turn('t0', [
    step('t0-0', { usage: usage(10, 5), llmTiming: { llmFirstTokenLatencyMs: 100, llmStreamDurationMs: 900 } })
  ], 4_000)]));
  const after = summarizeFold(state);
  assert.equal(after.steps, 1); // 覆盖而非累加
  assert.equal(after.llmMs, 1000);
  assert.equal(after.input, 10);
  assert.equal(after.output, 5);
  assert.equal(after.avgTurnMs, 4000);

  // 同一份数据再折一次：结果不变（轮询幂等）
  foldTranscript(state, payload([turn('t0', [
    step('t0-0', { usage: usage(10, 5), llmTiming: { llmFirstTokenLatencyMs: 100, llmStreamDurationMs: 900 } })
  ], 4_000)]));
  assert.deepEqual(summarizeFold(state), after);
});

test('分页回填与最新页重叠时按 turnId 覆盖：先折新页再折旧页不改变结果', () => {
  const t0 = turn('t0', [
    step('t0-0', {
      usage: usage(10, 5),
      llmTiming: { llmFirstTokenLatencyMs: 100, llmStreamDurationMs: 400 },
      endedAt: '2026-10-16T10:00:05.000Z'
    })
  ], 2_000);
  const t1 = turn('t1', [
    step('t1-0', {
      usage: usage(20, 7),
      llmTiming: { llmFirstTokenLatencyMs: 200, llmStreamDurationMs: 800 },
      endedAt: '2026-10-16T10:00:20.000Z'
    })
  ], 3_000);

  const a = emptyFold();
  foldTranscript(a, payload([t0, t1]));
  const newestFirst = summarizeFold(a);

  const b = emptyFold();
  foldTranscript(b, payload([t1]));
  foldTranscript(b, payload([t0, t1]));
  assert.deepEqual(summarizeFold(b), newestFirst);
  assert.equal(newestFirst.turns, 2);
  assert.equal(newestFirst.steps, 2);
  assert.equal(newestFirst.avgTurnMs, 2500);
});

test('服务端 TTFT 与解码耗时缺席：不计入平均值，也不虚增', () => {
  const state = foldTranscript(emptyFold(), payload([
    turn('t0', [
      step('t0-0', { usage: usage(1, 10), llmTiming: { llmFirstTokenLatencyMs: 300, llmStreamDurationMs: 700 } }),
      step('t0-1', {
        usage: usage(1, 10),
        llmTiming: { llmFirstTokenLatencyMs: 300, llmStreamDurationMs: 700, llmServerFirstTokenMs: 1200, llmServerDecodeMs: 1400 }
      })
    ], 5_000)
  ]));

  const s = summarizeFold(state);
  assert.equal(s.avgTtftMs, 300);
  assert.equal(s.avgServerTtftMs, 1200); // 只由带该字段的那一步决定
  assert.equal(s.decodeTokPerSec, 7); // 只有第二步有 decodeMs：10 tok / 1.4 s
  assert.equal(s.streamTokPerSec, 14); // 两步都在样本里：20 tok / 1.4 s
});

test('都为无值的耗时字段不进样本，也不显示 0', () => {
  const state = foldTranscript(emptyFold(), payload([
    turn('t0', [step('t0-0', { usage: usage(1, 10), llmTiming: { llmFirstTokenLatencyMs: 300, llmStreamDurationMs: 40 } })], 2_000)
  ]));

  const s = summarizeFold(state);
  assert.equal(s.steps, 1);
  assert.equal(s.llmMs, 340);
  assert.equal(s.streamTokPerSec, null); // 40ms 低于 metrics.js 的最小样本时长
  assert.equal(s.decodeTokPerSec, null);
});

test('usage 缺省：只用耗时不计步数统计的两侧都按有指标才计', () => {
  const state = foldTranscript(emptyFold(), payload([
    turn('t0', [
      step('t0-0', { llmTiming: { llmFirstTokenLatencyMs: 100, llmStreamDurationMs: 400 } }),
      step('t0-1', { usage: usage(0, 0), llmTiming: { llmFirstTokenLatencyMs: 100, llmStreamDurationMs: 400 } })
    ], 3_000)
  ]));

  const s = summarizeFold(state);
  assert.equal(s.steps, 2); // 有 usage 或有 llmTiming 就算一步（进行中的步两者皆无）
  assert.equal(s.timingSteps, 2);
  assert.equal(s.llmMs, 1000);
  assert.equal(s.input, 0);
  assert.equal(s.cacheHitRate, null);
  assert.equal(s.streamTokPerSec, null); // output 为 0，速度样本无意义
  assert.equal(s.avgTtftMs, 100);
});

test('没有任何指标的步不计入（进行中的轮不会虚增步数）', () => {
  const state = foldTranscript(emptyFold(), payload([
    turn('t0', [step('t0-0', {}), step('t0-1', { usage: usage(1, 1), llmTiming: { llmFirstTokenLatencyMs: 10, llmStreamDurationMs: 200 } })], 1_000)
  ]));

  const s = summarizeFold(state);
  assert.equal(s.steps, 1);
  assert.equal(s.turnCount, 1);
});

test('有步但没有耗时元数据：timingSteps 为 0，供状态条提示', () => {
  const state = foldTranscript(emptyFold(), payload([
    turn('t0', [step('t0-0', { usage: usage(10, 5) })], 1_000)
  ]));

  const s = summarizeFold(state);
  assert.equal(s.steps, 1);
  assert.equal(s.timingSteps, 0);
  assert.equal(s.llmMs, 0);
  assert.equal(s.avgTtftMs, null);
});

test('usage 兼容外部 provider 命名（normalizeUsage 口径）', () => {
  const state = foldTranscript(emptyFold(), payload([
    turn('t0', [
      step('t0-0', {
        usage: { prompt_tokens: 40, completion_tokens: 8, cache_read_tokens: 60 },
        llmTiming: { llmFirstTokenLatencyMs: 0, llmStreamDurationMs: 0 }
      })
    ], 1_000)
  ]));

  const s = summarizeFold(state);
  assert.equal(s.steps, 1);
  assert.equal(s.llmMs, 0);
  assert.equal(s.avgTtftMs, null); // 0 视为无值
  assert.equal(s.input, 100); // prompt_tokens 40 + cache_read 60
  assert.equal(s.output, 8);
});

test('非轮条目（marker/taskref）与未知轮不参与统计，模型名取 meta.agent.model', () => {
  const state = foldTranscript(emptyFold(), {
    items: [
      { kind: 'marker', markerId: 'm1', marker: 'turn.marker', at: '2026-10-16T10:00:00.000Z' },
      { kind: 'taskref', refId: 'r1', taskId: 'task_1', at: '2026-10-16T10:00:01.000Z' },
      turn('t0', [step('t0-0', { usage: usage(1, 1), llmTiming: { llmFirstTokenLatencyMs: 10, llmStreamDurationMs: 200 } })], 1_000)
    ],
    meta: { agent: { model: 'kimi-k2-local' } }
  });

  const s = summarizeFold(state);
  assert.equal(s.turnCount, 1);
  assert.equal(s.steps, 1);
  assert.equal(s.model, 'kimi-k2-local');
});

test('空数据：无轮无步，供状态条显示「无数据」', () => {
  const s = summarizeFold(foldTranscript(emptyFold(), { items: [], meta: {} }));
  assert.equal(s.turnCount, 0);
  assert.equal(s.turns, 0);
  assert.equal(s.steps, 0);
  assert.equal(s.avgTurnMs, null);
  assert.equal(s.model, '');
  assert.equal(s.cacheHitRate, null);
});

// meta.agent.usage.total 的形状与取值取自客户端实测响应（与各 agent 的 wire
// 折叠逐项一致）：{ inputOther, output, inputCacheRead, inputCacheCreation }。
const agentTotalPayload = (total, model = 'kimi-k3') => ({
  items: [],
  meta: { agent: { model, usage: { total } } }
});

test('子 agent 的 token 从 meta.agent.usage.total 汇总，main 仍按逐步折叠（不重复计入）', () => {
  const state = foldTranscript(emptyFold(), payload([
    turn('t0', [
      step('t0-0', { usage: usage(100, 10, 900, 0), llmTiming: { llmFirstTokenLatencyMs: 100, llmStreamDurationMs: 400 } })
    ], 1_000)
  ]));
  const mainOnly = summarizeFold(state);
  assert.equal(mainOnly.input, 1000); // 100 + 900
  assert.equal(mainOnly.agentCount, 0);

  // main 自己的 meta.usage 也回传（实际请求里它会随每页返回）：不得重复计入
  assert.equal(foldAgentUsage(state, 'main', agentTotalPayload({ inputOther: 100, output: 10, inputCacheRead: 900, inputCacheCreation: 0 })), true);
  const stillMainOnly = summarizeFold(state);
  assert.equal(stillMainOnly.input, mainOnly.input);
  assert.equal(stillMainOnly.output, mainOnly.output);
  assert.equal(stillMainOnly.agentCount, 0);

  // 两个子 agent：token 累加，轮/步/耗时不受影响
  foldAgentUsage(state, 'agent-1', agentTotalPayload({ inputOther: 50, output: 20, inputCacheRead: 150, inputCacheCreation: 0 }));
  foldAgentUsage(state, 'agent-2', agentTotalPayload({ inputOther: 5, output: 2, inputCacheRead: 45, inputCacheCreation: 5 }));
  const all = summarizeFold(state);
  assert.equal(all.agentCount, 2);
  assert.equal(all.input, 1000 + 200 + 55); // main 1000 + agent-1 (50+150) + agent-2 (5+45+5)
  assert.equal(all.output, 10 + 20 + 2);
  assert.equal(all.turns, 1);
  assert.equal(all.steps, 1);
  assert.equal(all.llmMs, 500);
  assert.equal(all.cacheHitRate, (900 + 150 + 45) / (1000 + 200 + 55) * 100);
});

test('子 agent 用量缺字段/缺 total 时该 agent 不计入，且不影响已有汇总', () => {
  const state = emptyFold();
  assert.equal(foldAgentUsage(state, 'agent-1', { items: [], meta: { agent: {} } }), false);
  assert.equal(foldAgentUsage(state, 'agent-1', { items: [], meta: { agent: { usage: {} } } }), false);
  assert.equal(foldAgentUsage(state, '', agentTotalPayload({ output: 1 })), false);
  foldAgentUsage(state, 'agent-1', agentTotalPayload({ inputOther: 7, output: 3, inputCacheRead: 0, inputCacheCreation: 0 }));
  assert.equal(summarizeFold(state).agentCount, 1);
  assert.equal(summarizeFold(state).input, 7);
  // 同一 agent 再拉一次：覆盖而非累加
  foldAgentUsage(state, 'agent-1', agentTotalPayload({ inputOther: 70, output: 30, inputCacheRead: 0, inputCacheCreation: 0 }));
  assert.equal(summarizeFold(state).input, 70);
  assert.equal(summarizeFold(state).agentCount, 1);
});

test('整会话分页补齐：逐页折叠与一次性折叠等价，跨页重复覆盖不重复计数', () => {
  const at = (s) => new Date(Date.parse('2026-10-16T10:00:00.000Z') + s * 1000).toISOString();
  const page1 = [turn('t3', [step('t3-0', { usage: usage(3, 3), llmTiming: { llmFirstTokenLatencyMs: 30, llmStreamDurationMs: 300 }, endedAt: at(30) })], 3_000)];
  const page2 = [
    turn('t1', [step('t1-0', { usage: usage(1, 1), llmTiming: { llmFirstTokenLatencyMs: 10, llmStreamDurationMs: 100 }, endedAt: at(10) })], 1_000),
    turn('t2', [step('t2-0', { usage: usage(2, 2), llmTiming: { llmFirstTokenLatencyMs: 20, llmStreamDurationMs: 200 }, endedAt: at(20) })], 2_000)
  ];
  const page3 = [turn('t0', [step('t0-0', { usage: usage(1, 1), llmTiming: { llmFirstTokenLatencyMs: 10, llmStreamDurationMs: 100 }, endedAt: at(5) })], 1_000)];

  const paged = emptyFold();
  // 先最新页（渲染），再逐页向更早；随后再重拉一次最新页（覆盖）
  for (const page of [page1, page2, page3, page1]) foldTranscript(paged, { items: page, meta: {} });
  const oneShot = foldTranscript(emptyFold(), { items: [...page3, ...page2, ...page1], meta: {} });

  assert.deepEqual(summarizeFold(paged), summarizeFold(oneShot));
  const s = summarizeFold(paged);
  assert.equal(s.turnCount, 4);
  assert.equal(s.turns, 4);
  assert.equal(s.steps, 4);
  assert.equal(s.llmMs, 770); // (30+300) + (10+100) + (20+200) + (10+100)
  assert.equal(s.avgTurnMs, 1750); // (3+1+2+1)s / 4 轮
  assert.equal(s.output, 7);
});

test('分页补齐途中被轮询覆盖更新：最新轮补上 durationMs 后均轮随之更新', () => {
  const state = emptyFold();
  foldTranscript(state, { items: [turn('t1', [step('t1-0', { usage: usage(1, 5) })], 2_000)], meta: {} }); // 最新页
  foldTranscript(state, { items: [turn('t0', [step('t0-0', { usage: usage(1, 5), llmTiming: { llmFirstTokenLatencyMs: 10, llmStreamDurationMs: 90 } })], 1_000)], meta: {} }); // 补旧页
  assert.equal(summarizeFold(state).avgTurnMs, 1500);
  assert.equal(summarizeFold(state).timingSteps, 1);

  // 轮询把进行中的 t1 补全（步补上耗时、轮补上 durationMs）
  foldTranscript(state, {
    items: [turn('t1', [step('t1-0', { usage: usage(1, 5), llmTiming: { llmFirstTokenLatencyMs: 100, llmStreamDurationMs: 400 } })], 6_000)],
    meta: {}
  });
  const s = summarizeFold(state);
  assert.equal(s.timingSteps, 2);
  assert.equal(s.avgTurnMs, 3500); // (6+1)s / 2 轮
  assert.equal(s.steps, 2);
  assert.equal(s.output, 10);
});
