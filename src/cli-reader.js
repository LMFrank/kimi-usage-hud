'use strict';

// 本地 CLI 用量读取器（File System Access / Native Messaging host 共用）。
// 职责：遍历 sessions/**/agents/*/wire.jsonl，逐行折叠出「当前会话」级别的
// 用量与耗时（对齐 @deepseek-ai/dsh-session-stats 的 sessionStats 投影语义）。
//
// 折叠口径（与 dsh 保持一致，事件名按 kimi-code wire.jsonl 约定）：
//   - steps  = step.end 数量（每个进入的 step 恰好写一条）。
//   - turns  = distinct turnId 数量（据此去重，空 turn 不计）。
//   - llmMs  = Σ(step.end.llmFirstTokenLatencyMs + llmStreamDurationMs)，
//              即模型生成墙钟（步内不区分 tool_use / end_turn）。
//   - toolMs = tool.call → tool.result 按 toolCallId 配对累计；
//             turn.ended 时丢弃未配对的 call（避免持久化膨胀）。
//   - ttftMs/ttftSteps = Σ llmFirstTokenLatencyMs / 有该值的步数（客户端首 token）。
//   - serverTtftMs/serverTtftSteps = Σ llmServerFirstTokenMs / 有该值的步数。
//   - turnMs = Σ turn.ended.durationMs（每轮墙钟，用于平均每轮耗时）。
//   - 流式/解码 tok/s 用 recent 样本 Σoutput / Σduration 聚合。
//   - input/output/cache 以 usage.record 为权威累计（step.end 里的 usage 不重复计数）。
// 纯浏览器 API + 纯函数解析；纯解析部分可在 Node 中单测。

import {
  aggregateSpeed,
  cacheHitRate,
  normalizeUsage,
  totalInputTokens
} from './metrics.js';

const DB_NAME = 'kimi-usage-hud';
const HANDLE_STORE = 'handles';
const HANDLE_KEY = 'kimi-code-sessions';
const READ_CHUNK_BYTES = 16 * 1024 * 1024; // 单次从文件尾读取的上限（字节）
const RECENT_CAP = 16; // 每个会话保留的最近步数样本（用于速度/TPS）
const SESSIONS_VIEW_LIMIT = 20;

// ---------- IndexedDB 句柄持久化（directory handle 不能经 JSON 消息传递） ----------

function openHandleDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(HANDLE_STORE)) db.createObjectStore(HANDLE_STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('无法打开本地目录授权存储'));
  });
}

async function withHandleStore(mode, operation) {
  const db = await openHandleDb();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction(HANDLE_STORE, mode);
      const request = operation(transaction.objectStore(HANDLE_STORE));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('目录授权存储失败'));
      transaction.onabort = () => reject(transaction.error || new Error('目录授权事务失败'));
    });
  } finally {
    db.close();
  }
}

export async function saveDirectoryHandle(handle) {
  await withHandleStore('readwrite', (store) => store.put(handle, HANDLE_KEY));
}

export async function getDirectoryHandle() {
  const handle = await withHandleStore('readonly', (store) => store.get(HANDLE_KEY));
  return handle || null;
}

export async function clearDirectoryHandle() {
  await withHandleStore('readwrite', (store) => store.delete(HANDLE_KEY));
}

export async function permissionState(handle) {
  if (!handle || typeof handle.queryPermission !== 'function') return 'missing';
  try {
    return await handle.queryPermission({ mode: 'read' });
  } catch {
    return 'denied';
  }
}

// ---------- 单行解析（纯函数，可单测） ----------

