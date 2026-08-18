-- 廣告歸屬：記錄這則廣告是哪個業主的，方便之後對帳/報表，也是未來業主登入功能的前置欄位。
ALTER TABLE ads ADD COLUMN advertiser TEXT;

UPDATE ads SET advertiser = 'dawson' WHERE id IN ('ad-1', 'ad-2', 'ad-3');
UPDATE ads SET advertiser = 'e713300' WHERE id = 'ad-4';
UPDATE ads SET advertiser = 'cp' WHERE id = 'ad-5';
