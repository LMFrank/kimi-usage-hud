import test from 'node:test';
import assert from 'node:assert/strict';

import { fetchDesktopPage, fetchDesktopSessionModel, readServerCredential, watchDesktopAgents } from '../desktop/reader.js';

function storage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    }
  };
}

function ok(data) {
  return {
    ok: true,
    status: 200,
    async json() {
      return { code: 0, data };
    }
  };
}

function options(fetchImpl, localStorage = storage()) {
  return {
    origin: 'http://127.0.0.1:50042',
    fetchImpl,
    localStorage,
    sessionStorage: storage()
  };
}

test('复用页面 server-credential：优先未过期 JSON，兼容旧裸字符串', () => {
  const key = 'kimi-web.server-credential';
  const credential = JSON.stringify({ version: 1, credential: 'json-test-credential', expiresAt: Date.now() + 60_000 });
  assert.equal(readServerCredential(storage({ [key]: credential }), storage()), 'json-test-credential');
  assert.equal(readServerCredential(storage({ [key]: 'legacy-test-credential' }), storage()), 'legacy-test-credential');
  const expired = JSON.stringify({ version: 1, credential: 'expired-test-credential', expiresAt: Date.now() - 1 });
  assert.equal(readServerCredential(storage({ [key]: expired }), storage({ [key]: 'session-test-credential' })), 'session-test-credential');
  assert.equal(readServerCredential(storage(), storage()), null);
});

test('Desktop 1.3.5：请求 agents/<id>/turns，携带 Bearer 与 before_ordinal', async () => {
  const calls = [];
  const data = { turns: [{ turn_id: 'turn-new', ordinal: 8, steps: [] }], has_more: true };
  const localStorage = storage({ 'kimi-web.server-credential': 'reader-test-credential' });
  const result = await fetchDesktopPage('session/id', {
    agentId: 'agent/1',
    pageSize: 20,
    beforeOrdinal: 8,
    beforeTurn: 'turn-old'
  }, options(async (url, init) => {
    calls.push({ url, init });
    return ok(data);
  }, localStorage));

  assert.equal(calls.length, 1);
  const url = new URL(calls[0].url);
  assert.equal(url.pathname, '/api/v1/sessions/session%2Fid/agents/agent%2F1/turns');
  assert.equal(url.searchParams.get('before_ordinal'), '8');
  assert.equal(url.searchParams.get('page_size'), '20');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer reader-test-credential');
  assert.equal(calls[0].init.cache, 'no-store');
  assert.deepEqual(result, { data, hasMore: true });
});

test('turns 返回 404 才回退旧 transcript，并映射 before_turn 与 agent_id', async () => {
  const calls = [];
  const data = { items: [{ kind: 'turn', turnId: 't7', steps: [] }], has_more: false };
  const result = await fetchDesktopPage('s1', {
    pageSize: 20,
    beforeOrdinal: 7,
    beforeTurn: 't7'
  }, options(async (url) => {
    calls.push(url);
    return calls.length === 1 ? { ok: false, status: 404 } : ok(data);
  }));

  assert.equal(calls.length, 2);
  const oldUrl = new URL(calls[1]);
  assert.equal(oldUrl.pathname, '/api/v1/sessions/s1/transcript');
  assert.equal(oldUrl.searchParams.get('agent_id'), 'main');
  assert.equal(oldUrl.searchParams.get('before_turn'), 't7');
  assert.equal(oldUrl.searchParams.get('page_size'), '20');
  assert.deepEqual(result, { data, hasMore: false });
});

test('turns 返回 401 时不回退、不吞错，也不发送空 Bearer', async () => {
  let calls = 0;
  await assert.rejects(fetchDesktopPage('s1', { pageSize: 2 }, options(async (url, init) => {
    calls += 1;
    assert.equal(Object.hasOwn(init.headers, 'Authorization'), false);
    return { ok: false, status: 401 };
  })), /读取失败\(401\)/);
  assert.equal(calls, 1);
});

test('会话模型从 session.agent_config.model 读取，沿用同一凭据获取方式', async () => {
  const localStorage = storage({ 'kimi-web.server-credential': 'model-test-credential' });
  const model = await fetchDesktopSessionModel('s1', options(async (url, init) => {
    assert.equal(new URL(url).pathname, '/api/v1/sessions/s1');
    assert.equal(init.headers.Authorization, 'Bearer model-test-credential');
    return ok({ agent_config: { model: 'kimi-test-model' } });
  }, localStorage));
  assert.equal(model, 'kimi-test-model');
});


test('复用 /api/v1/ws 公开订阅帧发现子 agent，并递归订阅 task.list/task', () => {
  class FakeWebSocket {
    static OPEN = 1;

    constructor(url, protocols) {
      this.url = url;
      this.protocols = protocols;
      this.readyState = 0;
      this.sent = [];
      FakeWebSocket.instance = this;
    }

    send(frame) {
      this.sent.push(JSON.parse(frame));
    }

    close() {
      this.readyState = 3;
    }
  }

  const discovered = [];
  const localStorage = storage({ 'kimi-web.server-credential': 'ws-test-credential' });
  const stop = watchDesktopAgents('s1', {
    ...options(async () => {
      throw new Error('unexpected fetch');
    }, localStorage),
    WebSocketImpl: FakeWebSocket
  }, (agentId) => discovered.push(agentId));
  const socket = FakeWebSocket.instance;

  assert.equal(socket.url, 'ws://127.0.0.1:50042/api/v1/ws');
  assert.deepEqual(socket.protocols, ['kimi-code.bearer.ws-test-credential']);
  socket.readyState = FakeWebSocket.OPEN;
  socket.onopen();
  assert.deepEqual(socket.sent.map((frame) => ({
    type: frame.type,
    session_id: frame.session_id,
    agent_ids: frame.agent_ids
  })), [{ type: 'subscribe', session_id: 's1', agent_ids: ['main'] }]);
  assert.equal(typeof socket.sent[0].request_id, 'string');

  socket.onmessage({ data: JSON.stringify({
    type: 'task.list',
    session_id: 's1',
    agent_id: 'main',
    tasks: [{ child_agent_id: 'agent-1' }, {}, { child_agent_id: 'agent-1' }]
  }) });
  socket.onmessage({ data: JSON.stringify({
    type: 'task',
    session_id: 's1',
    agent_id: 'agent-1',
    child_agent_id: 'agent-2'
  }) });
  socket.onmessage({ data: JSON.stringify({
    type: 'task.list',
    session_id: 'other-session',
    agent_id: 'main',
    tasks: [{ child_agent_id: 'wrong-session-agent' }]
  }) });

  assert.deepEqual(discovered, ['agent-1', 'agent-2']);
  assert.deepEqual(socket.sent.slice(1).map((frame) => frame.agent_ids), [['agent-1'], ['agent-2']]);
  stop();
  assert.equal(socket.readyState, 3);
});

