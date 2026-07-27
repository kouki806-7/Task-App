const CACHE_VERSION = 'v6';
const STATIC_CACHE = `daily-flow-static-${CACHE_VERSION}`;
const CDN_CACHE = `daily-flow-cdn-${CACHE_VERSION}`;

const STATIC_ASSETS = [
    './',
    './index.html',
    './app.js?v=68',
    './style.css?v=24',
    './manifest.json',
    './icon.jpg',
    './icon-192.png',
    './icon-512.png',
];

const CDN_HOSTS = [
    'www.gstatic.com',
    'fonts.googleapis.com',
    'fonts.gstatic.com',
    'apis.google.com',
    'accounts.google.com',
];

self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(STATIC_CACHE)
            .then(cache => cache.addAll(STATIC_ASSETS))
            .then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys()
            .then(keys => Promise.all(
                keys
                    .filter(k => k !== STATIC_CACHE && k !== CDN_CACHE)
                    .map(k => caches.delete(k))
            ))
            .then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', event => {
    const { request } = event;
    const url = new URL(request.url);

    if (request.method !== 'GET' || url.protocol === 'chrome-extension:') return;

    if (url.origin === self.location.origin) {
        event.respondWith(
            caches.open(STATIC_CACHE).then(cache =>
                cache.match(request).then(cached => {
                    const networkFetch = fetch(request).then(response => {
                        if (response.ok) cache.put(request, response.clone());
                        return response;
                    }).catch(() => null);
                    return cached || networkFetch;
                })
            )
        );
        return;
    }

    if (CDN_HOSTS.some(h => url.hostname.endsWith(h))) {
        event.respondWith(
            caches.open(CDN_CACHE).then(cache =>
                cache.match(request).then(cached => {
                    const networkFetch = fetch(request).then(response => {
                        if (response.status === 0 || response.ok) {
                            cache.put(request, response.clone());
                        }
                        return response;
                    }).catch(() => null);
                    return cached || networkFetch;
                })
            )
        );
        return;
    }
});
