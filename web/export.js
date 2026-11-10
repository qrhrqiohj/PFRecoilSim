/* RecoilSim front-end — Export: builds tables (columns + rows) and hands them
   to Google Sheets (tab-separated, via the clipboard), Excel (.xlsx) or CSV. */
"use strict";

const EXPORT_KINDS = [
  { id: "allBest", icon: "best", title: "Best setups · your guns", sub: "Runs the setup finder on the guns you pick (all by default)." },
  { id: "gunBest", icon: "gun", title: "Best setups · one gun", sub: "The latest Best setup results (the range's gun, or the last gun you searched)." },
  { id: "allStats", icon: "export", title: "Gun stats · every gun", sub: "Fire rate, damage and shots to kill at your ranges, optionally simulated accuracy." },
  { id: "damage", icon: "target", title: "Damage by range", sub: "Where shots to kill change for the current setup, or damage every few studs." },
  { id: "results", icon: "bolt", title: "Simulation results", sub: "The current result next to your saved patterns." },
  { id: "imported", icon: "down", title: "Imported sheet", sub: "Open a CSV or Excel file exported before, to sort, copy or re-export it." },
];
const col = (name, type = "text", d = null) => ({ name, type, d });

const ex = {
  kind: "allBest",
  custom: {},           // count fields switched to "Custom…"
  table: null,          // what the buttons export right now
  jobs: {},             // running / finished every-gun jobs by kind
  o: {
    allBest: { classes: null, guns: null, metric: "accuracy", shotguns: "oneshot", oneshotChance: 80, lists: ["combined"], excl: null, locks: {}, perGun: 1, depth: "thorough", distance: 50, aim_point: "torso", stance: "stand", aiming: true, fire: "default", comp: 100, health: 100, fps: 60, drop: false },
    gunBest: { lists: ["combined"], top: 10, breakdown: true },
    allStats: { classes: null, distances: "0, 25, 50, 100, 200", health: 100, groups: ["basics", "firing", "damage", "ranges", "stk", "ballistics"], sim: false, distance: 50, aim_point: "torso", stance: "stand", aiming: true, fire: "default", comp: 100, runs: 300, fps: 60, drop: false },
    damage: { mode: "breaks", step: 5, max: 0, health: 100 },
    results: {},
    imported: {},
  },
  sort: null,           // {sig, col, dir}: the preview / export column sort
  imported: null,       // a sheet opened with "Import sheet"
  gunOpen: new Set(),   // classes expanded in the gun list
  gunFilter: "",
};

function initExport() {
  $("exKinds").innerHTML = EXPORT_KINDS.map((k) => `<button class="ex-kind" data-k="${k.id}">${icon(k.icon)}<div><b>${k.title}</b><span>${k.sub}</span></div></button>`).join("");
  $("exKinds").addEventListener("click", (e) => { const b = e.target.closest("[data-k]"); if (b) { ex.kind = b.dataset.k; renderExport(); } });
  $("exportOpen").addEventListener("click", openExport);
  $("exportClose").addEventListener("click", () => closeModal("exportModal"));
  $("exportFull").addEventListener("click", toggleExportFull);
  setExportFull(!!prefs.exportFull);
  $("exportModal").addEventListener("mousedown", (e) => { if (e.target === $("exportModal")) closeModal("exportModal"); });
  $("exCopy").addEventListener("click", copyTable);
  $("exXlsx").addEventListener("click", () => downloadTable("xlsx"));
  $("exCsv").addEventListener("click", () => downloadTable("csv"));
  $("exOptions").addEventListener("input", onExOption);
  $("exOptions").addEventListener("change", onExOption);
  $("exOptions").addEventListener("click", onExOptionClick);
  initDefaultsEditor();
}
function openExport() {
  // the scenario starts from the range the first time only: after that it keeps
  // what you set here ("Copy from range" takes the range's values again)
  if (!ex.seeded) {
    const s = settings();
    for (const k of ["allBest", "allStats"]) Object.assign(ex.o[k], { distance: s.distance, aim_point: s.aim_point, stance: s.stance, health: s.health, fps: s.fps });
    ex.o.damage.health = s.health;
    ex.seeded = true;
  }
  if (gunBestResult() && !ex.jobs.allBest) ex.kind = ex.kind === "allBest" ? "gunBest" : ex.kind;
  openModal("exportModal");
  renderExport();
}

/* ------------------------------------------------------------------ option widgets */
const classesOf = () => Object.keys(state.catalog.classes);
function optField(label, html, tip, wide) {
  return `<div class="field ${wide ? "wide" : ""}"><label>${label}${tip ? ` <span class="tip" data-tip="${esc(tip)}">?</span>` : ""}</label>${html}</div>`;
}
function optNumber(key, v, min, max, unit) {
  return unit ? `<span class="numbox"><input type="number" data-o="${key}" value="${v}" min="${min}" max="${max}"><i>${unit}</i></span>`
    : `<input type="number" data-o="${key}" value="${v}" min="${min}" max="${max}">`;
}
/* number with its unit inside the box, right-aligned (like range / fps) */
function optUnit(key, v, min, max, unit) {
  return `<span class="numbox unitbox"><input type="number" data-o="${key}" value="${v}" min="${min}" max="${max}"><i>${unit}</i></span>`;
}
function optSelect(key, v, options, hints) {
  return `<select data-o="${key}"${hints ? ` data-hints="${hints}"` : ""}>${options.map(([val, l]) => `<option value="${esc(val)}" ${String(val) === String(v) ? "selected" : ""}>${esc(l)}</option>`).join("")}</select>`;
}
function optCount(key, v, presets) {
  // a preset, "All" (0) or the user's own number
  const custom = ex.custom[key] || !presets.some(([p]) => p === v);
  return `<div class="countpick"><select data-ocount="${key}">${presets.map(([p, l]) => `<option value="${p}" ${!custom && p === v ? "selected" : ""}>${l}</option>`).join("")}<option value="custom" ${custom ? "selected" : ""}>Custom…</option></select>${custom ? `<input type="number" data-o="${key}" value="${v || 1}" min="1" max="2000">` : ""}</div>`;
}
function optChips(key, values, options) {
  const on = new Set(values || options.map((o) => o[0]));
  return `<div class="chips" data-chips="${key}">${options.map(([v, l]) => `<span class="chip ${on.has(v) ? "on" : ""}" data-v="${esc(v)}">${esc(l)}</span>`).join("")}</div>`;
}
function scenarioFields(o, withHealth = true) {
  const ap = [...$("aimPoint").options].map((x) => [x.value, x.text]);
  return `<div class="copyrow"><h2>Scenario</h2><button class="btn small" data-copyrange="1" title="Copy range, aim point, stance, sight, fire mode, recoil control, input, shots per mag, click rate, health and FPS from the Setup panel">Copy from range</button></div>`
    + optField("Range", `<span class="numbox fpsbox"><input type="number" data-o="distance" value="${o.distance}" min="1" max="2000" step="any" title="Type any range, or pick a common one with the arrow"><i>st</i>${presetButton(RANGE_PRESETS, "st", "Common ranges")}</span>`)
    + optField("Aim at", optSelect("aim_point", o.aim_point, ap))
    + optField("Stance", optSelect("stance", o.stance, [["stand", "Stand"], ["crouch", "Crouch"], ["prone", "Prone"]]))
    + optField("Sight", optSelect("aiming", o.aiming ? "1" : "0", [["1", "Aimed"], ["0", "Hip fire"]]))
    + optField("Fire mode", optSelect("fire", o.fire, [["default", "Gun's first mode"], ["auto", "Prefer auto"], ["semi", "Prefer semi"], ["burst", "Prefer burst"]]), "Every gun has different modes, so pick a preference; guns without that mode use their first one.")
    + optField("Recoil control", optNumber("comp", o.comp, 0, 100, "%"), "How well the shooter pulls against the average recoil. 100% leaves only random spread.")
    + optField("Input", optSelect("input", o.input || "kbm", [["kbm", "Mouse & keyboard"], ["pad", "Controller"]]), "Pure controller input: the game halves camera recoil (the view kick, which the gun and bullets follow). Gun recoil and spread are the same.")
    + optField("Click rate", `<span class="numbox"><input type="number" data-o="trigger" value="${o.trigger || ""}" min="30" max="3000" placeholder="Max"><i>rpm</i></span>`, "Trigger pulls per minute for semi / burst modes. Empty: the fastest clicking each gun allows.")
    + (withHealth ? optField("Shots per mag", `<span class="numbox"><input type="number" data-o="shots" value="${o.shots || ""}" min="1" max="500" placeholder="Full mag"></span>`, "Empty: every setup fires the bare gun's magazine (damage goals: each setup's own). A number: every setup fires that many.") : "")
    + (withHealth ? optField("Enemy health", optUnit("health", o.health, 1, 1000, "hp")) : "")
    + optField("Game FPS", `<span class="numbox fpsbox"><input type="number" data-o="fps" value="${o.fps}" min="1" max="1000" step="any" title="Type any frame rate, or pick a common one with the arrow"><i>fps</i>${presetButton(FPS_PRESETS, "fps", "Common frame rates")}</span>`)
    + optField("Bullet drop", `<label class="switch"><input type="checkbox" data-o="drop" ${o.drop ? "checked" : ""}><span></span><em>${o.drop ? "Counts" : "Held over"}</em></label>`, "Off (recommended): you aim for drop at this range, so drop never counts as recoil. On: bullets drop below where you aim.");
}
function copyRangeInto(o) {
  const s = settings();
  const mode = currentModeLabel();
  Object.assign(o, { distance: s.distance, aim_point: s.aim_point, stance: s.stance, aiming: s.aiming, comp: s.compensation, health: s.health, fps: s.fps,
    input: s.controller ? "pad" : "kbm", trigger: s.trigger_rpm || "",
    fire: mode === "AUTO" || mode === "SWITCH" ? "auto" : mode.startsWith("BURST") ? "burst" : "semi" });
}
function batchSettings(o) {
  return { distance: +o.distance || 50, aim_point: o.aim_point, stance: o.stance, aiming: !!o.aiming, compensation: +o.comp || 0, health: +o.health || 100, fps: +o.fps || 60, drop: !!o.drop, oneshot_chance: +o.oneshotChance || 80,
    controller: o.input === "pad", trigger_rpm: +o.trigger > 0 ? +o.trigger : null, shots: +o.shots > 0 ? Math.round(+o.shots) : null,
    ...(Object.keys(state.recoilEdits || {}).length ? { recoil_overrides: state.recoilEdits } : {}) };
}

