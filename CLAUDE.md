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

**本站只收「不用付費的團體課」，官網有、但沒收進 seed 的分店都是刻意的**（Express 店，有的另外只有 Studio X 付費課），不是漏掉。為了讓每月 2 號的分店掃描只通知「真正新出現」的網址，這些不收的網址記在 `worker/src/branches-excluded.js` 的 `EXCLUDED_BRANCHES`（slug → 理由；2026-10-13 逐一查證並經使用者確認：36 間 Express ＋ 1 個別名網址 `caotun`，它跟已收錄的 `nantou-caotun` 是官網同一間草屯店的兩個網址）。Express 不會有免費團課，所以不收的網址不需要定期重新檢查。收到 Teams「疑似新分店」通知時：有不用付費的團課 → 照上面流程加進 seed（`BRANCH_SLUG_ORDER`、`index.html` pill 一起，只能往後附加）；不收 → 加進 `EXCLUDED_BRANCHES` 並寫理由。同一個 slug 不能同時在 seed 與 `EXCLUDED_BRANCHES`（`check:branches` 會擋）。另有 `EXPECTED_MISSING_FROM_SITEMAP`：已收進 seed、但官網 sitemap 還沒有的預售分店（目前是桃園藝文 `taoyuan-yiwen`、桃園八德 `taoyuan-bade`，八德 2026-10-25 開始預售），掃描不把它當「疑似下架」；官網建了分店頁、有課表之後爬蟲會自動抓進來，那時可以順手刪掉這一項。已收進 seed 但官網分店頁還沒有任何課的（目前是苗栗竹南 `miaoli-zhunan`）不需要登記——它在 sitemap 裡，掃描本來就不會報。

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
common.js                            前台與後台共用的前端工具：escapeHtml、readJsonOrThrow/fetchJson、isStandaloneDisplay、自製下拉選單、台灣今天日期 todayIso 與月份計算、折線圖工廠 createLineChart、圖表主題色 chartTheme／retintCharts、下拉重新整理
ga-init.js                           GA4 初始化（只有 index.html 載入，必須同步載入；因 CSP 不允許 inline script 而獨立成檔）
theme-init.js                        淺色／深色主題初始化（只有 index.html 載入，必須在 <head> 同步載入、趕在第一次繪製前貼 data-theme；同樣因 CSP 獨立成檔，見「深色模式」）
css-async.js                         非阻塞載入 Font Awesome CSS（同樣因 CSP；index.html、admin.html 都載入）
voice-search.js                      語音搜尋的比對引擎（分店/課程/老師/星期/時段/教室），第一次點麥克風才動態載入（見「語音搜尋」）
manifest.json / sw.js / icons/       PWA + Service Worker（推播提醒用）
admin.html / admin.js                後台：登入、報表（Chart.js）、手動重抓與清除孤兒資料
vendor/chart.umd.min.js              Chart.js，vendor 進來不吃 CDN
vendor/html2canvas.min.js            結果頁「下載圖片」用，點了才動態載入，vendor 進來不吃 CDN（見「結果頁底部按鈕列」）
403.html / 404.html / robots.txt / llms.txt / sitemap.xml   sitemap.xml 與 llms.txt 是動態版失敗時的備援靜態檔；403.html 是海外 IP 被擋時回的頁面（見「台灣 IP 限制」）
GA_EVENTS.md                         前端送出的 GA4 事件清單
functions/_middleware.js             Cloudflare Pages Functions：只放行台灣 IP（爬蟲 UA 例外）、擋掉非網站檔案（worker/、*.md、點開頭檔案等）回 404
functions/index.js                  Pages Function：單一分店網址在伺服器端注入課表（見下方「伺服器端注入課表」）
functions/sitemap.xml.js            動態 /sitemap.xml（備援：根目錄靜態 sitemap.xml）
functions/llms.txt.js               動態 /llms.txt（備援：根目錄靜態 llms.txt）
functions/_lib/                     注入設定與 SITE_ORIGIN（ssrConfig.js）、實作（ssrBranch.js）、slug 網址（branchUrl.js）、
                                    分店查找表（branches.js）、D1 逾時與 Cache API 共用流程（util.js）、
                                    有課表的分店清單（scheduleBranches.js，sitemap 與 llms.txt 共用）、sitemap.js、llms.js
_headers                             Pages 回應標頭：安全標頭與 CSP（見「安全標頭與 CSP」）、Permissions-Policy（語音搜尋需要 microphone=(self)，見「語音搜尋」）、CSS／JS／icon 的 30 天快取（見「靜態資源快取」）
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

前端呼叫 `worker` 的 API（`/queryClasses` 等），API 讀寫 D1（`worldgym-schedule`）。`worker/wrangler.toml` 的 `[triggers]` 有五個 cron：`*/5 * * * *` 每 5 分鐘掃描課前推播是否到期；`0 19 * * *`、`0 9 * * *`（台灣時間 03:00/17:00）各自動重抓一次全部分店（需要 Workers Paid，單次執行 subrequest 上限拉到 1000 才跑得完 111 間分店）；`0 20 1 * *`（每月 1 號 04:00）做兩件互不相關的事：把當月以前（實務上是剛結束的上個月）的報表明細壓縮成月度彙總並刪掉明細，以及另外清掉 `query_access_log` 90 天前的紀錄（90 天只針對這張表）；`0 21 2 * *`（每月 2 號 05:00）跑分店清單掃描。也可以透過 `admin.html` 手動觸發重抓。

### D1 資料表（完整定義見 worker/schema.sql）

| Table | 用途 |
| --- | --- |
| `classes` | 爬蟲抓下來的課表 |
| `branches` | 分店清單（slug、名稱、地區） |
| `meta_filter_options` | 篩選用課程/老師名稱清單快取（爬蟲跑完才更新；也是 `/trackSearchEvents` 驗證老師/課程名稱的來源） |
| `reminders` | 課前推播提醒登記與發送狀態 |
| `reminder_add_events` / `reminder_add_monthly` | 提醒功能使用量（只記「登記」次數） |
| `ads` | 首頁廣告內容與上下架時間（沒有輪播，每次載入隨機挑一則）。橫幅 `#adBanner` 在 `index.html` 預設 `hidden`、沒有預設文字與連結，有生效中的廣告（或臨時公告）才由 `script.js` 的 `initAdBanner()` 填內容並顯示——不要把預設改回顯示，否則沒廣告時載入會先閃一下再消失。**臨時公告**（例如颱風提醒）是 `script.js` 的 `SITE_NOTICE`（`text` 文字＋ `endDate` 不含當天的結束日），純文字、沒有連結、圖示是 `fa-bullhorn`，今天（台灣）早於 `endDate` 才顯示、過期自動消失；優先順序「公告 > 廣告」，公告期間不打 `/ads`、不送廣告點擊統計。要發新公告就改這兩個欄位並把 `script.js` 版號加一，不需要 migration |
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
- **被擋時的回應（Pages）**：瀏覽器開頁面（GET 且 Accept 含 text/html）回帶樣式的 403 頁（根目錄 `403.html`，仿 `404.html`，由 `_middleware.js` 的 `forbiddenResponse()` 從 `env.ASSETS` 讀 `/403`——Pages 會把 `/403.html` 308 轉址到 `/403`，所以要請 `/403`；回應帶 `Cache-Control: no-store`、`X-Robots-Tag: noindex`），其餘請求（腳本、API、HEAD）仍是純文字 `Forbidden`，讀不到 `403.html` 也退回純文字。海外使用者的瀏覽器要靠 `style.css` 才有樣式，所以 `/style.css` 在 `PUBLIC_ASSET_PATHS` 裡不受 IP 限制（它本來就是公開檔案）；其他資源（script.js、icons）照舊擋。Worker API 的 403 還是純文字（給程式讀的，不需要頁面）。