// usage.record 用于累计 token；step.end 提取耗时样本；tool.call/tool.result
// 通过 toolCallId 配对；turn.ended 清空未闭合工具调用并累计每轮墙钟。
export function parseLine(line) {
  if (!line) return null;

  if (line.includes('"usage.record"')) {
    try {
      const record = JSON.parse(line);
      if (record?.type !== 'usage.record' || !record.usage) return null;
      const time = Number(record.time);
      return {
        kind: 'usage',
        time: Number.isFinite(time) ? time : null,
        usage: normalizeUsage(record.usage),
        model: typeof record.model === 'string' ? record.model : ''
      };
    } catch {
      return null;
    }
  }

  if (line.includes('"step.end"')) {
    try {
      const record = JSON.parse(line);
      const event = record?.event;
      if (event?.type !== 'step.end' || !event.usage) return null;
      const time = Number(record.time);
      const rawTurnId = event.turnId;
      return {
        kind: 'step',
        time: Number.isFinite(time) ? time : null,
        turnId: rawTurnId == null ? '' : String(rawTurnId),
        output: normalizeUsage(event.usage).output,
        streamMs: Number(event.llmStreamDurationMs) || 0,
        decodeMs: Number(event.llmServerDecodeMs) || 0,
        ttftMs: Number(event.llmFirstTokenLatencyMs) || 0,
        serverTtftMs: Number(event.llmServerFirstTokenMs) || 0
      };
    } catch {
      return null;
    }
  }

  if (line.includes('"tool.call"')) {
    try {
      const record = JSON.parse(line);
      const event = record?.event;
      if (event?.type !== 'tool.call' || event.toolCallId == null) return null;
      const time = Number(record.time);
      return {
        kind: 'toolCall',
        time: Number.isFinite(time) ? time : null,
        toolCallId: String(event.toolCallId)
      };
    } catch {
      return null;
    }
  }

  if (line.includes('"tool.result"')) {
    try {
      const record = JSON.parse(line);
      const event = record?.event;
      if (event?.type !== 'tool.result' || event.toolCallId == null) return null;
      const time = Number(record.time);
      return {
        kind: 'toolResult',
        time: Number.isFinite(time) ? time : null,
        toolCallId: String(event.toolCallId)
      };
    } catch {
      return null;
    }
  }

  if (line.includes('"turn.ended"')) {
    try {
      const record = JSON.parse(line);
      if (record?.type !== 'turn.ended') return null;
      return { kind: 'turnEnded', durationMs: Number(record.durationMs) || 0 };
    } catch {
      return null;
    }
  }

  // config.update 里带真实模型名（子代理 usage.record 常写占位符）
  if (line.includes('"config.update"') && line.includes('"modelAlias"')) {
    try {
      const alias = JSON.parse(line)?.modelAlias;
      return { kind: 'alias', alias: typeof alias === 'string' ? alias : '' };
    } catch {
      return null;
    }
  }

  return null;
}

function applyLine(summary, parsed) {
  if (!parsed) return;
  if (parsed.kind === 'usage') {
    const u = parsed.usage;
    summary.input += totalInputTokens(u);
    summary.output += u.output;
    summary.cacheRead += u.cacheRead;
    summary.cacheCreation += u.cacheCreation;
    if (parsed.model) summary.model = parsed.model;
    if (parsed.time != null) summary.lastAt = Math.max(summary.lastAt || 0, parsed.time);
  } else if (parsed.kind === 'step') {
    summary.steps += 1;
    if (parsed.turnId && summary.lastTurnId !== parsed.turnId) {
      summary.turns += 1;
      summary.lastTurnId = parsed.turnId;
    }
    summary.llmMs += parsed.ttftMs + parsed.streamMs;
    if (parsed.ttftMs > 0) {
      summary.ttftMs += parsed.ttftMs;
      summary.ttftSteps += 1;
    }
    if (parsed.serverTtftMs > 0) {
      summary.serverTtftMs += parsed.serverTtftMs;
      summary.serverTtftSteps += 1;
    }
    summary.recent.push({
      output: parsed.output,
      streamMs: parsed.streamMs,
      decodeMs: parsed.decodeMs,
      ttftMs: parsed.ttftMs,
      ts: parsed.time || 0
    });
    if (summary.recent.length > RECENT_CAP * 4) summary.recent.splice(0, summary.recent.length - RECENT_CAP * 4);
    if (parsed.time != null) summary.lastAt = Math.max(summary.lastAt || 0, parsed.time);
  } else if (parsed.kind === 'toolCall') {
    if (parsed.toolCallId) summary.pendingCalls[parsed.toolCallId] = parsed.time;
  } else if (parsed.kind === 'toolResult') {
    const callId = parsed.toolCallId;
    const startedAt = summary.pendingCalls[callId];
    if (startedAt != null && Number.isFinite(parsed.time)) {
      summary.toolMs += Math.max(0, parsed.time - startedAt);
      delete summary.pendingCalls[callId];
    }
  } else if (parsed.kind === 'turnEnded') {
    summary.pendingCalls = {};
    summary.turnMs += parsed.durationMs || 0;
  } else if (parsed.kind === 'alias' && parsed.alias) {
    summary.modelAlias = parsed.alias;
  }
}