function onExOption(e) {
  if (e.target.id === "exExSearch") { ex.exEdit.filter = e.target.value; renderExclChips(); return; }
  if (e.target.matches("[data-gpfilter]")) {
    if (e.type !== "input") return;
    ex.gunFilter = e.target.value;
    refreshGunMenu();
    return;
  }
  const cnt = e.target.closest("[data-ocount]");
  if (cnt) {
    if (e.type !== "change") return;
    const key = cnt.dataset.ocount, o = ex.o[ex.kind];
    ex.custom[key] = cnt.value === "custom";
    if (!ex.custom[key]) o[key] = +cnt.value; else o[key] = o[key] || 10;
    renderExport();
    return;
  }
  const el = e.target.closest("[data-o]");
  if (!el) return;
  const o = ex.o[ex.kind];
  const k = el.dataset.o;
  let v = el.type === "checkbox" ? el.checked : el.value;
  if (k === "aiming") v = v === "1";
  else if (el.type === "number") v = ["perGun", "top"].includes(k) ? Math.max(1, Math.round(+v || 1)) : +v;
  else if (["perGun", "top"].includes(k)) v = +v;
  if (k === "fps") v = clampFps(v);
  o[k] = v;
  saveExportOpts();
  if (k === "sim" || k === "mode" || k === "drop" || k === "metric" || k === "shotguns") renderExport();
  else if (e.type === "change") { renderExRun(); buildTable(); }
  else refreshExportSoon();
}
function onExOptionClick(e) {
  if (ex.kind === "allBest" && onGunPick(e)) return;
  const o2 = ex.o.allBest, E = ex.exEdit;
  if (e.target.closest("[data-copyrange]")) { copyRangeInto(ex.o[ex.kind]); renderExport(); toast("Scenario copied from the range."); return; }
  if (e.target.closest("[data-xact='defaults']")) { openDefaultsEditor(); return; }
  const tok = e.target.closest("[data-tok]");
  if (tok) { toggleExclusion(tok.dataset.tok); return; }
  const xl = e.target.closest("[data-xlock]");
  if (xl) {
    if (xl.dataset.xlock === "__search") delete o2.locks[E.slot]; else o2.locks[E.slot] = xl.dataset.xlock;
    renderExport();
    return;
  }
  const xe = e.target.closest("[data-xedit]");
  if (xe && !xe.disabled) {
    const same = E.slot === xe.dataset.slot && E.mode === xe.dataset.xedit;
    E.slot = same ? null : xe.dataset.slot; E.mode = xe.dataset.xedit; E.filter = "";
    renderExport();
    return;
  }
  const xa = e.target.closest("[data-xact]");
  if (xa) {
    const a = xa.dataset.xact;
    if (a === "done") E.slot = null;
    else if (a === "incl") { const drop = new Set(slotTokens(o2, E.slot)); o2.excl = exclTokens(o2).filter((t) => !drop.has(t)); }
    else if (a === "reset") {
      // first press: search everything; pressed again with nothing excluded: the defaults
      if (exportIsClear(o2)) { o2.excl = null; toast("Default exclusions are back."); }
      else { o2.excl = []; o2.locks = {}; toast("Every attachment is searched. Press again for the default exclusions."); }
      E.slot = null;
    }
    renderExport();
    return;
  }
  const chip = e.target.closest("[data-chips] .chip");
  if (chip) {
    const key = chip.parentElement.dataset.chips;
    const all = [...chip.parentElement.querySelectorAll(".chip")].map((c) => c.dataset.v);
    const o = ex.o[ex.kind];
    const cur = new Set(o[key] || all);
    cur.has(chip.dataset.v) ? cur.delete(chip.dataset.v) : cur.add(chip.dataset.v);
    o[key] = cur.size === all.length && key === "classes" ? null : all.filter((v) => cur.has(v));
    renderExport();
    return;
  }
  const b = e.target.closest("[data-all]");
  if (b) {
    const o = ex.o[ex.kind];
    o[b.dataset.all] = b.dataset.val === "none" ? [] : null;
    renderExport();
  }
}
const refreshExportSoon = debounce(() => buildTable(), 300);

