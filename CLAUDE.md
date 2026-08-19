# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 語言

回覆一律使用繁體中文。

## What this is

World Gym 台灣課表查詢網站。純靜態前端 + Cloudflare Worker API + D1 資料庫，沒有 build step、沒有前端框架、沒有 bundler。`script.js`/`admin.js`/`style.css` 都是直接編輯後部署的原始檔。

- Hosting (static site, Workers Assets): https://worldgym-web.lions2100.workers.dev (also fronted at https://worldgym.pages.dev)
- API (Worker): https://worldgym-api.lions2100.workers.dev

## Commands

### Local dev
```bash
# 前端 (http://localhost:1069)
cd hosting && npm install && npm run dev

# API (worker/.dev.vars 需先手動建立，見 README「本機開發」章節)
cd worker && npm install && npm run dev
```
Both dev servers are also registered in `.claude/launch.json` (`worldgym-hosting`, `worldgym-worker`) for use with the preview/browser tools.

### Deploy
```bash
cd worker && npm run deploy     # 部署 API (wrangler deploy)
cd hosting && npx wrangler deploy   # 部署靜態站（見下方「部署注意」，不要用 npm run deploy）
```

Worker tail logs: `cd worker && npm run tail`

D1 query/migration against production:
```bash
cd worker
npx wrangler d1 execute worldgym-schedule --remote --command="SELECT ..."
npx wrangler d1 execute worldgym-schedule --remote --file=migrations/xxx.sql
```

There is no test suite and no lint/build command in this repo.

### 部署注意：hosting 的 npm script 是舊的，不要用
`hosting/package.json` 的 `deploy` script 還寫著 `wrangler pages deploy .. --project-name worldgym --branch main`（舊的 Cloudflare Pages 部署方式），但 `hosting/wrangler.jsonc` 已經是 Workers Assets 設定（`name: "worldgym-web"`, `assets.directory: ".."`）。實際部署要用 `npx wrangler deploy`（讀 `wrangler.jsonc`），不要用 `npm run deploy`。

部署會把整個 repo 根目錄（`assets.directory: ".."`，`.assetsignore` 排除 `worker/`/`hosting`/`node_modules` 等）當成靜態資源整批發布——發的是**當下工作目錄的檔案內容**，不是 git HEAD。deploy 前要注意根目錄下有沒有其他人正在改、還沒 commit 的檔案，因為它們會一起被發布上線。

## Architecture

```
index.html / script.js / style.css   前端：課表查詢頁 + 首頁廣告輪播 + 首頁公開排行報表
manifest.json / sw.js / icons/       PWA + Service Worker（推播提醒用）
admin.html / admin.js                後台：手動重抓、爬蟲紀錄、報表（Chart.js）
vendor/chart.umd.min.js              Chart.js，vendor 進來不吃 CDN
branches.json                        分店清單快取（前端用）
functions/_middleware.js             Cloudflare Pages Functions：只放行台灣 IP
_headers                             靜態資源快取設定
hosting/                             Workers Assets 靜態託管設定（wrangler.jsonc）
worker/
  src/index.js                      路由 / CORS / 入口 / cron scheduled()
  src/queryClasses.js               課表查詢邏輯
  src/scrape.js                     爬蟲邏輯（重抓官網課表寫入 D1）
  src/reminders.js                  課前推播提醒：登記/取消/到期發送 Web Push
  src/branches-seed.js              分店清單固定資料
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

**時間戳一律用台灣時間（`+08:00`），不是 UTC**：`createdAt`/`updatedAt`/`scrapedAt`/`ads.startAt`/`ads.endAt` 都是位移 8 小時再貼 `+08:00` 後綴的 ISO 字串（`nowTaiwanIso()`，在 `worker/src/index.js`/`scrape.js`/`reminders.js` 各有一份同樣邏輯），才能跟其他時間戳直接用字串比較/排序。改動任何時間戳寫入或比較的地方，都要延用這個慣例，不要混用 `new Date().toISOString()`（那是 UTC）。

新增/修改 ads table 結構：`schema.sql` 只在建立全新資料庫時整份重跑（會清空所有表）；對既有正式資料庫要用 `worker/migrations/` 新增檔案 + `wrangler d1 execute --remote --file=`，不要直接改 schema.sql 後重跑。

### 推播提醒 (PWA)
課表頁需先加到主畫面成為 PWA 才顯示鈴鐺按鈕（`script.js` 的 `isPWAInstalled()` 判斷 `display-mode: standalone`；本機測試可在網址加 `?pwa=1` 繞過）。登記提醒流程：前端 `sw.js` 註冊 Service Worker 拿 Push 訂閱 → `/registerReminder` 存 D1 → worker cron 每 5 分鐘掃到期提醒 → `reminders.js` 用 VAPID 金鑰簽署推播內容送出 → `sw.js` 的 `push` 事件顯示通知。

### /queryClasses 防濫用
匿名公開端點，做不到真正私有 API，只拉高濫用成本：
1. 流量限制：每 IP 每 60 秒 20 次（`/queryClasses`）/ 10 次（`/issueToken`），用 KV namespace `QUERY_RATE_LIMIT`（fixed-window，非原子，夠用不追求精確）。
2. 短效 HMAC token：`GET /issueToken` 發 15 分鐘效期 token（payload 只有 `exp`，`QUERY_TOKEN_SECRET` 簽名）。`/queryClasses` 沒帶對 token 回 401。
前端過期自動重拿 token 重試一次，使用者無感（見 `script.js` 的 query 流程）。

### 後台報表 / 首頁公開排行
`admin.html` 有廣告/查詢/最愛三個報表面板，全用 Chart.js 的共用元件 `createDualLineChart`（雙 Y 軸折線圖）。首頁「通知」分頁下方有老師/課程/分店查詢次數排行（`/publicTeacherStats` 等端點，邏輯同 admin 版但不驗證 token，因為這些是課表本身的公開資訊），用 `script.js` 的 `setupPublicRankingStats()` 畫圖，每張只顯示前 10 名。年/月選單是自製的 `.custom-select` 元件（`enhanceCustomSelect()`），跟 admin 的廣告篩選下拉共用同一套慣例。新增報表面板的模式：worker 開 `/trackXxx` 打點端點 + `/xxxStats` 讀取端點、新增對應 D1 table（含 migration）、前端在對應動作打 `/trackXxx`。

網站沒有帳號系統，「幾個人」的統計靠前端 `localStorage` 存的匿名 `wg_client_id`（`crypto.randomUUID()`），後端用 `COUNT(DISTINCT clientId)` 估算，不對應真實身分。

### 靜態資源快取
`style.css`/`icons/` 走 `_headers` 長效快取，搭配 `index.html`/`admin.html` 裡的 `?v=` 版號機制——內容改了要同步更新版號，否則使用者吃到快取住的舊檔案。`script.js` 目前故意不設長效快取（改動頻繁），只靠 `?v=` 版號控制。Font Awesome 圖示直接吃 cdnjs 的完整套件，`fa-` class 可以照官方圖示庫直接用。

## Secrets

`worker/.dev.vars`（gitignore，不進版控）本機開發用，需要 `MANUAL_SCRAPE_TOKEN` / `TEAMS_WEBHOOK_URL`(選填) / `VAPID_PRIVATE_KEY` / `QUERY_TOKEN_SECRET`。正式環境用 `npx wrangler secret put VAPID_PRIVATE_KEY` / `QUERY_TOKEN_SECRET` 設定（`QUERY_TOKEN_SECRET` 沒設會讓 `/queryClasses` 變 500）。
