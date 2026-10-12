// 海外 IP 的存取判斷：預設只開放台灣 IP，已知的搜尋引擎/AI 爬蟲只放行「唯讀」的少數路徑。
//
// ⚠ CRAWLER_UA_PATTERN 要跟 functions/_middleware.js 的同名常數保持同步：
// Pages Functions 與 Worker 是兩個獨立專案，沒辦法共用 import，改一邊記得改另一邊。
//
// 為什麼 Worker 也要放行：Googlebot 渲染頁面時，前端會從海外機房呼叫 /filterOptions、/issueToken、
// /queryClasses；Worker 若一律 403，爬蟲渲染出來的就是空課表。
// UA 可以偽造，但放行後能拿到的只是任何訪客都能公開查到的課表資料，而且 token 與每 IP 流量限制照舊，
// 所以只拿 UA 決定「放不放行」，不會因 UA 不同而回不同內容（避免 cloaking）。
export const CRAWLER_UA_PATTERN = /Googlebot|Google-InspectionTool|GoogleOther|Google-Extended|AdsBot-Google|Mediapartners-Google|APIs-Google|bingbot|BingPreview|Baiduspider|YandexBot|DuckDuckBot|GPTBot|ChatGPT-User|OAI-SearchBot|anthropic-ai|ClaudeBot|Claude-Web|Claude-SearchBot|Claude-User|PerplexityBot|Perplexity-User|MistralAI-User|CCBot|Bytespider|Amazonbot|Applebot|Meta-ExternalAgent|facebookexternalhit|LinkedInBot|Slackbot|TelegramBot|WhatsApp|Diffbot/i;

// 海外爬蟲唯一能碰的路徑（含允許的 HTTP method）。寫入型（/track*、/registerReminder、留言等）、
// 後台與統計端點一律不放行：Googlebot 渲染頁面會觸發前端打點，放行會污染統計。
// OPTIONS 一併放行：前端跨網域帶自訂 header（X-Query-Token），瀏覽器會先送 preflight，
// preflight 被擋整個請求就不會發出去。
const CRAWLER_ALLOWED_ROUTES = {
  "/filterOptions": ["GET", "OPTIONS"],
  "/issueToken": ["GET", "OPTIONS"],
  "/queryClasses": ["POST", "OPTIONS"],
};

// cf.country 沒有值（本機開發）一律放行，避免擋掉自己測試。
export function isRequestAllowed(req) {
  const country = req.cf?.country;
  if (!country || country === "TW") return true;
  const ua = req.headers.get("User-Agent") || "";
  if (!CRAWLER_UA_PATTERN.test(ua)) return false;
  const methods = CRAWLER_ALLOWED_ROUTES[new URL(req.url).pathname];
  return !!methods && methods.includes(req.method);
}
