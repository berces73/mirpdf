/**
 * MirPDF - SECURE Service Worker
 * ⚠️ CRITICAL: Prevents cache poisoning for PDF outputs
 * Version: 3.1.0 ENTERPRISE
 */

const CACHE_VERSION = 'v3.1.0';
const CACHE_NAME = `pdf-platform-${CACHE_VERSION}`;
const RUNTIME_CACHE = `runtime-${CACHE_VERSION}`;
const IMAGE_CACHE = `images-${CACHE_VERSION}`;

// Critical assets to precache
const PRECACHE_URLS = [
  '/',
  '/index.html',
  '/offline.html',
  '/style.css',
  '/manifest.json',
  '/assets/icons/icon-192x192.png',
  '/assets/icons/icon-512x512.png',
  '/assets/js/toast.js',
  '/assets/js/tool-page.js',
];

// ⚠️ CRITICAL: URLs that should NEVER be cached
const NEVER_CACHE_PATTERNS = [
  /\/pdf-output\//,           // PDF outputs
  /\/temp-pdfs\//,            // Temporary PDFs
  /\/api\//,                  // API calls
  /-temp\.pdf$/,              // Temp PDF files
  /-output\.pdf$/,            // Output PDF files
  /\/download\//,             // Download endpoints
  /sessionid=/,               // Session-specific
  /timestamp=/,               // Timestamped requests
  /user=/,                    // User-specific
  /private\//                 // Private content
];

// URLs that require fresh data
const NETWORK_ONLY_PATTERNS = [
  /\/api\//,
  /\/auth\//,
  /\/login/,
  /\/logout/,
  /\/profile/,
  /analytics/,
  /tracking/
];

/**
 * Check if URL should never be cached
 */
function shouldNeverCache(url) {
  return NEVER_CACHE_PATTERNS.some(pattern => pattern.test(url));
}

/**
 * Check if URL requires network-only
 */
function requiresNetworkOnly(url) {
  return NETWORK_ONLY_PATTERNS.some(pattern => pattern.test(url));
}

/**
 * Install Event
 */
self.addEventListener('install', event => {
  console.log('[SW] Installing version:', CACHE_VERSION);
  
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        console.log('[SW] Precaching critical assets');
        return cache.addAll(PRECACHE_URLS);
      })
      .then(() => {
        console.log('[SW] Installation complete');
        return self.skipWaiting();
      })
      .catch(error => {
        console.error('[SW] Installation failed:', error);
      })
  );
});

/**
 * Activate Event
 */
self.addEventListener('activate', event => {
  console.log('[SW] Activating version:', CACHE_VERSION);
  
  event.waitUntil(
    caches.keys()
      .then(cacheNames => {
        return Promise.all(
          cacheNames
            .filter(name => {
              return name.startsWith('pdf-platform-') && name !== CACHE_NAME ||
                     name.startsWith('runtime-') && name !== RUNTIME_CACHE ||
                     name.startsWith('images-') && name !== IMAGE_CACHE;
            })
            .map(name => {
              console.log('[SW] Deleting old cache:', name);
              return caches.delete(name);
            })
        );
      })
      .then(() => {
        console.log('[SW] Activation complete');
        return self.clients.claim();
      })
  );
});

/**
 * Fetch Event - SECURE
 */
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);
  
  // ⚠️ CRITICAL: Only handle GET requests
  if (request.method !== 'GET') {
    console.log('[SW] 🚫 Non-GET request (not cached):', request.method, url.pathname);
    return; // Don't cache POST, PUT, DELETE
  }
  
  // Skip non-http(s) requests
  if (!url.protocol.startsWith('http')) {
    return;
  }
  
  // ⚠️ CRITICAL: Never cache sensitive URLs
  if (shouldNeverCache(url.href)) {
    console.log('[SW] 🚫 Never cache:', url.pathname);
    return; // Always fetch from network
  }
  
  // Network-only for specific patterns
  if (requiresNetworkOnly(url.href)) {
    console.log('[SW] 🌐 Network only:', url.pathname);
    event.respondWith(fetch(request));
    return;
  }
  
  // Skip tracking/analytics
  if (url.hostname.includes('analytics') || 
      url.hostname.includes('googletagmanager') ||
      url.hostname.includes('facebook.com') ||
      url.hostname.includes('google-analytics.com')) {
    return;
  }
  
  // Determine strategy
  const strategy = determineStrategy(request, url);
  event.respondWith(handleRequest(request, strategy));
});

