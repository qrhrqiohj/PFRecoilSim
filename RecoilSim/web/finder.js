/* RecoilSim front-end — Best setup finder. Everything that affects the search
   is shown inside the finder itself: its own gun (the range's gun when it
   opens), its own scenario (copied from the range), and per-slot locks and
   exclusions, so nothing elsewhere on the page changes it silently. */
"use strict";

const GOAL_HINTS = {
  accuracy: "Every bullet is scored by how far it lands from where you aim. Lower is better.",
  ttk: "Average time until the target dies, using head / torso / limb damage per bullet.",
  damage: "Average damage a full magazine deals to the target.",
  dps: "Damage per mag divided by how long the mag takes to fire.",
  headshots: "Share of bullets that hit the head.",
  hits: "Share of bullets that hit any body part.",
  stk_torso: "First STK (shots to kill) range, aiming at the torso: the fewest shots that kill at the gun's best range, then how much range that holds over. Shotguns are ranked by how far it holds from point blank; every other gun by the total length of range (a 50–150 sweet spot counts 100; for damage that rises with range, like the KAC SRR, that means the closest start). Pellets count for the part they really hit (head, torso, limb or a miss), every shot. Equal ranges go to the average range, then handling, then recoil (single-bullet guns that need several shots: recoil before handling). Picked automatically for guns that can one-shot the torso (on their own, or with the conversion equipped on the range or locked here), unless it's a single-bullet gun whose limbs take more damage.",
  stk_head: "First STK (shots to kill) range, aiming at the head: the fewest shots that kill at the gun's best range, then how much range that holds over. Shotguns are ranked by how far it holds from point blank; every other gun by the total length of range (a 50–150 sweet spot counts 100; for damage that rises with range, like the KAC SRR, that means the closest start). Pellets count for the part they really hit (head, torso, limb or a miss), every shot. Equal ranges go to the average range, then handling, then recoil (single-bullet guns that need several shots: recoil before handling). Never picked automatically.",
  stk_limb: "First STK (shots to kill) range, aiming at the middle of the legs: the fewest shots that kill at the gun's best range, then how much range that holds over. Shotguns are ranked by how far it holds from point blank; every other gun by the total length of range (a 50–150 sweet spot counts 100; for damage that rises with range, like the KAC SRR, that means the closest start). Pellets count for the part they really hit (head, torso, limb or a miss), every shot. Equal ranges go to the average range, then handling, then recoil (single-bullet guns that need several shots: recoil before handling). Picked automatically for a single-bullet gun that can one-shot and whose limbs take more damage than its torso.",
};
const GOAL_SHORT = { accuracy: "Dist. from aim", ttk: "Avg TTK", damage: "Dmg / mag", dps: "DPS", headshots: "Headshots", hits: "On target", stk_torso: "First STK (torso)", stk_head: "First STK (head)", stk_limb: "First STK (limb)" };
// the export's extra goal; both goal pickers show these when hovering an option
HINT_SETS.goal = Object.assign(GOAL_HINTS, {
  stk_auto: "First STK range on the limbs or the torso, picked per gun: the limbs for a single-bullet gun whose limbs take more damage than its torso, otherwise the torso (pellet guns always the torso). Every gun is ranked this way, one-shot or not; the goal column names the part.",
});
const isStk = (m) => m === "stk_torso" || m === "stk_head" || m === "stk_limb" || m === "stk_auto";  // stk_auto: export only

const finder = { comp: 100, aiming: true, depth: "thorough", top: 10, metric: "accuracy", tab: "spread", weapon: null, info: null };
let optGroups = null;       // {slot: [{rep, members, no_effect}]} from the server
const optLocks = new Map(); // slot -> attachment locked for the search ("" = empty slot)
let optLocksWeapon = null;
let slotEdit = null;        // {slot, mode: "exclude" | "lock"} — the open slot editor
let setOStance, setOptAim;

function finderUiState() {
  return { metric: $("metric").value, oneshotChance: $("oneshotChance").value, optComp: +$("optComp").value, optAiming: finder.aiming, optDepth: finder.depth, optTop: finder.top, optTab: finder.tab };
}
function applyFinderUi(u) {
  if (!u) return;
  if (u.metric === "oneshot") u.metric = "stk_torso";  // older saved settings
  if (u.metric && [...$("metric").options].some((o) => o.value === u.metric)) $("metric").value = u.metric;
  if (u.oneshotChance) $("oneshotChance").value = u.oneshotChance;
  if (u.optComp != null) { setRange("optComp", u.optComp); $("optCompVal").textContent = `${u.optComp}%`; }
  if (u.optAiming != null) { finder.aiming = u.optAiming; setOptAim(u.optAiming ? "aim" : "hip"); }
  if (u.optDepth) { finder.depth = u.optDepth; $("optDepth").value = u.optDepth; }
  if (u.optTop != null) setFinderTop(u.optTop);
  if (u.optTab) finder.tab = u.optTab;
  updateMetricHint();
}
/* how many setups to list: a preset, "All" (0) or the user's own number */
function setFinderTop(n, custom = false) {
  finder.top = n;
  const preset = ["5", "10", "20", "50", "0"].includes(String(n)) && !custom;
  $("optTop").value = preset ? String(n) : "custom";
  $("optTopN").classList.toggle("hidden", preset);
  if (!preset) $("optTopN").value = n;
  updateTopHint();
}
function updateTopHint() {
  $("optTopHint").textContent = finder.top === 0 ? "All lists every distinct setup the search finds; re-running them all with many mags takes longer." : "";
}
function updateMetricHint() {
  // the description shows when hovering the goal (and each option in its list)
  $("metric").title = GOAL_HINTS[$("metric").value] || "";
  // "counts as a one-shot" only matters for pellets: a single bullet's first shot
  // lands where you aim, so it one-shots every time or never
  $("oneshotRow").classList.toggle("hidden", !isStk($("metric").value) || !finder.showChance);
}
/* The first STK range (torso) goal is picked automatically when the setup being
   searched can kill with one torso shot (shotguns, most snipers…): the bare gun
   with the finder's locks, or — for the gun on the range — what's equipped there
   plus the locks, so equipping or locking a conversion that adds a one-shot
   (slugs, a magnum conversion, a buckshot conversion) selects it; other guns get
   spread. A goal you pick yourself stays until the gun or that answer changes. */
