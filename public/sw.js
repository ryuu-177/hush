// Hush service worker（v0.8）
// - 只缓存“外壳”：首页、离线页、图标、manifest。聊天、接口、文件一律不缓存，永远走网络。
// - 首页“网络优先”：能连上就用最新的（升级立刻生效），连不上才显示离线页。
// - 缓存名带版本号，新版本上线后旧缓存自动删除。
const VERSION = '__APP_VERSION__';
const CACHE = 'hush-shell-' + VERSION;
const SHELL = [
  '/', '/offline.html', '/manifest.webmanifest',
  '/icons/favicon.svg', '/icons/favicon-32.png', '/icons/icon-192.png', '/icons/icon-512.png',
  '/icons/maskable-192.png', '/icons/apple-touch-icon.png', '/icons/badge-96.png'
];
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

  if (req.mode === 'navigate') {
    e.respondWith((async () => {
      let r = null;
      try { r = await fetch(req, { cache: 'no-store' }); } catch (_) {}
      if (!down(r)) {
        if (r.ok && url.pathname === '/') caches.open(CACHE).then(c => c.put('/', r.clone())).catch(() => {});
        return r;
      }
      return (await caches.match('/offline.html')) || r || Response.error();
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

// 点系统通知：已有窗口就切过去并定位到那条消息，没有就打开 Hush
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const id = e.notification.data && e.notification.data.id;
  e.waitUntil((async () => {
    const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const w = list.find(c => new URL(c.url).origin === location.origin);
    if (w) { await w.focus().catch(() => {}); w.postMessage({ type: 'open', id }); return; }
    await self.clients.openWindow('/' + (id ? '?msg=' + id : ''));
  })());
});

self.addEventListener('message', e => { if (e.data === 'skipWaiting') self.skipWaiting(); });