### 伺服器端注入課表（SSR）
目的：讓不執行 JS 的爬蟲（多數 AI 爬蟲）也讀得到單一分店課表。`functions/index.js` 只處理 `/`：網址正規化後剛好是「單一分店 + `room=1`」（`branch` 可寫短代碼或 slug；`utm_*`/`pwa`/`fbclid`/`gclid` 會忽略）且該分店在注入清單裡，才查 D1 並用 HTMLRewriter 改寫回傳的 `index.html`；其餘網址（無參數、多分店、有 day/time/course/teacher、不在注入清單）一律 `context.next()` 原樣放行，不查 D1，canonical 維持靜態 HTML 的 `/`。
- 注入清單：`functions/_lib/ssrConfig.js` 的 `SSR_BRANCH_SLUGS`，目前直接取 `worker/src/branches-seed.js` 的全部分店（新增分店自動納入）；想縮小範圍就改成明確的 slug 陣列。查不到團體課表的分店會退回原頁，不會回錯誤；回應標頭 `X-SSR-Status`（hit/miss=有注入，no-data/too-many/no-fixed/error=退回原頁的原因，error 不帶例外訊息、詳細內容看 Pages 的 log）可用來排查（要用 GET，HEAD 不會經過這個 Function）。
- **動態 sitemap**：`functions/sitemap.xml.js`（邏輯在 `functions/_lib/sitemap.js`）處理 `/sitemap.xml`，只列「近 7 天真的有團體教室固定班」的分店（跟注入條件一致，列出來的網址一定查得到內容；查詢與過濾在 `functions/_lib/scheduleBranches.js` 的 `getBranchesWithSchedule()`，與 llms.txt 共用，排序依短代碼，`<loc>` 用 slug 網址）＋首頁，lastmod 取該分店最新的 `scrapedAt` 日期，結果用 Cache API 快取 30 分鐘。新分店有資料自動出現、沒資料自動消失，不用手動維護。任何失敗（沒有 D1 綁定、逾時、查無資料）會 `context.next()` 退回根目錄的靜態 `sitemap.xml`，所以**靜態檔要留著當備援**，內容只是備援用，不必常更新。**暫時的診斷檔 `/sitemap-static.xml`**（2026-10-22 加入）：Search Console 對 `/sitemap.xml` 一直顯示「無法讀取 Sitemap」，為了分辨是動態 Function 的問題還是 Google 那邊的問題，另放一份靜態快照（根目錄 `sitemap-static.xml`，內容是當時動態 sitemap 的輸出，不會更新），並加進 `_middleware.js` 的 `PUBLIC_CRAWLER_PATHS`（不放行的話海外抓取會被 403，就測不出東西）。要在 Search Console 另外提交它來對照；**問題釐清後把這個檔與 `PUBLIC_CRAWLER_PATHS` 裡那一項刪掉，並從 Search Console 移除這份 sitemap**，不要留成長期維護的第二份 sitemap。
- 資料來源：Pages 專案綁 D1（binding 名 `DB`，**在 Cloudflare Dashboard → worldgym → Settings → Bindings 設定，不在版控裡**，改完要重新部署才生效），直接 `import` `worker/src/queryClasses.js`，所以內容與前端查詢（`/queryClasses`）同源。注入「本週固定課表」，不含代課（代課帶日期、很快過期）。
- **給爬蟲與 AI 看的分店網址一律用 slug**（`/?branch=taipei-daan&room=1`）：canonical、og:url、動態/靜態 sitemap、llms.txt、JSON-LD 都是，由 `functions/_lib/branchUrl.js` 的 `branchPageUrl()` 統一產生（canonical、sitemap、llms.txt 三處共用，不要各自拼網址；sitemap 放進 XML 時要把 `&` 跳脫成 `&amp;`）（slug 不符 `/^[a-z0-9-]+$/` 才退回短代碼）。**短代碼只保留給前端的分享網址（`script.js` 的 `buildShareUrl`）與舊連結相容**：解析端 `resolveSsrTarget` 兩種寫法都收，且兩種寫法得到的 canonical 都是 slug 版。短代碼 = `worker/src/branches-seed.js` 陣列位置，跟 `script.js` 的 `BRANCH_SLUG_ORDER` 同一個順序，**這個限制仍然有效：兩邊順序必須一致、只能往後附加，不能插入/調換**（順序一變，舊的短代碼分享網址就會指到別間分店；改完用 `npm run check:branches -- --base=origin/main` 檢查）。我的最愛存的是 slug，不受影響。
- **分店頁專屬 JSON-LD**：`rewriteHtml()` 會把頁面上第一個 `application/ld+json` 換成 `buildBranchJsonLd()` 的輸出（其餘的移除，確保只剩一個）：`@graph` 只有 WebSite（原樣沿用首頁那個節點，要跟 `index.html` 一致）加一個 WebPage（`@id`/`url` 是 slug 版 canonical，`name`/`description` 與 title/meta 共用 `buildBranchMeta()` 同一份來源，`dateModified` 沿用台灣時間的 `scrapedAt`）。輸出時 `<` 跳脫成 `\u003c`（JSON 裡等同 `<`，避免分店名稱含 `</script>` 破壞 HTML）。**刻意只用 WebPage、不輸出 ExerciseGym / LocalBusiness / SportsActivityLocation / Event / Course / ItemList / BreadcrumbList，也不輸出地址、電話、座標、評分**：課表區塊是視覺隱藏的，Google 規定結構化資料要與可見內容相符；而且不能替真實的健身房建立實體。首頁的 WebApplication 節點也不放進分店頁。所有 UA 拿到的 JSON-LD 完全相同；產生失敗就沿用首頁的。
- **動態 `/llms.txt`**：`functions/llms.txt.js`（邏輯在 `functions/_lib/llms.js`）= 根目錄靜態 `llms.txt` 的內容（取自 `env.ASSETS`，文字只有一份）+ `## 分店課表` 索引（`- [名稱 分店（地區）團體課表](slug 網址)`，順序與 sitemap 相同，因為共用 `scheduleBranches.js` 的 `getBranchesWithSchedule()`）。連結文字會跳脫 Markdown 特殊字元（`\`、`[`、`]`），結果用 Cache API 快取 30 分鐘。任何失敗（沒有 D1/ASSETS 綁定、逾時、查無分店、例外）`context.next()` 退回靜態 `llms.txt`，所以**靜態檔要留著當備援**（它不列分店）。**刻意不列出**：任何 API 端點、後台（/admin）、GitHub、Worker 網址、技術架構或爬取機制；更新頻率只寫「每日更新」。**要寫明「非官方」、資料來源與「僅開放台灣地區使用」**（「非官方」與資料來源是使用者 2026-10-27 決定，參考萵苣查查課的做法，讓 AI 引用時立場與來源正確；原本的做法是不加聲明）。所有請求（不分 UA）內容相同。
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

**我的最愛的編輯**：最愛只存在 localStorage `wg_favorites`（`{label, icon, color, state}` 陣列），**沒有 id，用陣列位置辨識**。入口是長按晶片約 0.5 秒（`script.js` 的 `bindFavoriteLongPress`；桌機右鍵、鍵盤 Menu 鍵走 `contextmenu`），短按仍是套用並查詢，所以編輯不能綁在一般點擊上。編輯與新增共用 `#addFavoriteModal`，`favEdit` 是 `null` 就是新增模式，否則是編輯模式（`{target, chip, index, newIndex, total}`，儲存／刪除前用 `target` 的內容在最新的清單裡重新找，多個分頁同時開著時才不會改到別顆）；編輯只改名稱／圖示／顏色／順序，`state`（篩選條件）不動，要改條件就刪了重建。編輯視窗的垃圾桶按了就直接刪，**刻意沒有二次確認**（使用者決定）；資料先寫回 localStorage，被刪的晶片再跑 `.removing` 動畫（`style.css` 的 `fav-remove`，時間要跟 `script.js` 的 `FAV_REMOVE_ANIM_MS` 一致；使用者設了「減少動態效果」就跳過），動畫結束才重畫清單。編輯與刪除只送 GA 事件（`edit_favorite`、`delete_favorite`），**不打 `/trackFavorite`**（後端白名單只收 `add`／`apply`，`favorite_events` 只統計建立與使用）。長按沒有可見提示，靠空狀態文字與**會流動彩虹底色的提示 pill**（`FAV_EDIT_NOTICE`，「長按最愛可以編輯」）補強：有最愛、而且還沒「看過」（localStorage `wg_fav_edit_hint_seen`）就接在所有最愛後面出現。第一次新增最愛的人，從結果頁回到篩選頁就會看到它（新增是從結果頁的愛心來的，當下最愛區塊是隱藏的，所以不在新增當下提示）。「看過」＝pill 完整出現在畫面上連續滿 2 秒（載入遮罩還在、分頁在背景、最愛列被藏起來都不算），滿了才寫記號、下次載入不再出現；點一下則收合並立刻記為看過；真的開過編輯視窗也記為看過。**這是永久的提示**（原本是 2026-11-01 下線的暫時提示，2026-10-29 使用者改成給第一次新增最愛的人用）；`.fav-item` 的 `user-select:none`／`-webkit-touch-callout:none` 是防 iOS 長按選字，別拿掉。**最愛的顏色有四顆限時的彩虹色票**（使用者 2026-10-29 做了兩顆鮮豔彩虹、2026-10-30 又加兩顆奶油彩虹，並決定它們是**限時限量**：只在彩蛋期間 `html.pride`（到 2026-11-02）出現在選色視窗的最後四格，**2026-11-03 起選色視窗換回原本的深綠 `#4f7942`、棕 `#a0714f`、金 `#8c721e`、青 `#207f8a`**）。做法：`index.html` 兩組色票都寫在裡面，原本四顆加 `.pride-replaced`、彩虹四顆加 `.pride-only`，`style.css` 靠 `html.pride` 切換顯示（沒有 JS）。順序（左到右）：奶油彩虹不會動 `cream`、奶油彩虹會流動 `cream-flow`、鮮豔彩虹不會動 `rainbow`、鮮豔彩虹會流動 `rainbow-flow`。**已經存成彩虹的最愛不受影響，這是刻意給使用者的優惠**（使用者 2026-10-30：只要在彩蛋期間內新增最愛、之後沒清除記憶，就永久保有彩虹底色）：過期後晶片照樣是彩虹底色（`FAV_RAINBOW_CLASSES` 與晶片的 `.fav-rainbow*`／`.fav-cream*` 樣式是永久的，不能跟著刪）；只是過期後編輯那顆最愛時，選色視窗裡看不到對應的色票（整組不勾、儲存沿用原值，跟其他對不到色票的舊資料一樣），改選別的顏色就回不去彩虹。藏起來的色票永遠不會被勾選：`checkFavoriteRadio` 只比對看得見的（`isFavoriteRadioShown`，看色票自己的 `display`），對不到就整組不勾，不然編輯完關窗後它仍勾著，新增模式會把新最愛偷偷存成藏起來的顏色。這四個值不是色碼，晶片不設 inline 背景，改加 class：`.fav-cream`／`.fav-cream-flow`（奶油色系，顏色是 `--cream-rainbow-stops`／`--cream-rainbow-cycle`，彩蛋標題共用）、`.fav-rainbow`／`.fav-rainbow-flow`（鮮豔，`--rainbow-stops`／`--rainbow-cycle`，流動的跟提示 pill 共用同一份流動 CSS）。都是 **45° 斜紋**（`135deg` 漸層）：不會動的整條拉滿，流動的位置寫死成一個循環、水平每 90px 重複，平移 90px 無縫接回，**stops 與 cycle 是同一組顏色，改色要一起改**。過期後**可以刪的**只有 `index.html` 的 `.pride-only` 四顆（連同 `.pride-replaced` 這個 class）、`style.css` 的切換規則與 `#favColor-*` 色票樣式。

