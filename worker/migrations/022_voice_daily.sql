-- 語音搜尋（POST /transcribeVoice）的每日計數，給 admin.html 的「語音」面板用（GET /voiceStats）。
--
-- 刻意不用本站慣用的「*_events 明細 + *_monthly 月度彙總」：那套是為了「要去重人數、要留單筆明細」設計的，
-- 語音這邊故意不留任何單筆資料（沒有 IP、轉錄文字、音檔、clientId），只需要次數，所以直接存每天的計數：
--  - 一年才幾千列，不需要每月壓縮的排程，每天的細節也永遠留得住（現有報表只有當月看得到每天）；
--  - 寫入用 INSERT ... ON CONFLICT DO UPDATE SET cnt = cnt + 1，SQLite 的遞增是原子的；
--  - 主鍵 (day, outcome) 就涵蓋所有查詢（依日期範圍掃描），不需要另外建索引。
--
-- day 是台灣日期（YYYY-MM-DD，worker/src/util.js 的 todayIsoTaipei()）。
-- outcome：ok（轉出文字）／empty（沒有內容：靜音，或只轉出提示語被拿掉）／ai_error（Workers AI 出錯，回 502）／
--          too_large（超過 VOICE_MAX_BYTES）／too_small（小於 VOICE_MIN_BYTES）／daily_limit（撞到每日額度）。
--          token 錯誤、格式不對、每 IP 限流在進到 handler 之前就被擋掉，不計入。
-- bytes_sum／ms_sum：該列所有請求的音檔位元組與 Whisper 耗時總和，除以 cnt 就是平均（只有 ok／empty／ai_error 有意義）。

CREATE TABLE voice_daily (
  day TEXT NOT NULL,
  outcome TEXT NOT NULL,
  cnt INTEGER NOT NULL DEFAULT 0,
  bytes_sum INTEGER NOT NULL DEFAULT 0,
  ms_sum INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, outcome)
);
