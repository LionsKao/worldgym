-- reminder_add_events 補上跟 teacher/course/branch_search_events 等表一樣的「明細 -> 月度彙總」機制
-- （見 worker/src/analytics.js 的 rollupAnalyticsEvents/reminderStatsCombined）。
-- 沒有名稱維度，只彙總成 (month -> cnt)，邏輯跟 search_events/search_monthly 一樣。

CREATE TABLE reminder_add_monthly (
  month TEXT PRIMARY KEY,
  cnt INTEGER NOT NULL
);

-- reminderStatsCombined()/rollupAnalyticsEvents() 都用 substr(createdAt,1,7) 篩選月份，
-- 直接建運算式索引，避免跟其他 6 張明細表一樣先全表掃描才發現要補索引。
CREATE INDEX idx_reminder_add_events_month ON reminder_add_events(substr(createdAt,1,7));
