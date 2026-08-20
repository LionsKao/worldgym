// 課表查詢、分店/課程/老師篩選選項都改由 Cloudflare Worker + D1 提供，不再直接用 Firestore client SDK。
const WORKER_BASE = "https://worldgym-api.lions2100.workers.dev";
// 篩選後結果超過這個筆數就視為條件太寬鬆，不導到結果頁、只在查詢按鈕上提示使用者多加篩選。
const RESULT_COUNT_WARN_LIMIT = 250;

// 課表通知（Web Push）：VAPID public key，跟 worker/.dev.vars 的 VAPID_PUBLIC_KEY 是同一組 key pair。
const VAPID_PUBLIC_KEY = "BCcFfPhUxaUYFMtosUu21nd24j5El9YcuYNndb3Ll0_rjC-SwSnT4YvQfi7nVTuQWYjIiDlZqG1jrZrwi7uuw4k";

// 網址帶 ?pwa=1 等同貼 localStorage.setItem("wg_debug_force_pwa","1")，方便直接分享測試連結，不用開 Console。
// 寫進 localStorage 才不會在查詢送出後被 buildShareUrl 換掉網址（只保留篩選參數）就失效。
if (new URLSearchParams(location.search).get("pwa") === "1"){
  localStorage.setItem("wg_debug_force_pwa", "1");
}

// 廣告文案輪播：內容改由 D1 的 ads table 提供（上下架時間 + enabled 開關），
// 首頁載入時打 /ads 拿目前生效中的廣告，每隔幾秒淡出換字再淡入，動畫時間要跟
// style.css 的 .ad-banner-text transition 對齊。每則廣告各自帶自己的連結，
// 切換文字時同步換掉外層 <a> 的 href。
let AD_BANNERS = [];
let currentAdIndex = 0;
// 廣告曝光/點擊落地存進 D1（跟 GA4 的 trackEvent 分開），失敗靜默吞掉，不影響前台體驗、不重試。
// 本機開發(localhost/127.0.0.1)不計入，避免測試把廣告曝光/點擊數字洗掉。
function trackAdEvent(adId, type){
  if (!adId) return;
  if (["localhost", "127.0.0.1"].includes(location.hostname)) return;
  fetch(`${WORKER_BASE}/trackAdEvent`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ adId, type }),
  }).catch(() => {});
}

