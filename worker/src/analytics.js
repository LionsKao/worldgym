import { taiwanMonthKey } from "./util.js";

// 分析報表用的「明細 + 月度彙總」合併查詢，以及每月把舊明細滾動壓縮成彙總、刪除明細的排程邏輯。
//
// 設計原則：teacher_search_events / course_search_events / branch_search_events / search_events /
// favorite_events / ad_events 這幾張表只用來「查每月統計」，從來不需要查單筆明細內容，所以舊資料
// 可以放心先壓縮成「(月份[, 名稱/廣告id/類型]) -> 次數」的彙總列再刪掉明細，不影響任何現有報表——
// 只要彙總表保留的維度跟報表原本 GROUP BY 的維度一致（teacher/course/branch 要留「名稱」，
// ad_events 要留「廣告id+類型」），報表看到的數字完全不會變。
//
// 只留最近 RAW_RETENTION_MONTHS 個月（含當月）的明細，更早的月份由 rollupAnalyticsEvents()
// （每月排程呼叫，見 index.js 的 scheduled()）算好彙總、寫進對應的 *_monthly 表後刪除明細。
// 所有讀取報表的查詢都改成「彙總表 UNION ALL 明細表」：舊月份只存在彙總表、當月只存在
// 明細表，兩者依月份天生互斥不會重疊——寫入端用同一個 db.batch() 把「彙總表 INSERT」跟「明細表
// DELETE」包成一次原子操作，確保任何時間點讀到的都是「完全還沒搬」或「完全搬完」，不會有兩邊
// 都算到、重複計數的中間狀態。
// 只留當月，上個月一結束就立刻彙總：寫入一律用伺服器收到請求當下的時間戳（nowTaiwanIso()），
// 不是前端帶時間過來，不會有「上個月的動作，遲到才寫進資料庫」這種跨月寫入，不需要留緩衝月份。
const RAW_RETENTION_MONTHS = 1;

// 把「每個月一列」的查詢結果加總成累積次數。後台的各個統計面板同時要「每月」跟「累積」兩種數字，
// 累積的就是每月加總，用這個算，不要再另外對事件表做一次全表掃描。
function sumCounts(rows) {
  return rows.reduce((total, row) => total + (row.cnt || 0), 0);
}

// --- 讀取端：有「名稱」維度的排行榜表共用（teacher/course/branch）---
async function monthlyNameRanking(db, { rawTable, nameColumn, monthlyTable, monthKey, limit }) {
  const { results } = await db.prepare(`
    SELECT name, SUM(cnt) AS cnt FROM (
      SELECT ${nameColumn} AS name, cnt FROM ${monthlyTable} WHERE month = ?
      UNION ALL
      SELECT ${nameColumn} AS name, COUNT(*) AS cnt FROM ${rawTable} WHERE substr(createdAt, 1, 7) = ? GROUP BY ${nameColumn}
    ) GROUP BY name ORDER BY cnt DESC LIMIT ?
  `).bind(monthKey, monthKey, limit).all();
  return results;
}

// 年份下拉選單的選項：只讀彙總表（很小）+ 目前年份，不掃明細表。明細表只留當月，
// 當月一定落在目前年份，所以不用靠掃明細來找年份。唯一的空窗是 1/1 台灣時間 00:00 到 1/2 04:00
// （每月排程還沒跑），去年 12 月的明細還沒進彙總表，去年若只有這個月的資料會暫時不在清單裡，
// 排程跑完就會出現。
async function availableYears(db, { monthlyTable }) {
  const { results } = await db.prepare(
    `SELECT DISTINCT substr(month, 1, 4) AS year FROM ${monthlyTable}`
  ).all();
  const years = new Set(results.map((r) => r.year));
  years.add(taiwanMonthKey().slice(0, 4));
  return [...years].sort().reverse();
}

// --- 查詢量趨勢（search_events / search_monthly）---
async function monthlySearchTrend(db) {
  const { results } = await db.prepare(`
    SELECT month, SUM(cnt) AS cnt, SUM(resultSum) AS resultSum FROM (
      SELECT month, cnt, resultSum FROM search_monthly
      UNION ALL
      SELECT substr(createdAt, 1, 7) AS month, COUNT(*) AS cnt, SUM(resultCount) AS resultSum FROM search_events GROUP BY month
    ) GROUP BY month
  `).all();
  const monthly = {}, monthlyResults = {};
  for (const row of results) {
    monthly[row.month] = row.cnt;
    monthlyResults[row.month] = row.resultSum || 0;
  }
  return { monthly, monthlyResults };
}

