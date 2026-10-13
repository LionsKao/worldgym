const WORKER_BASE = "https://worldgym-api.lions2100.workers.dev";
const TOKEN_STORAGE_KEY = "worldgym_admin_token";
const ADMIN_TOKEN_HEADER = "X-Admin-Token";

// 密碼跟 worker 的 MANUAL_SCRAPE_TOKEN secret 對應，密碼本身不會寫死在原始碼裡（repo 是公開的）。
// 登入成功後實際存進 localStorage、之後每次操作帶出去的，是 worker 換發的 7 天效期 session
// token，不是原始密碼——密碼只在登入當下送出一次，降低它在網路上被送出的次數；session token
// 過期或失效，重新輸入密碼即可換到新的一張。一律用 header 帶（不是 URL query string／JSON
// body），避免 token 被記進網址、外流到瀏覽器紀錄或中介的存取日誌。
function getStoredToken(){ return localStorage.getItem(TOKEN_STORAGE_KEY) || ""; }
function setStoredToken(token){ localStorage.setItem(TOKEN_STORAGE_KEY, token); }
function clearStoredToken(){ localStorage.removeItem(TOKEN_STORAGE_KEY); }

// 已登入後的後台呼叫統一走這個 helper 帶 header，避免每個呼叫點各自組 header 時漏掉。
function adminFetch(path, options = {}){
  return fetch(`${WORKER_BASE}${path}`, {
    ...options,
    headers: { ...(options.headers || {}), [ADMIN_TOKEN_HEADER]: getStoredToken() },
  });
}

// 登入流程驗證的是使用者剛輸入、還沒存起來的密碼，所以不能用 adminFetch（它讀的是已存的 token）。
// 驗證成功會換到一張有效期限的 session token（見 worker 的 issueAdminSession），之後改存/送
// 這張，不是原始密碼本身——降低密碼實際被送出網路的次數。
// 回傳 { sessionToken } 表示成功、{ locked: true } 表示連續失敗次數過多被鎖定、null 表示單純密碼錯誤。
async function verifyToken(token){
  const res = await fetch(`${WORKER_BASE}/verifyAdminToken`, {
    method: "POST",
    headers: { [ADMIN_TOKEN_HEADER]: token },
  });
  if (res.status === 423) return { locked: true };
  if (!res.ok) return null;
  const data = await res.json().catch(() => null);
  return data?.sessionToken ? { sessionToken: data.sessionToken } : null;
}

const loginOverlay = document.getElementById("adminLoginOverlay");
const adminPage = document.getElementById("adminPage");
const adminBackBtnWrap = document.getElementById("adminBackBtnWrap");
const adminLoginBackBtnWrap = document.getElementById("adminLoginBackBtnWrap");
const passwordInput = document.getElementById("adminPasswordInput");
const loginError = document.getElementById("adminLoginError");
const loginBtn = document.getElementById("adminLoginBtn");

function showAdminPage(){
  loginOverlay.classList.add("hidden");
  adminLoginBackBtnWrap.classList.add("hidden");
  adminPage.classList.remove("hidden");
  adminBackBtnWrap.classList.remove("hidden");
}
let loginErrorTimer = null;

function showLoginOverlay(){
  adminPage.classList.add("hidden");
  adminBackBtnWrap.classList.add("hidden");
  loginOverlay.classList.remove("hidden");
  adminLoginBackBtnWrap.classList.remove("hidden");
  passwordInput.value = "";
  hideLoginError();
  passwordInput.focus();
}

function logoutAndLeave(){
  clearStoredToken();
  window.location.href = "index.html";
}

// 密碼錯誤的提示用 tooltip 顯示在登入按鈕上方，顯示一陣子後自動消失，消失時順便清掉使用者打的字，
// 讓使用者不用自己手動清空重打。
function showLoginError(text){
  if (loginErrorTimer) clearTimeout(loginErrorTimer);
  loginError.textContent = text;
  loginError.classList.add("visible");
  loginErrorTimer = setTimeout(() => {
    hideLoginError();
    passwordInput.value = "";
    passwordInput.focus();
  }, 1600);
}
function hideLoginError(){
  if (loginErrorTimer){ clearTimeout(loginErrorTimer); loginErrorTimer = null; }
  loginError.classList.remove("visible");
}

