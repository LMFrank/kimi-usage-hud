import test from 'node:test';
import assert from 'node:assert/strict';

import {
  aggregateSpeed,
  cacheHitRate,
  decodeSpeed,
  formatPercentage,
  formatTokenCount,
  normalizeUsage,
  totalInputTokens
} from '../src/metrics.js';
import { applyLine, buildSessions, emptySummary, parseLine } from '../src/cli-reader.js';

test('normalizeUsage 识别 kimi-code CLI 原生字段', () => {
  const u = normalizeUsage({
    inputOther: 100,
    output: 20,
    inputCacheRead: 300,
    inputCacheCreation: 50
  });
  assert.deepEqual(u, {
    inputOther: 100,
    output: 20,
    cacheRead: 300,
    cacheCreation: 50
  });
});

test('normalizeUsage 兼容第三方 provider 常见字段', () => {
  const u = normalizeUsage({
    prompt_tokens: 10,
    completion_tokens: 2,
    cache_read_tokens: 8
  });
  assert.equal(u.inputOther, 10);
  assert.equal(u.output, 2);
  assert.equal(u.cacheRead, 8);
});

test('totalInputTokens = 未缓存输入 + 缓存读 + 缓存创建', () => {
  const u = normalizeUsage({ inputOther: 10, inputCacheRead: 20, inputCacheCreation: 5, output: 7 });
  assert.equal(totalInputTokens(u), 35);
});

test('cacheHitRate 命中率按输入总量计算', () => {
  const usage = { inputOther: 10, cacheRead: 40, cacheCreation: 0 };
  assert.equal(cacheHitRate(usage), 80);

  const nothing = { inputOther: 0, cacheRead: 0, cacheCreation: 0 };
  assert.equal(cacheHitRate(nothing), null);
});

test('parseLine 解析 usage.record 为累计样本', () => {
  const line = JSON.stringify({
    type: 'usage.record',
    model: 'deepseek/DeepSeek-V4-Pro',
    usage: { inputOther: 100, output: 20, inputCacheRead: 300, inputCacheCreation: 50 },
    usageScope: 'turn',
    time: 1787050640478
  });
  const parsed = parseLine(line);
  assert.equal(parsed.kind, 'usage');
  assert.equal(parsed.model, 'deepseek/DeepSeek-V4-Pro');
  assert.equal(parsed.usage.output, 20);
  assert.equal(parsed.time, 1787050640478);
});

test('parseLine 解析 step.end 为耗时样本', () => {
  const line = JSON.stringify({
    type: 'context.append_loop_event',
    event: {
      type: 'step.end',
      usage: { inputOther: 100, output: 90, inputCacheRead: 0, inputCacheCreation: 0 },
      llmFirstTokenLatencyMs: 4863,
      llmStreamDurationMs: 4953,
      llmServerDecodeMs: 4936
    },
    time: 1707050651176
  });
  const parsed = parseLine(line);
  assert.equal(parsed.kind, 'step');
  assert.equal(parsed.output, 90);
  assert.equal(parsed.streamMs, 4953);
  assert.equal(parsed.decodeMs, 4936);
  assert.equal(parsed.ttftMs, 4863);
});

test('parseLine 忽略无关行与损坏 JSON', () => {
  assert.equal(parseLine('{"type":"metadata"}'), null);
  assert.equal(parseLine('{broken json'), null);
  assert.equal(parseLine(''), null);
});

test('decodeSpeed 与 aggregateSpeed 计算 tok/s', () => {
  assert.equal(decodeSpeed(1000, 1000), 1000);
  assert.equal(decodeSpeed(90, 4936), 18); // 90 / 4.936 ≈ 18
  assert.equal(decodeSpeed(10, 1), null); // 时长过短

  const samples = [
    { output: 90, streamMs: 4936 },
    { output: 10, streamMs: 99 }, // 时长 < 100ms，应被过滤
    { output: 56, streamMs: 1000 }
  ];
  // (90 + 56) / ((4936 + 1000)/1000) = 146 / 5.936 ≈ 25
  assert.equal(aggregateSpeed(samples, 'streamMs'), 25);
});

test('formatPercentage 向下截断、封顶 100', () => {
  assert.equal(formatPercentage(99.95), '99.9');
  assert.equal(formatPercentage(100.0), '100.0');
  assert.equal(formatPercentage(123), '100.0');
  assert.equal(formatPercentage(null), null);
});

test('formatTokenCount 缩写', () => {
  assert.equal(formatTokenCount(999), '999');
  assert.equal(formatTokenCount(142000), '142k');
  assert.equal(formatTokenCount(1_500_000), '1.5M');
});