// --- 我的最愛（favorite_events / favorite_monthly / favorite_client_seen）---
// 'add' 的每月人數在彙總當下就把「去重」算好凍結；全時間的去重人數改看 favorite_client_seen
// （即時維護，不受這裡的彙總/刪除影響），才能讓「累積建立人數」這個總數字永遠準確。
async function favoriteStatsCombined(db) {
  const [{ results: adderRows }, { results: applyRows }, totalAdderRow] = await Promise.all([
    db.prepare(`
      SELECT month, SUM(cnt) AS cnt FROM (
        SELECT month, cnt FROM favorite_monthly WHERE type = 'add'
        UNION ALL
        SELECT substr(createdAt, 1, 7) AS month, COUNT(DISTINCT clientId) AS cnt FROM favorite_events WHERE type = 'add' GROUP BY month
      ) GROUP BY month
    `).all(),
    db.prepare(`
      SELECT month, SUM(cnt) AS cnt FROM (
        SELECT month, cnt FROM favorite_monthly WHERE type = 'apply'
        UNION ALL
        SELECT substr(createdAt, 1, 7) AS month, COUNT(*) AS cnt FROM favorite_events WHERE type = 'apply' GROUP BY month
      ) GROUP BY month
    `).all(),
    db.prepare("SELECT COUNT(*) AS cnt FROM favorite_client_seen").first(),
  ]);
  const monthlyAdders = {}, monthlyApplies = {};
  for (const row of adderRows) monthlyAdders[row.month] = row.cnt;
  for (const row of applyRows) monthlyApplies[row.month] = row.cnt;
  return {
    monthlyAdders, monthlyApplies,
    totalAdders: totalAdderRow?.cnt || 0,
    // 累積使用次數就是每個月的次數加總，不用再另外掃一次 favorite_events。
    // （累積「人數」不能這樣算：每個月各自去重，跨月加總會把同一個人算好幾次，所以仍看 favorite_client_seen。）
    totalApplies: sumCounts(applyRows),
  };
}

// --- 廣告成效（ad_events / ad_monthly）---
async function adStatsCombined(db) {
  const [{ results: ads }, { results: monthly }] = await Promise.all([
    db.prepare(
      "SELECT id, text, url, startAt, endAt, enabled, sortOrder, advertiser FROM ads ORDER BY sortOrder"
    ).all(),
    db.prepare(`
      SELECT adId, month, type, SUM(cnt) AS cnt FROM (
        SELECT adId, month, type, cnt FROM ad_monthly
        UNION ALL
        SELECT adId, substr(createdAt, 1, 7) AS month, type, COUNT(*) AS cnt FROM ad_events GROUP BY adId, month, type
      ) GROUP BY adId, month, type
    `).all(),
  ]);
  // 每支廣告的累積曝光／點擊就是各月加總，不用再另外掃一次 ad_events 算「全時間」的總數。
  const totalsByAd = {};
  const monthlyByAd = {};
  for (const row of monthly) {
    const field = row.type === "impression" ? "impressions" : "clicks";
    const bucket = (monthlyByAd[row.adId] ??= {});
    const entry = (bucket[row.month] ??= { impressions: 0, clicks: 0 });
    entry[field] = row.cnt;
    const total = (totalsByAd[row.adId] ??= { impressions: 0, clicks: 0 });
    total[field] += row.cnt;
  }
  for (const ad of ads) {
    ad.impressions = totalsByAd[ad.id]?.impressions || 0;
    ad.clicks = totalsByAd[ad.id]?.clicks || 0;
    ad.monthly = monthlyByAd[ad.id] || {};
  }
  return ads;
}

// --- 提醒功能使用量(reminder_add_events / reminder_add_monthly)，沒有名稱維度，邏輯跟 search_events 一樣 ---
async function reminderStatsCombined(db) {
  const { results } = await db.prepare(`
    SELECT month, SUM(cnt) AS cnt FROM (
      SELECT month, cnt FROM reminder_add_monthly
      UNION ALL
      SELECT substr(createdAt, 1, 7) AS month, COUNT(*) AS cnt FROM reminder_add_events GROUP BY month
    ) GROUP BY month ORDER BY month DESC
  `).all();
  return {
    monthly: results.map((r) => ({ month: r.month, count: r.cnt })),
    total: sumCounts(results),  // 累積登記次數就是各月加總，不用再另外掃一次 reminder_add_events
  };
}

