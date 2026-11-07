"use strict";
// Journal: decrypts data.enc in the browser and shows it.
// The password and key never leave this page and are never stored.
// Everything from the data is shown with textContent, never as HTML.

const AAD = new TextEncoder().encode("wod-journal-v1");
const AUTO_LOCK_MS = 2 * 60 * 1000;
const SVG = "http://www.w3.org/2000/svg";
let J = null;          // the decrypted journal
let KEY = null;        // non-extractable AES key, in memory only while unlocked
let SALT = null;       // the salt KEY was derived with; a new salt means the password changed
let current = "home";  // the view on screen
let syncUntil = 0;     // while a sync is expected, check for new data
let hiddenAt = 0;
const SYNC_SHORTCUT = "Sync Journal";
let range = 30;        // trends range in days
let filter = "All";    // activity filter

if (window.top !== window.self) window.top.location = window.self.location.href;

const $ = (id) => document.getElementById(id);

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined && text !== null) n.textContent = String(text);
  return n;
}

function svg(tag, attrs, parent) {
  const n = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs || {})) n.setAttribute(k, String(v));
  if (parent) parent.append(n);
  return n;
}

// ---------- crypto ----------

const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function deriveKey(password, box) {
  if (box.v !== 1 || box.kdf !== "PBKDF2-SHA256") throw new Error("Unknown format");
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt: unb64(box.salt), iterations: box.iter },
    base, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
}

async function openBox(key, box) {
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: unb64(box.iv), additionalData: AAD }, key, unb64(box.ct));
  return JSON.parse(new TextDecoder().decode(plain));
}

async function fetchBox() {
  const res = await fetch("data.enc?t=" + Date.now(), { cache: "no-store", credentials: "omit" });
  if (!res.ok) throw new Error("missing");
  return res.json();
}

async function unlock(event) {
  event.preventDefault();
  const input = $("password"), status = $("status"), button = $("open");
  button.disabled = true;
  status.textContent = "Unlocking…";
  try {
    const box = await fetchBox();
    KEY = await deriveKey(input.value, box);
    J = normalizeJournal(await openBox(KEY, box));
    SALT = box.salt;
    input.value = "";
    status.textContent = "";
    start();
  } catch (err) {
    J = null; KEY = null;
    status.textContent = err && err.name === "OperationError" ? "Wrong password." : "Couldn't open the journal.";
  } finally {
    button.disabled = false;
  }
}

/** The band logs CrossFit classes as "HIIT" (Garmin has no CrossFit type); show the real name everywhere. */
function normalizeJournal(j) {
  if (!j) return j;
  for (const a of j.activities || []) {
    if (a.label === "HIIT") a.label = "CrossFit";
    if (typeof a.name === "string") a.name = a.name.replace(/\bHIIT\b/g, "CrossFit");
  }
  const walk = (o) => {
    if (!o || typeof o !== "object") return;
    for (const k in o) {
      const v = o[k];
      if (typeof v === "string") o[k] = v.replace(/\bHIIT\b/g, "CrossFit");
      else if (v && typeof v === "object") walk(v);
    }
  };
  walk(j.coach);
  return j;
}

function lock() {
  stopSpeaking();
  J = null; KEY = null;
  window.location.reload(); // drops every decrypted value and the key from memory
}

// ---------- sync ----------

function setSyncState(text) {
  $("syncState").textContent = text || "";
  $("syncState").hidden = !text;
}

/** Loads the latest published journal with the key in memory. Returns true if it changed. */
async function refreshData() {
  if (!KEY) return false;
  try {
    const box = await fetchBox();
    if (box.salt !== SALT) { setSyncState("Password changed: lock and unlock"); return false; }
    const next = normalizeJournal(await openBox(KEY, box));
    if (next.updated === J.updated) return false;
    J = next;
    show(current, true);
    return true;
  } catch {
    return false;
  }
}

function sync() {
  // The GitHub key lives in the iPhone Shortcut, never in this page.
  syncUntil = Date.now() + 6 * 60 * 1000;
  setSyncState("Syncing…");
  window.location.href = "shortcuts://run-shortcut?name=" + encodeURIComponent(SYNC_SHORTCUT);
  poll();
}

async function poll() {
  if (!syncUntil) return;
  if (await refreshData()) { syncUntil = 0; setSyncState("Updated"); setTimeout(() => setSyncState(""), 4000); return; }
  if (Date.now() > syncUntil) { syncUntil = 0; setSyncState(""); return; }
  setTimeout(poll, 20000);
}

// ---------- data helpers ----------

const pad = (n) => String(n).padStart(2, "0");
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseDay = (s) => new Date(s.slice(0, 10) + "T12:00:00");
const fmtInt = (n) => (n === null || n === undefined ? "–" : Math.round(n).toLocaleString());
const fmtHM = (sec) => {
  if (!sec) return "–";
  const m = Math.round(sec / 60);
  return Math.floor(m / 60) + "h " + pad(m % 60) + "m";
};
const fmtMS = (sec) => {
  const s = Math.round(sec || 0);
  return Math.floor(s / 60) + ":" + pad(s % 60);
};
const dayName = (d, opts) => d.toLocaleDateString(undefined, opts);
const shortDay = (s) => dayName(parseDay(s), { day: "numeric", month: "short" });

function dayList(n) {
  const out = [];
  const today = new Date();
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i, 12);
    const key = iso(d);
    out.push({ key, d, v: (J.days || {})[key] || {} });
  }
  return out;
}

function avg(list) {
  const xs = list.filter((x) => typeof x === "number" && !isNaN(x));
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

const GROUPS = [
  { key: "training", label: "Training", cls: 1, types: ["hiit", "strength_training", "indoor_cardio", "fitness_equipment"] },
  { key: "padel", label: "Padel", cls: 2, types: ["paddelball", "padel"] },
  { key: "run", label: "Run & walk", cls: 3, types: ["running", "treadmill_running", "trail_running", "walking", "hiking"] },
  { key: "other", label: "Other", cls: 4, types: [] },
];
const groupOf = (a) => GROUPS.find((g) => g.types.includes(a.type)) || GROUPS[3];
const ICONS = {
  training: ["M6.5 7v10M17.5 7v10M3.5 9.5v5M20.5 9.5v5M6.5 12h11"],                    // dumbbell
  padel: ["M10 3.5a6 6 0 1 1 0 12a6 6 0 0 1 0-12z", "M14.3 13.8L20 19.5"],           // racket
  run: ["M3.5 17.5l5-6 4 3.5 7.5-9", "M15.5 6h4.5v4.5"],                                // route
  other: ["M12 21a7.5 7.5 0 1 0 0-15a7.5 7.5 0 0 0 0 15z", "M12 13.5V10", "M9.5 3h5"], // stopwatch
};

function setAmount(s) {
  if (s.unit === "m" && s.n) return s.n.toLocaleString() + " m";
  if (s.unit === "cal" && s.n) return s.n + " cal";
  if (s.n) return "× " + s.n;
  return fmtMS(s.sec);
}

// ---------- Today ----------

function tile(label, value, unit, sub, status) {
  const c = el("div", "card");
  c.append(el("div", "tile-label", label));
  const v = el("div", "stat-value", value);
  if (unit) v.append(el("small", null, unit));
  c.append(v);
  if (status) c.append(el("div", "status " + status.cls, status.text));
  if (sub) c.append(el("div", "stat-sub", sub));
  return c;
}

function readinessStatus(level, score) {
  if (score === null || score === undefined) return null;
  const map = { PRIME: ["good", "Prime"], HIGH: ["good", "High"], MODERATE: ["warning", "Moderate"],
    LOW: ["serious", "Low"], POOR: ["critical", "Poor"] };
  const [cls, text] = map[level] || (score >= 70 ? ["good", "High"] : score >= 50 ? ["warning", "Moderate"] : ["serious", "Low"]);
  return { cls, text };
}

function stageBar(s) {
  const bar = el("div", "stagebar");
  const total = (s.deep || 0) + (s.light || 0) + (s.rem || 0) + (s.awake || 0);
  [["deep", "k1"], ["light", "k2"], ["rem", "k3"], ["awake", "k4"]].forEach(([k, cls]) => {
    if (!s[k]) return;
    const seg = el("span", cls);
    seg.style.flex = String(s[k] / total);
    bar.append(seg);
  });
  return bar;
}

function sleepLegend(s) {
  const lg = el("div", "legend");
  [["Deep", "deep", "k1"], ["Light", "light", "k2"], ["REM", "rem", "k3"], ["Awake", "awake", "k4"]].forEach(([n, k, cls]) => {
    const item = el("span");
    item.append(el("i", cls), document.createTextNode(`${n} ${s ? fmtHM(s[k]).replace("0h ", "") : ""}`.trim()));
    lg.append(item);
  });
  return lg;
}

function latestSleep() {
  return dayList(3).reverse().find((x) => x.v.sleep);
}

function partOfDay(h) {
  if (h >= 5 && h < 12) return "morning";
  if (h >= 12 && h < 17) return "afternoon";
  if (h >= 17 && h < 22) return "evening";
  return "night";
}

const CALLS = {
  push: ["good", "Push day"], normal: ["good", "Train as planned"],
  easy: ["warning", "Keep it easy"], rest: ["serious", "Rest day"],
};

function coachChip(daily) {
  const card = el("button", "card coach-chip");
  card.type = "button";
  card.addEventListener("click", () => show("coach"));
  const [cls, text] = CALLS[daily.call] || ["good", "Coach"];
  const top = el("div", "coach-top");
  const who = el("span", "chip-who");
  who.append(coachAvatar(daily.call, 28), el("span", "tile-label", "Coach · today"));
  top.append(who, el("span", "status " + cls, text));
  card.append(top, el("div", "coach-headline", daily.headline));
  if (daily.plan) card.append(el("div", "stat-sub", planText(daily.plan)));
  return card;
}

// Weeks run Sunday to Saturday.
function weekStart(d) {
  const s = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0);
  s.setDate(s.getDate() - s.getDay());
  return s;
}

/** Sessions, minutes, kcal and avg HR between two dates (inclusive start, exclusive end). */
function sessionStats(from, to) {
  const acts = (J.activities || []).filter((a) => { const d = parseDay(a.date); return d >= from && d < to; });
  const mins = acts.reduce((s, a) => s + (a.min || 0), 0);
  return {
    acts,
    sessions: acts.length,
    minutes: mins,
    kcal: acts.reduce((s, a) => s + (a.kcal || 0), 0),
    hr: mins ? acts.reduce((s, a) => s + (a.hr || 0) * (a.min || 0), 0) / mins : null,
  };
}

function delta(now, before, fmt) {
  if (!before) return null;
  const diff = now - before;
  if (Math.abs(diff) < 0.5) return "same as last week";
  return (diff > 0 ? "▲ " : "▼ ") + fmt(Math.abs(diff)) + " vs last week";
}

function weekCard() {
  const today = new Date();
  const start = weekStart(today);
  const end = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1, 0);
  const lastStart = new Date(start); lastStart.setDate(start.getDate() - 7);
  const lastEnd = new Date(end); lastEnd.setDate(end.getDate() - 7); // same span of last week
  const w = sessionStats(start, end), l = sessionStats(lastStart, lastEnd);

  const card = el("div", "card");
  card.append(el("div", "tile-label", "This week"));
  const kv = el("div", "kv kv4");
  const pair = (b, s, d) => {
    const x = el("div"); x.append(el("b", null, b), el("span", null, s));
    if (d) x.append(el("em", null, d));
    kv.append(x);
  };
  pair(w.sessions, w.sessions === 1 ? "session" : "sessions", delta(w.sessions, l.sessions, (n) => Math.round(n)));
  pair(fmtHM(w.minutes * 60).replace("0h ", ""), "training", delta(w.minutes, l.minutes, (n) => Math.round(n) + " min"));
  pair(fmtInt(w.kcal), "kcal", delta(w.kcal, l.kcal, (n) => fmtInt(n)));
  pair(w.hr ? Math.round(w.hr) : "–", "avg HR", null);
  card.append(kv);

  // Mon-Sun strip: one dot per session, colored by type.
  const strip = el("div", "weekstrip");
  for (let i = 0; i < 7; i++) {
    const d = new Date(start); d.setDate(start.getDate() + i);
    const col = el("div", "wday" + (iso(d) === iso(today) ? " now" : ""));
    col.append(el("span", "wday-name", d.toLocaleDateString(undefined, { weekday: "narrow" })));
    const dots = el("div", "wdots");
    for (const a of w.acts.filter((a) => a.date.slice(0, 10) === iso(d))) dots.append(el("i", "g" + groupOf(a).cls));
    col.append(dots);
    strip.append(col);
  }
  card.append(strip, legendFor(GROUPS.map((g) => [g.label, g.cls])));
  return card;
}

function recoveryCard() {
  const days = dayList(3).reverse();
  const card = el("button", "card recovery");
  card.type = "button";
  card.addEventListener("click", () => show("sleep"));
  const cell = (label, value, sub, cls) => {
    const c = el("div");
    c.append(el("span", "tile-label", label), el("b", null, value));
    if (sub) c.append(el("span", "status " + (cls || ""), sub));
    return c;
  };
  const rd = days.find((x) => x.v.ready !== null && x.v.ready !== undefined);
  const st = rd ? readinessStatus(rd.v.readyLevel, rd.v.ready) : null;
  const sl = days.find((x) => x.v.sleep);
  const hv = days.find((x) => x.v.hrv);
  const hrvAvg = avg(dayList(30).map((x) => x.v.hrv));
  card.append(
    cell("Readiness", rd ? rd.v.ready : "–", st && st.text, st && st.cls),
    cell("Sleep", sl ? fmtHM(sl.v.sleep.sec) : "–", sl && sl.v.sleep.score ? "score " + sl.v.sleep.score : null),
    cell("HRV", hv ? hv.v.hrv + " ms" : "–", hv && hrvAvg ? (hv.v.hrv >= hrvAvg ? "above avg" : "below avg") : null,
      hv && hrvAvg ? (hv.v.hrv >= hrvAvg ? "good" : "warning") : null));
  return card;
}

/** New heaviest loads and records from the last few weeks. */
function highlights() {
  const out = [];
  const since = iso(new Date(Date.now() - 21 * 864e5));
  const best = new Map();
  for (const a of (J.activities || []).slice().reverse()) {      // oldest first
    for (const r of a.rounds || []) for (const s of r.sets) {
      if (s.rest || !s.kg) continue;
      const prev = best.get(s.ex);
      if (!prev || s.kg > prev.kg) best.set(s.ex, { kg: s.kg, date: a.date.slice(0, 10), first: !prev });
    }
  }
  // Only real improvements count: a first-ever load isn't a highlight.
  for (const [ex, b] of best) if (b.date >= since && !b.first) out.push(["🏋️", `${ex} ${b.kg} kg`, "heaviest yet", b.date]);
  for (const e of maxEfforts()) {
    if (e.date >= since) out.push(["⚡", `${e.ex} ${e.n === 1 && e.kg ? e.kg + " kg" : e.n + (e.unit === "cal" ? " cal" : " reps")}`, "max effort · " + fmtWindow(e.win), e.date]);
  }
  for (const r of J.records || []) {
    if (r.date && r.date >= since && (r.kind === "time" || r.kind === "distance")) {
      const v = r.kind === "time" ? fmtClock(r.value) : r.kind === "distance" ? (r.value / 1000).toFixed(2) + " km" : fmtInt(r.value);
      out.push(["🏆", `${r.label} ${v}`, "personal record", r.date]);
    }
  }
  return out.sort((a, b) => (a[3] < b[3] ? 1 : -1)).slice(0, 5);
}

function weeksChart(weeksBack) {
  const weeks = weeklyTraining(weeksBack);
  const wk = (g) => weeks.map((w) => Math.round(w.mins[g]));
  const card = chartCard({
    kind: "stack", title: `Training · last ${weeksBack} weeks`,
    summary: [fmtInt(avg(weeks.map((w) => Object.values(w.mins).reduce((a, b) => a + b, 0)))), "min / week"],
    labels: weeks.map((w) => w.key),
    series: GROUPS.map((g) => ({ name: g.label, cls: g.cls, values: wk(g.key) })),
    xLabel: (i) => shortDay(weeks[i].key),
    tip: (i) => {
      const parts = GROUPS.map((g) => [g.label, Math.round(weeks[i].mins[g.key])]).filter((p) => p[1]);
      return parts.length ? [parts.reduce((s, p) => s + p[1], 0) + " min",
        "week of " + shortDay(weeks[i].key) + " · " + parts.map((p) => `${p[0]} ${p[1]}`).join(", ")] : null;
    },
  });
  card.append(legendFor(GROUPS.map((g) => [g.label, g.cls])));
  return card;
}

