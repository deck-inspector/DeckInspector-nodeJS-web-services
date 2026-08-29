/* E3 web app - photo cache service worker (David, Aug 29 2026: "inspection
   information and photos were supposed to load one time and stay local").

   Scope: PHOTOS ONLY. This worker never caches the app page, scripts or API
   data - those must always be live so a deploy is never masked by a stale copy.

   What is cached: GET requests to Azure Blob storage (originals and the banked
   t320- thumbnails) and the backend's /api/image/thumb proxy. First load fetches
   and stores; every later load is served from the cache on this computer.

   Release / recall: the page posts {type:'evict', stems:[...]} (photo file
   names of one project) when "Report sent to client" is ticked or a project is
   marked complete; the matching entries are deleted. Opening the project again
   simply re-fetches and re-caches - nothing else to do. {type:'evictAll'}
   clears the whole photo cache.

   Opaque responses: storage has no CORS, so a cross-origin <img> fetch yields a
   status-less "opaque" response. A missing thumbnail (404) would look identical
   to a real one, so opaque responses are cached ONLY for originals (which always
   exist); thumbnails are cached when the response is readable (same-origin
   proxy, or storage once CORS is enabled). */
const CACHE = 'e3-photos-v1';
const BLOB_RE = /^https:\/\/[^/]*\.blob\.core\.windows\.net\//i;
const PROXY_RE = /\/api\/image\/thumb\?/i;

function isPhoto(url) { return BLOB_RE.test(url) || PROXY_RE.test(url); }
function isOriginalBlob(url) {
  if (!BLOB_RE.test(url)) return false;
  try { return !/^t\d+-/i.test(decodeURIComponent(new URL(url).pathname.split('/').pop() || '')); }
  catch (e) { return false; }
}

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || !isPhoto(req.url)) return;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(req.url, { ignoreVary: true, ignoreSearch: false });
    // An opaque (pre-CORS) entry can only satisfy a no-cors request (<img>);
    // a CORS-mode request would reject it, so refetch and replace it instead.
    if (hit && !(hit.type === 'opaque' && req.mode === 'cors')) return hit;
    // Prefer a readable (CORS) response so we can tell 200 from 404.
    let res = null;
    if (BLOB_RE.test(req.url)) {
      try { res = await fetch(req.url, { mode: 'cors', credentials: 'omit' }); } catch (err) { res = null; }
    }
    if (!res) res = await fetch(req);
    if (res && res.status === 200) {
      cache.put(req.url, res.clone()).catch(() => {});
    } else if (res && res.type === 'opaque' && isOriginalBlob(req.url)) {
      cache.put(req.url, res.clone()).catch(() => {});
    }
    return res;
  })());
});

self.addEventListener('message', (e) => {
  const m = (e && e.data) || {};
  if (m.type === 'evict' && Array.isArray(m.stems) && m.stems.length) {
    e.waitUntil((async () => {
      const cache = await caches.open(CACHE);
      const keys = await cache.keys();
      let n = 0;
      for (const k of keys) {
        let u = k.url;
        try { u = decodeURIComponent(u); } catch (err) { /* keep raw */ }
        if (m.stems.some((s) => s && u.includes(s))) { await cache.delete(k); n++; }
      }
      if (e.source && e.source.postMessage) e.source.postMessage({ type: 'evicted', count: n });
    })());
  } else if (m.type === 'evictAll') {
    e.waitUntil(caches.delete(CACHE));
  }
});