function finderSetup(withEquipped) {
  const atts = withEquipped && finder.weapon === state.weapon ? { ...state.attachments } : {};
  for (const [slot, name] of optLocks) { if (name) atts[slot] = name; else delete atts[slot]; }
  return atts;
}
let goalSeq = 0;
async function refreshGoalOptions() {
  const info = finder.info;
  if (!info) return;
  const seq = ++goalSeq;
  const hp = +$("oHealth").value || 100;
  let lockedPellets = info.pellets || 1;
  // the part a one-shot is aimed at: single bullets go for the torso, or the limbs
  // when those take more damage; pellet guns always aim at the torso and only count
  // when every pellet there kills (their pellets spread onto the limbs anyway).
  // null when it can't be one-shot.
  const partOf = (d, pellets) => {
    if (!d) return null;
    if ((pellets || 1) > 1) return d.torso >= hp - 1e-9 ? "torso" : null;
    const part = d.limb > d.torso + 1e-9 ? "limb" : "torso";
    return d[part] >= hp - 1e-9 ? part : null;
  };
  const canOf = async (atts, locked) => {
    if (!Object.values(atts).some(Boolean)) return partOf(info.oneshot_damage, info.pellets);
    try {
      const r = await api("/api/oneshot_info", { weapon: finder.weapon, attachments: atts });
      if (locked) lockedPellets = r.pellets;
      return partOf(r.oneshot_damage, r.pellets);
    } catch (e) { return null; }
  };
  const can = (await canOf(finderSetup(false), true)) || (await canOf(finderSetup(true), false));
  if (seq !== goalSeq) return;
  // pellets in the search: the gun with its locks fires pellets, or the search can
  // still pick an attachment that adds them (a buckshot conversion)
  finder.showChance = lockedPellets > 1 || (info.pellet_atts || []).some((a) => !optLocks.has(a.slot) && !exSet(a.slot).has(a.name));
  const m = $("metric");
  // the gun or its one-shot answer changed: pick the matching goal — first STK
  // range (torso) for guns that one-shot, spread otherwise (a goal you choose
  // afterwards stays until one of them changes again)
  const key = `${finder.weapon}|${can}`;
  if (finder.autoKey !== key) {
    finder.autoKey = key;
    m.value = can ? `stk_${can}` : "accuracy";
  }
  updateMetricHint();
}

/* attachment names of the finder's gun (which may not be the range's gun) */
function fLabel(slot, name) {
  const o = ((finder.info && finder.info.attachments[slot]) || []).find((x) => x.name === name);
  return o ? o.displayname : name;
}
/* hover text: the attachment's name with the kills it takes to unlock on this gun */
function fTip(slot, name) {
  if (!name) return "None";
  const o = ((finder.info && finder.info.attachments[slot]) || []).find((x) => x.name === name);
  return o ? `${o.displayname} — ${killLabel(o.kills, o.test)}` : name;
}

function initFinder() {
  for (const [k, m] of Object.entries(state.catalog.metrics)) $("metric").add(new Option(m.label, k));
  $("metric").value = "accuracy";
  for (const o of $("aimPoint").options) $("oAimPoint").add(new Option(o.text, o.value));
  setOStance = seg("oStanceSeg", () => {});
  setOptAim = seg("optAimSeg", (v) => { finder.aiming = v === "aim"; saveSettings(); });
  updateMetricHint();
  $("metric").addEventListener("change", () => { updateMetricHint(); saveSettings(); });
  $("oneshotChance").addEventListener("change", () => saveSettings());
  $("oHealth").addEventListener("change", refreshGoalOptions);
  $("optComp").addEventListener("input", () => { paintRange($("optComp")); $("optCompVal").textContent = `${$("optComp").value}%`; });
  $("optComp").addEventListener("change", () => saveSettings());
  $("optDepth").addEventListener("change", () => { finder.depth = $("optDepth").value; saveSettings(); });
  $("optTop").addEventListener("change", () => {
    const v = $("optTop").value;
    if (v === "custom") { $("optTopN").classList.remove("hidden"); $("optTopN").value = finder.top || 10; $("optTopN").focus(); finder.top = +$("optTopN").value; }
    else setFinderTop(+v);
    updateTopHint(); saveSettings();
  });
  $("optTopN").addEventListener("change", () => { setFinderTop(Math.max(1, Math.round(+$("optTopN").value || 1)), true); saveSettings(); });
  $("optSync").addEventListener("click", () => { syncScenario(true); toast("Scenario copied from the range."); });
  $("optDefaults").addEventListener("click", openDefaultsEditor);
  $("optOpen").addEventListener("click", () => openFinder());
  $("optGun").addEventListener("click", () => openWeaponPicker($("optGun"), { current: () => finder.weapon, pick: (n) => setFinderWeapon(n) }));
  $("optClose").addEventListener("click", () => closeModal("optModal"));
  $("optFull").addEventListener("click", toggleFinderFull);
  setFinderFull(!!prefs.finderFull);
  $("optModal").addEventListener("mousedown", (e) => { if (e.target === $("optModal")) closeModal("optModal"); });
  $("optBtn").addEventListener("click", runOptimizer);
  $("optStop").addEventListener("click", stopOptimizer);
  $("optSlots").addEventListener("click", onOptSlotClick);
  $("optReset").addEventListener("click", resetFinderSlots);
  paintRange($("optComp"));
}

