-- analytics.js 的月度報表查詢全部用 substr(createdAt,1,7)/substr(createdAt,1,4) 篩選月份/年份，
-- 原本的 idx_*_createdAt 是建在 createdAt 原始欄位上，查詢條件包了一層 substr() 之後 SQLite
-- 沒辦法用該索引 seek，變成整張明細表全掃（EXPLAIN QUERY PLAN 實測過是 SCAN，加了下面這些
-- 運算式索引後變成 SEARCH ... USING INDEX (<expr>=?)，rows_read 從全表列數降到 0）。
-- 運算式索引：對運算式本身建索引，運算式要跟查詢裡寫的完全一樣才吃得到，不用改任何應用程式碼。

CREATE INDEX idx_teacher_search_events_month ON teacher_search_events(substr(createdAt,1,7));
CREATE INDEX idx_teacher_search_events_year ON teacher_search_events(substr(createdAt,1,4));

CREATE INDEX idx_course_search_events_month ON course_search_events(substr(createdAt,1,7));
CREATE INDEX idx_course_search_events_year ON course_search_events(substr(createdAt,1,4));

CREATE INDEX idx_branch_search_events_month ON branch_search_events(substr(createdAt,1,7));
CREATE INDEX idx_branch_search_events_year ON branch_search_events(substr(createdAt,1,4));

CREATE INDEX idx_search_events_month ON search_events(substr(createdAt,1,7));

CREATE INDEX idx_favorite_events_month ON favorite_events(substr(createdAt,1,7));

CREATE INDEX idx_ad_events_month ON ad_events(substr(createdAt,1,7));
