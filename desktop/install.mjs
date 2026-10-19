#!/usr/bin/env node
/**
 * Kimi Code Usage HUD · 桌面客户端补丁安装器（macOS，Node ≥16）
 *
 * 用法：
 *   node install.mjs                安装/更新补丁（幂等，可反复执行）
 *   node install.mjs --uninstall    完整卸载（逐字节还原 index.html、删除载荷）
 *   node install.mjs --app <路径>   指定客户端位置（也接受裸路径参数）
 *   node install.mjs --help         只打印用法与路径推导结果，不落盘
 *
 * 行为：
 *   1. 备份 desktop-dist/index.html 为 index.html.bak-kuh（仅在备份不存在时
 *      创建，重装永远保留最早的原始版本）
 *   2. 把仓库里的 5 个载荷文件同步进 desktop-dist/kuh/（先暂存目录再原子替换）
 *   3. 在 index.html 的 </head> 前注入 <script src="/kuh/loader.js?v=哈希">
 *      （哈希取自载荷内容，客户端更新缓存自动失效）
 *
 * 客户端自动更新会整体替换 desktop-dist（补丁随之消失，属预期）：
 * 重新执行本脚本即可重装。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.dirname(HERE);
const APP_NAME = 'Kimi Code';
const PAYLOAD_DIR = 'kuh';
const LOADER_SRC = `/${PAYLOAD_DIR}/loader.js`;
const BACKUP_SUFFIX = '.bak-kuh';

// 载荷清单：源（仓库内相对路径）→ 目标（载荷内相对路径）。
// loader.js 放载荷根（index.html 只引它一个），其余保持仓库里的相对位置不变——
// hud-app.js 用 './fold.js' 引折叠逻辑、fold.js 用 '../src/metrics.js' 引口径，
// 位置一变这两处 import 就会 404。
const PAYLOAD_FILES = [
  ['desktop/loader.js', 'loader.js'],
  ['desktop/hud-app.js', 'desktop/hud-app.js'],
  ['desktop/fold.js', 'desktop/fold.js'],
  ['src/metrics.js', 'src/metrics.js'],
  ['styles/hud.css', 'styles/hud.css']
];

/* ---------- 纯函数（可单测 / 可 dry 检查） ---------- */

/** 客户端安装根目录候选（按序）。env/home 可注入，便于测试。 */
export function appRootCandidates(env = process.env, home = os.homedir()) {
  const out = [];
  if (env.KIMI_CODE_APP_DIR) out.push(env.KIMI_CODE_APP_DIR);
  out.push(path.join('/Applications', `${APP_NAME}.app`));
  out.push(path.join(home, 'Applications', `${APP_NAME}.app`));
  return out;
}

/** 应用根 → desktop-dist 目录。传入路径本身就是 desktop-dist 时直接用。 */
export function distDirOf(appRoot) {
  return path.basename(appRoot) === 'desktop-dist'
    ? appRoot
    : path.join(appRoot, 'Contents', 'Resources', 'desktop-dist');
}

/** 客户端版本（仅信息展示，取不到返回 '?'，不阻断安装）。 */
export function readClientVersion(appRoot) {
  try {
    const plist = fs.readFileSync(path.join(appRoot, 'Contents', 'Info.plist'), 'utf8');
    const m = plist.match(/<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/);
    return m ? m[1] : '?';
  } catch (error) {
    return '?';
  }
}

/** 载荷内容哈希：路径 + 内容排序后取整段 sha256 前 8 位，用于 ?v= 穿透缓存。 */
export function payloadHash(root) {
  const lines = PAYLOAD_FILES
    .map(([, rel]) => {
      const digest = crypto.createHash('sha256').update(fs.readFileSync(path.join(root, rel))).digest('hex');
      return `${digest}  ./${rel}`;
    })
    .sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  return crypto.createHash('sha256').update(lines.map((line) => `${line}\n`).join('')).digest('hex').slice(0, 8);
}

/** 去掉所有含 loader 标签的行（幂等重装 / 无备份卸载用）。 */
export function stripLoaderTagLines(html) {
  return html.split('\n').filter((line) => !line.includes(LOADER_SRC)).join('\n');
}

/** 在首个 </head> 前插入 loader 标签；找不到返回 null。 */
export function injectLoaderTag(html, hash) {
  const marker = '</head>';
  const idx = html.indexOf(marker);
  if (idx < 0) return null;
  const tag = `      <script src="${LOADER_SRC}?v=${hash}"></script>\n`;
  return html.slice(0, idx) + tag + html.slice(idx);
}