function setFinderFull(on) {
  $("optModal").classList.toggle("full", on);
  $("optFull").classList.toggle("on", on);
  $("optFull").title = on ? "Exit full screen (F)" : "Full screen (F)";
}
function toggleFinderFull() {
  prefs.finderFull = !$("optModal").classList.contains("full");
  savePrefs();
  setFinderFull(prefs.finderFull);
}
function openFinder() {
  // always starts on the gun that's on the range; change it inside the finder
  finder.weapon = state.weapon;
  finder.info = state.weaponInfo;
  showFinderWeapon();
  syncScenario();
  refreshGoalOptions();
  openModal("optModal");
}
async function setFinderWeapon(name) {
  if (!name || name === finder.weapon) return;
  try {
    finder.info = name === state.weapon ? state.weaponInfo : await api(`/api/weapon?name=${encodeURIComponent(name)}`);
  } catch (e) { toast(`Couldn't load that gun: ${e.message}`, 3500); return; }
  finder.weapon = name;
  showFinderWeapon();
  refreshGoalOptions();
  syncFireModes(name === state.weapon);
}
function showFinderWeapon() {
  $("optGunName").textContent = finder.info ? finder.info.displayname : "—";
  $("optGunClass").textContent = finder.info ? titleCase(finder.info.class || "") : "";
  buildOptSlots();
  const r = state.optResults[finder.weapon];
  if (r) renderOptResults(r);
  else if (!optJobId) renderEmptyResults();
}
function onWeaponChangedFinder() { /* the finder keeps its own gun while it's open */ }

/* the finder's own scenario: copied from the range on open, edited here only */
function syncScenario(all = false) {
  // on open: range, aim point, stance, health, FPS, fire mode. "Copy from range"
  // also copies sight and recoil control (the finder's own defaults otherwise)
  const s = settings();
  if (all) {
    finder.aiming = s.aiming; setOptAim(s.aiming ? "aim" : "hip");
    setRange("optComp", s.compensation); $("optCompVal").textContent = `${s.compensation}%`;
    saveSettings();
  }
  $("oDistance").value = s.distance;
  $("oAimPoint").value = s.aim_point;
  setOStance(s.stance);
  $("oHealth").value = s.health;
  $("oFps").value = String(s.fps);
  syncFireModes(finder.weapon === state.weapon);
}
function syncFireModes(sameGun) {
  const modes = (finder.info && finder.info.firemodes) || ["AUTO"];
  $("oFiremode").innerHTML = modes.map((m, i) => `<option value="${i}">${esc(prettyMode(m))}</option>`).join("");
  const cur = sameGun ? modes.indexOf(currentModeLabel()) : -1;
  $("oFiremode").value = String(Math.max(0, cur));
}
function finderSettings() {
  const base = settings();
  const fmSel = $("oFiremode");
  const modes = (finder.info && finder.info.firemodes) || [];
  const stance = ($("oStanceSeg").querySelector("button.on") || {}).dataset;
  return {
    ...base,
    shots: null, trigger_rpm: finder.weapon === state.weapon ? base.trigger_rpm : null,
    distance: +$("oDistance").value || base.distance,
    aim_point: $("oAimPoint").value || base.aim_point,
    stance: stance ? stance.v : base.stance,
    firemode_index: +fmSel.value || 0,
    firemode_label: modes[+fmSel.value || 0] || null,
    health: +$("oHealth").value || base.health,
    fps: clampFps($("oFps").value),
    drop: $("oDrop").checked,
    compensation: +$("optComp").value,
    aiming: finder.aiming,
    oneshot_chance: finder.showChance ? +$("oneshotChance").value || 80 : null,
  };
}

/* ------------------------------------------------------------------ slots: exclude / lock */
async function buildOptSlots() {
  if (optLocksWeapon !== finder.weapon) { optLocks.clear(); optLocksWeapon = finder.weapon; slotEdit = null; }
  $("optSlots").innerHTML = `<p class="hint">Loading attachments…</p>`;
  const w = finder.weapon;
  try {
    const g = await api("/api/attachment_groups", { weapon: w });
    if (w !== finder.weapon) return;
    optGroups = g;
  } catch (e) { $("optSlots").innerHTML = `<p class="error">${esc(e.message)}</p>`; return; }
  renderOptSlots();
  renderSlotEditor();
}
/* exclusions: per gun; a gun nobody has edited uses the default list (joke /
   novelty attachments), the same list the every-gun export starts from */
