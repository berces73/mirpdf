const CACHE_VERSION = "v1.0.2";
const STATIC_CACHE = `pdf-static-${CACHE_VERSION}`;
const RUNTIME_CACHE = `pdf-runtime-${CACHE_VERSION}`;

const MAX_RUNTIME_ENTRIES = 50;
const MAX_CACHE_AGE_DAYS = 7;

const STATIC_ASSETS = [
  "/",
  "/index.html",
  "/offline.html",
  "/manifest.json",
  "/assets/js/toast.js",
  "/assets/js/sw-register.js",
  "/favicon.ico"
];

function cacheTimeHeaders(res) {
  const headers = new Headers(res.headers);
  headers.set("sw-cached-at", String(Date.now()));
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

function isStale(res) {
  const t = res.headers.get("sw-cached-at");
  if (!t) return false;
  const age = Date.now() - Number(t);
  const maxAge = MAX_CACHE_AGE_DAYS * 24 * 60 * 60 * 1000;
  return age > maxAge;
}

async function cleanupRuntimeCache() {
  try {
    const cache = await caches.open(RUNTIME_CACHE);

    // 1) snapshot keys
    const keys = await cache.keys();

    // 2) limit
    if (keys.length > MAX_RUNTIME_ENTRIES) {
      const toDelete = keys.slice(0, keys.length - MAX_RUNTIME_ENTRIES);
      await Promise.all(toDelete.map((k) => cache.delete(k)));
    }

    // 3) stale check with fresh snapshot
    const currentKeys = await cache.keys();
    const staleList = await Promise.all(
      currentKeys.map(async (req) => {
        const res = await cache.match(req);
        return (res && isStale(res)) ? req : null;
      })
    );

    const stalesToDelete = staleList.filter(Boolean);
    if (stalesToDelete.length) {
      await Promise.all(stalesToDelete.map((req) => cache.delete(req)));
    }
  } catch (err) {
    console.error("[SW] Cleanup failed:", err);
  }
}

self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil((async () => {
    const cache = await caches.open(STATIC_CACHE);
    await Promise.allSettled(STATIC_ASSETS.map((u) => cache.add(u)));
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.map((k) => {
      if ((k.startsWith("pdf-static-") || k.startsWith("pdf-runtime-")) && !k.includes(CACHE_VERSION)) {
        return caches.delete(k);
      }
    }));

    await self.clients.claim();
    await cleanupRuntimeCache();

    const clients = await self.clients.matchAll();
    clients.forEach((c) => c.postMessage({ type: "SW_UPDATED", version: CACHE_VERSION }));
  })());
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") self.skipWaiting();
  if (event.data?.type === "CLEAR_CACHE") {
    event.waitUntil(
      caches.delete(RUNTIME_CACHE).then(() => {
        event.ports?.[0]?.postMessage({ success: true });
      })
    );
  }
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);

  if (req.method !== "GET") return;
  if (!url.protocol.startsWith("http")) return;
  if (url.pathname.startsWith("/api/")) return;

  const accept = req.headers.get("accept") || "";
  const isHTML = req.destination === "document" || accept.includes("text/html");

  if (isHTML) {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(req, { cache: "no-store" });
        if (fresh && fresh.ok) {
          const cache = await caches.open(RUNTIME_CACHE);
          await cache.put(req, cacheTimeHeaders(fresh.clone()));
          event.waitUntil(cleanupRuntimeCache());
        }
        return fresh;
      } catch {
        const cached = await caches.match(req);
        if (cached) return cached;
        const offline = await caches.match("/offline.html");
        return offline || new Response("Offline", { status: 503, headers: { "Content-Type": "text/html" } });
      }
    })());
    return;
  }

  event.respondWith((async () => {
    const cached = await caches.match(req);

    const update = fetch(req).then(async (res) => {
      if (res && res.ok) {
        const cache = await caches.open(RUNTIME_CACHE);
        await cache.put(req, cacheTimeHeaders(res.clone()));
        await cleanupRuntimeCache();
      }
      return res;
    }).catch(() => null);

    if (cached && !isStale(cached)) {
      event.waitUntil(update);
      return cached;
    }

    const fresh = await update;
    return fresh || cached || new Response("Offline", { status: 503 });
  })());
});
