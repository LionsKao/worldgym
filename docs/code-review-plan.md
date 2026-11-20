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
| G4 | 🟠 | `worker/src/scrape.js`、`queryClasses.js`、`branchScan.js`、`branches-seed.js`、`branches-excluded.js`、`worker/schema.sql` | 1,010 | 課表資料管線：爬蟲寫入與新舊資料切換、查詢 SQL 與筆數上限、每月分店掃描、時間戳與時區、schema 與實際程式是否一致 | 已跑完（2 項待決定） |
| G5 | 🟠 | `worker/src/reminders.js`、`worker/src/analytics.js`、`sw.js`、script.js 從開頭到 `trackTeacherEventOncePerSession`（含） | 1,030 | 推播提醒與報表統計：提醒登記／取消／到期發送、每月壓縮並刪明細（資料遺失風險）、前端的儲存／廣告與統計打點／推播註冊與提醒清單 | 已跑完（無待決定） |
| G6 | 🟡 | script.js 從 `showServiceErrorModal` 到 `performSearch`（含），以及 `init` 到檔尾 | 930 | 前端核心查詢與結果顯示：token 重試與查詢快取、結果列渲染的跳脫、頁面切換與競態、初始化流程、首頁公開排行的渲染 | 已跑完（1 項待決定） |
| G7 | 🟡 | script.js 從 `isSpeechRecognitionSupported`（含它前面的語音常數）到 `submitVoiceSearch`（含）、`voice-search.js` | 940 | 語音搜尋：狀態機與逾時、麥克風是否確實釋放、iOS 錄音路徑、比對引擎誤判。`worker/scripts/test-voice.mjs` 已有回歸測試，審查時可對照 | 已跑完（無待決定） |
| G8 | 🟢 | script.js 從 `addDaysIso` 到 `renderThemeToggle`（含） | 1,000 | 篩選、最愛與主題：pill 與勾選狀態、localStorage 讀寫、我的最愛的編輯與長按、深色模式切換 | 已跑完（1 項待決定） |
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
2026-11-20 跑完（xhigh，目標 `scrape.js`、`queryClasses.js`、`branchScan.js`、`branches-seed.js`、`branches-excluded.js`、`schema.sql`，沒有二次驗證），共 7 項：修 5 項、待決定 2 項。**這一組最重要的一項是「官網一出錯就清空整間分店」**——用官網的真實 API 實測確認過，不是推論。

**已修（5 項）**
- 官網課表 API 出錯時 HTTP 狀態仍是 200，內容是 `{"exception":"EXCEPTION","data":"","status":false}`（用壞日期實測）。舊的 `fetchBranchSchedule` 把它當成「沒有課」回 `[]`，`ingestBranchClasses` 隨後把整間分店的舊課表清掉；官網在 03:00／17:00 整個壞掉的話，111 間全被清空、`classes` 變 0 列，網站最久 12 小時查不到課（驗證腳本重現：1199 列 → 0 列，而且 `branchesOk` 還顯示 111）。→ 官網回 `status:false`、有 `exception`、或 `data` 不是陣列都丟錯，該間舊資料原封不動、列進 `errors`。沒有課的 Express 分店（`status:true`、`data` 是一排空物件 `{}`，實測確認）不受影響，仍然會清空那間分店。
- 爬官網的 `fetch` 沒有逾時：分店是依序逐一抓，官網卡住一間，後面所有分店本輪都等不到更新。`branchScan.js` 抓 sitemap 同樣沒有。→ 兩處都加 `OFFICIAL_SITE_TIMEOUT_MS`（20 秒，定義在 `util.js`），逾時當成該間失敗。
- `queryClasses` 判斷分店要不要下推進 SQL 時，沒把每個時間窗自己的參數（日期範圍 2、星期幾 ≤ 7、指定日期 ≤ 2、LIMIT 1）算進 D1 的 100 個綁定參數上限，檔頭註解的算式也漏了時段條件（最多 18 個小時）。課程 30＋老師 30＋教室 2＋時段 3＋分店 9＋星期 7＋指定日期 2 會綁 101 個而 500（500 組隨機條件裡 7 組重現）。→ 算進去，註解改正。
- 時段篩選用 `TIME_SLOT_HOURS[v]` 判斷，普通物件會吃到原型鏈：`time` 帶 `"constructor"`、`"toString"`、`"__proto__"` 會通過過濾，之後把 function／object 綁進 SQL 而 500。→ 改用 `Object.hasOwn`。
- `schema.sql` 在 README 與 CLAUDE.md 都被寫成「會 DROP 所有表」，實際上只有一部分的表有 `DROP TABLE IF EXISTS`（`ad_events`、`teacher/course/branch_search_events`、`search_events`、`favorite_events`、`query_access_log` 七張沒有）；對既有資料庫重跑，會先刪掉有 DROP 的表（含無法重建的月度彙總、`favorite_client_seen`、`voice_daily`），再在 `ad_events` 報 `already exists` 中斷。→ 只改說明：檔頭加警告、README／CLAUDE.md 的說法改成「只能對全新資料庫執行」，**沒有**替那七張表補 DROP（補了的話，誤跑在正式庫會變成全部毀掉，現在至少會中途擋住）。

