import { queryClasses } from "../../worker/src/queryClasses.js";
import {
  SITE_ORIGIN,
  FRAGMENT_CACHE_SECONDS,
  D1_TIMEOUT_MS,
  RESULT_COUNT_WARN_LIMIT,
  IGNORED_PARAM_PATTERN,
} from "./ssrConfig.js";
import { branchUrlParam } from "./branchUrl.js";
import { BRANCH_BY_SLUG, SLUG_BY_CODE, SSR_SLUGS } from "./branches.js";
import { withTimeout, cacheRequest, cacheGet, cachePut } from "./util.js";

const WEEKDAY_LABEL = { 1: "一", 2: "二", 3: "三", 4: "四", 5: "五", 6: "六", 7: "日" };

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
}

// 只有「單一分店 + room=1」（追蹤類參數除外）才會注入，其餘網址回傳 null，由呼叫端原樣放行。
// branch 接受短代碼或 slug，兩種寫法都會正規化成同一個目標（canonical 一律用短代碼）。
export function resolveSsrTarget(url) {
  const entries = [...url.searchParams].filter(([key]) => !IGNORED_PARAM_PATTERN.test(key));
  if (entries.length !== 2) return null;
  const branchValues = entries.filter(([key]) => key === "branch").map(([, v]) => v);
  const roomValues = entries.filter(([key]) => key === "room").map(([, v]) => v);
  if (branchValues.length !== 1 || roomValues.length !== 1 || roomValues[0] !== "1") return null;
  const slug = SLUG_BY_CODE.get(branchValues[0]) ?? (BRANCH_BY_SLUG.has(branchValues[0]) ? branchValues[0] : null);
  if (!slug || !SSR_SLUGS.has(slug)) return null;
  return BRANCH_BY_SLUG.get(slug);
}

// oldestScrapedAt 是 nowTaiwanIso() 產生的 "YYYY-MM-DDTHH:mm:ss.sss+08:00"，直接切字串，不經過 Date（會變裝置時區）。
function formatScrapedAt(iso) {
  const [datePart, timePart] = iso.split("T");
  return `${datePart.replaceAll("-", "/")} ${timePart.slice(0, 5)}`;
}

// 課程/老師名稱來自爬官網的資料，一律跳脫後才拼進 HTML。
function renderBlock(branch, rows, oldestScrapedAt) {
  const byDay = new Map();
  for (const { c } of rows) {
    if (!byDay.has(c.dayOfWeek)) byDay.set(c.dayOfWeek, []);
    byDay.get(c.dayOfWeek).push(c);
  }
  const days = [...byDay.keys()].sort((a, b) => a - b).map((day) => {
    const items = byDay.get(day).map((c) =>
      `<li>${escapeHtml(c.startTime.slice(0, 2))}:${escapeHtml(c.startTime.slice(2))} ${escapeHtml(c.className)}｜${escapeHtml(c.teacherName)}</li>`
    ).join("");
    return `<h3>週${WEEKDAY_LABEL[day]}</h3><ul>${items}</ul>`;
  }).join("");
  const updated = oldestScrapedAt
    ? `<p>資料更新：<time datetime="${escapeHtml(oldestScrapedAt)}">${escapeHtml(formatScrapedAt(oldestScrapedAt))}</time>（台灣時間）</p>`
    : "";
  return `<section id="ssr-schedule" class="visually-hidden"><h2>World Gym ${escapeHtml(branch.name)} 分店（${escapeHtml(branch.region)}）團體課表</h2>${updated}${days}</section>`;
}

// 查 D1（不含代課：flagged 的是 8~14 天後的代課，帶日期、很快過期，不放進會被快取的 HTML）。
// 回傳 { fragment, status }：查不到、超量或出錯 fragment 為 null，呼叫端就原樣放行；
// status 只用來寫進 X-SSR-Status 回應標頭，方便從外面排查為什麼沒注入。
async function buildFragment(env, branch) {
  const result = await withTimeout(queryClasses(env.DB, { branch: [branch.slug], room: ["團體教室"] }), D1_TIMEOUT_MS);
  if (result.rows.length === 0) return { fragment: null, status: "no-data" };
  if (result.rows.length > RESULT_COUNT_WARN_LIMIT) return { fragment: null, status: "too-many" };
  const fixedRows = result.rows.filter((row) => !row.flagged);
  if (fixedRows.length === 0) return { fragment: null, status: "no-fixed" };
  return { fragment: { blockHtml: renderBlock(branch, fixedRows, result.oldestScrapedAt), scrapedAt: result.oldestScrapedAt }, status: "miss" };
}

// 片段快取：只快取查 D1 的結果，不快取整份 HTML，index.html 一部署就是最新的。
// key 用正規化後的 /_ssr/v2/{slug}（見 util.js 的 cacheRequest），不同的 query 寫法（slug/短代碼、參數順序、utm）共用同一份。
// 讀取時仍容忍快取裡的片段沒有 scrapedAt 欄位（缺的話 JSON-LD 就不輸出 dateModified）。
export async function getFragment(context, branch) {
  const cacheKey = cacheRequest(branch.slug);
  const cached = await cacheGet(cacheKey, "SSR 片段", (response) => response.json());
  if (cached) return { fragment: cached, status: "hit" };
  try {
    const { fragment, status } = await buildFragment(context.env, branch);
    if (fragment) {
      const body = new Response(JSON.stringify(fragment), {
        headers: { "Content-Type": "application/json", "Cache-Control": `public, max-age=${FRAGMENT_CACHE_SECONDS}` },
      });
      cachePut(context, cacheKey, body, "SSR 片段");
    }
    return { fragment, status };
  } catch (e) {
    console.error("SSR 片段查詢失敗，退回原頁", e);
    // 狀態只回固定字串，不帶例外訊息：X-SSR-Status 是公開的回應標頭，訊息可能含 D1 / 內部細節；詳細內容已經在上面 console.error 記了。
    return { fragment: null, status: "error" };
  }
}