async function attemptLogin(){
  const token = passwordInput.value;
  if (!token){ showLoginError("沒有輸入密碼"); return; }
  loginBtn.disabled = true;
  hideLoginError();
  try{
    const result = await verifyToken(token);
    if (result?.sessionToken){
      setStoredToken(result.sessionToken);
      showAdminPage();
      loadAdStats();
      loadFavoriteStats();
      loadReminderStats();
      loadQueryAccessStats();
    } else if (result?.locked){
      showLoginError("嘗試次數過多，已暫時鎖定，請稍後再試");
    } else {
      showLoginError("密碼錯誤");
    }
  } catch(e){
    console.error(e);
    showLoginError("連線失敗，請稍後再試");
  } finally {
    loginBtn.disabled = false;
  }
}

loginBtn.addEventListener("click", attemptLogin);
passwordInput.addEventListener("keydown", (e) => { if (e.key === "Enter") attemptLogin(); });
const adminBackBtn = document.getElementById("adminBackBtn");
const adminBackTooltip = document.getElementById("adminBackTooltip");
adminBackBtn.addEventListener("click", logoutAndLeave);
adminBackBtn.addEventListener("mouseenter", () => adminBackTooltip.classList.add("visible"));
adminBackBtn.addEventListener("mouseleave", () => adminBackTooltip.classList.remove("visible"));

(async function initAuth(){
  const stored = getStoredToken();
  const result = stored && await verifyToken(stored).catch(() => null);
  if (result?.sessionToken){
    setStoredToken(result.sessionToken); // 換到新的 session token，滑動延長 7 天效期
    showAdminPage();
    loadAdStats();
    loadFavoriteStats();
    loadReminderStats();
    loadQueryAccessStats();
  } else {
    clearStoredToken();
    showLoginOverlay();
  }
})();

// --- 廣告統計面板：一次抓全部廣告（含已下架）+ 累計曝光/點擊，下拉選單切換不用重打 API ---
let AD_STATS = [];
const adStatsSelect = document.getElementById("adStatsSelect");
const adStatsDetail = document.getElementById("adStatsDetail");
const adStatusFilter = document.getElementById("adStatusFilter");
enhanceCustomSelect(adStatsSelect);
enhanceCustomSelect(adStatusFilter);

let currentFilteredAds = [];

// 「全部」是加總目前篩選出的所有廣告（依 adStatusFilter），逐月把曝光/點擊加起來變成一條總計折線；
// 選單裡選到特定廣告則單獨顯示那則廣告的曝光/點擊。
function buildAggregateAd(ads){
  if (!ads.length) return null;
  const monthly = {};
  for (const ad of ads){
    for (const [m, v] of Object.entries(ad.monthly || {})){
      const bucket = (monthly[m] ??= { impressions: 0, clicks: 0 });
      bucket.impressions += v.impressions || 0;
      bucket.clicks += v.clicks || 0;
    }
  }
  const startAt = ads.reduce((min, ad) => (ad.startAt < min ? ad.startAt : min), ads[0].startAt);
  return { id: "__all__", startAt, monthly };
}

function renderAdStatsDetail(adId){
  const ad = adId === "__all__" ? buildAggregateAd(currentFilteredAds) : AD_STATS.find((a) => a.id === adId);
  showAdChart(ad || null);
}

// --- 廣告曝光/點擊折線圖：近 6 個月，最右邊固定是「這個月」，左右箭頭切換月份視窗 ---
const adChartPrevBtn = document.getElementById("adChartPrevBtn");
const adChartNextBtn = document.getElementById("adChartNextBtn");
const adChartViewport = document.getElementById("adChartViewport");
const CHART_W = 560, CHART_H = 210;
const CHART_ASPECT_RATIO = CHART_W / CHART_H;

