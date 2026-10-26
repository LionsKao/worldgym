# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 語言

回覆一律使用繁體中文。

## 文件分工

`README.md` 是給人看的專案總覽；本檔是給 AI 協作者的維護細節（為什麼這樣設計、改動時要小心什麼）。兩邊重疊的資訊（資料表、API 端點、cron）以 `worker/schema.sql`、`worker/src/index.js` 的 `ROUTES`、`worker/wrangler.toml` 為準；改了行為就兩份文件都要檢查。**發現文件與實際行為矛盾時，先查證（讀程式、查 Dashboard 或 `wrangler deployments list`）再下結論，不要直接相信文件**——這份文件就曾經寫錯「Worker 沒有接 Git 自動部署」。

## What this is

World Gym 台灣課表查詢網站。純靜態前端 + Cloudflare Worker API + D1 資料庫，沒有 build step、沒有前端框架、沒有 bundler。`script.js`/`admin.js`/`style.css` 都是直接編輯後部署的原始檔。

- Hosting (static site, Cloudflare Pages): https://worldgym.pages.dev
- API (Worker): https://worldgym-api.lions2100.workers.dev

## Commands

### Local dev
```bash
# 前端 (http://localhost:1069)
cd hosting && npm install && npm run dev

# API (worker/.dev.vars 需先手動建立，見 README「本機開發」章節)
cd worker && npm install && npm run dev
```
Windows PowerShell 5.1 不支援 `&&`，上面這種串起來的指令要分成兩行執行。Both dev servers are also registered in `.claude/launch.json` (`worldgym-hosting`, `worldgym-worker`) for use with the preview/browser tools. 兩個都直接用 `node` 啟動（不經 bash/npm），Mac 與 Windows 通用，前提是 `hosting/`、`worker/` 都跑過 `npm install`。`hosting/dev.mjs` 把 wrangler 狀態存在 `os.tmpdir()` 底下：`hosting/wrangler.jsonc` 的 `assets.directory` 是 `..`（整個 repo），狀態若放在 repo 內（預設的 `.wrangler/state`）會被當成資源異動而無限重新載入。

### Deploy

**日常部署＝push 到 `main` 就好。** 靜態站（Pages）與 Worker 都已設定 Cloudflare 自動部署（細節見下面兩段），push 完不需要再手動部署（`wrangler deploy`、`pages deploy` 只在緊急、要不經 Git 立刻上線時才用），也不需要事後輪詢 `wrangler deployments list`、等建置完成來確認部署狀態——除非使用者明確要求驗證線上行為。使用者說「push」或「push 並部署」時，只做 push 並回報 commit 範圍。

**靜態站（Cloudflare Pages `worldgym`，https://worldgym.pages.dev）：push 到 `main` 就會自動部署。** 這個 Pages 專案連了 GitHub（`LionsKao/worldgym`），生產分支是 `main`、自動部署開著，Cloudflare 會從 Git 抓該 commit 的內容、在 repo 根目錄建置（沒有 build 指令，`functions/` 會一起打包）。所以：
- 發布的是**已 push 的 commit**，不是你電腦上的工作目錄，不會夾帶未 commit 的檔案。
- 沒 push 的 commit 在 Dashboard 按「Retry deployment」會失敗（`not our ref`），因為 Cloudflare 抓不到。
- Pages 的 D1 綁定（`DB`）設在 Dashboard 的 Production 環境，要改綁定需重新部署才生效。

**Worker API（`worldgym-api`）也是 push 到 `main` 就自動部署（Cloudflare Workers Builds）。** 設定在 Dashboard → Workers 和 Pages → worldgym-api → 設定 → 建置：Git 存放庫 `LionsKao/worldgym`、生產分支 `main`、根目錄 `worker`、部署指令 `npx wrangler deploy`、監看路徑 `*`（**任何**檔案有變動的 push——包含只改前端的——都會觸發一次 Worker 建置，約 15 秒到 2 分鐘）；「非生產分支的組建」有開（推到其他分支只會用 `wrangler versions upload` 建預覽版本，不影響線上）。Dashboard 的部署紀錄裡，標「建置 ⎇ main」的是 Git 觸發、標「已手動部署 / Wrangler」的是用指令部署。所以：
- **push 到 `main` ＝ 同時部署 Pages 與 Worker**，沒有「只 push、先不部署 Worker」這個選項。想先不上線，就推到別的分支，或晚點再 push。
- Worker 程式碼與 D1 migration 是分開的：自動部署**不會**跑 migration。改了 schema 要先 `wrangler d1 execute ... --remote --file=migrations/xxx.sql`（或確保新舊程式碼都相容），再 push。
- 手動部署只在要「不經 push、立刻上線」時用：
```bash
cd worker && npm run deploy     # 部署 API (wrangler deploy)
```

**緊急/手動部署 Pages（不經 Git）**：一定要在 repo **根目錄**執行，這種部署發布的是**當下工作目錄**的檔案（含還沒 commit 的），部署前先 `git status` 確認乾淨：
```bash
worker/node_modules/.bin/wrangler pages deploy . --project-name worldgym --branch main
```
**不要在 `hosting/` 下執行 `pages deploy ..`**：wrangler 是用「目前工作目錄」下的 `functions/` 找 Pages Functions，不是用部署目錄；在 `hosting/` 執行會找不到 `functions/`，整份 Functions（`_middleware.js` 的台灣 IP 限制、`index.js` 的伺服器端注入）都不會被打包上線。部署後可到 Dashboard → worldgym → 部署，確認該次部署有 Functions。（`hosting/package.json` 的 `deploy` 腳本已改成在根目錄執行。）

Worker tail logs: `cd worker && npm run tail`

D1 query/migration against production:
```bash
cd worker
npx wrangler d1 execute worldgym-schedule --remote --command="SELECT ..."
npx wrangler d1 execute worldgym-schedule --remote --file=migrations/xxx.sql
```

