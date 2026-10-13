import BRANCHES from "./branches-seed.js";
import { nowTaiwanIso, todayIsoTaipei, pad2, fnv1aHex, SCRAPER_USER_AGENT } from "./util.js";

const SCHEDULE_DAYS_AHEAD = 13;
// 查詢端（queryClasses.js 的 NORMAL_DAYS_AHEAD = 6）只看「今天到 +6 天」的正常班，
// 但這裡要多存一天（day0~day7 全存），超過的天數（day8~day13）只存代課——遠期查詢本來就只挑代課顯示，
// 更遠的正常班寫進 D1 也用不到，不存可以省下寫入量與儲存空間。
// 為什麼多存一天：爬蟲一天只跑兩次（台灣時間 03:00、17:00），若只存到 +6 天，
// 17:00 抓完的資料到隔天 00:00 就不夠了（窗口往前移一天，需要 +6 天的資料），
// 要等 03:00 的爬蟲才補上，每天 00:00~03:00 會缺「剛過去那天的同一個星期幾」。
// 多存一天，資料就涵蓋到「下一次爬蟲跑完之前」，也能容忍漏跑一次爬蟲。
// 多存的 day7 正常班不會被查詢讀到（近窗口只到 +6，遠窗口只看代課），所以不影響任何畫面。
const NEAR_DAYS_AHEAD = 7;
// 分店依序（非平行）逐一請求，每間之間隔這麼久，對官網客氣一點。
const BRANCH_REQUEST_DELAY_MS = 500;
// D1 batch 一次太多語句容易超時，分批送出。
const BATCH_CHUNK_SIZE = 50;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatDateSlash(date) {
  return `${date.getFullYear()}/${pad2(date.getMonth() + 1)}/${pad2(date.getDate())}`;
}

function formatDateIso(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

// 台灣今天的 00:00（用 todayIsoTaipei，不是執行環境的 UTC 日期），避免台北時間 00:00~08:00
// 這段區間算出「昨天」，導致這次抓到的資料整批往前錯位一天（近 7 天/13 天視窗的邊界也跟著錯位）。
function todayAtMidnight() {
  return new Date(`${todayIsoTaipei()}T00:00:00Z`);
}

// Chinese convention: Monday=1 ... Sunday=7 (JS getDay() is Sunday=0 ... Saturday=6).
function chineseWeekday(date) {
  const jsDay = date.getDay();
  return jsDay === 0 ? 7 : jsDay;
}

async function fetchBranchSchedule(slug, firstDate, lastDate) {
  const url = `https://www.worldgymtaiwan.com/find-a-club/${slug}/aerobics-class-schedule`;
  const body = new URLSearchParams({
    func: "queryWeekSchedule",
    scheduleType: "week",
    first_date: formatDateSlash(firstDate),
    last_date: formatDateSlash(lastDate),
  });
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": SCRAPER_USER_AGENT,
    },
    body: body.toString(),
  });
  if (!res.ok) {
    throw new Error(`schedule request failed for ${slug}: HTTP ${res.status}`);
  }
  const json = await res.json();
  return Array.isArray(json && json.data) ? json.data : [];
}

// 官網教室名稱常帶樓層（例如「3F飛輪教室」「B1團體有氧教室」），不管樓層一律歸成這兩種。
// 少數分店的團體教室只叫「有氧教室」（沒有「團體」二字，例如鳳山中山），同樣歸成團體教室，
// 不然前端選「團體教室」時這些分店的課一堂都查不到。
function normalizeRoomName(rawRoomName) {
  const name = (rawRoomName || "").trim();
  if (name.includes("飛輪")) return "飛輪教室";
  if (name.includes("團體") || name.includes("有氧")) return "團體教室";
  return name;
}

