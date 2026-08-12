import { queryClasses } from "./queryClasses.js";
import { runScrape, cleanupStaleBranches } from "./scrape.js";

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

      // 查詢前先只要筆數：前端拿 count 判斷要不要顯示「太多/沒有結果」提示，
      // 筆數在合理範圍才會真的呼叫 /queryClasses 把完整資料抓回去畫結果頁。
      if (url.pathname === "/classesCount" && req.method === "POST") {
        const body = await req.json().catch(() => ({}));
        const { fetchedCount, displayedCount } = await queryClasses(env.DB, body || {});
        return json({ fetchedCount, displayedCount }, 200, origin);
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

      return json({ error: "not found" }, 404, origin);
    } catch (e) {
      console.error("worker error", e);
      return json({ error: "internal error" }, 500, origin);
    }
  },

  async scheduled(_event, env, ctx) {
    ctx.waitUntil(runScrape(env.DB, {}));
  },
};
