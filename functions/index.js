// 單一分店網址（例如 /?branch=0&room=1）在伺服器端把該分店的課表寫進回傳的 HTML，
// 讓不執行 JS 的爬蟲也讀得到。所有 UA 拿到的內容完全相同（不依 User-Agent 回不同內容）。
// 沒有 query、或不符合白名單格式的網址，一律原樣放行（context.next()），不查 D1。
// 設定與細節見 functions/_lib/ssrConfig.js、ssrBranch.js，維護方式見 CLAUDE.md。
import { resolveSsrTarget, getFragment, rewriteHtml } from "./_lib/ssrBranch.js";

export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const branch = url.search && context.env.DB ? resolveSsrTarget(url) : null;
  if (!branch) return context.next();

  // 注入後的內容跟靜態檔不同，不能讓靜態檔層用條件請求回 304，所以拿掉驗證用的 header 再往下傳。
  const headers = new Headers(context.request.headers);
  headers.delete("If-None-Match");
  headers.delete("If-Modified-Since");
  const [response, fragment] = await Promise.all([
    context.next(new Request(context.request, { headers })),
    getFragment(context, branch),
  ]);
  const isHtml = (response.headers.get("Content-Type") || "").includes("text/html");
  if (!fragment || !response.ok || !isHtml) return response;
  return rewriteHtml(response, branch, fragment);
}
