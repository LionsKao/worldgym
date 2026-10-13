# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 語言

回覆一律使用繁體中文。

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
Both dev servers are also registered in `.claude/launch.json` (`worldgym-hosting`, `worldgym-worker`) for use with the preview/browser tools. 兩個都直接用 `node` 啟動（不經 bash/npm），Mac 與 Windows 通用，前提是 `hosting/`、`worker/` 都跑過 `npm install`。`hosting/dev.mjs` 把 wrangler 狀態存在 `os.tmpdir()` 底下：`hosting/wrangler.jsonc` 的 `assets.directory` 是 `..`（整個 repo），狀態若放在 repo 內（預設的 `.wrangler/state`）會被當成資源異動而無限重新載入。

### Deploy

**靜態站（Cloudflare Pages `worldgym`，https://worldgym.pages.dev）：push 到 `main` 就會自動部署。** 這個 Pages 專案連了 GitHub（`LionsKao/worldgym`），生產分支是 `main`、自動部署開著，Cloudflare 會從 Git 抓該 commit 的內容、在 repo 根目錄建置（沒有 build 指令，`functions/` 會一起打包）。所以：
- 發布的是**已 push 的 commit**，不是你電腦上的工作目錄，不會夾帶未 commit 的檔案。
- 沒 push 的 commit 在 Dashboard 按「Retry deployment」會失敗（`not our ref`），因為 Cloudflare 抓不到。
- Pages 的 D1 綁定（`DB`）設在 Dashboard 的 Production 環境，要改綁定需重新部署才生效。

**Worker API（`worldgym-api`）沒有接 Git 自動部署，改了 `worker/` 要手動部署：**
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
分店資料散在 `worker/src/branches-seed.js`（唯一來源）、`script.js` 的 `BRANCH_SLUG_ORDER`、`index.html` 寫死的分店 pill（含縣市、顯示名稱、經緯度）與備援用的靜態 `sitemap.xml`，沒有 build step 能自動同步。這支腳本只讀檔，檢查四處是否對得上；**加上 `--base=<git ref>` 才會驗證 seed 的順序「只能往後附加」**——三處同步插到中間時，光比對三處是看不出來的，但舊的短代碼分享網址會指到別間分店。有錯誤 exit code 為 1。

There is no test suite and no lint/build command in this repo（只有上面這支檢查腳本）。

### 部署注意
`hosting/wrangler.jsonc` 是另一套 Workers Assets 設定，`name: "worldgym-web"`，曾經對應過一個叫 `worldgym-web.lions2100.workers.dev` 的 Worker，但那個 Worker 已刪除——它跟 `worldgym.pages.dev` 是互相獨立、不互相依賴的兩個部署目標，且沒有 `functions/_middleware.js` 的台灣 IP 限制。不要再用 `npx wrangler deploy` 部署到它。

**Pages 會把整個 repo 根目錄當成靜態資源發布，而且不會套用 `.assetsignore`**（那是 Workers Assets 的機制，Pages 沒有這個功能）。所以 `worker/`、`hosting/`、`docs/`、`*.md`、`.claude/`、`.gitignore` 這類不屬於網站的檔案，是靠 `functions/_middleware.js` 的 `isBlockedPath()` 一律回 404 擋掉（路徑先 decode 再比對，擋百分比編碼繞過）。新增不該公開的資料夾或檔案類型時，要記得加進 `BLOCKED_TOP_DIRS`。手動部署時，`worker/.dev.vars` 這類密鑰檔也會被上傳（雖然讀不到），部署前仍要確認它不在工作目錄裡。

## Architecture