// 把官網回傳的一堂課轉成 classes 表的一列；沒有課程名稱的回 null。
// scrapedAt 由呼叫端傳入：同一間分店同一輪的所有列要共用同一個值（見 ingestBranchClasses），
// 不帶就用現在時間（單獨呼叫這個函式時）。
function transformRawClass(raw, branchSlug, branchName, scrapedAt = nowTaiwanIso()) {
  const className = (raw.other_class_name || "").trim().replace(/®/g, "").replace(/GROUP/gi, "").trim();
  if (!className) return null;

  const teacherName = (raw.teacher_name || "").trim();
  const teacherEmpNo = (raw.teacher_emp_no || "").trim();
  const startTime = (raw.class_stime || "").replace(":", "");
  const dateObj = new Date(raw.class_date);
  const date = formatDateIso(dateObj);
  const roomName = normalizeRoomName(raw.room_name);

  // 員編才是唯一識別老師的欄位——同名老師（不同分店常見）用姓名當 id 種子會撞在一起。
  const idSeed = `${branchSlug}|${date}|${startTime}|${className}|${teacherEmpNo || teacherName}`;
  const id = `${branchSlug}_${date}_${startTime || "0000"}_${fnv1aHex(idSeed)}`;

  return {
    id,
    branchSlug,
    branchName,
    date,
    dayOfWeek: chineseWeekday(dateObj),
    startTime,
    startHour: startTime.slice(0, 2),
    className,
    teacherName,
    teacherEmpNo,
    roomName,
    isSubstitute: raw.is_sub === "Y" ? 1 : 0,
    scrapedAt,
  };
}

// 分批送出並回傳所有語句的結果（依序）。同一批在 D1 裡是一個 transaction，批與批之間不是。
async function runBatched(db, statements) {
  const results = [];
  for (let i = 0; i < statements.length; i += BATCH_CHUNK_SIZE) {
    results.push(...(await db.batch(statements.slice(i, i + BATCH_CHUNK_SIZE))));
  }
  return results;
}

async function upsertBranches(db, branches) {
  const updatedAt = nowTaiwanIso();
  const stmts = branches
    .filter((b) => b.slug)
    .map((b) =>
      db
        .prepare("INSERT OR REPLACE INTO branches (slug, name, region, updatedAt) VALUES (?, ?, ?, ?)")
        .bind(b.slug, b.name, b.region, updatedAt)
    );
  await runBatched(db, stmts);
}

// 把這間分店這一輪的課表換成 transformed，回傳清掉的舊列數。
// 不是「先 DELETE 整間分店、再分批重寫」：那樣在分批寫入的這段時間（幾百毫秒到幾秒），這間分店是空的或只有一部分，
// 剛好有人查詢、或 sitemap/SSR 在這時重建並快取 30 分鐘，就看到殘缺資料；寫到一半失敗，更會留下殘缺資料到下一輪。
// 改成「先 upsert 這一輪的全部列（id 相同的原地更新），最後再清掉這間分店比這一輪舊的列」：
// - 任何時刻看得到的至少是舊資料，或舊資料加新資料（換了老師的課短暫有兩筆），不會有空窗
// - 中途失敗時舊資料原封不動，下一輪再清
// - 清除語句放在最後一批，跟最後一批的 upsert 在同一個 transaction 裡一起成功或一起失敗
// 這一輪所有列共用同一個 scrapedAt，它就是「比它舊的才算舊資料」的分水嶺。
// 這間分店這一輪沒有任何課（transformed 空）時，只剩清除語句，等於整間清空，跟以前一樣。
//
// 「upsert」用 ON CONFLICT(id) DO UPDATE，不用 INSERT OR REPLACE：後者遇到相同 id 是「先刪整列再插入」，
// 連帶把這列在每個索引裡的項目都刪掉重寫；而一天兩輪、每輪重寫整張表（約 8.7 千列），絕大多數列跟上一輪一模一樣，
// 白白多寫好幾倍的索引項目（D1 的 rows_written 是連索引項目一起算）。
// id 已經由 branchSlug、date、startTime、className、老師員編（沒有就用老師名）決定（見 transformRawClass），
// 同一個 id 的這些欄位（以及由它們推導出的 dayOfWeek、startHour）一定相同，所以只更新「同一個 id 之下還可能變」的欄位：
// 分店名稱、老師名稱與員編、教室、是否代課，以及 scrapedAt（新舊資料的分水嶺，每一輪都要更新）。
// className 刻意不放進 SET：它有索引，放進去等於每輪都重寫那條索引項目，而且同 id 下它不會變。
// （id 尾端是 32 位元 FNV 雜湊，同一分店同一天同一時間的兩堂不同課撞 id 的機率約 1/40 億；
// 撞了的話 INSERT OR REPLACE 是後者蓋掉前者，這裡會變成欄位混合，兩者都是壞資料，下一輪爬蟲會自己修正。）
async function replaceBranchClasses(db, branchSlug, transformed, scrapedAt) {
  const stmts = transformed.map((c) =>
    db
      .prepare(
        `INSERT INTO classes
          (id, branchSlug, branchName, date, dayOfWeek, startTime, startHour, className, teacherName, teacherEmpNo, roomName, isSubstitute, scrapedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
          branchName = excluded.branchName, teacherName = excluded.teacherName, teacherEmpNo = excluded.teacherEmpNo,
          roomName = excluded.roomName, isSubstitute = excluded.isSubstitute, scrapedAt = excluded.scrapedAt`
      )
      .bind(c.id, c.branchSlug, c.branchName, c.date, c.dayOfWeek, c.startTime, c.startHour, c.className, c.teacherName, c.teacherEmpNo, c.roomName, c.isSubstitute, c.scrapedAt)
  );
  stmts.push(db.prepare("DELETE FROM classes WHERE branchSlug = ? AND scrapedAt < ?").bind(branchSlug, scrapedAt));
  const results = await runBatched(db, stmts);
  return results[results.length - 1]?.meta?.changes || 0; // 只是給報表用的數字，寫入都成功了就不該因為它出錯
}

