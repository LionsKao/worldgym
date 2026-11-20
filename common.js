// 前台（script.js）與後台（admin.js）共用的前端工具：API 網域、HTML 跳脫、自製下拉選單、下拉重新整理、
// 日期與月份計算、折線圖。沒有 build step，所以是普通的全域函式與常數，兩個頁面都要在自己的 script 之前載入
// （見 index.html、admin.html 的 <script> 順序；頂層 const 在傳統 script 之間共用全域，所以 script.js、admin.js
// 不能再宣告同名的）。改了這個檔案要同步更新兩個 html 裡 common.js 的 ?v= 版號。

// 打自家 Worker API 的網址：前台與後台共用這一份。改網域時還要同步改 _headers 的 CSP connect-src 與 Worker 的 ALLOWED_ORIGINS。
const WORKER_BASE = "https://worldgym-api.lions2100.workers.dev";

function pad2(n){
  return String(n).padStart(2, "0");
}

function escapeHtml(str){
  return String(str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// 解析 API 回應的 JSON；狀態碼不是 2xx 就丟錯（訊息優先用回應裡的 error 欄位，沒有就用 HTTP 狀態碼）。
// 前台與後台打 Worker API 都是這個樣板，不要各自再寫一份。
async function readJsonOrThrow(res){
  // 錯誤回應不一定是 JSON（Cloudflare 的 5xx 頁面、海外 IP 被擋時的純文字 Forbidden）：解析失敗時，
  // 狀態碼不對就丟 HTTP 狀態碼，不要讓呼叫端只看到莫名其妙的 SyntaxError。
  let data;
  try {
    data = await res.json();
  } catch {
    throw new Error(res.ok ? "invalid JSON response" : `HTTP ${res.status}`);
  }
  if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
  return data;
}
async function fetchJson(url, options){
  return readJsonOrThrow(await fetch(url, options));
}

// 是不是以「加到主畫面」的獨立模式（PWA）開啟：iOS 看 navigator.standalone，其他瀏覽器看 display-mode。
function isStandaloneDisplay(){
  return window.navigator.standalone === true || window.matchMedia("(display-mode: standalone)").matches;
}

// 自製下拉選單：外觀跟 .section-search 一致，但不用原生 <select>（原生下拉的箭頭位置/樣式沒辦法客製）。
// root 是 .custom-select 容器，內含 .custom-select-trigger 按鈕跟 .custom-select-menu 選項列表。
// 用 root.value（getter/setter）+ root.addEventListener("change", ...) 模擬原生 select 的介面，
// 呼叫端程式碼幾乎不用改。root.setOptions(options, selectedValue) 用來動態換選項（廣告清單、年份/月份清單都是動態抓的）。
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
    // 找不到 selectedValue 時退回第一項：標籤、值與選單裡高亮的列要是同一項。
    const sel = options.find((o) => o.value === selectedValue) || options[0];
    menu.innerHTML = options
      .map((o) => `<div class="custom-select-option${o === sel ? " selected" : ""}" data-value="${escapeHtml(o.value)}">${o.html}</div>`)
      .join("");
    label.innerHTML = sel ? sel.html : "";
    root.dataset.value = sel ? sel.value : "";
  };
}

// --- 月份計算（折線圖的橫軸固定是「近 CHART_MONTHS 個月」，沒紀錄的月份補 0）---
const CHART_MONTHS = 12;