function renderHome() {
  const v = $("view-home");
  v.replaceChildren();
  const now = new Date();
  const first = J.profile && J.profile.first;
  v.append(el("h1", "large-title", `Good ${partOfDay(now.getHours())}${first ? ", " + first : ""}`),
    el("p", "eyebrow", dayName(now, { weekday: "long", day: "numeric", month: "long" })));

  const fresh = whatsNewStrip();
  if (fresh) v.append(fresh);
  v.append(heroCard());
  const wc = wrappedCard();
  if (wc) v.append(wc);
  v.append(weekCard());

  const hl = highlights();
  if (hl.length) {
    v.append(el("h2", "section-title", "Highlights"));
    const card = el("div", "card records");
    for (const [icon, title, sub, date] of hl) {
      const row = el("div", "record");
      const left = el("div");
      left.append(el("div", "record-label", `${icon}  ${title}`), el("div", "stat-sub", `${sub} · ${shortDay(date)}`));
      row.append(left);
      card.append(row);
    }
    v.append(card);
  }

  const last = (J.activities || [])[0];
  if (last) {
    v.append(el("h2", "section-title", "Latest workout"));
    v.append(activityRow(last));
  }
  v.append(el("h2", "section-title", "Consistency"));
  v.append(weeksChart(8));

  const bits = [];
  if (J.profile && J.profile.vo2max) bits.push(`VO₂ max ${Math.round(J.profile.vo2max)}`);
  if (J.updated) bits.push("Synced " + new Date(J.updated).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }));
  v.append(el("p", "stat-sub", bits.join(" · ")));
}

// ---------- Coach ----------
// The coach's words are short; the numbers around them are drawn here from Garmin data (no AI).

const TAGS = { good: ["good", "✓"], watch: ["watch", "!"], tip: ["advice", "→"] };
const MOOD_TEXT = { push: "Fired up", normal: "Ready", easy: "Careful today", rest: "Rest mode" };
let avatarSeq = 0;
const chatSeen = new Set();   // chats already played with the typing effect this session
const reducedMotion = () => window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** The coach, drawn here (no image files): his face follows the day's call. */
function coachAvatar(mood, size) {
  mood = MOOD_TEXT[mood] ? mood : "normal";
  const id = "avclip" + (++avatarSeq);
  const root = svg("svg", { viewBox: "0 0 64 64", width: size, height: size, class: "avatar m-" + mood, "aria-hidden": "true" });
  const clip = svg("clipPath", { id }, svg("defs", {}, root));
  svg("circle", { cx: 32, cy: 32, r: 32 }, clip);
  const g = svg("g", { "clip-path": `url(#${id})` }, root);
  svg("rect", { x: 0, y: 0, width: 64, height: 64, class: "av-bg" }, g);
  svg("path", { d: "M6 66c0-12 11-18 26-18s26 6 26 18z", class: "av-shirt" }, g);
  svg("path", { d: "M27.5 49h9v-7h-9z", class: "av-skin" }, g);
  svg("path", { d: "M24 48.5l8 8.5 8-8.5", class: "av-cord" }, g);
  svg("rect", { x: 29.5, y: 55.5, width: 7, height: 4, rx: 2, class: "av-whistle" }, g);
  svg("circle", { cx: 32, cy: 31, r: 15, class: "av-skin" }, g);
  svg("path", { d: "M17.2 33.5c1.2 8.5 6.6 12.5 14.8 12.5s13.6-4 14.8-12.5c-2.4 3.6-7 5.6-14.8 5.6s-12.4-2-14.8-5.6z", class: "av-beard" }, g);
  svg("path", { d: "M17 30c-.6-10 6.4-16 15-16s15.6 6 15 16c-3.2-4-8.4-6.2-15-6.2S20.2 26 17 30z", class: "av-hair" }, g);
  svg("rect", { x: 16.6, y: 22.2, width: 30.8, height: 4.6, rx: 2.3, class: "av-band" }, g);
  const line = (d) => svg("path", { d, class: "av-line" }, g);
  if (mood === "rest") {
    line("M23.5 31.5q2.5 2 5 0"); line("M35.5 31.5q2.5 2 5 0");
    const z = svg("text", { x: 47, y: 16, class: "av-z" }, g); z.textContent = "z";
  } else {
    svg("circle", { cx: 26, cy: 31.5, r: 1.9, class: "av-eye" }, g);
    svg("circle", { cx: 38, cy: 31.5, r: 1.9, class: "av-eye" }, g);
  }
  const brows = { push: ["M22.5 27l6 1.6", "M41.5 27l-6 1.6"], normal: ["M23 27.6q3-1.4 6 0", "M35 27.6q3-1.4 6 0"],
    easy: ["M23 28.4l6-1.8", "M41 28.4l-6-1.8"], rest: ["M23 28q3-.8 6 0", "M35 28q3-.8 6 0"] }[mood];
  brows.forEach(line);
  const mouth = svg("g", { class: "av-mouth" }, g);
  if (mood === "push") svg("path", { d: "M25.5 37.2q6.5 7 13 0z", class: "av-open" }, mouth);
  else svg("path", { d: { normal: "M27 37.8q5 4 10 0", easy: "M28 39q4 1 8 0", rest: "M28.5 38.4q3.5 2.6 7 0" }[mood], class: "av-line" }, mouth);
  return root;
}

function speakable() { return "speechSynthesis" in window && typeof SpeechSynthesisUtterance === "function"; }
function stopSpeaking() { if (speakable()) window.speechSynthesis.cancel(); }

/** Reads text aloud with the iPhone's own voice; nothing leaves the device. */
function listenButton(text, avatar) {
  const btn = el("button", "listen", "🔊 Listen");
  btn.type = "button";
  btn.addEventListener("click", () => {
    const s = window.speechSynthesis;
    if (s.speaking) { s.cancel(); return; }
    const u = new SpeechSynthesisUtterance(text);
    const voices = s.getVoices().filter((x) => /^en[-_]/i.test(x.lang));
    u.voice = voices.find((x) => /Daniel|Arthur|Aaron|Alex|Samantha/.test(x.name)) || voices[0] || null;
    u.lang = (u.voice && u.voice.lang) || "en-US";
    u.rate = 1.02;
    const done = () => { avatar.classList.remove("talking"); btn.textContent = "🔊 Listen"; };
    u.onstart = () => { avatar.classList.add("talking"); btn.textContent = "■ Stop"; };
    u.onend = done; u.onerror = done;
    s.speak(u);
  });
  return btn;
}

function itemOf(it, tag) { return typeof it === "string" ? { tag: tag || "tip", text: it } : it; }

/** Tagged one-liners; older reports were plain strings. */
function items(list, tag) {
  const ul = el("ul", "citems");
  for (const it of list || []) {
    const o = itemOf(it, tag);
    const [cls, mark] = TAGS[o.tag] || TAGS.tip;
    const li = el("li", "citem " + cls);
    li.append(el("span", "cmark", mark), el("span", null, o.text));
    ul.append(li);
  }
  return ul;
}

function bubble(o) {
  if (o.big) return el("div", "bubble big", o.text);
  const [cls, mark] = TAGS[o.tag] || TAGS.tip;
  const b = el("div", "bubble " + cls);
  b.append(el("span", "cmark", mark), el("span", null, o.text));
  return b;
}

/** Messages appear one by one with a typing indicator, once per session. */
function playChat(box, msgs, key, after) {
  if (chatSeen.has(key) || reducedMotion()) {
    for (const m of msgs) box.append(bubble(m));
    after.forEach((x) => x.classList.remove("later"));
    return;
  }
  chatSeen.add(key);
  let i = 0;
  const next = () => {
    if (!box.isConnected && i > 0) return;
    if (i >= msgs.length) { after.forEach((x) => x.classList.add("reveal")); after.forEach((x) => x.classList.remove("later")); return; }
    const typing = el("div", "bubble typing");
    typing.append(el("i"), el("i"), el("i"));
    box.append(typing);
    setTimeout(() => {
      const b = bubble(msgs[i]);
      b.classList.add("pop");
      typing.replaceWith(b);
      i++;
      setTimeout(next, 180);
    }, i === 0 ? 650 : 520);
  };
  next();
}

function planBox(plan, title) {
  const box = el("div", "cplan");
  box.append(el("div", "coach-sub", title));
  if (typeof plan === "string") { box.append(el("p", null, plan)); return box; }
  for (const p of plan || []) {
    const row = el("div", "cplan-row");
    row.append(el("b", null, p.what), el("span", null, p.detail));
    box.append(row);
  }
  return box;
}

function planText(plan) {
  if (typeof plan === "string") return plan;
  return (plan || []).map((p) => `${p.what} ${p.detail}`).join(" · ");
}

const fmtMin = (m) => (m < 60 ? Math.round(m) + " min" : fmtHM(m * 60));

/** Today against the last 30 days: a bar for today, a tick for the average. */
function signals() {
  const all = dayList(31);
  const today = all[30].v;
  const month = all.slice(0, 30).map((x) => x.v);
  const hours = (d) => (d.sleep && d.sleep.sec ? d.sleep.sec / 3600 : null);
  const rows = [
    ["Sleep", hours(today), avg(month.map(hours)), (x) => fmtHM(x * 3600), 1],
    ["HRV", today.hrv, avg(month.map((d) => d.hrv)), (x) => Math.round(x) + " ms", 1],
    ["Resting HR", today.rhr, avg(month.map((d) => d.rhr)), (x) => Math.round(x) + " bpm", -1],
    ["Readiness", today.ready, avg(month.map((d) => d.ready)), (x) => String(Math.round(x)), 1],
  ];
  const grid = el("div", "signals");
  for (const [label, now, base, fmt, dir] of rows) {
    if (typeof now !== "number" || !isFinite(now)) continue;
    const diff = base ? (now - base) / base : 0;
    const cls = !base || Math.abs(diff) < 0.03 ? "same" : diff * dir > 0 ? "up" : "down";
    const c = el("div", "signal");
    c.append(el("span", "tile-label", label), el("b", null, fmt(now)));
    const max = Math.max(now, base || 0) * 1.2 || 1;
    const track = el("div", "sig-track");
    const fill = el("span", "sig-fill " + cls);
    fill.style.width = Math.round((now / max) * 100) + "%";
    track.append(fill);
    if (base) { const tick = el("i", "sig-base"); tick.style.left = Math.round((base / max) * 100) + "%"; track.append(tick); }
    const mark = cls === "same" ? "≈" : now > base ? "▲" : "▼";
    c.append(track, el("span", "sig-sub " + cls, base ? `${mark} avg ${fmt(base)}` : ""));
    grid.append(c);
  }
  return grid;
}

/** Minutes per type in [from, to). */
function mix(from, to) {
  const mins = { training: 0, padel: 0, run: 0, other: 0 };
  let sessions = 0;
  for (const a of J.activities || []) {
    const d = parseDay(a.date);
    if (d < from || (to && d >= to)) continue;
    mins[groupOf(a).key] += a.min || 0;
    sessions++;
  }
  return { sessions, total: Object.values(mins).reduce((s, x) => s + x, 0),
    parts: GROUPS.map((g) => ({ label: g.label, cls: g.cls, value: mins[g.key] })) };
}

function donut(m, centre, sub) {
  const wrap = el("div", "donut");
  const root = svg("svg", { viewBox: "0 0 120 120", role: "img", "aria-label": `${centre} ${sub}` });
  const R = 46, C = 2 * Math.PI * R;
  svg("circle", { cx: 60, cy: 60, r: R, class: "donut-track" }, root);
  const shown = m.parts.filter((p) => p.value);
  let off = 0;
  for (const p of shown) {
    const len = (p.value / m.total) * C;
    svg("circle", {
      cx: 60, cy: 60, r: R, class: "donut-seg line" + p.cls, transform: "rotate(-90 60 60)",
      "stroke-dasharray": `${Math.max(len - (shown.length > 1 ? 3 : 0), 0.5)} ${C}`, "stroke-dashoffset": -off,
    }, root);
    off += len;
  }
  svg("text", { x: 60, y: 62, class: "donut-num", "text-anchor": "middle" }, root).textContent = centre;
  svg("text", { x: 60, y: 80, class: "donut-sub", "text-anchor": "middle" }, root).textContent = sub;
  const lg = el("div", "donut-legend");
  for (const p of shown) {
    const row = el("div");
    row.append(el("i", "g" + p.cls), el("span", null, p.label), el("b", null, `${fmtMin(p.value)} · ${Math.round((p.value / m.total) * 100)}%`));
    lg.append(row);
  }
  if (!shown.length) lg.append(el("p", "empty", "No sessions yet."));
  wrap.append(root, lg);
  return wrap;
}

/** Training minutes for each of the last 7 days, stacked by type. */
function loadChart() {
  const ds = dayList(7);
  const byDay = (g) => ds.map((x) => Math.round((J.activities || [])
    .filter((a) => a.date.slice(0, 10) === x.key && groupOf(a).key === g.key).reduce((s, a) => s + (a.min || 0), 0)));
  const series = GROUPS.map((g) => ({ name: g.label, cls: g.cls, values: byDay(g) }));
  const totals = ds.map((_, i) => series.reduce((s, x) => s + x.values[i], 0));
  const card = chartCard({
    kind: "stack", title: "Load · last 7 days", summary: [fmtMin(totals.reduce((a, b) => a + b, 0)), "total"],
    labels: ds.map((x) => x.key), series, min: 0,
    xLabel: (i) => ds[i].d.toLocaleDateString(undefined, { weekday: "narrow" }),
    tip: (i) => (totals[i] ? [totals[i] + " min", shortDay(ds[i].key)] : null),
  });
  card.append(legendFor(GROUPS.map((g) => [g.label, g.cls])));
  return card;
}

/** A class against the last few of the same kind. */
function vsRecent(a) {
  const prev = (J.activities || []).filter((x) => x.id !== a.id && groupOf(x).key === groupOf(a).key && x.date < a.date).slice(0, 6);
  const kv = el("div", "kv kv-cmp");
  const cell = (label, val, base, fmt) => {
    const d = el("div");
    d.append(el("b", null, typeof val === "number" ? fmt(val) : "–"), el("span", null, label));
    if (typeof val === "number" && base) {
      const diff = val - base, same = Math.abs(diff) / base < 0.03;
      d.append(el("em", same ? "" : diff > 0 ? "hard" : "easy", same ? "≈ usual" : (diff > 0 ? "▲ " : "▼ ") + fmt(Math.abs(diff))));
    }
    kv.append(d);
  };
  cell("avg HR", a.hr, avg(prev.map((x) => x.hr)), (x) => String(Math.round(x)));
  cell("kcal", a.kcal, avg(prev.map((x) => x.kcal)), (x) => String(Math.round(x)));
  cell("aerobic TE", a.te, avg(prev.map((x) => x.te)), (x) => x.toFixed(1));
  return kv;
}

function coachHead(mood, title, sub, speech) {
  const head = el("div", "coach-head");
  const av = coachAvatar(mood, 52);
  const who = el("div", "coach-who");
  who.append(el("b", null, title), el("span", null, sub));
  head.append(av, who);
  if (speech && speakable()) head.append(listenButton(speech, av));
  return head;
}

