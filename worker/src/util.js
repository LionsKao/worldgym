// Worker 各檔案共用的小工具：台灣時間、短雜湊、爬官網用的 User-Agent、推 Teams 訊息。
// 以前這些各自複製在 index.js / scrape.js / reminders.js / queryClasses.js / branchScan.js 裡，
// 改一份容易漏另一份（連註解都寫著「跟 xxx.js 同一套」）。
// 這個檔案也會被 functions/（Pages Functions）直接 import，所以只放不依賴 Worker 綁定的純函式。

// 台灣沒有日光節約時間，固定 UTC+8。
const TAIWAN_OFFSET_MS = 8 * 3600 * 1000;

// 「台灣牆上時鐘」：把現在往後位移 8 小時（再加上 offsetMs），之後用 getUTC*() 讀出來就是台灣的年月日時分。
export function taiwanClock(offsetMs = 0) {
  return new Date(Date.now() + TAIWAN_OFFSET_MS + offsetMs);
}

// D1 裡存的時間戳一律用台灣時間（+08:00），不是 UTC —— 純位移 8 小時再貼 +08:00 後綴，
// 這樣才能跟其他時間戳直接用字串比較/排序。不用 Intl.DateTimeFormat 是因為那個格式化起來反而更囉唆。
// offsetMs 可正可負，例如 taiwanIso(-90 * 86400000) 是 90 天前的台灣時間。
export function taiwanIso(offsetMs = 0) {
  return taiwanClock(offsetMs).toISOString().replace("Z", "+08:00");
}
export function nowTaiwanIso() {
  return taiwanIso();
}

// 台灣今天的日期（YYYY-MM-DD）。用 Asia/Taipei 而不是執行環境的 UTC，避免台北時間 00:00~08:00
// 這段區間算出「昨天」，導致查詢範圍少了今天的課、或爬蟲抓到的資料整批往前錯位一天。
export function todayIsoTaipei() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei" }).format(new Date());
}
export function addDaysIso(iso, days) {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function pad2(n) {
  return String(n).padStart(2, "0");
}

// Workers 的 Web Crypto 沒有 MD5，這裡只是要一組穩定、大致不重複的短字串接在 id 後面做區隔，
// 不是安全用途，FNV-1a 這種非加密雜湊就夠用。
export function fnv1aHex(str) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

// 爬官網（課表與 sitemap）時用的 User-Agent：跟舊版 C# 爬蟲打這個端點時用的一樣，
// 沒有瀏覽器特徵的請求會被官網拒絕。
export const SCRAPER_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36";

// 把一組 AdaptiveCard 區塊（body）推到 Teams 頻道 webhook，回傳 fetch 的 Response 讓呼叫端自己看 ok/status。
// 不檢查 env.TEAMS_WEBHOOK_URL 有沒有設：沒設的處理方式由呼叫端決定（月度掃描是靜靜略過，留言是回錯誤）。
export function postTeamsCard(env, body) {
  return fetch(env.TEAMS_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type: "AdaptiveCard",
      $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
      version: "1.4",
      body,
    }),
  });
}