**結果頁底部按鈕列**（使用者 2026-10-29 決定；以前「加到最愛」在篩選頁最下面的設定卡，現在那張卡整個移除）：由左到右是粉色愛心 `#addFavoriteBtn`、返回、綠色複製鈕 `#copyMenuBtn`。
- **愛心**開 `#addFavoriteModal`（新增模式，邏輯沒變）。這組篩選已經在最愛裡就變灰（`.gray-btn`＋`aria-disabled`，**不是 `disabled`**，才按得下去），按下去只顯示提示「這組篩選已經是最愛了」、不開視窗。比對用 `filterStateKey()`（每組值排序後比，因為老師排序會改 DOM 順序），只比篩選內容、不管名稱／圖示／顏色；`updateFavoriteHeart()` 在 `showResultView()` 與 `renderFavorites()`（任何新增、編輯、刪除之後）呼叫。沒有重複檢查的舊行為已被取代。
- **複製鈕**（綠色、收起時是分享節點圖示 `fa-share-nodes`，展開時變灰色的 ×）點開往上長出三顆**純圖示**按鈕（使用者決定不要文字）：1（靠近手指）`#copyResultsBtn` 複製文字、`fa-copy` 圖示；2 `#shareUrlBtn` 複製連結、`fa-link` 圖示（它就是以前的藍色分享鈕）；3（最外側，2026-11-06 新增）`#downloadImageBtn` 下載圖片、`fa-image` 圖示、橘色 `.orange-btn`（站內原本沒在這排按鈕用過的顏色）。1、2 排序依 GA 數字：複製文字比複製連結常用（2026-10-01～10-28：147 次對 39 次）；3 排在最外側是因為它是比較「重」的動作（要另外載入 JS、產生圖片），猜測使用頻率較低。選項是絕對定位、收起時 `visibility:hidden`；點外面、按 Esc、選了其中一個都會收起，提示掛在主鈕 `#copyMenuBtn` 上。`setCopyMenuOpen()` 在 `showResultView()` 會先收起。GA 事件 `copy_results`、`share_url` 名稱不變（維持跟舊數字可比），另加 `open_copy_menu`、`download_image`。
  - **下載圖片**：`script.js` 的 `loadHtml2Canvas()` 點了才動態載入 `vendor/html2canvas.min.js`（vendor 進來不吃 CDN，跟 `chart.umd.min.js` 同套路；1.4.1 版，未壓縮約 199KB、gzip 後約 45KB，套用 `_headers` 既有的 30 天快取，只有真的點下載才付出這個流量，不跟著首屏載入）。`loadHtml2Canvas()`／`loadChartJs()` 都是共用的 `createVendorScriptLoader(src, checkLoaded, onReady)` 做出來的（兩支 vendor script 延遲載入邏輯原本幾乎一樣、各寫一份，抽成共用函式後 `loadChartJs()` 也一併拿到「載入失敗會清掉快取的 promise、下次呼叫才會重新嘗試」這個修正，不然失敗一次就要整個頁面重新整理才會好；失敗的 `<script>` 節點也會從 DOM 移除，不留孤兒節點）。點擊當下會先 `disabled` 住 `#downloadImageBtn` 與 `#backBtn`（截圖是非同步的，載入/產生圖片這段期間按返回切回篩選頁，會截到錯的畫面），**還會把 `.page` 設成 `pointer-events:none`**（結果列表裡的老師名字、PWA 小鈴鐺都點得到，點了會改動 `.page` 的內容，跟按返回是同一種「中途截到不是使用者點擊當下畫面」的問題，不是只鎖兩顆操作按鈕就夠），並用一次 `setTimeout(...,0)` 讓瀏覽器先畫出轉圈圈再做會卡住主執行緒的 html2canvas 運算。截圖目標是 `#resultArea`（**只有課程列**：2026-11-06 原本是 `.page` 的「標題＋彩色長條＋白卡」整段，2026-11-07 使用者改成只要課程、不要標題與白卡）。四周留白由 `onclone` 給複製出來的 `#resultArea` 加 `DOWNLOAD_IMAGE_PADDING`（15px，border-box，圖片寬度不變）。`scale` 鎖 `Math.min(devicePixelRatio, 2)`：圖片只會用固定手機寬度分享，不需要吃滿高 DPI 螢幕預設的 2～3 倍，不然像素數會暴增好幾倍。`ignoreElements` 排除兩類元素、不是逐一列舉：①`.visually-hidden`（clip:rect() 技巧藏起來的文字，html2canvas 不支援 clip 會露出來，例如頁尾 SEO 文字、標題裡給讀屏器看的全名）；②帶 `data-export-exclude` 屬性的元素（PWA 小鈴鐺 `.bell-icon`、廣告橫幅 `#adBanner`——這是「不想出現在分享圖裡」的產品決策，跟是否隱藏無關）。以後要再排除新東西，照這兩種分類標記即可，不用回來改函式本身（舊版逐一列舉 `.bell-icon`／`#adBanner`／`.site-about` 已經連續補丁 3 次，是重構成這樣的原因）。`backgroundColor` 帶入 `body` 目前的實際背景色（淺色是米色 `--bg`、深色是對應的深色，使用者 2026-11-07 指定用頁面的米色當底），圖片是不透明的。**html2canvas 畫不出模糊的 `box-shadow`**（`.sheet` 的 `0 8px 24px rgba(0,0,0,0.08)` 陰影會被近似成一整排由淺到深的色塊，像鬼影一樣疊在卡片邊緣和每一列中間，使用者 2026-11-06 實測回報過）：用 `onclone` 選項把截圖當下那份複製 DOM 裡**所有** `.sheet`（不是只挑 `#mainFormSheet`，避免以後有別的 `.sheet` 剛好沒被隱藏時重演一次）的陰影拿掉再畫，真正畫面上的卡片陰影完全不受影響。同一個 `onclone` 也把複製 DOM 的 `body.style.minHeight` 設成 `"0"`——`body` 有 `min-height:100vh` 加上 flex 預設的 `align-items:stretch`，會把 `.page` 一起撐到跟模擬視窗一樣高，課程不多時下面會留一大片空白（已實測確認解掉這個之後 `windowHeight` 選項就不再有任何作用，所以乾脆拿掉不傳）。**圖片寬度固定成手機寬度**（`DOWNLOAD_IMAGE_WIDTH = 420`，略窄於 `style.css` 的 `@media (max-width:480px)` 斷點以確保觸發手機版樣式，使用者 2026-11-06 確認：桌機瀏覽器 `.page{max-width:900px}` 會讓截圖變得很寬，不適合直接分享）：用 html2canvas 的 `windowWidth` 選項讓它在內部另外開的複製視窗裡用這個寬度重新排版，不是單純裁切或縮放桌機版的排版；這個選項只影響截圖當下那份複製視窗，不會讓使用者畫面跟著變窄。輸出用 `canvas.toBlob()`＋`URL.createObjectURL()`（不用 `toDataURL()`，課程筆數多、圖片長的話 base64 字串會很肥）。深色模式下卡片與標題顏色不用特別處理，html2canvas 會照實際的 `background-color`／文字顏色畫，本來就會跟著當下主題（使用者 2026-11-06 確認這是刻意的，不要固定淺色）。`onclone` 也把複製 DOM 裡所有 `.teacher-link`（結果列表裡可以點的老師名字，平常是橘色）的顏色改成 `body` 的文字色（`--ink`，跟著目前主題）：下載圖片裡沒有「可以點」這件事，橘色連結提示沒有意義，使用者 2026-11-09 要求改成跟其他文字一樣的顏色。
    - **iOS 下載**（使用者 2026-11-06 回報 iPhone 點下載會轉很久）：先查到 iOS Safari 的 html2canvas 已知問題——document clone 階段會卡住，起因是頁面上任何地方（不限截圖範圍內）有 `loading="lazy"` 的 `<img>`（這裡是通知頁的 QR code）；**（這招放在 `onclone` 是無效的，見下面 2026-11-07 的更正）**同時加 `await document.fonts.ready`（確保 Font Awesome 圖示字型就緒，避免截圖當下才觸發字型載入拖慢速度）與 `imageTimeout: 3000`（html2canvas 預設 15 秒，截圖內容裡沒有真的圖片要等，萬一還是卡住也不要讓使用者等那麼久）。另外，**iOS Safari（含 iPadOS）的 `<a download>` 不會真的觸發存檔**，點了只會開啟圖片或完全沒反應，這是跟效能無關的另一個問題：`isIOS()`（用 `navigator.platform`／`userAgent` 判斷，iPadOS 13 起偽裝成 Mac 要另外用有沒有觸控分辨）為真時，改把產生的圖片顯示在 `#downloadImagePreviewModal`（`<img>`＋「長按圖片即可儲存到相簿」文字），不觸發 `<a download>`；其他瀏覽器維持原本 `appendChild` 進文件再 `click()` 再 `remove()` 的下載流程（部分瀏覽器對沒掛進文件的 `<a>` 觸發 `click()` 不保證會下載）。預覽視窗的 `blob:` URL 要等使用者關窗才 `revokeObjectURL`（不能跟一般下載一樣 1 秒後就收回，長按儲存可能要花一點時間），下載的檔名固定 `WG課表_YYYY-MM-DD.png`（當天台灣日期）。 **2026-11-07 使用者實機回報上面兩招之後 iPhone 仍一直轉**（這台 Mac 沒裝完整 Xcode，沒辦法用 iOS 模擬器重現）：`script.js` 加 `withTimeout()`，載入（10 秒）、截圖（20 秒）、轉檔（10 秒）各自逾時，失敗提示會帶階段名稱（例如「圖片產生失敗（截圖）」）；`document.fonts.ready` 只等 2 秒、等不到就直接截。實機回報卡在「截圖」階段後讀 `vendor/html2canvas.min.js` 查到根因：html2canvas 在 WebKit 上是**先**等複製文件裡每一張圖片載入（`En()`，沒有逾時）、**之後**才呼叫 `onclone`，所以在 `onclone` 改 `loading` 來不及，隱藏區塊裡的 lazy QR code 在 Safari 永遠不載入就永遠卡住。正確做法是截圖前先把**真實頁面**上的 `img[loading="lazy"]` 改成 eager 並等載入（`script.js` 下載鈕 handler 裡）。桌面 Chrome 的 UA 也含 AppleWebKit，但對隱藏的 lazy 圖不會卡，所以桌面測不出這個問題，要實機 iPhone 驗證。iOS Safari 的 canvas 上限約 1677 萬像素，71 列約 543 萬、250 列大約 1900 萬，列數很多時可能超過。
