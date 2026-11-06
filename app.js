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
    J = await openBox(KEY, box);
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

function lock() {
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
    const next = await openBox(KEY, box);
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
  top.append(el("span", "tile-label", "Coach · today"), el("span", "status " + cls, text));
  card.append(top, el("div", "coach-headline", daily.headline));
  if (daily.plan) card.append(el("div", "stat-sub", daily.plan));
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

  const daily = J.coach && J.coach.daily && J.coach.daily.date === iso(now) ? J.coach.daily : null;
  if (daily) v.append(coachChip(daily));
  v.append(weekCard());
  v.append(recoveryCard());

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
    v.append(activityCard(last, true));
  }
  v.append(el("h2", "section-title", "Consistency"));
  v.append(weeksChart(8));

  const bits = [];
  if (J.profile && J.profile.vo2max) bits.push(`VO₂ max ${Math.round(J.profile.vo2max)}`);
  if (J.updated) bits.push("Synced " + new Date(J.updated).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }));
  v.append(el("p", "stat-sub", bits.join(" · ")));
}

// ---------- Coach ----------


function bullets(items) {
  const ul = el("ul", "bullets");
  for (const it of items || []) ul.append(el("li", null, it));
  return ul;
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
  v.append(el("p", "eyebrow", "Based on your Garmin data and logged classes"));

  if (c.daily) {
    const d = c.daily;
    const card = el("div", "card");
    const [cls, text] = CALLS[d.call] || ["good", ""];
    const top = el("div", "coach-top");
    top.append(el("span", "tile-label", d.date === iso(new Date()) ? "Today" : shortDay(d.date)), el("span", "status " + cls, text));
    card.append(top, el("div", "coach-big", d.headline), bullets(d.points));
    if (d.plan) { const p = el("div", "coach-plan"); p.append(el("b", null, "Plan  "), document.createTextNode(d.plan)); card.append(p); }
    v.append(card);
  }

  if (c.weekly) {
    const w = c.weekly;
    v.append(el("h2", "section-title", "This week"));
    const card = el("div", "card");
    card.append(el("div", "tile-label", "Week of " + shortDay(w.week)), el("div", "coach-big", w.headline));
    for (const [title, items] of [["Wins", w.wins], ["Watch", w.watch], ["Focus", w.focus]]) {
      if (!items || !items.length) continue;
      card.append(el("div", "coach-sub", title), bullets(items));
    }
    if (w.next_week) { const p = el("div", "coach-plan"); p.append(el("b", null, "Next week  "), document.createTextNode(w.next_week)); card.append(p); }
    v.append(card);
  }

  const reviews = (J.activities || []).filter((a) => (c.workouts || {})[String(a.id)]);
  if (reviews.length) {
    v.append(el("h2", "section-title", "Class reviews"));
    for (const a of reviews) {
      const r = c.workouts[String(a.id)];
      const card = el("div", "card");
      card.append(el("div", "tile-label", `${shortDay(a.date)} · ${a.name || a.label}`), el("div", "coach-headline", r.headline), bullets(r.points));
      v.append(card);
    }
  }
  v.append(el("p", "stat-sub", "Tell the coach your goals: edit coach/goals.md in your GitHub repository."));
}

// ---------- Activity ----------

function activityCard(a, open) {
  const g = groupOf(a);
  const card = el("details", "card act");
  if (open) card.open = true;
  const head = el("summary");
  const badge = el("div", "badge g" + g.cls);
  const icon = svg("svg", { viewBox: "0 0 24 24", "aria-hidden": "true" }, null);
  for (const d of ICONS[g.key]) svg("path", { d }, icon);
  badge.append(icon);
  head.append(badge);
  const main = el("div", "act-main");
  main.append(el("div", "act-title", a.name || a.label));
  const when = new Date(a.date.replace(" ", "T"));
  main.append(el("div", "act-meta", [
    a.label,
    when.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }),
    Math.round(a.min) + " min",
    a.kcal ? Math.round(a.kcal) + " kcal" : null,
  ].filter(Boolean).join(" · ")));
  head.append(main, el("span", "chev", "›"));
  card.append(head);

  const body = el("div", "act-body");
  const kv = el("div", "kv");
  const pair = (b, s) => { const d = el("div"); d.append(el("b", null, b), el("span", null, s)); kv.append(d); };
  pair(fmtMS(a.min * 60), "Time");
  pair(a.kcal ? Math.round(a.kcal) : "–", "kcal");
  pair(a.hr ? Math.round(a.hr) : "–", "Avg HR");
  pair(a.hrMax ? Math.round(a.hrMax) : "–", "Max HR");
  pair(a.te ? a.te.toFixed(1) : "–", "Aerobic TE");
  pair(a.km ? a.km.toFixed(2) + " km" : a.teAn ? a.teAn.toFixed(1) : "–", a.km ? "Distance" : "Anaerobic TE");
  body.append(kv);

  if (a.notes) {
    const notes = el("div", "notes");
    for (const line of a.notes.split("\n")) if (line.trim()) notes.append(el("p", null, line));
    body.append(notes);
  }
  if (a.rounds && a.rounds.length) {
    const ol = el("ol", "rounds");
    for (const r of a.rounds) {
      const li = el("li", "round");
      li.append(el("div", "round-time", fmtMS(r.sec)));
      const ul = el("ul", "sets");
      for (const s of r.sets) {
        if (s.rest) { ul.append(el("li", "set rest", "Rest " + fmtMS(s.sec))); continue; }
        const row = el("li", "set");
        row.append(el("span", null, s.ex + (s.kg ? ` · ${s.kg} kg` : "")), el("span", "amt", setAmount(s)));
        ul.append(row);
      }
      li.append(ul);
      ol.append(li);
    }
    body.append(ol);
  }
  const link = el("a", "garmin", "Open in Garmin Connect");
  link.href = "https://connect.garmin.com/modern/activity/" + encodeURIComponent(String(a.id));
  link.rel = "noopener noreferrer";
  link.target = "_blank";
  body.append(link);
  card.append(body);
  return card;
}

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
    v.append(activityCard(a, false));
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
    left.append(el("div", "record-label", e.ex), el("div", "stat-sub", `${fmtWindow(e.win)} · ${shortDay(e.date)} ${e.date.slice(0, 4)}`));
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
    left.append(el("div", "record-label", ex), el("div", "stat-sub", shortDay(b.date) + " " + b.date.slice(0, 4)));
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
      row.append(el("div", "hbar-label", ex), track,
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

  const other = (J.records || []).filter((r) => r.kind !== "time" && r.kind !== "distance");
  if (other.length) {
    v.append(el("h2", "section-title", "Other records"));
    v.append(recordsCard(other));
  }
}

// ---------- shell ----------

const RENDER = { home: renderHome, activity: renderActivity, sleep: renderSleep, trends: renderTrends, coach: renderCoach };

function show(view, keepScroll) {
  current = view;
  for (const b of document.querySelectorAll(".tab")) b.classList.toggle("active", b.dataset.view === view);
  for (const key of Object.keys(RENDER)) $("view-" + key).hidden = key !== view;
  $("barTitle").textContent = $("view-" + view).dataset.title;
  RENDER[view]();
  if (!keepScroll) window.scrollTo(0, 0);
}

function start() {
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
