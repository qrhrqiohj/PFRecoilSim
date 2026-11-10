/* RecoilSim front-end — the Recoil tab (view / edit the gun's recoil, add or
   remove layers, export / import the game's text format) and the recoil
   designer (draw where the shots should land, get recoil the game can make). */
"use strict";

const RC_GROUPS = {
  CameraBody: { label: "Camera", hint: "Turns the view (and with it the gun and the bullets): the main climb you pull against.", axes: { x: "pitch (up / down)", y: "yaw (left / right)", z: "roll" } },
  Rotation: { label: "Rotational", hint: "Turns the gun in front of the camera: where the bullets go moves with it, usually a quick kick that settles fast.", axes: { x: "pitch (up / down)", y: "yaw (left / right)", z: "roll" } },
  Translation: { label: "Translational", hint: "Moves the gun in front of the camera (mostly the visible kick back). Barely changes where bullets land.", axes: { x: "sideways", y: "up / down", z: "back / forward" } },
  CameraHead: { label: "Head Camera", hint: "Shakes what you see only — the gun and the bullets follow the camera, not this, so it doesn't change where shots land.", axes: { x: "pitch", y: "yaw", z: "roll" } },
};
const rc = { stance: "aim", group: "CameraBody", base: {}, timer: null };

const clone = (o) => JSON.parse(JSON.stringify(o));
async function rcBase(weapon) {
  if (!rc.base[weapon]) rc.base[weapon] = (await api("/api/recoil", { weapon })).recoil;
  return rc.base[weapon];
}
function rcEdited(weapon) { return !!(state.recoilEdits || {})[weapon]; }
async function rcCurrent(weapon) { return state.recoilEdits[weapon] || await rcBase(weapon); }

