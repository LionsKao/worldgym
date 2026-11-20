// 載入保險：#loadingOverlay 是不透明的全螢幕遮罩，只有 script.js 的 init() 會把它拿掉。
// script.js／common.js 載不到、整支語法錯誤（太舊的瀏覽器不認得 ?. 之類的語法）、頂層丟例外、網路卡住，
// 使用者都只會看到永遠轉不停的載入動畫，沒有任何東西可以按。這支腳本在 common.js、script.js 之前載入，
// 遮罩還在時（確定載入失敗，或等超過 SLOW_MS）就在遮罩上加一行說明與「重新整理」鈕。
// 它不會移除遮罩：script.js 後來載入成功、init() 收掉遮罩時，提示是遮罩的子元素，會跟著消失。
// Content-Security-Policy 不允許 inline script，所以獨立成外部檔（同 ga-init.js、theme-init.js 的理由）；
// 提示的樣式用 inline style 寫在這裡、不靠 style.css——style.css 載入失敗時，遮罩也是一片空白，提示更需要自己顯示得出來。
(function () {
  var SLOW_MS = 10000; // 遮罩蓋了這麼久還沒收，就顯示「比預期久」；init() 蓋著遮罩時每個等待最多約 6 秒，正常載入不會碰到
  // 用換行（下面 white-space:pre-line）把一句話切成兩行，手機寬度才不會從詞的中間斷開（例如「瀏覽／器」）。
  var MSG_SLOW = "載入時間比預期久，\n請檢查網路後重新整理";
  var MSG_FAILED = "頁面載入失敗，\n請檢查網路後重新整理，或更新瀏覽器版本";
  var OUR_SCRIPT = /\/(?:common|script)\.js(?:[?#]|$)/;
  var textEl = null;

  function show(text) {
    try {
      var overlay = document.getElementById("loadingOverlay");
      if (!overlay || overlay.classList.contains("fade-out")) return; // 已經在收遮罩了，不用提示
      if (textEl) { textEl.textContent = text; return; } // 已經顯示過（例如先「比預期久」、後來確定失敗）：換字就好
      var box = document.createElement("div");
      box.id = "loadGuard";
      box.setAttribute("role", "status");
      // 定位在遮罩正中央下方：遮罩裡的載入動畫是垂直置中的，這裡不依賴它的版面（style.css 沒載入時它不是 flex）。
      box.style.cssText = "position:absolute;left:0;right:0;top:calc(50% + 28px);padding:0 24px;text-align:center;white-space:pre-line;font-size:14px;line-height:1.6;color:var(--ink,#2b2b2b);";
      textEl = document.createElement("div");
      textEl.textContent = text;
      var btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = "重新整理";
      btn.style.cssText = "margin-top:12px;padding:8px 22px;border:0;border-radius:999px;background:var(--ink,#2b2b2b);color:var(--paper,#fff);font:inherit;font-weight:700;cursor:pointer;";
      btn.addEventListener("click", function () { location.reload(); });
      box.appendChild(textEl);
      box.appendChild(btn);
      overlay.appendChild(box);
    } catch (e) { /* 這支只是保險，自己出錯就算了，不能影響其他腳本 */ }
  }

  // capture 階段才聽得到「<script> 載入失敗」（資源錯誤不會冒泡）；同一個監聽也收得到 script.js／common.js 的語法錯誤與頂層例外。
  window.addEventListener("error", function (e) {
    try {
      var t = e.target;
      var isResource = t && t !== window && t.tagName === "SCRIPT" && OUR_SCRIPT.test(t.src || "");
      var isThrown = (!t || t === window) && OUR_SCRIPT.test(e.filename || "");
      if (isResource || isThrown) show(MSG_FAILED);
    } catch (err) { /* 同上 */ }
  }, true);

  setTimeout(function () { show(MSG_SLOW); }, SLOW_MS);
})();
