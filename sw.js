self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  let payload = { title: "課表查詢", body: "" };
  try {
    if (event.data) payload = { ...payload, ...event.data.json() };
  } catch (e) {
    payload.body = event.data ? event.data.text() : "";
  }
  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      icon: "icons/icon-192.png?v=1",
      badge: "icons/icon-192.png?v=1",
      data: { url: payload.url || "/" },
    })
  );
});

// 通知帶的網址只允許本站（同源）：Worker 登記時已驗證過，這裡再擋一次（以防舊資料或日後漏驗證），不同源一律回首頁。
function sameOriginUrl(url) {
  try {
    const u = new URL(url, self.location.origin);
    return u.origin === self.location.origin ? u.href : "/";
  } catch (e) {
    return "/";
  }
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = sameOriginUrl((event.notification.data && event.notification.data.url) || "/");
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientsArr) => {
      const existing = clientsArr.find((c) => "focus" in c);
      // 已開著的分頁要導到登記通知當下那個查詢頁,不然只 focus 會停在原本畫面。
      if (existing) return ("navigate" in existing ? existing.navigate(targetUrl) : Promise.resolve(existing)).then((c) => c.focus());
      return self.clients.openWindow(targetUrl);
    })
  );
});
