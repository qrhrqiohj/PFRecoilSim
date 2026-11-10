/* RecoilSim front-end — the recoil designer.

   The design is a full recoil table (rd.recoil: camera, gun kick, view shake,
   each with its recovery springs) plus a pattern: one target per shot of the
   magazine — where it should land, how much that counts, and how widely it may
   spread (a ring). "Combine Recoil" fits the camera's pitch / yaw layers to the
   pattern (the server's recoil_fit.py); the Gun & view tab edits the other
   parts directly. Whatever the working table does is always shown: where each
   shot lands (orange), its spread, and the motion over time. */
"use strict";

const RD_W = { free: 0, soft: 0.35, normal: 1, strong: 4, lock: 25 };
const RD_PARTS = [
  { g: "Rotation", label: "Rotational", hint: "Turns the gun in front of the camera. Bullets follow it, so it changes the pattern too (Combine Recoil works around it).", axes: { x: "pitch (up / down)", y: "yaw (left / right)", z: "roll" } },
  { g: "Translation", label: "Translational", hint: "Moves the gun in front of the camera — mostly the visible kick back. Barely moves the bullets.", axes: { x: "sideways", y: "up / down", z: "back / forward" } },
  { g: "CameraHead", label: "Head Camera", hint: "Shakes what you see only; the bullets don't follow it.", axes: { x: "pitch", y: "yaw", z: "roll" } },
  { g: "CameraBody", label: "Camera roll", hint: "Tilts the view on each shot (the camera's pitch and yaw are on the Camera tab).", axes: { z: "roll" } },
];
/* simple starting points for a part: [axis] -> rows [damping, speed, kick, variance] */
const RD_PRESETS = {
  none: { label: "None", rows: {} },
  light: { label: "Light", k: 1 },
  medium: { label: "Medium", k: 2 },
  heavy: { label: "Heavy", k: 3.5, slow: 0.85 },
  snappy: { label: "Snappy", k: 1.6, fast: 1.6, damp: 0.95 },
  bouncy: { label: "Bouncy", k: 1.6, damp: 0.35 },
};
const RD_PRESET_BASE = {
  Rotation: { x: [0.8, 25, 0.4, 0.1], y: [0.7, 24, 0, 0.15], z: [0.6, 40, 0, 0.2] },
  Translation: { x: [0.85, 20, 0, 0.1], y: [0.85, 22, -0.2, 0.1], z: [1.0, 20, 3, 0.3] },
  CameraHead: { x: [0.65, 19, 0.3, 0.05], y: [0.65, 26, 0, 0.15], z: [0.65, 18, 0, 0.1] },
  CameraBody: { z: [0.45, 60, 0, 0.4] },
};
const rd = {
  weapon: null, stance: "aim", tool: "line", after: "settle", n: 30, cover: 30,
  ctrl: [], manual: {}, weight: {}, ring: {}, sel: -1,
  recoil: null, source: "this:edited", tags: { x: [], y: [] },
  live: null, fitInfo: null, partsChanged: false, scatter: null, busy: false, liveSeq: 0,
  feel: "game", layers: "auto", variance: 0.3, smooth: 0.3, snap: 0.6, snapOn: true, recD: 0.85, recS: 15, delay: 0.1, punch: 0, shake: 0,
  view: { cx: 0, cy: 3, scale: 30 }, drag: null, undo: [], redo: [],
  moShow: { camP: true, camY: true, gunP: true, view: false },
};
const rdG = (part) => rd.stance + part;          // e.g. "aimRotation"
const rdCam = () => rdG("CameraBody");

/* ------------------------------------------------------------------ pattern model */
const rdSnap = () => JSON.stringify({ ctrl: rd.ctrl, manual: rd.manual, weight: rd.weight, ring: rd.ring, cover: rd.cover, after: rd.after, n: rd.n,
  recoil: rd.recoil, tags: rd.tags, fitInfo: rd.fitInfo, hideLive: !!rd.hideLive });
function rdPush() { rd.undo.push(rdSnap()); if (rd.undo.length > 200) rd.undo.shift(); rd.redo = []; }
function rdRestore(json) {
  const o = JSON.parse(json);
  const recoilChanged = o.recoil && JSON.stringify(o.recoil) !== JSON.stringify(rd.recoil);
  Object.assign(rd, { ctrl: o.ctrl, manual: o.manual, weight: o.weight, ring: o.ring || {}, cover: o.cover, after: o.after, n: o.n });
  if (o.recoil) { rd.recoil = o.recoil; rd.tags = o.tags || { x: [], y: [] }; rd.fitInfo = o.fitInfo || null; rd.hideLive = !!o.hideLive; }
  $("rdShots").value = rd.n; $("rdCover").value = rd.cover; rd.setAfter(rd.after);
  if (recoilChanged) { rd.scatter = null; rdRenderLayers(); if (rd.tab === "parts") rdRenderParts(); rdLive(); }
  rdChanged(); rdDrawMotion();
  if (o.recoil) { rd.fitInfo = o.fitInfo ? JSON.parse(JSON.stringify(o.fitInfo)) : null; if (rd.fitInfo) rd.fitInfo.stale = !!(JSON.parse(json).fitInfo || {}).stale; rdShowResult(); }  // undo brings back whether it was up to date
}
const rdFirst = () => (rd.live && rd.live.path[0]) || [0, 0];
/* what the recoil does (orange path, spread, landing dots, motion) — hidden after
   Clear until you combine, reset, change the recoil or copy a pattern */
const rdShown = () => (rd.hideLive ? null : rd.live);
/* the drawn line; its first point is always shot 1, which fires before any recoil */
const rdCtrl = () => (rd.ctrl.length ? [rdFirst(), ...rd.ctrl.slice(1)] : []);
function rdAlongLine(count) {
  const P = rdCtrl();
  if (P.length < 2 || count < 1) return [];
  const seg = [], cum = [0];
  for (let i = 1; i < P.length; i++) { const d = Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1]); seg.push(d); cum.push(cum[i - 1] + d); }
  const total = cum[cum.length - 1] || 1, out = [];
  for (let k = 0; k < count; k++) {
    const t = count === 1 ? 0 : (k / (count - 1)) * total;
    let i = 1;
    while (i < cum.length - 1 && cum[i] < t) i++;
    const f = seg[i - 1] ? (t - cum[i - 1]) / seg[i - 1] : 0;
    out.push([P[i - 1][0] + (P[i][0] - P[i - 1][0]) * f, P[i - 1][1] + (P[i][1] - P[i - 1][1]) * f]);
  }
  return out;
}
/* every shot: {x, y, src: "first" | "manual" | "line" | "after" | "free", w} */
function rdShotsList() {
  const n = rd.n, cover = Math.min(rd.cover, n), line = rdAlongLine(cover), out = [];
  // the shots you gave a place: from the line or placed / moved yourself
  const own = (i) => (i === 0 ? rdFirst() : rd.manual[i] ? rd.manual[i] : i < line.length ? line[i] : null);
  // "after the line" starts after the last of them (line or placed shots alike),
  // in the direction of the last few
  let lastI = -1;
  for (let i = n - 1; i >= 1; i--) if (own(i)) { lastI = i; break; }
  const last = lastI >= 1 ? own(lastI) : null;
  let step = null;
  if (last) {
    let j = lastI - 1, steps = 0;
    while (j >= 0 && !own(j)) j--;
    if (j >= 0) { const a = own(j); steps = lastI - j; step = [(last[0] - a[0]) / steps, (last[1] - a[1]) / steps]; }
  }
  for (let i = 0; i < n; i++) {
    let s;
    if (i === 0) { const f = rdFirst(); out.push({ x: f[0], y: f[1], src: "first", w: 0 }); continue; }
    if (rd.manual[i]) s = { x: rd.manual[i][0], y: rd.manual[i][1], src: "manual", w: RD_W.normal };
    else if (i < line.length) s = { x: line[i][0], y: line[i][1], src: "line", w: RD_W.normal };
    else if (last && i > lastI && rd.after === "settle") s = { x: last[0], y: last[1], src: "after", w: RD_W.soft };
    else if (last && i > lastI && rd.after === "trend" && step) {
      const j = i - lastI, f = (1 - Math.pow(0.85, j)) / (1 - 0.85);
      s = { x: last[0] + step[0] * f, y: last[1] + step[1] * f, src: "after", w: RD_W.soft };
    } else s = { x: null, y: null, src: "free", w: 0 };
    if (rd.weight[i] != null) s.w = RD_W[rd.weight[i]];
    if (s.x == null) s.w = 0;
    out.push(s);
  }
  return out;
}
function rdWeightName(i, sh) { return rd.weight[i] || (sh.src === "free" ? "free" : sh.src === "after" ? "soft" : "normal"); }
/* spread rings: set on some shots, the ones between follow smoothly; [±x, ±y] studs (~2 sigma) */
function rdRingKeys() { return Object.keys(rd.ring).map(Number).filter((i) => i > 0 && i < rd.n).sort((a, b) => a - b); }
function rdRingAt(i) {
  // a ring belongs to its own shot only (shots without one use Randomness)
  return i >= 1 && rd.ring[i] ? { r: rd.ring[i], key: true } : null;
}

