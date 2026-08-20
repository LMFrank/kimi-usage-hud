'use strict';

import {
  clearDirectoryHandle,
  getDirectoryHandle,
  permissionState,
  scanDirectory
} from './cli-reader.js';

// service worker 是短生命周期的：状态集中在内存，目录句柄持久化在 IndexedDB，
// 由 content script 每 2s 的消息唤醒并驱动扫描（每次消息都会刷新 idle 计时，
// 从而避免 MV3 worker 被回收）。优先走 Native Messaging host（免目录授权、只 fold
// 目标 session），失败再回退 FSA 全量扫描。

const NATIVE_HOST_NAME = 'com.kimi.usage.hud';
let nativeBackoffUntil = 0;

const state = {
  handle: null,
  fileMap: new Map(),
  lastResult: null,
  permission: 'unknown',
  nativeError: '',
  error: ''
};

let scanning = null;

async function attach() {
  if (!state.handle) {
    try {
      state.handle = await getDirectoryHandle();
    } catch (error) {
      state.error = String(error?.message || error);
    }
    if (!state.handle) {
      state.permission = 'missing';
      return false;
    }
  }
  try {
    state.permission = await permissionState(state.handle);
  } catch {
    state.permission = 'denied';
  }
  return state.permission === 'granted';
}

function emptyCounts() {
  return { sessionCount: 0, fileCount: 0, changed: 0, failed: 0 };
}

function sendNativeMetrics(sessionId) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendNativeMessage(NATIVE_HOST_NAME, { type: 'metrics', sessionId }, (response) => {
        resolve({ response, error: chrome.runtime.lastError?.message || '' });
      });
    } catch (error) {
      resolve({ response: null, error: String(error?.message || error) });
    }
  });
}

async function tryNativeHost(sessionId) {
  if (Date.now() < nativeBackoffUntil) return null;
  const { response, error } = await sendNativeMetrics(sessionId);
  if (response?.ok) return response;
  // host 未安装 / 启动失败时，冷却 60s 后重试，避免每秒空打。
  nativeBackoffUntil = Date.now() + 60_000;
  state.nativeError = error || 'native host 不可用';
  return null;
}

async function runScan(sessionId) {
  const native = await tryNativeHost(sessionId);
  if (native) {
    const result = {
      sessions: Array.isArray(native.sessions) ? native.sessions : [],
      active: native.active || null,
      counts: native.counts || emptyCounts()
    };
    state.lastResult = result;
    return { permission: 'granted', ...result };
  }

  const granted = await attach();
  if (!granted) {
    const messages = {
      missing: '尚未授权本地 sessions 目录，请点扩展图标连接',
      prompt: '目录读权限待确认，请点扩展图标重新授权',
      denied: '目录读权限被拒绝，请重新选择目录',
      unknown: ''
    };
    const base = messages[state.permission] || state.error;
    return {
      permission: state.permission,
      sessions: [],
      active: null,
      counts: emptyCounts(),
      error: state.nativeError ? `${base}（native host: ${state.nativeError}）` : base
    };
  }

  if (!scanning) {
    scanning = scanDirectory(state.handle, state.fileMap)
      .catch((error) => ({
        sessions: [],
        active: null,
        counts: emptyCounts(),
        error: String(error?.message || error)
      }))
      .finally(() => {
        scanning = null;
      });
  }

  const result = await scanning;
  let active = result.active;
  if (sessionId && Array.isArray(result.sessions)) {
    active = result.sessions.find((s) => s.sessionId === sessionId) || active;
  }
  const next = { ...result, active };
  state.lastResult = next;
  return { permission: 'granted', ...next };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message !== 'object') return;

  if (message.type === 'request-metrics') {
    runScan(message.sessionId || null).then(sendResponse);
    return true;
  }

  if (message.type === 'reset-scan') {
    state.fileMap.clear();
    state.lastResult = null;
    state.error = '';
    state.nativeError = '';
    sendResponse({ ok: true });
    return;
  }

  if (message.type === 'clear-handle') {
    clearDirectoryHandle()
      .then(() => {
        state.handle = null;
        state.fileMap.clear();
        state.lastResult = null;
        state.permission = 'missing';
        state.error = '';
        state.nativeError = '';
        sendResponse({ ok: true });
      })
      .catch((error) => sendResponse({ ok: false, error: String(error?.message || error) }));
    return true;
  }
});