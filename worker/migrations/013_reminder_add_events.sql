-- 提醒功能使用量記錄：每次成功登記一顆提醒（/registerReminder）就記一列，純粹看
-- 每個月被觸發幾次，用來評估這個功能有沒有人在用；不分辨是不是同一人、也不追蹤取消。
CREATE TABLE reminder_add_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  createdAt TEXT NOT NULL
);

CREATE INDEX idx_reminder_add_events_createdAt ON reminder_add_events(createdAt);
