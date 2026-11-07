/* RecoilSim front-end: full-window 3D range, overlay panels, pattern/heatmap,
   pattern snapshots, stats with shots-to-kill breakpoints and the optimiser. */
"use strict";

const $ = (id) => document.getElementById(id);
const PART_COLORS = ["#ff4d6d", "#ffb020", "#3ec7ff", "#3ec7ff", "#3ec7ff", "#3ec7ff"];
const PART_RGB = [[1, 0.3, 0.43], [1, 0.69, 0.13], [0.24, 0.78, 1], [0.24, 0.78, 1], [0.24, 0.78, 1], [0.24, 0.78, 1]];
const MISS_COLOR = "#7d8794";
const PART_GROUP = ["head", "torso", "limb", "limb", "limb", "limb"];
const SLOTS = ["Optics", "Barrel", "Underbarrel", "Other", "Ammo"];
const STORE_KEY = "recoilsim.v2";
const SNAP_COLORS = ["#b48cff", "#4dffb5", "#ff7ad9", "#7ab8ff", "#ffe066", "#ff9a5c"];
const TARGET_BASE = 3.0;   // torso centre height above the baseplate
const WALL_GAP = 12;       // back wall distance behind the target
const BASE_FOV = 70;       // degrees, vertical

const state = {
  catalog: null, hitboxes: [], aimPoints: {},
  weapon: null, weaponInfo: null, attachments: {}, attNames: {},
  stats: null, lastDump: null, lastWatch: null,
  holes: [], anim: null,
  patternView: "heat", patternFit: "all", patternZoom: 1,
  aiming: true, stance: "stand", view: "first",
  aimBlend: 1, scene: null, orbit: { yaw: 0.75, pitch: 0.2, dist: 6.5 },
  snapshots: [], saved: {}, excludes: {},
};

/* ------------------------------------------------------------------ utils */
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
function saveIsDefault(prev) {
  // nothing worth offering: same as what a fresh start looks like
  if ((prev.snapshots || []).length) return false;
  if (Object.values(prev.excludes || {}).some((slots) => Object.values(slots || {}).some((l) => (l || []).length))) return false;
  if (Object.values(prev.attachments || {}).some((a) => Object.values(a || {}).some(Boolean))) return false;
  if (prev.weapon && prev.weapon !== state.weapon) return false;
  if (prev.view && prev.view !== state.view) return false;
  if (prev.settings && stableJSON(prev.settings) !== stableJSON(settings())) return false;
  if (prev.ui && stableJSON(prev.ui) !== stableJSON(uiState())) return false;
  return true;
}
function offerPreviousSave() {
  const prev = state.prevSave;
  if (!prev) return;
  if (saveIsDefault(prev)) {
    // the last session never changed anything: just start, no question
    state.prevSave = null;
    state.awaitingLoadChoice = false;
    return;
  }
  const name = prev.weapon && findWeapon(prev.weapon) ? (Object.values(state.catalog.classes).flat().find((w) => w.name === prev.weapon) || {}).displayname : null;
  const atts = prev.weapon && prev.attachments && prev.attachments[prev.weapon] ? Object.values(prev.attachments[prev.weapon]).filter(Boolean).length : 0;
  const snaps = (prev.snapshots || []).length;
  $("loadInfo").innerHTML = `Last time: ${name ? `<b>${esc(name)}</b>${atts ? ` with ${atts} attachment${atts === 1 ? "" : "s"}` : ""}` : "your settings"}${prev.settings ? `, ${prev.settings.distance} studs, ${prev.settings.aiming === false ? "hip fire" : "aimed"}` : ""}${snaps ? `, ${snaps} saved pattern${snaps === 1 ? "" : "s"}` : ""}. Load it, or start fresh with the defaults? (Starting fresh replaces the old save once you change something.)`;
  $("loadModal").classList.remove("hidden");
  const close = () => { $("loadModal").classList.add("hidden"); state.awaitingLoadChoice = false; };
  $("loadNo").onclick = () => { close(); state.prevSave = null; store(); };
  $("loadYes").onclick = async () => {
    // work from a copy: restoring settings saves as it goes, and that must not
    // overwrite the values still to be restored (it used to reset the gun)
    const save = JSON.parse(JSON.stringify(prev));
    const w = save.weapon && findWeapon(save.weapon) ? save.weapon : state.weapon;
    const atts = (save.attachments || {})[w] || {};
    state.saved = JSON.parse(JSON.stringify(prev));
    state.snapshots = Array.isArray(save.snapshots) ? save.snapshots : [];
    state.excludes = save.excludes || {};
    close();
    state.restoring = true;
    if (save.settings) applySavedSettings(save.settings);
    if (save.view) { state.view = save.view; setViewSeg(save.view); }
    applyUi(save.ui);
    renderSnapList();
    buildWeaponSelect("");
    $("weaponSelect").value = w;
    await selectWeapon(w, atts);
    if (save.settings) applySavedSettings(save.settings); // fire mode / trigger rate need the gun loaded
    state.restoring = false;
    saveSettings();
    onLoadoutChanged();
    drawPattern(); renderCompare();
  };
}
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
  if (!r.ok || data.error) throw new Error(data.error || r.statusText);
  return data;
}
function debounce(fn, ms) { let t = null; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
const fmt = (v, d = 1) => (v === null || v === undefined || Number.isNaN(v)) ? "–" : Number(v).toFixed(d);
const pct = (v, d = 1) => (v === null || v === undefined) ? "–" : (v * 100).toFixed(d) + "%";
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
function setupCanvas(cv) {
  const r = cv.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.round(r.width * dpr)), h = Math.max(1, Math.round(r.height * dpr));
  if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
  const ctx = cv.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w: r.width, h: r.height };
}
function seg(id, onChange) {
  const el = $(id);
  el.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    el.querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
    onChange(b.dataset.v);
  });
  return (v) => el.querySelectorAll("button").forEach((x) => x.classList.toggle("on", x.dataset.v === v));
}
function aimOffset() { return state.aimPoints[$("aimPoint").value] || 0; }

/* ------------------------------------------------------------------ settings */
function settings() {
  return {
    distance: +$("distanceNum").value || 50,
    aiming: state.aiming,
    stance: state.stance,
    firemode_index: +$("firemode").value || 0,
    firemode_label: $("firemode").selectedIndex >= 0 ? $("firemode").options[$("firemode").selectedIndex].text : null,
    shots: $("shots").value ? +$("shots").value : null,
    trigger_rpm: $("triggerRpm").value ? +$("triggerRpm").value : null,
    compensation: +$("comp").value,
    aim_point: $("aimPoint").value,
    gravity: $("gravity").checked,
    fps: +$("fps").value,
    health: +$("health").value || 100,
  };
}
function uiState() {
  // everything about the page worth bringing back with "Load previous session"
  const tab = document.querySelector(".panel-tabs [data-tab].on");
  return {
    dumps: +$("dumps").value || 500, autoRun: $("autoRun").checked, sound: $("sound").checked, speed: $("speed").value,
    patternView: state.patternView, patternFit: state.patternFit, patternZoom: state.patternZoom,
    metric: $("metric").value, optComp: +$("optComp").value, optAiming: state.optAiming !== false, leftTab: tab ? tab.dataset.tab : "loadout",
    leftHidden: $("leftPanel").classList.contains("hidden"), rightHidden: $("rightPanel").classList.contains("hidden"),
    orbit: state.orbit,
  };
}
function applyUi(u) {
  if (!u) return;
  if (u.dumps) $("dumps").value = u.dumps;
  if (u.autoRun != null) $("autoRun").checked = u.autoRun;
  if (u.sound != null) $("sound").checked = u.sound;
  if (u.speed) $("speed").value = u.speed;
  if (u.patternView) { state.patternView = u.patternView; setPatViewSeg(u.patternView); }
  if (u.patternFit) { state.patternFit = u.patternFit; setFitSeg(u.patternFit); }
  if (u.metric && [...$("metric").options].some((o) => o.value === u.metric)) $("metric").value = u.metric;
  if (u.optComp != null) { $("optComp").value = u.optComp; $("optCompVal").textContent = `${u.optComp}%`; }
  if (u.optAiming != null) { state.optAiming = u.optAiming; setOptAimSeg(u.optAiming ? "aim" : "hip"); }
  if (u.leftTab) { const b = document.querySelector(`.panel-tabs [data-tab="${u.leftTab}"]`); if (b) b.click(); }
  if (u.leftHidden) collapse("leftPanel", true);
  if (u.rightHidden) collapse("rightPanel", true);
  if (u.orbit) state.orbit = { ...state.orbit, ...u.orbit };
  if (u.patternZoom) setZoom(u.patternZoom);
}
function saveSettings() {
  state.saved.settings = settings();
  state.saved.ui = uiState();
  state.saved.view = state.view;
  state.saved.weapon = state.weapon;
  state.saved.attachments = state.saved.attachments || {};
  state.saved.attachments[state.weapon] = state.attachments;
  store();
}
function applySavedSettings(s) {
  if (s.distance) { $("distanceNum").value = s.distance; $("distance").value = Math.min(600, s.distance); }
  state.aiming = s.aiming !== false; setAimSeg(state.aiming ? "aim" : "hip"); state.aimBlend = state.aiming ? 1 : 0;
  state.stance = s.stance || "stand"; setStanceSeg(state.stance);
  if (s.shots) $("shots").value = s.shots;
  if (s.trigger_rpm) $("triggerRpm").value = s.trigger_rpm;
  $("comp").value = s.compensation || 0; $("compVal").textContent = `${$("comp").value}%`;
  if (s.aim_point) $("aimPoint").value = s.aim_point;
  $("gravity").checked = s.gravity !== false;
  if (s.fps) $("fps").value = String(s.fps);
  if (s.health) $("health").value = s.health;
  if (s.firemode_label) {
    const o = [...$("firemode").options].find((x) => x.text === s.firemode_label);
    if (o) { $("firemode").value = o.value; updateTriggerRow(); }
  }
}

/* ------------------------------------------------------------------ init */
let R = null; // RangeRenderer
async function init() {
  loadStore();
  try { R = new RangeRenderer($("gl")); } catch (e) { $("hud").textContent = `3D view unavailable: ${e.message}`; }
  // if the graphics driver resets, rebuild the 3D view instead of freezing on the last frame
  $("gl").addEventListener("webglcontextlost", (e) => { e.preventDefault(); if (R) R.lost = true; showError("The graphics driver reset the 3D view — restoring it…"); });
  $("gl").addEventListener("webglcontextrestored", () => {
    try { R = new RangeRenderer($("gl")); buildTargetGeometry(); state.mountEye = null; loadScene(); hideError(); } catch (e) { showError(`3D view lost: ${e.message}`); }
  });
  window.addEventListener("error", (e) => showError(`Error: ${e.message}`));
  window.addEventListener("unhandledrejection", (e) => showError(`Error: ${(e.reason && e.reason.message) || e.reason}`));
  const cat = await api("/api/catalog");
  state.catalog = cat;
  state.hitboxes = cat.hitboxes;
  state.aimPoints = cat.aim_points;
  const meta = cat.meta || {};
  const n = Object.values(cat.classes).reduce((a, l) => a + l.length, 0);
  $("meta").textContent = `${n} guns · ${meta.exportedAt ? meta.exportedAt.slice(0, 10) : ""}`;
  const apLabels = { head: "Head", neck: "Neck", chest: "Upper chest", torso: "Torso centre", stomach: "Stomach", legs: "Legs" };
  for (const k of Object.keys(cat.aim_points)) $("aimPoint").add(new Option(apLabels[k] || k, k));
  $("aimPoint").value = "torso";
  for (const [k, m] of Object.entries(cat.metrics)) $("metric").add(new Option(m.label, k));
  $("metric").value = "accuracy";
  buildWeaponSelect("");
  if (state.saved.settings) applySavedSettings(state.saved.settings);
  if (state.saved.view) { state.view = state.saved.view; setViewSeg(state.view); }
  if (window.innerWidth < 760) collapse("rightPanel", true);
  const first = state.saved.weapon && findWeapon(state.saved.weapon) ? state.saved.weapon : (findWeapon("AK47") ? "AK47" : $("weaponSelect").options[0].value);
  $("weaponSelect").value = first;
  buildTargetGeometry();
  await selectWeapon(first, (state.saved.attachments || {})[first]);
  wireEvents();
  renderSnapList();
  window.addEventListener("resize", debounce(() => { layoutPanels(); drawPattern(); drawDamageGraph(); drawPerShot(); }, 80));
  layoutPanels();
  requestAnimationFrame(frame);
  offerPreviousSave();
  warmupRtt();
}
async function warmupRtt() {
  // measure how long a replay request takes so hold-to-fire can hide it
  for (let i = 0; i < 3; i++) {
    const t0 = performance.now();
    try { await api("/api/simulate", { weapon: state.weapon, attachments: state.attachments, settings: { ...settings(), seed: 1, trigger_holds: [[0, 0.2]], track_end: 1 }, runs: 1, track: true }); } catch (e) { return; }
    const dt = performance.now() - t0;
    state.rtt = state.rtt ? 0.5 * state.rtt + 0.5 * dt : dt;
  }
}

function showError(msg) {
  const el = $("errBanner");
  el.querySelector(".msg").textContent = msg;
  el.classList.remove("hidden");
}
function hideError() { $("errBanner").classList.add("hidden"); }

function findWeapon(name) { return Object.values(state.catalog.classes).some((l) => l.some((w) => w.name === name)); }

function buildWeaponSelect(filter) {
  const sel = $("weaponSelect");
  const cur = sel.value;
  sel.innerHTML = "";
  // ignore case, spaces and punctuation so "ak12/76", "AK-12/76" and "ak 12 76" all match
  const norm = (t) => String(t).toLowerCase().replace(/[^a-z0-9]+/g, "");
  let f = norm(filter);
  const matches = (w, cls) => !f || norm(w.displayname).includes(f) || norm(w.name).includes(f) || norm(cls).includes(f);
  const any = Object.entries(state.catalog.classes).some(([cls, list]) => list.some((w) => matches(w, cls)));
  const noMatch = f && !any;
  if (noMatch) f = "";   // nothing matched: list every gun so you can always pick one
  for (const [cls, list] of Object.entries(state.catalog.classes)) {
    const items = list.filter((w) => matches(w, cls));
    if (!items.length) continue;
    const g = document.createElement("optgroup");
    g.label = cls;
    for (const w of items) g.appendChild(new Option(w.displayname, w.name));
    sel.appendChild(g);
  }
  const n = sel.options.length;
  if ((f || noMatch) && !(n === 1 && sel.options[0].value === cur)) {
    // placeholder on top so picking any match (even the first) fires "change"
    const ph = new Option(noMatch ? "No guns match — showing all" : `${n} match${n === 1 ? "" : "es"} — pick one (Enter = first)`, "");
    ph.disabled = true;
    sel.insertBefore(ph, sel.firstChild);
    sel.value = "";
    sel.selectedIndex = 0;
  } else if ([...sel.options].some((o) => o.value === cur)) sel.value = cur;
}
function equipFromSelect(name) {
  if (!name || name === state.weapon) return;
  $("weaponSearch").value = "";
  buildWeaponSelect("");
  $("weaponSelect").value = name;
  $("weaponSelect").blur();
  selectWeapon(name, (state.saved.attachments || {})[name]);
}

