/* Minimal service worker: app shell cached, API always network-first */
const CACHE = "vt-shell-v16";
/* config.js is deliberately NOT cached: you edit it and expect the new
   Worker URL to take effect immediately after a GitHub Pages update. */
const SHELL = ["./", "./index.html", "./style.css", "./app.js", "./icon.svg", "./manifest.json"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);

  // never cache API calls or config.js
  if (url.pathname.startsWith("/api/")) return;
  if (url.pathname.endsWith("/config.js")) return;

  e.respondWith(
    caches.match(e.request).then((hit) => hit || fetch(e.request).then((res) => {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
      return res;
    }).catch(() => caches.match("./index.html")))
  );
});