分店清單一致性檢查（新增/調整分店後一定要跑）：
```bash
cd worker && npm run check:branches -- --base=origin/main
```
分店資料散在 `worker/src/branches-seed.js`（唯一來源）、`script.js` 的 `BRANCH_SLUG_ORDER`、`index.html` 寫死的分店 pill（含縣市、顯示名稱、經緯度）與備援用的靜態 `sitemap.xml`，沒有 build step 能自動同步。這支腳本只讀檔，檢查四處是否對得上；**加上 `--base=<git ref>` 才會驗證 seed 的順序「只能往後附加」**——三處同步插到中間時，光比對三處是看不出來的，但舊的短代碼分享網址會指到別間分店。同時會檢查 `branches-excluded.js`（見下）的格式、重複與跟 seed 有沒有重疊。有錯誤 exit code 為 1。

**本站只收「不用付費的團體課」，官網有、但沒收進 seed 的分店都是刻意的**（Express 店，有的另外只有 Studio X 付費課），不是漏掉。為了讓每月 2 號的分店掃描只通知「真正新出現」的網址，這些不收的網址記在 `worker/src/branches-excluded.js` 的 `EXCLUDED_BRANCHES`（slug → 理由；2026-10-13 逐一查證並經使用者確認：36 間 Express ＋ 1 個別名網址 `caotun`，它跟已收錄的 `nantou-caotun` 是官網同一間草屯店的兩個網址）。Express 不會有免費團課，所以不收的網址不需要定期重新檢查。收到 Teams「疑似新分店」通知時：有不用付費的團課 → 照上面流程加進 seed（`BRANCH_SLUG_ORDER`、`index.html` pill 一起，只能往後附加）；不收 → 加進 `EXCLUDED_BRANCHES` 並寫理由。同一個 slug 不能同時在 seed 與 `EXCLUDED_BRANCHES`（`check:branches` 會擋）。另有 `EXPECTED_MISSING_FROM_SITEMAP`：已收進 seed、但官網 sitemap 還沒有的預售分店（目前是桃園藝文 `taoyuan-yiwen`），掃描不把它當「疑似下架」；官網建了分店頁、有課表之後爬蟲會自動抓進來，那時可以順手刪掉這一項。已收進 seed 但官網分店頁還沒有任何課的（目前是苗栗竹南 `miaoli-zhunan`）不需要登記——它在 sitemap 裡，掃描本來就不會報。

靜態資源版號檢查（**改了 CSS／JS／icon 之後、commit 或 push 之前一定要跑**，見「靜態資源快取」）：
```bash
cd worker && npm run check:versions -- --base=origin/main
```
CSS／JS／icon 快取 30 天，全靠 `?v=` 版號換新，版號是人工維護的。這支腳本只讀檔，檢查：每個引用本站資源的地方（三個 html、`manifest.json`、`sw.js` 的通知圖示、`script.js` 載入 Chart.js 的網址）都帶 `?v=` 且檔案存在、同一個檔案各處版號相同（例如 `style.css` 三頁要一樣）；**加上 `--base=<git ref>` 才會抓「檔案內容改了、版號沒加」**——這是最容易漏、一漏使用者最久一個月看到舊檔的錯誤。有錯誤 exit code 為 1。

There is no test suite and no lint/build command in this repo（只有上面這兩支檢查腳本）。

### 部署注意
`hosting/wrangler.jsonc` 是另一套 Workers Assets 設定，`name: "worldgym-web"`，曾經對應過一個叫 `worldgym-web.lions2100.workers.dev` 的 Worker，但那個 Worker 已刪除——它跟 `worldgym.pages.dev` 是互相獨立、不互相依賴的兩個部署目標，且沒有 `functions/_middleware.js` 的台灣 IP 限制。不要再用 `npx wrangler deploy` 部署到它。

**Pages 會把整個 repo 根目錄當成靜態資源發布，而且不會套用 `.assetsignore`**（那是 Workers Assets 的機制，Pages 沒有這個功能）。所以 `worker/`、`hosting/`、`docs/`、`*.md`、`.claude/`、`.gitignore` 這類不屬於網站的檔案，是靠 `functions/_middleware.js` 的 `isBlockedPath()` 一律回 404 擋掉（路徑先 decode 再比對，擋百分比編碼繞過）。新增不該公開的資料夾或檔案類型時，要記得加進 `BLOCKED_TOP_DIRS`。手動部署時，`worker/.dev.vars` 這類密鑰檔也會被上傳（雖然讀不到），部署前仍要確認它不在工作目錄裡。

## Architecture