/* ------------------------------------------------------------------ the five kinds */
/* the export options are part of the session save (offered again on the next start) */
const EXPORT_SAVED = ["allBest", "allStats", "damage", "gunBest"];
function saveExportOpts() {
  if (state.restoring) return;
  state.saved.exportOpts = JSON.parse(JSON.stringify(Object.fromEntries(EXPORT_SAVED.map((k) => [k, ex.o[k]]))));
  store();
}
function restoreExportOpts(saved) {
  if (!saved || typeof saved !== "object") return;
  for (const k of EXPORT_SAVED) if (saved[k] && typeof saved[k] === "object") Object.assign(ex.o[k], saved[k]);
  ex.seeded = true;
}
function renderExport() {
  saveExportOpts();
  document.querySelectorAll(".ex-kind").forEach((b) => b.classList.toggle("on", b.dataset.k === ex.kind));
  const o = ex.o[ex.kind];
  const classChips = (key) => optField("Classes", `<div>${optChips(key, o[key], classesOf().map((c) => [c, titleCase(c)]))}<div class="hint"><button class="link" data-all="${key}" data-val="all">All</button> · <button class="link" data-all="${key}" data-val="none">None</button></div></div>`, null, true);
  let html = "";
  if (ex.kind === "allBest") {
    // row 1: guns, lists · row 2: goal, one-shot guns, counts as a one-shot
    html = gunPickerField(o)
      + optField("Lists", optChips("lists", o.lists, [["spread", "Lowest spread"], ["climb", "Lowest climb"], ["combined", "Best overall"]]), "Which rankings to include. Fewer lists also search faster.").replace('class="field ', 'class="field span2 ')
      + `<div class="rowbreak"></div>`
      + optField("Goal", optSelect("metric", o.metric, [...Object.entries(state.catalog.metrics).map(([k, m]) => [k, m.label]), ["stk_auto", "First STK range (auto: limb or torso)"]], "goal"))
      + (!isStk(o.metric) ? optField("One-shot guns", optSelect("shotguns", o.shotguns || "oneshot", [["oneshot", "First STK range"], ["goal", "Use the goal to the left"]]), "Guns that can kill with one shot are ranked by their first STK range on the part they one-shot: the torso, or the limbs for a single-bullet gun whose limbs take more damage (pellet guns always the torso). Equal ranges go to better handling, then less recoil (setups that need more than one shot: less recoil first). The goal First STK range (auto) ranks every gun this way, one-shot or not.") : "")
      + ((isStk(o.metric) || (o.shotguns || "oneshot") === "oneshot") ? optField("Counts as a one-shot", optSelect("oneshotChance", o.oneshotChance || 80, [[50, "50% of shots"], [80, "80% of shots"], [95, "95% of shots"]]), "How reliably the first shot has to kill at a range for it to count.") : "")
      + exSlotsHtml(o)
      + optField("Setups per gun", optCount("perGun", o.perGun, [[1, "1"], [3, "3"], [5, "5"], [10, "10"], [0, "All"]]), "All lists every distinct setup the search finds for each gun (much slower).")
      + optField("Search depth", optSelect("depth", o.depth, [["quick", "Quick"], ["standard", "Standard"], ["thorough", "Thorough (slow)"]]), "Quick tests fewer combinations and mags per gun. Thorough is the same depth as the Best setup finder.")
      + optField("Tie-breakers", `<div class="tiebox-host" data-goal="${esc(o.metric + (!isStk(o.metric) && (o.shotguns || "oneshot") === "oneshot" ? "+os" : ""))}">${tiebreakHtml(o.metric + (!isStk(o.metric) && (o.shotguns || "oneshot") === "oneshot" ? "+os" : ""))}</div>`, "What decides between setups that are equal on the goal (for First STK goals: the same range). Default keeps the built-in order; Custom lets you pick and order your own. Shared with the Best setup finder.")
      + scenarioFields(o);
  } else if (ex.kind === "gunBest") {
    const r = gunBestResult();
    html = r ? `<p class="hint wide">Results for <b>${esc(r.gunName || r.weapon)}</b>${r.scenario ? ` · ${r.scenario.distance} st · ${r.scenario.aiming === false ? "hip fire" : "aimed"} · ${esc(r.metric_label)}` : ""}.</p>`
      + optField("Lists", optChips("lists", o.lists, [["spread", "Lowest spread"], ["climb", "Lowest climb"], ["combined", "Best overall"]]), null, true)
      + optField("Setups per list", optCount("top", o.top, [[1, "1"], [3, "3"], [5, "5"], [10, "10"], [0, "All"]]))
      + optField("Extra sheet", `<label class="switch"><input type="checkbox" data-o="breakdown" ${o.breakdown ? "checked" : ""}><span></span><em>Each attachment on its own (Excel only)</em></label>`, null, true)
      : `<div class="wide empty-state" style="padding:24px 0"><div><h4>No results for ${esc(state.weaponInfo.displayname)} yet</h4><p>Run the Best setup finder for this gun first.</p><p style="margin-top:12px"><button class="btn primary" id="exGoFinder">${icon("best")}Open Best setup</button></p></div></div>`;
  } else if (ex.kind === "allStats") {
    html = classChips("classes")
      + optField("Ranges", `<input data-o="distances" value="${esc(o.distances)}" placeholder="0, 50, 100">`, "Comma-separated distances in studs for the damage and shots-to-kill columns.")
      + optField("Enemy health", optUnit("health", o.health, 1, 1000, "hp"))
      + optField("Columns", optChips("groups", o.groups, [["basics", "Basics"], ["firing", "Fire rates"], ["damage", "Damage & multipliers"], ["ranges", "Damage at ranges"], ["stk", "Shots to kill at ranges"], ["ballistics", "Bullet speed & penetration"], ["handling", "Handling"]]), null, true)
      + optField("Simulate", `<label class="switch"><input type="checkbox" data-o="sim" ${o.sim ? "checked" : ""}><span></span><em>Add simulated accuracy: hit rate, climb, spread, TTK (runs every gun)</em></label>`, null, true)
      + (o.sim ? optField("Mags per gun", optNumber("runs", o.runs, 20, 5000)) + scenarioFields(o, false) : "");
  } else if (ex.kind === "damage") {
    html = optField("Rows", optSelect("mode", o.mode, [["breaks", "Shots-to-kill breakpoints"], ["step", "Every few studs"]]), "Breakpoints: one row per range band where head / torso / limb shots to kill stay the same. Every few studs: damage at regular steps.")
      + (o.mode === "step" ? optField("Every", optNumber("step", o.step, 0.5, 100, "st")) : "")
      + optField("Up to", optNumber("max", o.max || autoMax(), 5, 5000, "st"))
      + optField("Enemy health", optUnit("health", o.health, 1, 1000, "hp"))
      + `<p class="hint wide">For ${esc(setupLabel())}.</p>`;
  } else if (ex.kind === "imported") {
    html = `<div class="wide importrow"><button class="btn primary" id="exImport">${icon("down")}Import sheet…</button>
      <span class="hint">${ex.imported ? `Showing <b>${esc(ex.imported.name)}</b> · ${ex.imported.rows.length.toLocaleString()} rows. Click a column header to sort.` : "CSV, TSV or Excel (.xlsx) files exported from here (or any sheet with a header row)."}</span>
      <input type="file" id="exImportFile" accept=".csv,.tsv,.txt,.xlsx" hidden></div>`;
  } else {
    html = `<p class="hint wide">${state.lastDump ? "The current result" : "No current result"}${state.snapshots.length ? ` and ${state.snapshots.length} saved pattern${state.snapshots.length === 1 ? "" : "s"}` : ""}. Simulate and save patterns on the Pattern tab to add rows.</p>`;
  }
  $("exOptions").innerHTML = html;
  if (ex.kind === "allBest") renderExclChips();
  const go = $("exGoFinder");
  if (go) go.addEventListener("click", () => { closeModal("exportModal"); openFinder(); });
  const imp = $("exImport");
  if (imp) {
    imp.addEventListener("click", () => $("exImportFile").click());
    $("exImportFile").addEventListener("change", (e) => importSheet(e.target.files[0]));
  }
  renderExRun();
  buildTable();
}
function autoMax() {
  const g = (state.stats && state.stats.damageGraph) || [];
  return Math.ceil(((g.length ? g[g.length - 1].distance : 200) * 1.3) / 10) * 10;
}

/* best setups for your guns: a toggle list of guns (all by default), grouped by
   class in unlock-rank order like the game's menu */