function renderCoach() {
  const v = $("view-coach");
  v.replaceChildren();
  v.append(el("h1", "large-title", "Coach"));
  const c = J.coach || {};
  if (!c.daily && !c.weekly && !Object.keys(c.workouts || {}).length) {
    v.append(el("p", "eyebrow", "Your coach writes a brief each morning, a review after each class and one each week."),
      el("p", "empty", "Nothing yet: the first reports arrive with the next sync."));
    return;
  }

  if (c.daily) {
    const d = c.daily;
    const isToday = d.date === iso(new Date());
    const card = el("div", "card coach-today");
    const [cls, text] = CALLS[d.call] || ["good", ""];
    const points = (d.points || []).map((p) => itemOf(p));
    const speech = [d.headline, ...points.map((p) => p.text),
      typeof d.plan === "string" ? "Plan: " + d.plan : "Today's plan: " + (d.plan || []).map((p) => `${p.what}, ${p.detail}`).join(". ")].join(". ");
    const head = coachHead(d.call, "Coach", (isToday ? "Today" : shortDay(d.date)) + " · " + (MOOD_TEXT[d.call] || ""), speech);
    const pill = el("span", "call " + cls, text);
    card.append(head, pill);
    const chat = el("div", "chat");
    card.append(chat);
    const later = [];
    if (isToday) later.push(signals());
    later.push(planBox(d.plan, "Today's plan"));
    later.forEach((x) => { x.classList.add("later"); card.append(x); });
    v.append(card);
    playChat(chat, [{ big: true, text: d.headline }, ...points], "daily|" + d.date + "|" + d.headline, later);
  }
  v.append(loadChart());

  if (c.weekly) {
    const w = c.weekly;
    v.append(el("h2", "section-title", "This week"));
    const card = el("div", "card");
    const speech = [w.headline, ...(w.wins || []), ...(w.watch || []), ...(w.focus || [])].map((x) => (typeof x === "string" ? x : x.text)).join(". ");
    card.append(coachHead("normal", "Weekly review", "Week of " + shortDay(w.week), speech), el("div", "coach-big", w.headline));
    const m = mix(weekStart(new Date()));
    card.append(donut(m, fmtMin(m.total), m.sessions === 1 ? "1 session" : m.sessions + " sessions"));
    card.append(items(w.wins, "good"), items(w.watch, "watch"), items(w.focus, "tip"));
    if (w.next_week) card.append(planBox(w.next_week, "Next week"));
    v.append(card);
  }

  const reviews = (J.activities || []).filter((a) => (c.workouts || {})[String(a.id)]);
  if (reviews.length) {
    v.append(el("h2", "section-title", "Class reviews"));
    for (const a of reviews) {
      const r = c.workouts[String(a.id)];
      const card = el("div", "card");
      card.append(el("div", "tile-label", `${shortDay(a.date)} · ${a.name || a.label}`), el("div", "coach-headline", r.headline),
        vsRecent(a), items(r.points));
      v.append(card);
    }
  }
  v.append(el("p", "stat-sub", "Tell the coach your goals: edit coach/goals.md in your GitHub repository."));
}

// ---------- Activity ----------

function renderActivity() {
  const v = $("view-activity");
  v.replaceChildren();
  const acts = J.activities || [];
  const month = acts.filter((a) => a.date.slice(0, 7) === iso(new Date()).slice(0, 7));
  v.append(el("h1", "large-title", "Workouts"),
    el("p", "eyebrow", `${month.length} workouts this month · ${fmtInt(month.reduce((s, a) => s + (a.kcal || 0), 0))} kcal`));

  const labels = ["All", "WOD", ...new Set(acts.map((a) => a.label))];
  const chips = el("div", "chips");
  for (const l of labels) {
    const b = el("button", "chip" + (l === filter ? " on" : ""), l);
    b.type = "button";
    b.addEventListener("click", () => { filter = l; renderActivity(); });
    chips.append(b);
  }
  v.append(chips);

  const shown = acts.filter((a) => filter === "All" || (filter === "WOD" ? !!a.rounds : a.label === filter));
  if (!shown.length) { v.append(el("p", "empty", "Nothing here yet.")); return; }
  let lastDay = "";
  for (const a of shown) {
    const day = a.date.slice(0, 10);
    if (day !== lastDay) {
      v.append(el("div", "day-head", dayName(parseDay(day), { weekday: "long", day: "numeric", month: "short" })));
      lastDay = day;
    }
    v.append(activityRow(a));
  }
}

// ---------- charts ----------

const W = 340, H = 150, PL = 2, PR = 34, PT = 12, PB = 20;