```
index.html / script.js / style.css   前端：課表查詢頁 + 首頁廣告橫幅 + 首頁公開排行報表
common.js                            前台與後台共用的前端工具：escapeHtml、readJsonOrThrow/fetchJson、isStandaloneDisplay、自製下拉選單、台灣今天日期 todayIso 與月份計算、折線圖工廠 createLineChart、下拉重新整理
ga-init.js                           GA4 初始化（只有 index.html 載入，必須同步載入；因 CSP 不允許 inline script 而獨立成檔）
css-async.js                         非阻塞載入 Font Awesome CSS（同樣因 CSP；index.html、admin.html 都載入）
manifest.json / sw.js / icons/       PWA + Service Worker（推播提醒用）
admin.html / admin.js                後台：登入、報表（Chart.js）、手動重抓與清除孤兒資料
vendor/chart.umd.min.js              Chart.js，vendor 進來不吃 CDN
404.html / robots.txt / llms.txt / sitemap.xml   sitemap.xml 與 llms.txt 是動態版失敗時的備援靜態檔
GA_EVENTS.md                         前端送出的 GA4 事件清單
functions/_middleware.js             Cloudflare Pages Functions：只放行台灣 IP（爬蟲 UA 例外）、擋掉非網站檔案（worker/、*.md、點開頭檔案等）回 404
functions/index.js                  Pages Function：單一分店網址在伺服器端注入課表（見下方「伺服器端注入課表」）
functions/sitemap.xml.js            動態 /sitemap.xml（備援：根目錄靜態 sitemap.xml）
functions/llms.txt.js               動態 /llms.txt（備援：根目錄靜態 llms.txt）
functions/_lib/                     注入設定與 SITE_ORIGIN（ssrConfig.js）、實作（ssrBranch.js）、slug 網址（branchUrl.js）、
                                    分店查找表（branches.js）、D1 逾時與 Cache API 共用流程（util.js）、
                                    有課表的分店清單（scheduleBranches.js，sitemap 與 llms.txt 共用）、sitemap.js、llms.js
_headers                             Pages 回應標頭：安全標頭與 CSP（見「安全標頭與 CSP」）、CSS／JS／icon 的 30 天快取（見「靜態資源快取」）
hosting/                             只用於本機開發（dev.mjs 啟動 wrangler 靜態伺服器），不是正式部署目標
worker/
  src/index.js                      路由表 ROUTES（限流、後台驗證統一處理）/ CORS / 入口 / cron scheduled()
  src/crawlers.js                   海外 IP 存取判斷：爬蟲 UA 清單（Pages 的 _middleware.js 也 import 這份）+ 只放行的唯讀路徑
  src/util.js                       共用小工具：台灣時間（nowTaiwanIso 等）、fnv1aHex、爬官網的 UA、推 Teams；functions/ 也會 import
  src/queryClasses.js               課表查詢邏輯
  src/scrape.js                     爬蟲邏輯（重抓官網課表寫入 D1）
  src/branchScan.js                 每月比對官網 sitemap 與 branches-seed.js，有差異才通知 Teams（只通知，不改資料）；已知不收的網址（branches-excluded.js）不算差異
  src/reminders.js                  課前推播提醒：登記/取消/到期發送 Web Push
  src/analytics.js                  報表的「明細 + 月度彙總」合併查詢與每月壓縮（rollupAnalyticsEvents）
  src/branches-seed.js              分店清單固定資料
  src/branches-excluded.js          月度掃描用：官網有、但刻意不收的分店（EXCLUDED_BRANCHES，附理由）＋已收進 seed、官網 sitemap 還沒有的預售分店（EXPECTED_MISSING_FROM_SITEMAP）
  scripts/check-branches.mjs        分店清單一致性檢查（npm run check:branches，見 Commands）
  scripts/check-versions.mjs        靜態資源版號檢查（npm run check:versions，見 Commands 與「靜態資源快取」）
  schema.sql                        D1 完整 schema（重建資料庫用，會 DROP 所有表）
  migrations/                       針對既有正式資料庫的單張 table migration
```

前端呼叫 `worker` 的 API（`/queryClasses` 等），API 讀寫 D1（`worldgym-schedule`）。`worker/wrangler.toml` 的 `[triggers]` 有五個 cron：`*/5 * * * *` 每 5 分鐘掃描課前推播是否到期；`0 19 * * *`、`0 9 * * *`（台灣時間 03:00/17:00）各自動重抓一次全部分店（需要 Workers Paid，單次執行 subrequest 上限拉到 1000 才跑得完 110 間分店）；`0 20 1 * *`（每月 1 號 04:00）做兩件互不相關的事：把當月以前（實務上是剛結束的上個月）的報表明細壓縮成月度彙總並刪掉明細，以及另外清掉 `query_access_log` 90 天前的紀錄（90 天只針對這張表）；`0 21 2 * *`（每月 2 號 05:00）跑分店清單掃描。也可以透過 `admin.html` 手動觸發重抓。

### D1 資料表（完整定義見 worker/schema.sql）

| Table | 用途 |
| --- | --- |
| `classes` | 爬蟲抓下來的課表 |
| `branches` | 分店清單（slug、名稱、地區） |
| `meta_filter_options` | 篩選用課程/老師名稱清單快取（爬蟲跑完才更新；也是 `/trackSearchEvents` 驗證老師/課程名稱的來源） |
| `reminders` | 課前推播提醒登記與發送狀態 |
| `reminder_add_events` / `reminder_add_monthly` | 提醒功能使用量（只記「登記」次數） |
| `ads` | 首頁廣告內容與上下架時間（沒有輪播，每次載入隨機挑一則）。橫幅 `#adBanner` 在 `index.html` 預設 `hidden`、沒有預設文字與連結，有生效中的廣告（或舊網域提示、臨時公告）才由 `script.js` 的 `initAdBanner()` 填內容並顯示——不要把預設改回顯示，否則沒廣告時載入會先閃一下再消失。**臨時公告**（例如颱風提醒）是 `script.js` 的 `SITE_NOTICE`（`text` 文字＋ `endDate` 不含當天的結束日），純文字、沒有連結、圖示是 `fa-bullhorn`，今天（台灣）早於 `endDate` 才顯示、過期自動消失；優先順序「公告 > 舊網域提示 > 廣告」，公告期間不打 `/ads`、不送廣告點擊統計。要發新公告就改這兩個欄位並把 `script.js` 版號加一，不需要 migration |
| `ad_events` / `ad_monthly` | 廣告曝光/點擊打點與月度彙總 |
| `teacher_search_events` / `course_search_events` / `branch_search_events`（各有 `*_monthly`） | 老師/課程/分店查詢次數打點與月度彙總 |
| `search_events` / `search_monthly` | 整體查詢次數與結果數 |
| `favorite_events` / `favorite_monthly` / `favorite_client_seen` | 「我的最愛」建立/使用打點，用匿名 clientId 去重估算人數；`favorite_client_seen` 即時維護全時間去重人數 |
| `query_access_log` | `/issueToken`、`/queryClasses` 的存取紀錄，每月清 90 天前的 |

事件明細表（`*_events`）只保留當月，上個月由每月 cron 壓縮進 `*_monthly` 後刪除明細；所有報表查詢是「彙總表 UNION ALL 明細表」。**這些事件表的索引只留實際被查詢計畫用到的**：它們每次使用者查詢、點最愛、看廣告都會寫入，而每個索引都讓每筆寫入多寫一份、每月壓縮刪明細時也要連索引一起刪；所有查詢都是依月份 `substr(createdAt,1,7)` 篩選或分組，所以只需要建在 `substr` 運算式上的索引（`worker/migrations/020` 已在正式庫砍掉 14 個沒人用的，資料庫約 28.5MB → 24.2MB，23 個索引剩 9 個）。新增或改動會碰這些表的查詢時，先用 `EXPLAIN QUERY PLAN`（本機套 `schema.sql` 與正式庫的計畫要一致）確認用到哪個索引，真的需要才加，不要憑感覺多建。細節見 README「分析報表明細轉月度彙總」與 `worker/src/analytics.js`。

