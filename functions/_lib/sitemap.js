import { FRAGMENT_CACHE_SECONDS } from "./ssrConfig.js";
import { branchUrlParam } from "./branchUrl.js";
import { getBranchesWithSchedule } from "./scheduleBranches.js";

const SITE_ORIGIN = "https://worldgym.pages.dev";

// scrapedAt 是台灣時間字串（+08:00），直接切前 10 碼當 lastmod 日期，不經過 Date（會變裝置時區）。
function renderSitemap(branches, homeLastmod) {
  const urls = [
    `  <url>\n    <loc>${SITE_ORIGIN}/</loc>\n    <lastmod>${homeLastmod}</lastmod>\n    <changefreq>weekly</changefreq>\n    <priority>1.0</priority>\n  </url>`,
    ...branches.map(({ code, slug, lastmod }) =>
      `  <url>\n    <loc>${SITE_ORIGIN}/?branch=${branchUrlParam(slug, code)}&amp;room=1</loc>\n    <lastmod>${lastmod}</lastmod>\n    <changefreq>daily</changefreq>\n    <priority>0.6</priority>\n  </url>`
    ),
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join("\n")}\n</urlset>\n`;
}

async function buildSitemapXml(db) {
  const branches = await getBranchesWithSchedule(db);
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
  // v2：<loc> 由短代碼改成 slug，升版避免跟舊格式的快取混用。
  const cacheKey = new Request(`${SITE_ORIGIN}/_ssr/v2/sitemap`);
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
