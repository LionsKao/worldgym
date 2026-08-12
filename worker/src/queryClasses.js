const NORMAL_DAYS_AHEAD = 7;
const SUBSTITUTE_DAYS_AHEAD = 14;
// course/teacher 走 SQL IN 子句，D1 每個查詢的綁定參數上限是 100，
// course+teacher 兩個 IN 子句（30*2=60）加上 day(7)+room(2)+日期範圍(4) = 73，還有餘裕。
const IN_LIMIT = 30;
// branch 不透過 IN 子句下推（見下方 queryClasses 裡的說明），只是防濫用的天花板，
// 目前總共只有 106 家分店，不會真的卡到使用者。
const BRANCH_LIMIT = 150;
const ROOM_VALUES = new Set(["團體教室", "飛輪教室"]);

function pad2(n) {
  return String(n).padStart(2, "0");
}

// 用 Asia/Taipei 而不是執行環境的 UTC，避免台北時間 00:00~08:00
// 這段區間算出「昨天」，導致查詢範圍少了今天的課。
function todayIsoTaipei() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei" }).format(new Date());
}
function addDaysIso(iso, days) {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

function sanitizeStringArray(value, maxLen) {
  if (!Array.isArray(value)) return [];
  return value.filter((v) => typeof v === "string" && v.length > 0 && v.length < 200).slice(0, maxLen);
}

// 7 天內同一個「分店+星期+時間+課程+老師」的固定班表只留一筆（不顯示日期）；
// 代課(isSubstitute)不保證下週還是同一個老師，所以撈到的 8~14 天代課每一筆都保留、標示 flagged。
function buildDisplayRows(rows) {
  const normalMap = new Map();
  const subRows = [];
  rows.forEach((c) => {
    if (c.isSubstitute) {
      subRows.push(c);
    } else {
      const key = [c.branchSlug, c.dayOfWeek, c.startTime, c.className, c.teacherName].join("|");
      if (!normalMap.has(key)) normalMap.set(key, c);
    }
  });
  const out = [...normalMap.values()].map((c) => ({ c, flagged: false }))
    .concat(subRows.map((c) => ({ c, flagged: true })));
  // 依「離今天最近的實際日期」排序，不是依星期幾（1=一...7=日）排序 —
  // 不然不管今天星期幾，畫面永遠先列星期一的課，會讓人誤以為資料是從星期一開始抓的。
  // normalMap 裡每筆固定班表存的是它最近一次出現的 date（rows 進來前已經照 date 排過），
  // 所以直接照這個 date 排序就會是「最快要來的課排最前面」。
  out.sort((a, b) => a.c.date.localeCompare(b.c.date) || a.c.startTime.localeCompare(b.c.startTime));
  return out;
}

function inClause(column, values, params) {
  params.push(...values);
  return `${column} IN (${values.map(() => "?").join(",")})`;
}

// SQL 的 IN 子句沒有 Firestore 那種「一次查詢只能一個 in」的限制，
// 所以課程/老師/星期/教室可以全部一起下條件。分店例外：前端不再限制分店選幾間，
// 選很多間時全部塞進一個 IN 子句可能逼近 D1 每查詢 100 個綁定參數的上限，
// 所以分店改成撈完日期範圍＋其他篩選後，在這裡用 JS 過濾——反正 classes 全表也才幾千筆，
// 不下推分店條件對讀取量影響可忽略。
async function queryClasses(db, rawState) {
  const branch = sanitizeStringArray(rawState.branch, BRANCH_LIMIT);
  const course = sanitizeStringArray(rawState.course, IN_LIMIT);
  const teacher = sanitizeStringArray(rawState.teacher, IN_LIMIT);
  const room = sanitizeStringArray(rawState.room, 2).filter((v) => ROOM_VALUES.has(v));
  const day = sanitizeStringArray(rawState.day, 7)
    .map(Number)
    .filter((n) => Number.isInteger(n) && n >= 1 && n <= 7);

  const from = todayIsoTaipei();
  const normalTo = addDaysIso(from, NORMAL_DAYS_AHEAD);
  const subFrom = addDaysIso(normalTo, 1);
  const subTo = addDaysIso(from, SUBSTITUTE_DAYS_AHEAD);

  const params = [];
  // 未來 7 天內不分正常班/代課全部顯示；8~14 天只顯示已知的代課，藉此把讀取量砍半。
  const conditions = [`((date >= ? AND date <= ?) OR (date >= ? AND date <= ? AND isSubstitute = 1))`];
  params.push(from, normalTo, subFrom, subTo);

  if (course.length > 0) conditions.push(inClause("className", course, params));
  if (teacher.length > 0) conditions.push(inClause("teacherName", teacher, params));
  if (day.length > 0) conditions.push(inClause("dayOfWeek", day, params));
  if (room.length > 0) conditions.push(inClause("roomName", room, params));

  const sql = `SELECT branchSlug, branchName, date, dayOfWeek, startTime, className, teacherName, roomName, isSubstitute
    FROM classes WHERE ${conditions.map((c) => `(${c})`).join(" AND ")} ORDER BY date, startTime`;

  const { results } = await db.prepare(sql).bind(...params).all();
  let docs = results.map((r) => ({ ...r, isSubstitute: r.isSubstitute === 1 }));
  if (branch.length > 0) {
    const branchSet = new Set(branch);
    docs = docs.filter((c) => branchSet.has(c.branchSlug));
  }
  const fetchedCount = docs.length;

  const rows = buildDisplayRows(docs);
  return { rows, fetchedCount, displayedCount: rows.length };
}

export { queryClasses };