**時間戳一律用台灣時間（`+08:00`），不是 UTC**：`createdAt`/`updatedAt`/`scrapedAt`/`ads.startAt`/`ads.endAt` 都是位移 8 小時再貼 `+08:00` 後綴的 ISO 字串，才能跟其他時間戳直接用字串比較/排序。一律用 `worker/src/util.js` 的 `nowTaiwanIso()`（要往前/往後推用 `taiwanIso(offsetMs)`，要台灣年月日時分用 `taiwanClock()` 再讀 `getUTC*()`，用 `Date.UTC(...)` 湊出來的台灣牆上時間轉字串用 `taiwanIsoOf()`，台灣今天的日期用 `todayIsoTaipei()`，台灣這個月／往前幾個月的 `YYYY-MM` 用 `taiwanMonthKey(n)`；前端的台灣今天日期用 `common.js` 的 `todayIso()`，`currentMonthKey()` 也是它切出來的，前後台都不要自己再算一份），不要在各檔案自己寫 `Date.now() + 8 * 3600 * 1000`，也不要混用 `new Date().toISOString()`（那是 UTC）。

**爬蟲寫入 `classes` 的方式（`worker/src/scrape.js` 的 `replaceBranchClasses`）：先 upsert 這間分店這一輪的全部列、最後在最後一批裡清掉「這間分店 `scrapedAt` 比這一輪舊」的列**，不是先整間 DELETE 再分批重寫。那樣寫入的這幾百毫秒到幾秒，這間分店是空的或只有一部分，剛好有人查詢、或 sitemap/SSR 在這時重建並快取 30 分鐘就會看到殘缺資料；寫到一半失敗更會留下殘缺資料。現在任何時刻看到的至少是舊資料（換了老師的課短暫有兩筆），中途失敗舊資料原封不動、下一輪再清。因此**同一間分店同一輪的所有列共用同一個 `scrapedAt`**（它是新舊資料的分水嶺），改這段時不要改回逐列 `nowTaiwanIso()`，也不要改回先刪光。`staleDeleted` 現在是「真正過期被清掉的筆數」，不是「整間先刪光的筆數」。upsert 用 `ON CONFLICT(id) DO UPDATE SET`，**只更新同一個 id 下還可能變的欄位**（`branchName`、`teacherName`、`teacherEmpNo`、`roomName`、`isSubstitute`、`scrapedAt`），不要改回 `INSERT OR REPLACE`（它遇到相同 id 會「先刪整列再插入」，連帶重寫每個索引項目，寫入量大好幾倍）；`className`、`date`、`startTime`、`branchSlug` 都在 id 裡、同 id 必定相同，而且 `className` 有索引，放進 SET 會每輪重寫那條索引。

新增/修改 ads table 結構：`schema.sql` 只在建立全新資料庫時整份重跑（會清空所有表）；對既有正式資料庫要用 `worker/migrations/` 新增檔案 + `wrangler d1 execute --remote --file=`，不要直接改 schema.sql 後重跑。

### 推播提醒 (PWA)
課表頁需先加到主畫面成為 PWA 才顯示鈴鐺按鈕（`script.js` 的 `isPWAInstalled()` 判斷 `display-mode: standalone`；本機測試可在網址加 `?pwa=1` 繞過）。登記提醒流程：前端 `sw.js` 註冊 Service Worker 拿 Push 訂閱 → `/registerReminder` 存 D1 → worker cron 每 5 分鐘掃到期提醒 → `reminders.js` 用 VAPID 金鑰簽署推播內容送出 → `sw.js` 的 `push` 事件顯示通知。
課前幾分鐘由使用者在點鈴鐺跳出的小視窗選 30/60/90（前端 `script.js` 的 `REMIND_MINUTES_OPTIONS`、`index.html` 的 `remindLead` radio、後端 `reminders.js` 的 `REMIND_MINUTES_OPTIONS` 白名單三處要一致；`/registerReminder` 沒帶 `remindMinutes` 視為 30，帶了不在白名單回 400）。一堂課只有一個提醒時間：`buildReminderId` 不含分鐘數，重複登記是覆蓋；黃鈴鐺點一下直接取消，要改時間就取消後重登。`reminders.remindMinutes` 只給畫面顯示「課前 N 分鐘」用，**cron 發送只看 `remindAt`**。上次選的值存 localStorage `wg_remind_minutes`，只用來預選。

### 台灣 IP 限制與爬蟲例外
Pages（`functions/_middleware.js`）與 Worker（`worker/src/index.js` 開頭）都只放行台灣 IP（`cf.country` 沒值，如本機開發，一律放行）。已知搜尋引擎/AI 爬蟲（Googlebot、GPTBot、ClaudeBot、Claude-User 等，UA 清單 `CRAWLER_UA_PATTERN`）例外：
- Pages：整個站都放行（robots.txt / sitemap.xml / llms.txt 一律放行，不看 UA 也不看 IP；llms.txt 是給各家 AI 讀的，AI 的 UA 追不完，擋了沒意義）。
- Worker：只放行唯讀的 `GET /filterOptions`、`GET /issueToken`、`POST /queryClasses`（含這三個路徑的 `OPTIONS` preflight），其餘端點（打點、後台、統計、推播登記、留言…）對海外爬蟲一律 403，避免爬蟲渲染頁面時污染統計。判斷邏輯在 `worker/src/crawlers.js` 的 `isRequestAllowed`，token 與每 IP 流量限制照舊，沒有為爬蟲另開後門。
- **`CRAWLER_UA_PATTERN` 只有一份，在 `worker/src/crawlers.js`**，`functions/_middleware.js` 直接 import 它（`functions/` 本來就會 import `worker/src/` 的檔案，Pages 打包時一起包進去），要增減爬蟲只改那一處。
- UA 只能用來決定「放不放行」，不可以依 UA 回傳不同內容（cloaking）。