// 老師/課程查詢次數落地存進 D1，用來給 admin.html 統計「哪些老師/課程最常被查」。
// 同一裝置 30 分鐘內重複查同一個值只算 1 次，避免上一頁/重查造成洗次數。
const SEARCH_COUNT_DEDUPE_WINDOW_MS = 30 * 60 * 1000;
function makeSearchCountLogger(dedupeKey, endpoint, paramName){
  function shouldLog(value){
    let map;
    try { map = JSON.parse(localStorage.getItem(dedupeKey) || "{}"); }
    catch { map = {}; }
    const now = Date.now();
    for (const k of Object.keys(map)){
      if (now - map[k] > SEARCH_COUNT_DEDUPE_WINDOW_MS) delete map[k];
    }
    const last = map[value];
    if (last && now - last < SEARCH_COUNT_DEDUPE_WINDOW_MS){
      localStorage.setItem(dedupeKey, JSON.stringify(map));
      return false;
    }
    map[value] = now;
    localStorage.setItem(dedupeKey, JSON.stringify(map));
    return true;
  }
  return function logSearches(values){
    for (const value of values || []){
      if (!value || !shouldLog(value)) continue;
      fetch(`${WORKER_BASE}/${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [paramName]: value }),
      }).catch(() => {});
    }
  };
}
const logTeacherSearches = makeSearchCountLogger("wg_teacher_search_dedupe", "trackTeacherSearch", "teacher");
const logCourseSearches = makeSearchCountLogger("wg_course_search_dedupe", "trackCourseSearch", "course");
const logBranchSearches = makeSearchCountLogger("wg_branch_search_dedupe", "trackBranchSearch", "branch");

// state.branch 存的是分店 slug，要轉成畫面上看到的分店名稱再記錄，admin.html 的長條圖才看得懂。
function branchSlugToLabel(slug){
  const input = document.querySelector(`input[name="branch"][value="${CSS.escape(slug)}"]`);
  return input ? input.nextElementSibling.textContent : slug;
}

// 整體查詢量落地存進 D1，每次真的送出查詢就打一次，不去重，用來看使用量趨勢。
// resultCount 記錄這次查詢實際顯示的課程數，沒結果或結果太多沒顯示時傳 0。
function logSearchEvent(resultCount){
  fetch(`${WORKER_BASE}/trackSearch`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ resultCount }),
  }).catch(() => {});
}

// 沒有帳號系統，只能用存在 localStorage 的匿名 id 估算「幾個人」用過某個功能，
// 不會拿去對應任何個人資料，純粹統計用。
const CLIENT_ID_KEY = "wg_client_id";
function getClientId(){
  let id = localStorage.getItem(CLIENT_ID_KEY);
  if (!id){
    id = crypto.randomUUID();
    localStorage.setItem(CLIENT_ID_KEY, id);
  }
  return id;
}

// 我的最愛使用量落地存進 D1：add 是成功建立一個最愛、apply 是點最愛套用篩選，不去重，
// 用來在 admin.html 看「多少人做起來」跟「做起來後按了幾次」。
function logFavoriteEvent(type){
  fetch(`${WORKER_BASE}/trackFavorite`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clientId: getClientId(), type }),
  }).catch(() => {});
}
// Fisher-Yates：廣告輪播每輪播完（回到開頭）就重新洗牌一次，順序不固定、也不會永遠重複同一種排列。
function shuffleAds(arr){
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--){
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function withUtmSource(url){
  try {
    const u = new URL(url);
    u.searchParams.set("utm_source", "worldgym.pages.dev");
    return u.toString();
  } catch(err){
    return url;
  }
}

function initAdBannerCarousel(){
  const banner = document.getElementById("adBanner");
  const el = document.getElementById("adBannerText");
  if (!banner || !el) return;
  if (AD_BANNERS.length === 0) {
    banner.classList.add("hidden");
    return;
  }
  AD_BANNERS = shuffleAds(AD_BANNERS);
  currentAdIndex = 0;
  el.textContent = AD_BANNERS[0].text;
  banner.href = withUtmSource(AD_BANNERS[0].url);
  trackAdEvent(AD_BANNERS[0].id, "impression");
  if (AD_BANNERS.length < 2) return;
  setInterval(() => {
    el.classList.add("fading");
    setTimeout(() => {
      currentAdIndex++;
      if (currentAdIndex >= AD_BANNERS.length){
        AD_BANNERS = shuffleAds(AD_BANNERS);
        currentAdIndex = 0;
      }
      el.textContent = AD_BANNERS[currentAdIndex].text;
      banner.href = withUtmSource(AD_BANNERS[currentAdIndex].url);
      el.classList.remove("fading");
      trackAdEvent(AD_BANNERS[currentAdIndex].id, "impression");
    }, 350);
  }, 5000);
}
fetch(`${WORKER_BASE}/ads`)
  .then((res) => (res.ok ? res.json() : { ads: [] }))
  .then((data) => { AD_BANNERS = Array.isArray(data.ads) ? data.ads : []; })
  .catch(() => { AD_BANNERS = []; })
  .finally(initAdBannerCarousel);
document.querySelector(".ad-banner")?.addEventListener("click", () => {
  trackEvent("click_ad_banner", { ad_text: document.getElementById("adBannerText")?.textContent });
  trackAdEvent(AD_BANNERS[currentAdIndex]?.id, "click");
});

// 鈴鐺只在「已安裝成 standalone PWA」才顯示，不要求通知權限已授權（未授權按下去會先跳說明 modal）。
// 除錯用旁路：正式環境使用者不會知道這個 localStorage key，只是方便開發時在一般分頁看到鈴鐺。
function isPWAInstalled(){
  if (localStorage.getItem("wg_debug_force_pwa") === "1") return true;
  return window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
}

if ("serviceWorker" in navigator){
  navigator.serviceWorker.register("sw.js").catch((e) => console.error("service worker 註冊失敗", e));
}

function urlBase64ToUint8Array(base64String){
  const padding = "=".repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

// 取得（或建立）目前裝置的 push subscription。權限已授權時 subscribe() 不會再跳提示。
async function ensurePushSubscription(){
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub){
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
    });
  }
  return sub;
}

// 課表通知：登記狀態存這個 Map，key -> { id, classAt, remindAt, ... }（來自 /myReminders 或剛登記完的回應）。
const registeredReminders = new Map();
function reminderKeyFromFields(branchSlug, dayOfWeek, startTime, className, teacherName){
  return [branchSlug, dayOfWeek, startTime, className, teacherName].join("|");
}
function reminderKeyFromBell(bell){
  return reminderKeyFromFields(bell.dataset.branchSlug, bell.dataset.dayOfWeek, bell.dataset.startTime, bell.dataset.className, bell.dataset.teacherName);
}
// 查詢結果區的鈴鐺跟「通知」清單共用同一份 registeredReminders，其中一邊變動後呼叫這個同步畫面狀態。
function syncResultBellsToRegistered(){
  document.querySelectorAll("#resultArea .bell-icon").forEach((bell) => {
    const existing = registeredReminders.get(reminderKeyFromBell(bell));
    if (existing){
      bell.classList.add("armed");
      bell.classList.remove("fa-bell");
      bell.classList.add("fa-bell-slash");
      bell.dataset.reminderId = existing.id;
    } else {
      bell.classList.remove("armed");
      bell.classList.remove("fa-bell-slash");
      bell.classList.add("fa-bell");
      delete bell.dataset.reminderId;
    }
    setResultRowNotifyLine(bell, existing && existing.remindAt);
  });
}
// 查詢結果列底下顯示「會在 mm/dd 週幾 hh:mm 通知你」，跟通知清單頁那行文字共用同一個 formatReminderTime。
function setResultRowNotifyLine(bell, remindAt){
  const content = bell.closest(".result-row")?.querySelector(".result-row-content");
  if (!content) return;
  let notifyLine = content.querySelector(".reminder-notify-time");
  if (remindAt){
    if (!notifyLine){
      notifyLine = document.createElement("div");
      notifyLine.className = "reminder-notify-time";
      content.appendChild(notifyLine);
    }
    notifyLine.textContent = `會在 ${formatReminderTime(remindAt)} 通知你`;
  } else if (notifyLine){
    notifyLine.remove();
  }
}

// remindAt 是 "YYYY-MM-DDTHH:mm:ss+08:00" 格式的字串，直接切字串取值，避免瀏覽器時區再轉一次。
function formatReminderTime(iso){
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!m) return iso;
  const [, year, month, date, hour, minute] = m;
  const weekday = WEEKDAY_LABEL[weekdayOfIso(`${year}-${month}-${date}`)];
  return `${month}/${date} 週${weekday} ${hour}${minute}`;
}

let pendingReminderBell = null;
async function registerReminderForBell(bell){
  bell.classList.add("busy");
  try{
    const sub = await ensurePushSubscription();
    const body = {
      branchSlug: bell.dataset.branchSlug,
      branchName: bell.dataset.branchName,
      className: bell.dataset.className,
      teacherName: bell.dataset.teacherName,
      roomName: bell.dataset.roomName,
      dayOfWeek: parseInt(bell.dataset.dayOfWeek, 10),
      startTime: bell.dataset.startTime,
      pushSubscription: sub.toJSON(),
      clickUrl: location.href,
    };
    const res = await fetch(`${WORKER_BASE}/registerReminder`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`registerReminder failed: ${res.status}`);
    const data = await res.json();
    registeredReminders.set(reminderKeyFromBell(bell), { ...body, id: data.id, classAt: data.classAt, remindAt: data.remindAt });
    syncResultBellsToRegistered();
    trackEvent("register_reminder", { class_name: bell.dataset.className, teacher_name: bell.dataset.teacherName });
  } catch(e){
    console.error(e);
  } finally {
    bell.classList.remove("busy");
  }
}
async function cancelReminderForBell(bell){
  bell.classList.add("busy");
  try{
    const id = bell.dataset.reminderId;
    await fetch(`${WORKER_BASE}/cancelReminder`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    registeredReminders.delete(reminderKeyFromBell(bell));
    syncResultBellsToRegistered();
    trackEvent("cancel_reminder", { class_name: bell.dataset.className, teacher_name: bell.dataset.teacherName, source: "result_bell" });
  } catch(e){
    console.error(e);
  } finally {
    bell.classList.remove("busy");
  }
}
async function handleBellClick(bell){
  if (bell.classList.contains("busy")) return;
  if (bell.classList.contains("armed")){
    await cancelReminderForBell(bell);
    return;
  }
  if (Notification.permission !== "granted"){
    pendingReminderBell = bell;
    notifyPermissionText.innerHTML = Notification.permission === "denied" ? NOTIFY_PERMISSION_TEXT_BLOCKED : NOTIFY_PERMISSION_TEXT_NORMAL;
    document.getElementById("notifyPermissionModal").classList.remove("hidden");
    trackEvent("notify_permission_prompt", {});
    return;
  }
  await registerReminderForBell(bell);
}

// 「通知」清單：畫出目前這個 push subscription 底下所有已登記的通知。沒授權/沒訂閱就顯示空清單。
async function renderReminderList(){
  const grid = document.getElementById("reminderGrid");
  if (!isPWAInstalled() || Notification.permission !== "granted"){
    grid.innerHTML = "";
    return;
  }
  let list = [];
  try{
    const sub = await ensurePushSubscription();
    const res = await fetch(`${WORKER_BASE}/myReminders?endpoint=${encodeURIComponent(sub.endpoint)}`);
    const data = await res.json();
    list = data.reminders || [];
  } catch(e){
    console.error(e);
  }
  registeredReminders.clear();
  list.forEach((r) => registeredReminders.set(reminderKeyFromFields(r.branchSlug, r.dayOfWeek, r.startTime, r.className, r.teacherName), r));
  syncResultBellsToRegistered();

  grid.innerHTML = "";
  if (list.length === 0){
    grid.insertAdjacentHTML("beforeend", '<div class="empty-hint" id="reminderEmptyHint">沒有通知</div>');
    return;
  }
  list.forEach((r) => {
    const row = document.createElement("div");
    row.className = "result-row reminder-row";
    row.dataset.reminderId = r.id;
    const text = document.createElement("div");
    text.className = "reminder-text";
    const mainLine = document.createElement("div");
    mainLine.appendChild(document.createTextNode(`${r.branchName} 週${WEEKDAY_LABEL[r.dayOfWeek]} ${r.startTime.replace(":", "")} ${r.className} `));
    const teacherSpan = document.createElement("span");
    teacherSpan.className = "reminder-teacher";
    teacherSpan.textContent = r.teacherName;
    mainLine.appendChild(teacherSpan);
    text.appendChild(mainLine);
    if (r.remindAt){
      const notifyLine = document.createElement("div");
      notifyLine.className = "reminder-notify-time";
      notifyLine.textContent = `會在 ${formatReminderTime(r.remindAt)} 通知你`;
      text.appendChild(notifyLine);
    }
    row.appendChild(text);
    const bell = document.createElement("i");
    bell.className = "fa-solid fa-bell-slash reminder-cancel-bell";
    row.appendChild(bell);
    grid.appendChild(row);
  });
}
document.getElementById("reminderGrid").addEventListener("click", async (e) => {
  const bell = e.target.closest(".reminder-cancel-bell");
  if (!bell) return;
  const row = bell.closest(".reminder-row");
  const id = row.dataset.reminderId;
  bell.classList.add("busy");
  try{
    await fetch(`${WORKER_BASE}/cancelReminder`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    let cancelledReminder = null;
    for (const [key, r] of registeredReminders){
      if (r.id === id){ cancelledReminder = r; registeredReminders.delete(key); break; }
    }
    syncResultBellsToRegistered();
    trackEvent("cancel_reminder", { class_name: cancelledReminder?.className, teacher_name: cancelledReminder?.teacherName, source: "reminder_list" });
    const overlay = document.createElement("div");
    overlay.className = "reminder-cancel-overlay";
    overlay.textContent = "通知已取消";
    row.appendChild(overlay);
    void overlay.offsetHeight;
    overlay.classList.add("visible");
    setTimeout(() => {
      row.classList.add("fading-out");
      setTimeout(() => {
        row.remove();
        if (document.getElementById("reminderGrid").children.length === 0){
          document.getElementById("reminderGrid").innerHTML = '<div class="empty-hint" id="reminderEmptyHint">沒有通知</div>';
        }
      }, 250);
    }, 1000);
  } catch(e){
    console.error(e);
    bell.classList.remove("busy");
  }
});

// 頁面載入時,如果通知權限已經授權過、也已經有 push subscription,先把已登記的通知讀回來,
// 讓一開始查詢課表結果時鈴鐺就能正確顯示黃色,不用先跑去「通知」清單那邊才會同步。
async function preloadRegisteredReminders(){
  if (!isPWAInstalled() || Notification.permission !== "granted") return;
  try{
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (!sub) return;
    const res = await fetch(`${WORKER_BASE}/myReminders?endpoint=${encodeURIComponent(sub.endpoint)}`);
    const data = await res.json();
    (data.reminders || []).forEach((r) => registeredReminders.set(reminderKeyFromFields(r.branchSlug, r.dayOfWeek, r.startTime, r.className, r.teacherName), r));
  } catch(e){
    console.error(e);
  }
}

// slug -> Google Maps 連結，從 branches.json 的 mapUrl 欄位讀進來（不是每間分店都有）。
let BRANCH_MAP_URLS = {};
// 分店 slug 在網址參數裡很長，選很多間會讓網址爆長，改用 branches.json 陣列的順序位置當短代碼。
let BRANCH_URL_CODE = {};
let BRANCH_URL_DECODE = {};
// slug -> { lat, lng }，供依目前位置篩選分店（1km/3km/5km）使用。
let BRANCH_COORDS = {};

function trackEvent(name, params){
  if (typeof gtag === "function") gtag("event", name, params);
}

// 同一次瀏覽（分頁沒關掉前）同一個事件+對象只送一次，避免狂點洗數字。
const SESSION_TRACKED_EVENTS_KEY = "wg_session_tracked_events";
function trackEventOncePerSession(name, dedupValue, params){
  const key = `${name}:${dedupValue}`;
  let tracked;
  try { tracked = new Set(JSON.parse(sessionStorage.getItem(SESSION_TRACKED_EVENTS_KEY)) || []); }
  catch(e){ tracked = new Set(); }
  if (tracked.has(key)) return;
  tracked.add(key);
  sessionStorage.setItem(SESSION_TRACKED_EVENTS_KEY, JSON.stringify([...tracked]));
  trackEvent(name, params);
}
function trackTeacherEventOncePerSession(name, teacherName){
  trackEventOncePerSession(name, teacherName, { teacher_name: teacherName });
}

// 下一次 search_schedule 事件的觸發來源；送出後會重置回 "manual"。
let searchTriggerSource = "manual";

// 用 Asia/Taipei 而不是使用者裝置的本地時區，跟後端 queryClasses.js 的 todayIsoTaipei() 對齊，
// 不然裝置時區不是台灣時，「今天」在前後端會算出不同的星期幾。
function todayIso(){
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei" }).format(new Date());
}
function addDaysIso(iso, days){
  const d = new Date(iso + "T00:00:00");
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
}
function weekdayOfIso(iso){
  const jsDay = new Date(iso + "T00:00:00").getDay();
  return jsDay === 0 ? 7 : jsDay;
}
// "today"/"tomorrow" 是相對值：存最愛、存分享網址時保留原始字串，
// 只有在真的要送查詢給後端之前才 resolve 成當下的星期幾（見 resolveQueryState）。
function resolveDayValue(v){
  if (v === "today") return String(weekdayOfIso(todayIso()));
  if (v === "tomorrow") return String(weekdayOfIso(addDaysIso(todayIso(), 1)));
  return v;
}
function resolveQueryState(state){
  return { ...state, day: [...new Set((state.day || []).map(resolveDayValue))] };
}

const DAY_OPTIONS = [
  { name: "day", value: "today", label: "今天" },
  { name: "day", value: "tomorrow", label: "明天" },
  { name: "day", value: "1", label: "一" },
  { name: "day", value: "2", label: "二" },
  { name: "day", value: "3", label: "三" },
  { name: "day", value: "4", label: "四" },
  { name: "day", value: "5", label: "五" },
  { name: "day", value: "6", label: "六" },
  { name: "day", value: "7", label: "日" },
];
const ROOM_OPTIONS = [
  { name: "room", value: "團體教室", label: "團體" },
  { name: "room", value: "飛輪教室", label: "飛輪" },
];
const TIME_OPTIONS = [
  { name: "time", value: "0600", label: "06 - 11" },
  { name: "time", value: "1200", label: "12 - 17" },
  { name: "time", value: "1800", label: "18 - 23" },
];
const TIME_LABEL = Object.fromEntries(TIME_OPTIONS.map(o => [o.value, o.label]));
function makePill(name, value, label, checked){
  const wrap = document.createElement("span");
  wrap.className = "pill";
  const id = `${name}-${value}`.replace(/[^a-zA-Z0-9一-鿿-]/g, "_");
  wrap.innerHTML = `<input type="checkbox" name="${name}" value="${value}" id="${id}" ${checked ? "checked" : ""}><label for="${id}">${label}</label>`;
  return wrap;
}

function renderGrid(containerId, defaultName, options){
  const grid = document.getElementById(containerId);
  grid.querySelectorAll(".pill, .empty-hint, .region-subtitle").forEach(el => el.remove());
  if (options.length === 0){
    grid.insertAdjacentHTML("beforeend", '<span class="empty-hint">目前沒有資料</span>');
    return;
  }
  let lastRegion = undefined;
  options.forEach(opt => {
    if (opt.region !== undefined && opt.region !== lastRegion){
      if (lastRegion !== undefined){
        const sub = document.createElement("span");
        sub.className = "region-subtitle";
        const line = document.createElement("span");
        line.className = "region-line";
        sub.appendChild(line);
        grid.appendChild(sub);
      }
      lastRegion = opt.region;
    }
    grid.appendChild(makePill(opt.name || defaultName, opt.value, opt.label, opt.checked));
  });
}

function getZoneState(zoneName, isTaipei) {
  try {
    const states = JSON.parse(localStorage.getItem('wg_zone_states')) || {};
    if (states[zoneName] !== undefined) {
      return states[zoneName];
    }
  } catch(e) {
    console.warn("讀取 localStorage 失敗", e);
  }
  return isTaipei;
}

function saveZoneState(zoneName, isExpanded) {
  try {
    const states = JSON.parse(localStorage.getItem('wg_zone_states')) || {};
    states[zoneName] = isExpanded;
    localStorage.setItem('wg_zone_states', JSON.stringify(states));
  } catch(e) {
    console.warn("寫入 localStorage 失敗", e);
  }
}

function getClickCounts(key) {
  try {
    return JSON.parse(localStorage.getItem(key)) || {};
  } catch(e) {
    return {};
  }
}
function incrementClickCount(key, value) {
  const counts = getClickCounts(key);
  counts[value] = (counts[value] || 0) + 1;
  localStorage.setItem(key, JSON.stringify(counts));
}
function sortByClickCount(items, key, getValue = (x) => x) {
  const counts = getClickCounts(key);
  return [...items].sort((a, b) => (counts[getValue(b)] || 0) - (counts[getValue(a)] || 0));
}

function renderBranchGrid(containerId, options) {
  const grid = document.getElementById(containerId);
  grid.innerHTML = "";
  if (options.length === 0) {
    grid.insertAdjacentHTML("beforeend", '<span class="empty-hint">目前沒有資料</span>');
    return;
  }
  const branchSectionHead = document.getElementById("branchSectionHead");
  branchSectionHead.querySelectorAll(".pill-btn").forEach(el => el.remove());
  const zoneToggles = {};
  if (navigator.geolocation) {
    [1, 3, 5].forEach(radiusKm => {
      const geoBtn = document.createElement("button");
      geoBtn.type = "button";
      geoBtn.className = "pill-btn geo-filter-btn";
      geoBtn.textContent = `${radiusKm}km`;
      geoBtn.addEventListener("click", () => requestGeoFilter(radiusKm));
      branchSectionHead.appendChild(geoBtn);
    });
  }

  ["台北", "新北"].forEach(cityName => {
    const citySlugs = options.filter(opt => opt.cityName === cityName).map(opt => opt.value);
    if (citySlugs.length === 0) return;
    const selectAllBtn = document.createElement("button");
    selectAllBtn.type = "button";
    selectAllBtn.className = "pill-btn";
    selectAllBtn.textContent = cityName;
    selectAllBtn.addEventListener("click", () => {
      const citySlugSet = new Set(citySlugs);
      document.querySelectorAll('input[name="branch"]').forEach(input => {
        if (citySlugSet.has(input.value)) input.checked = true;
      });
      saveSelection("wg_selected_branch", ["branch"]);
      updateResetButtonState();
      updateSubmitState();
      trackEvent("select_all_branch", { city_name: cityName });

      const zoneName = ZONE_MAP[cityName] || cityName;
      const zoneToggle = zoneToggles[zoneName];
      if (zoneToggle && !zoneToggle.toggle.classList.contains("expanded")) {
        zoneToggle.toggle.click();
      }
    });
    branchSectionHead.appendChild(selectAllBtn);
  });

  [
    { label: "台中", zoneName: "台中區" },
    { label: "台南", zoneName: "台南區" },
    { label: "高屏", zoneName: "高屏區" },
  ].forEach(({ label, zoneName }) => {
    const zoneSlugs = options.filter(opt => opt.region === zoneName).map(opt => opt.value);
    if (zoneSlugs.length === 0) return;
    const selectAllBtn = document.createElement("button");
    selectAllBtn.type = "button";
    selectAllBtn.className = "pill-btn";
    selectAllBtn.textContent = label;
    selectAllBtn.addEventListener("click", () => {
      const zoneSlugSet = new Set(zoneSlugs);
      document.querySelectorAll('input[name="branch"]').forEach(input => {
        if (zoneSlugSet.has(input.value)) input.checked = true;
      });
      saveSelection("wg_selected_branch", ["branch"]);
      updateResetButtonState();
      updateSubmitState();
      trackEvent("select_all_branch", { city_name: label });

      const zoneToggle = zoneToggles[zoneName];
      if (zoneToggle && !zoneToggle.toggle.classList.contains("expanded")) {
        zoneToggle.toggle.click();
      }
    });
    branchSectionHead.appendChild(selectAllBtn);
  });

  let lastZone = undefined;
  let currentGroup = null;

  options.forEach(opt => {
    if (opt.region !== lastZone) {
      lastZone = opt.region;
      const zoneName = lastZone;
      const isTaipei = zoneName === "台北區";
      const zoneLabel = zoneName.replace(/區$/, "");

      const isExpanded = getZoneState(zoneName, isTaipei);

      currentGroup = document.createElement("span");
      currentGroup.className = isExpanded ? "zone-group" : "zone-group collapsed hidden-opacity";

      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = isExpanded ? "zone-toggle expanded" : "zone-toggle";
      toggle.innerHTML = `${zoneLabel} <i class="fa-solid fa-chevron-down"></i>`;
      grid.appendChild(toggle);
      zoneToggles[zoneName] = { toggle };

      toggle.addEventListener("click", () => {
        const group = toggle.nextElementSibling;
        const isCollapsing = !group.classList.contains("collapsed");

        saveZoneState(zoneName, !isCollapsing);

        if (isCollapsing) {
          group.classList.add("hidden-opacity");
          toggle.classList.remove("expanded");

          setTimeout(() => {
            if (group.classList.contains("hidden-opacity")) {
              group.classList.add("collapsed");
            }
          }, 250);
        } else {
          group.classList.remove("collapsed");
          toggle.classList.add("expanded");

          setTimeout(() => {
            group.classList.remove("hidden-opacity");
          }, 10);
        }
      });

      grid.appendChild(currentGroup);
    }
    currentGroup.appendChild(makePill(opt.name || "branch", opt.value, opt.label, opt.checked));
  });
}

document.querySelectorAll(".section-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    const group = btn.dataset.group;
    const checked = btn.dataset.action === "all";
    document.querySelectorAll(`input[name="${group}"]`).forEach(input => {
      const pill = input.closest(".pill");
      if (!pill || !pill.classList.contains("hidden")) input.checked = checked;
    });
  });
});

document.querySelectorAll(".section-search").forEach(input => {
  if (!input.dataset.searchFor) return;
  const clearBtn = input.closest(".search-wrap")?.querySelector(".search-clear");
  input.addEventListener("input", () => {
    const grid = document.getElementById(input.dataset.searchFor);
    const text = input.value.trim().toLowerCase();
    clearBtn?.classList.toggle("visible", input.value !== "");
    grid.querySelectorAll(".pill").forEach(pill => {
      const label = pill.querySelector("label").textContent.toLowerCase();
      pill.classList.toggle("hidden", text !== "" && !label.includes(text));
    });
    const wrapId = input.dataset.collapsible;
    if (!wrapId) return;
    const wrap = document.getElementById(wrapId);
    const moreBtn = document.querySelector(`.more-btn[data-target="${wrapId}"]`);
    const expanding = text !== "";
    wrap.style.maxHeight = expanding ? wrap.scrollHeight + "px" : "";
    wrap.classList.toggle("expanded", expanding);
    if (moreBtn){
      moreBtn.classList.toggle("expanded", expanding);
      moreBtn.setAttribute("aria-expanded", expanding);
    }
  });
  clearBtn?.addEventListener("click", () => {
    input.value = "";
    input.dispatchEvent(new Event("input"));
    input.focus();
  });
});

document.querySelectorAll(".more-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    const wrap = document.getElementById(btn.dataset.target);
    const expanding = !wrap.classList.contains("expanded");
    wrap.style.maxHeight = expanding ? wrap.scrollHeight + "px" : "";
    wrap.classList.toggle("expanded", expanding);
    btn.classList.toggle("expanded", expanding);
    btn.setAttribute("aria-expanded", expanding);
  });
});

function hasTeacherSelected(){
  return document.querySelectorAll('input[name="teacher"]:checked').length > 0;
}
// 查詢按鈕只看「有沒有選分店或老師」——這兩種篩選查詢起來對 D1 讀取量最省
// （分店 ≤40 間會走 idx_classes_branch 索引 seek，老師是等值查詢會走 idx_classes_teacherName），
// 完全不篩分店/老師是最貴的查詢，直接從按鈕鎖住擋掉，不用等送出後才用筆數提示。
function isSearchValid(){
  return hasTeacherSelected() || document.querySelectorAll('input[name="branch"]:checked').length > 0;
}
function updateSubmitState(){
  const branchCount = document.querySelectorAll('input[name="branch"]:checked').length;
  const dayCount = document.querySelectorAll('input[name="day"]:checked').length;
  // 加到最愛的解鎖條件比查詢按鈕寬：分店/老師/星期任一即可，維持原本邏輯不變。
  const favoriteValid = hasTeacherSelected() || branchCount > 0 || dayCount > 0;
  document.getElementById("scheduleSubmitBtn").classList.toggle("gray-btn", !isSearchValid());
  document.getElementById("addFavoriteBtn").disabled = !favoriteValid;
}
const pillWarnTooltip = document.createElement("div");
pillWarnTooltip.id = "pillWarnTooltip";
pillWarnTooltip.className = "pill-warn-tooltip";
document.body.appendChild(pillWarnTooltip);
let pillWarnTimer = null;
let activeTooltipAnchor = null;
// 靠右對齊的鈴鐺離螢幕邊緣很近，不夾住的話 tooltip 置中對齊錨點時會超出可視範圍被切掉。
function positionPillTooltip(rect){
  const half = pillWarnTooltip.offsetWidth / 2;
  const margin = 8;
  const anchorCenterX = rect.left + rect.width / 2;
  const centerX = Math.max(half + margin, Math.min(window.innerWidth - half - margin, anchorCenterX));
  pillWarnTooltip.style.left = centerX + "px";
  pillWarnTooltip.style.bottom = (window.innerHeight - rect.top + 10) + "px";
  // 箱體被夾住往左移的話，尖角要跟著留在原本錨點正下方，不然看起來會指向旁邊。
  const arrowPct = half > 0 ? Math.max(10, Math.min(90, ((anchorCenterX - centerX) / (half * 2) + 0.5) * 100)) : 50;
  pillWarnTooltip.style.setProperty("--arrow-left", arrowPct + "%");
}
function showPillWarning(anchorEl, text, iconClass){
  const rect = anchorEl.getBoundingClientRect();
  pillWarnTooltip.classList.remove("wrap");
  pillWarnTooltip.innerHTML = "";
  if (iconClass){
    const icon = document.createElement("i");
    icon.className = iconClass;
    pillWarnTooltip.appendChild(icon);
    pillWarnTooltip.appendChild(document.createTextNode(" "));
  }
  pillWarnTooltip.appendChild(document.createTextNode(text));
  positionPillTooltip(rect);
  pillWarnTooltip.classList.add("visible");
  clearTimeout(pillWarnTimer);
  pillWarnTimer = setTimeout(() => pillWarnTooltip.classList.remove("visible"), 1800);
}
function showHoverTooltip(anchorEl, text, wrap = true){
  const rect = anchorEl.getBoundingClientRect();
  pillWarnTooltip.classList.toggle("wrap", wrap);
  pillWarnTooltip.innerHTML = text;
  positionPillTooltip(rect);
  clearTimeout(pillWarnTimer);
  pillWarnTooltip.classList.add("visible");
}
function hideHoverTooltip(){
  clearTimeout(pillWarnTimer);
  pillWarnTooltip.classList.remove("visible");
  activeTooltipAnchor = null;
}
// 手機沒有 hover，改成點擊開關；點 tooltip 或錨點以外的地方要能收起。
document.addEventListener("click", (e) => {
  if (activeTooltipAnchor && !activeTooltipAnchor.contains(e.target) && !pillWarnTooltip.contains(e.target)){
    hideHoverTooltip();
  }
});

document.getElementById("branchGrid").addEventListener("change", (e) => {
  const input = e.target;
  if (input.matches('input[name="branch"]') && input.checked) incrementClickCount("wg_branch_clicks", input.value);
  updateSubmitState();
});

const githubLinkIcon = document.getElementById("githubLinkIcon");
githubLinkIcon.addEventListener("click", () => trackEvent("click_github_icon", {}));

const adminLinkIcon = document.getElementById("adminLinkIcon");
adminLinkIcon.addEventListener("click", () => trackEvent("click_admin_icon", {}));

const copyUrlBtn = document.getElementById("copyUrlBtn");
copyUrlBtn.addEventListener("click", async (e) => {
  e.stopPropagation();
  try{
    await navigator.clipboard.writeText(location.origin + "/?utm_source=website_link");
    showPillWarning(copyUrlBtn, "已複製網站網址到剪貼簿", "fa-solid fa-fw fa-clipboard-check");
    trackEvent("copy_site_url", {});
  } catch(err){
    console.error(err);
  }
});

// QR code 固定指向正式站網址（見 icons/qrcode.png，用 vendor/qrcode-generator.js 離線產生），
// 不再即時用 JS 產生：省掉一整包 56KB 的 QR 函式庫，換成一張幾 KB 的靜態圖。
const qrCodeBtn = document.getElementById("qrCodeBtn");
const qrCodeTooltip = document.getElementById("qrCodeTooltip");
qrCodeBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  qrCodeTooltip.classList.toggle("visible");
  if (qrCodeTooltip.classList.contains("visible")) trackEvent("open_qr_code", {});
});
document.addEventListener("click", (e) => {
  if (!qrCodeTooltip.classList.contains("visible")) return;
  if (e.target.closest("#qrCodeBtnWrap")) return;
  qrCodeTooltip.classList.remove("visible");
});

// 隱私說明：點擊切換顯示，內容講清楚只做匿名統計、資料來源是 World Gym 官網、本站非官方工具。
const privacyBtn = document.getElementById("privacyBtn");
const privacyTooltip = document.getElementById("privacyTooltip");
privacyBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  privacyTooltip.classList.toggle("visible");
});
document.addEventListener("click", (e) => {
  if (!privacyTooltip.classList.contains("visible")) return;
  if (e.target.closest("#privacyBtnWrap")) return;
  privacyTooltip.classList.remove("visible");
});

// 通知說明：只在「還不是 PWA 模式」時顯示，讓使用者知道怎麼加入主畫面開啟通知；
// 已經是 PWA 模式（standalone）就不需要這顆按鈕了。點擊切換顯示提示文字。
const notifyInfoBtnWrap = document.getElementById("notifyInfoBtnWrap");
const isStandaloneMode = window.navigator.standalone === true || window.matchMedia("(display-mode: standalone)").matches;
if (isStandaloneMode) notifyInfoBtnWrap.classList.add("hidden");
const notifyInfoBtn = document.getElementById("notifyInfoBtn");
const notifyInfoTooltip = document.getElementById("notifyInfoTooltip");
notifyInfoBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  notifyInfoTooltip.classList.toggle("visible");
});
document.addEventListener("click", (e) => {
  if (!notifyInfoTooltip.classList.contains("visible")) return;
  if (e.target.closest("#notifyInfoBtnWrap")) return;
  notifyInfoTooltip.classList.remove("visible");
});

// 星期／分店／課程／老師：勾選後記住選擇，下次打開頁面自動套用。
function saveSelection(key, names){
  const state = {};
  names.forEach(name => {
    state[name] = Array.from(document.querySelectorAll(`input[name="${name}"]:checked`)).map(i => i.value);
  });
  localStorage.setItem(key, JSON.stringify(state));
}
function applyStateToInputs(state, names){
  names.forEach(name => {
    const values = new Set(state[name] || []);
    document.querySelectorAll(`input[name="${name}"]`).forEach(input => {
      if (values.has(input.value)) input.checked = true;
    });
  });
}
function applySavedSelection(key, names){
  let state;
  try{ state = JSON.parse(localStorage.getItem(key)); }
  catch(e){ state = null; }
  if (!state) return;
  applyStateToInputs(state, names);
}
// 分享網址：把目前篩選條件編碼進網址 query string，讓別人打開網址時能直接重現同一個查詢結果。
// room 的值（"團體教室"/"飛輪教室"）中文字很長，網址上用短代碼 1/2 表示。
const ROOM_URL_CODE = { "團體教室": "1", "飛輪教室": "2" };
const ROOM_URL_DECODE = { "1": "團體教室", "2": "飛輪教室" };
function getUrlFilterState(){
  const params = new URLSearchParams(location.search);
  if ([...params.keys()].length === 0) return null;
  const state = {};
  ["day", "time", "branch", "room", "course", "teacher"].forEach(name => {
    let values = params.getAll(name);
    if (name === "room") values = values.map(v => ROOM_URL_DECODE[v] || v);
    // branch 的短代碼要等 branches.json 載入、BRANCH_URL_DECODE 填好後才解得開，
    // 這裡先留原始代碼，實際解碼發生在 init() 裡 branches.json 抓回來之後。
    if (values.length) state[name] = values;
  });
  return Object.keys(state).length ? state : null;
}
function buildShareUrl(state){
  const params = new URLSearchParams();
  ["day", "time", "branch", "room", "course", "teacher"].forEach(name => {
    (state[name] || []).forEach(v => {
      const code = name === "room" ? (ROOM_URL_CODE[v] || v) : name === "branch" ? (BRANCH_URL_CODE[v] || v) : v;
      params.append(name, code);
    });
  });
  const url = new URL(location.href);
  url.search = params.toString();
  return url.toString();
}
function updateResetButtonState(){
  // room 一定會有預設值（團體教室），所以不算進「有沒有選篩選」的判斷，不然按鈕永遠不會變灰。
  const hasSelection = ["day", "time", "branch", "course", "teacher"].some(name =>
    document.querySelector(`input[name="${name}"]:checked`)
  );
  const btn = document.getElementById("resetFiltersBtn");
  btn.classList.toggle("gray-btn", !hasSelection);
  btn.classList.toggle("reset-active", hasSelection);
}
document.getElementById("dayGrid").addEventListener("change", () => { saveSelection("wg_selected_day", ["day"]); updateResetButtonState(); });
document.getElementById("timeGrid").addEventListener("change", () => { saveSelection("wg_selected_time", ["time"]); updateResetButtonState(); });

document.getElementById("roomGrid").addEventListener("change", () => { saveSelection("wg_selected_room", ["room"]); updateResetButtonState(); });
document.getElementById("branchGrid").addEventListener("change", () => { saveSelection("wg_selected_branch", ["branch"]); updateResetButtonState(); });
document.getElementById("courseGrid").addEventListener("change", (e) => {
  if (e.target.checked) incrementClickCount("wg_course_clicks", e.target.value);
  saveSelection("wg_selected_course", ["course"]); updateResetButtonState();
});
document.getElementById("teacherGrid").addEventListener("change", (e) => {
  if (e.target.checked){
    incrementClickCount("wg_teacher_clicks", e.target.value);
    trackTeacherEventOncePerSession("select_teacher_filter", e.target.value);
  }
  saveSelection("wg_selected_teacher", ["teacher"]); updateResetButtonState(); updateSubmitState();
});

document.getElementById("resetFiltersBtn").addEventListener("click", (e) => {
  trackEvent("reset_filters", {});
  showPillWarning(e.currentTarget, "已清除所有篩選條件");
  ["day", "time", "branch", "room", "course", "teacher"].forEach(name => {
    document.querySelectorAll(`input[name="${name}"]`).forEach(input => { input.checked = false; });
  });
  ["wg_selected_day", "wg_selected_time", "wg_selected_branch", "wg_selected_room", "wg_selected_course", "wg_selected_teacher"].forEach(key => {
    localStorage.removeItem(key);
  });
  document.querySelectorAll("#filterForm .section-search").forEach(input => {
    input.value = "";
    input.dispatchEvent(new Event("input"));
  });
  const defaultRoomInput = document.querySelector('input[name="room"][value="團體教室"]');
  if (defaultRoomInput) defaultRoomInput.checked = true;
  updateSubmitState();
  updateResetButtonState();
});

// 我的最愛：把目前勾選的篩選存成一組快照，之後可以一鍵套用。
const FAVORITES_KEY = "wg_favorites";
const FILTER_GROUPS = ["day", "time", "branch", "room", "course", "teacher"];

function getFavorites(){
  try{ return JSON.parse(localStorage.getItem(FAVORITES_KEY)) || []; }
  catch(e){ return []; }
}
function saveFavorites(favs){
  localStorage.setItem(FAVORITES_KEY, JSON.stringify(favs));
}
function currentFilterState(){
  const state = {};
  FILTER_GROUPS.forEach(name => {
    state[name] = Array.from(document.querySelectorAll(`input[name="${name}"]:checked`)).map(i => i.value);
  });
  return state;
}
function applyFilterState(state){
  FILTER_GROUPS.forEach(name => {
    const values = new Set(state[name] || []);
    document.querySelectorAll(`input[name="${name}"]`).forEach(input => {
      input.checked = values.has(input.value);
      if (name === "branch" && input.checked) expandZoneForBranchInput(input);
    });
  });
  updateSubmitState();
}
// 套用最愛/分享網址等會直接勾選分店 checkbox 的情境，若該分店所在的地區是折疊狀態，
// 使用者會看不到自己被選起來的分店，所以要連動展開對應的 zone-group。
function expandZoneForBranchInput(input){
  const group = input.closest(".zone-group");
  const toggle = group?.previousElementSibling;
  if (!group || !toggle || !toggle.classList.contains("zone-toggle")) return;
  if (!toggle.classList.contains("expanded")) toggle.click();
}
const FUNNY_DEFAULT_FAVORITE_LABELS = [
  "興奮到模糊 🤩",
  "已購買小孩愛吃 😋",
  "阿姨我不想努力了 👵",
  "小丑竟是我自己 🤡",
  "我全都要 ✊",
  "請開始你的表演 🎭",
  "ㄅ級分 💯",
  "高麗菜煮蛋那桌 🥬",
  "留友看 👥",
  "月月鳥好棒棒 👍",
  "北市正常上班上課 🌀",
  "咕嚕咕嚕 🌀",
];
function favoriteLabel(state){
  const branchLabels = (state.branch || []).map(slug => {
    const input = document.querySelector(`input[name="branch"][value="${CSS.escape(slug)}"]`);
    return input ? input.nextElementSibling.textContent : slug;
  });
  if (branchLabels.length){
    const joined = branchLabels.join("、");
    return joined.length > 15 ? joined.slice(0, 15) + "…" : joined;
  }
  return FUNNY_DEFAULT_FAVORITE_LABELS[Math.floor(Math.random() * FUNNY_DEFAULT_FAVORITE_LABELS.length)];
}
const FAVORITE_EMPTY_HINTS = [
  "現在可以自訂最愛，選好篩選後按「加到最愛」。",
];
function renderFavorites(){
  const grid = document.getElementById("favoriteGrid");
  grid.querySelectorAll(".fav-item, .empty-hint").forEach(el => el.remove());
  const favs = getFavorites();
  if (favs.length === 0){
    const hint = FAVORITE_EMPTY_HINTS[Math.floor(Math.random() * FAVORITE_EMPTY_HINTS.length)];
    grid.insertAdjacentHTML("beforeend", `<span class="empty-hint fav-empty-hint">${hint}</span>`);
    return;
  }
  favs.forEach(fav => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "fav-item";
    btn.style.background = fav.color || "#e8604c";
    btn.innerHTML = `<i class="fa-solid fa-${fav.icon || "heart"}"></i>${fav.label}`;
    btn.addEventListener("click", () => {
      applyFilterState(fav.state);
      ["wg_selected_day", "wg_selected_time", "wg_selected_branch", "wg_selected_room", "wg_selected_course", "wg_selected_teacher"].forEach(key => localStorage.removeItem(key));
      FILTER_GROUPS.forEach(name => saveSelection(`wg_selected_${name}`, [name]));
      updateResetButtonState();
      trackEventOncePerSession("apply_favorite", fav.label, { favorite_label: fav.label });
      logFavoriteEvent("apply");
      searchTriggerSource = "favorite";
      document.getElementById("filterForm").requestSubmit(document.getElementById("scheduleSubmitBtn"));
    });
    grid.appendChild(btn);
  });
}

const addFavoriteModal = document.getElementById("addFavoriteModal");
document.getElementById("addFavoriteBtn").addEventListener("click", () => {
  document.getElementById("favNameInput").value = favoriteLabel(currentFilterState());
  addFavoriteModal.classList.remove("hidden");
});
document.getElementById("favNameRandomBtn").addEventListener("click", () => {
  const input = document.getElementById("favNameInput");
  input.value = FUNNY_DEFAULT_FAVORITE_LABELS[Math.floor(Math.random() * FUNNY_DEFAULT_FAVORITE_LABELS.length)];
});
document.getElementById("favModalCloseBtn").addEventListener("click", () => {
  addFavoriteModal.classList.add("hidden");
});
document.getElementById("favModalSubmitBtn").addEventListener("click", () => {
  const icon = document.querySelector('input[name="favIcon"]:checked').value;
  const color = document.querySelector('input[name="favColor"]:checked').value;
  const name = document.getElementById("favNameInput").value.trim() || favoriteLabel(currentFilterState());
  const favs = getFavorites();
  favs.push({ label: name, icon, color, state: currentFilterState() });
  saveFavorites(favs);
  trackEvent("add_favorite", { favorite_label: name });
  logFavoriteEvent("add");
  renderFavorites();
  addFavoriteModal.classList.add("hidden");
});
const clearMemoryModal = document.getElementById("clearMemoryModal");
document.getElementById("clearMemoryBtn").addEventListener("click", () => {
  clearMemoryModal.classList.remove("hidden");
});
document.getElementById("clearMemoryCancelBtn").addEventListener("click", () => {
  clearMemoryModal.classList.add("hidden");
});
document.getElementById("clearMemoryCloseBtn").addEventListener("click", () => {
  clearMemoryModal.classList.add("hidden");
});
document.getElementById("clearMemoryConfirmBtn").addEventListener("click", () => {
  trackEvent("clear_memory", {});
  localStorage.clear();
  location.reload();
});

// 頁面載入時課程/老師清單抓取失敗（伺服器或資料庫異常）跳出的提示 modal。
const serviceErrorModal = document.getElementById("serviceErrorModal");
function showServiceErrorModal(){
  serviceErrorModal.classList.remove("hidden");
}
document.getElementById("serviceErrorOkBtn").addEventListener("click", () => {
  serviceErrorModal.classList.add("hidden");
});

// 課表通知：第一次按灰色鈴鐺、還沒授權通知時彈出的說明 modal。
const notifyPermissionModal = document.getElementById("notifyPermissionModal");
const notifyPermissionText = document.getElementById("notifyPermissionText");
const NOTIFY_PERMISSION_TEXT_NORMAL = "開啟通知，課前 30 分鐘不怕錯過！<br>需要允許通知權限。";
const NOTIFY_PERMISSION_TEXT_BLOCKED = "通知權限已被封鎖，<br>請至裝置設定手動開啟通知權限。";
function closeNotifyPermissionModal(){
  notifyPermissionModal.classList.add("hidden");
  pendingReminderBell = null;
}
document.getElementById("notifyPermissionCancelBtn").addEventListener("click", closeNotifyPermissionModal);
document.getElementById("notifyPermissionCloseBtn").addEventListener("click", closeNotifyPermissionModal);
document.getElementById("notifyPermissionConfirmBtn").addEventListener("click", async () => {
  const bell = pendingReminderBell;
  notifyPermissionModal.classList.add("hidden");
  pendingReminderBell = null;
  if (!bell) return;
  if (Notification.permission === "denied"){
    trackEvent("notify_permission_blocked_retry", {});
    return;
  }
  const perm = await Notification.requestPermission();
  trackEvent("notify_permission_result", { result: perm });
  if (perm === "granted") await registerReminderForBell(bell);
});

// 依目前位置篩選分店：第一次按 1km/3km/5km、還沒授權定位時彈出的說明 modal。
const geoPermissionModal = document.getElementById("geoPermissionModal");
const geoPermissionText = document.getElementById("geoPermissionText");
const GEO_PERMISSION_TEXT_NORMAL = "依目前位置篩選分店，<br>需要允許定位權限。";
const GEO_PERMISSION_TEXT_BLOCKED = "定位權限已被封鎖，<br>請至裝置設定手動開啟定位權限。";
let pendingGeoRadiusKm = null;

function closeGeoPermissionModal(){
  geoPermissionModal.classList.add("hidden");
  pendingGeoRadiusKm = null;
}
document.getElementById("geoPermissionCancelBtn").addEventListener("click", closeGeoPermissionModal);
document.getElementById("geoPermissionCloseBtn").addEventListener("click", closeGeoPermissionModal);
document.getElementById("geoPermissionConfirmBtn").addEventListener("click", () => {
  const radiusKm = pendingGeoRadiusKm;
  geoPermissionModal.classList.add("hidden");
  pendingGeoRadiusKm = null;
  if (radiusKm) runGeoFilter(radiusKm);
});

async function requestGeoFilter(radiusKm){
  trackEvent("geo_filter_click", { radius_km: radiusKm });
  let state = "prompt";
  try {
    if (navigator.permissions?.query) {
      const status = await navigator.permissions.query({ name: "geolocation" });
      state = status.state;
    }
  } catch (e) { /* Permissions API 不支援，維持 "prompt" 走一般 modal 流程 */ }

  if (state === "granted") {
    runGeoFilter(radiusKm);
    return;
  }
  geoPermissionText.innerHTML = state === "denied" ? GEO_PERMISSION_TEXT_BLOCKED : GEO_PERMISSION_TEXT_NORMAL;
  pendingGeoRadiusKm = radiusKm;
  geoPermissionModal.classList.remove("hidden");
}

function runGeoFilter(radiusKm){
  if (!navigator.geolocation) return;
  navigator.geolocation.getCurrentPosition(
    position => {
      const { latitude, longitude } = position.coords;
      const matchedSlugs = new Set(
        Object.entries(BRANCH_COORDS)
          .filter(([, coord]) => distanceKm(latitude, longitude, coord.lat, coord.lng) <= radiusKm)
          .map(([slug]) => slug)
      );
      document.querySelectorAll('input[name="branch"]').forEach(input => {
        if (matchedSlugs.has(input.value)) input.checked = true;
      });
      saveSelection("wg_selected_branch", ["branch"]);
      updateResetButtonState();
      updateSubmitState();
      trackEvent("geo_filter_apply", { radius_km: radiusKm, matched_count: matchedSlugs.size });
    },
    error => {
      trackEvent("geo_filter_error", { radius_km: radiusKm, error_code: error.code });
    }
  );
}

renderFavorites();

// 分店排序：先依 World Gym 官方六大分區，區內再依這個地區順序排列。
const REGION_ORDER = ["台北", "新北", "基隆", "宜蘭", "花蓮", "桃園", "新竹", "苗栗", "台中", "彰化", "南投", "雲林", "台南", "嘉義", "高雄", "屏東"];
const ZONE_MAP = {
  "台北": "台北區", "新北": "台北區", "基隆": "台北區", "宜蘭": "台北區", "花蓮": "台北區",
  "桃園": "桃園區",
  "新竹": "新竹區", "苗栗": "新竹區",
  "台中": "台中區", "彰化": "台中區", "南投": "台中區", "雲林": "台中區",
  "台南": "台南區", "嘉義": "台南區",
  "高雄": "高屏區", "屏東": "高屏區",
};
const ZONE_ORDER = ["台北區", "桃園區", "新竹區", "台中區", "台南區", "高屏區"];
function regionRank(region){
  const idx = REGION_ORDER.indexOf(region);
  return idx === -1 ? REGION_ORDER.length : idx;
}
function zoneRank(region){
  const idx = ZONE_ORDER.indexOf(ZONE_MAP[region]);
  return idx === -1 ? ZONE_ORDER.length : idx;
}

function distanceKm(lat1, lng1, lat2, lng2){
  const R = 6371;
  const toRad = deg => deg * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.asin(Math.sqrt(a));
}

// 分店自訂排序（依 slug），未列在此清單的分店退回 region 排序。
const BRANCH_ORDER = [
  "taipei-station", "taipei-gongguan", "taipei-ximen", "taipei-changchun", "taipei-minquan-east",
  "taipei-dazhi", "taipei-daan", "taipei-tonling", "taipei-neihu-fuhwa", "taipei-guangfu",
  "taipei-nanjing", "taipei-minsheng", "taipei-minsheng-yuanhuan", "taipei-101", "taipei-songren",
  "taipei-songlong", "taipei-neihu", "taipei-neihu-gangqia", "taipei-tienmu", "taipei-tienmu-dexing",
  "taipei-beitou-zhonghe", "new-taipei-sanchong", "new-taipei-yonghe", "new-taipei-yonghe-minquan",
  "new-taipei-banqiao-shuangshi", "new-taipei-banqiao-zhongshan", "new-taipei-banqiao-fuzhong",
  "new-taipei-banciao-chongcing", "new-taipei-zhonghe", "new-taipei-jingping", "new-taipei-hsinzhuang",
  "new-taipei-beihsinzhuang", "new-taipei-hsindian", "new-taipei-tucheng", "new-taipei-tucheng-haishan",
  "taoyuan-fuxing", "taoyuan-dayou", "taoyuan-guoqiang", "taoyuan-taimall", "taoyuan-neili",
  "taoyuan-zhongli-zhongyuan", "taoyuan-pingzhen", "taoyuan-yangmei",
  "hsinchu-zhongzheng", "hsinchu-zhonghua", "hsinchu-xiangshan", "hsinchu-zhubei-huaxing",
  "hsinchu-zhubei", "hsinchu-xinfeng", "miaoli-toufen", "miaoli-yuanli",
  "taichung-e-chung", "taichung-meicun", "taichung-chongde", "taichung-xuefu", "taichung-dongshan",
  "taichung-taiping", "taichung-xitun", "taichung-liming", "changhua-heping", "taichung-daya",
  "taichung-wuri", "taichung-fengyuan", "taichung-shalu", "taichung-qingshui", "taichung-dajia",
  "nantou-caotun", "changhua-yuanlin", "changhua-lukang", "yunlin-douliu", "yunlin-huwei",
  "tainan-focus", "chiayi-minzu", "tainan-haian", "tainan-ximen", "tainan-zhonghua-east",
  "tainan-anping", "tainan-annan", "tainan-yongkang", "tainan-rende", "tainan-yongkang-yongda",
  "tainan-shanhua", "tainan-xinying", "chiayi-xingye", "tainan-shulin",
  "kaohsiung-sogo", "kaohsiung-baocheng", "kaohsiung-datong-heping", "kaohsiung-zhonghua", "pingtung-ziyou",
  "kaohsiung-yangming", "kaohsiung-zuoying", "kaohsiung-fengshan-wujia", "kaohsiung-fengshan-zhongshan",
  "kaohsiung-gangshan", "pingtung-chaozhou",
  "new-taipei-xizhi", "new-taipei-danshui", "new-taipei-linkou", "keelung-xinyi", "yilan-luodong",
  "yilan-youai", "hualian-guolian", "hualien-jian",
];
function branchRank(slug){
  const idx = BRANCH_ORDER.indexOf(slug);
  return idx === -1 ? BRANCH_ORDER.length : idx;
}

// 同頁查詢結果：按查詢後不換頁，改成隱藏篩選 pill、顯示結果，按返回再換回來。
const WEEKDAY_LABEL = { today: "今天", tomorrow: "明天", 1: "一", 2: "二", 3: "三", 4: "四", 5: "五", 6: "六", 7: "日" };

function branchSlugToName(slug){
  const input = document.querySelector(`input[name="branch"][value="${CSS.escape(slug)}"]`);
  return input ? input.nextElementSibling.textContent : slug;
}
function renderActiveFilters(state){
  const box = document.getElementById("activeFiltersBox");
  const groups = [
    ["day", "fa-calendar-day", "天", 5],
    ["time", "fa-clock", "個時段", 3],
    ["branch", "fa-location-dot", "間", 5],
    ["room", "fa-store", "種", 2],
    ["course", "fa-face-smile", "種", 3],
    ["teacher", "fa-user", "人", 3],
  ];
  const roomLabelMap = { "團體教室": "團體", "飛輪教室": "飛輪" };
  const labelMaps = { day: WEEKDAY_LABEL, room: roomLabelMap, time: TIME_LABEL };
  box.innerHTML = "";
  let any = false;
  groups.forEach(([key, icon, unit, maxShown]) => {
    const values = state[key] || [];
    if (values.length === 0) return;
    any = true;
    const labels = key === "branch"
      ? values.map(branchSlugToName)
      : values.map(v => (labelMaps[key] && labelMaps[key][v]) || v);
    const tag = document.createElement("span");
    tag.className = "active-filter-tag";
    const iconEl = document.createElement("i");
    iconEl.className = `fa-solid ${icon}`;
    tag.appendChild(iconEl);
    if (key === "branch"){
      // 分店名稱裡，有 Google Maps 連結（branches.json 的 mapUrl）的就顯示成可點的藍字，沒有的維持一般文字。
      values.slice(0, maxShown).forEach((slug, i) => {
        if (i > 0) tag.appendChild(document.createTextNode("、"));
        const mapUrl = BRANCH_MAP_URLS[slug];
        const label = branchSlugToName(slug);
        if (mapUrl){
          const link = document.createElement("a");
          link.className = "branch-map-link";
          link.href = mapUrl;
          link.target = "_blank";
          link.rel = "noopener";
          link.textContent = label;
          tag.appendChild(link);
        } else {
          tag.appendChild(document.createTextNode(label));
        }
      });
      if (values.length > maxShown) tag.appendChild(document.createTextNode(` 等 ${values.length} ${unit}`));
    } else {
      const displayText = labels.length > maxShown
        ? `${labels.slice(0, maxShown).join("、")} 等 ${labels.length} ${unit}`
        : labels.join("、");
      tag.appendChild(document.createTextNode(displayText));
    }
    if (labels.length > maxShown){
      const fullList = labels.join("、");
      tag.classList.add("has-tooltip");
      tag.addEventListener("click", (e) => {
        e.stopPropagation();
        if (activeTooltipAnchor === tag){
          hideHoverTooltip();
        } else {
          showHoverTooltip(tag, fullList);
          activeTooltipAnchor = tag;
        }
      });
    }
    box.appendChild(tag);
  });
  if (!any) box.insertAdjacentHTML("beforeend", '<span class="active-filter-tag">未設定篩選條件，顯示全部</span>');
}

class QueryTimeoutError extends Error {}
// 伺服器有回應但狀態碼不是 2xx（例如 500），跟「根本連不上／CORS 被擋」的網路錯誤要分開顯示。
class QueryHttpError extends Error {
  constructor(status){ super(`查詢失敗：伺服器回應 ${status}`); this.status = status; }
}
// /queryClasses 回 429（單 IP 短時間查太多次）跟回 401 token_expired（見下方 token 機制）
// 都要跟一般的 HTTP 錯誤分開處理，才知道要顯示「查太頻繁」還是自動換票重試。
class QueryRateLimitedError extends Error {}
class QueryTokenExpiredError extends Error {}
const QUERY_RETRY_AFTER_MS = 3000;
const QUERY_GIVE_UP_AFTER_MS = 6000;
// 3 秒還沒回應就多開一次同樣的請求重試，6 秒內兩次都還沒成功就放棄。
// 放棄時如果已經有明確失敗過的錯誤（HTTP 錯誤、網路／CORS 錯誤），就把那個錯誤丟出去，
// 只有「兩次嘗試都還在等、完全沒收到回應」時才算真的逾時（QueryTimeoutError），
// 這樣呼叫端才能區分「太慢」跟「連不上／伺服器錯誤」，顯示不同的提示訊息。
function withRetryTimeout(queryFactory, retryAfterMs, giveUpAfterMs){
  return new Promise((resolve, reject) => {
    let settled = false;
    let lastError = null;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(retryTimer);
      clearTimeout(giveUpTimer);
      fn(value);
    };
    const attempt = () => {
      queryFactory().then(
        v => finish(resolve, v),
        e => { lastError = e; console.error("查詢嘗試失敗", e); }
      );
    };
    attempt();
    const retryTimer = setTimeout(() => { if (!settled) attempt(); }, retryAfterMs);
    const giveUpTimer = setTimeout(() => finish(reject, lastError || new QueryTimeoutError("查詢逾時")), giveUpAfterMs);
  });
}

// /queryClasses 要帶一個短效 token 才能查（防止非瀏覽器直接爬 API，見 worker/src/index.js
// 的 issueQueryToken/verifyQueryToken），這裡快取起來，快過期或還沒拿過才重新要一張。
let cachedQueryToken = null; // { token, exp } | null
async function fetchFreshQueryToken(){
  const res = await fetch(`${WORKER_BASE}/issueToken`);
  if (!res.ok) throw new Error(`issueToken failed: ${res.status}`);
  const { token } = await res.json();
  const payload = JSON.parse(atob(token.split(".")[0].replace(/-/g, "+").replace(/_/g, "/")));
  cachedQueryToken = { token, exp: payload.exp };
  return cachedQueryToken;
}
async function getQueryToken(){
  if (cachedQueryToken && cachedQueryToken.exp > Date.now() + 5000) return cachedQueryToken.token;
  return (await fetchFreshQueryToken()).token;
}

async function queryClassesOnce(state){
  const token = await getQueryToken();
  const res = await fetch(`${WORKER_BASE}/queryClasses`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Query-Token": token },
    body: JSON.stringify(state),
  });
  if (res.status === 429) throw new QueryRateLimitedError();
  if (res.status === 401){
    const data = await res.json().catch(() => ({}));
    if (data.error === "token_expired") throw new QueryTokenExpiredError();
    throw new QueryHttpError(res.status);
  }
  if (!res.ok) throw new QueryHttpError(res.status);
  return res.json();
}

// 查課表：前端只送目前勾選的篩選條件，Firestore 查詢＋所有篩選＋去重都在後端
// （functions/queryClasses.js）做完，這裡只拿最終要顯示的 rows 來渲染。
// token 過期的話清快取重來一次就好（只重試一次，避免萬一一直失敗就無限迴圈）；
// withRetryTimeout 本身是「時間到就再打一次」不是「錯誤發生就馬上重試」，所以 token
// 過期最壞情況要等到 giveUpAfterMs 那次才會浮上來，多花幾秒，但使用者完全不會看到失敗畫面。
async function runScheduleQuery(state, isRetry){
  try{
    return await withRetryTimeout(() => queryClassesOnce(state), QUERY_RETRY_AFTER_MS, QUERY_GIVE_UP_AFTER_MS);
  } catch(err){
    if (err instanceof QueryTokenExpiredError && !isRetry){
      cachedQueryToken = null;
      return runScheduleQuery(state, true);
    }
    throw err;
  }
  // 回傳格式：{ rows, fetchedCount, displayedCount }
}

let lastResultRows = [];
let TEACHER_NAMES = [];
function renderTeacherGrid(){
  const checked = new Set(Array.from(document.querySelectorAll('input[name="teacher"]:checked')).map(i => i.value));
  renderGrid("teacherGrid", "teacher", sortByClickCount(TEACHER_NAMES, "wg_teacher_clicks").map(n => ({ value: n, label: n, checked: checked.has(n) })));
}
function renderScheduleResults(rows, onlyTeacher){
  const area = document.getElementById("resultArea");
  lastResultRows = rows;
  if (rows.length === 0){
    area.innerHTML = '<div class="empty-hint">沒有符合條件的課程，換個篩選條件試試看。</div>';
    return;
  }
  area.innerHTML = "";
  rows.forEach(row => {
    const { c } = row;
    const line = document.createElement("div");
    line.className = "result-row" + (row.flagged ? " flagged" : "");
    const content = document.createElement("span");
    content.className = "result-row-content";
    if (row.flagged){
      const icon = document.createElement("i");
      icon.className = "fa-solid fa-triangle-exclamation result-flag-icon";
      content.appendChild(icon);
      content.appendChild(document.createTextNode(`${c.date.slice(5).replace("-", "/")} `));
    }
    content.appendChild(document.createTextNode(`${c.branchName} 週${WEEKDAY_LABEL[c.dayOfWeek]} ${c.startTime.replace(":", "")} ${c.className} `));
    if (c.teacherName === onlyTeacher){
      content.appendChild(document.createTextNode(c.teacherName));
    } else {
      const teacherLink = document.createElement("span");
      teacherLink.className = "teacher-link";
      teacherLink.textContent = c.teacherName;
      teacherLink.dataset.teacher = c.teacherName;
      content.appendChild(teacherLink);
    }
    line.appendChild(content);
    if (isPWAInstalled()){
      const bell = document.createElement("i");
      const key = reminderKeyFromFields(c.branchSlug, c.dayOfWeek, c.startTime, c.className, c.teacherName);
      const existing = registeredReminders.get(key);
      bell.className = "fa-solid bell-icon" + (existing ? " fa-bell-slash armed" : " fa-bell");
      bell.dataset.branchSlug = c.branchSlug;
      bell.dataset.branchName = c.branchName;
      bell.dataset.className = c.className;
      bell.dataset.teacherName = c.teacherName;
      bell.dataset.roomName = c.roomName;
      bell.dataset.dayOfWeek = c.dayOfWeek;
      bell.dataset.startTime = c.startTime;
      if (existing) bell.dataset.reminderId = existing.id;
      line.appendChild(bell);
      setResultRowNotifyLine(bell, existing && existing.remindAt);
    }
    area.appendChild(line);
  });
}
document.getElementById("resultArea").addEventListener("click", async (e) => {
  const bell = e.target.closest(".bell-icon");
  if (bell){
    handleBellClick(bell);
    return;
  }
  const teacherLink = e.target.closest(".teacher-link");
  if (!teacherLink || teacherLink.classList.contains("busy")) return;
  const teacherName = teacherLink.dataset.teacher;
  applyFilterState({ teacher: [teacherName] });
  trackTeacherEventOncePerSession("filter_by_teacher", teacherName);
  incrementClickCount("wg_teacher_clicks", teacherName);
  saveSelection("wg_selected_day", ["day"]);
  saveSelection("wg_selected_branch", ["branch"]);
  saveSelection("wg_selected_course", ["course"]);
  saveSelection("wg_selected_teacher", ["teacher"]);
  updateResetButtonState();
  searchTriggerSource = "teacher_link";
  if (!isSearchValid()) return;
  // 這裡不用 requestSubmit：結果頁時 filterForm 是 hidden 的，submitBtn 的 spin 圖示使用者看不到，
  // 改成讓結果頁本來就看得到的返回按鈕轉圈，查詢完換出第二層結果後再變回箭頭。
  teacherLink.classList.add("busy");
  const backBtnIcon = document.querySelector("#backBtn i");
  backBtnIcon.className = "fa-solid fa-spinner fa-spin";
  await runSearchAndShowResults(currentFilterState());
  teacherLink.classList.remove("busy");
  backBtnIcon.className = "fa-solid fa-arrow-left";
});

function showResultView(){
  document.getElementById("filterForm").classList.add("hidden");
  document.getElementById("settingsSheet").classList.add("hidden");
  document.getElementById("favoriteSheet").classList.add("hidden");
  document.getElementById("mailDisclaimerSheet").classList.add("hidden");
  document.getElementById("quickLinksSheet").classList.add("hidden");
  fadeInView(document.getElementById("resultView"));
  document.getElementById("backBtnWrap").classList.remove("hidden");
  window.scrollTo({ top: 0, behavior: "smooth" });
}
function fadeInView(el){
  el.classList.remove("hidden");
  el.classList.add("view-fade-in");
  void el.offsetHeight; // 強制 reflow，讓 opacity:0 先套用再拿掉 class 觸發 transition
  el.classList.remove("view-fade-in");
}
function showMailView(){
  trackEvent("open_reminder_list", {});
  document.getElementById("mainFormSheet").classList.add("hidden");
  document.getElementById("settingsSheet").classList.add("hidden");
  document.getElementById("favoriteSheet").classList.add("hidden");
  fadeInView(document.getElementById("reminderView"));
  fadeInView(document.getElementById("mailView"));
  document.getElementById("searchTrendSheet").classList.remove("hidden");
  document.getElementById("branchStatsSheet").classList.remove("hidden");
  document.getElementById("courseStatsSheet").classList.remove("hidden");
  document.getElementById("teacherStatsSheet").classList.remove("hidden");
  document.getElementById("mailDisclaimerSheet").classList.remove("hidden");
  document.getElementById("quickLinksSheet").classList.remove("hidden");
  document.getElementById("mailBackBtnWrap").classList.remove("hidden");
  document.getElementById("mailContent").disabled = false;
  document.getElementById("mailSentOverlay").classList.add("hidden");
  document.getElementById("mailSendBtn").disabled = false;
  renderReminderList();
  window.scrollTo({ top: 0, behavior: "smooth" });
}
function showFilterView(){
  document.getElementById("resultView").classList.add("hidden");
  document.getElementById("backBtnWrap").classList.add("hidden");
  document.getElementById("reminderView").classList.add("hidden");
  document.getElementById("mailView").classList.add("hidden");
  document.getElementById("searchTrendSheet").classList.add("hidden");
  document.getElementById("branchStatsSheet").classList.add("hidden");
  document.getElementById("courseStatsSheet").classList.add("hidden");
  document.getElementById("teacherStatsSheet").classList.add("hidden");
  document.getElementById("mailDisclaimerSheet").classList.add("hidden");
  document.getElementById("quickLinksSheet").classList.add("hidden");
  document.getElementById("mailBackBtnWrap").classList.add("hidden");
  document.getElementById("mailContent").value = "";
  document.getElementById("mailContent").disabled = false;
  document.getElementById("mailSentOverlay").classList.add("hidden");
  document.getElementById("mailSendBtn").disabled = false;
  fadeInView(document.getElementById("mainFormSheet"));
  fadeInView(document.getElementById("filterForm"));
  document.getElementById("settingsSheet").classList.remove("hidden");
  document.getElementById("favoriteSheet").classList.remove("hidden");
  renderTeacherGrid();
  history.replaceState(null, "", location.pathname);
}
document.getElementById("notifyBtn").addEventListener("click", showMailView);
document.getElementById("mailBackBtn").addEventListener("click", showFilterView);
document.getElementById("mailSendBtn").addEventListener("click", async () => {
  const btn = document.getElementById("mailSendBtn");
  const input = document.getElementById("mailContent");
  const content = input.value.trim();
  if (!content){
    showPillWarning(btn, "請先輸入內容");
    return;
  }
  btn.disabled = true;
  try{
    const res = await fetch(`${WORKER_BASE}/sendMessageToAuthor`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    });
    if (!res.ok) throw new Error(`sendMessageToAuthor failed: ${res.status}`);
    trackEvent("send_message", {});
    input.disabled = true;
    document.getElementById("mailSentOverlay").classList.remove("hidden");
  } catch(e){
    console.error(e);
    showPillWarning(btn, "送出失敗，請稍後再試");
    btn.disabled = false;
  }
});

// 抽成獨立函式，讓「使用者按送出」跟「帶網址參數自動查詢」共用同一段邏輯 —
// 後者需要在畫面切到結果視圖之前都不能露出篩選畫面，見 init() 裡的呼叫方式。
async function runSearchAndShowResults(state){
  const submitBtn = document.getElementById("scheduleSubmitBtn");
  const submitIcon = submitBtn.querySelector("i");
  submitBtn.disabled = true;
  submitBtn.classList.add("busy");
  submitIcon.className = "fa-solid fa-spinner fa-spin";
  // state 本身保留 "today"/"tomorrow" 原始值（分享網址、篩選摘要都要看得到相對值）；
  // 送給後端查詢時才 resolve 成實際星期幾，後端只認得 1-7 的數字。
  const queryState = resolveQueryState(state);
  try{
    const { rows, displayedCount } = await runScheduleQuery(queryState);
    logSearchEvent(displayedCount);
    if (displayedCount === 0){
      showPillWarning(submitBtn, "查無符合條件的課程，請調整篩選條件");
    } else if (displayedCount > RESULT_COUNT_WARN_LIMIT){
      showPillWarning(submitBtn, "結果太多，請調整篩選條件");
    } else {
      trackEvent("search_schedule", {
        branch_count: state.branch.length,
        has_teacher: state.teacher.length > 0,
        has_course: state.course.length > 0,
        day_count: state.day.length,
        trigger_source: searchTriggerSource,
      });
      if (searchTriggerSource !== "favorite"){
        logTeacherSearches(state.teacher);
        logCourseSearches(state.course);
        logBranchSearches((state.branch || []).map(branchSlugToLabel));
      }
      showResultView();
      history.replaceState(null, "", buildShareUrl(state));
      renderActiveFilters(state);
      renderScheduleResults(rows, state.teacher.length === 1 ? state.teacher[0] : null);
    }
  } catch(err){
    console.error(err);
    let message;
    if (err instanceof QueryTimeoutError){
      message = "查詢逾時，請重新整理 😭";
    } else if (err instanceof QueryRateLimitedError){
      message = "查詢太頻繁了，請稍等一下再試一次";
    } else if (err instanceof QueryHttpError){
      message = "伺服器發生錯誤，請稍後再試一次 😭";
    } else {
      message = "網路連線異常，請確認網路連線後再試一次。";
    }
    showPillWarning(submitBtn, message);
  } finally {
    submitBtn.classList.remove("busy");
    submitIcon.className = "fa-solid fa-magnifying-glass";
    submitBtn.disabled = false;
    updateSubmitState();
  }
}
document.getElementById("filterForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!isSearchValid()){
    showPillWarning(document.getElementById("scheduleSubmitBtn"), "請先選擇一些分店或老師");
    return;
  }
  searchTriggerSource = "manual";
  await runSearchAndShowResults(currentFilterState());
});
document.getElementById("backBtn").addEventListener("click", showFilterView);

function formatResultBody({ c }){
  return `${c.branchName} 週${WEEKDAY_LABEL[c.dayOfWeek]} ${c.startTime} ${c.className} ${c.teacherName}`;
}
function formatResultLine(row){
  const prefix = row.flagged ? `⚠ ${row.c.date.slice(5).replace("-", "/")} ` : "";
  return prefix + formatResultBody(row);
}
document.getElementById("copyResultsBtn").addEventListener("click", () => {
  const text = lastResultRows.map(formatResultLine).join("\n");
  trackEvent("copy_results", { result_count: lastResultRows.length });
  navigator.clipboard.writeText(text)
    .then(() => showPillWarning(document.getElementById("copyResultsBtn"), "已複製課程文字到剪貼簿"))
    .catch(() => showPillWarning(document.getElementById("copyResultsBtn"), "複製失敗，請手動選取"));
});
document.getElementById("shareUrlBtn").addEventListener("click", () => {
  trackEvent("share_url", {});
  navigator.clipboard.writeText(location.href)
    .then(() => showPillWarning(document.getElementById("shareUrlBtn"), "已複製網址到剪貼簿"))
    .catch(() => showPillWarning(document.getElementById("shareUrlBtn"), "複製失敗，請手動選取"));
});

// 舊版「今天」曾經是獨立的篩選值，存在 wg_selected_day.date 裡；「今天」改成快捷鍵後這欄位沒用了，清掉。
(function migrateAwayFromDateFilter(){
  try{
    const raw = localStorage.getItem("wg_selected_day");
    if (!raw) return;
    const state = JSON.parse(raw);
    if (state && Object.prototype.hasOwnProperty.call(state, "date")){
      delete state.date;
      localStorage.setItem("wg_selected_day", JSON.stringify(state));
    }
  } catch(e){ /* ignore */ }
})();

async function init(){
  await preloadRegisteredReminders();
  const urlState = getUrlFilterState();
  renderGrid("dayGrid", "day", DAY_OPTIONS);
  if (urlState) applyStateToInputs(urlState, ["day"]);
  else applySavedSelection("wg_selected_day", ["day"]);

  renderGrid("timeGrid", "time", TIME_OPTIONS);
  if (urlState) applyStateToInputs(urlState, ["time"]);
  else applySavedSelection("wg_selected_time", ["time"]);

  renderGrid("roomGrid", "room", ROOM_OPTIONS);
  if (urlState) applyStateToInputs(urlState, ["room"]);
  else if (localStorage.getItem("wg_selected_room")) applySavedSelection("wg_selected_room", ["room"]);
  else {
    const defaultRoomInput = document.querySelector('input[name="room"][value="團體教室"]');
    if (defaultRoomInput) defaultRoomInput.checked = true;
  }
  // branches.json 跟 /filterOptions 彼此獨立，同時發出去、各自等待，
  // 不要一個抓完才抓下一個，不然畫面等待時間會是兩個請求時間相加。
  const branchesPromise = withRetryTimeout(() => fetch("branches.json").then(r => r.json()), QUERY_RETRY_AFTER_MS, QUERY_GIVE_UP_AFTER_MS);
  const filterOptionsPromise = withRetryTimeout(() => fetch(`${WORKER_BASE}/filterOptions`).then(r => r.json()), QUERY_RETRY_AFTER_MS, QUERY_GIVE_UP_AFTER_MS);
  // 頁面載入就先預熱一張查詢用的 token，大部分情況使用者按查詢時早就備好了，不用多等。
  fetchFreshQueryToken().catch(e => console.error("issueToken 預熱失敗", e));

  try{
    const branches = await branchesPromise;
    BRANCH_MAP_URLS = Object.fromEntries(branches.filter(b => b.mapUrl).map(b => [b.slug, b.mapUrl]));
    BRANCH_URL_CODE = Object.fromEntries(branches.map((b, i) => [b.slug, String(i)]));
    BRANCH_URL_DECODE = Object.fromEntries(branches.map((b, i) => [String(i), b.slug]));
    BRANCH_COORDS = Object.fromEntries(branches.filter(b => b.lat != null && b.lng != null).map(b => [b.slug, { lat: b.lat, lng: b.lng }]));
    const branchClicks = getClickCounts("wg_branch_clicks");
    const branchOptions = branches
      .sort((a, b) => zoneRank(a.region) - zoneRank(b.region)
        || (branchClicks[b.slug] || 0) - (branchClicks[a.slug] || 0)
        || branchRank(a.slug) - branchRank(b.slug) || regionRank(a.region) - regionRank(b.region))
      .map(b => ({ value: b.slug, label: b.name, region: ZONE_MAP[b.region] || b.region, cityName: b.region }));
    renderBranchGrid("branchGrid", branchOptions);
    if (urlState && urlState.branch) urlState.branch = urlState.branch.map(v => BRANCH_URL_DECODE[v] || v);
    if (urlState) applyStateToInputs(urlState, ["branch"]);
    else applySavedSelection("wg_selected_branch", ["branch"]);
    updateSubmitState();
  } catch(e){
    console.error(e);
    document.getElementById("branchGrid").innerHTML = '<div class="empty-hint">分店清單讀取失敗，請重新整理頁面再試一次。</div>';
  }
  try{
    const filterData = await filterOptionsPromise;
    TEACHER_NAMES = filterData.teacherNames || [];
    renderGrid("courseGrid", "course", sortByClickCount(filterData.classNames || [], "wg_course_clicks").map(n => ({ value: n, label: n })));
    renderTeacherGrid();
    if (urlState) applyStateToInputs(urlState, ["course", "teacher"]);
    else {
      applySavedSelection("wg_selected_course", ["course"]);
      applySavedSelection("wg_selected_teacher", ["teacher"]);
    }
    updateSubmitState();
  } catch(e){
    console.error(e);
    document.getElementById("courseGrid").innerHTML = '<div class="empty-hint">課程清單讀取失敗，請重新整理頁面再試一次。</div>';
    document.getElementById("teacherGrid").innerHTML = '<div class="empty-hint">老師清單讀取失敗，請重新整理頁面再試一次。</div>';
    showServiceErrorModal();
  } finally {
    updateResetButtonState();
    // 帶網址參數進來時，遮罩要一路蓋到查詢結果準備好才收掉，
    // 不然中間會先露出篩選畫面再跳到結果畫面（分享網址的使用情境最容易看到這個閃爍）。
    // 網址只帶星期/時段/課程、沒帶分店或老師的話，isSearchValid() 會是 false，
    // 停在篩選畫面讓使用者自己選分店或老師，不會自動送出查詢。
    if (urlState && isSearchValid()){
      searchTriggerSource = "shared_url";
      await runSearchAndShowResults(currentFilterState());
    }
    document.getElementById("loadingOverlay").classList.add("fade-out");
    setTimeout(() => document.getElementById("loadingOverlay").remove(), 200);
  }
}
init();

// 分頁從背景切回前景時，如果查詢 token 快過期或已經過期，就先在背景換一張新的，
// 降低使用者真的按下查詢時撞到 token 過期、需要多等一次重試的機率（不是正確性必要條件，
// 真的沒趕上換新的話 runScheduleQuery 裡的過期重試機制還是會處理，只是會慢一點）。
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") return;
  if (!cachedQueryToken || cachedQueryToken.exp <= Date.now() + 60000){
    fetchFreshQueryToken().catch(e => console.error("visibilitychange token 刷新失敗", e));
  }
});

// 首頁的公開排行報表（分店查詢排行、課程查詢排行）：資料來自不需管理密鑰的公開端點，
// Chart.js 體積不小，等區塊真的進入畫面才動態載入，避免拖慢首屏。
function loadChartJs(){
  if (window.Chart) return Promise.resolve();
  if (!loadChartJs._promise){
    loadChartJs._promise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "vendor/chart.umd.min.js";
      script.onload = resolve;
      script.onerror = reject;
      document.body.appendChild(script);
    });
  }
  return loadChartJs._promise;
}

// 自製下拉選單：外觀跟 .section-btn 一致，但不用原生 <select>（原生下拉的箭頭位置/樣式沒辦法客製）。
// root 是 .custom-select 容器，內含 .custom-select-trigger 按鈕跟 .custom-select-menu 選項列表。
// 用 root.value（getter/setter）+ root.addEventListener("change", ...) 模擬原生 select 的介面。
// root.setOptions(options, selectedValue) 用來動態換選項（年份/月份清單都是動態抓的）。
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
      .map((o) => `<div class="custom-select-option${o.value === selectedValue ? " selected" : ""}" data-value="${o.value}">${o.html}</div>`)
      .join("");
    const sel = options.find((o) => o.value === selectedValue) || options[0];
    label.innerHTML = sel ? sel.html : "";
    root.dataset.value = sel ? sel.value : "";
  };
}

function setupPublicRankingStats({ wrapId, yearSelectId, monthSelectId, endpoint, itemsKey, barColor, ariaLabel, maxItems }){
  const wrapEl = document.getElementById(wrapId);
  const yearSelect = document.getElementById(yearSelectId);
  const monthSelect = document.getElementById(monthSelectId);
  if (!wrapEl || !yearSelect || !monthSelect) return;
  enhanceCustomSelect(yearSelect);
  enhanceCustomSelect(monthSelect);

  const THEME_INK = "#2b2b2b", THEME_SUB = "#7a7a7a", THEME_LINE = "#ececec";
  const ROW_H = 28, MIN_H = 60;
  let chartInstance = null;

  function renderChart(items){
    if (chartInstance){ chartInstance.destroy(); chartInstance = null; }
    if (!items.length){
      wrapEl.style.height = "";
      wrapEl.textContent = "這個月沒有查詢紀錄";
      return;
    }
    wrapEl.style.height = `${Math.max(MIN_H, items.length * ROW_H)}px`;
    wrapEl.innerHTML = "<canvas></canvas>";
    const canvas = wrapEl.querySelector("canvas");
    canvas.setAttribute("role", "img");
    canvas.setAttribute("aria-label", ariaLabel);
    chartInstance = new Chart(canvas, {
      type: "bar",
      data: {
        labels: items.map((t) => t.name),
        datasets: [{ data: items.map((t) => t.count), backgroundColor: barColor, borderRadius: 4, barThickness: ROW_H * 0.55 }],
      },
      options: {
        indexAxis: "y",
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 280 },
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: THEME_INK, titleColor: "#fff", bodyColor: "#fff",
            titleFont: { size: 11, weight: "700" }, bodyFont: { size: 11 },
            padding: 8, cornerRadius: 8, displayColors: false,
          },
        },
        scales: {
          x: { beginAtZero: true, grid: { color: THEME_LINE }, ticks: { color: THEME_SUB, font: { size: 10 }, precision: 0 } },
          y: { grid: { display: false }, ticks: { color: THEME_INK, font: { size: 12, weight: "600" } } },
        },
      },
    });
  }

  function populateMonthOptions(selected){
    const options = Array.from({ length: 12 }, (_, i) => {
      const m = String(i + 1).padStart(2, "0");
      return { value: m, html: `${i + 1} 月` };
    });
    monthSelect.setOptions(options, selected);
  }

  async function load(){
    const now = new Date();
    const year = yearSelect.value || String(now.getFullYear());
    const month = monthSelect.value || String(now.getMonth() + 1).padStart(2, "0");
    try{
      await loadChartJs();
      const res = await fetch(`${WORKER_BASE}/${endpoint}?year=${encodeURIComponent(year)}&month=${encodeURIComponent(month)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      const years = Array.isArray(data.years) && data.years.length ? data.years : [String(now.getFullYear())];
      if (!yearSelect.value){
        const yearOptions = years.map((y) => ({ value: y, html: `${y} 年` }));
        const selectedYear = years.includes(year) ? year : years[0];
        yearSelect.setOptions(yearOptions, selectedYear);
        populateMonthOptions(month);
        if (yearSelect.value !== year){
          load();
          return;
        }
      }
      const items = Array.isArray(data[itemsKey]) ? data[itemsKey] : [];
      renderChart(maxItems ? items.slice(0, maxItems) : items);
    } catch(e){
      console.error(e);
      wrapEl.textContent = "載入失敗，請稍後再試";
    }
  }

  yearSelect.addEventListener("change", load);
  monthSelect.addEventListener("change", load);
  window.addEventListener("resize", () => { if (chartInstance) chartInstance.resize(); });

  const observer = new IntersectionObserver((entries) => {
    if (entries.some((e) => e.isIntersecting)){
      observer.disconnect();
      load();
    }
  }, { rootMargin: "200px" });
  observer.observe(wrapEl);
}

// 首頁「查詢量趨勢」：近 12 個月查詢次數 / 結果數雙折線圖，資料來自公開端點 /publicSearchStats。
(function setupSearchTrend(){
  const wrapEl = document.getElementById("searchTrendWrap");
  if (!wrapEl) return;

  const THEME_INK = "#2b2b2b", THEME_SUB = "#7a7a7a", THEME_LINE = "#ececec";
  const CHART_MONTHS = 12;
  let chartInstance = null;

  function currentMonthKey(){ return new Date().toISOString().slice(0, 7); }
  function addMonths(monthStr, delta){
    const [y, m] = monthStr.split("-").map(Number);
    const d = new Date(Date.UTC(y, m - 1 + delta, 1));
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  }
  function monthTickLabel(d){
    const [yyyy, mm] = d.month.split("-");
    return [yyyy, mm];
  }
  function buildWindow(monthly, monthlyResults, endMonth){
    const months = [];
    for (let i = CHART_MONTHS - 1; i >= 0; i--) months.push(addMonths(endMonth, -i));
    return months.map((m) => ({ month: m, count: monthly[m] || 0, resultCount: monthlyResults[m] || 0 }));
  }

  async function load(){
    try{
      await loadChartJs();
      const res = await fetch(`${WORKER_BASE}/publicSearchStats`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      const chartData = buildWindow(data.monthly || {}, data.monthlyResults || {}, currentMonthKey());
      wrapEl.innerHTML = "<canvas></canvas>";
      const canvas = wrapEl.querySelector("canvas");
      canvas.setAttribute("role", "img");
      canvas.setAttribute("aria-label", `近 ${CHART_MONTHS} 個月查詢次數與查詢結果數趨勢`);
      chartInstance = new Chart(canvas, {
        type: "line",
        data: {
          labels: chartData.map(monthTickLabel),
          datasets: [
            { label: "查詢次數", data: chartData.map((d) => d.count), borderColor: "#2a78d6", backgroundColor: "#2a78d6", yAxisID: "yA", tension: 0.3, pointRadius: 4, pointHoverRadius: 5, borderWidth: 3 },
            { label: "結果數", data: chartData.map((d) => d.resultCount), borderColor: "#eb6834", backgroundColor: "#eb6834", yAxisID: "yB", tension: 0.3, pointRadius: 4, pointHoverRadius: 5, borderWidth: 3 },
          ],
        },
        options: {
          responsive: true,
          maintainAspectRatio: true,
          aspectRatio: 560 / 210,
          animation: { duration: 280 },
          interaction: { mode: "index", intersect: false },
          plugins: {
            legend: { display: false },
            tooltip: {
              backgroundColor: THEME_INK, titleColor: "#fff", bodyColor: "#fff",
              titleFont: { size: 11, weight: "700" }, bodyFont: { size: 11 },
              padding: 8, cornerRadius: 8, displayColors: false,
              callbacks: {
                title: (items) => chartData[items[0].dataIndex].month,
                label: (item) => `${item.dataset.label} ${item.formattedValue}`,
              },
            },
          },
          scales: {
            x: { grid: { display: false }, ticks: { color: THEME_SUB, font: { size: 9 } } },
            yA: { position: "left", beginAtZero: true, ticks: { color: "#2a78d6", font: { size: 9 }, count: 5, precision: 0, callback: (v) => Math.round(v) }, grid: { color: THEME_LINE } },
            yB: { position: "right", beginAtZero: true, ticks: { color: "#eb6834", font: { size: 9 }, count: 5, precision: 0, callback: (v) => Math.round(v) }, grid: { display: false } },
          },
        },
      });
    } catch(e){
      console.error(e);
      wrapEl.textContent = "載入失敗，請稍後再試";
    }
  }

  window.addEventListener("resize", () => { if (chartInstance) chartInstance.resize(); });

  const observer = new IntersectionObserver((entries) => {
    if (entries.some((e) => e.isIntersecting)){
      observer.disconnect();
      load();
    }
  }, { rootMargin: "200px" });
  observer.observe(wrapEl);
})();

setupPublicRankingStats({
  wrapId: "branchStatsWrap", yearSelectId: "branchStatsYear", monthSelectId: "branchStatsMonth",
  endpoint: "publicBranchStats", itemsKey: "branches", barColor: "#4a90d9", ariaLabel: "分店查詢次數排行", maxItems: 10,
});
setupPublicRankingStats({
  wrapId: "courseStatsWrap", yearSelectId: "courseStatsYear", monthSelectId: "courseStatsMonth",
  endpoint: "publicCourseStats", itemsKey: "courses", barColor: "#8a6fb3", ariaLabel: "課程查詢次數排行", maxItems: 10,
});
setupPublicRankingStats({
  wrapId: "teacherStatsWrap", yearSelectId: "teacherStatsYear", monthSelectId: "teacherStatsMonth",
  endpoint: "publicTeacherStats", itemsKey: "teachers", barColor: "#c9922e", ariaLabel: "老師查詢次數排行",
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
