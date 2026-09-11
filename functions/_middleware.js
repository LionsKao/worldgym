// 只開放台灣 IP：cf.country 沒有值(如本機開發)就放行，避免擋掉自己測試。
// 已知的搜尋引擎/AI/社群預覽爬蟲另外放行（不限地區），不然 Google/AI 爬蟲多半從海外機房發request，
// 光靠 robots.txt 是擋不住這層 IP 限制的，永遠爬不到內容。User-Agent 可以偽造，但這裡放行後看到的
// 也只是原本任何訪客都能公開查到的課表資料，偽造成本大於利益，風險可接受。
const CRAWLER_UA_PATTERN = /Googlebot|Google-Extended|AdsBot-Google|Mediapartners-Google|APIs-Google|bingbot|BingPreview|Baiduspider|YandexBot|DuckDuckBot|GPTBot|ChatGPT-User|OAI-SearchBot|anthropic-ai|ClaudeBot|Claude-Web|PerplexityBot|CCBot|Bytespider|Amazonbot|Applebot|Meta-ExternalAgent|facebookexternalhit|LinkedInBot|Slackbot|TelegramBot|WhatsApp|Diffbot/i;

export async function onRequest(context) {
  const country = context.request.cf?.country;
  if (country && country !== "TW") {
    const ua = context.request.headers.get("User-Agent") || "";
    if (!CRAWLER_UA_PATTERN.test(ua)) {
      return new Response("Forbidden", { status: 403 });
    }
  }
  return context.next();
}
