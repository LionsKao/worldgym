# 🏋️ World Gym 課表查詢

查詢 World Gym 台灣各分店團體課表的網站,前端是純靜態頁面,後端用 Cloudflare Worker + D1 資料庫。

這是使用 Claude 寫的。

<img src="docs/screenshot.png" alt="課表查詢畫面截圖" width="320">

線上版本:
- Hosting: https://worldgym.pages.dev
- API: https://worldgym-api.lions2100.workers.dev

## 🏗️ 架構

```
.
├── index.html / script.js / style.css   # 前端:課表查詢頁(含首頁廣告輪播 + 公開排行報表)
├── aircon.html / aircon-assets/         # 前端:跟課表查詢無關的個人分類廣告頁面,共用同一個 Cloudflare Pages 部署
├── manifest.json / sw.js / icons/       # PWA 設定與 Service Worker(推播提醒用)
├── admin.html / admin.js                # 後台:登入、手動觸發重抓、查看爬蟲紀錄、報表(Chart.js 畫圖)
├── vendor/chart.umd.min.js              # Chart.js(vendor 進來,不吃 CDN,admin.html 報表用)
├── branches.json                        # 分店清單快取(前端用)
├── functions/_middleware.js             # Cloudflare Pages Functions:只放行台灣 IP
├── _headers                             # 靜態資源快取設定(style.css/icons 走長效快取,script.js 開發中暫不快取)
├── hosting/                             # Cloudflare Workers 靜態託管設定(wrangler)
└── worker/                              # Cloudflare Worker API
    ├── src/index.js                     # 路由 / CORS / 入口 / cron scheduled()
    ├── src/queryClasses.js              # 課表查詢邏輯
    ├── src/scrape.js                    # 爬蟲邏輯(重抓官網課表寫入 D1)
    ├── src/reminders.js                 # 課前推播提醒:登記/取消/到期後發送 Web Push
    ├── src/analytics.js                 # 分析報表的「明細 + 月度彙總」查詢與每月排程壓縮邏輯
    ├── src/branches-seed.js             # 分店清單固定資料(slug 對應官網 find-a-club/{slug})
    ├── schema.sql                       # D1 完整 schema(含預設種子資料),重建資料庫時整份下
    └── migrations/                      # 針對既有正式資料庫的單張 table migration(不動其他表)
```

前端呼叫 `worker/` 部署出來的 API(`/queryClasses` 等端點),API 讀寫 Cloudflare D1(`worldgym-schedule` 資料庫)。`worker/wrangler.toml` 的 `[triggers]` 設了四個 cron:`*/5 * * * *` 每 5 分鐘掃一次課前推播是否到期(跟爬蟲無關);`0 19 * * *`、`0 9 * * *` 是台灣時間 03:00、17:00 各自動重抓一次全部分店(見 `worker/src/branches-seed.js` 的清單,需要 Workers Paid 方案,因為單次執行要把 subrequest 上限拉到 1000 才跑得完全部分店);`0 20 1 * *` 是每月 1 號清一次 `query_access_log` 90 天前的舊紀錄、並把分析報表明細表超過保留窗口的舊月份壓縮成彙總(見下方「分析報表明細轉月度彙總」)。也可以直接在 `admin.html` 手動觸發重抓。

前端另外埋了 GA4 事件(篩選、查詢、登記/取消提醒等),用來追蹤使用行為。

## 🗄️ 資料表總覽

D1(`worldgym-schedule`)的 table 如下,完整欄位定義以 [`worker/schema.sql`](worker/schema.sql) 為準:

