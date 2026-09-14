import { createHash, timingSafeEqual } from "node:crypto";
import { queryClasses } from "./queryClasses.js";
import { runScrape, cleanupStaleBranches } from "./scrape.js";
import { registerReminder, cancelReminder, listReminders, dispatchDueReminders } from "./reminders.js";
import { monthlyNameRanking, availableYears, monthlySearchTrend, favoriteStatsCombined, adStatsCombined, reminderStatsCombined, rollupAnalyticsEvents } from "./analytics.js";

// 網站是跨網域被呼叫，所以要自己開白名單。
// 之後如果掛了自訂網域，把新網域加進這個陣列即可。
const ALLOWED_ORIGINS = [
  "https://worldgym-19445.web.app",
  "https://worldgym-19445.firebaseapp.com",
  "https://worldgym.pages.dev",
  "http://localhost:5460", // firebase emulators:start 的 hosting port（舊）
  "http://127.0.0.1:5460",
  "http://localhost:5471", // 開發用純靜態伺服器（npx serve public，舊）
  "http://127.0.0.1:5471",
  "http://localhost:1069", // Cloudflare Workers 靜態託管本機模擬（hosting/ wrangler dev）
  "http://127.0.0.1:1069",
  "https://worldgym-api.lions2100.workers.dev",
];

// D1 裡的時間戳（含 ads 的 startAt/endAt）一律用台灣時間（+8），跟 scrape.js / reminders.js 的
// nowTaiwanIso() 同一套慣例——純位移 8 小時再貼 +08:00 後綴，這樣才能跟其他時間戳直接用字串比較/排序。
function nowTaiwanIso() {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  return d.toISOString().replace("Z", "+08:00");
}

// 回傳台灣「現在」的年/月，用來當作統計報表沒帶 year/month 參數時的預設值，
// 避免用 UTC 現在時間判斷「這個月」在台灣午夜前後 8 小時內會跟資料庫實際存的月份對不起來。
function currentTaiwanYearMonth() {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  return { year: String(d.getUTCFullYear()), month: String(d.getUTCMonth() + 1).padStart(2, "0") };
}

function corsHeaders(origin) {
  const headers = { "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, X-Query-Token, X-Admin-Token" };
  if (ALLOWED_ORIGINS.includes(origin)) headers["Access-Control-Allow-Origin"] = origin;
  return headers;
}

function json(data, status, origin) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
  });
}

// --- /queryClasses 防濫用：流量限制(KV) + 短效 HMAC token ---
// 只是拉高濫用成本，不是真的能擋住所有非瀏覽器直接呼叫（見 README 相關討論），
// 所以刻意選簡單、低成本的做法，不追求密碼學等級的嚴謹。

// 每 IP 每 60 秒窗口的請求次數上限打點，KV 帶 expirationTtl 自動過期，不用額外清理。
async function checkRateLimit(env, kvKeyPrefix, ip, limit, ctx) {
  const windowBucket = Math.floor(Date.now() / 60000);
  const key = `${kvKeyPrefix}:${ip}:${windowBucket}`;
  const current = parseInt((await env.QUERY_RATE_LIMIT.get(key)) || "0", 10);
  if (current >= limit) return false;
  ctx.waitUntil(env.QUERY_RATE_LIMIT.put(key, String(current + 1), { expirationTtl: 90 }));
  return true;
}

// 給其餘端點共用的簡化包裝：算 IP、檢查限流，超過就直接回傳 429 response，
// 沒超過回傳 null 讓呼叫端繼續往下走（`if (rl) return rl;`）。每個端點各自傳不同的 name 當 KV key 前綴。
async function rateLimitOrNull(req, env, ctx, name, limit, origin) {
  const ip = req.headers.get("CF-Connecting-IP") || "unknown";
  const allowed = await checkRateLimit(env, `rl:${name}`, ip, limit, ctx);
  return allowed ? null : json({ error: "rate_limited" }, 429, origin);
}

// /issueToken、/queryClasses 存取紀錄，事後才有辦法查是不是被爬蟲/腳本大量打（見 query_access_log）。
// 用 waitUntil 背景寫入，不擋回應。
function logQueryAccess(env, ctx, endpoint, ip, userAgent, rateLimited) {
  ctx.waitUntil(
    env.DB.prepare(
      "INSERT INTO query_access_log (endpoint, ip, userAgent, rateLimited, createdAt) VALUES (?, ?, ?, ?, ?)"
    ).bind(endpoint, ip, userAgent, rateLimited ? 1 : 0, nowTaiwanIso()).run()
  );
}

// 每月排程（見 scheduled()）清一次舊紀錄，避免這張純維運用途的表無限成長——
// /queryAccessStats 本身預設只查最近 7 天，90 天前的資料早就沒人在看，刪掉也不影響任何功能。
const QUERY_ACCESS_LOG_RETENTION_DAYS = 90;
async function cleanupOldQueryAccessLog(db) {
  const cutoff = new Date(Date.now() + 8 * 3600 * 1000 - QUERY_ACCESS_LOG_RETENTION_DAYS * 86400000)
    .toISOString()
    .replace("Z", "+08:00");
  const res = await db.prepare("DELETE FROM query_access_log WHERE createdAt < ?").bind(cutoff).run();
  return { deleted: res.meta.changes || 0 };
}

