// 分店清單一致性檢查：node --no-warnings scripts/check-branches.mjs（在 worker/ 下執行，或 npm run check:branches）
//
// 分店資料散在好幾份，沒有 build step 能自動同步，改了其中一份忘了改另一份，使用者就會看到壞掉的畫面
// 或舊的分享網址指到別間分店。這支腳本只讀檔、不改任何東西，檢查：
//   1. worker/src/branches-seed.js（唯一的資料來源）：slug 不重複、格式合法
//   2. script.js 的 BRANCH_SLUG_ORDER：跟 seed 完全同一個順序（短代碼 = 陣列位置，順序一變舊分享網址就壞）
//   3. index.html 寫死的分店 pill：跟 seed 同一批分店，且縣市（data-city）、顯示名稱、經緯度對得上
//   4. 根目錄靜態 sitemap.xml（動態 sitemap 失敗時的備援）：不能出現 seed 裡已經沒有的分店
//   5. （選用）--base=<git ref>：seed 的 slug 順序只能「往後附加」，不能插入/調換/刪除
//      例如 npm run check:branches -- --base=origin/main
// 有錯誤（✗）exit code 為 1；警告（⚠）只是提醒，不影響 exit code。
// --root=<目錄> 可以指定另一份 repo 根目錄（測試用），預設是這支腳本所在 repo。
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const args = Object.fromEntries(
  process.argv.slice(2).filter((a) => a.startsWith("--")).map((a) => {
    const [key, ...rest] = a.slice(2).split("=");
    return [key, rest.length ? rest.join("=") : true];
  })
);
const ROOT = path.resolve(typeof args.root === "string" ? args.root : fileURLToPath(new URL("../../", import.meta.url)));
const SEED_PATH = "worker/src/branches-seed.js";
const SAFE_SLUG_PATTERN = /^[a-z0-9-]+$/; // 跟 functions/_lib/branchUrl.js 一樣，不符的話網址會退回短代碼

const errors = [];
const warnings = [];
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const fmt = (list, max = 8) => (list.length > max ? `${list.slice(0, max).join("、")} …共 ${list.length} 個` : list.join("、"));
const dupes = (list) => [...new Set(list.filter((v, i) => list.indexOf(v) !== i))];
const diff = (a, b) => a.filter((x) => !new Set(b).has(x));

// 兩份清單要「完全同一個順序」：回報長度不同、缺哪些、第一個位置不同的是哪兩個。
function checkSameOrder(nameA, listA, nameB, listB) {
  if (listA.length === listB.length && listA.every((v, i) => v === listB[i])) return true;
  const problems = [`${nameA} ${listA.length} 間、${nameB} ${listB.length} 間`];
  const onlyA = diff(listA, listB), onlyB = diff(listB, listA);
  if (onlyA.length) problems.push(`只在 ${nameA}：${fmt(onlyA)}`);
  if (onlyB.length) problems.push(`只在 ${nameB}：${fmt(onlyB)}`);
  if (!onlyA.length && !onlyB.length && listA.length !== listB.length) {
    problems.push("分店相同但筆數不同（其中一份有重複的項目）");
  } else if (!onlyA.length && !onlyB.length) {
    const i = listA.findIndex((v, idx) => v !== listB[idx]);
    problems.push(`內容相同但順序不同，第 ${i} 個位置 ${nameA} 是 ${listA[i]}、${nameB} 是 ${listB[i]}`);
  } else {
    const i = listA.findIndex((v, idx) => v !== listB[idx]);
    if (i >= 0) problems.push(`第一個不同的位置是 ${i}（${nameA}：${listA[i] ?? "（無）"}，${nameB}：${listB[i] ?? "（無）"}）`);
  }
  errors.push(problems.join("；"));
  return false;
}

function attr(tag, name) {
  const m = tag.match(new RegExp(`\\s${name}="([^"]*)"`));
  return m ? m[1] : null;
}

// ---- 1. seed ----
const seed = (await import(pathToFileURL(path.join(ROOT, SEED_PATH)).href)).default;
const seedSlugs = seed.map((b) => b.slug);
const seedBySlug = new Map(seed.map((b) => [b.slug, b]));
const seedDupes = dupes(seedSlugs);
if (seedDupes.length) errors.push(`${SEED_PATH} 有重複的 slug：${fmt(seedDupes)}`);
const badSlugs = seedSlugs.filter((s) => typeof s !== "string" || !SAFE_SLUG_PATTERN.test(s));
if (badSlugs.length) errors.push(`${SEED_PATH} 有不合法的 slug（只能小寫英數與連字號）：${fmt(badSlugs)}`);
const incomplete = seed.filter((b) => !b.name || !b.region).map((b) => b.slug);
if (incomplete.length) errors.push(`${SEED_PATH} 有缺 name 或 region 的分店：${fmt(incomplete)}`);
console.log(`${SEED_PATH}：${seed.length} 間`);

