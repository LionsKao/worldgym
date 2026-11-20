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
| G1 | 🔴 | `worker/src/index.js`（整檔） | 945 | 公開 API 與驗證核心：短效 token、每 IP 限流與全站每日額度、後台 session 與登入鎖定、CORS、各打點端點的輸入驗證、留言端點、語音端點、cron 入口。重點看驗證／限流能不能繞過、注入、資源耗盡、費用失控 | 已跑完（3 項待決定） |
| G2 | 🔴 | `functions/`（全部）、`worker/src/crawlers.js`、`worker/src/util.js`、`_headers`、`worker/wrangler.toml` | 740 | Pages 邊緣與伺服器端注入：台灣 IP 限制與爬蟲例外、擋掉非網站檔案（路徑編碼繞過）、SSR 注入課表的跳脫與快取、動態 sitemap／llms.txt、安全標頭與 CSP、cron 設定 | 已跑完（2 項待決定） |
| G3 | 🟠 | `admin.js`、`admin.html`、`common.js` | 1,180 | 後台頁面與共用工具：後台會渲染來自外部請求的資料，看 XSS／跳脫、登入與 session 處理、報表計算；`common.js` 是前台後台共用的工具（escapeHtml、fetchJson、圖表、時間） | 已跑完（2 項待決定） |
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
2026-11-20 跑完（xhigh，目標 `worker/src/index.js`，沒有二次驗證），共 15 項：修 9 項、待決定 3 項、決定不修 3 項。

**已修（9 項）**
- `/trackSearch` 的 `resultCount` 沒有上限：幾千次灌大數字就能讓 SQLite 的 `SUM()` 整數溢位，公開趨勢圖與每月壓縮會一起壞。→ 超過 1200 視為無效、記 0。
- `MANUAL_SCRAPE_TOKEN` 沒設或是空字串時，後台登入會放行（舊程式實測：不帶 header 回 200 並發 session）；兩個 secret 都沒設時 session 金鑰來自字串 `"undefined"`。→ `constantTimeEqual` 拒絕空值；兩個 secret 都沒設時簽發與驗證 session 會丟錯（回 500）。
- 公開端點的 JSON body 沒有大小上限。→ 32KB 上限（`readJson`／`readBodyText`，超過回 413）。
- `/trackSearchEvents` 名稱清單沒去重，一次請求能灌 20 次同一個名稱。→ 先去重再截斷。
- 排行端點的 `year`／`month` 沒驗證，亂填會洗掉快取。→ 年份限今年往前 10 年內、月份 01–12，不合回 400；快取上限 64 → 512（大於可能的 key 數約 360）。
- `/registerReminder` 欄位沒有長度上限，`pushSubscription` 整包原樣存。→ 分店 slug 必須在 seed、文字欄位 ≤100、endpoint ≤1024、金鑰必填且 ≤128，只存 endpoint／expirationTime／keys。
- 每月 cron 的註解與文件日期差一天（cron 是 UTC，實際是台灣每月 2 號 04:00 與 3 號 05:00）。→ 註解、`wrangler.toml`、README、CLAUDE.md 改正，cron 本身沒動。
- `/cancelReminder` 的 `id` 不是字串時回 500。→ 回 400。
- `/trackFavorite` 的 `clientId` 沒轉小寫，同一個 UUID 大小寫不同會算成兩個人。→ 轉小寫（已存在資料庫裡的大寫舊資料沒動）。

驗證：用假 KV／D1 直接呼叫 `worker.fetch` 的 89 個檢查全過；同一組檢查對修改前的版本跑，46 項失敗（對應上面的問題）、43 項（原本就該保留的行為）通過。測試腳本沒進版控。

**待使用者決定（3 項，沒修）**
- 登入鎖定是非原子的 KV 讀寫，平行猜密碼能繞過。根本解法要新增 D1 表或 Durable Object；小改法（先累加再驗證）只能縮小空檔、擋不住真正同時送出的請求。
- 限流與登入鎖定用完整 IPv6 位址當 key，同一個 /64 內換位址就能重置額度。改成以 /64 為 key 很短，副作用是同一個 /64 底下的人共用額度。
- 留言端點只有每 IP 限流，沒有全站每日上限，也沒檢查 Origin。

