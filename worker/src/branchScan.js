import BRANCHES from "./branches-seed.js";
import { EXCLUDED_BRANCHES, EXPECTED_MISSING_FROM_SITEMAP } from "./branches-excluded.js";
import { SCRAPER_USER_AGENT, postTeamsCard } from "./util.js";

// 官網分店清單的 AJAX（qryBranchMark，branches-seed.js 開頭有說明）擋在 Cloudflare bot 防護後面，
// 伺服器端要不到，改成拿 sitemap.xml 比對 find-a-club/{slug} 網址。sitemap 更新可能會比新分店上線
// 晚幾天，抓不到「剛開幕」的分店，但不用處理 bot 防護，夠用來每月抓一次「有沒有新分店/分店下架」的訊號。
async function fetchSitemapSlugs() {
  const res = await fetch("https://www.worldgymtaiwan.com/sitemap.xml", {
    headers: { "User-Agent": SCRAPER_USER_AGENT },
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
    body.push({ type: "TextBlock", text: `🆕 官網 sitemap 有、但既不在 branches-seed.js、也不在已知不收清單 branches-excluded.js（可能是新分店）：\n${added.join("、")}`, wrap: true });
    body.push({ type: "TextBlock", text: "有不用付費的團課 → 加進 branches-seed.js（流程見 CLAUDE.md）；Express 或只有付費課 → 加進 branches-excluded.js 並寫理由，下個月就不會再通知。", wrap: true });
  }
  if (removed.length) {
    body.push({ type: "TextBlock", text: `❓ branches-seed.js 有、官網 sitemap 沒有（可能已下架，也可能只是 sitemap 還沒收錄）：\n${removed.join("、")}`, wrap: true });
  }
  const teamsRes = await postTeamsCard(env, body);
  if (!teamsRes.ok) {
    console.error("branch scan Teams webhook responded with error", teamsRes.status, await teamsRes.text());
  }
}

// 每月排程用：跟官網 sitemap 比對出新增/疑似下架的分店 slug，有差異才發 Teams 通知，沒有差異就靜靜結束。
// 只負責「發現差異、通知」，實際加不加分店（branches-seed.js / script.js 的 BRANCH_SLUG_ORDER / index.html 的分店 pill）還是手動決定。
// 兩份清單用來過濾「已經決定過」的網址，避免每個月重複通知同一批：
//   - EXCLUDED_BRANCHES：官網有、但刻意不收（Express、只有付費課）→ 不算新增
//   - EXPECTED_MISSING_FROM_SITEMAP：我們已收進來、但官網還沒建分店頁（預售中）→ 不算疑似下架
export async function scanForNewBranches(env) {
  const sitemapSlugs = await fetchSitemapSlugs();
  const seedSlugs = new Set(BRANCHES.map((b) => b.slug));
  const excluded = new Set(Object.keys(EXCLUDED_BRANCHES));
  const expectedMissing = new Set(Object.keys(EXPECTED_MISSING_FROM_SITEMAP));
  const added = [...sitemapSlugs].filter((s) => !seedSlugs.has(s) && !excluded.has(s)).sort();
  const removed = [...seedSlugs].filter((s) => !sitemapSlugs.has(s) && !expectedMissing.has(s)).sort();

  if (added.length > 0 || removed.length > 0) {
    await notifyTeams(env, added, removed);
  }
  return {
    added,
    removed,
    sitemapCount: sitemapSlugs.size,
    seedCount: seedSlugs.size,
    excludedCount: [...sitemapSlugs].filter((s) => excluded.has(s)).length,
  };
}