- 能存最愛的前提是進得了結果頁：超過 250 筆（只提示縮小條件）或查無課程（只顯示提示）的組合都不進結果頁、存不了。使用者 2026-10-29 確認這是刻意的：查不到的組合存了也沒用，先看結果再決定要不要加。
- 第一次新增最愛的「長按可編輯」提示掛在愛心鈕上（文字「已加入最愛，回篩選頁長按可編輯」），不能掛在最愛晶片上：新增時 `#favoriteSheet` 是隱藏的，量不到位置，提示會跑到畫面外。
- 空狀態提示 `FAVORITE_EMPTY_HINT` 已改成指向結果頁的愛心；已經有最愛的舊使用者看不到這句，沒另外做一次性提示。

**清除記憶分兩顆按鈕**（通知頁最下面 `#quickLinksSheet` 的「清除記憶」，排在主題切換鈕後面、官網連結前面；2026-10-29 從設定列搬過來，設定卡整張已移除→ `#clearMemoryModal`，`script.js` 的 `FILTER_MEMORY_KEYS`）：「清除篩選記憶」清勾選條件（`wg_selected_*`）、常用排序（`wg_*_clicks`）、分店地區展開狀態（`wg_zone_states`）後重新整理；「清除我的最愛」只清 `wg_favorites` 並重畫最愛列（不重新整理）。兩顆都沒有二次確認（視窗本身就是確認）。**不再整個 `localStorage.clear()`**：`wg_client_id`（清掉會讓同一個人在最愛統計裡變成新使用者）、`wg_remind_minutes`、`wg_theme`（主題偏好）、`wg_fav_edit_hint_seen`、`wg_debug_force_pwa` 都保留。新增「篩選記憶」類的 localStorage key 時要記得加進 `FILTER_MEMORY_KEYS`。GA 事件 `clear_memory` 帶 `memory_type`（`filters`／`favorites`）。

**深色模式**（使用者 2026-10-29 決定）：預設淺色、**不跟隨系統設定**。通知頁最下面（`#quickLinksSheet`）有切換鈕 `#themeToggleBtn`，目前是淺色就顯示「深色模式」（月亮）、目前是深色就顯示「淺色模式」（太陽），位置在「清除記憶」前面。選了深色才在 localStorage 留下 `wg_theme=dark`，換回淺色就清掉 key；它是偏好、不是篩選記憶，清除記憶不會動它。運作方式：
- `theme-init.js`（`index.html` 的 `<head>` 同步載入）開頁時讀 `wg_theme`，在 `<html>` 貼 `data-theme="dark"`，趕在第一次繪製前，才不會先閃白（CSP 不允許 inline script，所以是獨立檔）。切換由 `script.js` 的 `themeToggleBtn` 處理，送 GA 事件 `toggle_theme`（帶 `theme`）。
- `style.css` 最後面的 `html[data-theme="dark"]` 區塊翻轉 CSS 變數、並覆寫寫死的顏色。`--navy` 同時當「底色」與「文字／邊框色」，所以另開 `--navy-ink`（淺色同 navy、深色變亮）給文字與邊框用；`--chart-tip` 是圖表提示框底色。**新增寫死的顏色（hex、rgba）時要回頭看深色長怎樣**；近黑色的底色（最愛可選 `#2b2b2b`）要有外框才看得見。
- 圖表（Chart.js）畫在 canvas、吃不到 CSS：顏色由 `common.js` 的 `chartTheme()` 讀 CSS 變數（有快取），option 用函式（scriptable）傳；切換時 `retintCharts()` 清快取並讓所有圖表重畫，不用重建。**新增圖表時顏色不要寫死 hex**，用 `() => chartTheme().xxx`。
- `#loadingOverlay` 的 inline `<style>` 是 `var(--paper,#fff)`，不能寫回白色，否則深色載入時整頁會先白一下。
- 只有 `index.html` 載入 `theme-init.js`；`admin.html`、`403.html`、`404.html` 一律淺色（沒檢查過它們在深色下的樣子；403 對海外 IP 也載不到這支腳本）。
- 切換有 0.3 秒的顏色淡入淡出：`script.js` 在 `<html>` 暫時加 `theme-switching`（約 0.4 秒後移除），`style.css` 最後用 `!important` 的 transition 讓全站一起過場；不常駐（免得干擾平常的 hover 與條紋動畫），`prefers-reduced-motion` 時不做。圖表是 canvas，換色是瞬間的，不跟著淡入淡出。