// 分店頁的 title / description / canonical：rewriteHtml（改寫 HTML）與 buildBranchJsonLd（JSON-LD）共用這一份，
// 不各自拼字串，避免日後兩邊不同步。
function buildBranchMeta(branch) {
  return {
    title: `World Gym ${branch.name} 分店（${branch.region}）團體課表｜課表查詢`,
    ogTitle: `World Gym ${branch.name} 分店團體課表`,
    description: `World Gym ${branch.name} 分店（${branch.region}）團體教室每週課表：依星期列出上課時間、課程與老師，資料每日更新。`,
    // slug 版 canonical（見 branchUrl.js）；短代碼與 slug 兩種寫法的舊網址都會得到同一個 canonical。
    canonical: `${SITE_ORIGIN}/?branch=${branchUrlParam(branch.slug, branch.code)}&room=1`,
  };
}

// 首頁 JSON-LD 的 WebSite 節點，原樣沿用（要跟 index.html 的 @graph 裡那個節點保持一致）。
const WEBSITE_NODE = {
  "@type": "WebSite",
  "@id": `${SITE_ORIGIN}/#website`,
  name: "課表查詢",
  alternateName: "WG課表查詢",
  url: `${SITE_ORIGIN}/`,
  description: "快速查詢 World Gym（WG）各分店課表、老師、時段。",
  inLanguage: "zh-TW",
};

// scrapedAt 是台灣時間且帶 +08:00 後綴的 ISO 8601 字串（見 CLAUDE.md 的時間戳慣例），直接沿用，不經過 Date。
const ISO_8601_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

// 分店頁的 JSON-LD（回傳 JSON 字串）：刻意只用 WebSite + WebPage，不輸出 ExerciseGym / LocalBusiness / Event /
// Course / ItemList / BreadcrumbList，也不輸出地址、電話、座標、評分——課表區塊是視覺隱藏的（結構化資料要與可見
// 內容相符），而且不能替真實的健身房建立實體。所有 UA 拿到的內容完全相同。
export function buildBranchJsonLd(branch, scrapedAt) {
  const { title, description, canonical } = buildBranchMeta(branch);
  const webPage = {
    "@type": "WebPage",
    "@id": `${canonical}#webpage`,
    url: canonical,
    name: title,
    description,
    inLanguage: "zh-TW",
    isPartOf: { "@id": WEBSITE_NODE["@id"] },
  };
  if (typeof scrapedAt === "string" && ISO_8601_PATTERN.test(scrapedAt)) webPage.dateModified = scrapedAt;
  // "<" 跳脫成 \u003c（JSON 裡等同 "<"）：分店名稱若含 </script> 之類字元，不會破壞 HTML。
  return JSON.stringify({ "@context": "https://schema.org", "@graph": [WEBSITE_NODE, webPage] }).replace(/</g, "\\u003c");
}

// 改寫 <title>、description、og/twitter、canonical、JSON-LD，並把課表區塊放進 #loadingOverlay：
// overlay 是不透明、固定全螢幕的載入遮罩，init() 結束時會整個 remove()，區塊跟著消失，
// 使用者畫面與沒注入時一致（不會有重複的課表，也不會位移）。
export function rewriteHtml(response, branch, fragment) {
  const { title, ogTitle, description, canonical } = buildBranchMeta(branch);
  const setContent = (value) => ({ element(el) { el.setAttribute("content", value); } });
  let jsonLd = null;
  try {
    jsonLd = buildBranchJsonLd(branch, fragment.scrapedAt);
  } catch (e) {
    console.error("分店 JSON-LD 產生失敗，沿用首頁的", e);
  }
  let jsonLdSeen = 0;
  const rewriter = new HTMLRewriter()
    .on("title", { element(el) { el.setInnerContent(title); } })
    .on('meta[name="description"]', setContent(description))
    .on('meta[property="og:title"]', setContent(ogTitle))
    .on('meta[property="og:description"]', setContent(description))
    .on('meta[property="og:url"]', setContent(canonical))
    .on('meta[name="twitter:title"]', setContent(title))
    .on('meta[name="twitter:description"]', setContent(description))
    .on('link[rel="canonical"]', { element(el) { el.setAttribute("href", canonical); } })
    .on("#loadingOverlay", { element(el) { el.append(fragment.blockHtml, { html: true }); } });
  // 第一個 JSON-LD 換成分店版（html:true 才不會把 JSON 內容再做 HTML 跳脫），其餘移除，確保分店頁只剩一個。
  if (jsonLd) {
    rewriter.on('script[type="application/ld+json"]', {
      element(el) {
        jsonLdSeen += 1;
        if (jsonLdSeen === 1) el.setInnerContent(jsonLd, { html: true });
        else el.remove();
      },
    });
  }
  const rewritten = rewriter.transform(response);
  // 內容已經跟原本的靜態檔不同，不能沿用它的 ETag/Last-Modified（瀏覽器/爬蟲拿舊驗證碼回來問會得到 304，卡在舊內容）。
  const headers = new Headers(rewritten.headers);
  headers.delete("ETag");
  headers.delete("Last-Modified");
  headers.set("Cache-Control", "public, max-age=0, must-revalidate");
  return new Response(rewritten.body, { status: rewritten.status, headers });
}