**決定不修（3 項）**
- 被限流的請求也寫 D1 存取紀錄：這是刻意的設計（報表要看被擋下的次數），要改就得放棄它。
- `cachedStats` 在快取過期瞬間會重複計算：目前流量下效益小。
- HMAC 金鑰每次請求重新匯入：單次成本很小，不值得多一份模組狀態。

**留給後面組別的線索**
- G3：`/queryAccessStats` 會把攻擊者可控的 `userAgent` 字串回傳給後台，要確認 `admin.js` 渲染時有跳脫。
- G2：`worker/wrangler.toml` 的 `VAPID_SUBJECT` 是個人 email，repo 若是公開的要評估；同一個檔案有註解還寫「CLAUDE.md『語音搜尋』第十版」，已經過期。

### G2
2026-11-20 跑完（xhigh，目標 `functions/`、`worker/src/crawlers.js`、`worker/src/util.js`、`_headers`、`worker/wrangler.toml`，沒有二次驗證），共 9 項：修 7 項、待決定 2 項。這一組沒有發現能直接利用的漏洞；`_middleware.js` 的路徑封鎖（先 decode 再比對、點開頭檔案、`.md`）與 SSR 的跳脫都沒找到繞過方式。

**已修（7 項）**
- `_headers` 收回麥克風權限的規則只寫了 `/admin.html`，但它會 308 轉址到實際提供頁面的 `/admin`，後者仍帶 `microphone=(self)`（用 curl 對正式站查到的）。→ 新增 `/admin` 規則。順便發現「本機沒生效」的舊註解是誤判（當時只讀了轉址後的 `/admin`），已改正。
- `theme-init.js` 沒有 30 天快取規則（正式站實測 `max-age=0, must-revalidate`），但它是 `<head>` 裡擋住首次繪製的腳本，CLAUDE.md 也寫它有快取。→ 補上規則，本機實測已是 `max-age=2592000`。
- SSR 片段只快取成功的結果，「沒資料／太多／沒有固定班」每個請求都重跑 `queryClasses`（最多 2×600 列）。→ 這三種負面結果也快取 5 分鐘（存 `{ none: 狀態 }`）；D1 出錯（error）不快取。
- 快取的片段不驗證格式，`blockHtml` 壞掉時 HTMLRewriter 會在回應送出後才丟錯、整頁壞掉。→ 格式不認得的快取一律當沒命中。
- `postTeamsCard` 沒有逾時。→ 10 秒 `AbortSignal.timeout`；`/sendMessageToAuthor` 連不上或逾時回 502。
- `todayIsoTaipei()` 每次呼叫都重建 `Intl.DateTimeFormat`。→ 改成 `taiwanIso().slice(0, 10)`；對 3.7 萬個時間點（含每天台灣午夜前後、跨年、閏日）比對結果與舊寫法完全一致，2 萬次呼叫從約 840 ms 降到約 13 ms。
- `wrangler.toml` 註解指到已不存在的 CLAUDE.md 段落。→ 改指 `docs/voice-search.md`。

驗證：用假 Cache API／D1 呼叫 `getFragment`、用假 `fetch` 與一個永不回應的本機伺服器測 Teams 逾時（實測 10.0 秒後丟 `TimeoutError`），共 40 個檢查全過；G1 的 89 個檢查重跑也全過。測試腳本沒進版控。

**待使用者決定（2 項，沒修）**
- `wrangler.toml` 的 `VAPID_SUBJECT` 是真實的工作 email，寫在版控裡。當時查不到 repo 是不是公開的，後來在 G3 看到 `admin.js` 開頭註解寫「repo 是公開的」，所以這個 email 是公開的；可以改成角色信箱或 `https:` 網址（金鑰沒變，既有訂閱不會失效）。
- 暫時的 `/sitemap-static.xml` 診斷路徑（`_middleware.js` 的 `PUBLIC_CRAWLER_PATHS` 加上根目錄 639 行的靜態檔）還在。只有你知道 Search Console 的「無法讀取 Sitemap」問題解決了沒；解決後連同 Search Console 裡那份 sitemap 一起刪。

**留給後面組別的線索**
- G3：`/queryAccessStats` 的 `userAgent` 是攻擊者可控字串（G1 已記），要確認後台渲染時有跳脫。另外 CSP 是全站共用（`/*`），後台頁雖然沒有載入 GA，仍允許 Google Tag Manager 等腳本來源；若想讓後台更嚴格，可以替 `/admin` 另設較窄的 CSP（要先用 `!` 拔掉繼承值再設）。

