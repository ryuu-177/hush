// Hush service worker（v0.8，v0.14 起也缓存背景图、字体和 lq-glass.js）
// - 只缓存“外壳”：首页、离线页、图标、manifest。聊天、接口、文件一律不缓存，永远走网络。
// - 首页“网络优先”：能连上就用最新的（升级立刻生效），连不上才显示离线页。
// - 缓存名带版本号，新版本上线后旧缓存自动删除。
const VERSION = '__APP_VERSION__';
const CACHE = 'hush-shell-' + VERSION;
const SHELL = [
  '/offline.html', '/manifest.webmanifest',
  '/icons/favicon.svg', '/icons/favicon-32.png', '/icons/icon-192.png', '/icons/icon-512.png',
  '/icons/maskable-192.png', '/icons/apple-touch-icon.png', '/icons/badge-96.png',
  '/lq-glass.js', '/bg/hush-light.svg', '/bg/hush-dark.svg', '/bg/hush-m-light.svg', '/bg/hush-m-dark.svg',
  '/fonts/font-001.woff2', '/fonts/font-002.woff2', '/fonts/font-003.woff2'
];
// 中文字体按需加载（63 个分片，用到哪片下哪片）：第一次用到时存进缓存，以后直接从本机读。换版本时随旧缓存一起清掉。
const FONTS = /^\/fonts\/(lyric\/)?[\w-]+\.(woff2|css)$/;   // v0.19：歌词字体也按需缓存
// 永远不经过缓存的路径
const BYPASS = /^\/(socket\.io|api|uploads)(\/|$)/;

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL.map(u => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith('hush-shell-') && k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

// 服务器关机时 Cloudflare 会返回 502 / 530 之类的错误页，也当作“连不上”
const down = r => !r || r.status >= 500;

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin || BYPASS.test(url.pathname)) return;

  // v0.18：页面导航不经过 service worker，直接请求服务器（服务器按桌面版的 User-Agent 决定给聊天程序还是门户；断网时桌面版自己显示离线页）
  if (req.mode === 'navigate') return;

  if (FONTS.test(url.pathname) && !SHELL.includes(url.pathname)) {
    e.respondWith((async () => {
      const c = await caches.open(CACHE), hit = await c.match(req, { ignoreSearch: true });
      if (hit) return hit;
      const r = await fetch(req);
      if (r.ok) c.put(req, r.clone()).catch(() => {});
      return r;
    })());
    return;
  }

  if (SHELL.includes(url.pathname)) {
    // 外壳资源：先用缓存，同时后台更新
    e.respondWith((async () => {
      const c = await caches.open(CACHE), hit = await c.match(req, { ignoreSearch: true });
      const net = fetch(req).then(r => { if (r.ok) c.put(req, r.clone()); return r; }).catch(() => null);
      return hit || (await net) || Response.error();
    })());
  }
});

// v0.18：不再处理系统通知（桌面版用系统通知，网页版不能聊天）
self.addEventListener('message', e => { if (e.data === 'skipWaiting') self.skipWaiting(); });
