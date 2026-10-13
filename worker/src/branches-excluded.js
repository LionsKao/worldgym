// 官網有分店頁、但「刻意不收」的分店（slug 對應官網 find-a-club/{slug}）。
//
// 本站只提供「不用付費的團體課程」查詢，所以排除 Express 店，以及只有付費課程（例如 Studio X 小班課）的分店。
// 每月分店掃描（branchScan.js）會跳過這裡的網址，只通知「真正新出現、既不在 branches-seed.js、
// 也不在這份清單」的網址，不然每個月的 Teams 通知都會重複列出這幾十個，真正新開的分店反而被淹沒。
//
// 官網出現新網址、收到 Teams 通知時怎麼處理：
//   - 要收（有不用付費的團課）：加進 branches-seed.js（流程見 CLAUDE.md）
//   - 不收：加進下面的 EXCLUDED_BRANCHES 並寫上理由
// npm run check:branches 會檢查同一個 slug 不能同時在 seed 與這份清單裡。
//
// 下面是 2026-10-13 逐一查證（用跟爬蟲相同的課表請求，查當週 10/13–10/19）的結果：
const STUDIO_X = "只有 Studio X 付費小班課";
const EMPTY_SCHEDULE = "有課表頁但沒有任何課（Express 或尚未開幕）";
const NO_SCHEDULE_PAGE = "沒有課表頁（Express 或尚未開幕）";

export const EXCLUDED_BRANCHES = {
  // 只有 Studio X 付費小班課（新竹光復店；台北光復店是另一間，有免費團課，已收錄為 taipei-guangfu）
  "hsinchu-guangfu": STUDIO_X,
  "new-taipei-sanchong-wuhua": STUDIO_X,
  "taichung-tanzi": STUDIO_X,

  // 有課表頁，但當週沒有任何課
  "hsinchu-zhulian": EMPTY_SCHEDULE,
  "kaohsiung-boai": EMPTY_SCHEDULE,
  "kaohsiung-fengshan-wenheng": EMPTY_SCHEDULE,
  "kaohsiung-nanzi": EMPTY_SCHEDULE,
  "kaohsiung-nanzi-xingnan": EMPTY_SCHEDULE,
  "new-taipei-luzhou": EMPTY_SCHEDULE,
  "new-taipei-sanxia": EMPTY_SCHEDULE,
  "new-taipei-taishan": EMPTY_SCHEDULE,
  "new-taipei-tucheng-zhongyang": EMPTY_SCHEDULE,
  "pingtung-donggang": EMPTY_SCHEDULE,
  "pingtung-fengjia": EMPTY_SCHEDULE,
  "taichung-dali-zhongxing": EMPTY_SCHEDULE,
  "taichung-dongxing": EMPTY_SCHEDULE,
  "taichung-jinhua-north": EMPTY_SCHEDULE,
  "taichung-tunghai": EMPTY_SCHEDULE,
  "taichung-wenxin": EMPTY_SCHEDULE,
  "tainan-zhonghua-west": EMPTY_SCHEDULE,
  "taipei-dazhi-beian": EMPTY_SCHEDULE,
  "taipei-jingmei": EMPTY_SCHEDULE,
  "taipei-lishui": EMPTY_SCHEDULE,
  "taipei-minquan-west": EMPTY_SCHEDULE,
  "taipei-muzha": EMPTY_SCHEDULE,
  "taipei-neihu-xingyun": EMPTY_SCHEDULE,
  "taipei-ningxia": EMPTY_SCHEDULE,
  "taipei-tonghua": EMPTY_SCHEDULE,
  "taoyuan-dayuan": EMPTY_SCHEDULE,
  "taoyuan-nankan": EMPTY_SCHEDULE,
  "taoyuan-zhongli-zhongshan": EMPTY_SCHEDULE,

  // 沒有課表頁（請求課表只回網頁、不是課表資料）
  "caotun": NO_SCHEDULE_PAGE,
  "chiayi-xingye-west": NO_SCHEDULE_PAGE,
  "tainan-changrong": NO_SCHEDULE_PAGE,
  "tainan-guobing": NO_SCHEDULE_PAGE,
  "taipei-taipei-sanxia": NO_SCHEDULE_PAGE,
  "taipei-xike": NO_SCHEDULE_PAGE,
};

// 已收進 branches-seed.js、但官網 sitemap 目前還沒有的分店（預售中，開幕前官網還沒建分店頁）。
// 月度掃描不把它們當成「疑似下架」；官網一建立分店頁、有了課表，爬蟲就會自動抓進來。
// 它們出現在 sitemap 之後這裡的項目就沒作用了，可以順手刪掉。
export const EXPECTED_MISSING_FROM_SITEMAP = {
  "taoyuan-yiwen": "桃園藝文：預售中，官網尚未建立分店頁（2026-10-13）",
};
