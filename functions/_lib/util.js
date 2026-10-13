// 注入課表、動態 sitemap、動態 llms.txt 共用的小工具：D1 逾時、Cache API 讀寫。
import { SITE_ORIGIN, FRAGMENT_CACHE_SECONDS } from "./ssrConfig.js";

// 超過 ms 毫秒就放棄（丟錯誤），不讓 D1 變慢拖累頁面載入；呼叫端自己決定怎麼退回。
export function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("D1 查詢逾時")), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// 快取 key 一律是 ${SITE_ORIGIN}/_ssr/v2/{name}：只是 Cache API 要一個 Request 當 key，這個網址並不存在也不會被請求。
// v2：注入片段多了 scrapedAt 欄位，sitemap 與 llms.txt 的 <loc>/連結由短代碼改 slug，升版避免跟舊格式的快取混用；
// 之後再改快取內容格式時改這裡的版號即可（CLAUDE.md 有各個 key 的說明）。
export function cacheRequest(name) {
  return new Request(`${SITE_ORIGIN}/_ssr/v2/${name}`);
}

// 讀快取：命中就回傳 read(命中的 Response) 的結果（預設回 Response 本身），沒命中或任何一步出錯都回 undefined，
// 出錯只記 log、當作沒命中，由呼叫端重新查詢——快取壞掉不能讓頁面跟著壞。
export async function cacheGet(cacheKey, label, read = (response) => response) {
  try {
    const hit = await caches.default.match(cacheKey);
    if (hit) return await read(hit);
  } catch (e) {
    console.error(`${label} 快取讀取失敗`, e);
  }
  return undefined;
}

// 寫快取：waitUntil 背景寫入，不擋回應；寫入失敗只記 log。
export function cachePut(context, cacheKey, response, label) {
  context.waitUntil(caches.default.put(cacheKey, response).catch((e) => console.error(`${label} 快取寫入失敗`, e)));
}

// 動態文字檔（sitemap.xml、llms.txt）共用的「快取 → 產生 → 快取」流程，結果快取 FRAGMENT_CACHE_SECONDS。
// build() 回傳文字，回空值代表「現在不該提供動態版」；任何失敗（build 丟錯）也一律回 null，
// 由呼叫端 context.next() 退回根目錄的靜態檔。所有請求（不分 UA）拿到的內容完全相同。
export async function cachedTextResponse(context, { name, label, contentType, build }) {
  const cacheKey = cacheRequest(name);
  const hit = await cacheGet(cacheKey, label);
  if (hit) return hit;
  try {
    const text = await build();
    if (!text) return null;
    const response = new Response(text, {
      headers: {
        "Content-Type": contentType,
        "Cache-Control": `public, max-age=${FRAGMENT_CACHE_SECONDS}`,
      },
    });
    cachePut(context, cacheKey, response.clone(), label);
    return response;
  } catch (e) {
    console.error(`動態 ${label} 產生失敗，退回靜態檔`, e);
    return null;
  }
}