驗證：用真的 SQLite（`node:sqlite`）包成跟 D1 一樣的介面（100 個參數上限、不收 function／object 參數、`batch` 是一個 transaction），搭配假官網，共 53 個檢查全過；對修改前的版本跑，15 項失敗（全部對應上面的問題）。涵蓋整輪爬蟲（官網出錯／全部出錯／HTTP 503／Express 沒課／換老師／同 id 原地更新／清孤兒分店）、500 組隨機查詢條件與暴力過濾的結果比對、分店掃描與 seed 資料。另外對官網實測三次（一般分店、Express 沒課的分店、故意給壞日期）確認回應格式，並用真實回應跑 `transformRawClass`（217 列 → 171 堂有課名，id 沒有撞、教室與時間格式都正常）。`schema.sql` 在真的 SQLite 整份可執行；依序套用 `migrations/` 後的結構與 `schema.sql` 一致（`classes`、`branches`、`meta_filter_options`、`reminders` 四張在 migration 開始前就存在，比不到；`idx_query_access_log_ip` 是 migration 011 建、之後手動砍掉的，`migrations/018` 有記）。G1 89 項、G2 40 項、語音比對 91 個案例、`check:branches`、`check:versions` 重跑也全過。測試腳本沒進版控。

**待使用者決定（2 項，沒修）**
- **排程爬蟲失敗沒有任何通知**：`runScrape` 的結果（幾間失敗）只寫 `console.log`。官網改版或持續出錯時，D1 保留舊資料、網站照常運作，但課表一天比一天舊，只有打開後台手動重抓或看 Worker log 才知道。專案已有 `postTeamsCard`，可以在「失敗的分店超過某個比例」時發一則 Teams；但這是新增通知行為，要你決定門檻（例如失敗超過一半）與要不要做。
- **`branches` 資料表只寫不讀**：全專案沒有任何地方讀它，`upsertBranches` 每輪白寫 111 列；README 與 CLAUDE.md 還把它列成「分店清單」，容易讓人誤以為分店清單在 D1。要移除得新增 migration `DROP TABLE branches` 並同步文件；不處理也沒有害處（每天約 222 列寫入）。

**其他沒處理**
- 官網回「有效但沒有課」（`status:true`、一排 `{}`）跟 Express 的真的沒課長得一模一樣，無法區分，所以仍然會清空那間分店；官網實際出錯的訊號（`status:false`）已經處理。
- `cleanupStaleBranches` 一次要清超過約 99 間孤兒分店時會撞 100 個參數上限，實務上不會碰到（要一次從 seed 移除近百間分店）。

**沒問題的部分**
- 爬蟲新舊資料切換（先 upsert、最後一批清舊的）在整輪驗證中行為正確，中途失敗舊資料保留。`class_date` 是 `2026/11/23`（斜線）格式，用本地時間解析、本地時間讀取，在 Workers（UTC）下與日期窗一致。
- 所有 SQL 都用綁定參數，沒有注入問題；`queryClasses` 近窗／遠窗的結果與暴力過濾逐筆一致（含分店下推與不下推兩條路）。
- 分店 seed：slug 與名稱都不重複、`check:branches` 通過；不收清單與 seed 沒有重疊；月度掃描的新增／疑似下架判斷正確。

### G5
2026-11-20 跑完（xhigh，目標 `reminders.js`、`analytics.js`、`sw.js`、`script.js` 開頭到 `trackTeacherEventOncePerSession`，沒有二次驗證），共 12 項：修 8 項、不處理 4 項。最重要的一項是「每月壓縮在兩輪同時跑時會把月度總數蓋成 0」——用模擬交錯執行重現過，不是推論。