// 台灣今天的日期（YYYY-MM-DD）。用 Asia/Taipei 而不是使用者裝置的本地時區或 UTC（toISOString）：
// 跟後端 worker/src/util.js 的 todayIsoTaipei() 對齊，不然裝置時區不是台灣時，「今天」在前後端會算出不同的星期幾；
// 台灣每月 1 號 00:00–08:00 UTC 還是上個月，用 UTC 的話圖表視窗會少顯示當月。前後台都用這一個，不要各自再算一份。
function todayIso(){
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei" }).format(new Date());
}
// 台灣現在的日期與時間（YYYY-MM-DD HH:mm），字串可以直接比大小；彩蛋要精確到幾點結束時用（只看日期用 todayIso）。
// hour 用 % 24 擋掉部分舊瀏覽器在午夜回傳 "24" 的怪癖。
function taipeiNowStamp(){
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date()).map((p) => [p.type, p.value]));
  const hour = pad2(Number(parts.hour) % 24);
  return `${parts.year}-${parts.month}-${parts.day} ${hour}:${parts.minute}`;
}
// 日期（YYYY-MM-DD）加減天數：純日曆運算，用 UTC 做，不受裝置時區與日光節約時間影響（跟 worker/src/util.js 的 addDaysIso 同一個做法）。
function addDaysIso(iso, days){
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
// 台灣現在是哪個月（YYYY-MM），跟 Worker 用台灣時間算的月份對得上。
function currentMonthKey(){
  return todayIso().slice(0, 7);
}

function addMonths(monthStr, delta){
  const [y, m] = monthStr.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}`;
}

// 由舊到新的月份視窗：以 endMonth 為最右邊，往前共 count 個月；valuesOf(月份字串) 回傳那個月的數值欄位。
function buildMonthWindow(count, endMonth, valuesOf){
  const months = [];
  for (let i = count - 1; i >= 0; i--) months.push(addMonths(endMonth, -i));
  return months.map((m) => ({ month: m, ...valuesOf(m) }));
}

// --- Chart.js 共用設定：跟站內配色風格一致（字型各頁面自己設）---
// Chart.js 畫在 canvas 上、吃不到 CSS，所以顏色從 style.css 的 CSS 變數讀（淺色／深色各自定義），
// 而且寫成 scriptable option（傳函式，每次重繪才取值）：換主題時 retintCharts() 清掉快取、叫所有圖表重畫一次就好，不用重建。
let chartThemeCache = null;
function chartTheme(){
  if (!chartThemeCache){
    const css = getComputedStyle(document.documentElement);
    const read = (name) => css.getPropertyValue(name).trim();
    chartThemeCache = { ink: read("--ink"), sub: read("--sub"), line: read("--line"), tip: read("--chart-tip") };
  }
  return chartThemeCache;
}
function retintCharts(){
  chartThemeCache = null;
  if (window.Chart) Object.values(Chart.instances).forEach((chart) => chart.update("none"));
}
const CHART_TOOLTIP_STYLE = {
  backgroundColor: () => chartTheme().tip, titleColor: "#fff", bodyColor: "#fff",
  titleFont: { size: 11, weight: "700" }, bodyFont: { size: 11 },
  padding: 8, cornerRadius: 8, displayColors: false,
};

// 雙軸圖的座標軸 id；兩條線時左右各一個。
const LINE_CHART_AXIS_IDS = ["yA", "yB"];

// Y 軸上限：挑「分成 4 格、每格剛好是整數、而且數字好讀」的最小上限。
// 左右兩邊固定都是 4 格（ticks.count: 5）才能對齊同一條水平格線，但數值很小時（最大 1～3），Chart.js 會自己算出
// 0、0.25、0.5… 這種小數刻度，標籤四捨五入成整數就變成「0 0 1 1 1」這樣重複、甚至不準的數字（1.75 標成 2）。
// 所以上限由我們決定：步長從 1、1.2、1.5、2、2.5、3、4、5、6、8 乘 10 的次方裡，挑第一個「是整數、而且 ≥ 最大值 / 4」的。
// 例：最大 1 → 0～4（步長 1）；最大 7 → 0～8（步長 2）；最大 110 → 0～120（步長 30）；最大 8123 → 0～10000（步長 2500）。
const AXIS_STEP_MULTIPLIERS = [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8];
function niceAxisMax(values){
  const peak = Math.max(0, ...values.map((v) => Number(v) || 0));
  const target = Math.max(peak / 4, 1);
  if (!Number.isFinite(target)) return undefined; // 不是有限數字就交給 Chart.js 自己算，不能進下面的無窮迴圈
  for (let power = 1; ; power *= 10){
    for (const m of AXIS_STEP_MULTIPLIERS){
      const step = m * power;
      if (Number.isInteger(step) && step >= target) return step * 4;
    }
  }
}

function monthTickLabel(d){
  const parts = d.month.split("-");
  // 每日資料（YYYY-MM-DD，後台語音面板）只顯示「月/日」；月度資料（YYYY-MM）維持上下兩行「年／月」。
  if (parts.length === 3) return [`${parts[1]}/${parts[2]}`];
  return [parts[0], parts[1]];
}

// 月度折線圖工廠：data 是 [{ month: "YYYY-MM", ...數值欄位 }]（後台語音面板傳每日資料，month 放 "YYYY-MM-DD"），series 是 [{ key, label, color }]（一或兩條）。
// 兩條線時用左右各自獨立的座標軸（yA、yB），避免量級差太大時其中一條線貼著 0 看不出變化；
// ticks.count 固定成一樣的格線數，讓左右座標的刻度對齊同一條水平格線。
// aspectRatio 有給就固定寬高比；不給就撐滿容器（高度由 CSS 的 min-height 決定，才不會動態改高度造成 CLS）。
function createLineChart(canvas, { data, series, ariaLabel, aspectRatio }){
  canvas.setAttribute("role", "img");
  canvas.setAttribute("aria-label", ariaLabel);
  const axisIds = LINE_CHART_AXIS_IDS;
  const scales = { x: { grid: { display: false }, ticks: { color: () => chartTheme().sub, font: { size: 9 } } } };
  series.forEach((s, i) => {
    scales[axisIds[i]] = {
      position: i === 0 ? "left" : "right", beginAtZero: true, max: niceAxisMax(data.map((d) => d[s.key])),
      ticks: { color: s.color, font: { size: 9 }, count: 5, precision: 0, callback: (v) => Math.round(v) },
      grid: i === 0 ? { color: () => chartTheme().line } : { display: false },
    };
  });
  const chart = new Chart(canvas, {
    type: "line",
    data: {
      labels: data.map(monthTickLabel),
      datasets: series.map((s, i) => ({
        label: s.label, data: data.map((d) => d[s.key]), borderColor: s.color, backgroundColor: s.color,
        yAxisID: axisIds[i], tension: 0.3, pointRadius: 4, pointHoverRadius: 5, borderWidth: 3,
      })),
    },
    options: {
      responsive: true,
      maintainAspectRatio: !!aspectRatio,
      ...(aspectRatio ? { aspectRatio } : {}),
      animation: { duration: 1600 },
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          ...CHART_TOOLTIP_STYLE,
          callbacks: {
            title: (items) => items[0].chart.wgData[items[0].dataIndex].month,
            label: (item) => `${item.dataset.label} ${item.formattedValue}`,
          },
        },
      },
      scales,
    },
  });
  chart.wgData = data;
  chart.wgSeries = series;
  return chart;
}

// 換一份資料（例如左右切換月份視窗）：沿用建立時的 series，不重建圖表。
function updateLineChart(chart, data){
  chart.data.labels = data.map(monthTickLabel);
  chart.wgSeries.forEach((s, i) => {
    chart.data.datasets[i].data = data.map((d) => d[s.key]);
    chart.options.scales[LINE_CHART_AXIS_IDS[i]].max = niceAxisMax(data.map((d) => d[s.key])); // 換資料後上限要跟著重算
  });
  chart.wgData = data;
  chart.update();
}

// iOS「加入主畫面」後是獨立模式，沒有瀏覽器原生的下拉重新整理，補一個簡易版本。
(function setupPullToRefresh(){
  if (!isStandaloneDisplay()) return;
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

  // 觸控被系統取消（邊緣手勢、來電、通知欄）時不會有 touchend，不收尾的話指示器會卡在拉到一半的位置、pulling 一直是 true。
  document.addEventListener("touchcancel", () => {
    if (!pulling || refreshing) return;
    pulling = false;
    indicator.classList.add("ptr-releasing");
    indicator.style.top = "-50px";
  }, { passive: true });
})();