function allGuns() { return Object.values(state.catalog.classes).flat(); }
function gunOn(o) { return o.guns ? new Set(o.guns) : new Set(allGuns().map((w) => w.name)); }
function gunMenuHtml(o) {
  const on = gunOn(o), f = norm(ex.gunFilter);
  let lastSlot = null;
  const rows = Object.entries(state.catalog.classes).map(([cls, list]) => {
    const k = list.filter((w) => on.has(w.name)).length;
    const shown = list.filter((w) => !f || norm(w.displayname).includes(f) || norm(w.name).includes(f));
    if (f && !shown.length) return "";
    const open = f || ex.gunOpen.has(cls);
    const head = slotOfClass(cls) !== lastSlot ? `<div class="gm-slot">${(lastSlot = slotOfClass(cls))}</div>` : "";
    return `${head}<div class="gm-class">
        <div class="gm-row" data-gpc="${esc(cls)}"><span class="ck ${k === list.length ? "on" : k ? "part" : ""}"></span><b>${esc(titleCase(cls))}</b><span class="sm">${k}/${list.length}</span>
          <button class="gm-x ${open ? "open" : ""}" data-gpx="${esc(cls)}" title="${open ? "Hide guns" : "Pick single guns"}">${icon("chev")}</button></div>
        ${open ? shown.map((w) => `<div class="gm-row gm-gun" data-gpg="${esc(w.name)}"><span class="ck ${on.has(w.name) ? "on" : ""}"></span>${esc(w.displayname)}<span class="sm">${rankLabel(w.rank, w.test)}</span></div>`).join("") : ""}</div>`;
  }).join("") || `<p class="hint" style="padding:8px">No guns match.</p>`;
  return `<div class="gm-head"><input data-gpfilter placeholder="Find a gun…" value="${esc(ex.gunFilter)}">
      <button class="link" data-gpa="all">All</button><button class="link" data-gpa="none">None</button></div>
    <div class="gm-list">${rows}</div>`;
}
function gunDDHtml(o) {
  const n = gunOn(o).size, total = allGuns().length;
  return `<div class="gundd" id="gunDD"><button class="gundd-btn ${ex.gunMenuOpen ? "open" : ""}" data-gpopen="1">
      <span>${n === total ? "All guns" : n ? `${n} of ${total} guns` : "No guns"}</span>${icon("chev")}</button>
      ${ex.gunMenuOpen ? `<div class="gunmenu">${gunMenuHtml(o)}</div>` : ""}</div>`;
}
function gunPickerField(o) {
  return optField("Guns", gunDDHtml(o),
    "Which guns to run the finder on (all by default). Tick a class to toggle all of it, or open it with the arrow to pick single guns.");
}
/* re-draw just the dropdown, keeping its scroll position and the search box focus */
function refreshGunMenu() {
  const dd = $("gunDD");
  if (!dd) return;
  const list = dd.querySelector(".gm-list"), top = list ? list.scrollTop : 0;
  const focused = document.activeElement && document.activeElement.matches("[data-gpfilter]");
  dd.outerHTML = gunDDHtml(ex.o.allBest);
  const nl = $("gunDD") && $("gunDD").querySelector(".gm-list");
  if (nl) nl.scrollTop = top;
  if (focused) { const i = $("gunDD").querySelector("[data-gpfilter]"); if (i) { i.focus(); i.setSelectionRange(i.value.length, i.value.length); } }
  renderExRun();
}
function setGuns(o, set) {
  o.guns = set.size === allGuns().length ? null : allGuns().map((w) => w.name).filter((n) => set.has(n));
  refreshGunMenu();
}
function onGunPick(e) {
  const o = ex.o.allBest;
  if (e.target.closest("[data-gpopen]")) { ex.gunMenuOpen = !ex.gunMenuOpen; refreshGunMenu(); return true; }
  const x = e.target.closest("[data-gpx]");
  if (x) { ex.gunOpen.has(x.dataset.gpx) ? ex.gunOpen.delete(x.dataset.gpx) : ex.gunOpen.add(x.dataset.gpx); refreshGunMenu(); return true; }
  const c = e.target.closest("[data-gpc]");
  if (c) {
    const list = state.catalog.classes[c.dataset.gpc] || [];
    const on = gunOn(o), all = list.every((w) => on.has(w.name));
    for (const w of list) all ? on.delete(w.name) : on.add(w.name);
    setGuns(o, on); return true;
  }
  const g = e.target.closest("[data-gpg]");
  if (g) { const on = gunOn(o); on.has(g.dataset.gpg) ? on.delete(g.dataset.gpg) : on.add(g.dataset.gpg); setGuns(o, on); return true; }
  const a = e.target.closest("[data-gpa]");
  if (a) { o.guns = a.dataset.gpa === "all" ? null : []; refreshGunMenu(); return true; }
  if (e.target.closest(".gunmenu")) return true;
  return false;
}
// clicking anywhere else closes the gun dropdown
document.addEventListener("mousedown", (e) => {
  if (ex.gunMenuOpen && !e.target.closest("#gunDD")) { ex.gunMenuOpen = false; refreshGunMenu(); }
});

/* opening a sheet exported before (CSV / TSV / xlsx) */
async function importSheet(file) {
  if (!file) return;
  try {
    const r = await fetch(`/api/import_sheet?name=${encodeURIComponent(file.name)}`, { method: "POST", body: await file.arrayBuffer() });
    const t = await r.json();
    if (!r.ok) throw new Error(t.error || r.statusText);
    ex.imported = t;
    ex.kind = "imported";
    storeResults();
    toast(`Imported ${t.rows.length.toLocaleString()} rows from ${file.name}.`, 3000);
  } catch (e) { toast(e.message, 4500); }
  renderExport();
}

/* every-gun best setups: slot locks and exclusions (shared default list with the finder) */
ex.exEdit = { slot: null, mode: "exclude", filter: "" };
let allAtts = null;
async function loadAllAtts() {
  if (allAtts) return allAtts;
  allAtts = await api("/api/attachments_all");
  return allAtts;
}
function exclTokens(o) { return o.excl || defaultTokenList(); }
/* toggle an attachment on every gun (its gun-only entries go either way: on
   every gun covers them, off clears the attachment entirely) */