```
index.html / script.js / style.css   前端：課表查詢頁 + 首頁廣告輪播 + 首頁公開排行報表
common.js                            前台與後台共用的前端工具：escapeHtml、自製下拉選單、月份計算、折線圖工廠、下拉重新整理
manifest.json / sw.js / icons/       PWA + Service Worker（推播提醒用）
admin.html / admin.js                後台：手動重抓、爬蟲紀錄、報表（Chart.js）
vendor/chart.umd.min.js              Chart.js，vendor 進來不吃 CDN
functions/_middleware.js             Cloudflare Pages Functions：只放行台灣 IP（爬蟲 UA 例外）、擋掉非網站檔案（worker/、*.md、點開頭檔案等）回 404
functions/index.js                  Pages Function：單一分店網址在伺服器端注入課表（見下方「伺服器端注入課表」）
functions/sitemap.xml.js            動態 /sitemap.xml（備援：根目錄靜態 sitemap.xml）
functions/llms.txt.js               動態 /llms.txt（備援：根目錄靜態 llms.txt）
functions/_lib/                     注入設定與 SITE_ORIGIN（ssrConfig.js）、實作（ssrBranch.js）、slug 網址（branchUrl.js）、
                                    分店查找表（branches.js）、D1 逾時與 Cache API 共用流程（util.js）、
                                    有課表的分店清單（scheduleBranches.js，sitemap 與 llms.txt 共用）、sitemap.js、llms.js
_headers                             靜態資源快取設定
hosting/                             Workers Assets 靜態託管設定（wrangler.jsonc）
worker/
  src/index.js                      路由表 ROUTES（限流、後台驗證統一處理）/ CORS / 入口 / cron scheduled()
  src/crawlers.js                   海外 IP 存取判斷：爬蟲 UA 清單（Pages 的 _middleware.js 也 import 這份）+ 只放行的唯讀路徑
  src/util.js                       共用小工具：台灣時間（nowTaiwanIso 等）、fnv1aHex、爬官網的 UA、推 Teams；functions/ 也會 import
  src/queryClasses.js               課表查詢邏輯
  src/scrape.js                     爬蟲邏輯（重抓官網課表寫入 D1）
  src/reminders.js                  課前推播提醒：登記/取消/到期發送 Web Push
  src/branches-seed.js              分店清單固定資料
  scripts/check-branches.mjs        分店清單一致性檢查（npm run check:branches，見 Commands）
  schema.sql                        D1 完整 schema（重建資料庫用，會 DROP 所有表）
  migrations/                       針對既有正式資料庫的單張 table migration
```

前端呼叫 `worker` 的 API（`/queryClasses` 等），API 讀寫 D1（`worldgym-schedule`）。`worker/wrangler.toml` 的 `[triggers]` cron：`*/5 * * * *` 每 5 分鐘掃描課前推播是否到期；`0 19 * * *`、`0 9 * * *`（台灣時間 03:00/17:00）各自動重抓一次全部分店（需要 Workers Paid，單次執行 subrequest 上限拉到 1000 才跑得完 104 家分店）。也可以透過 `admin.html` 手動觸發重抓。

### D1 資料表（完整定義見 worker/schema.sql）

| Table | 用途 |
| --- | --- |
| `classes` | 爬蟲抓下來的課表 |
| `branches` | 分店清單（slug、名稱、地區） |
| `meta_filter_options` | 篩選用課程/老師名稱清單快取 |
| `reminders` | 課前推播提醒登記與發送狀態 |
| `ads` | 首頁廣告輪播內容與上下架時間 |
| `ad_events` | 廣告曝光/點擊打點 |
| `teacher_search_events` / `course_search_events` / `branch_search_events` | 老師/課程/分店查詢次數打點 |
| `search_events` | 整體查詢次數與結果數打點 |
| `favorite_events` | 「我的最愛」建立/使用打點，用匿名 clientId 去重估算人數 |

**時間戳一律用台灣時間（`+08:00`），不是 UTC**：`createdAt`/`updatedAt`/`scrapedAt`/`ads.startAt`/`ads.endAt` 都是位移 8 小時再貼 `+08:00` 後綴的 ISO 字串，才能跟其他時間戳直接用字串比較/排序。一律用 `worker/src/util.js` 的 `nowTaiwanIso()`（要往前/往後推用 `taiwanIso(offsetMs)`，要台灣年月日時分用 `taiwanClock()` 再讀 `getUTC*()`，台灣今天的日期用 `todayIsoTaipei()`），不要在各檔案自己寫 `Date.now() + 8 * 3600 * 1000`，也不要混用 `new Date().toISOString()`（那是 UTC）。

