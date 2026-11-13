'use strict';

// 桌面客户端页面内的用量状态条。职责：跟随 SPA 当前会话，读客户端本地
// REST API（1.3.5 的 agents/<agent_id>/turns），交给 fold.js 折叠后渲染。
// 只访问客户端自己的本地服务；按页面自身方式读取本地 API Bearer，不上传、不输出。
// 与扩展版 content.js 的差异是数据来自本地 API 而非 Native Messaging，不使用 chrome.*。
//
// 时序：切会话时用 before_ordinal 自上而下补齐整会话（先渲染最新页，旧页后台逐页
// 补，边补边更新）；main 补完再对已发现的子 agent 分页补齐（20 页上限），之后每 2s
// 重拉 main 最新页并刷新模型名（进行中的轮按轮/步 id 覆盖，不重复计数）、每 15s
// 重拉各子 agent 最新页；路由由 1s 轮询跟随，初次加载失败在原会话自动重试。
//
// turns 的 step 带 usage 与 timing（字段口径见 fold.js）。新版 roster 通过客户端
// 同一 /api/v1/ws 的 subscribe → task.list/task 契约发现；WS 只发现 agent，不读用量。

const MODULE_QUERY = new URL(import.meta.url).search;

// loader 只给 hud-app 改版本参数；静态子模块 URL 会忽略该参数并复用旧 ES module。
// 把 hash 同时透传到 metrics/fold/reader，保证 reload 后实际执行的是同一载荷版本。
const [
  { formatPercentage, formatTokenCount },
  { emptyFold, foldAgentTranscript, foldTranscript, summarizeFold },
  { fetchDesktopPage, fetchDesktopSessionModel, watchDesktopAgents }
] = await Promise.all([
  import(new URL('../src/metrics.js' + MODULE_QUERY, import.meta.url)),
  import(new URL('./fold.js' + MODULE_QUERY, import.meta.url)),
  import(new URL('./reader.js' + MODULE_QUERY, import.meta.url))
]);

