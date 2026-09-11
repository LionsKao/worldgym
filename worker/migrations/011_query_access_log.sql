-- /issueToken、/queryClasses 這兩個公開端點的存取紀錄：記 IP/UA/是否被流量限制擋下，
-- 事後才有辦法追查是不是被爬蟲/腳本大量打（之前 search_events 完全沒記來源，查不出是誰）。
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
