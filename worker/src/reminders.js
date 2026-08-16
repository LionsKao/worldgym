import { buildPushPayload } from "@block65/webcrypto-web-push";

// 課表通知:上課前這麼多分鐘推播一次,單次通知,不做每週訂閱式的長期追蹤。
const REMIND_MINUTES_BEFORE = 30;
// scheduled() 的 cron 間隔是 5 分鐘(見 wrangler.toml [triggers]),掃描時抓「即將在這個視窗內到期」的通知。
const DISPATCH_WINDOW_MINUTES = 5;

const WEEKDAY_LABEL = { 1: "一", 2: "二", 3: "三", 4: "四", 5: "五", 6: "六", 7: "日" };

function pad2(n) {
  return String(n).padStart(2, "0");
}

// 跟 scrape.js 的 nowTaiwanIso() 用同一套「位移 8 小時再貼 +08:00 後綴」慣例,
// 這樣 remindAt/classAt 才能跟現有時間戳直接用字串比較。
function nowTaiwanIso() {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  return d.toISOString().replace("Z", "+08:00");
}

function taiwanIsoFromUtcParts(year, month, date, hour, minute) {
  return new Date(Date.UTC(year, month, date, hour, minute, 0)).toISOString().replace("Z", "+08:00");
}

function currentTaiwanParts() {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth(),
    date: d.getUTCDate(),
    weekday: d.getUTCDay() === 0 ? 7 : d.getUTCDay(),
    hours: d.getUTCHours(),
    minutes: d.getUTCMinutes(),
  };
}

// Workers 的 Web Crypto 沒有 MD5,借用 scrape.js 同一套 FNV-1a 短雜湊當 id 尾碼,不是安全用途。
function fnv1aHex(str) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

// 同一個 subscription 對同一堂固定班表(分店+星期+時間+課程+老師)重複登記要收斂成同一筆,
// 所以 id 由這些欄位決定,不含 pushSubscription 內容本身。
function buildReminderId(subscriptionEndpoint, branchSlug, dayOfWeek, startTime, className, teacherName) {
  const seed = [subscriptionEndpoint, branchSlug, dayOfWeek, startTime, className, teacherName].join("|");
  return `rem_${fnv1aHex(seed)}`;
}

// 找出「下一次符合 dayOfWeek/startTime 的上課時間」:今天符合但「課前提醒時間」已過就跳到下週同一天，
// 不能只看上課時間本身有沒有過——否則會登記到一個 remindAt 已經是過去式的提醒（課前 30 分早就過了）。
function computeNextOccurrence(dayOfWeek, startTime) {
  const now = currentTaiwanParts();
  const startHour = parseInt(startTime.slice(0, 2), 10) || 0;
  const startMinute = parseInt(startTime.slice(2, 4), 10) || 0;

  let deltaDays = (dayOfWeek - now.weekday + 7) % 7;
  const remindMinutesOfDay = startHour * 60 + startMinute - REMIND_MINUTES_BEFORE;
  if (deltaDays === 0 && remindMinutesOfDay <= now.hours * 60 + now.minutes) {
    deltaDays = 7;
  }

  const base = new Date(Date.UTC(now.year, now.month, now.date));
  base.setUTCDate(base.getUTCDate() + deltaDays);
  const y = base.getUTCFullYear();
  const m = base.getUTCMonth();
  const d = base.getUTCDate();

  const classAt = taiwanIsoFromUtcParts(y, m, d, startHour, startMinute);

  const remindDate = new Date(Date.UTC(y, m, d, startHour, startMinute));
  remindDate.setUTCMinutes(remindDate.getUTCMinutes() - REMIND_MINUTES_BEFORE);
  const remindAt = taiwanIsoFromUtcParts(
    remindDate.getUTCFullYear(),
    remindDate.getUTCMonth(),
    remindDate.getUTCDate(),
    remindDate.getUTCHours(),
    remindDate.getUTCMinutes()
  );

  return { classAt, remindAt };
}

