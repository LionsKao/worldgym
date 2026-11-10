// 語音搜尋的比對引擎：只在使用者第一次點麥克風時才會被載入（見 script.js 的 loadVoiceSearch），
// 不計入一般頁面載入的 JS 體積。純比對＋套用，不自己碰 SpeechRecognition（生命週期在 script.js）。
// 執行環境跟 script.js 同一個全域（classic script，非 module），FILTER_GROUPS/checkedValues/
// WEEKDAY_LABEL/TIME_OPTIONS/ROOM_URL_CODE/filterOptionsSettledPromise/applyVoiceFilters/
// submitVoiceSearch/createVendorScriptLoader 都是 script.js 已經宣告好的全域，這裡直接取用、不重複定義。

// 同音異字容錯用的拼音轉換（vendor/pinyin-pro.min.js，見 matchTranscript 下方說明）：
// 跟 voice-search.js 本身平行背景載入、不等它（跟 script.js 的 loadVoiceSearch() 同一招），
// 載入期間若使用者已經講完話，matchTranscript() 會偵測 window.pinyinPro 還沒就緒、
// 自動跳過拼音比對（退回純精確字串比對，等同沒有這層容錯，不會報錯卡住）。
// 原本先選了體積小很多的 tiny-pinyin（3.5KB gzip），但實測它「用 Intl.Collator 排序做二分搜尋」
// 的設計在現代瀏覽器的 ICU 資料下對一般常用字就不準（例如「北」轉成 bao、「橋」「前」「錢」都
// 轉成 qie，對照本站真實分店名稱「站前」「北投」「板橋」都轉錯），換成內建完整字典、不依賴
// Intl.Collator 排序的 pinyin-pro（145KB gzip，準確率換來的體積代價，使用者 2026-11-10 確認要準確優先）。
const loadPinyinPro = createVendorScriptLoader("vendor/pinyin-pro.min.js?v=1", () => !!window.pinyinPro);
loadPinyinPro().catch((e) => console.error("pinyin-pro.min.js 載入失敗", e));

// 口語別名表，對應到 index.html 既有的 checkbox value。別名的值可以是單一 value 或陣列
// （例如「週末」同時代表六跟日）。day 刻意不含裸數字（"一".."日"）當別名 key：裸數字太容易
// 誤判（課程/分店名稱裡常有數字），一定要連「星期/週/周/禮拜」字首才算。
// 「今天」「明天」不用再列在這裡：dayBaseTerms() 已經從 WEEKDAY_LABEL 讀出一樣的 {category:"day",
// value:"today"/"tomorrow", term:"今天"/"明天"}，列在這裡只是沒有作用的重複項，只留真正的別名「今日」「明日」。
const DAY_ALIASES = {
  "今日": "today", "明日": "tomorrow",
  "星期一": "1", "週一": "1", "周一": "1", "禮拜一": "1",
  "星期二": "2", "週二": "2", "周二": "2", "禮拜二": "2",
  "星期三": "3", "週三": "3", "周三": "3", "禮拜三": "3",
  "星期四": "4", "週四": "4", "周四": "4", "禮拜四": "4",
  "星期五": "5", "週五": "5", "周五": "5", "禮拜五": "5",
  "星期六": "6", "週六": "6", "周六": "6", "禮拜六": "6",
  "星期日": "7", "星期天": "7", "週日": "7", "周日": "7", "禮拜日": "7", "禮拜天": "7",
  "週末": ["6", "7"], "周末": ["6", "7"],
};
// 「傍晚」刻意算進 18-23（晚間團課多半從 18:00 起），不是 12-17。刻意不解析「晚上七點」這種
// 精確時刻：現有篩選系統本來就只有這三個時段區間，語音也不該比手動篩選更細。
const TIME_ALIASES = {
  "早上": "0600", "早晨": "0600", "清晨": "0600", "上午": "0600",
  "中午": "1200", "下午": "1200", "午後": "1200",
  "晚上": "1800", "傍晚": "1800", "晚間": "1800", "夜晚": "1800", "夜間": "1800", "深夜": "1800",
};
const ROOM_ALIASES = { "團課": "團體教室", "團體課": "團體教室", "飛輪課": "飛輪教室", "飛輪": "飛輪教室" };
// 只在目標詞確實存在於目前課程清單時才生效（見 courseTerms），小型、可自行擴充。
const COURSE_ALIASES = {
  "瑜珈": "瑜伽", "彼拉提斯": "皮拉提斯", "皮拉提": "皮拉提斯",
  "康貝": "BODYCOMBAT", "康盃": "BODYCOMBAT", "combat": "BODYCOMBAT", "BC": "BODYCOMBAT",
  "pump": "BODYPUMP", "BP": "BODYPUMP",
  "BB": "BODYBALANCE",
};

