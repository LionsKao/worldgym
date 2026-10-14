-- 分析事件表（*_events）的 23 個索引裡，有 14 個沒有任何查詢用得到。這些表每次使用者查詢、點最愛、
-- 看廣告都會寫入，每個索引都讓每一列多寫一筆索引項目（D1 的 rows_written 連索引項目一起算），
-- 沒人用的索引是純成本；每月壓縮進 *_monthly 時刪除整個月的明細，也要連每個索引一起刪。
--
-- 這些表只留當月明細，而且所有查詢（排行、趨勢、最愛、提醒、廣告、每月壓縮）都是依「月份」
-- substr(createdAt,1,7) 篩選或分組，所以只有建在 substr 運算式上的索引派得上用場。
--
-- 實測方式：把 analytics.js 裡碰到這些表的 31 個查詢（含每月壓縮的 SELECT／DELETE、廣告曝光寫入）
-- 逐一做 EXPLAIN QUERY PLAN，本機（套用 schema.sql）與正式庫的結果逐一相同——23 個索引裡只有 9 個
-- 出現在任何一個計畫裡，其餘 14 個一次都沒被選到：
--   用到的（保留）：idx_ad_events_month、idx_ad_events_adId_month_type、
--     idx_{teacher,course,branch}_search_events_month、idx_search_events_month、
--     idx_favorite_events_type_month_clientId、idx_favorite_events_month、idx_reminder_add_events_month
--   沒用到（砍掉）：見下面 DROP。其中 idx_ad_events_adId_type 原本是 adStatsCombined 算「全時間總數」用的，
--   那個查詢已改成各月加總（不再掃 ad_events），索引因此也沒人用了；
--   idx_*_search_events_year 原本給 availableYears 掃明細找年份，現在只讀彙總表（見 analytics.js）。
-- 影響：每一次寫入少寫 1～3 筆索引項目（teacher／course／branch 各從 4 個索引剩 1 個，其餘依表而定）；
-- 每月壓縮的 DELETE 同樣少一半以上的索引維護。讀取的計畫完全不變（用到的索引都留著）。
--
-- 評估過但刻意不做：把 idx_search_events_month 改成 (substr(createdAt,1,7), resultCount) 的 covering index。
-- 實測只有「每月壓縮的 SELECT COUNT/SUM」那一條從回表變成不回表（一個月才跑一次），monthlySearchTrend()
-- 的計畫沒有任何改變（照樣不是 covering），好處太小，不值得重建索引，所以這個索引原封不動。
--
-- 還原用（需要時再建）：
--   CREATE INDEX idx_ad_events_adId_type ON ad_events(adId, type);
--   CREATE INDEX idx_ad_events_createdAt ON ad_events(createdAt);
--   CREATE INDEX idx_teacher_search_events_teacherName ON teacher_search_events(teacherName);
--   CREATE INDEX idx_teacher_search_events_createdAt ON teacher_search_events(createdAt);
--   CREATE INDEX idx_teacher_search_events_year ON teacher_search_events(substr(createdAt,1,4));
--   CREATE INDEX idx_course_search_events_courseName ON course_search_events(courseName);
--   CREATE INDEX idx_course_search_events_createdAt ON course_search_events(createdAt);
--   CREATE INDEX idx_course_search_events_year ON course_search_events(substr(createdAt,1,4));
--   CREATE INDEX idx_branch_search_events_branchName ON branch_search_events(branchName);
--   CREATE INDEX idx_branch_search_events_createdAt ON branch_search_events(createdAt);
--   CREATE INDEX idx_branch_search_events_year ON branch_search_events(substr(createdAt,1,4));
--   CREATE INDEX idx_search_events_createdAt ON search_events(createdAt);
--   CREATE INDEX idx_favorite_events_clientId ON favorite_events(clientId);
--   CREATE INDEX idx_reminder_add_events_createdAt ON reminder_add_events(createdAt);
DROP INDEX IF EXISTS idx_ad_events_adId_type;
DROP INDEX IF EXISTS idx_ad_events_createdAt;
DROP INDEX IF EXISTS idx_teacher_search_events_teacherName;
DROP INDEX IF EXISTS idx_teacher_search_events_createdAt;
DROP INDEX IF EXISTS idx_teacher_search_events_year;
DROP INDEX IF EXISTS idx_course_search_events_courseName;
DROP INDEX IF EXISTS idx_course_search_events_createdAt;
DROP INDEX IF EXISTS idx_course_search_events_year;
DROP INDEX IF EXISTS idx_branch_search_events_branchName;
DROP INDEX IF EXISTS idx_branch_search_events_createdAt;
DROP INDEX IF EXISTS idx_branch_search_events_year;
DROP INDEX IF EXISTS idx_search_events_createdAt;
DROP INDEX IF EXISTS idx_favorite_events_clientId;
DROP INDEX IF EXISTS idx_reminder_add_events_createdAt;