/**
 * Determine caching strategy
 */
function determineStrategy(request, url) {
  // Images - cache first
  if (request.destination === 'image') {
    return 'cache-first';
  }
  
  // Static assets - cache first
  if (request.destination === 'style' || 
      request.destination === 'script' || 
      request.destination === 'font') {
    return 'cache-first';
  }
  
  // Documents/HTML - network first
  if (request.destination === 'document') {
    return 'network-first';
  }
  
  // Default - stale while revalidate
  return 'stale-while-revalidate';
}

/**
 * Handle Request
 */
async function handleRequest(request, strategy) {
  switch (strategy) {
    case 'cache-first':
      return cacheFirst(request);
    case 'network-first':
      return networkFirst(request);
    case 'stale-while-revalidate':
      return staleWhileRevalidate(request);
    default:
      return fetch(request);
  }
}

/**
 * Cache First Strategy
 */
async function cacheFirst(request) {
  const cacheName = request.destination === 'image' ? IMAGE_CACHE : CACHE_NAME;
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  
  if (cached) {
    return cached;
  }
  
  try {
    const response = await fetch(request);
    
    // ⚠️ SECURITY: Only cache successful responses
    if (response.ok && response.status === 200) {
      // ⚠️ SECURITY: Don't cache if response has Set-Cookie
      if (!response.headers.has('Set-Cookie')) {
        cache.put(request, response.clone());
      }
    }
    
    return response;
  } catch (error) {
    console.error('[SW] Cache first failed:', error);
    
    if (request.destination === 'document') {
      const offlinePage = await cache.match('/offline.html');
      if (offlinePage) return offlinePage;
    }
    
    return new Response('Offline - Asset not available', { 
      status: 503,
      statusText: 'Service Unavailable',
      headers: { 'Content-Type': 'text/plain' }
    });
  }
}

/**
 * Network First Strategy
 */
async function networkFirst(request) {
  const cache = await caches.open(RUNTIME_CACHE);
  
  try {
    const response = await fetch(request);
    
    // ⚠️ SECURITY: Only cache safe responses
    if (response.ok && response.status === 200) {
      const url = new URL(request.url);
      
      // ⚠️ Don't cache if:
      // - Has tracking parameters
      // - Has Set-Cookie
      // - Is personalized content
      if (!url.search.includes('utm_') && 
          !url.search.includes('fbclid') && 
          !url.search.includes('gclid') &&
          !response.headers.has('Set-Cookie') &&
          !response.headers.get('Vary')?.includes('Cookie')) {
        cache.put(request, response.clone());
      }
    }
    
    return response;
  } catch (error) {
    console.error('[SW] Network first failed, trying cache:', error);
    
    const cached = await cache.match(request);
    
    if (cached) {
      return cached;
    }
    
    if (request.destination === 'document') {
      const offlinePage = await caches.open(CACHE_NAME);
      const offline = await offlinePage.match('/offline.html');
      if (offline) return offline;
    }
    
    return new Response('Offline', { 
      status: 503,
      statusText: 'Service Unavailable',
      headers: { 'Content-Type': 'text/plain' }
    });
  }
}

/**
 * Stale While Revalidate Strategy
 */
