// 語音搜尋比對引擎的回歸測試：npm run test:voice（在 worker/ 下執行）
//
// 測的是 voice-search.js 的 applyTranscript()：給一句話，檢查它選到哪些分店／課程／老師／星期／時段／教室、
// 回傳 "submitted"／"insufficient"／"no-match"，以及「常用排序要加次數的項目」（named）與「標紅的片段」（hit）。
// 不測 script.js 的狀態機、錄音、Worker 的 /transcribeVoice（那些要真的麥克風或網路）。
//
// 怎麼跑起來的（跟瀏覽器裡的條件盡量一樣）：
//   - 用 jsdom 載入真正的 index.html（不執行頁面上的 <script>）：分店 pill 與「xx全選」按鈕是寫死在 HTML 裡的，
//     所以分店清單、縣市、分區永遠跟正式頁面同步——新增分店若讓某個案例的結果改變，這裡會先抓到。
//   - 課程、老師是執行時才從 API 載入，改填 scripts/voice-fixtures.json 的凍結快照（2026-11-12 的 /filterOptions）。
//     快照不會自動更新，所以測試結果是確定的、不受線上資料影響；想換新快照看 voice-fixtures.json 的 source 欄位。
//   - voice-search.js 是 classic script（共用 script.js 的全域）：用 vm 在 jsdom 的全域裡執行，頂層 const 才會留在全域。
//     它依賴的 FILTER_GROUPS／TIME_OPTIONS／ROOM_URL_CODE／WEEKDAY_LABEL／checkedValues 直接從 script.js 的原始碼
//     用正規表示式抽出來執行，不複製一份（複製了就會有兩邊不一致的一天）；抽不到會直接報錯。
//   - 載入真正的 vendor/pinyin-pro.min.js，同音字行為跟正式站一致。
//   - index.html 的教室 checkbox 兩個都沒勾（「團體教室」預設勾選是 script.js 在執行時才加的），這裡手動勾上團體教室。
//   - script.js 的 submitVoiceSearch／applyVoiceFilters 換成記錄呼叫參數的假函式。
//
// 案例在 scripts/voice-cases.mjs（欄位說明在檔案開頭）。有任何案例失敗 exit code 為 1。
// 選用參數：--only=<關鍵字>（只跑 say 含該字串的案例）、--verbose（每個案例都印出實際結果）、
// --say=<句子>（不跑案例，只印出這句話的比對結果，多句用 | 分隔；想知道某句話會怎樣、或要新增案例時用）。
import fs from "node:fs";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import { CASES } from "./voice-cases.mjs";

const args = Object.fromEntries(
  process.argv.slice(2).filter((a) => a.startsWith("--")).map((a) => {
    const [key, ...rest] = a.slice(2).split("=");
    return [key, rest.length ? rest.join("=") : true];
  })
);
const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const read = (rel) => fs.readFileSync(ROOT + rel, "utf8").replace(/\r\n/g, "\n");

function fatal(message){
  console.error(`✗ ${message}`);
  process.exit(1);
}

// ---------- 環境 ----------
const dom = new JSDOM(read("index.html"), { runScripts: "outside-only", url: "https://worldgym.pages.dev/" });
const { document } = dom.window;
const context = dom.getInternalVMContext();
const run = (code, filename) => new vm.Script(code, { filename }).runInContext(context);

// 課程、老師：填進跟 script.js 的 renderGrid 同樣結構的 checkbox（voice-search.js 只讀 name 與 value）。
const fixtures = JSON.parse(read("worker/scripts/voice-fixtures.json"));
function fillGrid(gridId, name, values){
  const grid = document.getElementById(gridId);
  if (!grid) fatal(`index.html 找不到 #${gridId}`);
  grid.innerHTML = "";
  values.forEach((value, i) => {
    const span = document.createElement("span");
    span.className = "pill";
    const input = document.createElement("input");
    Object.assign(input, { type: "checkbox", name, value, id: `${name}-${i}` });
    const label = document.createElement("label");
    label.htmlFor = input.id;
    label.textContent = value;
    span.append(input, label);
    grid.append(span);
  });
}
fillGrid("courseGrid", "course", fixtures.classNames);
fillGrid("teacherGrid", "teacher", fixtures.teacherNames);

