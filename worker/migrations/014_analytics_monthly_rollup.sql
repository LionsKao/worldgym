-- 分析報表「明細 -> 每月彙總」機制：teacher/course/branch 查詢次數、整體查詢量、我的最愛、
-- 廣告曝光/點擊這幾張明細表只保留最近 2 個月（含當月），更早的月份由每月排程
-- （worker/src/analytics.js 的 rollupAnalyticsEvents，見 index.js 的 scheduled()）壓縮寫進
-- 這裡對應的彙總表、刪除明細；報表查詢改成「彙總表 UNION ALL 明細表」，兩者依月份天生互斥。

CREATE TABLE teacher_search_monthly (
  month TEXT NOT NULL,
  teacherName TEXT NOT NULL,
  cnt INTEGER NOT NULL,
  PRIMARY KEY (month, teacherName)
);

CREATE TABLE course_search_monthly (
  month TEXT NOT NULL,
  courseName TEXT NOT NULL,
  cnt INTEGER NOT NULL,
  PRIMARY KEY (month, courseName)
);

CREATE TABLE branch_search_monthly (
  month TEXT NOT NULL,
  branchName TEXT NOT NULL,
  cnt INTEGER NOT NULL,
  PRIMARY KEY (month, branchName)
);

CREATE TABLE search_monthly (
  month TEXT PRIMARY KEY,
  cnt INTEGER NOT NULL,
  resultSum INTEGER NOT NULL DEFAULT 0
);

-- type='add' 的 cnt 是彙總當下算好、凍結的「當月去重人數」（壓縮後就沒有明細可以重新去重了）；
-- type='apply' 的 cnt 是單純加總，不去重。全時間的去重人數另外看 favorite_client_seen，不受這張表影響。
CREATE TABLE favorite_monthly (
  month TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('add', 'apply')),
  cnt INTEGER NOT NULL,
  PRIMARY KEY (month, type)
);

-- 「全時間去重人數」用這張表即時維護（/trackFavorite 每次 type='add' 就 INSERT OR IGNORE 一次），
-- 不依賴 favorite_events 明細是否還在，讓「累積建立人數」這個總數字永遠準確、不受清理影響。
-- 表本身只會隨「不重複的人數」成長，不會隨事件次數成長，天生有界。
CREATE TABLE favorite_client_seen (
  clientId TEXT PRIMARY KEY,
  firstSeenAt TEXT NOT NULL
);

-- 從既有明細一次性回填，讓這張表上線當下就反映正確的歷史去重人數，不用歸零重算。
INSERT OR IGNORE INTO favorite_client_seen (clientId, firstSeenAt)
SELECT clientId, MIN(createdAt) FROM favorite_events WHERE type = 'add' GROUP BY clientId;

CREATE TABLE ad_monthly (
  month TEXT NOT NULL,
  adId TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('impression', 'click')),
  cnt INTEGER NOT NULL,
  PRIMARY KEY (month, adId, type)
);
