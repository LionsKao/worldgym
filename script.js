// 課表查詢、分店/課程/老師篩選選項都由 Cloudflare Worker + D1 提供。
const WORKER_BASE = "https://worldgym-api.lions2100.workers.dev";
// 篩選後結果超過這個筆數就視為條件太寬鬆，不導到結果頁、只在查詢按鈕上提示使用者多加篩選。
const RESULT_COUNT_WARN_LIMIT = 250;

// 篩選區的六個群組（對應 input 的 name）：網址參數、分享網址、我的最愛、重設、儲存選擇都用這份順序。
const FILTER_GROUPS = ["day", "time", "branch", "room", "course", "teacher"];
// 各群組勾選結果存在 localStorage 的 key（wg_selected_day、wg_selected_time ...）
const SELECTION_STORAGE_KEYS = FILTER_GROUPS.map((name) => `wg_selected_${name}`);

// 打自家 Worker API 的 POST（body 一律 JSON），回傳 fetch 的 Promise。
function postJson(path, body){
  return fetch(`${WORKER_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}
// 打點類請求：失敗靜默吞掉，不影響前台體驗、不重試。
function fireAndForgetPost(path, body){
  postJson(path, body).catch(() => {});
}
// 讀 localStorage（useSession=true 則是 sessionStorage）裡的 JSON：沒有、格式壞掉、被瀏覽器擋掉都回 fallback。
// 讀寫 localStorage／sessionStorage 一律走下面這幾個函式：儲存空間滿了、或被瀏覽器擋住（無痕、關閉 cookie）時，
// 讀寫甚至連取得 localStorage 本身都可能丟例外。這些只是「記住使用者的選擇」的便利功能，失敗了不能讓查詢、渲染跟著失敗
// （以前寫入丟例外，會被 runSearchAndShowResults 的 catch 當成「網路連線異常」，成功的查詢結果也出不來）。
// 寫入失敗只留一則 console 警告，回傳 false。
function readStored(key, useSession = false){
  try { return (useSession ? sessionStorage : localStorage).getItem(key); }
  catch(e){ return null; }
}
function writeStored(key, value, useSession = false){
  try { (useSession ? sessionStorage : localStorage).setItem(key, value); return true; }
  catch(e){ console.warn("寫入儲存空間失敗", key, e); return false; }
}
function removeStored(key){
  try { localStorage.removeItem(key); }
  catch(e){ /* 取不到儲存空間就當沒有東西可清 */ }
}
function readStoredJson(key, fallback, useSession = false){
  try { return JSON.parse(readStored(key, useSession)) || fallback; }
  catch(e){ return fallback; }
}
function writeStoredJson(key, value, useSession = false){
  return writeStored(key, JSON.stringify(value), useSession);
}

// 課表通知（Web Push）：VAPID public key，跟 worker/.dev.vars 的 VAPID_PUBLIC_KEY 是同一組 key pair。
const VAPID_PUBLIC_KEY = "BCcFfPhUxaUYFMtosUu21nd24j5El9YcuYNndb3Ll0_rjC-SwSnT4YvQfi7nVTuQWYjIiDlZqG1jrZrwi7uuw4k";

// 網址帶 ?pwa=1 等同貼 localStorage.setItem("wg_debug_force_pwa","1")，方便直接分享測試連結，不用開 Console。
// 寫進 localStorage 才不會在查詢送出後被 buildShareUrl 換掉網址（只保留篩選參數）就失效。
if (new URLSearchParams(location.search).get("pwa") === "1"){
  writeStored("wg_debug_force_pwa", "1");
}

// 從舊網域導過來的訪客(Cloudflare 301 redirect 帶 ?utm_source=wgcourse_old 或 ?utm_source=old_index)，
// 沿用廣告 banner 的位置顯示「記得改書籤」提示，不顯示其他廣告。
const OLD_DOMAIN_UTM_SOURCES = ["wgcourse_old", "old_index"];
const cameFromOldDomain = OLD_DOMAIN_UTM_SOURCES.includes(new URLSearchParams(location.search).get("utm_source"));
if (cameFromOldDomain){
  // 提示文案講「加完書籤這行就會消失」，所以要讓「使用者當下把網址列加進書籤」存到的是乾淨網址，
  // 不然書籤存到的還是帶著 utm_source=wgcourse_old 的網址，下次打開又會命中同一組參數、提示又跳出來。
  // 清網址前要先讓 GA4 送出這次工作階段的第一個 pageview（歸因用得到這組 utm），不然 GA4 抓到的會是
  // 已經清乾淨、不帶 utm_source 的網址，變成「(not set)」。GA4 的 gtag.js 現在延遲到 window.load
  // 才開始載入（見 index.html），時間不固定，所以改成等 index.html 送出的 wg-ga-loaded 事件
  // （gtag.js 真的載入完成）才清，而不是猜一個固定秒數；保底逾時是防呆，避免 GA 被瀏覽器擋掉
  // （廣告攔截等）或載入失敗時網址永遠清不掉。清之前重新檢查一次，避免蓋掉使用者這段時間內
  // 自己觸發的網址變化（例如送出查詢後 runSearchAndShowResults 已經把網址換成分享用網址）。
  const cleanOldDomainUtmFromUrl = () => {
    if (OLD_DOMAIN_UTM_SOURCES.includes(new URLSearchParams(location.search).get("utm_source"))){
      history.replaceState(null, "", location.pathname);
    }
  };
  window.addEventListener("wg-ga-loaded", () => setTimeout(cleanOldDomainUtmFromUrl, 500), { once: true });
  setTimeout(cleanOldDomainUtmFromUrl, 20000);
}

// 臨時公告（例如颱風提醒）：沿用廣告 banner 的位置，純文字、沒有連結；今天（台灣）早於 endDate 才顯示，
// 過期自動消失。優先於舊網域提示與廣告，公告期間不載入廣告、也不送廣告點擊統計。
// 下次要發公告就改 text 與 endDate（endDate 是「不含當天」的結束日），script.js 版號加一。
const SITE_NOTICE = {
  text: "10/24 颱風：北中部及宜蘭團體課停課，嘉義以南照常，詳見官網公告。",
  endDate: "2026-10-25", // 顯示到 10/24 當天，10/25 零點起不顯示
};
const siteNoticeActive = () => todayIso() < SITE_NOTICE.endDate; // todayIso 來自 common.js
const showSiteNotice = siteNoticeActive(); // 載入時定一次：頁面開著跨過結束日也不會變成「看得到公告卻被當廣告統計」

// 廣告文案：內容改由 D1 的 ads table 提供（上下架時間 + enabled 開關），
// 首頁載入時打 /ads 拿目前生效中的廣告，隨機挑一則顯示，同一個工作階段（頁面沒重整）
// 就固定顯示那一則，不會再輪播切換。每則廣告各自帶自己的連結，換廣告時同步換外層 <a> 的 href。
let AD_BANNERS = [];
let currentAdIndex = 0;
// 廣告曝光/點擊落地存進 D1（跟 GA4 的 trackEvent 分開），失敗靜默吞掉，不影響前台體驗、不重試。
// 本機開發(localhost/127.0.0.1)不計入，避免測試把廣告曝光/點擊數字洗掉。
function isAdTrackingExcluded(){
  return ["localhost", "127.0.0.1"].includes(location.hostname);
}

// 點擊是低頻、有明確意圖的事件，直接送單筆即可，不用跟曝光一起排隊等 batch。
function trackAdClick(adId){
  if (!adId || isAdTrackingExcluded()) return;
  fireAndForgetPost("/trackAdEvent", { adId, type: "click" });
}

// 廣告一個工作階段只隨機挑一則顯示（不輪播），曝光先攢在記憶體裡，
// 使用者切到背景或離開頁面時才送出，見 flushAdImpressions()。
let adImpressionBuffer = [];
function bufferAdImpression(adId){
  if (!adId || isAdTrackingExcluded()) return;
  adImpressionBuffer.push(adId);
}

// useBeacon: 分頁切到背景/即將卸載時呼叫，用 sendBeacon 確保即使頁面馬上關閉也送得出去。
// 清空 buffer 前先複製一份，避免送出中途又有新曝光被吃掉。
// 曾經用 setInterval 每 30 秒定時 flush 一次（廣告輪播年代留下的保險機制），拿掉了：
// 現在一個工作階段最多只有 1 筆曝光，visibilitychange／pagehide 這兩個事件已經夠涵蓋所有離開頁面
// 的情境，不需要手機上一直醒著的計時器（省電）。
function flushAdImpressions(useBeacon){
  if (adImpressionBuffer.length === 0) return;
  const events = adImpressionBuffer.map((adId) => ({ adId, type: "impression" }));
  adImpressionBuffer = [];
  const payload = JSON.stringify({ events });
  if (useBeacon && navigator.sendBeacon){
    navigator.sendBeacon(`${WORKER_BASE}/trackAdEvents`, new Blob([payload], { type: "text/plain" }));
    return;
  }
  fireAndForgetPost("/trackAdEvents", { events });
}
document.addEventListener("visibilitychange", () => {
  if (document.hidden) flushAdImpressions(true);
});
window.addEventListener("pagehide", () => flushAdImpressions(true));

// 老師/課程/分店查詢次數落地存進 D1，用來給 admin.html 統計「哪些老師/課程/分店最常被查」。
// 同一裝置 30 分鐘內重複查同一個值只算 1 次，避免上一頁/重查造成洗次數。
// 一次查詢常常同時勾多個老師/課程/分店，三種各自去重篩選完之後合成一個 payload，
// 一次 fetch 打 /trackSearchEvents 讓 worker 一次 batch 寫完，不要選了幾個就發幾個獨立 request。
const SEARCH_COUNT_DEDUPE_WINDOW_MS = 30 * 60 * 1000;
function makeSearchCountFilter(dedupeKey){
  return function filterLoggable(values){
    const map = readStoredJson(dedupeKey, {});
    const now = Date.now();
    for (const k of Object.keys(map)){
      if (now - map[k] > SEARCH_COUNT_DEDUPE_WINDOW_MS) delete map[k];
    }
    const loggable = [];
    for (const value of values || []){
      if (!value) continue;
      const last = map[value];
      if (last && now - last < SEARCH_COUNT_DEDUPE_WINDOW_MS) continue;
      map[value] = now;
      loggable.push(value);
    }
    writeStoredJson(dedupeKey, map);
    return loggable;
  };
}
const filterLoggableTeachers = makeSearchCountFilter("wg_teacher_search_dedupe");
const filterLoggableCourses = makeSearchCountFilter("wg_course_search_dedupe");
const filterLoggableBranches = makeSearchCountFilter("wg_branch_search_dedupe");
function logSearchEvents(teachers, courses, branches){
  const payload = {
    teachers: filterLoggableTeachers(teachers),
    courses: filterLoggableCourses(courses),
    branches: filterLoggableBranches(branches),
  };
  if (payload.teachers.length === 0 && payload.courses.length === 0 && payload.branches.length === 0) return;
  fireAndForgetPost("/trackSearchEvents", payload);
}

// 整體查詢量落地存進 D1，每次真的送出查詢就打一次，不去重，用來看使用量趨勢。
// resultCount 記錄這次查詢實際顯示的課程數，沒結果或結果太多沒顯示時傳 0。
function logSearchEvent(resultCount){
  fireAndForgetPost("/trackSearch", { resultCount });
}

// 沒有帳號系統，只能用存在 localStorage 的匿名 id 估算「幾個人」用過某個功能，
// 不會拿去對應任何個人資料，純粹統計用。
const CLIENT_ID_KEY = "wg_client_id";
function getClientId(){
  let id = readStored(CLIENT_ID_KEY);
  if (!id){
    id = crypto.randomUUID();
    writeStored(CLIENT_ID_KEY, id);
  }
  return id;
}

// 我的最愛使用量落地存進 D1：add 是成功建立一個最愛、apply 是點最愛套用篩選，不去重，
// 用來在 admin.html 看「多少人做起來」跟「做起來後按了幾次」。
function logFavoriteEvent(type){
  fireAndForgetPost("/trackFavorite", { clientId: getClientId(), type });
}
// 廣告連結只收 http(s)：ads.url 是寫在資料庫裡的字串，會直接變成 <a href>，
// 要是不小心（或被人）寫成 javascript: 之類，點下去就會執行。不合格的廣告當作沒有這則。
function hasWebUrl(ad){
  try {
    return ["http:", "https:"].includes(new URL(ad.url).protocol);
  } catch(err){
    return false;
  }
}
function withUtmSource(url){
  try {
    const u = new URL(url);
    u.searchParams.set("utm_source", "worldgym.pages.dev");
    u.searchParams.set("utm_medium", "referral");
    return u.toString();
  } catch(err){
    return url;
  }
}

// 一次工作階段只隨機挑一則廣告顯示，不再輪播；使用者要看到別的廣告只能重新整理頁面（等同開新的工作階段）。
// 橫幅在 index.html 裡預設就是 hidden、也沒有預設文字與連結：沒有生效中的廣告時完全不會出現，
// 不會在等 /ads 回應的那段時間先閃一下舊內容再消失；有廣告（或舊網域提示）才在這裡填內容並顯示。
function initAdBanner(){
  const banner = document.getElementById("adBanner");
  const el = document.getElementById("adBannerText");
  if (!banner || !el) return;
  if (showSiteNotice){
    el.textContent = SITE_NOTICE.text;
    banner.removeAttribute("href");
    const tag = banner.querySelector(".ad-banner-tag");
    tag.setAttribute("aria-label", "公告");
    tag.innerHTML = '<i class="fa-solid fa-fw fa-bullhorn"></i>';
    banner.classList.remove("hidden");
    return;
  }
  if (cameFromOldDomain){
    el.textContent = "📌 網址換囉！記得把新網址加進書籤，加完這行就會消失";
    banner.removeAttribute("href");
    const tag = banner.querySelector(".ad-banner-tag");
    tag.setAttribute("aria-label", "提示");
    tag.innerHTML = '<i class="fa-solid fa-fw fa-bookmark"></i>';
    banner.classList.remove("hidden");
    return;
  }
  if (AD_BANNERS.length === 0) return;
  currentAdIndex = Math.floor(Math.random() * AD_BANNERS.length);
  el.textContent = AD_BANNERS[currentAdIndex].text;
  banner.href = withUtmSource(AD_BANNERS[currentAdIndex].url);
  banner.classList.remove("hidden");
  bufferAdImpression(AD_BANNERS[currentAdIndex].id);
}
if (showSiteNotice || cameFromOldDomain){
  initAdBanner();
} else {
  fetch(`${WORKER_BASE}/ads`)
    .then((res) => (res.ok ? res.json() : { ads: [] }))
    .then((data) => { AD_BANNERS = Array.isArray(data.ads) ? data.ads.filter(hasWebUrl) : []; })
    .catch(() => { AD_BANNERS = []; })
    .finally(initAdBanner);
}
document.querySelector(".ad-banner")?.addEventListener("click", () => {
  if (showSiteNotice || cameFromOldDomain) return;
  trackEvent("click_ad_banner", { ad_text: document.getElementById("adBannerText")?.textContent });
  trackAdClick(AD_BANNERS[currentAdIndex]?.id);
});

// 鈴鐺只在「已安裝成 standalone PWA」才顯示，不要求通知權限已授權（未授權按下去會先跳說明 modal）。
// 除錯用旁路：正式環境使用者不會知道這個 localStorage key，只是方便開發時在一般分頁看到鈴鐺。
function isPWAInstalled(){
  if (readStored("wg_debug_force_pwa") === "1") return true;
  return isStandaloneDisplay();
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
function reminderKeyFromRecord(r){
  return reminderKeyFromFields(r.branchSlug, r.dayOfWeek, r.startTime, r.className, r.teacherName);
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
    setResultRowNotifyLine(bell, existing);
  });
}
// 查詢結果列底下顯示「會在 mm/dd 週幾 hh:mm 通知你（課前 N 分鐘）」，跟通知清單頁那行文字共用同一個 reminderNotifyText。
// reminder 是 registeredReminders 裡的紀錄，沒登記就傳 undefined（把那一行拿掉）。
function setResultRowNotifyLine(bell, reminder){
  const content = bell.closest(".result-row")?.querySelector(".result-row-content");
  if (!content) return;
  let notifyLine = content.querySelector(".reminder-notify-time");
  if (reminder?.remindAt){
    if (!notifyLine){
      notifyLine = document.createElement("div");
      notifyLine.className = "reminder-notify-time";
      content.appendChild(notifyLine);
    }
    notifyLine.textContent = reminderNotifyText(reminder);
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

function reminderNotifyText(reminder){
  return `會在 ${formatReminderTime(reminder.remindAt)} 通知你（課前 ${reminder.remindMinutes || DEFAULT_REMIND_MINUTES} 分鐘）`;
}

// 課前提醒可選的分鐘數，要跟 worker/src/reminders.js 的 REMIND_MINUTES_OPTIONS（後端白名單）、
// index.html 的 remindLead 三個 radio 一致。上次選的記在 localStorage，下次開視窗時預選。
const REMIND_MINUTES_OPTIONS = [30, 60, 90];
const DEFAULT_REMIND_MINUTES = 30;
const REMIND_MINUTES_KEY = "wg_remind_minutes";
function readRemindMinutes(){
  const n = parseInt(readStored(REMIND_MINUTES_KEY), 10);
  return REMIND_MINUTES_OPTIONS.includes(n) ? n : DEFAULT_REMIND_MINUTES;
}

const REMINDER_EMPTY_HTML = '<div class="empty-hint" id="reminderEmptyHint">沒有通知</div>';
let pendingReminderBell = null;
async function registerReminderForBell(bell, remindMinutes){
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
      remindMinutes,
      pushSubscription: sub.toJSON(),
      clickUrl: location.href,
    };
    const res = await postJson("/registerReminder", body);
    if (!res.ok) throw new Error(`registerReminder failed: ${res.status}`);
    const data = await res.json();
    registeredReminders.set(reminderKeyFromBell(bell), { ...body, id: data.id, classAt: data.classAt, remindAt: data.remindAt, remindMinutes: data.remindMinutes });
    syncResultBellsToRegistered();
    trackEvent("register_reminder", { class_name: bell.dataset.className, teacher_name: bell.dataset.teacherName, lead_minutes: remindMinutes });
  } catch(e){
    console.error(e);
  } finally {
    bell.classList.remove("busy");
  }
}
// 取消一則已登記的通知（結果頁的鈴鐺、「通知」清單的鈴鐺共用）。
async function cancelReminderRequest(id){
  const sub = await ensurePushSubscription();
  await postJson("/cancelReminder", { id, subscriptionEndpoint: sub.endpoint });
}
// 這個 push subscription 底下所有還沒發送的通知。
async function fetchMyReminders(endpoint){
  const res = await fetch(`${WORKER_BASE}/myReminders?endpoint=${encodeURIComponent(endpoint)}`);
  const data = await res.json();
  return data.reminders || [];
}
async function cancelReminderForBell(bell){
  bell.classList.add("busy");
  try{
    const id = bell.dataset.reminderId;
    await cancelReminderRequest(id);
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
  openReminderModal(bell);
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
    list = await fetchMyReminders(sub.endpoint);
  } catch(e){
    console.error(e);
  }
  registeredReminders.clear();
  list.forEach((r) => registeredReminders.set(reminderKeyFromRecord(r), r));
  syncResultBellsToRegistered();

  grid.innerHTML = "";
  if (list.length === 0){
    grid.insertAdjacentHTML("beforeend", REMINDER_EMPTY_HTML);
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
      notifyLine.textContent = reminderNotifyText(r);
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
    await cancelReminderRequest(id);
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
          document.getElementById("reminderGrid").innerHTML = REMINDER_EMPTY_HTML;
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
    (await fetchMyReminders(sub.endpoint)).forEach((r) => registeredReminders.set(reminderKeyFromRecord(r), r));
  } catch(e){
    console.error(e);
  }
}

// slug -> Google Maps 連結，從 #branchGrid 分店 checkbox 的 data-map-url 讀進來（不是每間分店都有）。
let BRANCH_MAP_URLS = {};
// 分店 slug 在網址參數裡很長，選很多間會讓網址爆長，改用這份固定順序表的位置當短代碼。
// 順序要保持不變、只能往後附加（跟 worker/src/branches-seed.js 同一個順序），不然舊的分享網址會解碼出錯的分店。
const BRANCH_SLUG_ORDER = ["taipei-101","taipei-minsheng","taipei-gongguan","taipei-station","taipei-dazhi","taipei-changchun","taipei-minquan-east","taipei-nanjing","taipei-daan","taipei-tonling","taipei-guangfu","taipei-ximen","taipei-songren","taipei-songlong","taipei-tienmu-dexing","taipei-shilin","taipei-tienmu","taipei-beitou-zhonghe","taipei-neihu","taipei-neihu-fuhwa","new-taipei-banqiao-shuangshi","new-taipei-banciao-chongcing","new-taipei-banqiao-fuzhong","new-taipei-banqiao-zhongshan","new-taipei-xizhi","new-taipei-xike","new-taipei-hsindian","new-taipei-yonghe","new-taipei-yonghe-minquan","new-taipei-zhonghe","new-taipei-jingping","new-taipei-tucheng","new-taipei-sanchong","new-taipei-beihsinzhuang","new-taipei-hsinzhuang","new-taipei-danshui","new-taipei-linkou","taoyuan-taimall","taoyuan-neili","taoyuan-pingzhen","taoyuan-dayou","taoyuan-fuxing","taoyuan-guoqiang","hsinchu-zhonghua","hsinchu-zhongzheng","hsinchu-zhubei","miaoli-yuanli","taichung-xuefu","taichung-meicun","taichung-e-chung","taichung-chongde","taichung-dongshan","taichung-xitun","taichung-liming","taichung-wuri","taichung-fengyuan","taichung-qingshui","taichung-dajia","nantou-caotun","changhua-heping","changhua-yuanlin","chiayi-minzu","tainan-focus","tainan-shulin","tainan-ximen","tainan-yongkang","tainan-shanhua","kaohsiung-zhonghua","kaohsiung-datong-heping","kaohsiung-sogo","kaohsiung-baocheng","kaohsiung-gangshan","kaohsiung-fengshan-zhongshan","pingtung-ziyou","pingtung-chaozhou","yilan-youai","yilan-luodong","hualian-guolian","keelung-xinyi","changhua-lukang","kaohsiung-yangming","yunlin-douliu","taichung-daya","taipei-minsheng-yuanhuan","taipei-neihu-gangqia","taichung-shalu","taoyuan-yangmei","taoyuan-zhongli-zhongyuan","taichung-taiping","miaoli-zhunan","miaoli-toufen","new-taipei-tucheng-haishan","hualien-jian","tainan-rende","tainan-yongkang-yongda","yunlin-huwei","tainan-haian","tainan-annan","tainan-xinying","tainan-anping","hsinchu-xinfeng","hsinchu-zhubei-huaxing","kaohsiung-zuoying","kaohsiung-fengshan-wujia","chiayi-xingye","hsinchu-xiangshan","tainan-zhonghua-east","taoyuan-yiwen","miaoli-zhongzheng","changhua-xihu","taoyuan-bade"];
let BRANCH_URL_CODE = {};
let BRANCH_URL_DECODE = {};
// slug -> { lat, lng }，供依目前位置篩選分店（1km/3km/5km）使用，從 data-lat/data-lng 讀進來。
let BRANCH_COORDS = {};
// 分店 slug → 畫面上的分店名稱，initBranchGrid 讀 pill 時建好，branchSlugToName 查它。
let BRANCH_NAMES = new Map();

function trackEvent(name, params){
  if (typeof gtag === "function") gtag("event", name, params);
}

// 同一次瀏覽（分頁沒關掉前）同一個事件+對象只送一次，避免狂點洗數字。
const SESSION_TRACKED_EVENTS_KEY = "wg_session_tracked_events";
function trackEventOncePerSession(name, dedupValue, params){
  const key = `${name}:${dedupValue}`;
  const tracked = new Set(readStoredJson(SESSION_TRACKED_EVENTS_KEY, [], true));
  if (tracked.has(key)) return;
  tracked.add(key);
  writeStoredJson(SESSION_TRACKED_EVENTS_KEY, [...tracked], true);
  trackEvent(name, params);
}
function trackTeacherEventOncePerSession(name, teacherName){
  trackEventOncePerSession(name, teacherName, { teacher_name: teacherName });
}

// 下一次 search_schedule 事件的觸發來源；送出後會重置回 "manual"。
let searchTriggerSource = "manual";

// 台灣今天的日期 todayIso() 在 common.js（前後台共用）。
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
// 只有在真的要送查詢給後端之前才 resolve（見 resolveQueryState）。
// "今天"/"明天" resolve 成實際日期（exactDates），不是星期幾——這兩個字面上就是指「這一天」，
// 不該像明確勾選的星期幾一樣，連帶把 7~14 天後同星期的代課也撈出來（那是給「星期日」這種
// 明確星期幾篩選用的，見 worker/src/queryClasses.js 的 SUBSTITUTE_DAYS_AHEAD 說明）。
function resolveQueryState(state){
  const weekdays = [];
  const exactDates = [];
  for (const v of (state.day || [])){
    if (v === "today") exactDates.push(todayIso());
    else if (v === "tomorrow") exactDates.push(addDaysIso(todayIso(), 1));
    else weekdays.push(v);
  }
  return { ...state, day: [...new Set(weekdays)], exactDates: [...new Set(exactDates)] };
}

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
  // 課程/老師名稱來自爬官網的資料，不能直接拼進 innerHTML（官網資料若含 < 會被當成 HTML 執行），
  // 一律用 DOM API 設值，瀏覽器自己會當純文字處理。
  const input = document.createElement("input");
  input.type = "checkbox";
  input.name = name;
  input.value = value;
  input.id = id;
  if (checked) input.checked = true;
  const labelEl = document.createElement("label");
  labelEl.htmlFor = id;
  labelEl.textContent = label;
  wrap.append(input, labelEl);
  return wrap;
}

function renderGrid(containerId, defaultName, options){
  const grid = document.getElementById(containerId);
  grid.querySelectorAll(".pill, .empty-hint").forEach(el => el.remove());
  if (options.length === 0){
    grid.insertAdjacentHTML("beforeend", '<span class="empty-hint">目前沒有資料</span>');
    return;
  }
  const fragment = document.createDocumentFragment();
  options.forEach(opt => {
    fragment.appendChild(makePill(opt.name || defaultName, opt.value, opt.label, opt.checked));
  });
  grid.appendChild(fragment);
}

function getZoneState(zoneName, isTaipei) {
  const states = readStoredJson("wg_zone_states", {});
  return states[zoneName] !== undefined ? states[zoneName] : isTaipei;
}

function saveZoneState(zoneName, isExpanded) {
  const states = readStoredJson("wg_zone_states", {});
  states[zoneName] = isExpanded;
  writeStoredJson("wg_zone_states", states);
}

function getClickCounts(key) {
  return readStoredJson(key, {});
}
function incrementClickCount(key, value) {
  const counts = getClickCounts(key);
  counts[value] = (counts[value] || 0) + 1;
  writeStoredJson(key, counts);
}
function sortByClickCount(items, key, getValue = (x) => x) {
  const counts = getClickCounts(key);
  return [...items].sort((a, b) => (counts[getValue(b)] || 0) - (counts[getValue(a)] || 0));
}
// 把 container 底下的 .pill 依點擊次數由多到少重排（常用的排前面）：搬動既有節點，不重新產生 DOM。
// 每個 pill 只讀一次它的 input 值（排序時不再重複 querySelector；老師有一千多個 pill），順序沒變就不搬。
function reorderPillsByClicks(container, key){
  const counts = getClickCounts(key);
  const pills = [...container.querySelectorAll(".pill")];
  const ranked = pills
    .map(pill => [pill, counts[pill.querySelector("input").value] || 0])
    .sort((a, b) => b[1] - a[1])
    .map(([pill]) => pill);
  if (ranked.every((pill, i) => pill === pills[i])) return;
  ranked.forEach(pill => container.appendChild(pill));
}

// 分店 pill、1/3/5km 距離按鈕、全選按鈕都已經寫死在 index.html 裡（不是用 JS 動態產生），
// 這裡只負責讀出寫死的 data-* 屬性、把事件綁上去，並套用使用者的分區展開狀態跟分店點擊次數排序。
function initBranchGrid(){
  const grid = document.getElementById("branchGrid");
  const branchSectionHead = document.getElementById("branchSectionHead");

  BRANCH_URL_CODE = Object.fromEntries(BRANCH_SLUG_ORDER.map((slug, i) => [slug, String(i)]));
  BRANCH_URL_DECODE = Object.fromEntries(BRANCH_SLUG_ORDER.map((slug, i) => [String(i), slug]));

  const branchInputs = [...grid.querySelectorAll('input[name="branch"]')];
  BRANCH_MAP_URLS = Object.fromEntries(
    branchInputs.filter(input => input.dataset.mapUrl).map(input => [input.value, input.dataset.mapUrl])
  );
  BRANCH_NAMES = new Map(branchInputs.map(input => [input.value, input.nextElementSibling.textContent]));
  BRANCH_COORDS = Object.fromEntries(
    branchInputs.filter(input => input.dataset.lat && input.dataset.lng)
      .map(input => [input.value, { lat: Number(input.dataset.lat), lng: Number(input.dataset.lng) }])
  );

  if (!navigator.geolocation) {
    branchSectionHead.querySelectorAll(".geo-filter-btn").forEach(el => el.remove());
  } else {
    branchSectionHead.querySelectorAll(".geo-filter-btn").forEach(btn => {
      btn.addEventListener("click", () => requestGeoFilter(Number(btn.dataset.radiusKm)));
    });
  }

  const zoneToggles = {};
  grid.querySelectorAll(".zone-toggle").forEach(toggle => {
    const zoneName = toggle.dataset.zoneName;
    zoneToggles[zoneName] = { toggle };
    toggle.addEventListener("click", () => {
      const group = toggle.nextElementSibling;
      const isCollapsing = !group.classList.contains("collapsed");

      saveZoneState(zoneName, !isCollapsing);

      group.classList.toggle("collapsed", isCollapsing);
      toggle.classList.toggle("expanded", !isCollapsing);
    });
  });

  // 套用使用者上次留下的分區展開/收合狀態，可能跟寫死的預設值（只有台北區展開）不同。
  grid.querySelectorAll(".zone-group").forEach(group => {
    const zoneName = group.dataset.zoneName;
    const toggle = zoneToggles[zoneName]?.toggle;
    if (!toggle) return;
    const isExpanded = getZoneState(zoneName, zoneName === "台北區");
    group.classList.toggle("collapsed", !isExpanded);
    toggle.classList.toggle("expanded", isExpanded);
  });

  function selectAllAndExpand(inputs, trackLabel, zoneName){
    inputs.forEach(input => { input.checked = true; });
    saveSelection("wg_selected_branch", ["branch"]);
    updateResetButtonState();
    updateSubmitState();
    trackEvent("select_all_branch", { city_name: trackLabel });

    const zoneToggle = zoneToggles[zoneName];
    if (zoneToggle && !zoneToggle.toggle.classList.contains("expanded")) {
      zoneToggle.toggle.click();
    }
  }

  branchSectionHead.querySelectorAll("[data-select-all-city]").forEach(btn => {
    const cityName = btn.dataset.selectAllCity;
    btn.addEventListener("click", () => {
      const inputs = branchInputs.filter(input => input.dataset.city === cityName);
      selectAllAndExpand(inputs, cityName, ZONE_MAP[cityName] || cityName);
    });
  });

  branchSectionHead.querySelectorAll("[data-select-all-zone]").forEach(btn => {
    const zoneName = btn.dataset.selectAllZone;
    const label = btn.dataset.selectAllLabel;
    btn.addEventListener("click", () => {
      const inputs = [...grid.querySelector(`.zone-group[data-zone-name="${zoneName}"]`).querySelectorAll('input[name="branch"]')];
      selectAllAndExpand(inputs, label, zoneName);
    });
  });

  // 分店在各分區內再依使用者點擊次數重排（常用分店排前面），改成搬動既有節點，不用重新產生 DOM。
  grid.querySelectorAll(".zone-group").forEach(group => reorderPillsByClicks(group, "wg_branch_clicks"));
}

// 每個 pill 的 label 小寫文字只算一次：老師有一千多個 pill，打字時每個按鍵（輸入法組字時更密集）都要比對一遍，
// 以前每次都重新 querySelector("label")、讀 textContent、轉小寫。label 文字在 pill 建立後不會變，
// pill 重新產生就是新節點，WeakMap 的快取跟著換、舊的自動回收。
const pillLabelCache = new WeakMap();
function pillLabelText(pill){
  let text = pillLabelCache.get(pill);
  if (text === undefined){
    text = pill.querySelector("label").textContent.toLowerCase();
    pillLabelCache.set(pill, text);
  }
  return text;
}
document.querySelectorAll(".section-search").forEach(input => {
  if (!input.dataset.searchFor) return;
  const clearBtn = input.closest(".search-wrap")?.querySelector(".search-clear");
  input.addEventListener("input", () => {
    const grid = document.getElementById(input.dataset.searchFor);
    const text = input.value.trim().toLowerCase();
    clearBtn?.classList.toggle("visible", input.value !== "");
    grid.querySelectorAll(".pill").forEach(pill => {
      pill.classList.toggle("hidden", text !== "" && !pillLabelText(pill).includes(text));
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
  // 只選星期（或只選時間、教室、課程）查出的課程會太多、超過結果數量上限，所以不解鎖查詢鈕——
  // 星期格的 change 事件因此也不需要呼叫這個函式。「加到最愛」在查詢結果頁底下，進得了結果頁就一定通過這個條件，不用另外擋。
  const valid = isSearchValid();
  document.getElementById("scheduleSubmitBtn").classList.toggle("gray-btn", !valid);
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
  // text 含課程/老師名稱（來自爬官網的資料），一律當純文字放，不能用 innerHTML。
  pillWarnTooltip.textContent = text;
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

const githubLinkIcon = document.getElementById("githubLinkIcon");
githubLinkIcon.addEventListener("click", () => trackEvent("click_github_icon", {}));

const adminLinkIcon = document.getElementById("adminLinkIcon");
adminLinkIcon.addEventListener("click", () => trackEvent("click_admin_icon", {}));

const copyUrlBtn = document.getElementById("copyUrlBtn");
copyUrlBtn.addEventListener("click", async (e) => {
  e.stopPropagation();
  try{
    await navigator.clipboard.writeText(location.origin + "/?utm_source=website_link&utm_medium=copy_link");
    showPillWarning(copyUrlBtn, "已複製網站網址到剪貼簿", "fa-solid fa-fw fa-clipboard-check");
    trackEvent("copy_site_url", {});
  } catch(err){
    console.error(err);
  }
});

// QR code 固定指向正式站網址（見 icons/qrcode.png，用 vendor/qrcode-generator.js 離線產生），
// 不再即時用 JS 產生：省掉一整包 56KB 的 QR 函式庫，換成一張幾 KB 的靜態圖。
// 點按鈕開關浮層、點浮層與按鈕以外的地方收起（QR code、隱私說明、通知說明共用）。
// wrapSelector 是按鈕與浮層共同的外層，點在裡面不算「點外面」；onOpen 在剛打開時呼叫。
function setupTogglePopover(btn, tooltip, wrapSelector, onOpen){
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    tooltip.classList.toggle("visible");
    if (onOpen && tooltip.classList.contains("visible")) onOpen();
  });
  document.addEventListener("click", (e) => {
    if (!tooltip.classList.contains("visible")) return;
    if (e.target.closest(wrapSelector)) return;
    tooltip.classList.remove("visible");
  });
}
setupTogglePopover(document.getElementById("qrCodeBtn"), document.getElementById("qrCodeTooltip"), "#qrCodeBtnWrap", () => trackEvent("open_qr_code", {}));

// 隱私說明：點擊切換顯示，內容講清楚只做匿名統計、資料來源是 World Gym 官網、本站非官方工具。
setupTogglePopover(document.getElementById("privacyBtn"), document.getElementById("privacyTooltip"), "#privacyBtnWrap");

// 通知說明：只在「還不是 PWA 模式」時顯示，讓使用者知道怎麼加入主畫面開啟通知；
// 已經是 PWA 模式（standalone）就不需要這顆按鈕了。點擊切換顯示提示文字。
const notifyInfoBtnWrap = document.getElementById("notifyInfoBtnWrap");
if (isStandaloneDisplay()) notifyInfoBtnWrap.classList.add("hidden");
setupTogglePopover(document.getElementById("notifyInfoBtn"), document.getElementById("notifyInfoTooltip"), "#notifyInfoBtnWrap");

// 某一組篩選（input 的 name）目前勾選的值。
function checkedValues(name){
  return Array.from(document.querySelectorAll(`input[name="${name}"]:checked`)).map(i => i.value);
}
// 星期／分店／課程／老師：勾選後記住選擇，下次打開頁面自動套用。
function saveSelection(key, names){
  const state = {};
  names.forEach(name => {
    state[name] = checkedValues(name);
  });
  writeStoredJson(key, state);
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
  const state = readStoredJson(key, null);
  if (!state) return;
  applyStateToInputs(state, names);
}
// 還原篩選勾選：網址帶了參數（分享連結）就用網址的，否則用上次存在 localStorage 的。
function restoreFilterGroups(urlState, names){
  if (urlState) applyStateToInputs(urlState, names);
  else names.forEach(name => applySavedSelection(`wg_selected_${name}`, [name]));
}
// 分享網址：把目前篩選條件編碼進網址 query string，讓別人打開網址時能直接重現同一個查詢結果。
// room 的值（"團體教室"/"飛輪教室"）中文字很長，網址上用短代碼 1/2 表示。
const ROOM_URL_CODE = { "團體教室": "1", "飛輪教室": "2" };
const ROOM_URL_DECODE = { "1": "團體教室", "2": "飛輪教室" };
function getUrlFilterState(){
  const params = new URLSearchParams(location.search);
  if ([...params.keys()].length === 0) return null;
  const state = {};
  FILTER_GROUPS.forEach(name => {
    let values = params.getAll(name);
    if (name === "room") values = values.map(v => ROOM_URL_DECODE[v] || v);
    // branch 的短代碼要等 initBranchGrid() 把 BRANCH_URL_DECODE 填好後才解得開，
    // 這裡先留原始代碼，實際解碼發生在 init() 裡呼叫完 initBranchGrid() 之後。
    if (values.length) state[name] = values;
  });
  return Object.keys(state).length ? state : null;
}
function buildShareUrl(state){
  const params = new URLSearchParams();
  FILTER_GROUPS.forEach(name => {
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
  const hasSelection = FILTER_GROUPS.filter(name => name !== "room").some(name =>
    document.querySelector(`input[name="${name}"]:checked`)
  );
  const btn = document.getElementById("resetFiltersBtn");
  btn.classList.toggle("gray-btn", !hasSelection);
  btn.classList.toggle("reset-active", hasSelection);
}
document.getElementById("dayGrid").addEventListener("change", () => { saveSelection("wg_selected_day", ["day"]); updateResetButtonState(); });
document.getElementById("timeGrid").addEventListener("change", () => { saveSelection("wg_selected_time", ["time"]); updateResetButtonState(); });

document.getElementById("roomGrid").addEventListener("change", () => { saveSelection("wg_selected_room", ["room"]); updateResetButtonState(); });
document.getElementById("branchGrid").addEventListener("change", (e) => {
  const input = e.target;
  if (input.matches('input[name="branch"]') && input.checked) incrementClickCount("wg_branch_clicks", input.value);
  updateSubmitState();
  saveSelection("wg_selected_branch", ["branch"]); updateResetButtonState();
});
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
  FILTER_GROUPS.forEach(name => {
    document.querySelectorAll(`input[name="${name}"]`).forEach(input => { input.checked = false; });
  });
  SELECTION_STORAGE_KEYS.forEach(removeStored);
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

function getFavorites(){
  return readStoredJson(FAVORITES_KEY, []);
}
function saveFavorites(favs){
  writeStoredJson(FAVORITES_KEY, favs);
}
function currentFilterState(){
  const state = {};
  FILTER_GROUPS.forEach(name => {
    state[name] = checkedValues(name);
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
// 這組篩選是不是已經在最愛裡：每組值排序後再比（同一組篩選，勾選的 DOM 順序會因老師排序而不同）。
// 只比篩選內容，不管名稱／圖示／顏色。
function filterStateKey(state){
  return FILTER_GROUPS.map(name => [...(state?.[name] || [])].sort().join("\u0000")).join("|");
}
function isCurrentStateFavorite(){
  const key = filterStateKey(currentFilterState());
  return getFavorites().some(fav => filterStateKey(fav.state) === key);
}
// 結果頁的愛心：這組篩選已經是最愛就變灰（aria-disabled 而不是 disabled，這樣按下去還能出提示說明為什麼不能加）。
// 顯示結果頁、新增／編輯／刪除最愛之後都要更新。
function updateFavoriteHeart(){
  const btn = document.getElementById("addFavoriteBtn");
  const already = isCurrentStateFavorite();
  btn.classList.toggle("gray-btn", already);
  btn.setAttribute("aria-disabled", already ? "true" : "false");
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
  "咕嚕咕嚕 🌀",
  "聽君一席話，如聽一席話 🧠",
];
function randomFunnyFavoriteLabel(){
  return FUNNY_DEFAULT_FAVORITE_LABELS[Math.floor(Math.random() * FUNNY_DEFAULT_FAVORITE_LABELS.length)];
}
function favoriteLabel(state){
  const branchLabels = (state.branch || []).map(branchSlugToName);
  if (branchLabels.length){
    const joined = branchLabels.join("、");
    return joined.length > 15 ? joined.slice(0, 15) + "…" : joined;
  }
  return randomFunnyFavoriteLabel();
}
const FAVORITE_EMPTY_HINT = '查詢後按結果頁下方的 <i class="fa-solid fa-heart"></i> 加入最愛，長按最愛可編輯。';
function applyFavorite(fav){
  applyFilterState(fav.state);
  SELECTION_STORAGE_KEYS.forEach(removeStored);
  FILTER_GROUPS.forEach(name => saveSelection(`wg_selected_${name}`, [name]));
  updateResetButtonState();
  trackEventOncePerSession("apply_favorite", fav.label, { favorite_label: fav.label });
  logFavoriteEvent("apply");
  searchTriggerSource = "favorite";
  document.getElementById("filterForm").requestSubmit(document.getElementById("scheduleSubmitBtn"));
}
// 長按最愛晶片（約 0.5 秒）開編輯視窗；短按照舊套用並查詢。手指移動超過一小段距離（在捲動）或提早放開就取消。
// 桌機右鍵、鍵盤的 Menu 鍵／Shift+F10 會觸發 contextmenu，也開編輯視窗。
const FAV_LONG_PRESS_MS = 500;
const FAV_PRESSING_FEEDBACK_MS = 250; // 按住這麼久才出現縮小的回饋，輕點時不閃
const FAV_LONG_PRESS_MOVE_PX = 10;
function bindFavoriteLongPress(btn, index, fav){
  let longPressed = false; // 這次按壓已經開了編輯視窗，放手時接著來的 click 不能再套用
  let timer = null;
  let feedbackTimer = null;
  let startX = 0;
  let startY = 0;
  const cancel = () => {
    clearTimeout(timer);
    clearTimeout(feedbackTimer);
    timer = null;
    btn.classList.remove("pressing");
  };
  btn.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "mouse" && e.button !== 0) return; // 滑鼠右鍵走 contextmenu
    // 第二根手指（雙指縮放等）不是長按：把進行中的取消掉就好。不這樣的話第二次 pointerdown 會蓋掉 timer 變數，
    // 第一根手指排的計時器就再也清不掉，放手後編輯視窗還是會跳出來。
    cancel();
    if (!e.isPrimary) return;
    longPressed = false;
    startX = e.clientX;
    startY = e.clientY;
    feedbackTimer = setTimeout(() => btn.classList.add("pressing"), FAV_PRESSING_FEEDBACK_MS);
    timer = setTimeout(() => {
      timer = null;
      longPressed = true;
      btn.classList.remove("pressing");
      openFavoriteEditor(index, fav, btn);
    }, FAV_LONG_PRESS_MS);
  });
  btn.addEventListener("pointermove", (e) => {
    if (timer && Math.hypot(e.clientX - startX, e.clientY - startY) > FAV_LONG_PRESS_MOVE_PX) cancel();
  });
  ["pointerup", "pointercancel", "pointerleave"].forEach(type => btn.addEventListener(type, cancel));
  btn.addEventListener("contextmenu", (e) => {
    e.preventDefault(); // 擋掉 Android／桌機的系統選單
    cancel();
    longPressed = true;
    openFavoriteEditor(index, fav, btn);
  });
  // 鍵盤按 Enter／空白鍵觸發的 click 沒有 pointerdown，要自己把殘留的旗標清掉，不然會被吃掉一次。
  btn.addEventListener("keydown", () => { longPressed = false; });
  btn.addEventListener("click", () => {
    if (longPressed){ longPressed = false; return; }
    applyFavorite(fav);
  });
}
function renderFavorites(){
  updateFavoriteHeart();
  const grid = document.getElementById("favoriteGrid");
  grid.querySelectorAll(".fav-item, .empty-hint").forEach(el => el.remove());
  const favs = getFavorites();
  if (favs.length === 0){
    grid.insertAdjacentHTML("beforeend", `<span class="empty-hint fav-empty-hint">${FAVORITE_EMPTY_HINT}</span>`);
    return;
  }
  favs.forEach((fav, index) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "fav-item";
    btn.style.background = fav.color || "#e8604c";
    btn.innerHTML = `<i class="fa-solid fa-${escapeHtml(fav.icon || "heart")}"></i>${escapeHtml(fav.label)}`;
    bindFavoriteLongPress(btn, index, fav);
    grid.appendChild(btn);
  });
  appendFavEditNotice(grid); // FAV_EDIT_NOTICE
}

const addFavoriteModal = document.getElementById("addFavoriteModal");
const favNameInput = document.getElementById("favNameInput");
const favNameClearBtn = document.getElementById("favNameClearBtn");
function syncFavNameClearBtn(){
  favNameClearBtn.classList.toggle("visible", favNameInput.value !== "");
}
// 新增與編輯共用 #addFavoriteModal：favEdit 是 null 就是新增模式，否則是編輯模式，內容是
// { target, chip, index, newIndex, total }：
//   target   開窗當下那顆最愛的內容。最愛沒有 id，位置在多個分頁同時開著時會對不上（別的分頁刪了前面一顆，
//            位置就整個前移），所以儲存／刪除前先用內容（sameFavorite）在最新的清單裡重新找，找不到就不動任何一顆；
//   chip     被長按的那顆晶片（刪除動畫要收合的就是它）；
//   index    開窗時 target 在清單裡的位置；newIndex 是視窗裡暫存的新順序，按儲存才生效，取消不動；total 是當時的總數。
// 編輯專用的控制項（順序列、刪除鈕、標題的鉛筆）只在編輯模式顯示。
let favEdit = null;
const favModalSubmitBtn = document.getElementById("favModalSubmitBtn");
function sameFavorite(a, b){
  return !!a && a.label === b.label && a.icon === b.icon && a.color === b.color
    && JSON.stringify(a.state) === JSON.stringify(b.state);
}
// 在目前的清單裡找 target：先看原本的位置，再找內容一樣的；找不到（被別的分頁改掉或刪掉）回 -1。
function findFavoriteIndex(favs, target, hintIndex){
  if (sameFavorite(favs[hintIndex], target)) return hintIndex;
  return favs.findIndex(f => sameFavorite(f, target));
}
const favModalTag = document.getElementById("favModalTag");
const favModalTagIcon = document.getElementById("favModalTagIcon");
const favOrderRow = document.getElementById("favOrderRow");
const favMoveEarlierBtn = document.getElementById("favMoveEarlierBtn");
const favMoveLaterBtn = document.getElementById("favMoveLaterBtn");
const favOrderText = document.getElementById("favOrderText");
const favDeleteBtn = document.getElementById("favDeleteBtn");
function configureFavoriteModal(){
  const editing = favEdit !== null;
  favModalTag.setAttribute("aria-label", editing ? "編輯最愛" : "新增最愛");
  favModalTagIcon.classList.toggle("fa-pen", editing);
  favModalTagIcon.classList.toggle("fa-plus", !editing);
  favDeleteBtn.classList.toggle("hidden", !editing);
  favOrderRow.classList.toggle("hidden", !editing || favEdit.total < 2);
  if (editing) updateFavOrderControls();
}
function updateFavOrderControls(){
  favOrderText.textContent = `第 ${favEdit.newIndex + 1} / ${favEdit.total}`;
  favMoveEarlierBtn.disabled = favEdit.newIndex <= 0;
  favMoveLaterBtn.disabled = favEdit.newIndex >= favEdit.total - 1;
}
function closeFavoriteModal(){
  addFavoriteModal.classList.add("hidden");
  favEdit = null;
}
// 預填圖示／顏色：值來自 localStorage，不一定在預設選項裡（舊資料、自己用 devtools 改過的自訂圖示／顏色）。
// 對不到就把整組取消勾選：畫面上沒有選取，儲存時沿用原值（checkedFavoriteValue 的 fallback），
// 不會被上一次勾選的選項偷偷蓋掉。
function checkFavoriteRadio(name, value){
  const inputs = [...document.querySelectorAll(`input[name="${name}"]`)];
  const match = inputs.find(el => el.value === value);
  inputs.forEach(el => { el.checked = el === match; });
}
function checkedFavoriteValue(name, fallback){
  return checkedValues(name)[0] ?? fallback;
}
// 新增模式一定要有選取：上一次編輯自訂圖示／顏色的最愛會留下「整組沒選」，補回每組的第一個。
function ensureFavoriteRadioDefaults(){
  ["favIcon", "favColor"].forEach(name => {
    if (checkedValues(name).length === 0) document.querySelector(`input[name="${name}"]`).checked = true;
  });
}
// 編輯模式：名稱／圖示／顏色／順序都跟開窗時一樣就不能儲存（沒東西好存）；新增模式永遠可以。
function favFormChanged(){
  if (!favEdit) return true;
  const { target } = favEdit;
  return favNameInput.value.trim() !== target.label
    || checkedFavoriteValue("favIcon", target.icon) !== target.icon
    || checkedFavoriteValue("favColor", target.color) !== target.color
    || favEdit.newIndex !== favEdit.index;
}
function syncFavSubmitState(){
  favModalSubmitBtn.disabled = !favFormChanged();
}
// 名稱欄的狀態同時影響清除鈕與儲存鈕，開窗、輸入、骰子、清除都走這個。
function syncFavNameField(){
  syncFavNameClearBtn();
  syncFavSubmitState();
}
function openFavoriteEditor(index, fav, chip){
  if (!addFavoriteModal.classList.contains("hidden")) return; // 長按與 contextmenu 可能先後觸發，已經開著就不重複開
  const favs = getFavorites();
  const resolved = findFavoriteIndex(favs, fav, index);
  if (resolved === -1){ renderFavorites(); return; } // 晶片是舊的（別的分頁改過清單）：重畫成最新的，不開視窗
  const target = favs[resolved];
  favEdit = { target, chip, index: resolved, newIndex: resolved, total: favs.length };
  checkFavoriteRadio("favIcon", target.icon);
  checkFavoriteRadio("favColor", target.color);
  favNameInput.value = target.label;
  configureFavoriteModal();
  syncFavNameField();
  markFavEditHintSeen(); // 都會開編輯視窗了，已經知道這個功能，以後不用再提示
  removeFavEditNotice(); // FAV_EDIT_NOTICE
  addFavoriteModal.classList.remove("hidden");
}
document.getElementById("addFavoriteBtn").addEventListener("click", (e) => {
  if (isCurrentStateFavorite()){
    showPillWarning(e.currentTarget, "這組篩選已經是最愛了", "fa-solid fa-heart");
    return;
  }
  favEdit = null;
  configureFavoriteModal();
  ensureFavoriteRadioDefaults();
  favNameInput.value = favoriteLabel(currentFilterState());
  syncFavNameField();
  addFavoriteModal.classList.remove("hidden");
});
// 順序往前／往後移一格；到頭尾時按鈕是 disabled（updateFavOrderControls），點不到，不用再擋。
function moveFavEditOrder(delta){
  favEdit.newIndex += delta;
  updateFavOrderControls();
  syncFavSubmitState();
}
favMoveEarlierBtn.addEventListener("click", () => moveFavEditOrder(-1));
favMoveLaterBtn.addEventListener("click", () => moveFavEditOrder(1));
addFavoriteModal.addEventListener("change", syncFavSubmitState); // 圖示／顏色 radio
// 在最新的清單裡找出正在編輯的那一顆；找不到（開著視窗時被別的分頁改掉或刪掉）就關窗、重畫成最新的，回 -1，不動別顆。
function resolveFavEditIndex(favs){
  const current = findFavoriteIndex(favs, favEdit.target, favEdit.index);
  if (current === -1){ closeFavoriteModal(); renderFavorites(); }
  return current;
}
// 使用者有沒有設「減少動態效果」：有的話，動畫要跳過、直接做最後的狀態。
function prefersReducedMotion(){
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}
// 等 el「自己」的 CSS 動畫結束就呼叫 done（只呼叫一次）：子元素的動畫結束事件會冒泡上來，那個不算；
// animationend 沒來（分頁在背景等）時，fallbackMs 之後照樣呼叫，fallbackMs 只要比動畫長就好。
// 兩條路誰先到誰收尾，另一條一併取消。
function whenAnimationDone(el, fallbackMs, done){
  const finish = () => {
    clearTimeout(timer);
    el.removeEventListener("animationend", onEnd);
    done();
  };
  const onEnd = (e) => { if (e.target === el) finish(); };
  const timer = setTimeout(finish, fallbackMs);
  el.addEventListener("animationend", onEnd);
}
// 晶片收合消失：套 .removing 動畫（style.css 的 fav-remove），結束後呼叫 done（只呼叫一次）。
// 資料都在動畫開始前就處理好了，動畫只是視覺；使用者設了「減少動態效果」就直接 done。
const FAV_REMOVE_START_DELAY_MS = 180; // 刪除：等編輯視窗淡出（.2s）完，不然動畫被灰幕蓋住
const FAV_COLLAPSE_FALLBACK_MS = 1000; // 比 fav-remove 的 .3 秒長就好
function collapseChip(chip, done){
  if (prefersReducedMotion()){ done(); return; }
  chip.style.setProperty("--fav-w", `${chip.offsetWidth}px`); // 寬度收合動畫的起點，要先量好
  chip.classList.add("removing");
  whenAnimationDone(chip, FAV_COLLAPSE_FALLBACK_MS, done);
}
// 按垃圾桶就直接刪，沒有二次確認（使用者決定）。
favDeleteBtn.addEventListener("click", () => {
  if (!favEdit) return;
  const favs = getFavorites();
  const current = resolveFavEditIndex(favs);
  if (current === -1) return;
  const [removed] = favs.splice(current, 1);
  saveFavorites(favs);
  trackEvent("delete_favorite", { favorite_label: removed.label });
  const { chip } = favEdit;
  closeFavoriteModal();
  setTimeout(() => (chip.isConnected ? collapseChip(chip, renderFavorites) : renderFavorites()), FAV_REMOVE_START_DELAY_MS);
});
favNameInput.addEventListener("input", syncFavNameField);
document.getElementById("favNameRandomBtn").addEventListener("click", () => {
  favNameInput.value = randomFunnyFavoriteLabel();
  syncFavNameField();
});
favNameClearBtn.addEventListener("click", () => {
  favNameInput.value = "";
  syncFavNameField();
  favNameInput.focus();
});
document.getElementById("favModalCloseBtn").addEventListener("click", closeFavoriteModal);
// 長按才開得了編輯視窗、沒有可見提示，所以靠下面的彩虹提示 pill（FAV_EDIT_NOTICE）提醒。
// 「已經知道長按可以編輯」的記號：看過提示 pill、點掉它、或真的開過編輯視窗，就不再提示。
const FAV_EDIT_HINT_KEY = "wg_fav_edit_hint_seen";
function markFavEditHintSeen(){
  writeStored(FAV_EDIT_HINT_KEY, "1");
}
favModalSubmitBtn.addEventListener("click", () => {
  const typedName = favNameInput.value.trim();
  const favs = getFavorites();
  if (!favEdit){
    const icon = checkedValues("favIcon")[0]; // 新增模式的兩組 radio 一定有選取（ensureFavoriteRadioDefaults）
    const color = checkedValues("favColor")[0];
    const name = typedName || favoriteLabel(currentFilterState());
    favs.push({ label: name, icon, color, state: currentFilterState() });
    saveFavorites(favs);
    trackEvent("add_favorite", { favorite_label: name });
    logFavoriteEvent("add");
    // 還沒看過「長按可編輯」的人，renderFavorites 會接一顆提示 pill（FAV_EDIT_NOTICE）；最愛區塊此刻是隱藏的，回篩選頁才看得到。
    renderFavorites();
    closeFavoriteModal();
    return;
  }
  const current = resolveFavEditIndex(favs);
  if (current === -1) return;
  const old = favs[current];
  const name = typedName || favoriteLabel(old.state || {});
  const icon = checkedFavoriteValue("favIcon", old.icon); // 自訂圖示／顏色沒被改就沿用原值
  const color = checkedFavoriteValue("favColor", old.color);
  // 只改名稱／圖示／顏色，state（篩選條件）原封不動；先拿掉、再插到新順序的位置。
  // 沒調順序就留在目前的位置（別的分頁在前面增減過的話，開窗時的位置已經不準，不能拿來插回去）。
  const insertAt = favEdit.newIndex === favEdit.index ? current : favEdit.newIndex;
  favs.splice(current, 1);
  favs.splice(insertAt, 0, { ...old, label: name, icon, color });
  saveFavorites(favs);
  trackEvent("edit_favorite", { favorite_label: name });
  renderFavorites();
  closeFavoriteModal();
});

// FAV_EDIT_NOTICE：給還沒看過「長按可編輯」的人的一次性提示 pill（第一次新增最愛的人、以及編輯功能上線前就有最愛的舊使用者），
// 長得像最愛晶片、接在所有最愛後面，用會流動的彩虹底色。有最愛、而且還沒記為看過就會出現；
// 「看過」的定義是 pill 完整出現在畫面上連續滿 FAV_EDIT_NOTICE_SEEN_MS（載入遮罩還在、分頁在背景、最愛列被藏起來
// ——例如分享連結直接顯示查詢結果——都不算），滿了才寫記號，所以下一次載入就不再出現；點一下則收合並立刻記為看過。
// 本來是 2026-11-01 就下線的暫時提示，2026-10-29 使用者決定改成永久、給第一次新增最愛的人用。
const FAV_EDIT_NOTICE_SEEN_MS = 2000;
const FAV_EDIT_NOTICE_TICK_MS = 500;
const FAV_EDIT_NOTICE_MAX_TICKS = 600; // 一直沒看到（例如停在查詢結果頁）時 5 分鐘後就不再偵測；沒記為看過，下次載入頁面會重新偵測
function removeFavEditNotice(){
  document.querySelector("#favoriteGrid .fav-edit-notice")?.remove();
}
// 整顆 pill 都在畫面內：沒被藏起來、載入遮罩已經消失、分頁在前景。
function isFavEditNoticeOnScreen(el){
  if (document.hidden || document.getElementById("loadingOverlay")) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 && r.top >= 0 && r.left >= 0
    && r.bottom <= window.innerHeight && r.right <= window.innerWidth;
}
function watchFavEditNoticeSeen(el){
  let visibleMs = 0;
  let ticks = 0;
  const timer = setInterval(() => {
    if (!el.isConnected || ++ticks > FAV_EDIT_NOTICE_MAX_TICKS){ clearInterval(timer); return; }
    if (!isFavEditNoticeOnScreen(el)){ visibleMs = 0; return; } // 要連續滿 2 秒，中途離開畫面就重算
    visibleMs += FAV_EDIT_NOTICE_TICK_MS;
    if (visibleMs < FAV_EDIT_NOTICE_SEEN_MS) return;
    clearInterval(timer);
    markFavEditHintSeen();
    trackEvent("fav_edit_notice_shown", {});
  }, FAV_EDIT_NOTICE_TICK_MS);
}
function appendFavEditNotice(grid){
  if (readStored(FAV_EDIT_HINT_KEY) === "1") return; // 已經知道長按可以編輯了
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "fav-item fav-edit-notice";
  btn.innerHTML = '<i class="fa-solid fa-wand-magic-sparkles"></i>長按最愛可以編輯';
  btn.addEventListener("click", () => {
    markFavEditHintSeen();
    trackEvent("fav_edit_notice_dismiss", {});
    btn.disabled = true; // 收合動畫期間不要再被點
    collapseChip(btn, () => btn.remove());
  });
  grid.appendChild(btn);
  watchFavEditNoticeSeen(btn);
}

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
// 「篩選記憶」＝勾選條件、常用排序（點擊次數）、分店地區展開狀態；新增這類記憶的 key 要加進來。
// 其餘（wg_client_id、提醒分鐘、wg_theme 主題偏好、各種旗標）不清：清掉 wg_client_id 會讓同一個人在最愛統計裡變成新使用者。
const FILTER_MEMORY_KEYS = [
  ...SELECTION_STORAGE_KEYS,
  "wg_branch_clicks", "wg_course_clicks", "wg_teacher_clicks",
  "wg_zone_states",
];
// 兩顆按鈕按了就清，沒有第二次確認（這個視窗本身就是確認）。
document.getElementById("clearFiltersMemoryBtn").addEventListener("click", () => {
  trackEvent("clear_memory", { memory_type: "filters" });
  FILTER_MEMORY_KEYS.forEach(removeStored);
  location.reload(); // 排序與展開狀態是載入時套用的，重新整理最簡單
});
document.getElementById("clearFavoritesBtn").addEventListener("click", () => {
  trackEvent("clear_memory", { memory_type: "favorites" });
  removeStored(FAVORITES_KEY);
  clearMemoryModal.classList.add("hidden");
  renderFavorites();
});

// 淺色／深色切換（頁尾的按鈕）：預設淺色、不跟隨系統設定；選深色才在 localStorage 留下 wg_theme=dark，換回淺色就清掉。
// 開頁時由 theme-init.js 在 <head> 先把 data-theme 貼到 <html>（趕在第一次繪製前，才不會先閃白），這裡只負責按鈕與切換。
const THEME_STORAGE_KEY = "wg_theme";
const themeToggleBtn = document.getElementById("themeToggleBtn");
function isDarkTheme(){
  return document.documentElement.getAttribute("data-theme") === "dark";
}
function renderThemeToggle(){
  const dark = isDarkTheme();
  themeToggleBtn.innerHTML = dark
    ? '<i class="fa-solid fa-fw fa-sun"></i>淺色模式'
    : '<i class="fa-solid fa-fw fa-moon"></i>深色模式';
  themeToggleBtn.setAttribute("aria-label", dark ? "切換為淺色模式" : "切換為深色模式");
}
let themeSwitchTimer = null;
themeToggleBtn.addEventListener("click", () => {
  const next = isDarkTheme() ? "light" : "dark";
  // 先加 theme-switching（style.css：全站顏色淡入淡出），過場跑完再拿掉，平常的 hover／選取不受影響。
  document.documentElement.classList.add("theme-switching");
  clearTimeout(themeSwitchTimer);
  themeSwitchTimer = setTimeout(() => document.documentElement.classList.remove("theme-switching"), 400);
  if (next === "dark"){
    document.documentElement.setAttribute("data-theme", "dark");
    writeStored(THEME_STORAGE_KEY, "dark");
  } else {
    document.documentElement.removeAttribute("data-theme");
    removeStored(THEME_STORAGE_KEY);
  }
  renderThemeToggle();
  retintCharts();
  trackEvent("toggle_theme", { theme: next });
});
renderThemeToggle();

// 頁面載入時課程/老師清單抓取失敗（伺服器或資料庫異常）跳出的提示 modal。
const serviceErrorModal = document.getElementById("serviceErrorModal");
function showServiceErrorModal(){
  serviceErrorModal.classList.remove("hidden");
}
document.getElementById("serviceErrorOkBtn").addEventListener("click", () => {
  serviceErrorModal.classList.add("hidden");
});

// 課表通知：按灰色鈴鐺彈出的 modal，選課前 30/60/90 分鐘；還沒授權通知時多一句權限說明
// （權限被封鎖時只剩說明、不顯示選項，因為怎麼選都登記不了）。
const notifyPermissionModal = document.getElementById("notifyPermissionModal");
const notifyPermissionText = document.getElementById("notifyPermissionText");
const NOTIFY_PERMISSION_TEXT_NORMAL = "需要允許通知權限。";
const NOTIFY_PERMISSION_TEXT_BLOCKED = "通知權限已被封鎖，<br>請至裝置設定手動開啟通知權限。";
function openReminderModal(bell){
  pendingReminderBell = bell;
  const permission = Notification.permission;
  document.getElementById("remindLeadField").classList.toggle("hidden", permission === "denied");
  document.getElementById(`remindLead-${readRemindMinutes()}`).checked = true;
  notifyPermissionText.innerHTML = permission === "denied" ? NOTIFY_PERMISSION_TEXT_BLOCKED : NOTIFY_PERMISSION_TEXT_NORMAL;
  notifyPermissionText.classList.toggle("hidden", permission === "granted");
  notifyPermissionModal.classList.remove("hidden");
  if (permission !== "granted") trackEvent("notify_permission_prompt", {});
}
function closeNotifyPermissionModal(){
  notifyPermissionModal.classList.add("hidden");
  pendingReminderBell = null;
}
document.getElementById("notifyPermissionCancelBtn").addEventListener("click", closeNotifyPermissionModal);
document.getElementById("notifyPermissionCloseBtn").addEventListener("click", closeNotifyPermissionModal);
document.getElementById("notifyPermissionConfirmBtn").addEventListener("click", async () => {
  const bell = pendingReminderBell;
  const remindMinutes = parseInt(document.querySelector('input[name="remindLead"]:checked').value, 10);
  notifyPermissionModal.classList.add("hidden");
  pendingReminderBell = null;
  if (!bell) return;
  if (Notification.permission === "denied"){
    trackEvent("notify_permission_blocked_retry", {});
    return;
  }
  if (Notification.permission !== "granted"){
    const perm = await Notification.requestPermission();
    trackEvent("notify_permission_result", { result: perm });
    if (perm !== "granted") return;
  }
  writeStored(REMIND_MINUTES_KEY, String(remindMinutes));
  await registerReminderForBell(bell, remindMinutes);
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

// 分店的縣市 -> World Gym 官方六大分區（分區展開/收合、分區全選按鈕在用）。
const ZONE_MAP = {
  "台北": "台北區", "新北": "台北區", "基隆": "台北區", "宜蘭": "台北區", "花蓮": "台北區",
  "桃園": "桃園區",
  "新竹": "新竹區", "苗栗": "新竹區",
  "台中": "台中區", "彰化": "台中區", "南投": "台中區", "雲林": "台中區",
  "台南": "台南區", "嘉義": "台南區",
  "高雄": "高屏區", "屏東": "高屏區",
};

function distanceKm(lat1, lng1, lat2, lng2){
  const R = 6371;
  const toRad = deg => deg * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.asin(Math.sqrt(a));
}

// 同頁查詢結果：按查詢後不換頁，改成隱藏篩選 pill、顯示結果，按返回再換回來。
const WEEKDAY_LABEL = { today: "今天", tomorrow: "明天", 1: "一", 2: "二", 3: "三", 4: "四", 5: "五", 6: "六", 7: "日" };

// 分店 slug → 畫面上看到的分店名稱（找不到就回 slug）。記錄查詢次數（admin 的長條圖才看得懂）、
// 篩選摘要、最愛的預設名稱都用這一個。
function branchSlugToName(slug){
  return BRANCH_NAMES.get(slug) ?? slug;
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
      // 分店名稱裡，有 Google Maps 連結（index.html 分店 pill 的 data-map-url）的就顯示成可點的藍字，沒有的維持一般文字。
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

// 爬蟲排程每天 03:00/17:00（台灣時間）各跑一次，30 小時等於「今天兩次都沒跑成功」才會示警。
const STALE_DATA_THRESHOLD_HOURS = 30;
function appendStaleNoticeTag(box, oldestScrapedAt){
  if (!oldestScrapedAt) return;
  const ageHours = (Date.now() - new Date(oldestScrapedAt).getTime()) / 3600000;
  if (ageHours <= STALE_DATA_THRESHOLD_HOURS) return;
  // oldestScrapedAt 格式固定為 nowTaiwanIso() 產生的 "YYYY-MM-DDTHH:mm:ss.sss+08:00"，
  // 直接切字串取值，不透過 Date 的 getMonth/getHours（那些回傳裝置當地時區，不是台灣時間）。
  const [datePart, timePart] = oldestScrapedAt.split("T");
  const [, mm, dd] = datePart.split("-");
  const [hh, min] = timePart.split(":");
  const tag = document.createElement("span");
  tag.className = "active-filter-tag";
  tag.innerHTML = `<i class="fa-solid fa-triangle-exclamation"></i>資料更新 ${mm}/${dd} ${hh}:${min}`;
  box.appendChild(tag);
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

// 查課表：前端只送目前勾選的篩選條件，D1 查詢＋所有篩選＋去重都在後端
// （worker/src/queryClasses.js）做完，這裡只拿最終要顯示的 rows 來渲染。
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
  // 回傳格式：{ rows, fetchedCount, displayedCount, oldestScrapedAt }
}

// 查詢結果的記憶體快取：同一組條件在 QUERY_CACHE_TTL_MS 內重複查（查詢→返回→再查、點最愛、點老師名字…）
// 直接用上一次的結果，不再打 /queryClasses，也不會用掉每分鐘 20 次的限流額度。
// 只存在這個頁面的 JS 記憶體，不寫 localStorage：重新整理、關掉 PWA 就清空；隔了一段時間再回來
// （即使 localStorage 還原了同一組篩選，不是在來回查詢）超過存活時間，也會真的重新跟伺服器要資料。
// 課表一天只更新兩次（台灣時間 03:00/17:00），5 分鐘內重複查詢看到的資料不會比伺服器舊多少。
const QUERY_CACHE_TTL_MS = 5 * 60 * 1000; // 從「抓回來」那一刻起算，不會因為一直命中而延長
const QUERY_CACHE_MAX_ENTRIES = 20;
const queryResultCache = new Map(); // key → { at, result }；Map 依插入順序，最舊的排最前面
// key 含台灣今天的日期：跨日後「今天起 7 天」的視窗會變，不能沿用前一天的結果。
// 陣列欄位排序後再比對：查詢條件是集合，勾選順序不同不該算不同條件。
function queryCacheKey(queryState){
  const normalized = Object.fromEntries(Object.keys(queryState).sort().map((k) => [k, Array.isArray(queryState[k]) ? [...queryState[k]].sort() : queryState[k]]));
  return JSON.stringify([todayIso(), normalized]);
}
async function runScheduleQueryCached(queryState){
  const key = queryCacheKey(queryState);
  const hit = queryResultCache.get(key);
  if (hit && Date.now() - hit.at < QUERY_CACHE_TTL_MS) return hit.result;
  queryResultCache.delete(key); // 過期的順便移掉（沒有就什麼都不做）
  const result = await runScheduleQuery(queryState); // 失敗（逾時、限流、伺服器錯誤）會直接丟出去，不會被存起來
  // 超過上限的結果前端不會顯示（只提示「結果太多」），不存，避免佔記憶體
  if (result.displayedCount <= RESULT_COUNT_WARN_LIMIT){
    queryResultCache.set(key, { at: Date.now(), result });
    while (queryResultCache.size > QUERY_CACHE_MAX_ENTRIES) queryResultCache.delete(queryResultCache.keys().next().value);
  }
  return result;
}

let lastResultRows = [];
let TEACHER_NAMES = [];
function renderTeacherGrid(){
  const checked = new Set(checkedValues("teacher"));
  renderGrid("teacherGrid", "teacher", sortByClickCount(TEACHER_NAMES, "wg_teacher_clicks").map(n => ({ value: n, label: n, checked: checked.has(n) })));
}
// 從結果頁按「返回」時只需要依最新點擊次數重新排序既有的老師 pill，不用整個砍掉重建 DOM
// （這裡曾經每次都呼叫 renderTeacherGrid() 整個重建，Cloudflare Web Analytics 抓到 #backBtn 的
// INP 卡在 250ms 左右、#mainFormSheet 也跟著有 CLS，兩個問題都是同一個重建動作造成的）。
function reorderTeacherGrid(){
  reorderPillsByClicks(document.getElementById("teacherGrid"), "wg_teacher_clicks");
}
// 縮課日：國定假日（含補假）當天，分店改用假日課表，開課時間大多落在整點或 30 分（平常的平日是每堂隔 10 分鐘，
// 例如 08:40、09:50）。官方資料沒有任何標記，開課時間也不是可靠的條件（10/26 實測有 16 間分店、33 堂課
// 在 :10／:20／:40／:50 開始，例如長春 09:40 的瑜伽球，但整天仍是假日課表），所以只靠人工維護的日期：
// 那天所有分店的所有課都算縮課。連假裡的週六日若也縮課（使用者確認），要一起列進來，才會跟著標紅。
// 每次有新的補假就把日期加進來；過期的日期留著無害，不用刪。
const REDUCED_SCHEDULE_DATES = new Set([
  "2026-10-24", "2026-10-25", "2026-10-26", // 光復節連假（週六、週日、補假週一）
]);
function isReducedScheduleClass(c){
  return REDUCED_SCHEDULE_DATES.has(c.date);
}
function renderScheduleResults(rows, onlyTeacher){
  const area = document.getElementById("resultArea");
  lastResultRows = rows;
  if (rows.length === 0){
    area.innerHTML = '<div class="empty-hint">沒有符合條件的課程，換個篩選條件試試看。</div>';
    return;
  }
  area.innerHTML = "";
  const pwaInstalled = isPWAInstalled();
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
    content.appendChild(document.createTextNode(`${c.branchName} `));
    const weekdayText = `週${WEEKDAY_LABEL[c.dayOfWeek]}`;
    if (isReducedScheduleClass(c)){
      const weekday = document.createElement("span");
      weekday.className = "result-reduced-weekday"; // 縮課日的課：星期兩個字變紅
      weekday.textContent = weekdayText;
      content.appendChild(weekday);
    } else {
      content.appendChild(document.createTextNode(weekdayText));
    }
    content.appendChild(document.createTextNode(` ${c.startTime.replace(":", "")} ${c.className} `));
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
    if (pwaInstalled){
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
      setResultRowNotifyLine(bell, existing);
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
  // applyFilterState 會把「所有」篩選組重設成只剩這位老師，所以每一組都要存，不然沒存的組（時間、教室）
  // 重新整理後會從舊的儲存值還原，跟畫面當時的篩選對不上。
  FILTER_GROUPS.forEach(name => saveSelection(`wg_selected_${name}`, [name]));
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
  setHidden(["filterForm", "favoriteSheet", "mailDisclaimerSheet", "quickLinksSheet"], true);
  fadeInView(document.getElementById("resultView"));
  setCopyMenuOpen(false); // 上一次離開時選單可能還開著
  updateFavoriteHeart();
  setHidden(["backBtnWrap"], false);
  window.scrollTo({ top: 0, behavior: "smooth" });
}
// 把這些 id 的元素一次顯示（hidden=false）或隱藏（hidden=true），各個畫面（篩選、結果、通知）切換時用。
function setHidden(ids, hidden){
  ids.forEach(id => document.getElementById(id).classList.toggle("hidden", hidden));
}
function fadeInView(el){
  el.classList.remove("hidden");
  el.classList.add("view-fade-in");
  void el.offsetHeight; // 強制 reflow，讓 opacity:0 先套用再拿掉 class 觸發 transition
  el.classList.remove("view-fade-in");
}
function showMailView(){
  trackEvent("open_reminder_list", {});
  setHidden(["mainFormSheet", "favoriteSheet"], true);
  fadeInView(document.getElementById("reminderView"));
  fadeInView(document.getElementById("mailView"));
  setHidden(["searchTrendSheet", "branchStatsSheet", "courseStatsSheet", "teacherStatsSheet", "mailDisclaimerSheet", "quickLinksSheet", "mailBackBtnWrap"], false);
  document.getElementById("mailContent").disabled = false;
  setHidden(["mailSentOverlay"], true);
  document.getElementById("mailSendBtn").disabled = false;
  renderReminderList();
  window.scrollTo({ top: 0, behavior: "smooth" });
}
function showFilterView(){
  setHidden(["resultView", "backBtnWrap", "reminderView", "mailView", "searchTrendSheet", "branchStatsSheet", "courseStatsSheet", "teacherStatsSheet", "mailDisclaimerSheet", "quickLinksSheet", "mailBackBtnWrap"], true);
  document.getElementById("mailContent").value = "";
  document.getElementById("mailContent").disabled = false;
  setHidden(["mailSentOverlay"], true);
  document.getElementById("mailSendBtn").disabled = false;
  // reorderTeacherGrid() 用 appendChild 重排 #teacherGrid 裡寬度不一的 pill（flex-wrap），
  // 排序結果會改變換行位置、進而改變 grid 高度；一定要趁 mainFormSheet 還是 display:none
  // 時排完，翻牌後才不會又造成一次 Cloudflare Web Analytics 抓到的 #mainFormSheet CLS。
  reorderTeacherGrid();
  // favoriteSheet 在 DOM 順序上排在 mainFormSheet 前面，
  // 要先讓它們恢復顯示、版面高度定案，mainFormSheet 才不會在自己淡入之後又被
  // 前面冒出來的 favoriteSheet 推擠位置，造成 Cloudflare Web Analytics 抓到的
  // #mainFormSheet CLS（mainFormSheet 本身沒有淡入效果，CSS 只對 filterForm 那層
  // 做 opacity 動畫，所以這裡直接切 hidden 就好，不用呼叫 fadeInView 多強制一次 reflow）。
  setHidden(["favoriteSheet", "mainFormSheet"], false);
  fadeInView(document.getElementById("filterForm"));
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
    const res = await postJson("/sendMessageToAuthor", { content });
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
  // 送給後端查詢時才 resolve：明確星期幾送 day（1-7 數字），"今天"/"明天" 送 exactDates（實際日期）。
  const queryState = resolveQueryState(state);
  try{
    const { rows, displayedCount, oldestScrapedAt } = await runScheduleQueryCached(queryState);
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
        logSearchEvents(state.teacher, state.course, (state.branch || []).map(branchSlugToName));
      }
      showResultView();
      history.replaceState(null, "", buildShareUrl(state));
      renderActiveFilters(state);
      appendStaleNoticeTag(document.getElementById("activeFiltersBox"), oldestScrapedAt);
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
// 同一個篩選條件連續手動查詢滿 5 次就跳 modal 提醒 30 分鐘去重規則，避免使用者一直查/返回白耗 D1 讀取量。
const repeatQueryModal = document.getElementById("repeatQueryModal");
function showRepeatQueryModal(){
  repeatQueryModal.classList.remove("hidden");
}
document.getElementById("repeatQueryOkBtn").addEventListener("click", () => {
  repeatQueryModal.classList.add("hidden");
});
const REPEAT_QUERY_MODAL_THRESHOLD = 5;
let lastManualQueryKey = null;
let sameFilterQueryStreak = 0;

document.getElementById("filterForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!isSearchValid()){
    showPillWarning(document.getElementById("scheduleSubmitBtn"), "請先選擇一些分店或老師");
    return;
  }
  searchTriggerSource = "manual";
  const state = currentFilterState();
  const filterKey = JSON.stringify(state);
  if (filterKey === lastManualQueryKey){
    sameFilterQueryStreak++;
  } else {
    lastManualQueryKey = filterKey;
    sameFilterQueryStreak = 1;
  }
  if (sameFilterQueryStreak >= REPEAT_QUERY_MODAL_THRESHOLD){
    sameFilterQueryStreak = 0;
    showRepeatQueryModal();
  }
  await runSearchAndShowResults(state);
});
document.getElementById("backBtn").addEventListener("click", showFilterView);

// 複製文字到剪貼簿，成功/失敗都在按鈕上方顯示提示。
function copyTextWithToast(text, btn, successMessage){
  navigator.clipboard.writeText(text)
    .then(() => showPillWarning(btn, successMessage))
    .catch(() => showPillWarning(btn, "複製失敗，請手動選取"));
}
function formatResultBody({ c }){
  return `${c.branchName} 週${WEEKDAY_LABEL[c.dayOfWeek]} ${c.startTime} ${c.className} ${c.teacherName}`;
}
function formatResultLine(row){
  const prefix = row.flagged ? `⚠ ${row.c.date.slice(5).replace("-", "/")} ` : "";
  return prefix + formatResultBody(row);
}
// 結果頁底部右邊的複製鈕：點開往上長出「複製文字」「複製連結」兩顆純圖示按鈕（style.css 的 .copy-menu）。
// 點選單以外的地方、按 Esc、選了其中一個都會收起來；提示掛在主鈕上，因為選項收起後就看不到了。
const copyMenu = document.getElementById("copyMenu");
const copyMenuBtn = document.getElementById("copyMenuBtn");
function setCopyMenuOpen(open){
  if (copyMenu.classList.contains("open") === open) return;
  copyMenu.classList.toggle("open", open);
  copyMenuBtn.setAttribute("aria-expanded", String(open));
  copyMenuBtn.setAttribute("aria-label", open ? "收起" : "複製或分享");
  copyMenuBtn.querySelector("i").className = open ? "fa-solid fa-xmark" : "fa-solid fa-share-nodes";
  if (open) trackEvent("open_copy_menu", {});
}
copyMenuBtn.addEventListener("click", () => setCopyMenuOpen(!copyMenu.classList.contains("open")));
document.addEventListener("click", (e) => {
  if (!copyMenu.contains(e.target)) setCopyMenuOpen(false);
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") setCopyMenuOpen(false);
});
document.getElementById("copyResultsBtn").addEventListener("click", () => {
  const text = lastResultRows.map(formatResultLine).join("\n");
  trackEvent("copy_results", { result_count: lastResultRows.length });
  setCopyMenuOpen(false);
  copyTextWithToast(text, copyMenuBtn, "已複製課程文字到剪貼簿");
});
document.getElementById("shareUrlBtn").addEventListener("click", () => {
  trackEvent("share_url", {});
  setCopyMenuOpen(false);
  copyTextWithToast(location.href, copyMenuBtn, "已複製網址到剪貼簿");
});

async function init(){
  // 已登記的通知（已裝 PWA 且已授權通知才會真的打 API）只有「畫查詢結果的鈴鐺」要用，不必擋在最前面：
  // 這裡先讓它在背景跑，跟 /filterOptions、token 預熱同時進行，到要查詢結果、收掉載入遮罩之前才等它（見 finally）。
  // 它內部自己 try/catch，不會 reject。
  const preloadRemindersPromise = preloadRegisteredReminders();
  const urlState = getUrlFilterState();
  // 星期/時段/教室類型的選項是固定的，已經寫死在 index.html（同分店清單那次的做法），
  // 不用再用 JS 重新產生 pill，避免頁面剛載入、JS 還沒跑完時 fieldset 是空的造成 CLS。
  restoreFilterGroups(urlState, ["day"]);
  restoreFilterGroups(urlState, ["time"]);

  if (urlState) applyStateToInputs(urlState, ["room"]);
  else if (readStored("wg_selected_room")) applySavedSelection("wg_selected_room", ["room"]);
  else {
    const defaultRoomInput = document.querySelector('input[name="room"][value="團體教室"]');
    if (defaultRoomInput) defaultRoomInput.checked = true;
  }
  // 分店資料已經寫死在 index.html，只剩 /filterOptions 需要等。
  const filterOptionsPromise = withRetryTimeout(() => fetch(`${WORKER_BASE}/filterOptions`).then(r => r.json()), QUERY_RETRY_AFTER_MS, QUERY_GIVE_UP_AFTER_MS);
  // 頁面載入就先預熱一張查詢用的 token，大部分情況使用者按查詢時早就備好了，不用多等。
  fetchFreshQueryToken().catch(e => console.error("issueToken 預熱失敗", e));

  try{
    initBranchGrid();
    if (urlState && urlState.branch) urlState.branch = urlState.branch.map(v => BRANCH_URL_DECODE[v] || v);
    restoreFilterGroups(urlState, ["branch"]);
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
    restoreFilterGroups(urlState, ["course", "teacher"]);
    updateSubmitState();
  } catch(e){
    console.error(e);
    document.getElementById("courseGrid").innerHTML = '<div class="empty-hint">課程清單讀取失敗，請重新整理頁面再試一次。</div>';
    document.getElementById("teacherGrid").innerHTML = '<div class="empty-hint">老師清單讀取失敗，請重新整理頁面再試一次。</div>';
    showServiceErrorModal();
  } finally {
    updateResetButtonState();
    await preloadRemindersPromise; // 查詢結果的鈴鐺要靠它判斷哪些已登記（見 renderScheduleResults）
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
      script.src = "vendor/chart.umd.min.js?v=1";
      script.onload = () => {
        // Chart.js 預設用 Helvetica/Arial，不會吃頁面的 CSS 字型，這裡統一成全站的 Nunito
        window.Chart.defaults.font.family = '"Nunito", sans-serif';
        resolve();
      };
      script.onerror = reject;
      document.body.appendChild(script);
    });
  }
  return loadChartJs._promise;
}

// 區塊（距離畫面 200px 以內）第一次進入畫面才呼叫 load，之後不再觀察——Chart.js 與統計資料等真的要看到才載入。
function loadWhenVisible(el, load){
  const observer = new IntersectionObserver((entries) => {
    if (entries.some((e) => e.isIntersecting)){
      observer.disconnect();
      load();
    }
  }, { rootMargin: "200px" });
  observer.observe(el);
}

function setupPublicRankingStats({ wrapId, yearSelectId, monthSelectId, endpoint, itemsKey, barColor, ariaLabel, maxItems }){
  const wrapEl = document.getElementById(wrapId);
  const yearSelect = document.getElementById(yearSelectId);
  const monthSelect = document.getElementById(monthSelectId);
  if (!wrapEl || !yearSelect || !monthSelect) return;
  enhanceCustomSelect(yearSelect);
  enhanceCustomSelect(monthSelect);

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
        animation: { duration: 1600 },
        plugins: {
          legend: { display: false },
          tooltip: { ...CHART_TOOLTIP_STYLE },
        },
        scales: {
          x: { beginAtZero: true, grid: { color: () => chartTheme().line }, ticks: { color: () => chartTheme().sub, font: { size: 10 }, precision: 0 } },
          y: { grid: { display: false }, ticks: { color: () => chartTheme().ink, font: { size: 12, weight: "600" } } },
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
    // 預設年月用台灣現在（不是裝置時區，也不是 UTC），跟 Worker 沒帶參數時的預設一致
    const [nowYear, nowMonth] = currentMonthKey().split("-");
    const year = yearSelect.value || nowYear;
    const month = monthSelect.value || nowMonth;
    try{
      await loadChartJs();
      const data = await fetchJson(`${WORKER_BASE}/${endpoint}?year=${encodeURIComponent(year)}&month=${encodeURIComponent(month)}`);
      const years = Array.isArray(data.years) && data.years.length ? data.years : [nowYear];
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

  loadWhenVisible(wrapEl, load);
}

// 首頁「查詢量趨勢」：近 12 個月查詢次數 / 結果數雙折線圖，資料來自公開端點 /publicSearchStats。
(function setupSearchTrend(){
  const wrapEl = document.getElementById("searchTrendWrap");
  if (!wrapEl) return;

  let chartInstance = null;

  function buildWindow(monthly, monthlyResults, endMonth){
    return buildMonthWindow(CHART_MONTHS, endMonth, (m) => ({ count: monthly[m] || 0, resultCount: monthlyResults[m] || 0 }));
  }

  async function load(){
    try{
      await loadChartJs();
      const data = await fetchJson(`${WORKER_BASE}/publicSearchStats`);
      const chartData = buildWindow(data.monthly || {}, data.monthlyResults || {}, currentMonthKey());
      wrapEl.innerHTML = "<canvas></canvas>";
      const canvas = wrapEl.querySelector("canvas");
      // 不給 aspectRatio（不維持固定寬高比）：原本 560/210 是照桌機寬度抓的，手機版容器變窄，
      // 算出來的圖表高度會比 .branch-stats-wrap 的 min-height:200px 矮一截，下面就會留白；
      // 改成直接撐滿容器本身的高度（由 CSS min-height 決定，不是這裡動態設定，才不會又造成 CLS）。
      chartInstance = createLineChart(canvas, {
        data: chartData,
        series: [
          { key: "count", label: "查詢次數", color: "#2a78d6" },
          { key: "resultCount", label: "結果數", color: "#eb6834" },
        ],
        ariaLabel: `近 ${CHART_MONTHS} 個月查詢次數與查詢結果數趨勢`,
      });
    } catch(e){
      console.error(e);
      wrapEl.textContent = "載入失敗，請稍後再試";
    }
  }

  window.addEventListener("resize", () => { if (chartInstance) chartInstance.resize(); });

  loadWhenVisible(wrapEl, load);
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
