import test from 'node:test';
import assert from 'node:assert/strict';

let moduleSequence = 0;

function ok(data) {
  return {
    ok: true,
    status: 200,
    async json() {
      return { code: 0, data };
    }
  };
}

function storage() {
  return { getItem: () => null };
}

function installDom(fetchImpl, WebSocketImpl) {
  const fields = new Map();
  const intervals = new Map();
  const buttons = [];
  let mounted = false;
  const button = () => {
    const value = { textContent: '', title: '', addEventListener() {} };
    buttons.push(value);
    return value;
  };
  const root = {
    title: '',
    innerHTML: '',
    style: { setProperty() {} },
    setAttribute() {},
    addEventListener() {},
    querySelector(selector) {
      if (selector === '.kuh-fields') {
        return {
          querySelector(fieldSelector) {
            const key = /data-k="([^"]+)"/.exec(fieldSelector)?.[1];
            if (!fields.has(key)) fields.set(key, { textContent: '' });
            return fields.get(key);
          }
        };
      }
      if (selector === '.kuh-drag') return { addEventListener() {} };
      return button();
    }
  };
  const document = {
    body: {
      appendChild() {
        mounted = true;
      }
    },
    documentElement: {
      appendChild() {
        mounted = true;
      }
    },
    createElement: () => root,
    getElementById: () => (mounted ? root : null)
  };
  const window = { __kuhKapOrigin: 'http://127.0.0.1:50042' };
  const location = { pathname: '/sessions/s1', origin: 'http://127.0.0.1:50042' };
  const overrides = {
    document,
    window,
    location,
    fetch: fetchImpl,
    WebSocket: WebSocketImpl,
    localStorage: storage(),
    sessionStorage: storage(),
    getComputedStyle: () => ({ getPropertyValue: () => '8' }),
    setInterval(fn, ms) {
      intervals.set(ms, fn);
      return intervals.size;
    }
  };
  const previous = new Map();
  for (const [key, value] of Object.entries(overrides)) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  return {
    fields,
    intervals,
    restore() {
      for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else delete globalThis[key];
      }
    }
  };
}

async function flush() {
  for (let index = 0; index < 12; index += 1) await new Promise((resolve) => setImmediate(resolve));
}

function mainPage() {
  return {
    turns: [{
      turn_id: 'main-turn',
      ordinal: 0,
      duration_ms: 1_000,
      steps: [{
        index: 0,
        usage: { input_other: 10, input_cache_read: 0, input_cache_creation: 0, output: 2 },
        timing: { first_token_ms: 100, stream_ms: 900 }
      }]
    }],
    has_more: false
  };
}

function agentPage(input, output) {
  return {
    turns: [{
      turn_id: 'agent-turn',
      ordinal: 0,
      duration_ms: 1_000,
      steps: [{
        index: 0,
        usage: { input_other: input, input_cache_read: 0, input_cache_creation: 0, output },
        timing: { first_token_ms: 100, stream_ms: 900 }
      }]
    }],
    has_more: false
  };
}

function fakeWebSocketClass() {
  return class FakeWebSocket {
    static OPEN = 1;
    static instances = [];

    constructor(url, protocols) {
      this.url = url;
      this.protocols = protocols;
      this.readyState = 0;
      this.sent = [];
      FakeWebSocket.instances.push(this);
    }

    send(frame) {
      this.sent.push(JSON.parse(frame));
    }

    close() {
      this.readyState = 3;
    }

    open() {
      this.readyState = FakeWebSocket.OPEN;
      this.onopen?.();
    }

    message(frame) {
      this.onmessage?.({ data: JSON.stringify(frame) });
    }
  };
}

