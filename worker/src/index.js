import { queryClasses } from "./queryClasses.js";
import { runScrape, cleanupStaleBranches } from "./scrape.js";
import { registerReminder, cancelReminder, listReminders, dispatchDueReminders } from "./reminders.js";

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
  "https://worldgym-web.lions2100.workers.dev",
];

function corsHeaders(origin) {
  const headers = { "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, X-Query-Token" };
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
        const allowed = await checkRateLimit(env, "rl:issueToken", ip, 10, ctx);
        if (!allowed) return json({ error: "rate_limited" }, 429, origin);
        const token = await issueQueryToken(env);
        return json({ token }, 200, origin);
      }

      if (url.pathname === "/queryClasses" && req.method === "POST") {
        const ip = req.headers.get("CF-Connecting-IP") || "unknown";
        const allowed = await checkRateLimit(env, "rl:queryClasses", ip, 20, ctx);
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
        const now = new Date().toISOString();
        const { results } = await env.DB.prepare(
          "SELECT id, text, url FROM ads WHERE enabled = 1 AND startAt <= ? AND endAt >= ? ORDER BY sortOrder"
        ).bind(now, now).all();
        return json({ ads: results }, 200, origin);
      }

      // 廣告曝光/點擊打點：訪客觸發的公開動作，不做身分驗證，只驗證 adId 真的存在、type 合法，
      // 避免寫入垃圾資料污染統計。
      if (url.pathname === "/trackAdEvent" && req.method === "POST") {
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
          .bind(adId, type, new Date().toISOString())
          .run();
        return json({ ok: true }, 200, origin);
      }

      // 老師查詢次數打點：訪客真的送出查詢（含指定老師）時觸發，不做身分驗證，
      // 只做基本型別/長度防呆。前端已經做 30 分鐘內同老師去重，這裡單純累加寫入。
      if (url.pathname === "/trackTeacherSearch" && req.method === "POST") {
        const body = await req.json().catch(() => ({}));
        const { teacher } = body || {};
        if (typeof teacher !== "string" || !teacher.trim() || teacher.length > 50) {
          return json({ error: "invalid teacher" }, 400, origin);
        }
        await env.DB.prepare("INSERT INTO teacher_search_events (teacherName, createdAt) VALUES (?, ?)")
          .bind(teacher.trim(), new Date().toISOString())
          .run();
        return json({ ok: true }, 200, origin);
      }

      // 課程查詢次數打點，邏輯跟 /trackTeacherSearch 一樣。
      if (url.pathname === "/trackCourseSearch" && req.method === "POST") {
        const body = await req.json().catch(() => ({}));
        const { course } = body || {};
        if (typeof course !== "string" || !course.trim() || course.length > 50) {
          return json({ error: "invalid course" }, 400, origin);
        }
        await env.DB.prepare("INSERT INTO course_search_events (courseName, createdAt) VALUES (?, ?)")
          .bind(course.trim(), new Date().toISOString())
          .run();
        return json({ ok: true }, 200, origin);
      }

      // 分店查詢次數打點，邏輯跟 /trackTeacherSearch 一樣。
      if (url.pathname === "/trackBranchSearch" && req.method === "POST") {
        const body = await req.json().catch(() => ({}));
        const { branch } = body || {};
        if (typeof branch !== "string" || !branch.trim() || branch.length > 50) {
          return json({ error: "invalid branch" }, 400, origin);
        }
        await env.DB.prepare("INSERT INTO branch_search_events (branchName, createdAt) VALUES (?, ?)")
          .bind(branch.trim(), new Date().toISOString())
          .run();
        return json({ ok: true }, 200, origin);
      }

      // 整體查詢量打點：每次使用者真的送出查詢就打一次，不做去重、不驗證內容，
      // 純粹用來看「每月查詢次數」跟「每月查詢結果數」的使用量趨勢。
      if (url.pathname === "/trackSearch" && req.method === "POST") {
        const body = await req.json().catch(() => ({}));
        const resultCount = Number.isInteger(body?.resultCount) && body.resultCount >= 0 ? body.resultCount : 0;
        await env.DB.prepare("INSERT INTO search_events (createdAt, resultCount) VALUES (?, ?)")
          .bind(new Date().toISOString(), resultCount)
          .run();
        return json({ ok: true }, 200, origin);
      }

      // 「我的最愛」使用打點：type='add' 是成功建立一個最愛、type='apply' 是點最愛套用篩選，
      // clientId 是前端自己產生存在 localStorage 的匿名 id，不做身分驗證，只驗證型別/長度防呆。
      if (url.pathname === "/trackFavorite" && req.method === "POST") {
        const body = await req.json().catch(() => ({}));
        const { clientId, type } = body || {};
        if (typeof clientId !== "string" || !clientId.trim() || clientId.length > 100) {
          return json({ error: "invalid clientId" }, 400, origin);
        }
        if (type !== "add" && type !== "apply") {
          return json({ error: "invalid type" }, 400, origin);
        }
        await env.DB.prepare("INSERT INTO favorite_events (clientId, type, createdAt) VALUES (?, ?, ?)")
          .bind(clientId.trim(), type, new Date().toISOString())
          .run();
        return json({ ok: true }, 200, origin);
      }

      // admin.html 廣告統計面板：一次回傳全部廣告（含已下架）+ 累計曝光/點擊數字 + 按月分組的曝光/點擊，
      // 讓前端畫折線圖時可以直接切月份視窗，不用每次切月都重打 API。
      if (url.pathname === "/adStats" && req.method === "GET") {
        if (url.searchParams.get("token") !== env.MANUAL_SCRAPE_TOKEN) {
          return json({ error: "forbidden" }, 403, origin);
        }
        const [{ results: ads }, { results: monthly }] = await Promise.all([
          env.DB.prepare(`
            SELECT
              a.id, a.text, a.url, a.startAt, a.endAt, a.enabled, a.sortOrder, a.advertiser,
              COALESCE(imp.cnt, 0) AS impressions,
              COALESCE(clk.cnt, 0) AS clicks
            FROM ads a
            LEFT JOIN (SELECT adId, COUNT(*) cnt FROM ad_events WHERE type='impression' GROUP BY adId) imp ON imp.adId = a.id
            LEFT JOIN (SELECT adId, COUNT(*) cnt FROM ad_events WHERE type='click' GROUP BY adId) clk ON clk.adId = a.id
            ORDER BY a.sortOrder
          `).all(),
          env.DB.prepare(`
            SELECT adId, substr(createdAt, 1, 7) AS month, type, COUNT(*) cnt
            FROM ad_events
            GROUP BY adId, month, type
          `).all(),
        ]);
        const monthlyByAd = {};
        for (const row of monthly) {
          const bucket = (monthlyByAd[row.adId] ??= {});
          const entry = (bucket[row.month] ??= { impressions: 0, clicks: 0 });
          entry[row.type === "impression" ? "impressions" : "clicks"] = row.cnt;
        }
        for (const ad of ads) ad.monthly = monthlyByAd[ad.id] || {};
        return json({ ads }, 200, origin);
      }

      // admin.html 查詢老師統計面板：回傳指定年月查詢次數前 15 名的老師，
      // 順便回傳所有有紀錄的年份，讓前端動態長出年份下拉選項。
      if (url.pathname === "/teacherStats" && req.method === "GET") {
        if (url.searchParams.get("token") !== env.MANUAL_SCRAPE_TOKEN) {
          return json({ error: "forbidden" }, 403, origin);
        }
        const now = new Date();
        const year = url.searchParams.get("year") || String(now.getUTCFullYear());
        const month = (url.searchParams.get("month") || String(now.getUTCMonth() + 1).padStart(2, "0")).padStart(2, "0");
        const monthKey = `${year}-${month}`;

        const [{ results: years }, { results: teachers }] = await Promise.all([
          env.DB.prepare("SELECT DISTINCT substr(createdAt, 1, 4) AS y FROM teacher_search_events ORDER BY y DESC").all(),
          env.DB.prepare(`
            SELECT teacherName, COUNT(*) AS cnt
            FROM teacher_search_events
            WHERE substr(createdAt, 1, 7) = ?
            GROUP BY teacherName
            ORDER BY cnt DESC
            LIMIT 15
          `).bind(monthKey).all(),
        ]);
        return json({
          years: years.map((r) => r.y),
          teachers: teachers.map((r) => ({ name: r.teacherName, count: r.cnt })),
        }, 200, origin);
      }

      // admin.html 查詢課程統計面板，邏輯跟 /teacherStats 一樣。
      if (url.pathname === "/courseStats" && req.method === "GET") {
        if (url.searchParams.get("token") !== env.MANUAL_SCRAPE_TOKEN) {
          return json({ error: "forbidden" }, 403, origin);
        }
        const now = new Date();
        const year = url.searchParams.get("year") || String(now.getUTCFullYear());
        const month = (url.searchParams.get("month") || String(now.getUTCMonth() + 1).padStart(2, "0")).padStart(2, "0");
        const monthKey = `${year}-${month}`;

        const [{ results: years }, { results: courses }] = await Promise.all([
          env.DB.prepare("SELECT DISTINCT substr(createdAt, 1, 4) AS y FROM course_search_events ORDER BY y DESC").all(),
          env.DB.prepare(`
            SELECT courseName, COUNT(*) AS cnt
            FROM course_search_events
            WHERE substr(createdAt, 1, 7) = ?
            GROUP BY courseName
            ORDER BY cnt DESC
            LIMIT 15
          `).bind(monthKey).all(),
        ]);
        return json({
          years: years.map((r) => r.y),
          courses: courses.map((r) => ({ name: r.courseName, count: r.cnt })),
        }, 200, origin);
      }

      // admin.html 查詢分店統計面板，邏輯跟 /teacherStats 一樣。
      if (url.pathname === "/branchStats" && req.method === "GET") {
        if (url.searchParams.get("token") !== env.MANUAL_SCRAPE_TOKEN) {
          return json({ error: "forbidden" }, 403, origin);
        }
        const now = new Date();
        const year = url.searchParams.get("year") || String(now.getUTCFullYear());
        const month = (url.searchParams.get("month") || String(now.getUTCMonth() + 1).padStart(2, "0")).padStart(2, "0");
        const monthKey = `${year}-${month}`;

        const [{ results: years }, { results: branches }] = await Promise.all([
          env.DB.prepare("SELECT DISTINCT substr(createdAt, 1, 4) AS y FROM branch_search_events ORDER BY y DESC").all(),
          env.DB.prepare(`
            SELECT branchName, COUNT(*) AS cnt
            FROM branch_search_events
            WHERE substr(createdAt, 1, 7) = ?
            GROUP BY branchName
            ORDER BY cnt DESC
            LIMIT 15
          `).bind(monthKey).all(),
        ]);
        return json({
          years: years.map((r) => r.y),
          branches: branches.map((r) => ({ name: r.branchName, count: r.cnt })),
        }, 200, origin);
      }

      // index.html 公開版老師查詢排行，邏輯跟 /teacherStats 一樣，但不驗證 token（老師名字本來就是課表上的公開資訊）。
      if (url.pathname === "/publicTeacherStats" && req.method === "GET") {
        const now = new Date();
        const year = url.searchParams.get("year") || String(now.getUTCFullYear());
        const month = (url.searchParams.get("month") || String(now.getUTCMonth() + 1).padStart(2, "0")).padStart(2, "0");
        const monthKey = `${year}-${month}`;

        const [{ results: years }, { results: teachers }] = await Promise.all([
          env.DB.prepare("SELECT DISTINCT substr(createdAt, 1, 4) AS y FROM teacher_search_events ORDER BY y DESC").all(),
          env.DB.prepare(`
            SELECT teacherName, COUNT(*) AS cnt
            FROM teacher_search_events
            WHERE substr(createdAt, 1, 7) = ?
            GROUP BY teacherName
            ORDER BY cnt DESC
            LIMIT 15
          `).bind(monthKey).all(),
        ]);
        return json({
          years: years.map((r) => r.y),
          teachers: teachers.map((r) => ({ name: r.teacherName, count: r.cnt })),
        }, 200, origin);
      }

      // index.html 公開版課程查詢排行，邏輯跟 /courseStats 一樣，但不驗證 token（僅回傳聚合次數，不含個資）。
      if (url.pathname === "/publicCourseStats" && req.method === "GET") {
        const now = new Date();
        const year = url.searchParams.get("year") || String(now.getUTCFullYear());
        const month = (url.searchParams.get("month") || String(now.getUTCMonth() + 1).padStart(2, "0")).padStart(2, "0");
        const monthKey = `${year}-${month}`;

        const [{ results: years }, { results: courses }] = await Promise.all([
          env.DB.prepare("SELECT DISTINCT substr(createdAt, 1, 4) AS y FROM course_search_events ORDER BY y DESC").all(),
          env.DB.prepare(`
            SELECT courseName, COUNT(*) AS cnt
            FROM course_search_events
            WHERE substr(createdAt, 1, 7) = ?
            GROUP BY courseName
            ORDER BY cnt DESC
            LIMIT 15
          `).bind(monthKey).all(),
        ]);
        return json({
          years: years.map((r) => r.y),
          courses: courses.map((r) => ({ name: r.courseName, count: r.cnt })),
        }, 200, origin);
      }

      // index.html 公開版分店查詢排行，邏輯跟 /branchStats 一樣，但不驗證 token（僅回傳聚合次數，不含個資）。
      if (url.pathname === "/publicBranchStats" && req.method === "GET") {
        const now = new Date();
        const year = url.searchParams.get("year") || String(now.getUTCFullYear());
        const month = (url.searchParams.get("month") || String(now.getUTCMonth() + 1).padStart(2, "0")).padStart(2, "0");
        const monthKey = `${year}-${month}`;

        const [{ results: years }, { results: branches }] = await Promise.all([
          env.DB.prepare("SELECT DISTINCT substr(createdAt, 1, 4) AS y FROM branch_search_events ORDER BY y DESC").all(),
          env.DB.prepare(`
            SELECT branchName, COUNT(*) AS cnt
            FROM branch_search_events
            WHERE substr(createdAt, 1, 7) = ?
            GROUP BY branchName
            ORDER BY cnt DESC
            LIMIT 15
          `).bind(monthKey).all(),
        ]);
        return json({
          years: years.map((r) => r.y),
          branches: branches.map((r) => ({ name: r.branchName, count: r.cnt })),
        }, 200, origin);
      }

      // admin.html 查詢量趨勢折線圖：依月分組回傳全部歷史的查詢次數，前端只取最近 12 個月畫圖。
      if (url.pathname === "/searchStats" && req.method === "GET") {
        if (url.searchParams.get("token") !== env.MANUAL_SCRAPE_TOKEN) {
          return json({ error: "forbidden" }, 403, origin);
        }
        const { results } = await env.DB.prepare(
          "SELECT substr(createdAt, 1, 7) AS month, COUNT(*) AS cnt, SUM(resultCount) AS resultSum FROM search_events GROUP BY month"
        ).all();
        const monthly = {};
        const monthlyResults = {};
        for (const row of results) {
          monthly[row.month] = row.cnt;
          monthlyResults[row.month] = row.resultSum || 0;
        }
        return json({ monthly, monthlyResults }, 200, origin);
      }

      // admin.html 最愛統計面板：add 用 COUNT(DISTINCT clientId) 估算「幾個人成功建立過最愛」，
      // apply 單純累加「總共被按了幾次」，不去重。
      if (url.pathname === "/favoriteStats" && req.method === "GET") {
        if (url.searchParams.get("token") !== env.MANUAL_SCRAPE_TOKEN) {
          return json({ error: "forbidden" }, 403, origin);
        }
        const [{ results: adderRows }, { results: applyRows }, totalAdderRow, totalApplyRow] = await Promise.all([
          env.DB.prepare(
            "SELECT substr(createdAt, 1, 7) AS month, COUNT(DISTINCT clientId) AS cnt FROM favorite_events WHERE type = 'add' GROUP BY month"
          ).all(),
          env.DB.prepare(
            "SELECT substr(createdAt, 1, 7) AS month, COUNT(*) AS cnt FROM favorite_events WHERE type = 'apply' GROUP BY month"
          ).all(),
          env.DB.prepare("SELECT COUNT(DISTINCT clientId) AS cnt FROM favorite_events WHERE type = 'add'").first(),
          env.DB.prepare("SELECT COUNT(*) AS cnt FROM favorite_events WHERE type = 'apply'").first(),
        ]);
        const monthlyAdders = {};
        for (const row of adderRows) monthlyAdders[row.month] = row.cnt;
        const monthlyApplies = {};
        for (const row of applyRows) monthlyApplies[row.month] = row.cnt;
        return json({
          monthlyAdders, monthlyApplies,
          totalAdders: totalAdderRow?.cnt || 0,
          totalApplies: totalApplyRow?.cnt || 0,
        }, 200, origin);
      }

      // 讀 meta_filter_options 快取（一列資料），不用每次頁面載入都對 classes 全表重新 GROUP BY。
      // 這張快取只在整輪爬蟲成功、由 /finalizeScrape 寫入時才會更新，見下面的說明。
      if (url.pathname === "/filterOptions" && req.method === "GET") {
        const row = await env.DB.prepare("SELECT classNames, teacherNames FROM meta_filter_options WHERE id = ?")
          .bind("filterOptions")
          .first();
        if (!row) return json({ classNames: [], teacherNames: [] }, 200, origin);
        return json({ classNames: JSON.parse(row.classNames), teacherNames: JSON.parse(row.teacherNames) }, 200, origin);
      }

      // admin.html 登入用：只驗證 token 對不對，不做任何事，讓前端可以在跑真正動作前先確認密碼正確。
      if (url.pathname === "/verifyAdminToken" && req.method === "POST") {
        const body = await req.json().catch(() => ({}));
        if (body?.token !== env.MANUAL_SCRAPE_TOKEN) {
          return json({ error: "forbidden" }, 403, origin);
        }
        return json({ ok: true }, 200, origin);
      }

      // 手動測試整站爬蟲：GET /scrapeManual?token=...
      // 回傳串流（NDJSON，每行一個 JSON 物件），讓 admin 頁面的終端機能即時顯示進度，
      // 不用等整輪 106 家分店都跑完才拿到結果。最後一行一定是 type:"result" 或 type:"error"。
      if (url.pathname === "/scrapeManual" && req.method === "GET") {
        if (url.searchParams.get("token") !== env.MANUAL_SCRAPE_TOKEN) {
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
        const body = await req.json().catch(() => ({}));
        const content = String(body?.content || "").trim();
        if (!content || content.length > 2000) {
          return json({ error: "invalid content" }, 400, origin);
        }
        const teamsRes = await fetch(env.TEAMS_WEBHOOK_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: `課表查詢網站有新留言：\n${content}` }),
        });
        if (!teamsRes.ok) {
          console.error("Teams webhook responded with error", teamsRes.status, await teamsRes.text());
          return json({ error: "teams webhook failed" }, 502, origin);
        }
        return json({ ok: true }, 200, origin);
      }

      // 刪除不在目前分店清單裡的舊課表資料（分店關店/從 branches-seed.js 移除後的孤兒資料）。
      if (url.pathname === "/cleanupStaleBranches" && req.method === "POST") {
        const body = await req.json().catch(() => ({}));
        if (body?.token !== env.MANUAL_SCRAPE_TOKEN) {
          return json({ error: "forbidden" }, 403, origin);
        }
        const result = await cleanupStaleBranches(env.DB);
        return json(result, 200, origin);
      }

      // 課表通知(單次,上課前 30 分鐘):登記一顆課的 Web Push 通知。
      if (url.pathname === "/registerReminder" && req.method === "POST") {
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
        });
        return json(result, 200, origin);
      }

      // 取消一顆已登記的課表通知。
      if (url.pathname === "/cancelReminder" && req.method === "POST") {
        const body = await req.json().catch(() => ({}));
        const result = await cancelReminder(env.DB, body || {});
        return json(result, 200, origin);
      }

      // 某個 push subscription 底下所有還沒發送的通知清單(還原鈴鐺狀態/畫「通知」清單用)。
      if (url.pathname === "/myReminders" && req.method === "GET") {
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
    // 其餘（每 5 分鐘）用來掃一次課表通知。
    ctx.waitUntil(dispatchDueReminders(env.DB, env));
  },
};