async function selectWeapon(name, atts) {
  // switching guns always ends any firing in progress
  try { stopFiring(); } catch (e) { state.anim = null; }
  state.session = null;
  state.weapon = name;
  const info = await api(`/api/weapon?name=${encodeURIComponent(name)}`);
  state.weaponInfo = info;
  $("weaponName").textContent = info.displayname;
  $("weaponDesc").textContent = info.description || "";
  const fm = $("firemode");
  fm.innerHTML = "";
  info.firemodes.forEach((l, i) => fm.add(new Option(l, i)));
  const savedFm = state.saved.settings && state.saved.settings.firemode_index;
  if (savedFm !== undefined && savedFm < info.firemodes.length && state.saved.weapon === name) fm.value = savedFm;
  updateTriggerRow();
  const box = $("attachmentSlots");
  box.innerHTML = "";
  state.attachments = {};
  state.attNames = {};
  for (const slot of SLOTS) {
    const opts = info.attachments[slot] || [];
    state.attNames[slot] = {};
    const row = document.createElement("div");
    row.className = "row";
    const lab = document.createElement("label");
    lab.textContent = slot;
    const sel = document.createElement("select");
    sel.dataset.slot = slot;
    sel.add(new Option(opts.length ? "None" : "—", ""));
    const groups = {};
    for (const o of opts) {
      state.attNames[slot][o.name] = o;
      if (!groups[o.category]) { groups[o.category] = document.createElement("optgroup"); groups[o.category].label = o.category; sel.appendChild(groups[o.category]); }
      const op = new Option(o.displayname, o.name);
      op.title = o.info;
      groups[o.category].appendChild(op);
    }
    sel.disabled = !opts.length;
    if (atts && atts[slot] && state.attNames[slot][atts[slot]]) { sel.value = atts[slot]; state.attachments[slot] = atts[slot]; }
    sel.addEventListener("change", () => {
      if (sel.value) state.attachments[slot] = sel.value; else delete state.attachments[slot];
      const o = state.attNames[slot][sel.value];
      $("attInfo").textContent = o ? `${o.displayname}: ${o.info}` : "";
      onLoadoutChanged();
    });
    row.append(lab, sel);
    box.appendChild(row);
  }
  $("attInfo").textContent = "";
  $("optResults").innerHTML = "";
  $("optProgress").classList.remove("show");
  state.holes = [];
  state.lastWatch = null;
  state.dmgView = null;
  onLoadoutChanged();
}

function setSelectsFromState() {
  document.querySelectorAll("#attachmentSlots select").forEach((sel) => { sel.value = state.attachments[sel.dataset.slot] || ""; });
}
function syncFiremodes(labels) {
  // attachments (e.g. conversion kits) can change which fire modes exist:
  // rebuild the list from the compiled gun and keep the same mode by name
  if (!Array.isArray(labels) || !labels.length) return;
  const fm = $("firemode");
  const cur = [...fm.options].map((o) => o.text);
  if (cur.length === labels.length && cur.every((t, i) => t === labels[i])) return;
  const prev = fm.options[fm.selectedIndex] ? fm.options[fm.selectedIndex].text : null;
  fm.innerHTML = "";
  labels.forEach((l, i) => fm.add(new Option(l, i)));
  const keep = labels.indexOf(prev);
  fm.value = String(keep >= 0 ? keep : 0);
  updateTriggerRow();
  if (keep < 0 && prev) {
    $("attInfo").textContent = `Fire mode ${prev} isn't available with this setup, so it switched to ${labels[0]}.`;
  }
  saveSettings();
  if (state.lastDump) autoRun();
}
function updateTriggerRow() {
  const sel = $("firemode");
  const label = sel.options[sel.selectedIndex] ? sel.options[sel.selectedIndex].text : "AUTO";
  $("triggerRow").style.display = label === "AUTO" || label === "SWITCH" ? "none" : "";
}
function attLabel(slot, name) {
  const o = state.attNames[slot] && state.attNames[slot][name];
  return o ? o.displayname : name;
}

/* ------------------------------------------------------------------ gun model */
let sceneReq = 0;
async function loadScene() {
  const id = ++sceneReq;
  try {
    const { scene } = await api("/api/model", { weapon: state.weapon, attachments: state.attachments });
    if (id !== sceneReq) return;
    state.scene = scene;
    if (R && scene) {
      const geo = buildPartGeometry(scene.parts, scene.meshes);
      R.upload("gun", geo.opaque);
      R.upload("gunClear", geo.clear);
      scene.hipM = M4.fromCF(scene.hip);
      scene.aimM = M4.fromCF(scene.aim);
    }
  } catch (e) { console.warn("model", e); }
}

function buildTargetGeometry() {
  if (!R) return;
  const out = [];
  const col = { Head: [0.95, 0.8, 0.45], Torso: [0.16, 0.36, 0.72], "Left Arm": [0.95, 0.8, 0.45], "Right Arm": [0.95, 0.8, 0.45], "Left Leg": [0.3, 0.55, 0.25], "Right Leg": [0.3, 0.55, 0.25] };
  for (const [name, hx, hy, hw, hh] of state.hitboxes.length ? state.hitboxes : []) {
    Geo.box(out, M4.trans(hx, TARGET_BASE + hy, 0), hw * 2, hh * 2, 1, [...(col[name] || [0.7, 0.7, 0.7]), 1]);
  }
  Geo.box(out, M4.trans(0, 0.06, 0), 3.2, 0.12, 1.6, [0.35, 0.36, 0.4, 1]);
  R.upload("target", out);
}

function buildMount(eyeY) {
  if (!R) return;
  const out = [];
  Geo.cylinder(out, M4.trans(0, (eyeY - 0.5) / 2, -0.9), eyeY - 0.5, 0.07, 0.07, 1, [0.22, 0.23, 0.26, 1]);
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2;
    const M = M4.mul(M4.trans(Math.cos(a) * 0.45, 0.35, -0.9 + Math.sin(a) * 0.45), M4.mul(M4.rotY(-a), M4.axisAngle([0, 0, 0.9])));
    Geo.cylinder(out, M, 1.0, 0.04, 0.04, 1, [0.22, 0.23, 0.26, 1]);
  }
  Geo.box(out, M4.trans(0, eyeY - 0.5, -0.9), 0.35, 0.08, 0.6, [0.3, 0.31, 0.34, 1]);
  R.upload("mount", out);
  state.mountEye = eyeY;
}

/* ------------------------------------------------------------------ frame */
const POSE_KEYS = ["body", "rot", "trans", "spread", "head", "comp"];
function poseDiff(a, b) { const o = {}; for (const k of POSE_KEYS) o[k] = a[k].map((v, i) => v - b[k][i]); return o; }
function trackState(t) {
  const A = state.anim;
  const sp = trackStateOf(A, t);
  if (A && A.blend) {
    const k = (performance.now() - A.blend.start) / A.blend.dur;
    if (k >= 1) A.blend = null;
    else {
      const w = 1 - k * k * (3 - 2 * k); // smoothstep fade of the old-new difference
      for (const key of POSE_KEYS) sp[key] = sp[key].map((v, i) => v + A.blend.offset[key][i] * w);
    }
  }
  return sp;
}
function trackStateOf(A, t) {
  // spring state for the replay at time t (seconds since the first shot)
  const zero = { body: [0, 0, 0], rot: [0, 0, 0], trans: [0, 0, 0], spread: [0, 0, 0], head: [0, 0, 0], x: 0, y: 0, comp: [0, 0] };
  if (!A || !A.track.length) return zero;
  const tr = A.track;
  if (A.freezeAt != null) t = Math.min(t, A.freezeAt);
  let i = A.trackIdx || 0;
  if (i >= tr.length || tr[i][0] > t) i = 0;
  while (i < tr.length - 1 && tr[i + 1][0] <= t) i++;
  A.trackIdx = i;
  const a = tr[i], b = tr[Math.min(i + 1, tr.length - 1)];
  const f = b[0] > a[0] ? Math.min(1, Math.max(0, (t - a[0]) / (b[0] - a[0]))) : 0;
  const L = (k) => a[k] + (b[k] - a[k]) * f;
  return {
    x: L(1), y: L(2),
    body: [L(3), L(4), L(5)], rot: [L(6), L(7), L(8)], trans: [L(9), L(10), L(11)],
    spread: [L(12), L(13), L(14)], head: [L(15), L(16), L(17)],
    comp: a.length > 19 ? [L(18), L(19)] : [0, 0],
  };
}

function gunMatrices(eyeY, sp) {
  // mirrors FirearmObject: mainC0 = shake * mainoffset * T(pose.p) * R(spread) * T(trans) * R(rot) * Rot(pose)
  const sc = state.scene;
  // recoil control: the shooter turns the camera against the average climb
  const Dc = (state.anim && state.anim.res && state.anim.res.distance) || settings().distance;
  const C = M4.mul(M4.rotY(Math.atan2(sp.comp[0], Dc)), M4.rotX(-Math.atan2(sp.comp[1], Dc)));
  const B = M4.mul(M4.trans(0, eyeY, 0), M4.mul(C, M4.axisAngle(sp.body)));
  if (!sc) return { B, gun: null };
  const hip = sc.hipM, aim = sc.aimM, k = state.aimBlend;
  const pose = new Float32Array(hip);
  for (let i = 12; i < 15; i++) pose[i] = hip[i] + (aim[i] - hip[i]) * k;
  if (k > 0.5) for (const i of [0, 1, 2, 4, 5, 6, 8, 9, 10]) pose[i] = aim[i];
  const rotOnly = new Float32Array(pose); rotOnly[12] = rotOnly[13] = rotOnly[14] = 0;
  const C0 = M4.mul(M4.trans(pose[12], pose[13], pose[14]),
    M4.mul(M4.axisAngle(sp.spread), M4.mul(M4.trans(sp.trans[0], sp.trans[1], sp.trans[2]), M4.mul(M4.axisAngle(sp.rot), rotOnly))));
  return { B, gun: M4.mul(B, C0) };
}

function frame(now) {
  requestAnimationFrame(frame);
  try { renderFrame(now); } catch (e) {
    // never let one bad frame freeze the range: drop the replay and report it
    console.error(e);
    state.anim = null; state.session = null;
    showError(`Replay error (firing was reset): ${e.message}`);
  }
}
function renderFrame(now) {
  if (!R || R.lost) { drawOverlay(null); return; }
  const s = settings();
  const D = s.distance;
  const eyeY = TARGET_BASE + aimOffset();
  const A = state.anim;
  const t = animTime(A);
  const sp = trackState(t);
  // smooth aim transition
  const target = state.aiming ? 1 : 0;
  const dt = Math.min(0.05, (now - (state.lastNow || now)) / 1000);
  state.lastNow = now;
  state.aimBlend += (target - state.aimBlend) * (1 - Math.exp(-dt * 12));
  if (Math.abs(target - state.aimBlend) < 0.002) state.aimBlend = target;

  const { B, gun } = gunMatrices(eyeY, sp);
  const sc = state.scene;
  const first = state.view === "first";
  let camWorld, fovy;
  if (first) {
    camWorld = M4.mul(B, M4.axisAngle(sp.head));
    const zoom = sc ? 1 + (sc.zoom - 1) * state.aimBlend : 1;
    fovy = 2 * Math.atan(Math.tan((BASE_FOV * Math.PI) / 360) / zoom);
  } else {
    const o = state.orbit;
    const c = [0, eyeY, -1.2];
    const eye = [c[0] + Math.sin(o.yaw) * Math.cos(o.pitch) * o.dist, c[1] + Math.sin(o.pitch) * o.dist, c[2] + Math.cos(o.yaw) * Math.cos(o.pitch) * o.dist];
    camWorld = M4.lookAt(eye, [0, eyeY - 0.4, -Math.min(D * 0.3, 8) - 1.5]);
    fovy = (55 * Math.PI) / 180;
  }
  R.begin({ world: camWorld, fovy, near: first ? 0.03 : 0.1, far: 30000 });
  const fog = [Math.max(250, D * 1.5), Math.max(2500, D * 6)];
  R.drawPlane([[-20000, 0, 20000], [20000, 0, 20000], [20000, 0, -20000], [-20000, 0, -20000]], 0, [0.43, 0.45, 0.42], [0.36, 0.38, 0.35], [0.3, 0.32, 0.29], fog);
  const wz = -(D + WALL_GAP);
  R.drawPlane([[-20000, -1, wz], [20000, -1, wz], [20000, 8000, wz], [-20000, 8000, wz]], 1, [0.52, 0.5, 0.46], [0.46, 0.44, 0.4], [0.4, 0.38, 0.35], fog);
  R.drawMesh("target", M4.trans(0, 0, -D), { fogRange: fog });
  if (!first) {
    if (state.mountEye !== eyeY) buildMount(eyeY);
    R.drawMesh("mount", null, { fogRange: fog });
  }

  // holes
  const pts = [];
  for (const h of state.holes) {
    if (A && h.anim === A && (h.time > t || (A.cutoff != null && h.shot >= A.cutoff))) continue;
    const c = h.part >= 0 ? PART_RGB[h.part] : [0.16, 0.16, 0.16];
    pts.push([h.w[0], h.w[1], h.w[2], c[0], c[1], c[2], 0.95, h.part >= 0 ? 0.16 : 0.22]);
  }
  R.drawPoints(pts, false, false);

  // tracers + flash
  let flash = false;
  if (A) {
    for (const b of A.bullets) if (!b.from && t >= b.t0) b.from = gun && sc ? Array.from(M4.apply(gun, sc.muzzle)) : [0, eyeY - 0.3, -2];
    const segs = [];
    for (const b of A.bullets) {
      const d = t - b.t0;
      if (d >= 0 && d < 0.045 && !(A.cutoff != null && b.t0 >= A.cutoff)) flash = true;
      if (d < 0 || d > b.tt + 0.02 || !b.from || (A.cutoff != null && b.t0 >= A.cutoff)) continue;
      const f = Math.min(1, d / b.tt);
      const head = b.from.map((v, i) => v + (b.to[i] - v) * f);
      const tf = Math.max(0, f - Math.min(0.5, 14 / (b.dist + 1)));
      const tail = b.from.map((v, i) => v + (b.to[i] - v) * tf);
      segs.push([tail, head, 0.05, 1, 0.55, 0.35, 0.95]);
    }
    R.drawRibbons(segs);
  }

  // gun
  const hideGun = first && sc && sc.blackscope && state.aimBlend > 0.85;
  if (gun && !hideGun) {
    // aiming in 1st person fades the gun so the target stays visible
    const alpha = first ? 1 - 0.8 * Math.max(0, (state.aimBlend - 0.4) / 0.6) : 1;
    R.drawMesh("gun", gun, { alpha, fogRange: [1e5, 2e5] });
    R.drawMesh("gunClear", gun, { blend: true, alpha: Math.max(alpha, 0.35), fogRange: [1e5, 2e5] });
  }
  if (flash && gun && sc && !hideGun) {
    const m = M4.apply(gun, sc.muzzle);
    R.drawPoints([[m[0], m[1], m[2], 1, 0.78, 0.4, 0.95, 0.9]], true, true);
  }
  drawOverlay({ s, D, eyeY, t, A, first, sp });
  if (A && t > A.end && !(state.session && state.session.holding && A.sess === state.session.id)) {
    state.anim = null; drawPattern();
    if (state.session && state.session.empty) state.session = null;
  }
  const firing = isFiring();
  if (state.fireLabel !== firing) { state.fireLabel = firing; $("fireBtn").textContent = firing ? "■ Stop" : "▶ Fire mag"; }
}

