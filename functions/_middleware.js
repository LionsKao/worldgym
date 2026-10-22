import { CRAWLER_UA_PATTERN } from "../worker/src/crawlers.js";

// 只開放台灣 IP：cf.country 沒有值(如本機開發)就放行，避免擋掉自己測試。
// 已知的搜尋引擎/AI/社群預覽爬蟲另外放行（不限地區），不然 Google/AI 爬蟲多半從海外機房發request，
// 光靠 robots.txt 是擋不住這層 IP 限制的，永遠爬不到內容。User-Agent 可以偽造，但這裡放行後看到的
// 也只是原本任何訪客都能公開查到的課表資料，偽造成本大於利益，風險可接受。
// UA 清單（CRAWLER_UA_PATTERN）直接 import 自 worker/src/crawlers.js，Worker 與 Pages 共用同一份，
// 要增減爬蟲只改那裡（Pages Functions 打包時本來就會把 import 的 worker/src 檔案一起包進去）。
// Google-InspectionTool：Search Console「網址審查／即時測試」用的 UA，不含 Googlebot 字樣，
// 之前沒放行導致從海外機房發出的即時測試一律 403（GoogleOther 是 Google 另一支通用爬蟲，一併補上）。

// robots.txt / sitemap.xml / llms.txt 本來就是公開給爬蟲與 AI 讀的，一律放行，不看 UA 也不看 IP：
// Search Console 抓 sitemap 的 UA 不一定在上面的白名單內，海外抓取被 403 會顯示「無法讀取 Sitemap」；
// llms.txt 是給各家 AI 讀的站點摘要，AI 的抓取 UA 五花八門、清單永遠追不完，擋了就沒有意義。
// 這三個檔只放摘要與分店網址索引，都是任何訪客本來就能公開查到的資訊。
// /sitemap-static.xml：暫時的對照用靜態 sitemap（內容是某一刻的動態 sitemap 快照），用來診斷 Search Console
// 一直顯示「無法讀取 Sitemap」是不是動態 Function 造成的；問題釐清後連同根目錄的 sitemap-static.xml 一起刪掉。
const PUBLIC_CRAWLER_PATHS = new Set(["/robots.txt", "/sitemap.xml", "/sitemap-static.xml", "/llms.txt"]);

// 部署會把整個 repo 根目錄當成靜態資源發布（Pages 不吃 .assetsignore），這些不是網站的一部分、
// 不該被公開讀取：後端原始碼與設定、專案文件、工具設定檔、點開頭的檔案（.gitignore、.claude/ …）。
// 一律回 404，跟「這個路徑不存在」看起來一樣；不看 UA 也不看 IP（爬蟲也不該抓到）。
// 路徑先 decode 再比對，避免用 /%77orker/ 這類百分比編碼繞過。
const BLOCKED_TOP_DIRS = new Set(["worker", "hosting", "functions", "docs", "node_modules"]);
function isBlockedPath(pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname).toLowerCase();
  } catch {
    return true; // 編碼不合法的路徑直接擋掉
  }
  const segments = decoded.split("/").filter(Boolean);
  if (segments.length === 0) return false;
  if (BLOCKED_TOP_DIRS.has(segments[0])) return true;
  // 點開頭的檔案/目錄一律擋，只有 .well-known（憑證驗證、安全聯絡資訊等標準用途）放行。
  if (segments.some((seg) => seg.startsWith(".") && seg !== ".well-known")) return true;
  return decoded.endsWith(".md");
}

export async function onRequest(context) {
  const { pathname } = new URL(context.request.url);
  if (isBlockedPath(pathname)) {
    return new Response("Not Found", { status: 404 });
  }
  if (PUBLIC_CRAWLER_PATHS.has(pathname)) {
    return context.next();
  }
  const country = context.request.cf?.country;
  if (country && country !== "TW") {
    const ua = context.request.headers.get("User-Agent") || "";
    if (!CRAWLER_UA_PATTERN.test(ua)) {
      return new Response("Forbidden", { status: 403 });
    }
  }
  return context.next();
}