async function staleWhileRevalidate(request) {
  const cache = await caches.open(RUNTIME_CACHE);
  const cached = await cache.match(request);
  
  const fetchPromise = fetch(request).then(response => {
    if (response.ok && response.status === 200) {
      // ⚠️ SECURITY: Same checks as above
      const url = new URL(request.url);
      if (!url.search.includes('utm_') &&
          !response.headers.has('Set-Cookie')) {
        cache.put(request, response.clone());
      }
    }
    return response;
  }).catch(error => {
    console.error('[SW] Stale while revalidate update failed:', error);
    return cached;
  });
  
  return cached || fetchPromise;
}

/**
 * Background Sync
 */
self.addEventListener('sync', event => {
  console.log('[SW] Background sync:', event.tag);
  
  if (event.tag === 'sync-analytics') {
    event.waitUntil(syncAnalytics());
  }
});

async function syncAnalytics() {
  console.log('[SW] Syncing analytics data...');
  // Placeholder for analytics sync
}

/**
 * Push Notifications
 */
self.addEventListener('push', event => {
  const data = event.data ? event.data.json() : {};
  
  const options = {
    body: data.body || 'Yeni özellikler ve güncellemeler mevcut!',
    icon: '/assets/icons/icon-192x192.png',
    badge: '/assets/icons/badge-72x72.png',
    vibrate: [200, 100, 200],
    tag: data.tag || 'general-notification',
    requireInteraction: false,
    data: {
      url: data.url || '/',
      dateOfArrival: Date.now()
    },
    actions: [
      { action: 'open', title: 'Aç' },
      { action: 'close', title: 'Kapat' }
    ]
  };
  
  event.waitUntil(
    self.registration.showNotification(
      data.title || 'MirPDF',
      options
    )
  );
});

/**
 * Notification Click Handler
 */
self.addEventListener('notificationclick', event => {
  const notification = event.notification;
  const action = event.action;
  
  notification.close();
  
  if (action === 'close') return;
  
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUnmerged: true })
      .then(clientList => {
        for (let client of clientList) {
          if (client.url === notification.data.url && 'focus' in client) {
            return client.focus();
          }
        }
        if (clients.openWindow) {
          return clients.openWindow(notification.data.url);
        }
      })
  );
});

/**
 * Message Handler
 */
self.addEventListener('message', event => {
  console.log('[SW] Message received:', event.data);
  
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
  
  if (event.data && event.data.type === 'CACHE_URLS') {
    event.waitUntil(
      caches.open(RUNTIME_CACHE)
        .then(cache => cache.addAll(event.data.urls))
    );
  }
  
  if (event.data && event.data.type === 'CLEAR_CACHE') {
    event.waitUntil(
      caches.keys().then(names => {
        return Promise.all(
          names.map(name => caches.delete(name))
        );
      })
    );
  }
});

/**
 * Cache Size Management
 */
async function limitCacheSize(cacheName, maxItems) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  
  if (keys.length > maxItems) {
    await cache.delete(keys[0]);
    await limitCacheSize(cacheName, maxItems);
  }
}

// Clean up periodically
setInterval(() => {
  limitCacheSize(IMAGE_CACHE, 100);
  limitCacheSize(RUNTIME_CACHE, 50);
}, 3600000); // Every hour

/**
 * Error Handler
 */
self.addEventListener('error', (event) => {
  console.error('[SW Error]', event.error);
  
  // Send to error tracking
  fetch('/api/errors/sw', {
    method: 'POST',
    body: JSON.stringify({
      type: 'sw_error',
      message: event.error.message,
      stack: event.error.stack,
      timestamp: new Date().toISOString()
    }),
    keepalive: true
  }).catch(() => {});
});

self.addEventListener('unhandledrejection', (event) => {
  console.error('[SW Unhandled Rejection]', event.reason);
  
  fetch('/api/errors/sw', {
    method: 'POST',
    body: JSON.stringify({
      type: 'sw_rejection',
      reason: String(event.reason),
      timestamp: new Date().toISOString()
    }),
    keepalive: true
  }).catch(() => {});
});

console.log('[SW] Service Worker loaded successfully (SECURE)');
