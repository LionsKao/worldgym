# GA4 事件清單

前端 `script.js` 透過 `trackEvent()` / `trackEventOncePerSession()` 送出的自訂 GA4 事件，依觸發情境分類整理。所有事件名稱都是 snake_case 英文（GA4 事件名不能用中文），events 沒有另外接 GTM。

## 課表查詢

| 事件名稱 | 觸發時機 | 參數 |
| --- | --- | --- |
| `search_schedule` | 按下查詢按鈕後，**真正成功顯示結果頁**才算（查無結果、超量警告、逾時/限流/伺服器錯誤都不算）| `branch_count` 分店數、`has_teacher`/`has_course` 是否有指定、`day_count` 星期數、`trigger_source` 觸發來源（`manual`/`favorite` 等）|
| `reset_filters` | 按下「清除所有篩選條件」| 無 |
| `select_all_branch` | 用「全選」勾選某縣市/區域全部分店 | `city_name` 縣市或區域名稱 |
| `select_teacher_filter`（每個老師每個 session 只送一次）| 在老師篩選網格勾選某位老師 | `teacher_name` |
| `filter_by_teacher`（每個老師每個 session 只送一次）| 從結果列表點課程上的老師名字，直接套用該老師篩選 | `teacher_name` |
| `geo_filter_click` | 按下「附近分店」定位篩選按鈕 | `radius_km` 篩選半徑 |
| `geo_filter_apply` | 定位成功並套用附近分店篩選 | `radius_km`、`matched_count` 符合的分店數 |
| `geo_filter_error` | 定位失敗（權限拒絕、逾時等）| `radius_km`、`error_code`（`GeolocationPositionError.code`）|

## 我的最愛

| 事件名稱 | 觸發時機 | 參數 |
| --- | --- | --- |
| `add_favorite` | 把目前篩選條件存成一筆最愛 | `favorite_label` 最愛名稱 |
| `apply_favorite`（每個最愛每個 session 只送一次）| 點某個已存的最愛套用篩選 | `favorite_label` |

## 課前推播提醒

| 事件名稱 | 觸發時機 | 參數 |
| --- | --- | --- |
| `register_reminder` | 成功登記某堂課的推播提醒 | `class_name`、`teacher_name` |
| `cancel_reminder` | 取消提醒，來源分結果頁鈴鐺 / 提醒清單頁兩種 | `class_name`、`teacher_name`、`source`（`result_bell`/`reminder_list`）|
| `notify_permission_prompt` | 因為瀏覽器推播權限還沒開，彈出權限說明彈窗 | 無 |
| `notify_permission_blocked_retry` | 權限已被封鎖（`denied`）時，使用者仍點了「開啟通知」按鈕 | 無 |
| `notify_permission_result` | 瀏覽器推播權限請求跳出後使用者做出的選擇 | `result`（`granted`/`denied`/`default`）|
| `open_reminder_list` | 打開「已登記提醒清單」頁面 | 無 |

## 廣告輪播

| 事件名稱 | 觸發時機 | 參數 |
| --- | --- | --- |
| `click_ad_banner` | 點擊首頁廣告輪播 banner | `ad_text` banner 文字內容 |

（注：曝光/點擊本身另外用 `trackAdEvent()` 打進自家 `/trackAd` API 存 D1，不是這裡列的 GA4 事件。）

## 分享 / 複製

| 事件名稱 | 觸發時機 | 參數 |
| --- | --- | --- |
| `copy_results` | 複製查詢結果文字到剪貼簿 | `result_count` 複製的課程筆數 |
| `share_url` | 複製目前篩選條件的分享網址 | 無 |
| `copy_site_url` | 複製網站首頁網址（帶 `utm_source=website_link`）| 無 |
| `open_qr_code` | 打開網站 QR Code 顯示 | 無 |

## 其他

| 事件名稱 | 觸發時機 | 參數 |
| --- | --- | --- |
| `click_github_icon` | 點擊頁面上的 GitHub 連結圖示 | 無 |
| `click_admin_icon` | 點擊頁面上的後台管理連結圖示 | 無 |
| `clear_memory` | 按下「清除本機資料」確認鈕（清空 `localStorage` 並重新整理）| 無 |
| `send_message` | 透過「留言給站長」功能送出訊息成功 | 無 |