### G3
2026-11-20 跑完（xhigh，目標 `admin.js`、`admin.html`、`common.js`，沒有二次驗證），共 10 項：修 7 項、待決定 2 項、不修 1 項。**後台渲染外部資料的 XSS 沒有問題**：存取紀錄的 `ip`、`userAgent`、`lastSeen`（含 `title` 屬性）、廣告文字、下拉選單的值都有跳脫，用帶 `<img onerror>`／`<script>` 的 User-Agent 實測沒有長出元素（這是 G1 留下的線索，已結案）。

**已修（7 項）**
- 折線圖 Y 軸在數值很小時刻度標籤重複（用真的 Chart.js 4.4.7 量到：最大 1 → `0,0,1,1,1`、最大 7 → `0,2,4,5,7` 而 1.75 被標成 2）。→ 新增 `niceAxisMax()` 決定上限，4 等分、每格整數（最大 1 → 0～4、7 → 0～8、110 → 0～120、8123 → 0～10000）；`updateLineChart()` 換資料時一併重算。前後台的折線圖都吃到。
- 後台動作（重抓、清除孤兒資料）沒有防重複：重抓中再按別顆或再確認一次，終端機被清掉、輸出混在一起，Worker 端還會同時跑兩輪。→ `runAction` 加 `actionRunning`，跑的時候兩顆按鈕鎖住，確認視窗也不會打開。
- 後台「上架中」只比日期，跟 Worker 的 `/ads` 不一致：`endAt` 設成隔天 00:00 的廣告（`migrations/012` 就是）在已下架的那一整天仍顯示上架中。→ 改成比到時與分。
- 登入失敗一律顯示「密碼錯誤」，連被限流（429）、伺服器錯誤（5xx）、回應格式不對也是。→ 只有 401／403 顯示密碼錯誤，其他顯示「伺服器暫時無法驗證，請稍後再試」。
- `readJsonOrThrow` 遇到非 JSON 的錯誤回應（Cloudflare 5xx 頁、海外 IP 的純文字 Forbidden）丟 `SyntaxError`，JSON `null` 加上錯誤狀態碼會 `TypeError`。→ 丟 `HTTP <狀態碼>`。
- 下拉重新整理沒處理 `touchcancel`，觸控被系統取消時指示器會卡在半途。→ 補上收尾。
- 自製下拉選單 `setOptions` 找不到選中值時退回第一項，但選單裡沒有任何一列高亮。→ 高亮與標籤是同一項。

驗證：用 jsdom 載入真正的 `admin.html`、Chart.js 4.4.7、`common.js`、`admin.js`（用真的 `<script>` 元素執行，top-level `const` 跟瀏覽器一樣共用），搭配假 `fetch`，共 71 個檢查全過；G1 的 89 個、G2 的 40 個、語音比對 91 個案例、`check:versions` 重跑也全過。`common.js` 版號 8 → 9（`index.html`、`admin.html` 兩邊）、`admin.js` 46 → 47。測試腳本沒進版控。

**待使用者決定（2 項，沒修）**
- 登出只清瀏覽器裡的 token，伺服器端 7 天的 session（可滑動延長）仍然有效，沒有撤銷機制。要修得在伺服器端加撤銷清單或登出端點，是設計上的改動。
- 公開的 `admin.html` 內嵌了 Cloudflare 帳號 ID、D1 資料庫 ID、GA 資源 ID 與 Web Analytics 的 site tag 的連結。它們不是密碼，但讓釣魚或探測更容易；可以改成登入後才由 `admin.js` 產生連結。**`admin.js` 開頭的註解寫「repo 是公開的」，所以 G2 提到的 `VAPID_SUBJECT`（真實工作 email）也是公開的**，要不要改請一併決定。

**不修（1 項）**
- 自製下拉選單沒有鍵盤操作與 ARIA（選項是沒有 tabindex 的 div）。要做好得改選單的結構與互動，而且會動到公開首頁的排行選單，這次不處理。

**其他沒處理**
- `admin.js` 的 `addDays` 與 `script.js` 的 `addDaysIso`（以及 Worker 的 `addDaysIso`）是三份相同功能的程式；要合併得動 `script.js`，價值低，沒做。

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
