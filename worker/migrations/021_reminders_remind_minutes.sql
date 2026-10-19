-- 課前提醒時間改成使用者可選（30／60／90 分鐘），每筆提醒要記下當初選的分鐘數：
-- 發送端（dispatchDueReminders）只看 remindAt，不受影響；這欄是給前端顯示「課前 N 分」、
-- 以及重新整理後從 /myReminders 還原畫面用。
--
-- 新欄位有預設值，舊的提醒自動是 30（當時唯一的選項）；舊版 Worker 的 INSERT 沒列這個欄位，
-- migration 之後仍能正常寫入（取預設值），所以「先跑 migration、再 push」的部署順序是安全的。
ALTER TABLE reminders ADD COLUMN remindMinutes INTEGER NOT NULL DEFAULT 30;