// 把一間分店「已經抓好的官網原始 JSON」轉換＋寫進 D1，呼叫端是本檔案下面的 runScrape。
// 每間分店各自負責自己的資料：寫入這次抓到的新資料、清掉這間分店的舊資料（寫法見 replaceBranchClasses），
// 不影響其他分店；只有官網資料真的抓到才會走到這裡，抓取失敗的話該分店舊資料原封不動。
async function ingestBranchClasses(db, branchSlug, branchName, rawClasses) {
  const firstDate = todayAtMidnight();
  const lastDate = addDays(firstDate, SCHEDULE_DAYS_AHEAD);
  const nearDate = addDays(firstDate, NEAR_DAYS_AHEAD);
  const todayIso = formatDateIso(firstDate);
  const lastDateIso = formatDateIso(lastDate);
  const nearDateIso = formatDateIso(nearDate);

  // 這一輪這間分店所有列共用同一個 scrapedAt（replaceBranchClasses 靠它分辨新舊資料）。
  const scrapedAt = nowTaiwanIso();
  // day0~day7 全存（見上方 NEAR_DAYS_AHEAD 的說明）；剩餘天數（day8~day13）只存代課，配合查詢端
  // （queryClasses.js 的 NORMAL_DAYS_AHEAD/SUBSTITUTE_DAYS_AHEAD 窗口）本來就只在遠期顯示代課。
  const transformed = rawClasses
    .map((raw) => transformRawClass(raw, branchSlug, branchName, scrapedAt))
    .filter(Boolean)
    .filter((item) => item.date >= todayIso && item.date <= lastDateIso)
    .filter((item) => item.date <= nearDateIso || item.isSubstitute === 1);

  const staleDeleted = await replaceBranchClasses(db, branchSlug, transformed, scrapedAt);
  return { classesWritten: transformed.length, staleDeleted };
}

// 清掉「不在目前 BRANCHES 清單裡」的分店舊課表資料——處理分店關店、從 branches-seed.js
// 移除之後留下的孤兒資料（因為 ingestBranchClasses 只會清「自己這間分店」比這一輪舊的資料，
// 一旦分店整個從清單消失，就再也沒有人會去清它的舊資料）。
// 不用「scrapedAt 太久沒更新」這種時間門檻來判斷，是因為爬蟲萬一連續幾輪都失敗（官網改版、網路問題），
// 還在營業的分店也會被時間門檻誤判成該清了。直接比對清單最準，不管多久沒重抓成功都不會誤刪。
async function cleanupStaleBranches(db) {
  const currentSlugs = new Set(BRANCHES.filter((b) => b.slug).map((b) => b.slug));
  if (currentSlugs.size === 0) return { deleted: 0, staleBranches: [] };

  // 分店清單上百家，綁進 SQL 的 NOT IN (?,?,...) 容易撞到 D1 單次查詢的變數上限，
  // 改成整張表的 distinct branchSlug 查出來，直接在 JS 裡跟目前清單做差集比較。
  const allRows = await db.prepare("SELECT DISTINCT branchSlug FROM classes").all();
  const staleBranches = allRows.results.map((r) => r.branchSlug).filter((slug) => !currentSlugs.has(slug));
  if (staleBranches.length === 0) return { deleted: 0, staleBranches: [] };

  const delPlaceholders = staleBranches.map(() => "?").join(",");
  const res = await db
    .prepare(`DELETE FROM classes WHERE branchSlug IN (${delPlaceholders})`)
    .bind(...staleBranches)
    .run();
  return { deleted: res.meta.changes || 0, staleBranches };
}

