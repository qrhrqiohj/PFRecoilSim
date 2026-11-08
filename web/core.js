/* RecoilSim front-end — shared state, helpers, storage and small UI widgets.
   Script order: renderer.js, core.js, range.js, panels.js, finder.js, export.js, main.js */
"use strict";

const $ = (id) => document.getElementById(id);
const SLOTS = ["Optics", "Barrel", "Underbarrel", "Other", "Ammo"];
const PART_GROUP = ["head", "torso", "limb", "limb", "limb", "limb"];
const COLORS = { head: "#ff5c7a", torso: "#ffb224", limb: "#4cc3ff", miss: "#7d8794", accent: "#ffb224", text: "#eef1f5", text2: "#a9b1bd", text3: "#6f7885" };
const PART_COLORS = [COLORS.head, COLORS.torso, COLORS.limb, COLORS.limb, COLORS.limb, COLORS.limb];
const PART_RGB = PART_COLORS.map((c) => [1, 3, 5].map((k) => parseInt(c.slice(k, k + 2), 16) / 255));
const SNAP_COLORS = ["#b48cff", "#4dffb5", "#ff7ad9", "#7ab8ff", "#ffe066", "#ff9a5c"];
const STORE_KEY = "recoilsim.v2";
const PREFS_KEY = "recoilsim.prefs";
const TARGET_BASE = 3.0;   // torso centre height above the baseplate
const WALL_GAP = 12;       // back wall distance behind the target
const FONT = '"Inter", "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif';

const state = {
  catalog: null, hitboxes: [], aimPoints: {},
  weapon: null, weaponInfo: null, attachments: {}, attNames: {},
  stats: null, lastDump: null, lastWatch: null,
  holes: [], anim: null,
  patternView: "heat", patternFit: "all", patternZoom: 1,
  aiming: true, stance: "stand", view: "first", sound: true,
  aimBlend: 1, scene: null, orbit: { yaw: 0.75, pitch: 0.2, dist: 6.5 },
  snapshots: [], saved: {}, excludes: {},
  optResults: {}, // last best-setup result per gun (for export)
};

/* ------------------------------------------------------------------ preferences (always kept) */
const PREF_DEFAULTS = { fov: 70, ghost: 20, tracers: true, markers: true, numbers: true, heat: "thermal", vol: 70, glass: true, defExcl: null, defExclSeen: null };
let prefs = { ...PREF_DEFAULTS };
function loadPrefs() {
  try { prefs = { ...PREF_DEFAULTS, ...(JSON.parse(localStorage.getItem(PREFS_KEY) || "{}") || {}) }; } catch (e) { prefs = { ...PREF_DEFAULTS }; }
}
/* default exclusion list: attachment names (any gun) and "GUN::name" (that gun
   only). The user's own list when they've edited it, else the built-in one. */
function builtinTokens() {
  const d = (state.catalog && state.catalog.default_excludes) || {};
  return [...(d["*"] || []), ...Object.entries(d).filter(([w]) => w !== "*").flatMap(([w, l]) => l.map((n) => `${w}::${n}`))];
}
/* unlock requirements as shown next to guns / attachments */
function rankLabel(r, test) { return `${r == null ? "–" : `Rank ${r}`}${test ? " · test" : ""}`; }
function killLabel(k, test) { return `${k == null ? "–" : k === 0 ? "free" : `${k.toLocaleString()} kills`}${test ? " · test only" : ""}`; }

/* the arrow in a range / fps box: a menu of common values (the box still takes any value) */
const FPS_PRESETS = [30, 60, 75, 120, 144, 165, 240, 360];
const RANGE_PRESETS = [10, 25, 50, 75, 100, 150, 200, 300, 500];
function presetButton(values, unit, title) {
  return `<button type="button" class="fps-dd" tabindex="-1" title="${title}" data-presets="${values.join(",")}" data-unit="${unit}"><svg class="ic"><use href="#i-chev"/></svg></button>`;
}
function closeFpsMenu() { const m = document.querySelector(".fpsmenu"); if (m) m.remove(); }
document.addEventListener("click", (e) => {
  const dd = e.target.closest(".fps-dd");
  if (!dd) { if (!e.target.closest(".fpsmenu")) closeFpsMenu(); return; }
  e.preventDefault();
  const input = dd.parentElement.querySelector("input");
  const open = document.querySelector(".fpsmenu");
  closeFpsMenu();
  if (open && open.dataset.for === (input.id || input.dataset.o)) return;
  const values = (dd.dataset.presets || FPS_PRESETS.join(",")).split(",").map(Number);
  const unit = dd.dataset.unit || "fps";
  const m = document.createElement("div");
  m.className = "fpsmenu";
  m.dataset.for = input.id || input.dataset.o;
  m.innerHTML = values.map((v) => `<button type="button" data-fps="${v}" class="${+input.value === v ? "cur" : ""}">${v}<span>${unit}</span></button>`).join("");
  document.body.appendChild(m);
  const r = dd.parentElement.getBoundingClientRect();
  const h = m.offsetHeight;
  m.style.left = `${Math.max(8, r.right - m.offsetWidth)}px`;
  m.style.top = `${r.bottom + 4 + h > innerHeight ? r.top - h - 4 : r.bottom + 4}px`;
  m.addEventListener("click", (ev) => {
    const b = ev.target.closest("[data-fps]");
    if (!b) return;
    input.value = b.dataset.fps;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    closeFpsMenu();
  });
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && document.querySelector(".fpsmenu")) { closeFpsMenu(); e.stopPropagation(); }
}, true);
window.addEventListener("resize", closeFpsMenu);