**語音搜尋**（使用者 2026-11-09 決定）：通知頁最下面（`#quickLinksSheet`，GitHub 連結後面）有開關 `#voiceSearchToggleBtn`，做法跟 `#themeToggleBtn` 一樣是「自己描述狀態的按鈕」（不是獨立的 switch 元件，這個 codebase 裡沒有這種元件）：選了開才在 localStorage 留下 `wg_voice_search_enabled=1`，關掉清掉 key；它是偏好、不是篩選記憶，清除記憶不會動它。**按鈕文字刻意加上「（測試）」**（使用者 2026-11-09 要求，標示這是還在驗證中的功能），開/關兩種文字與 `aria-label` 都要一起帶這個字樣，改措辭時兩處不要漏改。開啟後，**篩選頁完全沒勾選任何篩選**時（跟 `#resetFiltersBtn` 的灰色條件同一個，由共用的 `hasAnyFilterSelected()` 判斷——故意比查詢鈕自己原本的 `isSearchValid()`〔只看分店/老師〕更嚴格），查詢鈕的圖示會從放大鏡換成麥克風（`.coral-btn`，紅色共用 `style.css` 的 `--coral` 變數，跟縮課日標紅、查詢中轉圈圈同一個紅，不要寫死 hex；**原本是紫色 `.purple-btn`（跟 `#themeToggleBtn` 的 accent 同一色、共用 `--purple` 變數），使用者 2026-11-10 要求改成紅色**，`#themeToggleBtn`／`#voiceSearchToggleBtn` 的 `--accent` 仍是 `--purple`、沒有一起改），點下去用瀏覽器原生 `SpeechRecognition` 語音輸入——**沒有「聽到了沒」的確認畫面**，比對出分店/老師/課程/星期/時段/教室後直接勾選並送出查詢。
- **`voiceRecognitionState` 是單一狀態機**：`"idle"`／`"starting"`（已按下、等瀏覽器權限視窗或 `onstart`）／`"listening"`（真的在收音）／`"processing"`（收到結果、比對中）。一開始是分成 `voiceRecognitionState`（只有 idle/listening）跟 `voiceProcessing` 兩個獨立旗標，測試時發現兩個分開會漏狀態（例如按下麥克風到 `onstart` 之間沒有任何狀態標記、又按一次會開出第二個 session），合併成一個四態的字串後 `micEligible()` 只要看是不是 `"idle"` 就好。`startVoiceSearch()` 一開始（呼叫 `recognition.start()` 之前）就先把狀態設成 `"starting"` 並鎖住按鈕/checkbox，不是等 `onstart` 才鎖，雙重防止權限視窗還沒回應時再點一次開出第二個 session。`setVoiceRecordingLock()` 除了鎖 `#resetFiltersBtn`/`#notifyBtn`，**也會把六組篩選 checkbox 一起 disable**：不然聆聽/比對期間手動勾選，會被語音結果套用時 `applyFilterState()` 的整組取代悄悄蓋掉。
- 聆聽中：查詢鈕維持同一個紅（`--coral`），外圍兩圈脈衝環＋鈕內等化器短條取代麥克風圖示（`.voice-listening`，只在 `prefers-reduced-motion:no-preference` 時才切換成等化器——**減少動態效果的使用者保留靜態的麥克風圖示當回饋**，不然圖示被藏起來、等化器又沒有動畫撐出高度，會變成空的紅色圓圈，這是實作時真的測出來的 bug），`#submitTooltip`（平常是隱藏的 hint-tooltip，原本沒人用）跳出「聆聽中・請說話」。左右兩顆按鈕（`#resetFiltersBtn`／`#notifyBtn`）變淡並真的 `disabled`，比照下載圖片鎖住 `#backBtn` 的做法（`.voice-dimmed`；`#notifyBtn` 平常是 `.orange-btn`，`:disabled` 的顏色優先權較高會蓋掉，CSS 另外用 id 贏回來）。
- 停止聆聽三種方式一起用：`continuous=false` 預設行為（偵測到停頓自動結束）、再點一次查詢鈕提前結束（用 `recognition.stop()` 不是 `abort()`，仍會對已經聽到的內容觸發一次 `onresult`）、10 秒強制逾時（`VOICE_RECOGNITION_TIMEOUT_MS`）。**逾時計時從點下麥克風那一刻就開始算，不是等 `onstart` 才算**：瀏覽器的麥克風權限視窗如果使用者一直不理（不同意也不拒絕），`SpeechRecognition` 既不會觸發 `onstart` 也不會觸發 `onerror`，畫面會卡著看起來沒反應。
- **拿到結果（`onresult`）也要明確收尾收音 session，不能假設 `continuous=false` 會自動停止收音**：使用者實機 iOS 測試回報，查詢成功、畫面（含查詢鈕圖示）都正確切回待機狀態後，手機狀態列的「錄音中」指示燈卻還一直亮著——`handleVoiceTimeout()`／`cancelVoiceSearch()` 都有明確呼叫 `abort()`，只有「成功拿到結果」這條路徑原本沒有、只是被動假設瀏覽器自己會停。**第一版補的是 `stopVoiceSearchManually()`（呼叫 `stop()`，溫和結束）**，使用者接著實測發現：第一次語音查詢狀態列麥克風圖示＋錄音中圓點都正常出現，但查完返回再用第二次，圓點卻不見了（只剩麥克風圖示）——懷疑是 `stop()` 的優雅結束在 iOS 快速連續使用時釋放麥克風不夠即時。**第二版改成呼叫 `abortActiveRecognition()`**（跟 `cancelVoiceSearch()`／`handleVoiceTimeout()` 共用），理由是這個時間點 transcript 已經拿到手、沒有「優雅處理剩餘音訊」的需求——**但使用者實機再測，`stop()`／`abort()` 兩種寫法結果一樣，而且更進一步回報第二次語音查詢「完全沒聽到聲音」**，確定不是單純燈號顯示與否，是真的收音失敗：兩次都在猜「怎麼結束上一個 session」，但真正的根因是「上一個 session 被瀏覽器真正收尾（釋放麥克風資源）之前，下一個 session 就搶著開始」——iOS 快速連續使用時，新的 `SpeechRecognition.start()` 可能在舊的底層音訊資源還沒真的釋放乾淨時就啟動，導致新的這次根本拿不到真正的收音，不管上一個 session 是用 `stop()` 還是 `abort()` 結束都一樣。**第三版在 `startVoiceSearch()` 加一道 `await` 等待**：建立新的 `SpeechRecognition` 前先 `await` 一個「上一個 session 真的被瀏覽器收尾完」的 promise（1500ms 保險逾時），等到了才繼續。這版通過了三個審查（`/code-review`／`/security-review`／`/simplify`，過程中也修了一個審查抓到的競態 bug：收尾用的旗標一開始寫成模組層級共用變數，被下一個 session 覆蓋，後來改成每個 session 各自獨立的閉包狀態）並且已經 commit，**但在 push 之前**，使用者貼了另一個 AI 工具對 `voice-search.js` 的分析，點出一個更根本的問題：**iOS Safari 的 `SpeechRecognition.start()` 必須留在使用者點擊的同步呼叫鏈裡才會真的生效**——`await` 任何 promise（即使是已經 resolved 的）都一定會讓後面的程式碼延到下一個 microtask 才繼續執行，等於讓 `recognition.start()` 離開了原本點擊事件的同步呼叫鏈，iOS 可能因此悄悄判定這次呼叫不再具備「使用者手勢」而讓收音失效——這會讓**每一次**（不只第二次）語音查詢都有收不到音的風險，比原本要修的 bug 還更嚴重。查核後確認原本（這次語音功能最早的版本）`recognition.start()` 前面完全沒有 `await`，這個風險是第三版那個 `await` 自己引入的，不是舊有問題。

**第四版（目前版本）拿掉 `await`，改成同步的旗標 gate**：`recognitionReady`（模組層級布林值，預設 `true`）取代 `recognitionTornDown` promise；`startVoiceSearch()` 開頭第一件事就同步檢查 `if (!recognitionReady)`，**不夠就直接放棄這次點擊**（顯示「請稍候一下再試一次」，不嘗試自動等待、不留計時器），往下所有程式碼（包含最後的 `recognition.start()`）完全沒有任何 `await`／microtask，保證跟使用者的點擊留在同一個同步呼叫鏈裡。等待改成交給「使用者自己再點一次」：下一次點擊本身就是一個新的使用者手勢，到那時候上一個 session 通常已經真的收尾完畢（`recognitionReady` 自然變回 `true`）。`recognitionReady` 只有建立新 session 時設回 `false`、該 session 的 `onend`／`recognition.start()` 丟例外時設回 `true`——因為只有「已經是 `true`」的時候才允許建立下一個 session，不會有「下一個 session 把它蓋掉、上一個 session 的事件又誤讀到新值」這類競態（跟 `settled` 不同，不需要做成每個 session 各自獨立的閉包狀態，這裡只需要一個全站共用的「現在能不能開始新的一次」旗標）。**「這個 session 的使用者可見結果處理過了沒」（`settled`）這個閉包狀態設計不受這次改動影響，繼續沿用**：`onresult`／`onend`／`start()` 例外三個路徑都在 `startVoiceSearch()` 同一個閉包內，直接讀寫區域變數 `settled`；`detachRecognitionHandlers()`／`abortActiveRecognition()`（被 `cancelVoiceSearch()`／`handleVoiceTimeout()`／`onresult` 呼叫）構不到這個區域變數，所以另外掛一份在 `recognition._markSettled`（物件自己的屬性，每個 session 各自獨立），`detachRecognitionHandlers()` 統一呼叫它，同時也去掉了 `abortActiveRecognition()`／`onerror` 兩處各自重複寫一次「設旗標＋`detachRecognitionHandlers()`」的重複。**這次教訓**：之後任何語音搜尋相關的修改，只要會影響到「使用者點擊」與「`recognition.start()`」之間那段程式碼，都要確認中間沒有被插入 `await`／`.then()` 這類會讓出事件迴圈的東西，否則 iOS Safari 可能整個收音功能悄悄失效且不會有任何錯誤訊息。