**爬蟲寫入 `classes` 的方式（`worker/src/scrape.js` 的 `replaceBranchClasses`）：先 upsert 這間分店這一輪的全部列、最後在最後一批裡清掉「這間分店 `scrapedAt` 比這一輪舊」的列**，不是先整間 DELETE 再分批重寫。那樣寫入的這幾百毫秒到幾秒，這間分店是空的或只有一部分，剛好有人查詢、或 sitemap/SSR 在這時重建並快取 30 分鐘就會看到殘缺資料；寫到一半失敗更會留下殘缺資料。現在任何時刻看到的至少是舊資料（換了老師的課短暫有兩筆），中途失敗舊資料原封不動、下一輪再清。因此**同一間分店同一輪的所有列共用同一個 `scrapedAt`**（它是新舊資料的分水嶺），改這段時不要改回逐列 `nowTaiwanIso()`，也不要改回先刪光。`staleDeleted` 現在是「真正過期被清掉的筆數」，不是「整間先刪光的筆數」。

新增/修改 ads table 結構：`schema.sql` 只在建立全新資料庫時整份重跑（會清空所有表）；對既有正式資料庫要用 `worker/migrations/` 新增檔案 + `wrangler d1 execute --remote --file=`，不要直接改 schema.sql 後重跑。

### 推播提醒 (PWA)
課表頁需先加到主畫面成為 PWA 才顯示鈴鐺按鈕（`script.js` 的 `isPWAInstalled()` 判斷 `display-mode: standalone`；本機測試可在網址加 `?pwa=1` 繞過）。登記提醒流程：前端 `sw.js` 註冊 Service Worker 拿 Push 訂閱 → `/registerReminder` 存 D1 → worker cron 每 5 分鐘掃到期提醒 → `reminders.js` 用 VAPID 金鑰簽署推播內容送出 → `sw.js` 的 `push` 事件顯示通知。

### 台灣 IP 限制與爬蟲例外
Pages（`functions/_middleware.js`）與 Worker（`worker/src/index.js` 開頭）都只放行台灣 IP（`cf.country` 沒值，如本機開發，一律放行）。已知搜尋引擎/AI 爬蟲（Googlebot、GPTBot、ClaudeBot、Claude-User 等，UA 清單 `CRAWLER_UA_PATTERN`）例外：
- Pages：整個站都放行（robots.txt / sitemap.xml / llms.txt 一律放行，不看 UA 也不看 IP；llms.txt 是給各家 AI 讀的，AI 的 UA 追不完，擋了沒意義）。
- Worker：只放行唯讀的 `GET /filterOptions`、`GET /issueToken`、`POST /queryClasses`（含這三個路徑的 `OPTIONS` preflight），其餘端點（打點、後台、統計、推播登記、留言…）對海外爬蟲一律 403，避免爬蟲渲染頁面時污染統計。判斷邏輯在 `worker/src/crawlers.js` 的 `isRequestAllowed`，token 與每 IP 流量限制照舊，沒有為爬蟲另開後門。
- **`CRAWLER_UA_PATTERN` 只有一份，在 `worker/src/crawlers.js`**，`functions/_middleware.js` 直接 import 它（`functions/` 本來就會 import `worker/src/` 的檔案，Pages 打包時一起包進去），要增減爬蟲只改那一處。
- UA 只能用來決定「放不放行」，不可以依 UA 回傳不同內容（cloaking）。

