// sw.js — Listo service worker.
// The app is served under /api/listo/app/ — only these files are cached
// so the app can reopen with zero network. /api/listo/api/* calls always
// go to the network (fresh data); offline state lives in localStorage.
var CACHE = "listo-v95";
var SHELL = [
  "index.html",
  "style.css",
  "app.js",
  "i18n.js",
  "i18n/fr.js",
  "i18n/en.js",
  "jsbarcode.min.js",
  "quagga.min.js",
  "qrcode.min.js",
  "jsqr.min.js",
  "manifest.webmanifest",
  "img/icon.svg",
  "img/card.svg",
  "img/camera.svg",
  "img/settings.svg",
  "img/refresh-accent.svg",
  "img/check.svg",
  "img/close.svg",
  "img/close-muted.svg",
  "img/edit.svg",
  "img/link.svg",
  "img/plus.svg",
  "img/dish.svg",
  "img/drag.svg",
  "img/arrow-up.svg",
  "img/arrow-down.svg",
  "img/icon-192.png",
  "img/icon-512.png",
];

self.addEventListener("install", function (e) {
  e.waitUntil(
    caches.open(CACHE).then(function (c) { return c.addAll(SHELL); })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener("activate", function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        if (k !== CACHE) return caches.delete(k);
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener("fetch", function (e) {
  var url = new URL(e.request.url);

  // Never cache API data calls or non-GET requests.
  if (url.pathname.indexOf("/api/listo/api/") === 0 ||
      e.request.method !== "GET") {
    return;
  }

  // Navigations: network first, cached page as offline fallback.
  if (e.request.mode === "navigate") {
    e.respondWith(
      fetch(e.request).catch(function () { return caches.match("index.html"); })
    );
    return;
  }

  // App shell: cache first, network fallback + cache update.
  if (url.pathname.indexOf("/api/listo/app/") === 0) {
    e.respondWith(
      caches.match(e.request, { ignoreSearch: true }).then(function (hit) {
        if (hit) return hit;
        return fetch(e.request).then(function (resp) {
          if (resp.ok) {
            var clone = resp.clone();
            caches.open(CACHE).then(function (c) { c.put(e.request, clone); });
          }
          return resp;
        });
      })
    );
  }
});
