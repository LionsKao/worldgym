import BRANCHES from "./branches-seed.js";

const SCHEDULE_DAYS_AHEAD = 13;
// 104 家分店依序（非平行）逐一請求，跟 group.aspx.cs 的爬蟲間隔對齊。
const BRANCH_REQUEST_DELAY_MS = 500;
// D1 batch 一次太多語句容易超時，分批送出。
const BATCH_CHUNK_SIZE = 50;

// Matches the User-Agent the legacy C# scraper used against this endpoint;
// requests without a browser-like UA get rejected by the site.
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

// D1 裡存的時間戳一律用台灣時間（+8），不是 UTC —— 純位移 8 小時再貼 +08:00 後綴，
// 不用 Intl.DateTimeFormat 是因為那個格式化起來反而更囉唆。
function nowTaiwanIso() {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  return d.toISOString().replace("Z", "+08:00");
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

function todayAtMidnight() {
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  return now;
}

// Chinese convention: Monday=1 ... Sunday=7 (JS getDay() is Sunday=0 ... Saturday=6).
function chineseWeekday(date) {
  const jsDay = date.getDay();
  return jsDay === 0 ? 7 : jsDay;
}

// Workers 的 Web Crypto 沒有 MD5，這裡只是要一組穩定、大致不重複的短字串接在 docId 後面
// 做同分店/日期/時段內多筆課程的區隔，不是安全用途，FNV-1a 這種非加密雜湊就夠用。
function fnv1aHex(str) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
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
      "User-Agent": USER_AGENT,
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
function normalizeRoomName(rawRoomName) {
  const name = (rawRoomName || "").trim();
  if (name.includes("飛輪")) return "飛輪教室";
  if (name.includes("團體")) return "團體教室";
  return name;
}

// Mirrors the transform rules from the legacy group.aspx.cs GetWorldGymData.
function transformRawClass(raw, branchSlug, branchName) {
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
    scrapedAt: nowTaiwanIso(),
  };
}

async function runBatched(db, statements) {
  for (let i = 0; i < statements.length; i += BATCH_CHUNK_SIZE) {
    await db.batch(statements.slice(i, i + BATCH_CHUNK_SIZE));
  }
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

async function upsertClasses(db, transformed) {
  const stmts = transformed.map((c) =>
    db
      .prepare(
        `INSERT OR REPLACE INTO classes
          (id, branchSlug, branchName, date, dayOfWeek, startTime, startHour, className, teacherName, teacherEmpNo, roomName, isSubstitute, scrapedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(c.id, c.branchSlug, c.branchName, c.date, c.dayOfWeek, c.startTime, c.startHour, c.className, c.teacherName, c.teacherEmpNo, c.roomName, c.isSubstitute, c.scrapedAt)
  );
  await runBatched(db, stmts);
}

// D1/SQLite 沒有 TRUNCATE TABLE 語法，DELETE FROM WHERE branchSlug 就是清掉這一間分店的舊資料。
// 只在這間分店的官網資料真的抓到之後才呼叫（見下面 ingestBranchClasses）——
// 抓取失敗的話不會走到這裡，該分店舊資料原封不動保留，不會被清空後補不回來。
async function deleteBranchClasses(db, branchSlug) {
  const res = await db.prepare("DELETE FROM classes WHERE branchSlug = ?").bind(branchSlug).run();
  return res.meta.changes || 0;
}

// 把一間分店「已經抓好的官網原始 JSON」轉換＋寫進 D1，呼叫端是本檔案下面的 runScrape。
// 每間分店各自負責自己的資料：先刪這間分店的舊資料，再寫入這次抓到的新資料，不影響其他分店。
async function ingestBranchClasses(db, branchSlug, branchName, rawClasses) {
  const firstDate = todayAtMidnight();
  const lastDate = addDays(firstDate, SCHEDULE_DAYS_AHEAD);
  const todayIso = formatDateIso(firstDate);
  const lastDateIso = formatDateIso(lastDate);

  // 不再區分「前幾天存全部、後幾天只存代課」——抓到多少課程就存多少，抓多少天就存多少天。
  const transformed = rawClasses
    .map((raw) => transformRawClass(raw, branchSlug, branchName))
    .filter(Boolean)
    .filter((item) => item.date >= todayIso && item.date <= lastDateIso);

  const staleDeleted = await deleteBranchClasses(db, branchSlug);
  await upsertClasses(db, transformed);
  return { classesWritten: transformed.length, staleDeleted };
}

// 清掉「不在目前 BRANCHES 清單裡」的分店舊課表資料——處理分店關店、從 branches-seed.js
// 移除之後留下的孤兒資料（因為 ingestBranchClasses 現在只在該分店還有被抓到資料時才會刪它，
// 一旦分店整個從清單消失，就再也沒有人會去清它的舊資料）。
// 不用「scrapedAt 太久沒更新」這種時間門檻來判斷，是因為爬蟲目前沒有自動排程，只能手動按重抓，
// 太久沒人按的話，還在營業的分店也會被時間門檻誤判成該清了。直接比對清單最準，不管多久沒重抓都不會誤刪。
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

// 整輪爬蟲（不管是 Worker 自己跑還是 Firebase 分批 ingest）跑完後呼叫一次：對 classes 表
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

// 每次一定跑全部分店：104 家分店逐一發出 subrequest，「單次執行」就用掉 104 個，
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
