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

-- 老師查詢次數記錄。使用者送出查詢（含指定老師）且成功顯示結果（不是 0 筆、也不是超過
-- RESULT_COUNT_WARN_LIMIT 顯示不出來）時才寫一列，前端已做 30 分鐘內同老師去重，這裡單純累加，不做聚合。
CREATE TABLE teacher_search_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  teacherName TEXT NOT NULL,
  createdAt TEXT NOT NULL
);

CREATE INDEX idx_teacher_search_events_teacherName ON teacher_search_events(teacherName);
CREATE INDEX idx_teacher_search_events_createdAt ON teacher_search_events(createdAt);

-- 課程查詢次數記錄，邏輯跟 teacher_search_events 一樣：使用者真的送出查詢（含指定課程）時寫一列，
-- 前端已做 30 分鐘內同課程去重。
CREATE TABLE course_search_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  courseName TEXT NOT NULL,
  createdAt TEXT NOT NULL
);

CREATE INDEX idx_course_search_events_courseName ON course_search_events(courseName);
CREATE INDEX idx_course_search_events_createdAt ON course_search_events(createdAt);

-- 分店查詢次數記錄，邏輯跟 teacher_search_events/course_search_events 一樣。
CREATE TABLE branch_search_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  branchName TEXT NOT NULL,
  createdAt TEXT NOT NULL
);

CREATE INDEX idx_branch_search_events_branchName ON branch_search_events(branchName);
CREATE INDEX idx_branch_search_events_createdAt ON branch_search_events(createdAt);

-- 整體查詢量記錄：每次使用者真的送出查詢就寫一列，不做去重（要看的是真實使用量、不是排行榜），
-- 用來在 admin.html 畫「每月查詢次數」趨勢折線圖。resultCount 記錄這次查詢實際顯示的課程數，
-- 沒有結果或結果太多沒顯示時也照樣 +1 一列查詢次數，resultCount 就記實際數字（0 或超量的數字）。
CREATE TABLE search_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  createdAt TEXT NOT NULL,
  resultCount INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_search_events_createdAt ON search_events(createdAt);

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