**已修（8 項）**
- 每月壓縮（`rollupAnalyticsEvents`）是「先 SELECT 回 JS、再用綁定值 INSERT 彙總＋DELETE 明細」。兩輪壓縮同時跑時（排程剛好遇到後台手動按鈕、或排程被重複觸發），後到的那輪讀到的是先到的那輪已經刪光明細之後的空結果，接著把先算好的月度總數蓋成 0，明細沒了就永遠回不來（驗證：查詢量、最愛、提醒三張彙總表各被蓋成 0 一次）。→ 改成每個月份一個 `db.batch()`：用 `INSERT ... SELECT` 在同一個 transaction 裡從明細現算、同批刪明細；明細已被刪掉就什麼都不寫。七張明細表共用同一個 `rollupTable()`，程式碼少了約 30 行；`rowsAggregated` 改用 `meta.changes`，回應欄位不變。
- 課前推播逐筆送出時：推播服務卡住沒有逾時，而且送完的提醒要等整輪結束才一次刪。執行到一半被平台砍掉（時間、CPU 上限）或卡住時，已經送出的提醒還留在資料庫，每 5 分鐘被再送一次（驗證：25 筆在第 23 筆卡死，25 筆全留著、其中 22 筆會重送）。→ 每筆 10 秒逾時；處理完的每 20 筆就刪一次，結束前再刪一次。
- 課已經開始了還是會送「課前提醒」（例如排程停擺一陣子、之後補跑）。→ `classAt` 早於現在的直接丟掉。
- 前端取消通知（`cancelReminderRequest`）不檢查 HTTP 狀態：被限流（429）或伺服器錯誤時，畫面照樣顯示「已取消」，伺服器還留著，課前照樣收到通知。→ 非 2xx 丟錯，鈴鐺維持原狀、可以重試。
- 前端讀取通知清單（`fetchMyReminders`）失敗時回空陣列，`renderReminderList` 把它當成「沒有通知」，清掉清單與登記記錄。→ 失敗要丟錯；清單與登記記錄維持原樣，只有畫面上原本什麼都沒有時才顯示「無法讀取通知，請稍後再試」。
- `sw.js` 點通知：已開著的視窗若不是這個 service worker 控制的，`navigate()` 會被拒絕（或回 `null`），整個點擊流程丟錯，點了通知沒有任何反應。→ 被拒絕就改開新視窗，回 `null` 就只 focus 原本的視窗。
- `logFavoriteEvent` 在沒有 `crypto.randomUUID` 的瀏覽器會丟例外，而呼叫端（加入最愛、套用最愛）在它後面還有事要做（關視窗、送出查詢）。→ 打點包 try/catch，不能擋住主流程。
- `/registerReminder` 的 `startTime` 只檢查是 4 位數字，`2599` 這種會被 `Date.UTC` 進位成隔天的奇怪時間。→ 限制成 00～23 時、00～59 分。

驗證：後端用真的 SQLite 包成 D1 介面、真的 VAPID／Web Push 加密、假推播服務，共 30 個檢查全過；前端用 jsdom 執行真正的 `script.js`（第 1～523 行）與 `common.js`，並用 `vm` 執行真正的 `sw.js`，共 35 個檢查全過。對修改前的版本跑，共 14 項失敗（後端 6、前端 8，全部對應上面的問題）。涵蓋：`computeNextOccurrence` 4000 組隨機（現在時間×星期×開課時間×提前分鐘）與暴力解逐一對照、登記／覆蓋／取消／清單與他人 endpoint 的權限、endpoint 白名單、推播各種回應（410／500／丟例外／被白名單擋／壞資料）、壓縮前後所有報表數字一致、壓縮中途失敗無遺失、重複執行不變、兩輪同時跑（三種交錯）、廣告顯示與曝光點擊、查詢次數去重。G1 89 項、G2 40 項、G4 53 項、語音比對 91 個案例、`check:branches`、`check:versions` 重跑也全過。`script.js` 版號 250 → 251。測試腳本沒進版控。**限制**：`sw.js` 的 `navigate()` 行為是用假的 clients 測的，沒有在真的 iPhone PWA 上驗證。