| Table | 用途 |
| --- | --- |
| `classes` | 爬蟲抓下來的課表(分店、日期、課程、老師、教室等) |
| `branches` | 分店清單(slug、名稱、地區) |
| `meta_filter_options` | 篩選用的課程名稱/老師名稱清單快取 |
| `reminders` | 課前推播提醒的登記紀錄與發送狀態 |
| `reminder_add_events` / `reminder_add_monthly` | 提醒功能使用量打點,只記「登記提醒」被觸發幾次,不分辨是不是同一人、不追蹤取消(admin.html 提醒報表用) |
| `ads` | 首頁廣告輪播內容與上下架時間 |
| `ad_events` / `ad_monthly` | 廣告曝光/點擊事件明細 + 每月彙總(見下方「分析報表明細轉月度彙總」) |
| `teacher_search_events` / `course_search_events` / `branch_search_events`(+ 對應 `*_monthly` 彙總表) | 老師/課程/分店的查詢次數打點(首頁公開排行報表 + admin.html 查詢報表用) |
| `search_events` / `search_monthly` | 整體查詢次數與查詢結果數打點 |
| `favorite_events` / `favorite_monthly` / `favorite_client_seen` | 「我的最愛」建立/使用打點;`favorite_client_seen` 即時維護全時間去重人數,不受明細清理影響 |
| `query_access_log` | `/issueToken`、`/queryClasses` 的存取紀錄(IP/UA/是否被流量限制擋下),事後排查是不是被爬蟲/腳本大量打,每月自動清 90 天前的舊紀錄 |

**時間戳記一律用台灣時間(`+08:00`),不是 UTC。**`createdAt`/`updatedAt`/`scrapedAt` 都是位移 8 小時再貼上 `+08:00` 後綴的 ISO 字串(見 `worker/src/index.js`/`scrape.js`/`reminders.js` 的 `nowTaiwanIso()`),報表「這個月」的預設值也是照台灣時間判斷,避免在台灣午夜前後 8 小時內誤判成上個月。例外是 `ads.startAt`/`endAt`——這是後台手動填的排程時間,沿用既有的 UTC(`Z`)格式,跟事件打點時間意義不同。

## 🗂️ 分析報表明細轉月度彙總

`teacher_search_events`/`course_search_events`/`branch_search_events`/`search_events`/`favorite_events`/`ad_events`/`reminder_add_events` 這幾張「事件明細」表只保留當月的明細,上個月一結束就由每月排程(`worker/src/analytics.js` 的 `rollupAnalyticsEvents()`,見 `wrangler.toml` 的 `0 20 1 * *` cron)壓縮成對應的 `*_monthly` 彙總表、然後刪除明細。彙總表保留的是報表實際會用到的完整維度(例如老師排行要留「月份 + 老師名字」各自的次數,不是只留一個月度總數),不管排第幾名都完整保留——之後要把「排行前 15 名」改成「前 20 名」之類的顯示調整,不需要任何資料回填,舊資料本來就在。

所有讀取報表的查詢都是「彙總表 `UNION ALL` 明細表」,兩者依月份天生互斥(一個月份要嘛還在明細裡、要嘛已經被搬進彙總並清掉),讀取端完全無感,不影響任何現有數字。彙總寫入跟刪除明細包在同一個 `db.batch()` 裡原子執行,避免任何時間點的查詢同時看到彙總跟明細都有同一個月的資料而重複計算。

`favorite_events` 的「累積建立人數」是例外——它靠 `favorite_client_seen` 這張表即時維護(每次 `/trackFavorite` 記一次 `add` 就 `INSERT OR IGNORE` 一次),不依賴明細是否還在,才能讓這個總數字不受清理影響、永遠準確。

想手動確認/補跑這個排程,可以帶 admin token 呼叫 `POST /rollupAnalyticsManual`,不用等到每月 1 號。

## 🔔 推播提醒(PWA)

課表查詢頁要先加到主畫面成為 PWA,才會顯示鈴鐺按鈕(見 `script.js` 的 `isPWAInstalled()`,判斷 `display-mode: standalone`)。使用者對某堂課按下鈴鐺登記提醒後,流程是:

1. 前端透過 `sw.js` 註冊 Service Worker、跟瀏覽器要 Push 訂閱(`ensurePushSubscription`),連同上課資訊一起打 `worker` 的 `/registerReminder` 存進 D1,同時在 `reminder_add_events` 記一筆使用量。
2. `worker` 的 cron(`src/index.js` 的 `scheduled()`)每 5 分鐘掃一次 D1,找出快到上課時間、還沒發送的提醒。
3. 到期的提醒由 `worker/src/reminders.js` 組出推播內容(標題:`課程名 老師`,內文:`分店 週幾 時間`),用 VAPID 金鑰(`VAPID_SUBJECT` / `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY`)簽署後送給瀏覽器的 Push 服務。
4. 瀏覽器收到後交給 `sw.js` 的 `push` 事件處理,呼叫 `showNotification` 顯示通知。