function base64url(bytes) {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function base64urlToBytes(str) {
  const b64 = str.replace(/-/g, "+").replace(/_/g, "/").padEnd(str.length + (4 - str.length % 4) % 4, "=");
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}
async function hmacKey(env) {
  return crypto.subtle.importKey(
    "raw", new TextEncoder().encode(env.QUERY_TOKEN_SECRET),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]
  );
}
// token 只放 exp（不綁 IP，手機網路常換 IP，綁了會誤傷正常使用者），效期 15 分鐘。
// 前端過期後會自動拿新 token 重試一次，見 script.js 的 runScheduleQuery。
async function issueQueryToken(env, ttlMs = 15 * 60 * 1000) {
  const payload = JSON.stringify({ exp: Date.now() + ttlMs });
  const key = await hmacKey(env);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return `${base64url(new TextEncoder().encode(payload))}.${base64url(sig)}`;
}
async function verifyQueryToken(env, token) {
  if (!token || typeof token !== "string" || !token.includes(".")) return { ok: false, reason: "token_invalid" };
  const [payloadPart, sigPart] = token.split(".");
  let payloadBytes, payload;
  try {
    payloadBytes = base64urlToBytes(payloadPart);
    payload = JSON.parse(new TextDecoder().decode(payloadBytes));
  } catch {
    return { ok: false, reason: "token_invalid" };
  }
  const key = await hmacKey(env);
  // 要驗證的是「當初被簽名的那份原始 payload bytes」，不是 base64url 編碼後的字串本身。
  const valid = await crypto.subtle.verify("HMAC", key, base64urlToBytes(sigPart), payloadBytes);
  if (!valid) return { ok: false, reason: "token_invalid" };
  if (typeof payload.exp !== "number" || Date.now() > payload.exp) return { ok: false, reason: "token_expired" };
  return { ok: true };
}

// --- 後台驗證：X-Admin-Token header 帶 MANUAL_SCRAPE_TOKEN ---
// 先各自雜湊成固定長度再用 timingSafeEqual 比較，不能直接 !== 字串比較——
// JS 字串比較是「比到第一個不同字元就提前返回」，理論上可被時間側channel慢慢猜出 token。
// 雜湊成固定長度也順便避開 timingSafeEqual 要求兩個 buffer 長度相同的限制。
const ADMIN_TOKEN_HEADER = "X-Admin-Token";
function constantTimeEqual(a, b) {
  const ha = createHash("sha256").update(String(a ?? "")).digest();
  const hb = createHash("sha256").update(String(b ?? "")).digest();
  return timingSafeEqual(ha, hb);
}
// 登入成功後換一張有效期限的簽章 session token，之後的請求都送這張，不用每次都把真正的密碼
// 傳一次（降低密碼在網路上被送出的次數）。簽章金鑰是從 MANUAL_SCRAPE_TOKEN 雜湊衍生出來、
// 不是直接拿密碼當 HMAC key，這樣就算 session token 外流也推不回密碼本身。
// isAdminRequest 兩種憑證都認：舊的直接帶密碼（相容既有呼叫方式）、新的帶 session token。
const ADMIN_SESSION_TTL_MS = 7 * 24 * 3600 * 1000; // 7 天，過期要重新輸入密碼
async function adminSessionKey(env) {
  const material = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`admin-session:${env.MANUAL_SCRAPE_TOKEN}`));
  return crypto.subtle.importKey("raw", material, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}
async function issueAdminSession(env, ttlMs = ADMIN_SESSION_TTL_MS) {
  const payload = JSON.stringify({ exp: Date.now() + ttlMs });
  const key = await adminSessionKey(env);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return `${base64url(new TextEncoder().encode(payload))}.${base64url(sig)}`;
}
async function verifyAdminSession(env, token) {
  if (!token || typeof token !== "string" || !token.includes(".")) return false;
  const [payloadPart, sigPart] = token.split(".");
  let payloadBytes, payload;
  try {
    payloadBytes = base64urlToBytes(payloadPart);
    payload = JSON.parse(new TextDecoder().decode(payloadBytes));
  } catch {
    return false;
  }
  const key = await adminSessionKey(env);
  const valid = await crypto.subtle.verify("HMAC", key, base64urlToBytes(sigPart), payloadBytes);
  if (!valid) return false;
  return typeof payload.exp === "number" && Date.now() <= payload.exp;
}
async function isAdminRequest(req, env) {
  const header = req.headers.get(ADMIN_TOKEN_HEADER);
  if (await verifyAdminSession(env, header)) return true;
  return constantTimeEqual(header, env.MANUAL_SCRAPE_TOKEN);
}