test('parseLine 解析 tool.call / tool.result / turn.ended', () => {
  const call = JSON.stringify({
    type: 'context.append_loop_event',
    event: { type: 'tool.call', toolCallId: 'call_1', name: 'Grep' },
    time: 10000
  });
  assert.deepEqual(parseLine(call), { kind: 'toolCall', time: 10000, toolCallId: 'call_1' });

  const result = JSON.stringify({
    type: 'context.append_loop_event',
    event: { type: 'tool.result', toolCallId: 'call_1', result: {} },
    time: 14000
  });
  assert.deepEqual(parseLine(result), { kind: 'toolResult', time: 14000, toolCallId: 'call_1' });

  const ended = JSON.stringify({ type: 'turn.ended', turnId: 0, reason: 'completed' });
  assert.deepEqual(parseLine(ended), { kind: 'turnEnded', durationMs: 0 });

  const endedWith = JSON.stringify({ type: 'turn.ended', turnId: 0, reason: 'completed', durationMs: 32112 });
  assert.deepEqual(parseLine(endedWith), { kind: 'turnEnded', durationMs: 32112 });
});

test('applyLine 按 step/tool/turn 折叠出轮、步、模型/工具耗时、首 token', () => {
  const s = emptySummary();
  const loop = (event, time) => applyLine(s, parseLine(JSON.stringify({
    type: 'context.append_loop_event', event, time
  })));

  loop({ type: 'step.end', turnId: '0', usage: { output: 100 }, llmFirstTokenLatencyMs: 200, llmStreamDurationMs: 1800, llmServerDecodeMs: 1900 }, 3000);
  loop({ type: 'step.end', turnId: '0', usage: { output: 100 }, llmFirstTokenLatencyMs: 300, llmStreamDurationMs: 1700, llmServerDecodeMs: 1650 }, 6000);
  loop({ type: 'step.end', turnId: '1', usage: { output: 100 }, llmFirstTokenLatencyMs: 500, llmStreamDurationMs: 1500, llmServerDecodeMs: 1400 }, 9000);

  loop({ type: 'tool.call', toolCallId: 'call_1' }, 10000);
  loop({ type: 'tool.result', toolCallId: 'call_1' }, 14000);
  loop({ type: 'tool.call', toolCallId: 'call_2' }, 15000);
  applyLine(s, parseLine(JSON.stringify({ type: 'turn.ended' })));

  assert.equal(s.steps, 3);
  assert.equal(s.turns, 2); // turn "0" 与 "1"
  assert.equal(s.llmMs, 6000); // Σ(ttft + stream) = 2000 + 2000 + 2000
  assert.equal(s.toolMs, 4000); // call_1: 14000 - 10000；call_2 未闭合被丢弃
  assert.equal(s.ttftSteps, 3);
  assert.equal(s.ttftMs, 1000); // 200 + 300 + 500
  assert.equal(Object.keys(s.pendingCalls).length, 0);
});

test('buildSessions 只从 main 算轮/步/耗时，token 聚合所有 agent', () => {
  const files = new Map();
  const main = emptySummary();
  main.workspace = 'wd';
  main.sessionId = 'session_x';
  main.isSubagent = false;
  applyLine(main, parseLine(JSON.stringify({
    type: 'context.append_loop_event',
    event: { type: 'step.end', turnId: '0', usage: { output: 120 }, llmFirstTokenLatencyMs: 600, llmStreamDurationMs: 2400, llmServerDecodeMs: 2000 },
    time: 100
  })));
  applyLine(main, parseLine(JSON.stringify({
    type: 'context.append_loop_event',
    event: { type: 'step.end', turnId: '1', usage: { output: 240 }, llmFirstTokenLatencyMs: 800, llmStreamDurationMs: 4800, llmServerDecodeMs: 4000 },
    time: 200
  })));
  applyLine(main, parseLine(JSON.stringify({
    type: 'usage.record',
    usage: { inputOther: 100, output: 360, inputCacheRead: 400, inputCacheCreation: 0 }
  })));
  files.set('main', main);

  // 子 agent：影响 token，但不影响轮/步/耗时。
  const sub = emptySummary();
  sub.workspace = 'wd';
  sub.sessionId = 'session_x';
  sub.isSubagent = true;
  applyLine(sub, parseLine(JSON.stringify({ type: 'usage.record', usage: { inputOther: 50, output: 40, inputCacheRead: 0, inputCacheCreation: 0 } })));
  applyLine(sub, parseLine(JSON.stringify({
    type: 'context.append_loop_event',
    event: { type: 'step.end', turnId: '0', usage: { output: 40 }, llmFirstTokenLatencyMs: 100, llmStreamDurationMs: 900, llmServerDecodeMs: 800 },
    time: 100
  })));
  files.set('sub', sub);

  const { sessions } = buildSessions(files, {});
  assert.equal(sessions.length, 1);
  const s = sessions[0];
  assert.equal(s.turns, 2);
  assert.equal(s.steps, 2); // 子 agent 的步骤不计入
  assert.equal(s.llmMs, 8600); // 3000 + 5600
  assert.equal(s.avgTtftMs, 700); // (600 + 800) / 2
  assert.equal(s.input, 550); // 500（main）+ 50（sub）
  assert.equal(s.output, 400); // 360 + 40
});