-- 課程查詢次數記錄，邏輯跟 teacher_search_events 一樣：使用者真的送出查詢（含指定課程）時寫一列，
-- 前端已做 30 分鐘內同課程去重。
CREATE TABLE course_search_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  courseName TEXT NOT NULL,
  createdAt TEXT NOT NULL
);

CREATE INDEX idx_course_search_events_courseName ON course_search_events(courseName);
CREATE INDEX idx_course_search_events_createdAt ON course_search_events(createdAt);
