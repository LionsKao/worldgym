-- worldgym-schedule D1 schema
-- Mirrors the old Firestore collections: classes, branches, meta/filterOptions.
-- SQL supports multiple IN clauses per query, so unlike Firestore we don't need
-- the combinatorial composite indexes that firestore.indexes.json had.

DROP TABLE IF EXISTS classes;
CREATE TABLE classes (
  id TEXT PRIMARY KEY,
  branchSlug TEXT NOT NULL,
  branchName TEXT NOT NULL,
  date TEXT NOT NULL,
  dayOfWeek INTEGER NOT NULL,
  startTime TEXT NOT NULL,
  startHour TEXT NOT NULL DEFAULT '',
  className TEXT NOT NULL,
  teacherName TEXT NOT NULL,
  teacherEmpNo TEXT NOT NULL DEFAULT '',
  roomName TEXT NOT NULL,
  isSubstitute INTEGER NOT NULL DEFAULT 0,
  scrapedAt TEXT NOT NULL
);

CREATE INDEX idx_classes_date ON classes(date, startTime);
CREATE INDEX idx_classes_branch ON classes(branchSlug, date, startTime);
CREATE INDEX idx_classes_className ON classes(className);
CREATE INDEX idx_classes_teacherName ON classes(teacherName);
CREATE INDEX idx_classes_teacherEmpNo ON classes(teacherEmpNo);
CREATE INDEX idx_classes_dayOfWeek ON classes(dayOfWeek);
CREATE INDEX idx_classes_roomName ON classes(roomName);
CREATE INDEX idx_classes_startHour ON classes(startHour);

DROP TABLE IF EXISTS branches;
CREATE TABLE branches (
  slug TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  region TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);

DROP TABLE IF EXISTS meta_filter_options;
CREATE TABLE meta_filter_options (
  id TEXT PRIMARY KEY,
  classNames TEXT NOT NULL,
  teacherNames TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);

DROP TABLE IF EXISTS reminders;
CREATE TABLE reminders (
  id TEXT PRIMARY KEY,
  branchSlug TEXT NOT NULL,
  branchName TEXT NOT NULL,
  className TEXT NOT NULL,
  teacherName TEXT NOT NULL,
  roomName TEXT NOT NULL,
  dayOfWeek INTEGER NOT NULL,
  startTime TEXT NOT NULL,
  classAt TEXT NOT NULL,
  remindAt TEXT NOT NULL,
  subscriptionEndpoint TEXT NOT NULL,
  pushSubscription TEXT NOT NULL,
  clickUrl TEXT NOT NULL DEFAULT '',
  sent INTEGER NOT NULL DEFAULT 0,
  createdAt TEXT NOT NULL
);

CREATE INDEX idx_reminders_pending ON reminders(sent, remindAt);
CREATE INDEX idx_reminders_endpoint ON reminders(subscriptionEndpoint);

-- 首頁廣告輪播。startAt/endAt 是 ISO 8601 字串，上下架時間到了自動生效/失效；
-- enabled 是額外的手動開關，臨時要下架某則廣告不用改時間，直接把這欄改 0 即可。
DROP TABLE IF EXISTS ads;
CREATE TABLE ads (
  id TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  url TEXT NOT NULL,
  startAt TEXT NOT NULL,
  endAt TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  sortOrder INTEGER NOT NULL DEFAULT 0,
  advertiser TEXT
);

CREATE INDEX idx_ads_active ON ads(enabled, startAt, endAt);

INSERT INTO ads (id, text, url, startAt, endAt, enabled, sortOrder, advertiser) VALUES
  ('ad-1', '📍 大安黃金地段 1 樓免爬樓！質感時尚裝潢與獨立衛浴，輕鬆享受便利生活！ ✨', 'https://www.dd-room.com/object/wkx02awwk4xntjhk', '2026-01-01T00:00:00Z', '2027-12-31T23:59:59Z', 1, 0, 'dawson'),
  ('ad-2', '🌿 坐落大安區四維路，兼具靜謐與便利的 1 樓時尚獨衛套房，質感生活隨時開啟！ 🛋️', 'https://www.dd-room.com/object/wkx02awwk4xntjhk', '2026-01-01T00:00:00Z', '2027-12-31T23:59:59Z', 1, 1, 'dawson'),
  ('ad-3', '🔑 台北大安區精緻 6 坪獨立衛浴套房，一樓出入順暢、機能滿分，優質租屋首選！ 💯', 'https://www.dd-room.com/object/wkx02awwk4xntjhk', '2026-01-01T00:00:00Z', '2027-12-31T23:59:59Z', 1, 2, 'dawson'),
  ('ad-4', '🏋️‍♂️ 健身｜黝黑｜陽光生活 🏡 新莊公園旁｜質感自住獨立空間 💫 保持開放心態，探索各種關係的無限可能 ✨ 📩 DMs are open, 歡迎私訊聊天！💬', 'https://www.instagram.com/e713300', '2026-01-01T00:00:00Z', '2027-12-31T23:59:59Z', 1, 3, 'e713300'),
  ('ad-5', '一句話，找到你想上的課——【世界健忘中心】，課表不用翻，直接問就好。', 'https://worldforgetful.tw/schedule-query', '2026-08-17T00:00:00Z', '2099-12-31T23:59:59Z', 1, 4, 'cp');

