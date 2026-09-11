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
// 所有讀取報表的查詢都改成「彙總表 UNION ALL 明細表」：舊月份只存在彙總表、當月/前一個月只存在
// 明細表，兩者依月份天生互斥不會重疊——寫入端用同一個 db.batch() 把「彙總表 INSERT」跟「明細表
// DELETE」包成一次原子操作，確保任何時間點讀到的都是「完全還沒搬」或「完全搬完」，不會有兩邊
// 都算到、重複計數的中間狀態。
const RAW_RETENTION_MONTHS = 2;

function monthKeyOf(date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

// 台灣「現在」往前推 n 個月的月份字串（YYYY-MM）。
function taiwanMonthOffset(n) {
  const now = new Date(Date.now() + 8 * 3600 * 1000);
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - n, 1));
  return monthKeyOf(d);
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

async function availableYears(db, { rawTable, monthlyTable }) {
  const { results } = await db.prepare(`
    SELECT DISTINCT year FROM (
      SELECT substr(month, 1, 4) AS year FROM ${monthlyTable}
      UNION
      SELECT substr(createdAt, 1, 4) AS year FROM ${rawTable}
    ) ORDER BY year DESC
  `).all();
  return results.map((r) => r.year);
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
  const [{ results: adderRows }, { results: applyRows }, totalAdderRow, totalApplyRow] = await Promise.all([
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
    db.prepare(`
      SELECT SUM(cnt) AS cnt FROM (
        SELECT cnt FROM favorite_monthly WHERE type = 'apply'
        UNION ALL
        SELECT COUNT(*) AS cnt FROM favorite_events WHERE type = 'apply'
      )
    `).first(),
  ]);
  const monthlyAdders = {}, monthlyApplies = {};
  for (const row of adderRows) monthlyAdders[row.month] = row.cnt;
  for (const row of applyRows) monthlyApplies[row.month] = row.cnt;
  return {
    monthlyAdders, monthlyApplies,
    totalAdders: totalAdderRow?.cnt || 0,
    totalApplies: totalApplyRow?.cnt || 0,
  };
}

// --- 廣告成效（ad_events / ad_monthly）---
async function adStatsCombined(db) {
  const [{ results: ads }, { results: totals }, { results: monthly }] = await Promise.all([
    db.prepare(
      "SELECT id, text, url, startAt, endAt, enabled, sortOrder, advertiser FROM ads ORDER BY sortOrder"
    ).all(),
    db.prepare(`
      SELECT adId, type, SUM(cnt) AS cnt FROM (
        SELECT adId, type, cnt FROM ad_monthly
        UNION ALL
        SELECT adId, type, COUNT(*) AS cnt FROM ad_events GROUP BY adId, type
      ) GROUP BY adId, type
    `).all(),
    db.prepare(`
      SELECT adId, month, type, SUM(cnt) AS cnt FROM (
        SELECT adId, month, type, cnt FROM ad_monthly
        UNION ALL
        SELECT adId, substr(createdAt, 1, 7) AS month, type, COUNT(*) AS cnt FROM ad_events GROUP BY adId, month, type
      ) GROUP BY adId, month, type
    `).all(),
  ]);
  const totalsByAd = {};
  for (const row of totals) {
    const bucket = (totalsByAd[row.adId] ??= { impressions: 0, clicks: 0 });
    bucket[row.type === "impression" ? "impressions" : "clicks"] = row.cnt;
  }
  const monthlyByAd = {};
  for (const row of monthly) {
    const bucket = (monthlyByAd[row.adId] ??= {});
    const entry = (bucket[row.month] ??= { impressions: 0, clicks: 0 });
    entry[row.type === "impression" ? "impressions" : "clicks"] = row.cnt;
  }
  for (const ad of ads) {
    ad.impressions = totalsByAd[ad.id]?.impressions || 0;
    ad.clicks = totalsByAd[ad.id]?.clicks || 0;
    ad.monthly = monthlyByAd[ad.id] || {};
  }
  return ads;
}