取消提醒(`/cancelReminder`)一定要帶對「登記當時那個裝置的 push 訂閱網址」(`subscriptionEndpoint`)才會真的刪除,不能只憑 reminder id——reminder id 是給非安全用途的雜湊值,不能單獨當刪除授權用。

本機測試可以在網址加上 `?pwa=1`(等同 `localStorage.setItem("wg_debug_force_pwa","1")`),讓 `isPWAInstalled()` 直接回傳 true,不用真的安裝成 PWA 就能看到鈴鐺按鈕。

## 📢 首頁廣告

首頁上方的廣告輪播內容存在 D1 的 `ads` table(`text` / `url` / `startAt` / `endAt` / `enabled` / `sortOrder`)。前端載入時打 `worker` 的 `GET /ads`,只會拿回目前在上下架時間內、且 `enabled = 1` 的廣告,從中隨機挑一則顯示;拿不到任何廣告時,整條廣告列會自動隱藏。**這裡沒有輪播/切換機制**——每次載入頁面隨機選一則、固定顯示到重新整理頁面為止,不會每隔幾秒自動換下一則,廣告只有一則的時候行為完全一樣。

要臨時下架某則廣告,不用改上下架時間,直接把該筆的 `enabled` 改成 `0` 即可:

```bash
cd worker
npx wrangler d1 execute worldgym-schedule --remote --command="UPDATE ads SET enabled=0 WHERE id='ad-1'"
```

要新增或修改 ads table 結構的話:`worker/schema.sql` 是重建整個資料庫用的完整版本(會 `DROP TABLE` 掉所有表,只在建立全新資料庫時執行);要對既有正式資料庫追加改動,請改寫或新增 `worker/migrations/` 底下的檔案,用 `wrangler d1 execute ... --remote --file=migrations/xxx.sql` 執行,才不會把 `classes`/`reminders` 等其他表的資料一起清掉。

## 🔑 後台登入

`admin.html` 用一組共用密碼登入(對應 worker 的 `MANUAL_SCRAPE_TOKEN` secret),沒有帳號系統,任何人拿到這組密碼都能登入。登入流程:

1. 輸入密碼後打 `POST /verifyAdminToken`,worker 把傳入值跟 `MANUAL_SCRAPE_TOKEN` 各自雜湊成固定長度、用 `timingSafeEqual` 常數時間比較(不能直接用 `!==` 比字串,理論上會被時間側channel慢慢猜出來)。驗證成功會換發一張**簽章、7 天效期**的 session token(payload 只有 `exp`,簽章金鑰是從 `MANUAL_SCRAPE_TOKEN` 雜湊衍生,不是直接拿密碼當 key)。
2. 前端把這張 session token(不是密碼本身)存進 `localStorage`,之後每次後台操作都用 `X-Admin-Token` header 帶著送出去。
3. 每次重新打開後台頁面都會重新驗證一次、順便換發新的 token(滑動延長效期)——只要 7 天內有開過後台就不用重新輸入密碼,超過 7 天沒用才需要重新輸入。
4. 所有後台端點也接受「直接帶密碼本身」這個方式(向下相容),但正常使用流程下密碼只會在登入當下被送出網路一次,不是每次後台操作都在傳輸密碼。

## 📊 後台報表

`admin.html` 登入後有 4 個報表面板:

| 面板 | 資料來源 | 內容 |
| --- | --- | --- |
| 廣告 | `ad_events` / `ad_monthly` | 每則廣告(或全部加總)近 12 個月的曝光/點擊趨勢,可翻頁切換月份視窗 |
| 最愛 | `favorite_events` / `favorite_monthly` / `favorite_client_seen` | 累積建立人數(全時間去重)+ 累積使用次數,近 12 個月趨勢 |
| 提醒 | `reminder_add_events` / `reminder_add_monthly` | 累積登記次數 + 近 12 個月每月次數表格(沒紀錄的月份顯示 0,不是空白),用來評估這個功能有沒有人在用 |
| 存取紀錄 | `query_access_log` | 依 IP 分組列出 `/issueToken`、`/queryClasses` 的存取次數與被流量限制擋下的次數,可切換 7/14/30 天視窗 |

