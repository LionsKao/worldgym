// 給搜尋引擎與 AI 看的分店網址（canonical、og:url、sitemap、JSON-LD、llms.txt）一律用 slug：
// /?branch=taipei-daan&room=1。短代碼（branches-seed.js 陣列位置）只保留給前端的分享網址與舊連結相容，
// 因為順序一變，舊的短代碼網址就會指到別間分店，而且不可讀。
// slug 目前都是小寫英文與連字號，所以不需要 encodeURIComponent；萬一日後出現其他字元（會讓網址出問題），
// 就退回短代碼，不要輸出怪網址。
const SAFE_SLUG_PATTERN = /^[a-z0-9-]+$/;

export function branchUrlParam(slug, code) {
  return SAFE_SLUG_PATTERN.test(slug) ? slug : String(code);
}