/* ------------------------------------------------------------------ working recoil */
function rdRows(ax) {
  // the camera's pitch ("x") / yaw ("y") layers as [d, s, kick, var, rec d, rec s]
  const g = rdCam(), rows = rd.recoil[g][ax] || [], rl = (rd.recoil[g + "Recovery"][ax] || {}).layers || [];
  return rows.map((r, i) => [...r, ...(rl[i] || [r[0], r[1]])]);
}
function rdSetRows(ax, rows) {
  const g = rdCam();
  rd.recoil[g][ax] = rows.map((r) => r.slice(0, 4));
  rd.recoil[g + "Recovery"][ax] = { layers: rows.map((r) => [r[4], r[5]]), delay: (rd.recoil[g + "Recovery"][ax] || {}).delay ?? rd.delay };
}
function rdSyncTags() {
  for (const ax of ["x", "y"]) {
    const n = (rd.recoil[rdCam()][ax] || []).length;
    rd.tags[ax] = Array.from({ length: n }, (_, i) => rd.tags[ax][i] || "fit");
  }
}
function rdSimReq(extra) {
  const s = settings();
  return { weapon: rd.weapon, aiming: rd.stance === "aim", distance: +$("rdDist").value || 50, shots: rd.n, fps: s.fps,
    firemode_index: s.firemode_index, controller: s.controller, trigger_rpm: s.trigger_rpm, ...extra };
}
/* what the working recoil does: path, spread, motion (debounced; the latest request wins) */
let rdLiveTimer = null;
function rdLive(now) {
  clearTimeout(rdLiveTimer);
  const go = async () => {
    const seq = ++rd.liveSeq;
    try {
      const r = await api("/api/recoil/path", rdSimReq({ recoil: rd.recoil, sigma: true, track: true, runs: $("rdSpread").checked ? 150 : 0 }));
      if (seq !== rd.liveSeq) return;
      rd.live = { path: r.path, sigma: r.sigma, track: r.track, settle: r.settle, times: r.times };
      rd.scatter = rd.hideLive ? null : r.scatter || null;
      rdAfterLive();
    } catch (e) { if (seq === rd.liveSeq) $("rdResult").innerHTML = `<p class="error">${esc(e.message)}</p>`; }
  };
  if (now) return go();
  rdLiveTimer = setTimeout(go, 140);
}
function rdAfterLive() {
  rdShowResult(); rdRenderShot(); rdDrawMotion(); rdDraw();
}