function lastNewlineIndex(bytes) {
  for (let i = bytes.length - 1; i >= 0; i -= 1) {
    if (bytes[i] === 10) return i;
  }
  return -1;
}

function emptySummary() {
  return {
    size: 0,
    lastModified: 0,
    offset: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheCreation: 0,
    turns: 0,
    steps: 0,
    llmMs: 0,
    toolMs: 0,
    ttftMs: 0,
    ttftSteps: 0,
    serverTtftMs: 0,
    serverTtftSteps: 0,
    turnMs: 0,
    model: '',
    modelAlias: '',
    lastAt: null,
    lastTurnId: null,
    pendingCalls: {},
    recent: []
  };
}

function cloneSummary(source) {
  const next = emptySummary();
  for (const key of Object.keys(next)) {
    if (key === 'pendingCalls') continue;
    if (source?.[key] != null) next[key] = source[key];
  }
  next.recent = Array.isArray(source?.recent) ? source.recent.slice() : [];
  next.pendingCalls = source?.pendingCalls && typeof source.pendingCalls === 'object'
    ? { ...source.pendingCalls }
    : {};
  return next;
}

// 文件追加/替换的增量判据：仅“纯追加”才从旧 offset 续扫；否则回退 0 全量重扫。
function scanStartOffset(file, previous) {
  const offset = Number(previous?.offset);
  const scannedToOldEnd = Number.isFinite(offset) && offset >= 0 && offset === Number(previous.size);
  return scannedToOldEnd && offset < file.size ? offset : 0;
}

async function scanFile(fileHandle, previous) {
  const file = await fileHandle.getFile();
  const offset = scanStartOffset(file, previous);
  const canAppend = offset > 0;
  const summary = canAppend ? cloneSummary(previous) : emptySummary();

  let cursor = offset;
  while (cursor < file.size) {
    let end = Math.min(file.size, cursor + READ_CHUNK_BYTES);
    let bytes = new Uint8Array(await file.slice(cursor, end).arrayBuffer());
    let newline = lastNewlineIndex(bytes);

    // 单行可能大于块：向后扩展直到找到换行，避免把一条 JSON 拆开解析。
    while (newline < 0 && end < file.size) {
      end = Math.min(file.size, end + READ_CHUNK_BYTES);
      bytes = new Uint8Array(await file.slice(cursor, end).arrayBuffer());
      newline = lastNewlineIndex(bytes);
    }

    // 文件末尾尚未写完的行留到下次扫描，不推进 cursor。
    if (newline < 0) break;

    const complete = bytes.subarray(0, newline + 1);
    const text = new TextDecoder().decode(complete);
    for (const line of text.split('\n')) applyLine(summary, parseLine(line));
    cursor += newline + 1;
  }

  summary.size = file.size;
  summary.lastModified = file.lastModified;
  summary.offset = cursor;
  return summary;
}

async function resolveSessionsHandle(handle) {
  // 兼容授权 ~/.kimi-code 根目录，或直接授权其 sessions 子目录。
  if (handle?.name === '.kimi-code') {
    try {
      return await handle.getDirectoryHandle('sessions');
    } catch {
      return handle;
    }
  }
  return handle;
}

