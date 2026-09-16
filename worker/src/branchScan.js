import BRANCHES from "./branches-seed.js";

// 跟 scrape.js 用同一個 User-Agent，官網對沒有瀏覽器特徵的請求會拒絕。
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36";

// 官網分店清單的 AJAX（qryBranchMark，branches-seed.js 開頭有說明）擋在 Cloudflare bot 防護後面，
// 伺服器端要不到，改成拿 sitemap.xml 比對 find-a-club/{slug} 網址。sitemap 更新可能會比新分店上線
// 晚幾天，抓不到「剛開幕」的分店，但不用處理 bot 防護，夠用來每月抓一次「有沒有新分店/分店下架」的訊號。
async function fetchSitemapSlugs() {
  const res = await fetch("https://www.worldgymtaiwan.com/sitemap.xml", {
    headers: { "User-Agent": USER_AGENT },
  });
  if (!res.ok) throw new Error(`sitemap.xml 讀取失敗：HTTP ${res.status}`);
  const xml = await res.text();
  const slugs = new Set();
  for (const m of xml.matchAll(/find-a-club\/([a-z0-9-]+)/g)) {
    slugs.add(m[1]);
  }
  return slugs;
}

async function notifyTeams(env, added, removed) {
  if (!env.TEAMS_WEBHOOK_URL) return;
  const body = [
    { type: "TextBlock", text: "課表查詢網站：分店清單月度掃描發現差異", weight: "bolder", wrap: true },
  ];
  if (added.length) {
    body.push({ type: "TextBlock", text: `🆕 官網 sitemap 有、branches-seed.js 沒有（可能是新分店）：\n${added.join("、")}`, wrap: true });
  }
  if (removed.length) {
    body.push({ type: "TextBlock", text: `❓ branches-seed.js 有、官網 sitemap 沒有（可能已下架，也可能只是 sitemap 還沒收錄）：\n${removed.join("、")}`, wrap: true });
  }
  const teamsRes = await fetch(env.TEAMS_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type: "AdaptiveCard",
      $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
      version: "1.4",
      body,
    }),
  });
  if (!teamsRes.ok) {
    console.error("branch scan Teams webhook responded with error", teamsRes.status, await teamsRes.text());
  }
}

// 每月排程用：跟官網 sitemap 比對出新增/疑似下架的分店 slug，有差異才發 Teams 通知，沒有差異就靜靜結束。
// 只負責「發現差異、通知」，實際加不加分店（branches-seed.js / branches.json / index.html）還是手動決定。
export async function scanForNewBranches(env) {
  const sitemapSlugs = await fetchSitemapSlugs();
  const seedSlugs = new Set(BRANCHES.map((b) => b.slug));
  const added = [...sitemapSlugs].filter((s) => !seedSlugs.has(s)).sort();
  const removed = [...seedSlugs].filter((s) => !sitemapSlugs.has(s)).sort();

  if (added.length > 0 || removed.length > 0) {
    await notifyTeams(env, added, removed);
  }
  return { added, removed, sitemapCount: sitemapSlugs.size, seedCount: seedSlugs.size };
}