**第五版（目前版本）`recognitionReady` 加一道 `RECOGNITION_COOLDOWN_MS`（400ms）緩衝**：第四版上線後使用者實機再測仍回報第二次收不到音——截圖顯示 UI 正確進入「聆聽中」（紫色/紅色、脈衝環、`#submitTooltip` 都正常），手機狀態列卻只有麥克風圖示、沒有代表「真的在收音」的橘色圓點，代表 iOS WebKit 的 `onend` 事件觸發，不等於底層音訊硬體真的在同一時間點釋放乾淨——`recognitionReady` 原本在 `onend` 裡立刻同步設回 `true`，可能在硬體還沒真的放掉時就又放行了下一次 `start()`。使用者貼了另一個 AI 工具的分析，點出這個「`onend` 之後硬體還要幾百毫秒緩衝」的理論，但**沒有照搬它建議的寫法**（它的範例是在下次 `start()` 前用 `setTimeout` 延後呼叫，等同引入 `await`／非同步等待，會重蹈第三版的錯——讓 `recognition.start()` 脫離使用者點擊的同步呼叫鏈）；改成把 `setTimeout` 放在 `onend` **這一側**：`recognitionReady` 不再立刻設成 `true`，而是 `setTimeout(() => { recognitionReady = true; }, RECOGNITION_COOLDOWN_MS)`，只延後「門什麼時候重新打開」，不影響任何一次點擊當下的同步性——太快點第二次的使用者會吃到「請稍候一下再試一次」（跟原本放棄點擊的訊息相同，使用者體感只是偶爾要多點一次），緩衝期過後的下一次點擊仍是全新、同步的使用者手勢，不受影響。`recognition.start()` 丟例外那條路徑（根本沒真的建立過 session）維持立即設回 `true`，不需要這個緩衝。400ms 是依使用者回報的現象抓的起始值，沒有精確測試依據，之後如果還有同樣症狀可以再往上調。
- **`#resetFiltersBtn`（清除所有篩選）也會呼叫 `cancelVoiceSearch()`**（使用者要求）：讓「清除篩選」順便把語音搜尋狀態（聆聽中／比對中）整個收乾淨、回到初始，不用另外找地方重設；`cancelVoiceSearch()` 內部本來就會判斷有沒有真的在收音，沒有語音在跑時呼叫也安全。
- **收尾一定要先拔掉 recognition 物件的事件處理器再 `abort()`／`stop()`，共用 `detachRecognitionHandlers()`**：`abort()` 之後瀏覽器仍會非同步觸發 `onerror("aborted")`／`onend`，不拔掉的話這些事後才到的事件會跟呼叫端自己的收尾重複處理——實際出現過的 bug 是使用者講完話收到結果（或手動取消）後，稍晚飄來的 `onend` 又把畫面重置一次、彈出第二次「沒聽到聲音」的矛盾訊息＋多送一次 `voice_search_failed`。`handleVoiceTimeout()`／`cancelVoiceSearch()`／`onerror`（處理完真正的錯誤之後）都會呼叫這個共用函式。
- `onresult` 整段（含切到 `"processing"` 狀態、呼叫 `voice-search.js`）都包在同一個 `try/finally` 裡，`finally` 唯一出口是 `resetVoiceUI()`：這樣任何一步意外丟例外都保證會收尾，不會卡在 `"processing"` 回不去（這也是為什麼不再用獨立的 `voiceProcessing` 旗標——獨立旗標時曾經發生過前面提早 return、旗標沒機會重設成 false 的情況）。切換開關關閉時（`if (!voiceSearchEnabled && voiceRecognitionState !== "idle")`，不是只看 `"listening"`）會呼叫 `cancelVoiceSearch()`；但 `onresult` 已經在比對/送出中（`activeRecognition` 已經清空、沒有 recognition 物件可以 `abort()`）時，光靠這個檢查攔不住已經在跑的 `applyTranscript()`，所以 `voice-search.js` 的 `applyTranscript()` 自己也會在真正送出前重新檢查一次 `voiceSearchEnabled`（script.js 的全域），使用者在比對期間把開關關掉就回傳 `"cancelled"`（不套用、不送出、也不用再顯示任何訊息），不是跟 `"no-match"` 共用。
- 比對引擎在另外延遲載入的 `voice-search.js`（只在第一次點麥克風時才載入，不計入一般頁面載入體積，沿用 `createVendorScriptLoader` 的做法）：純字串比對（依詞彙長度排序、長詞優先佔字元），不是 AI/LLM；分店/課程/老師詞彙直接讀現場 DOM（分店寫死在 `index.html`、課程老師等 `filterOptionsSettledPromise` resolve 才讀），星期/時段/教室重用 `WEEKDAY_LABEL`/`TIME_OPTIONS`/`ROOM_URL_CODE` 既有常數，另外一份口語別名表（「早上」「晚上」「團課」「瑜珈」之類）。**`WEEKDAY_LABEL` 的「一」~「日」裸數字刻意不收進比對詞彙**（`voice-search.js` 的 `dayBaseTerms()` 只取 `today`/`tomorrow`）：單獨一個字太容易在任何句子裡剛好出現造成誤判（例如隨口一句「一下」的「一」會被誤判成星期一），星期幾一律只靠 `DAY_ALIASES` 有字首的形式（「星期一」「週一」「周一」「禮拜一」）比對，這是實作時真的測出來的 bug，不是預防性假設。比對完只呼叫 `window.applyVoiceFilters(state)`／`window.submitVoiceSearch(state)`（script.js 開的出口，分別對應「套用但不送出」跟「套用並直接呼叫共用的 `performSearch()`」），不直接呼叫 `applyFilterState`／`runSearchAndShowResults`，這樣才會經過既有的查詢中轉圈圈、連續查詢提醒 modal、`trigger_source` 記錄等既有邏輯。**沒有分店或老師**（跟 `isSearchValid()` 同一條規則）時只套用聽懂的部分、不送出；**完全沒聽懂任何類別**時什麼都不碰，只顯示提示。
- **`performSearch(triggerSource)`：手動按查詢鈕、套用最愛、語音都呼叫同一個共用函式，用明確參數傳 triggerSource，不透過 `requestSubmit()` 重新進入 `filterForm` 的 `submit` 監聽器**。原本語音是送 `pendingVoiceSubmit` 旗標、讓監聽器重入時知道這次是語音觸發，但套用「我的最愛」（`applyFavorite()`）早就用同一招（`searchTriggerSource = "favorite"` 再 `requestSubmit()`），而監聽器重入時固定的第一行 `searchTriggerSource = "manual"` 會把它蓋掉——**這是一個比這次語音功能更早就存在的 bug：套用最愛時 GA 的 `search_schedule` 事件 `trigger_source` 其實從來沒有真的記成過 `"favorite"`，一直是 `"manual"`，連帶 `if (searchTriggerSource !== "favorite")` 那個應該跳過最愛的 `logSearchEvents()` 也一直多送了一次**。原本想過改用 `e.isTrusted`（程式呼叫 `requestSubmit()` 應該是 `false`、真人點擊是 `true`）分辨，**但實測發現 `requestSubmit()` 觸發的 `submit` 事件 `isTrusted` 也是 `true`**（瀏覽器原生 API 呼叫、不是手刻的 `Event` 物件）分不出來，所以改成直接呼叫共用函式、徹底不靠 `requestSubmit()` 重入——`pendingVoiceSubmit` 這個旗標已經整個拿掉。結果頁點老師名字（`teacher_link`）也改成呼叫 `performSearch("teacher_link")`（原本是直接呼叫 `runSearchAndShowResults()`、繞過連續查詢提醒 modal 的保護，`/simplify` 抓到這個落差後補上；`#backBtn` 轉圈圈的客製 UI 不受影響，只是包在 `performSearch()` 外面）。`shared_url`（`init()` 裡、頁面載入時最多觸發一次）還是直接呼叫 `runSearchAndShowResults()`，沒有這個重複呼叫的風險，沒有改動。
- **`_headers` 的 `Permissions-Policy` 原本是 `microphone=()`**——空白名單會連頁面自己的 JS 都擋掉，`SpeechRecognition` 根本起不來、瀏覽器連原生權限請求都不會跳：已經改成 `microphone=(self)`，跟既有的 `geolocation=(self)` 同一個寫法。這是最容易漏掉、沒漏掉也看不出哪裡錯的一種 bug，跟下載圖片功能當初漏掉 CSP `img-src blob:` 是同一類教訓。**`microphone=(self)` 只在首頁生效**：`/admin.html`、`/403`、`/404` 完全沒有語音搜尋的程式碼，依最小權限原則用 `! Permissions-Policy` 先把從 `/*` 繼承來的值拔掉、重新設回 `microphone=()`（見「安全標頭與 CSP」）。
- **麥克風權限被拒絕後查詢鈕要變回原本的灰色，不能一直停在紫色**：`micEligible()` 看 `voiceMicPermission`——單一狀態值（`"unknown"`／`"prompt"`／`"granted"`／`"denied"`），不是兩個各自要注意先後順序的旗標（原本拆成 `voicePermissionDenied` ＋ `voicePermissionApiActive` 兩個布林值，`/simplify` 合併成一個，寫法可以參考既有的 `requestGeoFilter()` 定位權限查詢，同一種「一個狀態值，誰是權威來源誰覆寫」的做法）。支援 Permissions API 的瀏覽器（`navigator.permissions.query({name:"microphone"})`，且瀏覽器本身支援 `SpeechRecognition` 才查，省掉用不到這個功能的瀏覽器也要查一次）用真正的權限狀態直接覆寫這個值，連使用者事後跑去瀏覽器設定重新允許都會透過 `status.onchange` 自動反映，不用重新整理頁面；**只有這個值還是 `"unknown"`（代表查不到 Permissions API）時，`onerror` 收到 `not-allowed`/`service-not-allowed` 才會退回去把它設成 `"denied"`**——使用者很可能只是把瀏覽器原生的麥克風權限視窗按掉而已，並沒有真的「封鎖」，這種情況下真正的權限狀態通常還是 `"prompt"`，`onchange` 永遠不會觸發，若已經查得到真正狀態時 `onerror` 還自己亂設就會卡住回不去；只有查不到 Permissions API 的瀏覽器（例如較舊的 Safari）才會真的走到這個 fallback，只能重新整理頁面復原。
- **開關按鈕文字帶目前 `script.js` 的版號**（`SCRIPT_VERSION_LABEL`，使用者要求，方便確認 push 後自動部署的新版本是否已經生效）：直接讀 `document.currentScript.src` 解析 `?v=` 的值，不是另外手寫一個常數——這樣版號一定跟實際載入的檔案一致，不會有「忘記同步」的風險。**`document.currentScript` 只在 `<script>` 標籤最初同步執行的那段程式碼裡有效**，一旦進到任何 callback／`await` 之後就會變成 `null`，所以這個常數必須在檔案最上層同步執行的時候就算出來（放在 `renderVoiceSearchToggle()` 定義之前即可，不用是整個檔案第一行），不能延後到按鈕點擊或其他非同步流程裡才讀。
- **聖誕樹／投票日印章兩個彩蛋優先權更高**：`xmasActive`／`voteActive` 其中之一為真時，`micEligible()` 直接回傳 false，麥克風這幾天完全不出現（開關本身不受影響，彩蛋結束後自動恢復），避免跟這兩個彩蛋搶同一顆按鈕的圖示/`::before`。
- **`createVendorScriptLoader()` 的 `onload` 不能直接當成「載入成功」**：`<script>` 的 `load` 事件在腳本中途拋出例外時一樣會觸發（只有真的網路載入失敗才會走 `onerror`），所以現在 `onload` 裡會再檢查一次 `checkLoaded()`，沒通過就當失敗處理（清掉快取的 promise、下次呼叫才會重新注入 `<script>`）；原本沒有這層檢查的話，`voice-search.js`（或 `vendor/chart.umd.min.js`／`vendor/html2canvas.min.js`）如果哪天改壞、在設定好 `checkLoaded()` 要看的全域變數之前就丟例外，這個 promise 會被誤判成功、永久快取住，之後永遠不會再重試。

