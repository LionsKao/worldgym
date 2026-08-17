# 🏋️ World Gym 課表查詢

查詢 World Gym 台灣各分店團體課表的網站,前端是純靜態頁面,後端用 Cloudflare Worker + D1 資料庫。

<img src="docs/screenshot.png" alt="課表查詢畫面截圖" width="320">

線上版本:
- Hosting: https://worldgym.pages.dev
- API: https://worldgym-api.lions2100.workers.dev

## 🏗️ 架構

```
.
├── index.html / script.js / style.css   # 前端:課表查詢頁(含首頁廣告輪播)
├── manifest.json / sw.js / icons/       # PWA 設定與 Service Worker(推播提醒用)
│   └── icons/fontawesome/               # 自打包的 Font Awesome 子集(只含用到的圖示,取代 cdnjs 全量載入)
├── admin.html / admin.js                # 後台:手動觸發重抓、查看爬蟲紀錄
├── branches.json                        # 分店清單快取(前端用)
├── functions/_middleware.js             # Cloudflare Pages Functions:只放行台灣 IP
├── _headers                             # 靜態資源快取設定(script.js/style.css/icons 走長效快取)
├── hosting/                             # Cloudflare Workers 靜態託管設定(wrangler)
└── worker/                              # Cloudflare Worker API
    ├── src/index.js                     # 路由 / CORS / 入口 / cron scheduled()
    ├── src/queryClasses.js              # 課表查詢邏輯
    ├── src/scrape.js                    # 爬蟲邏輯(重抓官網課表寫入 D1)
    ├── src/reminders.js                 # 課前推播提醒:登記/取消/到期後發送 Web Push
    ├── src/branches-seed.js             # 分店清單固定資料(slug 對應官網 find-a-club/{slug})
    ├── schema.sql                       # D1 完整 schema(含預設種子資料),重建資料庫時整份下
    └── migrations/                      # 針對既有正式資料庫的單張 table migration(不動其他表)
```

前端呼叫 `worker/` 部署出來的 API(`/queryClasses` 等端點),API 讀寫 Cloudflare D1(`worldgym-schedule` 資料庫)。爬蟲沒有排程,重抓要透過 `admin.html` 手動觸發;`worker/wrangler.toml` 裡的 `[triggers]` cron(`*/5 * * * *`)只用來每 5 分鐘掃描是否有課前推播提醒到期,跟爬蟲無關。

前端另外有埋 GA4 事件(篩選、查詢、登記/取消提醒等),用來看使用行為。

## 🗄️ 資料表總覽

D1(`worldgym-schedule`)裡的 table,完整欄位定義以 [`worker/schema.sql`](worker/schema.sql) 為準:

| Table | 用途 |
| --- | --- |
| `classes` | 爬蟲抓下來的課表(分店、日期、課程、老師、教室等) |
| `branches` | 分店清單(slug、名稱、地區) |
| `meta_filter_options` | 篩選用的課程名稱/老師名稱清單快取 |
| `reminders` | 課前推播提醒的登記紀錄與發送狀態 |
| `ads` | 首頁廣告輪播內容與上下架時間 |

## 🔔 推播提醒(PWA)

課表查詢頁需要先加到主畫面成為 PWA 才能顯示鈴鐺按鈕(見 `script.js` 的 `isPWAInstalled()`,判斷 `display-mode: standalone`)。使用者對某堂課按鈴鐺登記提醒後:

1. 前端透過 `sw.js` 註冊 Service Worker 並跟瀏覽器要 Push 訂閱(`ensurePushSubscription`),連同上課資訊一起打 `worker` 的 `/registerReminder` 存進 D1。
2. `worker` 的 cron(`src/index.js` 的 `scheduled()`)每 5 分鐘掃一次 D1,找出快到上課時間、還沒發送的提醒。
3. 到期的提醒由 `worker/src/reminders.js` 組出推播內容(標題:`課程名 老師`,內文:`分店 週幾 時間`),用 VAPID 金鑰(`VAPID_SUBJECT` / `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY`)簽署後送給瀏覽器的 Push 服務。
4. 瀏覽器收到後交給 `sw.js` 的 `push` 事件處理,呼叫 `showNotification` 顯示通知。

