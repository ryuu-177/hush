// Hush v__APP_VERSION__：浏览器版的 service worker 只做一件事——把自己注销掉。
// 从 v0.18 起网页只用来登录 / 注册 / 看个人信息，不再缓存聊天程序、不再弹通知、不再能安装成 PWA。
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith('hush-shell-')) await caches.delete(k);
    await self.registration.unregister();
    for (const c of await self.clients.matchAll({ type: 'window' })) c.navigate(c.url).catch(() => {});
  })());
});
