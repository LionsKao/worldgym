// 官網有分店頁、但「刻意不收」的分店（slug 對應官網 find-a-club/{slug}）。
//
// 本站只提供「不用付費的團體課程」查詢，所以排除 Express 店（沒有免費團課，有的只有 Studio X 付費小班課）。
// 每月分店掃描（branchScan.js）會跳過這裡的網址，只通知「真正新出現、既不在 branches-seed.js、
// 也不在這份清單」的網址，不然每個月的 Teams 通知都會重複列出這幾十個，真正新開的分店反而被淹沒。
//
// 官網出現新網址、收到 Teams 通知時怎麼處理：
//   - 要收（有不用付費的團課）：加進 branches-seed.js（流程見 CLAUDE.md）
//   - 不收：加進下面的 EXCLUDED_BRANCHES 並寫上理由
// npm run check:branches 會檢查同一個 slug 不能同時在 seed 與這份清單裡。
//
// 下面是 2026-10-13 的結果：先用跟爬蟲相同的課表請求逐一查證（當週 10/13–10/19），
// 再經網站擁有者確認——除了 caotun（草屯店的別名網址，見下）之外，其餘 36 間都是 Express。
// Express 不會有免費團課，所以不收的分店不需要定期重新檢查。
const EXPRESS_STUDIO_X = "Express（只有 Studio X 付費小班課）";
const EXPRESS_EMPTY = "Express（官網有課表頁但沒有任何課）";
const EXPRESS_NO_PAGE = "Express（官網沒有課表頁）";

export const EXCLUDED_BRANCHES = {
  // 官網同一間分店有兩個網址：草屯店（World Gym 南投草屯店）的完整頁是 nantou-caotun，已收錄；
  // sitemap 裡另有一個頁面內容相同、但較精簡的 caotun，是別名，不是另一間分店
  "caotun": "草屯店的別名網址，同一間分店已用 nantou-caotun 收錄",

  // Express，另有 Studio X 付費小班課（新竹光復店；台北光復店是另一間，有免費團課，已收錄為 taipei-guangfu）
  "hsinchu-guangfu": EXPRESS_STUDIO_X,
  "new-taipei-sanchong-wuhua": EXPRESS_STUDIO_X,
  "taichung-tanzi": EXPRESS_STUDIO_X,

  // Express，有課表頁但當週沒有任何課
  "hsinchu-zhulian": EXPRESS_EMPTY,
  "kaohsiung-boai": EXPRESS_EMPTY,
  "kaohsiung-fengshan-wenheng": EXPRESS_EMPTY,
  "kaohsiung-nanzi": EXPRESS_EMPTY,
  "kaohsiung-nanzi-xingnan": EXPRESS_EMPTY,
  "new-taipei-luzhou": EXPRESS_EMPTY,
  "new-taipei-sanxia": EXPRESS_EMPTY,
  "new-taipei-taishan": EXPRESS_EMPTY,
  "new-taipei-tucheng-zhongyang": EXPRESS_EMPTY,
  "pingtung-donggang": EXPRESS_EMPTY,
  "pingtung-fengjia": EXPRESS_EMPTY,
  "taichung-dali-zhongxing": EXPRESS_EMPTY,
  "taichung-dongxing": EXPRESS_EMPTY,
  "taichung-jinhua-north": EXPRESS_EMPTY,
  "taichung-tunghai": EXPRESS_EMPTY,
  "taichung-wenxin": EXPRESS_EMPTY,
  "tainan-zhonghua-west": EXPRESS_EMPTY,
  "taipei-dazhi-beian": EXPRESS_EMPTY,
  "taipei-jingmei": EXPRESS_EMPTY,
  "taipei-lishui": EXPRESS_EMPTY,
  "taipei-minquan-west": EXPRESS_EMPTY,
  "taipei-muzha": EXPRESS_EMPTY,
  "taipei-neihu-xingyun": EXPRESS_EMPTY,
  "taipei-ningxia": EXPRESS_EMPTY,
  "taipei-tonghua": EXPRESS_EMPTY,
  "taoyuan-dayuan": EXPRESS_EMPTY,
  "taoyuan-nankan": EXPRESS_EMPTY,
  "taoyuan-zhongli-zhongshan": EXPRESS_EMPTY,

  // 沒有課表頁（請求課表只回網頁、不是課表資料）
  "chiayi-xingye-west": EXPRESS_NO_PAGE,
  "tainan-changrong": EXPRESS_NO_PAGE,
  "tainan-guobing": EXPRESS_NO_PAGE,
  "taipei-taipei-sanxia": EXPRESS_NO_PAGE,
  "taipei-xike": EXPRESS_NO_PAGE,
};

// 已收進 branches-seed.js、但官網 sitemap 目前還沒有的分店（預售中，開幕前官網還沒建分店頁）。
// 月度掃描不把它們當成「疑似下架」；官網一建立分店頁、有了課表，爬蟲就會自動抓進來。
// 它們出現在 sitemap 之後這裡的項目就沒作用了，可以順手刪掉。
export const EXPECTED_MISSING_FROM_SITEMAP = {
  "taoyuan-yiwen": "桃園藝文：預售中、還沒蓋好，官網尚未建立分店頁，開始營業後才會有課表（2026-10-13 由網站擁有者確認）",
};
