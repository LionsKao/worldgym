import { queryClasses } from "../../worker/src/queryClasses.js";
import BRANCHES from "../../worker/src/branches-seed.js";
import {
  SSR_BRANCH_SLUGS,
  FRAGMENT_CACHE_SECONDS,
  D1_TIMEOUT_MS,
  RESULT_COUNT_WARN_LIMIT,
  IGNORED_PARAM_PATTERN,
} from "./ssrConfig.js";

const SITE_ORIGIN = "https://worldgym.pages.dev";
const WEEKDAY_LABEL = { 1: "一", 2: "二", 3: "三", 4: "四", 5: "五", 6: "六", 7: "日" };

// branch 網址短代碼 = branches-seed.js 陣列的位置（跟 script.js 的 BRANCH_SLUG_ORDER 同一個順序，
// 這份順序只能往後附加，不能插入或調換，不然舊的分享網址會指到別間分店）。
const BRANCH_BY_SLUG = new Map(BRANCHES.map((b, i) => [b.slug, { ...b, code: String(i) }]));
const SLUG_BY_CODE = new Map(BRANCHES.map((b, i) => [String(i), b.slug]));
const SSR_SLUGS = new Set(SSR_BRANCH_SLUGS);

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

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("D1 查詢逾時")), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
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
      `<li>${c.startTime.slice(0, 2)}:${c.startTime.slice(2)} ${escapeHtml(c.className)}｜${escapeHtml(c.teacherName)}</li>`
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
  return { fragment: { blockHtml: renderBlock(branch, fixedRows, result.oldestScrapedAt) }, status: "miss" };
}

// 片段快取：只快取查 D1 的結果，不快取整份 HTML，index.html 一部署就是最新的。
// key 用正規化後的 /_ssr/{slug}，不同的 query 寫法（slug/短代碼、參數順序、utm）共用同一份。
export async function getFragment(context, branch) {
  const cache = caches.default;
  const cacheKey = new Request(`${SITE_ORIGIN}/_ssr/${branch.slug}`);
  try {
    const hit = await cache.match(cacheKey);
    if (hit) return { fragment: await hit.json(), status: "hit" };
  } catch (e) {
    console.error("SSR 片段快取讀取失敗", e);
  }
  try {
    const { fragment, status } = await buildFragment(context.env, branch);
    if (fragment) {
      const body = new Response(JSON.stringify(fragment), {
        headers: { "Content-Type": "application/json", "Cache-Control": `public, max-age=${FRAGMENT_CACHE_SECONDS}` },
      });
      context.waitUntil(cache.put(cacheKey, body).catch((e) => console.error("SSR 片段快取寫入失敗", e)));
    }
    return { fragment, status };
  } catch (e) {
    console.error("SSR 片段查詢失敗，退回原頁", e);
    return { fragment: null, status: `error: ${String(e && e.message).slice(0, 80)}` };
  }
}

// 改寫 <title>、description、og/twitter、canonical，並把課表區塊放進 #loadingOverlay：
// overlay 是不透明、固定全螢幕的載入遮罩，init() 結束時會整個 remove()，區塊跟著消失，
// 使用者畫面與沒注入時一致（不會有重複的課表，也不會位移）。
export function rewriteHtml(response, branch, fragment) {
  const title = `World Gym ${branch.name} 分店（${branch.region}）團體課表｜課表查詢`;
  const ogTitle = `World Gym ${branch.name} 分店團體課表`;
  const description = `World Gym ${branch.name} 分店（${branch.region}）團體教室每週課表：依星期列出上課時間、課程與老師，資料每日更新。`;
  const canonical = `${SITE_ORIGIN}/?branch=${branch.code}&room=1`;
  const setContent = (value) => ({ element(el) { el.setAttribute("content", value); } });
  const rewritten = new HTMLRewriter()
    .on("title", { element(el) { el.setInnerContent(title); } })
    .on('meta[name="description"]', setContent(description))
    .on('meta[property="og:title"]', setContent(ogTitle))
    .on('meta[property="og:description"]', setContent(description))
    .on('meta[property="og:url"]', setContent(canonical))
    .on('meta[name="twitter:title"]', setContent(title))
    .on('meta[name="twitter:description"]', setContent(description))
    .on('link[rel="canonical"]', { element(el) { el.setAttribute("href", canonical); } })
    .on("#loadingOverlay", { element(el) { el.append(fragment.blockHtml, { html: true }); } })
    .transform(response);
  // 內容已經跟原本的靜態檔不同，不能沿用它的 ETag/Last-Modified（瀏覽器/爬蟲拿舊驗證碼回來問會得到 304，卡在舊內容）。
  const headers = new Headers(rewritten.headers);
  headers.delete("ETag");
  headers.delete("Last-Modified");
  headers.set("Cache-Control", "public, max-age=0, must-revalidate");
  return new Response(rewritten.body, { status: rewritten.status, headers });
}