// script.js 的全域：從原始碼抽出來，抽不到就報錯（代表 script.js 改了寫法，這裡要跟著調整）。
const scriptJs = read("script.js");
function extract(pattern, name){
  const m = scriptJs.match(pattern);
  if (!m) fatal(`script.js 抽不到 ${name}（寫法改了？請調整 scripts/test-voice.mjs 的正規表示式）`);
  return m[0];
}
run([
  extract(/^const FILTER_GROUPS = .*;$/m, "FILTER_GROUPS"),
  extract(/^const TIME_OPTIONS = \[[\s\S]*?\n\];$/m, "TIME_OPTIONS"),
  extract(/^const ROOM_URL_CODE = .*;$/m, "ROOM_URL_CODE"),
  extract(/^const WEEKDAY_LABEL = .*;$/m, "WEEKDAY_LABEL"),
  extract(/^function checkedValues\(name\)\{[\s\S]*?\n\}$/m, "checkedValues"),
  // 不載入外部腳本：pinyin-pro 下面直接執行；篩選選項視為已經載入完成。
  "function createVendorScriptLoader(){ return () => Promise.resolve(); }",
  "const filterOptionsSettledPromise = Promise.resolve();",
  "window.__calls = [];",
  'window.submitVoiceSearch = (state, named) => { window.__calls.push({ kind: "submit", state, named }); };',
  'window.applyVoiceFilters = (state, named) => { window.__calls.push({ kind: "apply", state, named }); };',
].join("\n"), "test-voice-prelude.js");
run(read("vendor/pinyin-pro.min.js"), "pinyin-pro.min.js");
if (!dom.window.pinyinPro) fatal("vendor/pinyin-pro.min.js 執行後沒有 window.pinyinPro");
run(read("voice-search.js"), "voice-search.js");
if (!dom.window.WGVoiceSearch) fatal("voice-search.js 執行後沒有 window.WGVoiceSearch");

// ---------- 分店名稱 → value ----------
// 案例裡的分店寫畫面上看到的名稱；也可以寫整組簡寫：@city:高雄（該縣市全部分店）、@zone:台南區（該分區全部）、
// @prefix:板橋（名稱開頭的所有分店）。這樣縣市多一間分店時，案例不用跟著改。
const branchInputs = [...document.querySelectorAll('#branchGrid input[name="branch"]')];
const branchRows = branchInputs.map((input) => ({
  value: input.value,
  label: input.nextElementSibling.textContent,
  city: input.dataset.city,
  zone: input.closest(".zone-group")?.dataset.zoneName,
}));
function expandBranch(token){
  const shorthand = token.match(/^@(city|zone|prefix):(.+)$/);
  let rows;
  if (shorthand){
    const [, kind, key] = shorthand;
    rows = branchRows.filter((r) => (kind === "city" ? r.city === key : kind === "zone" ? r.zone === key : r.label.startsWith(key)));
    if (!rows.length) throw new Error(`分店簡寫 ${token} 在頁面上找不到任何分店`);
  } else {
    rows = branchRows.filter((r) => r.label === token);
    if (!rows.length) throw new Error(`分店「${token}」不在 index.html 的分店 pill 裡（改名或下架了？）`);
  }
  return rows.map((r) => r.value);
}
const labelOf = new Map(branchRows.map((r) => [r.value, r.label]));
const showBranches = (values) => values.map((v) => labelOf.get(v) ?? v);

// ---------- 執行單一案例 ----------
const DEFAULT_ROOM = ["團體教室"];
const plain = (x) => JSON.parse(JSON.stringify(x)); // 去掉 jsdom 全域的 Array 原型，才能跟本地陣列比較
const sortedUnique = (list) => [...new Set(list)].sort();

function setRooms(checked){
  document.querySelectorAll('input[name="room"]').forEach((input) => { input.checked = checked.includes(input.value); });
}

async function runCase(c){
  setRooms(c.roomBefore ?? DEFAULT_ROOM);
  dom.window.__calls.length = 0;
  let spans = null;
  const savedPinyin = dom.window.pinyinPro;
  if (c.noPinyin) dom.window.pinyinPro = undefined;
  let result;
  try {
    result = await dom.window.WGVoiceSearch.applyTranscript(c.say, () => true, (s) => { spans = plain(s); });
  } finally {
    dom.window.pinyinPro = savedPinyin;
  }
  const call = plain(dom.window.__calls[0] ?? null);
  return { result, call, spans };
}

