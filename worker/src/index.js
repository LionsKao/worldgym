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
  const headers = { "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" };
  if (ALLOWED_ORIGINS.includes(origin)) headers["Access-Control-Allow-Origin"] = origin;
  return headers;
}

function json(data, status, origin) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
  });
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
      if (url.pathname === "/queryClasses" && req.method === "POST") {
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

      // admin.html 廣告統計面板：一次回傳全部廣告（含已下架）+ 累計曝光/點擊數字。
      if (url.pathname === "/adStats" && req.method === "GET") {
        if (url.searchParams.get("token") !== env.MANUAL_SCRAPE_TOKEN) {
          return json({ error: "forbidden" }, 403, origin);
        }
        const { results } = await env.DB.prepare(`
          SELECT
            a.id, a.text, a.url, a.startAt, a.endAt, a.enabled, a.sortOrder,
            COALESCE(imp.cnt, 0) AS impressions,
            COALESCE(clk.cnt, 0) AS clicks
          FROM ads a
          LEFT JOIN (SELECT adId, COUNT(*) cnt FROM ad_events WHERE type='impression' GROUP BY adId) imp ON imp.adId = a.id
          LEFT JOIN (SELECT adId, COUNT(*) cnt FROM ad_events WHERE type='click' GROUP BY adId) clk ON clk.adId = a.id
          ORDER BY a.sortOrder
        `).all();
        return json({ ads: results }, 200, origin);
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

  async scheduled(_event, env, ctx) {
    // 爬蟲維持手動觸發(見上面 wrangler.toml 的說明,官網會擋 Worker 自動爬),
    // 這個 cron 目前只用來每 5 分鐘掃一次課表通知。
    ctx.waitUntil(dispatchDueReminders(env.DB, env));
  },
};