**彩蛋：同志遊行彩虹標題與紙片**（使用者 2026-10-30 決定，只到 2026-11-02）：標題「課表查詢」改成奶油色系的漸層彩虹——`script.js` 載入時在 `<html>` 加 `pride`，`style.css` 的 `html.pride .hero h1` 用 `background-clip:text` 畫漸層（`filter:drop-shadow` 補淡色字的對比；字的填色是透明的，不能用 `text-shadow`），過期就不加、回到原本的珊瑚＋深藍。紙片部分：`script.js` 的 `startPrideConfetti()` 在 `init()` 收掉載入遮罩後啟動，用 canvas 持續飄下約 45 片（手機約 22 片）奶油色系的彩虹粗短紙片（`PRIDE_CONFETTI_COLORS`；使用者不要長條與波浪彩帶、不要鮮豔色，也不要太多）。`PRIDE_END_DATE` 是不含當天的結束日（`2026-11-03`），用台灣日期判斷、過期自動不再出現；使用者開了「減少動態效果」也不飄；`.pride-confetti` 點擊穿透、z-index 900（蓋過底部按鈕列、在彈窗之下）。**過期後這整段（`script.js` 的 `PRIDE_*`／`prideActive`／`startPrideConfetti`、`init()` 裡的呼叫、`style.css` 的 `.pride-confetti` 與 `html.pride`；最愛選色視窗的限時色票見「我的最愛的編輯」那段）可以刪**，沒刪也不會再執行；明年要用就改結束日。

**彩蛋：聖誕節**（使用者 2026-11-04 決定，**兩段日期不同**）：**下雪 2026-12-01 ~ 12-31**（`script.js` 的 `SNOW_START_DATE`／`SNOW_END_DATE`，`2027-01-01` 不含當天）；**其餘聖誕彩蛋 2026-12-21 ~ 12-26**（`XMAS_START_DATE`／`XMAS_END_DATE`，`2026-12-27` 不含當天）。都用台灣日期判斷、過期自動不再出現；網址加 `?xmas=1` 可在期間外預覽全部（含下雪），加 `?snow=1` 只預覽下雪。聖誕彩蛋期間載入時在 `<html>` 加 `xmas`（載入遮罩還蓋著，看不到換樣子的瞬間）。下面五項裡「下雪」跟隨下雪的日期，其餘四項跟隨聖誕彩蛋的日期：
- **下雪**：`startSnow()` 在 `init()` 收掉載入遮罩後（跟紙片彩蛋同一處）啟動，**只在期間內才動態載入** `vendor/pure-snow.js`／`vendor/pure-snow.css`（使用者提供的 jptip 專案的 pure-snow，本站改過，改了什麼寫在兩個檔案的檔頭註解：不自動執行、不監聽 resize、雪花不要太淡太小、淺色主題用淡藍色雪花〔白色在米白底看不見〕、不用 drop-shadow 濾鏡）。數量用 `#snow` 的 `data-count` 控制：桌機 `SNOW_COUNT_DESKTOP`（60）、手機 `SNOW_COUNT_MOBILE`（30），雪花實際片數是 count − 1；開了「減少動態效果」就不下；`#snow` 點擊穿透、z-index 900。檔案放在 `vendor/`，沿用 `/vendor/*` 的 30 天快取，所以**改了內容要把 `script.js` 裡的 `?v=` 加一**（`check:versions` 已涵蓋 `link.href`）。
- **查詢鈕**（`#scheduleSubmitBtn`）的放大鏡換成樹（`fa-tree`，免費版有）：圖示 class 集中在 `computeSubmitIconClass()` 這個單一決定點（聖誕期間優先回傳樹，見「語音搜尋」一段），查詢中的轉圈圈結束後也回到它，不要直接寫死放大鏡或在別處另開一條判斷。
- **分頁標題**的 💪 換成 🎄（只留一個 emoji；分店頁標題沒有 💪，就在前面補 🎄）。靜態 HTML 的 `<title>` 不變，爬蟲看到的不受影響。
- **標題「課表查詢」**改紅綠相間的 45° 斜紋（只有紅綠兩色、每條寬 14px，使用者先試 10px 後要求更粗，不要漸層）：`style.css` 的 `html.xmas .hero h1`，做法同同志遊行的標題。
- **最愛的顏色多一顆限時色票「紅綠斜紋」**（`xmas-stripe`，晶片加 `.fav-xmas-stripe`，不會動、45° 糖果斜紋，顏色是 `--xmas-stripe`）：只在期間內放在**第一格**，並把最後一格的青色 `#207f8a` 藏起來（維持 14 顆；使用者 2026-11-04 要求放第一個）（`index.html` 的 `.xmas-only`／`.xmas-replaced`，`html.xmas` 切換，沒有 JS），期間後換回青色。使用者看過四顆（漸層、斜紋、流動斜紋、金色）後決定只留這一顆。規則同彩虹色票：**已存成紅綠斜紋的最愛不受影響**，晶片樣式與 `FAV_RAINBOW_CLASSES` 永久保留，過期後只是選色視窗選不到（編輯時整組不勾、儲存沿用原值）。

**彩蛋：投票日（2026-11-28 縣市長選舉，只有當天）**（使用者 2026-11-06 決定）：`script.js` 的 `VOTE_START_DATE`／`VOTE_END_DATE`（`2026-11-29` 不含當天），台灣日期判斷、過期自動消失；網址加 `?vote=1` 可在期間外預覽。期間內在 `<html>` 加 `vote`，**查詢鈕整顆變成「圈選印章」**（維基百科「圈選印章」的樣子：白底、珊瑚色粗圓環貼齊按鈕邊緣、一條貫穿圓心的直線加一條從圓心往左下的斜線）。畫面全由 `style.css` 的 `html.vote #scheduleSubmitBtn` 處理，**JS 的圖示邏輯一行都沒改**：`<i>` 用 CSS 藏起來，印章畫在 `::before`（`mask` 加 `background:currentColor`，所以未選條件時自動變灰、深色模式有專門的灰；比按鈕大 2px 往外溢出再被 `overflow:hidden` 切掉，圓環才不會留白邊）；查詢中（`.busy`）不套用，轉圈圈照舊顯示在珊瑚色底。按鈕的 `aria-label`「查詢課表」不變。使用者逐步調整出來的：先試「卜」字（不像）→ 看圖片搜尋找到真正的印章形狀 → 改白底珊瑚線條 → 嫌太小，要整顆按鈕就是一個章。**政治中立**：只用珊瑚與白，不用任何政黨色，不放候選人、政黨、民調；分頁標題與提醒橫幅這次沒做。過期後 `script.js` 的 `VOTE_*`／`voteActive` 與 `style.css` 的 `html.vote` 規則可以整段刪；明年（或下次選舉）要用就改日期。

過期後可以刪的：`startSnow`／`SNOW_*`／`XMAS_*`／`xmasActive`、`vendor/pure-snow.*`、`html.xmas` 標題規則、`.xmas-only`／`.xmas-replaced` 與 `#favColor-xmas-stripe` 色票；**晶片的 `.fav-xmas-stripe` 與 `--xmas-stripe` 要留**。明年要用就改日期。

網站沒有帳號系統，「幾個人」的統計靠前端 `localStorage` 存的匿名 `wg_client_id`（`crypto.randomUUID()`），後端用 `COUNT(DISTINCT clientId)` 估算，不對應真實身分。

