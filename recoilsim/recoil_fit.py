"""Recoil designer: turn a pattern the user lays out (where each shot of the
magazine should land, and how widely around that point) into a recoil table
the game can use.

What the game can make. Every recoil spring layer gets the same random kick
(mean +- variance, uniform) on every shot (RecoilSprings.applyImpulse);
nothing in the game kicks differently from one shot to the next. Each layer is
a damped spring pulling back to the centre; after `delay` seconds without a
shot it switches to its recovery damping / speed (if the table has one for that
layer). The springs are linear, so a magazine's average path is

    path = (path of the rest of the recoil) + sum_j mean_j * (path of layer j alone)

and the spread around it (the kicks are independent) is

    var(shot k) = (spread of the rest) + sum_j variance_j^2 / 3 * sum_i r_j(k, i)^2

where r_j(k, i) is where shot k is moved by one unit kick of layer j at shot i.

How the designer works.
1. It measures the path of a dictionary of candidate layers (damping x speed),
   limited by the chosen *feel*: "game" (like the game's own guns: fast layers
   that may bounce a little, slow layers that never bounce — no floaty
   swinging), "smooth" (nothing bounces) or "free" (anything, for zig-zags).
2. Per direction (pitch -> up / down, yaw -> left / right) it adds, one at a
   time, the candidate that brings the pattern closest (weighted least squares
   over every kick), up to the number of layers asked for or, on Auto, until
   more stop helping. Small sets are then fine-tuned. Locked layers (e.g. a
   fast "punch" per shot) are kept as they are and fitted around.
3. Variances: with per-shot spread targets, the layers' variances are solved
   (non-negative least squares on the formula above, adding spread-only layers
   where the pattern's own layers can't shape it); otherwise each variance is a
   share of its kick.
4. Recovery: by default every camera layer gets a recovery spring (critically
   damped) so the view returns to the centre within the chosen time once you
   stop firing — the game's own guns have none, so their camera drifts back
   only as fast as the firing springs allow.
"""
from __future__ import annotations

import copy
import math

import numpy as np

from .recoil_edit import MAX_LAYERS, sanitize
from .simulate import SimSettings, simulate
from .springs import spring_coeffs

SEL_RIDGE = 1e-5  # while choosing layers: keeps pairs of layers from cancelling (big opposite kicks go non-linear)
FREE_W = 0.03     # free shots: a very light hint (see fit_recoil)
SMOOTH_W = 0.3     # weight of the in-between / after-the-magazine checks (vs a normal shot)
KICK_RIDGE = 1e-4  # keeps layers from cancelling each other with huge kicks
UNIT = 0.01  # kick used to measure a layer's path (small: stays linear, never flies off)

# the springs each feel may use: lists of (damping range, speed range)
FEELS = {
    # the game's own guns: fast layers (may bounce a little) + slow layers that never bounce
    "game": [((0.3, 1.4), (8.0, 90.0)), ((1.0, 4.0), (1.5, 8.0))],
    "smooth": [((0.9, 4.0), (1.5, 90.0))],
    "free": [((0.1, 5.0), (1.0, 200.0))],
}
_GRIDS = {
    "game": [(d, s) for d in (0.3, 0.45, 0.6, 0.8, 1.0, 1.3) for s in (9.0, 12.0, 16.0, 22.0, 30.0, 42.0, 60.0, 85.0)]
          + [(d, s) for d in (1.0, 1.3, 1.7, 2.3, 3.0, 4.0) for s in (1.5, 2.0, 2.7, 3.6, 4.8, 6.4, 7.9)],
    "smooth": [(d, float(s)) for d in (0.9, 1.0, 1.3, 1.8, 2.5, 3.5) for s in np.geomspace(1.5, 90.0, 12)],
    "free": [(d, float(s)) for d in (0.12, 0.2, 0.3, 0.45, 0.6, 0.8, 1.0, 1.3, 1.8, 2.6) for s in np.geomspace(1.2, 160.0, 14)],
}


def _project(feel, d, s):
    """The nearest spring this feel allows."""
    best = None
    for (d0, d1), (s0, s1) in FEELS[feel]:
        dd, ss = min(max(d, d0), d1), min(max(s, s0), s1)
        cost = abs(math.log(dd / d)) + abs(math.log(ss / s))
        if best is None or cost < best[0]:
            best = (cost, dd, ss)
    return best[1], best[2]


def _cfg_with(cfg, recoil_canon):
    """A compiled setup with this (canonical) recoil in place of its own."""
    c = copy.copy(cfg)
    rec = {}
    for g, v in recoil_canon.items():
        if g.endswith("Recovery"):
            rec[g] = {ax: {**{i + 1: list(r) for i, r in enumerate(a["layers"])}, "delay": a["delay"]} for ax, a in v.items()}
        else:
            rec[g] = {ax: [list(map(float, r)) for r in rows] for ax, rows in v.items()}
    c.recoil = rec
    c.stats = dict(cfg.stats)
    c.stats["recoil"] = rec
    c.pose = None  # the designer works on recoil only (no barrel offset)
    return c