### 伺服器端注入課表（SSR）
目的：讓不執行 JS 的爬蟲（多數 AI 爬蟲）也讀得到單一分店課表。`functions/index.js` 只處理 `/`：網址正規化後剛好是「單一分店 + `room=1`」（`branch` 可寫短代碼或 slug；`utm_*`/`pwa`/`fbclid`/`gclid` 會忽略）且該分店在注入清單裡，才查 D1 並用 HTMLRewriter 改寫回傳的 `index.html`；其餘網址（無參數、多分店、有 day/time/course/teacher、不在注入清單）一律 `context.next()` 原樣放行，不查 D1，canonical 維持靜態 HTML 的 `/`。
- 注入清單：`functions/_lib/ssrConfig.js` 的 `SSR_BRANCH_SLUGS`，目前直接取 `worker/src/branches-seed.js` 的全部分店（新增分店自動納入）；想縮小範圍就改成明確的 slug 陣列。查不到團體課表的分店會退回原頁，不會回錯誤；回應標頭 `X-SSR-Status`（hit/miss=有注入，no-data/too-many/no-fixed/error:…=退回原頁的原因）可用來排查（要用 GET，HEAD 不會經過這個 Function）。
- **動態 sitemap**：`functions/sitemap.xml.js`（邏輯在 `functions/_lib/sitemap.js`）處理 `/sitemap.xml`，只列「近 7 天真的有團體教室固定班」的分店（跟注入條件一致，列出來的網址一定查得到內容；查詢與過濾在 `functions/_lib/scheduleBranches.js` 的 `getBranchesWithSchedule()`，與 llms.txt 共用，排序依短代碼，`<loc>` 用 slug 網址）＋首頁，lastmod 取該分店最新的 `scrapedAt` 日期，結果用 Cache API 快取 30 分鐘。新分店有資料自動出現、沒資料自動消失，不用手動維護。任何失敗（沒有 D1 綁定、逾時、查無資料）會 `context.next()` 退回根目錄的靜態 `sitemap.xml`，所以**靜態檔要留著當備援**，內容只是備援用，不必常更新。
- 資料來源：Pages 專案綁 D1（binding 名 `DB`，**在 Cloudflare Dashboard → worldgym → Settings → Bindings 設定，不在版控裡**，改完要重新部署才生效），直接 `import` `worker/src/queryClasses.js`，所以內容與前端查詢（`/queryClasses`）同源。注入「本週固定課表」，不含代課（代課帶日期、很快過期）。
- **給爬蟲與 AI 看的分店網址一律用 slug**（`/?branch=taipei-daan&room=1`）：canonical、og:url、動態/靜態 sitemap、llms.txt、JSON-LD 都是，由 `functions/_lib/branchUrl.js` 的 `branchUrlParam()` 統一產生（slug 不符 `/^[a-z0-9-]+$/` 才退回短代碼）。**短代碼只保留給前端的分享網址（`script.js` 的 `buildShareUrl`）與舊連結相容**：解析端 `resolveSsrTarget` 兩種寫法都收，且兩種寫法得到的 canonical 都是 slug 版。短代碼 = `worker/src/branches-seed.js` 陣列位置，跟 `script.js` 的 `BRANCH_SLUG_ORDER` 同一個順序，**這個限制仍然有效：兩邊順序必須一致、只能往後附加，不能插入/調換**（順序一變，舊的短代碼分享網址就會指到別間分店；改完用 `npm run check:branches -- --base=origin/main` 檢查）。我的最愛存的是 slug，不受影響。
- **分店頁專屬 JSON-LD**：`rewriteHtml()` 會把頁面上第一個 `application/ld+json` 換成 `buildBranchJsonLd()` 的輸出（其餘的移除，確保只剩一個）：`@graph` 只有 WebSite（原樣沿用首頁那個節點，要跟 `index.html` 一致）加一個 WebPage（`@id`/`url` 是 slug 版 canonical，`name`/`description` 與 title/meta 共用 `buildBranchMeta()` 同一份來源，`dateModified` 沿用台灣時間的 `scrapedAt`）。輸出時 `<` 跳脫成 `\u003c`（JSON 裡等同 `<`，避免分店名稱含 `</script>` 破壞 HTML）。**刻意只用 WebPage、不輸出 ExerciseGym / LocalBusiness / SportsActivityLocation / Event / Course / ItemList / BreadcrumbList，也不輸出地址、電話、座標、評分**：課表區塊是視覺隱藏的，Google 規定結構化資料要與可見內容相符；而且不能替真實的健身房建立實體。首頁的 WebApplication 節點也不放進分店頁。所有 UA 拿到的 JSON-LD 完全相同；產生失敗就沿用首頁的。
- **動態 `/llms.txt`**：`functions/llms.txt.js`（邏輯在 `functions/_lib/llms.js`）= 根目錄靜態 `llms.txt` 的內容（取自 `env.ASSETS`，文字只有一份）+ `## 分店課表` 索引（`- [名稱 分店（地區）團體課表](slug 網址)`，順序與 sitemap 相同，因為共用 `scheduleBranches.js` 的 `getBranchesWithSchedule()`）。連結文字會跳脫 Markdown 特殊字元（`\`、`[`、`]`），結果用 Cache API 快取 30 分鐘。任何失敗（沒有 D1/ASSETS 綁定、逾時、查無分店、例外）`context.next()` 退回靜態 `llms.txt`，所以**靜態檔要留著當備援**（它不列分店）。**刻意不列出**：任何 API 端點、後台（/admin）、GitHub、Worker 網址、技術架構或爬取機制；更新頻率只寫「每日更新」；也不加「非官方」等聲明。所有請求（不分 UA）內容相同。
- 注入內容放在 `#loadingOverlay` 裡（`.visually-hidden`）：overlay 是不透明全螢幕載入遮罩，`init()` 結束時整個 `remove()`，區塊跟著消失，所以使用者畫面不變、`script.js` 不用改。同時改寫 `<title>`、description、og/twitter、canonical（slug 版）與 JSON-LD。
- 查 D1 的結果（片段，含 `scrapedAt`）用 Cache API 快取 30 分鐘，不快取整份 HTML；片段快取 key 是 `/_ssr/v2/{slug}`（v2 = 多了 `scrapedAt` 欄位，升版避免跟舊格式混用；讀取時仍容忍沒有此欄位，缺的話 JSON-LD 就不輸出 `dateModified`），動態 sitemap 的 key 是 `/_ssr/v2/sitemap`（v2 = `<loc>` 由短代碼改 slug），llms.txt 是 `/_ssr/v2/llms`（三種 key 都由 `functions/_lib/util.js` 的 `cacheRequest()` 產生，版號只在那裡改一處；sitemap 與 llms.txt 共用 `cachedTextResponse()` 的「快取→產生→快取」流程）；D1 逾時（1.5 秒）、查不到、超過 250 筆、出錯都退回原頁，不回錯誤頁。課程/老師名稱一律 HTML 跳脫。
- 本機測試：`wrangler pages dev . --compatibility-date=2026-08-11 --d1 DB=<database_id> --persist-to <dir>`；本機 D1 是空的，要先匯入資料。