let chartEndMonth = null;
let currentChartAd = null;

function buildChartWindow(ad, endMonth){
  return buildMonthWindow(CHART_MONTHS, endMonth, (m) => ({
    impressions: ad.monthly?.[m]?.impressions || 0,
    clicks: ad.monthly?.[m]?.clicks || 0,
  }));
}

// --- Chart.js 設定：字型跟站內一致；折線圖工廠、月份計算與配色常數在 common.js ---
Chart.defaults.font.family = "Nunito, sans-serif";
Chart.defaults.font.weight = "600";

// 曝光/點擊用雙 Y 軸（兩者量級差很多，單一座標軸會讓其中一條線貼著 0 看不出變化）
const AD_CHART_SERIES = [
  { key: "impressions", label: "曝光次數", color: "#2a78d6" },
  { key: "clicks", label: "點擊次數", color: "#eb6834" },
];

let adChartInstance = null;

function updateChartNavState(){
  if (!currentChartAd){
    adChartPrevBtn.disabled = true;
    adChartNextBtn.disabled = true;
    return;
  }
  const startMonth = addMonths(chartEndMonth, -(CHART_MONTHS - 1));
  const adStartMonth = currentChartAd.startAt.slice(0, 7);
  adChartPrevBtn.disabled = startMonth <= adStartMonth;
  adChartNextBtn.disabled = chartEndMonth >= currentMonthKey();
}

function showAdChart(ad){
  currentChartAd = ad;
  if (adChartInstance){ adChartInstance.destroy(); adChartInstance = null; }
  if (!ad){
    adChartViewport.innerHTML = "";
    updateChartNavState();
    return;
  }
  chartEndMonth = currentMonthKey();
  const data = buildChartWindow(ad, chartEndMonth);
  adChartViewport.innerHTML = "<canvas></canvas>";
  adChartInstance = createLineChart(adChartViewport.querySelector("canvas"), {
    data, series: AD_CHART_SERIES, aspectRatio: CHART_ASPECT_RATIO,
    ariaLabel: `近 ${CHART_MONTHS} 個月曝光與點擊趨勢`,
  });
  updateChartNavState();
}

function navigateAdChart(direction){
  if (!currentChartAd || chartEndMonth === null) return;
  const nextEndMonth = addMonths(chartEndMonth, direction === "next" ? 1 : -1);
  if (direction === "next" && nextEndMonth > currentMonthKey()) return;
  const nextStartMonth = addMonths(nextEndMonth, -(CHART_MONTHS - 1));
  const adStartMonth = currentChartAd.startAt.slice(0, 7);
  if (direction === "prev" && nextStartMonth <= adStartMonth && addMonths(chartEndMonth, -(CHART_MONTHS - 1)) <= adStartMonth) return;

  chartEndMonth = nextEndMonth;
  updateLineChart(adChartInstance, buildChartWindow(currentChartAd, chartEndMonth));
  updateChartNavState();
}

adChartPrevBtn.addEventListener("click", () => navigateAdChart("prev"));
adChartNextBtn.addEventListener("click", () => navigateAdChart("next"));

function isAdActive(ad){
  const today = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
  return !!ad.enabled && ad.startAt.slice(0, 10) <= today && today <= ad.endAt.slice(0, 10);
}

function renderAdStatsSelect(){
  const filter = adStatusFilter.value;
  const filtered = AD_STATS.filter((ad) => {
    if (filter === "active") return isAdActive(ad);
    if (filter === "inactive") return !isAdActive(ad);
    return true;
  });
  currentFilteredAds = filtered;
  if (!filtered.length){
    adStatsSelect.setOptions([]);
    adStatsDetail.textContent = "沒有符合篩選條件的廣告";
    showAdChart(null);
    return;
  }
  adStatsDetail.textContent = "";
  const options = [
    { value: "__all__", html: "全部" },
    ...filtered.map((ad) => ({ value: ad.id, html: escapeHtml(ad.text) })),
  ];
  adStatsSelect.setOptions(options, "__all__");
  renderAdStatsDetail("__all__");
}