async function registerReminder(db, params) {
  const { branchSlug, branchName, className, teacherName, roomName, dayOfWeek, startTime, pushSubscription, clickUrl } = params;
  const subscriptionEndpoint = pushSubscription?.endpoint || "";
  if (!subscriptionEndpoint) throw new Error("missing push subscription endpoint");

  const { classAt, remindAt } = computeNextOccurrence(dayOfWeek, startTime);
  const id = buildReminderId(subscriptionEndpoint, branchSlug, dayOfWeek, startTime, className, teacherName);

  await db
    .prepare(
      `INSERT OR REPLACE INTO reminders
        (id, branchSlug, branchName, className, teacherName, roomName, dayOfWeek, startTime, classAt, remindAt, subscriptionEndpoint, pushSubscription, clickUrl, sent, createdAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`
    )
    .bind(
      id,
      branchSlug,
      branchName,
      className,
      teacherName,
      roomName,
      dayOfWeek,
      startTime,
      classAt,
      remindAt,
      subscriptionEndpoint,
      JSON.stringify(pushSubscription),
      clickUrl || "",
      nowTaiwanIso()
    )
    .run();

  return { id, classAt, remindAt };
}

async function cancelReminder(db, params) {
  if (params.id) {
    const res = await db.prepare("DELETE FROM reminders WHERE id = ?").bind(params.id).run();
    return { deleted: res.meta.changes || 0 };
  }
  const { branchSlug, dayOfWeek, startTime, className, teacherName, subscriptionEndpoint } = params;
  const id = buildReminderId(subscriptionEndpoint, branchSlug, dayOfWeek, startTime, className, teacherName);
  const res = await db.prepare("DELETE FROM reminders WHERE id = ?").bind(id).run();
  return { deleted: res.meta.changes || 0 };
}

async function listReminders(db, subscriptionEndpoint) {
  const { results } = await db
    .prepare(
      `SELECT id, branchSlug, branchName, className, teacherName, roomName, dayOfWeek, startTime, classAt, remindAt
       FROM reminders WHERE subscriptionEndpoint = ? AND sent = 0 ORDER BY classAt`
    )
    .bind(subscriptionEndpoint)
    .all();
  return results;
}

function formatHHmm(startTime) {
  return `${startTime.slice(0, 2)}:${startTime.slice(2, 4)}`;
}

// cron(每 5 分鐘,見 wrangler.toml [triggers])呼叫:掃出「快到期」的通知,逐筆送 Web Push。
// 單次通知用完即丟——不管送成功、訂閱失效還是送失敗,都直接刪除該筆,不重試、不留存。
async function dispatchDueReminders(db, env) {
  const windowEnd = new Date(Date.now() + (8 * 3600 + DISPATCH_WINDOW_MINUTES * 60) * 1000)
    .toISOString()
    .replace("Z", "+08:00");

  const { results } = await db.prepare("SELECT * FROM reminders WHERE sent = 0 AND remindAt <= ?").bind(windowEnd).all();
  if (results.length === 0) return { dispatched: 0 };

  const vapid = { subject: env.VAPID_SUBJECT, publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY };
  let dispatched = 0;

  for (const r of results) {
    try {
      const subscription = JSON.parse(r.pushSubscription);
      const title = `${r.className} ${r.teacherName}`;
      const body = `${r.branchName} 週${WEEKDAY_LABEL[r.dayOfWeek]} ${formatHHmm(r.startTime)}`;
      const message = { data: JSON.stringify({ title, body, url: r.clickUrl || "/" }), options: { ttl: 3600 } };
      const payload = await buildPushPayload(message, subscription, vapid);
      const res = await fetch(subscription.endpoint, payload);
      if (!res.ok) {
        console.error("[reminders] push endpoint responded", res.status, r.id);
      } else {
        dispatched++;
      }
    } catch (err) {
      console.error("[reminders] push failed", r.id, err.message);
    } finally {
      await db.prepare("DELETE FROM reminders WHERE id = ?").bind(r.id).run();
    }
  }

  return { dispatched, scanned: results.length };
}

export { computeNextOccurrence, registerReminder, cancelReminder, listReminders, dispatchDueReminders };