/* ------------------------------------------------------------------ drawing */
function rdToScreen(x, y, cv) { const v = rd.view; return [cv.width / 2 + (x - v.cx) * v.scale, cv.height / 2 - (y - v.cy) * v.scale]; }
function rdToWorld(sx, sy, cv) { const v = rd.view; return [(sx - cv.width / 2) / v.scale + v.cx, -(sy - cv.height / 2) / v.scale + v.cy]; }
function rdSizeCanvas(cv) {
  const dpr = devicePixelRatio || 1, r = cv.getBoundingClientRect();
  if (cv.width !== Math.round(r.width * dpr) || cv.height !== Math.round(r.height * dpr)) { cv.width = Math.round(r.width * dpr); cv.height = Math.round(r.height * dpr); }
  return dpr;
}
function rdDraw() {
  const cv = $("rdCanvas");
  if (!cv || $("rdModal").classList.contains("hidden")) return;
  const dpr = rdSizeCanvas(cv), c = cv.getContext("2d"), s = rd.view.scale;
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.fillStyle = "#11141a"; c.fillRect(0, 0, cv.width, cv.height);
  // grid: every stud (every 5 brighter); coarser when zoomed out
  const [x0, y1] = rdToWorld(0, 0, cv), [x1, y0] = rdToWorld(cv.width, cv.height, cv);
  const step = s < 6 ? 5 : s > 120 ? 0.25 : 1;
  c.lineWidth = 1;
  for (let gx = Math.ceil(x0 / step) * step; gx <= x1; gx += step) { const [sx] = rdToScreen(gx, 0, cv); c.strokeStyle = Math.abs(gx % 5) < 1e-9 ? "rgba(255,255,255,.1)" : "rgba(255,255,255,.035)"; c.beginPath(); c.moveTo(sx, 0); c.lineTo(sx, cv.height); c.stroke(); }
  for (let gy = Math.ceil(y0 / step) * step; gy <= y1; gy += step) { const [, sy] = rdToScreen(0, gy, cv); c.strokeStyle = Math.abs(gy % 5) < 1e-9 ? "rgba(255,255,255,.1)" : "rgba(255,255,255,.035)"; c.beginPath(); c.moveTo(0, sy); c.lineTo(cv.width, sy); c.stroke(); }
  const col = { Head: "rgba(255,92,122,.3)", Torso: "rgba(255,178,36,.24)" };
  for (const [name, hx, hy, hw, hh] of state.hitboxes || []) {
    const [a, b] = rdToScreen(hx - hw, hy + hh, cv);
    c.fillStyle = col[name] || "rgba(76,195,255,.18)"; c.fillRect(a, b, hw * 2 * s, hh * 2 * s);
    c.strokeStyle = "rgba(255,255,255,.16)"; c.strokeRect(a, b, hw * 2 * s, hh * 2 * s);
  }
  const [ax, ay] = rdToScreen(0, 0, cv);
  c.strokeStyle = "#fff"; c.lineWidth = 1.5 * dpr;
  c.beginPath(); c.moveTo(ax - 7 * dpr, ay); c.lineTo(ax + 7 * dpr, ay); c.moveTo(ax, ay - 7 * dpr); c.lineTo(ax, ay + 7 * dpr); c.stroke();
  const P = (p) => rdToScreen(p[0], p[1], cv);
  const poly = (pts, color, w, dash) => {
    const q = pts.filter(Boolean);
    if (q.length < 2) return;
    c.strokeStyle = color; c.lineWidth = w * dpr; c.setLineDash(dash ? dash.map((d) => d * dpr) : []);
    c.beginPath(); q.forEach((p, i) => { const [x, y] = P(p); i ? c.lineTo(x, y) : c.moveTo(x, y); }); c.stroke(); c.setLineDash([]);
  };
  const ellipse = (p, rx, ry, color, w, dash, fill) => {
    const [x, y] = P(p);
    c.beginPath(); c.ellipse(x, y, Math.max(1, rx * s), Math.max(1, ry * s), 0, 0, 7);
    if (fill) { c.fillStyle = fill; c.fill(); }
    c.strokeStyle = color; c.lineWidth = w * dpr; c.setLineDash(dash ? dash.map((d) => d * dpr) : []); c.stroke(); c.setLineDash([]);
  };
  if (rd.scatter) {
    c.fillStyle = "rgba(255,178,36,.16)";
    for (const mag of rd.scatter) for (const p of mag) { if (Math.abs(p[0]) > 1e5) continue; const [x, y] = P(p); c.fillRect(x - dpr, y - dpr, 2 * dpr, 2 * dpr); }
  }
  const shown = rdShown(), shots = rdShotsList(), live = shown && shown.path, rings = $("rdRings").checked;
  // what the recoil does now: spread (about 19 in 20 land inside) and path
  // orange: what the recoil being designed does now (the gun's own until you combine)
  if (live && rings && shown.sigma) live.forEach((p, i) => { const sg = shown.sigma[i]; if (sg && i > 0 && (sg[0] > 0.01 || sg[1] > 0.01)) ellipse(p, 2 * sg[0], 2 * sg[1], "rgba(255,178,36,.28)", 1); });
  // the targets: a line through them in order, their rings
  poly(shots.map((sh) => (sh.x == null ? null : [sh.x, sh.y])), "rgba(76,195,255,.35)", 1.2);
  if (rd.tool === "line") {
    poly(rdCtrl(), "rgba(76,195,255,.7)", 1.6, [5, 4]);
    rdCtrl().forEach((p, i) => { if (!i) return; const [x, y] = P(p); c.fillStyle = "#0b0d11"; c.strokeStyle = "#4cc3ff"; c.lineWidth = 2 * dpr; c.beginPath(); c.rect(x - 4.5 * dpr, y - 4.5 * dpr, 9 * dpr, 9 * dpr); c.fill(); c.stroke(); });
  }
  if (rings) shots.forEach((sh, i) => {
    if (sh.x == null) return;
    const rg = rdRingAt(i);
    if (rg) ellipse([sh.x, sh.y], rg.r[0], rg.r[1], rg.key ? "rgba(76,195,255,.75)" : "rgba(76,195,255,.3)", rg.key ? 1.4 : 1, rg.key ? null : [3, 3], rg.key ? "rgba(76,195,255,.05)" : null);
  });
  if (live) {
    c.strokeStyle = "rgba(255,107,107,.55)"; c.lineWidth = 1 * dpr;
    shots.forEach((sh, i) => { if (sh.x == null || !live[i] || i === 0) return; const [a, b] = P([sh.x, sh.y]), [x, y] = P(live[i]); c.beginPath(); c.moveTo(a, b); c.lineTo(x, y); c.stroke(); });
    poly(live, "#ffb224", 2);
  }
  const every = s > 40 ? 1 : s > 18 ? 5 : 10;
  shots.forEach((sh, i) => {
    const sel = i === rd.sel;
    if (live && live[i]) { const [x, y] = P(live[i]); c.fillStyle = sel ? "#ffd27a" : "#ffb224"; c.beginPath(); c.arc(x, y, (sel ? 4.5 : 3) * dpr, 0, 7); c.fill(); }
    if (sh.x == null) return;
    const [x, y] = P([sh.x, sh.y]);
    const rr = (sh.src === "manual" ? 5 : 4) * dpr;
    c.lineWidth = 1.6 * dpr;
    c.strokeStyle = sh.src === "after" ? "rgba(169,177,189,.7)" : sh.src === "first" ? "#fff" : "#4cc3ff";
    c.fillStyle = sh.src === "manual" ? "#4cc3ff" : sh.src === "first" ? "#fff" : "#0b0d11";
    c.beginPath(); c.arc(x, y, rr, 0, 7); c.fill(); c.stroke();
    if (rd.weight[i] === "lock" || rd.weight[i] === "strong") { c.beginPath(); c.arc(x, y, rr + 3 * dpr, 0, 7); c.stroke(); }
    if (sel) {
      c.strokeStyle = "#fff"; c.lineWidth = 2 * dpr; c.beginPath(); c.arc(x, y, rr + 5 * dpr, 0, 7); c.stroke();
      // ring handles: drag to resize the spread ring
      if (rings && i > 0 && rd.tool === "move") for (const h of rdRingHandles(i)) { const [hx, hy] = P(h.p); c.fillStyle = "#4cc3ff"; c.fillRect(hx - 3.5 * dpr, hy - 3.5 * dpr, 7 * dpr, 7 * dpr); }
    }
    if ((i + 1) % every === 0 || i === 0 || sel) { c.fillStyle = "rgba(238,241,245,.85)"; c.font = `${10 * dpr}px ${FONT}`; c.textAlign = "left"; c.textBaseline = "bottom"; c.fillText(String(i + 1), x + rr + 2 * dpr, y - 2 * dpr); }
  });
  c.fillStyle = "rgba(255,255,255,.6)"; c.font = `${11 * dpr}px ${FONT}`; c.textAlign = "left"; c.textBaseline = "alphabetic";
  const unit = s < 6 ? 5 : 1;
  c.fillRect(12 * dpr, cv.height - 14 * dpr, s * unit, 2 * dpr);
  c.fillText(`${unit} st at ${+$("rdDist").value || 50} st`, 12 * dpr, cv.height - 20 * dpr);
}
function rdRingHandles(i) {
  const sh = rdShotsList()[i];
  if (!sh || sh.x == null) return [];
  const rg = rdRingAt(i), r = rg ? rg.r : [0.3, 0.3];
  return [{ p: [sh.x + r[0], sh.y], axis: 0 }, { p: [sh.x, sh.y + r[1]], axis: 1 }];
}
/* the motion over time: camera, gun and view angles (degrees) */
const RD_MO = [
  { k: "camP", i: 1, label: "Camera ↕", color: "#ffb224" },
  { k: "camY", i: 2, label: "Camera ↔", color: "#ff7a45", dash: [4, 3] },
  { k: "gunP", i: 3, label: "Gun ↕", color: "#4cc3ff" },
  { k: "view", i: 6, label: "View shake ↕", color: "#b48cff" },
];
function rdDrawMotion() {
  const cv = $("rdMotion");
  if (!cv || $("rdModal").classList.contains("hidden")) return;
  const dpr = rdSizeCanvas(cv), c = cv.getContext("2d"), W = cv.width, H = cv.height;
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.fillStyle = "#0e1116"; c.fillRect(0, 0, W, H);
  $("rdLegend").innerHTML = RD_MO.map((m) => `<button class="rd-chip${rd.moShow[m.k] ? " on" : ""}" data-mo="${m.k}" style="--c:${m.color}">${m.label}</button>`).join("");
  const tr = rdShown() && rd.live.track;
  const st = $("rdSettle");
  if (!tr || !tr.length) { st.textContent = ""; return; }
  const t0 = tr[0][0], t1 = tr[tr.length - 1][0], last = rd.live.times && rd.live.times.length ? rd.live.times[rd.live.times.length - 1] : 0;
  const shown = RD_MO.filter((m) => rd.moShow[m.k]);
  let lo = 0, hi = 0;
  for (const row of tr) for (const m of shown) { lo = Math.min(lo, row[m.i]); hi = Math.max(hi, row[m.i]); }
  const pad = (hi - lo) * 0.1 || 0.5; lo -= pad; hi += pad;
  const L = 34 * dpr, R = 8 * dpr, T = 6 * dpr, B = 16 * dpr;
  const X = (t) => L + ((t - t0) / Math.max(t1 - t0, 1e-6)) * (W - L - R), Y = (v) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
  // after the last shot
  c.fillStyle = "rgba(255,255,255,.035)"; c.fillRect(X(last), T, W - R - X(last), H - T - B);
  c.strokeStyle = "rgba(255,255,255,.12)"; c.lineWidth = dpr; c.beginPath(); c.moveTo(L, Y(0)); c.lineTo(W - R, Y(0)); c.stroke();
  c.fillStyle = "rgba(255,255,255,.45)"; c.font = `${10 * dpr}px ${FONT}`; c.textAlign = "right"; c.textBaseline = "middle";
  c.fillText(`${hi.toFixed(1)}°`, L - 4 * dpr, Y(hi)); c.fillText(`${lo.toFixed(1)}°`, L - 4 * dpr, Y(lo)); c.fillText("0", L - 4 * dpr, Y(0));
  c.textAlign = "center"; c.textBaseline = "top";
  for (let t = Math.ceil(t0); t <= t1; t += 1) c.fillText(`${t}s`, X(t), H - B + 3 * dpr);
  c.textAlign = "left"; c.fillText("last shot", X(last) + 4 * dpr, T);
  for (const m of shown) {
    c.strokeStyle = m.color; c.lineWidth = 1.5 * dpr; c.setLineDash(m.dash ? m.dash.map((d) => d * dpr) : []);
    c.beginPath(); tr.forEach((row, j) => { const x = X(row[0]), y = Y(row[m.i]); j ? c.lineTo(x, y) : c.moveTo(x, y); }); c.stroke(); c.setLineDash([]);
  }
  const sv = rd.live.settle;
  st.innerHTML = sv == null ? `<span class="warn">The view is still off centre 3 s after the last shot</span>` : `Back at the centre <b>${sv.toFixed(2)} s</b> after the last shot`;
}
function rdFitView() {
  const pts = [...rd.ctrl, ...rdShotsList().filter((p) => p.x != null).map((p) => [p.x, p.y]), ...((rd.live && rd.live.path) || []), [-2.5, -3.5], [2.5, 2.5]];
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const cv = $("rdCanvas"), dpr = devicePixelRatio || 1, r = cv.getBoundingClientRect();
  const w = Math.max(...xs) - Math.min(...xs) + 2, h = Math.max(...ys) - Math.min(...ys) + 2;
  rd.view = { cx: (Math.max(...xs) + Math.min(...xs)) / 2, cy: (Math.max(...ys) + Math.min(...ys)) / 2, scale: Math.max(2, Math.min((r.width * dpr) / w, (r.height * dpr) / h)) };
  rdDraw();
}