async function loadAdStats(){
  try{
    const res = await adminFetch("/adStats");
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    AD_STATS = Array.isArray(data.ads) ? data.ads : [];
    if (AD_STATS.length){
      renderAdStatsSelect();
    } else {
      adStatsSelect.setOptions([]);
      adStatsDetail.textContent = "目前沒有任何廣告資料";
    }
  } catch(e){
    console.error(e);
    adStatsDetail.textContent = "載入失敗，請重新登入";
  }
}
adStatsSelect.addEventListener("change", () => renderAdStatsDetail(adStatsSelect.value));
adStatusFilter.addEventListener("change", renderAdStatsSelect);

// --- 最愛統計：累積人數/次數用兩個大數字顯示，近 12 個月「建立人數/使用次數」跟其他雙數列折線圖同一套。 ---
const favoriteStatsSummary = document.getElementById("favoriteStatsSummary");
const favoriteTrendWrap = document.getElementById("favoriteTrendWrap");
let favoriteTrendChartInstance = null;

function buildFavoriteTrendWindow(monthlyAdders, monthlyApplies, endMonth){
  return buildMonthWindow(CHART_MONTHS, endMonth, (m) => ({ adders: monthlyAdders[m] || 0, applies: monthlyApplies[m] || 0 }));
}

async function loadFavoriteStats(){
  try{
    const res = await adminFetch("/favoriteStats");
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    favoriteStatsSummary.innerHTML = `
      <div class="favorite-stats-item"><div class="favorite-stats-num">${data.totalAdders || 0}</div><div class="favorite-stats-label">累積建立人數</div></div>
      <div class="favorite-stats-item"><div class="favorite-stats-num">${data.totalApplies || 0}</div><div class="favorite-stats-label">累積使用次數</div></div>
    `;
    const data12 = buildFavoriteTrendWindow(data.monthlyAdders || {}, data.monthlyApplies || {}, currentMonthKey());
    if (favoriteTrendChartInstance){ favoriteTrendChartInstance.destroy(); favoriteTrendChartInstance = null; }
    favoriteTrendWrap.innerHTML = '<div class="ad-chart-viewport"><canvas></canvas></div>';
    favoriteTrendChartInstance = createLineChart(favoriteTrendWrap.querySelector("canvas"), {
      data: data12, aspectRatio: CHART_ASPECT_RATIO,
      series: [
        { key: "adders", label: "建立人數", color: "#2a78d6" },
        { key: "applies", label: "使用次數", color: "#eb6834" },
      ],
      ariaLabel: `近 ${CHART_MONTHS} 個月最愛建立人數與使用次數趨勢`,
    });
  } catch(e){
    console.error(e);
    favoriteStatsSummary.textContent = "";
    favoriteTrendWrap.textContent = "載入失敗，請重新登入";
  }
}

// --- 提醒功能統計：只看每個月「登記提醒」被觸發幾次，評估功能有沒有人用，不用像最愛那樣分兩個數字。 ---
const reminderStatsSummary = document.getElementById("reminderStatsSummary");
const reminderTrendWrap = document.getElementById("reminderTrendWrap");
let reminderTrendChartInstance = null;

// 跟廣告/最愛面板的折線圖同一套邏輯：固定顯示近 CHART_MONTHS 個月、由舊到新排序，沒紀錄的月份補 0，
// 不會因為完全沒資料就整個面板空著、讓人誤以為功能壞掉。
function buildReminderMonthlyWindow(monthly, endMonth){
  const byMonth = {};
  for (const row of monthly) byMonth[row.month] = row.count;
  return buildMonthWindow(CHART_MONTHS, endMonth, (m) => ({ count: byMonth[m] || 0 }));
}

