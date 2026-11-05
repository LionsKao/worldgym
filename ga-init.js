// GA4 初始化。原本是 index.html 開頭的 inline script，為了讓 Content-Security-Policy 的 script-src 不必放行
// 'unsafe-inline'（見 _headers）搬成外部檔。必須在 <head> 同步載入（不能 defer/async）：script.js 的 trackEvent
// 用 typeof gtag === "function" 判斷，gtag 要在它執行前就存在。
window.dataLayer = window.dataLayer || [];
function gtag(){dataLayer.push(arguments);}
gtag('js', new Date());
gtag('config', 'G-Q7NZN45T0D');
window.addEventListener('load', function () {
  var s = document.createElement('script');
  s.async = true;
  s.src = 'https://www.googletagmanager.com/gtag/js?id=G-Q7NZN45T0D';
  document.head.appendChild(s);
});