// --- 每月排程：把保留窗口以外的舊明細壓縮成彙總、刪除明細 ---
// 保留當月 + 前一個月的明細，更早的月份才處理。每次都抓「明細裡所有比保留窗口舊的月份」整批
// 處理，不是只處理特定一個月——就算某次排程漏跑、失敗，下次照樣會把積欠的月份一次補齊，
// 不用人工介入。每個月份的「彙總 INSERT」+「明細 DELETE」包在同一個 db.batch() 裡原子執行，
// 避免任何時間點的讀取查詢同時看到彙總跟明細都有這個月的資料而重複計數。
async function rollupAnalyticsEvents(db) {
  const cutoff = taiwanMonthOffset(RAW_RETENTION_MONTHS - 1); // 比這個月份舊的才處理
  const summary = {};

  async function rollupNameTable(rawTable, nameColumn, monthlyTable) {
    const { results: months } = await db.prepare(
      `SELECT DISTINCT substr(createdAt, 1, 7) AS month FROM ${rawTable} WHERE substr(createdAt, 1, 7) < ?`
    ).bind(cutoff).all();
    let rowsAggregated = 0;
    for (const { month } of months) {
      const { results } = await db.prepare(
        `SELECT ${nameColumn} AS name, COUNT(*) AS cnt FROM ${rawTable} WHERE substr(createdAt, 1, 7) = ? GROUP BY ${nameColumn}`
      ).bind(month).all();
      if (results.length === 0) continue;
      await db.batch([
        ...results.map((r) =>
          db.prepare(`INSERT OR REPLACE INTO ${monthlyTable} (month, ${nameColumn}, cnt) VALUES (?, ?, ?)`)
            .bind(month, r.name, r.cnt)
        ),
        db.prepare(`DELETE FROM ${rawTable} WHERE substr(createdAt, 1, 7) = ?`).bind(month),
      ]);
      rowsAggregated += results.length;
    }
    summary[rawTable] = { monthsRolledUp: months.length, rowsAggregated };
  }

  await rollupNameTable("teacher_search_events", "teacherName", "teacher_search_monthly");
  await rollupNameTable("course_search_events", "courseName", "course_search_monthly");
  await rollupNameTable("branch_search_events", "branchName", "branch_search_monthly");

  // search_events：沒有名稱維度，直接彙總成 (month -> cnt, resultSum)。
  {
    const { results: months } = await db.prepare(
      "SELECT DISTINCT substr(createdAt, 1, 7) AS month FROM search_events WHERE substr(createdAt, 1, 7) < ?"
    ).bind(cutoff).all();
    for (const { month } of months) {
      const row = await db.prepare(
        "SELECT COUNT(*) AS cnt, SUM(resultCount) AS resultSum FROM search_events WHERE substr(createdAt, 1, 7) = ?"
      ).bind(month).first();
      await db.batch([
        db.prepare("INSERT OR REPLACE INTO search_monthly (month, cnt, resultSum) VALUES (?, ?, ?)")
          .bind(month, row.cnt, row.resultSum || 0),
        db.prepare("DELETE FROM search_events WHERE substr(createdAt, 1, 7) = ?").bind(month),
      ]);
    }
    summary.search_events = { monthsRolledUp: months.length };
  }

  // favorite_events：'add' 要先把去重人數算好凍結，'apply' 直接加總；
  // 真正的「全時間去重人數」另外靠 favorite_client_seen 即時維護，不受這裡影響。
  {
    const { results: months } = await db.prepare(
      "SELECT DISTINCT substr(createdAt, 1, 7) AS month FROM favorite_events WHERE substr(createdAt, 1, 7) < ?"
    ).bind(cutoff).all();
    for (const { month } of months) {
      const addRow = await db.prepare(
        "SELECT COUNT(DISTINCT clientId) AS cnt FROM favorite_events WHERE type = 'add' AND substr(createdAt, 1, 7) = ?"
      ).bind(month).first();
      const applyRow = await db.prepare(
        "SELECT COUNT(*) AS cnt FROM favorite_events WHERE type = 'apply' AND substr(createdAt, 1, 7) = ?"
      ).bind(month).first();
      await db.batch([
        db.prepare("INSERT OR REPLACE INTO favorite_monthly (month, type, cnt) VALUES (?, 'add', ?)").bind(month, addRow?.cnt || 0),
        db.prepare("INSERT OR REPLACE INTO favorite_monthly (month, type, cnt) VALUES (?, 'apply', ?)").bind(month, applyRow?.cnt || 0),
        db.prepare("DELETE FROM favorite_events WHERE substr(createdAt, 1, 7) = ?").bind(month),
      ]);
    }
    summary.favorite_events = { monthsRolledUp: months.length };
  }

  // ad_events：(month, adId, type) 三個維度都要留。
  {
    const { results: months } = await db.prepare(
      "SELECT DISTINCT substr(createdAt, 1, 7) AS month FROM ad_events WHERE substr(createdAt, 1, 7) < ?"
    ).bind(cutoff).all();
    for (const { month } of months) {
      const { results } = await db.prepare(
        "SELECT adId, type, COUNT(*) AS cnt FROM ad_events WHERE substr(createdAt, 1, 7) = ? GROUP BY adId, type"
      ).bind(month).all();
      const stmts = results.map((r) =>
        db.prepare("INSERT OR REPLACE INTO ad_monthly (month, adId, type, cnt) VALUES (?, ?, ?, ?)")
          .bind(month, r.adId, r.type, r.cnt)
      );
      stmts.push(db.prepare("DELETE FROM ad_events WHERE substr(createdAt, 1, 7) = ?").bind(month));
      await db.batch(stmts);
    }
    summary.ad_events = { monthsRolledUp: months.length };
  }

  return summary;
}

export {
  monthlyNameRanking,
  availableYears,
  monthlySearchTrend,
  favoriteStatsCombined,
  adStatsCombined,
  rollupAnalyticsEvents,
};