export default {
  async fetch(req, env, ctx) {
    // 只開放台灣 IP：cf.country 沒有值(如本機開發)就放行，避免擋掉自己測試。
    const country = req.cf?.country;
    if (country && country !== "TW") {
      return new Response("Forbidden", { status: 403 });
    }

    const origin = req.headers.get("Origin") || "";
    const url = new URL(req.url);

    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    try {
      // 發短效 token 給前端：頁面載入時預熱拿一次，之後查詢帶著這個 token 打 /queryClasses。
      // 這個端點本身也有流量限制（獨立 key 前綴），避免有人瘋狂打這個端點換無限張票。
      if (url.pathname === "/issueToken" && req.method === "GET") {
        const ip = req.headers.get("CF-Connecting-IP") || "unknown";
        const ua = req.headers.get("User-Agent") || "";
        const allowed = await checkRateLimit(env, "rl:issueToken", ip, 10, ctx);
        logQueryAccess(env, ctx, "issueToken", ip, ua, !allowed);
        if (!allowed) return json({ error: "rate_limited" }, 429, origin);
        const token = await issueQueryToken(env);
        return json({ token }, 200, origin);
      }

      if (url.pathname === "/queryClasses" && req.method === "POST") {
        const ip = req.headers.get("CF-Connecting-IP") || "unknown";
        const ua = req.headers.get("User-Agent") || "";
        const allowed = await checkRateLimit(env, "rl:queryClasses", ip, 20, ctx);
        logQueryAccess(env, ctx, "queryClasses", ip, ua, !allowed);
        if (!allowed) return json({ error: "rate_limited" }, 429, origin);

        const verification = await verifyQueryToken(env, req.headers.get("X-Query-Token"));
        if (!verification.ok) return json({ error: verification.reason }, 401, origin);

        const body = await req.json().catch(() => ({}));
        const result = await queryClasses(env.DB, body || {});
        return json(result, 200, origin);
      }

      // 首頁廣告輪播：只回傳目前在上下架時間內、且 enabled=1 的廣告，順序照 sortOrder。
      // id 要回傳出去，前端輪播才能標記「目前顯示的是哪一則廣告」，用來打曝光/點擊事件。
      if (url.pathname === "/ads" && req.method === "GET") {
        const rl = await rateLimitOrNull(req, env, ctx, "ads", 60, origin);
        if (rl) return rl;
        const now = nowTaiwanIso();
        const { results } = await env.DB.prepare(
          "SELECT id, text, url FROM ads WHERE enabled = 1 AND startAt <= ? AND endAt >= ? ORDER BY sortOrder"
        ).bind(now, now).all();
        return json({ ads: results }, 200, origin);
      }

      // 廣告曝光/點擊打點：訪客觸發的公開動作，不做身分驗證，只驗證 adId 真的存在、type 合法，
      // 避免寫入垃圾資料污染統計。
      if (url.pathname === "/trackAdEvent" && req.method === "POST") {
        const rl = await rateLimitOrNull(req, env, ctx, "trackAdEvent", 60, origin);
        if (rl) return rl;
        const body = await req.json().catch(() => ({}));
        const { adId, type } = body || {};
        if (type !== "impression" && type !== "click") {
          return json({ error: "invalid type" }, 400, origin);
        }
        const ad = await env.DB.prepare("SELECT 1 FROM ads WHERE id = ?").bind(adId).first();
        if (!ad) {
          return json({ error: "unknown adId" }, 400, origin);
        }
        await env.DB.prepare("INSERT INTO ad_events (adId, type, createdAt) VALUES (?, ?, ?)")
          .bind(adId, type, nowTaiwanIso())
          .run();
        return json({ ok: true }, 200, origin);
      }

      // 廣告曝光打點的 batch 版本：前端輪播每 5 秒攢一筆到記憶體，定時/離開頁面時才一次送一批
      // （見 script.js 的 flushAdImpressions），避免每次輪播都各自發一個 request + D1 寫入。
      // sendBeacon 送出的 body 是 text/plain，這裡用 req.text() 手動 parse 才能同時吃 fetch 跟 beacon 兩種來源。
      if (url.pathname === "/trackAdEvents" && req.method === "POST") {
        const rl = await rateLimitOrNull(req, env, ctx, "trackAdEvents", 20, origin);
        if (rl) return rl;
        const raw = await req.text();
        let body;
        try { body = JSON.parse(raw); } catch { body = {}; }
        const events = Array.isArray(body && body.events) ? body.events : [];
        const MAX_BATCH_EVENTS = 100;
        const valid = events
          .filter((e) => e && (e.type === "impression" || e.type === "click") && typeof e.adId === "string" && e.adId)
          .slice(0, MAX_BATCH_EVENTS);
        if (valid.length === 0) {
          return json({ ok: true, written: 0 }, 200, origin);
        }
        // 一次查出這批事件裡出現過的 adId 誰是合法的，取代逐筆各查一次「SELECT 1 FROM ads」。
        const adIds = [...new Set(valid.map((e) => e.adId))];
        const placeholders = adIds.map(() => "?").join(",");
        const { results } = await env.DB.prepare(`SELECT id FROM ads WHERE id IN (${placeholders})`)
          .bind(...adIds)
          .all();
        const knownIds = new Set(results.map((r) => r.id));
        const createdAt = nowTaiwanIso();
        const stmts = valid
          .filter((e) => knownIds.has(e.adId))
          .map((e) =>
            env.DB.prepare("INSERT INTO ad_events (adId, type, createdAt) VALUES (?, ?, ?)").bind(e.adId, e.type, createdAt)
          );
        if (stmts.length > 0) await env.DB.batch(stmts);
        return json({ ok: true, written: stmts.length }, 200, origin);
      }

      // 老師查詢次數打點：訪客真的送出查詢（含指定老師）時觸發，不做身分驗證，
      // 只做基本型別/長度防呆。前端已經做 30 分鐘內同老師去重，這裡單純累加寫入。
      if (url.pathname === "/trackTeacherSearch" && req.method === "POST") {
        const rl = await rateLimitOrNull(req, env, ctx, "trackTeacherSearch", 60, origin);
        if (rl) return rl;
        const body = await req.json().catch(() => ({}));
        const { teacher } = body || {};
        if (typeof teacher !== "string" || !teacher.trim() || teacher.length > 50) {
          return json({ error: "invalid teacher" }, 400, origin);
        }
        await env.DB.prepare("INSERT INTO teacher_search_events (teacherName, createdAt) VALUES (?, ?)")
          .bind(teacher.trim(), nowTaiwanIso())
          .run();
        return json({ ok: true }, 200, origin);
      }

      // 課程查詢次數打點，邏輯跟 /trackTeacherSearch 一樣。
      if (url.pathname === "/trackCourseSearch" && req.method === "POST") {
        const rl = await rateLimitOrNull(req, env, ctx, "trackCourseSearch", 60, origin);
        if (rl) return rl;
        const body = await req.json().catch(() => ({}));
        const { course } = body || {};
        if (typeof course !== "string" || !course.trim() || course.length > 50) {
          return json({ error: "invalid course" }, 400, origin);
        }
        await env.DB.prepare("INSERT INTO course_search_events (courseName, createdAt) VALUES (?, ?)")
          .bind(course.trim(), nowTaiwanIso())
          .run();
        return json({ ok: true }, 200, origin);
      }

      // 分店查詢次數打點，邏輯跟 /trackTeacherSearch 一樣。
      if (url.pathname === "/trackBranchSearch" && req.method === "POST") {
        const rl = await rateLimitOrNull(req, env, ctx, "trackBranchSearch", 60, origin);
        if (rl) return rl;
        const body = await req.json().catch(() => ({}));
        const { branch } = body || {};
        if (typeof branch !== "string" || !branch.trim() || branch.length > 50) {
          return json({ error: "invalid branch" }, 400, origin);
        }
        await env.DB.prepare("INSERT INTO branch_search_events (branchName, createdAt) VALUES (?, ?)")
          .bind(branch.trim(), nowTaiwanIso())
          .run();
        return json({ ok: true }, 200, origin);
      }

      // 老師/課程/分店查詢次數打點的 batch 版本：使用者一次查詢動作常常同時勾了多個老師/課程/分店，
      // 前端（logSearchEvents，取代原本各自迴圈呼叫 /trackTeacherSearch 等）已經做完 30 分鐘去重，
      // 這裡收整批已經確定要記錄的值，三張表各自組 INSERT 語句、一次 db.batch() 送完，
      // 取代「選了幾個分店/老師/課程就各自發幾個獨立 request + 獨立 INSERT」。
      if (url.pathname === "/trackSearchEvents" && req.method === "POST") {
        const rl = await rateLimitOrNull(req, env, ctx, "trackSearchEvents", 20, origin);
        if (rl) return rl;
        const body = await req.json().catch(() => ({}));
        const MAX_ITEMS_PER_KIND = 20;
        function sanitizeList(list) {
          if (!Array.isArray(list)) return [];
          return list
            .filter((v) => typeof v === "string" && v.trim() && v.length <= 50)
            .map((v) => v.trim())
            .slice(0, MAX_ITEMS_PER_KIND);
        }
        const teachers = sanitizeList(body && body.teachers);
        const courses = sanitizeList(body && body.courses);
        const branches = sanitizeList(body && body.branches);
        if (teachers.length === 0 && courses.length === 0 && branches.length === 0) {
          return json({ ok: true, written: 0 }, 200, origin);
        }
        const createdAt = nowTaiwanIso();
        const stmts = [
          ...teachers.map((t) =>
            env.DB.prepare("INSERT INTO teacher_search_events (teacherName, createdAt) VALUES (?, ?)").bind(t, createdAt)
          ),
          ...courses.map((c) =>
            env.DB.prepare("INSERT INTO course_search_events (courseName, createdAt) VALUES (?, ?)").bind(c, createdAt)
          ),
          ...branches.map((b) =>
            env.DB.prepare("INSERT INTO branch_search_events (branchName, createdAt) VALUES (?, ?)").bind(b, createdAt)
          ),
        ];
        await env.DB.batch(stmts);
        return json({ ok: true, written: stmts.length }, 200, origin);
      }

      // 整體查詢量打點：每次使用者真的送出查詢就打一次，不做去重、不驗證內容，
      // 純粹用來看「每月查詢次數」跟「每月查詢結果數」的使用量趨勢。
      if (url.pathname === "/trackSearch" && req.method === "POST") {
        const rl = await rateLimitOrNull(req, env, ctx, "trackSearch", 60, origin);
        if (rl) return rl;
        const body = await req.json().catch(() => ({}));
        const resultCount = Number.isInteger(body?.resultCount) && body.resultCount >= 0 ? body.resultCount : 0;
        await env.DB.prepare("INSERT INTO search_events (createdAt, resultCount) VALUES (?, ?)")
          .bind(nowTaiwanIso(), resultCount)
          .run();
        return json({ ok: true }, 200, origin);
      }

      // 「我的最愛」使用打點：type='add' 是成功建立一個最愛、type='apply' 是點最愛套用篩選，
      // clientId 是前端自己產生存在 localStorage 的匿名 id，不做身分驗證，只驗證型別/長度防呆。
      if (url.pathname === "/trackFavorite" && req.method === "POST") {
        const rl = await rateLimitOrNull(req, env, ctx, "trackFavorite", 60, origin);
        if (rl) return rl;
        const body = await req.json().catch(() => ({}));
        const { clientId, type } = body || {};
        if (typeof clientId !== "string" || !clientId.trim() || clientId.length > 100) {
          return json({ error: "invalid clientId" }, 400, origin);
        }
        if (type !== "add" && type !== "apply") {
          return json({ error: "invalid type" }, 400, origin);
        }
        await env.DB.prepare("INSERT INTO favorite_events (clientId, type, createdAt) VALUES (?, ?, ?)")
          .bind(clientId.trim(), type, nowTaiwanIso())
          .run();
        // 全時間去重人數即時維護在 favorite_client_seen，不依賴 favorite_events 明細是否還在
        // （見 analytics.js 的說明），才能讓「累積建立人數」在明細被每月排程清掉後依然準確。
        if (type === "add") {
          ctx.waitUntil(
            env.DB.prepare("INSERT OR IGNORE INTO favorite_client_seen (clientId, firstSeenAt) VALUES (?, ?)")
              .bind(clientId.trim(), nowTaiwanIso())
              .run()
          );
        }
        return json({ ok: true }, 200, origin);
      }

      // admin.html 廣告統計面板：一次回傳全部廣告（含已下架）+ 累計曝光/點擊數字 + 按月分組的曝光/點擊，
      // 讓前端畫折線圖時可以直接切月份視窗，不用每次切月都重打 API。
      if (url.pathname === "/adStats" && req.method === "GET") {
        const rl = await rateLimitOrNull(req, env, ctx, "adStats", 30, origin);
        if (rl) return rl;
        if (!(await isAdminRequest(req, env))) {
          return json({ error: "forbidden" }, 403, origin);
        }
        const ads = await adStatsCombined(env.DB);
        return json({ ads }, 200, origin);
      }

      // admin.html 查詢老師統計面板：回傳指定年月查詢次數前 15 名的老師，
      // 順便回傳所有有紀錄的年份，讓前端動態長出年份下拉選項。
      // 舊月份的明細會被每月排程搬進 teacher_search_monthly（見 analytics.js），
      // 這裡一律用「彙總 UNION 明細」的合併查詢，讀起來完全無感。
      if (url.pathname === "/teacherStats" && req.method === "GET") {
        const rl = await rateLimitOrNull(req, env, ctx, "teacherStats", 30, origin);
        if (rl) return rl;
        if (!(await isAdminRequest(req, env))) {
          return json({ error: "forbidden" }, 403, origin);
        }
        const nowTW = currentTaiwanYearMonth();
        const year = url.searchParams.get("year") || nowTW.year;
        const month = (url.searchParams.get("month") || nowTW.month).padStart(2, "0");
        const monthKey = `${year}-${month}`;
        const tableArgs = { rawTable: "teacher_search_events", nameColumn: "teacherName", monthlyTable: "teacher_search_monthly" };
        const [years, teachers] = await Promise.all([
          availableYears(env.DB, tableArgs),
          monthlyNameRanking(env.DB, { ...tableArgs, monthKey, limit: 15 }),
        ]);
        return json({
          years,
          teachers: teachers.map((r) => ({ name: r.name, count: r.cnt })),
        }, 200, origin);
      }

      // admin.html 查詢課程統計面板，邏輯跟 /teacherStats 一樣。
      if (url.pathname === "/courseStats" && req.method === "GET") {
        const rl = await rateLimitOrNull(req, env, ctx, "courseStats", 30, origin);
        if (rl) return rl;
        if (!(await isAdminRequest(req, env))) {
          return json({ error: "forbidden" }, 403, origin);
        }
        const nowTW = currentTaiwanYearMonth();
        const year = url.searchParams.get("year") || nowTW.year;
        const month = (url.searchParams.get("month") || nowTW.month).padStart(2, "0");
        const monthKey = `${year}-${month}`;
        const tableArgs = { rawTable: "course_search_events", nameColumn: "courseName", monthlyTable: "course_search_monthly" };
        const [years, courses] = await Promise.all([
          availableYears(env.DB, tableArgs),
          monthlyNameRanking(env.DB, { ...tableArgs, monthKey, limit: 15 }),
        ]);
        return json({
          years,
          courses: courses.map((r) => ({ name: r.name, count: r.cnt })),
        }, 200, origin);
      }

      // admin.html 查詢分店統計面板，邏輯跟 /teacherStats 一樣。
      if (url.pathname === "/branchStats" && req.method === "GET") {
        const rl = await rateLimitOrNull(req, env, ctx, "branchStats", 30, origin);
        if (rl) return rl;
        if (!(await isAdminRequest(req, env))) {
          return json({ error: "forbidden" }, 403, origin);
        }
        const nowTW = currentTaiwanYearMonth();
        const year = url.searchParams.get("year") || nowTW.year;
        const month = (url.searchParams.get("month") || nowTW.month).padStart(2, "0");
        const monthKey = `${year}-${month}`;
        const tableArgs = { rawTable: "branch_search_events", nameColumn: "branchName", monthlyTable: "branch_search_monthly" };
        const [years, branches] = await Promise.all([
          availableYears(env.DB, tableArgs),
          monthlyNameRanking(env.DB, { ...tableArgs, monthKey, limit: 15 }),
        ]);
        return json({
          years,
          branches: branches.map((r) => ({ name: r.name, count: r.cnt })),
        }, 200, origin);
      }

      // index.html 公開版查詢量趨勢，邏輯跟 /searchStats 一樣，但不驗證 token（僅回傳每月聚合次數，不含個資）。
      if (url.pathname === "/publicSearchStats" && req.method === "GET") {
        const rl = await rateLimitOrNull(req, env, ctx, "publicSearchStats", 30, origin);
        if (rl) return rl;
        const stats = await monthlySearchTrend(env.DB);
        return json(stats, 200, origin);
      }

      // index.html 公開版老師查詢排行，邏輯跟 /teacherStats 一樣，但不驗證 token（老師名字本來就是課表上的公開資訊）。
      if (url.pathname === "/publicTeacherStats" && req.method === "GET") {
        const rl = await rateLimitOrNull(req, env, ctx, "publicTeacherStats", 30, origin);
        if (rl) return rl;
        const nowTW = currentTaiwanYearMonth();
        const year = url.searchParams.get("year") || nowTW.year;
        const month = (url.searchParams.get("month") || nowTW.month).padStart(2, "0");
        const monthKey = `${year}-${month}`;
        const tableArgs = { rawTable: "teacher_search_events", nameColumn: "teacherName", monthlyTable: "teacher_search_monthly" };
        const [years, teachers] = await Promise.all([
          availableYears(env.DB, tableArgs),
          monthlyNameRanking(env.DB, { ...tableArgs, monthKey, limit: 15 }),
        ]);
        return json({
          years,
          teachers: teachers.map((r) => ({ name: r.name, count: r.cnt })),
        }, 200, origin);
      }

      // index.html 公開版課程查詢排行，邏輯跟 /courseStats 一樣，但不驗證 token（僅回傳聚合次數，不含個資）。
      if (url.pathname === "/publicCourseStats" && req.method === "GET") {
        const rl = await rateLimitOrNull(req, env, ctx, "publicCourseStats", 30, origin);
        if (rl) return rl;
        const nowTW = currentTaiwanYearMonth();
        const year = url.searchParams.get("year") || nowTW.year;
        const month = (url.searchParams.get("month") || nowTW.month).padStart(2, "0");
        const monthKey = `${year}-${month}`;
        const tableArgs = { rawTable: "course_search_events", nameColumn: "courseName", monthlyTable: "course_search_monthly" };
        const [years, courses] = await Promise.all([
          availableYears(env.DB, tableArgs),
          monthlyNameRanking(env.DB, { ...tableArgs, monthKey, limit: 15 }),
        ]);
        return json({
          years,
          courses: courses.map((r) => ({ name: r.name, count: r.cnt })),
        }, 200, origin);
      }

      // index.html 公開版分店查詢排行，邏輯跟 /branchStats 一樣，但不驗證 token（僅回傳聚合次數，不含個資）。
      if (url.pathname === "/publicBranchStats" && req.method === "GET") {
        const rl = await rateLimitOrNull(req, env, ctx, "publicBranchStats", 30, origin);
        if (rl) return rl;
        const nowTW = currentTaiwanYearMonth();
        const year = url.searchParams.get("year") || nowTW.year;
        const month = (url.searchParams.get("month") || nowTW.month).padStart(2, "0");
        const monthKey = `${year}-${month}`;
        const tableArgs = { rawTable: "branch_search_events", nameColumn: "branchName", monthlyTable: "branch_search_monthly" };
        const [years, branches] = await Promise.all([
          availableYears(env.DB, tableArgs),
          monthlyNameRanking(env.DB, { ...tableArgs, monthKey, limit: 10 }),
        ]);
        return json({
          years,
          branches: branches.map((r) => ({ name: r.name, count: r.cnt })),
        }, 200, origin);
      }

      // admin.html 查詢量趨勢折線圖：依月分組回傳全部歷史的查詢次數，前端只取最近 12 個月畫圖。
      if (url.pathname === "/searchStats" && req.method === "GET") {
        const rl = await rateLimitOrNull(req, env, ctx, "searchStats", 30, origin);
        if (rl) return rl;
        if (!(await isAdminRequest(req, env))) {
          return json({ error: "forbidden" }, 403, origin);
        }
        const stats = await monthlySearchTrend(env.DB);
        return json(stats, 200, origin);
      }

      // 查有沒有被爬蟲/腳本大量打：依 IP 分組列出 /issueToken、/queryClasses 的存取次數與被流量限制擋下的次數，
      // 預設抓最近 7 天，只列前 30 個 IP（照總次數排序）。
      if (url.pathname === "/queryAccessStats" && req.method === "GET") {
        const rl = await rateLimitOrNull(req, env, ctx, "queryAccessStats", 30, origin);
        if (rl) return rl;
        if (!(await isAdminRequest(req, env))) {
          return json({ error: "forbidden" }, 403, origin);
        }
        const days = parseInt(url.searchParams.get("days") || "7", 10);
        const sinceDate = new Date(Date.now() + 8 * 3600 * 1000 - days * 86400000);
        const since = sinceDate.toISOString().replace("Z", "+08:00");
        const { results } = await env.DB.prepare(`
          SELECT ip, userAgent, COUNT(*) AS cnt, SUM(rateLimited) AS rateLimitedCnt, MAX(createdAt) AS lastSeen
          FROM query_access_log
          WHERE createdAt >= ?
          GROUP BY ip
          ORDER BY cnt DESC
          LIMIT 30
        `).bind(since).all();
        return json({
          since,
          ips: results.map((r) => ({
            ip: r.ip, userAgent: r.userAgent, count: r.cnt, rateLimitedCount: r.rateLimitedCnt || 0, lastSeen: r.lastSeen,
          })),
        }, 200, origin);
      }

      // admin.html 最愛統計面板：totalAdders 讀 favorite_client_seen（即時維護，不受清理影響，
      // 永遠是正確的全時間去重人數）；月度趨勢一樣是「彙總 UNION 明細」合併查詢。
      if (url.pathname === "/favoriteStats" && req.method === "GET") {
        const rl = await rateLimitOrNull(req, env, ctx, "favoriteStats", 30, origin);
        if (rl) return rl;
        if (!(await isAdminRequest(req, env))) {
          return json({ error: "forbidden" }, 403, origin);
        }
        const stats = await favoriteStatsCombined(env.DB);
        return json(stats, 200, origin);
      }

      // admin.html 提醒功能統計面板：單純看每個月「登記提醒」被觸發幾次，評估這個功能有沒有人在用，
      // 不分辨是不是同一人、不追蹤取消（見 reminders.js 的 trackReminderAdd）。
      // 舊月份的明細會被每月排程搬進 reminder_add_monthly（見 analytics.js），這裡一律用
      // 「彙總 UNION 明細」的合併查詢，讀起來完全無感。
      if (url.pathname === "/reminderStats" && req.method === "GET") {
        const rl = await rateLimitOrNull(req, env, ctx, "reminderStats", 30, origin);
        if (rl) return rl;
        if (!(await isAdminRequest(req, env))) {
          return json({ error: "forbidden" }, 403, origin);
        }
        const stats = await reminderStatsCombined(env.DB);
        return json(stats, 200, origin);
      }

      // 讀 meta_filter_options 快取（一列資料），不用每次頁面載入都對 classes 全表重新 GROUP BY。
      // 這張快取只在整輪爬蟲成功、由 /finalizeScrape 寫入時才會更新，見下面的說明。
      if (url.pathname === "/filterOptions" && req.method === "GET") {
        const rl = await rateLimitOrNull(req, env, ctx, "filterOptions", 60, origin);
        if (rl) return rl;
        const row = await env.DB.prepare("SELECT classNames, teacherNames FROM meta_filter_options WHERE id = ?")
          .bind("filterOptions")
          .first();
        if (!row) return json({ classNames: [], teacherNames: [] }, 200, origin);
        return json({ classNames: JSON.parse(row.classNames), teacherNames: JSON.parse(row.teacherNames) }, 200, origin);
      }

      // admin.html 登入用：只驗證 token 對不對，不做任何事，讓前端可以在跑真正動作前先確認密碼正確。
      if (url.pathname === "/verifyAdminToken" && req.method === "POST") {
        const rl = await rateLimitOrNull(req, env, ctx, "verifyAdminToken", 10, origin);
        if (rl) return rl;
        if (!(await isAdminRequest(req, env))) {
          return json({ error: "forbidden" }, 403, origin);
        }
        // 帶密碼或帶還沒過期的 session token 來驗證都會換到一張新的 session token（滑動式延長
        // 有效期）：只要 7 天內有開過後台，就不用重新輸入密碼；超過 7 天沒用才會真的過期。
        const sessionToken = await issueAdminSession(env);
        return json({ ok: true, sessionToken }, 200, origin);
      }

      // 手動測試整站爬蟲：GET /scrapeManual?token=...
      // 回傳串流（NDJSON，每行一個 JSON 物件），讓 admin 頁面的終端機能即時顯示進度，
      // 不用等整輪 106 家分店都跑完才拿到結果。最後一行一定是 type:"result" 或 type:"error"。
      if (url.pathname === "/scrapeManual" && req.method === "GET") {
        const rl = await rateLimitOrNull(req, env, ctx, "scrapeManual", 5, origin);
        if (rl) return rl;
        if (!(await isAdminRequest(req, env))) {
          return json({ error: "forbidden" }, 403, origin);
        }
        const { readable, writable } = new TransformStream();
        const writer = writable.getWriter();
        const encoder = new TextEncoder();
        const writeLine = (obj) => writer.write(encoder.encode(JSON.stringify(obj) + "\n")).catch(() => {});

        const task = (async () => {
          try {
            const summary = await runScrape(env.DB, { onProgress: (text) => writeLine({ type: "log", text }) });
            await writeLine({ type: "result", ...summary });
          } catch (e) {
            await writeLine({ type: "error", message: e.message });
          } finally {
            await writer.close().catch(() => {});
          }
        })();
        ctx.waitUntil(task);

        return new Response(readable, {
          status: 200,
          headers: { "Content-Type": "application/x-ndjson; charset=utf-8", ...corsHeaders(origin) },
        });
      }

      // 「寫信給作者」表單：把留言轉發到 Teams 頻道 webhook，不落地存資料。
      // 原本是 Firebase Function sendMessageToAuthor，2026-08-12 搬過來合併成單一部署系統。
      if (url.pathname === "/sendMessageToAuthor" && req.method === "POST") {
        const rl = await rateLimitOrNull(req, env, ctx, "sendMessageToAuthor", 5, origin);
        if (rl) return rl;
        const body = await req.json().catch(() => ({}));
        const content = String(body?.content || "").trim();
        if (!content || content.length > 2000) {
          return json({ error: "invalid content" }, 400, origin);
        }
        const teamsRes = await fetch(env.TEAMS_WEBHOOK_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            type: "AdaptiveCard",
            $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
            version: "1.4",
            body: [
              { type: "TextBlock", text: "課表查詢網站有新留言：", weight: "bolder", wrap: true },
              { type: "TextBlock", text: content, wrap: true },
            ],
          }),
        });
        if (!teamsRes.ok) {
          console.error("Teams webhook responded with error", teamsRes.status, await teamsRes.text());
          return json({ error: "teams webhook failed" }, 502, origin);
        }
        return json({ ok: true }, 200, origin);
      }

      // 刪除不在目前分店清單裡的舊課表資料（分店關店/從 branches-seed.js 移除後的孤兒資料）。
      if (url.pathname === "/cleanupStaleBranches" && req.method === "POST") {
        const rl = await rateLimitOrNull(req, env, ctx, "cleanupStaleBranches", 5, origin);
        if (rl) return rl;
        if (!(await isAdminRequest(req, env))) {
          return json({ error: "forbidden" }, 403, origin);
        }
        const result = await cleanupStaleBranches(env.DB);
        return json(result, 200, origin);
      }

      // 手動觸發一次分析報表的月度彙總（見 analytics.js），平常由每月排程自動跑，
      // 這裡讓後台可以隨時手動確認/補跑，不用等到月初或自己下 SQL。
      if (url.pathname === "/rollupAnalyticsManual" && req.method === "POST") {
        const rl = await rateLimitOrNull(req, env, ctx, "rollupAnalyticsManual", 5, origin);
        if (rl) return rl;
        if (!(await isAdminRequest(req, env))) {
          return json({ error: "forbidden" }, 403, origin);
        }
        const result = await rollupAnalyticsEvents(env.DB);
        return json(result, 200, origin);
      }

      // 課表通知(單次,上課前 30 分鐘):登記一顆課的 Web Push 通知。
      if (url.pathname === "/registerReminder" && req.method === "POST") {
        const rl = await rateLimitOrNull(req, env, ctx, "registerReminder", 60, origin);
        if (rl) return rl;
        const body = await req.json().catch(() => ({}));
        const { branchSlug, branchName, className, teacherName, roomName, dayOfWeek, startTime, pushSubscription, clickUrl } = body || {};
        if (
          typeof branchSlug !== "string" || !branchSlug ||
          typeof branchName !== "string" || !branchName ||
          typeof className !== "string" || !className ||
          typeof teacherName !== "string" || !teacherName ||
          typeof roomName !== "string" ||
          !Number.isInteger(dayOfWeek) || dayOfWeek < 1 || dayOfWeek > 7 ||
          typeof startTime !== "string" || !/^\d{4}$/.test(startTime) ||
          !pushSubscription || typeof pushSubscription.endpoint !== "string" || !pushSubscription.endpoint ||
          (clickUrl !== undefined && (typeof clickUrl !== "string" || clickUrl.length > 500))
        ) {
          return json({ error: "invalid reminder" }, 400, origin);
        }
        const result = await registerReminder(env.DB, {
          branchSlug, branchName, className, teacherName, roomName, dayOfWeek, startTime, pushSubscription, clickUrl,
        }, ctx);
        return json(result, 200, origin);
      }

      // 取消一顆已登記的課表通知。subscriptionEndpoint 是必要欄位，用來驗證呼叫端真的擁有
      // 這個 push subscription，不能只憑 id（見 reminders.js 的 cancelReminder 說明）。
      if (url.pathname === "/cancelReminder" && req.method === "POST") {
        const rl = await rateLimitOrNull(req, env, ctx, "cancelReminder", 60, origin);
        if (rl) return rl;
        const body = await req.json().catch(() => ({}));
        if (typeof body?.subscriptionEndpoint !== "string" || !body.subscriptionEndpoint) {
          return json({ error: "invalid cancelReminder" }, 400, origin);
        }
        const result = await cancelReminder(env.DB, body);
        return json(result, 200, origin);
      }

      // 某個 push subscription 底下所有還沒發送的通知清單(還原鈴鐺狀態/畫「通知」清單用)。
      if (url.pathname === "/myReminders" && req.method === "GET") {
        const rl = await rateLimitOrNull(req, env, ctx, "myReminders", 60, origin);
        if (rl) return rl;
        const endpoint = url.searchParams.get("endpoint") || "";
        if (!endpoint) return json({ reminders: [] }, 200, origin);
        const reminders = await listReminders(env.DB, endpoint);
        return json({ reminders }, 200, origin);
      }

      return json({ error: "not found" }, 404, origin);
    } catch (e) {
      console.error("worker error", e);
      return json({ error: "internal error" }, 500, origin);
    }
  },

  async scheduled(event, env, ctx) {
    // 每天台灣時間 03:00、17:00（UTC 19:00、09:00）各自動重抓一次全部分店，見 wrangler.toml 的 cron 設定。
    // 這支爬蟲對 104 家分店逐一發出 subrequest，「單次執行」就用掉 104 個，
    // 需要 Workers Paid 方案（單次執行 subrequest 上限 1000）才跑得完；免費方案單次執行上限只有 50，會在跑到一半時失敗。
    if (event.cron === "0 19 * * *" || event.cron === "0 9 * * *") {
      ctx.waitUntil(runScrape(env.DB));
      return;
    }
    // 每月 1 號台灣時間 04:00（UTC 20:00）：清一次 query_access_log 的舊紀錄，
    // 並把分析報表明細表（teacher/course/branch 查詢次數、查詢量、最愛、廣告事件）超過保留窗口
    // 的舊月份壓縮成彙總、刪除明細（見 analytics.js 的 rollupAnalyticsEvents）。見 wrangler.toml 的 cron 設定。
    if (event.cron === "0 20 1 * *") {
      ctx.waitUntil(cleanupOldQueryAccessLog(env.DB));
      ctx.waitUntil(rollupAnalyticsEvents(env.DB));
      return;
    }
    // 其餘（每 5 分鐘）用來掃一次課表通知。
    ctx.waitUntil(dispatchDueReminders(env.DB, env));
  },
};
