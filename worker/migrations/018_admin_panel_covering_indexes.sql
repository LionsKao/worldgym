-- 後台三個報表面板一樣有「結果沒幾筆、讀取量卻很誇張」的問題，原因跟 migrations/017 一樣：
-- 索引沒蓋到查詢實際需要的欄位，SQLite 找到符合條件的 row 後還要回頭查表本身拿其他欄位。
-- 逐一實測過（見下面每段的實測數字），都是加對複合 covering index 就能解決。

-- adStatsCombined() 的「依廣告分月明細」查詢要 GROUP BY adId, month, type，
-- 原本只有 (adId, type) 索引，沒蓋到月份，實測 rows_read 從 7,691 降到 3,861
-- （當月 ad_events 實際只有 3,834 筆）。
CREATE INDEX idx_ad_events_adId_month_type ON ad_events(adId, substr(createdAt,1,7), type);

-- favoriteStatsCombined() 的 add/apply 兩個月度趨勢查詢都是 WHERE type=? GROUP BY month，
-- 原本的 idx_favorite_events_type_createdAt 蓋的是原始 createdAt 欄位，沒有運算式、也沒有
-- clientId（add 那條要 COUNT DISTINCT clientId），一樣要回頭查表。實測 rows_read：
-- add 129→67、apply 424→214（當月 add 62 筆、apply 210 筆），改成複合索引後舊索引完全
-- 用不到了，直接砍掉换成這個。
DROP INDEX idx_favorite_events_type_createdAt;
CREATE INDEX idx_favorite_events_type_month_clientId ON favorite_events(type, substr(createdAt,1,7), clientId);

-- /queryAccessStats（存取紀錄面板）的查詢是 WHERE createdAt >= ? GROUP BY ip ORDER BY cnt DESC，
-- 原本 SQLite 為了 GROUP BY ip 用起來方便，寧願用 idx_query_access_log_ip 整表按 ip 排序掃過去，
-- 完全沒吃到 createdAt 的日期篩選（7 天視窗實測還是讀了快 1.4 萬列，逼近全表的量——這張表
-- 目前累積不到一個月資料，日期篩選本來就還不夠選擇性，但架構上先修對，之後資料變多才會真的有感）。
-- idx_query_access_log_ip 這個會讓查詢規劃器選錯路的單欄位索引，先前手動測試時已經砍掉了；
-- 這裡直接建「createdAt 開頭、蓋滿查詢所有欄位」的複合 covering index，讓它老實照日期範圍 seek，
-- 原本的單欄位 createdAt 索引也被這個複合索引的前綴完全涵蓋，一併砍掉。
DROP INDEX idx_query_access_log_createdAt;
CREATE INDEX idx_query_access_log_createdAt_covering ON query_access_log(createdAt, ip, userAgent, rateLimited);
