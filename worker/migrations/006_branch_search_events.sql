-- 分店查詢次數記錄，邏輯跟 teacher_search_events/course_search_events 一樣。
CREATE TABLE branch_search_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  branchName TEXT NOT NULL,
  createdAt TEXT NOT NULL
);

CREATE INDEX idx_branch_search_events_branchName ON branch_search_events(branchName);
CREATE INDEX idx_branch_search_events_createdAt ON branch_search_events(createdAt);
