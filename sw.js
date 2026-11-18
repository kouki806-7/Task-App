const CACHE_VERSION = 'v126';
const STATIC_CACHE = `daily-flow-static-${CACHE_VERSION}`;
const CDN_CACHE = `daily-flow-cdn-${CACHE_VERSION}`;

const STATIC_ASSETS = [
    './',
    './index.html',
    './app.js?v=123',
    './style.css?v=124',
    './vendor/firebase-10.11.0/firebase-app-compat.js',
    './vendor/firebase-10.11.0/firebase-auth-compat.js',
    './vendor/firebase-10.11.0/firebase-firestore-compat.js',
    './manifest.json',
    './icon-192.png',
    './icon-512.png',
    './icon-maskable-192.png',
    './icon-maskable-512.png',
];

// Google API への通信（予定・ToDo・ログイン）はキャッシュしない
const CDN_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com'];

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
                keys.filter(k => k !== STATIC_CACHE && k !== CDN_CACHE).map(k => caches.delete(k))
            ))
            .then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', event => {
    const { request } = event;
    const url = new URL(request.url);
    if (request.method !== 'GET' || url.protocol === 'chrome-extension:') return;

    // 同じ github.io でも、このアプリのフォルダの外（ほかのリポジトリのページ）は扱わない
    const scopePath = new URL(self.registration.scope).pathname;
    const sameOrigin = url.origin === self.location.origin && url.pathname.startsWith(scopePath);
    const cdn = CDN_HOSTS.includes(url.hostname);
    if (!sameOrigin && !cdn) return;

    // 新しい版を優先し、オフライン時だけキャッシュを使う
    const cacheName = sameOrigin ? STATIC_CACHE : CDN_CACHE;
    event.respondWith(
        caches.open(cacheName).then(cache =>
            fetch(request)
                .then(response => {
                    if (response.ok || response.status === 0) cache.put(request, response.clone());
                    return response;
                })
                .catch(() => cache.match(request))
        )
    );
});
