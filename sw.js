// sw.js - تخزين مؤقت بسيط: الشبكة أولاً، ثم النسخة المخزنة إذا انقطع الاتصال
const V = 'lima-v3';
const SHELL = ['index.html', 'product.html', 'cart.html', 'offline.html', 'style.css', 'app.js', 'config.js',
  'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(V).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== V).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;   // Supabase والخطوط والصور الخارجية: بدون تدخل
  if (url.pathname.endsWith('/alfa.html')) return;                      // الأدمن ما بينخزن
  e.respondWith(
    fetch(req).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(V).then(c => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req, { ignoreSearch: true }).then(r =>
      r || (req.mode === 'navigate' ? caches.match('offline.html') : Response.error())))
  );
});