function niceMax(v) {
  if (!v || v <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  const m = v / p;
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p;
}

function barTop(x, y, w, h, r) {
  r = Math.min(r, w / 2, h);
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

/**
 * One chart: kind "bar" | "stack" | "line" | "range".
 * cfg: { title, summary, labels[], series:[{name, cls, values[]}], lo[], hi[], goal, min, max, fmt, tip(i) }
 */
function chartCard(cfg) {
  const card = el("div", "card");
  const head = el("div", "chart-head");
  head.append(el("div", "chart-title", cfg.title));
  const sum = el("div", "chart-sum");
  if (cfg.summary) { sum.append(el("b", null, cfg.summary[0]), document.createTextNode(" " + cfg.summary[1])); }
  head.append(sum);
  card.append(head);

  const n = cfg.labels.length;
  const box = el("div", "chart");
  const root = svg("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": cfg.title });
  box.append(root);
  card.append(box);

  let values = [];
  if (cfg.kind === "stack") {
    values = cfg.labels.map((_, i) => cfg.series.reduce((s, se) => s + (se.values[i] || 0), 0));
  } else if (cfg.kind === "range") {
    values = cfg.hi.concat(cfg.lo);
  } else values = cfg.series[0].values;
  const nums = values.filter((x) => typeof x === "number");
  let lo = cfg.min ?? 0;
  let hi = cfg.max ?? niceMax(Math.max(...nums, cfg.goal || 0, 1));
  if (cfg.kind === "line" && cfg.min === undefined && nums.length) {
    const a = Math.min(...nums), b = Math.max(...nums), padv = Math.max(2, (b - a) * 0.25);
    lo = Math.max(0, Math.floor((a - padv) / 5) * 5);
    hi = Math.ceil((b + padv) / 5) * 5;
  }
  const iw = W - PL - PR, ih = H - PT - PB;
  const step = iw / Math.max(n, 1);
  const X = (i) => PL + step * i + step / 2;
  const Y = (val) => PT + ih - ((val - lo) / (hi - lo || 1)) * ih;

  // recessive grid with labels on the right
  for (const f of [0, 0.5, 1]) {
    const val = lo + (hi - lo) * f;
    const y = Y(val);
    svg("line", { class: "gridline", x1: PL, x2: W - PR + 4, y1: y, y2: y }, root);
    const t = svg("text", { class: "axis", x: W - PR + 8, y: y + 3 }, root);
    t.textContent = cfg.fmtAxis ? cfg.fmtAxis(val) : fmtInt(val);
  }
  // x labels: first, middle, last
  [...new Set([0, Math.floor((n - 1) / 2), n - 1])].forEach((i) => {
    if (i < 0) return;
    const t = svg("text", { class: "axis", x: X(i), y: H - 4, "text-anchor": i === 0 ? "start" : i === n - 1 ? "end" : "middle" }, root);
    t.textContent = cfg.xLabel ? cfg.xLabel(i) : shortDay(cfg.labels[i]);
  });

  const marks = [];
  const bw = Math.max(2, Math.min(16, step * 0.62));
  if (cfg.kind === "bar" || cfg.kind === "stack") {
    for (let i = 0; i < n; i++) {
      let base = Y(lo);
      const group = svg("g", {}, root);
      const parts = cfg.kind === "stack" ? cfg.series : [cfg.series[0]];
      const visible = parts.filter((se) => se.values[i]);
      visible.forEach((se, k) => {
        const h = Math.max(0, Y(lo) - Y(lo + (se.values[i] || 0))); // this segment's own height
        if (h <= 0) return;
        const top = k === visible.length - 1;
        const gap = top ? 0 : 1; // 2px surface gap between stacked segments
        const y = base - h;
        svg("path", { class: "fill" + se.cls, d: top ? barTop(X(i) - bw / 2, y, bw, h, 4) : `M${X(i) - bw / 2},${base}V${y + gap}H${X(i) + bw / 2}V${base}Z` }, group);
        base = y;
      });
      marks.push(group);
    }
    if (cfg.goal) svg("line", { class: "goalline", x1: PL, x2: W - PR + 4, y1: Y(cfg.goal), y2: Y(cfg.goal) }, root);
  } else if (cfg.kind === "range") {
    for (let i = 0; i < n; i++) {
      const group = svg("g", {}, root);
      if (typeof cfg.lo[i] === "number" && typeof cfg.hi[i] === "number") {
        const y1 = Y(cfg.hi[i]), y2 = Y(cfg.lo[i]);
        svg("rect", { class: "fill" + cfg.series[0].cls, x: X(i) - bw / 2, y: y1, width: bw, height: Math.max(bw, y2 - y1), rx: bw / 2 }, group);
      }
      marks.push(group);
    }
  } else { // line
    const se = cfg.series[0];
    let d = "", pen = false;
    se.values.forEach((val, i) => {
      if (typeof val !== "number") { pen = false; return; }
      d += (pen ? "L" : "M") + X(i).toFixed(1) + "," + Y(val).toFixed(1);
      pen = true;
    });
    svg("path", { class: "line line" + se.cls, d }, root);
    se.values.forEach((val, i) => {
      if (typeof val === "number" && (i === n - 1 || typeof se.values[i + 1] !== "number") && (i === 0 || typeof se.values[i - 1] !== "number"))
        svg("circle", { class: "fill" + se.cls, cx: X(i), cy: Y(val), r: 2.5 }, root); // isolated points stay visible
    });
  }

  // hover / tap layer
  const cursor = svg("line", { class: "cursor", y1: PT, y2: PT + ih, visibility: "hidden" }, root);
  const dot = cfg.kind === "line" ? svg("circle", { class: "dot fill" + cfg.series[0].cls, r: 5, visibility: "hidden" }, root) : null;
  const hit = svg("rect", { x: PL, y: 0, width: iw, height: H, fill: "transparent" }, root);
  const tip = el("div", "tip");
  tip.hidden = true;
  box.append(tip);
  const show = (evt) => {
    const r = root.getBoundingClientRect();
    const px = ((evt.clientX - r.left) / r.width) * W;
    const i = Math.max(0, Math.min(n - 1, Math.floor((px - PL) / step)));
    const text = cfg.tip(i);
    if (!text) { hide(); return; }
    cursor.setAttribute("x1", X(i)); cursor.setAttribute("x2", X(i)); cursor.setAttribute("visibility", "visible");
    marks.forEach((m, k) => m.classList.toggle("dim", k !== i));
    if (dot) {
      const val = cfg.series[0].values[i];
      if (typeof val === "number") { dot.setAttribute("cx", X(i)); dot.setAttribute("cy", Y(val)); dot.setAttribute("visibility", "visible"); }
      else dot.setAttribute("visibility", "hidden");
    }
    tip.replaceChildren();
    const [strong, rest] = text;
    tip.append(el("b", null, strong), document.createTextNode(rest ? "  " + rest : ""));
    tip.hidden = false;
    const left = (X(i) / W) * r.width;
    tip.style.left = Math.max(60, Math.min(r.width - 60, left)) + "px";
  };
  const hide = () => {
    tip.hidden = true;
    cursor.setAttribute("visibility", "hidden");
    if (dot) dot.setAttribute("visibility", "hidden");
    marks.forEach((m) => m.classList.remove("dim"));
  };
  hit.addEventListener("pointermove", show);
  hit.addEventListener("pointerdown", show);
  hit.addEventListener("pointerleave", (e) => { if (e.pointerType === "mouse") hide(); });
  return card;
}

function legendFor(items) {
  const lg = el("div", "legend");
  for (const [name, cls] of items) {
    const it = el("span");
    it.append(el("i", "k" + cls), document.createTextNode(name));
    lg.append(it);
  }
  return lg;
}

// ---------- Sleep ----------

function renderSleep() {
  const v = $("view-sleep");
  v.replaceChildren();
  v.append(el("h1", "large-title", "Sleep"));
  const sl = latestSleep();
  if (!sl) { v.append(el("p", "empty", "No sleep data yet.")); return; }
  const s = sl.v.sleep;
  v.append(el("p", "eyebrow", "Last night · " + dayName(sl.d, { weekday: "long", day: "numeric", month: "short" })));

  const hero = el("div", "card");
  const top = el("div", "grid2");
  const a = el("div");
  a.append(el("div", "tile-label", "Time asleep"), el("div", "stat-value", fmtHM(s.sec)), el("div", "stat-sub", `${s.start || "?"} – ${s.end || "?"}`));
  const b = el("div");
  b.append(el("div", "tile-label", "Score"), el("div", "stat-value", s.score ?? "–"),
    el("div", "stat-sub", [s.resp ? `${s.resp} brpm` : null, sl.v.hrv ? `HRV ${sl.v.hrv} ms` : null].filter(Boolean).join(" · ")));
  top.append(a, b);
  hero.append(top, stageBar(s), sleepLegend(s));
  v.append(hero);

  const nights = dayList(14);
  const H = (k) => nights.map((x) => (x.v.sleep && x.v.sleep[k] ? x.v.sleep[k] / 3600 : 0));
  const card = chartCard({
    kind: "stack", title: "Last 14 nights",
    summary: [fmtHM(avg(nights.map((x) => x.v.sleep && x.v.sleep.sec)) || 0), "avg"],
    labels: nights.map((x) => x.key),
    series: [{ name: "Deep", cls: 1, values: H("deep") }, { name: "Light", cls: 2, values: H("light") },
      { name: "REM", cls: 3, values: H("rem") }, { name: "Awake", cls: 4, values: H("awake") }],
    max: 10, fmtAxis: (x) => Math.round(x) + "h",
    xLabel: (i) => shortDay(nights[i].key),
    tip: (i) => {
      const z = nights[i].v.sleep;
      return z ? [fmtHM(z.sec), `${shortDay(nights[i].key)}${z.score ? " · score " + z.score : ""}`] : null;
    },
  });
  card.append(legendFor([["Deep", 1], ["Light", 2], ["REM", 3], ["Awake", 4]]));
  v.append(card);

  const scores = nights.map((x) => (x.v.sleep ? x.v.sleep.score : null));
  v.append(chartCard({
    kind: "line", title: "Sleep score", summary: [fmtInt(avg(scores)), "avg"],
    labels: nights.map((x) => x.key), series: [{ cls: 1, values: scores }], min: 0, max: 100,
    tip: (i) => (typeof scores[i] === "number" ? [scores[i], shortDay(nights[i].key)] : null),
  }));
}

// ---------- Trends ----------

function fmtClock(sec) {
  const s = Math.round(sec);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return (h ? h + ":" + pad(m) : m) + ":" + pad(s % 60);
}

function recordsCard(recs) {
  const card = el("div", "card records");
  if (!recs.length) { card.append(el("p", "empty", "No records yet.")); return card; }
  for (const r of recs) {
    const row = el("div", "record");
    const left = el("div");
    left.append(el("div", "record-label", r.label));
    const sub = [r.pace ? fmtClock(r.pace) + " /km" : null, r.date ? shortDay(r.date) + " " + r.date.slice(0, 4) : null];
    left.append(el("div", "stat-sub", sub.filter(Boolean).join(" · ")));
    const value = r.kind === "time" ? fmtClock(r.value)
      : r.kind === "distance" ? (r.value / 1000).toFixed(2) + " km"
      : r.kind === "days" ? Math.round(r.value) + (Math.round(r.value) === 1 ? " day" : " days")
      : fmtInt(r.value);
    row.append(left, el("div", "record-value", value));
    card.append(row);
  }
  return card;
}

function fmtWindow(sec) {
  if (!sec) return "max";
  return sec % 60 ? sec + " s" : sec / 60 + " min";
}

/** Max-effort results: best per movement and window, newest date of that best. */
function maxEfforts() {
  const best = new Map();
  for (const a of (J.activities || []).slice().reverse()) for (const r of a.rounds || []) for (const s of r.sets) {
    if (!s.max) continue;
    const key = s.ex + "|" + (s.win || 0) + "|" + (s.unit || "reps");
    const score = s.n === 1 && s.kg ? s.kg : s.n;          // a max lift scores by load
    const prev = best.get(key);
    if (!prev || score >= prev.score) best.set(key, { ex: s.ex, win: s.win || 0, unit: s.unit, kg: s.kg, n: s.n, score, date: a.date.slice(0, 10) });
  }
  return [...best.values()];
}

function renderBests(v) {
  v.append(el("h2", "section-title", "Body"));
  v.append(bodyCard());
  const recs = J.records || [];
  const running = recs.filter((r) => r.kind === "time" || r.kind === "distance");
  v.append(el("h2", "section-title", "Running bests"));
  v.append(recordsCard(running));

  const efforts = maxEfforts();
  v.append(el("h2", "section-title", "Max efforts"));
  const ec = el("div", "card records");
  if (!efforts.length) {
    ec.append(el("p", "empty", "None yet. When a class has a max test, add your result in the Log WOD notes, e.g. “max burpees 1 min: 22”."));
  }
  for (const e of efforts.sort((x, y) => x.ex.localeCompare(y.ex))) {
    const row = el("div", "record");
    const left = el("div");
    const lab = el("div", "record-label");
    lab.append(moveLink(e.ex));
    left.append(lab, el("div", "stat-sub", `${fmtWindow(e.win)} · ${shortDay(e.date)} ${e.date.slice(0, 4)}`));
    const value = e.n === 1 && e.kg ? e.kg + " kg" : e.unit === "cal" ? e.n + " cal" : e.unit === "m" ? fmtInt(e.n) + " m" : e.n + " reps";
    row.append(left, el("div", "record-value", value));
    ec.append(row);
  }
  v.append(ec);

  v.append(el("h2", "section-title", "Heaviest loads"));
  const best = new Map();
  for (const a of (J.activities || []).slice().reverse()) for (const r of a.rounds || []) for (const s of r.sets) {
    if (!s.rest && s.kg && s.kg >= ((best.get(s.ex) || {}).kg || 0)) best.set(s.ex, { kg: s.kg, date: a.date.slice(0, 10) });
  }
  const list = el("div", "card records");
  if (!best.size) list.append(el("p", "empty", "No weighted movements yet."));
  [...best].sort((x, y) => y[1].kg - x[1].kg).slice(0, 10).forEach(([ex, b]) => {
    const row = el("div", "record");
    const left = el("div");
    const lab = el("div", "record-label");
    lab.append(moveLink(ex));
    left.append(lab, el("div", "stat-sub", shortDay(b.date) + " " + b.date.slice(0, 4)));
    row.append(left, el("div", "record-value", b.kg + " kg"));
    list.append(row);
  });
  v.append(list);
}

function weeklyTraining(weeks) {
  const start = new Date();
  start.setHours(12, 0, 0, 0);
  start.setDate(start.getDate() - start.getDay() - 7 * (weeks - 1)); // Sunday, weeks ago
  const buckets = Array.from({ length: weeks }, (_, k) => {
    const d = new Date(start); d.setDate(start.getDate() + 7 * k);
    return { key: iso(d), mins: { training: 0, padel: 0, run: 0, other: 0 } };
  });
  for (const a of J.activities || []) {
    const d = parseDay(a.date);
    const k = Math.floor((d - start) / (7 * 864e5));
    if (k >= 0 && k < weeks) buckets[k].mins[groupOf(a).key] += a.min || 0;
  }
  return buckets;
}

function renderTrends() {
  const v = $("view-trends");
  v.replaceChildren();
  v.append(el("h1", "large-title", "Progress"));
  renderBests(v);
  v.append(el("h2", "section-title", "Training"));
  const seg = el("div", "seg");
  for (const r of [14, 30, 90]) {
    const b = el("button", r === range ? "on" : "", r + " days");
    b.type = "button";
    b.addEventListener("click", () => { range = r; renderTrends(); });
    seg.append(b);
  }
  v.append(seg);

  const ds = dayList(range);
  const labels = ds.map((x) => x.key);
  const pick = (k) => ds.map((x) => (typeof x.v[k] === "number" ? x.v[k] : null));

  v.append(weeksChart(Math.max(4, Math.round(range / 7))));

  // Intensity of each session: average heart rate, colored by type.
  const sessions = (J.activities || []).filter((a) => a.hr && parseDay(a.date) >= parseDay(labels[0])).slice().reverse();
  if (sessions.length) {
    const byGroup = (g) => sessions.map((a) => (groupOf(a).key === g.key ? Math.round(a.hr) : null));
    const card = chartCard({
      kind: "stack", title: "Session intensity", summary: [fmtInt(avg(sessions.map((a) => a.hr))), "avg HR"],
      labels: sessions.map((a) => a.date), min: 0,
      series: GROUPS.map((g) => ({ name: g.label, cls: g.cls, values: byGroup(g) })),
      fmtAxis: (x) => Math.round(x) + "",
      xLabel: (i) => shortDay(sessions[i].date),
      tip: (i) => [Math.round(sessions[i].hr) + " bpm", `${sessions[i].name || sessions[i].label} · ${shortDay(sessions[i].date)}`],
    });
    card.append(legendFor(GROUPS.map((g) => [g.label, g.cls])));
    v.append(card);
  }

  // Most trained movements in the period (logged classes).
  const vol = new Map();
  for (const a of J.activities || []) {
    if (!a.rounds || parseDay(a.date) < parseDay(labels[0])) continue;
    for (const r of a.rounds) for (const s of r.sets) {
      if (s.rest || !s.n) continue;
      const key = s.ex + "|" + (s.unit || "reps");
      vol.set(key, (vol.get(key) || 0) + s.n);
    }
  }
  if (vol.size) {
    const card = el("div", "card");
    card.append(el("div", "chart-head"));
    card.firstChild.append(el("div", "chart-title", "Most trained movements"), el("div", "chart-sum", `last ${range} days`));
    // Reps first, then calories, then meters; each bar is scaled within its own unit.
    const unitOf = (key) => key.split("|")[1];
    const order = { reps: 0, cal: 1, m: 2 };
    const rows = [...vol].sort((a, b) => (order[unitOf(a[0])] - order[unitOf(b[0])]) || b[1] - a[1]).slice(0, 10);
    const maxBy = {};
    for (const [key, n] of rows) maxBy[unitOf(key)] = Math.max(maxBy[unitOf(key)] || 0, n);
    const list = el("div", "hbars");
    for (const [key, n] of rows) {
      const [ex, unit] = key.split("|");
      const row = el("div", "hbar");
      const bar = el("span", "hbar-fill");
      bar.style.width = Math.max(4, Math.round((n / maxBy[unit]) * 100)) + "%";
      const track = el("div", "hbar-track");
      track.append(bar);
      const lab = el("div", "hbar-label");
      lab.append(moveLink(ex));
      row.append(lab, track,
        el("div", "hbar-num", unit === "m" ? n.toLocaleString() + " m" : unit === "cal" ? n + " cal" : n.toLocaleString()));
      list.append(row);
    }
    card.append(list);
    v.append(card);
  }

  v.append(el("h2", "section-title", "Recovery"));
  const rhr = pick("rhr");
  v.append(chartCard({
    kind: "line", title: "Resting heart rate", summary: [fmtInt(avg(rhr)), "bpm avg"], labels,
    series: [{ cls: 2, values: rhr }],
    tip: (i) => (rhr[i] !== null ? [rhr[i] + " bpm", shortDay(labels[i])] : null),
  }));
  const hrv = pick("hrv");
  v.append(chartCard({
    kind: "line", title: "HRV (overnight)", summary: [fmtInt(avg(hrv)), "ms avg"], labels,
    series: [{ cls: 1, values: hrv }],
    tip: (i) => (hrv[i] !== null ? [hrv[i] + " ms", shortDay(labels[i])] : null),
  }));

  const wl = wrappedList();
  if (wl) { v.append(el("h2", "section-title", "Wrapped")); v.append(wl); }

  const other = (J.records || []).filter((r) => r.kind !== "time" && r.kind !== "distance");
  if (other.length) {
    v.append(el("h2", "section-title", "Other records"));
    v.append(recordsCard(other));
  }
}

// ---------- Sheets: full-screen workout and movement pages ----------

const sheetStack = [];

function openSheet(title, build) {
  closeSheets();
  const wrap = el("div", "sheet-wrap");
  wrap.id = "sheet";
  const back = el("div", "sheet-backdrop");
  const panel = el("div", "sheet");
  panel.setAttribute("role", "dialog");
  const head = el("div", "sheet-head");
  const grab = el("div", "sheet-grab");
  const prev = el("button", "sheet-back", "‹");
  prev.type = "button"; prev.setAttribute("aria-label", "Back");
  const name = el("div", "sheet-title");
  const close = el("button", "sheet-close", "✕");
  close.type = "button"; close.setAttribute("aria-label", "Close");
  head.append(grab, prev, name, close);
  const body = el("div", "sheet-body");
  panel.append(head, body);
  wrap.append(back, panel);
  document.body.append(wrap);
  document.body.classList.add("no-scroll");
  back.addEventListener("click", closeSheets);
  close.addEventListener("click", closeSheets);
  prev.addEventListener("click", popSheet);
  // Drag the header down to close.
  let y0 = null;
  head.addEventListener("touchstart", (e) => { y0 = e.touches[0].clientY; panel.classList.add("dragging"); }, { passive: true });
  head.addEventListener("touchmove", (e) => {
    if (y0 === null) return;
    panel.style.transform = `translateY(${Math.max(0, e.touches[0].clientY - y0)}px)`;
  }, { passive: true });
  head.addEventListener("touchend", (e) => {
    if (y0 === null) return;
    const dy = e.changedTouches[0].clientY - y0; y0 = null;
    panel.classList.remove("dragging");
    panel.style.transform = "";
    if (dy > 110) closeSheets();
  });
  pushSheet(title, build);
}

function pushSheet(title, build) {
  const w = $("sheet");
  if (!w) { openSheet(title, build); return; }
  sheetStack.push({ title, build, scroll: w.querySelector(".sheet-body").scrollTop });
  paintSheet();
}

function popSheet() {
  sheetStack.pop();
  paintSheet(true);
}

function paintSheet(restore) {
  const w = $("sheet");
  if (!w || !sheetStack.length) { closeSheets(); return; }
  const top = sheetStack[sheetStack.length - 1];
  const body = w.querySelector(".sheet-body");
  w.querySelector(".sheet-title").textContent = top.title;
  w.querySelector(".sheet-back").hidden = sheetStack.length < 2;
  body.replaceChildren(top.build());
  body.scrollTop = restore ? top.scroll || 0 : 0;
}

function closeSheets() {
  sheetStack.length = 0;
  const w = $("sheet");
  if (w) w.remove();
  if (!$("wrapped")) document.body.classList.remove("no-scroll");
}

// ---------- heart rate curve with the class's rounds ----------

const LAG_S = 15; // heart rate trails effort

/** Work and rest pieces of a logged class, in time order, with their round. */
function timeline(a) {
  const out = [];
  (a.rounds || []).forEach((r, k) => r.sets.forEach((s) => {
    if (typeof s.a === "number" && typeof s.b === "number" && s.b > s.a) out.push({ ...s, round: k });
  }));
  return out.sort((x, y) => x.a - y.a);
}

function avgHr(a, from, to) {
  if (!a.hrs) return null;
  const st = a.hrStep || 5;
  const xs = a.hrs.slice(Math.floor((from + LAG_S) / st), Math.ceil((to + LAG_S) / st)).filter((x) => typeof x === "number");
  return xs.length ? xs.reduce((p, q) => p + q, 0) / xs.length : null;
}

function hrChart(a) {
  const hrs = a.hrs, st = a.hrStep || 5;
  const card = el("div", "card");
  const vals = hrs.filter((x) => typeof x === "number");
  const peak = Math.max(...vals);
  const head = el("div", "chart-head");
  const sum = el("div", "chart-sum");
  sum.append(el("b", null, String(peak)), document.createTextNode(" max bpm"));
  head.append(el("div", "chart-title", "Heart rate"), sum);
  card.append(head);

  const tl = timeline(a);
  const hasTl = tl.length > 0;
  const Wd = 340, Hd = hasTl ? 196 : 160, L = 2, R = 30, T = 18, B = hasTl ? 62 : 22;
  const total = hrs.length * st;
  const lo = Math.max(40, Math.floor((Math.min(...vals) - 8) / 10) * 10), hi = Math.ceil((peak + 6) / 10) * 10;
  const X = (t) => L + (t / total) * (Wd - L - R);
  const Y = (b) => T + (1 - (b - lo) / (hi - lo)) * (Hd - T - B);
  const box = el("div", "chart hr-chart");
  const root = svg("svg", { viewBox: `0 0 ${Wd} ${Hd}`, role: "img", "aria-label": `Heart rate, peak ${peak} bpm` });
  box.append(root);

  // Round bands behind the curve; rests darker; setup before the WOD.
  if (hasTl) {
    if (a.setup) {
      svg("rect", { x: X(0), y: T, width: X(a.setup) - X(0), height: Hd - T - B, class: "band-setup" }, root);
      if (X(a.setup) - X(0) > 34) svg("text", { x: X(a.setup / 2), y: T - 6, class: "band-label", "text-anchor": "middle" }, root).textContent = "Setup";
    }
    const rounds = new Map();
    for (const p of tl) {
      if (p.rest) {
        svg("rect", { x: X(p.a), y: T, width: Math.max(1, X(p.b) - X(p.a)), height: Hd - T - B, class: "band-rest" + (p.sure ? "" : " unsure") }, root);
        continue;
      }
      const r = rounds.get(p.round) || { a: p.a, b: p.b };
      r.a = Math.min(r.a, p.a); r.b = Math.max(r.b, p.b);
      rounds.set(p.round, r);
    }
    [...rounds].forEach(([k, r], i) => {
      svg("rect", { x: X(r.a), y: T, width: Math.max(1, X(r.b) - X(r.a)), height: Hd - T - B, class: "band-round" + (i % 2 ? " alt" : "") }, root);
      if (X(r.b) - X(r.a) > 16) svg("text", { x: X((r.a + r.b) / 2), y: T - 6, class: "band-label", "text-anchor": "middle" }, root).textContent = "R" + (k + 1);
    });
  }

  for (const f of [0, 0.5, 1]) {
    const b = lo + (hi - lo) * f;
    svg("line", { class: "gridline", x1: L, x2: Wd - R + 4, y1: Y(b), y2: Y(b) }, root);
    svg("text", { class: "axis", x: Wd - R + 8, y: Y(b) + 3 }, root).textContent = Math.round(b);
  }

  // The curve, with a soft fill.
  const gid = "hrg" + (++avatarSeq);
  const grad = svg("linearGradient", { id: gid, x1: 0, y1: 0, x2: 0, y2: 1 }, svg("defs", {}, root));
  svg("stop", { offset: "0%", class: "hr-stop-top" }, grad);
  svg("stop", { offset: "100%", class: "hr-stop-bottom" }, grad);
  let d = "", first = null, lastX = null;
  hrs.forEach((b, i) => {
    if (typeof b !== "number") return;
    const x = X(i * st + st / 2), y = Y(b);
    d += (first === null ? "M" : "L") + x.toFixed(1) + "," + y.toFixed(1);
    if (first === null) first = x;
    lastX = x;
  });
  svg("path", { d: `${d}L${lastX},${Y(lo)}L${first},${Y(lo)}Z`, fill: `url(#${gid})` }, root);
  svg("path", { d, class: "hr-line" }, root);
  const pi = hrs.indexOf(peak);
  svg("circle", { cx: X(pi * st + st / 2), cy: Y(peak), r: 3.5, class: "hr-peak" }, root);

  // The movements under the curve; dashed edges are estimates.
  if (hasTl) {
    const y0 = Hd - B + 8, h = 24;
    for (const p of tl) {
      if (p.rest) continue;
      const x1 = X(p.a), x2 = X(p.b);
      svg("rect", { x: x1 + 0.5, y: y0, width: Math.max(1, x2 - x1 - 1), height: h, rx: 4, class: "mv-box r" + (p.round % 2) }, root);
      if (x2 - x1 > 16) {
        const t = svg("text", { x: (x1 + x2) / 2, y: y0 + 15.5, class: "mv-text", "text-anchor": "middle" }, root);
        const words = p.ex.split(" ");
        t.textContent = x2 - x1 > 54 ? (p.ex.length > 9 ? words[0].slice(0, 8) : p.ex) : p.ex.slice(0, 3);
      }
    }
    for (let k = 0; k < Math.floor(total / 300) + 1; k++) {
      const t = k * 300;
      if (t > total) break;
      svg("text", { class: "axis", x: X(t), y: Hd - 4, "text-anchor": k === 0 ? "start" : "middle" }, root).textContent = fmtMS(t);
    }
  } else {
    [0, total / 2, total].forEach((t, k) => {
      svg("text", { class: "axis", x: X(t), y: Hd - 4, "text-anchor": ["start", "middle", "end"][k] }, root).textContent = fmtMS(t);
    });
  }

  // Touch: time, bpm, round and movement.
  const cursor = svg("line", { class: "cursor", y1: T, y2: Hd - B, visibility: "hidden" }, root);
  const dot = svg("circle", { r: 5, class: "dot hr-dot", visibility: "hidden" }, root);
  const hit = svg("rect", { x: L, y: 0, width: Wd - L - R, height: Hd, fill: "transparent" }, root);
  const tip = el("div", "tip");
  tip.hidden = true;
  box.append(tip);
  const showTip = (evt) => {
    const r = root.getBoundingClientRect();
    const px = ((evt.clientX - r.left) / r.width) * Wd;
    const t = Math.max(0, Math.min(total - 1, ((px - L) / (Wd - L - R)) * total));
    const i = Math.min(hrs.length - 1, Math.floor(t / st));
    const b = hrs[i];
    if (typeof b !== "number") return;
    const x = X(i * st + st / 2);
    cursor.setAttribute("x1", x); cursor.setAttribute("x2", x); cursor.setAttribute("visibility", "visible");
    dot.setAttribute("cx", x); dot.setAttribute("cy", Y(b)); dot.setAttribute("visibility", "visible");
    const effort = t - LAG_S;
    const p = tl.find((q) => effort >= q.a && effort < q.b);
    let where = "";
    if (a.setup && effort < a.setup) where = "Setup";
    else if (p && p.rest) where = `Rest after R${p.round + 1}`;
    else if (p) where = `R${p.round + 1} · ≈ ${p.ex}`;
    tip.replaceChildren(el("b", null, b + " bpm"), document.createTextNode(`  ${fmtMS(t)}${where ? " · " + where : ""}`));
    tip.hidden = false;
    tip.style.left = Math.max(80, Math.min(r.width - 80, (x / Wd) * r.width)) + "px";
  };
  hit.addEventListener("pointermove", showTip);
  hit.addEventListener("pointerdown", showTip);
  hit.addEventListener("pointerleave", (e) => {
    if (e.pointerType !== "mouse") return;
    tip.hidden = true; cursor.setAttribute("visibility", "hidden"); dot.setAttribute("visibility", "hidden");
  });
  card.append(box);

  if (hasTl) {
    const anySure = tl.some((p) => p.rest && p.sure);
    card.append(el("p", "stat-sub hr-note", anySure
      ? "Rounds and rests are matched to your heart-rate dips. Movements inside a round are estimates."
      : "Rounds follow the class plan (no clear rests to match). Movements inside a round are estimates."));
    // Where it got hardest.
    const work = tl.filter((p) => !p.rest).map((p) => ({ p, hr: avgHr(a, p.a, p.b) })).filter((x) => x.hr);
    if (work.length) {
      const top = work.sort((x, y) => y.hr - x.hr)[0];
      const row = el("div", "hr-insight");
      row.append(el("span", "cmark", "↑"), el("span", null, `Hardest stretch: round ${top.p.round + 1}, ≈ ${top.p.ex} at ${Math.round(top.hr)} bpm`));
      card.append(row);
    }
  }
  return card;
}

// ---------- a workout ----------

function activityRow(a) {
  const g = groupOf(a);
  const row = el("button", "card act-row");
  row.type = "button";
  const badge = el("div", "badge g" + g.cls);
  const icon = svg("svg", { viewBox: "0 0 24 24", "aria-hidden": "true" }, null);
  for (const d of ICONS[g.key]) svg("path", { d }, icon);
  badge.append(icon);
  const main = el("div", "act-main");
  main.append(el("div", "act-title", a.name || a.label));
  const when = new Date(a.date.replace(" ", "T"));
  main.append(el("div", "act-meta", [a.label, when.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }),
    Math.round(a.min) + " min", a.kcal ? Math.round(a.kcal) + " kcal" : null].filter(Boolean).join(" · ")));
  row.append(badge, main, el("span", "chev", "›"));
  row.addEventListener("click", () => openActivity(a));
  return row;
}