### 靜態資源快取
**CSS、JS、icon 一律走 `_headers` 快取 30 天（`max-age=2592000`，不加 `immutable`，所以按重新整理仍會向伺服器確認）**：`style.css`、`script.js`、`common.js`、`admin.js`、`ga-init.js`、`theme-init.js`、`css-async.js`、`voice-search.js`、`vendor/*`、`icons/*`、`favicon.ico`。這套做法的前提是**所有引用處都帶 `?v=` 版號**，而且**內容改了就一定要把引用它的地方的版號加一**，否則使用者最久一個月看到舊的——改 JS／CSS／icon 時別忘了：
- `style.css`：`index.html`、`admin.html`、`403.html`、`404.html` 四頁**要用同一個版號**（目前 139；以前三頁各自為政變成 104／73／45，後台和 404 頁會吃到舊樣式）。
- `script.js`（只有 `index.html`）、`admin.js`（只有 `admin.html`）、`common.js`（兩頁都引用，都要排在自己的 script 之前，改了要兩個檔案裡的 `common.js?v=` 一起更新）。
- `ga-init.js`、`theme-init.js`、`css-async.js`、`vendor/chart.umd.min.js`（`admin.html`，以及 `script.js` 的 `loadChartJs()`）、`vendor/html2canvas.min.js`（`script.js` 的 `loadHtml2Canvas()`）：目前 `?v=1`（`ga-init.js` 是 `?v=2`）。`voice-search.js`（`script.js` 的 `loadVoiceSearch()`）目前 `?v=4`。改了這些檔案就把版號往上加——**`check:versions` 現在抓得到這三個延遲載入的 vendor／首次使用才載入的檔案**：它們原本是靠 `createVendorScriptLoader(url, ...)` 傳字面字串當參數載入，不是 `script.src = "..."`／`link.href = "..."` 賦值，腳本原本抓不到版號改了沒（`worker/scripts/check-versions.mjs` 的 `SOURCES` 已經補上 `createVendorScriptLoader\(` 這個分支，兩種寫法都認得）。
- `icons/*`：`index.html`（`og:image`、`twitter:image`、`apple-touch-icon`、QR code）、`manifest.json`、`sw.js`（通知圖示）都帶 `?v=1`，換圖就一起加。
- 改完跑 `cd worker && npm run check:versions -- --base=origin/main`，它會抓「引用沒帶版號、各處版號不一致、內容改了版號沒加」。
- 例外：`sw.js` 不長快取（Service Worker 本身要能隨時更新）；`favicon.ico` 是瀏覽器自己隱含請求的，沒辦法帶版號（換 favicon 最久一個月才會更新）；HTML、`manifest.json` 沒設，每次都會向伺服器確認。Font Awesome 圖示直接吃 cdnjs 的完整套件，`fa-` class 可以照官方圖示庫直接用。

### 安全標頭與 CSP（`_headers` 的 `/*`）
所有頁面都帶 `Content-Security-Policy`、`X-Frame-Options: DENY`（後台不能被嵌入）、`Strict-Transport-Security`、`Permissions-Policy`（`geolocation=(self)` 給分店依距離篩選用；`microphone=(self)` 給語音搜尋用，只在首頁生效——`/admin.html`、`/403`、`/404` 另外用 `! Permissions-Policy` 把從 `/*` 繼承來的值整個拔掉、重新設回 `microphone=()`，因為這三頁完全沒有語音搜尋的程式碼，依最小權限原則收回來。**Cloudflare Pages 的 `_headers`是「所有符合的規則一起套用、同一個標頭重複出現會用逗號接起來」，不是比較精確的路徑會蓋掉籠統的路徑**，所以不能只加一個更窄的路徑區塊就以為會贏過 `/*`，一定要搭配 `!` 才有效，見「語音搜尋」一段）等標頭。CSP 的重點：
- **`script-src` 不含 `'unsafe-inline'`**：頁面裡不能再寫 inline `<script>` 或 `onclick=`/`onload=` 這類 inline 事件處理（會被擋、而且是靜默失效）。需要時放成外部檔（現有 `ga-init.js` 是 GA4 初始化，只有 `index.html` 載入，且必須同步載入；`theme-init.js` 是主題初始化，同樣只有 `index.html` 載入、必須同步載入；`css-async.js` 非阻塞載入 Font Awesome CSS，`index.html`/`admin.html` 都載入）。`type="application/ld+json"` 不是可執行腳本，不受影響。
- `style-src` 保留 `'unsafe-inline'`（HTML 裡有大量 `style=` 屬性）。
- **新增任何外部來源（CDN、字型、分析服務、新的 API 網域）都要同步改 CSP**，否則在正式站被擋、本機看不出差別以外的問題；改完用本機 hosting 開發伺服器（會套用 `_headers`）載入頁面，看主控台有沒有 `violates the following Content Security Policy`。萬用字元 `*.example.com` **不包含** `example.com` 本身，要另外列（GA4 的 `analytics.google.com` 就是這樣漏掉過）。
- GA4 會打 `www.google.com.tw` 的受眾像素，所以 `img-src`/`connect-src` 有列這個在地化網域；站台只開放台灣 IP，不必列其他國家網域。
- `img-src` 另外加了 `blob:`：下載圖片功能在 iOS 會把產生的圖片以 `blob:` URL 顯示在預覽視窗（見「結果頁底部按鈕列」的「iOS 下載」），沒有這個會被 CSP 擋掉、圖片顯示不出來（本機測試看得出來，`console` 會印 `violates the following Content Security Policy`）。
- 本機（localhost）載入時 Cloudflare Web Analytics beacon 會出現 CORS 錯誤，是因為 localhost 不是它登記的網域，跟 CSP 無關，可忽略。

### 後台登入
密碼是 `MANUAL_SCRAPE_TOKEN`；登入成功換發 7 天效期、簽章的 session token（存 `localStorage`，用 `X-Admin-Token` header 帶），只有 `/verifyAdminToken` 收原始密碼，其餘後台端點只認 session token。**登入失敗鎖定**：同一 IP 連續輸錯 5 次鎖 15 分鐘（KV key `admin-fail:<IP>`，TTL 到期自動解除），鎖定期間連正確密碼也會被拒（回 423、畫面顯示「嘗試次數過多，已暫時鎖定」）；要排查可用 `wrangler kv key get "admin-fail:<IP>" --namespace-id <QUERY_RATE_LIMIT 的 id> --remote` 看計數，不要為了「測試登入」刻意輸錯。session 簽章金鑰見下面的 `ADMIN_SESSION_SECRET`。`admin.html` 的登入框（`#adminLoginOverlay`）與登入頁的返回鈕在 HTML 裡預設 `hidden`，只有 `admin.js` 的 `initAuth()` 判斷需要登入才顯示——已登入的人開後台要等 `/verifyAdminToken` 回應，預設顯示的話會先閃一下登入框再消失。驗證超過 `LOGIN_REVEAL_AFTER_MS`（3 秒）還沒回應，就先亮出登入框（不然網路慢時是一片空白、無法登入），之後驗證成功仍會自動換成後台；`showLoginOverlay()` 要先關掉轉場再 `focus()`（從 hidden 轉出來的起點仍算 hidden，直接 focus 會失敗），已經顯示時再呼叫是 no-op（不會清掉使用者打到一半的密碼），`adminEntered` 讓遲到的驗證結果不會蓋掉等待期間手動登入的人。**只有 `/verifyAdminToken` 明確回 401／403（`verifyToken()` 的 `{ invalid: true }`）才清掉存在 `localStorage` 的 session**；423 被鎖定、網路錯誤、逾時、5xx 都保留它（session 可能還有效，鎖定解除或網路恢復後重開就能自動登入，不用重新輸入密碼），不要改回「任何失敗都清掉」。

## Secrets

`worker/.dev.vars`（gitignore，不進版控）本機開發用，需要 `MANUAL_SCRAPE_TOKEN` / `QUERY_TOKEN_SECRET` / `VAPID_PRIVATE_KEY`，`TEAMS_WEBHOOK_URL` 與 `ADMIN_SESSION_SECRET` 選填。正式環境五個 secret 都用 `npx wrangler secret put <名稱>` 設定（`MANUAL_SCRAPE_TOKEN`、`QUERY_TOKEN_SECRET`、`VAPID_PRIVATE_KEY`、`ADMIN_SESSION_SECRET`、`TEAMS_WEBHOOK_URL`；`QUERY_TOKEN_SECRET` 沒設會讓 `/queryClasses` 變 500；`TEAMS_WEBHOOK_URL` 沒設則留言端點回 503、月度掃描靜默略過）。secret 是 Worker 的執行期設定，Git 自動部署不會洗掉它們；wrangler 讀不出 secret 的值，只能覆寫。

`ADMIN_SESSION_SECRET`（選填但建議設，至少 32 字元的隨機字串，`npx wrangler secret put ADMIN_SESSION_SECRET`）：後台 session token 的簽章金鑰。沒設或少於 32 字元就退回舊做法——從 `MANUAL_SCRAPE_TOKEN` 做無鹽 SHA-256 衍生，session token 一旦外洩，攻擊者能離線猜登入密碼；設了獨立金鑰就沒有這個問題。**設定或更換它會讓目前所有後台登入失效**（要重新輸入密碼一次），因為兩種金鑰簽出來的 token 不通用。