/* any frame rate the player types (1-1000 fps); empty / nonsense -> 60 */
function clampFps(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.min(1000, Math.max(1, n)) : 60;
}
function defaultTokenList() { return prefs.defExcl || builtinTokens(); }
/* entries added to the built-in default list in an update also join an edited
   default list (once; removing them again afterwards sticks) */
function mergeNewDefaultExcludes() {
  const now = builtinTokens();
  // (lists saved before this was tracked: the .223 entries are the ones added since,
  // and these used to be built in)
  const formerly = ["Banana", "Fun Switch", "Spring Mod", "Engravings", "M107 Rat Shot", "Uzi .22LR Conversion"];
  const seen = prefs.defExclSeen || [...now.filter((t) => !t.startsWith(".223 Remington") && t !== ".17 Wildcat"), ...formerly];
  if (prefs.defExcl && Array.isArray(seen)) {
    // entries added to the built-in list join yours; entries taken off it leave yours
    const added = now.filter((t) => !seen.includes(t) && !prefs.defExcl.includes(t));
    const removed = new Set(seen.filter((t) => !now.includes(t)));
    prefs.defExcl = [...prefs.defExcl.filter((t) => !removed.has(t)), ...added];
  }
  prefs.defExclSeen = now;
  savePrefs();
}
function savePrefs() { try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch (e) { /* storage unavailable */ } }