// --- 每月排程：把保留窗口以外的舊明細壓縮成彙總、刪除明細 ---
// 只保留當月的明細，上個月一結束就處理。每次都抓「明細裡所有比保留窗口舊的月份」整批
// 處理，不是只處理特定一個月——就算某次排程漏跑、失敗，下次照樣會把積欠的月份一次補齊，
// 不用人工介入。每個月份的「彙總 INSERT」+「明細 DELETE」包在同一個 db.batch() 裡原子執行，
// 避免任何時間點的讀取查詢同時看到彙總跟明細都有這個月的資料而重複計數。
//
// 彙總一定要用「INSERT ... SELECT」在同一個 batch（同一個 transaction）裡從明細現算，
// 不能先 SELECT 回 JS、再用綁定值 INSERT：兩輪壓縮同時跑時（排程剛好遇到後台手動按鈕、或排程被重複觸發），
// 後到的那輪若是「先讀、再寫」，讀到的會是先到的那輪已經刪掉明細之後的空結果，
// 接著把先算好的月度總數蓋成 0——明細已經沒了，就永遠回不來。現算的話，明細已被刪掉就什麼都不寫
// （沒有列可選；沒有 GROUP BY 的總數查詢多包一層 WHERE c > 0），後到的那輪等於空轉。
// 每個 insertSql 的兩個 ? 都是月份（SELECT 清單一個、WHERE 一個）。
async function rollupAnalyticsEvents(db) {
  const cutoff = taiwanMonthKey(RAW_RETENTION_MONTHS - 1); // 比這個月份舊的才處理
  const summary = {};

  // 明細表裡所有比保留窗口舊的月份（YYYY-MM）。
  async function monthsBefore(rawTable) {
    const { results } = await db.prepare(
      `SELECT DISTINCT substr(createdAt, 1, 7) AS month FROM ${rawTable} WHERE substr(createdAt, 1, 7) < ?`
    ).bind(cutoff).all();
    return results.map((r) => r.month);
  }

  // 一張明細表的壓縮：每個舊月份各一個 batch＝（insertSqls 各一句，從明細現算寫進彙總表）＋刪掉這個月的明細。
  async function rollupTable(rawTable, insertSqls) {
    const months = await monthsBefore(rawTable);
    let rowsAggregated = 0;
    for (const month of months) {
      const results = await db.batch([
        ...insertSqls.map((sql) => db.prepare(sql).bind(month, month)),
        db.prepare(`DELETE FROM ${rawTable} WHERE substr(createdAt, 1, 7) = ?`).bind(month),
      ]);
      rowsAggregated += results.slice(0, insertSqls.length).reduce((n, r) => n + (r?.meta?.changes || 0), 0);
    }
    summary[rawTable] = { monthsRolledUp: months.length, rowsAggregated };
  }

  // 有「名稱」維度的表（teacher／course／branch）：每個名稱一列 (month, 名稱, 次數)。
  const nameTable = (nameColumn, monthlyTable, rawTable) =>
    `INSERT OR REPLACE INTO ${monthlyTable} (month, ${nameColumn}, cnt)
     SELECT ?, ${nameColumn}, COUNT(*) FROM ${rawTable} WHERE substr(createdAt, 1, 7) = ? GROUP BY ${nameColumn}`;
  await rollupTable("teacher_search_events", [nameTable("teacherName", "teacher_search_monthly", "teacher_search_events")]);
  await rollupTable("course_search_events", [nameTable("courseName", "course_search_monthly", "course_search_events")]);
  await rollupTable("branch_search_events", [nameTable("branchName", "branch_search_monthly", "branch_search_events")]);

  // search_events：沒有名稱維度，直接彙總成 (month -> cnt, resultSum)。
  await rollupTable("search_events", [
    `INSERT OR REPLACE INTO search_monthly (month, cnt, resultSum)
     SELECT ?, c, COALESCE(s, 0) FROM (SELECT COUNT(*) AS c, SUM(resultCount) AS s FROM search_events WHERE substr(createdAt, 1, 7) = ?) WHERE c > 0`,
  ]);

  // favorite_events：'add' 要先把去重人數算好凍結，'apply' 直接加總；
  // 真正的「全時間去重人數」另外靠 favorite_client_seen 即時維護，不受這裡影響。
  await rollupTable("favorite_events", [
    `INSERT OR REPLACE INTO favorite_monthly (month, type, cnt)
     SELECT ?, 'add', adders FROM (SELECT COUNT(*) AS n, COUNT(DISTINCT CASE WHEN type = 'add' THEN clientId END) AS adders FROM favorite_events WHERE substr(createdAt, 1, 7) = ?) WHERE n > 0`,
    `INSERT OR REPLACE INTO favorite_monthly (month, type, cnt)
     SELECT ?, 'apply', applies FROM (SELECT COUNT(*) AS n, SUM(CASE WHEN type = 'apply' THEN 1 ELSE 0 END) AS applies FROM favorite_events WHERE substr(createdAt, 1, 7) = ?) WHERE n > 0`,
  ]);

  // reminder_add_events：沒有名稱維度，直接彙總成 (month -> cnt)，邏輯跟 search_events 一樣。
  await rollupTable("reminder_add_events", [
    `INSERT OR REPLACE INTO reminder_add_monthly (month, cnt)
     SELECT ?, c FROM (SELECT COUNT(*) AS c FROM reminder_add_events WHERE substr(createdAt, 1, 7) = ?) WHERE c > 0`,
  ]);

  // ad_events：(month, adId, type) 三個維度都要留。
  await rollupTable("ad_events", [
    `INSERT OR REPLACE INTO ad_monthly (month, adId, type, cnt)
     SELECT ?, adId, type, COUNT(*) FROM ad_events WHERE substr(createdAt, 1, 7) = ? GROUP BY adId, type`,
  ]);

  return summary;
}

export {
  monthlyNameRanking,
  availableYears,
  monthlySearchTrend,
  favoriteStatsCombined,
  adStatsCombined,
  reminderStatsCombined,
  rollupAnalyticsEvents,
};