function drawOverlay(o) {
  const cv = $("overlay");
  const { ctx, w, h } = setupCanvas(cv);
  ctx.clearRect(0, 0, w, h);
  if (!o) return;
  const { D, eyeY, t, A, first } = o;
  // distance markers on the baseplate
  ctx.font = "bold 12px Consolas, monospace"; ctx.textAlign = "center";
  for (const m of [10, 25, 50, 75, 100, 150, 200, 250, 300, 400, 500, 600, 800, 1000, 1500]) {
    if (m >= D - 2) break;
    const p = R.project([-5, 0.05, -m]);
    if (!p) continue;
    ctx.fillStyle = "rgba(20,24,28,0.75)"; ctx.fillText(`${m}`, p[0] + 1, p[1] + 1);
    ctx.fillStyle = "rgba(255,245,215,0.95)"; ctx.fillText(`${m}`, p[0], p[1]);
  }
  const tp = R.project([0, TARGET_BASE + 3, -D]);
  if (tp && !(first && state.aimBlend > 0.5)) { ctx.fillStyle = "rgba(255,245,215,0.95)"; ctx.fillText(`${D} studs`, tp[0], tp[1] - 4); }
  ctx.textAlign = "left";

  // reticle / scope
  const cx = w / 2, cy = h / 2;
  const sc = state.scene;
  if (first) {
    if (state.aimBlend > 0.85) {
      if (sc && sc.blackscope) {
        const r = Math.min(w, h) * 0.44;
        ctx.fillStyle = "#000";
        ctx.beginPath(); ctx.rect(0, 0, w, h); ctx.arc(cx, cy, r, 0, Math.PI * 2, true); ctx.fill();
        ctx.strokeStyle = "rgba(0,0,0,0.85)"; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.moveTo(cx - r, cy); ctx.lineTo(cx - 8, cy); ctx.moveTo(cx + 8, cy); ctx.lineTo(cx + r, cy); ctx.moveTo(cx, cy + 8); ctx.lineTo(cx, cy + r); ctx.stroke();
      }
      ctx.fillStyle = "rgba(255,40,40,0.95)"; ctx.beginPath(); ctx.arc(cx, cy, 2.2, 0, Math.PI * 2); ctx.fill();
    } else if (state.aimBlend < 0.2) {
      ctx.strokeStyle = "rgba(255,255,255,0.85)"; ctx.lineWidth = 1.5;
      const g = 9, l = 7;
      ctx.beginPath();
      ctx.moveTo(cx - g - l, cy); ctx.lineTo(cx - g, cy); ctx.moveTo(cx + g, cy); ctx.lineTo(cx + g + l, cy);
      ctx.moveTo(cx, cy - g - l); ctx.lineTo(cx, cy - g); ctx.moveTo(cx, cy + g); ctx.lineTo(cx, cy + g + l);
      ctx.stroke();
    }
  }

  // HUD text
  const wn = state.weaponInfo ? state.weaponInfo.displayname : "";
  if (A) {
    const live = (x) => x <= t && !(A.cutoff != null && x >= A.cutoff);
    const fired = A.times.filter(live).length;
    let hits = 0, head = 0, torso = 0, limb = 0, dmg = 0;
    for (const b of A.bullets) if (b.t0 + b.tt <= t && b.part >= 0 && !(A.cutoff != null && b.t0 >= A.cutoff)) {
      hits++; dmg += b.dmg;
      const g = PART_GROUP[b.part]; if (g === "head") head++; else if (g === "torso") torso++; else limb++;
    }
    $("hud").textContent = `${wn} · ${A.firemode} · ${liveRpm(A, t)} rpm · shot ${fired}/${A.sess ? magShots() : A.times.length}\nhits ${hits}/${fired * ((A.res.impacts[0][0] || [0]).length)} (H ${head} T ${torso} L ${limb}) · damage ${Math.round(dmg)}` + (A.killAt != null && t >= A.killAt ? ` · KILL in ${Math.round(A.killAt * 1000)} ms` : "");
    const count = A.shotArrivals.filter((x, i) => x <= t && !(A.cutoff != null && A.times[i] >= A.cutoff)).length;
    if (count !== A.lastCount) { A.lastCount = count; drawPattern({ impacts: A.res.impacts[0], parts: A.res.parts[0], count, from: A.clearFrom || 0 }); }
    while (A.nextSound < A.times.length && A.times[A.nextSound] <= t && !(A.cutoff != null && A.times[A.nextSound] >= A.cutoff)) { shotSound(); A.lastSoundT = A.times[A.nextSound]; A.nextSound++; }
  } else {
    const S = state.session;
    const mag = S && !S.empty && S.fired ? `   mag ${magShots() - S.fired}/${magShots()} left` : "";
    const rl = state.reloadNote && performance.now() - state.reloadNote < 1500 ? "   RELOADED" : "";
    $("hud").textContent = `${wn} · ${nominalRpm()} rpm · ${D} studs · ${state.aiming ? "aimed" : "hip fire"} · ${state.stance}${mag}${rl}   [hold LMB] shoot  [F] fire mag  [R] reload  [C] clear holes  [X] clear dumps  [H] aim/hip  [V] view`;
  }
}

/* ------------------------------------------------------------------ fire rate shown on screen */
function nominalRpm() {
  // the selected fire mode's rate (aimed fire rate when aiming, if the gun has one)
  const st = state.stats;
  if (!st) return "–";
  if (state.aiming && st.aimedfirerate) return Math.round(st.aimedfirerate);
  const fmi = +$("firemode").value || 0;
  const fr = st.firerate;
  const v = Array.isArray(fr) ? (st.variablefirerate ? fr[Math.min(fmi, fr.length - 1)] : fr[0]) : fr;
  return v ? Math.round(v) : "–";
}
function liveRpm(A, t) {
  // rate between the last two shots actually fired (shows burst rates, heat
  // ramp-up / slow-down and auto-burst); falls back to the gun's rate in pauses
  let k = -1;
  for (let i = 0; i < A.times.length && A.times[i] <= t; i++) {
    if (A.cutoff != null && A.times[i] >= A.cutoff) break;
    k = i;
  }
  if (k >= 1) {
    const last = A.times[k] - A.times[k - 1];
    if (last > 1e-6 && last < 1 && t - A.times[k] < Math.max(0.35, last * 1.5)) {
      // average the last few intervals of this trigger pull: shots land on frame
      // boundaries, so single intervals jump between e.g. 600 and 720 rpm
      let j = k, n = 0;
      while (j >= 1 && n < 6) {
        const dt = A.times[j] - A.times[j - 1];
        if (dt > Math.max(2.2 * last, last + 0.05)) break; // a pause: new pull
        j--; n++;
      }
      return Math.round((60 * n) / (A.times[k] - A.times[k - n]));
    }
  }
  return nominalRpm();
}

/* ------------------------------------------------------------------ sound */
let audioCtx = null;
function shotSound() {
  if (!$("sound").checked || !audioCtx) return;
  try {
    const ac = audioCtx, len = 0.18;
    const buf = ac.createBuffer(1, Math.floor(ac.sampleRate * len), ac.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / d.length, 3.5);
    const src = ac.createBufferSource(); src.buffer = buf;
    const lp = ac.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 2400;
    const g = ac.createGain(); g.gain.value = 0.22;
    src.connect(lp); lp.connect(g); g.connect(ac.destination);
    src.start();
  } catch (e) { /* audio unavailable */ }
}

/* ------------------------------------------------------------------ firing replay */
function impactWorld(x, y, part, D, eyeY) {
  if (part >= 0) return [x, eyeY + y, -D + 0.52];
  const s = (D + WALL_GAP) / D;
  const wy = eyeY + y * s;
  if (wy > 0) return [x * s, wy, -(D + WALL_GAP) + 0.05];
  const s2 = y < 0 ? eyeY / -y : s;
  return [x * s2, 0.03, -D * s2];
}

function ensureAudio() {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === "suspended") audioCtx.resume();
  } catch (e) { /* no audio */ }
}

function animTime(A) { return A ? ((performance.now() - A.start) / 1000) * A.speed : 0; }
function isFiring() {
  const S = state.session, A = state.anim;
  if (S && S.holding) return true;
  if (A && A.sess) return animTime(A) < A.flightEnd; // paused hold-fire: only while bullets fly
  return !!A;
}

function buildAnim(res, s, start, speed, sess) {
  // turn a /api/simulate answer (one run, with track) into a replay timeline
  const D = res.distance;
  const bspeed = state.stats ? state.stats.bulletspeed : 2000;
  const eyeY = TARGET_BASE + aimOffset();
  const t0 = sess ? 0 : (res.fire_times[0] || 0);
  const times = res.fire_times.map((x) => x - t0);
  const dmgs = res.summary.damage;
  const bullets = [], shotArrivals = [];
  let cum = 0, killAt = null;
  const anim = { start, speed, times, bullets, res, firemode: res.firemode, nextSound: 0, lastCount: -1, shotArrivals, sess: sess ? sess.id : null };
  if (sess) state.holes = state.holes.filter((h) => h.sess !== sess.id);
  res.impacts[0].forEach((shot, i) => {
    let shotDmg = 0;
    shot.forEach((p, k) => {
      const part = res.parts[0][i][k];
      const dmg = part < 0 ? 0 : PART_GROUP[part] === "head" ? dmgs.head : PART_GROUP[part] === "torso" ? dmgs.torso : dmgs.limb;
      shotDmg += dmg;
      const to = impactWorld(p[0], p[1], part, D, eyeY);
      const dist = Math.hypot(to[0], to[1] - eyeY, to[2]);
      const tt = Math.min(2, dist / bspeed);
      bullets.push({ t0: times[i], tt, to, dist, part, dmg, from: null });
      // shots from before the last "Clear holes" stay cleared when the session's
      // timeline is rebuilt on the next trigger press
      if (!(sess && i < (sess.clearFrom || 0))) state.holes.push({ w: to, part, time: times[i] + tt, shot: times[i], anim, sess: sess ? sess.id : null });
      if (k === 0) shotArrivals.push(times[i] + tt);
    });
    cum += shotDmg;
    if (killAt === null && cum >= s.health) killAt = times[i] + Math.min(2, D / bspeed);
  });
  if (state.holes.length > 3000) state.holes = state.holes.slice(-3000);
  anim.track = (res.track || []).map((r) => { const c = r.slice(); c[0] -= t0; return c; });
  const lastShot = times[times.length - 1] || 0;
  anim.end = lastShot + Math.min(2, D / bspeed) + 0.7;
  anim.flightEnd = lastShot + Math.min(2, D / bspeed) + 0.15;
  if (sess && anim.track.length) anim.end = Math.max(anim.end, anim.track[anim.track.length - 1][0]);
  anim.killAt = killAt;
  anim.clearFrom = sess && sess.clearFrom ? Math.min(sess.clearFrom, times.length) : 0;
  state.dotsCleared = false;
  // when replacing a running timeline, don't replay sounds / shots already shown
  const now = animTime(anim);
  while (anim.nextSound < times.length && times[anim.nextSound] < now - 0.03) anim.nextSound++;
  return anim;
}

function stopFiring() {
  const A = state.anim;
  if (A) {
    const t = animTime(A);
    state.holes = state.holes.filter((h) => h.anim !== A || h.time <= t);
    // keep the last mag view in sync with what was actually shown
    const shown = A.shotArrivals.filter((x) => x <= t).length;
    if (shown && A.res) {
      state.lastWatch = { ...A.res, impacts: [A.res.impacts[0].slice(0, shown)], parts: [A.res.parts[0].slice(0, shown)] };
    }
  }
  state.anim = null;
  if (state.session) state.session.reqId++;
  state.session = null;
  drawPattern();
}

async function fireMag() {
  if (isFiring()) { stopFiring(); return; }
  state.session = null;
  ensureAudio();
  const s = settings();
  const token = (state.fireToken = (state.fireToken || 0) + 1);
  try {
    const res = await api("/api/simulate", { weapon: state.weapon, attachments: state.attachments, settings: s, runs: 1, track: true, return_runs: 1 });
    if (token !== state.fireToken || state.session) return;
    state.lastWatch = res;
    state.anim = buildAnim(res, s, performance.now(), +$("speed").value, null);
  } catch (e) {
    $("hud").textContent = `Error: ${e.message}`;
  }
}

/* hold the left mouse button to shoot; letting go pauses, the springs keep
   recovering, and the next press carries on with the same magazine */