function toggleEverywhere(set, t) {
  const a = allAtts && Object.values(allAtts).flat().find((x) => x.name === t);
  const ids = ((a && a.gun_ids) || []).map(([w]) => w);
  const covered = ids.length > 0 && ids.every((w) => set.has(`${w}::${t}`));
  const on = !(set.has(t) || covered);
  for (const x of [...set]) if (x.endsWith(`::${t}`)) set.delete(x);
  on ? set.add(t) : set.delete(t);
  return set;
}
function toggleExclusion(t) {
  const o = ex.o.allBest;
  const set = new Set(exclTokens(o));
  if (t.includes("::")) set.has(t) ? set.delete(t) : set.add(t); else toggleEverywhere(set, t);
  o.excl = [...set];
  renderExport();
}
function exportIsClear(o) { return !exclTokens(o).length && !Object.keys(o.locks).length; }
function slotTokens(o, slot) {
  // excluded tokens that belong to this slot ("GUN::name" tokens count too)
  const names = new Set((allAtts[slot] || []).map((a) => a.name));
  return exclTokens(o).filter((t) => names.has(t.includes("::") ? t.split("::")[1] : t));
}
function attName(slot, name) { const a = (allAtts[slot] || []).find((x) => x.name === name); return a ? a.displayname : name; }
function exSlotsHtml(o) {
  if (!allAtts) { loadAllAtts().then(() => { if (ex.kind === "allBest") renderExport(); }).catch(() => {}); return optField("Slots", `<span class="hint">Loading attachments…</span>`, null, true); }
  const E = ex.exEdit;
  const cards = SLOTS.map((slot) => {
    const locked = slot in o.locks;
    const exN = slotTokens(o, slot).length;
    const open = E.slot === slot ? E.mode : "";
    const status = locked ? `Locked: <b>${o.locks[slot] ? esc(attName(slot, o.locks[slot])) : "empty"}</b>` : `Searching${exN ? ` · <span class="exn">${exN} excluded</span>` : " everything"}`;
    return `<div class="oslot ${open ? "open" : ""} ${locked ? "kept" : ""}">
      <div class="oslot-top"><span class="nm">${slot}</span></div><div class="oslot-sub">${status}</div>
      <div class="oslot-btns">
        <button class="btn small ${open === "exclude" ? "on" : ""} ${exN ? "has" : ""}" data-xedit="exclude" data-slot="${slot}" ${locked ? "disabled" : ""}>${icon("x")}Exclude${exN ? ` (${exN})` : ""}</button>
        <button class="btn small ${open === "lock" ? "on" : ""} ${locked ? "lk" : ""}" data-xedit="lock" data-slot="${slot}">${icon("lock")}${locked ? "Locked" : "Lock"}</button></div></div>`;
  }).join("");
  const editor = E.slot ? `<div class="exeditor ${E.mode === "lock" ? "lockmode" : ""}"><div class="exhead">
      <h4>${E.mode === "lock" ? `Lock the ${E.slot.toLowerCase()} slot for every gun that can use it <span class="hint">· other guns search it as usual</span>` : `Exclude from every gun's ${E.slot.toLowerCase()} search <span class="hint">· click = every gun (red) · right-click = pick guns (orange)</span>`}</h4>
      <input id="exExSearch" placeholder="Filter…" value="${esc(E.filter)}">
      ${E.mode === "exclude" ? `<button class="btn small" data-xact="incl">Include all</button>` : ""}<button class="btn small primary" data-xact="done">Done</button></div>
      <div class="chips" id="exExChips"></div></div>` : "";
  return optField("Slots", `<div><div class="optslots">${cards}</div>${editor}
      <div class="exsum"><span class="hint">${exclTokens(o).length} attachment${exclTokens(o).length === 1 ? "" : "s"} excluded${o.excl ? "" : " (the default list)"}${Object.keys(o.locks).length ? ` · ${Object.keys(o.locks).length} slot${Object.keys(o.locks).length === 1 ? "" : "s"} locked` : ""}</span>
      <button class="link" data-xact="defaults">Edit default list</button><button class="link" data-xact="reset">${exportIsClear(o) ? "Restore default exclusions" : "Reset all"}</button></div></div>`,
    "Exclude leaves attachments out of every gun's search. Lock fixes a slot to one attachment (or empty) for every gun that can use it.", true);
}
function renderExclChips() {
  const box = $("exExChips");
  if (!box || !allAtts) return;
  const o = ex.o.allBest, { slot, mode } = ex.exEdit, f = norm(ex.exEdit.filter);
  const list = (allAtts[slot] || []).filter((a) => !f || norm(a.displayname).includes(f) || norm(a.only || "").includes(f));
  const meta = (a) => ` <span class="sm">${a.only ? esc(a.only) : `${a.guns} guns`}</span>`;
  if (mode === "lock") {
    const cur = slot in o.locks ? o.locks[slot] : null;
    box.innerHTML = `<span class="chip ${cur === null ? "on" : ""}" data-xlock="__search">Don't lock (search all)</span><span class="chip empty ${cur === "" ? "lk" : ""}" data-xlock="">Empty slot</span>`
      + list.slice(0, 400).map((a) => `<span class="chip ${cur === a.name ? "lk" : ""}" data-xlock="${esc(a.name)}" ${a.only ? "" : `title="${esc(gunListTip(a))}"`}>${esc(a.displayname)}${meta(a)}</span>`).join("");
    return;
  }
  box.innerHTML = exclChipsHtml(slot, list, exclTokens(o));
}

/* One chip per attachment. Click: exclude it on every gun. Right-click: a list of
   the guns that can use it, to exclude it on some of them only ("GUN::name"
   entries). A chip with gun-only exclusions shows which guns. */
function exclChipsHtml(slot, list, tokens) {
  const set = new Set(tokens);
  const gunOnly = (name) => tokens.filter((t) => t.endsWith(`::${name}`)).map((t) => t.slice(0, -name.length - 2));
  const rows = list.map((a) => {
    const ids = (a.gun_ids || []).map(([w]) => w);
    // gun-only entries that cover every gun it's on are the same as "every gun"
    const glob = set.has(a.name) || (ids.length > 0 && ids.every((w) => set.has(`${w}::${a.name}`)));
    const guns = glob ? [] : gunOnly(a.name);
    const disp = (w) => ((a.gun_ids || []).find(([id]) => id === w) || [w, w])[1];
    const only = guns.length ? ` <span class="xg">${guns.length === 1 ? esc(disp(guns[0])) : `${guns.length} guns`} only</span>` : "";
    const meta = ` <span class="sm">${a.only ? esc(a.only) : `${a.guns} guns`}</span>`;
    const tip = `${a.only ? `${a.only} only` : gunListTip(a)}${guns.length ? `\nExcluded on: ${guns.map(disp).join(", ")}` : ""}\nClick: exclude on every gun · Right-click: pick guns`;
    return { rank: glob ? 0 : guns.length ? 1 : 2, html: `<span class="chip ${glob ? "x" : guns.length ? "xpart" : ""}" data-tok="${esc(a.name)}" data-slot="${esc(slot)}" title="${esc(tip)}">${esc(a.displayname)}${meta}${only}</span>` };
  });
  rows.sort((x, y) => x.rank - y.rank);
  return rows.slice(0, 500).map((r) => r.html).join("") || `<span class="hint">Nothing matches.</span>`;
}

/* right-click menu: exclude an attachment on chosen guns */
const gunX = { box: null, slot: null, name: null, filter: "" };
function exclTarget(box) {
  // whose list a chip edits: the default list (editor dialog) or the export's own
  return box === "defChips"
    ? { get: () => defaultTokenList(), set: (t) => { prefs.defExcl = t; savePrefs(); renderDefaults(); afterDefaultsChanged(); } }
    : { get: () => exclTokens(ex.o.allBest), set: (t) => { ex.o.allBest.excl = t; renderExport(); } };
}
function closeGunX() { const m = document.querySelector(".gunxmenu"); if (m) m.remove(); gunX.name = null; }
function renderGunX() {
  const m = document.querySelector(".gunxmenu");
  if (!m) return;
  const a = (allAtts[gunX.slot] || []).find((x) => x.name === gunX.name);
  if (!a) { closeGunX(); return; }
  const t = exclTarget(gunX.box).get(), set = new Set(t), glob = set.has(a.name), f = norm(gunX.filter);
  const ids = (a.gun_ids || []).filter(([, d]) => !f || norm(d).includes(f));
  const n = (a.gun_ids || []).filter(([w]) => set.has(`${w}::${a.name}`)).length;
  m.querySelector(".gx-body").innerHTML = `<label class="gx-row gx-all"><input type="checkbox" data-gx="*" ${glob ? "checked" : ""}><b>Every gun</b><span class="sm">${a.guns}</span></label>
    ${ids.map(([w, d]) => `<label class="gx-row ${glob ? "dim" : ""}"><input type="checkbox" data-gx="${esc(w)}" ${glob || set.has(`${w}::${a.name}`) ? "checked" : ""} ${glob ? "disabled" : ""}>${esc(d)}</label>`).join("")}`;
  m.querySelector(".gx-count").textContent = glob ? "Excluded on every gun" : n ? `Excluded on ${n} gun${n === 1 ? "" : "s"}` : "Not excluded";
}
function openGunX(ev, chip) {
  closeGunX();
  const a = (allAtts[chip.dataset.slot] || []).find((x) => x.name === chip.dataset.tok);
  if (!a) return;
  Object.assign(gunX, { box: chip.closest("#defChips") ? "defChips" : "exExChips", slot: chip.dataset.slot, name: a.name, filter: "" });
  const m = document.createElement("div");
  m.className = "gunxmenu";
  m.innerHTML = `<div class="gx-head"><b>${esc(a.displayname)}</b><span class="hint">exclude on…</span></div>
    ${(a.gun_ids || []).length > 10 ? `<input class="gx-filter" placeholder="Find a gun…">` : ""}
    <div class="gx-body"></div><div class="gx-foot"><span class="hint gx-count"></span><button class="btn small" data-gxdone>Done</button></div>`;
  document.body.appendChild(m);
  renderGunX();
  const w = m.offsetWidth, h = m.offsetHeight;
  m.style.left = `${Math.max(8, Math.min(ev.clientX, innerWidth - w - 8))}px`;
  m.style.top = `${Math.max(8, Math.min(ev.clientY, innerHeight - h - 8))}px`;
  const fi = m.querySelector(".gx-filter");
  if (fi) { fi.addEventListener("input", () => { gunX.filter = fi.value; renderGunX(); }); fi.focus(); }
  m.addEventListener("change", (e) => {
    const c = e.target.closest("[data-gx]");
    if (!c) return;
    const tgt = exclTarget(gunX.box), set = new Set(tgt.get()), name = gunX.name;
    if (c.dataset.gx === "*") {
      // every gun: one entry for all of them (gun-only entries for it are dropped)
      for (const x of [...set]) if (x.endsWith(`::${name}`)) set.delete(x);
      c.checked ? set.add(name) : set.delete(name);
    } else {
      const k = `${c.dataset.gx}::${name}`;
      c.checked ? set.add(k) : set.delete(k);
      // every gun that has it ticked one by one (e.g. the only gun it's on) is
      // simply "excluded on every gun"
      const a = (allAtts[gunX.slot] || []).find((x) => x.name === name);
      const ids = (a && a.gun_ids || []).map(([w]) => w);
      if (ids.length && ids.every((w) => set.has(`${w}::${name}`))) {
        for (const w of ids) set.delete(`${w}::${name}`);
        set.add(name);
      }
    }
    tgt.set([...set]);
    renderGunX();
  });
  m.querySelector("[data-gxdone]").addEventListener("click", closeGunX);
}
document.addEventListener("contextmenu", (e) => {
  const chip = e.target.closest("#defChips [data-tok], #exExChips [data-tok]");
  if (!chip || !allAtts || ex.exEdit.mode === "lock" && chip.closest("#exExChips")) return;
  e.preventDefault();
  openGunX(e, chip);
});
document.addEventListener("mousedown", (e) => { if (!e.target.closest(".gunxmenu")) closeGunX(); }, true);
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && document.querySelector(".gunxmenu")) { closeGunX(); e.stopPropagation(); } }, true);

