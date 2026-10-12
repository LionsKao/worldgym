// 動態 /llms.txt：靜態檔內容 + 分店索引（見 functions/_lib/llms.js）。
// 任何失敗就 context.next() 退回根目錄的靜態 llms.txt，所以靜態檔要留著當備援。
import { getLlmsResponse } from "./_lib/llms.js";

export async function onRequestGet(context) {
  return (await getLlmsResponse(context)) || context.next();
}