function aliasTerms(category, aliasMap){
  const terms = [];
  Object.entries(aliasMap).forEach(([term, value]) => {
    (Array.isArray(value) ? value : [value]).forEach((v) => terms.push({ category, value: v, term }));
  });
  return terms;
}
// WEEKDAY_LABEL 的「一」~「日」是裸數字，單獨一個字太容易在任何句子裡剛好出現造成誤判
// （例如隨口一句「一下」的「一」就會被誤判成星期一）；只收 "today"/"tomorrow" 這兩個天生夠長
// 夠明確的詞，星期幾一律只透過下面 DAY_ALIASES 有字首的形式（「星期一」「週一」等）比對。
function dayBaseTerms(){
  return Object.entries(WEEKDAY_LABEL)
    .filter(([value]) => value === "today" || value === "tomorrow")
    .map(([value, label]) => ({ category: "day", value, term: label }));
}
function timeBaseTerms(){
  return TIME_OPTIONS.map((o) => ({ category: "time", value: o.value, term: o.label }));
}
function roomBaseTerms(){
  return Object.keys(ROOM_URL_CODE).map((value) => ({ category: "room", value, term: value }));
}
// 分店：直接讀 #branchGrid 的 DOM（index.html 寫死，頁面載入就緒），組兩條通用別名規則，
// 涵蓋「大安分店」「台北站前」這類口語說法，不用手動列舉 100 多間分店。
function branchTerms(){
  const terms = [];
  document.querySelectorAll('#branchGrid input[name="branch"]').forEach((input) => {
    const label = input.nextElementSibling ? input.nextElementSibling.textContent : "";
    if (!label) return;
    const city = input.dataset.city;
    terms.push({ category: "branch", value: input.value, term: label });
    terms.push({ category: "branch", value: input.value, term: label + "店" });
    terms.push({ category: "branch", value: input.value, term: label + "分店" });
    if (city && !label.startsWith(city)) terms.push({ category: "branch", value: input.value, term: city + label });
  });
  return terms;
}
// 課程/老師是動態填入的，直接讀現場 DOM（呼叫端已經等過 filterOptionsSettledPromise 才會呼叫這裡）。
function courseTerms(){
  const values = new Set([...document.querySelectorAll('#courseGrid input[name="course"]')].map((i) => i.value));
  const terms = [...values].map((v) => ({ category: "course", value: v, term: v }));
  Object.entries(COURSE_ALIASES).forEach(([term, value]) => { if (values.has(value)) terms.push({ category: "course", value, term }); });
  return terms;
}
function teacherTerms(){
  return [...document.querySelectorAll('#teacherGrid input[name="teacher"]')].map((i) => ({ category: "teacher", value: i.value, term: i.value }));
}
async function buildVocabulary(){
  await filterOptionsSettledPromise; // 最壞情況 6 秒內一定會 resolve
  return [
    ...dayBaseTerms(), ...aliasTerms("day", DAY_ALIASES),
    ...timeBaseTerms(), ...aliasTerms("time", TIME_ALIASES),
    ...roomBaseTerms(), ...aliasTerms("room", ROOM_ALIASES),
    ...branchTerms(), ...courseTerms(), ...teacherTerms(),
  ];
}