function gunListTip(a) { return a.gun_list ? `${a.guns} guns: ${a.gun_list.join(", ")}` : `${a.guns} guns`; }

/* ------------------------------------------------------------------ editing the default exclusion list */
const defEdit = { slot: "Barrel", filter: "" };
async function openDefaultsEditor() {
  closePopover();
  try { await loadAllAtts(); } catch (e) { toast(`Couldn't load attachments: ${e.message}`, 3500); return; }
  $("defSlots").innerHTML = SLOTS.map((sl) => `<button data-v="${sl}" class="${sl === defEdit.slot ? "on" : ""}">${sl}</button>`).join("");
  $("defSearch").value = defEdit.filter;
  openModal("defModal");
  renderDefaults();
}
function renderDefaults() {
  const tokens = defaultTokenList(), slot = defEdit.slot, f = norm(defEdit.filter);
  const list = (allAtts[slot] || []).filter((a) => !f || norm(a.displayname).includes(f) || norm(a.only || "").includes(f));
  $("defChips").innerHTML = exclChipsHtml(slot, list, tokens);
  const nGun = tokens.filter((t) => t.includes("::")).length, nAll = tokens.length - nGun;
  $("defCount").textContent = `${nAll} excluded on every gun · ${nGun} on single guns${prefs.defExcl ? " (your list)" : " (built-in list)"}`;
}
function afterDefaultsChanged() {
  // finder / export pick up the new defaults straight away
  if (!$("optModal").classList.contains("hidden")) { renderOptSlots(); renderSlotEditor(); }
  if (!$("exportModal").classList.contains("hidden")) renderExport();
}
function initDefaultsEditor() {
  $("defSlots").addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b) return; defEdit.slot = b.dataset.v; $("defSlots").querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b)); renderDefaults(); });
  $("defSearch").addEventListener("input", (e) => { defEdit.filter = e.target.value; renderDefaults(); });
  $("defChips").addEventListener("click", (e) => {
    const c = e.target.closest("[data-tok]"); if (!c) return;
    const set = toggleEverywhere(new Set(defaultTokenList()), c.dataset.tok);
    prefs.defExcl = [...set]; savePrefs(); renderDefaults(); afterDefaultsChanged();
  });
  $("defBuiltin").addEventListener("click", () => { prefs.defExcl = null; savePrefs(); renderDefaults(); afterDefaultsChanged(); toast("Built-in default list restored."); });
  $("defDone").addEventListener("click", () => closeModal("defModal"));
  $("defModal").addEventListener("mousedown", (e) => { if (e.target === $("defModal")) closeModal("defModal"); });
}

/* every-gun jobs: start / stop / progress */
function needsJob() { return ex.kind === "allBest" || (ex.kind === "allStats" && ex.o.allStats.sim); }
function jobKey() { return ex.kind === "allBest" ? "allBest" : "allStatsSim"; }
function gunsSelected(classes, guns) {
  if (guns) return guns.length;
  return Object.entries(state.catalog.classes).filter(([c]) => !classes || classes.includes(c)).reduce((n, [, l]) => n + l.length, 0);
}
function renderExRun() {
  const box = $("exRun");
  if (!needsJob()) { box.innerHTML = ""; return; }
  const j = ex.jobs[jobKey()];
  const o = ex.o[ex.kind];
  const n = gunsSelected(o.classes, ex.kind === "allBest" ? o.guns : null);
  const running = j && !j.done;
  const pctDone = j ? Math.round((j.progress || 0) * 100) : 0;
  let label = `${n} gun${n === 1 ? "" : "s"} selected`;
  if (j) {
    const eta = j.progress > 0.02 && !j.done ? Math.max(0, (j.elapsed / j.progress) * (1 - j.progress)) : null;
    label = j.done ? `${j.error === "cancelled" ? "Stopped" : j.error ? `Failed: ${esc(j.error)}` : "Finished"} · ${j.rows} rows · ${j.guns_done}/${j.guns_total} guns · ${Math.round(j.elapsed)}s`
      : `${pctDone}% · ${esc(j.stage || "")}${eta != null ? ` · about ${eta > 90 ? `${Math.round(eta / 60)} min` : `${Math.round(eta)} s`} left` : ""}`;
  }
  const can = n && !(ex.kind === "allBest" && !(o.lists || []).length);
  box.innerHTML = `${running ? `<button class="btn" id="exStop" ${j.stopping ? "disabled" : ""}>${icon("stop")}${j.stopping ? "Stopping…" : "Stop"}</button>` : `<button class="btn primary" id="exStart" ${can ? "" : "disabled"}>${icon("bolt")}${j ? "Run again" : "Start"}</button>`}
    <div class="progress ${j ? "show" : ""}"><div class="bar" style="width:${j ? pctDone : 0}%"></div><span class="label">${label}</span></div>`;
  if (!j) box.querySelector(".progress").classList.add("show");
  const st = $("exStart"), sp = $("exStop");
  if (st) st.addEventListener("click", startExportJob);
  if (sp) sp.addEventListener("click", () => {
    const jj = ex.jobs[jobKey()];
    if (!jj) return;
    jj.stopping = true;
    renderExRun();
    api("/api/optimize/cancel", { id: jj.id }).catch(() => {});
  });
}
async function startExportJob() {
  const key = jobKey(), kind = ex.kind;
  const o = ex.o[kind];
  const body = kind === "allBest"
    ? { kind: "best", classes: null, weapons: o.guns, metric: o.metric, shotguns: o.shotguns || "oneshot", lists: o.lists, per_gun: o.perGun, depth: o.depth, settings: batchSettings(o), firemode_pref: o.fire,
      exclude_tokens: exclTokens(o), locks: o.locks, tiebreak: tiebreakList() }
    : { kind: "stats", classes: o.classes, distances: parseDistances(o.distances), groups: o.groups, runs: o.runs, settings: batchSettings(o), firemode_pref: o.fire };
  try {
    const { id } = await api("/api/batch", body);
    ex.jobs[key] = { id, progress: 0, stage: "Starting", done: false, rows: 0, elapsed: 0, guns_done: 0, guns_total: gunsSelected(o.classes, kind === "allBest" ? o.guns : null) };
    renderExRun();
    pollExportJob(key);
  } catch (e) { toast(`Couldn't start: ${e.message}`, 4000); }
}
async function pollExportJob(key) {
  const j = ex.jobs[key];
  if (!j) return;
  let st;
  try { st = await api(`/api/job?id=${j.id}&table=1`); } catch (e) { setTimeout(() => pollExportJob(key), 2000); return; }
  Object.assign(j, st);
  if (!$("exportModal").classList.contains("hidden") && jobKey() === key && needsJob()) { renderExRun(); buildTable(); }
  if (!st.done) setTimeout(() => pollExportJob(key), 1500);
  else {
    storeResults();
    if (!st.error) toast(`Export table ready: ${st.rows} rows.`, 3000);
  }
}