function openActivity(a) {
  const title = a.name || a.label;
  if ($("sheet")) pushSheet(title, () => activityView(a)); else openSheet(title, () => activityView(a));
}

function moveLink(name, cls) {
  const b = el("button", "move-link" + (cls ? " " + cls : ""), name);
  b.type = "button";
  b.addEventListener("click", (e) => { e.stopPropagation(); openMovement(name); });
  return b;
}

function activityView(a) {
  const v = el("div");
  const when = new Date(a.date.replace(" ", "T"));
  v.append(el("p", "eyebrow", `${a.label} · ${when.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" })} · ${when.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`));
  const kv = el("div", "kv");
  const pair = (b, s) => { const d = el("div"); d.append(el("b", null, b), el("span", null, s)); kv.append(d); };
  pair(fmtMS(a.min * 60), "Time");
  pair(a.kcal ? Math.round(a.kcal) : "–", "kcal");
  pair(a.hr ? Math.round(a.hr) : "–", "Avg HR");
  pair(a.hrMax ? Math.round(a.hrMax) : "–", "Max HR");
  pair(a.te ? a.te.toFixed(1) : "–", "Aerobic TE");
  pair(a.km ? a.km.toFixed(2) + " km" : a.teAn ? a.teAn.toFixed(1) : "–", a.km ? "Distance" : "Anaerobic TE");
  const statCard = el("div", "card"); statCard.append(kv);
  v.append(statCard);

  const worked = sessionBodyCard(a);
  if (worked) v.append(worked);
  const engine = engineCard(a);
  if (engine) v.append(engine);

  if (a.hrs && a.hrs.some((x) => typeof x === "number")) v.append(hrChart(a));

  const review = ((J.coach || {}).workouts || {})[String(a.id)];
  if (review) {
    const c = el("div", "card");
    const head = el("div", "chip-who");
    head.append(coachAvatar("normal", 28), el("span", "tile-label", "Coach review"));
    c.append(head, el("div", "coach-headline", review.headline), vsRecent(a), items(review.points));
    v.append(c);
  }

  if (a.rounds && a.rounds.length) {
    const c = el("div", "card");
    c.append(el("div", "chart-title", "Rounds"));
    const ol = el("ol", "rounds");
    for (const r of a.rounds) {
      const li = el("li", "round");
      li.append(el("div", "round-time", fmtMS(r.sec)));
      const ul = el("ul", "sets");
      for (const s of r.sets) {
        if (s.rest) { ul.append(el("li", "set rest", "Rest " + fmtMS(s.sec))); continue; }
        const row = el("li", "set");
        const left = el("span");
        left.append(moveLink(s.ex));
        if (s.kg) left.append(document.createTextNode(` · ${s.kg} kg`));
        const hr = typeof s.a === "number" ? avgHr(a, s.a, s.b) : null;
        const right = el("span", "amt", setAmount(s));
        if (hr) right.append(el("small", "set-hr", ` ${Math.round(hr)} bpm`));
        row.append(left, right);
        ul.append(row);
      }
      li.append(ul);
      ol.append(li);
    }
    c.append(ol);
    v.append(c);
  }

  if (a.notes) {
    const c = el("div", "card notes");
    for (const line of a.notes.split("\n")) if (line.trim()) c.append(el("p", null, line));
    v.append(c);
  }
  const link = el("a", "garmin", "Open in Garmin Connect");
  link.href = "https://connect.garmin.com/modern/activity/" + encodeURIComponent(String(a.id));
  link.rel = "noopener noreferrer";
  link.target = "_blank";
  v.append(link);
  return v;
}

// ---------- a movement ----------

function movementSessions(name) {
  const out = [];
  for (const a of J.activities || []) {
    const sets = [];
    for (const r of a.rounds || []) for (const s of r.sets) if (!s.rest && s.ex === name) sets.push(s);
    if (!sets.length) continue;
    const units = {};
    for (const s of sets) units[s.unit || "reps"] = (units[s.unit || "reps"] || 0) + (s.n || 0);
    const kg = Math.max(0, ...sets.map((s) => s.kg || 0)) || null;
    const timed = sets.filter((s) => typeof s.a === "number");
    let hr = null;
    if (a.hrs && timed.length) {
      let sum = 0, w = 0;
      for (const s of timed) { const h = avgHr(a, s.a, s.b); if (h) { sum += h * (s.b - s.a); w += s.b - s.a; } }
      hr = w ? sum / w : null;
    }
    out.push({ a, units, kg, hr, sec: timed.reduce((p, s) => p + (s.b - s.a), 0) });
  }
  return out; // newest first
}

function openMovement(name) {
  if ($("sheet")) pushSheet(name, () => movementView(name)); else openSheet(name, () => movementView(name));
}

function movementView(name) {
  const v = el("div");
  const ses = movementSessions(name);
  if (!ses.length) { v.append(el("p", "empty", "No logged sets of this movement yet.")); return v; }
  const totals = {};
  for (const s of ses) for (const [u, n] of Object.entries(s.units)) totals[u] = (totals[u] || 0) + n;
  const fmtU = (u, n) => (u === "m" ? fmtInt(n) + " m" : u === "cal" ? fmtInt(n) + " cal" : fmtInt(n));
  const mainU = Object.keys(totals).sort((x, y) => totals[y] - totals[x])[0];
  const best = ses.filter((s) => s.kg).sort((x, y) => y.kg - x.kg)[0];

  const kv = el("div", "kv");
  const pair = (b, s) => { const d = el("div"); d.append(el("b", null, b), el("span", null, s)); kv.append(d); };
  pair(fmtU(mainU, totals[mainU]), mainU === "reps" ? "total reps" : "total");
  pair(String(ses.length), ses.length === 1 ? "session" : "sessions");
  pair(best ? best.kg + " kg" : "–", "best load");
  const c0 = el("div", "card");
  const amount = (x) => Object.entries(x.units).filter(([, n]) => n).map(([u, n]) => fmtU(u, n) + (u === "reps" ? " reps" : "")).join(" + ") || "–";
  c0.append(kv, el("p", "stat-sub mv-last", `Last done ${shortDay(ses[0].a.date)} · ${amount(ses[0])}${ses[0].kg ? " @ " + ses[0].kg + " kg" : ""}`));
  v.append(c0);

  const old = ses.slice().reverse(); // oldest first for charts
  const labels = old.map((s) => s.a.date.slice(0, 10));
  const xl = (i) => shortDay(labels[i]);

  // Heart rate while doing it: the engine signal.
  const hrs = old.map((s) => (s.hr ? Math.round(s.hr) : null));
  if (hrs.filter((x) => x).length >= 1) {
    const card = chartCard({
      kind: "line", title: "Heart rate during " + name, summary: [fmtInt(avg(hrs)), "bpm avg"], labels,
      series: [{ cls: 2, values: hrs }], xLabel: xl,
      tip: (i) => (hrs[i] ? [hrs[i] + " bpm", xl(i)] : null),
    });
    const known = hrs.filter((x) => x);
    if (known.length >= 2) {
      const last = known[known.length - 1], before = avg(known.slice(0, -1));
      const diff = Math.round(last - before);
      const trend = known.length >= 3;   // one comparison isn't a trend
      card.append(el("div", "hr-insight", Math.abs(diff) < 2 ? "≈ Same heart rate as before." :
        diff < 0 ? (trend ? `▼ ${-diff} bpm lower than your earlier sessions: your engine is handling it better.` : `▼ ${-diff} bpm lower than last time.`)
          : (trend ? `▲ ${diff} bpm higher than before: a harder pace, or a tired day.` : `▲ ${diff} bpm higher than last time.`)));
    }
    v.append(card);
  }

  const kgs = old.map((s) => s.kg);
  if (kgs.some((x) => x)) {
    v.append(chartCard({
      kind: "line", title: "Load", summary: [best.kg + " kg", "best"], labels, series: [{ cls: 1, values: kgs }], xLabel: xl,
      tip: (i) => (kgs[i] ? [kgs[i] + " kg", xl(i)] : null),
    }));
  }
  const vol = old.map((s) => s.units[mainU] || null);
  if (vol.filter((x) => x).length) v.append(chartCard({
    kind: "bar", title: mainU === "reps" ? "Reps per session" : mainU === "m" ? "Meters per session" : "Calories per session",
    summary: [fmtU(mainU, Math.round(avg(vol))), "avg"], labels, series: [{ cls: 3, values: vol }], xLabel: xl,
    tip: (i) => (vol[i] ? [fmtU(mainU, vol[i]), xl(i)] : [amount(old[i]), xl(i)]),
  }));

  v.append(el("h2", "section-title", "Sessions"));
  for (const s of ses) v.append(activityRow(s.a));
  return v;
}

// ---------- Home: today hero and what's new ----------

let lastSeen = null;       // when the journal was last opened, from this device
let whatsNewHidden = false;

function rememberVisit() {
  try {
    const prev = Number(localStorage.getItem("journal.seen")) || 0;
    if (lastSeen === null) lastSeen = prev;
    localStorage.setItem("journal.seen", String(Date.now()));   // only a time, nothing from the journal
  } catch { if (lastSeen === null) lastSeen = 0; }
}