/* ---------- 落盘流程 ---------- */

/** 原子替换 index.html：先写同目录暂存文件再 rename 顶替。
 *  'w' 直写会先截断原文件，写一半失败会留下空文件；同目录 rename 要么成功
 *  要么原文件一个字节不动。失败时清掉暂存文件后原样抛出。 */
function replaceIndex(index, content) {
  const staged = path.join(path.dirname(index), `.kuh-index-${process.pid}.html`);
  fs.rmSync(staged, { force: true });
  try {
    fs.writeFileSync(staged, content);
    fs.renameSync(staged, index);
  } catch (error) {
    fs.rmSync(staged, { force: true });
    throw error;
  }
}

/** 载荷同步：先建暂存目录（验证目标可写），再删旧载荷、rename 顶替。
 *  不能先删后拷：客户端目录受 macOS「App 管理」保护时创建会被拒，
 *  而删除已经生效，会留下「载荷没了、index.html 却仍引用 loader」的坏状态。 */
function syncPayload(dist) {
  const staged = path.join(dist, `${PAYLOAD_DIR}.new-${process.pid}`);
  fs.rmSync(staged, { recursive: true, force: true });
  try {
    for (const [from, to] of PAYLOAD_FILES) {
      const target = path.join(staged, to);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(path.join(REPO_ROOT, from), target);
    }
    fs.rmSync(path.join(dist, PAYLOAD_DIR), { recursive: true, force: true });
    fs.renameSync(staged, path.join(dist, PAYLOAD_DIR));
  } catch (error) {
    fs.rmSync(staged, { recursive: true, force: true });
    throw error;
  }
}

function payloadVersion() {
  try {
    return fs.readFileSync(path.join(HERE, 'VERSION'), 'utf8').trim();
  } catch (error) {
    return '?';
  }
}

function install(dist) {
  const index = path.join(dist, 'index.html');
  if (!fs.existsSync(index)) {
    console.error(`[install] 未找到 ${index}——请确认 --app 指向的是客户端安装目录`);
    process.exit(1);
  }

  // 可写性预检：动手前实测目标目录能不能写。失败时给人话指引，不抛裸堆栈。
  try {
    const probe = path.join(dist, `.kuh-probe-${process.pid}`);
    fs.writeFileSync(probe, '');
    fs.rmSync(probe, { force: true });
  } catch (error) {
    console.error(`[install] 客户端目录不可写：${dist}（${error?.code || error?.message || error}）`);
    console.error('[install] macOS 目录受「App 管理」保护时：系统设置 → 隐私与安全性 → App 管理，允许当前终端后重试');
    process.exit(1);
  }

  const backup = index + BACKUP_SUFFIX;
  if (!fs.existsSync(backup)) {
    try {
      fs.copyFileSync(index, backup);
      console.error('[install] 已备份原始 index.html');
    } catch (error) {
      console.error(`[install] 备份失败：${error?.message || error}`);
      console.error('[install] 已中止：index.html 未改动，按上方权限指引处理后重试');
      process.exit(1);
    }
  } else {
    console.error('[install] 备份已存在，保留最早的原始版本');
  }

  try {
    syncPayload(dist);
  } catch (error) {
    console.error(`[install] 载荷写入失败：${error?.message || error}`);
    if (error?.code === 'EPERM' || error?.code === 'EACCES') {
      console.error('[install] 客户端目录被系统保护：系统设置 → 隐私与安全性 →「App 管理」允许当前终端后重试');
    }
    console.error('[install] 已中止：原有载荷与 index.html 都未改动');
    process.exit(1);
  }
  console.error('[install] 载荷已同步');

  const hash = payloadHash(path.join(dist, PAYLOAD_DIR));
  const html = fs.readFileSync(index, 'utf8');
  const injected = injectLoaderTag(stripLoaderTagLines(html), hash);
  if (injected === null) {
    console.error('[install] 注入标签失败：index.html 结构与预期不符（可能客户端大版本更新），已中止');
    fs.rmSync(path.join(dist, PAYLOAD_DIR), { recursive: true, force: true });
    process.exit(1);
  }
  try {
    replaceIndex(index, injected);
  } catch (error) {
    console.error(`[install] 写入 index.html 失败：${error?.message || error}`);
    console.error('[install] 已中止：index.html 未改动（载荷已同步，处理后重跑安装即可完成）');
    process.exit(1);
  }
  if (!fs.readFileSync(index, 'utf8').includes(`${LOADER_SRC}?v=${hash}`)) {
    console.error('[install] 注入校验失败，正在还原备份……');
    fs.copyFileSync(backup, index);
    fs.rmSync(path.join(dist, PAYLOAD_DIR), { recursive: true, force: true });
    process.exit(1);
  }

  console.error(`[install] 完成（v${payloadVersion()} · 载荷 ${hash}）`);
  console.error('[install] 请重载 Kimi Code 客户端（Cmd+R）或重启客户端，进入会话页即可看到状态条');
  console.error('[install] 注：客户端大版本更新会清除补丁文件（属预期），届时重新执行本安装即可恢复');
}