function parseDistances(s) {
  const v = String(s).split(/[,;\s]+/).map(Number).filter((x) => Number.isFinite(x) && x >= 0);
  return [...new Set(v)].sort((a, b) => a - b).slice(0, 20);
}

/* ------------------------------------------------------------------ building the table */
let tableReq = 0;
async function buildTable() {
  const id = ++tableReq;
  let t = null;
  try {
    if (ex.kind === "allBest") t = (ex.jobs.allBest && ex.jobs.allBest.table) || null;
    else if (ex.kind === "gunBest") t = gunBestTable();
    else if (ex.kind === "allStats") {
      const o = ex.o.allStats;
      if (o.sim) t = (ex.jobs.allStatsSim && ex.jobs.allStatsSim.table) || null;
      else t = await api("/api/export/stats", { classes: o.classes, distances: parseDistances(o.distances), health: +o.health || 100, groups: o.groups });
    } else if (ex.kind === "damage") t = damageTable();
    else if (ex.kind === "imported") t = ex.imported;
    else t = resultsTable();
  } catch (e) { t = null; $("exCount").textContent = e.message; }
  if (id !== tableReq) return;
  ex.table = t;
  renderPreview();
}
/* full-screen toggle (top right, or F), remembered like the finder's */
function setExportFull(on) {
  $("exportModal").classList.toggle("full", on);
  $("exportFull").classList.toggle("on", on);
  $("exportFull").title = on ? "Exit full screen (F)" : "Full screen (F)";
}
function toggleExportFull() {
  prefs.exportFull = !$("exportModal").classList.contains("full");
  savePrefs();
  setExportFull(prefs.exportFull);
}
function gunBestResult() {
  return state.optResults[state.weapon] || state.optResults[state.lastOptWeapon] || null;
}
function rLabel(r, slot, name) { return ((r.labels || {})[slot] || {})[name] || attLabel(slot, name); }
function gunBestTable() {
  const r = gunBestResult();
  if (!r) return null;
  const o = ex.o.gunBest;
  const goal = GOAL_SHORT[r.metric] || r.metric;
  const m = metricScale(r.metric);
  const stk = isStk(r.metric);
  // first STK: the shots and range as text; vs #1 in shots when that differs, else studs
  const stkVs = (v, k) => {
    if (k !== "combined") return v || 0;
    const d = stkDiff(v || 0);
    return d.shots ? `${d.shots > 0 ? "+" : "−"}${Math.abs(d.shots)} shot${Math.abs(d.shots) === 1 ? "" : "s"}` : `${d.studs > 0 ? "+" : d.studs < 0 ? "−" : "±"}${Math.abs(d.studs).toFixed(1)} st`;
  };
  const lab = { spread: "Lowest spread", climb: "Lowest climb", combined: "Best overall" };
  const lists = ["spread", "climb", "combined"].filter((k) => (o.lists || []).includes(k) && r.lists[k]);
  // "List" only with several lists, "#" only with several setups per list
  const showList = lists.length > 1, showPos = o.top !== 1;
  const columns = [...(showList ? [col("List")] : []), ...(showPos ? [col("#", "int")] : []), ...SLOTS.map((s) => col(s)), col("Spread (st)", "num", 4), col("Climb (st)", "num", 4),
    ...(stk ? [col(goal), col(`± ${goal} (st)`, "num", 1), col("vs #1 in list")]
      : [col(`${goal}${m.unit ? ` (${m.unit === "%" ? "%" : m.unit})` : ""}`, "num", m.d), col(`± ${goal}`, "num", m.d), col("vs #1 in list", "num", 4)]),
    col("Handling vs bare gun", "pct", 1),
    col("Avg distance from aim (st)", "num", 3), col("Avg TTK (ms)", "num", 0), col(`On target (${+((r.scenario || {}).distance ?? 50)} st)`, "pct", 1), col("Headshots", "pct", 1), col("Kills / mag", "pct", 0)];
  const rows = [];
  for (const k of lists) {
    r.lists[k].slice(0, o.top || undefined).forEach((x, i) => {
      const s = x.summary || {};
      rows.push([...(showList ? [lab[k]] : []), ...(showPos ? [i + 1] : []), ...SLOTS.map((sl) => (x.attachments[sl] ? rLabel(r, sl, x.attachments[sl]) : "")), x.spread, x.climb,
        ...(stk ? [s.oneshot_band || stkText(x.score).replace(/<[^>]+>/g, " ").trim(), x.score_err, i === 0 ? "best" : stkVs(x.vs_best, k)]
          : [x.score * m.k, x.score_err * m.k, i === 0 ? 0 : (x.vs_best || 0) * (k === "combined" ? m.k : 1)]),
        x.handling ?? null, s.aim_error, s.ttk_mean != null ? s.ttk_mean * 1000 : null, s.hit_rate, s.head_rate, s.kill_rate]);
    });
  }
  const sheets = [];
  if (o.breakdown && r.slot_rankings) {
    const bc = [col("Slot"), col("Attachment"), col("Identical to"), stk ? col(`${goal} vs empty`) : col(`${goal} vs empty`, "num", m.d), col("Climb vs empty (st)", "num", 4), col("Spread vs empty (st)", "num", 4)];
    const br = [];
    for (const slot of SLOTS) for (const e of (r.slot_rankings[slot] || [])) {
      br.push([slot, e.attachment ? rLabel(r, slot, e.attachment) : "None", e.same.map((n) => (n ? rLabel(r, slot, n) : "None")).join(", "),
        e.delta != null ? (stk ? stkVs(e.delta, "combined") : e.delta * m.k) : null, e.climb_delta, e.spread_delta]);
    }
    sheets.push({ name: "Each attachment", columns: bc, rows: br });
  }
  return { name: `${r.gunName || state.weaponInfo.displayname} best setups`, columns, rows, extra: sheets };
}
function damageTable() {
  const st = state.stats;
  if (!st || !(st.damageGraph || []).length) return null;
  const o = ex.o.damage;
  const hp = +o.health || 100;
  const p = st.pelletcount || 1;
  const mult = { Head: st.multhead, Torso: st.multtorso, Limb: st.multlimb };
  const stk = (d) => (d > 0 ? Math.ceil(hp / d - 1e-9) : null);
  const name = `${state.weaponInfo.displayname} damage`;
  if (o.mode !== "step") {
    // one row per band where shots to kill stays the same, for each body part
    const max = Math.max(1, +o.max || autoMax());
    const res = 0.01;
    const columns = [col("Body part"), col("Shots to kill", "int"), col("From (st)", "num", 2), col("To (st)", "num", 2),
      col(`Damage at start${p > 1 ? " (all pellets)" : ""}`, "num", 2), col(`Damage at end${p > 1 ? " (all pellets)" : ""}`, "num", 2)];
    const rows = [];
    for (const [part, m] of Object.entries(mult)) {
      let from = 0, k = stk(dmgAt(st.damageGraph, 0) * p * m);
      for (let d = res; d <= max + 1e-9; d += res) {
        const kk = stk(dmgAt(st.damageGraph, d) * p * m);
        if (kk !== k) {
          rows.push([part, k, from, +d.toFixed(2), dmgAt(st.damageGraph, from) * p * m, dmgAt(st.damageGraph, d - res) * p * m]);
          from = +d.toFixed(2); k = kk;
        }
      }
      rows.push([part, k, from, "inf", dmgAt(st.damageGraph, from) * p * m, dmgAt(st.damageGraph, max) * p * m]);
    }
    return { name, columns, rows };
  }
  const step = Math.max(0.5, +o.step || 5), max = Math.max(step, +o.max || autoMax());
  const columns = [col("Range (st)", "num", 1), col(`Damage${p > 1 ? " / pellet" : ""}`, "num", 2), col("Head", "num", 2), col("Torso", "num", 2), col("Limb", "num", 2),
    col("STK head", "int"), col("STK torso", "int"), col("STK limb", "int")];
  const rows = [];
  for (let d = 0; d <= max + 1e-9; d += step) {
    const b = dmgAt(st.damageGraph, d);
    rows.push([+d.toFixed(2), b, b * st.multhead, b * st.multtorso, b * st.multlimb, stk(b * p * st.multhead), stk(b * p * st.multtorso), stk(b * p * st.multlimb)]);
  }
  return { name, columns, rows };
}
function resultsTable() {
  // the range each result was simulated at: in the header when they all share it
  const dists = [...(state.lastDump ? [state.lastDump.distance] : []), ...state.snapshots.map((sn) => sn.distance)];
  const one = dists.length && dists.every((d) => d != null && d === dists[0]);
  const columns = [col("Pattern"), ...(one ? [] : [col("Range (st)", "num", 1)]), col("Avg distance from aim (st)", "num", 3), col(one ? `On target (${+dists[0]} st)` : "On target", "pct", 1), col("Headshots", "pct", 1), col("Torso", "pct", 1), col("Limbs", "pct", 1),
    col("Kills / mag", "pct", 0), col("Avg TTK (ms)", "num", 0), col("Shots to kill", "num", 2), col("Damage / mag", "num", 0), col("Climb (st)", "num", 3), col("Spread (st)", "num", 3)];
  const row = (name, s, d) => [name, ...(one ? [] : [d ?? null]), s.aim_error, s.hit_rate, s.head_rate, s.torso_rate, s.limb_rate, s.kill_rate, s.ttk_mean != null ? s.ttk_mean * 1000 : null, s.stk_mean, s.avg_mag_damage, s.final_climb, s.random_radius];
  const rows = [];
  if (state.lastDump) rows.push(row(`Now: ${state.lastDump.label || currentLabel()}`, state.lastDump.summary, state.lastDump.distance));
  state.snapshots.forEach((sn, i) => rows.push(row(`#${i + 1}: ${sn.name}`, sn.summary, sn.distance)));
  return rows.length ? { name: "Simulation results", columns, rows } : null;
}