function magShots() {
  const s = settings();
  return s.shots || Math.ceil((state.stats && state.stats.magsize) || 30);
}
function triggerDown() {
  ensureAudio();
  state.fireToken = (state.fireToken || 0) + 1; // cancel a pending "Fire mag"
  let S = state.session;
  if (S && S.empty) S = null;
  // Press and release take effect a few ms in the future (about one server
  // round trip), so the new timeline is back before it starts: no snapping.
  const lead = inputLead();
  if (!S) {
    if (state.anim) stopFiring();
    S = state.session = {
      id: Date.now(), seed: Math.floor(Math.random() * 2 ** 31), start: performance.now() + lead,
      speed: +$("speed").value, holds: [], reqId: 0, holding: false, settings: settings(),
    };
  }
  const t = Math.max(0, ((performance.now() + lead - S.start) / 1000) * S.speed);
  S.holds.push([t, null]);
  S.holding = true;
  requestSession(S, null, t - 0.4);
}
function triggerUp() {
  const S = state.session;
  if (!S || !S.holding) return;
  // Release takes effect immediately (no extra shots). Until the simulator
  // answers, the view holds its pose instead of playing shots that won't happen.
  const h = S.holds[S.holds.length - 1];
  const t = Math.max(h[0], ((performance.now() - S.start) / 1000) * S.speed);
  h[1] = t;
  S.holding = false;
  S.releasedAt = t;
  if (state.anim && state.anim.sess === S.id) {
    // the old (still-held) timeline must not show shots from the release frame on
    const fps = S.settings.fps || 60;
    const relFrame = Math.ceil(t * fps - 1e-9) / fps;
    state.anim.cutoff = relFrame - 1e-6;
    state.anim.freezeAt = t;
  }
  requestSession(S, t + 3, h[0] - 0.4);
}
function inputLead() {
  // milliseconds: ~1.5 measured round trips plus a frame, within sane limits
  return Math.min(120, Math.max(40, (state.rtt || 40) * 1.4 + 15));
}
function requestSession(S, trackEnd, trackStart) {
  // At most one replay request in flight: while one is running, only the
  // newest trigger state is remembered and sent when it returns. Spamming the
  // trigger then costs one request per round trip instead of two per click.
  S.pending = { trackEnd, trackStart };
  if (S.inFlight) return;
  const next = S.pending;
  S.pending = null;
  S.inFlight = true;
  sendSession(S, next.trackEnd, next.trackStart).finally(() => {
    S.inFlight = false;
    if (S.pending && state.session === S) requestSession(S, S.pending.trackEnd, S.pending.trackStart);
  });
}
async function sendSession(S, trackEnd, trackStart) {
  const id = ++S.reqId;
  // only the part of the timeline around "now" is needed for the replay
  const s = { ...S.settings, seed: S.seed, trigger_holds: S.holds.map((h) => h.slice()), track_end: trackEnd, track_start: Math.max(0, trackStart || 0) };
  try {
    const t0 = performance.now();
    const res = await api("/api/simulate", { weapon: state.weapon, attachments: state.attachments, settings: s, runs: 1, track: true, return_runs: 1 });
    state.rtt = 0.7 * (state.rtt || 60) + 0.3 * (performance.now() - t0);
    if (state.session !== S || id !== S.reqId) return;
    S.fired = res.fire_times.length;
    const cf = Math.min(S.clearFrom || 0, res.impacts[0].length);
    state.lastWatch = cf ? { ...res, impacts: [res.impacts[0].slice(cf)], parts: [res.parts[0].slice(cf)] } : res;
    const prev = state.anim && state.anim.sess === S.id ? state.anim : null;
    const A = buildAnim(res, s, S.start, S.speed, S);
    // If the trigger was let go while this request was on its way, the answer
    // still has it held: hide its shots from the release frame on, and hold the
    // pose there until the next answer (sent right after this one) arrives.
    const snapLast = s.trigger_holds.length - 1;
    const now = S.holds[snapLast];
    if (s.trigger_holds[snapLast][1] == null && now && now[1] != null) {
      const fps = S.settings.fps || 60;
      A.cutoff = Math.ceil(now[1] * fps - 1e-9) / fps - 1e-6;
      A.freezeAt = now[1];
    }
    if (prev) {
      // never replay a shot sound the previous timeline already played
      const lt = prev.lastSoundT ?? -1;
      A.nextSound = 0;
      while (A.nextSound < A.times.length && A.times[A.nextSound] <= lt + 1e-6) A.nextSound++;
      A.lastSoundT = prev.lastSoundT;
      // if the answer arrived a little late, glide from the shown pose instead of snapping
      const t = animTime(A);
      const from = trackStateOf(prev, t), to = trackStateOf(A, t);
      A.blend = { start: performance.now(), dur: 110, offset: poseDiff(from, to) };
    }
    const closed = s.trigger_holds[s.trigger_holds.length - 1][1] != null;
    S.empty = closed && res.fire_times.length >= magShots();
    state.anim = A;
  } catch (e) {
    $("hud").textContent = `Error: ${e.message}`;
  }
}

/* ------------------------------------------------------------------ stats */
async function refreshStats() {
  const s = settings();
  try {
    state.stats = await api("/api/stats", { weapon: state.weapon, attachments: state.attachments, distance: s.distance, health: s.health });
  } catch (e) { return; }
  const st = state.stats;
  syncFiremodes(st.firemodes);
  // rate of the selected fire mode (guns with variable fire rates list one per mode)
  const fmi = Math.min(+$("firemode").value || 0, Array.isArray(st.firerate) ? st.firerate.length - 1 : 0);
  const frv = Array.isArray(st.firerate) ? (st.variablefirerate ? st.firerate[fmi] : st.firerate[0]) : st.firerate;
  const fr = Math.round(frv);
  const capTxt = st.firecap ? `${Math.round(st.firecap)} <small>rpm${st.forcecap ? "!" : ""}</small>` : "none";
  const stk = st.shots_to_kill;
  const items = [
    ["Fire rate", `${fr} <small>rpm</small>`],
    ["Magazine", `${st.magsize} <small>+${st.sparerounds ?? "?"}</small>`],
    ["Fire cap", capTxt],
    ["Aimed rate", st.aimedfirerate ? `${Math.round(st.aimedfirerate)} <small>rpm</small>` : "same"],
    ["Damage here", `${fmt(st.damage_here.base, 1)}${st.pelletcount > 1 ? ` <small>×${st.pelletcount}</small>` : ""}`],
    ["Bullet speed", `${Math.round(st.bulletspeed)} <small>st/s</small>`],
    ["Penetration", st.penetrationdepth != null ? `${fmt(st.penetrationdepth, 2)} <small>studs</small>` : "–"],
    ["Pellets", st.pelletcount > 1 ? `${st.pelletcount} <small>per shot</small>` : "1"],
    ["Head", `${fmt(st.damage_here.head, 1)} <small>×${fmt(st.multhead, 2)}</small>`, "head"],
    ["Torso", `${fmt(st.damage_here.torso, 1)} <small>×${fmt(st.multtorso, 2)}</small>`, "torso"],
    ["Limbs", `${fmt(st.damage_here.limb, 1)} <small>×${fmt(st.multlimb, 2)}</small>`, "limb"],
    ["STK H/T/L", stk.head ? `${stk.head} / ${stk.torso} / ${stk.limb}` : "–"],
  ];
  $("statsCard").innerHTML = items.map(([k, v, c]) => `<div class="r ${c || ""}"><span class="k">${k}</span><span class="v">${v}</span></div>`).join("");
  drawDamageGraph();
}

function niceStep(span, target) {
  const raw = span / Math.max(target, 1), mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const f = raw / mag;
  return (f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10) * mag;
}
function dmgAt(g, d) {
  for (let i = 0; i < g.length; i++) {
    if (d < g[i].distance) {
      if (i === 0) return g[0].damage;
      const a = g[i - 1], b = g[i], f = (d - a.distance) / (b.distance - a.distance);
      return a.damage + (b.damage - a.damage) * f;
    }
  }
  return g[g.length - 1].damage;
}
function graphFull(st) {
  const g = st.damageGraph || [];
  return Math.max((g.length ? g[g.length - 1].distance : 100) * 1.3, settings().distance * 1.15, 60);
}