function sameSet(a, b){
  const x = sortedUnique(a);
  const y = sortedUnique(b);
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

function check(c, actual){
  const problems = [];
  const expectResult = c.result ?? "submitted";
  if (actual.result !== expectResult) problems.push(`回傳 ${actual.result}，預期 ${expectResult}`);
  if (expectResult === "no-match"){
    if (actual.call) problems.push("no-match 不該呼叫 submitVoiceSearch／applyVoiceFilters");
    return problems;
  }
  if (!actual.call){
    if (actual.result !== expectResult) return problems; // 上面已經報過了
    problems.push("沒有呼叫 submitVoiceSearch／applyVoiceFilters");
    return problems;
  }
  const wantKind = expectResult === "submitted" ? "submit" : "apply";
  if (actual.call.kind !== wantKind) problems.push(`呼叫了 ${actual.call.kind}，預期 ${wantKind}`);
  const state = actual.call.state;
  const expectState = {
    day: c.day ?? [],
    time: c.time ?? [],
    room: c.room ?? c.roomBefore ?? DEFAULT_ROOM,
    branch: (c.branch ?? []).flatMap(expandBranch),
    course: c.course ?? [],
    teacher: c.teacher ?? [],
  };
  Object.entries(expectState).forEach(([name, want]) => {
    const got = state[name] ?? [];
    if (!sameSet(got, want)){
      const show = name === "branch" ? showBranches : (v) => v;
      problems.push(`${name}：實際 [${show(sortedUnique(got)).join("、")}]，預期 [${show(sortedUnique(want)).join("、")}]`);
    }
  });
  if (c.named){
    const wantNamed = {
      branch: (c.named.branch ?? []).flatMap(expandBranch),
      course: c.named.course ?? [],
      teacher: c.named.teacher ?? [],
    };
    Object.entries(wantNamed).forEach(([name, want]) => {
      const got = actual.call.named?.[name] ?? [];
      if (!sameSet(got, want)){
        const show = name === "branch" ? showBranches : (v) => v;
        problems.push(`named.${name}：實際 [${show(sortedUnique(got)).join("、")}]，預期 [${show(sortedUnique(want)).join("、")}]`);
      }
    });
  }
  if (c.hit){
    const got = (actual.spans ?? []).map(([s, e]) => c.say.slice(s, e));
    if (JSON.stringify(got) !== JSON.stringify(c.hit)) problems.push(`標紅片段：實際 ${JSON.stringify(got)}，預期 ${JSON.stringify(c.hit)}`);
  }
  return problems;
}

function describe(actual){
  if (!actual.call) return actual.result;
  const s = actual.call.state;
  const parts = ["day", "time", "room", "course", "teacher"].filter((k) => s[k]?.length).map((k) => `${k}=[${s[k].join("、")}]`);
  if (s.branch?.length) parts.push(`branch=[${showBranches(s.branch).join("、")}]`);
  return `${actual.result} ${parts.join(" ")}`;
}

// ---------- 主流程 ----------
if (typeof args.say === "string"){
  for (const say of args.say.split("|")){
    const actual = await runCase({ say });
    const marked = (actual.spans ?? []).map(([s, e]) => say.slice(s, e));
    console.log(`「${say}」→ ${describe(actual)}${marked.length ? `  標紅 ${JSON.stringify(marked)}` : ""}`);
  }
  process.exit(0);
}
const selected = typeof args.only === "string" ? CASES.filter((c) => c.say.includes(args.only)) : CASES;
if (!selected.length) fatal(`沒有符合 --only=${args.only} 的案例`);
let failed = 0;
let known = 0;
for (const c of selected){
  let problems;
  let actual = null;
  try {
    actual = await runCase(c);
    problems = check(c, actual);
  } catch (e) {
    problems = [`執行錯誤：${e.message}`];
  }
  if (c.todo){
    // 已知問題：expect 寫的是「應該有的行為」，目前還沒做到。仍然不通過時只提醒、不算失敗；
    // 哪天修好了就會通過，這時反過來算失敗，逼著把 todo 拿掉（不然修好了還一直掛著已知問題）。
    if (problems.length){
      known++;
      console.log(`△ 已知問題「${c.say}」：${c.todo}`);
      if (actual) console.log(`    目前實際結果：${describe(actual)}`);
    } else {
      failed++;
      console.log(`✗ 「${c.say}」已經通過了——把這個案例的 todo 拿掉`);
    }
  } else if (problems.length){
    failed++;
    console.log(`✗ 「${c.say}」${c.note ? `（${c.note}）` : ""}`);
    problems.forEach((p) => console.log(`    ${p}`));
    if (actual) console.log(`    實際結果：${describe(actual)}`);
  } else if (args.verbose){
    console.log(`✓ 「${c.say}」→ ${describe(actual)}`);
  }
}
console.log(`${failed ? "✗" : "✓"} 語音比對：${selected.length - failed - known}/${selected.length} 個案例通過${known ? `，${known} 個已知問題（todo）` : ""}`);
process.exit(failed ? 1 : 0);