function uninstall(dist) {
  const index = path.join(dist, 'index.html');
  const backup = index + BACKUP_SUFFIX;
  if (fs.existsSync(backup)) {
    // 用 Buffer 原样顶替，兑现「卸载逐字节还原」；失败时备份仍在，可重跑
    try {
      replaceIndex(index, fs.readFileSync(backup));
    } catch (error) {
      console.error(`[install] 还原 index.html 失败：${error?.message || error}`);
      console.error(`[install] 备份仍在（index.html${BACKUP_SUFFIX}），处理后重跑 --uninstall 即可`);
      process.exit(1);
    }
    fs.rmSync(backup);
    console.error('[install] 已还原原始 index.html');
  } else if (fs.existsSync(index)) {
    try {
      replaceIndex(index, stripLoaderTagLines(fs.readFileSync(index, 'utf8')));
    } catch (error) {
      console.error(`[install] 清除注入行失败：${error?.message || error}`);
      console.error('[install] 已中止：index.html 未改动，请处理后重跑 --uninstall');
      process.exit(1);
    }
    console.error('[install] 未找到备份，已移除注入行');
  }
  fs.rmSync(path.join(dist, PAYLOAD_DIR), { recursive: true, force: true });
  console.error('[install] 载荷目录已删除，卸载完成（重载客户端生效）');
}

function usage() {
  console.error('用法：');
  console.error('  node install.mjs                安装/更新补丁（幂等，可反复执行）');
  console.error('  node install.mjs --uninstall    完整卸载（逐字节还原 index.html、删除载荷）');
  console.error('  node install.mjs --app <路径>   指定客户端位置（也接受裸路径参数）');
  console.error('  node install.mjs --help         只打印用法与路径推导结果，不落盘');
  console.error(`载荷：${PAYLOAD_FILES.map(([, to]) => `${PAYLOAD_DIR}/${to}`).join('、')}`);
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    usage();
    console.error('候选客户端目录：');
    for (const candidate of appRootCandidates()) {
      console.error(`  ${distDirOf(candidate)}${fs.existsSync(path.join(distDirOf(candidate), 'index.html')) ? '（存在）' : ''}`);
    }
    return;
  }

  let action = 'install';
  let appArg = '';
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--uninstall') action = 'uninstall';
    else if (arg === '--app') appArg = args[(i += 1)] || '';
    else if (arg.startsWith('--app=')) appArg = arg.slice('--app='.length);
    else if (!arg.startsWith('-')) appArg = arg; // 裸路径
  }

  const appRoot = appArg
    ? path.resolve(appArg)
    : appRootCandidates().find((candidate) => fs.existsSync(path.join(distDirOf(candidate), 'index.html'))) || '';
  if (!appRoot) {
    console.error('[install] 未找到 Kimi Code 桌面客户端（需要含 desktop-dist 的应用包）');
    console.error('[install] 若客户端装在其他位置：node install.mjs --app <客户端目录>，或设 KIMI_CODE_APP_DIR');
    process.exit(1);
  }

  const dist = distDirOf(appRoot);
  if (!fs.existsSync(dist)) {
    console.error(`[install] 未找到 ${dist}——请确认 --app 指向的是客户端安装目录`);
    process.exit(1);
  }
  console.error(`[install] 客户端：${appRoot}（v${readClientVersion(appRoot)}）`);
  if (action === 'uninstall') uninstall(dist);
  else install(dist);
}

// 直接执行时跑 CLI（被 import 时不跑）。先 realpath：macOS 的 /tmp 是符号链接，
// Node 会把主模块解析成真实路径写进 import.meta.url，argv[1] 却保留调用时的路径。
if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  main();
}
