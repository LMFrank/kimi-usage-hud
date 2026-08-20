#!/usr/bin/env node
'use strict';

// Kimi Code Usage HUD —— Native Messaging host。
// 改成「懒折叠」：首屏只 fold 当前活跃 session，切到哪个 session 再按需 fold 哪个。
// - 会话列表来自 ~/.kimi-code/session_index.json（kimi 自维护的追加索引），倒序即“最新优先”。
// - 默认 active = 列表第一条；消息带 sessionId 时 fold 指定 session。
// 协议：chrome.runtime.sendNativeMessage 的 stdin/stdout，4 字节小端长度 + JSON。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

import {
  applyLine,
  buildSessions,
  emptySummary,
  parseLine
} from '../src/cli-reader.js';

const HOST_NAME = 'com.kimi.usage.hud';

function kimiHome() {
  return process.env.KIMI_CODE_HOME || path.join(os.homedir(), '.kimi-code');
}

function sessionsRoot() {
  return path.join(kimiHome(), 'sessions');
}

function sessionIndexPath() {
  return path.join(kimiHome(), 'session_index.jsonl');
}

function shortSessionId(id) {
  return String(id || '').replace(/^session_/, '').slice(0, 8);
}

function mtimeMs(dir) {
  try {
    return fs.statSync(dir).mtimeMs;
  } catch {
    return 0;
  }
}

// 活跃度看日志文件而非目录：目录 mtime 只在增删条目时变，日志文件随每步写入更新。
function activityMs(sessionDir) {
  if (!sessionDir) return 0;
  const wire = path.join(sessionDir, 'agents', 'main', 'wire.jsonl');
  const t = mtimeMs(wire);
  if (t > 0) return t;
  return mtimeMs(sessionDir);
}

function readTitle(sessionDir, workDir, id) {
  try {
    const state = JSON.parse(fs.readFileSync(path.join(sessionDir, 'state.json'), 'utf8'));
    if (typeof state.title === 'string' && state.title) return state.title;
  } catch {
    // state.json 缺失不阻断列表。
  }
  if (typeof workDir === 'string' && workDir) {
    const base = path.basename(workDir);
    if (base) return base;
  }
  return shortSessionId(id);
}

// 会话列表：优先 session_index.json（倒序去重 = 最新优先）；缺失时扫描目录按 mtime 排序。
function listSessions() {
  const seen = new Set();
  const out = [];
  const indexPath = sessionIndexPath();

  if (fs.existsSync(indexPath)) {
    const lines = fs.readFileSync(indexPath, 'utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = lines[i];
      if (!line) continue;
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      const id = record?.sessionId;
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const sessionDir = typeof record.sessionDir === 'string' && record.sessionDir
        ? record.sessionDir
        : null;
      out.push({
        sessionId: id,
        sessionDir,
        workDir: typeof record.workDir === 'string' ? record.workDir : '',
        title: readTitle(sessionDir, record.workDir, id),
        mtime: activityMs(sessionDir)
      });
    }
    if (out.length > 0) {
      out.sort((a, b) => b.mtime - a.mtime);
      return out;
    }
  }

  // 兜底：session_index.json 缺失时，扫 sessions 目录，按最新目录 mtime 在前。
  const root = sessionsRoot();
  if (fs.existsSync(root)) {
    for (const workspace of fs.readdirSync(root, { withFileTypes: true })) {
      if (!workspace.isDirectory()) continue;
      const workspaceDir = path.join(root, workspace.name);
      for (const session of fs.readdirSync(workspaceDir, { withFileTypes: true })) {
        if (!session.isDirectory() || !session.name.startsWith('session_')) continue;
        const id = session.name;
        if (seen.has(id)) continue;
        seen.add(id);
        const sessionDir = path.join(workspaceDir, id);
        out.push({
          sessionId: id,
          sessionDir,
          workDir: '',
          title: readTitle(sessionDir, '', id),
          mtime: activityMs(sessionDir)
        });
      }
    }
    out.sort((a, b) => b.mtime - a.mtime);
  }

  return out;
}

// 只 fold 一个 session：main + 子 agent 的 wire.jsonl。
// 轮/步/模型耗时/工具耗时/首 token 只从 main 算；token 用量聚合所有 agent（buildSessions 内部已按 isSubagent 分流）。
function foldOneSession(session) {
  if (!session?.sessionDir || !fs.existsSync(session.sessionDir)) return null;

  const fileMap = new Map();
  const agentsDir = path.join(session.sessionDir, 'agents');
  let agents = [];
  try {
    agents = fs.readdirSync(agentsDir, { withFileTypes: true });
  } catch {
    agents = [];
  }

  for (const agent of agents) {
    if (!agent.isDirectory()) continue;
    const wirePath = path.join(agentsDir, agent.name, 'wire.jsonl');
    if (!fs.existsSync(wirePath)) continue;

    const summary = emptySummary();
    summary.workspace = path.basename(path.dirname(session.sessionDir));
    summary.sessionId = session.sessionId;
    summary.isSubagent = agent.name !== 'main';

    const text = fs.readFileSync(wirePath, 'utf8');
    for (const line of text.split('\n')) {
      const parsed = parseLine(line);
      if (parsed) applyLine(summary, parsed);
    }
    fileMap.set(`${summary.workspace}/${session.sessionId}/agents/${agent.name}/wire.jsonl`, summary);
  }

  const meta = {
    [session.sessionId]: {
      title: session.title || null,
      cwd: session.workDir || ''
    }
  };
  const { sessions } = buildSessions(fileMap, meta);
  return sessions[0] || null;
}

function getMetrics(sessionId) {
  const list = listSessions();
  const target = list.find((s) => s.sessionId === sessionId) || list[0] || null;
  const active = target ? foldOneSession(target) : null;

  return {
    // 下拉只给元数据，不 fold 历史会话（fold 是切到才做）。
    sessions: list
      .map((s) => ({ sessionId: s.sessionId, title: s.title, cwd: s.workDir || s.sessionDir || '' }))
      .slice(0, 100),
    active,
    counts: { sessionCount: list.length }
  };
}

function sendMessage(object) {
  const payload = Buffer.from(JSON.stringify({ ...object, host: HOST_NAME }), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(payload.length, 0);
  process.stdout.write(Buffer.concat([header, payload]));
}

const send = sendMessage;

function handleMessage(raw) {
  let message;
  try {
    message = JSON.parse(raw);
  } catch {
    send({ ok: false, error: 'bad-json-payload' });
    return;
  }

  if (message?.type === 'ping') {
    send({ ok: true, pong: true });
    return;
  }
  if (message?.type === 'metrics') {
    try {
      send({ ok: true, ...getMetrics(message.sessionId || null) });
    } catch (error) {
      send({ ok: false, error: String(error?.message || error) });
    }
    return;
  }
  send({ ok: false, error: 'unknown-message-type' });
}

// stdin 分帧循环：4 字节小端长度 + JSON，处理后立即写回，级联消息对。
let buffer = Buffer.alloc(0);
process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    if (buffer.length < 4) break;
    const length = buffer.readUInt32LE(0);
    if (length < 0 || length > 64 * 1024 * 1024) {
      send({ ok: false, error: 'invalid-frame-length' });
      buffer = Buffer.alloc(0);
      break;
    }
    if (buffer.length < 4 + length) break;
    const payload = buffer.subarray(4, 4 + length).toString('utf8');
    buffer = buffer.subarray(4 + length);
    handleMessage(payload);
  }
});

process.stdin.on('end', () => {
  process.exit(0);
});
process.stdin.on('error', () => {
  process.exit(0);
});