/* ------------------------------------------------------------------ panels */
const RD_HELP = {
  line: "The line starts at shot 1 (it fires before any recoil) · click to add points along the path · drag a square to move it · right-click a square to delete it · wheel: zoom · right / middle drag: pan",
  place: "Each click puts the next shot (2, 3, 4… — shot 1 always lands where you aim) · right-click a shot to free it · wheel: zoom · right / middle drag: pan",
  move: "Click a shot to select it, drag to move it · drag the small squares to size its spread ring (Shift+wheel too) · arrows nudge it (Shift: more) · [ and ]: previous / next shot · Delete: free it",
};
/* the pattern changed: the last fit no longer matches it */
function rdChanged() {
  if (rd.fitInfo) rd.fitInfo.stale = true;
  rdShowResult(); rdRenderShot(); rdRingInfo(); rdDraw();
}
function rdRingInfo() {
  const keys = rdRingKeys();
  $("rdRingInfo").textContent = keys.length ? `${keys.length} shot${keys.length === 1 ? "" : "s"} with a ring; shots without one spread by Randomness (Camera tab).` : "No rings: Randomness on the Camera tab decides the spread.";
}
function rdRenderShot() {
  const box = $("rdShotBox"), i = rd.sel, shots = rdShotsList();
  if (i < 0 || i >= shots.length) { box.innerHTML = `<h3>Shot</h3><p class="hint">Pick <b>Move shots</b> and click a shot to edit it: where it should land, how much that counts and how widely it may spread.</p>`; return; }
  const live = rdShown() && rd.live.path[i], sg = rdShown() && rd.live.sigma && rd.live.sigma[i];
  const t = rd.live && rd.live.times && rd.live.times[i] != null ? `${(rd.live.times[i] * 1000).toFixed(0)} ms` : "";
  const nav = `<span class="rd-nav"><button class="iconbtn tiny" data-rdnav="-1" title="Previous shot ([)" ${i ? "" : "disabled"}>‹</button><button class="iconbtn tiny" data-rdnav="1" title="Next shot (])">›</button></span>`;
  if (i === 0) {
    const f = shots[0];
    box.innerHTML = `<h3>Shot 1 <span class="hint">of ${rd.n}</span>${nav}</h3>
      <p class="hint">The first shot fires before any recoil, so it always lands at <b>${f.x.toFixed(2)}, ${f.y.toFixed(2)}</b> (where you aim${rd.stance === "hip" ? ", from the hip" : ""}). The pattern — and the drawn line — starts here.</p>`;
    return;
  }
  const sh = shots[i], wn = rdWeightName(i, sh), rg = rdRingAt(i);
  const miss = live && sh.x != null ? Math.hypot(live[0] - sh.x, live[1] - sh.y) : null;
  const r = rg ? rg.r : [0, 0];
  box.innerHTML = `<h3>Shot ${i + 1} <span class="hint">of ${rd.n}${t ? ` · ${t}` : ""}</span>${nav}</h3>
    <div class="field"><label>Counts <span class="tip" data-tip="How tightly the recoil has to land on this shot: Free — anywhere; Soft — a little; Normal; Strong; Lock — as exactly as the springs allow.">?</span></label>
      <div class="seg mini" id="rdW">${["free", "soft", "normal", "strong", "lock"].map((k) => `<button data-v="${k}" class="${k === wn ? "on" : ""}">${k[0].toUpperCase() + k.slice(1)}</button>`).join("")}</div></div>
    <div class="field"><label>Spread ring <span class="tip" data-tip="How widely this shot may land around its point: left / right and up / down, in studs (about 19 magazines in 20 land inside). The shots between rings you set follow smoothly.">?</span></label>
      <div class="rd-ring"><span>↔ ±</span><input type="number" step="0.05" min="0" data-rdring="0" value="${rg ? r[0].toFixed(2) : ""}" placeholder="–"><span>↕ ±</span><input type="number" step="0.05" min="0" data-rdring="1" value="${rg ? r[1].toFixed(2) : ""}" placeholder="–"><span class="hint">st</span></div></div>
    <input type="range" class="rd-ringslider" id="rdRingSlider" min="0" max="5" step="0.05" value="${Math.max(r[0], r[1]).toFixed(2)}" title="Both directions together">
    <p class="hint">${rg ? `Its own ring. <button class="link" data-rdringclr="1">Remove</button>` : "No ring: it spreads by Randomness (Camera tab). Set one to choose."}</p>
    <p class="hint">${sh.src === "manual" ? "Placed by you." : sh.src === "line" ? "From the line." : sh.src === "after" ? "After the line (soft target)." : "Free: no target."}
      ${live ? ` Lands at <b>${live[0].toFixed(2)}, ${live[1].toFixed(2)}</b>${miss != null ? ` — ${miss.toFixed(3)} st from its target` : ""}${sg ? `, spreading ±${(2 * sg[0]).toFixed(2)} ↔ ±${(2 * sg[1]).toFixed(2)} ↕` : ""}.` : ""}</p>
    ${rd.manual[i] ? `<button class="link" data-rdunset="1">Back to the line</button>` : ""}`;
  paintRange($("rdRingSlider"));
}
function rdShowResult() {
  const box = $("rdResult");
  const shots = rdShotsList(), path = rd.live && rd.live.path;
  if (rd.hideLive) { $("rdResult").innerHTML = `<p class="hint wrap">Cleared. Draw a line, place shots or Copy pattern, then Combine Recoil.</p>`; rdFitButton(); return; }
  const targeted = shots.filter((p) => p.w > 0).length;
  if (!path) { box.innerHTML = `<p class="hint">Working out what the recoil does…</p>`; return; }
  let s2 = 0, sw = 0, worst = -1, wm = -1;
  shots.forEach((sh, i) => {
    if (sh.x == null || !sh.w || !path[i]) return;
    const m = Math.hypot(path[i][0] - sh.x, path[i][1] - sh.y);
    s2 += sh.w * m * m; sw += sh.w;
    if (m > wm) { wm = m; worst = i; }
  });
  const rms = sw ? Math.sqrt(s2 / sw) : null;
  const nx = (rd.recoil[rdCam()].x || []).length, ny = (rd.recoil[rdCam()].y || []).length;
  const fi = rd.fitInfo;
  let html = "";
  if (!fi) {
    html += `<p class="hint wrap">${targeted ? `${targeted} of ${rd.n - 1} shots targeted. ` : "No targets yet: draw a line, place shots or Copy pattern. "}Orange: the recoil you started from.</p>`;
  } else if (!targeted) html += `<p class="hint wrap">No targets yet: draw a line, place shots or Copy pattern.</p>`;
  else html += `<p><b>Average miss: ${rms.toFixed(3)} st</b>${worst >= 0 ? ` <span class="hint">· furthest: <button class="link" data-rdgo="${worst}">shot ${worst + 1}</button> (${wm.toFixed(3)} st)</span>` : ""}</p>
    <p class="hint">${targeted} of ${rd.n - 1} shots targeted · camera ${nx} + ${ny} layers</p>`;
  if (rd.fitInfo && rd.fitInfo.stale) html += `<p class="hint warn">Changed since the last Combine Recoil.</p>`;
  box.innerHTML = html;
  rdFitButton();
}
/* the Combine Recoil button says whether the result is up to date */
function rdFitButton() {
  const b = $("rdFit"), fi = rd.fitInfo;
  if (!b) return;
  b.classList.toggle("due", (!fi || fi.stale) && !rd.busy);
  b.textContent = rd.busy ? "Combining…" : "Combine Recoil";
}
function rdRenderLayers() {
  const box = $("rdLayersBox");
  if (!rd.recoil) { box.hidden = true; return; }
  box.hidden = false;
  rdSyncTags();
  const tagLabel = { punch: "punch", shake: "shake" };
  const row = (ax, r, i) => {
    const tag = rd.tags[ax][i];
    const lock = tag === "fit" ? "" : "checked";
    return `<tr class="${tag !== "fit" ? "locked" : ""}"${tagLabel[tag] ? ` title="The ${tagLabel[tag]} layer (from its slider; Combine Recoil keeps it)"` : ""}><td class="rc-n">${tagLabel[tag] ? tagLabel[tag][0].toUpperCase() : i + 1}</td>${r.map((v, j) => `<td><input type="number" step="any" data-rdl="${ax}|${i}|${j}" value="${+(+v).toFixed(4)}"></td>`).join("")}
      <td><label class="rd-lock" title="${tagLabel[tag] ? `The ${tagLabel[tag]} layer (from the slider)` : "Lock: Combine Recoil keeps this layer as it is and fits the others around it"}"><input type="checkbox" data-rdlock="${ax}|${i}" ${lock} ${tagLabel[tag] ? "disabled" : ""}></label></td>
      <td><button class="iconbtn tiny" data-rdldel="${ax}|${i}" title="Remove this layer">×</button></td></tr>`;
  };
  const g = rdCam();
  box.innerHTML = `<h3>Camera layers <span class="hint">· edits show live</span></h3>
    <table class="rc-grid rd-grid"><thead><tr><th></th><th title="1 = no overshoot; lower bounces">Damp</th><th title="How fast the spring moves">Speed</th><th title="Average kick per shot">Kick</th><th title="Random part of the kick (kick ± this)">Var</th><th title="Recovery spring: damping once no shot has come for the delay">Rec d</th><th title="Recovery spring: speed">Rec s</th><th title="Locked layers are kept by Combine Recoil"><svg class="ic tiny-ic"><use href="#i-lock"/></svg></th><th></th></tr></thead><tbody>
    ${["x", "y"].map((ax) => `<tr class="rc-ax"><td colspan="9"><b>${ax}</b> <span class="hint">${ax === "x" ? "pitch: up / down" : "yaw: left / right"} · delay ${(rd.recoil[g + "Recovery"][ax] || {}).delay ?? rd.delay}s</span><button class="link" data-rdladd="${ax}">+ layer</button></td></tr>${rdRows(ax).map((r, i) => row(ax, r, i)).join("")}`).join("")}
    </tbody></table>
    <div class="rd-row"><button class="btn small" id="rdRefit" title="Keep these springs (damping, speed, recovery) and work out the best kicks again">Re-fit kicks</button><button class="btn small" id="rdFromGunCam" title="Put the gun's own camera layers back (all locked), to build on them">Gun's camera layers</button></div>`;
}
function rdRenderParts() {
  const host = $("rdParts");
  const guns = allWeapons().map((w) => `<option value="gun:${esc(w.name)}">${esc(w.displayname || w.name)}</option>`).join("");
  host.innerHTML = RD_PARTS.map((P) => {
    const g = rdG(P.g), axes = Object.keys(P.axes);
    const rows = (ax) => {
      const fire = rd.recoil[g][ax] || [], rl = (rd.recoil[g + "Recovery"][ax] || {}).layers || [];
      return fire.map((r, i) => { const rr = rl[i] || [r[0], r[1]]; return `<tr><td class="rc-n">${i + 1}</td>${[...r, ...rr].map((v, j) => `<td><input type="number" step="any" data-rdp="${P.g}|${ax}|${i}|${j}" value="${+(+v).toFixed(4)}"></td>`).join("")}<td><button class="iconbtn tiny" data-rdpdel="${P.g}|${ax}|${i}" title="Remove this layer">×</button></td></tr>`; }).join("")
        || `<tr><td></td><td colspan="7" class="hint">No layers</td></tr>`;
    };
    return `<section class="rd-sec rd-part">
      <h3>${P.label}<select class="rd-preset" data-rdpreset="${P.g}"><option value="">Presets…</option>${Object.entries(RD_PRESETS).map(([k, v]) => `<option value="${k}">${v.label}</option>`).join("")}<option value="own">This gun's own</option><optgroup label="Copy from">${guns}</optgroup></select></h3>
      <p class="hint">${P.hint}</p>
      <table class="rc-grid rd-grid"><thead><tr><th></th><th>Damp</th><th>Speed</th><th>Kick</th><th>Var</th><th title="Recovery damping">Rec d</th><th title="Recovery speed">Rec s</th><th></th></tr></thead><tbody>
      ${axes.map((ax) => `<tr class="rc-ax"><td colspan="8"><b>${ax}</b> <span class="hint">${P.axes[ax]}</span> <label class="rc-delay">delay <input type="number" step="0.01" min="0" data-rdpdelay="${P.g}|${ax}" value="${+((rd.recoil[g + "Recovery"][ax] || {}).delay ?? 0.1).toFixed(3)}">s</label><button class="link" data-rdpadd="${P.g}|${ax}">+ layer</button></td></tr>${rows(ax)}`).join("")}
      </tbody></table></section>`;
  }).join("");
}
function rdSelect(i, reveal = true) {
  rd.sel = Math.max(-1, Math.min(rd.n - 1, i));
  if (rd.sel >= 0 && reveal && rd.tab !== "shots") rdSetTab("shots");
  rdRenderShot(); rdDraw();
  if (rd.sel >= 0 && reveal) {
    const box = $("rdShotBox");
    box.scrollIntoView({ block: "nearest", behavior: "smooth" });
    box.classList.remove("flash"); void box.offsetWidth; box.classList.add("flash");
  }
}
function rdSetTab(v) {
  rd.tab = v; rd.setTab(v);
  document.querySelectorAll("[data-rdpane]").forEach((p) => p.classList.toggle("hidden", p.dataset.rdpane !== v));
  if (v === "camera") rdRenderLayers();
  if (v === "parts") rdRenderParts();
}