function defaultExcludesFor(weapon, info) {
  const tokens = defaultTokenList();
  const names = new Set(tokens.filter((t) => !t.includes("::")).concat(tokens.filter((t) => t.startsWith(`${weapon}::`)).map((t) => t.slice(weapon.length + 2))));
  const out = {};
  const atts = (info || (weapon === finder.weapon ? finder.info : state.weaponInfo) || {}).attachments || {};
  for (const slot of SLOTS) {
    const l = (atts[slot] || []).map((o) => o.name).filter((n) => names.has(n));
    if (l.length) out[slot] = l;
  }
  return out;
}
function excludesFor(weapon) { return state.excludes[weapon] || defaultExcludesFor(weapon); }
function exSet(slot) { return new Set(excludesFor(finder.weapon)[slot] || []); }
function finderIsClear() {
  return !optLocks.size && !Object.values(excludesFor(finder.weapon)).some((l) => l.length);
}
function resetFinderSlots() {
  // first press: search everything (no exclusions, no locks); pressed again
  // when nothing is excluded: back to the default exclusions
  if (finderIsClear()) {
    delete state.excludes[finder.weapon];
    toast("Default exclusions are back.");
  } else {
    state.excludes[finder.weapon] = {};
    optLocks.clear();
    toast("Every attachment is searched. Press again for the default exclusions.");
  }
  slotEdit = null;
  store();
  renderOptSlots(); renderSlotEditor();
  refreshGoalOptions();
}
function exCount(slot) {
  const groups = (optGroups && optGroups[slot]) || [];
  const ex = exSet(slot);
  return groups.filter((g) => (g.rep === null ? ex.has("") : g.members.every((m) => ex.has(m)))).length;
}
function renderOptSlots() {
  $("optReset").textContent = finderIsClear() ? "Restore default exclusions" : "Reset all";
  $("optSlots").innerHTML = SLOTS.map((slot) => {
    const groups = (optGroups && optGroups[slot]) || [];
    const n = ((finder.info && finder.info.attachments[slot]) || []).length;
    const locked = optLocks.has(slot);
    const lock = optLocks.get(slot);
    const effect = groups.filter((g) => !g.no_effect).length;
    const exN = exCount(slot);
    const open = slotEdit && slotEdit.slot === slot ? slotEdit.mode : "";
    const status = !n ? "No attachments" : locked ? `Locked: <b>${lock ? esc(fLabel(slot, lock)) : "empty"}</b>`
      : `Searching ${effect} option${effect === 1 ? "" : "s"}`;
    return `<div class="oslot ${open ? "open" : ""} ${locked ? "kept" : ""}">
      <div class="oslot-top"><span class="nm">${slot}</span></div>
      <div class="oslot-sub">${status}</div>
      <div class="oslot-btns">
        <button class="btn small ${open === "exclude" ? "on" : ""} ${exN ? "has" : ""}" data-edit="exclude" data-slot="${slot}" ${n && !locked ? "" : "disabled"} title="Leave attachments out of this slot's search">${icon("x")}Exclude${exN ? ` (${exN})` : ""}</button>
        <button class="btn small ${open === "lock" ? "on" : ""} ${locked ? "lk" : ""}" data-edit="lock" data-slot="${slot}" ${n ? "" : "disabled"} title="Search with this slot fixed to one attachment">${icon("lock")}${locked ? "Locked" : "Lock"}</button>
      </div>
    </div>`;
  }).join("");
}
function onOptSlotClick(e) {
  const b = e.target.closest("[data-edit]");
  if (!b || b.disabled) return;
  const same = slotEdit && slotEdit.slot === b.dataset.slot && slotEdit.mode === b.dataset.edit;
  slotEdit = same ? null : { slot: b.dataset.slot, mode: b.dataset.edit };
  renderOptSlots(); renderSlotEditor();
}
function renderSlotEditor(filter = "") {
  const box = $("exEditor");
  if (!slotEdit || !optGroups) { box.classList.add("hidden"); return; }
  box.classList.remove("hidden");
  const { slot, mode } = slotEdit;
  const f = norm(filter);
  const done = () => { slotEdit = null; renderOptSlots(); renderSlotEditor(); };
  const rerender = () => { renderOptSlots(); renderSlotEditor($("exSearch").value); refreshGoalOptions(); };
  if (mode === "lock") {
    const opts = (finder.info.attachments[slot] || []).filter((o) => !f || norm(o.displayname).includes(f) || norm(o.category).includes(f));
    const cur = optLocks.has(slot) ? optLocks.get(slot) : null;
    const eq = finder.weapon === state.weapon ? state.attachments[slot] : undefined;
    box.className = "exeditor lockmode";
    box.innerHTML = `<div class="exhead"><h4>Lock the ${slot.toLowerCase()} slot <span class="hint">· the search keeps this attachment and tries everything else around it</span></h4>
        <input id="exSearch" placeholder="Filter…" value="${esc(filter)}"><button class="btn small primary" id="exClose">Done</button></div>
      <div class="chips">
        <span class="chip ${cur === null ? "on" : ""}" data-lockv="__search">Don't lock (search all)</span>
        <span class="chip empty ${cur === "" ? "lk" : ""}" data-lockv="">Empty slot</span>
        ${opts.map((o) => `<span class="chip ${cur === o.name ? "lk" : ""}" data-lockv="${esc(o.name)}" title="${esc(`${killLabel(o.kills, o.test)}${o.info ? ` · ${o.info}` : ""}`)}">${esc(o.displayname)}${o.name === eq ? ` <span class="sm">equipped</span>` : ""}</span>`).join("") || `<span class="hint">Nothing matches.</span>`}
      </div>`;
    box.querySelectorAll("[data-lockv]").forEach((c) => c.addEventListener("click", () => {
      if (c.dataset.lockv === "__search") optLocks.delete(slot); else optLocks.set(slot, c.dataset.lockv);
      rerender();
      refreshGoalOptions();
    }));
  } else {
    // game loadout order: empty slot first, then by the fewest kills any member needs
    // test-only attachments last (by kills), like everywhere else
    const kills = Object.fromEntries((finder.info.attachments[slot] || []).map((o) => [o.name, (o.test ? 1e7 : 0) + (o.kills || 0)]));
    const gk = (g) => (g.rep === null ? -1 : Math.min(...g.members.map((m) => (kills[m] == null ? 1e9 : kills[m]))));
    const groups = [...(optGroups[slot] || [])].sort((a, b) => gk(a) - gk(b));
    const ex = exSet(slot);
    const label = (g) => (g.rep === null ? "Empty slot" : fLabel(slot, g.rep));
    const isEx = (g) => (g.rep === null ? ex.has("") : g.members.every((m) => ex.has(m)));
    const shown = groups.filter((g) => !f || norm(label(g)).includes(f) || g.members.some((m) => norm(fLabel(slot, m)).includes(f)));
    box.className = "exeditor";
    box.innerHTML = `<div class="exhead"><h4>Exclude from the ${slot.toLowerCase()} search <span class="hint">· red = left out, click to toggle</span></h4>
        <input id="exSearch" placeholder="Filter…" value="${esc(filter)}">
        <button class="btn small" id="exNone">Include all</button><button class="btn small" id="exAll">Exclude all</button><button class="btn small primary" id="exClose">Done</button></div>
      <div class="chips">${shown.map((g) => {
        const same = g.rep === null ? [] : g.members.filter((m) => m !== g.rep);
        const tip = g.rep === null ? `Leaves the slot empty. Same result as: ${g.members.map((m) => fLabel(slot, m)).join(", ") || "nothing else"}` : [g.rep, ...same].map((m) => fLabel(slot, m)).join(", ");
        return `<span class="chip ${isEx(g) ? "x" : ""} ${g.rep === null ? "empty" : ""}" data-g="${groups.indexOf(g)}" title="${esc(tip)}">${esc(label(g))}${same.length ? ` <span class="sm">+${same.length} identical</span>` : ""}</span>`;
      }).join("") || `<span class="hint">Nothing matches.</span>`}</div>`;
    const setEx = (names, on) => {
      const e = state.excludes[finder.weapon] = state.excludes[finder.weapon] || JSON.parse(JSON.stringify(defaultExcludesFor(finder.weapon)));
      const set = new Set(e[slot] || []);
      for (const n of names) on ? set.add(n) : set.delete(n);
      e[slot] = [...set];
      store();
    };
    const namesOf = (g) => (g.rep === null ? ["", ...g.members] : g.members);
    box.querySelectorAll("[data-g]").forEach((c) => c.addEventListener("click", () => { const g = groups[+c.dataset.g]; setEx(namesOf(g), !isEx(g)); rerender(); }));
    $("exNone").addEventListener("click", () => { setEx(groups.flatMap(namesOf), false); rerender(); });
    $("exAll").addEventListener("click", () => { setEx(groups.filter((g) => g.rep !== null).flatMap(namesOf), true); rerender(); });
  }
  $("exSearch").addEventListener("input", (e) => { const v = e.target.value; renderSlotEditor(v); const i = $("exSearch"); i.focus(); i.setSelectionRange(v.length, v.length); });
  $("exClose").addEventListener("click", done);
}

