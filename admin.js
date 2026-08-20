const WORKER_BASE = "https://worldgym-api.lions2100.workers.dev";
const TOKEN_STORAGE_KEY = "worldgym_admin_token";

// 密碼跟 worker 的 MANUAL_SCRAPE_TOKEN secret 對應。登入成功後存在 localStorage，
// 之後每次操作都帶著送到後端驗證，密碼本身不會寫死在原始碼裡（repo 是公開的）。
function getStoredToken(){ return localStorage.getItem(TOKEN_STORAGE_KEY) || ""; }
function setStoredToken(token){ localStorage.setItem(TOKEN_STORAGE_KEY, token); }
function clearStoredToken(){ localStorage.removeItem(TOKEN_STORAGE_KEY); }

async function verifyToken(token){
  const res = await fetch(`${WORKER_BASE}/verifyAdminToken`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
  });
  return res.ok;
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
    const ok = await verifyToken(token);
    if (ok){
      setStoredToken(token);
      showAdminPage();
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
  if (stored && await verifyToken(stored).catch(() => false)){
    showAdminPage();
    loadAdStats();
    loadFavoriteStats();
  } else {
    clearStoredToken();
    showLoginOverlay();
  }
})();

function escapeHtml(str){
  return String(str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// 自製下拉選單：外觀跟 .section-search 一致，但不用原生 <select>（原生下拉的箭頭位置/樣式沒辦法客製）。
// root 是 .custom-select 容器，內含 .custom-select-trigger 按鈕跟 .custom-select-menu 選項列表。
// 用 root.value（getter/setter）+ root.addEventListener("change", ...) 模擬原生 select 的介面，
// 呼叫端程式碼幾乎不用改。root.setOptions(options, selectedValue) 用來動態換選項（廣告清單用）。
function enhanceCustomSelect(root){
  const trigger = root.querySelector(".custom-select-trigger");
  const label = root.querySelector(".custom-select-label");
  const menu = root.querySelector(".custom-select-menu");

  function close(){ root.classList.remove("open"); }
  function open(){ root.classList.add("open"); }

  function selectOption(optionEl, { silent = false } = {}){
    menu.querySelectorAll(".custom-select-option").forEach((o) => o.classList.toggle("selected", o === optionEl));
    label.innerHTML = optionEl.innerHTML;
    root.dataset.value = optionEl.dataset.value;
    close();
    if (!silent) root.dispatchEvent(new Event("change"));
  }

  trigger.addEventListener("click", (e) => {
    e.stopPropagation();
    root.classList.contains("open") ? close() : open();
  });
  menu.addEventListener("click", (e) => {
    const opt = e.target.closest(".custom-select-option");
    if (opt) selectOption(opt);
  });
  document.addEventListener("click", (e) => {
    if (!root.contains(e.target)) close();
  });

  Object.defineProperty(root, "value", {
    get(){ return root.dataset.value || ""; },
    set(v){
      const opt = menu.querySelector(`.custom-select-option[data-value="${CSS.escape(String(v))}"]`);
      if (opt) selectOption(opt, { silent: true });
    },
  });

  root.setOptions = function(options, selectedValue){
    menu.innerHTML = options
      .map((o) => `<div class="custom-select-option${o.value === selectedValue ? " selected" : ""}" data-value="${escapeHtml(o.value)}">${o.html}</div>`)
      .join("");
    const sel = options.find((o) => o.value === selectedValue) || options[0];
    label.innerHTML = sel ? sel.html : "";
    root.dataset.value = sel ? sel.value : "";
  };
}

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
const CHART_MONTHS = 12;

let chartEndMonth = null;
let currentChartAd = null;

function currentMonthKey(){ return new Date().toISOString().slice(0, 7); }

function addMonths(monthStr, delta){
  const [y, m] = monthStr.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function monthLabel(monthStr){ return monthStr; }

function buildChartWindow(ad, endMonth){
  const months = [];
  for (let i = CHART_MONTHS - 1; i >= 0; i--) months.push(addMonths(endMonth, -i));
  return months.map((m) => ({
    month: m,
    impressions: ad.monthly?.[m]?.impressions || 0,
    clicks: ad.monthly?.[m]?.clicks || 0,
  }));
}

// --- Chart.js 共用設定：跟站內字體/配色風格一致，雙折線圖(曝光/點擊、查詢次數/結果數)共用同一套工廠函式 ---
Chart.defaults.font.family = "Nunito, sans-serif";
Chart.defaults.font.weight = "600";
const THEME_INK = "#2b2b2b", THEME_SUB = "#7a7a7a", THEME_LINE = "#ececec";

function monthTickLabel(d){
  const [yyyy, mm] = d.month.split("-");
  return [yyyy, mm];
}

// 雙 Y 軸折線圖工廠：曝光/點擊、查詢次數/結果數圖都用這個，用左右各自獨立座標軸避免量級差太大時
// 其中一條線貼著 0 看不出變化。ticks.count 固定成一樣的格線數，讓左右座標的刻度對齊同一條水平格線。
function createDualLineChart(canvas, { data, keyA, labelA, colorA, keyB, labelB, colorB, ariaLabel }){
  canvas.setAttribute("role", "img");
  canvas.setAttribute("aria-label", ariaLabel);
  const chart = new Chart(canvas, {
    type: "line",
    data: {
      labels: data.map(monthTickLabel),
      datasets: [
        { label: labelA, data: data.map((d) => d[keyA]), borderColor: colorA, backgroundColor: colorA, yAxisID: "yA", tension: 0.3, pointRadius: 4, pointHoverRadius: 5, borderWidth: 3 },
        { label: labelB, data: data.map((d) => d[keyB]), borderColor: colorB, backgroundColor: colorB, yAxisID: "yB", tension: 0.3, pointRadius: 4, pointHoverRadius: 5, borderWidth: 3 },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: true,
      aspectRatio: CHART_W / CHART_H,
      animation: { duration: 280 },
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: THEME_INK, titleColor: "#fff", bodyColor: "#fff",
          titleFont: { size: 11, weight: "700" }, bodyFont: { size: 11 },
          padding: 8, cornerRadius: 8, displayColors: false,
          callbacks: {
            title: (items) => items[0].chart.wgData[items[0].dataIndex].month,
            label: (item) => `${item.dataset.label} ${item.formattedValue}`,
          },
        },
      },
      scales: {
        x: { grid: { display: false }, ticks: { color: THEME_SUB, font: { size: 9 } } },
        yA: { position: "left", beginAtZero: true, ticks: { color: colorA, font: { size: 9 }, count: 5, precision: 0, callback: (v) => Math.round(v) }, grid: { color: THEME_LINE } },
        yB: { position: "right", beginAtZero: true, ticks: { color: colorB, font: { size: 9 }, count: 5, precision: 0, callback: (v) => Math.round(v) }, grid: { display: false } },
      },
    },
  });
  chart.wgData = data;
  return chart;
}

function updateDualLineChart(chart, data, keyA, keyB){
  chart.data.labels = data.map(monthTickLabel);
  chart.data.datasets[0].data = data.map((d) => d[keyA]);
  chart.data.datasets[1].data = data.map((d) => d[keyB]);
  chart.wgData = data;
  chart.update();
}

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
  adChartInstance = createDualLineChart(adChartViewport.querySelector("canvas"), {
    data, keyA: "impressions", labelA: "曝光次數", colorA: "#2a78d6", keyB: "clicks", labelB: "點擊次數", colorB: "#eb6834",
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
  updateDualLineChart(adChartInstance, buildChartWindow(currentChartAd, chartEndMonth), "impressions", "clicks");
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
    const res = await fetch(`${WORKER_BASE}/adStats?token=${encodeURIComponent(getStoredToken())}`);
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
  const months = [];
  for (let i = CHART_MONTHS - 1; i >= 0; i--) months.push(addMonths(endMonth, -i));
  return months.map((m) => ({ month: m, adders: monthlyAdders[m] || 0, applies: monthlyApplies[m] || 0 }));
}

async function loadFavoriteStats(){
  try{
    const res = await fetch(`${WORKER_BASE}/favoriteStats?token=${encodeURIComponent(getStoredToken())}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    favoriteStatsSummary.innerHTML = `
      <div class="favorite-stats-item"><div class="favorite-stats-num">${data.totalAdders || 0}</div><div class="favorite-stats-label">累積建立人數</div></div>
      <div class="favorite-stats-item"><div class="favorite-stats-num">${data.totalApplies || 0}</div><div class="favorite-stats-label">累積使用次數</div></div>
    `;
    const data12 = buildFavoriteTrendWindow(data.monthlyAdders || {}, data.monthlyApplies || {}, currentMonthKey());
    if (favoriteTrendChartInstance){ favoriteTrendChartInstance.destroy(); favoriteTrendChartInstance = null; }
    favoriteTrendWrap.innerHTML = '<div class="ad-chart-viewport"><canvas></canvas></div>';
    favoriteTrendChartInstance = createDualLineChart(favoriteTrendWrap.querySelector("canvas"), {
      data: data12, keyA: "adders", labelA: "建立人數", colorA: "#2a78d6", keyB: "applies", labelB: "使用次數", colorB: "#eb6834",
      ariaLabel: `近 ${CHART_MONTHS} 個月最愛建立人數與使用次數趨勢`,
    });
  } catch(e){
    console.error(e);
    favoriteStatsSummary.textContent = "";
    favoriteTrendWrap.textContent = "載入失敗，請重新登入";
  }
}

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
  const res = await fetch(`${WORKER_BASE}/scrapeManual?token=${encodeURIComponent(getStoredToken())}`);
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
    body: JSON.stringify({ token: getStoredToken() }),
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

// iOS「加入主畫面」後是獨立模式，沒有瀏覽器原生的下拉重新整理，補一個簡易版本。
(function setupPullToRefresh(){
  const isStandalone = window.navigator.standalone === true || window.matchMedia("(display-mode: standalone)").matches;
  if (!isStandalone) return;
  const indicator = document.getElementById("ptrIndicator");
  const THRESHOLD = 70;
  const MAX_PULL = 100;
  let startY = 0;
  let pulling = false;
  let refreshing = false;

  document.addEventListener("touchstart", (e) => {
    if (refreshing) return;
    if (window.scrollY > 0){ pulling = false; return; }
    startY = e.touches[0].clientY;
    pulling = true;
    indicator.classList.remove("ptr-releasing");
  }, { passive: true });

  document.addEventListener("touchmove", (e) => {
    if (!pulling || refreshing) return;
    const delta = e.touches[0].clientY - startY;
    if (delta <= 0){ indicator.style.top = "-50px"; return; }
    const pull = Math.min(delta / 2, MAX_PULL);
    indicator.style.top = `${pull - 50}px`;
    indicator.style.transform = `translate(-50%, 0) rotate(${pull * 3}deg)`;
  }, { passive: true });

  document.addEventListener("touchend", () => {
    if (!pulling || refreshing) return;
    pulling = false;
    indicator.classList.add("ptr-releasing");
    const top = parseFloat(indicator.style.top || "-50");
    if (top + 50 >= THRESHOLD){
      refreshing = true;
      indicator.style.top = "16px";
      indicator.style.transform = "translate(-50%, 0) rotate(0deg)";
      indicator.classList.add("ptr-refreshing");
      setTimeout(() => location.reload(), 300);
    } else {
      indicator.style.top = "-50px";
    }
  });
})();