/* ------------------------------------------------------------------ open / sources */
async function rdLoadSource(src) {
  rd.source = src;
  rd.hideLive = false;
  let rec;
  if (src === "this:game") rec = await rcBase(rd.weapon);
  else if (src.startsWith("gun:")) rec = await rcBase(src.slice(4));
  else rec = await rcCurrent(rd.weapon);
  rd.recoil = clone(rec);
  rd.tags = { x: [], y: [] }; rdSyncTags();
  rd.fitInfo = null; rd.partsChanged = false;
}
function rdSourceOptions() {
  const cur = state.weaponInfo ? state.weaponInfo.displayname : state.weapon;
  $("rdSource").innerHTML = `<option value="this:edited">${esc(cur)} — as it is now</option><option value="this:game">${esc(cur)} — game values</option><optgroup label="Another gun's recoil">${allWeapons().filter((w) => w.name !== rd.weapon).map((w) => `<option value="gun:${esc(w.name)}">${esc(w.displayname || w.name)}</option>`).join("")}</optgroup>`;
  $("rdSource").value = rd.source;
}
async function openDesigner() {
  const fresh = rd.weapon !== state.weapon;
  rd.weapon = state.weapon;
  $("rdGun").textContent = `· ${state.weaponInfo ? state.weaponInfo.displayname : state.weapon}`;
  if (fresh) {
    rd.n = rd.cover = (state.stats && state.stats.magsize) || 30;
    rd.ctrl = []; rd.manual = {}; rd.weight = {}; rd.ring = {}; rd.sel = -1; rd.undo = []; rd.redo = [];
    rd.source = "this:edited"; rd.live = null; rd.scatter = null; rd.hideLive = false;
    $("rdDist").value = settings().distance;
    rd.stance = rc.stance;
  }
  rdSourceOptions();
  $("rdShots").value = rd.n; $("rdCover").value = rd.cover;
  rd.setStance(rd.stance);
  $("rdApply").textContent = `Use it on this gun (${rd.stance === "aim" ? "aimed" : "hip fire"})`;
  openModal("rdModal");
  rdFitButton();
  if (fresh || !rd.recoil) await rdLoadSource(rd.source);
  rdSetTab(rd.tab || "shots");
  rdRingInfo();
  await rdLive(true);
  if (fresh) rdFitView(); else rdDraw();
}
function rdHitShot(sx, sy, cv) {
  // a shot's target marker or its orange landing dot, whichever is nearest
  const dpr = devicePixelRatio || 1, shots = rdShotsList();
  let best = -1, bd = 12 * dpr;
  shots.forEach((sh, i) => {
    for (const p of [sh.x != null ? [sh.x, sh.y] : null, rdShown() && rd.live.path[i]]) {
      if (!p) continue;
      const [x, y] = rdToScreen(p[0], p[1], cv), d = Math.hypot(x - sx, y - sy);
      if (d < bd) { bd = d; best = i; }
    }
  });
  return best;
}
function rdHitCtrl(sx, sy, cv) {
  const dpr = devicePixelRatio || 1;
  for (let i = rd.ctrl.length - 1; i >= 1; i--) { const [x, y] = rdToScreen(rd.ctrl[i][0], rd.ctrl[i][1], cv); if (Math.hypot(x - sx, y - sy) < 9 * dpr) return i; }
  return -1;
}
function rdHitRing(sx, sy, cv) {
  if (rd.tool !== "move" || rd.sel < 1 || !$("rdRings").checked) return null;
  const dpr = devicePixelRatio || 1;
  for (const h of rdRingHandles(rd.sel)) { const [x, y] = rdToScreen(h.p[0], h.p[1], cv); if (Math.hypot(x - sx, y - sy) < 8 * dpr) return h.axis; }
  return null;
}
function rdSetRing(i, axis, v) {
  const cur = rdRingAt(i), r = cur ? [...cur.r] : [0.3, 0.3];
  v = Math.max(0, Math.round(v * 100) / 100);
  if (axis == null) { r[0] = v; r[1] = v; } else r[axis] = v;
  rd.ring[i] = r;
}

/* ------------------------------------------------------------------ fitting */
function rdPerShotLayers() {
  // punch (fast pitch kick) and side shake (fast random yaw) layers, kept as they are by the fit
  const out = { x: [], y: [] };
  if (rd.punch > 0) out.x.push({ row: [0.5, 70, rd.punch, +(rd.punch * 0.15).toFixed(3), 0.85, 15], tag: "punch" });
  if (rd.shake > 0) out.y.push({ row: [0.75, 25, 0, rd.shake, 0.65, 15], tag: "shake" });
  return out;
}
async function rdRunFit(refit) {
  const shots = rdShotsList();
  if (shots.filter((s) => s.w > 0).length < 2) { toast("Give at least two shots a place to land first."); return; }
  if (rd.busy) return;
  rd.busy = true; $("rdFit").disabled = true; rdFitButton();
  $("rdResult").innerHTML = `<p class="hint">Working out the recoil…</p>`;
  rdSyncTags();
  const extra = rdPerShotLayers(), locked = { x: [], y: [] }, newTags = { x: [], y: [] }, springs = { x: [], y: [] };
  for (const ax of ["x", "y"]) {
    rdRows(ax).forEach((r, i) => {
      const tag = rd.tags[ax][i];
      if (tag === "lock") { locked[ax].push(r); newTags[ax].push("lock"); }
      else if (tag === "fit") springs[ax].push([r[0], r[1], r[4], r[5]]);
    });
    for (const e of extra[ax]) { locked[ax].push(e.row); newTags[ax].push(e.tag); }
  }
  const keys = rdRingKeys();
  const spread = keys.length ? shots.map((sh, i) => { const rg = rdRingAt(i); return rg ? [rg.r[0] / 2, rg.r[1] / 2] : null; }) : null;
  try {
    const r = await api("/api/recoil/fit", rdSimReq({
      points: shots.map((s) => (s.x == null ? null : [s.x, s.y])), weights: shots.map((s) => s.w),
      layers: refit ? undefined : rd.layers, springs: refit ? springs : undefined, feel: rd.feel, variance: rd.variance, smooth: rd.smooth,
      recoil: rd.recoil, locked, spread,
      recovery: { damping: rd.recD, speed: rd.recS, delay: rd.delay, snap: rd.snapOn ? rd.snap : null },
    }), undefined, 180000);
    rd.recoil = r.recoil;
    for (const ax of ["x", "y"]) rd.tags[ax] = [...newTags[ax], ...Array((r.layers[ax].length - newTags[ax].length)).fill("fit")];
    rd.live = { path: r.path, sigma: r.sigma, track: r.track, settle: r.settle, times: r.times };
    rd.hideLive = false;
    rd.fitInfo = { rms: r.rms, spread: r.spread_fit };
    rd.scatter = null;
    rdRenderLayers(); rdAfterLive();
    if ($("rdSpread").checked) rdLive();
  } catch (e) { $("rdResult").innerHTML = `<p class="error">${esc(e.message)}</p>`; }
  finally { rd.busy = false; $("rdFit").disabled = false; rdFitButton(); }
}
/* the design's groups for its stance, put into a recoil table */
function rdMergeInto(rec) {
  for (const part of ["CameraBody", "Rotation", "Translation", "CameraHead"]) {
    const g = rdG(part);
    rec[g] = clone(rd.recoil[g]); rec[g + "Recovery"] = clone(rd.recoil[g + "Recovery"]);
  }
  return rec;
}
const rdTest = { prev: undefined, aiming: null, active: false };
async function rdStartTest() {
  const w = rd.weapon;
  if (w !== state.weapon) { toast("The range's gun changed — open the designer again."); return; }
  rdTest.prev = state.recoilEdits[w]; rdTest.aiming = state.aiming; rdTest.active = true;
  state.recoilEdits[w] = rdMergeInto(clone(await rcCurrent(w)));
  state.aiming = rd.stance === "aim"; setAimSeg(state.aiming ? "aim" : "hip");
  closeModal("rdModal");
  $("rdTestBar").classList.remove("hidden");
  onLoadoutChanged();
  setTimeout(() => fireMag(), 250);
}
function rdEndTest(keep) {
  if (!rdTest.active) return;
  rdTest.active = false;
  $("rdTestBar").classList.add("hidden");
  const w = rd.weapon;
  const design = state.recoilEdits[w];
  if (rdTest.prev === undefined) delete state.recoilEdits[w]; else state.recoilEdits[w] = rdTest.prev;
  state.aiming = rdTest.aiming; setAimSeg(state.aiming ? "aim" : "hip");
  if (keep) { rcEdit((r) => { Object.assign(r, clone(design)); }); toast("New recoil in use.", 2500); }
  else onLoadoutChanged();
}

