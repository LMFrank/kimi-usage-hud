import test from 'node:test';
import assert from 'node:assert/strict';

import { emptyFold, foldAgentTranscript, foldTranscript, summarizeFold } from '../desktop/fold.js';

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

test('服务端计时样本不足一半：均值置空，解码 TPS 退回流式口径', () => {
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
  assert.equal(s.avgTtftMs, 300); // 客户端 TTFT 覆盖率 100%，不受影响
  assert.equal(s.avgServerTtftMs, null); // 1/2 = 50% < 90%
  assert.equal(s.decodeTokPerSec, s.streamTokPerSec); // 解码样本不足 → 流式口径
  assert.equal(s.streamTokPerSec, 14); // 20 tok / 1.4 s
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

// 子 agent 的 transcript 页：与 main 同构（items 是「轮」，steps 带 usage/llmTiming）。
const agentPage = (turns, model = 'kimi-k3') => ({ items: turns, has_more: false, meta: { agent: { model } } });

test('子 agent 的 token 按步骤 usage 折叠：多 agent 求和，轮/步仍只算 main', () => {
  const state = foldTranscript(emptyFold(), payload([
    turn('t0', [
      step('t0-0', { usage: usage(100, 10, 900, 0), llmTiming: { llmFirstTokenLatencyMs: 100, llmStreamDurationMs: 400 } })
    ], 1_000)
  ]));
  const mainOnly = summarizeFold(state);
  assert.equal(mainOnly.input, 1000); // 100 + 900
  assert.equal(mainOnly.agentCount, 0);

  // main 的页不得走子 agent 通道（否则 token 双计）
  assert.equal(foldAgentTranscript(state, 'main', agentPage([])), false);
  assert.equal(foldAgentTranscript(state, '', agentPage([])), false);

  assert.equal(foldAgentTranscript(state, 'agent-1', agentPage([
    turn('t0', [
      step('t0-0', { usage: usage(50, 20, 150, 0) }),
      step('t0-1', { usage: usage(30, 5, 20, 0) })
    ], 2_000)
  ])), true);
  assert.equal(foldAgentTranscript(state, 'agent-2', agentPage([
    turn('t0', [step('t0-0', { usage: usage(5, 2, 45, 5) })], 1_000)
  ])), true);

  const all = summarizeFold(state);
  assert.equal(all.agentCount, 2);
  assert.equal(all.input, 1000 + (50 + 150) + (30 + 20) + (5 + 45 + 5));
  assert.equal(all.output, 10 + 20 + 5 + 2);
  assert.equal(all.turns, 1); // 轮/步/耗时只算 main（子 agent 的 t0 不与之合并）
  assert.equal(all.steps, 1);
  assert.equal(all.llmMs, 500);
  assert.equal(all.cacheHitRate, (900 + 150 + 20 + 45) / all.input * 100);
});

test('子 agent 多页合并与重复页覆盖：与一次性折叠等价，无 usage 的步跳过', () => {
  const page1 = [turn('t2', [step('t2-0', { usage: usage(2, 2) })], 2_000)];
  const page2 = [
    turn('t1', [
      step('t1-0', { usage: usage(1, 1) }),
      step('t1-1', {}) // 进行中的步：无 usage / 无耗时，不计
    ], 1_000)
  ];

  const paged = emptyFold();
  foldAgentTranscript(paged, 'agent-1', agentPage(page1));
  foldAgentTranscript(paged, 'agent-1', agentPage(page2));
  foldAgentTranscript(paged, 'agent-1', agentPage(page1)); // 重拉最新页：覆盖而非累加

  const oneShot = emptyFold();
  foldAgentTranscript(oneShot, 'agent-1', agentPage([...page2, ...page1]));

  assert.deepEqual(summarizeFold(paged), summarizeFold(oneShot));
  const s = summarizeFold(paged);
  assert.equal(s.agentCount, 1);
  assert.equal(s.input, 3);
  assert.equal(s.output, 3);
  assert.equal(s.turns, 0); // 子 agent 不计轮
  assert.equal(s.steps, 0);

  // 只有空页的 agent 不算「有步骤」
  foldAgentTranscript(paged, 'agent-empty', agentPage([]));
  assert.equal(summarizeFold(paged).agentCount, 1);
});

test('服务端 TTFT 覆盖率 ≥90% 才给均值，样本不足时返回 null', () => {
  const coveragePayload = (withServer) => payload([
    turn('t0', Array.from({ length: 10 }, (_, i) => {
      const timing = { llmFirstTokenLatencyMs: 100, llmStreamDurationMs: 1000 };
      if (i < withServer) {
        timing.llmServerFirstTokenMs = 200;
        timing.llmServerDecodeMs = 500;
      }
      return step(`t0-${i}`, {
        usage: usage(1, 10),
        llmTiming: timing,
        endedAt: new Date(Date.parse('2026-10-16T10:00:00.000Z') + i * 1000).toISOString()
      });
    }), 10_000)
  ]);

  const full = summarizeFold(foldTranscript(emptyFold(), coveragePayload(10)));
  assert.equal(full.avgServerTtftMs, 200);

  const edge = summarizeFold(foldTranscript(emptyFold(), coveragePayload(9))); // 9/10 = 90%
  assert.equal(edge.avgServerTtftMs, 200);

  const sparse = summarizeFold(foldTranscript(emptyFold(), coveragePayload(8))); // 8/10 = 80%
  assert.equal(sparse.avgServerTtftMs, null);
  assert.equal(sparse.avgTtftMs, 100); // 客户端 TTFT 不受覆盖率守卫影响
});

test('解码 TPS：样本覆盖率 ≥90% 用解码口径，否则退回流式口径', () => {
  // 10 步、每步 output 10：流式 1000ms → 10 tok/s；解码 500ms（前 N 步）→ 20 tok/s
  const build = (withDecode) => payload([
    turn('t0', Array.from({ length: 10 }, (_, i) => {
      const timing = { llmFirstTokenLatencyMs: 100, llmStreamDurationMs: 1000 };
      if (i < withDecode) timing.llmServerDecodeMs = 500;
      return step(`t0-${i}`, {
        usage: usage(1, 10),
        llmTiming: timing,
        endedAt: new Date(Date.parse('2026-10-16T10:00:00.000Z') + i * 1000).toISOString()
      });
    }), 10_000)
  ]);

  const covered = summarizeFold(foldTranscript(emptyFold(), build(9))); // 90%
  assert.equal(covered.streamTokPerSec, 10);
  assert.equal(covered.decodeTokPerSec, 20); // 90 tok / 4.5 s

  const sparse = summarizeFold(foldTranscript(emptyFold(), build(5))); // 50%
  assert.equal(sparse.decodeTokPerSec, sparse.streamTokPerSec); // 回退
  assert.equal(sparse.decodeTokPerSec, 10);
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
