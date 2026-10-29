// 淺色／深色主題初始化。必須在 <head> 同步載入（不能 defer/async）：要趕在第一次繪製前把 data-theme 貼到 <html>，
// 否則選了深色的人每次開頁都會先閃一下白。Content-Security-Policy 不允許 inline script，所以獨立成外部檔（同 ga-init.js 的理由）。
// 預設淺色（不跟隨系統設定）；只有使用者按過「深色模式」才會在 localStorage 留下 wg_theme=dark。切換按鈕與存取在 script.js。
try {
  if (localStorage.getItem("wg_theme") === "dark") document.documentElement.setAttribute("data-theme", "dark");
} catch (e) { /* 取不到 localStorage（無痕、被瀏覽器擋住）就維持淺色 */ }
