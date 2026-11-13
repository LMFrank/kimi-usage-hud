'use strict';

const CREDENTIAL_KEY = 'kimi-web.server-credential';

function storedCredential(storage) {
  try {
    const raw = storage?.getItem(CREDENTIAL_KEY);
    if (typeof raw !== 'string' || raw.length === 0) return null;
    let value;
    try {
      value = JSON.parse(raw);
    } catch {
      return raw;
    }
    if (value?.version === 1 && typeof value.credential === 'string' && value.credential.length > 0 && Number.isFinite(value.expiresAt)) {
      return value.expiresAt > Date.now() ? value.credential : null;
    }
    return raw;
  } catch {
    return null;
  }
}

// 与 Kimi Code 页面自身一致：凭据只从页面存储读入当前请求，不持久化、不输出。
export function readServerCredential(localStorage = globalThis.localStorage, sessionStorage = globalThis.sessionStorage) {
  return storedCredential(localStorage) || storedCredential(sessionStorage);
}

function requestOptions(options) {
  const credential = readServerCredential(options.localStorage, options.sessionStorage);
  return {
    cache: 'no-store',
    headers: credential ? { Authorization: `Bearer ${credential}` } : {}
  };
}

async function get(path, options) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  return fetchImpl(`${options.origin}${path}`, requestOptions(options));
}

async function responseData(response) {
  if (!response.ok) throw new Error(`读取失败(${response.status})`);
  const payload = await response.json();
  if (payload?.code !== 0) throw new Error(`读取失败(${payload?.code ?? '未知'})`);
  if (payload.data == null) throw new Error('读取失败(响应无 data)');
  return payload.data;
}

export async function fetchDesktopPage(sid, params, options) {
  const agentId = params.agentId || 'main';
  const sessionPath = `/api/v1/sessions/${encodeURIComponent(sid)}`;
  const agentPath = `${sessionPath}/agents/${encodeURIComponent(agentId)}/turns`;
  const query = new URLSearchParams({ page_size: String(params.pageSize) });
  if (params.beforeOrdinal !== '' && params.beforeOrdinal != null) query.set('before_ordinal', String(params.beforeOrdinal));
  let response = await get(`${agentPath}?${query}`, options);

  // 1.3.5 移除 transcript；仅在 turns 不存在时走旧版单页兼容路径。
  if (response.status === 404) {
    const oldQuery = new URLSearchParams({
      agent_id: agentId,
      page_size: String(params.pageSize)
    });
    if (params.beforeTurn) oldQuery.set('before_turn', params.beforeTurn);
    response = await get(`${sessionPath}/transcript?${oldQuery}`, options);
  }

  const data = await responseData(response);
  if (!Array.isArray(data.turns) && !Array.isArray(data.items)) throw new Error('读取失败(响应无 turns/items)');
  return { data, hasMore: data.has_more === true };
}

export async function fetchDesktopSessionModel(sid, options) {
  const data = await responseData(await get(`/api/v1/sessions/${encodeURIComponent(sid)}`, options));
  const model = data?.agent_config?.model;
  return typeof model === 'string' ? model : '';
}
// 1.3.5 自身通过 /api/v1/ws 的 subscribe → task.list/task 帧发现 child_agent_id。
// 这里只订阅 roster，不消费 turns；断线采用 250ms→4s 封顶的单层指数退避。
// 每次重连重读凭据并恢复订阅；当前 socket 是唯一有效回调源，stop 后不再重连。
export function watchDesktopAgents(sid, options, onAgent) {
  const WebSocketImpl = options.WebSocketImpl || globalThis.WebSocket;
  const setTimeoutImpl = options.setTimeoutImpl || globalThis.setTimeout;
  const clearTimeoutImpl = options.clearTimeoutImpl || globalThis.clearTimeout;
  const url = new URL(`${options.origin}/api/v1/ws`);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  const subscribed = new Set(['main']);
  let socket = null;
  let reconnectTimer = null;
  let reconnectAttempt = 0;
  let stopped = false;
  let sequence = 0;

  const isCurrent = (current) => !stopped && socket === current;

  function send(current, frame) {
    if (!isCurrent(current) || current.readyState !== (WebSocketImpl.OPEN ?? 1)) return;
    current.send(JSON.stringify(frame));
  }

  function subscribe(current, agentId) {
    send(current, {
      type: 'subscribe',
      request_id: `kuh_${sequence += 1}`,
      session_id: sid,
      agent_ids: [agentId]
    });
  }

  function scheduleReconnect() {
    if (stopped || socket || reconnectTimer != null) return;
    const delay = Math.min(4_000, 250 * 2 ** reconnectAttempt);
    reconnectAttempt += 1;
    reconnectTimer = setTimeoutImpl(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  }

  function discover(current, agentId) {
    if (agentId === 'main' || typeof agentId !== 'string' || agentId.length === 0 || subscribed.has(agentId)) return;
    subscribed.add(agentId);
    subscribe(current, agentId);
    onAgent(agentId);
  }

  function connect() {
    if (stopped || socket) return;
    const credential = readServerCredential(options.localStorage, options.sessionStorage);
    const protocols = credential ? [`kimi-code.bearer.${credential}`] : undefined;
    let current;
    try {
      current = new WebSocketImpl(url.toString(), protocols);
    } catch {
      scheduleReconnect();
      return;
    }
    socket = current;

    current.onopen = () => {
      if (!isCurrent(current)) return;
      reconnectAttempt = 0;
      for (const agentId of subscribed) subscribe(current, agentId);
    };
    current.onmessage = (event) => {
      if (!isCurrent(current)) return;
      let frame;
      try {
        frame = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (frame?.type === 'ping') {
        send(current, { type: 'pong' });
        return;
      }
      if (frame?.session_id !== sid) return;
      if (frame.type === 'task.list') {
        for (const task of Array.isArray(frame.tasks) ? frame.tasks : []) discover(current, task?.child_agent_id);
      } else if (frame.type === 'task') {
        discover(current, frame.child_agent_id);
      }
    };
    current.onclose = () => {
      if (!isCurrent(current)) return;
      socket = null;
      scheduleReconnect();
    };
  }

  connect();
  return () => {
    stopped = true;
    if (reconnectTimer != null) clearTimeoutImpl(reconnectTimer);
    reconnectTimer = null;
    const current = socket;
    socket = null;
    current?.close();
  };
}