function localStamp(ms) {
  const d = new Date(ms);
  return `${iso(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function whatsNew() {
  if (!lastSeen) return [];
  const since = localStamp(lastSeen);
  const out = [];
  for (const a of J.activities || []) {
    const nm = a.name || a.label;
    if (a.date.replace(" ", "T") > since) out.push([/^\p{Extended_Pictographic}/u.test(nm) ? "" : "🏋️", nm, () => openActivity(a)]);
  }
  const c = J.coach || {};
  if (c.daily && (c.daily.written || "") > since) out.push(["💬", "Coach brief", () => show("coach")]);
  for (const a of J.activities || []) {
    const r = (c.workouts || {})[String(a.id)];
    if (r && (r.written || "") > since) out.push(["📝", "Review: " + (a.name || a.label), () => openActivity(a)]);
  }
  if (c.weekly && (c.weekly.written || "") > since) out.push(["📅", "Weekly review", () => show("coach")]);
  for (const [icon, title, , date] of highlights()) if (date >= since.slice(0, 10)) out.push([icon, title, () => show("trends")]);
  return out.slice(0, 8);
}

function whatsNewStrip() {
  const list = whatsNew();
  if (!list.length || whatsNewHidden) return null;
  const box = el("div", "new-strip");
  const head = el("div", "new-head");
  const x = el("button", "new-x", "✕");
  x.type = "button"; x.setAttribute("aria-label", "Hide");
  x.addEventListener("click", () => { whatsNewHidden = true; box.remove(); });
  head.append(el("span", "tile-label", "New since you last looked"), x);
  const row = el("div", "new-row");
  for (const [icon, text, go] of list) {
    const b = el("button", "new-chip", icon ? `${icon} ${text}` : text);
    b.type = "button";
    b.addEventListener("click", go);
    row.append(b);
  }
  box.append(head, row);
  return box;
}

function heroCard() {
  const now = new Date();
  const c = J.coach || {};
  const daily = c.daily && c.daily.date === iso(now) ? c.daily : null;
  const card = el("button", "card hero");
  card.type = "button";
  card.addEventListener("click", () => show("coach"));
  const top = el("div", "hero-top");
  const who = el("span", "chip-who");
  who.append(coachAvatar(daily ? daily.call : "normal", 40), el("span", "tile-label", "Today"));
  top.append(who);
  if (daily) { const [cls, text] = CALLS[daily.call] || ["good", ""]; top.append(el("span", "call " + cls, text)); }
  card.append(top);
  card.append(el("div", "hero-headline", daily ? daily.headline : "Your coach writes once last night's sleep has synced."));

  const days = dayList(3).reverse();
  const month = dayList(31).slice(0, 30).map((x) => x.v);
  const rd = days.find((x) => typeof x.v.ready === "number");
  const sl = days.find((x) => x.v.sleep && x.v.sleep.sec);
  const hv = days.find((x) => typeof x.v.hrv === "number");
  const hrvAvg = avg(month.map((d) => d.hrv));
  const st = rd ? readinessStatus(rd.v.readyLevel, rd.v.ready) : null;
  const stats = el("div", "hero-stats");
  const cell = (label, value, sub, cls) => {
    const d = el("div");
    d.append(el("b", null, value), el("span", null, label));
    if (sub) d.append(el("em", cls || "", sub));
    stats.append(d);
  };
  cell("Readiness", rd ? String(rd.v.ready) : "–", st && st.text, st && st.cls);
  cell("Sleep", sl ? fmtHM(sl.v.sleep.sec) : "–", sl && sl.v.sleep.score ? "score " + sl.v.sleep.score : null);
  cell("HRV", hv ? hv.v.hrv + " ms" : "–", hv && hrvAvg ? (hv.v.hrv >= hrvAvg ? "▲ above avg" : "▼ below avg") : null,
    hv && hrvAvg ? (hv.v.hrv >= hrvAvg ? "good" : "warning") : null);
  card.append(stats);
  if (daily && daily.plan) card.append(el("div", "hero-plan", "Plan · " + planText(daily.plan)));
  return card;
}

// ---------- Body: which muscles are loaded right now ----------
// Same numbers as muscles.py: minutes of work per muscle, fading by half every ~25 hours.

const MUSCLE_NAMES = {
  QUADS: "Quads", HAMSTRINGS: "Hamstrings", GLUTES: "Glutes", CALVES: "Calves", HIPS: "Hip flexors",
  ADDUCTORS: "Adductors", ABDUCTORS: "Abductors", ABS: "Abs", OBLIQUES: "Obliques", LOWER_BACK: "Lower back",
  LATS: "Lats", TRAPS: "Traps", SHOULDERS: "Shoulders", CHEST: "Chest", BICEPS: "Biceps", TRICEPS: "Triceps",
  FOREARM: "Forearms",
};
const LEVELS = [["fresh", "Fresh"], ["light", "Light"], ["worked", "Worked"], ["fried", "Fried"]];
const levelOf = (m) => (m >= 12 ? "fried" : m >= 6 ? "worked" : m >= 2 ? "light" : "fresh");

/** {muscle: {load, by: Map(source -> minutes), last, sore}} for now. */
function muscleState() {
  const now = Date.now();
  const out = {};
  const add = (m, minutes, src, date) => {
    const o = out[m] || (out[m] = { load: 0, by: new Map(), last: null, sore: false, d14: 0 });
    o.load += minutes;
    o.by.set(src, (o.by.get(src) || 0) + minutes);
    if (!o.last || date > o.last) o.last = date;
  };
  for (const a of J.activities || []) {
    const ageH = (now - new Date(a.date.replace(" ", "T")).getTime()) / 36e5;
    if (ageH < 0 || ageH > 24 * 14) continue;
    const fade = Math.pow(0.5, ageH / 25);
    const pieces = [];
    for (const r of a.rounds || []) for (const s of r.sets) {
      if (s.rest || !s.mp) continue;
      const sec = typeof s.a === "number" && typeof s.b === "number" ? s.b - s.a : 45;
      pieces.push([s.mp, s.ms || [], sec / 60, s.ex]);
    }
    if (!pieces.length && a.mus) pieces.push([a.mus[0], a.mus[1], (a.min || 0) * a.mus[2], a.name || a.label]);
    for (const [main, sup, min, src] of pieces) {
      for (const m of main) { add(m, ageH <= 240 ? min * fade : 0, src, a.date); out[m].d14 += min; }
      for (const m of sup) { add(m, ageH <= 240 ? min * 0.4 * fade : 0, src, a.date); out[m].d14 += min * 0.4; }
    }
    if (ageH <= 72) for (const m of a.sore || []) (out[m] || (out[m] = { load: 0, by: new Map(), last: a.date, sore: false, d14: 0 })).sore = true;
  }
  return out;
}

// Anatomical figures: muscle outlines from react-body-highlighter (data only, embedded), smoothed into curves.
/*
MIT License

Copyright (c) 2020 GV79

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/
const ANATOMY = {"front":[["CHEST",[51.8,41.6,51.0,55.1,58.0,58.0,67.8,55.5,70.6,47.3,62.0,41.6]],["CHEST",[29.8,46.5,31.4,55.5,40.8,58.0,48.2,55.1,47.8,42.0,37.6,42.0]],["OBLIQUES",[68.6,63.3,67.3,57.1,58.8,59.6,60.0,64.1,60.4,83.3,65.7,78.8,66.5,69.8]],["OBLIQUES",[33.9,78.4,33.1,71.8,31.0,63.3,32.2,57.1,40.8,59.2,39.2,63.3,39.2,83.7]],["ABS",[56.3,59.2,58.0,64.1,58.4,78.0,58.4,92.7,56.3,98.4,55.1,104.1,51.4,107.8,51.0,84.5,50.6,67.3,51.0,57.1]],["ABS",[43.7,58.8,48.6,57.1,49.0,67.3,48.6,84.5,48.2,107.3,44.5,103.7,40.8,91.4,40.8,78.4,41.2,64.5]],["BICEPS",[16.7,68.2,18.0,71.4,22.9,66.1,29.0,53.9,27.8,49.4,20.4,55.9]],["BICEPS",[71.4,49.4,70.2,54.7,76.3,66.1,81.6,71.8,82.9,69.0,78.8,55.5]],["TRICEPS",[69.4,55.5,69.4,61.6,75.9,72.7,77.6,70.2,75.5,67.3]],["TRICEPS",[22.4,69.4,29.8,55.5,29.8,60.8,22.9,73.1]],[null,[55.5,23.7,50.6,33.5,50.6,39.2,61.6,40.0,70.6,44.9,69.4,36.7,63.3,35.1,58.4,30.6]],[null,[29.0,44.9,30.2,37.1,36.3,35.1,41.2,30.2,44.5,24.5,49.0,33.9,48.6,39.2,38.0,39.6]],["SHOULDERS",[78.4,53.1,79.6,47.8,79.2,41.2,75.9,38.0,71.0,36.3,72.2,42.9,71.4,47.3]],["SHOULDERS",[28.2,47.3,21.2,53.1,20.0,47.8,20.4,40.8,24.5,37.1,28.6,37.1,26.9,43.3]],[null,[42.4,2.9,40.0,11.8,42.0,19.6,46.1,23.3,49.8,25.3,54.7,22.4,57.6,19.2,59.2,10.2,57.1,2.4,49.8,0.0]],["ADDUCTORS",[52.7,110.2,54.3,124.9,60.0,110.2,62.0,100.0,64.9,94.3,60.0,92.7,56.7,104.5]],["ADDUCTORS",[47.8,110.6,44.9,125.3,42.0,115.9,40.4,113.1,39.6,107.3,38.0,102.4,34.7,93.9,39.6,92.2,41.6,99.2,43.7,105.3]],["QUADS",[34.7,98.8,37.1,108.2,37.1,127.8,34.3,137.1,31.0,132.7,29.4,120.0,28.2,111.4,29.4,100.8,32.2,94.7]],["QUADS",[63.3,105.7,64.5,100.0,66.9,94.7,70.2,101.2,71.0,111.8,68.2,133.1,65.3,137.6,62.4,128.6,62.0,111.4]],["QUADS",[38.8,129.4,38.4,112.2,41.2,118.4,44.5,129.4,42.9,135.1,40.0,146.1,36.3,146.5,35.5,140.0]],["QUADS",[59.6,145.7,55.5,129.0,60.8,113.9,61.2,130.2,64.1,139.6,62.9,146.5]],["QUADS",[32.7,138.4,26.5,145.7,25.7,136.7,25.7,127.3,26.9,114.3,29.4,133.5]],["QUADS",[71.8,113.1,73.9,124.1,73.9,140.4,72.7,145.7,66.5,138.4,70.2,133.5]],[null,[33.9,140.0,34.7,143.3,35.5,147.3,36.3,151.0,35.1,156.7,29.8,156.7,27.3,152.7,27.3,147.3,30.2,144.1]],[null,[65.7,140.0,72.2,147.8,72.2,152.2,69.8,157.1,64.9,156.7,62.9,151.0]],["CALVES",[71.4,160.4,73.5,153.5,76.7,161.2,79.6,167.8,78.4,187.8,79.6,195.5,74.7,195.5]],["CALVES",[24.9,194.7,27.8,164.9,28.2,160.4,26.1,154.3,24.9,157.6,22.4,161.6,20.8,167.8,22.0,188.2,20.8,195.5]],["CALVES",[72.7,195.1,69.8,159.2,65.3,158.4,64.1,162.4,64.1,165.3,65.7,177.1]],["CALVES",[35.5,158.4,35.9,162.4,35.9,166.9,35.1,172.2,35.1,176.7,32.2,182.0,30.6,187.3,26.9,194.7,27.3,187.8,28.2,180.4,28.6,175.5,29.0,169.8,29.8,164.1,30.2,158.8]],["FOREARM",[6.1,88.6,10.2,75.1,14.7,70.2,16.3,74.3,19.2,73.5,4.5,97.6,0.0,100.0]],["FOREARM",[84.5,69.8,83.3,73.5,80.0,73.1,95.1,98.4,100.0,100.4,93.5,89.4,89.8,76.3]],["FOREARM",[77.6,72.2,77.6,77.6,80.4,84.1,85.3,89.8,92.2,101.2,94.7,99.6]],["FOREARM",[6.9,101.2,13.5,90.6,18.8,84.1,21.6,77.1,21.2,71.8,4.9,98.8]]],"back":[[null,[50.6,0.0,46.0,0.9,40.9,5.5,40.4,12.8,45.1,20.0,55.7,20.0,59.1,13.6,59.6,4.7,55.7,1.3]],["TRAPS",[44.7,21.7,47.7,21.7,47.2,38.3,47.7,64.7,38.3,53.2,35.3,40.9,31.1,36.6,39.1,33.2,43.8,27.2]],["TRAPS",[52.3,21.7,55.7,21.7,56.6,27.2,60.9,32.8,68.9,36.6,64.7,40.4,61.7,53.2,52.3,64.7,53.2,38.3]],["SHOULDERS",[29.4,37.0,23.0,39.1,17.4,44.3,18.3,53.6,24.3,49.4,27.2,46.4]],["SHOULDERS",[71.1,37.0,78.3,39.6,82.6,44.7,81.7,53.6,74.9,48.9,72.3,45.1]],["LATS",[31.1,38.7,28.1,48.9,28.5,55.3,34.0,75.3,47.2,71.1,47.2,66.4,36.6,54.0,33.6,41.3]],["LATS",[68.9,38.7,71.9,49.4,71.5,56.2,66.0,75.3,52.8,71.1,52.8,66.4,63.4,54.5,66.4,41.7]],["TRICEPS",[26.8,49.8,17.9,55.7,14.5,72.3,16.6,81.7,21.7,63.8,26.8,55.7]],["TRICEPS",[73.6,50.2,82.1,55.7,86.0,73.2,83.4,82.1,77.9,63.0,73.2,55.7]],["TRICEPS",[26.8,58.3,26.8,68.5,23.0,75.3,19.1,77.4,22.6,65.5]],["TRICEPS",[72.8,58.3,77.0,64.7,80.4,77.4,76.6,75.3,72.8,68.9]],["LOWER_BACK",[47.7,72.8,34.5,77.0,35.3,83.4,49.4,102.1,46.8,83.0]],["LOWER_BACK",[52.3,72.8,65.5,77.0,64.7,83.4,50.6,102.1,53.2,83.8]],["FOREARM",[86.4,75.7,91.1,83.4,93.2,94.0,100.0,106.4,96.2,104.3,88.1,89.4,84.3,83.8]],["FOREARM",[13.6,75.7,8.9,83.8,6.8,93.6,0.0,106.4,3.8,104.3,12.3,88.5,15.7,83.0]],["FOREARM",[81.3,79.6,77.4,77.9,79.1,84.7,91.1,103.8,93.2,108.9,94.5,104.7]],["FOREARM",[18.7,79.6,22.1,77.9,20.9,84.3,9.4,103.0,6.8,108.5,5.1,104.7]],["GLUTES",[44.7,99.6,30.2,108.5,29.8,118.7,31.5,126.0,47.2,121.3,49.4,114.9]],["GLUTES",[55.3,99.1,51.1,114.5,52.3,120.9,68.1,126.0,69.8,119.1,69.4,108.5]],["ABDUCTORS",[48.1,123.0,44.7,123.0,41.3,125.5,45.1,144.3,48.5,135.7,48.9,129.4]],["ABDUCTORS",[51.9,122.6,55.7,123.4,59.1,126.0,54.9,144.3,51.9,136.2,51.1,129.4]],["HAMSTRINGS",[28.9,122.1,31.1,129.4,36.6,126.0,35.3,135.3,34.5,150.2,29.4,158.3,28.9,146.8,27.7,141.3,27.2,131.5]],["HAMSTRINGS",[71.5,121.7,69.4,128.9,63.8,126.0,65.5,136.6,66.4,150.2,71.1,158.3,71.5,147.7,72.8,142.1,73.6,131.9]],["HAMSTRINGS",[38.7,125.5,44.3,146.0,40.4,166.8,36.2,152.8,37.0,135.3]],["HAMSTRINGS",[61.7,125.5,63.4,136.2,64.3,153.2,60.0,166.8,56.2,146.4]],[null,[34.5,153.2,31.1,159.1,33.6,166.4,37.4,162.6]],[null,[66.4,153.6,63.0,163.0,66.8,166.4,69.4,159.1]],["CALVES",[29.4,160.4,28.5,167.2,24.7,179.6,23.8,192.8,25.5,197.0,28.5,193.2,29.8,180.0,31.9,171.1,31.9,166.8]],["CALVES",[37.4,165.1,35.3,167.7,33.2,171.9,31.1,180.4,30.2,191.9,34.0,200.0,38.7,190.6,39.1,168.9]],["CALVES",[63.0,165.1,61.3,168.5,61.7,190.6,66.4,199.6,70.6,191.9,68.9,179.6,66.8,170.2]],["CALVES",[70.6,160.4,72.3,168.5,75.7,179.1,76.6,192.8,74.5,196.6,72.3,193.6,70.6,179.6,68.1,168.1]],["CALVES",[28.5,195.7,30.2,195.7,33.6,201.7,30.6,220.0,28.5,213.6,26.8,198.3]],["CALVES",[69.8,195.7,71.9,195.7,73.6,198.3,71.9,213.2,70.2,219.6,67.2,202.1]]]};

/** A closed, smooth path through [x, y, x, y, ...] (Catmull-Rom, slightly tightened). */
function smoothFlat(flat) {
  const pts = [];
  for (let k = 0; k < flat.length; k += 2) pts.push([flat[k], flat[k + 1]]);
  const n = pts.length, t = 0.7 / 6;
  let d = `M${pts[0][0]},${pts[0][1]}`;
  for (let i = 0; i < n; i++) {
    const p0 = pts[(i - 1 + n) % n], p1 = pts[i], p2 = pts[(i + 1) % n], p3 = pts[(i + 2) % n];
    d += `C${(p1[0] + (p2[0] - p0[0]) * t).toFixed(1)},${(p1[1] + (p2[1] - p0[1]) * t).toFixed(1)} ` +
      `${(p2[0] - (p3[0] - p1[0]) * t).toFixed(1)},${(p2[1] - (p3[1] - p1[1]) * t).toFixed(1)} ${p2[0]},${p2[1]}`;
  }
  return d + "Z";
}

function figure(side, state, onPick) {
  const shapes = ANATOMY[side].map(([m, flat]) => [m, smoothFlat(flat)]);
  const root = svg("svg", { viewBox: side === "front" ? "-6 -6 112 210" : "-6 -6 112 234", class: "body-fig", role: "img", "aria-label": side === "front" ? "Front" : "Back" });
  // The silhouette: every shape drawn with a thick outline, then again to hide the inner lines.
  for (const [, d] of shapes) svg("path", { d, class: "sil-edge" }, root);
  for (const [, d] of shapes) svg("path", { d, class: "sil-fill" }, root);
  for (const [m, d] of shapes) {
    if (!m) continue;
    const st = state[m];
    const lv = st ? levelOf(st.load) : "fresh";
    const node = svg("path", { d, class: `mus lv-${lv}${st && st.sore ? " sore" : ""}`, "data-m": m }, root);
    node.addEventListener("click", () => onPick(m));
  }
  return root;
}

function bodyCard() {
  const state = muscleState();
  const card = el("div", "card body-card");
  const head = el("div", "chart-head");
  head.append(el("div", "chart-title", "Body · right now"), el("div", "chart-sum", "tap a muscle"));
  card.append(head);
  const figs = el("div", "body-figs");
  const pick = (m) => openSheet(MUSCLE_NAMES[m] || m, () => muscleView(m));
  for (const side of ["front", "back"]) {
    const col = el("div", "body-col");
    col.append(figure(side, state, pick), el("span", "body-side", side === "front" ? "Front" : "Back"));
    figs.append(col);
  }
  card.append(figs);
  const lg = el("div", "legend body-legend");
  for (const [lv, name] of LEVELS) { const it = el("span"); it.append(el("i", "lv-" + lv), document.createTextNode(name)); lg.append(it); }
  const so = el("span"); so.append(el("i", "lv-sore"), document.createTextNode("Sore")); lg.append(so);
  card.append(lg);

  const loaded = Object.entries(state).filter(([, s]) => s.load >= 6).sort((a, b) => b[1].load - a[1].load).map(([m]) => MUSCLE_NAMES[m]);
  const idle = Object.keys(MUSCLE_NAMES).filter((m) => !state[m] || state[m].d14 < 1).map((m) => MUSCLE_NAMES[m]);
  const notes = el("div", "body-notes");
  if (loaded.length) notes.append(el("p", null, "🔥 Most loaded: " + loaded.slice(0, 5).join(", ") + (loaded.length > 5 ? ` +${loaded.length - 5}` : "")));
  if (idle.length) notes.append(el("p", null, "💤 Not trained in 2 weeks: " + idle.join(", ")));
  card.append(notes);
  return card;
}

function muscleView(m) {
  const state = muscleState()[m] || { load: 0, by: new Map(), last: null, sore: false, d14: 0 };
  const v = el("div");
  const lv = levelOf(state.load);
  const top = el("div", "card");
  const kv = el("div", "kv");
  const pair = (b, s) => { const d = el("div"); d.append(el("b", null, b), el("span", null, s)); kv.append(d); };
  pair(LEVELS.find((x) => x[0] === lv)[1], "right now");
  pair(recoverShort(state.load), "to recover");
  pair(state.last ? shortDay(state.last) : "–", "last worked");
  top.append(kv);
  if (state.sore) top.append(el("p", "stat-sub mv-last", "🩹 You noted soreness here in the last 3 days."));
  const bar = el("div", "lv-bar");
  const fill = el("span", "lv-" + lv);
  fill.style.width = Math.min(100, Math.round((state.load / 16) * 100)) + "%";
  bar.append(fill);
  top.append(bar, el("p", "stat-sub mv-last", recoverSentence(state.load)));
  v.append(top);

  const sources = muscleContributors(m);
  if (sources.length) {
    v.append(el("h2", "section-title", "Where the load comes from"));
    const card = el("div", "card src-list");
    const total = sources.reduce((s, o) => s + o.load, 0) || 1;
    const top = sources.slice(0, 7), rest = sources.slice(7);
    const roundedTop = top.map((o) => Math.round((o.load / total) * 100));
    const addRow = (labelNode, sub, pct) => {
      const row = el("div", "src-row");
      const head = el("div", "src-head");
      head.append(labelNode, el("span", "src-pct", pct + "%"));
      const track = el("div", "src-track");
      const fill = el("span", "src-fill");
      fill.style.width = Math.max(3, pct) + "%";
      track.append(fill);
      row.append(head, track);
      if (sub) row.append(el("div", "src-sub", sub));
      card.append(row);
    };
    top.forEach((o, i) => {
      const label = o.isMove ? moveLink(o.src) : el("span", "src-name", o.src);
      addRow(label, [contribFact(o), ago(o.last)].filter(Boolean).join(" · "), roundedTop[i]);
    });
    if (rest.length) {
      const othersPct = Math.max(0, 100 - roundedTop.reduce((a, b) => a + b, 0));
      addRow(el("span", "src-name", "Others"), rest.length + (rest.length === 1 ? " movement" : " movements"), othersPct);
    }
    v.append(card);
  } else {
    v.append(el("p", "empty", "Nothing has worked this muscle in the last 10 days."));
  }
  const acts = (J.activities || []).filter((a) => (a.rounds || []).some((r) => r.sets.some((s) => (s.mp || []).includes(m) || (s.ms || []).includes(m)))
    || (a.mus && (a.mus[0].includes(m) || a.mus[1].includes(m)))).slice(0, 6);
  if (acts.length) {
    v.append(el("h2", "section-title", "Recent sessions"));
    for (const a of acts) v.append(activityRow(a));
  }
  return v;
}

function recoverHours(load) {
  return load < 2 ? 0 : 25 * Math.log2(load / 2);
}

function recoverShort(load) {
  if (load < 2) return "–";
  const h = recoverHours(load);
  return h < 3 ? "Soon" : h < 36 ? "~1 day" : "~" + Math.round(h / 24) + " days";
}

function recoverSentence(load) {
  if (load < 2) return "Recovered — ready to train.";
  const h = recoverHours(load);
  if (h < 2) return "Almost recovered.";
  const t = new Date(Date.now() + h * 3600e3);
  const part = partOfDay(t.getHours());
  const d0 = new Date(); d0.setHours(0, 0, 0, 0);
  const d1 = new Date(t); d1.setHours(0, 0, 0, 0);
  const days = Math.round((d1 - d0) / 864e5);
  const when = days <= 0 ? "later this " + part
    : days === 1 ? "tomorrow " + part
    : days < 7 ? t.toLocaleDateString(undefined, { weekday: "short" }) + " " + part
    : "in about " + Math.round(h / 24) + " days";
  return "Fresh again " + when + ".";
}

function ago(dateStr) {
  const days = Math.round((parseDay(iso(new Date())) - parseDay(dateStr)) / 864e5);
  return days <= 0 ? "today" : days === 1 ? "yesterday" : days + " days ago";
}

function contribFact(o) {
  const parts = [];
  if (o.reps) parts.push("×" + fmtInt(o.reps));
  if (o.cal) parts.push(fmtInt(o.cal) + " cal");
  if (o.dist) parts.push(fmtInt(o.dist) + " m");
  if (o.min) parts.push(fmtInt(o.min) + " min");
  return parts.join(" + ");
}

/** Each source's share of one muscle's current load: weighted, faded minutes for the ranking; the real amount done for the label. */
function muscleContributors(m) {
  const now = Date.now();
  const by = new Map();
  const get = (src, isMove) => {
    let o = by.get(src);
    if (!o) { o = { src, isMove, load: 0, reps: 0, cal: 0, dist: 0, min: 0, last: null }; by.set(src, o); }
    return o;
  };
  for (const a of J.activities || []) {
    const ageH = (now - new Date(a.date.replace(" ", "T")).getTime()) / 36e5;
    if (ageH < 0 || ageH > 24 * 10) continue;
    const fade = Math.pow(0.5, ageH / 25);
    let anyMp = false;
    for (const r of a.rounds || []) for (const sset of r.sets) {
      if (sset.rest || !sset.mp) continue;
      anyMp = true;
      const isMain = sset.mp.includes(m), isSup = (sset.ms || []).includes(m);
      if (!isMain && !isSup) continue;
      const sec = typeof sset.a === "number" && typeof sset.b === "number" ? sset.b - sset.a : 45;
      const o = get(sset.ex, true);
      o.load += (sec / 60) * (isMain ? 1 : 0.4) * fade;
      if (sset.n) o[sset.unit === "m" ? "dist" : sset.unit === "cal" ? "cal" : "reps"] += sset.n;
      if (!o.last || a.date > o.last) o.last = a.date;
    }
    if (!anyMp && a.mus) {
      const [main, sup, factor] = a.mus;
      const isMain = main.includes(m), isSup = sup.includes(m);
      if (isMain || isSup) {
        const o = get(a.name || a.label, false);
        o.load += (a.min || 0) * factor * (isMain ? 1 : 0.4) * fade;
        o.min += a.min || 0;
        if (!o.last || a.date > o.last) o.last = a.date;
      }
    }
  }
  return [...by.values()].filter((o) => o.load > 0.05).sort((x, y) => y.load - x.load);
}

function isMove(name) {
  return (J.activities || []).some((a) => (a.rounds || []).some((r) => r.sets.some((s) => s.ex === name)));
}

/** Muscles worked in ONE session (not faded): m -> {work, moves}, and move -> {main, sup}. */
const HEART_PATH = "M0,2.5 C0,0.5 -2.2,-2 -5,-2 C-8.5,-2 -9,2 -9,3.2 C-9,6.2 -4.8,9.2 0,12 C4.8,9.2 9,6.2 9,3.2 C9,2 8.5,-2 5,-2 C2.2,-2 0,0.5 0,2.5 Z";
const ZONE_COLORS = ["#8e8e93", "#3987e5", "#199e70", "#f2802a", "#ef3a32"];

function zoneOf(hr, zones) {
  let z = 1;
  for (let i = 0; i < zones.length; i++) if (hr >= zones[i][1]) z = i + 1;
  return z;
}

/** Every movement's average heart rate while you did it — the real engine signal (machines and bodyweight alike). */
function engineDrivers(a) {
  if (!a.hrs) return [];
  const by = new Map();
  for (const r of a.rounds || []) for (const s of r.sets) {
    if (s.rest || typeof s.a !== "number" || typeof s.b !== "number") continue;
    const hr = avgHr(a, s.a, s.b);
    if (hr == null) continue;
    const sec = s.b - s.a;
    const o = by.get(s.ex) || { ex: s.ex, sec: 0, hrsec: 0 };
    o.sec += sec; o.hrsec += hr * sec; by.set(s.ex, o);
  }
  return [...by.values()].map((o) => ({ ex: o.ex, hr: o.hrsec / o.sec })).sort((x, y) => y.hr - x.hr);
}

function engineCard(a) {
  const zones = a.zones;
  if (!zones && !a.hr) return null;
  const card = el("div", "card");
  card.append(el("div", "chart-title", "Engine"));

  const head = el("div", "eng");
  const hs = svg("svg", { viewBox: "-10 -4 20 18", class: "eng-h", "aria-hidden": "true" });
  svg("path", { d: HEART_PATH, class: "heart" }, hs);
  const meter = el("div", "eng-meter");
  const big = el("div", "eng-big");
  big.append(el("b", null, a.hr ? Math.round(a.hr) : "\u2013"), el("small", null, " avg bpm"));
  meter.append(big);
  const red = zones ? Math.round((zones[3][0] + zones[4][0]) / 60) : null;
  meter.append(el("div", "eng-sub", [a.hrMax ? "max " + Math.round(a.hrMax) : null, red ? red + " min in the red" : null].filter(Boolean).join(" \u00b7 ")));
  head.append(hs, meter);
  card.append(head);

  if (zones) {
    const bar = el("div", "zbar");
    zones.forEach((z, i) => { if (!z[0]) return; const seg = el("span", "z" + (i + 1)); seg.style.flex = String(z[0]); bar.append(seg); });
    card.append(bar);
    const list = el("div", "zlist");
    zones.forEach((z, i) => {
      const hi = i < 4 ? zones[i + 1][1] : (a.hrMax && Math.round(a.hrMax) > z[1] ? Math.round(a.hrMax) : null);
      const row = el("div", "zrow");
      row.append(el("i", "z" + (i + 1)), el("span", "zname", "Zone " + (i + 1)),
        el("span", "zrange", z[1] + (hi ? "\u2013" + hi : "+") + " bpm"), el("b", null, z[0] ? fmtClock(z[0]) : "\u2013"));
      list.append(row);
    });
    card.append(list);
  }

  const drivers = engineDrivers(a);
  if (drivers.length) {
    card.append(el("div", "eng-cardio-h", "Heart rate by movement"));
    const hrs = drivers.map((d) => d.hr);
    const lo = Math.min(...hrs) - 3, hi = Math.max(...hrs);
    const list = el("div", "src-list");
    for (const d of drivers.slice(0, 9)) {
      const z = zones ? zoneOf(d.hr, zones) : 4;
      const row = el("div", "src-row");
      const head = el("div", "src-head");
      head.append(el("span", "src-name", d.ex), el("span", "src-pct", Math.round(d.hr) + " bpm"));
      const track = el("div", "src-track");
      const fill = el("span", "src-fill");
      fill.style.width = Math.round(12 + 88 * ((d.hr - lo) / Math.max(1, hi - lo))) + "%";
      fill.style.background = ZONE_COLORS[z - 1];
      track.append(fill);
      row.append(head, track);
      list.append(row);
    }
    card.append(list);
    card.append(el("p", "stat-sub hr-note", "Average heart rate while doing each \u2014 your whole metcon is engine work (timing within a round is estimated)."));
  }
  return card;
}

function sessionMuscleData(a) {
  const byMuscle = new Map(), byMove = new Map();
  const addMuscle = (m, work, move) => {
    const o = byMuscle.get(m) || { work: 0, moves: new Set() };
    o.work += work; o.moves.add(move); byMuscle.set(m, o);
  };
  let any = false;
  for (const r of a.rounds || []) for (const s of r.sets) {
    if (s.rest || !s.mp) continue;
    any = true;
    const sec = typeof s.a === "number" && typeof s.b === "number" ? s.b - s.a : 45;
    const min = sec / 60;
    if (!byMove.has(s.ex)) byMove.set(s.ex, { main: s.mp.slice(), sup: (s.ms || []).slice() });
    for (const m of s.mp) addMuscle(m, min, s.ex);
    for (const m of s.ms || []) addMuscle(m, min * 0.4, s.ex);
  }
  if (!any && a.mus) {
    const name = a.name || a.label;
    byMove.set(name, { main: a.mus[0].slice(), sup: a.mus[1].slice() });
    const min = (a.min || 0) * a.mus[2];
    for (const m of a.mus[0]) addMuscle(m, min, name);
    for (const m of a.mus[1]) addMuscle(m, min * 0.4, name);
  }
  return { byMuscle, byMove, max: Math.max(0, ...[...byMuscle.values()].map((o) => o.work)) };
}

function bodyFigures(shadeOf, onMuscle) {
  const wrap = el("div", "body-figs");
  for (const side of ["front", "back"]) {
    const col = el("div", "body-col");
    const root = svg("svg", { viewBox: side === "front" ? "-6 -6 112 210" : "-6 -6 112 234", class: "body-fig", "aria-hidden": "true" });
    const shapes = ANATOMY[side].map(([m, flat]) => [m, smoothFlat(flat)]);
    for (const [, d] of shapes) svg("path", { d, class: "sil-edge" }, root);
    for (const [, d] of shapes) svg("path", { d, class: "sil-fill" }, root);
    for (const [m, d] of shapes) {
      if (!m) continue;
      const sh = shadeOf(m);
      const node = svg("path", { d, class: "mus " + (sh.cls || ""), "data-m": m }, root);
      if (sh.op != null) node.style.fillOpacity = sh.op;
      if (onMuscle) node.addEventListener("click", () => onMuscle(m));
    }
    col.append(root, el("span", "body-side", side === "front" ? "Front" : "Back"));
    wrap.append(col);
  }
  return wrap;
}

function sessionBodyCard(a) {
  const data = sessionMuscleData(a);
  if (!data.byMuscle.size) return null;
  const card = el("div", "card body-card");
  card.append(el("div", "chart-title", "Worked"));
  let sel = null;   // null | {type:"move", name} | {type:"muscle", m}
  const figHolder = el("div");
  const caption = el("p", "stat-sub body-cap");
  const chips = el("div", "chips");

  const shade = (m) => {
    const w = data.byMuscle.get(m);
    if (sel && sel.type === "move") {
      const mv = data.byMove.get(sel.name);
      if (mv.main.includes(m)) return { cls: "iso" };
      if (mv.sup.includes(m)) return { cls: "iso-sup" };
      return { cls: "dim" };
    }
    if (sel && sel.type === "muscle") return { cls: m === sel.m ? "iso" : "dim" };
    if (!w) return { cls: "off" };
    return { cls: "on", op: (0.32 + 0.68 * (w.work / (data.max || 1))).toFixed(2) };
  };
  const pickMuscle = (m) => {
    if (!data.byMuscle.has(m)) return;          // only muscles this session touched
    sel = sel && sel.type === "muscle" && sel.m === m ? null : { type: "muscle", m };
    render();
  };
  const pickMove = (name) => {
    sel = sel && sel.type === "move" && sel.name === name ? null : { type: "move", name };
    render();
  };

  function render() {
    figHolder.replaceChildren(bodyFigures(shade, pickMuscle));
    for (const c of chips.children) {
      const on = (c.dataset.move && sel && sel.type === "move" && sel.name === c.dataset.move) || (c.dataset.all && !sel);
      c.classList.toggle("on", !!on);
    }
    const nm = (m) => MUSCLE_NAMES[m] || m;
    if (!sel) caption.textContent = "Tap a movement or muscle to isolate it.";
    else if (sel.type === "move") {
      const mv = data.byMove.get(sel.name);
      caption.textContent = `${sel.name} → ${mv.main.map(nm).join(", ")}` + (mv.sup.length ? ` (+ ${mv.sup.map(nm).join(", ")})` : "");
    } else {
      caption.textContent = `${nm(sel.m)} ← ${[...data.byMuscle.get(sel.m).moves].join(", ")}`;
    }
  }

  const allChip = el("button", "chip", "All"); allChip.type = "button"; allChip.dataset.all = "1";
  allChip.addEventListener("click", () => { sel = null; render(); });
  chips.append(allChip);
  for (const name of data.byMove.keys()) {
    const b = el("button", "chip", name); b.type = "button"; b.dataset.move = name;
    b.addEventListener("click", () => pickMove(name));
    chips.append(b);
  }
  card.append(figHolder, caption, chips);
  render();
  return card;
}

// ---------- Wrapped ----------
// Monthly and yearly story slides, all computed here from the journal (the coach adds one caption).

const SLIDE_MS = 6500;

function actsIn(from, to) {
  return (J.activities || []).filter((a) => { const d = parseDay(a.date); return d >= from && d < to; });
}

/** Finished months of the last year, plus finished years (and this year from December). */
function wrappedPeriods() {
  const now = new Date();
  const out = [];
  for (let k = 1; k <= 12; k++) {
    const from = new Date(now.getFullYear(), now.getMonth() - k, 1);
    const to = new Date(now.getFullYear(), now.getMonth() - k + 1, 1);
    if (!actsIn(from, to).length) continue;
    out.push({ kind: "month", key: `${from.getFullYear()}-${pad(from.getMonth() + 1)}`, from, to,
      name: from.toLocaleDateString(undefined, { month: "long" }),
      long: from.toLocaleDateString(undefined, { month: "long", year: "numeric" }) });
  }
  for (const y of [now.getFullYear(), now.getFullYear() - 1]) {
    if (y === now.getFullYear() && now.getMonth() < 11) continue;
    const from = new Date(y, 0, 1), to = new Date(y + 1, 0, 1);
    if (actsIn(from, to).length) out.unshift({ kind: "year", key: String(y), from, to, name: String(y), long: String(y) });
  }
  return out;
}

function longestStreak(acts) {
  const days = [...new Set(acts.map((a) => a.date.slice(0, 10)))].sort();
  let best = 0, run = 0, prev = null;
  for (const d of days) {
    run = prev && (parseDay(d) - parseDay(prev)) / 864e5 === 1 ? run + 1 : 1;
    best = Math.max(best, run);
    prev = d;
  }
  return best;
}

function wrappedStats(p) {
  const acts = actsIn(p.from, p.to);
  const before = (J.activities || []).filter((a) => parseDay(a.date) < p.from);
  const len = p.to - p.from;
  const prevActs = actsIn(new Date(p.from - len), p.from);
  const s = {
    acts, sessions: acts.length, minutes: acts.reduce((x, a) => x + (a.min || 0), 0),
    kcal: acts.reduce((x, a) => x + (a.kcal || 0), 0),
    prevSessions: prevActs.length, prevMinutes: prevActs.reduce((x, a) => x + (a.min || 0), 0),
    mix: mix(p.from, p.to), streak: longestStreak(acts),
  };
  // Movement totals from logged classes.
  const vol = new Map();
  for (const a of acts) for (const r of a.rounds || []) for (const x of r.sets) {
    if (x.rest || !x.n) continue;
    const key = x.ex + "|" + (x.unit || "reps");
    vol.set(key, (vol.get(key) || 0) + x.n);
  }
  s.moves = [...vol].map(([k, n]) => ({ ex: k.split("|")[0], unit: k.split("|")[1], n })).sort((a, b) => b.n - a.n);
  s.reps = s.moves.filter((m) => m.unit === "reps").reduce((x, m) => x + m.n, 0);
  s.meters = s.moves.filter((m) => m.unit === "m").reduce((x, m) => x + m.n, 0);
  s.cals = s.moves.filter((m) => m.unit === "cal").reduce((x, m) => x + m.n, 0);
  // Hardest session: highest average heart rate over at least 20 minutes.
  s.hardest = acts.filter((a) => a.hr && a.min >= 20).sort((a, b) => b.hr - a.hr)[0] || null;
  // PRs: loads beyond every earlier best, max efforts, running records.
  const bestBefore = new Map();
  for (const a of before) for (const r of a.rounds || []) for (const x of r.sets) {
    if (x.kg && x.kg > (bestBefore.get(x.ex) || 0)) bestBefore.set(x.ex, x.kg);
  }
  const loads = new Map();
  for (const a of acts) for (const r of a.rounds || []) for (const x of r.sets) {
    if (x.kg && bestBefore.has(x.ex) && x.kg > bestBefore.get(x.ex) && x.kg > (loads.get(x.ex) || 0)) loads.set(x.ex, x.kg);
  }
  s.prs = [...loads].map(([ex, kg]) => `${ex} ${kg} kg`);
  const inP = (d) => d && parseDay(d) >= p.from && parseDay(d) < p.to;
  for (const e of maxEfforts()) if (inP(e.date)) s.prs.push(`${e.ex} ${e.n === 1 && e.kg ? e.kg + " kg" : e.n + " " + (e.unit || "reps")} · ${fmtWindow(e.win)}`);
  for (const r of J.records || []) if ((r.kind === "time" || r.kind === "distance") && inP(r.date)) {
    s.prs.push(`${r.label} ${r.kind === "time" ? fmtClock(r.value) : (r.value / 1000).toFixed(2) + " km"}`);
  }
  // Busiest week.
  const weeks = new Map();
  for (const a of acts) { const k = iso(weekStart(parseDay(a.date))); weeks.set(k, (weeks.get(k) || 0) + (a.min || 0)); }
  s.busiest = [...weeks].sort((a, b) => b[1] - a[1])[0] || null;
  // Padel.
  const padel = acts.filter((a) => groupOf(a).key === "padel");
  s.padel = { n: padel.length, min: padel.reduce((x, a) => x + (a.min || 0), 0), kcal: padel.reduce((x, a) => x + (a.kcal || 0), 0) };
  // Sleep (the journal keeps 90 days of nights).
  const nights = Object.entries(J.days || {}).filter(([k, d]) => inP(k) && d.sleep && d.sleep.sec);
  s.sleep = nights.length >= 5 ? {
    avg: avg(nights.map(([, d]) => d.sleep.sec)),
    best: nights.filter(([, d]) => d.sleep.score).sort((a, b) => b[1].sleep.score - a[1].sleep.score)[0] || null,
  } : null;
  // Year: the strongest month.
  if (p.kind === "year") {
    const months = new Array(12).fill(0);
    for (const a of acts) months[parseDay(a.date).getMonth()] += a.min || 0;
    const m = months.indexOf(Math.max(...months));
    s.topMonth = { name: new Date(2000, m, 1).toLocaleDateString(undefined, { month: "long" }), min: months[m] };
  }
  return s;
}

/** Big numbers count up when the slide opens. */
function countUp(node, value, fmt) {
  node.textContent = fmt(value);
  if (reducedMotion() || !value) return;
  const start = performance.now(), dur = 900;
  const step = (t) => {
    const k = Math.min(1, (t - start) / dur);
    node.textContent = fmt(value * (1 - Math.pow(1 - k, 3)));
    if (k < 1 && node.isConnected) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function slide(bg, kicker, big, sub, extra) {
  const sl = el("div", "w-slide w-bg" + bg);
  sl.append(el("div", "w-kicker", kicker));
  if (big) {
    const b = el("div", "w-big");
    b.dataset.count = "1";
    sl.append(b);
    sl._count = () => countUp(b, big[0], big[1]);
  }
  if (sub) sl.append(el("div", "w-sub", sub));
  if (extra) sl.append(extra);
  return sl;
}

function wList(rows) {
  const ul = el("ul", "w-list");
  for (const [a, b] of rows) { const li = el("li"); li.append(el("span", null, a), el("b", null, b)); ul.append(li); }
  return ul;
}

function wrappedSlides(p) {
  const s = wrappedStats(p);
  const n0 = (x) => fmtInt(x);
  const slides = [];
  const span = p.kind === "year" ? "year" : "month";

  slides.push(slide(1, p.kind === "year" ? "Your year in training" : "Your month in training",
    null, null, (() => { const t = el("div", "w-title", p.long); return t; })()));

  const delta = s.prevSessions ? s.sessions - s.prevSessions : null;
  slides.push(slide(2, "You showed up", [s.sessions, n0], `sessions · ${fmtMin(s.minutes)} of training`,
    el("div", "w-note", delta === null ? "" : delta > 0 ? `▲ ${delta} more than last ${span}` : delta < 0 ? `▼ ${-delta} fewer than last ${span}` : `Same as last ${span}`)));

  const d = donut(s.mix, fmtMin(s.mix.total), "by type");
  d.classList.add("w-donut");
  slides.push(slide(3, "Where the time went", null, null, d));

  if (s.moves.length) {
    const top = s.moves.filter((m) => m.unit === "reps").slice(0, 3);
    const rows = top.map((m) => [m.ex, n0(m.n) + " reps"]);
    if (s.meters) rows.push(["Meters (run, row, sled…)", n0(s.meters) + " m"]);
    if (s.cals) rows.push(["Machine calories", n0(s.cals) + " cal"]);
    slides.push(slide(4, "You moved", [s.reps, n0], "reps in logged classes", wList(rows)));
  }

  slides.push(slide(5, "You burned", [s.kcal, n0], "active kcal",
    el("div", "w-note", `≈ ${n0(s.kcal / 285)} slices of pizza 🍕`)));

  if (s.hardest) {
    const h = s.hardest;
    slides.push(slide(2, "Your hardest session", [h.hr, (x) => Math.round(x) + ""], "avg heart rate",
      wList([[h.name || h.label, shortDay(h.date)], ["Time", fmtMin(h.min)], ["Calories", n0(h.kcal) + " kcal"]])));
  }

  if (s.prs.length) {
    slides.push(slide(3, "New bests", [s.prs.length, n0], s.prs.length === 1 ? "personal best" : "personal bests",
      wList(s.prs.slice(0, 5).map((x) => ["🏆", x]))));
  }

  const rows = [["Longest streak", s.streak + (s.streak === 1 ? " day" : " days")]];
  if (s.busiest) rows.push(["Busiest week", `${shortDay(s.busiest[0])} · ${fmtMin(s.busiest[1])}`]);
  if (s.topMonth) rows.push(["Strongest month", `${s.topMonth.name} · ${fmtMin(s.topMonth.min)}`]);
  slides.push(slide(4, "Consistency", [s.streak, n0], "days in a row, your best run", wList(rows)));

  if (s.padel.n) {
    slides.push(slide(2, "On the padel court", [s.padel.min / 60, (x) => x.toFixed(1)], "hours of padel",
      wList([["Sessions", String(s.padel.n)], ["Calories", n0(s.padel.kcal) + " kcal"]])));
  }
  if (s.sleep) {
    const rowsS = [["Average night", fmtHM(s.sleep.avg)]];
    if (s.sleep.best) rowsS.push(["Best night", `${s.sleep.best[1].sleep.score} · ${shortDay(s.sleep.best[0])}`]);
    slides.push(slide(1, "Recovery", [s.sleep.avg / 3600, (x) => x.toFixed(1)], "hours of sleep a night", wList(rowsS)));
  }

  const cap = ((J.coach || {}).wrapped || {})[p.key];
  const end = slide(1, "Coach says", null, null);
  const row = el("div", "w-coach");
  row.append(coachAvatar("push", 64));
  const bub = el("div", "bubble big", cap ? cap.line : `${s.sessions} sessions in ${p.name}. Keep stacking them.`);
  row.append(bub);
  if (cap && cap.title) end.append(el("div", "w-title", cap.title));
  end.append(row);
  slides.push(end);
  return slides;
}

let wrapTimer = 0;

function openWrapped(p) {
  closeWrapped();
  const slides = wrappedSlides(p);
  const box = el("div", "wrapped");
  box.id = "wrapped";
  box.setAttribute("role", "dialog");
  box.setAttribute("aria-label", "Wrapped " + p.long);
  const bars = el("div", "w-bars");
  slides.forEach(() => { const b = el("i"); b.append(el("span")); bars.append(b); });
  const close = el("button", "w-close", "✕");
  close.type = "button";
  close.setAttribute("aria-label", "Close");
  const stage = el("div", "w-stage");
  const back = el("button", "w-tap left"); back.type = "button"; back.setAttribute("aria-label", "Previous");
  const fwd = el("button", "w-tap right"); fwd.type = "button"; fwd.setAttribute("aria-label", "Next");
  box.append(stage, back, fwd, bars, close);
  document.body.append(box);
  document.body.classList.add("no-scroll");

  let i = 0;
  const go = (k) => {
    if (k < 0) k = 0;
    if (k >= slides.length) { closeWrapped(); return; }
    i = k;
    stage.replaceChildren(slides[i]);
    slides[i].classList.remove("enter"); void slides[i].offsetWidth; slides[i].classList.add("enter");
    if (slides[i]._count) slides[i]._count();
    [...bars.children].forEach((b, j) => { b.className = j < i ? "done" : j === i ? "on" : ""; });
    clearTimeout(wrapTimer);
    wrapTimer = setTimeout(() => go(i + 1), SLIDE_MS);
  };
  back.addEventListener("click", () => go(i - 1));
  fwd.addEventListener("click", () => go(i + 1));
  close.addEventListener("click", closeWrapped);
  let x0 = null;
  box.addEventListener("touchstart", (e) => { x0 = e.touches[0].clientX; }, { passive: true });
  box.addEventListener("touchend", (e) => {
    if (x0 === null) return;
    const dx = e.changedTouches[0].clientX - x0; x0 = null;
    if (Math.abs(dx) > 50) go(i + (dx < 0 ? 1 : -1));
  });
  go(0);
}

function closeWrapped() {
  clearTimeout(wrapTimer);
  const w = $("wrapped");
  if (w) w.remove();
  document.body.classList.remove("no-scroll");
}

/** Home: the latest month's Wrapped during the first 10 days of a month. */
function wrappedCard() {
  if (new Date().getDate() > 10) return null;
  const p = wrappedPeriods().find((x) => x.kind === "month");
  const now = new Date();
  if (!p || p.to.getMonth() !== now.getMonth()) return null;
  const card = el("button", "card wrap-card");
  card.type = "button";
  card.append(el("span", "wrap-kicker", "📦 Wrapped"), el("b", null, `Your ${p.name} is ready`), el("span", "wrap-sub", "Tap to play"));
  card.addEventListener("click", () => openWrapped(p));
  return card;
}

/** Progress: every Wrapped there is. */
function wrappedList() {
  const ps = wrappedPeriods();
  const box = el("div", "chips wrap-chips");
  for (const p of ps) {
    const b = el("button", "chip" + (p.kind === "year" ? " on" : ""), (p.kind === "year" ? "★ " : "") + p.long);
    b.type = "button";
    b.addEventListener("click", () => openWrapped(p));
    box.append(b);
  }
  return ps.length ? box : null;
}

// ---------- shell ----------

const RENDER = { home: renderHome, activity: renderActivity, sleep: renderSleep, trends: renderTrends, coach: renderCoach };

function show(view, keepScroll) {
  if (view !== current) stopSpeaking();
  closeSheets();
  current = view;
  for (const b of document.querySelectorAll(".tab")) b.classList.toggle("active", b.dataset.view === view);
  for (const key of Object.keys(RENDER)) $("view-" + key).hidden = key !== view;
  $("barTitle").textContent = $("view-" + view).dataset.title;
  RENDER[view]();
  if (!keepScroll) window.scrollTo(0, 0);
}

function start() {
  rememberVisit();
  $("lock").hidden = true;
  $("app").hidden = false;
  show("home");
}

document.addEventListener("visibilitychange", () => {
  if (document.hidden) { hiddenAt = Date.now(); return; }
  if (J && hiddenAt && Date.now() - hiddenAt > AUTO_LOCK_MS && !syncUntil) { lock(); return; }
  if (J) refreshData(); // back from the Sync Shortcut (or anywhere): pick up new data
});

document.addEventListener("DOMContentLoaded", () => {
  $("unlock").addEventListener("submit", unlock);
  $("lockBtn").addEventListener("click", lock);
  $("syncBtn").addEventListener("click", sync);
  for (const b of document.querySelectorAll(".tab")) b.addEventListener("click", () => show(b.dataset.view));
});