const ROUTE_POLL_MS = 1000;
const POLL_MS = 2000;
const SUBAGENT_REFRESH_MS = 15_000; // 子 agent 刷新节拍（只在跑动时才变，不必每 2s 拉）
const AGENT_ID = 'main';
// turns/transcript 每页按「轮」计，page_size 上限 100。
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
let agentBackfills = new Map(); // agentId → 历史回填 Promise；避免 WS 与轮询重复回填
let stopRosterWatch = null;
let backfillDone = false;
let switchInFlight = false;
let activeSwitch = null;
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
  const approximate = session.approximateTiming ? '≈' : '';
  renderFields({
    model: session.model ? `· ${session.model}` : '',
    turns,
    llm: `| LLM ${approximate}${sec1(session.llmMs)} · 工具 ${sec0(session.toolMs)}`,
    ttft: `| 首 token ${approximate}${sec1(session.avgTtftMs)} · ${approximate}${session.streamTokPerSec != null ? session.streamTokPerSec : '–'} tok/s`,
    ttftServer: `| TTFT 客户端 ${approximate}${sec1(session.avgTtftMs)} · 服务端 ${sec1(session.avgServerTtftMs)}`,
    turn: `| 均轮 ${sec0(session.avgTurnMs)}`,
    cache: `| 缓存 ${fmtPct(session.cacheHitRate)}`,
    tokens: `| 输入 ${formatTokenCount(session.input)} tok · 输出 ${formatTokenCount(session.output)} tok · TPS ${approximate}${session.decodeTokPerSec != null ? session.decodeTokPerSec : '–'} tok/s`
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

function readerOptions() {
  return { origin: window.__kuhKapOrigin || location.origin };
}

async function fetchTranscript(sid, params) {
  return fetchDesktopPage(sid, params, readerOptions());
}

function pageTurns(data) {
  if (Array.isArray(data?.turns)) return data.turns;
  return (Array.isArray(data?.items) ? data.items : []).filter((item) => item?.kind === 'turn');
}

// task.list 只报告活动任务；已完成 agent 还需从 main turns 的实际
// Task/Agent tool item 的 agent_refs 发现，沿用同一轮询复用历史回填 Promise。
function collectRoster(data) {
  for (const agent of Array.isArray(data?.agents) ? data.agents : []) {
    if (typeof agent?.agentId === 'string' && agent.agentId) rosterAgents.add(agent.agentId);
  }
  for (const turn of Array.isArray(data?.turns) ? data.turns : []) {
    for (const item of Array.isArray(turn.items) ? turn.items : []) {
      if (item?.type !== 'tool_call' || !Array.isArray(item.agent_refs)) continue;
      for (const ref of item.agent_refs) {
        if (typeof ref?.agent_id === 'string' && ref.agent_id) discoverAgent(sessionId, ref.agent_id, generation);
      }
    }
  }
}

// 子 agent 首次出现时补齐它的整段历史：page_size=20，按接口游标翻页到
// has_more=false 或 20 页上限；每折一页重绘一次，token 随着补齐增长。
async function backfillAgent(sid, agentId, gen) {
  let beforeOrdinal = '';
  let beforeTurn = '';
  for (let page = 0; page < SUBAGENT_MAX_PAGES; page += 1) {
    const { data, hasMore } = await fetchTranscript(sid, {
      agentId,
      pageSize: BACKFILL_PAGE_SIZE,
      beforeOrdinal,
      beforeTurn
    });
    if (gen !== generation) return;
    const turns = pageTurns(data);
    if (turns.length === 0) return false;
    foldAgentTranscript(state, agentId, data);
    refresh();
    const isTurns = Array.isArray(data.turns);
    const oldest = isTurns ? turns[0]?.ordinal : turns[0]?.turnId;
    if (!hasMore || oldest == null || oldest === '' || oldest === (isTurns ? beforeOrdinal : beforeTurn)) return true;
    beforeOrdinal = isTurns ? oldest : '';
    beforeTurn = isTurns ? '' : oldest;
  }
  return true;
}

function ensureAgentBackfill(sid, agentId, gen) {
  if (agentId === AGENT_ID || gen !== generation) return Promise.resolve(true);
  const backfills = agentBackfills;
  if (backfills.has(agentId)) return backfills.get(agentId);
  const pending = backfillAgent(sid, agentId, gen).then((filled) => {
    if (!filled) backfills.delete(agentId);
    return filled;
  }, (error) => {
    backfills.delete(agentId);
    throw error;
  });
  backfills.set(agentId, pending);
  return pending;
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
// ordinal（新版）或 turnId（旧版）逐页向更早补齐，直到 has_more=false 或到达页数上限；
// 每页折完立刻重绘，所以整会话数字是边补边长出来的。
async function backfill(sid, gen) {
  let beforeOrdinal = '';
  let beforeTurn = '';
  for (let page = 0; page < BACKFILL_MAX_PAGES; page += 1) {
    const { data, hasMore } = await fetchTranscript(sid, { pageSize: BACKFILL_PAGE_SIZE, beforeOrdinal, beforeTurn });
    if (gen !== generation) return;
    const turns = pageTurns(data);
    if (turns.length === 0) return;
    foldTranscript(state, data);
    collectRoster(data); // 旧 transcript 的 roster 用于子 agent 回填/刷新
    backfillDone = true; // 已有最新页，可以开始轮询
    refresh();
    const isTurns = Array.isArray(data.turns);
    const oldest = isTurns ? turns[0]?.ordinal : turns[0]?.turnId;
    if (!hasMore || oldest == null || oldest === '' || oldest === (isTurns ? beforeOrdinal : beforeTurn)) return;
    beforeOrdinal = isTurns ? oldest : '';
    beforeTurn = isTurns ? '' : oldest;
  }
}

// 按 roster 补齐所有子 agent 的历史；已由 WS 触发的回填复用同一 Promise。
async function backfillAgents(sid, gen) {
  for (const agentId of [...rosterAgents]) {
    if (agentId === AGENT_ID) continue;
    await ensureAgentBackfill(sid, agentId, gen);
    if (gen !== generation) return;
  }
}

function discoverAgent(sid, agentId, gen) {
  if (gen !== generation) return;
  rosterAgents.add(agentId);
  if (!backfillDone) return;
  ensureAgentBackfill(sid, agentId, gen).catch((error) => {
    if (gen !== generation) return;
    status = { kind: 'error', text: error.message };
    paint();
  });
}

// 增量：每轮重拉最新一页（进行中的轮会被整轮覆盖更新），没有游标状态；
// 子 agent 按更慢的节拍重拉各自最新一页。
async function poll() {
  if (!sessionId || !backfillDone) return;
  const gen = generation;
  try {
    const [{ data }, model] = await Promise.all([
      fetchTranscript(sessionId, { pageSize: REFRESH_PAGE_SIZE }),
      fetchDesktopSessionModel(sessionId, readerOptions())
    ]);
    if (gen !== generation) return;
    state.model = model;
    foldTranscript(state, data);
    collectRoster(data);
    const now = Date.now();
    if (now - lastAgentRefreshAt >= SUBAGENT_REFRESH_MS) {
      lastAgentRefreshAt = now;
      await backfillAgents(sessionId, gen);
      if (gen !== generation) return;
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
  switchInFlight = true;
  if (stopRosterWatch) stopRosterWatch();
  stopRosterWatch = null;
  state = emptyFold();
  rosterAgents = new Set();
  agentBackfills = new Map();
  backfillDone = false;
  lastAgentRefreshAt = 0;

  try {
    if (!nextId) {
      status = { kind: 'loading', text: '无会话' };
      paint();
      return;
    }

    status = { kind: 'loading', text: '读取中…' };
    paint();
    stopRosterWatch = watchDesktopAgents(nextId, readerOptions(), (agentId) => {
      discoverAgent(nextId, agentId, gen);
    });
    state.model = await fetchDesktopSessionModel(nextId, readerOptions());
    if (gen !== generation) return;
    await backfill(nextId, gen);
    if (gen !== generation) return;
    await backfillAgents(nextId, gen);
    if (gen !== generation) return;
    lastAgentRefreshAt = Date.now(); // 子 agent 刚补完，下一次 15s 刷新不用立刻重拉
    backfillDone = true;
    refresh();
  } catch (error) {
    if (gen !== generation) return;
    backfillDone = false;
    status = { kind: 'error', text: error.message };
    paint();
  } finally {
    if (gen === generation) switchInFlight = false;
  }
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
  if (sid !== sessionId || (sid && !backfillDone && !switchInFlight)) activeSwitch = switchSession(sid);
  return activeSwitch;
}

tick();
setInterval(tick, ROUTE_POLL_MS);
setInterval(poll, POLL_MS);