test('初次模型请求失败后，同一会话的路由轮询自动重试并恢复', async () => {
  let modelCalls = 0;
  let mainCalls = 0;
  const FakeWebSocket = fakeWebSocketClass();
  const harness = installDom(async (url) => {
    const path = new URL(url).pathname;
    if (path === '/api/v1/sessions/s1') {
      modelCalls += 1;
      if (modelCalls === 1) return { ok: false, status: 500 };
      return ok({ agent_config: { model: 'model-after-retry' } });
    }
    if (path === '/api/v1/sessions/s1/agents/main/turns') {
      mainCalls += 1;
      return ok(mainPage());
    }
    throw new Error(`unexpected request: ${path}`);
  }, FakeWebSocket);
  try {
    await import(`../desktop/hud-app.js?retry=${moduleSequence += 1}`);
    await flush();
    assert.equal(modelCalls, 1);
    assert.equal(mainCalls, 0);
    assert.equal(harness.fields.get('turns').textContent, '读取失败(500)');

    await harness.intervals.get(1000)();
    assert.equal(modelCalls, 2);
    assert.equal(mainCalls, 1);
    assert.equal(harness.fields.get('model').textContent, '· model-after-retry');
    assert.equal(harness.fields.get('turns').textContent, '1 轮 · 1 步');
  } finally {
    harness.restore();
  }
});

test('task.list 恢复子 agent 历史与轮询刷新，模型名同步更新', async () => {
  let now = 100_000;
  let currentModel = 'model-a';
  let agentInput = 50;
  let agentOutput = 5;
  let agentCalls = 0;
  const originalNow = Date.now;
  Date.now = () => now;
  const FakeWebSocket = fakeWebSocketClass();
  const harness = installDom(async (url) => {
    const path = new URL(url).pathname;
    if (path === '/api/v1/sessions/s1') return ok({ agent_config: { model: currentModel } });
    if (path === '/api/v1/sessions/s1/agents/main/turns') return ok(mainPage());
    if (path === '/api/v1/sessions/s1/agents/agent-1/turns') {
      agentCalls += 1;
      return ok(agentPage(agentInput, agentOutput));
    }
    throw new Error(`unexpected request: ${path}`);
  }, FakeWebSocket);
  try {
    await import(`../desktop/hud-app.js?agents=${moduleSequence += 1}`);
    await harness.intervals.get(1000)();
    const socket = FakeWebSocket.instances.at(-1);
    socket.open();
    socket.message({
      type: 'task.list',
      session_id: 's1',
      agent_id: 'main',
      tasks: [{ child_agent_id: 'agent-1' }]
    });
    await flush();

    assert.equal(agentCalls, 1);
    assert.equal(harness.fields.get('tokens').textContent, '| 输入 60 tok · 输出 7 tok · TPS 2 tok/s');

    currentModel = 'model-b';
    agentInput = 70;
    agentOutput = 7;
    now += 16_000;
    await harness.intervals.get(2000)();

    assert.equal(agentCalls, 2);
    assert.equal(harness.fields.get('model').textContent, '· model-b');
    assert.equal(harness.fields.get('tokens').textContent, '| 输入 80 tok · 输出 9 tok · TPS 2 tok/s');
  } finally {
    Date.now = originalNow;
    harness.restore();
  }
});


test('初次 turns 请求失败后，同一会话自动重试，不需要切换路由', async () => {
  let mainCalls = 0;
  const FakeWebSocket = fakeWebSocketClass();
  const harness = installDom(async (url) => {
    const path = new URL(url).pathname;
    if (path === '/api/v1/sessions/s1') return ok({ agent_config: { model: 'model-a' } });
    if (path === '/api/v1/sessions/s1/agents/main/turns') {
      mainCalls += 1;
      return mainCalls === 1 ? { ok: false, status: 401 } : ok(mainPage());
    }
    throw new Error(`unexpected request: ${path}`);
  }, FakeWebSocket);
  try {
    await import(`../desktop/hud-app.js?turn-retry=${moduleSequence += 1}`);
    await flush();
    assert.equal(mainCalls, 1);
    assert.equal(harness.fields.get('turns').textContent, '读取失败(401)');

    await harness.intervals.get(1000)();
    assert.equal(mainCalls, 2);
    assert.equal(harness.fields.get('turns').textContent, '1 轮 · 1 步');
  } finally {
    harness.restore();
  }
});


