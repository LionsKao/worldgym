-- 只新增 ads table，不動 classes/branches/reminders 既有資料。
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
