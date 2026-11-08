/* RecoilSim front-end — the 3D range: gun model, replaying shots, hold-to-fire,
   the on-screen readout and gunshot sound. */
"use strict";

let R = null; // RangeRenderer

/* ------------------------------------------------------------------ gun model + target */
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
    state.sceneVer = (state.sceneVer || 0) + 1;
  } catch (e) { console.warn("model", e); }
}

function buildTargetGeometry() {
  if (!R) return;
  const out = [];
  const col = { Head: [0.95, 0.8, 0.45], Torso: [0.16, 0.36, 0.72], "Left Arm": [0.95, 0.8, 0.45], "Right Arm": [0.95, 0.8, 0.45], "Left Leg": [0.3, 0.55, 0.25], "Right Leg": [0.3, 0.55, 0.25] };
  for (const [name, hx, hy, hw, hh] of state.hitboxes) {
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

/* ------------------------------------------------------------------ spring state over time */
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
  const ua = userAimStuds(Dc);
  const cx = sp.comp[0] - ua[0], cy = sp.comp[1] - ua[1];
  const C = M4.mul(M4.rotY(Math.atan2(cx, Dc)), M4.rotX(-Math.atan2(cy, Dc)));
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

/* ------------------------------------------------------------------ frame loop */
function frame(now) {
  requestAnimationFrame(frame);
  try { renderFrame(now); } catch (e) {
    state.lastSig = null;
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

  // nothing moving and nothing changed: keep the last frame (saves the GPU / battery)
  const sig = A || (state.session && state.session.holding) ? null
    : [D, eyeY, state.aimBlend, state.view, state.orbit.yaw, state.orbit.pitch, state.orbit.dist, state.sceneVer,
      state.holes.length, prefs.fov, prefs.ghost, prefs.markers, innerWidth, innerHeight, state.userAng[0], state.userAng[1]].join("|");
  if (sig && sig === state.lastSig) { updateReadout(t, A); return; }
  state.lastSig = sig;

  const { B, gun } = gunMatrices(eyeY, sp);
  const sc = state.scene;
  const first = state.view === "first";
  let camWorld, fovy;
  if (first) {
    camWorld = M4.mul(B, M4.axisAngle(sp.head));
    const zoom = sc ? 1 + (sc.zoom - 1) * state.aimBlend : 1;
    fovy = 2 * Math.atan(Math.tan((prefs.fov * Math.PI) / 360) / zoom);
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

  // bullet holes
  const pts = [];
  for (const h of state.holes) {
    if (A && h.anim === A && (h.time > t || (A.cutoff != null && h.shot >= A.cutoff))) continue;
    const c = h.part >= 0 ? PART_RGB[h.part] : [0.16, 0.16, 0.16];
    pts.push([h.w[0], h.w[1], h.w[2], c[0], c[1], c[2], 0.95, h.part >= 0 ? 0.16 : 0.22]);
  }
  R.drawPoints(pts, false, false);

  // tracers + muzzle flash
  let flash = false;
  if (A) {
    for (const b of A.bullets) if (!b.aimed && t >= b.t0 && !(A.cutoff != null && b.t0 >= A.cutoff)) aimBullet(A, b, D, eyeY);
    for (const b of A.bullets) if (!b.from && t >= b.t0) b.from = gun && sc ? Array.from(M4.apply(gun, sc.muzzle)) : [0, eyeY - 0.3, -2];
    const segs = [];
    for (const b of A.bullets) {
      const d = t - b.t0;
      if (d >= 0 && d < 0.045 && !(A.cutoff != null && b.t0 >= A.cutoff)) flash = true;
      if (!prefs.tracers || d < 0 || d > b.tt + 0.02 || !b.from || (A.cutoff != null && b.t0 >= A.cutoff)) continue;
      const f = Math.min(1, d / b.tt);
      const head = b.from.map((v, i) => v + (b.to[i] - v) * f);
      const tf = Math.max(0, f - Math.min(0.5, 14 / (b.dist + 1)));
      const tail = b.from.map((v, i) => v + (b.to[i] - v) * tf);
      segs.push([tail, head, 0.05, 1, 0.55, 0.35, 0.95]);
    }
    R.drawRibbons(segs);
  }

  // gun: in 1st person it fades while aiming so the target stays visible
  const hideGun = first && sc && sc.blackscope && state.aimBlend > 0.85;
  const ghost = prefs.ghost / 100;
  const alpha = first ? 1 - (1 - ghost) * Math.max(0, (state.aimBlend - 0.4) / 0.6) : 1;
  if (gun && !hideGun && alpha > 0.02) {
    R.drawMesh("gun", gun, { alpha, fogRange: [1e5, 2e5] });
    R.drawMesh("gunClear", gun, { blend: true, alpha: Math.max(alpha, Math.min(0.35, alpha * 3)), fogRange: [1e5, 2e5] });
  }
  if (flash && gun && sc && !hideGun) {
    const m = M4.apply(gun, sc.muzzle);
    R.drawPoints([[m[0], m[1], m[2], 1, 0.78, 0.4, 0.95, 0.9]], true, true);
  }
  drawOverlay({ D, t, A, first });
  if (A && t > A.end && !(state.session && state.session.holding && A.sess === state.session.id)) {
    state.anim = null; drawPattern();
    if (state.session && state.session.empty) state.session = null;
  }
  const firing = isFiring();
  if (state.fireLabel !== firing) {
    state.fireLabel = firing;
    const b = $("fireBtn");
    b.classList.toggle("on", firing);
    b.querySelector("use").setAttribute("href", firing ? "#i-stop" : "#i-play");
    b.querySelector("span").textContent = firing ? "Stop" : "Fire mag";
  }
}

/* ------------------------------------------------------------------ overlay: range markers, reticle, readout */
function drawOverlay(o) {
  const cv = $("overlay");
  const { ctx, w, h } = setupCanvas(cv);
  ctx.clearRect(0, 0, w, h);
  if (!o) return;
  const { D, t, A, first } = o;
  if (prefs.markers) {
    ctx.font = `600 12px ${FONT}`; ctx.textAlign = "center";
    for (const m of [10, 25, 50, 75, 100, 150, 200, 250, 300, 400, 500, 600, 800, 1000, 1500]) {
      if (m >= D - 2) break;
      const p = R.project([-5, 0.05, -m]);
      if (!p) continue;
      ctx.fillStyle = "rgba(15,18,22,0.55)"; ctx.fillText(`${m}`, p[0] + 1, p[1] + 1);
      ctx.fillStyle = "rgba(255,248,230,0.95)"; ctx.fillText(`${m}`, p[0], p[1]);
    }
    const tp = R.project([0, TARGET_BASE + 3, -D]);
    if (tp && !(first && state.aimBlend > 0.5)) {
      const txt = `${D} st`;
      ctx.font = `600 11.5px ${FONT}`;
      const tw = ctx.measureText(txt).width + 12;
      ctx.fillStyle = "rgba(16,19,25,0.78)"; roundRect(ctx, tp[0] - tw / 2, tp[1] - 22, tw, 18, 9); ctx.fill();
      ctx.fillStyle = "#eef1f5"; ctx.fillText(txt, tp[0], tp[1] - 9);
    }
    ctx.textAlign = "left";
  }

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
      ctx.strokeStyle = "rgba(255,255,255,0.9)"; ctx.lineWidth = 1.5;
      const g = 9, l = 7;
      ctx.beginPath();
      ctx.moveTo(cx - g - l, cy); ctx.lineTo(cx - g, cy); ctx.moveTo(cx + g, cy); ctx.lineTo(cx + g + l, cy);
      ctx.moveTo(cx, cy - g - l); ctx.lineTo(cx, cy - g); ctx.moveTo(cx, cy + g); ctx.lineTo(cx, cy + g + l);
      ctx.stroke();
    }
  }
  updateReadout(t, A);
}

let readoutKey = "";
function setReadout(items) {
  const key = JSON.stringify(items);
  if (key === readoutKey) return;
  readoutKey = key;
  const el = $("hud");
  el.innerHTML = items.map(([k, v, cls]) => `<div class="ro ${cls || ""}"><span class="k">${k}</span><span class="v">${v}</span></div>`).join("");
  fitReadout();
}
function fitReadout() {
  // drop the less important read-outs when the space between the panels is tight
  const el = $("hud");
  el.classList.remove("compact");
  const l = $("leftPanel"), r = $("rightPanel");
  const left = l.classList.contains("hidden") ? 0 : l.getBoundingClientRect().right;
  const right = r.classList.contains("hidden") ? innerWidth : r.getBoundingClientRect().left;
  if (el.getBoundingClientRect().width > right - left - 24) el.classList.add("compact");
}
function updateReadout(t, A) {
  if (A) {
    const live = (x) => x <= t && !(A.cutoff != null && x >= A.cutoff);
    const fired = A.times.filter(live).length;
    let hits = 0, head = 0, torso = 0, limb = 0, dmg = 0, killAt = null;
    const hp = (A.health || settings().health);
    for (const b of A.bullets) if (b.t0 + b.tt <= t && b.part >= 0 && !(A.cutoff != null && b.t0 >= A.cutoff)) {
      hits++; dmg += b.dmg;
      if (killAt === null && dmg >= hp - 1e-9) killAt = b.t0 + b.tt;
      const g = PART_GROUP[b.part]; if (g === "head") head++; else if (g === "torso") torso++; else limb++;
    }
    const pellets = (A.res.impacts[0][0] || [0]).length;
    const mag = A.sess ? magShots() : A.times.length;
    const items = [
      [prettyMode(A.firemode), `${liveRpm(A, t)}<small>rpm</small>`],
      ["Ammo", `${Math.max(0, mag - fired)}<small>/ ${mag}</small>`],
      ["Hits", `${hits}<small>/ ${fired * pellets}</small>`],
      ["Head · Torso · Limb", `<span class="h">${head}</span> · <span class="t">${torso}</span> · <span class="l">${limb}</span>`, "opt"],
      ["Damage", `${Math.round(dmg)}`],
    ];
    if (killAt != null) items.push(["Kill", `${Math.round(killAt * 1000)}<small>ms</small>`, "kill"]);
    setReadout(items);
    const count = A.shotArrivals.filter((x, i) => x <= t && !(A.cutoff != null && A.times[i] >= A.cutoff)).length;
    if (count !== A.lastCount) { A.lastCount = count; drawPattern({ impacts: A.res.impacts[0], parts: A.res.parts[0], count, from: A.clearFrom || 0 }); }
    while (A.nextSound < A.times.length && A.times[A.nextSound] <= t && !(A.cutoff != null && A.times[A.nextSound] >= A.cutoff)) { shotSound(); A.lastSoundT = A.times[A.nextSound]; A.nextSound++; }
  } else {
    const S = state.session;
    const items = [[prettyMode(currentModeLabel()), `${nominalRpm()}<small>rpm</small>`]];
    if (S && !S.empty && S.fired) items.push(["Ammo", `${magShots() - S.fired}<small>/ ${magShots()}</small>`]);
    else items.push(["Ammo", `${magShots()}<small>/ ${magShots()}</small>`]);
    if (state.reloadNote && performance.now() - state.reloadNote < 1500) items.push(["", "Reloaded", "note flash"]);
    else if (!state.hasFired) items.push(["", "Hold left click on the range to shoot", "note opt"]);
    setReadout(items);
  }
}

/* ------------------------------------------------------------------ fire rate shown on screen */
function currentModeLabel() {
  const sel = $("firemode");
  return sel.options[sel.selectedIndex] ? sel.options[sel.selectedIndex].text : "AUTO";
}
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
  // rate between the last shots actually fired (shows burst rates, heat ramp-up /
  // slow-down and auto-burst); falls back to the gun's rate in pauses
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
function ensureAudio() {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === "suspended") audioCtx.resume();
  } catch (e) { /* no audio */ }
}
function shotSound() {
  if (!state.sound || !audioCtx || prefs.vol <= 0) return;
  try {
    const ac = audioCtx, len = 0.18;
    const buf = ac.createBuffer(1, Math.floor(ac.sampleRate * len), ac.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / d.length, 3.5);
    const src = ac.createBufferSource(); src.buffer = buf;
    const lp = ac.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 2400;
    const g = ac.createGain(); g.gain.value = 0.32 * (prefs.vol / 100);
    src.connect(lp); lp.connect(g); g.connect(ac.destination);
    src.start();
  } catch (e) { /* audio unavailable */ }
}