def _det(cfg):
    """No randomness, a single bullet, no spread: the average path."""
    det = copy.copy(cfg)
    det.recoil = copy.deepcopy(cfg.recoil)
    for group in det.recoil.values():
        if isinstance(group, dict):
            for rows in group.values():
                if isinstance(rows, list):
                    for row in rows:
                        if isinstance(row, list) and len(row) >= 4:
                            row[3] = 0.0
    det.stats = dict(cfg.stats)
    det.stats["pelletcount"] = 1
    det.stats["spread"] = None
    det.stats["hipfirespread"] = 0
    return det


def _no_variance(rec, group, axes=("x", "y")):
    out = copy.deepcopy(rec)
    for ax in axes:
        out[group][ax] = [[r[0], r[1], r[2], 0.0] for r in out[group][ax]]
    return out


class _Runner:
    """Runs average paths for recoil tables of one gun / scenario."""

    def __init__(self, gd, req):
        self.weapon = req["weapon"]
        self.aiming = bool(req.get("aiming", True))
        self.cfg = gd.compile(self.weapon, {})  # its recoil is replaced, so edits don't matter here
        self.mag = int(self.cfg.stats.get("magsize") or 30)
        n = int(req.get("shots") or self.mag)
        self.n = max(2, min(n, 300))
        self.st = SimSettings(distance=max(1.0, float(req.get("distance") or 50)), aiming=self.aiming, runs=1, seed=1,
                              gravity=False, shots=self.n, firemode_index=int(req.get("firemode_index") or 0),
                              fps=float(req.get("fps") or 60),
                              trigger_rpm=float(req["trigger_rpm"]) if req.get("trigger_rpm") else None,
                              controller=bool(req.get("controller", False)))
        self.group = ("aim" if self.aiming else "hip") + "CameraBody"
        self.times = None
        self.sample_t = None
        self.impulse_t = None

    def path(self, rec):
        res = simulate(_det(_cfg_with(self.cfg, rec)), self.st)
        if self.times is None:
            t = np.array(res.plan.sample_times[: self.n], float)
            self.sample_t = t
            self.impulse_t = np.array(res.plan.impulse_times[: self.n], float)
            self.times = (t - t[0]).tolist() if len(t) else []
        return res.impacts[0, : self.n, 0, :]

    def scatter(self, rec, runs, seed=7):
        st = copy.copy(self.st)
        st.runs = runs
        st.seed = seed
        res = simulate(_cfg_with(self.cfg, rec), st)
        return res.impacts[:, : self.n, 0, :]

    def sigma(self, rec, runs=300):
        """Per-shot spread (standard deviation, studs) of x and y from simulated magazines."""
        sc = self.scatter(rec, runs, seed=11)
        sc = np.where(np.isfinite(sc) & (np.abs(sc) < 1e5), sc, np.nan)
        with np.errstate(invalid="ignore"):
            return np.nan_to_num(np.nanstd(sc, axis=0), nan=0.0)  # (n, 2)

    def track(self, rec, after=3.0):
        """The camera / gun / view motion of one average magazine and `after`
        seconds beyond: rows [t, cam pitch, cam yaw, gun pitch, gun yaw, gun back,
        view pitch, view yaw] (degrees; studs for gun back)."""
        st = copy.copy(self.st)
        st.record_track = True
        self.path(rec)
        st.track_end = float(self.impulse_t[-1]) + after if self.impulse_t is not None and len(self.impulse_t) else after
        res = simulate(_det(_cfg_with(self.cfg, rec)), st)
        tr = np.array(res.track, float) if res.track else np.zeros((0, 18))
        if not len(tr):
            return [], None
        t0 = self.sample_t[0] if self.sample_t is not None and len(self.sample_t) else 0.0
        deg = 180 / math.pi
        rows = np.stack([tr[:, 0] - t0, tr[:, 3] * deg, tr[:, 4] * deg, tr[:, 6] * deg, tr[:, 7] * deg, tr[:, 11],
                         tr[:, 15] * deg, tr[:, 16] * deg], axis=1)
        step = max(1, len(rows) // 400)
        out = rows[::step]
        # when the view is back at the centre after the last shot (camera within 5 % of its peak, or 0.05 deg)
        last = float(self.impulse_t[-1] - t0) if self.impulse_t is not None and len(self.impulse_t) else 0.0
        mag = np.hypot(rows[:, 1], rows[:, 2])
        thr = max(0.05, 0.05 * float(mag.max() if len(mag) else 0))
        after_last = rows[:, 0] > last
        settle = None
        if after_last.any():
            idx = np.where(after_last)[0]
            above = idx[mag[idx] > thr]
            if not len(above):
                settle = 0.0
            elif above[-1] < len(rows) - 1:
                settle = float(rows[above[-1] + 1, 0] - last)
        return np.round(out, 4).tolist(), settle


REC_RANGE = ((0.3, 3.0), (3.0, 90.0))  # recovery damping / speed the designer may pick


def _project_rec(dr, sr):
    (a, b), (c, e) = REC_RANGE
    return min(max(dr, a), b), min(max(sr, c), e)


def _assemble(start, group, rows_xy, delay):
    """start with the camera's pitch / yaw layers replaced by rows_xy, each row
    [damping, speed, mean, variance, recovery damping, recovery speed]: the
    recovery springs go into the recovery table at the same layer index (the
    game pairs them by index), with this delay."""
    rec = copy.deepcopy(start)
    for ax in ("x", "y"):
        rec[group][ax] = [[float(r[0]), float(r[1]), float(r[2]), float(r[3])] for r in rows_xy[ax]]
        rec[group + "Recovery"][ax] = {"layers": [[float(r[4]), float(r[5])] for r in rows_xy[ax]], "delay": float(delay)}
    return rec


def split_layers(canon, group):
    """A canonical table's camera pitch / yaw layers as 6-value rows (recovery
    paired by index; a layer without one gets its own firing spring = no change)."""
    out = {}
    for ax in ("x", "y"):
        rl = canon[group + "Recovery"][ax]["layers"]
        out[ax] = [list(r) + (list(rl[i]) if i < len(rl) else [r[0], r[1]]) for i, r in enumerate(canon[group][ax])]
    return out


def _wls(A, y, w, ridge=1e-5):
    """Weighted least squares with a little ridge (keeps kicks from cancelling wildly)."""
    sw = np.sqrt(w)
    Aw, yw = A * sw[:, None], y * sw
    G = Aw.T @ Aw
    lam = ridge * (np.trace(G) / max(G.shape[0], 1) + 1e-12)
    m = np.linalg.solve(G + lam * np.eye(G.shape[0]), Aw.T @ yw)
    r = Aw @ m - yw
    return m, float(r @ r / max(w.sum(), 1e-9))


def _nnls(A, b, iters=400):
    """min ||A q - b||, q >= 0 (projected coordinate descent; small problems)."""
    n = A.shape[1]
    q = np.zeros(n)
    G = A.T @ A
    h = A.T @ b
    diag = np.maximum(np.diag(G), 1e-18)
    for _ in range(iters):
        prev = q.copy()
        for j in range(n):
            g = G[j] @ q - h[j]
            q[j] = max(0.0, q[j] - g / diag[j])
        if np.max(np.abs(q - prev)) <= 1e-10 * (1 + np.max(np.abs(q))):
            break
    return q


def _nelder_mead(f, x0, step=0.25, iters=60):
    n = len(x0)
    pts = [np.array(x0, float)] + [np.array(x0, float) + step * np.eye(n)[i] for i in range(n)]
    vals = [f(p) for p in pts]
    for _ in range(iters):
        order = np.argsort(vals)
        pts, vals = [pts[i] for i in order], [vals[i] for i in order]
        c = np.mean(pts[:-1], axis=0)
        xr = c + (c - pts[-1])
        fr = f(xr)
        if fr < vals[0]:
            xe = c + 2 * (c - pts[-1])
            fe = f(xe)
            pts[-1], vals[-1] = (xe, fe) if fe < fr else (xr, fr)
        elif fr < vals[-2]:
            pts[-1], vals[-1] = xr, fr
        else:
            xc = c + 0.5 * (pts[-1] - c)
            fc = f(xc)
            if fc < vals[-1]:
                pts[-1], vals[-1] = xc, fc
            else:
                for i in range(1, len(pts)):
                    pts[i] = pts[0] + 0.5 * (pts[i] - pts[0])
                    vals[i] = f(pts[i])
    i = int(np.argmin(vals))
    return pts[i], vals[i]


def _responses(d, s, rec_row, delay, imp_t, samp_t, fps=60.0):
    """R[k, i]: spring position at shot k's sample time after a unit kick (in
    velocity) at shot i's impulse, with the recovery switch after `delay` (on the
    first rendered frame after it, as the game checks once per frame)."""
    n = len(samp_t)
    ev = [(float(samp_t[k]), 0, k) for k in range(n)] + [(float(imp_t[i]), 2, i) for i in range(len(imp_t))]
    ev.sort()
    p = np.zeros(len(imp_t))
    v = np.zeros(len(imp_t))
    R = np.zeros((n, len(imp_t)))
    t = ev[0][0] if ev else 0.0
    params = (d, s)
    last_imp = None
    in_rec = False
    cache = {}

    def step(dt):
        nonlocal p, v
        if dt <= 0:
            return
        key = (params, round(dt, 9))
        c = cache.get(key)
        if c is None:
            c = cache[key] = spring_coeffs(params[0], params[1], dt)
        pp, pv, vp, vv, _, _ = c
        p, v = pp * p + pv * v, vp * p + vv * v

    for time, kind, idx in ev:
        # the recovery switch, if it falls before this event
        if rec_row is not None and last_imp is not None and not in_rec:
            ts = (math.floor((last_imp + delay) * fps + 1e-9) + 1) / fps
            if ts < time - 1e-9:
                step(ts - t)
                t = ts
            else:
                ts = None
        else:
            ts = None
        if ts is not None:
            params = (rec_row[0], rec_row[1])
            in_rec = True
        step(time - t)
        t = time
        if kind == 0:
            R[idx] = p
        else:
            params = (d, s)
            in_rec = False
            v[idx] += 1.0
            last_imp = time
    return R


def fit_recoil(gd, req: dict) -> dict:
    """req: weapon, aiming, distance, shots, firemode_index, fps, trigger_rpm, controller;
    points [[x, y] or null, ...] (where shot i should land, studs from the aim
    point, x right / y up; null = free), weights [w, ...] (0 = free);
    spread [[sx, sy] or null, ...] (how widely shot i may land around its point:
    a standard deviation in studs per axis; null = no target);
    layers ("auto" or 1-16 per direction); feel ("game", "smooth", "free");
    variance (0-1: how random each shot's kick is, as a share of that shot's step
    along the pattern — the spread target of shots without one); recoil (the full table to start from: its other parts are kept);
    locked ({"x": [[d, s, mean, var, rec d, rec s], ...], "y": [...]}: camera
    layers kept exactly as they are, fitted around); springs ({"x": [[d, s, rec d,
    rec s], ...], "y": [...]}: keep these springs, fit only the kicks); smooth (0-2, default 0.3:
    how strongly the view is kept on a smooth path between shots and after the
    last one);
    recovery ({"damping", "speed": the recovery spring new layers start from,
    "delay": seconds without a shot before it takes over, "tune": fine-tune each
    layer's recovery too})."""
    raw = req.get("points") or []
    k = len(raw)
    if k < 2:
        raise ValueError("place at least two shots")
    wl = list(req.get("weights") or [])
    weights = np.array([float(wl[i]) if i < len(wl) and wl[i] is not None else 1.0 for i in range(k)], float)
    pts = np.zeros((k, 2))
    for i, p in enumerate(raw):
        if p is None:
            weights[i] = 0.0
        else:
            pts[i] = [float(p[0]), float(p[1])]
    if (weights > 0).sum() < 2:
        raise ValueError("at least two shots need a place to land")
    req = {**req, "shots": max(int(req.get("shots") or 0), k)}
    run = _Runner(gd, req)
    k = min(k, run.n)
    pts, weights = pts[:k], weights[:k]
    w_user = weights.copy()  # what the user asked for (the result is measured on these)
    # Free shots get a very light hint so the springs can't run away with them:
    # between two shots with a place, the straight line between them; after the
    # last one, carrying on in its direction, slowing down. (Light enough that
    # anything else you asked for wins.)
    on_idx = [i for i in range(1, k) if weights[i] > 0]
    if on_idx:
        wl = FREE_W * float(weights[on_idx].mean())
        last = on_idx[-1]
        prev = [i for i in on_idx if i < last]
        step = (pts[last] - pts[prev[-1]]) / (last - prev[-1]) if prev else np.zeros(2)
        for i in range(1, k):
            if weights[i] > 0:
                continue
            a = max([j for j in on_idx if j < i], default=None)
            b = min([j for j in on_idx if j > i], default=None)
            if a is not None and b is not None:
                pts[i] = pts[a] + (pts[b] - pts[a]) * (i - a) / (b - a)
            elif a is not None:
                j = i - last
                pts[i] = pts[last] + step * (1 - 0.85 ** j) / (1 - 0.85)
            else:
                continue
            weights[i] = wl
    w = weights
    feel = req.get("feel") if req.get("feel") in FEELS else "game"
    variance = min(1.0, max(0.0, float(req.get("variance") or 0)))
    start = sanitize(req["recoil"]) if req.get("recoil") else gd.base_recoil(run.weapon)
    g = run.group
    rcfg = req.get("recovery") or {}
    rec0 = _project_rec(float(rcfg.get("damping") or 0.85), float(rcfg.get("speed") or 15.0))
    delay = max(0.0, float(rcfg["delay"])) if rcfg.get("delay") is not None else 0.1
    tune_rec = bool(rcfg.get("tune", True))

    def full_row(r):
        r = [float(x) for x in r] + [0.0] * max(0, 4 - len(r))
        return r[:4] + (r[4:6] if len(r) >= 6 else [r[0], r[1]])
    locked = {ax: [full_row(r) for r in ((req.get("locked") or {}).get(ax) or [])] for ax in ("x", "y")}

    def with_rows(rows_xy):
        return _assemble(start, g, rows_xy, delay)

    base = run.path(with_rows(locked))[:k]
    resid = pts - base
    fps = float(run.st.fps)
    imp_t, samp_t = run.impulse_t[:k], run.sample_t[:k]
    # every camera layer moves the shots by (a constant) x (where its spring is at
    # each shot): measure the constant once with the simulator, then the search
    # works on exact spring maths (fast) and the simulator checks the result
    ref = (1.0, 20.0) + rec0
    ana_ref = _responses(ref[0], ref[1], ref[2:], delay, imp_t, samp_t, fps).sum(axis=1)
    scale = {}
    for ax, col in (("x", 1), ("y", 0)):
        rows = {a: list(locked[a]) for a in ("x", "y")}
        rows[ax] = rows[ax] + [[ref[0], ref[1], UNIT, 0.0, ref[2], ref[3]]]
        sim = (run.path(with_rows(rows))[:k] - base)[:, col] / UNIT
        scale[ax] = float(sim @ ana_ref / max(ana_ref @ ana_ref, 1e-18))
    memo = {}
    # snap back: the view should be back at the centre this long after the last
    # shot — extra "shots" after the magazine that should land on the aim point
    snap = rcfg.get("snap", 0.6)
    snap = None if snap in (None, False, "off") else max(0.1, float(snap))
    wm = float(w[w > 0].mean())
    smooth = SMOOTH_W if req.get("smooth") is None else max(0.0, min(2.0, float(req["smooth"])))
    # Between the shots the fit can't see the view, so springs could swing wildly
    # there and still land every shot (jittery, "spazzing" recoil). Extra checks
    # keep the motion between two targeted shots near the straight line between
    # them, and the return after the last shot a smooth glide to the centre.
    mid_t, mid_y, mid_w = [], [], []
    wl_ = np.where(np.arange(k) == 0, np.roll(w, -1), w)  # shot 1 counts like shot 2 here
    for i in range(k - 1):
        ww_ = min(wl_[i], wl_[i + 1])
        if ww_ <= 0 or samp_t[i + 1] <= samp_t[i]:
            continue
        for f in (1 / 3, 2 / 3):
            mid_t.append(samp_t[i] + f * (samp_t[i + 1] - samp_t[i]))
            mid_y.append(resid[i] + f * (resid[i + 1] - resid[i]))
            mid_w.append(smooth * ww_)
    post_t, post_y, post_w = [], [], []
    if snap:
        t_end = float(samp_t[-1])
        for j in range(1, 9) if w[-1] > 0 else ():  # (the last shot is free: no known start for the glide)
            f = j / 8.0
            post_t.append(t_end + f * snap)
            post_y.append(resid[-1] * (1 - f * f * (3 - 2 * f)))  # smooth glide to the centre
            post_w.append(smooth * wm)
        for t in float(imp_t[-1]) + snap + np.linspace(0.0, 0.8, 6):
            post_t.append(t); post_y.append(np.zeros(2)); post_w.append(2.0 * wm)
    extra_t = np.array(mid_t + post_t, float)
    extra_y = np.array(mid_y + post_y, float).reshape(-1, 2)
    extra_w = np.array(mid_w + post_w, float)
    # the other parts' contribution at the in-between times isn't known exactly:
    # the targets above are relative to the shots' (base already removed)
    ext_t = np.concatenate([samp_t, extra_t])
    w_ext = np.concatenate([w, extra_w])

    def profile(sp):
        """spring position at every shot (and the snap-back checks) per unit kick at each shot"""
        key = tuple(round(x, 5) for x in sp)
        if key not in memo:
            memo[key] = _responses(sp[0], sp[1], (sp[2], sp[3]), delay, imp_t, ext_t, fps)
        return memo[key]

    def layer_col(sp, ax):
        """How one unit of kick of this layer (d, s, rec d, rec s) on axis ax moves
        every shot (pitch "x" up / down, yaw "y" left / right), then the view after."""
        return scale[ax] * profile(sp).sum(axis=1)

    fixed = req.get("springs")
    spread_size = float(np.sqrt(np.average(np.sum((pts - pts[0]) ** 2, axis=1), weights=np.maximum(w, 1e-9)))) or 1.0
    tol = max(0.02, 0.01 * spread_size)
    # candidates: the feel's springs, each with a few recovery springs (or none: keeps its own)
    rec_set = [rec0] + [r for r in ((0.65, 6.0), (0.85, 9.0), (0.85, 15.0), (0.85, 24.0), (1.2, 9.0), (1.2, 24.0), (0.65, 40.0)) if r != rec0]
    cands = [(d, s) + r for d, s in _GRIDS[feel] for r in rec_set] + [(d, s, d, s) for d, s in _GRIDS[feel]]
    history = {"x": [], "y": []}
    want = "auto"
    if fixed:
        chosen = {}
        for ax in ("x", "y"):
            chosen[ax] = []
            for r in (fixed.get(ax) or [])[:MAX_LAYERS]:
                r = [float(x) for x in r]
                chosen[ax].append(tuple(r[:4]) if len(r) >= 4 else (r[0], r[1]) + rec0)
    else:
        want = req.get("layers") or "auto"
        want = "auto" if str(want).lower() == "auto" else want
        max_l = MAX_LAYERS - max(len(locked["x"]), len(locked["y"])) if want == "auto" else int(min(MAX_LAYERS, max(1, int(want))))
        max_l = max(1, max_l)
        prof_all = np.stack([profile(sp).sum(axis=1) for sp in cands], axis=1)  # (k + extra, C)
        good = np.isfinite(prof_all).all(axis=0)
        sw = np.sqrt(w_ext)
        wsum = max(float(w_ext.sum()), 1e-9)

        def unpack(v):
            out = []
            for i in range(len(v) // 4):
                d, s = _project(feel, math.exp(v[4 * i]), math.exp(v[4 * i + 1]))
                dr, sr = _project_rec(math.exp(v[4 * i + 2]), math.exp(v[4 * i + 3]))
                out.append((round(d, 4), round(s, 3), round(dr, 4), round(sr, 3)))
            return out

        def set_err(springs, ax, y):
            if not springs:
                return float(np.average(y ** 2, weights=np.maximum(w_ext, 1e-9)))
            return _wls(np.stack([layer_col(sp, ax) for sp in springs], 1), y, w_ext, SEL_RIDGE)[1]

        def polish(springs, ax, y, iters):
            """fine-tune the layers' springs and recovery springs together (inside the feel)"""
            def f(v):
                e = set_err(unpack(v), ax, y)
                return e if math.isfinite(e) else 1e30
            v0 = [math.log(max(x, 1e-6)) for sp in springs for x in sp]
            e0 = f(v0)
            vb, e = _nelder_mead(f, v0, step=0.2, iters=iters)
            return (unpack(vb), e) if e < e0 else (list(springs), e0)

        chosen = {}
        iters = int(req.get("polish") or 150)
        for ax, col in (("x", 1), ("y", 0)):
            y = np.concatenate([resid[:, col], extra_y[:, col]])
            cur, best_err = [], set_err([], ax, y)
            if math.sqrt(best_err) < tol and want == "auto":
                chosen[ax] = []
                continue
            Aw = (scale[ax] * prof_all[:, good]) * sw[:, None]
            gidx = np.where(good)[0]
            lam = SEL_RIDGE * float(np.mean(np.sum(Aw ** 2, axis=0)))
            yw = y * sw
            # beam search (a plain one-at-a-time pick misses layers that only work
            # together, like the game's fast "snap" + slow climb); the best small sets
            # are fine-tuned and carry on into the next round
            beam = [((), best_err)]
            BEAM = 6
            while len(cur) < max_l:
                trials = {}
                for members, _ in beam:
                    if members:
                        Bw = np.stack([layer_col(sp, ax) for sp in members], 1) * sw[:, None]
                        Q, _ = np.linalg.qr(Bw)
                        r = yw - Q @ (Q.T @ yw)
                        Ap = Aw - Q @ (Q.T @ Aw)
                    else:
                        r, Ap = yw, Aw
                    errs = (r @ r - (Ap.T @ r) ** 2 / (np.sum(Ap ** 2, axis=0) + lam)) / wsum
                    for c in np.argsort(errs)[:40]:
                        sp = cands[gidx[c]]
                        if sp in members:
                            continue
                        key = tuple(sorted(members + (sp,)))
                        if key not in trials:
                            trials[key] = float(errs[c])
                if not trials:
                    break
                beam = sorted(trials.items(), key=lambda kv: kv[1])[:BEAM]
                if len(beam[0][0]) <= 4:
                    best = None
                    for members, _ in beam[:3]:
                        sp, e = polish(list(members), ax, y, iters)
                        if best is None or e < best[1]:
                            best = (sp, e)
                    new, e_new = best
                    beam = [(tuple(sorted(tuple(x) for x in new)), e_new)] + beam[:BEAM - 1]
                else:
                    new, e_new = list(beam[0][0]), set_err(list(beam[0][0]), ax, y)
                gain = best_err - e_new
                if want == "auto" and cur and (gain < 0.01 * best_err or math.sqrt(best_err) < tol):
                    break
                if cur and e_new >= best_err:  # more layers made it no better: stop here
                    break
                cur, best_err = new, e_new
                history[ax].append(list(cur))
                if want == "auto" and math.sqrt(best_err) < tol:
                    break
            chosen[ax] = cur

    # exact kicks: each fitted layer on its own axis, on the full 2D pattern (locked ones stay)
    ww = np.repeat(w, 2)

    def solve(springs):
        """the best kicks for these springs (with a few Gauss-Newton steps: big
        kicks aren't quite linear, the view turns far); -> (rows, weighted error)"""
        def rows_of(kv):
            out, i = {ax: [list(r) for r in locked[ax]] for ax in ("x", "y")}, 0
            for ax in ("x", "y"):
                for d, s, dr, sr in springs[ax]:
                    out[ax].append([d, s, float(kv[i]), 0.0, dr, sr])
                    i += 1
            return out

        nk = sum(len(v) for v in springs.values())
        # the in-between / after-the-magazine checks (exact spring maths, linear in the kicks)
        E = np.zeros((2 * len(extra_t), nk))
        j = 0
        for ax, col in (("x", 1), ("y", 0)):
            for sp in springs[ax]:
                E[col::2, j] = layer_col(sp, ax)[k:]
                j += 1
        Ey = extra_y.reshape(-1)
        Ew = np.repeat(extra_w, 2)

        def err_of(pc, kv):
            e = (pc - pts).reshape(-1)
            x = E @ kv - Ey if nk else -Ey
            v = float(np.sum(ww * e * e) + np.sum(Ew * x * x))
            return v if math.isfinite(v) else 1e30

        def step(J, r_shots, kv, ridge):
            A = np.concatenate([J, E], axis=0)
            b = np.concatenate([r_shots, Ey - E @ kv])
            return _wls(A, b, np.concatenate([ww, Ew]), ridge=ridge)[0]
        kicks = np.zeros(nk)
        pc = run.path(with_rows(rows_of(kicks)))[:k]
        err = err_of(pc, kicks)
        if not nk:
            return rows_of(kicks), err
        basis = []
        for j in range(nk):
            kv = np.zeros(nk)
            kv[j] = UNIT
            basis.append(((run.path(with_rows(rows_of(kv)))[:k] - pc) / UNIT).reshape(-1))
        k1 = step(np.stack(basis, axis=1), (pts - pc).reshape(-1), kicks, KICK_RIDGE)
        p1 = run.path(with_rows(rows_of(k1)))[:k]
        e1 = err_of(p1, k1)
        if e1 < err:
            kicks, pc, err = k1, p1, e1
        for _ in range(4):
            J = []
            for j in range(nk):
                h = max(UNIT, 0.01 * abs(kicks[j]))
                kv = kicks.copy()
                kv[j] += h
                J.append(((run.path(with_rows(rows_of(kv)))[:k] - pc) / h).reshape(-1))
            delta = step(np.stack(J, axis=1), (pts - pc).reshape(-1), kicks, 1e-6)
            nkv = kicks + delta
            npc = run.path(with_rows(rows_of(nkv)))[:k]
            ne = err_of(npc, nkv)
            if ne >= err * 0.999:
                break
            kicks, pc, err = nkv, npc, ne
        return rows_of(kicks), err

    final = {ax: [tuple(sp) for sp in (chosen.get(ax) or [])] for ax in ("x", "y")}
    rows, err = solve(final)
    if not fixed and want == "auto":
        # many layers can cancel each other with big kicks, which the linear search
        # can't see: also try the smaller fine-tuned sets and keep the better one
        # (fewer layers unless more are clearly closer)
        for size in (3, 2, 1):
            alt = {ax: [tuple(sp) for sp in (history[ax][min(size, len(history[ax])) - 1] if history[ax] else [])] for ax in ("x", "y")}
            if alt == final:
                continue
            r2, e2 = solve(alt)
            nl = lambda sp: sum(len(v) for v in sp.values())
            if e2 < err * (1.1 if nl(alt) < nl(final) else 1.0):
                rows, err, final = r2, e2, alt
    for ax in ("x", "y"):
        for r in rows[ax][len(locked[ax]):]:
            r[2] = round(r[2], 4)
            r[3] = round(abs(r[2]) * variance, 4)

    # variances from per-shot spread targets
    spread_t = req.get("spread")
    spread_info = None
    if variance > 0:
        # Shots without a ring: "randomness" is a share of each shot's own step. Each shot's
        # kick varies by that share, and the variations add up shot after shot
        # (like the game's guns: an AK-47 at 30 % ends up spreading about the
        # same as its own). Asking for that spread per shot keeps layers that
        # cancel each other from piling up randomness (setting each layer's
        # variance as a share of its own kick would).
        given = list(spread_t or [])
        spread_t, acc, prev = [None] * k, 0.0, 0
        for i in range(1, k):
            if w[i] > 0:
                gap = i - prev
                d = float(np.hypot(*(pts[i] - pts[prev]))) / gap
                acc += d * d * gap
                prev = i
            sd = variance * math.sqrt(acc)
            # a ring the user set on this shot wins
            spread_t[i] = given[i] if i < len(given) and given[i] is not None else [sd, sd]
    if spread_t and any(x is not None for x in spread_t[:run.n]):
        rows, spread_info = _fit_spread(run, rows, locked, spread_t, with_rows, [c for c in cands if c[2:] == rec0], profile, scale)

    result = with_rows(rows)
    full = run.path(result)
    miss = np.hypot(*(full[:k] - pts).T)
    on = w_user > 0
    rms = float(np.sqrt(np.average(miss[on] ** 2, weights=w_user[on])))
    sig = run.sigma(result)
    track, settle = run.track(result)
    return {"recoil": sanitize(result), "group": g, "path": full.tolist(), "times": run.times, "miss": miss.tolist(),
            "rms": rms, "worst": int(np.argmax(np.where(on, miss, -1))), "layers": rows,
            "locked": {ax: len(locked[ax]) for ax in ("x", "y")},
            "sigma": np.round(sig, 4).tolist(), "spread_fit": spread_info, "track": track, "settle": settle,
            "delay": delay, "shots": run.n, "magsize": run.mag}


def _fit_spread(run, rows, locked, spread_t, with_rows, cands, profile, scale):
    """Solve the layers' variances so each shot spreads as asked (see the module
    notes); adds spread-only layers (no average kick) where the pattern's own
    layers can't shape it."""
    n = min(run.n, len(spread_t))
    tgt = np.full((n, 2), np.nan)
    for i, v in enumerate(spread_t[:n]):
        if v is not None:
            tgt[i] = [max(0.0, float(v[0])), max(0.0, float(v[1]))]
    # spread from everything else (other parts, hip spread, locked layers' variance)
    quiet = {ax: [list(r[:3]) + [r[3] if j < len(locked[ax]) else 0.0] + list(r[4:6]) for j, r in enumerate(rows[ax])] for ax in ("x", "y")}
    base_var = (run.sigma(with_rows(quiet), runs=400) ** 2)[:n]

    def var_profile(sp, ax):
        """variance at each shot per unit variance^2 of this layer (uniform kick: / 3)"""
        R = profile(sp)[:n]
        return (scale[ax] ** 2) * (R ** 2).sum(axis=1) / 3.0

    out_rows = {ax: [list(r) for r in rows[ax]] for ax in ("x", "y")}
    info = {}
    for ax, col in (("x", 1), ("y", 0)):
        have = ~np.isnan(tgt[:, col])
        if not have.any():
            continue
        want = tgt[:, col] ** 2 - base_var[:, col]
        cols, owners = [], []
        for j in range(len(locked[ax]), len(rows[ax])):
            sp = (rows[ax][j][0], rows[ax][j][1], rows[ax][j][4], rows[ax][j][5])
            cols.append(var_profile(sp, ax))
            owners.append(("layer", j))
        for sp in cands:
            vp = var_profile(sp, ax)
            if np.isfinite(vp).all():
                cols.append(vp)
                owners.append(("new", sp))
        Afull = np.stack(cols, axis=1)
        A = Afull[have]
        b = want[have]
        wscale = 1.0 / (tgt[have, col] ** 2 + 1e-3)  # relative error per shot
        # the fitted layers are preferred: spread-only layers cost a little more
        pen = np.array([1.0 if o[0] == "layer" else 1.15 for o in owners])
        q = _nnls(A * wscale[:, None] / pen[None, :], b * wscale) / pen
        new_idx = [i for i, o in enumerate(owners) if o[0] == "new" and q[i] > 0]
        contrib = {i: float((A[:, i] * q[i]).sum()) for i in new_idx}
        keep_new = sorted(new_idx, key=lambda i: -contrib[i])[:max(0, min(3, MAX_LAYERS - len(out_rows[ax])))]
        sel = [i for i, o in enumerate(owners) if o[0] == "layer"] + keep_new
        q2 = _nnls(A[:, sel] * wscale[:, None] / pen[sel][None, :], b * wscale) / pen[sel]
        q = np.zeros(len(owners))
        q[sel] = q2
        for i in sel:
            o = owners[i]
            v = math.sqrt(max(0.0, q[i]))
            if o[0] == "layer":
                out_rows[ax][o[1]][3] = round(v, 4)
            elif q[i] > 0:
                d, s, dr, sr = o[1]
                out_rows[ax].append([round(d, 4), round(s, 3), 0.0, round(v, 4), round(dr, 4), round(sr, 3)])
        pred = np.sqrt(np.maximum(0.0, Afull @ q + base_var[:, col]))
        info[ax] = {"floor": np.round(np.sqrt(base_var[:, col]), 4).tolist(), "predicted": np.round(pred, 4).tolist()}
    return out_rows, info


def preview_path(gd, req: dict) -> dict:
    """The average path (no randomness, no recoil control) of a recoil table —
    the gun's own or req["recoil"] — for the whole magazine (or req["shots"]),
    with each shot's time; req["runs"] > 0 also returns that many simulated
    magazines' shots (with randomness) for a spread preview; req["sigma"] the
    per-shot spread; req["track"] the motion over time and when the view is back
    at the centre."""
    run = _Runner(gd, req)
    rec = sanitize(req["recoil"]) if req.get("recoil") else gd.base_recoil(run.weapon)
    path = run.path(rec)
    out = {"path": path.tolist(), "times": run.times, "magsize": run.mag, "shots": run.n}
    runs = int(req.get("runs") or 0)
    if runs > 0:
        sc = run.scatter(rec, min(runs, 400))
        out["scatter"] = np.round(np.nan_to_num(sc, nan=1e6), 3).tolist()
    if req.get("sigma"):
        out["sigma"] = np.round(run.sigma(rec), 4).tolist()
    if req.get("track"):
        out["track"], out["settle"] = run.track(rec)
    return out
