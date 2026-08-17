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
  sortOrder INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_ads_active ON ads(enabled, startAt, endAt);

INSERT INTO ads (id, text, url, startAt, endAt, enabled, sortOrder) VALUES
  ('ad-1', '📍 大安黃金地段 1 樓免爬樓！質感時尚裝潢與獨立衛浴，輕鬆享受便利生活！ ✨', 'https://www.dd-room.com/object/wkx02awwk4xntjhk', '2026-01-01T00:00:00Z', '2027-12-31T23:59:59Z', 1, 0),
  ('ad-2', '🌿 坐落大安區四維路，兼具靜謐與便利的 1 樓時尚獨衛套房，質感生活隨時開啟！ 🛋️', 'https://www.dd-room.com/object/wkx02awwk4xntjhk', '2026-01-01T00:00:00Z', '2027-12-31T23:59:59Z', 1, 1),
  ('ad-3', '🔑 台北大安區精緻 6 坪獨立衛浴套房，一樓出入順暢、機能滿分，優質租屋首選！ 💯', 'https://www.dd-room.com/object/wkx02awwk4xntjhk', '2026-01-01T00:00:00Z', '2027-12-31T23:59:59Z', 1, 2),
  ('ad-4', '🏋️‍♂️ 健身｜黝黑｜陽光生活 🏡 新莊公園旁｜質感自住獨立空間 💫 保持開放心態，探索各種關係的無限可能 ✨ 📩 DMs are open, 歡迎私訊聊天！💬', 'https://www.instagram.com/e713300', '2026-01-01T00:00:00Z', '2027-12-31T23:59:59Z', 1, 3);

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