### 伺服器端注入課表（SSR）
目的：讓不執行 JS 的爬蟲（多數 AI 爬蟲）也讀得到單一分店課表。`functions/index.js` 只處理 `/`：網址正規化後剛好是「單一分店 + `room=1`」（`branch` 可寫短代碼或 slug；`utm_*`/`pwa`/`fbclid`/`gclid` 會忽略）且該分店在注入清單裡，才查 D1 並用 HTMLRewriter 改寫回傳的 `index.html`；其餘網址（無參數、多分店、有 day/time/course/teacher、不在注入清單）一律 `context.next()` 原樣放行，不查 D1，canonical 維持靜態 HTML 的 `/`。
- 注入清單：`functions/_lib/ssrConfig.js` 的 `SSR_BRANCH_SLUGS`，目前直接取 `worker/src/branches-seed.js` 的全部分店（新增分店自動納入）；想縮小範圍就改成明確的 slug 陣列。查不到團體課表的分店會退回原頁，不會回錯誤；回應標頭 `X-SSR-Status`（hit/miss=有注入，no-data/too-many/no-fixed/error=退回原頁的原因，error 不帶例外訊息、詳細內容看 Pages 的 log）可用來排查（要用 GET，HEAD 不會經過這個 Function）。
- **動態 sitemap**：`functions/sitemap.xml.js`（邏輯在 `functions/_lib/sitemap.js`）處理 `/sitemap.xml`，只列「近 7 天真的有團體教室固定班」的分店（跟注入條件一致，列出來的網址一定查得到內容；查詢與過濾在 `functions/_lib/scheduleBranches.js` 的 `getBranchesWithSchedule()`，與 llms.txt 共用，排序依短代碼，`<loc>` 用 slug 網址）＋首頁，lastmod 取該分店最新的 `scrapedAt` 日期，結果用 Cache API 快取 30 分鐘。新分店有資料自動出現、沒資料自動消失，不用手動維護。任何失敗（沒有 D1 綁定、逾時、查無資料）會 `context.next()` 退回根目錄的靜態 `sitemap.xml`，所以**靜態檔要留著當備援**，內容只是備援用，不必常更新。**暫時的診斷檔 `/sitemap-static.xml`**（2026-10-22 加入）：Search Console 對 `/sitemap.xml` 一直顯示「無法讀取 Sitemap」，為了分辨是動態 Function 的問題還是 Google 那邊的問題，另放一份靜態快照（根目錄 `sitemap-static.xml`，內容是當時動態 sitemap 的輸出，不會更新），並加進 `_middleware.js` 的 `PUBLIC_CRAWLER_PATHS`（不放行的話海外抓取會被 403，就測不出東西）。要在 Search Console 另外提交它來對照；**問題釐清後把這個檔與 `PUBLIC_CRAWLER_PATHS` 裡那一項刪掉，並從 Search Console 移除這份 sitemap**，不要留成長期維護的第二份 sitemap。
- 資料來源：Pages 專案綁 D1（binding 名 `DB`，**在 Cloudflare Dashboard → worldgym → Settings → Bindings 設定，不在版控裡**，改完要重新部署才生效），直接 `import` `worker/src/queryClasses.js`，所以內容與前端查詢（`/queryClasses`）同源。注入「本週固定課表」，不含代課（代課帶日期、很快過期）。
- **給爬蟲與 AI 看的分店網址一律用 slug**（`/?branch=taipei-daan&room=1`）：canonical、og:url、動態/靜態 sitemap、llms.txt、JSON-LD 都是，由 `functions/_lib/branchUrl.js` 的 `branchPageUrl()` 統一產生（canonical、sitemap、llms.txt 三處共用，不要各自拼網址；sitemap 放進 XML 時要把 `&` 跳脫成 `&amp;`）（slug 不符 `/^[a-z0-9-]+$/` 才退回短代碼）。**短代碼只保留給前端的分享網址（`script.js` 的 `buildShareUrl`）與舊連結相容**：解析端 `resolveSsrTarget` 兩種寫法都收，且兩種寫法得到的 canonical 都是 slug 版。短代碼 = `worker/src/branches-seed.js` 陣列位置，跟 `script.js` 的 `BRANCH_SLUG_ORDER` 同一個順序，**這個限制仍然有效：兩邊順序必須一致、只能往後附加，不能插入/調換**（順序一變，舊的短代碼分享網址就會指到別間分店；改完用 `npm run check:branches -- --base=origin/main` 檢查）。我的最愛存的是 slug，不受影響。
- **分店頁專屬 JSON-LD**：`rewriteHtml()` 會把頁面上第一個 `application/ld+json` 換成 `buildBranchJsonLd()` 的輸出（其餘的移除，確保只剩一個）：`@graph` 只有 WebSite（原樣沿用首頁那個節點，要跟 `index.html` 一致）加一個 WebPage（`@id`/`url` 是 slug 版 canonical，`name`/`description` 與 title/meta 共用 `buildBranchMeta()` 同一份來源，`dateModified` 沿用台灣時間的 `scrapedAt`）。輸出時 `<` 跳脫成 `\u003c`（JSON 裡等同 `<`，避免分店名稱含 `</script>` 破壞 HTML）。**刻意只用 WebPage、不輸出 ExerciseGym / LocalBusiness / SportsActivityLocation / Event / Course / ItemList / BreadcrumbList，也不輸出地址、電話、座標、評分**：課表區塊是視覺隱藏的，Google 規定結構化資料要與可見內容相符；而且不能替真實的健身房建立實體。首頁的 WebApplication 節點也不放進分店頁。所有 UA 拿到的 JSON-LD 完全相同；產生失敗就沿用首頁的。
- **動態 `/llms.txt`**：`functions/llms.txt.js`（邏輯在 `functions/_lib/llms.js`）= 根目錄靜態 `llms.txt` 的內容（取自 `env.ASSETS`，文字只有一份）+ `## 分店課表` 索引（`- [名稱 分店（地區）團體課表](slug 網址)`，順序與 sitemap 相同，因為共用 `scheduleBranches.js` 的 `getBranchesWithSchedule()`）。連結文字會跳脫 Markdown 特殊字元（`\`、`[`、`]`），結果用 Cache API 快取 30 分鐘。任何失敗（沒有 D1/ASSETS 綁定、逾時、查無分店、例外）`context.next()` 退回靜態 `llms.txt`，所以**靜態檔要留著當備援**（它不列分店）。**刻意不列出**：任何 API 端點、後台（/admin）、GitHub、Worker 網址、技術架構或爬取機制；更新頻率只寫「每日更新」；也不加「非官方」等聲明。所有請求（不分 UA）內容相同。
- 注入內容放在 `#loadingOverlay` 裡（`.visually-hidden`）：overlay 是不透明全螢幕載入遮罩，`init()` 結束時整個 `remove()`，區塊跟著消失，所以使用者畫面不變、`script.js` 不用改。同時改寫 `<title>`、description、og/twitter、canonical（slug 版）與 JSON-LD。
- 查 D1 的結果（片段，含 `scrapedAt`）用 Cache API 快取 30 分鐘，不快取整份 HTML；片段快取 key 是 `/_ssr/v2/{slug}`（v2 = 多了 `scrapedAt` 欄位，升版避免跟舊格式混用；讀取時仍容忍沒有此欄位，缺的話 JSON-LD 就不輸出 `dateModified`），動態 sitemap 的 key 是 `/_ssr/v2/sitemap`（v2 = `<loc>` 由短代碼改 slug），llms.txt 是 `/_ssr/v2/llms`（三種 key 都由 `functions/_lib/util.js` 的 `cacheRequest()` 產生，版號只在那裡改一處；sitemap 與 llms.txt 共用 `cachedTextResponse()` 的「快取→產生→快取」流程）；D1 逾時（1.5 秒）、查不到、超過 250 筆、出錯都退回原頁，不回錯誤頁。課程/老師名稱一律 HTML 跳脫。
- 本機測試：`wrangler pages dev . --compatibility-date=2026-08-11 --d1 DB=<database_id> --persist-to <dir>`；本機 D1 是空的，要先匯入資料。

