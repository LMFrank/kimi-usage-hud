'use strict';

import { saveDirectoryHandle } from '../src/cli-reader.js';

const $ = (id) => document.getElementById(id);

function setStatus(state, text, detail) {
  const statusEl = $('status');
  statusEl.dataset.state = state;
  $('status-text').textContent = text;
  $('status-detail').textContent = detail || '';
}

function renderResult(result) {
  if (!result) {
    setStatus('error', '无法连接扩展后台');
    return;
  }
  const permission = result.permission;
  if (permission !== 'granted') {
    const messages = {
      missing: '尚未连接 sessions 目录',
      prompt: '目录读权限待确认',
      denied: '目录读权限被拒绝',
      error: '扫描出错'
    };
    setStatus(permission === 'denied' ? 'denied' : permission, messages[permission] || permission, result.error || '');
    return;
  }

  const counts = result.counts || {};
  const active = result.active || null;
  const detail = [
    `会话 ${counts.sessionCount ?? 0} 个 · wire 文件 ${counts.fileCount ?? 0} 个`,
    active ? `当前：${active.title}${active.model ? ` · ${active.model}` : ''}` : '',
    active ? `输入 ${fmtTok(active.input)} · 输出 ${fmtTok(active.output)} · 累计 ${fmtTok(active.totalTokens)}` : ''
  ].filter(Boolean).join('\n');
  setStatus('granted', '已连接，状态条运行中', detail);
}

function fmtTok(value) {
  const n = Number(value) || 0;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1).replace(/\.0$/, '')}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1).replace(/\.0$/, '')}k`;
  return String(n);
}

async function refresh() {
  setStatus('loading', '读取中…');
  let result;
  try {
    result = await chrome.runtime.sendMessage({ type: 'request-metrics' });
  } catch (error) {
    setStatus('error', '无法连接扩展后台', String(error?.message || error));
    return;
  }
  renderResult(result);
}

async function connect() {
  if (typeof window.showDirectoryPicker !== 'function') {
    setStatus('error', '当前浏览器不支持目录授权', '请使用最新版 Chrome/Edge。');
    return;
  }
  try {
    // 必须在用户手势的同一瞬态激活内调用
    const handle = await window.showDirectoryPicker({ mode: 'read' });
    await saveDirectoryHandle(handle);
    // 选择目录通常会直接授予读权限；若未授予，下次点击再 requestPermission。
    try {
      await handle.requestPermission({ mode: 'read' });
    } catch {
      // 某些实现下可能重复请求导致报错，忽略。
    }
    await chrome.runtime.sendMessage({ type: 'reset-scan' });
    await refresh();
  } catch (error) {
    if (error?.name === 'AbortError') return; // 用户取消
    setStatus('error', '连接失败', String(error?.message || error));
  }
}

async function disconnect() {
  try {
    await chrome.runtime.sendMessage({ type: 'clear-handle' });
  } catch (error) {
    setStatus('error', '断开失败', String(error?.message || error));
    return;
  }
  await refresh();
}

async function rescan() {
  try {
    await chrome.runtime.sendMessage({ type: 'reset-scan' });
  } catch (error) {
    setStatus('error', '重扫失败', String(error?.message || error));
    return;
  }
  await refresh();
}

$('connect').addEventListener('click', connect);
$('rescan').addEventListener('click', rescan);
$('disconnect').addEventListener('click', disconnect);

refresh();