/* ------------------------------------------------------------------ the shooter's own mouse aim */
// Mouse control: while firing, moving the mouse turns the view (yaw / pitch in
// radians, + = right / up). Every bullet lands where the aim was when it fired:
// the simulated impact plus the aim offset on the target plane (the recoil
// springs are additive, so this is the same as turning the camera in game).
state.userAng = [0, 0];
function userAimStuds(D) {
  return [D * Math.tan(state.userAng[0]), D * Math.tan(state.userAng[1])];
}
function resetUserAim() { state.userAng = [0, 0]; }
function mouseAimMove(dx, dy) {
  // one pixel turns the view by one pixel's worth of the current field of view
  const sc = state.scene;
  const zoom = sc ? 1 + (sc.zoom - 1) * state.aimBlend : 1;
  const fovy = 2 * Math.atan(Math.tan((prefs.fov * Math.PI) / 360) / zoom);
  const per = (fovy / innerHeight) * (state.mouseSens || 1);
  state.userAng[0] = Math.max(-1.2, Math.min(1.2, state.userAng[0] + dx * per));
  state.userAng[1] = Math.max(-1.2, Math.min(1.2, state.userAng[1] - dy * per));
}
function classifyHit(x, y, cy) {
  // same rules as the simulator: 0.1-stud margin, head > torso > arms > legs
  const R = (state.catalog && state.catalog.hitbox_radius) || 0.1;
  let part = -1;
  const order = state.hitboxes.map((h, i) => [h[5] ?? i, i]).sort((a, b) => b[0] - a[0]);
  for (const [, i] of order) {
    const [, hx, hy, hw, hh] = state.hitboxes[i];
    const dx = Math.max(Math.abs(x - hx) - hw, 0), dy = Math.max(Math.abs(y - (hy + cy)) - hh, 0);
    if (dx * dx + dy * dy < R * R + 1e-12) part = i;
  }
  return part;
}
function aimBullet(A, b, D, eyeY) {
  // fix where this bullet goes: stored aim for already-fired shots, else the aim right now
  b.aimed = true;
  if (!A.aimOff[b.i]) A.aimOff[b.i] = state.mouseAim ? userAimStuds(D) : [0, 0];
  const [ox, oy] = A.aimOff[b.i];
  if ((!ox && !oy) || !Number.isFinite(b.x0)) return;
  const x = b.x0 + ox, y = b.y0 + oy;
  let part = classifyHit(x, y, A.res.target_cy);
  if (b.part0 < 0 && classifyHit(b.x0, b.y0, A.res.target_cy) >= 0) part = -1; // ran out of range: still a miss
  b.part = part;
  b.dmg = part < 0 ? 0 : A.res.summary.damage[PART_GROUP[part]];
  b.to = impactWorld(x, y, part, D, eyeY);
  A.res.impacts[0][b.i][b.k] = [x, y];
  A.res.parts[0][b.i][b.k] = part;
  if (b.hole) { b.hole.w = b.to; b.hole.part = part; }
}