### /queryClasses 防濫用
匿名公開端點，做不到真正私有 API，只拉高濫用成本：
1. 流量限制：每 IP 每 60 秒 20 次（`/queryClasses`）/ 10 次（`/issueToken`），用 KV namespace `QUERY_RATE_LIMIT`（fixed-window，非原子，夠用不追求精確）。
2. 短效 HMAC token：`GET /issueToken` 發 15 分鐘效期 token（payload 只有 `exp`，`QUERY_TOKEN_SECRET` 簽名）。`/queryClasses` 沒帶對 token 回 401。
前端過期自動重拿 token 重試一次，使用者無感（見 `script.js` 的 query 流程）。

### 後台報表 / 首頁公開排行
`admin.html` 有廣告/最愛/提醒三個報表面板（加上 IP 存取紀錄表），折線圖用 Chart.js 的共用元件 `createDualLineChart`/`createSingleLineChart`。首頁「通知」分頁下方有查詢量趨勢與老師/課程/分店查詢次數排行（`/publicSearchStats`、`/publicTeacherStats` 等端點，不驗證 token，因為這些是課表本身的公開資訊），用 `script.js` 的 `setupPublicRankingStats()` 畫圖，每張只顯示前 10 名。年/月選單是自製的 `.custom-select` 元件（`enhanceCustomSelect()`），跟 admin 的廣告篩選下拉共用同一套慣例。新增報表面板的模式：worker 開打點端點（`/trackXxx`，同一次查詢動作會一起寫入的就併進批次端點，如 `/trackSearchEvents`）+ `/xxxStats` 讀取端點（公開的用 `/publicXxxStats`，後台的要驗證 session token）、新增對應 D1 table（含 migration）、前端在對應動作打點。**新增端點只要在 `worker/src/index.js` 的 `ROUTES` 表加一列**（key 是 `"METHOD /path"`，填 `limit` 每 IP 每分鐘上限、後台端點加 `admin: true`、`handler`）：限流（KV key 前綴 = 路徑名）、後台 session 驗證、429/403/404/500 都由 `fetch()` 統一處理，handler 只寫業務邏輯；老師/課程/分店排行三個端點共用 `rankingHandler()`。

