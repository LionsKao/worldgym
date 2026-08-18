-- 查詢量趨勢要多畫一條「查詢結果數」線，search_events 補一個 resultCount 欄位記錄
-- 每次查詢實際顯示的課程數（沒結果或結果太多沒顯示時記 0），舊資料補 0。
ALTER TABLE search_events ADD COLUMN resultCount INTEGER NOT NULL DEFAULT 0;
