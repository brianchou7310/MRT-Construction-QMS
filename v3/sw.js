/* 現場作業離線快取（Service Worker）
 * - 安裝時讀取 field.html，把它引用的 JS／CSS／圖片全部預先快取（版本字串 ?v= 變了就是新檔，自動更新）
 * - 開啟頁面：網路優先，失敗（離線）改用快取；靜態資源：快取優先，沒有才抓網路並存起來
 * - 只負責「App 能離線開啟」；資料本來就存在瀏覽器 IndexedDB */
const CACHE = 'qms3-shell-v3';
const PAGES = ['field.html'];
const EXTRA = ['manifest.webmanifest', 'images/logo.png', 'images/icon-192.png', 'images/icon-512.png'];

async function precache() {
  const c = await caches.open(CACHE), urls = new Set([...PAGES, ...EXTRA]);
  for (const p of PAGES) {   // 解析頁面引用的資源
    const html = await (await fetch(p, { cache: 'no-cache' })).text();
    for (const m of html.matchAll(/\s(?:src|href)="([^"#]+)"/g)) { const u = m[1]; if (!/^(https?:)?\/\//.test(u) && !u.startsWith('data:') && !/\.html(\?|$)/.test(u)) urls.add(u); }   // 只抓靜態資源（排除 Vue 綁定的 :src、連到其他頁面的連結）
  }
  const res = await Promise.all([...urls].map(u => c.add(new Request(u, { cache: 'reload' })).then(() => true, () => false)));   // 單一檔案失敗不擋安裝
  return { total: res.length, ok: res.filter(Boolean).length };
}
self.addEventListener('install', e => { e.waitUntil(precache().then(() => self.skipWaiting())); });
// 頁面要求重新快取（離線準備）：回報成功／總數
self.addEventListener('message', e => { if (e.data === 'refresh') e.waitUntil(precache().then(r => e.source && e.source.postMessage({ type: 'refreshed', ...r }), () => e.source && e.source.postMessage({ type: 'refreshed', total: 0, ok: 0 }))); });

self.addEventListener('activate', e => {
  e.waitUntil((async () => { for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k); await self.clients.claim(); })());
});

self.addEventListener('fetch', e => {
  const req = e.request; if (req.method !== 'GET') return;
  const url = new URL(req.url), same = url.origin === location.origin;
  // 字型（Google Fonts）：有就用、背景更新；離線時缺字型只會退回系統字型
  if (!same && /fonts\.(googleapis|gstatic)\.com$/.test(url.hostname)) {
    e.respondWith(caches.open(CACHE).then(async c => { const hit = await c.match(req); const net = fetch(req).then(r => { if (r.ok || r.type === 'opaque') c.put(req, r.clone()); return r; }).catch(() => hit); return hit || net; }));
    return;
  }
  if (!same) return;
  if (req.mode === 'navigate') {   // 頁面：網路優先，離線用快取（忽略 ?role= 等查詢字串）
    e.respondWith(fetch(req).then(r => { if (r.ok) caches.open(CACHE).then(c => c.put(req, r.clone())); return r; })
      .catch(async () => (await caches.match(req, { ignoreSearch: true })) || (await caches.match('field.html')) || Response.error()));
    return;
  }
  e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(r => { if (r.ok) caches.open(CACHE).then(c => c.put(req, r.clone())); return r; })
    .catch(async () => (await caches.match(req, { ignoreSearch: true })) || Response.error())));
});