function drawDamageGraph() {
  const st = state.stats, cv = $("dmgGraph");
  if (!st || !cv.offsetParent) return;
  const { ctx, w, h } = setupCanvas(cv);
  ctx.clearRect(0, 0, w, h);
  const g = st.damageGraph || [];
  if (!g.length) return;
  const D = settings().distance;
  const full = graphFull(st);
  const view = state.dmgView || { x0: 0, x1: full };
  const x0 = Math.max(0, view.x0), x1 = Math.max(x0 + 1, view.x1);
  const parts = [["head", st.multhead || 1, "#ff4d6d"], ["torso", st.multtorso || 1, "#ffb020"], ["limb", st.multlimb || 1, "#3ec7ff"]];
  const pellets = st.pelletcount || 1;
  // y range: whole graph when zoomed out, otherwise fit the visible part
  let lo = Infinity, hi = -Infinity;
  for (let k = 0; k <= 60; k++) {
    const d = x0 + ((x1 - x0) * k) / 60, base = dmgAt(g, d);
    for (const [, m] of parts) { lo = Math.min(lo, base * m); hi = Math.max(hi, base * m); }
  }
  const zoomed = x1 - x0 < full * 0.98;
  let y0 = zoomed ? Math.max(0, lo - (hi - lo) * 0.15 - 1) : 0, y1 = hi + Math.max((hi - lo) * 0.12, hi * 0.06, 1);
  const bandH = 14;
  const pad = { l: 36, r: 8, t: 10 };
  const axisY = h - 30 - bandH * 3;          // bottom of the damage plot
  const bandsTop = axisY + 6;
  const X = (d) => pad.l + ((d - x0) / (x1 - x0)) * (w - pad.l - pad.r);
  const Y = (v) => axisY - ((v - y0) / (y1 - y0)) * (axisY - pad.t);
  state.dmgGeom = { X, x0, x1, pad, w, h, axisY, bandsTop, bandH };
  ctx.font = "10px Consolas, monospace"; ctx.lineWidth = 1;
  // grid + axes
  const ys = niceStep(y1 - y0, 5), xs = niceStep(x1 - x0, Math.max(3, Math.floor((w - pad.l) / 60)));
  ctx.textAlign = "right";
  for (let v = Math.ceil(y0 / ys) * ys; v <= y1 + 1e-9; v += ys) {
    const y = Y(v);
    ctx.strokeStyle = "rgba(120,140,165,0.16)"; ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(w - pad.r, y); ctx.stroke();
    ctx.fillStyle = "#9aa7b6"; ctx.fillText(String(+v.toFixed(2)), pad.l - 4, y + 3);
  }
  ctx.textAlign = "center";
  for (let d = Math.ceil(x0 / xs) * xs; d <= x1 + 1e-9; d += xs) {
    const x = X(d);
    ctx.strokeStyle = "rgba(120,140,165,0.12)"; ctx.beginPath(); ctx.moveTo(x, pad.t); ctx.lineTo(x, bandsTop + bandH * 3); ctx.stroke();
    ctx.fillStyle = "#9aa7b6"; ctx.fillText(String(+d.toFixed(1)), x, h - 16);
  }
  ctx.strokeStyle = "#5b6878"; ctx.lineWidth = 1.2;
  ctx.beginPath(); ctx.moveTo(pad.l, pad.t); ctx.lineTo(pad.l, axisY); ctx.lineTo(w - pad.r, axisY); ctx.stroke();
  ctx.fillStyle = "#8b98a8"; ctx.fillText("range (studs)", (pad.l + w - pad.r) / 2, h - 3);
  ctx.save(); ctx.translate(9, (pad.t + axisY) / 2); ctx.rotate(-Math.PI / 2); ctx.fillText(`damage${pellets > 1 ? " / pellet" : ""}`, 0, 0); ctx.restore();
  // clip the plot area
  ctx.save(); ctx.beginPath(); ctx.rect(pad.l, pad.t - 2, w - pad.l - pad.r, bandsTop + bandH * 3 - pad.t + 2); ctx.clip();
  // draw limb, torso, head; a curve that sits exactly on an earlier one is dashed so both show
  const drawn = [];
  for (const [, m, c] of [parts[2], parts[1], parts[0]]) {
    ctx.strokeStyle = c; ctx.lineWidth = 1.7;
    ctx.setLineDash(drawn.some((q) => Math.abs(q - m) < 1e-6) ? [6, 6] : []);
    ctx.beginPath();
    const pts = [{ distance: Math.min(x0, g[0].distance), damage: g[0].damage }, ...g, { distance: Math.max(x1, g[g.length - 1].distance) + 1, damage: g[g.length - 1].damage }];
    pts.forEach((p, i) => (i ? ctx.lineTo(X(p.distance), Y(p.damage * m)) : ctx.moveTo(X(p.distance), Y(p.damage * m))));
    ctx.stroke(); ctx.setLineDash([]);
    drawn.push(m);
  }
  // current range
  ctx.strokeStyle = "rgba(245,165,36,0.9)"; ctx.lineWidth = 1.5; ctx.setLineDash([5, 3]);
  ctx.beginPath(); ctx.moveTo(X(D), pad.t); ctx.lineTo(X(D), bandsTop + bandH * 3); ctx.stroke(); ctx.setLineDash([]);
  // shots-to-kill bands (below the plot) and breakpoint dots on the curves
  const bands = st.stk_bands || {};
  const labels = [];
  parts.forEach(([name, m, c], i) => {
    const y = bandsTop + i * bandH;
    for (const b of bands[name] || []) {
      const bx0 = X(Math.max(b.from, x0)), bx1 = X(b.to == null ? x1 : Math.min(b.to, x1));
      if (bx1 > bx0) {
        ctx.fillStyle = c; ctx.globalAlpha = 0.16 + 0.14 * ((b.stk || 0) % 2); ctx.fillRect(bx0, y, bx1 - bx0 - 1, bandH - 2); ctx.globalAlpha = 1;
        ctx.fillStyle = "#e6edf3"; ctx.textAlign = "center";
        if (bx1 - bx0 > 16) ctx.fillText(`${b.stk ?? "–"}`, (bx0 + bx1) / 2, y + 10);
      }
      if (b.from > 0 && b.from >= x0 && b.from <= x1) {
        const px = X(b.from), py = Y(dmgAt(g, b.from) * m);
        const same = labels.find((q) => Math.abs(q.px - px) < 2 && Math.abs(q.py - py) < 2);
        if (same) same.c2 = c; else labels.push({ px, py, c, text: `${+b.from.toFixed(1)}` });
      }
    }
  });
  for (const L of labels) {
    ctx.fillStyle = "#0b0f15"; ctx.beginPath(); ctx.arc(L.px, L.py, 4.6, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = L.c; ctx.beginPath(); ctx.arc(L.px, L.py, 3.4, 0, Math.PI * 2); ctx.fill();
    if (L.c2) { ctx.fillStyle = L.c2; ctx.beginPath(); ctx.arc(L.px, L.py, 3.4, -Math.PI / 2, Math.PI / 2); ctx.fill(); }
  }
  // breakpoint range numbers next to their dots, nudged so they don't overlap
  ctx.textAlign = "left"; ctx.font = "bold 10px Consolas, monospace";
  const placed = [];
  for (const L of labels.sort((a, b) => a.px - b.px)) {
    let ty = L.py - 7;
    while (placed.some((q) => Math.abs(q.x - (L.px + 5)) < 26 && Math.abs(q.y - ty) < 10)) ty -= 10;
    if (ty < pad.t + 8) ty = L.py + 14;
    placed.push({ x: L.px + 5, y: ty });
    ctx.fillStyle = "rgba(11,15,21,0.75)"; ctx.fillRect(L.px + 4, ty - 9, ctx.measureText(L.text).width + 3, 11);
    ctx.fillStyle = L.c; ctx.fillText(L.text, L.px + 5, ty);
  }
  ctx.restore();
  ctx.font = "10px Consolas, monospace"; ctx.textAlign = "left";
  parts.forEach(([name, , c], i) => { ctx.fillStyle = c; ctx.fillText(name[0].toUpperCase(), pad.l - 12, bandsTop + i * bandH + 10); });
  // hover read-out
  const hv = state.dmgHover;
  if (hv != null && hv >= x0 && hv <= x1) {
    const x = X(hv), base = dmgAt(g, hv);
    ctx.strokeStyle = "rgba(230,237,243,0.45)"; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(x, pad.t); ctx.lineTo(x, axisY); ctx.stroke();
    const stkAt = (name) => { const b = (bands[name] || []).find((q) => hv >= q.from && (q.to == null || hv < q.to)); return b ? b.stk : "–"; };
    const rows = [[`${hv.toFixed(1)} studs`, "#e6edf3"], ...parts.map(([name, m, c]) => [`${name[0].toUpperCase()} ${(base * m).toFixed(1)} · ${stkAt(name)} stk`, c])];
    ctx.font = "10px Consolas, monospace";
    const bw = Math.max(...rows.map((r) => ctx.measureText(r[0]).width)) + 10, bh = rows.length * 12 + 6;
    const bxp = x + 8 + bw > w - pad.r ? x - 8 - bw : x + 8;
    ctx.fillStyle = "rgba(11,15,21,0.88)"; ctx.fillRect(bxp, pad.t + 2, bw, bh);
    rows.forEach(([t, c], i) => { ctx.fillStyle = c; ctx.fillText(t, bxp + 5, pad.t + 14 + i * 12); });
  }
  // text summary + damage table
  const lines = parts.map(([name, , c]) => {
    const segs = (bands[name] || []).map((b) => `${b.stk} ${b.to == null ? `beyond ${fmt(b.from, 1)}` : `to ${fmt(b.to, 1)}`}`);
    return `<b style="color:${c}">${name[0].toUpperCase() + name.slice(1)}</b>: ${segs.join(" → ")} studs`;
  });
  $("stkText").innerHTML = `Shots to kill ${st.health} HP${pellets > 1 ? " (all pellets hitting)" : ""}:<br>${lines.join("<br>")}`;
}

function wireDamageGraph() {
  const cv = $("dmgGraph");
  const toDist = (e) => {
    const G = state.dmgGeom; if (!G) return null;
    const r = cv.getBoundingClientRect(), x = e.clientX - r.left;
    return G.x0 + ((x - G.pad.l) / (G.w - G.pad.l - G.pad.r)) * (G.x1 - G.x0);
  };
  const clampView = (a, b) => {
    const full = graphFull(state.stats);
    const span = Math.min(Math.max(b - a, 2), full);
    a = Math.max(0, Math.min(a, full - span));
    return { x0: a, x1: a + span };
  };
  cv.addEventListener("wheel", (e) => {
    if (!state.stats || !state.dmgGeom) return;
    e.preventDefault();
    const G = state.dmgGeom, d = toDist(e), f = e.deltaY < 0 ? 0.8 : 1.25;
    state.dmgView = clampView(d - (d - G.x0) * f, d + (G.x1 - d) * f);
    drawDamageGraph();
  }, { passive: false });
  let drag = null;
  cv.addEventListener("mousedown", (e) => { if (state.dmgGeom) drag = { x: e.clientX, v: { x0: state.dmgGeom.x0, x1: state.dmgGeom.x1 } }; });
  window.addEventListener("mouseup", () => { drag = null; });
  cv.addEventListener("mousemove", (e) => {
    const G = state.dmgGeom; if (!G) return;
    if (drag) {
      const per = (drag.v.x1 - drag.v.x0) / (G.w - G.pad.l - G.pad.r);
      const dd = -(e.clientX - drag.x) * per;
      state.dmgView = clampView(drag.v.x0 + dd, drag.v.x1 + dd);
    }
    state.dmgHover = toDist(e);
    drawDamageGraph();
  });
  cv.addEventListener("mouseleave", () => { state.dmgHover = null; drawDamageGraph(); });
  cv.addEventListener("dblclick", () => { state.dmgView = null; drawDamageGraph(); });
  $("dmgReset").addEventListener("click", () => { state.dmgView = null; drawDamageGraph(); });
  $("dmgZoomIn").addEventListener("click", () => { const G = state.dmgGeom; if (!G) return; const c = (G.x0 + G.x1) / 2, s2 = (G.x1 - G.x0) * 0.35; state.dmgView = clampView(c - s2, c + s2); drawDamageGraph(); });
  $("dmgZoomOut").addEventListener("click", () => { const G = state.dmgGeom; if (!G) return; const c = (G.x0 + G.x1) / 2, s2 = (G.x1 - G.x0) * 0.75; state.dmgView = clampView(c - s2, c + s2); drawDamageGraph(); });
}

/* ------------------------------------------------------------------ mag dumps */
let dumpAbort = null;
async function runDumps() {
  const n = Math.max(1, Math.min(100000, +$("dumps").value || 500));
  if (dumpAbort) dumpAbort.abort();
  dumpAbort = new AbortController();
  $("dumpStatus").textContent = `Simulating ${n.toLocaleString()} mag dumps…`;
  $("dumpBtn").disabled = true;
  try {
    const res = await api("/api/simulate", { weapon: state.weapon, attachments: state.attachments, settings: settings(), runs: n, return_runs: 1, heatmap: true, dump: true }, dumpAbort.signal, 180000);
    state.lastDump = res;
    state.lastDump.label = currentLabel();
    state.dotsCleared = false;
    $("dumpStatus").textContent = `${res.runs.toLocaleString()} mag dumps · ${res.summary.bullets.toLocaleString()} bullets · ${res.elapsed}s` +
      (res.capped_from ? ` (capped from ${res.capped_from.toLocaleString()} to keep it under 3 million bullets)` : "");
    renderResults(res.summary);
    drawPattern(); drawPerShot(); renderCompare();
  } catch (e) {
    if (e.name !== "AbortError" && e.message !== "cancelled") $("dumpStatus").innerHTML = `<span class="error">${esc(e.message)}</span>`;
  } finally { $("dumpBtn").disabled = false; }
}

function clearDumps() {
  if (dumpAbort) dumpAbort.abort();
  state.lastDump = null;
  $("results").innerHTML = "";
  $("dumpStatus").textContent = "Mag dump results cleared. Press Simulate (or change something with Auto on) to run again.";
  drawPerShot(); drawPattern(); renderCompare();
}

function reloadMag() {
  // R: fresh magazine for hold-to-fire (and stop whatever is firing)
  stopFiring();
  state.session = null;
  state.reloadNote = performance.now();
}

function currentLabel() {
  const s = settings();
  const atts = SLOTS.filter((k) => state.attachments[k]).map((k) => attLabel(k, state.attachments[k]));
  return `${state.weaponInfo ? state.weaponInfo.displayname : state.weapon}${atts.length ? " · " + atts.join(", ") : ""} · ${s.aiming ? "aim" : "hip"} · ${s.distance}st${s.compensation ? ` · ${s.compensation}% ctrl` : ""}`;
}

function renderResults(s) {
  const items = [
    ["On target", pct(s.hit_rate)], ["Headshots", pct(s.head_rate), "head"], ["Torso", pct(s.torso_rate), "torso"],
    ["Limbs", pct(s.limb_rate), "limb"], ["Kill / mag", pct(s.kill_rate, 0)], ["Avg TTK", s.ttk_mean != null ? `${Math.round(s.ttk_mean * 1000)}<small>ms</small>` : "–"],
    ["Avg off aim", `${fmt(s.aim_error, 2)}<small>st</small>`], ["Shots to kill", fmt(s.stk_mean, 2)], ["Dmg / mag", fmt(s.avg_mag_damage, 0)],
    ["Climb", `${fmt(s.final_climb, 2)}<small>st</small>`], ["Random spread", `${fmt(s.random_radius, 2)}<small>st</small>`], ["Fire rate", s.effective_rpm ? `${Math.round(s.effective_rpm)}<small>rpm</small>` : s.firemode],
  ];
  $("results").innerHTML = items.map(([k, v, c]) => `<div class="stat ${c || ""}"><div class="k">${k}</div><div class="v">${v}</div></div>`).join("");
  $("patternRange").textContent = `@ ${settings().distance} studs`;
}

function drawPerShot() {
  const cv = $("perShot");
  const { ctx, w, h } = setupCanvas(cv);
  ctx.clearRect(0, 0, w, h);
  const s = state.lastDump && state.lastDump.summary;
  if (!s) return;
  const v = s.per_shot_hit, n = v.length;
  ctx.font = "10px Consolas, monospace"; ctx.fillStyle = "#9aa7b6"; ctx.fillText("hit chance per shot", 2, 10);
  const bw = (w - 4) / n;
  ctx.fillStyle = "rgba(120,140,165,0.15)"; ctx.fillRect(2, h - 2, w - 4, 1);
  for (let i = 0; i < n; i++) {
    const bh = (h - 18) * v[i];
    ctx.fillStyle = `hsl(${v[i] * 120}, 70%, 52%)`;
    ctx.fillRect(2 + i * bw + 0.5, h - 2 - bh, Math.max(1, bw - 1), bh);
  }
}

/* ------------------------------------------------------------------ pattern panel */
function patternBounds(w, h) {
  const res = state.lastDump || state.lastWatch;
  const cy = res ? res.target_cy : -aimOffset();
  let x0 = -3.0, x1 = 3.0, y0 = cy - 3.3, y1 = cy + 2.5;
  if (state.patternFit === "all") {
    // fit only what is actually drawn right now (cleared shots / dumps don't count)
    const pts = [];
    const heat = state.patternView !== "dots", dots = state.patternView !== "heat";
    if (heat && state.lastDump && state.lastDump.cloud) pts.push(...state.lastDump.cloud);
    if (dots) {
      if (state.lastWatch) { for (const shot of state.lastWatch.impacts[0]) for (const p of shot) pts.push(p); }
      else if (state.lastDump && !state.dotsCleared) for (const shot of state.lastDump.impacts[0]) for (const p of shot) pts.push(p);
    }
    for (const sn of state.snapshots) if (sn.visible) pts.push(...sn.cloud);
    const xs = pts.map((p) => p[0]).filter(Number.isFinite).sort((a, b) => a - b);
    const ys = pts.map((p) => p[1]).filter(Number.isFinite).sort((a, b) => a - b);
    if (xs.length > 5) {
      const q = (a, f) => a[Math.min(a.length - 1, Math.max(0, Math.floor(f * (a.length - 1))))];
      x0 = Math.min(x0, q(xs, 0.005)); x1 = Math.max(x1, q(xs, 0.995));
      y0 = Math.min(y0, q(ys, 0.005)); y1 = Math.max(y1, q(ys, 0.995));
      const mx = (x1 - x0) * 0.06, my = (y1 - y0) * 0.06;
      x0 -= mx; x1 += mx; y0 -= my; y1 += my;
    }
  }
  const s0 = Math.max((x1 - x0) / w, (y1 - y0) / h);
  const s = s0 / state.patternZoom;
  // zoom towards the aim point when zoomed in
  const z = Math.min(1, Math.max(0, (state.patternZoom - 1) / 2));
  const cxm = ((x0 + x1) / 2) * (1 - z), cym = ((y0 + y1) / 2) * (1 - z);
  return { x0: cxm - (s * w) / 2, x1: cxm + (s * w) / 2, y0: cym - (s * h) / 2, y1: cym + (s * h) / 2, s, cy };
}

function heatColor(t) {
  const stops = [[0, [20, 30, 90, 0]], [0.12, [40, 70, 200, 120]], [0.35, [40, 200, 230, 170]], [0.6, [250, 230, 60, 200]], [0.85, [255, 120, 30, 225]], [1, [255, 40, 40, 240]]];
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i][0]) {
      const [a, ca] = stops[i - 1], [b, cb] = stops[i];
      const f = (t - a) / (b - a);
      return ca.map((v, k) => v + (cb[k] - v) * f);
    }
  }
  return stops[stops.length - 1][1];
}

function densityGrid(cloud, B, nx, ny) {
  const grid = new Float32Array(nx * ny);
  for (const [x, y] of cloud) {
    const i = Math.floor(((x - B.x0) / (B.x1 - B.x0)) * nx), j = Math.floor(((B.y1 - y) / (B.y1 - B.y0)) * ny);
    if (i >= 0 && i < nx && j >= 0 && j < ny) grid[j * nx + i] += 1;
  }
  const k = [0.05, 0.12, 0.2, 0.26, 0.2, 0.12, 0.05], tmp = new Float32Array(nx * ny);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    let s = 0; for (let q = -3; q <= 3; q++) { const ii = i + q; if (ii >= 0 && ii < nx) s += grid[j * nx + ii] * k[q + 3]; } tmp[j * nx + i] = s;
  }
  let mx = 0;
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    let s = 0; for (let q = -3; q <= 3; q++) { const jj = j + q; if (jj >= 0 && jj < ny) s += tmp[jj * nx + i] * k[q + 3]; } grid[j * nx + i] = s; if (s > mx) mx = s;
  }
  return { grid, mx };
}

function drawHeat(ctx, B, w, h, cloud) {
  if (!cloud || !cloud.length) return;
  const nx = 140, ny = Math.max(20, Math.round((nx * h) / w));
  const { grid, mx } = densityGrid(cloud, B, nx, ny);
  if (mx <= 0) return;
  const off = document.createElement("canvas");
  off.width = nx; off.height = ny;
  const octx = off.getContext("2d");
  const img = octx.createImageData(nx, ny);
  for (let p = 0; p < nx * ny; p++) {
    const t = Math.pow(grid[p] / mx, 0.6);
    if (t < 0.02) continue;
    const c = heatColor(t);
    img.data[p * 4] = c[0]; img.data[p * 4 + 1] = c[1]; img.data[p * 4 + 2] = c[2]; img.data[p * 4 + 3] = c[3];
  }
  octx.putImageData(img, 0, 0);
  ctx.save();
  ctx.imageSmoothingEnabled = true;
  ctx.globalCompositeOperation = "screen";
  ctx.drawImage(off, 0, 0, w, h);
  ctx.restore();
}

/* Saved patterns are drawn as outlines: the smallest areas that hold 50 %,
   80 % and 95 % of that pattern's bullets (marching squares on the density). */