/* ------------------------------------------------------------------ wiring */
function wireDesigner() {
  const cv = $("rdCanvas");
  $("rdLayers").innerHTML = [`<option value="auto">Auto</option>`, ...Array.from({ length: 16 }, (_, i) => `<option value="${i + 1}">${i + 1} per direction</option>`)].join("");
  $("rdLayers").addEventListener("change", () => { rd.layers = $("rdLayers").value === "auto" ? "auto" : +$("rdLayers").value; });
  rd.setTab = seg("rdTabs", (v) => rdSetTab(v));
  rd.setStance = seg("rdStance", async (v) => {
    rd.stance = v; rd.hideLive = false; $("rdApply").textContent = `Use it on this gun (${v === "aim" ? "aimed" : "hip fire"})`;
    rd.fitInfo = null; rdSyncTags(); rd.tags = { x: [], y: [] }; rdSyncTags();
    if (rd.tab === "camera") rdRenderLayers();
    if (rd.tab === "parts") rdRenderParts();
    await rdLive(true); rdChanged();
  });
  rd.setTool = seg("rdTool", (v) => { rd.tool = v; $("rdHelp").textContent = RD_HELP[v]; rdDraw(); });
  $("rdHelp").textContent = RD_HELP.line;
  rd.setAfter = seg("rdAfter", (v) => { rdPush(); rd.after = v; rdChanged(); });
  rd.setFeel = seg("rdFeel", (v) => { rd.feel = v; });
  const slider = (id, valId, fmt, fn) => { $(id).addEventListener("input", () => { paintRange($(id)); $(valId).textContent = fmt(+$(id).value); fn(+$(id).value); }); paintRange($(id)); };
  slider("rdVar", "rdVarVal", (v) => `${v}%`, (v) => { rd.variance = v / 100; });
  slider("rdCalm", "rdCalmVal", (v) => `${v}%`, (v) => { rd.smooth = v / 100; });
  slider("rdSnap", "rdSnapVal", (v) => `${v.toFixed(2)} s`, (v) => { rd.snap = v; });
  slider("rdPunch", "rdPunchVal", (v) => v.toFixed(2), (v) => { rd.punch = v; });
  slider("rdShake", "rdShakeVal", (v) => v.toFixed(2), (v) => { rd.shake = v; });
  $("rdSnapOn").addEventListener("change", () => { rd.snapOn = $("rdSnapOn").checked; $("rdSnap").disabled = !rd.snapOn; });
  const num = (id, key, lo, hi) => $(id).addEventListener("change", () => { const v = +$(id).value; rd[key] = Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : rd[key]; $(id).value = rd[key]; });
  num("rdRecD", "recD", 0.3, 3); num("rdRecS", "recS", 3, 90); num("rdDelay", "delay", 0, 2);
  $("rdSource").addEventListener("change", async () => { await rdLoadSource($("rdSource").value); rdRenderLayers(); if (rd.tab === "parts") rdRenderParts(); await rdLive(true); toast("Starting from that recoil — Copy pattern puts its shots on the canvas.", 3000); });
  $("rdShots").addEventListener("change", async () => {
    rdPush();
    const was = rd.n;
    rd.n = Math.max(2, Math.min(300, Math.round(+$("rdShots").value || was)));
    if (rd.cover === was || rd.cover > rd.n) rd.cover = rd.n;
    $("rdShots").value = rd.n; $("rdCover").value = rd.cover;
    for (const o of [rd.manual, rd.ring, rd.weight]) for (const k of Object.keys(o)) if (+k >= rd.n) delete o[k];
    await rdLive(true); rdChanged();
  });
  $("rdCover").addEventListener("change", () => { rdPush(); rd.cover = Math.max(2, Math.min(rd.n, Math.round(+$("rdCover").value || rd.n))); $("rdCover").value = rd.cover; rdChanged(); });
  $("rdDist").addEventListener("change", async () => { await rdLive(true); rdChanged(); });
  $("rcDesign").addEventListener("click", openDesigner);
  $("rdClose").addEventListener("click", () => closeModal("rdModal"));
  $("rdUndo").addEventListener("click", () => { if (rd.undo.length) { rd.redo.push(rdSnap()); rdRestore(rd.undo.pop()); } });
  $("rdRedo").addEventListener("click", () => { if (rd.redo.length) { rd.undo.push(rdSnap()); rdRestore(rd.redo.pop()); } });
  $("rdClear").addEventListener("click", async () => {
    // the pattern, and the camera back to what the design started from (Gun & view edits stay)
    rdPush();
    rd.ctrl = []; rd.manual = {}; rd.weight = {}; rd.ring = {}; rd.sel = -1;
    const src = rd.source === "this:game" ? await rcBase(rd.weapon) : rd.source.startsWith("gun:") ? await rcBase(rd.source.slice(4)) : await rcCurrent(rd.weapon);
    const g = rdCam();
    for (const ax of ["x", "y"]) { rd.recoil[g][ax] = clone(src[g][ax] || []); rd.recoil[g + "Recovery"][ax] = clone(src[g + "Recovery"][ax] || { layers: [], delay: 0.1 }); }
    rd.tags = { x: [], y: [] }; rdSyncTags();
    rd.fitInfo = null; rd.scatter = null; $("rdSpread").checked = false;
    rd.hideLive = true;
    rdRenderLayers(); rdChanged(); rdDrawMotion(); rdLive();
  });
  $("rdReset").addEventListener("click", async () => {
    // everything back to how the designer opens for this gun
    rdPush();
    rd.ctrl = []; rd.manual = {}; rd.weight = {}; rd.ring = {}; rd.sel = -1;
    rd.n = rd.cover = (state.stats && state.stats.magsize) || 30;
    $("rdShots").value = rd.n; $("rdCover").value = rd.cover;
    rd.after = "settle"; rd.setAfter("settle");
    $("rdDist").value = settings().distance;
    // Camera tab settings
    Object.assign(rd, { feel: "game", layers: "auto", variance: 0.3, smooth: 0.3, snap: 0.6, snapOn: true, recD: 0.85, recS: 15, delay: 0.1, punch: 0, shake: 0 });
    rd.setFeel("game"); $("rdLayers").value = "auto";
    for (const [id, v] of [["rdVar", 30], ["rdCalm", 30], ["rdSnap", 0.6], ["rdPunch", 0], ["rdShake", 0]]) { $(id).value = v; $(id).dispatchEvent(new Event("input")); }
    $("rdSnapOn").checked = true; $("rdSnap").disabled = false;
    $("rdRecD").value = 0.85; $("rdRecS").value = 15; $("rdDelay").value = 0.1;
    // the recoil: every part back to the gun's as it is now
    rd.source = "this:edited"; $("rdSource").value = rd.source;
    rd.hideLive = false;
    await rdLoadSource(rd.source);
    rd.scatter = null; $("rdSpread").checked = false;
    rdRenderLayers(); if (rd.tab === "parts") rdRenderParts();
    rdChanged(); await rdLive(true); rdFitView();
    toast("Designer reset — Undo brings the pattern and recoil back.", 2500);
  });
  $("rdMirror").addEventListener("click", () => {
    rdPush();
    const fx = rdFirst()[0];
    rd.ctrl = rd.ctrl.map(([x, y]) => [2 * fx - x, y]);
    for (const k of Object.keys(rd.manual)) rd.manual[k] = [2 * fx - rd.manual[k][0], rd.manual[k][1]];
    rdChanged();
  });
  $("rdSmooth").addEventListener("click", () => {
    rdPush();
    const sm = (P) => P.map((p, i) => (i === 0 || i === P.length - 1 ? p : [(P[i - 1][0] + 2 * p[0] + P[i + 1][0]) / 4, (P[i - 1][1] + 2 * p[1] + P[i + 1][1]) / 4]));
    if (rd.ctrl.length > 2) rd.ctrl = sm(rd.ctrl);
    const keys = Object.keys(rd.manual).map(Number).sort((a, b) => a - b);
    if (keys.length > 2) { const sp = sm(keys.map((k) => rd.manual[k])); keys.forEach((k, i) => { rd.manual[k] = sp[i]; }); }
    rdChanged();
  });
  $("rdFromGun").addEventListener("click", () => {
    if (!rd.live) return;
    rdPush();
    rd.hideLive = false;
    rd.ctrl = []; rd.weight = {}; rd.manual = {}; rd.ring = {};
    rd.live.path.forEach((p, i) => {
      if (!i) return;
      rd.manual[i] = [+p[0].toFixed(3), +p[1].toFixed(3)];
      const sg = rd.live.sigma && rd.live.sigma[i];
      if (sg) rd.ring[i] = [+(2 * sg[0]).toFixed(3), +(2 * sg[1]).toFixed(3)];
    });
    rd.tool = "move"; rd.setTool("move"); $("rdHelp").textContent = RD_HELP.move;
    rdChanged(); rdFitView();
  });
  // spread rings for every shot
  $("rdRingSet").addEventListener("click", () => { const v = Math.max(0, +$("rdRingAll").value || 0); rdPush(); rd.ring = {}; for (let i = 1; i < rd.n; i++) rd.ring[i] = [v, v]; rdChanged(); });
  $("rdRingGrow").addEventListener("click", () => {
    const v = Math.max(0, +$("rdRingAll").value || 0); rdPush(); rd.ring = {};
    for (let i = 1; i < rd.n; i++) { const r = +(v * (0.2 + 0.8 * Math.sqrt((i - 1) / Math.max(1, rd.n - 2)))).toFixed(3); rd.ring[i] = [r, r]; }
    rdChanged();
  });
  $("rdRingClear").addEventListener("click", () => { rdPush(); rd.ring = {}; rdChanged(); });
  $("rdRings").addEventListener("change", () => rdDraw());
  $("rdSpread").addEventListener("change", () => { if ($("rdSpread").checked) rdLive(); else { rd.scatter = null; rdDraw(); } });
  $("rdZoomIn").addEventListener("click", () => { rd.view.scale *= 1.25; rdDraw(); });
  $("rdZoomOut").addEventListener("click", () => { rd.view.scale /= 1.25; rdDraw(); });
  $("rdZoomFit").addEventListener("click", rdFitView);
  $("rdLegend").addEventListener("click", (e) => { const b = e.target.closest("[data-mo]"); if (b) { rd.moShow[b.dataset.mo] = !rd.moShow[b.dataset.mo]; rdDrawMotion(); } });
  // canvas
  cv.addEventListener("contextmenu", (e) => e.preventDefault());
  const local = (e) => { const dpr = devicePixelRatio || 1, r = cv.getBoundingClientRect(); return [(e.clientX - r.left) * dpr, (e.clientY - r.top) * dpr]; };
  cv.addEventListener("mousedown", (e) => {
    cv.focus();
    const [sx, sy] = local(e);
    if (e.button === 2) {
      if (rd.tool === "line") { const h = rdHitCtrl(sx, sy, cv); if (h >= 1) { rdPush(); rd.ctrl.splice(h, 1); if (rd.ctrl.length < 2) rd.ctrl = []; rdChanged(); return; } }
      else { const h = rdHitShot(sx, sy, cv); if (h > 0) { rdPush(); delete rd.manual[h]; if (rd.tool === "move") rd.weight[h] = "free"; rdChanged(); return; } }
    }
    if (e.button === 1 || e.button === 2) { rd.drag = { pan: true, sx, sy, cx: rd.view.cx, cy: rd.view.cy }; return; }
    if (e.button !== 0) return;
    const w = rdToWorld(sx, sy, cv).map((v) => +v.toFixed(3));
    if (rd.tool === "line") {
      const h = rdHitCtrl(sx, sy, cv);
      rdPush();
      if (h >= 1) rd.drag = { ctrl: h };
      else {
        if (!rd.ctrl.length) rd.ctrl.push(rdFirst());
        rd.ctrl.push(w); rd.drag = { ctrl: rd.ctrl.length - 1 }; rdChanged();
      }
    } else if (rd.tool === "place") {
      const hit = rdHitShot(sx, sy, cv);
      if (hit >= 0 && (hit === 0 || rd.manual[hit])) { rdSelect(hit); if (hit > 0) { rdPush(); rd.drag = { shot: hit }; } return; }
      let i = 1;
      while (i < rd.n && rd.manual[i]) i++;
      if (i >= rd.n) { toast("Every shot of the magazine is placed — use Move shots to change them."); return; }
      rdPush(); rd.manual[i] = w; delete rd.weight[i]; rd.sel = i; rdChanged();
    } else {
      const ra = rdHitRing(sx, sy, cv);
      if (ra != null) { rdPush(); rd.drag = { ring: rd.sel, axis: ra }; return; }
      const h = rdHitShot(sx, sy, cv);
      rdSelect(h);
      if (h > 0) { rdPush(); rd.drag = { shot: h }; }
    }
  });
  window.addEventListener("mousemove", (e) => {
    if (!rd.drag) return;
    const [sx, sy] = local(e);
    if (rd.drag.pan) { rd.view.cx = rd.drag.cx - (sx - rd.drag.sx) / rd.view.scale; rd.view.cy = rd.drag.cy + (sy - rd.drag.sy) / rd.view.scale; rdDraw(); return; }
    const w = rdToWorld(sx, sy, cv).map((v) => +v.toFixed(3));
    if (rd.drag.ctrl != null) rd.ctrl[rd.drag.ctrl] = w;
    else if (rd.drag.shot != null) { rd.manual[rd.drag.shot] = w; if (rd.weight[rd.drag.shot] === "free") delete rd.weight[rd.drag.shot]; }
    else if (rd.drag.ring != null) { const sh = rdShotsList()[rd.drag.ring]; rdSetRing(rd.drag.ring, rd.drag.axis, rd.drag.axis === 0 ? Math.abs(w[0] - sh.x) : Math.abs(w[1] - sh.y)); }
    rd.drag.moved = true;
    rdChanged();
  });
  window.addEventListener("mouseup", () => { if (rd.drag && !rd.drag.pan && !rd.drag.moved && rd.undo.length) rd.undo.pop(); rd.drag = null; });
  cv.addEventListener("wheel", (e) => {
    e.preventDefault();
    if (e.shiftKey && rd.sel > 0) {
      const rg = rdRingAt(rd.sel), r = rg ? rg.r : [0.3, 0.3], f = e.deltaY < 0 ? 1.08 : 1 / 1.08;
      rd.ring[rd.sel] = [+(r[0] * f).toFixed(3), +(r[1] * f).toFixed(3)];
      rdChanged(); return;
    }
    const [sx, sy] = local(e), [wx, wy] = rdToWorld(sx, sy, cv);
    rd.view.scale = Math.max(2, Math.min(800, rd.view.scale * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
    const [nx, ny] = rdToWorld(sx, sy, cv);
    rd.view.cx += wx - nx; rd.view.cy += wy - ny;
    rdDraw();
  }, { passive: false });
  document.addEventListener("keydown", (e) => {
    if ($("rdModal").classList.contains("hidden")) return;
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); rdRunFit(false); return; }
    if (e.target.matches("input, select, textarea")) return;
    const k = e.key;
    if ((e.ctrlKey || e.metaKey) && k.toLowerCase() === "z") { e.preventDefault(); $("rdUndo").click(); return; }
    if ((e.ctrlKey || e.metaKey) && k.toLowerCase() === "y") { e.preventDefault(); $("rdRedo").click(); return; }
    const tool = { l: "line", p: "place", m: "move" }[k.toLowerCase()];
    if (tool && !e.ctrlKey && !e.metaKey) { rd.tool = tool; rd.setTool(tool); $("rdHelp").textContent = RD_HELP[tool]; rdDraw(); return; }
    if (k === "[" || k === "]") { rdSelect(rd.sel < 0 ? 0 : rd.sel + (k === "]" ? 1 : -1)); return; }
    if (rd.sel < 1) return;
    const sh = rdShotsList()[rd.sel];
    if (k.startsWith("Arrow") && sh) {
      e.preventDefault();
      const d = e.shiftKey ? 0.25 : 0.05, base = sh.x != null ? [sh.x, sh.y] : (rd.live && rd.live.path[rd.sel]) || [0, 0];
      rdPush();
      rd.manual[rd.sel] = [+(base[0] + (k === "ArrowRight" ? d : k === "ArrowLeft" ? -d : 0)).toFixed(3), +(base[1] + (k === "ArrowUp" ? d : k === "ArrowDown" ? -d : 0)).toFixed(3)];
      if (rd.weight[rd.sel] === "free") delete rd.weight[rd.sel];
      rdChanged();
    } else if (k === "Delete" || k === "Backspace") { rdPush(); delete rd.manual[rd.sel]; rd.weight[rd.sel] = "free"; rdChanged(); }
  });
  window.addEventListener("resize", () => { rdDraw(); rdDrawMotion(); });
  // the selected-shot panel
  $("rdShotBox").addEventListener("click", (e) => {
    const nav = e.target.closest("[data-rdnav]"), wb = e.target.closest("#rdW button"), un = e.target.closest("[data-rdunset]"), rc0 = e.target.closest("[data-rdringclr]");
    if (nav) rdSelect(rd.sel + +nav.dataset.rdnav);
    else if (wb) { rdPush(); rd.weight[rd.sel] = wb.dataset.v; rdChanged(); }
    else if (un) { rdPush(); delete rd.manual[rd.sel]; rdChanged(); }
    else if (rc0) { rdPush(); delete rd.ring[rd.sel]; rdChanged(); }
  });
  $("rdShotBox").addEventListener("change", (e) => {
    const inp = e.target.closest("[data-rdring]");
    if (!inp || rd.sel < 1) return;
    rdPush();
    if (inp.value === "") delete rd.ring[rd.sel];
    else rdSetRing(rd.sel, +inp.dataset.rdring, +inp.value);
    rdChanged();
  });
  $("rdShotBox").addEventListener("input", (e) => {
    if (e.target.id !== "rdRingSlider" || rd.sel < 1) return;
    rdSetRing(rd.sel, null, +e.target.value);
    rdDraw();
    const box = $("rdShotBox");
    box.querySelectorAll("[data-rdring]").forEach((x) => { x.value = (+e.target.value).toFixed(2); });
    paintRange(e.target);
  });
  $("rdShotBox").addEventListener("change", (e) => { if (e.target.id === "rdRingSlider") { rdPush(); rdChanged(); } });
  $("rdResult").addEventListener("click", (e) => { const g = e.target.closest("[data-rdgo]"); if (g) { rd.tool = "move"; rd.setTool("move"); $("rdHelp").textContent = RD_HELP.move; rdSetTab("shots"); rdSelect(+g.dataset.rdgo); } });
  // camera layers: edit live, lock, add / remove, re-fit the kicks
  $("rdLayersBox").addEventListener("change", (e) => {
    const inp = e.target.closest("[data-rdl]"), lk = e.target.closest("[data-rdlock]");
    if (lk) { const [ax, i] = lk.dataset.rdlock.split("|"); rdSyncTags(); rd.tags[ax][+i] = lk.checked ? (rd.tags[ax][+i] === "fit" ? "lock" : rd.tags[ax][+i]) : "fit"; rdRenderLayers(); return; }
    if (!inp) return;
    const [ax, i, j] = inp.dataset.rdl.split("|");
    const v = +inp.value;
    if (!Number.isFinite(v)) { rdRenderLayers(); return; }
    const rows = rdRows(ax);
    rows[+i][+j] = v;
    rdSetRows(ax, rows);
    if (rd.fitInfo) rd.fitInfo.stale = true;
    rd.hideLive = false;
    rdLive();
  });
  $("rdLayersBox").addEventListener("click", async (e) => {
    const add = e.target.closest("[data-rdladd]"), del = e.target.closest("[data-rdldel]");
    if (add) { const ax = add.dataset.rdladd, rows = rdRows(ax); rows.push(rows.length ? [...rows[rows.length - 1].slice(0, 2), 0, 0, ...rows[rows.length - 1].slice(4)] : [1, 20, 0, 0, rd.recD, rd.recS]); rdSetRows(ax, rows); rd.tags[ax].push("lock"); rdRenderLayers(); rdLive(); }
    else if (del) { const [ax, i] = del.dataset.rdldel.split("|"); const rows = rdRows(ax); rows.splice(+i, 1); rdSetRows(ax, rows); rd.tags[ax].splice(+i, 1); rdRenderLayers(); rdLive(); }
    else if (e.target.closest("#rdRefit")) rdRunFit(true);
    else if (e.target.closest("#rdFromGunCam")) {
      const base = await rcBase(rd.weapon), g = rdCam();
      rd.recoil[g].x = clone(base[g].x); rd.recoil[g].y = clone(base[g].y);
      rd.recoil[g + "Recovery"].x = clone(base[g + "Recovery"].x); rd.recoil[g + "Recovery"].y = clone(base[g + "Recovery"].y);
      rd.tags = { x: base[g].x.map(() => "lock"), y: base[g].y.map(() => "lock") };
      rdRenderLayers(); rdLive();
    }
  });
  // gun & view parts
  const partEdit = () => { rd.hideLive = false; rd.partsChanged = true; if (rd.fitInfo) rd.fitInfo.stale = true; rdLive(); };
  $("rdParts").addEventListener("change", async (e) => {
    const inp = e.target.closest("[data-rdp]"), dl = e.target.closest("[data-rdpdelay]"), pre = e.target.closest("[data-rdpreset]");
    if (inp) {
      const [part, ax, i, j] = inp.dataset.rdp.split("|"), g = rdG(part), v = +inp.value;
      if (!Number.isFinite(v)) { rdRenderParts(); return; }
      const fire = rd.recoil[g][ax], rec = rd.recoil[g + "Recovery"][ax] || (rd.recoil[g + "Recovery"][ax] = { layers: [], delay: 0.1 });
      while (rec.layers.length < fire.length) rec.layers.push(fire[rec.layers.length].slice(0, 2));
      if (+j < 4) fire[+i][+j] = v; else rec.layers[+i][+j - 4] = v;
      partEdit();
    } else if (dl) {
      const [part, ax] = dl.dataset.rdpdelay.split("|"), g = rdG(part);
      (rd.recoil[g + "Recovery"][ax] || (rd.recoil[g + "Recovery"][ax] = { layers: [], delay: 0.1 })).delay = Math.max(0, +dl.value || 0);
      partEdit();
    } else if (pre && pre.value) {
      const part = pre.dataset.rdpreset, g = rdG(part), v = pre.value;
      const P = RD_PARTS.find((p) => p.g === part), axes = Object.keys(P.axes);
      let src = null;
      if (v === "own") src = await rcBase(rd.weapon);
      else if (v.startsWith("gun:")) src = await rcBase(v.slice(4));
      for (const ax of axes) {
        let rows, rec, delay = 0.1;
        if (src) { rows = clone(src[g][ax] || []); rec = clone(((src[g + "Recovery"] || {})[ax] || {}).layers || []); delay = ((src[g + "Recovery"] || {})[ax] || {}).delay ?? 0.1; }
        else {
          const pr = RD_PRESETS[v], b = RD_PRESET_BASE[part][ax];
          rows = pr.rows || !b ? [] : [[+(Math.min(3, b[0] * (pr.damp ? pr.damp / 0.8 : 1))).toFixed(3), +(b[1] * (pr.fast || 1) * (pr.slow || 1)).toFixed(2), +(b[2] * pr.k).toFixed(3), +(b[3] * pr.k).toFixed(3)]];
          if (pr.damp && rows.length) rows[0][0] = pr.damp;
          rec = rows.map((r) => [0.85, Math.max(10, Math.min(30, r[1] * 0.8))].map((x) => +x.toFixed(2)));
        }
        while (rec.length < rows.length) rec.push(rows[rec.length].slice(0, 2));
        rd.recoil[g][ax] = rows;
        rd.recoil[g + "Recovery"][ax] = { layers: rec.slice(0, rows.length), delay };
      }
      rdRenderParts(); partEdit();
    }
  });
  $("rdParts").addEventListener("click", (e) => {
    const add = e.target.closest("[data-rdpadd]"), del = e.target.closest("[data-rdpdel]");
    if (add) {
      const [part, ax] = add.dataset.rdpadd.split("|"), g = rdG(part);
      const fire = rd.recoil[g][ax] || (rd.recoil[g][ax] = []), rec = rd.recoil[g + "Recovery"][ax] || (rd.recoil[g + "Recovery"][ax] = { layers: [], delay: 0.1 });
      while (rec.layers.length < fire.length) rec.layers.push(fire[rec.layers.length].slice(0, 2));
      const b = (RD_PRESET_BASE[part] || {})[ax] || [0.8, 20, 0, 0];
      fire.push(fire.length ? [...fire[fire.length - 1].slice(0, 2), 0, 0] : [b[0], b[1], 0, 0]);
      rec.layers.push([0.85, 15]);
      rdRenderParts(); partEdit();
    } else if (del) {
      const [part, ax, i] = del.dataset.rdpdel.split("|"), g = rdG(part);
      rd.recoil[g][ax].splice(+i, 1);
      const rec = rd.recoil[g + "Recovery"][ax];
      if (rec && rec.layers.length > +i) rec.layers.splice(+i, 1);
      rdRenderParts(); partEdit();
    }
  });
  $("rdFit").addEventListener("click", () => rdRunFit(false));
  $("rdApply").addEventListener("click", async () => {
    if (rd.weapon !== state.weapon) { toast("The range's gun changed — open the designer again."); return; }
    await rcEdit((r) => rdMergeInto(r));
    rc.stance = rd.stance; rc.setStance(rc.stance); rc.group = "CameraBody"; rc.setGroup(rc.group);
    closeModal("rdModal"); showTab("recoil"); renderRecoilTab();
    toast("New recoil in use — the range and the pattern use it now.", 3500);
  });
  $("rdTest").addEventListener("click", rdStartTest);
  $("rdTestAgain").addEventListener("click", () => fireMag());
  $("rdTestKeep").addEventListener("click", () => rdEndTest(true));
  $("rdTestBack").addEventListener("click", () => { rdEndTest(false); openDesigner(); });
}
