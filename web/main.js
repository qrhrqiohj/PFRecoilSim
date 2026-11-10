/* RecoilSim front-end — start-up, saving / restoring the session, and wiring
   every control to what it does. */
"use strict";

let setAimSeg, setStanceSeg, setViewSeg, setPatViewSeg, setInputSeg;

/* ------------------------------------------------------------------ what gets saved */
function uiState() {
  // everything about the page worth bringing back with "Load previous session"
  const tab = document.querySelector("#rightTabs [data-tab].on");
  return {
    dumps: +$("dumps").value || 500, autoRun: $("autoRun").checked, sound: state.sound, speed: $("speed").value,
    patternView: state.patternView, patternFit: state.patternFit, patternZoom: state.patternZoom,
    rightTab: tab ? tab.dataset.tab : "pattern", moreResults: !!state.showMoreResults,
    leftHidden: $("leftPanel").classList.contains("hidden"), rightHidden: $("rightPanel").classList.contains("hidden"),
    orbit: state.orbit, mouseAim: !!state.mouseAim, mouseSens: state.mouseSens || 1, ...finderUiState(),
  };
}
function applyUi(u) {
  if (!u) return;
  if (u.dumps) { $("dumps").value = u.dumps; clampDumps(); }
  if (u.autoRun != null) $("autoRun").checked = u.autoRun;
  if (u.sound != null) setSound(u.sound);
  if (u.speed) $("speed").value = u.speed;
  if (u.patternView) { state.patternView = u.patternView; setPatViewSeg(u.patternView); }
  if (u.patternFit) setFit(u.patternFit);
  if (u.rightTab) showTab(u.rightTab);
  if (u.moreResults != null) state.showMoreResults = u.moreResults;
  if (u.leftHidden) collapse("leftPanel", true);
  if (u.rightHidden) collapse("rightPanel", true);
  if (u.orbit) state.orbit = { ...state.orbit, ...u.orbit };
  if (u.mouseAim != null) setMouseAim(u.mouseAim);
  if (u.mouseSens) { state.mouseSens = u.mouseSens; setRange("mouseSens", u.mouseSens); $("mouseSensVal").textContent = `${(+u.mouseSens).toFixed(2)}×`; }
  if (u.patternZoom) setZoom(u.patternZoom);
  applyFinderUi(u);
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
const saveSoon = debounce(() => saveSettings(), 400);

function saveIsDefault(prev) {
  // nothing worth offering: same as what a fresh start looks like
  if ((prev.snapshots || []).length) return false;
  if (Object.values(prev.excludes || {}).some((slots) => Object.values(slots || {}).some((l) => (l || []).length))) return false;
  if (Object.values(prev.attachments || {}).some((a) => Object.values(a || {}).some(Boolean))) return false;
  if (prev.weapon && prev.weapon !== state.weapon) return false;
  if (prev.view && prev.view !== state.view) return false;
  if (prev.settings && stableJSON(prev.settings) !== stableJSON(settings())) return false;
  if (prev.ui && stableJSON(prev.ui) !== stableJSON(uiState())) return false;
  if (prev.recoilEdits && Object.keys(prev.recoilEdits).length) return false;
  if (prev.exportOpts && stableJSON(prev.exportOpts) !== stableJSON(Object.fromEntries(EXPORT_SAVED.map((k) => [k, ex.o[k]])))) return false;
  if (sessionPrefsChanged()) return false;
  return true;
}
/* preferences that belong to the work, not to the Settings panel: Start fresh resets them */
const SESSION_PREFS = ["tiebreak", "defExcl", "exportFull", "finderFull"];
function sessionPrefsChanged() {
  return (tbPrefs().custom) || prefs.defExcl != null || !!prefs.exportFull || !!prefs.finderFull;
}
function resetSessionPrefs() {
  for (const k of SESSION_PREFS) delete prefs[k];
  prefs.defExcl = null;
  savePrefs();
  renderTieboxes();
  if (typeof setExportFull === "function") setExportFull(false);
  if (typeof setFinderFull === "function") setFinderFull(false);
  if (typeof renderDefaults === "function" && $("exportModal") && !$("exportModal").classList.contains("hidden")) renderDefaults();
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
  const w = prev.weapon ? findWeapon(prev.weapon) : null;
  const atts = w && prev.attachments && prev.attachments[prev.weapon] ? Object.values(prev.attachments[prev.weapon]).filter(Boolean).length : 0;
  const snaps = (prev.snapshots || []).length;
  const bits = [];
  if (prev.settings) bits.push(`${prev.settings.distance} st`, prev.settings.aiming === false ? "hip fire" : "aimed");
  if (snaps) bits.push(`${snaps} saved pattern${snaps === 1 ? "" : "s"}`);
  $("loadInfo").innerHTML = `Last time you had ${w ? `the <b>${esc(w.displayname)}</b>${atts ? ` with ${atts} attachment${atts === 1 ? "" : "s"}` : ""}` : "your own settings"}${bits.length ? ` (${bits.join(", ")})` : ""}. Starting fresh replaces that save once you change something, and resets the tie-breakers, your default exclusion list and edited recoil (the Settings panel — field of view, sound, graphics — stays).`;
  openModal("loadModal");
  const close = () => { closeModal("loadModal"); state.awaitingLoadChoice = false; };
  $("loadNo").onclick = () => { close(); state.prevSave = null; clearResults(); resetSessionPrefs(); store(); };
  $("loadYes").onclick = async () => {
    // work from a copy: restoring settings saves as it goes, and that must not
    // overwrite the values still to be restored (it used to reset the gun)
    const save = JSON.parse(JSON.stringify(prev));
    const name = save.weapon && findWeapon(save.weapon) ? save.weapon : state.weapon;
    state.saved = JSON.parse(JSON.stringify(prev));
    state.snapshots = Array.isArray(save.snapshots) ? save.snapshots : [];
    state.excludes = save.excludes || {};
    state.recoilEdits = save.recoilEdits && typeof save.recoilEdits === "object" ? save.recoilEdits : {};
    close();
    state.restoring = true;
    if (save.settings) applySavedSettings(save.settings);
    if (save.view) setView(save.view);
    restoreExportOpts(save.exportOpts);
    // results: the finder's lists, every-gun export tables, an imported sheet
    const res = loadResults();
    if (res) {
      Object.assign(state.optResults, res.optResults || {});
      if (res.lastOptWeapon) state.lastOptWeapon = res.lastOptWeapon;
      for (const [k, j] of Object.entries(res.jobs || {})) ex.jobs[k] = j;
      if (res.imported) ex.imported = res.imported;
    }
    applyUi(save.ui);
    renderSnapList();
    await selectWeapon(name, (save.attachments || {})[name] || {});
    if (save.settings) applySavedSettings(save.settings); // fire mode / click rate need the gun loaded
    state.restoring = false;
    saveSettings();
    onLoadoutChanged();
    drawPattern(); renderCompare(); renderResults(state.lastDump && state.lastDump.summary);
    if (save.dump) runDumps();  // the simulation result that was on screen
  };
}

/* ------------------------------------------------------------------ reacting to changes */
const autoRun = debounce(() => { if ($("autoRun").checked) runDumps(); }, 350);
function onLoadoutChanged() {
  if (state.session && !state.session.holding) state.session = null;
  saveSettings();
  refreshStats();
  loadScene();
  drawPattern();
  autoRun();
}
function setAim(aim) { state.aiming = aim; setAimSeg(aim ? "aim" : "hip"); onLoadoutChanged(); }
const DUMPS_MAX = 100000;
// snaps the magazine count into range so the box always shows what will actually run:
// above the cap -> 100000, zero/negative -> 1, decimals -> nearest whole number
function clampDumps() {
  const el = $("dumps");
  const raw = String(el.value).trim();
  let n = raw === "" ? NaN : Number(raw);
  if (!Number.isFinite(n)) n = +el.dataset.last || 500;
  n = Math.min(DUMPS_MAX, Math.max(1, Math.round(n)));
  el.value = n;
  el.dataset.last = n;
  return n;
}
function setMouseAim(on) {
  state.mouseAim = on;
  $("mouseAim").checked = on;
  $("mouseSensRow").classList.toggle("hidden", !on);
  if (!on) resetUserAim();
}
function setView(v) { state.view = v; setViewSeg(v); saveSettings(); }
function setSound(on) {
  state.sound = on;
  const b = $("soundBtn");
  b.classList.toggle("on", on);
  b.querySelector("use").setAttribute("href", on ? "#i-vol" : "#i-mute");
  b.title = on ? "Sound on" : "Sound off";
}
function showTab(tab) {
  document.querySelectorAll("#rightTabs [data-tab]").forEach((x) => x.classList.toggle("on", x.dataset.tab === tab));
  document.querySelectorAll("#rightPanel .pane").forEach((p) => p.classList.toggle("on", p.dataset.pane === tab));
  setTimeout(() => (tab === "stats" ? drawDamageGraph() : (drawPattern(), drawPerShot())), 10);
  if (tab === "recoil") renderRecoilTab();
}

/* ------------------------------------------------------------------ preferences */
function applyPrefsToControls() {
  setRange("pFov", prefs.fov); $("pFovVal").textContent = `${prefs.fov}°`;
  setRange("pGhost", prefs.ghost); $("pGhostVal").textContent = `${prefs.ghost}%`;
  setRange("pVol", prefs.vol); $("pVolVal").textContent = `${prefs.vol}%`;
  $("pTracers").checked = prefs.tracers; $("pMarkers").checked = prefs.markers; $("pNumbers").checked = prefs.numbers;
  $("pHeat").value = prefs.heat;
  $("pGlass").checked = prefs.glass;
  document.body.classList.toggle("solid", !prefs.glass);
}
function wirePrefs() {
  const set = (k, v) => { prefs[k] = v; savePrefs(); applyPrefsToControls(); drawPattern(); };
  $("pFov").addEventListener("input", (e) => { prefs.fovSet = true; set("fov", +e.target.value); });
  $("pGhost").addEventListener("input", (e) => set("ghost", +e.target.value));
  $("pVol").addEventListener("input", (e) => set("vol", +e.target.value));
  $("pTracers").addEventListener("change", (e) => set("tracers", e.target.checked));
  $("pMarkers").addEventListener("change", (e) => set("markers", e.target.checked));
  $("pNumbers").addEventListener("change", (e) => set("numbers", e.target.checked));
  $("pHeat").addEventListener("change", (e) => set("heat", e.target.value));
  $("pGlass").addEventListener("change", (e) => set("glass", e.target.checked));
  $("prefsReset").addEventListener("click", () => { prefs = { ...PREF_DEFAULTS, defExcl: prefs.defExcl }; savePrefs(); applyPrefsToControls(); drawPattern(); });
  $("prefsOpen").addEventListener("click", () => (openPop && openPop.id === "prefsPop" ? closePopover() : showPopover("prefsPop", $("prefsOpen"), "below-right")));
  $("helpOpen").addEventListener("click", () => (openPop && openPop.id === "helpPop" ? closePopover() : showPopover("helpPop", $("helpOpen"), "below-right")));
  applyPrefsToControls();
}

/* ------------------------------------------------------------------ start-up */
/* RecoilSim was updated while it was running: the page is new but the server
   still runs the old code until it's restarted (a server from before this
   check has no /api/stale at all, which says the same). */
let staleShown = false;
async function checkStale() {
  if (staleShown) return;
  try {
    const r = await fetch("/api/stale", { cache: "no-store" });
    const stale = r.status === 404 || (r.ok && (await r.json()).stale);
    if (stale) { staleShown = true; showError("RecoilSim was updated while it was running — close it and start it again to load the new version (until then some features won't work)."); }
  } catch (e) { /* server not reachable: other errors will say so */ }
}
async function init() {
  loadPrefs();
  loadStore();
  try { R = new RangeRenderer($("gl")); } catch (e) { showError(`3D view unavailable: ${e.message}`); }
  // if the graphics driver resets, rebuild the 3D view instead of freezing on the last frame
  $("gl").addEventListener("webglcontextlost", (e) => { e.preventDefault(); if (R) R.lost = true; showError("The graphics driver reset the 3D view — restoring it…"); });
  $("gl").addEventListener("webglcontextrestored", () => {
    try { R = new RangeRenderer($("gl")); buildTargetGeometry(); state.mountEye = null; state.lastSig = null; loadScene(); hideError(); } catch (e) { showError(`3D view lost: ${e.message}`); }
  });
  window.addEventListener("error", (e) => showError(`Error: ${e.message}`));
  window.addEventListener("unhandledrejection", (e) => showError(`Error: ${(e.reason && e.reason.message) || e.reason}`));
  bootMsg("Loading guns and attachments…");
  checkStale();
  window.addEventListener("focus", checkStale);
  const cat = await api("/api/catalog");
  state.catalog = cat;
  mergeNewDefaultExcludes();
  state.hitboxes = cat.hitboxes;
  state.aimPoints = cat.aim_points;
  const n = Object.values(cat.classes).reduce((a, l) => a + l.length, 0);
  $("weaponSearch").placeholder = `Search ${n} guns…`;
  const apLabels = { head: "Head", neck: "Neck", chest: "Upper chest", torso: "Torso centre", stomach: "Stomach", legs: "Legs" };
  for (const k of Object.keys(cat.aim_points)) $("aimPoint").add(new Option(apLabels[k] || k, k));
  $("aimPoint").value = "torso";
  initFinder();
  initExport();
  wireRecoilTab();
  wirePrefs();
  if (innerWidth < 760) collapse("rightPanel", true);
  const first = findWeapon("AK47") ? "AK47" : allWeapons()[0].name;
  buildTargetGeometry();
  wireEvents();
  document.querySelectorAll('input[type="range"]').forEach(paintRange);
  bootMsg("Loading the gun model…");
  if (!R) bootDone();  // no 3D view: nothing to wait for
  setTimeout(bootDone, 20000);  // never keep the screen up forever
  await selectWeapon(first, {});
  bootMsg("Building the 3D range…");
  renderSnapList();
  renderResults(null);
  layoutDock();
  requestAnimationFrame(frame);
  await bootReady;
  offerPreviousSave();
  warmupRtt();
}

function wireEvents() {
  setAimSeg = seg("aimSeg", (v) => setAim(v === "aim"));
  setStanceSeg = seg("stanceSeg", (v) => { state.stance = v; onLoadoutChanged(); });
  setInputSeg = seg("inputSeg", (v) => { state.controller = v === "pad"; onLoadoutChanged(); });
  setViewSeg = seg("viewSeg", (v) => setView(v));
  setPatViewSeg = seg("patViewSeg", (v) => { state.patternView = v; drawPattern(); saveSettings(); });

  // gun + attachments
  $("weaponChip").addEventListener("click", () => openWeaponPicker());
  $("weaponSearch").addEventListener("input", renderWeaponList);
  $("weaponCats").addEventListener("click", (e) => { const b = e.target.closest("[data-c]"); if (!b) return; pickerClass = b.dataset.c; renderWeaponCats(); renderWeaponList(); $("weaponSearch").focus(); });
  $("weaponList").addEventListener("click", (e) => { const b = e.target.closest(".pk-item"); if (b) pickWeapon(b.dataset.v); });
  listNav($("weaponSearch"), $("weaponList"), pickWeapon);
  $("attachmentSlots").addEventListener("click", (e) => { const b = e.target.closest(".slot"); if (b && !b.disabled) openAttPicker(b.dataset.slot, b); });
  $("attSearch").addEventListener("input", renderAttList);
  $("attList").addEventListener("click", (e) => { const b = e.target.closest(".pk-item"); if (b) setAttachment(attSlot, b.dataset.v); });
  listNav($("attSearch"), $("attList"), (v) => setAttachment(attSlot, v));
  $("resetAtts").addEventListener("click", resetAttachments);

  // target + shooting
  for (const id of ["fps", "oFps"]) $(id).addEventListener("change", (e) => { e.target.value = clampFps(e.target.value); });
  for (const id of ["shots", "triggerRpm", "aimPoint", "gravity", "fps", "health"]) $(id).addEventListener("change", onLoadoutChanged);
  $("firemode").addEventListener("change", () => { renderFiremodeSeg(); onLoadoutChanged(); });
  $("firemodeSeg").addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b || b.disabled || b.dataset.v === $("firemode").value) return;
    $("firemode").value = b.dataset.v;
    renderFiremodeSeg();
    onLoadoutChanged();
  });
  $("comp").addEventListener("input", () => { paintRange($("comp")); $("compVal").textContent = `${$("comp").value}%`; });
  $("comp").addEventListener("change", onLoadoutChanged);
  $("distance").addEventListener("input", () => { paintRange($("distance")); $("distanceNum").value = $("distance").value; });
  $("distance").addEventListener("change", onLoadoutChanged);
  $("distanceNum").addEventListener("change", () => { setRange("distance", Math.min(600, +$("distanceNum").value)); onLoadoutChanged(); });
  $("mouseAim").addEventListener("change", (e) => { setMouseAim(e.target.checked); saveSettings(); });
  $("mouseSens").addEventListener("input", (e) => { state.mouseSens = +e.target.value; paintRange(e.target); $("mouseSensVal").textContent = `${state.mouseSens.toFixed(2)}×`; });
  $("mouseSens").addEventListener("change", () => saveSettings());

  // analysis panel
  $("rightTabs").addEventListener("click", (e) => { const b = e.target.closest("[data-tab]"); if (b) { showTab(b.dataset.tab); if (!state.restoring) saveSettings(); } });
  $("dumpBtn").addEventListener("click", runDumps);
  $("dumpClear").addEventListener("click", clearDumps);
  $("moreResults").addEventListener("click", () => { state.showMoreResults = !state.showMoreResults; renderResults(state.lastDump && state.lastDump.summary); saveSettings(); });
  $("zoomIn").addEventListener("click", () => setZoom(state.patternZoom * 1.25));
  $("zoomOut").addEventListener("click", () => setZoom(state.patternZoom / 1.25));
  $("zoomVal").addEventListener("click", () => setZoom(1));
  $("fitBtn").addEventListener("click", () => { setFit(state.patternFit === "all" ? "target" : "all"); saveSettings(); });
  $("patternCanvas").addEventListener("wheel", (e) => { e.preventDefault(); setZoom(state.patternZoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15)); }, { passive: false });
  $("snapBtn").addEventListener("click", saveSnapshot);
  $("snapList").addEventListener("click", onSnapClick);
  $("dumps").addEventListener("change", clampDumps);
  for (const id of ["dumps", "speed", "autoRun"]) $(id).addEventListener("change", () => saveSettings());
  clampDumps();
  $("speed").addEventListener("change", () => { setPlaybackSpeed(+$("speed").value); $("speed").blur(); });
  wireDamageGraph();

  // dock
  $("fireBtn").addEventListener("click", fireMag);
  $("clearBtn").addEventListener("click", clearHoles);
  $("reloadBtn").addEventListener("click", reloadMag);
  $("soundBtn").addEventListener("click", () => { setSound(!state.sound); saveSettings(); });
  $("errBanner").querySelector("button").addEventListener("click", hideError);
  document.querySelectorAll("[data-collapse]").forEach((b) => b.addEventListener("click", () => collapse(b.dataset.collapse, true)));
  document.querySelectorAll("[data-reopen]").forEach((b) => b.addEventListener("click", () => collapse(b.dataset.reopen, false)));
  window.addEventListener("resize", debounce(() => { layoutDock(); drawPattern(); drawDamageGraph(); drawPerShot(); closePopover(); }, 80));

  // keyboard
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (openPop) { closePopover(); return; }
      const m = topModal();
      if (m && m.id !== "loadModal") closeModal(m.id);
      return;
    }
    if (e.target.matches("input, select, textarea") || e.ctrlKey || e.metaKey || e.altKey) return;
    if (topModal() && topModal().id === "optModal" && e.key.toLowerCase() === "f") { toggleFinderFull(); return; }
    if (topModal() && topModal().id === "exportModal" && e.key.toLowerCase() === "f") { toggleExportFull(); return; }
    if (topModal()) return;
    const k = e.key.toLowerCase();
    if (k === "f") fireMag();
    else if (k === "v") setView(state.view === "first" ? "third" : "first");
    else if (k === "c") clearHoles();
    else if (k === "x") clearDumps();
    else if (k === "r") reloadMag();
    else if (k === "h") setAim(!state.aiming);
    else if (k === "g") { e.preventDefault(); openWeaponPicker(); }
    else if (k === "b") openFinder();
    else if (k === "[") collapse("leftPanel", !$("leftPanel").classList.contains("hidden"));
    else if (k === "]") collapse("rightPanel", !$("rightPanel").classList.contains("hidden"));
    else if (k === "?") showPopover("helpPop", $("helpOpen"), "below-right");
  });

  // left mouse: hold to shoot. Right mouse: click toggles aim, drag orbits in 3rd person
  const gl = $("gl");
  // left: hold to shoot. Right: click toggles aimed / hip; held with Mouse aim on,
  // moving the mouse moves your aim; otherwise drag orbits in 3rd person.
  // Middle drag always orbits.
  let drag = null;
  // Mouse aim locks the pointer while the right button is held, so the hidden
  // cursor can't wander onto the panels and a click always goes to the range.
  const lockPointer = () => {
    try {
      const p = gl.requestPointerLock && gl.requestPointerLock();
      if (p && p.catch) p.catch(() => {});
    } catch (e) { /* not available: fall back to the free cursor */ }
  };
  const unlockPointer = () => { if (document.pointerLockElement === gl) document.exitPointerLock(); };
  const endDrag = () => { drag = null; document.body.classList.remove("aiming"); unlockPointer(); };
  gl.addEventListener("mousedown", (e) => {
    // clicking the range takes keyboard focus away from any box, so the shortcuts work
    if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
    closePopover();
    if (e.button === 0) { e.preventDefault(); triggerDown(); }
    else if (e.button === 2 || e.button === 1) {
      e.preventDefault();
      drag = { x: e.clientX, y: e.clientY, moved: 0, btn: e.button, aim: e.button === 2 && !!state.mouseAim };
      document.body.classList.toggle("aiming", drag.aim);
      if (drag.aim) lockPointer();
    }
  });
  window.addEventListener("mouseup", (e) => {
    if (e.button === 0) triggerUp();
    if (drag && e.button === drag.btn) {
      if (drag.btn === 2 && drag.moved < 4) setAim(!state.aiming);
      endDrag();
    }
  });
  // Esc (or the browser) ending the lock also ends aiming
  document.addEventListener("pointerlockchange", () => { if (document.pointerLockElement !== gl && drag && drag.aim) endDrag(); });
  window.addEventListener("blur", () => { triggerUp(); endDrag(); });
  window.addEventListener("mousemove", (e) => {
    if (!drag) return;
    if (drag.aim) {
      // while locked clientX/Y stay put; only movementX/Y carry the motion
      const mx = e.movementX || 0, my = e.movementY || 0;
      if (Math.abs(mx) > 400 || Math.abs(my) > 400) return; // browsers sometimes report a bogus jump right after locking
      drag.moved += Math.abs(mx) + Math.abs(my);
      mouseAimMove(mx, my);
      return;
    }
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

init().catch((e) => { bootDone(); showError(`Failed to start: ${e.message}`); console.error(e); });