// 比對：全部詞彙（跨所有類別）依長度排序，由長到短、用 indexOf 掃描整句（不需要分詞，中文
// 逐字比對本來就可行）。字元一旦被較長的詞彙「佔用」，較短的詞彙就不能再用同一段文字——
// 這樣才能正確解開「台南西門」（長度 4，整段先佔走）vs 裡面碰巧也存在的「西門」（長度 2，
// 可能是另一間分店的別名）這種重疊。只有長度完全相同時才用類別優先權當 tie-break。
const CATEGORY_PRIORITY = { branch: 0, teacher: 1, course: 2, day: 3, time: 4, room: 5 };
function normalize(s){
  return s.replace(/[，,。.!！?？、\s]/g, "").toLowerCase();
}
// 掃一遍：全部詞彙（跨所有類別）依長度排序，由長到短、用 indexOf 掃描整句（不需要分詞，中文
// 逐字比對本來就可行）。字元一旦被較長的詞彙「佔用」，較短的詞彙就不能再用同一段文字——
// 這樣才能正確解開「台南西門」（長度 4，整段先佔走）vs 裡面碰巧也存在的「西門」（長度 2，
// 可能是另一間分店的別名）這種重疊。只有長度完全相同時才用類別優先權當 tie-break。
// text／vocabTerms 的 term 都要是呼叫端已經轉換好（normalize 或轉拼音）的最終字串。
function scanTerms(text, vocabTerms){
  const vocab = vocabTerms
    .filter((t) => t.term.length > 0)
    .sort((a, b) => b.term.length - a.term.length || CATEGORY_PRIORITY[a.category] - CATEGORY_PRIORITY[b.category]);

  const claimed = new Array(text.length).fill(false);
  // 六個類別名稱直接從 FILTER_GROUPS（script.js 的全域）生出來，不要在這裡另外手寫一份固定清單——
  // 兩邊各自維護的話，FILTER_GROUPS 哪天真的改動，這裡忘記同步更新就會讓 matched[name] 變 undefined。
  const matched = Object.fromEntries(FILTER_GROUPS.map((name) => [name, new Set()]));

  vocab.forEach(({ category, value, term }) => {
    let from = 0;
    let idx;
    while ((idx = text.indexOf(term, from)) !== -1){
      from = idx + 1;
      const end = idx + term.length;
      let overlap = false;
      for (let i = idx; i < end; i++){ if (claimed[i]){ overlap = true; break; } }
      if (overlap) continue;
      for (let i = idx; i < end; i++) claimed[i] = true;
      matched[category].add(value);
    }
  });
  return matched;
}
// 拼音比對只當作精確比對的補強：門檻刻意設 4 個字母（約兩個音節）以上才收，太短的拼音
// （例如兩三個字母）在任意一段話裡剛好出現的機率高，容易誤判成不相關的分店/課程/老師。
const MIN_PINYIN_TERM_LEN = 4;
function matchTranscript(transcript, vocabTerms){
  const text = normalize(transcript);
  const normalizedVocab = vocabTerms.map((t) => ({ ...t, term: normalize(t.term) }));
  const matched = scanTerms(text, normalizedVocab);

  // 同音異字容錯：語音辨識把字聽成同音的別字時（例如「熊大」聽成「雄大」），上面的精確字串
  // 比對比不出來；多轉一層拼音（vendor/pinyin-pro.min.js）再比對一次，兩次結果取聯集，不影響
  // 精確比對原本就比得到的結果。pinyin-pro 還沒載入完成時直接跳過這段、退回純精確比對
  // （跟沒有這層容錯以前行為相同，不報錯）。traditional:true 對應本站內容全是繁體中文；
  // 轉出來的英文（分店/課程裡混的 BODYCOMBAT 之類）pinyin-pro 不會自動轉小寫，這裡額外
  // .toLowerCase() 一次，跟 normalize() 的大小寫規則一致。
  if (window.pinyinPro){
    const toPinyin = (s) => window.pinyinPro.pinyin(s, { toneType: "none", type: "string", separator: "", traditional: true }).toLowerCase();
    const pinyinText = toPinyin(text);
    const pinyinVocab = normalizedVocab
      .map((t) => ({ ...t, term: toPinyin(t.term) }))
      .filter((t) => t.term.length >= MIN_PINYIN_TERM_LEN);
    const pinyinMatched = scanTerms(pinyinText, pinyinVocab);
    FILTER_GROUPS.forEach((name) => { pinyinMatched[name].forEach((v) => matched[name].add(v)); });
  }

  return Object.fromEntries(Object.entries(matched).map(([k, v]) => [k, [...v]]));
}

// 三種結果，對應語音搜尋「不經確認直接動作」的三個出口：
//   "no-match"    完全沒聽懂任何類別 → 不碰任何 checkbox，script.js 顯示「聽不懂」提示。
//   "insufficient" 聽懂了一些、但沒有分店或老師（跟 isSearchValid() 同一條規則）→ 套用聽懂的
//                  部分到 checkbox（讓使用者接著手動補完），但不送出查詢。
//   "submitted"    有分店或老師 → 套用＋直接送出查詢，完全不經確認。
//   "cancelled"    比對這段期間使用者自己把語音搜尋開關關掉了 → 什麼都不套用、不送出。
async function applyTranscript(transcript){
  const vocab = await buildVocabulary();
  const matched = matchTranscript(transcript, vocab);
  const hitAny = FILTER_GROUPS.some((name) => matched[name].length > 0);
  if (!hitAny) return "no-match";
  // voiceSearchEnabled 是 script.js 的全域，比對這段非同步期間使用者可能已經把開關關掉——
  // 這時不該再套用/送出任何東西，即使語音內容本身聽懂了。
  if (!voiceSearchEnabled) return "cancelled";

  // room 語音沒提到的話，保留使用者目前已勾選的（room 本來就有「團體教室」預設值、不列入 isSearchValid()）。
  const state = { ...matched, room: matched.room.length ? matched.room : checkedValues("room") };
  const sufficient = matched.branch.length > 0 || matched.teacher.length > 0;
  if (sufficient){
    window.submitVoiceSearch(state);
    return "submitted";
  }
  window.applyVoiceFilters(state);
  return "insufficient";
}

window.WGVoiceSearch = { applyTranscript };
