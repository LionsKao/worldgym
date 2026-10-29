// 靜態資源版號檢查：node --no-warnings scripts/check-versions.mjs（在 worker/ 下執行，或 npm run check:versions）
//
// CSS、JS、icon 都走 _headers 快取 30 天，能這樣做的前提是「引用處都帶 ?v= 版號、檔案內容改了版號就要加一」。
// 版號是人工維護的，以前就出現過三個頁面的 style.css 版號各自為政（104／73／45）。這支腳本只讀檔、不改任何東西，檢查：
//   1. 每個引用本站 CSS／JS／icon 的地方（index.html、admin.html、403.html、404.html、manifest.json、sw.js、script.js 的 Chart.js 載入）
//      都帶 ?v=數字，而且檔案存在
//   2. 同一個檔案在所有引用處用的版號相同（例如 style.css 三個頁面要一樣、common.js 兩個頁面要一樣）
//   3. （選用）--base=<git ref>：內容跟 base 不一樣的檔案，版號一定要比 base 的大——抓「改了檔案忘了加版號」，
//      這是最容易漏、而且一漏使用者最久一個月看到舊檔的錯誤。例如 npm run check:versions -- --base=origin/main
// 不檢查的（刻意不帶版號）：sw.js（Service Worker 本身不長快取）、manifest.json 的 <link>、favicon.ico（瀏覽器自己請求）。
// 有錯誤（✗）exit code 為 1。--root=<目錄> 可以指定另一份 repo 根目錄（測試用），預設是這支腳本所在 repo。
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const args = Object.fromEntries(
  process.argv.slice(2).filter((a) => a.startsWith("--")).map((a) => {
    const [key, ...rest] = a.slice(2).split("=");
    return [key, rest.length ? rest.join("=") : true];
  })
);
const ROOT = path.resolve(typeof args.root === "string" ? args.root : fileURLToPath(new URL("../../", import.meta.url)));
const SITE_ORIGIN = "https://worldgym.pages.dev/";
const ASSET_PATTERN = /^[\w./-]+\.(?:js|css|png|svg|ico)(?:\?.*)?$/;
const EXEMPT = new Set(["favicon.ico"]);

// 每種引用檔各自用最窄的規則抓出「引用了哪些本站資源」，避免把註解或其他字串誤抓進來。
const SOURCES = [
  { file: "index.html", pick: (t) => [...t.matchAll(/\b(?:src|href|content)="([^"]*)"/g)].map((m) => m[1]) },
  { file: "admin.html", pick: (t) => [...t.matchAll(/\b(?:src|href|content)="([^"]*)"/g)].map((m) => m[1]) },
  { file: "403.html", pick: (t) => [...t.matchAll(/\b(?:src|href|content)="([^"]*)"/g)].map((m) => m[1]) },
  { file: "404.html", pick: (t) => [...t.matchAll(/\b(?:src|href|content)="([^"]*)"/g)].map((m) => m[1]) },
  { file: "manifest.json", pick: (t) => [...t.matchAll(/"src"\s*:\s*"([^"]*)"/g)].map((m) => m[1]) },
  { file: "sw.js", pick: (t) => [...t.matchAll(/\b(?:icon|badge)\s*:\s*"([^"]*)"/g)].map((m) => m[1]) },
  { file: "script.js", pick: (t) => [...t.matchAll(/script\.src\s*=\s*"([^"]*)"/g)].map((m) => m[1]) },
];

const errors = [];
const readWorking = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const readBase = (ref, rel) => {
  try { return execFileSync("git", ["show", `${ref}:${rel}`], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 }); }
  catch { return null; }
};
const readBaseBuffer = (ref, rel) => {
  try { return execFileSync("git", ["show", `${ref}:${rel}`], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 }); }
  catch { return null; }
};
// 比內容時忽略換行差異（工作目錄是 CRLF、git 裡存 LF）。
const hashOf = (buf) => crypto.createHash("sha1").update(Buffer.from(buf.toString("binary").replace(/\r\n/g, "\n"), "binary")).digest("hex");

// 從各引用檔收集 { path, version, from }。
function collect(readText) {
  const refs = [];
  for (const { file, pick } of SOURCES) {
    const text = readText(file);
    if (text == null) continue;
    for (const raw of pick(text)) {
      const value = raw.startsWith(SITE_ORIGIN) ? raw.slice(SITE_ORIGIN.length) : raw;
      if (!ASSET_PATTERN.test(value)) continue;
      const [p, query = ""] = value.split("?");
      if (EXEMPT.has(p)) continue;
      const m = query.match(/(?:^|&)v=(\d+)(?:&|$)/);
      refs.push({ path: p, version: m ? Number(m[1]) : null, from: file });
    }
  }
  return refs;
}

const refs = collect((f) => (fs.existsSync(path.join(ROOT, f)) ? readWorking(f) : null));
const byPath = new Map();
for (const r of refs) { if (!byPath.has(r.path)) byPath.set(r.path, []); byPath.get(r.path).push(r); }

// 1. 有帶版號、檔案存在
for (const r of refs) {
  if (r.version === null) errors.push(`${r.from} 引用 ${r.path} 沒帶 ?v=版號（長快取一定要有版號，否則改了檔案使用者最久一個月看不到）`);
  if (!fs.existsSync(path.join(ROOT, r.path))) errors.push(`${r.from} 引用的 ${r.path} 不存在`);
}
// 2. 同一個檔案在所有引用處版號一致
for (const [p, list] of byPath) {
  const versions = [...new Set(list.map((r) => r.version))];
  if (versions.length > 1) errors.push(`${p} 在不同地方用了不同版號：${list.map((r) => `${r.from}=?v=${r.version}`).join("、")}`);
}
console.log(`引用本站資源的地方：${refs.length} 處，涵蓋 ${byPath.size} 個檔案`);

// 3. 內容改了、版號沒加
if (args.base) {
  const ref = String(args.base);
  if (readBase(ref, "index.html") === null) {
    errors.push(`無法讀取 ${ref} 的 index.html（base 不存在？）`);
  } else {
    const baseRefs = collect((f) => readBase(ref, f));
    const baseVersion = new Map();
    for (const r of baseRefs) baseVersion.set(r.path, Math.max(baseVersion.get(r.path) ?? 0, r.version ?? 0));
    let changed = 0, added = 0;
    for (const [p, list] of byPath) {
      const baseBuf = readBaseBuffer(ref, p);
      if (baseBuf === null) { added++; continue; } // base 沒有這個檔案，是新增的
      if (!fs.existsSync(path.join(ROOT, p))) continue;
      if (hashOf(baseBuf) === hashOf(fs.readFileSync(path.join(ROOT, p)))) continue;
      changed++;
      const now = Math.max(...list.map((r) => r.version ?? 0));
      const before = baseVersion.get(p) ?? 0;
      if (now <= before) errors.push(`${p} 的內容相對 ${ref} 改過了，但版號沒加（現在 ?v=${now}，${ref} 是 ?v=${before}）——要把 ${[...new Set(list.map((r) => r.from))].join("、")} 裡的版號加一`);
    }
    console.log(`相對 ${ref}：${changed} 個檔案內容有改${added ? `、${added} 個是新增` : ""}`);
  }
}

console.log("");
for (const e of errors) console.log(`✗ ${e}`);
if (errors.length) {
  console.log(`\n發現 ${errors.length} 個錯誤。`);
  process.exit(1);
}
console.log(`✓ 版號一致：${byPath.size} 個檔案的所有引用都帶 ?v=，同一個檔案各處版號相同${args.base ? `，內容有改的都已加版號` : ""}。`);