**不處理（4 項）**
- 提醒清單用 `GET /myReminders?endpoint=...`，推播 endpoint 會出現在網址裡（Worker 的請求紀錄看得到）。endpoint 本身就是「誰有它誰就能列出、取消那支裝置的提醒」的憑證，要改成 POST 得動前後端兩邊；紀錄只有你自己看得到，價值低。
- 單次到期的提醒超過約 1000 筆時（Workers 單次執行的 subrequest 上限），超過的會被丟掉。目前用量遠低於這個數字。
- 開課時間在凌晨 01:30 以前的課，「課前 90 分鐘」會落在前一天，登記時 `remindAt` 可能已經過去。課表一般沒有這種時段，沒處理。
- 每月壓縮的 `INSERT OR REPLACE` 沒改成累加：新寫法已經讓兩輪同時跑變成空轉，而且寫入時間戳都是伺服器當下產生、排程在月底約 28 小時後才跑，不會有遲到的舊月份明細。

**沒問題的部分**
- 提醒的權限：取消與清單都要連同 push endpoint 比對，猜 id 刪不到別人的；endpoint 白名單擋得住冒名網域（`fcm.googleapis.com.evil.com`）、帶 port、帶帳密、http。
- 廣告網址只收 http(s)、廣告文字當純文字顯示（帶 `<img onerror>` 的文字沒有長出元素）、曝光離開頁面時只送一次、查詢次數 30 分鐘去重。
- 每月壓縮在新舊寫法下，壓縮前後所有報表（排行、趨勢、最愛、廣告、提醒、年份選單）數字完全一致，中途失敗後下一輪補齊的最終結果也一致。

### G6
2026-11-20 跑完（xhigh，目標 `script.js` 的 `showServiceErrorModal`～`performSearch` 與 `init`～檔尾，沒有二次驗證），共 10 項：修 8 項、待決定 1 項、不處理 1 項。結果列渲染、查詢快取、token 重試、`init` 流程的主線都沒有問題；問題集中在「失敗時使用者看不到」與「兩件事同時進行」。

**已修（8 項）**
- `init()` 載入 `/filterOptions` 用 `fetch().then(r => r.json())`，不檢查 HTTP 狀態：被限流（429）或伺服器錯誤時回應本身也是 JSON（`{"error":...}`），解析成功就被當成成功，課程與老師區塊變成空的，沒有錯誤提示、也沒有重試。→ 改用 `common.js` 的 `fetchJson`，失敗走原本的「讀取失敗」文字與服務錯誤視窗。
- `init()` 的 `finally` 無上限地等「已登記通知」（`preloadRemindersPromise`），而它沒有逾時（`/myReminders`）、Service Worker 註冊失敗時 `navigator.serviceWorker.ready` 還永遠不會 resolve：網路卡住就一直蓋著載入遮罩。`/filterOptions` 與 token 都有 6 秒上限，只有這一步沒有。→ 最多等 `QUERY_GIVE_UP_AFTER_MS`，等不到先放行；晚到時用 `syncResultBellsToRegistered()` 補上已畫出來的鈴鐺。
- 從結果頁點老師名字觸發的查詢，所有提示（被限流、逾時、伺服器錯誤）都掛在 `#scheduleSubmitBtn`，而它在被隱藏的篩選表單裡，`getBoundingClientRect()` 全是 0，提示框被定位到畫面上方之外（內建瀏覽器 812 px 高的視窗實測：掛在隱藏的鈕上 top -39 / bottom -4，掛在返回鍵上 671～706）。使用者只看到返回鍵的轉圈圈停了，不知道失敗，而篩選條件已被改成只剩那位老師。→ 查詢鈕在隱藏區域時提示改掛返回鍵。
- `runSearchAndShowResults` 沒有防重疊：結果頁連點兩位老師（只擋同一位）、查詢進行中又點最愛晶片（最愛列不受查詢鈕 disabled 影響），兩個查詢同時跑，誰後到誰顯示，標籤列與課程列可能對應不同條件，先結束的那個 `finally` 還會提早解開查詢鈕。→ 每次查詢編號，過時的結果不碰畫面、`finally` 只有最新的一次會恢復查詢鈕；點老師時只要有任何一位在查詢就忽略；`searchTriggerSource` 在查詢開始時先記下，不受下一次查詢改掉。
- 等查詢期間（最久 6 秒）使用者按「⋮」進通知頁，結果回來照樣 `showResultView()`：返回鍵疊在通知頁上（跟通知頁自己的返回鍵同時出現）、網址被換成分享網址，結果列表卻在被隱藏的 `#mainFormSheet` 裡看不到。→ 結果回來時查詢畫面已被離開就什麼都不做（含錯誤提示）。
- 首頁公開排行 `load()` 沒處理回應亂序：先選 10 月再快速選 11 月，10 月的回應較晚到就會用 10 月的資料畫圖，選單卻寫 11 月。→ 只有最後一次的回應可以畫圖。
- `queryClassesOnce` 收到 401 `token_expired` 沒有馬上丟掉快取的 token，3 秒時的重試仍用同一張過期的，要等 6 秒放棄後 `runScheduleQuery` 才換新的（裝置時鐘比伺服器慢時客戶端會以為 token 沒過期）。→ 收到時立刻清掉，第一次重試就換新的（驗證：6 秒 → 3 秒，測試縮短版 0.62 秒 → 0.3 秒）。
- `/issueToken` 被限流或伺服器錯誤時丟一般 `Error`，查詢畫面把它顯示成「網路連線異常，請確認網路連線」，但使用者的網路沒問題。→ 429 丟 `QueryRateLimitedError`（「查詢太頻繁了」）、其他丟 `QueryHttpError`（「伺服器發生錯誤」）。

