// 非阻塞載入 Font Awesome CSS：<head> 裡的 <link rel="preload" as="style"> 負責提早開始下載，
// 這支腳本再用 JS 插入同一個網址的 <link rel="stylesheet">——動態插入的樣式表不會擋住渲染，
// 而且會重用預載的資源，不會下載第二次。
// 原本是在 preload 的 link 寫 onload="this.rel='stylesheet'"，那是 inline 事件處理，
// Content-Security-Policy（見 _headers）不放行 'unsafe-inline' 就會被擋、圖示 CSS 永遠不套用。
// 也不能改成「監聽 load 事件」：預載資源來自快取時，load 在這支腳本執行之前就觸發了，監聽器掛太晚。
// 必須放在這些 <link> 之後、同步載入（不能 defer/async）。
document.querySelectorAll('link[rel="preload"][as="style"]').forEach(function (preload) {
  var sheet = document.createElement('link');
  sheet.rel = 'stylesheet';
  sheet.href = preload.href;
  if (preload.integrity) sheet.integrity = preload.integrity;
  if (preload.crossOrigin !== null) sheet.crossOrigin = preload.crossOrigin;
  document.head.appendChild(sheet);
});