// 依出現次數由多到少排序（次數相同時依字母排序求穩定順序）。
function sortByCountDesc(rows, key) {
  return rows
    .slice()
    .sort((a, b) => b.cnt - a.cnt || a[key].localeCompare(b[key], "zh-Hant"))
    .map((r) => r[key]);
}

// 整輪爬蟲（每日排程或後台手動重抓）跑完後呼叫一次：對 classes 表
// GROUP BY 算出目前的課程/老師清單，寫進 meta_filter_options 快取，讓 /filterOptions
// 只要讀一列資料就好，不用每次頁面載入都重新 GROUP BY 整張表。
// 跟之前一樣的保護：只有真的算出資料才覆寫，全部分店都失敗、算出來是空的話保留舊快取。
async function finalizeFilterOptions(db) {
  const [classRows, teacherRows] = await Promise.all([
    db.prepare("SELECT className, COUNT(*) as cnt FROM classes WHERE className != '' GROUP BY className").all(),
    db.prepare("SELECT teacherName, COUNT(*) as cnt FROM classes WHERE teacherName != '' GROUP BY teacherName").all(),
  ]);
  const classNames = sortByCountDesc(classRows.results, "className");
  const teacherNames = sortByCountDesc(teacherRows.results, "teacherName");
  if (classNames.length === 0 && teacherNames.length === 0) {
    return { classNames: 0, teacherNames: 0, skipped: true };
  }
  await db
    .prepare("INSERT OR REPLACE INTO meta_filter_options (id, classNames, teacherNames, updatedAt) VALUES (?, ?, ?, ?)")
    .bind("filterOptions", JSON.stringify(classNames), JSON.stringify(teacherNames), nowTaiwanIso())
    .run();
  return { classNames: classNames.length, teacherNames: teacherNames.length, skipped: false };
}

// 每次一定跑全部分店：每間分店一個 subrequest（目前 110 間），「單次執行」就用掉一百多個，
// 需要 Workers Paid 方案（單次執行 subrequest 上限 1000）才跑得完。
// 由每日排程（scheduled）跟手動的 /scrapeManual 呼叫。不再支援只重抓單一分店。
// onProgress(text) 是選用的即時進度回報（給 /scrapeManual 串流給前端終端機用），跟 logger 是分開的兩條輸出。
async function runScrape(db, { logger = console, onProgress = () => {} } = {}) {
  const summary = {
    branchesTotal: BRANCHES.length,
    branchesOk: 0,
    classesWritten: 0,
    staleDeleted: 0,
    errors: [],
  };

  onProgress("🏁 初始化爬蟲...");
  await upsertBranches(db, BRANCHES);
  logger.log(`[worldgym] using ${BRANCHES.length} seeded branches`);

  const firstDate = todayAtMidnight();
  const lastDate = addDays(firstDate, SCHEDULE_DAYS_AHEAD);
  onProgress(`📅 日期範圍: ${formatDateSlash(firstDate)} ~ ${formatDateSlash(lastDate)}`);
  onProgress(`🏪 預計抓取分店數: ${BRANCHES.length}`);

  let i = 0;
  for (const branch of BRANCHES) {
    if (!branch.slug) continue;
    i++;
    onProgress(`(${i}/${BRANCHES.length}) 讀取: ${branch.name} (${branch.slug})...`);
    try {
      const rawClasses = await fetchBranchSchedule(branch.slug, firstDate, lastDate);
      const result = await ingestBranchClasses(db, branch.slug, branch.name, rawClasses);
      summary.classesWritten += result.classesWritten;
      summary.staleDeleted += result.staleDeleted;
      summary.branchesOk++;
      onProgress(`　　→ 寫入 ${result.classesWritten} 筆課程`);
      onProgress(`✅ ${branch.name} 更新完成`);
    } catch (err) {
      logger.error(`[worldgym] branch ${branch.slug} failed: ${err.message}`);
      summary.errors.push({ branch: branch.slug, message: err.message });
      onProgress(`❌ ${branch.name} 失敗: ${err.message}`);
    }
    await sleep(BRANCH_REQUEST_DELAY_MS);
  }

  if (summary.branchesOk > 0) {
    await finalizeFilterOptions(db);
    onProgress("🔄 已更新課程/老師篩選快取");
  }

  onProgress("🎉 全部作業完成！");
  logger.log(`[worldgym] done: ${JSON.stringify(summary)}`);
  return summary;
}

export { runScrape, ingestBranchClasses, finalizeFilterOptions, fetchBranchSchedule, transformRawClass, chineseWeekday, cleanupStaleBranches };