廣告/最愛面板用 [Chart.js](https://www.chartjs.org/) 畫折線圖(vendor 進 `vendor/chart.umd.min.js`,不吃 CDN);提醒/存取紀錄面板是純表格,不畫圖。

網站沒有帳號系統,所以「幾個人」這類統計是靠前端在 `localStorage` 存一個 `crypto.randomUUID()` 產生的匿名 id(`wg_client_id`,最愛功能用)或裝置的 push 訂閱網址雜湊(提醒功能的使用量統計不需要分辨是不是同一人,所以沒有用到這個 id),這些都不對應任何真實身分,純粹統計用。

新增報表面板的大致流程:worker 開一個打點端點(`/trackXxx` 或直接在既有動作發生時打點)+ 一個 `/xxxStats` 給 admin 讀,新增對應的 D1 table(記得同步寫 migration),需要長期累積的話評估要不要比照「分析報表明細轉月度彙總」的模式做保留窗口。

這些統計都不蒐集可識別個人身份的資料,GA4 事件跟這裡的匿名 id 都只用來看使用量,不會對應到任何真實使用者身分。

## 🏆 首頁公開排行報表

老師/課程/分店的查詢次數排行改放在**首頁**(`index.html` 的「通知」分頁下方),不需要登入,任何人都看得到——因為這些名字本來就是課表上的公開資訊,不含個資。對應的 worker 端點是 `/publicTeacherStats`、`/publicCourseStats`、`/publicBranchStats`(邏輯跟 admin 版的 `/teacherStats` 等相同,只是不驗證 token)。

- 前端用 `script.js` 的 `setupPublicRankingStats()` 共用一份邏輯,畫出三張排行長條圖(Chart.js)。分店/課程排行前端固定只顯示前 10 名;老師排行目前顯示後端回傳的前 15 名。三者的後端排行本身依 `worker/src/index.js` 呼叫 `monthlyNameRanking()` 時傳的 `limit` 參數決定要撈幾名——調整名次上限不需要任何資料搬移,重新部署新的 `limit` 值即可生效(見上方「分析報表明細轉月度彙總」)。
- 年/月選單不是原生 `<select>`,而是自製的 `.custom-select` 元件(`enhanceCustomSelect()`),外觀跟按鈕一致,月份選單排成 4×3 格狀;跟 `admin.html` 的廣告篩選下拉用同一套元件慣例。
- 排行數字會在使用者送出查詢時即時 +1(見 `/trackTeacherSearch` 等打點端點),不是跟著爬蟲排程更新,所以是即時的;會跟爬蟲排程更新頻率有關的只有課表本身(`classes` table)。

## 🛡️ 防濫用機制

### /queryClasses

課表查詢是最耗 D1 讀取量的端點,公開給匿名訪客用,沒有登入機制,做不到真正的「私有 API」——只能拉高濫用成本,不追求 100% 擋住。防護分三層,都在 `worker/src/index.js`/`worker/src/queryClasses.js`:

1. **流量限制**:每 IP 每 60 秒最多 20 次(`/queryClasses`)、10 次(`/issueToken`),用 KV namespace `QUERY_RATE_LIMIT` 記 fixed-window 計數,超過就回 `429`。KV 是 eventually-consistent、read-then-write 也不是原子操作,這只是「夠用的防濫用」,不是精確計費。
2. **短效 HMAC token**:`GET /issueToken` 發一個 15 分鐘後過期的 token(payload 只有 `exp`,用 `QUERY_TOKEN_SECRET` 簽名,`crypto.subtle.verify` 驗證,不用查資料庫)。`/queryClasses` 沒帶對的 token 會回 `401`,body 用 `token_invalid`/`token_expired` 區分是不是單純過期。
3. **結果筆數上限**:`RESULT_HARD_CAP = 300`。前端本來就設計成結果超過 250 筆就整包不顯示、只提示「結果太多,請調整篩選條件」(`RESULT_COUNT_WARN_LIMIT`,見 `script.js`),篩選條件下得很寬時,後端沒必要真的把全表資料都撈出來又白白被前端丟棄——300 這個數字比前端的警告門檻高一點,真正 ≤250 筆的正常情況完全不受影響。

前端(`script.js`)對應的邏輯是:頁面載入時背景預熱先拿一次 token 快取起來;每次查詢都帶著 token,如果伺服器說過期,會自動清快取、重新拿一張再重試一次,使用者不會看到任何錯誤畫面(頂多慢個幾秒);分頁從背景切回前景時也會順便檢查要不要提前換新,降低真的撞到過期重試的機率。

這套機制擋不住「認真寫爬蟲、會先讀網頁怎麼呼叫 API 再模仿」的人——目標只是擋掉隨手直接打 API 的腳本,把濫用成本墊高到「至少要跑一次完整的兩步驟流程」。

### 其他端點

除了 `/queryClasses`/`/issueToken`,其餘所有會寫入 D1 或觸發外部動作的公開端點(`/trackXxx` 系列、`/registerReminder`、`/cancelReminder`、`/sendMessageToAuthor` 等)跟後台端點,也都各自掛了流量限制(每分鐘 5~60 次不等,依端點的敏感/成本程度而定),見 `worker/src/index.js` 的 `rateLimitOrNull()`。

## ⚡ 靜態資源快取

`style.css` / `icons/` 走 `_headers` 設定的長效快取(`Cache-Control: max-age=...`),搭配 `index.html`/`admin.html` 裡既有的 `?v=` 版號機制:內容有改就要同步更新版號,不然使用者會吃到快取住的舊檔案。`script.js` 因為近期改動較頻繁,暫時從 `_headers` 移除長效快取設定,只靠 `?v=` 版號控制。

圖示從 cdnjs 載入完整的 Font Awesome 套件(`https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.2/css/all.min.css`),`fa-` class 可以直接照官方圖示庫用,不用再手動維護子集檔案;每個頁面的這個 `<link>` 都加了 `integrity`(SRI)屬性防中介竄改。**升級 Font Awesome 版本時要記得同步更新這個 hash**,不然版本號改了但 hash 沒換,瀏覽器會因為內容跟簽章對不上而整份擋掉、圖示全部消失——可以下載新版 `all.min.css` 自己算:`openssl dgst -sha384 -binary all.min.css | openssl base64 -A`。

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
QUERY_TOKEN_SECRET=your-own-random-string          # /queryClasses 防濫用用的 token 簽名密鑰,見上方「防濫用機制」章節
```

你也需要自己在 Cloudflare 建立一個 D1 資料庫跟一個 KV namespace,並把 `worker/wrangler.toml` 裡對應的 `database_id`/`id` 換成你自己的:

```bash
npx wrangler d1 create worldgym-schedule
npx wrangler kv namespace create QUERY_RATE_LIMIT
```

接著啟動本機開發伺服器:

```bash
npm run dev
```

`npm run dev` 跑的是 `wrangler dev --remote`,D1/KV 都是直接連正式站的資料庫,不是本機模擬版——本機開發時的每一次讀寫都會真的動到正式資料,測試資料會混進正式資料裡,要注意。

### 3. 部署

```bash
# 部署 API
cd worker && npm run deploy

# 部署前端靜態站到 Cloudflare Pages(唯一正確的前端部署目標,發布到 https://worldgym.pages.dev)
cd hosting && npx wrangler pages deploy .. --project-name worldgym --branch main
```

`hosting/wrangler.jsonc` 是另一套 Workers Assets 設定(`name: "worldgym-web"`),曾經對應一個叫 `worldgym-web.lions2100.workers.dev` 的 Worker,但那個 Worker 已經刪除、不再使用——**不要用 `npx wrangler deploy` 部署到它**,那不會更新到 `worldgym.pages.dev` 這個實際在跑的網站,只會白白部署到一個沒人在看的地方。

部署前端會把整個 repo 根目錄(`.assetsignore` 排除 `worker/`/`hosting/`/`node_modules` 等)當成靜態資源整批發布——發的是**當下工作目錄的檔案內容**,不是 git HEAD,部署前要注意根目錄下有沒有其他還沒 commit 的檔案,因為它們會一起被發布上線。

`VAPID_PRIVATE_KEY` 跟 `QUERY_TOKEN_SECRET` 都是機密,不放在 `wrangler.toml`,部署前要先設成 Cloudflare Worker 的 secret(只需做一次;`QUERY_TOKEN_SECRET` 沒設定的話,`/queryClasses` 會直接變成 500,記得先設再部署):

```bash
cd worker
npx wrangler secret put VAPID_PRIVATE_KEY
npx wrangler secret put QUERY_TOKEN_SECRET
```

## 📄 授權

[MIT License](LICENSE)
