"use strict";
// WOD Journal: decrypts data.enc in the browser and shows it.
// The password and key never leave this page and are never stored.
// Everything from the data is shown with textContent, never as HTML.

const AAD = new TextEncoder().encode("wod-journal-v1");
const AUTO_LOCK_MS = 2 * 60 * 1000;
let journal = null;
let hiddenAt = 0;

if (window.top !== window.self) {
  // Never run inside someone else's frame.
  window.top.location = window.self.location.href;
}

const $ = (id) => document.getElementById(id);

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

function b64(s) {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

async function decrypt(box, password) {
  if (box.v !== 1 || box.kdf !== "PBKDF2-SHA256") throw new Error("Unknown journal format");
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveKey"]);
  const key = await crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt: b64(box.salt), iterations: box.iter },
    base, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: b64(box.iv), additionalData: AAD }, key, b64(box.ct));
  return JSON.parse(new TextDecoder().decode(plain));
}

async function unlock(event) {
  event.preventDefault();
  const input = $("password");
  const status = $("status");
  const button = $("open");
  button.disabled = true;
  status.textContent = "Opening…";
  try {
    const res = await fetch("data.enc", { cache: "no-store", credentials: "omit" });
    if (!res.ok) throw new Error("No journal yet");
    journal = await decrypt(await res.json(), input.value);
    input.value = "";
    status.textContent = "";
    show();
  } catch (err) {
    journal = null;
    status.textContent = err && err.name === "OperationError" ? "Wrong password." : "Couldn't open the journal.";
  } finally {
    button.disabled = false;
  }
}

function lock() {
  journal = null;
  // A reload drops every decrypted value from memory.
  window.location.reload();
}

function fmtDate(iso) {
  const d = new Date(iso.replace(" ", "T"));
  return d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" }) +
    " · " + d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

function fmtSec(sec) {
  const s = Math.round(sec || 0);
  return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
}

function setLine(set) {
  if (set.rest) return "Rest " + fmtSec(set.sec);
  const bits = [set.ex];
  if (set.reps) bits.push("× " + set.reps);
  if (set.kg) bits.push("@ " + set.kg + " kg");
  return bits.join(" ");
}

function stat(label, value) {
  const box = el("div", "stat");
  box.append(el("div", "stat-value", value), el("div", "stat-label", label));
  return box;
}

function renderStats() {
  const now = new Date();
  const month = journal.classes.filter((c) => {
    const d = new Date(c.date.replace(" ", "T"));
    return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
  });
  const sum = (k) => month.reduce((t, c) => t + (c[k] || 0), 0);
  const stats = $("stats");
  stats.replaceChildren(
    stat("classes this month", month.length),
    stat("kcal this month", Math.round(sum("kcal")).toLocaleString()),
    stat("minutes this month", Math.round(sum("min"))));
}

function renderClass(c) {
  const card = el("details", "card");
  const head = el("summary", "card-head");
  const title = el("div", "card-title", c.title || "Workout");
  const meta = el("div", "card-meta",
    [fmtDate(c.date), Math.round(c.min) + " min", c.kcal ? Math.round(c.kcal) + " kcal" : null,
     c.hr ? "♥ " + Math.round(c.hr) : null].filter(Boolean).join(" · "));
  head.append(title, meta);
  card.append(head);

  if (c.notes) {
    const notes = el("div", "notes");
    for (const line of c.notes.split("\n")) {
      if (line.trim()) notes.append(el("p", null, line));
    }
    card.append(notes);
  }

  const rounds = el("ol", "rounds");
  c.rounds.forEach((r) => {
    const li = el("li", "round");
    li.append(el("div", "round-time", fmtSec(r.sec)));
    const sets = el("ul", "sets");
    for (const s of r.sets) sets.append(el("li", s.rest ? "set rest" : "set", setLine(s)));
    li.append(sets);
    rounds.append(li);
  });
  card.append(rounds);

  const link = el("a", "garmin", "Open in Garmin Connect");
  link.href = "https://connect.garmin.com/modern/activity/" + encodeURIComponent(String(c.id));
  link.rel = "noopener noreferrer";
  link.target = "_blank";
  card.append(link);
  return card;
}

function renderClasses() {
  const list = $("classes");
  list.replaceChildren();
  if (!journal.classes.length) {
    list.append(el("p", "empty", "No classes logged yet."));
    return;
  }
  journal.classes.forEach((c, i) => {
    const card = renderClass(c);
    if (i === 0) card.open = true;
    list.append(card);
  });
}

function renderProgress() {
  const best = new Map();   // exercise -> heaviest kg
  const recent = new Map(); // exercise -> reps in the last 30 days
  const since = Date.now() - 30 * 24 * 3600 * 1000;
  for (const c of journal.classes) {
    const when = new Date(c.date.replace(" ", "T")).getTime();
    for (const r of c.rounds) {
      for (const s of r.sets) {
        if (s.rest) continue;
        if (s.kg && s.kg > (best.get(s.ex) || 0)) best.set(s.ex, s.kg);
        if (when >= since && s.reps) recent.set(s.ex, (recent.get(s.ex) || 0) + s.reps);
      }
    }
  }
  const box = $("progress");
  box.replaceChildren();

  box.append(el("h2", null, "Heaviest loads"));
  const heavy = el("ul", "rank");
  [...best].sort((a, b) => b[1] - a[1]).forEach(([ex, kg]) => {
    const li = el("li");
    li.append(el("span", null, ex), el("span", "num", kg + " kg"));
    heavy.append(li);
  });
  box.append(best.size ? heavy : el("p", "empty", "No weighted movements yet."));

  box.append(el("h2", null, "Last 30 days · reps and calories"));
  const top = [...recent].sort((a, b) => b[1] - a[1]);
  const max = top.length ? top[0][1] : 1;
  const bars = el("ul", "bars");
  top.forEach(([ex, n]) => {
    const li = el("li");
    const bar = el("div", "bar");
    bar.style.width = Math.max(4, Math.round((n / max) * 100)) + "%";
    li.append(el("span", "bar-label", ex), bar, el("span", "num", n));
    bars.append(li);
  });
  box.append(top.length ? bars : el("p", "empty", "Nothing in the last 30 days."));
}

function show() {
  $("lock").hidden = true;
  $("journal").hidden = false;
  renderStats();
  renderClasses();
  renderProgress();
}

function switchTab(event) {
  const tab = event.target.closest("[data-tab]");
  if (!tab) return;
  for (const b of document.querySelectorAll(".tab")) b.classList.toggle("active", b === tab);
  $("classes").hidden = tab.dataset.tab !== "classes";
  $("progress").hidden = tab.dataset.tab !== "progress";
}

document.addEventListener("visibilitychange", () => {
  if (document.hidden) hiddenAt = Date.now();
  else if (journal && hiddenAt && Date.now() - hiddenAt > AUTO_LOCK_MS) lock();
});

document.addEventListener("DOMContentLoaded", () => {
  $("unlock").addEventListener("submit", unlock);
  $("lockBtn").addEventListener("click", lock);
  document.querySelector(".tabs").addEventListener("click", switchTab);
});