test('WS 无凭据时不发送认证子协议', () => {
  let socket;
  class FakeWebSocket {
    constructor(url, protocols) {
      this.url = url;
      this.protocols = protocols;
      this.readyState = 0;
      socket = this;
    }

    close() {}
  }

  const stop = watchDesktopAgents('s1', {
    ...options(async () => {
      throw new Error('unexpected fetch');
    }),
    WebSocketImpl: FakeWebSocket
  }, () => {});
  assert.equal(socket.protocols, undefined);
  assert.equal(stop instanceof Function, true);
  stop();
});


function wsHarness(credentialValue = 'ws-initial-credential') {
  let credential = credentialValue;
  let nextTimerId = 0;
  const timers = new Map();
  const scheduler = {
    setTimeout(fn, delay) {
      const id = ++nextTimerId;
      timers.set(id, { fn, delay });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    runNext() {
      const [id, timer] = timers.entries().next().value || [];
      if (!timer) return false;
      timers.delete(id);
      timer.fn();
      return true;
    },
    get size() {
      return timers.size;
    },
    get delays() {
      return [...timers.values()].map((timer) => timer.delay);
    }
  };
  class FakeWebSocket {
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

    serverClose() {
      this.readyState = 3;
      this.onclose?.();
    }
  }
  return {
    scheduler,
    WebSocketImpl: FakeWebSocket,
    localStorage: { getItem: () => credential },
    setCredential(value) {
      credential = value;
    }
  };
}

test('WS ping 回复 pong，即使 ping 不带 session_id', () => {
  const harness = wsHarness();
  const stop = watchDesktopAgents('s1', {
    ...options(async () => {
      throw new Error('unexpected fetch');
    }, harness.localStorage),
    WebSocketImpl: harness.WebSocketImpl,
    setTimeoutImpl: harness.scheduler.setTimeout,
    clearTimeoutImpl: harness.scheduler.clearTimeout
  }, () => {});
  const socket = harness.WebSocketImpl.instances[0];
  socket.open();
  socket.message({ type: 'ping' });
  assert.deepEqual(socket.sent.at(-1), { type: 'pong' });
  stop();
});

test('WS close 后有限退避重连、重读凭据并恢复 roster；stop 与旧回调均失效', () => {
  const harness = wsHarness();
  const discovered = [];
  const stop = watchDesktopAgents('s1', {
    ...options(async () => {
      throw new Error('unexpected fetch');
    }, harness.localStorage),
    WebSocketImpl: harness.WebSocketImpl,
    setTimeoutImpl: harness.scheduler.setTimeout,
    clearTimeoutImpl: harness.scheduler.clearTimeout
  }, (agentId) => discovered.push(agentId));
  const first = harness.WebSocketImpl.instances[0];
  first.open();
  first.message({
    type: 'task.list',
    session_id: 's1',
    agent_id: 'main',
    tasks: [{ child_agent_id: 'agent-1' }]
  });
  assert.deepEqual(first.sent.map((frame) => frame.agent_ids).filter(Boolean), [['main'], ['agent-1']]);

  first.serverClose();
  first.serverClose();
  assert.equal(harness.scheduler.size, 1);
  assert.deepEqual(harness.scheduler.delays, [250]);
  harness.setCredential('ws-rotated-credential');
  assert.equal(harness.scheduler.runNext(), true);

  assert.equal(harness.WebSocketImpl.instances.length, 2);
  const second = harness.WebSocketImpl.instances[1];
  assert.deepEqual(second.protocols, ['kimi-code.bearer.ws-rotated-credential']);
  second.open();
  assert.deepEqual(second.sent.map((frame) => frame.agent_ids).filter(Boolean), [['main'], ['agent-1']]);

  const firstSent = first.sent.length;
  first.message({ type: 'ping' });
  first.message({ type: 'task', session_id: 's1', child_agent_id: 'stale-agent' });
  assert.equal(first.sent.length, firstSent);
  assert.deepEqual(discovered, ['agent-1']);

  second.message({ type: 'task', session_id: 's1', child_agent_id: 'agent-2' });
  assert.deepEqual(discovered, ['agent-1', 'agent-2']);
  second.serverClose();
  assert.equal(harness.scheduler.size, 1);
  stop();
  assert.equal(harness.scheduler.size, 0);
  assert.equal(harness.scheduler.runNext(), false);
  assert.equal(harness.WebSocketImpl.instances.length, 2);

  second.message({ type: 'task', session_id: 's1', child_agent_id: 'after-stop-agent' });
  assert.deepEqual(discovered, ['agent-1', 'agent-2']);
});
