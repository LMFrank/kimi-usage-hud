'use strict';

// 桌面客户端页面内的用量状态条。职责：跟随 SPA 当前会话，读客户端本地
// REST API（/api/v1/sessions/<sid>/transcript），交给 fold.js 折叠后渲染。
// 只访问客户端自己的本地服务：不读账号、不带凭据、不上传；与扩展版
// content.js 的差异是数据来自本地 API 而非 Native Messaging，且不使用 chrome.*。
//
// 时序：切会话时用 before_turn 自上而下补齐整会话（先渲染最新页，旧页后台逐页
// 补，边补边更新）；main 补完再对每个子 agent 分页补齐（20 页上限），之后每 2s
// 重拉 main 最新页（进行中的轮会被覆盖更新，fold.js 按 turnId/stepId 覆盖，不会
// 重复计数）、每 15s 重拉各子 agent 最新页；路由由 1s 轮询跟随。
//
// 用 transcript 而不是 messages 的原因见 fold.js 头部：只有 transcript 的
// step 带 usage 与 llmTiming（与 wire.jsonl 的 step.end 字段一致）。

import { formatPercentage, formatTokenCount } from '../src/metrics.js';
import { emptyFold, foldAgentTranscript, foldTranscript, summarizeFold } from './fold.js';

const ROUTE_POLL_MS = 1000;
const POLL_MS = 2000;
const SUBAGENT_REFRESH_MS = 15_000; // 子 agent 刷新节拍（只在跑动时才变，不必每 2s 拉）
const AGENT_ID = 'main';
// transcript 每页按「轮」计（服务端 paginateTurns 取 segments），page_size 上限 100。
// 回填：先拉最新一页立即渲染，再逐页向更早补，直到 has_more=false（main 上限 50 页、
// 子 agent 20 页，防呆）；轮询只重拉最新 2 轮，避免每 2s 搬整段会话（响应里带
// tool frame 的完整输入输出）。子 agent 按同样的页大小分页回填，token 取步骤 usage。
const BACKFILL_PAGE_SIZE = 20;
const BACKFILL_MAX_PAGES = 50;
const SUBAGENT_MAX_PAGES = 20;
const REFRESH_PAGE_SIZE = 2;
const SUBAGENT_REFRESH_PAGE_SIZE = 20;
const DEFAULT_TOP_PX = 8;
const VIEWS = ['full', 'key', 'mini'];
const VIEW_LABELS = { full: '全量显示', key: '关键值', mini: '完全缩小' };
const VIEW_GLYPH = { full: '▁', key: '≡', mini: '□' };
const FIELD_KEYS = ['model', 'turns', 'llm', 'ttft', 'ttftServer', 'turn', 'cache', 'tokens'];
const STORE_THEME = 'kuh.theme';
const STORE_VIEW = 'kuh.view';

// 展示格式化：百分比与 token 缩写复用 src/metrics.js，耗时按状态条一行排版。
const fmtPct = (value) => {
  const text = formatPercentage(value);
  return text == null ? '—' : `${text.replace(/\.0$/, '')}%`;
};
const sec1 = (ms) => (ms == null || !Number.isFinite(Number(ms)) ? '–' : `${(Number(ms) / 1000).toFixed(1)}s`);
const sec0 = (ms) => (ms == null || !Number.isFinite(Number(ms)) ? '–' : `${Math.round(Number(ms) / 1000)}s`);

let root = null;
let fieldsEl = null;
let themeBtn = null;
let collapseBtn = null;
let theme = 'light';
let viewIndex = 0;

let sessionId;
let generation = 0;
let state = emptyFold();
let rosterAgents = new Set(); // 当前会话的 agent roster（含 main）
let backfillDone = false;
let lastAgentRefreshAt = 0;
let status = { kind: 'loading', text: '读取中…' };

function readStored(key, fallback) {
  try {
    const value = localStorage.getItem(key);
    return value == null ? fallback : value;
  } catch (e) {
    return fallback;
  }
}

function writeStored(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch (e) {
    /* 存不了只影响记忆，不影响当前会话渲染 */
  }
}