**公開打點端點要驗證內容，不能什麼字串都收**：`/trackSearchEvents` 的名稱會原封不動出現在首頁公開排行榜，所以分店名稱必須在 `branches-seed.js` 裡（跟前端分店 pill 文字一致）、老師/課程名稱必須在 `meta_filter_options`（前端選項的來源，isolate 內快取 5 分鐘），不在名單的值靜默丟掉；`/trackFavorite` 的 `clientId` 必須是 UUID 格式。新增會顯示在公開頁面上的打點時照這個原則做。

網站沒有帳號系統，「幾個人」的統計靠前端 `localStorage` 存的匿名 `wg_client_id`（`crypto.randomUUID()`），後端用 `COUNT(DISTINCT clientId)` 估算，不對應真實身分。

### 靜態資源快取
`style.css`/`icons/` 走 `_headers` 長效快取，搭配 `index.html`/`admin.html` 裡的 `?v=` 版號機制——內容改了要同步更新版號，否則使用者吃到快取住的舊檔案。`script.js`、`admin.js`、`common.js` 目前故意不設長效快取（改動頻繁），只靠 `?v=` 版號控制；`common.js` 同時被 `index.html` 與 `admin.html` 引用（都要排在自己的 script 之前），改了要兩個檔案裡的 `common.js?v=` 一起更新。Font Awesome 圖示直接吃 cdnjs 的完整套件，`fa-` class 可以照官方圖示庫直接用。

### 安全標頭與 CSP（`_headers` 的 `/*`）
所有頁面都帶 `Content-Security-Policy`、`X-Frame-Options: DENY`（後台不能被嵌入）、`Strict-Transport-Security`、`Permissions-Policy`（只開 `geolocation=(self)`，分店依距離篩選要用）等標頭。CSP 的重點：
- **`script-src` 不含 `'unsafe-inline'`**：頁面裡不能再寫 inline `<script>` 或 `onclick=`/`onload=` 這類 inline 事件處理（會被擋、而且是靜默失效）。需要時放成外部檔（現有 `ga-init.js` 是 GA4 初始化，只有 `index.html` 載入，且必須同步載入；`css-async.js` 非阻塞載入 Font Awesome CSS，`index.html`/`admin.html` 都載入）。`type="application/ld+json"` 不是可執行腳本，不受影響。
- `style-src` 保留 `'unsafe-inline'`（HTML 裡有大量 `style=` 屬性）。
- **新增任何外部來源（CDN、字型、分析服務、新的 API 網域）都要同步改 CSP**，否則在正式站被擋、本機看不出差別以外的問題；改完用本機 hosting 開發伺服器（會套用 `_headers`）載入頁面，看主控台有沒有 `violates the following Content Security Policy`。萬用字元 `*.example.com` **不包含** `example.com` 本身，要另外列（GA4 的 `analytics.google.com` 就是這樣漏掉過）。
- GA4 會打 `www.google.com.tw` 的受眾像素，所以 `img-src`/`connect-src` 有列這個在地化網域；站台只開放台灣 IP，不必列其他國家網域。
- 本機（localhost）載入時 Cloudflare Web Analytics beacon 會出現 CORS 錯誤，是因為 localhost 不是它登記的網域，跟 CSP 無關，可忽略。

## Secrets

`worker/.dev.vars`（gitignore，不進版控）本機開發用，需要 `MANUAL_SCRAPE_TOKEN` / `TEAMS_WEBHOOK_URL`(選填) / `VAPID_PRIVATE_KEY` / `QUERY_TOKEN_SECRET`。正式環境用 `npx wrangler secret put VAPID_PRIVATE_KEY` / `QUERY_TOKEN_SECRET` 設定（`QUERY_TOKEN_SECRET` 沒設會讓 `/queryClasses` 變 500）。

`ADMIN_SESSION_SECRET`（選填但建議設，至少 32 字元的隨機字串，`npx wrangler secret put ADMIN_SESSION_SECRET`）：後台 session token 的簽章金鑰。沒設或少於 32 字元就退回舊做法——從 `MANUAL_SCRAPE_TOKEN` 做無鹽 SHA-256 衍生，session token 一旦外洩，攻擊者能離線猜登入密碼；設了獨立金鑰就沒有這個問題。**設定或更換它會讓目前所有後台登入失效**（要重新輸入密碼一次），因為兩種金鑰簽出來的 token 不通用。