驗證：用 jsdom 載入真正的 `index.html`、`common.js`、整份 `script.js`（逾時常數縮短為 3000→300、6000→600 毫秒），搭配假 `fetch`、假 Chart、假 IntersectionObserver，共 62 個檢查全過；對修改前的版本跑，17 項失敗（對應上面 8 項）。涵蓋：載入選項（正常、429／500／純文字 403、先失敗再重試成功）、通知清單卡住與晚到、查詢主線（結果列渲染與跳脫、縮課日標紅、資料更新時間、語音原句標籤、結果數 0／超過 250／500／429／逾時／網路錯誤的提示、查詢快取的命中／過期／排序／20 組上限、連續 5 次查詢的提醒視窗）、兩個查詢同時進行、等待時離開篩選頁、token 過期與 `/issueToken` 失敗、公開排行（只畫前 10 名、年月選單、沒資料、失敗、亂序）與趨勢圖、依位置篩選分店。提示框掛在隱藏按鈕上會跑到畫面外這點，另外在內建瀏覽器（本機伺服器、手機寬度 375×812）量過位置，jsdom 沒有版面、量不出來。G5 的前端檢查（35 項）與 `check:versions` 重跑也全過。`script.js` 版號 251 → 252。測試腳本沒進版控。

**待使用者決定（1 項，沒修）**
- 「依目前位置篩選分店」（1／3／5 公里）在定位被拒絕、逾時、或附近沒有任何分店時完全沒有畫面回饋，只送 GA 事件，使用者不知道是壞了還是附近真的沒有。要不要提示、提示什麼字，是產品決定。

**不處理（1 項）**
- 首頁四張圖表各自註冊 `window` 的 `resize` 去呼叫 `chart.resize()`，而 Chart.js 設了 `responsive: true` 已經自己監聽容器大小，看起來是多餘的。但不確定當初是不是為了某個版面問題刻意加的，拿掉沒有可量的好處，沒動。

**其他沒處理**
- 用戶在結果頁點老師、查詢還沒回來時按返回，查詢回來會把結果頁再叫出來（跟手動查詢「按了就是要看結果」一致，沒有改）。
- 分享網址帶老師或課程、而 `/filterOptions` 失敗時，那些條件被丟掉，自動查詢只帶分店，結果比網址原本的條件寬；但同時會跳服務錯誤視窗，沒處理。

**沒問題的部分**
- 結果列與篩選標籤都用 `textContent` 組出來，帶 `<img onerror>`、`<script>` 的課名與老師名沒有長出元素；唯一用 `innerHTML` 的是資料更新時間（取自 Worker 自己產生的時間戳）。
- 查詢快取（5 分鐘、依排序後的條件與台灣日期、最多 20 組、超過 250 筆不存、失敗不存）、`withRetryTimeout`、重複查詢提醒、縮課日標紅都與文件一致。
- `newYearPrepare()` 內部有 try/catch，不會讓 `init()` 在收遮罩前丟例外。

### G7
2026-11-20 跑完（xhigh，目標 `script.js` 的 `isSpeechRecognitionSupported`（含前面的語音常數）到 `submitVoiceSearch`、`voice-search.js`，沒有二次驗證），共 8 項：修 4 項、不處理 3 項、不用改 1 項。語音的主線（三條硬規定、麥克風是否放開、逾時、第二次點擊的擋法、比對引擎）都沒有問題，修的都是邊角：「不該開始錄音的時候開始錄音」與「卡住就鎖死」。

