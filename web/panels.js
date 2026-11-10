/* RecoilSim front-end — the Setup panel (gun, attachments, target, shooting)
   and the Analysis panel (pattern, simulation results, saved patterns, gun stats). */
"use strict";

/* ------------------------------------------------------------------ the scenario the range uses */
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
    fps: clampFps($("fps").value),
    health: +$("health").value || 100,
    controller: !!state.controller,
    ...(Object.keys(state.recoilEdits || {}).length ? { recoil_overrides: state.recoilEdits } : {}),
  };
}
function applySavedSettings(s) {
  if (s.distance) { $("distanceNum").value = s.distance; setRange("distance", Math.min(600, s.distance)); }
  state.aiming = s.aiming !== false; setAimSeg(state.aiming ? "aim" : "hip"); state.aimBlend = state.aiming ? 1 : 0;
  state.stance = s.stance || "stand"; setStanceSeg(state.stance);
  state.controller = !!s.controller; setInputSeg(state.controller ? "pad" : "kbm");
  $("shots").value = s.shots || "";
  $("triggerRpm").value = s.trigger_rpm || "";
  setRange("comp", s.compensation || 0); $("compVal").textContent = `${$("comp").value}%`;
  if (s.aim_point) $("aimPoint").value = s.aim_point;
  $("gravity").checked = s.gravity !== false;
  if (s.fps) $("fps").value = String(s.fps);
  if (s.health) $("health").value = s.health;
  if (s.firemode_label) {
    const o = [...$("firemode").options].find((x) => x.text === s.firemode_label);
    if (o) { $("firemode").value = o.value; renderFiremodeSeg(); }
  }
}

/* ------------------------------------------------------------------ gun picker */
let pickerClass = "";
// what the gun picker is choosing for: the range (default) or the setup finder
let pickerTarget = { current: () => state.weapon, pick: (name) => equipWeapon(name) };
function openWeaponPicker(anchor = $("weaponChip"), target = null) {
  if (openPop && openPop.id === "weaponPicker" && openPop.anchor === anchor) { closePopover(); return; }
  pickerTarget = target || { current: () => state.weapon, pick: (name) => equipWeapon(name) };
  $("weaponSearch").value = "";
  pickerClass = "";
  renderWeaponCats();
  renderWeaponList();
  showPopover("weaponPicker", anchor);
  $("weaponSearch").focus();
  const cur = $("weaponList").querySelector(".pk-item.cur");
  if (cur) cur.scrollIntoView({ block: "center" });
}
function renderWeaponCats() {
  const classes = Object.keys(state.catalog.classes);
  // primaries, then secondaries (a thin divider between them), as in the game's loadout
  let last = null;
  $("weaponCats").innerHTML = [["", "All"], ...classes.map((c) => [c, titleCase(c)])]
    .map(([k, l]) => {
      const sl = k ? slotOfClass(k) : null, gap = sl && last && sl !== last ? `<span class="cat-gap" title="${sl}"></span>` : "";
      if (sl) last = sl;
      return `${gap}<button data-c="${esc(k)}" class="${k === pickerClass ? "on" : ""}" title="${sl ? `${sl.slice(0, -1)}` : "Every class"}">${esc(l)}</button>`;
    }).join("");
}
function renderWeaponList() {
  const f = norm($("weaponSearch").value);
  const groups = [];
  let n = 0, lastSlot = null;
  for (const [cls, list] of Object.entries(state.catalog.classes)) {
    if (pickerClass && cls !== pickerClass) continue;
    const items = list.filter((w) => !f || norm(w.displayname).includes(f) || norm(w.name).includes(f) || norm(cls).includes(f));
    if (!items.length) continue;
    n += items.length;
    if (!pickerClass && slotOfClass(cls) !== lastSlot) { lastSlot = slotOfClass(cls); groups.push(`<div class="pk-slot">${lastSlot}</div>`); }
    groups.push(`<div class="pk-group">${esc(titleCase(cls))}</div>` + items.map((w) =>
      `<button class="pk-item ${w.name === pickerTarget.current() ? "cur" : ""}" data-v="${esc(w.name)}"><span class="t"><span class="n">${esc(w.displayname)}</span></span><span class="m">${rankLabel(w.rank, w.test)}</span>${icon("check")}</button>`).join(""));
  }
  $("weaponList").innerHTML = groups.join("") || `<div class="pk-empty">No guns match “${esc($("weaponSearch").value)}”.</div>`;
  if (f && n) $("weaponList").querySelector(".pk-item").classList.add("hl");
}
function pickWeapon(name) {
  closePopover();
  if (name) pickerTarget.pick(name);
}
function equipWeapon(name) {
  closePopover();
  if (!name || name === state.weapon) return;
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
  $("weaponClass").textContent = titleCase(info.class || "");
  $("weaponChip").title = info.description ? `${info.description}\n\nChange gun (G)` : "Change gun (G)";
  renderAbout(); renderRecoilTab();
  const fm = $("firemode");
  fm.innerHTML = "";
  info.firemodes.forEach((l, i) => fm.add(new Option(l, i)));
  const savedFm = state.saved.settings && state.saved.settings.firemode_index;
  if (savedFm !== undefined && savedFm < info.firemodes.length && state.saved.weapon === name) fm.value = savedFm;
  renderFiremodeSeg();
  state.attachments = {};
  state.attNames = {};
  for (const slot of SLOTS) {
    state.attNames[slot] = {};
    for (const o of info.attachments[slot] || []) state.attNames[slot][o.name] = o;
    if (atts && atts[slot] && state.attNames[slot][atts[slot]]) state.attachments[slot] = atts[slot];
  }
  renderSlots();
  $("attInfo").textContent = "";
  state.holes = [];
  state.lastWatch = null;
  state.dmgView = null;
  if (typeof onWeaponChangedFinder === "function") onWeaponChangedFinder();
  onLoadoutChanged();
}