### /queryClasses 防濫用
匿名公開端點，做不到真正私有 API，只拉高濫用成本：
1. 流量限制：每 IP 每 60 秒 20 次（`/queryClasses`）/ 10 次（`/issueToken`），用 KV namespace `QUERY_RATE_LIMIT`（fixed-window，非原子，夠用不追求精確）。
2. 短效 HMAC token：`GET /issueToken` 發 15 分鐘效期 token（payload 只有 `exp`，`QUERY_TOKEN_SECRET` 簽名）。`/queryClasses` 沒帶對 token 回 401（`token_invalid`/`token_expired`）。
3. 結果筆數上限：`worker/src/queryClasses.js` 的 `RESULT_HARD_CAP = 600`（前端超過 `RESULT_COUNT_WARN_LIMIT = 250` 就整包不顯示，後端沒必要撈更多）。
前端過期自動重拿 token 重試一次，使用者無感（見 `script.js` 的 query 流程）。
**前端查詢結果快取**（`script.js` 的 `runScheduleQueryCached`）：同一組條件 5 分鐘內重複查詢（查詢→返回→再查、點最愛、點老師名字）直接用上一次的結果，不打 `/queryClasses`，也不吃限流額度。**只存在頁面的 JS 記憶體、不寫 localStorage**——重新整理、關掉 PWA 就清空，隔了一段時間再回來（localStorage 會還原同一組篩選）超過存活時間也會真的重新要資料；課表一天只更新兩次，5 分鐘不會讓人看到過期資料。key 含台灣今天的日期（跨日要重查）與排序過的條件；只存成功且筆數 ≤ 250 的結果，失敗不存，最多 20 組。`/trackSearch` 等統計打點不受快取影響（命中也照送，查詢次數統計與以前相同）。改這段時不要把結果寫進 localStorage，也不要讓快取延長存活時間（TTL 從「抓回來」起算）。

### 後台報表 / 首頁公開排行
`admin.html` 有廣告/最愛/提醒三個報表面板（加上 IP 存取紀錄表），折線圖用 `common.js` 的共用工廠 `createLineChart()`（一或兩條線；`updateLineChart()` 換資料）。首頁「通知」分頁下方有查詢量趨勢與老師/課程/分店查詢次數排行（`/publicSearchStats`、`/publicTeacherStats` 等端點，不驗證 token，因為這些是課表本身的公開資訊），用 `script.js` 的 `setupPublicRankingStats()` 畫圖：分店與課程只顯示前 10 名，老師顯示後端回傳的前 15 名（上限在 `rankingHandler` 的 `limit`）。這四個公開端點每次要合併整個月的事件明細（合計約 13～17 萬列讀取），而 API 走 workers.dev、邊緣不替 Worker 做共用快取，所以除了瀏覽器端的 `Cache-Control`（5 分鐘），Worker 還用 `cachedStats()` 在 isolate 記憶體再快取 5 分鐘（key 含端點與年月、最多 64 筆、滿了丟最舊的、只快取成功結果），排行與趨勢因此最多晚約 10 分鐘更新；改這幾個端點時別繞過 `cachedStats()`。年/月選單是自製的 `.custom-select` 元件（`enhanceCustomSelect()`），跟 admin 的廣告篩選下拉共用同一套慣例。新增報表面板的模式：worker 開打點端點（`/trackXxx`，同一次查詢動作會一起寫入的就併進批次端點，如 `/trackSearchEvents`）+ `/xxxStats` 讀取端點（公開的用 `/publicXxxStats`，後台的要驗證 session token）、新增對應 D1 table（含 migration）、前端在對應動作打點。**新增端點只要在 `worker/src/index.js` 的 `ROUTES` 表加一列**（key 是 `"METHOD /path"`，填 `limit` 每 IP 每分鐘上限、後台端點加 `admin: true`、`handler`）：限流（KV key 前綴 = 路徑名）、後台 session 驗證、429/403/404/500 都由 `fetch()` 統一處理，handler 只寫業務邏輯；老師/課程/分店排行三個端點共用 `rankingHandler()`。

**公開打點端點要驗證內容，不能什麼字串都收**：`/trackSearchEvents` 的名稱會原封不動出現在首頁公開排行榜，所以分店名稱必須在 `branches-seed.js` 裡（跟前端分店 pill 文字一致）、老師/課程名稱必須在 `meta_filter_options`（前端選項的來源，isolate 內快取 5 分鐘），不在名單的值靜默丟掉；`/trackFavorite` 的 `clientId` 必須是 UUID 格式。新增會顯示在公開頁面上的打點時照這個原則做。

