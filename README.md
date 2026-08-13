# World Gym 課表查詢

查詢 World Gym 台灣各分店團體課表的網站,前端是純靜態頁面,後端用 Cloudflare Worker + D1 資料庫,課表資料每天自動從官網重新抓取。

線上版本:
- Hosting: https://worldgym.pages.dev
- API: https://worldgym-api.lions2100.workers.dev

## 架構

```
.
├── index.html / script.js / style.css   # 前端:課表查詢頁
├── admin.html / admin.js                # 後台:手動觸發重抓、查看爬蟲紀錄
├── branches.json                        # 分店清單快取(前端用)
├── hosting/                             # Cloudflare Workers 靜態託管設定(wrangler)
└── worker/                              # Cloudflare Worker API
    ├── src/index.js                     # 路由 / CORS / 入口
    ├── src/queryClasses.js              # 課表查詢邏輯
    ├── src/scrape.js                    # 爬蟲邏輯(重抓官網課表寫入 D1)
    └── src/branches-seed.js             # 分店清單固定資料(slug 對應官網 find-a-club/{slug})
```

前端呼叫 `worker/` 部署出來的 API(`/queryClasses` 等端點),API 讀寫 Cloudflare D1(`worldgym-schedule` 資料庫)。目前沒有排程機制自動每日爬蟲,重抓要透過 `admin.html` 手動觸發。

## 本機開發

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

## 授權

[MIT License](LICENSE)