test('HUD 的全部子模块继承版本查询参数，避免 Electron 复用旧 ES module 缓存', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../desktop/hud-app.js', import.meta.url), 'utf8');
  assert.match(source, /const MODULE_QUERY = new URL\(import\.meta\.url\)\.search/);
  for (const dependency of ['../src/metrics.js', './fold.js', './reader.js']) {
    assert.ok(
      source.includes(`import(new URL('${dependency}' + MODULE_QUERY, import.meta.url))`),
      `子模块未透传 import.meta.url.search: ${dependency}`
    );
  }
});


test('WS 只有活动 agent 时，main turns 的 agent_refs 仍补齐已完成 agent 历史与汇总', async () => {
  let historicCalls = 0;
  const FakeWebSocket = fakeWebSocketClass();
  const historicalMain = mainPage();
  historicalMain.turns[0].items = [{
    type: 'tool_call',
    name: 'Task',
    task_id: 'agent-historic',
    agent_refs: [{ agent_id: 'agent-historic', role: 'primary', swarm_index: 0 }],
    status: 'ended',
    outcome: 'completed'
  }];
  const harness = installDom(async (url) => {
    const path = new URL(url).pathname;
    if (path === '/api/v1/sessions/s1') return ok({ agent_config: { model: 'model-a' } });
    if (path === '/api/v1/sessions/s1/agents/main/turns') return ok(historicalMain);
    if (path === '/api/v1/sessions/s1/agents/agent-1/turns') return ok(agentPage(50, 5));
    if (path === '/api/v1/sessions/s1/agents/agent-historic/turns') {
      historicCalls += 1;
      return ok(agentPage(200, 20));
    }
    throw new Error(`unexpected request: ${path}`);
  }, FakeWebSocket);
  try {
    await import(`../desktop/hud-app.js?historic-refs=${moduleSequence += 1}`);
    await harness.intervals.get(1000)();
    const socket = FakeWebSocket.instances.at(-1);
    socket.open();
    socket.message({
      type: 'task.list',
      session_id: 's1',
      agent_id: 'main',
      tasks: [{ child_agent_id: 'agent-1', status: 'running' }]
    });
    await flush();

    assert.equal(historicCalls, 1);
    assert.equal(harness.fields.get('tokens').textContent, '| 输入 260 tok · 输出 27 tok · TPS 2 tok/s');
  } finally {
    harness.restore();
  }
});


test('timeline 相关的 LLM、客户端 TTFT 与速度在 UI 标为近似值', async () => {
  const FakeWebSocket = fakeWebSocketClass();
  const timeline = mainPage();
  const step = timeline.turns[0].steps[0];
  delete step.timing;
  step.started_at = '2026-11-13T01:00:00.000Z';
  step.ended_at = '2026-11-13T01:00:01.100Z';
  timeline.turns[0].items = [
    { type: 'reasoning', step_index: 0, created_at: '2026-11-13T01:00:00.100Z' },
    { type: 'tool_call', step_index: 0, created_at: '2026-11-13T01:00:01.000Z' }
  ];
  const harness = installDom(async (url) => {
    const path = new URL(url).pathname;
    if (path === '/api/v1/sessions/s1') return ok({ agent_config: { model: 'model-a' } });
    if (path === '/api/v1/sessions/s1/agents/main/turns') return ok(timeline);
    throw new Error(`unexpected request: ${path}`);
  }, FakeWebSocket);
  try {
    await import(`../desktop/hud-app.js?approximate-display=${moduleSequence += 1}`);
    await harness.intervals.get(1000)();

    assert.equal(harness.fields.get('llm').textContent, '| LLM ≈1.0s · 工具 –');
    assert.equal(harness.fields.get('ttft').textContent, '| 首 token ≈0.1s · ≈2 tok/s');
    assert.equal(harness.fields.get('ttftServer').textContent, '| TTFT 客户端 ≈0.1s · 服务端 –');
    assert.equal(harness.fields.get('tokens').textContent, '| 输入 10 tok · 输出 2 tok · TPS ≈2 tok/s');
    assert.equal(harness.fields.get('turn').textContent, '| 均轮 1s');
  } finally {
    harness.restore();
  }
});
