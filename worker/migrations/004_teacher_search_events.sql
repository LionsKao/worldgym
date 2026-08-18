-- 老師查詢次數記錄。使用者在首頁真的送出查詢（含指定老師）時寫一列，
-- 前端已做 30 分鐘內同老師去重，這裡單純累加，不做聚合。
CREATE TABLE teacher_search_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  teacherName TEXT NOT NULL,
  createdAt TEXT NOT NULL
);

CREATE INDEX idx_teacher_search_events_teacherName ON teacher_search_events(teacherName);
CREATE INDEX idx_teacher_search_events_createdAt ON teacher_search_events(createdAt);