本機測試可以在網址加上 `?pwa=1`(等同 `localStorage.setItem("wg_debug_force_pwa","1")`),讓 `isPWAInstalled()` 直接回傳 true,不用真的安裝成 PWA 就能看到鈴鐺按鈕。

## 📢 首頁廣告

首頁上方的廣告輪播內容存在 D1 的 `ads` table(`text` / `url` / `startAt` / `endAt` / `enabled` / `sortOrder`),前端載入時打 `worker` 的 `GET /ads`,只會拿回目前在上下架時間內、且 `enabled = 1` 的廣告;拿不到任何廣告時整條廣告列會自動隱藏。

要臨時下架某則廣告,不用改上下架時間,直接把該筆的 `enabled` 改成 `0` 即可:

```bash
cd worker
npx wrangler d1 execute worldgym-schedule --remote --command="UPDATE ads SET enabled=0 WHERE id='ad-1'"
```

新增/修改 ads table 結構的話,`worker/schema.sql` 是重建整個資料庫用的完整版本(會 `DROP TABLE` 掉所有表,只在建立全新資料庫時執行);要對既有正式資料庫追加改動,改寫或新增 `worker/migrations/` 底下的檔案,用 `wrangler d1 execute ... --remote --file=migrations/xxx.sql` 執行,才不會把 `classes`/`reminders` 等其他表的資料一起清掉。

## ⚡ 靜態資源快取

`script.js` / `style.css` / `icons/` 走 `_headers` 設定的長效快取(`Cache-Control: max-age=...`),搭配 `index.html`/`admin.html` 裡既有的 `?v=` 版號機制:內容有改的話記得同步更新版號,不然使用者會吃到快取住的舊檔案。

圖示改用自己打包的 Font Awesome 子集(`icons/fontawesome/`,只含實際用到的圖示),不再從 cdnjs 載入完整套件;要新增圖示的話得重新產生子集檔案,不能直接在 HTML 裡加新的 `fa-` class 就以為會動。

## 🛠️ 本機開發

需要 Node.js 與 [wrangler](https://developers.cloudflare.com/workers/wrangler/)(已在各自的 `package.json` 裡列為 devDependency)。

### 1. 跑前端(靜態頁面)

```bash
cd hosting
npm install
npm run dev
```

會在 `http://localhost:1069` 啟動(Cloudflare Workers 靜態託管模擬)。

### 2. 跑後端 API

```bash
cd worker
npm install
```

在 `worker/` 底下建立 `.dev.vars`(此檔案已被 `.gitignore` 排除,不會進版控):

```
MANUAL_SCRAPE_TOKEN=your-own-secret-token
TEAMS_WEBHOOK_URL=https://your-teams-webhook-url   # 選填,爬蟲失敗時的 Teams 通知
VAPID_PRIVATE_KEY=your-own-vapid-private-key       # 推播提醒用,跟 wrangler.toml 裡的 VAPID_PUBLIC_KEY 成對
```

你也需要自己在 Cloudflare 建立一個 D1 資料庫,並把 `worker/wrangler.toml` 裡的 `database_id` 換成你自己的:

```bash
npx wrangler d1 create worldgym-schedule
```

接著啟動本機開發伺服器:

```bash
npm run dev
```

### 3. 部署

```bash
# 部署 API
cd worker && npm run deploy

# 部署前端
cd hosting && npm run deploy
```

`VAPID_PRIVATE_KEY` 是機密,不放在 `wrangler.toml`,部署前要先設成 Cloudflare Worker 的 secret(只需做一次):

```bash
cd worker && npx wrangler secret put VAPID_PRIVATE_KEY
```

## 📄 授權

[MIT License](LICENSE)