**已修（4 項）**
- 「搜尋老師」是 `#filterForm` 裡唯一的文字輸入，在裡面按 Enter（手機鍵盤的「前往」）會觸發表單送出；沒勾任何篩選時，送出的處理等於按下麥克風，使用者只是想搜名字，卻突然開始錄音或跳出麥克風權限視窗。用內建瀏覽器按真的 Enter 鍵實測：修改前 `startVoiceSearch()` 被呼叫 1 次、修改後 0 次。→ 搜尋框的 `keydown` 在 `micEligible()` 時攔下 Enter、只收起鍵盤；已經有勾選時維持原本的 Enter 就查詢；輸入法組字中的 Enter（確認選字）不攔。
- SpeechRecognition 的 `onerror` 把 `no-speech` 當一般錯誤，顯示「語音辨識發生錯誤」、GA reason 記 `recognition-error`；`onend` 那條路才是「沒聽到聲音」。使用者按了麥克風卻沒講話，Android 的辨識服務會比我們的 6 秒逾時更早用 error 事件回報。→ `no-speech` 另外處理，提示「沒聽到聲音」、reason `no-speech`。
- iOS 上傳辨識：`res.json()` 在 `finally` 清掉逾時之後才讀。回應標頭來了、body 卻一直讀不完時沒有任何逾時，也不能被取消，狀態一直停在「辨識中」、篩選全被鎖住，只能重新整理。→ 讀 body 移進逾時保護裡（abort 會中止它）。
- `runVoiceProcessing` 的 `await loadVoiceSearch()` 沒有上限：`voice-search.js` 的 `<script>` 一直載不進來、也沒失敗的話，同樣鎖死。→ 用既有的 `withTimeout` 加 `VOICE_ENGINE_LOAD_TIMEOUT_MS`（10 秒）。

驗證：用 jsdom 載入真正的 `index.html`、`common.js`、整份 `script.js`、`vendor/pinyin-pro.min.js`、`voice-search.js`，搭配假的 SpeechRecognition、MediaRecorder、getUserMedia、fetch（逾時常數縮短），共 52 個檢查全過；對修改前的版本跑，6 項失敗（對應上面 4 項）。涵蓋兩條路徑的完整狀態機：SpeechRecognition 路徑（`start()` 在點擊的同一個同步呼叫鏈裡被呼叫、拿到結果後不手動 abort、沒講話、逾時 abort 且先拔處理器、權限被拒、network 錯誤、aborted 事件被忽略、麥克風叫不醒提早判斷、上一個 session 沒收尾就再點被擋下並在 onend 與冷卻後恢復、切到背景收畫面不碰 recognition、只講星期不夠不送出、聽不懂、空白、比對引擎載入卡住）；iOS 路徑（`getUserMedia` 在點擊的同步呼叫鏈裡第一個被呼叫、錄完每條音軌都 `stop()`、再點一下提前結束、到錄音上限自動結束、取消與切到背景不上傳並放開麥克風、拒絕權限、權限視窗沒人理且逾時後才按允許時麥克風立刻放掉、429／500／斷線／空結果／非 JSON、401 換 token 重試、錄音太小不上傳、body 卡住）。比對引擎的 91 個回歸案例、G6 的 62 項、G5 前端 35 項、`check:versions` 重跑也全過。`script.js` 版號 252 → 253。測試腳本沒進版控。**限制**：沒有在真的 iPhone 或 Android 上驗證；`no-speech` 在 Android 上實際何時觸發沒量過（這項修正只是把訊息對應好，不依賴時間）。

**不處理（3 項）**
- `COURSE_ALIASES` 的 `bc`、`bp`、`bb` 這類兩個字母的英文別名，會比到英文單字的內部（實測「abc」會選到 BODYCOMBAT）。比對前會把空白全部拿掉，已經分不出英文字的邊界，要處理得重做英文詞的比對方式；Whisper 轉出來的內容幾乎都是中文，英文單字夾 `bc` 的機率很低。
- 聆聽中切到背景只收畫面、不 abort recognition：這是使用者實機驗證後刻意的取捨（手動 abort 疑似會讓整個分頁的音訊狀態卡住），代價是回來時可能看到遲到的訊息，程式註解與 CLAUDE.md 都有記。
- `/transcribeVoice` 的每日額度（2000 次）用完回的也是 429，畫面顯示「操作太頻繁，請稍後再試」，實際要等到明天。額度很寬、目前用量遠低於它，分不出兩種 429 也沒有可行的提示可以給。

