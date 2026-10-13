import BRANCHES from "../../worker/src/branches-seed.js";

// 站台網址：canonical、sitemap、llms.txt、JSON-LD、快取 key 都用這一個。
export const SITE_ORIGIN = "https://worldgym.pages.dev";

// 伺服器端注入課表的設定。目前涵蓋 branches-seed.js 裡的全部分店（新增分店會自動納入）。
// 想縮小範圍（例如只開放部分分店）時，把下面改成明確的 slug 陣列即可；沒列在這裡的分店網址
// 完全維持原樣，不查 D1、不改 HTML。
export const SSR_BRANCH_SLUGS = BRANCHES.map((b) => b.slug);

// 課表一天只更新兩次（台灣時間 03:00、17:00），片段快取 30 分鐘，最多落後半小時。
export const FRAGMENT_CACHE_SECONDS = 1800;
// D1 查詢逾時：超過就放棄注入、回傳原本的頁面，不讓 D1 變慢拖累首頁載入。
export const D1_TIMEOUT_MS = 1500;
// 跟 script.js 的 RESULT_COUNT_WARN_LIMIT 對齊：前端超過這個筆數整包不渲染，伺服器端也不注入。
export const RESULT_COUNT_WARN_LIMIT = 250;

// 網址上這些參數跟課表內容無關（追蹤、PWA 模式），正規化時忽略，不影響是否注入、也不影響快取 key。
export const IGNORED_PARAM_PATTERN = /^(utm_[a-z_]+|pwa|fbclid|gclid)$/i;