**縮課日標記**：國定假日（含補假）當天，分店改用假日課表，開課時間大多落在整點或 30 分（平常平日是每堂隔 10 分鐘），官方資料沒有任何假日欄位。`script.js` 的 `REDUCED_SCHEDULE_DATES`（目前是 `2026-10-24`、`2026-10-25`、`2026-10-26` 光復節連假：週六、週日、補假週一）是**人工維護的日期清單**，**只看日期**：結果列裡日期在清單裡的課（所有分店、所有課）都會把「週一」這類星期兩個字變成紅色（`.result-reduced-weekday`，用 `--coral`、跟最愛預設的紅同一個；只改顏色，沒有圖示、日期或提示）。**刻意不加「開課時間是整點或 30 分」的條件**：實測 10/26 有 16 間分店、33 堂課在 :10／:20／:40／:50 開始（例如長春 09:40 的瑜伽球），但整天仍是假日課表，用開課時間判斷會漏標（使用者 2026-10-20 確認）。**每次有新的補假日期就要手動加進清單**；連假裡的週六日要是也縮課（光復節連假的 10/24、10/25 使用者 2026-10-22 確認有縮課），也要一起列進去；一般週末本來就是假日課表、不是縮課，不要整批列。資料庫只存今天起 8 天內的完整課表，第 8～14 天只有代課，所以假日在 8 天以外時，列出來的只有代課、紅字也看不到完整情況。

**我的最愛的編輯**：最愛只存在 localStorage `wg_favorites`（`{label, icon, color, state}` 陣列），**沒有 id，用陣列位置辨識**。入口是長按晶片約 0.5 秒（`script.js` 的 `bindFavoriteLongPress`；桌機右鍵、鍵盤 Menu 鍵走 `contextmenu`），短按仍是套用並查詢，所以編輯不能綁在一般點擊上。編輯與新增共用 `#addFavoriteModal`，`favEdit` 是 `null` 就是新增模式，否則是編輯模式（`{target, chip, index, newIndex, total}`，儲存／刪除前用 `target` 的內容在最新的清單裡重新找，多個分頁同時開著時才不會改到別顆）；編輯只改名稱／圖示／顏色／順序，`state`（篩選條件）不動，要改條件就刪了重建。編輯視窗的垃圾桶按了就直接刪，**刻意沒有二次確認**（使用者決定）；資料先寫回 localStorage，被刪的晶片再跑 `.removing` 動畫（`style.css` 的 `fav-remove`，時間要跟 `script.js` 的 `FAV_REMOVE_ANIM_MS` 一致；使用者設了「減少動態效果」就跳過），動畫結束才重畫清單。編輯與刪除只送 GA 事件（`edit_favorite`、`delete_favorite`），**不打 `/trackFavorite`**（後端白名單只收 `add`／`apply`，`favorite_events` 只統計建立與使用）。長按沒有可見提示，靠空狀態文字與「第一次新增最愛後出現一次提示」（localStorage `wg_fav_edit_hint_seen`，看過提示、或真的開過編輯視窗就記下，不再提示）補強；**暫時的 `FAV_EDIT_NOTICE`：編輯功能剛上線時，給已經有最愛的舊使用者一顆接在最愛後面、彩虹底色會流動的「最愛可以編輯了！長按試試」pill，只在 2026-11-01 之前、且尚未記為看過時顯示；pill 完整出現在畫面上連續滿 2 秒才算看過（所以下次載入就不再出現），點一下則收合並立刻記為看過。2026-11-01 之後要把 `FAV_EDIT_NOTICE` 相關程式（搜尋這個字串）、`style.css` 的 `.fav-edit-notice`／`fav-rainbow`、`GA_EVENTS.md` 兩個 `fav_edit_notice_*` 事件、這段說明整個刪掉，並把版號加一**；`.fav-item` 的 `user-select:none`／`-webkit-touch-callout:none` 是防 iOS 長按選字，別拿掉。

**清除記憶分兩顆按鈕**（設定列的「清除記憶」→ `#clearMemoryModal`，`script.js` 的 `FILTER_MEMORY_KEYS`）：「清除篩選記憶」清勾選條件（`wg_selected_*`）、常用排序（`wg_*_clicks`）、分店地區展開狀態（`wg_zone_states`）後重新整理；「清除我的最愛」只清 `wg_favorites` 並重畫最愛列（不重新整理）。兩顆都沒有二次確認（視窗本身就是確認）。**不再整個 `localStorage.clear()`**：`wg_client_id`（清掉會讓同一個人在最愛統計裡變成新使用者）、`wg_remind_minutes`、`wg_fav_edit_hint_seen`、`wg_debug_force_pwa` 都保留。新增「篩選記憶」類的 localStorage key 時要記得加進 `FILTER_MEMORY_KEYS`。GA 事件 `clear_memory` 帶 `memory_type`（`filters`／`favorites`）。

網站沒有帳號系統，「幾個人」的統計靠前端 `localStorage` 存的匿名 `wg_client_id`（`crypto.randomUUID()`），後端用 `COUNT(DISTINCT clientId)` 估算，不對應真實身分。

### 靜態資源快取
**CSS、JS、icon 一律走 `_headers` 快取 30 天（`max-age=2592000`，不加 `immutable`，所以按重新整理仍會向伺服器確認）**：`style.css`、`script.js`、`common.js`、`admin.js`、`ga-init.js`、`css-async.js`、`vendor/*`、`icons/*`、`favicon.ico`。這套做法的前提是**所有引用處都帶 `?v=` 版號**，而且**內容改了就一定要把引用它的地方的版號加一**，否則使用者最久一個月看到舊的——改 JS／CSS／icon 時別忘了：
- `style.css`：`index.html`、`admin.html`、`404.html` 三頁**要用同一個版號**（目前 119；以前三頁各自為政變成 104／73／45，後台和 404 頁會吃到舊樣式）。
- `script.js`（只有 `index.html`）、`admin.js`（只有 `admin.html`）、`common.js`（兩頁都引用，都要排在自己的 script 之前，改了要兩個檔案裡的 `common.js?v=` 一起更新）。
- `ga-init.js`、`css-async.js`、`vendor/chart.umd.min.js`（`admin.html`，以及 `script.js` 的 `loadChartJs()`）：目前 `?v=1`，改了這些檔案就把 1 往上加。
- `icons/*`：`index.html`（`og:image`、`twitter:image`、`apple-touch-icon`、QR code）、`manifest.json`、`sw.js`（通知圖示）都帶 `?v=1`，換圖就一起加。
- 改完跑 `cd worker && npm run check:versions -- --base=origin/main`，它會抓「引用沒帶版號、各處版號不一致、內容改了版號沒加」。
- 例外：`sw.js` 不長快取（Service Worker 本身要能隨時更新）；`favicon.ico` 是瀏覽器自己隱含請求的，沒辦法帶版號（換 favicon 最久一個月才會更新）；HTML、`manifest.json` 沒設，每次都會向伺服器確認。Font Awesome 圖示直接吃 cdnjs 的完整套件，`fa-` class 可以照官方圖示庫直接用。

