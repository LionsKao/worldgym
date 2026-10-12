import BRANCHES from "../../worker/src/branches-seed.js";
import { SSR_BRANCH_SLUGS, FRAGMENT_CACHE_SECONDS, D1_TIMEOUT_MS } from "./ssrConfig.js";

const SITE_ORIGIN = "https://worldgym.pages.dev";
// 跟 worker/src/queryClasses.js 的 NORMAL_DAYS_AHEAD 對齊：注入的是「近 7 天的固定班」，
// sitemap 只列這個範圍內真的有團體教室固定班的分店，這樣列出來的網址一定查得到內容（不會是退回原頁的空殼）。
const NORMAL_DAYS_AHEAD = 6;
const CODE_BY_SLUG = new Map(BRANCHES.map((b, i) => [b.slug, i]));
const INCLUDED_SLUGS = new Set(SSR_BRANCH_SLUGS);

function todayIsoTaipei() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei" }).format(new Date());
}
function addDaysIso(iso, days) {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// scrapedAt 是台灣時間字串（+08:00），直接切前 10 碼當 lastmod 日期，不經過 Date（會變裝置時區）。
function renderSitemap(branches, homeLastmod) {
  const urls = [
    `  <url>\n    <loc>${SITE_ORIGIN}/</loc>\n    <lastmod>${homeLastmod}</lastmod>\n    <changefreq>weekly</changefreq>\n    <priority>1.0</priority>\n  </url>`,
    ...branches.map(({ code, lastmod }) =>
      `  <url>\n    <loc>${SITE_ORIGIN}/?branch=${code}&amp;room=1</loc>\n    <lastmod>${lastmod}</lastmod>\n    <changefreq>daily</changefreq>\n    <priority>0.6</priority>\n  </url>`
    ),
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join("\n")}\n</urlset>\n`;
}

async function buildSitemapXml(db) {
  const from = todayIsoTaipei();
  const to = addDaysIso(from, NORMAL_DAYS_AHEAD);
  const query = db
    .prepare(
      `SELECT branchSlug, MAX(scrapedAt) AS scrapedAt FROM classes
       WHERE roomName = ? AND isSubstitute = 0 AND date >= ? AND date <= ? GROUP BY branchSlug`
    )
    .bind("團體教室", from, to)
    .all();
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("D1 查詢逾時")), D1_TIMEOUT_MS); });
  const { results } = await Promise.race([query, timeout]).finally(() => clearTimeout(timer));
  const branches = results
    .filter((r) => INCLUDED_SLUGS.has(r.branchSlug) && CODE_BY_SLUG.has(r.branchSlug))
    .map((r) => ({ code: CODE_BY_SLUG.get(r.branchSlug), lastmod: r.scrapedAt.slice(0, 10) }))
    .sort((a, b) => a.code - b.code);
  if (branches.length === 0) return null; // 查不到任何分店通常是資料庫出問題，退回靜態 sitemap，不要回一份空的
  const homeLastmod = branches.reduce((max, b) => (b.lastmod > max ? b.lastmod : max), branches[0].lastmod);
  return renderSitemap(branches, homeLastmod);
}

// 動態 sitemap：只列「現在真的有團體課表」的分店，新分店有資料後自動出現、沒資料的自動消失。
// 結果快取 30 分鐘（跟注入的片段一致），避免被狂刷時每次都掃 classes。
// 任何失敗（沒有 D1 綁定、逾時、查無資料）回 null，由呼叫端退回靜態的 sitemap.xml。
export async function getSitemapResponse(context) {
  if (!context.env.DB) return null;
  const cache = caches.default;
  const cacheKey = new Request(`${SITE_ORIGIN}/_ssr/sitemap`);
  try {
    const hit = await cache.match(cacheKey);
    if (hit) return hit;
  } catch (e) {
    console.error("sitemap 快取讀取失敗", e);
  }
  try {
    const xml = await buildSitemapXml(context.env.DB);
    if (!xml) return null;
    const response = new Response(xml, {
      headers: {
        "Content-Type": "application/xml; charset=utf-8",
        "Cache-Control": `public, max-age=${FRAGMENT_CACHE_SECONDS}`,
      },
    });
    context.waitUntil(cache.put(cacheKey, response.clone()).catch((e) => console.error("sitemap 快取寫入失敗", e)));
    return response;
  } catch (e) {
    console.error("動態 sitemap 產生失敗，退回靜態檔", e);
    return null;
  }
}
