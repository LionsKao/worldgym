// 動態 sitemap：只列現在真的有團體課表的分店（見 functions/_lib/sitemap.js）。
// 任何失敗就 context.next() 退回根目錄的靜態 sitemap.xml，所以靜態檔要留著當備援。
import { getSitemapResponse } from "./_lib/sitemap.js";

export async function onRequestGet(context) {
  return (await getSitemapResponse(context)) || context.next();
}