### 安全標頭與 CSP（`_headers` 的 `/*`）
所有頁面都帶 `Content-Security-Policy`、`X-Frame-Options: DENY`（後台不能被嵌入）、`Strict-Transport-Security`、`Permissions-Policy`（只開 `geolocation=(self)`，分店依距離篩選要用）等標頭。CSP 的重點：
- **`script-src` 不含 `'unsafe-inline'`**：頁面裡不能再寫 inline `<script>` 或 `onclick=`/`onload=` 這類 inline 事件處理（會被擋、而且是靜默失效）。需要時放成外部檔（現有 `ga-init.js` 是 GA4 初始化，只有 `index.html` 載入，且必須同步載入；`css-async.js` 非阻塞載入 Font Awesome CSS，`index.html`/`admin.html` 都載入）。`type="application/ld+json"` 不是可執行腳本，不受影響。
- `style-src` 保留 `'unsafe-inline'`（HTML 裡有大量 `style=` 屬性）。
- **新增任何外部來源（CDN、字型、分析服務、新的 API 網域）都要同步改 CSP**，否則在正式站被擋、本機看不出差別以外的問題；改完用本機 hosting 開發伺服器（會套用 `_headers`）載入頁面，看主控台有沒有 `violates the following Content Security Policy`。萬用字元 `*.example.com` **不包含** `example.com` 本身，要另外列（GA4 的 `analytics.google.com` 就是這樣漏掉過）。
- GA4 會打 `www.google.com.tw` 的受眾像素，所以 `img-src`/`connect-src` 有列這個在地化網域；站台只開放台灣 IP，不必列其他國家網域。
- 本機（localhost）載入時 Cloudflare Web Analytics beacon 會出現 CORS 錯誤，是因為 localhost 不是它登記的網域，跟 CSP 無關，可忽略。

### 後台登入
密碼是 `MANUAL_SCRAPE_TOKEN`；登入成功換發 7 天效期、簽章的 session token（存 `localStorage`，用 `X-Admin-Token` header 帶），只有 `/verifyAdminToken` 收原始密碼，其餘後台端點只認 session token。**登入失敗鎖定**：同一 IP 連續輸錯 5 次鎖 15 分鐘（KV key `admin-fail:<IP>`，TTL 到期自動解除），鎖定期間連正確密碼也會被拒（回 423、畫面顯示「嘗試次數過多，已暫時鎖定」）；要排查可用 `wrangler kv key get "admin-fail:<IP>" --namespace-id <QUERY_RATE_LIMIT 的 id> --remote` 看計數，不要為了「測試登入」刻意輸錯。session 簽章金鑰見下面的 `ADMIN_SESSION_SECRET`。`admin.html` 的登入框（`#adminLoginOverlay`）與登入頁的返回鈕在 HTML 裡預設 `hidden`，只有 `admin.js` 的 `initAuth()` 判斷需要登入才顯示——已登入的人開後台要等 `/verifyAdminToken` 回應，預設顯示的話會先閃一下登入框再消失。驗證超過 `LOGIN_REVEAL_AFTER_MS`（3 秒）還沒回應，就先亮出登入框（不然網路慢時是一片空白、無法登入），之後驗證成功仍會自動換成後台；`showLoginOverlay()` 要先關掉轉場再 `focus()`（從 hidden 轉出來的起點仍算 hidden，直接 focus 會失敗），已經顯示時再呼叫是 no-op（不會清掉使用者打到一半的密碼），`adminEntered` 讓遲到的驗證結果不會蓋掉等待期間手動登入的人。**只有 `/verifyAdminToken` 明確回 401／403（`verifyToken()` 的 `{ invalid: true }`）才清掉存在 `localStorage` 的 session**；423 被鎖定、網路錯誤、逾時、5xx 都保留它（session 可能還有效，鎖定解除或網路恢復後重開就能自動登入，不用重新輸入密碼），不要改回「任何失敗都清掉」。

## Secrets

`worker/.dev.vars`（gitignore，不進版控）本機開發用，需要 `MANUAL_SCRAPE_TOKEN` / `QUERY_TOKEN_SECRET` / `VAPID_PRIVATE_KEY`，`TEAMS_WEBHOOK_URL` 與 `ADMIN_SESSION_SECRET` 選填。正式環境五個 secret 都用 `npx wrangler secret put <名稱>` 設定（`MANUAL_SCRAPE_TOKEN`、`QUERY_TOKEN_SECRET`、`VAPID_PRIVATE_KEY`、`ADMIN_SESSION_SECRET`、`TEAMS_WEBHOOK_URL`；`QUERY_TOKEN_SECRET` 沒設會讓 `/queryClasses` 變 500；`TEAMS_WEBHOOK_URL` 沒設則留言端點回 503、月度掃描靜默略過）。secret 是 Worker 的執行期設定，Git 自動部署不會洗掉它們；wrangler 讀不出 secret 的值，只能覆寫。

`ADMIN_SESSION_SECRET`（選填但建議設，至少 32 字元的隨機字串，`npx wrangler secret put ADMIN_SESSION_SECRET`）：後台 session token 的簽章金鑰。沒設或少於 32 字元就退回舊做法——從 `MANUAL_SCRAPE_TOKEN` 做無鹽 SHA-256 衍生，session token 一旦外洩，攻擊者能離線猜登入密碼；設了獨立金鑰就沒有這個問題。**設定或更換它會讓目前所有後台登入失效**（要重新輸入密碼一次），因為兩種金鑰簽出來的 token 不通用。
