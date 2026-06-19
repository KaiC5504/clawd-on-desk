const CACHE_NAME = "clawd-mobile-v15";
const STATIC_ASSETS = [
  "/mobile/",
  "/mobile/index.html",
  "/mobile/style.css",
  "/mobile/icons.js",
  "/mobile/i18n.js",
  "/mobile/jsqr.js",
  "/mobile/qr-scan.js",
  "/mobile/app.js",
  "/mobile/manifest.json",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      // Bypass the HTTP cache so a new SW version always precaches fresh assets.
      .then((cache) => cache.addAll(STATIC_ASSETS.map((u) => new Request(u, { cache: "reload" }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  // WS 请求不拦截
  if (event.request.url.includes("/ws")) return;

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((response) => {
        if (response.ok && response.type === "basic") {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      });
    }).catch(() => {
      if (event.request.destination === "document") {
        return caches.match("/mobile/index.html");
      }
    })
  );
});

// 推送：审批请求 → 系统通知
self.addEventListener("push", (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch {}
  const title = data.title || "需要审批 / Approval needed";
  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body || "",
      tag: data.tag || (data.handle ? "approval-" + data.handle : "clawd-approval"),
      icon: "/mobile/icons/icon-256.png",
      badge: "/mobile/icons/icon-256.png",
      data: { handle: data.handle || null, sessionId: data.sessionId || null },
    })
  );
});

// 通知点击：聚焦到已有窗口并深链到对应审批
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const handle = event.notification.data && event.notification.data.handle;
  const target = "/mobile/" + (handle ? "#approval=" + encodeURIComponent(handle) : "");
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if ("focus" in client) {
          if (handle) { try { client.postMessage({ type: "approval-focus", handle: handle }); } catch {} }
          return client.focus();
        }
      }
      return self.clients.openWindow(target);
    })
  );
});
