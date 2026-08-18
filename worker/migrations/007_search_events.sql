-- 整體查詢量記錄：每次使用者真的送出查詢就寫一列，不做去重（要看的是真實使用量、不是排行榜），
-- 用來在 admin.html 畫「每月查詢次數」趨勢折線圖。
CREATE TABLE search_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  createdAt TEXT NOT NULL
);

CREATE INDEX idx_search_events_createdAt ON search_events(createdAt);
