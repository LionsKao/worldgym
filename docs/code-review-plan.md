# 全專案 code review 計畫（暫時文件）

> 暫時文件：全部組別都完成後，刪掉這個檔案，以及 CLAUDE.md 裡「進行中：全專案 code review」那一段。
> 專案前期沒有用 code review，後期才開始用；這份計畫是把全專案重新檢視一遍，分組分次跑，用空閒時間的剩餘用量慢慢做完。

## 做法

- **強度一律 `xhigh`**（使用者指定）。
- **使用者說「開始檢查第 N 組」才跑那一組**，不會自己接著跑下一組。一次想跑幾組由使用者決定。
- 範圍用**檔名與函式名稱**界定（script.js 太長，行號只是參考，改動後會位移）。一組只看自己的範圍，別組的範圍留給別組，不要重複審。
- 兩台電腦接力靠 git：每跑完一組就 commit，要換電腦前 push、另一台 pull。**push 到 `main` 會同時部署 Pages 與 Worker**，所以 push 前確認這一組的修正已經驗證過。

## 每一組的流程

1. `git pull`，讀這份檔案，確認那一組的狀態是「未開始」或「進行中」。
2. 對該組範圍跑 `/code-review xhigh <範圍>`。script.js 的組別要在指示裡寫明只看哪些函式。
3. 把發現**逐項列給使用者**，每項附上判斷（真的 bug／誤報／已知且刻意的設計）。**使用者同意的才修**；決定不修的，連同原因記進下面的「各組紀錄」，避免下次重複報同一件事。專案裡有些行為是使用者刻意決定的，這些寫在 CLAUDE.md，審查前先對照。
4. 修完後依改動跑對應檢查：改 CSS／JS／icon 跑 `npm run check:versions -- --base=origin/main`；改 `voice-search.js` 或分店 pill 跑 `npm run test:voice`；改分店資料跑 `npm run check:branches -- --base=origin/main`（都在 `worker/` 下執行）。
5. 更新下面兩處：分組表的「狀態」、「各組紀錄」該組的內容（日期、發現幾項、修了哪些、不修的與原因）。**不用寫 commit hash**（寫了要多一次 commit），要找就用組別編號與日期在 `git log` 搜。
6. 該組的修正與紀錄**同一個 commit**，commit 訊息開頭寫「code review 第 N 組：」。
7. 還有哪些組沒跑，看下面的分組表。

## 分組（依嚴重程度，🔴 最高 → 🟢 最低）

嚴重程度＝「這裡有 bug 的話後果多大」×「外部能不能碰到」。行數是約略值，供估用量。

| 組 | 嚴重度 | 範圍 | 約行數 | 重點 | 狀態 |
| --- | --- | --- | --- | --- | --- |
| G1 | 🔴 | `worker/src/index.js`（整檔） | 945 | 公開 API 與驗證核心：短效 token、每 IP 限流與全站每日額度、後台 session 與登入鎖定、CORS、各打點端點的輸入驗證、留言端點、語音端點、cron 入口。重點看驗證／限流能不能繞過、注入、資源耗盡、費用失控 | 未開始 |
| G2 | 🔴 | `functions/`（全部）、`worker/src/crawlers.js`、`worker/src/util.js`、`_headers`、`worker/wrangler.toml` | 740 | Pages 邊緣與伺服器端注入：台灣 IP 限制與爬蟲例外、擋掉非網站檔案（路徑編碼繞過）、SSR 注入課表的跳脫與快取、動態 sitemap／llms.txt、安全標頭與 CSP、cron 設定 | 未開始 |
| G3 | 🟠 | `admin.js`、`admin.html`、`common.js` | 1,180 | 後台頁面與共用工具：後台會渲染來自外部請求的資料，看 XSS／跳脫、登入與 session 處理、報表計算；`common.js` 是前台後台共用的工具（escapeHtml、fetchJson、圖表、時間） | 未開始 |
| G4 | 🟠 | `worker/src/scrape.js`、`queryClasses.js`、`branchScan.js`、`branches-seed.js`、`branches-excluded.js`、`worker/schema.sql` | 1,010 | 課表資料管線：爬蟲寫入與新舊資料切換、查詢 SQL 與筆數上限、每月分店掃描、時間戳與時區、schema 與實際程式是否一致 | 未開始 |
| G5 | 🟠 | `worker/src/reminders.js`、`worker/src/analytics.js`、`sw.js`、script.js 從開頭到 `trackTeacherEventOncePerSession`（含） | 1,030 | 推播提醒與報表統計：提醒登記／取消／到期發送、每月壓縮並刪明細（資料遺失風險）、前端的儲存／廣告與統計打點／推播註冊與提醒清單 | 未開始 |
| G6 | 🟡 | script.js 從 `showServiceErrorModal` 到 `performSearch`（含），以及 `init` 到檔尾 | 930 | 前端核心查詢與結果顯示：token 重試與查詢快取、結果列渲染的跳脫、頁面切換與競態、初始化流程、首頁公開排行的渲染 | 未開始 |
| G7 | 🟡 | script.js 從 `isSpeechRecognitionSupported`（含它前面的語音常數）到 `submitVoiceSearch`（含）、`voice-search.js` | 940 | 語音搜尋：狀態機與逾時、麥克風是否確實釋放、iOS 錄音路徑、比對引擎誤判。`worker/scripts/test-voice.mjs` 已有回歸測試，審查時可對照 | 未開始 |
| G8 | 🟢 | script.js 從 `addDaysIso` 到 `renderThemeToggle`（含） | 1,000 | 篩選、最愛與主題：pill 與勾選狀態、localStorage 讀寫、我的最愛的編輯與長按、深色模式切換 | 未開始 |
| G9 | 🟢 | script.js 從 `copyTextWithToast` 到 `startNewYearFireworks`（含）、`newyear-fireworks.js`、`index.html`、`403.html`、`404.html`、`ga-init.js`、`theme-init.js`、`css-async.js`、`manifest.json` | 1,300 | 結果頁複製與下載圖片、限時彩蛋、靜態頁面。`index.html` 有 640 行大多是標記，實際邏輯少 | 未開始 |

建議節奏（可自行調整）：G1 分量最重又最重要，單獨一次；之後 G2＋G3、G4＋G5、G6＋G7、G8＋G9 各配一次。

## 不審查的範圍

| 範圍 | 原因 |
| --- | --- |
| `style.css` | 沒有邏輯，bug 是看得出來的視覺問題 |
| `worker/migrations/` | 已套用到正式庫的歷史紀錄；只在 G4 順帶對照 `schema.sql` 是否一致 |
| `worker/scripts/`（check-*、test-voice、voice-cases） | 開發用工具，不上線；最後有餘裕再說 |
| `vendor/` | 第三方檔案 |
| `sitemap.xml`、`sitemap-static.xml`、`llms.txt`、`README.md`、`GA_EVENTS.md`、`docs/` | 資料與文件，不是程式 |

## 各組紀錄

跑完一組就填那一組。格式：日期、發現幾項、修了哪些、不修的與原因（不修的一定要寫原因）。

### G1
（未開始）

### G2
（未開始）

### G3
（未開始）

### G4
（未開始）

### G5
（未開始）

### G6
（未開始）

### G7
（未開始）

### G8
（未開始）

### G9
（未開始）
