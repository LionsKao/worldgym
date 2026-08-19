-- 把既有資料的 UTC('Z') 時間戳位移成台灣時間(+08:00)，跟 nowTaiwanIso() 存的格式對齊。
-- 只挑 createdAt/updatedAt/scrapedAt 還是 '...Z' 結尾的 row 動，已經是 +08:00 的（部署後新寫入的）不會被誤搬動兩次。
-- 範圍：6 張查詢報表事件表 + branches/meta_filter_options/scrapedAt（跟 scrape.js/reminders.js 已經在用的慣例對齊）。
-- 不動 ads.startAt/endAt（後台手動排程時間，跟這次的「事件打點時間」意義不同）、reminders（目前無資料）。

UPDATE ad_events
SET createdAt = strftime('%Y-%m-%dT%H:%M:%f', createdAt, '+8 hours') || '+08:00'
WHERE createdAt LIKE '%Z';

UPDATE teacher_search_events
SET createdAt = strftime('%Y-%m-%dT%H:%M:%f', createdAt, '+8 hours') || '+08:00'
WHERE createdAt LIKE '%Z';

UPDATE course_search_events
SET createdAt = strftime('%Y-%m-%dT%H:%M:%f', createdAt, '+8 hours') || '+08:00'
WHERE createdAt LIKE '%Z';

UPDATE branch_search_events
SET createdAt = strftime('%Y-%m-%dT%H:%M:%f', createdAt, '+8 hours') || '+08:00'
WHERE createdAt LIKE '%Z';

UPDATE search_events
SET createdAt = strftime('%Y-%m-%dT%H:%M:%f', createdAt, '+8 hours') || '+08:00'
WHERE createdAt LIKE '%Z';

UPDATE favorite_events
SET createdAt = strftime('%Y-%m-%dT%H:%M:%f', createdAt, '+8 hours') || '+08:00'
WHERE createdAt LIKE '%Z';

UPDATE branches
SET updatedAt = strftime('%Y-%m-%dT%H:%M:%f', updatedAt, '+8 hours') || '+08:00'
WHERE updatedAt LIKE '%Z';

UPDATE meta_filter_options
SET updatedAt = strftime('%Y-%m-%dT%H:%M:%f', updatedAt, '+8 hours') || '+08:00'
WHERE updatedAt LIKE '%Z';

UPDATE classes
SET scrapedAt = strftime('%Y-%m-%dT%H:%M:%f', scrapedAt, '+8 hours') || '+08:00'
WHERE scrapedAt LIKE '%Z';