/* ------------------------------------------------------------------ attachment slots */
function renderSlots() {
  const info = state.weaponInfo;
  $("attachmentSlots").innerHTML = SLOTS.map((slot) => {
    const n = ((info && info.attachments[slot]) || []).length;
    const cur = state.attachments[slot];
    const o = cur && state.attNames[slot][cur];
    const tip = o ? `${o.displayname} — ${killLabel(o.kills, o.test)}${o.info ? `\n\n${o.info}` : ""}` : "";
    return `<button class="slot ${cur ? "set" : ""}" data-slot="${slot}" ${n ? "" : "disabled"} title="${esc(tip)}">
      <span class="sl">${slot}</span><span class="sv ${cur ? "" : "none"}">${cur ? esc(attLabel(slot, cur)) : n ? "None" : "—"}</span>${icon("chev")}</button>`;
  }).join("");
}
let attSlot = null;
function openAttPicker(slot, anchor) {
  if (openPop && openPop.id === "attPicker" && attSlot === slot) { closePopover(); return; }
  attSlot = slot;
  $("attSearch").value = "";
  $("attSearch").placeholder = `Search ${slot.toLowerCase()}…`;
  renderAttList();
  showPopover("attPicker", anchor, "right");
  $("attSearch").focus();
  const cur = $("attList").querySelector(".pk-item.cur");
  if (cur) cur.scrollIntoView({ block: "center" });
}
function renderAttList() {
  const slot = attSlot;
  const opts = (state.weaponInfo.attachments[slot] || []);
  const f = norm($("attSearch").value);
  const cur = state.attachments[slot] || "";
  const item = (v, name, desc, kills, test) => `<button class="pk-item ${v === cur ? "cur" : ""}" data-v="${esc(v)}" title="${esc(desc || "")}"><span class="t"><span class="n">${esc(name)}</span>${desc ? `<span class="d">${esc(desc)}</span>` : ""}</span>${kills === undefined ? "" : `<span class="m">${killLabel(kills, test)}</span>`}${icon("check")}</button>`;
  const out = [];
  if (!f) out.push(item("", "None", "Leave the slot empty"));
  // the game's loadout order: by kills needed to unlock, then name
  for (const o of opts) {
    if (f && !norm(o.displayname).includes(f) && !norm(o.category).includes(f)) continue;
    out.push(item(o.name, o.displayname, o.info, o.kills, o.test));
  }
  $("attList").innerHTML = out.join("") || `<div class="pk-empty">Nothing matches.</div>`;
  if (f && $("attList").querySelector(".pk-item")) $("attList").querySelector(".pk-item").classList.add("hl");
}
function setAttachment(slot, name) {
  closePopover();
  if ((state.attachments[slot] || "") === (name || "")) return;
  if (name) state.attachments[slot] = name; else delete state.attachments[slot];
  renderSlots();
  // the description only shows when hovering the slot (no text under the slots)
  $("attInfo").textContent = "";
  onLoadoutChanged();
}
function resetAttachments() {
  state.attachments = {};
  renderSlots();
  $("attInfo").textContent = "";
  onLoadoutChanged();
}

/* ------------------------------------------------------------------ fire modes */
function renderFiremodeSeg() {
  const sel = $("firemode"), segEl = $("firemodeSeg");
  const opts = [...sel.options];
  const useSeg = opts.length <= 4;
  segEl.classList.toggle("hidden", !useSeg);
  sel.classList.toggle("hidden", useSeg);
  segEl.innerHTML = opts.map((o) => `<button data-v="${o.value}" class="${o.value === sel.value ? "on" : ""}" ${opts.length === 1 ? "disabled" : ""}>${esc(prettyMode(o.text))}</button>`).join("");
  updateTriggerRow();
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
  renderFiremodeSeg();
  if (keep < 0 && prev) $("attInfo").textContent = `${prettyMode(prev)} isn't available with this setup, so the fire mode switched to ${prettyMode(labels[0])}.`;
  saveSettings();
  if (state.lastDump) autoRun();
}
function updateTriggerRow() {
  const label = currentModeLabel();
  $("triggerRow").classList.toggle("hidden", label === "AUTO" || label === "SWITCH");
}

/* ------------------------------------------------------------------ description tab */
function renderAbout() {
  const info = state.weaponInfo, st = state.stats;
  if (!info) return;
  const facts = [["Class", titleCase(info.class || "")], ["Unlock", rankLabel(info.rank, info.test)]];
  if (st && st.ammotype) facts.push(["Ammo", st.ammotype]);
  if (st && st.magsize) facts.push(["Magazine", `${st.magsize} + ${st.sparerounds ?? "?"}`]);
  $("aboutCard").innerHTML = `<h3>${esc(info.displayname)}</h3>
    <div class="about-facts">${facts.map(([k, v]) => `<span><em>${esc(k)}</em>${esc(String(v))}</span>`).join("")}</div>
    <p class="about-text">${info.description ? esc(info.description).replace(/\n/g, "<br>") : `<span class="hint">This gun has no description in the game.</span>`}</p>`;
}