/* ------------------------------------------------------------------ session storage */
function store() {
  if (state.awaitingLoadChoice) return; // don't overwrite the old save before the user decides
  try {
    state.saved.snapshots = state.snapshots;
    state.saved.excludes = state.excludes;
    localStorage.setItem(STORE_KEY, JSON.stringify(state.saved));
  } catch (e) { /* storage unavailable or full */ }
}
function loadStore() {
  // every start begins from the defaults; the previous save is only offered
  let prev = {};
  try { prev = JSON.parse(localStorage.getItem(STORE_KEY) || "{}") || {}; } catch (e) { prev = {}; }
  state.prevSave = prev && (prev.weapon || (prev.snapshots && prev.snapshots.length)) ? prev : null;
  state.awaitingLoadChoice = !!state.prevSave;
  state.saved = {};
  state.snapshots = [];
  state.excludes = {};
}
function stableJSON(v) {
  if (Array.isArray(v)) return `[${v.map(stableJSON).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stableJSON(v[k])}`).join(",")}}`;
  return JSON.stringify(v === undefined ? null : v);
}

/* ------------------------------------------------------------------ server */
async function api(path, body, signal, timeoutMs = 60000) {
  // every request gets a timeout so a busy server can't leave the UI stuck
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  if (signal) signal.addEventListener("abort", () => ctl.abort());
  const opt = body === undefined ? { signal: ctl.signal } : { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" }, signal: ctl.signal };
  let r;
  try { r = await fetch(path, opt); } catch (e) {
    if (signal && signal.aborted) throw e;
    if (ctl.signal.aborted) throw new Error("the simulator took too long to answer");
    throw new Error("can't reach the simulator — is the RecoilSim window still open?");
  } finally { clearTimeout(timer); }
  const data = await r.json();
  // a job's status carries its own "error" (e.g. "cancelled") as data, not as a failed request
  if (!r.ok || (data.error && data.done === undefined)) throw new Error(data.error || r.statusText);
  return data;
}

/* ------------------------------------------------------------------ formatting */
function debounce(fn, ms) { let t = null; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
const fmt = (v, d = 1) => (v === null || v === undefined || Number.isNaN(v)) ? "–" : Number(v).toFixed(d);
const pct = (v, d = 1) => (v === null || v === undefined) ? "–" : (v * 100).toFixed(d) + "%";
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const titleCase = (s) => String(s).toLowerCase().replace(/(^|[\s-])([a-z])/g, (m, a, b) => a + b.toUpperCase()).replace(/\b(Lmg|Pdw|Dmr|Smg)\b/g, (x) => x.toUpperCase());
const norm = (t) => String(t).toLowerCase().replace(/[^a-z0-9]+/g, "");
const icon = (name, cls = "ic") => `<svg class="${cls}"><use href="#i-${name}"/></svg>`;
function prettyMode(l) { return l === "AUTO" ? "Auto" : l === "SEMI" ? "Semi" : l.startsWith("BURST") ? `Burst ${l.slice(6)}` : titleCase(l); }
function aimOffset() { return state.aimPoints[$("aimPoint").value] || 0; }
function allWeapons() { return Object.entries(state.catalog.classes).flatMap(([cls, l]) => l.map((w) => ({ ...w, cls }))); }
function findWeapon(name) { return allWeapons().find((w) => w.name === name) || null; }
function attLabel(slot, name) {
  const o = state.attNames[slot] && state.attNames[slot][name];
  return o ? o.displayname : name;
}

function setupCanvas(cv) {
  const r = cv.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.round(r.width * dpr)), h = Math.max(1, Math.round(r.height * dpr));
  if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
  const ctx = cv.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w: r.width, h: r.height };
}
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y); ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r); ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h); ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r); ctx.quadraticCurveTo(x, y, x + r, y); ctx.closePath();
}

/* ------------------------------------------------------------------ widgets */
function seg(id, onChange) {
  // segmented control: returns a setter that changes the shown value without firing onChange
  const el = $(id);
  el.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b || b.disabled) return;
    el.querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
    onChange(b.dataset.v);
  });
  return (v) => el.querySelectorAll("button").forEach((x) => x.classList.toggle("on", x.dataset.v === v));
}
function paintRange(el) {
  // filled part of a slider track (WebKit has no native "progress" part)
  const min = +el.min || 0, max = +el.max || 100;
  el.style.setProperty("--p", `${((+el.value - min) / (max - min)) * 100}%`);
}
function setRange(id, v) { const el = $(id); el.value = v; paintRange(el); }

let toastTimer = null;
function toast(msg, ms = 2200) {
  const el = $("toast");
  el.textContent = msg;
  el.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add("hidden"), ms);
}
function showError(msg) {
  const el = $("errBanner");
  el.querySelector(".msg").textContent = msg;
  el.classList.remove("hidden");
}
function hideError() { $("errBanner").classList.add("hidden"); }

/* popovers: one open at a time, closed by Esc / clicking elsewhere */
let openPop = null;
function showPopover(id, anchor, place = "below") {
  closePopover();
  const pop = $(id);
  pop.classList.remove("hidden");
  const a = anchor.getBoundingClientRect(), p = pop.getBoundingClientRect();
  let left, top;
  if (place === "right") { left = a.right + 8; top = a.top - 6; }
  else if (place === "below-right") { left = a.right - p.width; top = a.bottom + 8; }
  else { left = a.left; top = a.bottom + 8; }
  left = Math.max(8, Math.min(left, innerWidth - p.width - 8));
  top = Math.max(8, Math.min(top, innerHeight - p.height - 8));
  pop.style.left = `${left}px`; pop.style.top = `${top}px`;
  openPop = { id, anchor };
  anchor.classList.add("open");
}
function closePopover() {
  if (!openPop) return;
  $(openPop.id).classList.add("hidden");
  openPop.anchor.classList.remove("open");
  const cb = openPop.onClose;
  openPop = null;
  if (cb) cb();
}
document.addEventListener("mousedown", (e) => {
  if (!openPop) return;
  if ($(openPop.id).contains(e.target) || openPop.anchor.contains(e.target)) return;
  closePopover();
});

/* modals */
function openModal(id) { closePopover(); $(id).classList.remove("hidden"); }
function closeModal(id) { $(id).classList.add("hidden"); }
function topModal() { return [...document.querySelectorAll(".modal:not(.hidden)")].pop() || null; }

/* tooltips for the little "?" marks */
(function wireTooltips() {
  const tip = () => $("tooltip");
  document.addEventListener("mouseover", (e) => {
    const t = e.target.closest("[data-tip]");
    if (!t) return;
    const el = tip();
    el.textContent = t.dataset.tip;
    el.classList.remove("hidden");
    const r = t.getBoundingClientRect(), p = el.getBoundingClientRect();
    let left = Math.min(Math.max(8, r.left + r.width / 2 - p.width / 2), innerWidth - p.width - 8);
    let top = r.top - p.height - 8;
    if (top < 8) top = r.bottom + 8;
    el.style.left = `${left}px`; el.style.top = `${top}px`;
  });
  document.addEventListener("mouseout", (e) => { if (e.target.closest("[data-tip]")) tip().classList.add("hidden"); });
})();

/* keyboard navigation for list popovers (weapon / attachment pickers) */
function listNav(input, list, onPick) {
  input.addEventListener("keydown", (e) => {
    const items = [...list.querySelectorAll(".pk-item")];
    if (!items.length) return;
    let i = items.findIndex((x) => x.classList.contains("hl"));
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      i = e.key === "ArrowDown" ? Math.min(items.length - 1, i + 1) : Math.max(0, i - 1);
      items.forEach((x, k) => x.classList.toggle("hl", k === i));
      items[i].scrollIntoView({ block: "nearest" });
    } else if (e.key === "Enter") {
      e.preventDefault();
      onPick((items[i >= 0 ? i : 0]).dataset.v);
    }
  });
}

/* ------------------------------------------------------------------ selects with hover descriptions
   A <select data-hints="name"> opens this menu instead of the browser's list:
   hovering an option shows its description (HINT_SETS[name][value]) under the
   list, and hovering the closed select shows the chosen one's. */
const HINT_SETS = {};
function closeSelMenu() { const m = document.querySelector(".selmenu"); if (m) m.remove(); }
function hintsOf(sel) { return HINT_SETS[sel.dataset.hints] || {}; }
function openSelMenu(sel) {
  const open = document.querySelector(".selmenu");
  closeSelMenu();
  if (open && open._sel === sel) return;
  const hints = hintsOf(sel);
  const m = document.createElement("div");
  m.className = "selmenu";
  m._sel = sel;
  m.innerHTML = `<div class="selmenu-list">${[...sel.options].map((o) => `<button type="button" data-v="${esc(o.value)}" class="${o.value === sel.value ? "cur" : ""}">${esc(o.text)}</button>`).join("")}</div>
    <p class="selmenu-desc"></p>`;
  const desc = m.querySelector(".selmenu-desc");
  const show = (v) => { desc.textContent = hints[v] || ""; desc.hidden = !hints[v]; };
  show(sel.value);
  document.body.appendChild(m);
  const r = sel.getBoundingClientRect();
  m.style.width = `${Math.max(r.width, 340)}px`;
  m.style.left = `${Math.max(8, Math.min(r.left, innerWidth - m.offsetWidth - 8))}px`;
  const h = m.offsetHeight;
  m.style.top = `${r.bottom + 4 + h > innerHeight - 8 ? Math.max(8, r.top - h - 4) : r.bottom + 4}px`;
  m.addEventListener("mouseover", (ev) => { const b = ev.target.closest("[data-v]"); if (b) show(b.dataset.v); });
  m.addEventListener("mouseleave", () => show(sel.value));
  m.addEventListener("click", (ev) => {
    const b = ev.target.closest("[data-v]");
    if (!b) return;
    closeSelMenu();
    if (sel.value !== b.dataset.v) {
      sel.value = b.dataset.v;
      sel.dispatchEvent(new Event("input", { bubbles: true }));
      sel.dispatchEvent(new Event("change", { bubbles: true }));
    }
    sel.title = hints[sel.value] || "";
    sel.focus();
  });
}
document.addEventListener("mousedown", (e) => {
  const sel = e.target.closest("select[data-hints]");
  if (!sel) { if (!e.target.closest(".selmenu")) closeSelMenu(); return; }
  if (e.button !== 0 || sel.disabled) return;
  e.preventDefault();
  sel.focus();
  openSelMenu(sel);
}, true);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && document.querySelector(".selmenu")) { closeSelMenu(); e.stopPropagation(); return; }
  const sel = e.target.closest && e.target.closest("select[data-hints]");
  if (sel && (e.key === "Enter" || e.key === " " || (e.altKey && e.key === "ArrowDown"))) { e.preventDefault(); openSelMenu(sel); }
}, true);
// the closed select's own hover text: the chosen option's description
document.addEventListener("mouseover", (e) => {
  const sel = e.target.closest && e.target.closest("select[data-hints]");
  if (sel) sel.title = hintsOf(sel)[sel.value] || "";
});
window.addEventListener("resize", closeSelMenu);
document.addEventListener("scroll", (e) => { if (!(e.target.closest && e.target.closest(".selmenu"))) closeSelMenu(); }, true);
