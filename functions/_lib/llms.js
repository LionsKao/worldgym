import { SITE_ORIGIN } from "./ssrConfig.js";
import { branchUrlParam } from "./branchUrl.js";
import { getBranchesWithSchedule } from "./scheduleBranches.js";
import { cachedTextResponse } from "./util.js";

// 連結文字裡的 Markdown 特殊字元要跳脫（反斜線、[、]），避免分店名稱破壞連結語法；
// 目前分店名稱都沒有這些字元，仍然防禦。
function escapeLinkText(text) {
  return String(text).replace(/[\\\[\]]/g, (ch) => "\\" + ch);
}

// 一行一間分店，格式與分店頁 <title> 一致；連結用 slug 版網址，Markdown 裡的 & 就是純 &（不是 &amp;）。
function renderBranchSection(branches) {
  const lines = branches.map(
    ({ code, slug, name, region }) =>
      `- [${escapeLinkText(`${name} 分店（${region}）團體課表`)}](${SITE_ORIGIN}/?branch=${branchUrlParam(slug, code)}&room=1)`
  );
  return `\n## 分店課表\n\n${lines.join("\n")}\n`;
}

// 動態 /llms.txt：靜態 llms.txt 的內容 + 「## 分店課表」索引（現在有團體課表的分店，順序與 sitemap 相同，
// 因為兩邊共用 getBranchesWithSchedule）。靜態檔取自 env.ASSETS（直接讀靜態資源，不會再進 Function），
// 文字只有一份。結果快取 30 分鐘；任何失敗（沒有 D1/ASSETS 綁定、讀不到靜態檔、逾時、查無分店、例外）回 null，
// 由呼叫端 context.next() 退回靜態 llms.txt。所有請求（不分 UA）拿到的內容完全相同。
export async function getLlmsResponse(context) {
  if (!context.env.DB || !context.env.ASSETS) return null;
  return cachedTextResponse(context, {
    name: "llms",
    label: "llms.txt",
    contentType: "text/plain; charset=utf-8",
    build: async () => {
      const [branches, assetRes] = await Promise.all([
        getBranchesWithSchedule(context.env.DB),
        context.env.ASSETS.fetch(new Request(`${SITE_ORIGIN}/llms.txt`)),
      ]);
      if (branches.length === 0 || !assetRes.ok) return null;
      const staticText = (await assetRes.text()).replace(/\s+$/, "\n");
      if (!staticText.trim()) return null;
      return staticText + renderBranchSection(branches);
    },
  });
}