**不用改（1 項）**
- 整區全選詞（「台中」「高屏」…）判斷「這句話有沒有講到該區的單一分店」時，會看到其他整區詞先加進去的分店，理論上處理順序會影響結果；實測「彰化台中」「台中彰化」「嘉義台南」「台南嘉義」結果與順序無關：整區詞長度都一樣，詞彙表的排列先放分區按鈕詞、再放縣市詞。目前沒有重現，改了反而動到比對引擎。

**沒問題的部分**
- CLAUDE.md「語音搜尋」的三條硬規定都符合：`start()` 之前沒有 `await`（測試 A1，iOS 的 `getUserMedia` 是測試 B1）、拿到結果後不手動 `abort()`（A7）、收尾先拔處理器再 abort（A13、A14）。
- 麥克風放開：正常結束、取消、切到背景、拒絕權限、逾時後才允許，每條路徑的音軌都被 `stop()`（B5、B11、B12、B22）。
- 比對引擎：`pinyin-pro` 對空字串、表情符號、孤立代理字元、2000 字長句都不丟例外；表情符號會讓逐字拼音長度和句子不一致，程式已經檢查長度相同才換算標色範圍。`npm run test:voice` 91 個案例全過。

### G8
2026-11-20 跑完（xhigh，目標 `script.js` 的 `addDaysIso`～`renderThemeToggle`，沒有二次驗證），共 10 項：修 6 項、待決定 1 項、不處理 2 項、不用改 1 項。篩選勾選與存檔、分享網址、最愛的新增／套用／編輯／刪除／順序／長按、清除記憶、深色模式的主線都沒有問題；修的是「兩個功能互相踩到」與「壞資料」。

**已修（6 項）**
- 語音進行中（`starting`／`listening`／`processing`）只鎖了重設鈕、通知鈕與六組 checkbox，**最愛晶片與分店區的距離／全選鈕沒鎖**：聆聽中點最愛晶片會直接套用並進結果頁，語音那一輪結束時又整組取代、再查一次，結果頁被語音的查詢蓋掉；按「台北全選」勾的 22 間分店被語音結果悄悄蓋掉（正是 `setVoiceRecordingLock` 的註解說要避免的情況）。→ `setVoiceRecordingLock` 一併鎖住（disabled ＋ `voice-dimmed` 變暗）。
- 通知頁的隱私說明與 QR code 浮層可以同時開著、互相疊住看不清楚（內建瀏覽器 375 寬實測）：`setupTogglePopover` 的按鈕 click 有 `stopPropagation`，別的浮層的「點外面收起」收不到這次點擊。→ 開一個時收掉其他的（模組內留一份浮層清單）。
- `showPillWarning` 接手跟標籤完整內容提示（`showHoverTooltip`）共用的那個提示框，卻沒清掉 `activeTooltipAnchor`：結果頁點「等 6 間」標籤、提示開著時再按已是最愛的灰色愛心，「這組篩選已經是最愛了」被接著冒泡到 `document` 的 click 處理器立刻收掉，使用者看到按鈕沒反應。→ `showPillWarning` 內容換掉時清掉 `activeTooltipAnchor`。
- 通知頁「複製網站網址」失敗只 `console.error`，沒有畫面提示；結果頁的複製會顯示「複製失敗，請手動選取」。在 LINE 等內建瀏覽器或剪貼簿權限被拒時，按鈕看起來是壞的（`navigator.clipboard` 不存在時 `TypeError` 也被同一個 `try` 接住）。→ 失敗時顯示「複製失敗，請手動選取」。
- `makePill` 的 id 把非英數、非 CJK 統一表意文字的字元全換成底線：名稱只差在標點、空白、注音符號的老師或課程會得到同一個 id（例如「ㄅ悟」與「ㄚ悟」），第二顆 pill 的 `label for` 指到第一顆，點第二位老師勾到第一位。**目前資料沒有碰撞**（1052 位老師、74 門課的快照逐一比對），屬潛在問題。→ id 尾巴加流水號；id 沒有其他地方在引用（搜尋過 `script.js`、`voice-search.js`、`style.css`）。
- `getFavorites()` 只確認 JSON 能解析、不確認結構：`wg_favorites` 被改成物件、字串或含 `null` 時，載入時頂層的 `renderFavorites()` 丟例外，整支 `script.js` 後面的 `init()` 全不執行，只能手動清網站資料。正常使用不會發生。→ 只收「陣列、每筆是帶 `state` 的物件」的資料，壞掉的筆數下次存檔時掉掉。