/* ------------------------------------------------------------------ gun stats tab */
async function refreshStats() {
  const s = settings();
  try {
    state.stats = await api("/api/stats", { weapon: state.weapon, attachments: state.attachments, distance: s.distance, health: s.health, aiming: s.aiming });
  } catch (e) { return; }
  const st = state.stats;
  syncFiremodes(st.firemodes);
  // rate of the selected fire mode (guns with variable fire rates list one per mode)
  const fmi = Math.min(+$("firemode").value || 0, Array.isArray(st.firerate) ? st.firerate.length - 1 : 0);
  const frv = Array.isArray(st.firerate) ? (st.variablefirerate ? st.firerate[fmi] : st.firerate[0]) : st.firerate;
  const stk = st.shots_to_kill;
  const items = [
    ["Fire rate", `${Math.round(frv)}<small> rpm</small>`],
    ["Magazine", `${st.magsize}<small> +${st.sparerounds ?? "?"}</small>`],
    ["Fire cap", st.firecap ? `${Math.round(st.firecap)}<small> rpm${st.forcecap ? " (forced)" : ""}</small>` : "none"],
    ["Aimed rate", st.aimedfirerate ? `${Math.round(st.aimedfirerate)}<small> rpm</small>` : "same"],
    [`Damage @ ${s.distance}`, `${fmt(st.damage_here.base, 1)}${st.pelletcount > 1 ? `<small> ×${st.pelletcount}</small>` : ""}`],
    ["Bullet speed", `${Math.round(st.bulletspeed)}<small> st/s</small>`],
    ["Penetration", st.penetrationdepth != null ? `${fmt(st.penetrationdepth, 2)}<small> st</small>` : "–"],
    ["Shots to kill", stk.head ? `<span style="color:${COLORS.head}">${stk.head}</span> · <span style="color:${COLORS.torso}">${stk.torso}</span> · <span style="color:${COLORS.limb}">${stk.limb}</span>` : "–"],
    ["Head", `${fmt(st.damage_here.head, 1)}<small> ×${fmt(st.multhead, 2)}</small>`, "head"],
    ["Torso", `${fmt(st.damage_here.torso, 1)}<small> ×${fmt(st.multtorso, 2)}</small>`, "torso"],
    ["Limbs", `${fmt(st.damage_here.limb, 1)}<small> ×${fmt(st.multlimb, 2)}</small>`, "limb"],
    ["Pellets", st.pelletcount > 1 ? `${st.pelletcount}<small> per shot</small>` : "1"],
  ];
  const os = st.one_shot_avg;
  if (os && (os.head != null || os.torso != null || os.limb != null)) {
    const tip = `Where the first shot kills in one hit at least half the time when aimed there: a number is the average one-shot range from point blank, a–b a band (damage peaks mid-range), a+ from there on (damage rises with range)${st.pelletcount > 1 ? ", with every pellet's spread counted" : ""}. – = can't one-shot there.`;
    for (const [p, l] of [["head", "1-shot head"], ["torso", "1-shot torso"], ["limb", "1-shot legs"]]) {
      items.push([p === "head" ? `${l} <span class="tip" data-tip="${esc(tip)}">?</span>` : l, os[p] == null ? "–" : `${esc(os[p].text)}${/\d\+?$/.test(os[p].text) ? "<small> st</small>" : ""}`, p]);
    }
  }
  renderAbout(); renderRecoilTab();
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
  const parts = [["head", st.multhead || 1, COLORS.head], ["torso", st.multtorso || 1, COLORS.torso], ["limb", st.multlimb || 1, COLORS.limb]];
  const pellets = st.pelletcount || 1;
  // y range: whole graph when zoomed out, otherwise fit the visible part
  let lo = Infinity, hi = -Infinity;
  for (let k = 0; k <= 60; k++) {
    const d = x0 + ((x1 - x0) * k) / 60, base = dmgAt(g, d);
    for (const [, m] of parts) { lo = Math.min(lo, base * m); hi = Math.max(hi, base * m); }
  }
  const zoomed = x1 - x0 < full * 0.98;
  const y0 = zoomed ? Math.max(0, lo - (hi - lo) * 0.15 - 1) : 0, y1 = hi + Math.max((hi - lo) * 0.12, hi * 0.06, 1);
  const bandH = 14;
  const pad = { l: 34, r: 6, t: 8 };
  const axisY = h - 28 - bandH * 3;          // bottom of the damage plot
  const bandsTop = axisY + 6;
  const X = (d) => pad.l + ((d - x0) / (x1 - x0)) * (w - pad.l - pad.r);
  const Y = (v) => axisY - ((v - y0) / (y1 - y0)) * (axisY - pad.t);
  state.dmgGeom = { X, x0, x1, pad, w, h, axisY, bandsTop, bandH };
  ctx.font = `10.5px ${FONT}`; ctx.lineWidth = 1;
  const ys = niceStep(y1 - y0, 5), xs = niceStep(x1 - x0, Math.max(3, Math.floor((w - pad.l) / 60)));
  ctx.textAlign = "right";
  for (let v = Math.ceil(y0 / ys) * ys; v <= y1 + 1e-9; v += ys) {
    const y = Y(v);
    ctx.strokeStyle = "rgba(255,255,255,0.06)"; ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(w - pad.r, y); ctx.stroke();
    ctx.fillStyle = COLORS.text3; ctx.fillText(String(+v.toFixed(2)), pad.l - 6, y + 3.5);
  }
  ctx.textAlign = "center";
  for (let d = Math.ceil(x0 / xs) * xs; d <= x1 + 1e-9; d += xs) {
    const x = X(d);
    ctx.strokeStyle = "rgba(255,255,255,0.045)"; ctx.beginPath(); ctx.moveTo(x, pad.t); ctx.lineTo(x, bandsTop + bandH * 3); ctx.stroke();
    ctx.fillStyle = COLORS.text3; ctx.fillText(String(+d.toFixed(1)), x, h - 14);
  }
  ctx.strokeStyle = "rgba(255,255,255,0.18)"; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(pad.l, axisY); ctx.lineTo(w - pad.r, axisY); ctx.stroke();
  ctx.fillStyle = COLORS.text3; ctx.fillText("range (st)", (pad.l + w - pad.r) / 2, h - 1);
  ctx.save(); ctx.translate(9, (pad.t + axisY) / 2); ctx.rotate(-Math.PI / 2); ctx.fillText(`damage${pellets > 1 ? " / pellet" : ""}`, 0, 0); ctx.restore();
  ctx.save(); ctx.beginPath(); ctx.rect(pad.l, pad.t - 2, w - pad.l - pad.r, bandsTop + bandH * 3 - pad.t + 2); ctx.clip();
  // limb, torso, head; a curve exactly on top of an earlier one is dashed so both show
  const drawn = [];
  for (const [, m, c] of [parts[2], parts[1], parts[0]]) {
    ctx.strokeStyle = c; ctx.lineWidth = 2; ctx.lineJoin = "round";
    ctx.setLineDash(drawn.some((q) => Math.abs(q - m) < 1e-6) ? [6, 6] : []);
    ctx.beginPath();
    const pts = [{ distance: Math.min(x0, g[0].distance), damage: g[0].damage }, ...g, { distance: Math.max(x1, g[g.length - 1].distance) + 1, damage: g[g.length - 1].damage }];
    pts.forEach((p, i) => (i ? ctx.lineTo(X(p.distance), Y(p.damage * m)) : ctx.moveTo(X(p.distance), Y(p.damage * m))));
    ctx.stroke(); ctx.setLineDash([]);
    drawn.push(m);
  }
  // current range
  ctx.strokeStyle = "rgba(255,255,255,0.55)"; ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
  ctx.beginPath(); ctx.moveTo(X(D), pad.t); ctx.lineTo(X(D), bandsTop + bandH * 3); ctx.stroke(); ctx.setLineDash([]);
  // shots-to-kill bands below the plot, breakpoint dots on the curves
  const bands = st.stk_bands || {};
  const labels = [];
  parts.forEach(([name, m, c], i) => {
    const y = bandsTop + i * bandH;
    for (const b of bands[name] || []) {
      const bx0 = X(Math.max(b.from, x0)), bx1 = X(b.to == null ? x1 : Math.min(b.to, x1));
      if (bx1 > bx0) {
        ctx.fillStyle = c; ctx.globalAlpha = 0.14 + 0.12 * ((b.stk || 0) % 2); ctx.fillRect(bx0, y, bx1 - bx0 - 1, bandH - 2); ctx.globalAlpha = 1;
        ctx.fillStyle = COLORS.text; ctx.textAlign = "center";
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
    ctx.fillStyle = "#0b0d11"; ctx.beginPath(); ctx.arc(L.px, L.py, 4.6, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = L.c; ctx.beginPath(); ctx.arc(L.px, L.py, 3.4, 0, Math.PI * 2); ctx.fill();
    if (L.c2) { ctx.fillStyle = L.c2; ctx.beginPath(); ctx.arc(L.px, L.py, 3.4, -Math.PI / 2, Math.PI / 2); ctx.fill(); }
  }
  // breakpoint ranges next to their dots, nudged so they don't overlap
  ctx.textAlign = "left"; ctx.font = `600 10px ${FONT}`;
  const placed = [];
  for (const L of labels.sort((a, b) => a.px - b.px)) {
    let ty = L.py - 7;
    while (placed.some((q) => Math.abs(q.x - (L.px + 5)) < 26 && Math.abs(q.y - ty) < 10)) ty -= 10;
    if (ty < pad.t + 8) ty = L.py + 14;
    placed.push({ x: L.px + 5, y: ty });
    ctx.fillStyle = "rgba(11,13,17,0.8)"; ctx.fillRect(L.px + 4, ty - 9, ctx.measureText(L.text).width + 3, 11);
    ctx.fillStyle = L.c; ctx.fillText(L.text, L.px + 5, ty);
  }
  ctx.restore();
  ctx.font = `600 10px ${FONT}`; ctx.textAlign = "left";
  parts.forEach(([name, , c], i) => { ctx.fillStyle = c; ctx.fillText(name[0].toUpperCase(), pad.l - 12, bandsTop + i * bandH + 10); });
  // hover read-out
  const hv = state.dmgHover;
  if (hv != null && hv >= x0 && hv <= x1) {
    const x = X(hv), base = dmgAt(g, hv);
    ctx.strokeStyle = "rgba(255,255,255,0.35)"; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(x, pad.t); ctx.lineTo(x, axisY); ctx.stroke();
    const stkAt = (name) => { const b = (bands[name] || []).find((q) => hv >= q.from && (q.to == null || hv < q.to)); return b ? b.stk : "–"; };
    const rows = [[`${hv.toFixed(1)} st`, COLORS.text], ...parts.map(([name, m, c]) => [`${titleCase(name)} ${(base * m).toFixed(1)} · ${stkAt(name)} to kill`, c])];
    ctx.font = `11px ${FONT}`;
    const bw = Math.max(...rows.map((r) => ctx.measureText(r[0]).width)) + 14, bh = rows.length * 14 + 8;
    const bxp = x + 10 + bw > w - pad.r ? x - 10 - bw : x + 10;
    ctx.fillStyle = "rgba(14,16,21,0.94)"; roundRect(ctx, bxp, pad.t + 2, bw, bh, 6); ctx.fill();
    ctx.strokeStyle = "rgba(255,255,255,0.1)"; ctx.stroke();
    rows.forEach(([t, c], i) => { ctx.fillStyle = c; ctx.fillText(t, bxp + 7, pad.t + 17 + i * 14); });
  }
  const lines = parts.map(([name, , c]) => {
    const segs = (bands[name] || []).map((b) => `<b>${b.stk}</b> ${b.to == null ? `beyond ${fmt(b.from, 1)}` : `to ${fmt(b.to, 1)}`}`);
    return `<span style="color:${c}">●</span> ${titleCase(name)}: ${segs.join(" → ")} st`;
  });
  $("stkText").innerHTML = `Shots to kill ${st.health} HP${pellets > 1 ? " (all pellets hitting)" : ""}<br>${lines.join("<br>")}`;
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
  const zoomBy = (f) => { const G = state.dmgGeom; if (!G) return; const c = (G.x0 + G.x1) / 2, s2 = ((G.x1 - G.x0) * f) / 2; state.dmgView = clampView(c - s2, c + s2); drawDamageGraph(); };
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
  $("dmgZoomIn").addEventListener("click", () => zoomBy(0.7));
  $("dmgZoomOut").addEventListener("click", () => zoomBy(1.5));
}

/* ------------------------------------------------------------------ mag-dump simulation */
let dumpAbort = null;
async function runDumps() {
  const n = clampDumps();
  if (dumpAbort) dumpAbort.abort();
  dumpAbort = new AbortController();
  $("dumpStatus").textContent = `Simulating ${n.toLocaleString()} magazines…`;
  $("dumpBtn").disabled = true;
  try {
    const res = await api("/api/simulate", { weapon: state.weapon, attachments: state.attachments, settings: settings(), runs: n, return_runs: 1, heatmap: true, dump: true }, dumpAbort.signal, 180000);
    state.lastDump = res;
    state.lastDump.label = currentLabel();
    // the next session's "Load previous session" re-runs it (results are too big to keep)
    state.saved.dump = n; store();
    state.dotsCleared = false;
    $("dumpStatus").innerHTML = `<b>${res.runs.toLocaleString()}</b> mags · <b>${res.summary.bullets.toLocaleString()}</b> bullets at ${res.distance} st · ${res.elapsed}s` +
      (res.capped_from ? ` · capped from ${res.capped_from.toLocaleString()} (3 million bullet limit)` : "");
    renderResults(res.summary);
    drawPattern(); drawPerShot(); renderCompare();
  } catch (e) {
    if (e.name !== "AbortError" && e.message !== "cancelled") $("dumpStatus").innerHTML = `<span class="error">${esc(e.message)}</span>`;
  } finally { $("dumpBtn").disabled = false; }
}
function clearDumps() {
  if (dumpAbort) dumpAbort.abort();
  state.lastDump = null;
  if (state.saved.dump) { delete state.saved.dump; store(); }
  renderResults(null);
  $("dumpStatus").textContent = "Results cleared.";
  drawPerShot(); drawPattern(); renderCompare();
}
function setupLabel() {
  const atts = SLOTS.filter((k) => state.attachments[k]).map((k) => attLabel(k, state.attachments[k]));
  return `${state.weaponInfo ? state.weaponInfo.displayname : state.weapon}${atts.length ? " · " + atts.join(", ") : ""}`;
}
function currentLabel() {
  const s = settings();
  return `${setupLabel()} · ${s.aiming ? "aimed" : "hip"} · ${s.distance} st${s.compensation ? ` · ${s.compensation}% control` : ""}`;
}

const RESULT_TILES = [
  ["On target", (s) => pct(s.hit_rate)], ["Headshots", (s) => pct(s.head_rate), "head"], ["Avg TTK", (s) => (s.ttk_mean != null ? `${Math.round(s.ttk_mean * 1000)}<small>ms</small>` : "–")],
  ["Climb", (s) => `${fmt(s.final_climb, 2)}<small>st</small>`], ["Spread", (s) => `${fmt(s.random_radius, 2)}<small>st</small>`], ["Kills / mag", (s) => pct(s.kill_rate, 0)],
  ["Torso", (s) => pct(s.torso_rate), "torso"], ["Limbs", (s) => pct(s.limb_rate), "limb"], ["Dist. from aim", (s) => `${fmt(s.aim_error, 2)}<small>st</small>`],
  ["Shots to kill", (s) => fmt(s.stk_mean, 2)], ["Damage / mag", (s) => fmt(s.avg_mag_damage, 0)], ["Fire rate", (s) => (s.effective_rpm ? `${Math.round(s.effective_rpm)}<small>rpm</small>` : prettyMode(s.firemode))],
];
const TILE_TIPS = {
  Climb: "Where the average pattern ends up after the whole mag, relative to the aim point (after your recoil control). Learnable.",
  Spread: "Random scatter around the average pattern. Nobody can learn this away.",
  "Dist. from aim": "Average distance of every bullet from where you aim (the aim point), in studs. Lower = tighter, more accurate. Bullets that miss the dummy count too.",
};
function renderResults(s) {
  const more = state.showMoreResults;
  $("results").innerHTML = s ? RESULT_TILES.slice(0, more ? 12 : 6).map(([k, f, c]) => `<div class="tile ${c || ""}" ${TILE_TIPS[k] ? `data-tip="${esc(TILE_TIPS[k])}"` : ""}><div class="k">${k}</div><div class="v">${f(s)}</div></div>`).join("") : "";
  $("moreResults").classList.toggle("hidden", !s);
  $("moreResults").textContent = more ? "Fewer results" : "Show all results";
  $("perShotWrap").classList.toggle("hidden", !s || !more);
  if (s && more) drawPerShot();
}
function drawPerShot() {
  const cv = $("perShot");
  if (!cv.offsetParent) return;
  const { ctx, w, h } = setupCanvas(cv);
  ctx.clearRect(0, 0, w, h);
  const s = state.lastDump && state.lastDump.summary;
  if (!s) return;
  const v = s.per_shot_hit, n = v.length;
  const bw = w / n;
  for (let i = 0; i < n; i++) {
    const bh = Math.max(1, (h - 2) * v[i]);
    ctx.fillStyle = `hsl(${v[i] * 120}, 62%, 52%)`;
    ctx.fillRect(i * bw + 0.5, h - bh, Math.max(1, bw - 1), bh);
  }
}

/* ------------------------------------------------------------------ pattern view */
function patternBounds(w, h) {
  const res = state.lastDump || state.lastWatch;
  const cy = res ? res.target_cy : -aimOffset();
  let x0 = -3.0, x1 = 3.0, y0 = cy - 3.3, y1 = cy + 2.5;
  if (state.patternFit === "all") {
    // fit only what is actually drawn right now (cleared shots / results don't count)
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
  // leave room for the controls drawn over the top and bottom of the view
  y1 += (y1 - y0) * 0.08; y0 -= (y1 - y0) * 0.06;
  const s0 = Math.max((x1 - x0) / w, (y1 - y0) / h);
  const s = s0 / state.patternZoom;
  // zoom towards the aim point when zoomed in
  const z = Math.min(1, Math.max(0, (state.patternZoom - 1) / 2));
  const cxm = ((x0 + x1) / 2) * (1 - z), cym = ((y0 + y1) / 2) * (1 - z);
  return { x0: cxm - (s * w) / 2, x1: cxm + (s * w) / 2, y0: cym - (s * h) / 2, y1: cym + (s * h) / 2, s, cy };
}

const HEAT_PALETTES = {
  thermal: [[0, [20, 30, 90, 0]], [0.12, [40, 70, 200, 120]], [0.35, [40, 200, 230, 170]], [0.6, [250, 230, 60, 200]], [0.85, [255, 120, 30, 225]], [1, [255, 40, 40, 240]]],
  ember: [[0, [60, 10, 20, 0]], [0.15, [120, 20, 40, 130]], [0.4, [220, 60, 40, 180]], [0.7, [255, 160, 40, 215]], [1, [255, 245, 200, 245]]],
  ice: [[0, [10, 30, 70, 0]], [0.15, [20, 60, 140, 120]], [0.45, [40, 150, 230, 180]], [0.75, [120, 220, 255, 215]], [1, [240, 255, 255, 245]]],
  mono: [[0, [255, 255, 255, 0]], [0.2, [255, 255, 255, 60]], [1, [255, 255, 255, 235]]],
};
function heatColor(t) {
  const stops = HEAT_PALETTES[prefs.heat] || HEAT_PALETTES.thermal;
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
function gridImage(nx, ny, paint) {
  const off = document.createElement("canvas");
  off.width = nx; off.height = ny;
  const octx = off.getContext("2d");
  const img = octx.createImageData(nx, ny);
  paint(img.data);
  octx.putImageData(img, 0, 0);
  return off;
}
function drawHeat(ctx, B, w, h, cloud) {
  if (!cloud || !cloud.length) return;
  const nx = 140, ny = Math.max(20, Math.round((nx * h) / w));
  const { grid, mx } = densityGrid(cloud, B, nx, ny);
  if (mx <= 0) return;
  const off = gridImage(nx, ny, (d) => {
    for (let p = 0; p < nx * ny; p++) {
      const t = Math.pow(grid[p] / mx, 0.6);
      if (t < 0.02) continue;
      const c = heatColor(t);
      d[p * 4] = c[0]; d[p * 4 + 1] = c[1]; d[p * 4 + 2] = c[2]; d[p * 4 + 3] = c[3];
    }
  });
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
const MS_SEGS = { 1: [[3, 2]], 2: [[2, 1]], 3: [[3, 1]], 4: [[0, 1]], 5: [[3, 0], [2, 1]], 6: [[0, 2]], 7: [[3, 0]], 8: [[3, 0]], 9: [[0, 2]], 10: [[3, 2], [0, 1]], 11: [[0, 1]], 12: [[3, 1]], 13: [[2, 1]], 14: [[3, 2]] };
function contourPath(ctx, grid, nx, ny, level, w, h) {
  const cx = (i) => ((i + 0.5) / nx) * w, cy = (j) => ((j + 0.5) / ny) * h;
  const g = (i, j) => grid[j * nx + i];
  const lerp = (p, q) => (level - p) / (q - p || 1e-9);
  ctx.beginPath();
  for (let j = 0; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) {
    const a = g(i, j), b = g(i + 1, j), c = g(i + 1, j + 1), d = g(i, j + 1);
    const idx = (a >= level ? 8 : 0) | (b >= level ? 4 : 0) | (c >= level ? 2 : 0) | (d >= level ? 1 : 0);
    if (idx === 0 || idx === 15) continue;
    // edge points: 0 top, 1 right, 2 bottom, 3 left
    const E = [
      [cx(i) + lerp(a, b) * (cx(i + 1) - cx(i)), cy(j)],
      [cx(i + 1), cy(j) + lerp(b, c) * (cy(j + 1) - cy(j))],
      [cx(i) + lerp(d, c) * (cx(i + 1) - cx(i)), cy(j + 1)],
      [cx(i), cy(j) + lerp(a, d) * (cy(j + 1) - cy(j))],
    ];
    for (const [p, q] of MS_SEGS[idx]) { ctx.moveTo(E[p][0], E[p][1]); ctx.lineTo(E[q][0], E[q][1]); }
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
  const rgb = [1, 3, 5].map((k) => parseInt(color.slice(k, k + 2), 16));
  const off = gridImage(nx, ny, (d) => {
    for (let p = 0; p < nx * ny; p++) if (grid[p] >= th[0]) { d[p * 4] = rgb[0]; d[p * 4 + 1] = rgb[1]; d[p * 4 + 2] = rgb[2]; d[p * 4 + 3] = 46; }
  });
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
  ctx.fillStyle = "#0a0c10"; ctx.fillRect(0, 0, w, h);
  const step = px > 60 ? 0.5 : px > 25 ? 1 : px > 10 ? 2 : px > 4 ? 5 : 10;
  ctx.strokeStyle = "rgba(255,255,255,0.045)"; ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = Math.ceil(B.x0 / step) * step; x <= B.x1; x += step) { ctx.moveTo(Math.round(X(x)) + 0.5, 0); ctx.lineTo(Math.round(X(x)) + 0.5, h); }
  for (let y = Math.ceil(B.y0 / step) * step; y <= B.y1; y += step) { ctx.moveTo(0, Math.round(Y(y)) + 0.5); ctx.lineTo(w, Math.round(Y(y)) + 0.5); }
  ctx.stroke();
  const cy = B.cy;
  for (const [name, hx, hy, hw, hh] of state.hitboxes) {
    const c = name === "Head" ? COLORS.head : name === "Torso" ? COLORS.torso : COLORS.limb;
    const rgb = [1, 3, 5].map((k) => parseInt(c.slice(k, k + 2), 16)).join(",");
    ctx.fillStyle = `rgba(${rgb},0.09)`; ctx.strokeStyle = `rgba(${rgb},0.6)`; ctx.lineWidth = 1;
    const rx = X(hx - hw), ry = Y(hy + cy + hh), rw = 2 * hw * px, rh = 2 * hh * px;
    ctx.fillRect(rx, ry, rw, rh); ctx.strokeRect(rx + 0.5, ry + 0.5, rw - 1, rh - 1);
  }
  const dump = state.lastDump;
  if (state.patternView !== "dots" && dump) drawHeat(ctx, B, w, h, dump.cloud);
  for (const sn of state.snapshots) {
    if (!sn.visible) continue;
    drawContours(ctx, B, w, h, sn.cloud, sn.color);
    ctx.strokeStyle = sn.color; ctx.lineWidth = 1.6; ctx.setLineDash([5, 3]); ctx.beginPath();
    sn.mean_path.forEach(([x, y], i) => (i ? ctx.lineTo(X(x), Y(y)) : ctx.moveTo(X(x), Y(y))));
    ctx.stroke(); ctx.setLineDash([]);
  }
  if (dump && dump.summary && dump.summary.mean_path && state.patternView !== "dots") {
    ctx.strokeStyle = "rgba(255,255,255,0.85)"; ctx.lineWidth = 1.4; ctx.setLineDash([4, 3]); ctx.beginPath();
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
    ctx.strokeStyle = "rgba(230,236,244,0.16)"; ctx.lineWidth = 1; ctx.beginPath();
    let started = false;
    for (let i = from; i < n; i++) {
      const p = src[i][0];
      if (!p || !Number.isFinite(p[0])) continue;
      if (!started) { ctx.moveTo(X(p[0]), Y(p[1])); started = true; } else ctx.lineTo(X(p[0]), Y(p[1]));
    }
    ctx.stroke();
    const showNum = prefs.numbers && n <= 60 && px > 12;
    ctx.font = `600 9px ${FONT}`;
    for (let i = from; i < n; i++) for (let k = 0; k < src[i].length; k++) {
      const p = src[i][k];
      if (!p || !Number.isFinite(p[0])) continue;
      const part = parts[i][k];
      ctx.fillStyle = part >= 0 ? PART_COLORS[part] : COLORS.miss; ctx.strokeStyle = "rgba(0,0,0,0.85)"; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(X(p[0]), Y(p[1]), src[i].length > 1 ? 2.5 : 3.4, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      if (showNum && k === 0) { ctx.fillStyle = "rgba(230,236,244,0.85)"; ctx.fillText(String(i + 1), X(p[0]) + 5, Y(p[1]) - 4); }
    }
  }
  // aim point
  ctx.strokeStyle = "#fff"; ctx.lineWidth = 1.3;
  const ax = X(0), ay = Y(0);
  ctx.beginPath(); ctx.moveTo(ax - 9, ay); ctx.lineTo(ax - 3, ay); ctx.moveTo(ax + 3, ay); ctx.lineTo(ax + 9, ay);
  ctx.moveTo(ax, ay - 9); ctx.lineTo(ax, ay - 3); ctx.moveTo(ax, ay + 3); ctx.lineTo(ax, ay + 9); ctx.stroke();
  // scale bar (bottom left)
  const D = settings().distance;
  const studs = step * (step < 2 ? 2 : 1), bar = studs * px;
  ctx.strokeStyle = "rgba(230,236,244,0.8)"; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(10, h - 14); ctx.lineTo(10 + bar, h - 14); ctx.moveTo(10, h - 18); ctx.lineTo(10, h - 10); ctx.moveTo(10 + bar, h - 18); ctx.lineTo(10 + bar, h - 10); ctx.stroke();
  ctx.font = `500 11px ${FONT}`; ctx.fillStyle = "rgba(230,236,244,0.85)";
  ctx.fillText(`${studs} st · ${((Math.atan2(studs, D) * 180) / Math.PI).toFixed(2)}°`, 16 + bar, h - 10);
  // legend (top right, stacked)
  const legend = [["Head", COLORS.head], ["Torso", COLORS.torso], ["Limb", COLORS.limb], ["Miss", COLORS.miss]];
  ctx.font = `500 11px ${FONT}`; ctx.textAlign = "left";
  const lw = Math.max(...legend.map(([t]) => ctx.measureText(t).width)) + 16;
  legend.forEach(([t, c], i) => {
    const y = 20 + i * 15;
    ctx.fillStyle = c; ctx.beginPath(); ctx.arc(w - lw - 4, y - 4, 3.5, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "rgba(230,236,244,0.75)"; ctx.fillText(t, w - lw + 4, y);
  });
  if (state.snapshots.some((x) => x.visible)) {
    ctx.fillStyle = "rgba(230,236,244,0.55)"; ctx.font = `11px ${FONT}`;
    ctx.fillText("Saved: solid 50% · dashed 80% · dotted 95% of bullets", 10, 46);
  }
  if (!dump && !src) {
    ctx.textAlign = "center";
    ctx.fillStyle = "rgba(230,236,244,0.8)"; ctx.font = `600 13px ${FONT}`;
    ctx.fillText("No pattern yet", w / 2, h / 2 - 8);
    ctx.fillStyle = "rgba(230,236,244,0.5)"; ctx.font = `12px ${FONT}`;
    ctx.fillText("Press Simulate, or shoot on the range", w / 2, h / 2 + 12);
    ctx.textAlign = "left";
  }
}
function setZoom(z) {
  state.patternZoom = Math.min(16, Math.max(0.25, z));
  $("zoomVal").textContent = `${state.patternZoom.toFixed(state.patternZoom < 10 ? 1 : 0)}×`;
  drawPattern();
  if (!state.restoring) saveSoon();
}
function setFit(fit) {
  state.patternFit = fit;
  $("fitBtn").classList.toggle("on", fit === "all");
  drawPattern();
}

/* ------------------------------------------------------------------ saved patterns */
function saveSnapshot() {
  const d = state.lastDump;
  if (!d) { toast("Simulate first, then save the pattern."); return; }
  let cloud = d.cloud || [];
  if (cloud.length > 4000) { const stepN = cloud.length / 4000; cloud = Array.from({ length: 4000 }, (_, i) => cloud[Math.floor(i * stepN)]); }
  const used = new Set(state.snapshots.map((s) => s.color));
  const color = SNAP_COLORS.find((c) => !used.has(c)) || SNAP_COLORS[state.snapshots.length % SNAP_COLORS.length];
  const s = d.summary;
  state.snapshots.push({
    id: Date.now(), name: d.label || currentLabel(), color, visible: true, distance: d.distance,
    cloud: cloud.map(([x, y]) => [Math.round(x * 1000) / 1000, Math.round(y * 1000) / 1000]),
    mean_path: s.mean_path,
    summary: { aim_error: s.aim_error, hit_rate: s.hit_rate, head_rate: s.head_rate, torso_rate: s.torso_rate, limb_rate: s.limb_rate, kill_rate: s.kill_rate, ttk_mean: s.ttk_mean, ttk_median: s.ttk_median, stk_mean: s.stk_mean, avg_mag_damage: s.avg_mag_damage, final_climb: s.final_climb, random_radius: s.random_radius },
  });
  if (state.snapshots.length > 6) state.snapshots.shift();
  store(); renderSnapList(); drawPattern(); renderCompare();
}
function renderSnapList() {
  $("snapList").innerHTML = state.snapshots.map((s, i) => `<div class="snap ${s.visible ? "" : "off"}" data-id="${s.id}">
    <span class="sw" style="background:${s.color}"></span><span class="no">#${i + 1}</span><span class="nm" title="${esc(s.name)}">${esc(s.name)}</span>
    <button class="iconbtn" data-act="toggle" title="${s.visible ? "Hide" : "Show"}">${icon(s.visible ? "eye" : "eyeoff")}</button>
    <button class="iconbtn" data-act="del" title="Delete">${icon("x")}</button></div>`).join("");
}
function onSnapClick(e) {
  const b = e.target.closest("[data-act]");
  if (!b) return;
  const id = +b.closest(".snap").dataset.id;
  if (b.dataset.act === "del") state.snapshots = state.snapshots.filter((x) => x.id !== id);
  else { const s = state.snapshots.find((x) => x.id === id); s.visible = !s.visible; }
  store(); renderSnapList(); drawPattern(); renderCompare();
}
const COMPARE_ROWS = [
  ["Dist. from aim", "aim_error", (v) => `${fmt(v, 2)} st`, -1], ["On target", "hit_rate", (v) => pct(v), 1], ["Headshots", "head_rate", (v) => pct(v), 1], ["Kills / mag", "kill_rate", (v) => pct(v, 0), 1],
  ["Avg TTK", "ttk_mean", (v) => (v == null ? "–" : `${Math.round(v * 1000)} ms`), -1], ["Shots to kill", "stk_mean", (v) => fmt(v, 2), -1],
  ["Damage / mag", "avg_mag_damage", (v) => fmt(v, 0), 1], ["Climb", "final_climb", (v) => `${fmt(v, 2)} st`, 0], ["Spread", "random_radius", (v) => `${fmt(v, 2)} st`, -1],
];
function renderCompare() {
  const shown = state.snapshots.filter((s) => s.visible);
  const cur = state.lastDump && state.lastDump.summary;
  if (!shown.length || !cur) { $("compare").innerHTML = ""; return; }
  const head = `<tr><th></th><th>Now</th>${shown.map((s) => `<th style="color:${s.color}" title="${esc(s.name)}">#${state.snapshots.indexOf(s) + 1}</th>`).join("")}</tr>`;
  const body = COMPARE_ROWS.map(([label, key, f, dir]) => `<tr><td>${label}</td><td>${f(cur[key])}</td>${shown.map((s) => {
    const v = s.summary[key];
    let cls = "";
    if (dir && v != null && cur[key] != null && Math.abs(v - cur[key]) > 1e-9) cls = (v - cur[key]) * dir > 0 ? "better" : "worse";
    return `<td class="${cls}">${f(v)}</td>`;
  }).join("")}</tr>`).join("");
  $("compare").innerHTML = `<table class="cmp">${head}${body}</table><p class="hint">Green / red: the saved pattern is better / worse than now.</p>`;
}

/* ------------------------------------------------------------------ layout */
function layoutDock() {
  // keep the dock and readout centred in the space between the side panels
  const l = $("leftPanel"), r = $("rightPanel");
  const left = l.classList.contains("hidden") ? 0 : l.getBoundingClientRect().right;
  const right = r.classList.contains("hidden") ? innerWidth : r.getBoundingClientRect().left;
  const mid = innerWidth > 760 ? (left + right) / 2 : innerWidth / 2;
  $("dock").style.left = `${mid}px`;
  $("hud").style.left = `${mid}px`;
  fitReadout();
}
function collapse(id, hide) {
  $(id).classList.toggle("hidden", hide);
  document.querySelector(`[data-reopen="${id}"]`).classList.toggle("show", hide);
  layoutDock();
  if (!hide) setTimeout(() => { drawPattern(); drawDamageGraph(); drawPerShot(); }, 30);
  if (!state.restoring && state.catalog) saveSoon();
}