async function loadReminderStats(){
  try{
    const res = await adminFetch("/reminderStats");
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    reminderStatsSummary.innerHTML = `
      <div class="favorite-stats-item"><div class="favorite-stats-num">${data.total || 0}</div><div class="favorite-stats-label">累積登記次數</div></div>
    `;
    const data12 = buildReminderMonthlyWindow(data.monthly || [], currentMonthKey());
    if (reminderTrendChartInstance){ reminderTrendChartInstance.destroy(); reminderTrendChartInstance = null; }
    reminderTrendWrap.innerHTML = '<div class="ad-chart-viewport"><canvas></canvas></div>';
    reminderTrendChartInstance = createLineChart(reminderTrendWrap.querySelector("canvas"), {
      data: data12, aspectRatio: CHART_ASPECT_RATIO,
      series: [{ key: "count", label: "登記次數", color: "#3fae8f" }],
      ariaLabel: `近 ${CHART_MONTHS} 個月提醒登記次數趨勢`,
    });
  } catch(e){
    console.error(e);
    reminderStatsSummary.textContent = "";
    reminderTrendWrap.textContent = "載入失敗，請重新登入";
  }
}

// --- 存取紀錄面板：查 /issueToken、/queryClasses 有沒有被單一 IP 異常大量打（爬蟲/腳本），
// 依 IP 分組列出次數最多的前 30 個，rateLimitedCount > 0（有被流量限制擋過）的列特別標色。
const accessLogDaysFilter = document.getElementById("accessLogDaysFilter");
const accessLogTableWrap = document.getElementById("accessLogTableWrap");
enhanceCustomSelect(accessLogDaysFilter);

// 間隔變異係數(CV = 標準差 / 平均值)低於這個門檻，視為「間隔異常規律」，UI 特別標色提醒——
// 只是輔助判斷的信號，不是自動封鎖依據，見 worker/src/index.js 的 intervalCV()。
const REGULAR_CV_THRESHOLD = 0.3;

function formatIntervalCV(cv){
  if (cv === null || cv === undefined) return "-";
  return cv.toFixed(2);
}

function renderAccessLogTable(ips){
  if (!ips.length){
    accessLogTableWrap.innerHTML = '<span class="empty-hint">目前沒有存取紀錄</span>';
    return;
  }
  const rows = ips.map((row) => {
    const isRegular = typeof row.intervalCV === "number" && row.intervalCV < REGULAR_CV_THRESHOLD;
    const rowClasses = [
      row.rateLimitedCount > 0 ? "access-log-row-flagged" : "",
      isRegular ? "access-log-row-regular" : "",
    ].filter(Boolean).join(" ");
    return `
    <tr class="${rowClasses}">
      <td>${escapeHtml(row.ip)}</td>
      <td class="access-log-ua" title="${escapeHtml(row.userAgent || "")}">${escapeHtml(row.userAgent || "(無)")}</td>
      <td>${row.count}</td>
      <td>${row.rateLimitedCount}</td>
      <td title="間隔變異係數，越接近 0 代表請求間隔越規律；樣本數 < 10 不計算">${formatIntervalCV(row.intervalCV)}</td>
      <td>${escapeHtml(row.lastSeen || "")}</td>
    </tr>
  `;
  }).join("");
  accessLogTableWrap.innerHTML = `
    <table class="access-log-table">
      <thead><tr><th>IP</th><th>User-Agent</th><th>次數</th><th>被擋次數</th><th>規律性</th><th>最後出現時間</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

async function loadQueryAccessStats(){
  try{
    const days = accessLogDaysFilter.value || "7";
    const res = await adminFetch(`/queryAccessStats?days=${encodeURIComponent(days)}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    renderAccessLogTable(data.ips || []);
  } catch(e){
    console.error(e);
    accessLogTableWrap.textContent = "載入失敗，請重新登入";
  }
}
accessLogDaysFilter.addEventListener("change", loadQueryAccessStats);

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
  const res = await adminFetch("/scrapeManual");
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
// 一百多家分店那麼久，所以不用真的串流，這裡自己組幾行進度文字丟給 onLog，維持跟終端機一致的體驗。
async function cleanupStaleBranches(onLog){
  onLog("🔍 比對目前分店清單...");
  const res = await adminFetch("/cleanupStaleBranches", { method: "POST" });
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
