#!/usr/bin/env node
/**
 * 桌面面板对照工具：按扩展版（wire.jsonl）口径把某个会话折出来，打印成状态条
 * 同一行字段，用于和客户端里的面板数字逐项对照。
 *
 *   node desktop/verify.mjs [sessionId]      # 省略 id 时取最近改动的会话
 *
 * 折叠逻辑直接复用 src/cli-reader.js（轮/步/耗时只算 main，token 聚合所有
 * agent），口径与浏览器扩展完全一致；本文件只负责找会话、跑折叠、排版输出。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyLine, buildSessions, emptySummary, parseLine } from '../src/cli-reader.js';

const sessionsRoot = path.join(os.homedir(), '.kimi-code', 'sessions');

function listSessions() {
  const found = [];
  for (const workspace of fs.readdirSync(sessionsRoot)) {
    const wsDir = path.join(sessionsRoot, workspace);
    if (!fs.statSync(wsDir).isDirectory()) continue;
    for (const name of fs.readdirSync(wsDir)) {
      if (!name.startsWith('session_')) continue;
      const dir = path.join(wsDir, name);
      found.push({ sessionId: name, workspace, dir, mtime: fs.statSync(dir).mtimeMs });
    }
  }
  return found.sort((a, b) => b.mtime - a.mtime);
}

function foldSession(session) {
  const filesMap = new Map();
  const agentsDir = path.join(session.dir, 'agents');
  for (const agent of fs.readdirSync(agentsDir)) {
    const wire = path.join(agentsDir, agent, 'wire.jsonl');
    if (!fs.existsSync(wire)) continue;
    const summary = emptySummary();
    for (const line of fs.readFileSync(wire, 'utf8').split('\n')) applyLine(summary, parseLine(line));
    summary.workspace = session.workspace;
    summary.sessionId = session.sessionId;
    summary.isSubagent = agent !== 'main';
    filesMap.set(`${session.sessionId}/${agent}`, summary);
  }
  const meta = {};
  try {
    const state = JSON.parse(fs.readFileSync(path.join(session.dir, 'state.json'), 'utf8'));
    meta[session.sessionId] = { title: state.title, cwd: state.cwd };
  } catch {
    // state.json 缺失不影响用量折叠
  }
  return buildSessions(filesMap, meta).sessions[0] ?? null;
}

const wanted = process.argv[2];
const sessions = listSessions();
const target = wanted ? sessions.find((s) => s.sessionId === wanted) : sessions[0];
if (!target) {
  console.error(wanted ? `找不到会话 ${wanted}` : `在 ${sessionsRoot} 下没有找到会话`);
  process.exit(1);
}

const view = foldSession(target);
if (!view) {
  console.error(`${target.sessionId} 没有可折叠的 wire.jsonl`);
  process.exit(1);
}

const sec1 = (ms) => (ms == null ? '–' : `${(ms / 1000).toFixed(1)}s`);
const sec0 = (ms) => (ms == null ? '–' : `${Math.round(ms / 1000)}s`);
const pct = (v) => (v == null ? '—' : `${Math.floor(v * 10 + 1e-6) / 10}%`);
const tok = (v) => (v >= 1e6 ? `${(v / 1e6).toFixed(1).replace(/\.0$/, '')}M` : v >= 1e3 ? `${(v / 1e3).toFixed(1).replace(/\.0$/, '')}k` : String(v));

console.log(`${target.sessionId}  ${view.title || ''}`);
console.log(`  ${view.turns} 轮 · ${view.steps} 步`);
console.log(`  | LLM ${sec1(view.llmMs)} · 工具 ${sec0(view.toolMs)}`);
console.log(`  | 首 token ${sec1(view.avgTtftMs)} · ${view.streamTokPerSec ?? '–'} tok/s`);
console.log(`  | TTFT 客户端 ${sec1(view.avgTtftMs)} · 服务端 ${sec1(view.avgServerTtftMs)}`);
console.log(`  | 均轮 ${sec0(view.avgTurnMs)}`);
console.log(`  | 缓存 ${pct(view.cacheHitRate)}`);
console.log(`  | 输入 ${tok(view.input)} tok · 输出 ${tok(view.output)} tok · TPS ${view.decodeTokPerSec ?? '–'} tok/s`);
console.log(`  文件：${target.dir}`);
