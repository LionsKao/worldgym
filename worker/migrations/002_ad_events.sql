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
