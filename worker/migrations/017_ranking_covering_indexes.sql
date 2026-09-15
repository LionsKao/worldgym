-- monthlyNameRanking() 的查詢（/publicTeacherStats /publicCourseStats /publicBranchStats /
-- teacherStats /courseStats /branchStats）要 GROUP BY 名稱欄位，但 migrations/015 建的
-- idx_*_month 只蓋到 substr(createdAt,1,7)，不含名稱欄位——SQLite 用索引找到符合月份的
-- row 之後，還要每一筆回頭查一次表本身才能拿到名稱欄位分組，等於多讀一倍。
-- 實測過（branch_search_events，9 月約 4 萬筆）：只有 month 索引時 rows_read 84,004，
-- 索引加上名稱欄位變成真正的 covering index 後降到 42,109，跟當月實際筆數一致。
-- 把索引換成 (月份運算式, 名稱欄位) 的複合索引，讓查詢完全不用碰到表本身。
-- 舊的單欄位 month 索引在複合索引前綴涵蓋範圍內，變成完全多餘，直接砍掉。

DROP INDEX idx_teacher_search_events_month;
CREATE INDEX idx_teacher_search_events_month ON teacher_search_events(substr(createdAt,1,7), teacherName);

DROP INDEX idx_course_search_events_month;
CREATE INDEX idx_course_search_events_month ON course_search_events(substr(createdAt,1,7), courseName);

DROP INDEX idx_branch_search_events_month;
CREATE INDEX idx_branch_search_events_month ON branch_search_events(substr(createdAt,1,7), branchName);