const CONTOUR_LEVELS = [[0.5, 2.4, 0.95, []], [0.8, 1.6, 0.8, [6, 3]], [0.95, 1.1, 0.6, [2, 3]]];
function massThresholds(grid, fracs) {
  const v = Array.from(grid).filter((x) => x > 0).sort((a, b) => b - a);
  const total = v.reduce((a, b) => a + b, 0);
  const out = [];
  let acc = 0, k = 0;
  for (const f of fracs) {
    while (k < v.length && acc < f * total) acc += v[k++];
    out.push(v[Math.max(0, k - 1)] || 0);
  }
  return out;
}
function contourPath(ctx, grid, nx, ny, level, w, h) {
  const cx = (i) => ((i + 0.5) / nx) * w, cy = (j) => ((j + 0.5) / ny) * h;
  const g = (i, j) => grid[j * nx + i];
  ctx.beginPath();
  for (let j = 0; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) {
    const a = g(i, j), b = g(i + 1, j), c = g(i + 1, j + 1), d = g(i, j + 1);
    const idx = (a >= level ? 8 : 0) | (b >= level ? 4 : 0) | (c >= level ? 2 : 0) | (d >= level ? 1 : 0);
    if (idx === 0 || idx === 15) continue;
    const lerp = (p, q) => (level - p) / (q - p || 1e-9);
    const top = [cx(i) + lerp(a, b) * (cx(i + 1) - cx(i)), cy(j)];
    const right = [cx(i + 1), cy(j) + lerp(b, c) * (cy(j + 1) - cy(j))];
    const bottom = [cx(i) + lerp(d, c) * (cx(i + 1) - cx(i)), cy(j + 1)];
    const left = [cx(i), cy(j) + lerp(a, d) * (cy(j + 1) - cy(j))];
    const segs = {
      1: [[left, bottom]], 2: [[bottom, right]], 3: [[left, right]], 4: [[top, right]], 5: [[left, top], [bottom, right]],
      6: [[top, bottom]], 7: [[left, top]], 8: [[left, top]], 9: [[top, bottom]], 10: [[left, bottom], [top, right]],
      11: [[top, right]], 12: [[left, right]], 13: [[bottom, right]], 14: [[left, bottom]],
    }[idx];
    for (const [p, q] of segs) { ctx.moveTo(p[0], p[1]); ctx.lineTo(q[0], q[1]); }
  }
}
function drawContours(ctx, B, w, h, cloud, color) {
  if (!cloud || !cloud.length) return;
  const nx = 120, ny = Math.max(20, Math.round((nx * h) / w));
  const { grid, mx } = densityGrid(cloud, B, nx, ny);
  if (mx <= 0) return;
  const th = massThresholds(grid, CONTOUR_LEVELS.map((l) => l[0]));
  ctx.save();
  ctx.strokeStyle = color; ctx.lineCap = "round";
  // soft fill of the core (50 %) area so overlapping patterns stay readable
  const off = document.createElement("canvas");
  off.width = nx; off.height = ny;
  const octx = off.getContext("2d"), img = octx.createImageData(nx, ny);
  const rgb = [1, 3, 5].map((k) => parseInt(color.slice(k, k + 2), 16));
  for (let p = 0; p < nx * ny; p++) if (grid[p] >= th[0]) { img.data[p * 4] = rgb[0]; img.data[p * 4 + 1] = rgb[1]; img.data[p * 4 + 2] = rgb[2]; img.data[p * 4 + 3] = 46; }
  octx.putImageData(img, 0, 0);
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(off, 0, 0, w, h);
  CONTOUR_LEVELS.forEach(([, lw, alpha, dash], k) => {
    if (!(th[k] > 0)) return;
    ctx.globalAlpha = alpha; ctx.lineWidth = lw; ctx.setLineDash(dash);
    contourPath(ctx, grid, nx, ny, th[k], w, h);
    ctx.stroke();
  });
  ctx.restore();
}

function drawPattern(liveHits) {
  const cv = $("patternCanvas");
  if (!cv.offsetParent) return;
  const { ctx, w, h } = setupCanvas(cv);
  const B = patternBounds(w, h);
  const X = (x) => ((x - B.x0) / (B.x1 - B.x0)) * w;
  const Y = (y) => ((B.y1 - y) / (B.y1 - B.y0)) * h;
  const px = 1 / B.s;
  ctx.fillStyle = "#0b0f15"; ctx.fillRect(0, 0, w, h);
  const step = px > 60 ? 0.5 : px > 25 ? 1 : px > 10 ? 2 : px > 4 ? 5 : 10;
  ctx.strokeStyle = "#16202b"; ctx.lineWidth = 1;
  for (let x = Math.ceil(B.x0 / step) * step; x <= B.x1; x += step) { ctx.beginPath(); ctx.moveTo(X(x), 0); ctx.lineTo(X(x), h); ctx.stroke(); }
  for (let y = Math.ceil(B.y0 / step) * step; y <= B.y1; y += step) { ctx.beginPath(); ctx.moveTo(0, Y(y)); ctx.lineTo(w, Y(y)); ctx.stroke(); }
  const cy = B.cy;
  for (const [name, hx, hy, hw, hh] of state.hitboxes) {
    const col = name === "Head" ? "255,77,109" : name === "Torso" ? "255,176,32" : "62,199,255";
    ctx.fillStyle = `rgba(${col},0.13)`; ctx.strokeStyle = `rgba(${col},0.75)`; ctx.lineWidth = 1.2;
    const rx = X(hx - hw), ry = Y(hy + cy + hh), rw = 2 * hw * px, rh = 2 * hh * px;
    ctx.fillRect(rx, ry, rw, rh); ctx.strokeRect(rx, ry, rw, rh);
    const r = 0.1 * px;
    ctx.strokeStyle = `rgba(${col},0.25)`; ctx.setLineDash([2, 3]);
    roundRect(ctx, rx - r, ry - r, rw + 2 * r, rh + 2 * r, r); ctx.stroke(); ctx.setLineDash([]);
  }
  const dump = state.lastDump;
  if (state.patternView !== "dots" && dump) drawHeat(ctx, B, w, h, dump.cloud);
  // saved patterns for comparison
  for (const sn of state.snapshots) {
    if (!sn.visible) continue;
    drawContours(ctx, B, w, h, sn.cloud, sn.color);
    ctx.strokeStyle = sn.color; ctx.lineWidth = 1.6; ctx.setLineDash([5, 3]); ctx.beginPath();
    sn.mean_path.forEach(([x, y], i) => (i ? ctx.lineTo(X(x), Y(y)) : ctx.moveTo(X(x), Y(y))));
    ctx.stroke(); ctx.setLineDash([]);
  }
  if (dump && dump.summary && dump.summary.mean_path && state.patternView !== "dots") {
    ctx.strokeStyle = "rgba(245,165,36,0.95)"; ctx.lineWidth = 1.6; ctx.setLineDash([4, 3]); ctx.beginPath();
    dump.summary.mean_path.forEach(([x, y], i) => (i ? ctx.lineTo(X(x), Y(y)) : ctx.moveTo(X(x), Y(y))));
    ctx.stroke(); ctx.setLineDash([]);
  }
  let src = null, parts = null, count = Infinity;
  if (liveHits) { src = liveHits.impacts; parts = liveHits.parts; count = liveHits.count; }
  else if (state.lastWatch && state.patternView !== "heat") { src = state.lastWatch.impacts[0]; parts = state.lastWatch.parts[0]; }
  else if (dump && state.patternView !== "heat" && !state.dotsCleared) { src = dump.impacts[0]; parts = dump.parts[0]; }
  const from = liveHits ? liveHits.from || 0 : 0;
  if (src) {
    const n = Math.min(src.length, count);
    ctx.strokeStyle = "rgba(220,230,240,0.18)"; ctx.lineWidth = 1; ctx.beginPath();
    let started = false;
    for (let i = from; i < n; i++) {
      const p = src[i][0];
      if (!p || !Number.isFinite(p[0])) continue;
      if (!started) { ctx.moveTo(X(p[0]), Y(p[1])); started = true; } else ctx.lineTo(X(p[0]), Y(p[1]));
    }
    ctx.stroke();
    const showNum = n <= 60 && px > 12;
    ctx.font = "9px Consolas, monospace";
    for (let i = from; i < n; i++) for (let k = 0; k < src[i].length; k++) {
      const p = src[i][k];
      if (!p || !Number.isFinite(p[0])) continue;
      const part = parts[i][k];
      ctx.fillStyle = part >= 0 ? PART_COLORS[part] : MISS_COLOR; ctx.strokeStyle = "#000";
      ctx.beginPath(); ctx.arc(X(p[0]), Y(p[1]), src[i].length > 1 ? 2.6 : 3.6, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      if (showNum && k === 0) { ctx.fillStyle = "#cfd8e3"; ctx.fillText(String(i + 1), X(p[0]) + 5, Y(p[1]) - 4); }
    }
  }
  ctx.strokeStyle = "#e6edf3"; ctx.lineWidth = 1.2;
  const ax = X(0), ay = Y(0);
  ctx.beginPath(); ctx.moveTo(ax - 9, ay); ctx.lineTo(ax - 3, ay); ctx.moveTo(ax + 3, ay); ctx.lineTo(ax + 9, ay);
  ctx.moveTo(ax, ay - 9); ctx.lineTo(ax, ay - 3); ctx.moveTo(ax, ay + 3); ctx.lineTo(ax, ay + 9); ctx.stroke();
  const D = settings().distance;
  const studs = step * (step < 2 ? 2 : 1), bar = studs * px;
  ctx.fillStyle = "#cfd8e3"; ctx.strokeStyle = "#cfd8e3";
  ctx.beginPath(); ctx.moveTo(10, h - 12); ctx.lineTo(10 + bar, h - 12); ctx.moveTo(10, h - 16); ctx.lineTo(10, h - 8); ctx.moveTo(10 + bar, h - 16); ctx.lineTo(10 + bar, h - 8); ctx.stroke();
  ctx.font = "11px Consolas, monospace";
  ctx.fillText(`${studs} stud${studs === 1 ? "" : "s"} = ${((Math.atan2(studs, D) * 180) / Math.PI).toFixed(2)}°`, 16 + bar, h - 8);
  const legend = [["Head", PART_COLORS[0]], ["Torso", PART_COLORS[1]], ["Limb", PART_COLORS[2]], ["Miss", MISS_COLOR]];
  let lx = w - 8;
  ctx.textAlign = "right";
  for (let i = legend.length - 1; i >= 0; i--) {
    const [t, c] = legend[i];
    ctx.fillStyle = "#cfd8e3"; ctx.fillText(t, lx, 16);
    const tw = ctx.measureText(t).width;
    ctx.fillStyle = c; ctx.beginPath(); ctx.arc(lx - tw - 7, 12, 3.5, 0, Math.PI * 2); ctx.fill();
    lx -= tw + 22;
  }
  ctx.textAlign = "left";
  if (state.snapshots.some((x) => x.visible)) {
    ctx.fillStyle = "#8b98a8"; ctx.font = "10px Consolas, monospace";
    ctx.fillText("saved: solid 50% · dashed 80% · dotted 95% of bullets", 8, 30);
  }
  if (!dump && !src) {
    ctx.fillStyle = "#8b98a8"; ctx.font = "13px Segoe UI, sans-serif"; ctx.textAlign = "center";
    ctx.fillText("Run mag dumps or fire a mag to see the pattern", w / 2, h / 2); ctx.textAlign = "left";
  }
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y); ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r); ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h); ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r); ctx.quadraticCurveTo(x, y, x + r, y); ctx.closePath();
}

function setZoom(z) {
  state.patternZoom = Math.min(16, Math.max(0.25, z));
  $("zoom").value = Math.log2(state.patternZoom);
  $("zoomVal").textContent = `${state.patternZoom.toFixed(state.patternZoom < 10 ? 1 : 0)}×`;
  drawPattern();
  if (!state.restoring) saveSoon();
}
const saveSoon = debounce(() => saveSettings(), 400);

/* ------------------------------------------------------------------ snapshots */
function saveSnapshot() {
  const d = state.lastDump;
  if (!d) { $("dumpStatus").textContent = "Run some mag dumps first, then save the pattern."; return; }
  let cloud = d.cloud || [];
  if (cloud.length > 4000) { const stepN = cloud.length / 4000; cloud = Array.from({ length: 4000 }, (_, i) => cloud[Math.floor(i * stepN)]); }
  const used = new Set(state.snapshots.map((s) => s.color));
  const color = SNAP_COLORS.find((c) => !used.has(c)) || SNAP_COLORS[state.snapshots.length % SNAP_COLORS.length];
  const s = d.summary;
  state.snapshots.push({
    id: Date.now(), name: d.label || currentLabel(), color, visible: true,
    cloud: cloud.map(([x, y]) => [Math.round(x * 1000) / 1000, Math.round(y * 1000) / 1000]),
    mean_path: s.mean_path,
    summary: { aim_error: s.aim_error, hit_rate: s.hit_rate, head_rate: s.head_rate, torso_rate: s.torso_rate, limb_rate: s.limb_rate, kill_rate: s.kill_rate, ttk_mean: s.ttk_mean, ttk_median: s.ttk_median, stk_mean: s.stk_mean, avg_mag_damage: s.avg_mag_damage, final_climb: s.final_climb, random_radius: s.random_radius },
  });
  if (state.snapshots.length > 6) state.snapshots.shift();
  store(); renderSnapList(); drawPattern(); renderCompare();
}

function renderSnapList() {
  const el = $("snapList");
  el.innerHTML = state.snapshots.map((s) => `<span class="snap ${s.visible ? "" : "off"}" data-id="${s.id}"><span class="sw" style="background:${s.color}"></span><span class="nm" title="${esc(s.name)} (click to show/hide)"><b>#${state.snapshots.indexOf(s) + 1}</b> ${esc(s.name)}</span><button data-del="${s.id}" title="Delete">✕</button></span>`).join("");
  el.querySelectorAll(".nm").forEach((n) => n.addEventListener("click", () => {
    const s = state.snapshots.find((x) => x.id === +n.parentElement.dataset.id);
    s.visible = !s.visible; store(); renderSnapList(); drawPattern(); renderCompare();
  }));
  el.querySelectorAll("[data-del]").forEach((b) => b.addEventListener("click", () => {
    state.snapshots = state.snapshots.filter((x) => x.id !== +b.dataset.del); store(); renderSnapList(); drawPattern(); renderCompare();
  }));
}

