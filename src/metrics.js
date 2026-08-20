'use strict';

// 纯函数：用量归一化、缓存命中率、速度、缩写格式化。
// 字段名同时兼容 kimi-code CLI 的 wire.jsonl（inputOther/inputCacheRead/inputCacheCreation/output）
// 与若干第三方 provider 的常见命名，避免因 provider 不同而识别不到。

const MIN_SPEED_DURATION_MS = 100;

function toNonNegativeInteger(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function firstDefined(source, keys) {
  for (const key of keys) {
    if (source?.[key] != null) return source[key];
  }
  return 0;
}

// 归一化成 { inputOther, output, cacheRead, cacheCreation }。
// 注意：inputOther 不含缓存读/写；三者之和才是真实输入总量。
export function normalizeUsage(raw) {
  const usage = raw && typeof raw === 'object' ? raw : {};
  return {
    inputOther: toNonNegativeInteger(firstDefined(usage, ['inputOther', 'input_tokens', 'prompt_tokens'])),
    output: toNonNegativeInteger(firstDefined(usage, ['output', 'output_tokens', 'completion_tokens'])),
    cacheRead: toNonNegativeInteger(firstDefined(usage, ['inputCacheRead', 'cache_read_input_tokens', 'cache_read_tokens'])),
    cacheCreation: toNonNegativeInteger(firstDefined(usage, ['inputCacheCreation', 'cache_creation_input_tokens', 'cache_creation_tokens']))
  };
}

export function totalInputTokens(usage) {
  return usage.inputOther + usage.cacheRead + usage.cacheCreation;
}

// 缓存命中率 = 缓存命中 token / 输入总量（含缓存创建）。输入为 0 时返回 null。
export function cacheHitRate(usage) {
  const total = totalInputTokens(usage);
  return total > 0 ? (usage.cacheRead / total) * 100 : null;
}

// 显示用百分比：向下截断到 decimals 位小数，永不超 100。
export function formatPercentage(value, decimals = 1) {
  if (value == null || value === '' || Number.isNaN(Number(value))) return null;
  const places = Math.max(0, Math.min(6, Math.floor(Number(decimals) || 0)));
  const factor = 10 ** places;
  const clamped = Math.max(0, Math.min(100, Number(value)));
  const truncated = Math.floor(clamped * factor + 1e-6) / factor;
  return truncated.toFixed(places);
}

// 1k / 1M 缩写，与 HUD 单行展示一致。
export function formatTokenCount(value) {
  const n = toNonNegativeInteger(value);
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, '')}k`;
  return String(n);
}

// 单段耗时（毫秒）→ tok/s。过短或输出为 0 视为无意义，返回 null。
export function decodeSpeed(outputTokens, durationMs) {
  const output = toNonNegativeInteger(outputTokens);
  const duration = Number(durationMs);
  if (!Number.isFinite(duration) || duration < MIN_SPEED_DURATION_MS || output === 0) return null;
  return Math.round(output / (duration / 1000));
}

// 用最近若干步聚合速度（Σoutput / Σduration），过滤过短离群点。
export function aggregateSpeed(samples, key, maxSamples = 12) {
  let totalOut = 0;
  let totalMs = 0;
  let counted = 0;
  for (let i = samples.length - 1; i >= 0 && counted < maxSamples; i -= 1) {
    const s = samples[i];
    const ms = Number(s?.[key]);
    const out = Number(s?.output);
    if (Number.isFinite(ms) && ms >= MIN_SPEED_DURATION_MS && Number.isFinite(out) && out > 0) {
      totalOut += out;
      totalMs += ms;
      counted += 1;
    }
  }
  return totalMs > 0 ? Math.round(totalOut / (totalMs / 1000)) : null;
}

// 毫秒 → "1.2s" / "50.5s" / "3m02s"。用于可选展示耗时。
export function formatDuration(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n < 0) return null;
  if (n < 1000) return `${Math.round(n)}ms`;
  const seconds = Math.round(n / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes}m${String(rest).padStart(2, '0')}s`;
}