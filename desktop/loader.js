/* 桌面客户端补丁 loader：由 desktop-dist/index.html 末尾的
   <script src="/kuh/loader.js?v=N"> 引入（N 为载荷内容哈希，Electron 子资源
   缓存不发校验头，只能靠查询参数穿透）。
   职责：解析客户端本地服务 origin / 在会话页注入状态条的样式与模块 / 用
   看门狗保证 SPA 重绘后仍在。数据由 hud-app.js 直连本地 REST API 读取。 */
(() => {
  'use strict';

  const HUD_CSS = '/kuh/styles/hud.css';
  const HUD_APP = '/kuh/desktop/hud-app.js';
  const SESSION_PATH = /^\/sessions\/[^/?#]+/;
  const WATCHDOG_MS = 1000;

  // 自身版本号：改版只改 index.html 里的 ?v=N，子资源全跟着它走。
  let V = '0';
  try {
    V = new URL(document.currentScript.src).searchParams.get('v') || '0';
  } catch (e) {
    /* 取不到就用 0，只影响缓存穿透 */
  }

  // 客户端本地服务（kap）源三级获取，与客户端 SPA 自身的定位方式一致：
  // ① URL 的 kimi_origin——主进程每次加载页面时拼入（重启换端口自动跟随）；
  // ② sessionStorage['kimi-desktop-server-origin']——Cmd+R 重载后 URL 不再带参数；
  // ③ localStorage 缓存——跨客户端重启（重启后 ① 会写入新值覆盖）。
  try {
    const urlOrigin = new URLSearchParams(location.search).get('kimi_origin');
    if (urlOrigin) localStorage.setItem('kuh.kapOrigin', urlOrigin);
    window.__kuhKapOrigin =
      urlOrigin ||
      sessionStorage.getItem('kimi-desktop-server-origin') ||
      localStorage.getItem('kuh.kapOrigin') ||
      location.origin;
  } catch (e) {
    window.__kuhKapOrigin = location.origin;
  }

  const isSessionPage = () => SESSION_PATH.test(location.pathname);

  const ensureStyles = () => {
    if (document.querySelector('link[data-kuh-styles]')) return;
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = `${HUD_CSS}?v=${V}`;
    link.setAttribute('data-kuh-styles', '');
    document.head.appendChild(link);
  };

  const boot = () => {
    if (!document.head || !isSessionPage()) return;
    // 桌面端的页面视口从窗口顶部开始（标题/标签条在页面之上），hud.css 据此下移状态条
    document.documentElement.setAttribute('data-kuh-desktop', '1');
    ensureStyles();
    if (window.__kuhInjected) return;
    window.__kuhInjected = true;
    const app = document.createElement('script');
    app.type = 'module';
    app.src = `${HUD_APP}?v=${V}`;
    document.head.appendChild(app);
  };

  // 看门狗：SPA 从首页切进会话页时补注入；状态条被重绘摘掉时补挂。
  // __kuhRemount 由 hud-app.js 装配后写入。
  window.__kuhRemount = null;
  setInterval(() => {
    if (!isSessionPage()) return;
    boot();
    if (typeof window.__kuhRemount === 'function' && !document.getElementById('kimi-usage-hud')) {
      window.__kuhRemount();
    }
  }, WATCHDOG_MS);

  boot();
})();