-- 廣告曝光/點擊事件記錄。每次曝光或點擊各寫一列，不做聚合，
-- 方便未來要依時間區間篩選時直接 WHERE createdAt BETWEEN ...，不用改 schema。
CREATE TABLE ad_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  adId TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('impression', 'click')),
  createdAt TEXT NOT NULL
);

CREATE INDEX idx_ad_events_adId_type ON ad_events(adId, type);
CREATE INDEX idx_ad_events_createdAt ON ad_events(createdAt);
-- analytics.js 的月度彙總查詢用 substr(createdAt,1,7) 篩選月份，上面 idx_ad_events_createdAt
-- 是建在原始欄位上，包了 substr() 之後吃不到，另建運算式索引（見 migrations/015）。
CREATE INDEX idx_ad_events_month ON ad_events(substr(createdAt,1,7));

-- 老師查詢次數記錄。使用者送出查詢（含指定老師）且成功顯示結果（不是 0 筆、也不是超過
-- RESULT_COUNT_WARN_LIMIT 顯示不出來）時才寫一列，前端已做 30 分鐘內同老師去重，這裡單純累加，不做聚合。
CREATE TABLE teacher_search_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  teacherName TEXT NOT NULL,
  createdAt TEXT NOT NULL
);

CREATE INDEX idx_teacher_search_events_teacherName ON teacher_search_events(teacherName);
CREATE INDEX idx_teacher_search_events_createdAt ON teacher_search_events(createdAt);
-- analytics.js 用 substr(createdAt,1,7)/substr(createdAt,1,4) 篩選月份/年份，上面兩個索引
-- 是建在原始欄位上，包了 substr() 之後吃不到，另建運算式索引（見 migrations/015）。
CREATE INDEX idx_teacher_search_events_month ON teacher_search_events(substr(createdAt,1,7));
CREATE INDEX idx_teacher_search_events_year ON teacher_search_events(substr(createdAt,1,4));

-- 課程查詢次數記錄，邏輯跟 teacher_search_events 一樣：使用者真的送出查詢（含指定課程）時寫一列，
-- 前端已做 30 分鐘內同課程去重。
CREATE TABLE course_search_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  courseName TEXT NOT NULL,
  createdAt TEXT NOT NULL
);

CREATE INDEX idx_course_search_events_courseName ON course_search_events(courseName);
CREATE INDEX idx_course_search_events_createdAt ON course_search_events(createdAt);
-- 同 teacher_search_events：另建 substr() 運算式索引（見 migrations/015）。
CREATE INDEX idx_course_search_events_month ON course_search_events(substr(createdAt,1,7));
CREATE INDEX idx_course_search_events_year ON course_search_events(substr(createdAt,1,4));

-- 分店查詢次數記錄，邏輯跟 teacher_search_events/course_search_events 一樣。
CREATE TABLE branch_search_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  branchName TEXT NOT NULL,
  createdAt TEXT NOT NULL
);

CREATE INDEX idx_branch_search_events_branchName ON branch_search_events(branchName);
CREATE INDEX idx_branch_search_events_createdAt ON branch_search_events(createdAt);
-- 同 teacher_search_events：另建 substr() 運算式索引（見 migrations/015）。
CREATE INDEX idx_branch_search_events_month ON branch_search_events(substr(createdAt,1,7));
CREATE INDEX idx_branch_search_events_year ON branch_search_events(substr(createdAt,1,4));

-- 整體查詢量記錄：每次使用者真的送出查詢就寫一列，不做去重（要看的是真實使用量、不是排行榜），
-- 用來在 admin.html 畫「每月查詢次數」趨勢折線圖。resultCount 記錄這次查詢實際顯示的課程數，
-- 沒有結果或結果太多沒顯示時也照樣 +1 一列查詢次數，resultCount 就記實際數字（0 或超量的數字）。
CREATE TABLE search_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  createdAt TEXT NOT NULL,
  resultCount INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_search_events_createdAt ON search_events(createdAt);
-- monthlySearchTrend() 用 substr(createdAt,1,7) 篩選月份，上面索引建在原始欄位上吃不到，
-- 另建運算式索引（見 migrations/015）。
CREATE INDEX idx_search_events_month ON search_events(substr(createdAt,1,7));

-- 「我的最愛」使用記錄：clientId 是前端自己產生存在 localStorage 的匿名 id（不是帳號系統，
-- 沒有登入機制，只能用這個估算「幾個人」）。type='add' 是成功建立一個最愛時記一列，
-- 用 COUNT(DISTINCT clientId) 估算有多少人做過這個功能；type='apply' 是每次點最愛套用篩選時記一列，
-- 不去重，單純看總共被按了幾次。
CREATE TABLE favorite_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  clientId TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('add', 'apply')),
  createdAt TEXT NOT NULL
);