function renderCompare() {
  const shown = state.snapshots.filter((s) => s.visible);
  const cur = state.lastDump && state.lastDump.summary;
  if (!shown.length || !cur) { $("compare").innerHTML = ""; return; }
  const rows = [
    ["Avg off aim", "aim_error", (v) => `${fmt(v, 2)} st`, -1], ["On target", "hit_rate", (v) => pct(v), 1], ["Headshots", "head_rate", (v) => pct(v), 1], ["Kill / mag", "kill_rate", (v) => pct(v, 0), 1],
    ["Avg TTK", "ttk_mean", (v) => (v == null ? "–" : `${Math.round(v * 1000)}ms`), -1], ["Shots to kill", "stk_mean", (v) => fmt(v, 2), -1],
    ["Dmg / mag", "avg_mag_damage", (v) => fmt(v, 0), 1], ["Climb", "final_climb", (v) => fmt(v, 2), 0], ["Random spread", "random_radius", (v) => fmt(v, 2), -1],
  ];
  const head = `<tr><th></th><th style="color:#f5a524">Now</th>${shown.map((s) => `<th style="color:${s.color}" title="${esc(s.name)}">#${state.snapshots.indexOf(s) + 1}</th>`).join("")}</tr>`;
  const body = rows.map(([label, key, f, dir]) => `<tr><td>${label}</td><td>${f(cur[key])}</td>${shown.map((s) => {
    const v = s.summary[key];
    let cls = "";
    if (dir && v != null && cur[key] != null && Math.abs(v - cur[key]) > 1e-9) cls = (v - cur[key]) * dir > 0 ? "better" : "worse";
    return `<td class="${cls}">${f(v)}</td>`;
  }).join("")}</tr>`).join("");
  $("compare").innerHTML = `<table class="cmp">${head}${body}</table><div class="muted small">Green / red: the saved pattern is better / worse than now.</div>`;
}