驗證：用 jsdom 載入真正的 `index.html`、`common.js`、整份 `script.js`（假 fetch／Chart／IntersectionObserver／PointerEvent，長按時間常數縮短），共 131 個檢查全過；同一份測試對修改前的版本跑，15 項失敗（對應上面 6 項）。涵蓋：`addDaysIso`／`weekdayOfIso`／`resolveQueryState`（跨年、閏年、今天明天）、`makePill`／`renderGrid`（純文字、重畫）、勾選存檔與重新載入還原（分店、星期、時段、教室、課程、老師）、點擊次數排序、分區展開狀態、城市與分區全選、搜尋框與展開鈕、重設鈕、分享網址的產生與還原（短代碼、`utm` 參數、網址帶不存在的值）、提示框、浮層、新增最愛（預設名稱、截斷、提示 pill）、套用最愛、右鍵與長按編輯（改名、換色、順序、取消、刪除）、別的分頁改過清單時的內容比對（改到對的那顆、目標被刪不動別顆、晶片已過期）、長按與短按（放手後的 click 不套用、手指移動、第二根手指、滑鼠右鍵、鍵盤 Enter）、語音鎖定、清除記憶兩顆按鈕保留的 key、主題切換（儲存空間被擋也照樣切）、11 種壞掉的 localStorage 內容。鎖定時的變暗外觀與兩個浮層互斥另在內建瀏覽器（本機伺服器、375×812）看過。G5 前端 35 項、G6 62 項、G7 52 項、`test:voice` 91 案例、`check:versions` 重跑也全過。`script.js` 版號 253 → 254。測試腳本沒進版控。

**待使用者決定（1 項，沒修）**
- 新增最愛時，使用者自己打的名稱原樣當 `favorite_label` 送進 GA（`add_favorite`／`edit_favorite`／`delete_favorite`／`apply_favorite`），但隱私說明寫「僅進行匿名統計且不收集個人資料」。`GA_EVENTS.md` 有記載這是設計（為了看最愛名稱的分布），但名稱是自由文字，使用者可能打人名。要不要改成只送預設名稱（分店名或趣味預設名）、自訂名稱改送 `custom`，或在隱私說明補一句，是產品與隱私的決定。

**不處理（2 項）**
- 「清除篩選記憶」靠 `location.reload()`：網址若還帶著不足以自動查詢的篩選參數（例如手動輸入的 `/?day=1`），重新整理後又被網址套回去。程式產生的分享網址都會在返回篩選頁時被 `showFilterView` 的 `replaceState` 清掉，只有手動編輯網址才碰得到。
- `showHoverTooltip` 的 `wrap` 參數沒有呼叫端傳過非預設值：多一個分支，但拿掉沒有可量的好處。

**不用改（1 項）**
- 原本以為 `TIME_OPTIONS` 只用來產生 `TIME_LABEL`、可以簡化：實際上 `voice-search.js`（詞彙表）與 `worker/scripts/test-voice.mjs`（用正規表示式從 `script.js` 抽出來執行）都在用，是我只搜了 `script.js` 的誤判，沒有動。

**其他沒處理**
- 搜尋老師時被搜尋框藏起來的 pill 若已勾選，畫面上看不到但查詢仍會帶上（沒有任何提示說「還有 N 個已勾選的被藏起來」）；這是搜尋框的既有行為，沒有人回報過。
- 套用最愛時，最愛裡的老師／課程若已不在清單，會被悄悄略過（記憶檔已記錄使用者 2026-10-20 決定先不改）。

**沒問題的部分**
- 所有 localStorage 讀寫都走 `readStored`／`writeStored`／`removeStored`，儲存空間被擋時主題切換、最愛、篩選記憶都不丟例外；`FILTER_MEMORY_KEYS` 涵蓋所有「篩選記憶」類的 key，不會誤清 `wg_client_id`、`wg_theme` 等。
- 最愛編輯：按鈕的垃圾桶刪除先寫回 localStorage 再跑動畫；儲存／刪除前用內容在最新清單裡重新找（`findFavoriteIndex`），多個分頁同時開著不會改到別顆；長按與 `contextmenu` 先後觸發時只開一次；放手後的 click 不會再套用。
- 最愛晶片的名稱與圖示用 `escapeHtml` 後才放進 `innerHTML`（引號也跳脫），顏色走 `style.background` 賦值；老師與課程名稱用 `textContent`（`makePill`）。

### G9
（未開始）
