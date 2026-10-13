import { NORMAL_DAYS_AHEAD } from "../../worker/src/queryClasses.js";
import { todayIsoTaipei, addDaysIso } from "../../worker/src/util.js";
import { D1_TIMEOUT_MS } from "./ssrConfig.js";
import { BRANCH_BY_SLUG, SSR_SLUGS } from "./branches.js";
import { withTimeout } from "./util.js";

// 「現在有團體課表的分店」清單：sitemap.xml 與 llms.txt 共用這一份查詢與過濾，不要各複製一份。
// 範圍直接用 queryClasses.js 的 NORMAL_DAYS_AHEAD：注入的是「近 7 天的固定班」，只列這個範圍內真的有
// 團體教室固定班的分店，這樣列出來的網址一定查得到內容（不會是退回原頁的空殼）。
// 回傳 [{ code, slug, name, region, lastmod }]，依短代碼（branches-seed.js 陣列位置）由小到大排序；
// lastmod 取該分店最新 scrapedAt 的日期（台灣時間字串直接切前 10 碼，不經過 Date）。
// 查詢逾時或出錯會 throw，由呼叫端決定怎麼退回；查無任何分店回傳空陣列。
export async function getBranchesWithSchedule(db) {
  const from = todayIsoTaipei();
  const to = addDaysIso(from, NORMAL_DAYS_AHEAD);
  const query = db
    .prepare(
      `SELECT branchSlug, MAX(scrapedAt) AS scrapedAt FROM classes
       WHERE roomName = ? AND isSubstitute = 0 AND date >= ? AND date <= ? GROUP BY branchSlug`
    )
    .bind("團體教室", from, to)
    .all();
  const { results } = await withTimeout(query, D1_TIMEOUT_MS);
  return results
    .filter((r) => SSR_SLUGS.has(r.branchSlug) && BRANCH_BY_SLUG.has(r.branchSlug))
    .map((r) => {
      const b = BRANCH_BY_SLUG.get(r.branchSlug);
      return { code: b.code, slug: b.slug, name: b.name, region: b.region, lastmod: r.scrapedAt.slice(0, 10) };
    })
    .sort((a, b) => a.code - b.code);
}
