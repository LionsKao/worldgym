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
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(async (clientsArr) => {
      const existing = clientsArr.find((c) => "focus" in c);
      if (!existing) return self.clients.openWindow(targetUrl);
      // 已開著的分頁要導到登記通知當下那個查詢頁,不然只 focus 會停在原本畫面。
      // navigate() 只對「受這個 service worker 控制」的分頁有效：不是的話會被拒絕、同源以外或其他情況會回 null。
      // 被拒絕就退回開新視窗；回 null 就只 focus 原本的分頁——不能讓點了通知卻完全沒反應。
      let target = existing;
      if ("navigate" in existing) {
        try {
          target = (await existing.navigate(targetUrl)) || existing;
        } catch (e) {
          return self.clients.openWindow(targetUrl);
        }
      }
      return target.focus();
    })
  );
});