// ---- 2. script.js 的 BRANCH_SLUG_ORDER ----
const orderMatch = read("script.js").match(/const BRANCH_SLUG_ORDER = (\[[\s\S]*?\]);/);
if (!orderMatch) {
  errors.push("script.js 找不到 BRANCH_SLUG_ORDER");
} else {
  checkSameOrder("branches-seed.js", seedSlugs, "script.js 的 BRANCH_SLUG_ORDER", JSON.parse(orderMatch[1]));
}

// ---- 3. index.html 的分店 pill ----
const pills = [...read("index.html").matchAll(/<input[^>]*name="branch"[^>]*>\s*<label[^>]*>([^<]*)<\/label>/g)].map((m) => ({
  slug: attr(m[0], "value"), city: attr(m[0], "data-city"), lat: attr(m[0], "data-lat"), lng: attr(m[0], "data-lng"), label: m[1].trim(),
}));
const pillSlugs = pills.map((p) => p.slug);
const pillDupes = dupes(pillSlugs);
if (pillDupes.length) errors.push(`index.html 的分店 pill 有重複：${fmt(pillDupes)}`);
const missingPills = diff(seedSlugs, pillSlugs), extraPills = diff(pillSlugs, seedSlugs);
if (missingPills.length) errors.push(`index.html 少了這些分店的 pill：${fmt(missingPills)}`);
if (extraPills.length) errors.push(`index.html 有 seed 裡不存在的分店 pill：${fmt(extraPills)}`);
const cityMismatch = pills.filter((p) => seedBySlug.has(p.slug) && p.city !== seedBySlug.get(p.slug).region).map((p) => `${p.slug}（pill 是 ${p.city}、seed 是 ${seedBySlug.get(p.slug).region}）`);
if (cityMismatch.length) errors.push(`index.html 的 data-city 跟 seed 的 region 不一致：${fmt(cityMismatch, 5)}`);
const labelMismatch = pills.filter((p) => seedBySlug.has(p.slug) && p.label !== seedBySlug.get(p.slug).name).map((p) => `${p.slug}（pill 是「${p.label}」、seed 是「${seedBySlug.get(p.slug).name}」）`);
if (labelMismatch.length) errors.push(`index.html 的分店顯示名稱跟 seed 的 name 不一致：${fmt(labelMismatch, 5)}`);
const hasCoord = (v) => v !== null && v !== "" && Number.isFinite(Number(v));
const noCoords = pills.filter((p) => !hasCoord(p.lat) || !hasCoord(p.lng)).map((p) => p.slug);
if (noCoords.length) warnings.push(`這些分店的 pill 沒有有效的經緯度（依位置篩選分店時會被跳過）：${fmt(noCoords)}`);
console.log(`index.html：${pills.length} 個分店 pill`);

// ---- 4. 靜態 sitemap.xml ----
const sitemapSlugs = [...read("sitemap.xml").matchAll(/\?branch=([^&<]+)&amp;room=1/g)].map((m) => m[1]);
const unknownInSitemap = diff(sitemapSlugs, seedSlugs);
if (unknownInSitemap.length) warnings.push(`靜態 sitemap.xml（備援）列了 seed 裡已經沒有的分店：${fmt(unknownInSitemap)}`);
console.log(`sitemap.xml（備援）：${sitemapSlugs.length} 個分店網址`);

// ---- 5. 只能往後附加（選用）----
if (args.base) {
  const ref = String(args.base);
  try {
    const baseText = execFileSync("git", ["show", `${ref}:${SEED_PATH}`], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    const baseSlugs = (await import("data:text/javascript;base64," + Buffer.from(baseText).toString("base64"))).default.map((b) => b.slug);
    const i = baseSlugs.findIndex((s, idx) => s !== seedSlugs[idx]);
    if (i >= 0) {
      errors.push(
        `相對 ${ref}，seed 的順序被動過（只能往後附加）：第 ${i} 個原本是 ${baseSlugs[i]}，現在是 ${seedSlugs[i] ?? "（已被刪除）"}。` +
        "插入、調換或刪除都會讓舊的短代碼分享網址指到別間分店"
      );
    } else {
      console.log(`相對 ${ref}：原有 ${baseSlugs.length} 間順序不變，新增 ${seedSlugs.length - baseSlugs.length} 間`);
    }
  } catch (e) {
    errors.push(`無法讀取 ${ref} 的 ${SEED_PATH}：${String(e.stderr || e.message).trim().split("\n")[0]}`);
  }
}

console.log("");
for (const w of warnings) console.log(`⚠ ${w}`);
for (const e of errors) console.log(`✗ ${e}`);
if (errors.length) {
  console.log(`\n發現 ${errors.length} 個錯誤、${warnings.length} 個警告。`);
  process.exit(1);
}
console.log(`✓ 一致：seed、BRANCH_SLUG_ORDER、index.html 的 ${seed.length} 間分店對得上${warnings.length ? `（另有 ${warnings.length} 個警告）` : ""}。`);