/* ------------------------------------------------------------------ the tab */
async function renderRecoilTab() {
  const pane = document.querySelector('[data-pane="recoil"]');
  if (!pane || !state.weapon) return;
  $("rcGun").textContent = state.weaponInfo ? state.weaponInfo.displayname : state.weapon;
  $("rcState").textContent = rcEdited(state.weapon) ? "edited" : "game values";
  $("rcState").classList.toggle("edited", rcEdited(state.weapon));
  $("rcGroupHint").textContent = RC_GROUPS[rc.group].hint;
  let rec;
  try { rec = await rcCurrent(state.weapon); } catch (e) { $("rcTable").innerHTML = `<p class="error">${esc(e.message)}</p>`; return; }
  const g = rc.stance + rc.group, gr = rec[g] || {}, rv = rec[g + "Recovery"] || {};
  const num = (path, v, title) => `<input type="number" step="any" data-rc="${path}" value="${+(+v).toFixed(4)}" title="${title}">`;
  const axes = RC_GROUPS[rc.group].axes;
  let html = `<table class="rc-grid"><thead><tr><th></th><th title="How strongly the spring resists bouncing (1 = no overshoot)">Damping</th><th title="How fast the spring moves">Speed</th><th title="Average kick per shot">Mean</th><th title="Random part of the kick: each shot is mean ± variance">Variance</th><th></th></tr></thead><tbody>`;
  for (const ax of ["x", "y", "z"]) {
    const rows = gr[ax] || [];
    html += `<tr class="rc-ax"><td colspan="6"><b>${ax}</b> <span class="hint">${axes[ax]}</span><button class="link" data-rcadd="${g}|${ax}">+ layer</button></td></tr>`;
    rows.forEach((r, i) => {
      html += `<tr><td class="rc-n">${i + 1}</td><td>${num(`${g}|${ax}|${i}|0`, r[0], "Damping")}</td><td>${num(`${g}|${ax}|${i}|1`, r[1], "Speed")}</td><td>${num(`${g}|${ax}|${i}|2`, r[2], "Mean")}</td><td>${num(`${g}|${ax}|${i}|3`, r[3], "Variance")}</td><td><button class="iconbtn tiny" data-rcdel="${g}|${ax}|${i}" title="Remove this layer">×</button></td></tr>`;
    });
    if (!rows.length) html += `<tr><td></td><td colspan="5" class="hint">No layers</td></tr>`;
  }
  html += `</tbody></table><div class="rc-rec"><div class="minihead">Recovery <span class="hint">· the springs used once the gun stops firing (after the delay)</span></div><table class="rc-grid"><thead><tr><th></th><th>Damping</th><th>Speed</th><th colspan="2"></th><th></th></tr></thead><tbody>`;
  for (const ax of ["x", "y", "z"]) {
    const a = rv[ax] || { layers: [], delay: 0 };
    html += `<tr class="rc-ax"><td colspan="6"><b>${ax}</b> <span class="hint">${axes[ax]}</span> <label class="rc-delay">delay ${num(`${g}Recovery|${ax}|delay`, a.delay, "Seconds after the last shot before recovery starts")}s</label><button class="link" data-rcadd="${g}Recovery|${ax}">+ layer</button></td></tr>`;
    a.layers.forEach((r, i) => {
      html += `<tr><td class="rc-n">${i + 1}</td><td>${num(`${g}Recovery|${ax}|${i}|0`, r[0], "Damping")}</td><td>${num(`${g}Recovery|${ax}|${i}|1`, r[1], "Speed")}</td><td colspan="2"></td><td><button class="iconbtn tiny" data-rcdel="${g}Recovery|${ax}|${i}" title="Remove this layer">×</button></td></tr>`;
    });
  }
  html += `</tbody></table></div>`;
  $("rcTable").innerHTML = html;
}
async function rcEdit(fn) {
  const w = state.weapon;
  const rec = clone(await rcCurrent(w));
  fn(rec);
  // back to exactly the game's values: no longer "edited"
  if (stableJSON(rec) === stableJSON(await rcBase(w))) delete state.recoilEdits[w];
  else state.recoilEdits[w] = rec;
  store();
  clearTimeout(rc.timer);
  rc.timer = setTimeout(() => onLoadoutChanged(), 350);
}
function wireRecoilTab() {
  rc.setStance = seg("rcStance", (v) => { rc.stance = v; renderRecoilTab(); });
  rc.setGroup = seg("rcGroup", (v) => { rc.group = v; renderRecoilTab(); });
  $("rcTable").addEventListener("change", (e) => {
    const inp = e.target.closest("[data-rc]");
    if (!inp) return;
    const [g, ax, i, j] = inp.dataset.rc.split("|");
    const v = Number(inp.value);
    if (!Number.isFinite(v)) { renderRecoilTab(); return; }
    rcEdit((rec) => {
      if (i === "delay") rec[g][ax].delay = v;
      else if (g.endsWith("Recovery")) rec[g][ax].layers[+i][+j] = v;
      else rec[g][ax][+i][+j] = v;
    }).then(renderRecoilTab);
  });
  $("rcTable").addEventListener("click", (e) => {
    const add = e.target.closest("[data-rcadd]"), del = e.target.closest("[data-rcdel]");
    if (add) {
      const [g, ax] = add.dataset.rcadd.split("|");
      rcEdit((rec) => {
        if (g.endsWith("Recovery")) { const L = rec[g][ax].layers; L.push(L.length ? [...L[L.length - 1]] : [1, 10]); }
        else { const L = rec[g][ax]; L.push(L.length ? [L[L.length - 1][0], L[L.length - 1][1], 0, 0] : [1, 20, 0, 0]); }
      }).then(renderRecoilTab);
    } else if (del) {
      const [g, ax, i] = del.dataset.rcdel.split("|");
      rcEdit((rec) => { (g.endsWith("Recovery") ? rec[g][ax].layers : rec[g][ax]).splice(+i, 1); }).then(renderRecoilTab);
    }
  });
  $("rcReset").addEventListener("click", () => {
    if (!rcEdited(state.weapon)) { toast("This gun already uses the game's recoil."); return; }
    delete state.recoilEdits[state.weapon]; store(); onLoadoutChanged(); renderRecoilTab(); toast("Recoil reset to the game's values.");
  });
  $("rcBlank").addEventListener("click", () => {
    // every table down to one layer of zeros (aimed and hip, recovery delays 0)
    rcEdit((rec) => {
      for (const g of Object.keys(rec)) {
        for (const ax of ["x", "y", "z"]) {
          if (g.endsWith("Recovery")) rec[g][ax] = { layers: [[0, 0]], delay: 0 };
          else rec[g][ax] = [[0, 0, 0, 0]];
        }
      }
    }).then(() => { renderRecoilTab(); toast("Recoil blanked: every value 0, one layer each. Reset brings the game's back."); });
  });
  $("rcExport").addEventListener("click", rcOpenExport);
  $("rcImport").addEventListener("click", rcOpenImport);
  $("rcTextClose").addEventListener("click", () => closeModal("rcTextModal"));
  $("rcTextModal").addEventListener("mousedown", (e) => { if (e.target === $("rcTextModal")) closeModal("rcTextModal"); });
  $("rcTextCopy").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText($("rcText").value); toast("Copied."); } catch (e) { $("rcText").select(); document.execCommand("copy"); toast("Copied."); }
  });
  $("rcTextSave").addEventListener("click", () => {
    const blob = new Blob([$("rcText").value], { type: "text/plain" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${(state.weaponInfo && state.weaponInfo.displayname) || state.weapon} recoil.lua`;
    document.body.appendChild(a); a.click(); a.remove();
  });
  $("rcTextApply").addEventListener("click", async () => {
    $("rcTextErr").textContent = "";
    try {
      const { recoil } = await api("/api/recoil/parse", { text: $("rcText").value });
      await rcEdit((rec) => { for (const k of Object.keys(recoil)) rec[k] = recoil[k]; });
      closeModal("rcTextModal"); renderRecoilTab(); toast("Recoil imported.");
    } catch (e) { $("rcTextErr").textContent = e.message; }
  });
  wireDesigner();
}
async function rcOpenExport() {
  const rec = await rcCurrent(state.weapon);
  const { text } = await api("/api/recoil/lua", { recoil: rec });
  $("rcTextTitle").textContent = `${(state.weaponInfo && state.weaponInfo.displayname) || state.weapon} recoil`;
  $("rcTextHint").textContent = "The game's own recoil format (the weapon editor's recoil export): paste it into the editor or a weapon module. Argument order: damping, speed, mean, variance.";
  $("rcText").value = text; $("rcText").readOnly = true; $("rcTextErr").textContent = "";
  $("rcTextApply").hidden = true; $("rcTextCopy").hidden = false; $("rcTextSave").hidden = false;
  openModal("rcTextModal");
}
function rcOpenImport() {
  $("rcTextTitle").textContent = `Import recoil for ${(state.weaponInfo && state.weaponInfo.displayname) || state.weapon}`;
  $("rcTextHint").textContent = 'Paste recoil in the game\'s format (gunData.recoil["aimRotation"] = { ... } and so on, all 8 tables and their Recovery tables).';
  $("rcText").value = ""; $("rcText").readOnly = false; $("rcTextErr").textContent = "";
  $("rcTextApply").hidden = false; $("rcTextCopy").hidden = true; $("rcTextSave").hidden = true;
  openModal("rcTextModal");
  $("rcText").focus();
}