async function listWireFiles(sessionsHandle) {
  const files = [];
  for await (const [workspaceName, workspaceHandle] of sessionsHandle.entries()) {
    if (workspaceHandle.kind !== 'directory') continue;
    for await (const [sessionName, sessionHandle] of workspaceHandle.entries()) {
      if (sessionHandle.kind !== 'directory' || !sessionName.startsWith('session_')) continue;
      let agentsHandle;
      try {
        agentsHandle = await sessionHandle.getDirectoryHandle('agents');
      } catch {
        continue;
      }
      for await (const [agentName, agentHandle] of agentsHandle.entries()) {
        if (agentHandle.kind !== 'directory') continue;
        let wireHandle;
        try {
          wireHandle = await agentHandle.getFileHandle('wire.jsonl');
        } catch {
          continue;
        }
        files.push({
          path: `${workspaceName}/${sessionName}/agents/${agentName}/wire.jsonl`,
          handle: wireHandle,
          workspace: workspaceName,
          sessionId: sessionName,
          isSubagent: agentName !== 'main'
        });
      }
    }
  }
  return files;
}

async function readSessionMeta(sessionsHandle) {
  const meta = {};
  for await (const [, workspaceHandle] of sessionsHandle.entries()) {
    if (workspaceHandle.kind !== 'directory') continue;
    for await (const [sessionName, sessionHandle] of workspaceHandle.entries()) {
      if (sessionHandle.kind !== 'directory' || !sessionName.startsWith('session_')) continue;
      try {
        const stateHandle = await sessionHandle.getFileHandle('state.json');
        const text = await (await stateHandle.getFile()).text();
        const parsed = JSON.parse(text);
        meta[sessionName] = {
          title: typeof parsed.title === 'string' ? parsed.title : '',
          cwd: typeof parsed.cwd === 'string' ? parsed.cwd : ''
        };
      } catch {
        // state.json 缺失/损坏不影响用量解析。
      }
    }
  }
  return meta;
}

function buildSessions(filesMap, sessionMeta) {
  const sessions = {};
  for (const [, file] of filesMap) {
    const sessionId = file.sessionId;
    if (!sessionId) continue;
    let session = sessions[sessionId];
    if (!session) {
      session = sessions[sessionId] = {
        sessionId,
        workspace: file.workspace || '',
        title: sessionMeta[sessionId]?.title || null,
        cwd: sessionMeta[sessionId]?.cwd || '',
        model: '',
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheCreation: 0,
        turns: 0,
        steps: 0,
        llmMs: 0,
        toolMs: 0,
        ttftMs: 0,
        ttftSteps: 0,
        serverTtftMs: 0,
        serverTtftSteps: 0,
        turnMs: 0,
        lastAt: null,
        recent: []
      };
    }
    // token 用量属资源消耗：聚合所有 agent（main + 子 agent）。
    session.input += file.input;
    session.output += file.output;
    session.cacheRead += file.cacheRead;
    session.cacheCreation += file.cacheCreation;
    if (file.lastAt != null) session.lastAt = Math.max(session.lastAt || 0, file.lastAt);
    if (file.modelAlias) session.model = file.modelAlias;
    else if (file.model && !session.model) session.model = file.model;

    // 轮次/步数/模型耗时/工具耗时/首 token/TTFT，是“主对话”的 UX 形态，
    // 只用 main agent 的 wire 计算（子 agent 是独立 loop，避免污染会话步数）。
    if (!file.isSubagent) {
      session.turns += file.turns;
      session.steps += file.steps;
      session.llmMs += file.llmMs;
      session.toolMs += file.toolMs;
      session.ttftMs += file.ttftMs;
      session.ttftSteps += file.ttftSteps;
      session.serverTtftMs += file.serverTtftMs;
      session.serverTtftSteps += file.serverTtftSteps;
      session.turnMs += file.turnMs;
      session.recent.push(...file.recent);
    }
  }

  const views = Object.values(sessions).map((session) => finalizeSession(session));
  views.sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0));
  return {
    sessions: views.slice(0, SESSIONS_VIEW_LIMIT),
    counts: { sessionCount: views.length, fileCount: fileMapSize(filesMap) }
  };
}