/* ------------------------------------------------------------------ preview + output */
/* a value the row doesn't have (not that kind of gun, no result...) reads "N/A";
   an empty attachment slot ("") stays blank */
const NA = "N/A";
function cellText(c, v, forSheet) {
  if (v === null || v === undefined || (typeof v === "number" && !Number.isFinite(v))) return NA;
  if (c.type === "pct" && typeof v === "number") return `${(v * 100).toFixed(c.d ?? 1)}%`;
  if (typeof v === "number" && c.d != null) return v.toFixed(c.d);
  const s = String(v);
  return forSheet ? s.replace(/[\t\r\n]+/g, " ") : s;
}
/* click a column header to sort (again to reverse, a third time to undo); the
   copied / saved sheet keeps the order you see */
function tableSig(t) { return t ? `${t.name}|${t.columns.map((c) => c.name).join("|")}` : ""; }
function sortValue(v) {
  if (v === null || v === undefined || v === "" || v === NA) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const n = Number(String(v).replace(/[%,\s]/g, ""));
  return Number.isFinite(n) && /\d/.test(String(v)) ? n : String(v);
}
function viewTable(t) {
  const so = ex.sort;
  if (!t || !so || so.sig !== tableSig(t)) return t;
  const k = so.col, dir = so.dir;
  const rows = t.rows.map((r, i) => [r, i]).sort((a, b) => {
    const x = sortValue(a[0][k]), y = sortValue(b[0][k]);
    if (x === null || y === null) return (x === null) - (y === null) || a[1] - b[1]; // blanks last
    const c = typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true, sensitivity: "base" });
    return c * dir || a[1] - b[1];
  }).map((x) => x[0]);
  return { ...t, rows };
}
function sortBy(k) {
  const sig = tableSig(ex.table);
  const so = ex.sort && ex.sort.sig === sig && ex.sort.col === k ? ex.sort : null;
  ex.sort = !so ? { sig, col: k, dir: 1 } : so.dir === 1 ? { sig, col: k, dir: -1 } : null;
  renderPreview();
}
function renderPreview() {
  const t = viewTable(ex.table);
  const has = !!(t && t.rows && t.rows.length);
  for (const id of ["exCopy", "exXlsx", "exCsv"]) $(id).disabled = !has;
  if (!t || !t.rows.length) {
    const msg = needsJob() ? (ex.jobs[jobKey()] ? "Rows appear here as guns finish." : "Press Start to build this table.") : ex.kind === "gunBest" ? "" : ex.kind === "imported" ? "Import a sheet to see it here." : "Nothing to export yet.";
    $("exPreview").innerHTML = msg ? `<div class="empty-state"><div><p>${msg}</p></div></div>` : "";
    $("exCount").textContent = "";
    return;
  }
  const max = 300;
  const so = ex.sort && ex.sort.sig === tableSig(ex.table) ? ex.sort : null;
  const head = `<tr><th class="rn"></th>${t.columns.map((c, k) => `<th class="sortable ${so && so.col === k ? (so.dir > 0 ? "asc" : "desc") : ""}" data-sort="${k}" title="Sort by ${esc(c.name)}">${esc(c.name)}</th>`).join("")}</tr>`;
  const body = t.rows.slice(0, max).map((r, i) => `<tr><td class="rn">${i + 1}</td>${t.columns.map((c, k) => `<td class="${c.type === "text" ? "" : "n"}">${esc(cellText(c, r[k]))}</td>`).join("")}</tr>`).join("");
  $("exPreview").innerHTML = `<table class="grid"><thead>${head}</thead><tbody>${body}</tbody></table>`;
  $("exPreview").querySelectorAll("[data-sort]").forEach((th) => th.addEventListener("click", () => sortBy(+th.dataset.sort)));
  $("exCount").textContent = `${t.rows.length.toLocaleString()} rows × ${t.columns.length} columns${t.rows.length > max ? ` · showing the first ${max}` : ""}`;
}
function tableTSV(t) {
  return [t.columns.map((c) => c.name).join("\t"), ...t.rows.map((r) => t.columns.map((c, k) => cellText(c, r[k], true)).join("\t"))].join("\n");
}
async function copyTable() {
  const t = viewTable(ex.table);
  if (!t) return;
  const text = tableTSV(t);
  try { await navigator.clipboard.writeText(text); }
  catch (e) {
    const ta = document.createElement("textarea");
    ta.value = text; document.body.appendChild(ta); ta.select();
    try { document.execCommand("copy"); } finally { ta.remove(); }
  }
  toast(`Copied ${t.rows.length.toLocaleString()} rows — click cell A1 in Google Sheets and paste.`, 3500);
}
function fileName(t) {
  const d = new Date();
  const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return `RecoilSim ${t.name} ${stamp}`;
}
async function downloadTable(format) {
  const t = viewTable(ex.table);
  if (!t) return;
  const na = (rows) => rows.map((r) => r.map((v) => (v === null || v === undefined || (typeof v === "number" && !Number.isFinite(v)) ? NA : v)));
  const sheets = [{ name: t.name, columns: t.columns, rows: na(t.rows) }, ...(format === "xlsx" ? (t.extra || []).map((x) => ({ ...x, rows: na(x.rows) })) : [])];
  try {
    const r = await fetch("/api/export/file", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ format, name: fileName(t), sheets }) });
    if (!r.ok) throw new Error(r.statusText);
    const blob = await r.blob();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${fileName(t)}.${format}`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    toast(format === "xlsx" ? "Excel file saved — in Google Sheets use File → Import to open it." : "CSV saved.", 3500);
  } catch (e) { toast(`Couldn't save the file: ${e.message}`, 4000); }
}