function applyTheme(next) {
  theme = next === 'dark' ? 'dark' : 'light';
  if (root) root.setAttribute('data-theme', theme);
  if (themeBtn) themeBtn.textContent = theme === 'dark' ? '☀' : '☾';
  writeStored(STORE_THEME, theme);
}

function applyView(index) {
  viewIndex = index;
  const view = VIEWS[index];
  if (root) root.setAttribute('data-view', view);
  if (collapseBtn) {
    collapseBtn.textContent = VIEW_GLYPH[view];
    collapseBtn.title = `显示档位：${VIEW_LABELS[view]}（点击切换）`;
  }
  writeStored(STORE_VIEW, view);
}

// kimi 客户端是 SPA，切会话只改 URL path 为 /sessions/<id>，据此跟随当前会话。
function currentSessionFromUrl() {
  const m = location.pathname.match(/\/sessions\/([^/?#]+)/);
  return m ? m[1] : null;
}

function renderFields(values) {
  for (const key of FIELD_KEYS) {
    const el = fieldsEl && fieldsEl.querySelector(`[data-k="${key}"]`);
    if (el) el.textContent = values[key] || '';
  }
}

function renderSession(session) {
  const turns = `${session.turns || 0} 轮 · ${session.steps || 0} 步`;
  renderFields({
    model: session.model ? `· ${session.model}` : '',
    turns,
    llm: `| LLM ${sec1(session.llmMs)} · 工具 ${sec0(session.toolMs)}`,
    ttft: `| 首 token ${sec1(session.avgTtftMs)} · ${session.streamTokPerSec != null ? session.streamTokPerSec : '–'} tok/s`,
    ttftServer: `| TTFT 客户端 ${sec1(session.avgTtftMs)} · 服务端 ${sec1(session.avgServerTtftMs)}`,
    turn: `| 均轮 ${sec0(session.avgTurnMs)}`,
    cache: `| 缓存 ${fmtPct(session.cacheHitRate)}`,
    tokens: `| 输入 ${formatTokenCount(session.input)} tok · 输出 ${formatTokenCount(session.output)} tok · TPS ${session.decodeTokPerSec != null ? session.decodeTokPerSec : '–'} tok/s`
  });
  if (root) {
    const agents = session.agentCount > 0 ? ` · 子 agent ${session.agentCount}` : '';
    root.title = `${session.turns || 0} 轮 · ${session.steps || 0} 步${agents} · TTFT ${session.lastTtftMs != null ? `${session.lastTtftMs}ms` : '—'}`;
  }
}

// 状态文案写进 turns 位（全量/关键值两档可见）：无会话、读取失败、无数据都不静默。
function paint() {
  if (!root) return;
  root.setAttribute('data-state', status.kind);
  if (status.text) {
    renderFields({ turns: status.text });
    root.title = status.text;
    return;
  }
  renderSession(summarizeFold(state));
}

function refresh() {
  const summary = summarizeFold(state);
  if (summary.turnCount === 0) status = { kind: 'loading', text: '无数据' };
  else if (summary.timingSteps === 0) status = { kind: 'ok', text: `${summary.turnCount} 轮 · 无耗时元数据` };
  else status = { kind: 'ok', text: '' };
  paint();
}

async function fetchTranscript(sid, params) {
  const query = new URLSearchParams({
    agent_id: params.agentId || AGENT_ID,
    page_size: String(params.pageSize)
  });
  if (params.beforeTurn) query.set('before_turn', params.beforeTurn);
  const base = window.__kuhKapOrigin || location.origin;
  const response = await fetch(`${base}/api/v1/sessions/${encodeURIComponent(sid)}/transcript?${query}`, {
    cache: 'no-store'
  });
  if (!response.ok) throw new Error(`读取失败(${response.status})`);
  const payload = await response.json();
  if (payload?.code !== 0) throw new Error(`读取失败(${payload?.code ?? '未知'})`);
  const data = payload.data;
  if (!data || !Array.isArray(data.items)) throw new Error('读取失败(响应无 items)');
  return { data, hasMore: data.has_more === true };
}

// 子 agent 的一页 transcript 折叠进它自己的状态（轮/步只读 main，token 取步骤 usage）。
function collectRoster(data) {
  for (const agent of Array.isArray(data?.agents) ? data.agents : []) {
    if (typeof agent?.agentId === 'string' && agent.agentId) rosterAgents.add(agent.agentId);
  }
}

// 子 agent 首次出现时补齐它的整段历史：page_size=20，before_turn 翻页到
// has_more=false 或 20 页上限；每折一页重绘一次，token 随着补齐增长。
async function backfillAgent(sid, agentId, gen) {
  let beforeTurn = '';
  for (let page = 0; page < SUBAGENT_MAX_PAGES; page += 1) {
    const { data, hasMore } = await fetchTranscript(sid, {
      agentId,
      pageSize: BACKFILL_PAGE_SIZE,
      beforeTurn
    });
    if (gen !== generation) return;
    const turns = data.items.filter((item) => item?.kind === 'turn');
    if (turns.length === 0) return;
    foldAgentTranscript(state, agentId, data);
    refresh();
    const oldest = turns[0].turnId;
    if (!hasMore || !oldest || oldest === beforeTurn) return;
    beforeTurn = oldest;
  }
}

// 15s 刷新：每个子 agent 只重拉最新一页（进行中的轮整轮覆盖），不翻旧页。
async function refreshAgents(sid, gen) {
  const roster = [...rosterAgents].filter((id) => id !== AGENT_ID);
  if (roster.length === 0) return;
  const results = await Promise.all(roster.map(async (agentId) => {
    try {
      const { data } = await fetchTranscript(sid, { agentId, pageSize: SUBAGENT_REFRESH_PAGE_SIZE });
      return { agentId, data };
    } catch (error) {
      return { agentId, data: null };
    }
  }));
  if (gen !== generation) return;
  for (const { agentId, data } of results) if (data) foldAgentTranscript(state, agentId, data);
}

// 回填：不带游标的一页是「最新若干轮」（升序），先折先渲染，再用最旧一轮的
// turnId 作 before_turn 逐页向更早补齐，直到 has_more=false 或到达页数上限；
// 每页折完立刻重绘，所以整会话数字是边补边长出来的。
async function backfill(sid, gen) {
  let beforeTurn = '';
  for (let page = 0; page < BACKFILL_MAX_PAGES; page += 1) {
    const { data, hasMore } = await fetchTranscript(sid, { pageSize: BACKFILL_PAGE_SIZE, beforeTurn });
    if (gen !== generation) return;
    const turns = data.items.filter((item) => item?.kind === 'turn');
    if (turns.length === 0) return;
    foldTranscript(state, data);
    collectRoster(data); // roster 随任一页返回，用于后续子 agent 回填/刷新
    backfillDone = true; // 已有最新页，可以开始轮询
    refresh();
    const oldest = turns[0].turnId;
    if (!hasMore || !oldest || oldest === beforeTurn) return;
    beforeTurn = oldest;
  }
}

// 按 roster 补齐所有子 agent 的历史（main 回填完成后调用）。
async function backfillAgents(sid, gen) {
  for (const agentId of [...rosterAgents]) {
    if (agentId === AGENT_ID) continue;
    await backfillAgent(sid, agentId, gen);
    if (gen !== generation) return;
  }
}

// 增量：每轮重拉最新一页（进行中的轮会被整轮覆盖更新），没有游标状态；
// 子 agent 按更慢的节拍重拉各自最新一页。
async function poll() {
  if (!sessionId || !backfillDone) return;
  const gen = generation;
  try {
    const { data } = await fetchTranscript(sessionId, { pageSize: REFRESH_PAGE_SIZE });
    if (gen !== generation) return;
    foldTranscript(state, data);
    collectRoster(data);
    const now = Date.now();
    if (now - lastAgentRefreshAt >= SUBAGENT_REFRESH_MS) {
      lastAgentRefreshAt = now;
      await refreshAgents(sessionId, gen);
      if (gen !== generation) return;
    }
  } catch (error) {
    if (gen !== generation) return;
    status = { kind: 'error', text: error.message };
    paint();
    return;
  }
  refresh();
}

async function switchSession(nextId) {
  sessionId = nextId;
  generation += 1;
  const gen = generation;
  state = emptyFold();
  rosterAgents = new Set();
  backfillDone = false;
  lastAgentRefreshAt = 0;

  if (!nextId) {
    status = { kind: 'loading', text: '无会话' };
    paint();
    return;
  }

  status = { kind: 'loading', text: '读取中…' };
  paint();
  try {
    await backfill(nextId, gen);
    if (gen !== generation) return;
    await backfillAgents(nextId, gen);
    if (gen !== generation) return;
    lastAgentRefreshAt = Date.now(); // 子 agent 刚补完，下一次 15s 刷新不用立刻重拉
  } catch (error) {
    if (gen !== generation) return;
    status = { kind: 'error', text: error.message };
    paint();
    return;
  }
  backfillDone = true;
  refresh();
}

function mount() {
  if (document.getElementById('kimi-usage-hud')) return;
  root = document.createElement('section');
  root.id = 'kimi-usage-hud';
  root.setAttribute('data-state', status.kind);
  root.innerHTML = `
    <div class="kuh-bar" role="status" aria-live="polite">
      <button class="kuh-drag" type="button" aria-label="拖动状态条" title="拖动调整位置">⋮⋮</button>
      <span class="kuh-fields">
        <span class="kuh-field kuh-detail" data-k="model"></span>
        <span class="kuh-field" data-k="turns"></span>
        <span class="kuh-field kuh-detail" data-k="llm"></span>
        <span class="kuh-field kuh-detail" data-k="ttft"></span>
        <span class="kuh-field" data-k="ttftServer"></span>
        <span class="kuh-field" data-k="turn"></span>
        <span class="kuh-field" data-k="cache"></span>
        <span class="kuh-field" data-k="tokens"></span>
      </span>
      <button class="kuh-theme" type="button" aria-label="切换明暗主题" title="切换明暗主题">☾</button>
      <button class="kuh-collapse" type="button" aria-label="切换显示档位" title="全量显示 / 只显示关键值 / 完全缩小">▣</button>
    </div>`;

  (document.body || document.documentElement).appendChild(root);

  fieldsEl = root.querySelector('.kuh-fields');
  themeBtn = root.querySelector('.kuh-theme');
  collapseBtn = root.querySelector('.kuh-collapse');
  const dragBtn = root.querySelector('.kuh-drag');

  if (themeBtn) {
    themeBtn.addEventListener('click', () => {
      applyTheme(theme === 'dark' ? 'light' : 'dark');
    });
  }

  if (collapseBtn) {
    collapseBtn.addEventListener('click', () => {
      applyView((viewIndex + 1) % VIEWS.length);
    });
  }

  if (dragBtn) {
    let dragging = false;
    let startY = 0;
    let startTop = DEFAULT_TOP_PX;
    dragBtn.addEventListener('pointerdown', (event) => {
      dragging = true;
      startY = event.clientY;
      startTop = parseFloat(getComputedStyle(root).getPropertyValue('--kuh-top')) || DEFAULT_TOP_PX;
      dragBtn.setPointerCapture(event.pointerId);
      event.preventDefault();
    });
    dragBtn.addEventListener('pointermove', (event) => {
      if (!dragging) return;
      const dy = startY - event.clientY; // 向上拖 dy>0 → top 减小
      root.style.setProperty('--kuh-top', `${Math.max(0, startTop - dy)}px`);
    });
    dragBtn.addEventListener('pointerup', () => {
      dragging = false;
    });
    dragBtn.addEventListener('pointercancel', () => {
      dragging = false;
    });
  }

  applyTheme(theme);
  applyView(viewIndex);
  paint();
}

// 主题与档位存 localStorage（kuh.*），换会话只重置折叠状态、不动显示偏好。
theme = readStored(STORE_THEME, 'light') === 'dark' ? 'dark' : 'light';
viewIndex = Math.max(0, VIEWS.indexOf(readStored(STORE_VIEW, 'full')));

window.__kuhRemount = mount;
mount();

function tick() {
  const sid = currentSessionFromUrl();
  if (sid !== sessionId) switchSession(sid);
}

tick();
setInterval(tick, ROUTE_POLL_MS);
setInterval(poll, POLL_MS);
