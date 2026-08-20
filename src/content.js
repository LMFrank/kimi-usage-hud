(() => {
  'use strict';
  if (window.__kimiUsageHudInjected) return;
  window.__kimiUsageHudInjected = true;

  const POLL_MS = 2000;
  const DEFAULT_TOP_PX = 8;
  const VIEWS = ['full', 'key', 'mini'];
  const VIEW_LABELS = { full: '全量显示', key: '关键值', mini: '完全缩小' };
  const VIEW_GLYPH = { full: '▁', key: '≡', mini: '□' };

  // 轻量格式化（content script 无法 import，这里自备）
  const fmtTok = (v) => {
    const n = Number(v) || 0;
    if (n >= 1e6) return `${(n / 1e6).toFixed(1).replace(/\.0$/, '')}M`;
    if (n >= 1e3) return `${(n / 1e3).toFixed(1).replace(/\.0$/, '')}k`;
    return String(n);
  };
  const fmtPct = (v) => {
    if (v == null || Number.isNaN(Number(v))) return '—';
    const n = Math.max(0, Math.min(100, Number(v)));
    return `${Math.floor(n * 10 + 1e-6) / 10}%`;
  };
  const sec1 = (ms) => (Number.isFinite(Number(ms)) ? `${(Number(ms) / 1000).toFixed(1)}s` : '–');
  const sec0 = (ms) => (Number.isFinite(Number(ms)) ? `${Math.round(Number(ms) / 1000)}s` : '–');

  const root = document.createElement('section');
  root.id = 'kimi-usage-hud';
  root.setAttribute('data-state', 'loading');
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

  const fieldsEl = root.querySelector('.kuh-fields');
  const themeBtn = root.querySelector('.kuh-theme');
  const collapseBtn = root.querySelector('.kuh-collapse');
  const dragBtn = root.querySelector('.kuh-drag');

  let viewIndex = 0;

  function applyTheme(theme) {
    root.setAttribute('data-theme', theme === 'dark' ? 'dark' : 'light');
    if (themeBtn) themeBtn.textContent = theme === 'dark' ? '☀' : '☾';
  }

  function applyView(index) {
    viewIndex = index;
    const view = VIEWS[index];
    root.setAttribute('data-view', view);
    if (collapseBtn) {
      collapseBtn.textContent = VIEW_GLYPH[view];
      collapseBtn.title = `显示档位：${VIEW_LABELS[view]}（点击切换）`;
    }
  }

  // kimi 是 SPA，切会话会改 URL path 为 /sessions/<id>，据此跟随当前会话。
  function currentSessionFromUrl() {
    const m = location.pathname.match(/\/sessions\/([^/?#]+)/);
    return m ? m[1] : null;
  }

  function setState(state) {
    root.setAttribute('data-state', state || 'ok');
  }

  function setField(key, text) {
    const el = fieldsEl && fieldsEl.querySelector(`[data-k="${key}"]`);
    if (el) el.textContent = text;
  }

  function renderSession(session) {
    if (!session) {
      setField('model', '');
      setField('turns', '');
      setField('llm', '');
      setField('ttft', '');
      setField('ttftServer', '');
      setField('turn', '');
      setField('cache', '');
      setField('tokens', '');
      return;
    }
    const turns = `${session.turns || 0} 轮 · ${session.steps || 0} 步`;
    const llm = `| LLM ${sec1(session.llmMs)} · 工具 ${sec0(session.toolMs)}`;
    const ttft = `| 首 token ${sec1(session.avgTtftMs)} · ${session.streamTokPerSec != null ? session.streamTokPerSec : '–'} tok/s`;
    const ttftServer = `| TTFT 客户端 ${sec1(session.avgTtftMs)} · 服务端 ${sec1(session.avgServerTtftMs)}`;
    const turn = `| 均轮 ${sec0(session.avgTurnMs)}`;
    const cache = fmtPct(session.cacheHitRate);
    const tokens = `| 输入 ${fmtTok(session.input)} tok · 输出 ${fmtTok(session.output)} tok · TPS ${session.decodeTokPerSec != null ? session.decodeTokPerSec : '–'} tok/s`;

    setField('model', session.model ? `· ${session.model}` : '');
    setField('turns', turns);
    setField('llm', llm);
    setField('ttft', ttft);
    setField('ttftServer', ttftServer);
    setField('turn', turn);
    setField('cache', `| 缓存 ${cache}`);
    setField('tokens', tokens);
    root.title = `${session.title || ''} · ${session.model || '未知模型'} · TTFT ${session.lastTtftMs != null ? `${session.lastTtftMs}ms` : '—'}`;
  }

  function applyPayload(result) {
    if (!result) {
      setState('error');
      return;
    }
    if (result.permission !== 'granted') {
      setState(result.permission === 'denied' ? 'error' : 'loading');
      renderSession(null);
      setField('model', `· ${result.error || '未连接本地 sessions 目录'}`);
      return;
    }
    renderSession(result.active || null);
    setState('ok');
  }

  async function poll() {
    let result;
    try {
      result = await chrome.runtime.sendMessage({ type: 'request-metrics', sessionId: currentSessionFromUrl() });
    } catch (error) {
      setState('error');
      renderSession(null);
      return;
    }
    applyPayload(result);
  }

  if (themeBtn) {
    themeBtn.addEventListener('click', () => {
      const next = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
      applyTheme(next);
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
      const next = Math.max(0, startTop - dy);
      root.style.setProperty('--kuh-top', `${next}px`);
    });
    dragBtn.addEventListener('pointerup', (_event) => {
      dragging = false;
    });
    dragBtn.addEventListener('pointercancel', () => {
      dragging = false;
    });
  }

  // 默认浅色、全量档；点 ☾/☀ 切主题，点右侧按钮切 全量→关键值→缩略。
  applyTheme('light');
  applyView(0);

  poll();
  setInterval(poll, POLL_MS);
})();