/* ------------------------------------------------------------------ optimiser */
/* -------- best setup: slot cards, exclusion editor, search */
let optGroups = null;      // {slot: [{rep, members, no_effect}]} from the server
const optLocks = new Set(); // slots ticked "Keep current" (survives re-rendering the cards)
let exOpenSlot = null;
let optLocksWeapon = null;
async function buildOptSlots() {
  if (optLocksWeapon !== state.weapon) { optLocks.clear(); optLocksWeapon = state.weapon; }
  const el = $("optSlots");
  el.innerHTML = `<p class="muted small">Loading attachments…</p>`;
  $("exEditor").classList.add("hidden");
  exOpenSlot = null;
  try {
    optGroups = await api("/api/attachment_groups", { weapon: state.weapon });
  } catch (e) { el.innerHTML = `<p class="error">${esc(e.message)}</p>`; return; }
  renderOptSlots();
}
function exSet(slot) {
  const e = state.excludes[state.weapon] || {};
  return new Set(e[slot] || []);
}
function renderOptSlots() {
  const el = $("optSlots");
  el.innerHTML = SLOTS.map((slot) => {
    const groups = (optGroups && optGroups[slot]) || [];
    const cur = state.attachments[slot];
    const effect = groups.filter((g) => !g.no_effect);
    const noEff = groups.filter((g) => g.no_effect).reduce((n, g) => n + g.members.length, 0);
    const ex = exSet(slot);
    const exN = groups.filter((g) => (g.rep === null ? ex.has("") : g.members.every((m) => ex.has(m)))).length;
    return `<div class="optslot ${exOpenSlot === slot ? "open" : ""}"><div class="ttl">${slot}</div>
      <label class="lock chk"><input type="checkbox" data-lock="${slot}" ${optLocks.has(slot) ? "checked" : ""}> Keep current${cur ? `: ${esc(attLabel(slot, cur))}` : " (empty)"}</label>
      <div class="cnt"><b>${effect.length}</b> option${effect.length === 1 ? "" : "s"} change the shooting${noEff ? ` · ${noEff} don't (skipped)` : ""}</div>
      <button class="exbtn ${exN ? "has" : ""}" data-exopen="${slot}">${exN ? `${exN} excluded · edit` : "Exclude…"}</button></div>`;
  }).join("");
  el.querySelectorAll("[data-lock]").forEach((cb) => cb.addEventListener("change", () => {
    if (cb.checked) optLocks.add(cb.dataset.lock); else optLocks.delete(cb.dataset.lock);
  }));
  el.querySelectorAll("[data-exopen]").forEach((b) => b.addEventListener("click", () => {
    exOpenSlot = exOpenSlot === b.dataset.exopen ? null : b.dataset.exopen;
    renderOptSlots(); renderExEditor();
  }));
}
function renderExEditor(filter = "") {
  const box = $("exEditor");
  if (!exOpenSlot || !optGroups) { box.classList.add("hidden"); return; }
  box.classList.remove("hidden");
  const slot = exOpenSlot;
  const groups = optGroups[slot] || [];
  const ex = exSet(slot);
  const f = filter.trim().toLowerCase();
  const label = (g) => (g.rep === null ? "Empty slot / no effect" : attLabel(slot, g.rep));
  const isEx = (g) => (g.rep === null ? ex.has("") : g.members.every((m) => ex.has(m)));
  const shown = groups.filter((g) => !f || label(g).toLowerCase().includes(f) || g.members.some((m) => attLabel(slot, m).toLowerCase().includes(f)));
  const noEff = groups.find((g) => g.no_effect);
  box.innerHTML = `<div class="exhead"><h4>Exclude from the ${slot} search <span class="muted small">— click to toggle</span></h4>
      <input class="search" id="exSearch" placeholder="Filter…" value="${esc(filter)}">
      <button class="tiny" id="exNone">Include all</button><button class="tiny" id="exAll">Exclude all</button><button class="tiny" id="exClose">Done</button></div>
    <div class="chips">${shown.map((g, i) => {
      const same = g.rep === null ? [] : g.members.filter((m) => m !== g.rep);
      const tip = g.rep === null ? `Leaves the slot empty. Same result as: ${g.members.map((m) => attLabel(slot, m)).join(", ") || "nothing else"}` : [g.rep, ...same].map((m) => attLabel(slot, m)).join(", ");
      return `<span class="chip ${isEx(g) ? "x" : ""} ${g.rep === null ? "empty" : ""}" data-g="${groups.indexOf(g)}" title="${esc(tip)}">${esc(label(g))}${same.length ? ` <span class="sm">+${same.length} identical</span>` : ""}</span>`;
    }).join("") || `<span class="muted small">Nothing matches.</span>`}</div>
    ${noEff && noEff.members.length ? `<p class="muted small note">${noEff.members.length} attachment${noEff.members.length === 1 ? "" : "s"} in this slot change nothing about shooting (e.g. ${esc(noEff.members.slice(0, 3).map((m) => attLabel(slot, m)).join(", "))}), so they count as an empty slot and are never simulated separately.</p>` : ""}`;
  const setEx = (names, on) => {
    const e = state.excludes[state.weapon] = state.excludes[state.weapon] || {};
    const set = new Set(e[slot] || []);
    for (const n of names) on ? set.add(n) : set.delete(n);
    e[slot] = [...set];
    store();
  };
  const namesOf = (g) => (g.rep === null ? ["", ...g.members] : g.members);
  box.querySelectorAll("[data-g]").forEach((c) => c.addEventListener("click", () => {
    const g = groups[+c.dataset.g];
    setEx(namesOf(g), !isEx(g));
    renderOptSlots(); renderExEditor($("exSearch").value);
  }));
  $("exSearch").addEventListener("input", (e) => { const v = e.target.value; renderExEditor(v); const i = $("exSearch"); i.focus(); i.setSelectionRange(v.length, v.length); });
  $("exNone").addEventListener("click", () => { setEx(groups.flatMap(namesOf), false); renderOptSlots(); renderExEditor($("exSearch").value); });
  $("exAll").addEventListener("click", () => { setEx(groups.filter((g) => g.rep !== null).flatMap(namesOf), true); renderOptSlots(); renderExEditor($("exSearch").value); });
  $("exClose").addEventListener("click", () => { exOpenSlot = null; renderOptSlots(); renderExEditor(); });
}

let optTimer = null, optJobId = null;
async function runOptimizer() {
  const locked = {};
  for (const slot of optLocks) locked[slot] = state.attachments[slot] || "";
  $("optBtn").disabled = true;
  $("optStop").classList.remove("hidden");
  const prog = $("optProgress");
  prog.classList.add("show");
  prog.querySelector(".bar").style.width = "0%";
  $("optResults").innerHTML = "";
  clearTimeout(optTimer);
  const done = () => { $("optBtn").disabled = false; $("optStop").classList.add("hidden"); optJobId = null; };
  try {
    const { id } = await api("/api/optimize", {
      weapon: state.weapon, metric: $("metric").value, settings: { ...settings(), compensation: +$("optComp").value, aiming: state.optAiming !== false }, locked, exclude: state.excludes[state.weapon] || {},
    });
    optJobId = id;
    const poll = async () => {
      if (optJobId !== id) return;
      let st;
      try { st = await api(`/api/job?id=${id}`); } catch (e) { optTimer = setTimeout(poll, 1000); return; }
      if (optJobId !== id) return;
      prog.querySelector(".bar").style.width = `${Math.round(st.progress * 100)}%`;
      prog.querySelector(".label").textContent = `${st.stage} · ${Math.round(st.progress * 100)}% · ${st.evaluated.toLocaleString()} setups simulated · ${st.elapsed}s`;
      if (st.done) {
        done();
        if (st.error === "cancelled") { $("optResults").innerHTML = `<p class="muted">Search stopped.</p>`; return; }
        if (st.error) { $("optResults").innerHTML = `<p class="error">${esc(st.error)}</p>`; return; }
        renderOptResults(st.result);
        return;
      }
      optTimer = setTimeout(poll, 400);
    };
    poll();
  } catch (e) {
    $("optResults").innerHTML = `<p class="error">${esc(e.message)}</p>`;
    done();
  }
}
function stopOptimizer() {
  // stop for real: the server cancels the job and stops its worker processes;
  // the page is usable again straight away
  const id = optJobId;
  optJobId = null;
  clearTimeout(optTimer);
  api("/api/optimize/cancel", { id }).catch(() => {});
  $("optBtn").disabled = false;
  $("optStop").classList.add("hidden");
  $("optProgress").classList.remove("show");
  $("optResults").innerHTML = `<p class="muted">Search stopped.</p>`;
}

// full-precision formatting for the setup finder (scores are compared exactly)
function metricScale(metric) {
  if (metric === "ttk") return { k: 1000, unit: " ms", d: 2 };
  if (metric === "accuracy") return { k: 1, unit: " st", d: 4 };
  if (metric === "hits" || metric === "headshots") return { k: 100, unit: " pt", d: 3 };
  return { k: 1, unit: "", d: 2 };
}
function metricText(metric, score, err) {
  if (score == null) return "–";
  const m = metricScale(metric);
  const v = (score * m.k).toFixed(m.d);
  const unit = m.unit === " pt" ? "%" : m.unit.trim();
  return `${v}${err != null ? ` <span class="alt">±${(err * m.k).toFixed(m.d)} ${unit}</span>` : ` <span class="alt">${unit}</span>`}`;
}
function diffText(r, v, err, real) {
  const m = metricScale(r.metric);
  const x = v * m.k;
  if (x === 0) return `<span class="sc">±0</span>`;
  const good = r.better === "lower" ? x < 0 : x > 0;
  const cls = real === false ? "" : good ? "good" : "bad";
  return `<span class="sc ${cls}">${x > 0 ? "+" : "−"}${Math.abs(x).toFixed(m.d)}${m.unit}${err != null ? ` <span class="alt">±${(err * m.k).toFixed(m.d)}</span>` : ""}</span>`;
}
function partsText(e) {
  // why an attachment scores the way it does: learnable climb vs random spread
  if (!e.attachment || e.climb_delta == null) return "";
  const f = (v) => (Math.abs(v) < 5e-5 ? "±0" : `${v > 0 ? "+" : "−"}${Math.abs(v).toFixed(4)}`);
  const cls = (v) => (Math.abs(v) < 5e-5 ? "" : v < 0 ? "good" : "bad");
  return `<div class="parts">climb <span class="${cls(e.climb_delta)}">${f(e.climb_delta)} st</span></div><div class="parts">spread <span class="${cls(e.spread_delta)}">${f(e.spread_delta)} st</span></div>`;
}
function slotLine(r, e, tab) {
  // headline = what the current tab ranks by; the other two underneath
  if (!e.attachment) return deltaText(r, e);
  const f = (v) => (Math.abs(v) < 5e-5 ? "±0" : `${v > 0 ? "+" : "−"}${Math.abs(v).toFixed(4)}`);
  const cls = (v) => (Math.abs(v) < 5e-5 ? "" : v < 0 ? "good" : "bad");
  const line = (label, v) => `<div class="parts">${label} <span class="${cls(v)}">${f(v)} st</span></div>`;
  if (tab === "combined" || e.climb_delta == null) return deltaText(r, e) + partsText(e);
  const head = tab === "spread" ? e.spread_delta : e.climb_delta;
  const other = tab === "spread" ? line("climb", e.climb_delta) : line("spread", e.spread_delta);
  const goal = `<div class="parts">${esc(r.metric_label.toLowerCase())} ${deltaText(r, e).replace('class="sc', 'class="')}</div>`;
  return `<span class="sc ${cls(head)}">${f(head)} st</span>${other}${goal}`;
}
function deltaText(r, e) {
  if (!e.attachment) return `<span class="sc">${metricText(r.metric, e.score).replace(/<[^>]+>.*$/, "")}</span>`;
  if (e.delta == null) return "";
  return diffText(r, e.delta);
}

let optTab = "spread";
function renderOptResults(r) {
  state.lastOpt = r;
  const lists = r.lists || { combined: r.results };
  if (!lists[optTab]) optTab = lists.spread ? "spread" : "combined";
  const tab = optTab;
  const cell = (slot, name, alts) => {
    if (!name) return `<td class="none">none</td>`;
    const a = (alts && alts[slot]) || [];
    return `<td>${esc(attLabel(slot, name))}${a.length ? `<div class="alt" title="${esc(a.map((n) => attLabel(slot, n)).join(", "))}">+${a.length} same stats</div>` : ""}</td>`;
  };
  // the ranked value of this tab, and how to show differences in it
  const studs = { metric: "accuracy", better: "lower" };
  const main = tab === "combined"
    ? { label: r.metric_label, val: (x) => metricText(r.metric, x.score, x.score_err), diffCtx: r }
    : { label: tab === "climb" ? "Climb" : "Spread", val: (x) => `${x[tab].toFixed(4)} <span class="alt">st</span>`, diffCtx: studs };
  const extraCols = [
    ["Climb", (x) => `${x.climb.toFixed(4)} st`, "climb"],
    ["Spread", (x) => `${x.spread.toFixed(4)} st`, "spread"],
    ["Off aim", (x) => `${fmt(x.summary.aim_error, 3)} st`, "accuracy"],
    ["Avg TTK", (x) => (x.summary.ttk_mean == null ? "–" : `${Math.round(x.summary.ttk_mean * 1000)} ms`), "ttk"],
    ["On target", (x) => pct(x.summary.hit_rate), "hits"],
    ["Head", (x) => pct(x.summary.head_rate), "headshots"],
    ["Kill/mag", (x) => pct(x.summary.kill_rate, 0), ""],
  ].filter((c) => c[2] !== tab && !(tab === "combined" && c[2] === r.metric) && !(tab !== "combined" && c[2] === "accuracy" && r.metric === "accuracy" && false));
  const rowsData = lists[tab];
  const rows = rowsData.map((x, i) => `<tr class="${i === 0 ? "best" : ""}"><td class="num">#${i + 1}</td>${SLOTS.map((s) => cell(s, x.attachments[s], x.alternatives)).join("")}
      <td class="num">${main.val(x)}</td><td class="num" title="Difference to #1 measured on the same mag dumps; ± is the noise of that difference. Grey = within noise.">${i === 0 ? "best" : x.vs_best != null ? diffText(main.diffCtx, x.vs_best, x.vs_best_err, x.vs_best_real) : ""}</td>${extraCols.map((c) => `<td class="num">${c[1](x)}</td>`).join("")}
      <td><button data-apply="${i}">Apply</button></td></tr>`).join("");
  // highlight = what #1 of the tab you're looking at uses, and the per-slot
  // lists follow the same tab (sorted by spread / climb / the chosen goal)
  const best = rowsData[0] ? rowsData[0].attachments : {};
  const sign = r.better === "lower" ? 1 : -1;
  const slotKey = (e) => (tab === "combined" ? sign * (e.delta || 0) : (e[`${tab}_delta`] ?? 0));
  const ranks = SLOTS.map((slot) => {
    const raw = (r.slot_rankings || {})[slot];
    if (!raw) return `<div class="rank"><b>${slot}</b><div class="muted">kept as chosen</div></div>`;
    const list = raw.map((e, i) => [e, i]).sort((a, b) => slotKey(a[0]) - slotKey(b[0]) || a[1] - b[1]).map((x) => x[0]);
    return `<div class="rank"><b>${slot}</b> <span class="muted">vs empty slot</span><ol>${list.map((e) => `<li class="${(e.attachment || null) === (best[slot] || null) ? "chosen" : ""}" title="${esc([e.attachment ? attLabel(slot, e.attachment) : "None", ...e.same.map((n) => (n ? attLabel(slot, n) : "None"))].join(", "))}">${e.attachment ? esc(attLabel(slot, e.attachment)) : "<i>None</i>"}${e.same.length ? ` <span class="sc">(+${e.same.length} same)</span>` : ""}${slotLine(r, e, tab)}</li>`).join("")}</ol></div>`;
  }).join("");
  const base = r.baseline;
  const tabs = [["spread", "Lowest spread"], ["climb", "Lowest climb"], ["combined", `Combined · ${esc(r.metric_label)}`]]
    .filter(([k]) => lists[k]).map(([k, l]) => `<button data-optab="${k}" class="${k === tab ? "on" : ""}">${l}</button>`).join("");
  const tabNote = {
    combined: "Ranked by the goal chosen above (closeness to aim mixes climb and spread).",
    climb: "Ranked by <b>climb</b>: how far the average pattern drifts from the aim point, after your recoil-control setting. A player can learn to pull against this.",
    spread: "Ranked by <b>spread</b>: how far bullets scatter randomly around that average pattern. No one can learn this away, so it matters most for skilled players.",
  }[tab];
  $("optResults").innerHTML = `<div class="seg opttabs">${tabs}</div>
    <p class="muted small">${tabNote} <span class="unitnote"><b>st</b> = studs, Roblox's unit of distance (the target dummy is 5 studs tall; 1 stud ≈ 28 cm).</span></p>
    <table class="optres"><thead><tr><th></th>${SLOTS.map((s) => `<th>${s}</th>`).join("")}<th>${esc(main.label)}</th><th>vs #1</th>${extraCols.map((c) => `<th>${c[0]}</th>`).join("")}<th></th></tr></thead><tbody>${rows}</tbody></table>
    <p class="muted small">Baseline (${Object.keys(base.attachments).length ? "locked slots only" : "no attachments"}): ${metricText(r.metric, base.score, base.score_err).replace(/<[^>]+>/g, "")}${base.climb != null ? ` · climb ${base.climb.toFixed(4)} st · spread ${base.spread.toFixed(4)} st` : ""}. Values are compared at full precision; every setup in a stage runs on the same random mag dumps, so even small recoil differences show up · ${r.searched.exhaustive ? `tested all ${r.searched.combinations.toLocaleString()} distinct combinations` : `${r.searched.combinations.toLocaleString()} distinct combinations possible; searched the strongest and refined slot by slot for each list`} (${r.searched.simulated.toLocaleString()} setups simulated, ${r.searched.runs_search} mag dumps each, top setups re-run with ${r.searched.runs_final.toLocaleString()}).</p>
    <h3>Every attachment per slot, tested on its own</h3><p class="muted small"><span style="color:var(--accent2)">Highlighted</span> = the attachment #1 of the <b>${tab === "combined" ? "Combined" : tab === "climb" ? "Lowest climb" : "Lowest spread"}</b> tab uses; the lists are sorted by the same thing. The best single attachment isn't always part of the best setup, because attachments interact (e.g. one grip may pair better with a choke than another). Each score is split into <b>climb</b> (how far the average pattern drifts from the aim point after your recoil-control setting; a player can learn this) and <b>spread</b> (random kick around that pattern; no one can learn it). An attachment can win on one and lose on the other — e.g. a stock that makes the gun dip harder each shot cancels some camera climb but adds random kick. Raise <i>Recoil control</i> to weight spread more. All distances in st (studs).</p><div class="ranks">${ranks}</div>`;
  $("optResults").querySelectorAll("[data-optab]").forEach((b) => b.addEventListener("click", () => { optTab = b.dataset.optab; renderOptResults(r); }));
  $("optResults").querySelectorAll("[data-apply]").forEach((b) => b.addEventListener("click", () => {
    state.attachments = { ...rowsData[+b.dataset.apply].attachments };
    setSelectsFromState();
    onLoadoutChanged();
    $("optModal").classList.add("hidden");
  }));
}

/* ------------------------------------------------------------------ panels & events */
function layoutPanels() {
  // keep the side panels below the top bar whenever they would overlap it
  const tb = document.querySelector(".topbar").getBoundingClientRect();
  for (const id of ["leftPanel", "rightPanel"]) {
    const el = $(id);
    el.style.top = "";
    if (window.innerWidth <= 760) continue;
    const r = el.getBoundingClientRect();
    if (r.width && r.left < tb.right && r.right > tb.left && r.top < tb.bottom + 6) el.style.top = `${Math.ceil(tb.bottom + 8)}px`;
  }
}

function collapse(id, hide) {
  $(id).classList.toggle("hidden", hide);
  document.querySelector(`[data-reopen="${id}"]`).classList.toggle("show", hide);
  if (!hide) setTimeout(() => { drawPattern(); drawDamageGraph(); drawPerShot(); }, 30);
  if (!state.restoring && state.catalog) saveSoon();
}

const autoRun = debounce(() => { if ($("autoRun").checked) runDumps(); }, 350);
function onLoadoutChanged() {
  if (state.session && !state.session.holding) state.session = null;
  saveSettings();
  refreshStats();
  loadScene();
  drawPattern();
  autoRun();
}

let setAimSeg, setStanceSeg, setViewSeg, setPatViewSeg, setFitSeg, setOptAimSeg;
function setAim(aim) { state.aiming = aim; setAimSeg(aim ? "aim" : "hip"); onLoadoutChanged(); }
function setView(v) { state.view = v; setViewSeg(v); saveSettings(); }

function wireEvents() {
  $("weaponSearch").addEventListener("input", (e) => buildWeaponSelect(e.target.value));
  $("weaponSelect").addEventListener("change", (e) => equipFromSelect(e.target.value));
  $("weaponSearch").addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    const opts = [...$("weaponSelect").options];
    if (opts[0] && !opts[0].value && opts[0].text.startsWith("No guns")) return;
    const first = opts.find((o) => o.value);
    if (first) equipFromSelect(first.value);
  });
  for (const id of ["firemode", "shots", "triggerRpm", "aimPoint", "gravity", "fps", "health"]) $(id).addEventListener("change", onLoadoutChanged);
  $("firemode").addEventListener("change", updateTriggerRow);
  $("comp").addEventListener("input", () => { $("compVal").textContent = `${$("comp").value}%`; });
  $("comp").addEventListener("change", onLoadoutChanged);
  $("distance").addEventListener("input", () => { $("distanceNum").value = $("distance").value; });
  $("distance").addEventListener("change", onLoadoutChanged);
  $("distanceNum").addEventListener("change", () => { $("distance").value = Math.min(600, +$("distanceNum").value); onLoadoutChanged(); });
  $("dumpBtn").addEventListener("click", runDumps);
  $("dumpClear").addEventListener("click", clearDumps);
  $("errBanner").querySelector("button").addEventListener("click", hideError);
  $("resetAtts").addEventListener("click", () => {
    state.attachments = {};
    setSelectsFromState();
    $("attInfo").textContent = "";
    onLoadoutChanged();
  });
  wireDamageGraph();
  $("fireBtn").addEventListener("click", fireMag);
  $("clearBtn").addEventListener("click", () => {
    state.holes = state.holes.filter((h) => state.anim && h.anim === state.anim && h.time > animTime(state.anim));
    const firedSoFar = state.lastWatch && state.lastWatch.fire_times ? state.lastWatch.fire_times.length : 0;
    state.lastWatch = null;
    state.dotsCleared = true;
    const A = state.anim;
    if (A) { const t = animTime(A); A.clearFrom = A.shotArrivals.filter((x) => x <= t).length; A.lastCount = -1; }
    const S = state.session;
    if (S) S.clearFrom = Math.max(S.clearFrom || 0, A && A.sess === S.id ? A.clearFrom : (S.fired || firedSoFar));
    drawPattern();
  });
  $("optOpen").addEventListener("click", () => { $("optWeapon").textContent = `· ${state.weaponInfo ? state.weaponInfo.displayname : ""}`; buildOptSlots(); $("optModal").classList.remove("hidden"); });
  $("optClose").addEventListener("click", () => $("optModal").classList.add("hidden"));
  $("optModal").addEventListener("click", (e) => { if (e.target === $("optModal")) $("optModal").classList.add("hidden"); });
  $("optBtn").addEventListener("click", runOptimizer);
  $("optStop").addEventListener("click", stopOptimizer);
  $("optComp").addEventListener("input", () => { $("optCompVal").textContent = `${$("optComp").value}%`; });
  setOptAimSeg = seg("optAimSeg", (v) => { state.optAiming = v === "aim"; saveSettings(); });
  $("snapBtn").addEventListener("click", saveSnapshot);
  $("zoom").addEventListener("input", () => setZoom(Math.pow(2, +$("zoom").value)));
  $("zoomReset").addEventListener("click", () => setZoom(1));
  $("patternCanvas").addEventListener("wheel", (e) => { e.preventDefault(); setZoom(state.patternZoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15)); }, { passive: false });
  setPatViewSeg = seg("patViewSeg", (v) => { state.patternView = v; drawPattern(); saveSettings(); });
  setFitSeg = seg("fitSeg", (v) => { state.patternFit = v; drawPattern(); saveSettings(); });
  for (const id of ["dumps", "speed", "sound", "autoRun", "metric", "optComp"]) $(id).addEventListener("change", () => saveSettings());
  document.querySelectorAll(".panel-tabs [data-tab]").forEach((b) => b.addEventListener("click", () => {
    document.querySelectorAll(".panel-tabs [data-tab]").forEach((x) => x.classList.toggle("on", x === b));
    document.querySelectorAll("section[data-pane]").forEach((p) => p.classList.toggle("on", p.dataset.pane === b.dataset.tab));
    if (b.dataset.tab === "stats") setTimeout(drawDamageGraph, 10);
    if (!state.restoring) saveSettings();
  }));
  document.querySelectorAll("[data-collapse]").forEach((b) => b.addEventListener("click", () => collapse(b.dataset.collapse, true)));
  document.querySelectorAll("[data-reopen]").forEach((b) => b.addEventListener("click", () => collapse(b.dataset.reopen, false)));
  window.addEventListener("keydown", (e) => {
    if (e.target.matches("input, select, textarea")) return;
    if (e.key === "Escape") $("optModal").classList.add("hidden");
    else if (e.key === "f" || e.key === "F") fireMag();
    else if (e.key === "v" || e.key === "V") setView(state.view === "first" ? "third" : "first");
    else if (e.key === "c" || e.key === "C") $("clearBtn").click();
    else if (e.key === "x" || e.key === "X") clearDumps();
    else if (e.key === "r" || e.key === "R") reloadMag();
    else if (e.key === "h" || e.key === "H") setAim(!state.aiming);
  });
  // left mouse: hold to shoot. Right mouse: click toggles aim, drag orbits in 3rd person
  const gl = $("gl");
  let drag = null;
  gl.addEventListener("mousedown", (e) => {
    // clicking the range takes keyboard focus away from any dropdown / box, so
    // the F / R / C / X / H / V keys go to the range (preventDefault below stops
    // the browser from doing that on its own)
    if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
    if (e.button === 0) { e.preventDefault(); triggerDown(); }
    else if (e.button === 2) drag = { x: e.clientX, y: e.clientY, moved: 0 };
  });
  window.addEventListener("mouseup", (e) => {
    if (e.button === 0) triggerUp();
    if (e.button === 2 && drag) {
      if (drag.moved < 4) setAim(!state.aiming);
      drag = null;
    }
  });
  window.addEventListener("blur", () => { triggerUp(); drag = null; });
  window.addEventListener("mousemove", (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    drag.moved += Math.abs(dx) + Math.abs(dy);
    if (state.view === "third") {
      state.orbit.yaw -= dx * 0.006;
      state.orbit.pitch = Math.min(1.3, Math.max(-0.2, state.orbit.pitch + dy * 0.004));
    }
    drag.x = e.clientX; drag.y = e.clientY;
  });
  gl.addEventListener("wheel", (e) => { if (state.view === "third") { e.preventDefault(); state.orbit.dist = Math.min(40, Math.max(2.5, state.orbit.dist * (e.deltaY > 0 ? 1.1 : 0.9))); } }, { passive: false });
  gl.addEventListener("contextmenu", (e) => e.preventDefault());
}
setAimSeg = seg("aimSeg", (v) => setAim(v === "aim"));
setStanceSeg = seg("stanceSeg", (v) => { state.stance = v; onLoadoutChanged(); });
setViewSeg = seg("viewSeg", (v) => setView(v));

init().catch((e) => { $("hud").textContent = `Failed to start: ${e.message}`; console.error(e); });
