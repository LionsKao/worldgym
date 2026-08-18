-- 「我的最愛」使用記錄：clientId 是前端自己產生存在 localStorage 的匿名 id，
-- type='add' 記成功建立最愛（COUNT(DISTINCT clientId) 估算有多少人用過這功能），
-- type='apply' 記每次點最愛套用篩選（不去重，看總共按了幾次）。
CREATE TABLE favorite_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  clientId TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('add', 'apply')),
  createdAt TEXT NOT NULL
);

CREATE INDEX idx_favorite_events_type_createdAt ON favorite_events(type, createdAt);
CREATE INDEX idx_favorite_events_clientId ON favorite_events(clientId);