function fileMapSize(map) {
  return typeof map.size === 'number' ? map.size : Object.keys(map).length;
}

function finalizeSession(session) {
  session.recent.sort((a, b) => (b.ts || 0) - (a.ts || 0));
  if (session.recent.length > RECENT_CAP) session.recent = session.recent.slice(0, RECENT_CAP);

  const input = session.input;
  const lastStep = session.recent[0] || null;
  return {
    sessionId: session.sessionId,
    workspace: session.workspace,
    title: session.title || shortSessionId(session.sessionId),
    model: session.model || '',
    input,
    output: session.output,
    cacheRead: session.cacheRead,
    cacheCreation: session.cacheCreation,
    cacheHitRate: input > 0 ? cacheHitRate({ inputOther: input - session.cacheRead - session.cacheCreation, cacheRead: session.cacheRead, cacheCreation: session.cacheCreation }) : null,
    totalTokens: input + session.output,
    turns: session.turns,
    steps: session.steps,
    llmMs: session.llmMs,
    toolMs: session.toolMs,
    avgTtftMs: session.ttftSteps > 0 ? Math.round(session.ttftMs / session.ttftSteps) : null,
    avgServerTtftMs: session.serverTtftSteps > 0 ? Math.round(session.serverTtftMs / session.serverTtftSteps) : null,
    avgTurnMs: session.turns > 0 ? Math.round(session.turnMs / session.turns) : null,
    streamTokPerSec: aggregateSpeed(session.recent, 'streamMs'),
    decodeTokPerSec: aggregateSpeed(session.recent, 'decodeMs'),
    lastTtftMs: lastStep ? lastStep.ttftMs : null,
    lastStreamMs: lastStep ? lastStep.streamMs : null,
    lastAt: session.lastAt
  };
}

function shortSessionId(id) {
  return String(id || '').replace(/^session_/, '').slice(0, 8);
}

// 对外统一的"扫一遍目录"：复用外部传入的 filesMap（Map），实现增量 offset。
export async function scanDirectory(handle, fileMap) {
  const rootHandle = await resolveSessionsHandle(handle);
  const sessionMeta = await readSessionMeta(rootHandle);
  const wireFiles = await listWireFiles(rootHandle);
  const counts = { sessionCount: 0, fileCount: wireFiles.length, changed: 0, failed: 0 };

  for (const entry of wireFiles) {
    let file;
    try {
      file = await entry.handle.getFile();
    } catch {
      counts.failed += 1;
      continue;
    }
    const previous = fileMap.get(entry.path);
    const unchanged = Boolean(
      previous &&
      Number(previous.size) === file.size &&
      Number(previous.lastModified) === file.lastModified &&
      Number(previous.offset) === file.size
    );
    if (unchanged) {
      continue;
    }
    try {
      const summary = await scanFile(entry.handle, previous);
      summary.workspace = entry.workspace;
      summary.sessionId = entry.sessionId;
      summary.isSubagent = entry.isSubagent;
      fileMap.set(entry.path, summary);
      counts.changed += 1;
    } catch {
      // 单文件失败（锁/权限抖动）跳过，不影响其它文件；下次轮询继续重试。
      counts.failed += 1;
    }
  }

  const { sessions, counts: builtCounts } = buildSessions(fileMap, sessionMeta);
  counts.sessionCount = builtCounts.sessionCount;
  return {
    sessions,
    active: sessions[0] || null,
    counts
  };
}

export { normalizeUsage, totalInputTokens, cacheHitRate };
export { applyLine, buildSessions, emptySummary };