CREATE INDEX idx_favorite_events_type_createdAt ON favorite_events(type, createdAt);
CREATE INDEX idx_favorite_events_clientId ON favorite_events(clientId);
-- favoriteStatsCombined() 用 substr(createdAt,1,7) 篩選月份，上面索引吃不到，
-- 另建運算式索引（見 migrations/015）。
CREATE INDEX idx_favorite_events_month ON favorite_events(substr(createdAt,1,7));

-- /issueToken、/queryClasses 這兩個公開端點的存取紀錄：記 IP/UA/是否被流量限制擋下，
-- 事後才有辦法追查是不是被爬蟲/腳本大量打（search_events 完全沒記來源，查不出是誰）。
CREATE TABLE query_access_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  endpoint TEXT NOT NULL,
  ip TEXT NOT NULL,
  userAgent TEXT,
  rateLimited INTEGER NOT NULL DEFAULT 0,
  createdAt TEXT NOT NULL
);

CREATE INDEX idx_query_access_log_createdAt ON query_access_log(createdAt);
CREATE INDEX idx_query_access_log_ip ON query_access_log(ip);

-- 提醒功能使用量記錄：每次成功登記一顆提醒（/registerReminder）就記一列，純粹看
-- 每個月被觸發幾次，用來評估這個功能有沒有人在用；不分辨是不是同一人、也不追蹤取消。
DROP TABLE IF EXISTS reminder_add_events;
CREATE TABLE reminder_add_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  createdAt TEXT NOT NULL
);

CREATE INDEX idx_reminder_add_events_createdAt ON reminder_add_events(createdAt);
-- reminderStatsCombined()/rollupAnalyticsEvents() 用 substr(createdAt,1,7) 篩選月份，
-- 上面索引建在原始欄位上吃不到，另建運算式索引（見 migrations/016）。
CREATE INDEX idx_reminder_add_events_month ON reminder_add_events(substr(createdAt,1,7));

-- 分析報表「明細 -> 每月彙總」機制（見 worker/src/analytics.js）：teacher/course/branch
-- 查詢次數、整體查詢量、我的最愛、廣告曝光/點擊、提醒登記這幾張明細表只保留當月，上個月一結束
-- 就由每月排程壓縮寫進這裡、刪除明細；報表查詢改成「彙總表 UNION ALL 明細表」。
DROP TABLE IF EXISTS teacher_search_monthly;
CREATE TABLE teacher_search_monthly (
  month TEXT NOT NULL,
  teacherName TEXT NOT NULL,
  cnt INTEGER NOT NULL,
  PRIMARY KEY (month, teacherName)
);

DROP TABLE IF EXISTS course_search_monthly;
CREATE TABLE course_search_monthly (
  month TEXT NOT NULL,
  courseName TEXT NOT NULL,
  cnt INTEGER NOT NULL,
  PRIMARY KEY (month, courseName)
);

DROP TABLE IF EXISTS branch_search_monthly;
CREATE TABLE branch_search_monthly (
  month TEXT NOT NULL,
  branchName TEXT NOT NULL,
  cnt INTEGER NOT NULL,
  PRIMARY KEY (month, branchName)
);

DROP TABLE IF EXISTS search_monthly;
CREATE TABLE search_monthly (
  month TEXT PRIMARY KEY,
  cnt INTEGER NOT NULL,
  resultSum INTEGER NOT NULL DEFAULT 0
);

-- reminder_add_events 的月度彙總，沒有名稱維度，邏輯跟 search_monthly 一樣。
DROP TABLE IF EXISTS reminder_add_monthly;
CREATE TABLE reminder_add_monthly (
  month TEXT PRIMARY KEY,
  cnt INTEGER NOT NULL
);

-- type='add' 的 cnt 是彙總當下算好、凍結的「當月去重人數」；type='apply' 單純加總。
-- 全時間的去重人數另外看 favorite_client_seen，不受這張表影響。
DROP TABLE IF EXISTS favorite_monthly;
CREATE TABLE favorite_monthly (
  month TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('add', 'apply')),
  cnt INTEGER NOT NULL,
  PRIMARY KEY (month, type)
);

-- 「全時間去重人數」即時維護（/trackFavorite 每次 type='add' 就 INSERT OR IGNORE 一次），
-- 不依賴 favorite_events 明細是否還在。表本身只隨「不重複的人數」成長，天生有界。
DROP TABLE IF EXISTS favorite_client_seen;
CREATE TABLE favorite_client_seen (
  clientId TEXT PRIMARY KEY,
  firstSeenAt TEXT NOT NULL
);

DROP TABLE IF EXISTS ad_monthly;
CREATE TABLE ad_monthly (
  month TEXT NOT NULL,
  adId TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('impression', 'click')),
  cnt INTEGER NOT NULL,
  PRIMARY KEY (month, adId, type)
);
