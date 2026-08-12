// 跟 worker 的 MANUAL_SCRAPE_TOKEN secret 對應，只是擋掉不知道網址也不知道這個值的人，不是真的登入機制。
const RESCRAPE_TOKEN = "worldgym-local-test-token";
const WORKER_BASE = "https://worldgym-api.lions2100.workers.dev";

const modal = document.getElementById("rescrapeModal");
const modalText = document.getElementById("rescrapeModalText");
const confirmBtn = document.getElementById("rescrapeConfirmBtn");
const cancelBtn = document.getElementById("rescrapeCancelBtn");
const terminalLog = document.getElementById("terminalLog");

// --- 終端機面板：所有操作的進度/結果統一顯示在這裡，不再另外用 modal 顯示結果文字 ---
function pad2(n){ return String(n).padStart(2, "0"); }
function nowHms(){
  const d = new Date();
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}
function classifyLine(text){
  if (text.startsWith("✅") || text.startsWith("🎉")) return "ok";
  if (text.startsWith("❌")) return "err";
  return null;
}
function clearTerminal(){
  terminalLog.textContent = "";
}
function appendTerminalLine(text, kind){
  const line = document.createElement("div");
  line.className = kind ? `term-line term-${kind}` : "term-line";
  const time = document.createElement("span");
  time.className = "term-time";
  time.textContent = `[${nowHms()}]`;
  line.appendChild(time);
  line.appendChild(document.createTextNode(text));
  terminalLog.appendChild(line);
  terminalLog.scrollTop = terminalLog.scrollHeight;
}
function logToTerminal(text){
  appendTerminalLine(text, classifyLine(text));
}

// Cloudflare Worker 自己打官網。回應是 NDJSON 串流（每行一個 JSON 物件），
// 邊讀邊把 type:"log" 的行丟給 onLog 即時顯示，最後一行是 type:"result" 或 type:"error"。
async function rescrapeViaCloudflare(onLog){
  const res = await fetch(`${WORKER_BASE}/scrapeManual?token=${encodeURIComponent(RESCRAPE_TOKEN)}`);
  if (!res.ok || !res.body){
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let result = null;
  while (true){
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newlineIndex;
    while ((newlineIndex = buffer.indexOf("\n")) >= 0){
      const line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      if (msg.type === "log") onLog(msg.text);
      else if (msg.type === "result") result = msg;
      else if (msg.type === "error") throw new Error(msg.message);
    }
  }
  if (!result) throw new Error("未收到重抓結果");
  return { classesWritten: result.classesWritten || 0, staleDeleted: result.staleDeleted || 0, errors: result.errors || [] };
}

// 刪除不在目前分店清單（branches-seed.js）裡的舊課表資料。只是單一次查詢+刪除，不像重抓要跑
// 106 家分店那麼久，所以不用真的串流，這裡自己組幾行進度文字丟給 onLog，維持跟終端機一致的體驗。
async function cleanupStaleBranches(onLog){
  onLog("🔍 比對目前分店清單...");
  const res = await fetch(`${WORKER_BASE}/cleanupStaleBranches`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: RESCRAPE_TOKEN }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  if (data.staleBranches && data.staleBranches.length){
    data.staleBranches.forEach((slug) => onLog(`🗑️ 清除分店：${slug}`));
  } else {
    onLog("✅ 沒有找到已停用分店的舊資料");
  }
  onLog(`📊 一共刪除 ${data.deleted} 筆課程`);
  onLog("🎉 清除完成！");
  return data;
}

// 執行一個會即時輸出進度的動作：清空終端機、跑 action、有錯誤的話印一行紅字。
async function runAction(action){
  clearTerminal();
  try{
    await action(logToTerminal);
  } catch(e){
    console.error(e);
    logToTerminal(`❌ ${e.message}`);
  }
}

// 只有「重抓所有分店」需要 modal 二次確認（怕誤按、跑一次要一兩分鐘）。
// 其他動作（清除孤兒資料、開啟外部連結）直接執行，結果都看終端機就好。
function openConfirmModal(){
  modalText.textContent = "確定要重抓全部分店的課表嗎？";
  modal.classList.remove("hidden");
}
function closeConfirmModal(){
  modal.classList.add("hidden");
}
document.getElementById("rescrapeCloseBtn").addEventListener("click", closeConfirmModal);
cancelBtn.addEventListener("click", closeConfirmModal);
confirmBtn.addEventListener("click", () => {
  closeConfirmModal();
  runAction(rescrapeViaCloudflare);
});

document.getElementById("rescrapeAllCf").addEventListener("click", openConfirmModal);
document.getElementById("cleanupStaleBtn").addEventListener("click", () => runAction(cleanupStaleBranches));

document.querySelectorAll(".admin-link-btn[data-log-text]").forEach((link) => {
  link.addEventListener("click", () => logToTerminal(link.dataset.logText));
});