/* ------------------------------------------------------------------ running the search */
let optTimer = null, optJobId = null;
async function runOptimizer() {
  const locked = {};
  for (const [slot, name] of optLocks) locked[slot] = name;
  const weapon = finder.weapon, info = finder.info;
  $("optBtn").disabled = true;
  $("optStop").hidden = false;
  const prog = $("optProgress");
  prog.classList.add("show");
  prog.querySelector(".bar").style.width = "0%";
  prog.querySelector(".label").textContent = "Starting…";
  $("optResults").innerHTML = "";
  clearTimeout(optTimer);
  const done = () => { $("optBtn").disabled = false; $("optStop").hidden = true; optJobId = null; };
  const scenario = finderSettings();
  try {
    const { id } = await api("/api/optimize", {
      weapon, metric: $("metric").value, settings: scenario, locked, exclude: excludesFor(weapon),
      depth: finder.depth, top_n: finder.top,
    });
    optJobId = id;
    const poll = async () => {
      if (optJobId !== id) return;
      let st;
      try { st = await api(`/api/job?id=${id}`); } catch (e) { optTimer = setTimeout(poll, 1000); return; }
      if (optJobId !== id) return;
      prog.querySelector(".bar").style.width = `${Math.round(st.progress * 100)}%`;
      // the step's own count (e.g. 120 / 243), then everything simulated so far in all steps
      const step = st.step_total > 1 ? ` (${st.step_done.toLocaleString()} / ${st.step_total.toLocaleString()})` : "";
      prog.querySelector(".label").textContent = `${Math.round(st.progress * 100)}% · ${st.stage}${step} · ${st.evaluated.toLocaleString()} simulated in total · ${st.elapsed}s`;
      if (st.done) {
        done();
        prog.classList.remove("show");
        if (st.error === "cancelled") { $("optResults").innerHTML = `<p class="hint">Search stopped.</p>`; return; }
        if (st.error) { $("optResults").innerHTML = `<p class="error">${esc(st.error)}</p>`; return; }
        st.result.weapon = weapon;
        st.result.scenario = scenario;
        st.result.gunName = info.displayname;
        st.result.labels = Object.fromEntries(SLOTS.map((sl) => [sl, Object.fromEntries((info.attachments[sl] || []).map((o) => [o.name, o.displayname]))]));
        state.lastOptWeapon = weapon;
        state.optResults[weapon] = st.result;
        if (weapon === finder.weapon) renderOptResults(st.result);
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
  // stop for real: the server cancels the job and stops its worker processes
  const id = optJobId;
  optJobId = null;
  clearTimeout(optTimer);
  api("/api/optimize/cancel", { id }).catch(() => {});
  $("optBtn").disabled = false;
  $("optStop").hidden = true;
  $("optProgress").classList.remove("show");
  $("optResults").innerHTML = `<p class="hint">Search stopped.</p>`;
}

/* ------------------------------------------------------------------ results */
function renderEmptyResults() {
  $("optResults").innerHTML = `<div class="empty-state"><div>${icon("best")}<h4>Find the best attachments for ${esc(finder.info ? finder.info.displayname : "this gun")}</h4>
    <p>Pick a goal and scenario on the left, then press <b>Find best setup</b>. You get three rankings: lowest spread, lowest climb and best overall (your goal). To search around an attachment, use <b>Lock</b> on its slot above.</p></div></div>`;
}
// full-precision formatting (scores are compared exactly)
function metricScale(metric) {
  if (metric === "ttk") return { k: 1000, unit: "ms", d: 2 };
  if (metric === "accuracy") return { k: 1, unit: "st", d: 4 };
  if (metric === "hits" || metric === "headshots") return { k: 100, unit: "%", d: 3 };
  if (isStk(metric)) return { k: 1, unit: "st", d: 1 };
  return { k: 1, unit: "", d: 2 };
}
const STUDS = { metric: "accuracy", better: "lower" };
function valueCell(metric, v, err) {
  if (v == null) return "–";
  const m = metricScale(metric);
  return `${(v * m.k).toFixed(m.d)}<span class="u">${m.unit}</span>${err != null ? `<span class="pm">±${(err * m.k).toFixed(m.d)}</span>` : ""}`;
}
/* first STK scores are "range − 10000 × shots": split them back up */
const STK_STEP = 1e4;
function stkSplit(score) { const k = Math.max(1, Math.ceil(-score / STK_STEP - 1e-9)); return { k, val: score + STK_STEP * k }; }
function stkDiff(v) { const n = Math.round(-v / STK_STEP); return { shots: n, studs: v + STK_STEP * n }; }
function diffCell(ctx, v, err, real) {
  if (isStk(ctx.metric) && Math.abs(v) >= STK_STEP / 2) {
    const n = stkDiff(v).shots;  // takes more (or fewer) shots: that's the difference that counts
    return `<span class="${n > 0 ? "bad" : "good"}">${n > 0 ? "+" : "−"}${Math.abs(n)}<span class="u"> shot${Math.abs(n) === 1 ? "" : "s"}</span></span>`;
  }
  const m = metricScale(ctx.metric);
  const x = v * m.k;
  if (x === 0) return `<span class="same">±0</span>`;
  const good = ctx.better === "lower" ? x < 0 : x > 0;
  const cls = real === false ? "same" : good ? "good" : "bad";
  return `<span class="${cls}">${x > 0 ? "+" : "−"}${Math.abs(x).toFixed(m.d)}<span class="u">${m.unit === "%" ? " pt" : m.unit}</span></span>${err != null ? `<span class="pm">±${(err * m.k).toFixed(m.d)}</span>` : ""}`;
}
function studDelta(v) {
  if (v == null) return "";
  if (Math.abs(v) < 5e-5) return `<span class="same">±0</span>`;
  return `<span class="${v < 0 ? "good" : "bad"}">${v > 0 ? "+" : "−"}${Math.abs(v).toFixed(4)}</span>`;
}

function renderOptResults(r) {
  const lists = r.lists || { combined: r.results };
  if (isStk(r.metric) && !r.tabChosen) finder.tab = "combined";  // the first STK list is the point for these goals
  if (!lists[finder.tab]) finder.tab = lists.spread ? "spread" : "combined";
  const tab = finder.tab;
  const goal = GOAL_SHORT[r.metric] || r.metric_label;
  const cols = {
    spread: { label: "Spread", val: (x) => valueCell("accuracy", x.spread), ctx: STUDS },
    climb: { label: "Climb", val: (x) => valueCell("accuracy", x.climb), ctx: STUDS },
    combined: { label: goal, val: (x) => (isStk(r.metric) ? oneshotCell(x) : valueCell(r.metric, x.score, x.score_err)), ctx: r },
  };
  const main = cols[tab];
  const others = ["spread", "climb", "combined"].filter((k) => k !== tab).map((k) => cols[k]);
  if (isStk(r.metric)) {
    const sgn = (v) => (v == null ? "–" : `${v > 0 ? "+" : v < 0 ? "−" : "±"}${Math.abs(v * 100).toFixed(1)}<span class="u">%</span>`);
    others.push({ label: "Handling", val: (x) => sgn(x.handling) });
    others.push({ label: "Dist. from aim", val: (x) => valueCell("accuracy", x.summary.aim_error) });
    for (const [p, l] of [["head", "Avg 1-shot head"], ["torso", "Avg 1-shot torso"], ["limb", "Avg 1-shot limb"]]) {
      if (rowsAny(lists[tab], p)) others.push({ label: l, val: (x) => { const v = ((x.summary || {}).oneshot_avg || {})[p]; return v == null ? "–" : `${esc(v.text)}${/\d\+?$/.test(v.text) ? `<span class="u">st</span>` : ""}`; } });
    }
  }
  if (r.metric !== "ttk") others.push({ label: "Avg TTK", val: (x) => (x.summary.ttk_mean == null ? "–" : `${Math.round(x.summary.ttk_mean * 1000)}<span class="u">ms</span>`) });
  if (r.metric !== "hits") others.push({ label: "On target", val: (x) => pct(x.summary.hit_rate) });
  const rowsData = lists[tab];
  const cell = (slot, name, alts) => {
    if (!name) return `<td class="att none">—</td>`;
    const a = (alts && alts[slot]) || [];
    return `<td class="att" title="${esc([name, ...a].map((n) => fTip(slot, n)).join("\n"))}">${esc(fLabel(slot, name))}${a.length ? `<span class="alt">+${a.length} identical</span>` : ""}</td>`;
  };
  // Equip sits next to the rank so it's reachable without scrolling the wide table sideways
  const rows = rowsData.map((x, i) => `<tr class="${i === 0 ? "first" : ""}"><td class="pos">${i + 1}</td><td class="act"><button class="btn small" data-apply="${i}" title="Put this setup on the gun on the range">Equip</button></td>${SLOTS.map((s) => cell(s, x.attachments[s], x.alternatives)).join("")}
      <td class="num main">${main.val(x)}</td>
      <td class="num">${i === 0 ? `<span class="same">best</span>` : x.vs_best != null ? diffCell(main.ctx, x.vs_best, x.vs_best_err, x.vs_best_real) : ""}</td>
      ${others.map((c) => `<td class="num">${c.val(x)}</td>`).join("")}</tr>`).join("");
  const order = isStk(r.metric) ? [["combined", "Best overall"], ["spread", "Lowest spread"], ["climb", "Lowest climb"]]
    : [["spread", "Lowest spread"], ["climb", "Lowest climb"], ["combined", "Best overall"]];
  const tabs = order
    .filter(([k]) => lists[k]).map(([k, l]) => `<button data-v="${k}" class="${k === tab ? "on" : ""}">${l}</button>`).join("");
  const note = {
    spread: "Ranked by <b>spread</b> — the random scatter around the average pattern. Nobody can learn it away, so it matters most for good players.",
    climb: "Ranked by <b>climb</b> — how far the recoil drags the average pattern away from your aim before any recoil control: how much you have to pull against. Lower = easier to control.",
    combined: isStk(r.metric)
      ? `<b>Best overall</b> — ranked by the first STK range (${r.metric.slice(4)}): the fewest shots that kill at the gun's best range${(r.scenario || {}).oneshot_chance ? ` (a one-shot has to kill ${Math.round(r.scenario.oneshot_chance)}% of the time)` : ""}, then how far that holds; equal ranges go to the longer <b>average</b> range, then better <b>handling</b> (aim, walk, sprint and equip speed vs the bare gun), then less recoil (distance from aim) — for a single-bullet gun that needs several shots, less recoil comes before handling.`
      : `<b>Best overall</b> — ranked by your goal: <b>${esc(r.metric_label)}</b>.`,
  }[tab];
  const sc = r.scenario || {};
  const base = r.baseline;
  $("optResults").innerHTML = `
    <div class="res-head"><div class="seg" id="optTabs">${tabs}</div>
      <span class="hint">${sc.distance ? `${sc.distance} st · ${sc.aiming === false ? "hip fire" : "aimed"} · ${sc.compensation}% control · ${esc(prettyMode(sc.firemode_label || ""))}` : ""}</span></div>
    <p class="res-note">${note} Differences to #1 are measured on the same simulated mags; grey means within noise.</p>
    <table class="rank"><thead><tr><th></th><th></th>${SLOTS.map((s) => `<th>${s}</th>`).join("")}<th class="num">${esc(main.label)}</th><th class="num">vs #1</th>${others.map((c) => `<th class="num">${esc(c.label)}</th>`).join("")}</tr></thead><tbody>${rows}</tbody></table>
    <section class="breakdown"><h3>Every attachment on its own <span class="hint">— sorted the same way, compared with an empty slot</span></h3>${breakdownHtml(r, tab, rowsData[0] ? rowsData[0].attachments : {})}</section>
    <p class="foot-meta">Without attachments${Object.keys(base.attachments).length ? " (kept slots only)" : ""}: ${esc(goal.toLowerCase())} ${isStk(r.metric) ? esc(((base.summary || {}).oneshot_band || "–")) + (/\d\+?$/.test((base.summary || {}).oneshot_band || "") ? " st" : "") : valueCell(r.metric, base.score).replace(/<[^>]+>/g, " ")}${base.climb != null ? ` · climb ${base.climb.toFixed(4)} st · spread ${base.spread.toFixed(4)} st` : ""}.
      ${r.searched.exhaustive ? `Tested all ${r.searched.combinations.toLocaleString()} distinct combinations` : `${r.searched.combinations.toLocaleString()} distinct combinations possible — tested the strongest and refined slot by slot`};
      ${r.searched.simulated.toLocaleString()} setups simulated with ${r.searched.runs_search} mags each, top setups re-run with ${r.searched.runs_final.toLocaleString()}.</p>`;
  seg("optTabs", (v) => { finder.tab = v; r.tabChosen = true; saveSettings(); renderOptResults(r); });
  $("optResults").querySelectorAll("[data-apply]").forEach((b) => b.addEventListener("click", async () => {
    const atts = { ...rowsData[+b.dataset.apply].attachments };
    closeModal("optModal");
    if (r.weapon && r.weapon !== state.weapon) await selectWeapon(r.weapon, atts);
    else { state.attachments = atts; renderSlots(); onLoadoutChanged(); }
    toast("Setup equipped on the range.");
  }));
}
/* first STK range as the shots and where they kill: "1-shot: 95.7" (from point
   blank), "1-shot: 80.0–250.0" (a hump in the damage curve), "1-shot: 197.3+"
   (rising damage: from there on), "2-shot: any range" */
function oneshotCell(x) {
  const t = (x.summary || {}).oneshot_band || x.score.toFixed(1);
  return `${esc(t)}${/\d\+?$/.test(t) ? `<span class="u">st</span>` : ""}${x.score_err ? `<span class="pm">±${x.score_err.toFixed(1)}</span>` : ""}`;
}
function stkText(score) { const { k, val } = stkSplit(score); return `${k}-shot · ${val.toFixed(1)}<span class="u">st</span>`; }
function rowsAny(rows, part) { return (rows || []).some((x) => x.summary && x.summary.oneshot_avg && x.summary.oneshot_avg[part] != null); }
function breakdownHtml(r, tab, best) {
  const sign = r.better === "lower" ? 1 : -1;
  const key = (e) => (tab === "combined" ? sign * (e.delta || 0) : (e[`${tab}_delta`] ?? 0));
  return `<div class="ranks">${SLOTS.map((slot) => {
    const raw = (r.slot_rankings || {})[slot];
    if (!raw) return `<div class="rankcol"><h5>${slot}<span>kept</span></h5><p class="hint">Not searched.</p></div>`;
    const list = raw.map((e, i) => [e, i]).sort((a, b) => key(a[0]) - key(b[0]) || a[1] - b[1]).map((x) => x[0]);
    return `<div class="rankcol"><h5>${slot}</h5><ol>${list.map((e) => {
      const head = tab === "combined" || e.climb_delta == null ? (e.attachment ? (e.delta == null ? "" : diffCell(r, e.delta)) : `<span class="same">${isStk(r.metric) ? `${stkSplit(e.score).val.toFixed(1)}<span class="u">st</span>` : valueCell(r.metric, e.score).replace(/<span class="pm">.*$/, "")}</span>`)
        : studDelta(tab === "spread" ? e.spread_delta : e.climb_delta);
      // secondary numbers, one per line under the main one (label left, value right)
      const goalName = esc(GOAL_SHORT[r.metric].toLowerCase());
      const subs = !e.attachment ? [[isStk(r.metric) && e.score != null ? `baseline · ${stkSplit(e.score).k}-shot` : "baseline", ""]] : tab === "spread" ? [["climb", studDelta(e.climb_delta)], [goalName, diffCell(r, e.delta || 0)]]
        : tab === "climb" ? [["spread", studDelta(e.spread_delta)], [goalName, diffCell(r, e.delta || 0)]]
        : e.climb_delta == null ? [] : [["climb", studDelta(e.climb_delta)], ["spread", studDelta(e.spread_delta)]];
      const subHtml = subs.map(([k, v]) => `<span class="sub2"><em>${k}</em><span>${v.replace(/<span class="(pm|u)">[^<]*<\/span>/g, "")}</span></span>`).join("");
      const names = [fTip(slot, e.attachment), ...e.same.map((n) => fTip(slot, n))].join("\n");
      return `<li class="${(e.attachment || null) === (best[slot] || null) ? "chosen" : ""}" title="${esc(names)}"><span class="an">${e.attachment ? esc(fLabel(slot, e.attachment)) : "<i>None</i>"}${e.same.length ? ` <span class="hint">+${e.same.length}</span>` : ""}</span><span class="dv">${head}</span>${subHtml}</li>`;
    }).join("")}</ol></div>`;
  }).join("")}</div>
  <p class="hint">Highlighted: what #1 in this list uses. The best single attachment isn't always in the best setup, because attachments interact.</p>`;
}