/* ------------------------------------------------------------------ replaying a simulated magazine */
function impactWorld(x, y, part, D, eyeY) {
  if (part >= 0) return [x, eyeY + y, -D + 0.52];
  const s = (D + WALL_GAP) / D;
  const wy = eyeY + y * s;
  if (wy > 0) return [x * s, wy, -(D + WALL_GAP) + 0.05];
  const s2 = y < 0 ? eyeY / -y : s;
  return [x * s2, 0.03, -D * s2];
}

function setPlaybackSpeed(v) {
  // change speed mid-shot: keep the current moment and run on from it at the new speed
  const now = performance.now();
  const S = state.session, A = state.anim;
  if (S) { const t = ((now - S.start) / 1000) * S.speed; S.speed = v; S.start = now - (t / v) * 1000; }
  if (A) { const t = animTime(A); A.speed = v; A.start = now - (t / v) * 1000; }
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
  const anim = { start, speed, times, bullets, res, firemode: res.firemode, nextSound: 0, lastCount: -1, shotArrivals, sess: sess ? sess.id : null,
    health: s.health, aimOff: sess ? (sess.aimOff = sess.aimOff || {}) : {} };
  if (sess) state.holes = state.holes.filter((h) => h.sess !== sess.id);
  res.impacts[0].forEach((shot, i) => {
    shot.forEach((p, k) => {
      const part = res.parts[0][i][k];
      const dmg = part < 0 ? 0 : dmgs[PART_GROUP[part]];
      const to = impactWorld(p[0], p[1], part, D, eyeY);
      const dist = Math.hypot(to[0], to[1] - eyeY, to[2]);
      const tt = Math.min(2, dist / bspeed);
      const b = { t0: times[i], tt, to, dist, part, dmg, from: null, i, k, x0: p[0], y0: p[1], part0: part, aimed: false };
      bullets.push(b);
      // shots from before the last "Clear holes" stay cleared when the session's
      // timeline is rebuilt on the next trigger press
      if (!(sess && i < (sess.clearFrom || 0))) { b.hole = { w: to, part, time: times[i] + tt, shot: times[i], anim, sess: sess ? sess.id : null }; state.holes.push(b.hole); }
      if (k === 0) shotArrivals.push(times[i] + tt);
      // shots already fired in this session keep the aim they were fired with
      if (anim.aimOff[i]) aimBullet(anim, b, D, eyeY);
    });
  });
  if (state.holes.length > 3000) state.holes = state.holes.slice(-3000);
  anim.track = (res.track || []).map((r) => { const c = r.slice(); c[0] -= t0; return c; });
  const lastShot = times[times.length - 1] || 0;
  anim.end = lastShot + Math.min(2, D / bspeed) + 0.7;
  anim.flightEnd = lastShot + Math.min(2, D / bspeed) + 0.15;
  if (sess && anim.track.length) anim.end = Math.max(anim.end, anim.track[anim.track.length - 1][0]);
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

let fireToken = 0;
async function fireMag() {
  if (isFiring()) { stopFiring(); return; }
  state.hasFired = true;
  state.session = null;
  ensureAudio();
  const s = settings();
  const token = ++fireToken;
  try {
    const res = await api("/api/simulate", { weapon: state.weapon, attachments: state.attachments, settings: s, runs: 1, track: true, return_runs: 1 });
    if (token !== fireToken || state.session) return;
    state.lastWatch = res;
    state.anim = buildAnim(res, s, performance.now(), +$("speed").value, null);
  } catch (e) {
    showError(`Couldn't fire: ${e.message}`);
  }
}

function reloadMag() {
  // R: fresh magazine for hold-to-fire (and stop whatever is firing)
  stopFiring();
  state.session = null;
  state.reloadNote = performance.now();
  resetUserAim();
}

function clearHoles() {
  state.holes = state.holes.filter((h) => state.anim && h.anim === state.anim && h.time > animTime(state.anim));
  const firedSoFar = state.lastWatch && state.lastWatch.fire_times ? state.lastWatch.fire_times.length : 0;
  state.lastWatch = null;
  state.dotsCleared = true;
  const A = state.anim;
  if (A) { const t = animTime(A); A.clearFrom = A.shotArrivals.filter((x) => x <= t).length; A.lastCount = -1; }
  const S = state.session;
  if (S) S.clearFrom = Math.max(S.clearFrom || 0, A && A.sess === S.id ? A.clearFrom : (S.fired || firedSoFar));
  drawPattern();
}

/* hold the left mouse button to shoot; letting go pauses, the springs keep
   recovering, and the next press carries on with the same magazine */
function magShots() {
  const s = settings();
  return s.shots || Math.ceil((state.stats && state.stats.magsize) || 30);
}
function triggerDown() {
  ensureAudio();
  state.hasFired = true;
  fireToken++; // cancel a pending "Fire mag"
  let S = state.session;
  if (S && S.empty) S = null;
  // Press and release take effect a few ms in the future (about one server
  // round trip), so the new timeline is back before it starts: no snapping.
  const lead = inputLead();
  if (!S) {
    if (state.anim) stopFiring();
    // your aim carries over between magazines; only R (reload) re-centres it
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
    state.anim.cutoff = Math.ceil(t * fps - 1e-9) / fps - 1e-6;
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
    showError(`Couldn't fire: ${e.message}`);
  }
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
