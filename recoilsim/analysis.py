"""Turns raw simulation output into the numbers and pictures the UI shows."""
from __future__ import annotations

import copy
import math

import numpy as np

from .simulate import BULLET_LIFETIME, HITBOXES, PART_GROUP, SimResult, SimSettings, _time_to_plane, classify_hits, simulate


def mean_path(cfg, st: SimSettings, track: bool = False):
    """Deterministic 'average' recoil path: every impulse uses its mean value.

    The recoil springs are linear, so this is the expected impact offset per
    shot. A player who has learned the pattern pulls against this path."""

    det = copy.deepcopy(cfg)
    for group in det.recoil.values():
        if not isinstance(group, dict):
            continue
        for rows in group.values():
            if isinstance(rows, list):
                for row in rows:
                    if isinstance(row, list) and len(row) >= 4:
                        row[3] = 0.0
    s2 = copy.copy(st)
    s2.runs = 1
    s2.gravity = False
    det.stats = dict(det.stats)
    det.stats["pelletcount"] = 1
    det.stats["spread"] = None
    det.stats["hipfirespread"] = 0
    s2.record_track = track
    res = simulate(det, s2)
    path = res.impacts[0, :, 0, :]  # (shots, 2)
    return (path, res.track) if track else path


def apply_compensation(res: SimResult, path, amount: float):
    if amount <= 0 or path is None:
        return
    shift = path[None, :, None, :] * amount
    res.impacts = res.impacts - shift
    parts = classify_hits(res.impacts[..., 0], res.impacts[..., 1], res.target_cy)
    ok = res.travel_time <= 2.0
    parts = np.where(ok, parts, -1)
    base = res.dmg_values
    mult = np.array([base["head"], base["torso"], base["limb"], base["limb"], base["limb"], base["limb"], 0.0])
    res.parts = parts
    res.damage = np.where(parts >= 0, mult[parts], 0.0)


def kill_stats(res: SimResult, health: float):
    """Per-run time-to-kill and shots-to-kill."""
    plan = res.plan
    per_shot = res.damage.sum(axis=2)  # (runs, shots)
    cum = np.cumsum(per_shot, axis=1)
    killed = cum >= health - 1e-9
    any_kill = killed.any(axis=1)
    first = np.where(any_kill, killed.argmax(axis=1), -1)
    t_sample = np.array(plan.sample_times)
    t0 = t_sample[0] if len(t_sample) else 0.0
    travel = np.nanmean(np.where(np.isfinite(res.travel_time), res.travel_time, np.nan), axis=2)
    ttk = np.full(per_shot.shape[0], np.nan)
    stk = np.full(per_shot.shape[0], np.nan)
    idx = np.where(any_kill)[0]
    if len(idx):
        k = first[idx]
        ttk[idx] = t_sample[k] - t0 + np.nan_to_num(travel[idx, k], nan=0.0)
        stk[idx] = k + 1
    return {
        "kill_rate": float(any_kill.mean()),
        "ttk": ttk,
        "stk": stk,
        "mag_damage": per_shot.sum(axis=1),
    }


MISS_CAP = 25.0  # studs; a bullet that flies off (or never arrives) counts this far off


def aim_error(res: SimResult):
    """Average distance (studs) of every bullet from the aim point, per run."""
    imp = res.impacts
    d = np.hypot(imp[..., 0], imp[..., 1])
    d = np.where(np.isfinite(d) & (res.travel_time <= 2.0), np.minimum(d, MISS_CAP), MISS_CAP)
    return d.mean(axis=(1, 2))


def score_runs(res: SimResult, health: float, metric: str):
    """Single number per run (lower is better for ttk, higher for others)."""
    ks = kill_stats(res, health)
    if metric == "ttk":
        dur = (res.plan.sample_times[-1] - res.plan.sample_times[0]) if res.plan.sample_times else 0
        penalty = dur + 1.0
        return np.where(np.isnan(ks["ttk"]), penalty, ks["ttk"]), ks
    if metric == "damage":
        return ks["mag_damage"], ks
    if metric == "dps":
        dur = max((res.plan.sample_times[-1] - res.plan.sample_times[0]) if res.plan.sample_times else 0, 1e-3)
        return ks["mag_damage"] / (dur + 60 / max(res.plan.firerates[0], 1e-6)), ks
    if metric == "accuracy":
        return aim_error(res), ks
    if metric == "hits":
        return (res.parts >= 0).mean(axis=(1, 2)), ks
    if metric == "headshots":
        return (res.parts == 0).mean(axis=(1, 2)), ks
    raise ValueError(metric)


METRICS = {
    "accuracy": {"label": "Closest to aim point (avg distance)", "better": "lower"},
    "ttk": {"label": "Time to kill", "better": "lower"},
    "damage": {"label": "Damage per mag", "better": "higher"},
    "dps": {"label": "Damage per second", "better": "higher"},
    "headshots": {"label": "Headshot rate", "better": "higher"},
    "hits": {"label": "Hit rate (any body part)", "better": "higher"},
    # how far the gun keeps its best (lowest) shots to kill, aiming at that part
    "stk_torso": {"label": "First STK range (torso)", "better": "higher"},
    "stk_head": {"label": "First STK range (head)", "better": "higher"},
    "stk_limb": {"label": "First STK range (limb)", "better": "higher"},
}

ONESHOT_CHANCE = 0.8   # default: "reliably one-shots" = at least this share of first shots kill


# where the one-shot ranges aim (target_cy as in simulate: minus the aim height)
ONESHOT_TARGETS = {"head": -1.6, "torso": 0.0, "limb": 2.0}


def one_shot_damage(stats: dict) -> dict:
    """Most damage one shot can do to each part (every pellet hitting it at the
    closest range)."""
    graph = stats.get("damageGraph") or []
    top = max((p["damage"] for p in graph), default=0.0)
    pellets = int(stats.get("pelletcount") or 1)
    return {"head": top * (stats.get("multhead") or 1) * pellets,
            "torso": top * (stats.get("multtorso") or 1) * pellets,
            "limb": top * (stats.get("multlimb") or 1) * pellets}


STK_METRICS = ("stk_torso", "stk_head", "stk_limb")
STK_STEP = 1e4   # score = range - STK_STEP * shots: one shot fewer always beats any range


def best_stk(stats: dict, health: float, part: str):
    """Fewest shots that kill with every shot (all pellets) on `part`, at the
    gun's best range. None if it can't hurt at all."""
    dmg = one_shot_damage(stats)[part]
    return math.ceil(health / dmg - 1e-9) if dmg > 0 else None


def stk_profile(cfg, health: float, part: str, k: int, max_dist: float | None = None, step: float = 0.25):
    """Where `k` shots (every pellet hitting `part`) still kill: the bands of the
    damage curve with shots to kill <= k, like one_shot_profile for k > 1
    (several hits, so pellet spread isn't counted). The bullet lifetime caps it."""
    max_dist = ONESHOT_MAX if max_dist is None else max_dist
    stats = cfg.stats
    graph = sorted(stats.get("damageGraph") or [], key=lambda p: p["distance"])
    gx = np.array([p["distance"] for p in graph], float) if graph else np.array([0.0])
    gy = np.array([p["damage"] for p in graph], float) if graph else np.array([0.0])
    mult = {"head": stats.get("multhead") or 1, "torso": stats.get("multtorso") or 1, "limb": stats.get("multlimb") or 1}[part]
    pellets = int(stats.get("pelletcount") or 1)
    end = min(max_dist, float(stats.get("bulletspeed") or 2000) * BULLET_LIFETIME)

    def ok(d):
        return np.interp(d, gx, gy) * mult * pellets * k >= health - 1e-9

    last = min(float(gx[-1]), end)
    D = np.append(np.arange(0.0, last + step, step), end)
    D = np.unique(np.clip(D, 0, end))
    P = np.array([1.0 if ok(d) else 0.0 for d in D])
    if end < max_dist:  # bullets expire: no kill beyond
        D = np.append(D, max_dist)
        P = np.append(P, 0.0)

    def refine(lo, hi, rising):
        for _ in range(30):
            mid = 0.5 * (lo + hi)
            if (ok(mid) and mid <= end) == rising:
                hi = mid
            else:
                lo = mid
        return 0.5 * (lo + hi)
    bands = _bands_from(D, P, 0.5, refine, max_dist)
    coverage = sum((max_dist if b is None else b) - a for a, b in bands)
    reach = max(((max_dist if b is None else b) for _a, b in bands), default=0.0)
    pointblank = next(((max_dist if b is None else b) for a, b in bands if a == 0.0), 0.0)
    return {"bands": bands, "coverage": float(coverage), "reach": float(reach), "pointblank": float(pointblank),
            "avg": float(coverage), "bands50": bands}


def one_shot_part(stats: dict, health: float = 100.0):
    """The part a one-shot gun's goal aims at: single bullets go for the torso, or
    the limbs when those take more damage; pellet guns always aim at the torso (their
    pellets spread onto the limbs anyway) and count when every pellet on the torso
    kills. None when it can't be one-shot."""
    d = one_shot_damage(stats)
    if int(stats.get("pelletcount") or 1) > 1:
        return "torso" if d["torso"] >= health - 1e-9 else None
    part = "limb" if d["limb"] > d["torso"] + 1e-9 else "torso"
    return part if d[part] >= health - 1e-9 else None


def stk_auto_part(stats: dict) -> str:
    """The part "First STK range (auto)" aims at: the limbs for a single-bullet gun
    whose limbs take more damage than its torso, else the torso (pellet guns
    always the torso: their pellets spread onto the limbs anyway)."""
    if int(stats.get("pelletcount") or 1) > 1:
        return "torso"
    d = one_shot_damage(stats)
    return "limb" if d["limb"] > d["torso"] + 1e-9 else "torso"


def can_one_shot(stats: dict, health: float = 100.0, part: str = "torso") -> bool:
    """Guns that can kill with one shot to the torso (or the limbs, which never
    take more than the torso) get the one-shot goal by default."""
    return one_shot_damage(stats)[part] >= health - 1e-9


# handling: these stats count, each as its change relative to the bare gun
HANDLING_STATS = ("aimspeed", "unaimspeed", "walkspeed", "aimwalk", "sprintspeed", "unsprintspeed", "equipspeed")


def handling_score(stats: dict, base: dict) -> float:
    """Average relative change of aim / unaim speed, walk speed (hip and aimed),
    sprint speed, sprint-to-fire speed and equip speed vs the bare gun
    (0.05 = 5 % better handling on average)."""
    def val(st, k):
        if k == "aimwalk":
            w, m = st.get("walkspeed"), st.get("aimwalkspeedmult")
            return w * m if isinstance(w, (int, float)) and isinstance(m, (int, float)) else None
        v = st.get(k)
        return v if isinstance(v, (int, float)) and not isinstance(v, bool) else None
    ch = []
    for k in HANDLING_STATS:
        a, b = val(stats, k), val(base, k)
        if a is not None and b:
            ch.append(a / b - 1.0)
    return float(np.mean(ch)) if ch else 0.0


def one_shot_distances(res: SimResult, cfg, st: SimSettings, health: float, max_dist: float = 2000.0,
                       target_cy: float | None = None):
    """Per run: the farthest distance at which that run's first shot (every
    pellet of it) still kills. Uses the first shot's rays from a simulation
    with keep_rays, so every distance sees exactly the same pellet pattern:
    only the pellets' spread at that range, the damage fall-off and the
    2 s bullet lifetime change. The share of runs whose distance is at least
    d is the chance to one-shot at d."""
    rays = res.rays
    if rays is None:
        raise ValueError("simulate with keep_rays=True")
    stats = cfg.stats
    graph = sorted(stats.get("damageGraph") or [], key=lambda p: p["distance"])
    R = rays["vel"].shape[0]
    if not graph:
        return np.zeros(R)
    gx = np.array([p["distance"] for p in graph], float)
    gy = np.array([p["damage"] for p in graph], float)
    mh = stats.get("multhead") or 1
    mt = stats.get("multtorso") or 1
    ml = stats.get("multlimb") or 1
    mult = np.array([mh, mt, ml, ml, ml, ml, 0.0])
    o, vel, acc = rays["o"], rays["vel"], rays["acc"]
    oz = np.broadcast_to(o[:, None, 2], vel[..., 2].shape)

    def kills(d):  # d: (R,) distances -> (R,) bool
        tt = _time_to_plane(oz, vel[..., 2], acc[..., 2], -d[:, None])
        x = o[:, None, 0] + vel[..., 0] * tt + 0.5 * acc[..., 0] * tt * tt
        y = o[:, None, 1] + vel[..., 1] * tt + 0.5 * acc[..., 1] * tt * tt
        parts = classify_hits(x, y, res.target_cy if target_cy is None else target_cy)
        ok = (parts >= 0) & (tt <= BULLET_LIFETIME)
        dmg = np.interp(d, gx, gy)[:, None] * mult[np.where(parts >= 0, parts, 6)]
        return np.where(ok, dmg, 0.0).sum(axis=1) >= health - 1e-9

    # no run can kill beyond the distance where every pellet in the head isn't enough
    pellets = vel.shape[1]
    best = max(mh, mt, ml) * pellets
    hi = max_dist
    if gy[-1] * best < health - 1e-9:
        lo_d, hi_d = 0.0, max_dist
        for _ in range(40):
            mid = 0.5 * (lo_d + hi_d)
            if np.interp(mid, gx, gy) * best >= health - 1e-9:
                lo_d = mid
            else:
                hi_d = mid
        hi = min(max_dist, hi_d)
    lo = np.full(R, 0.0)
    hi_a = np.full(R, hi)
    near = kills(np.full(R, 0.5))
    top = kills(hi_a)
    out = np.where(top, hi, 0.0)
    todo = near & ~top
    lo[:] = 0.5
    for _ in range(18):  # ~0.01 st resolution at 2000 st
        mid = 0.5 * (lo + hi_a)
        k = kills(mid)
        lo = np.where(k, mid, lo)
        hi_a = np.where(k, hi_a, mid)
    return np.where(todo, lo, out)


_trapz = getattr(np, "trapezoid", None) or np.trapz  # numpy 1.x has only trapz
ONESHOT_MAX = 2000.0  # one-shot bands are measured out to here ("+" = still one-shots there)


def _one_shot_kills(res: SimResult, cfg, health: float, target_cy: float, runs: int | None = None, shots: int = 1):
    """kills(d) -> (runs,) bool: does each run's first shot kill at distance d.
    shots > 1: do that many shots kill, each a fresh aimed shot with its own pellet
    pattern (the first shots of the next runs), every pellet scored by the part it
    hits (head, torso, limb or a miss)."""
    rays = res.rays
    if rays is None:
        raise ValueError("simulate with keep_rays=True")
    stats = cfg.stats
    graph = sorted(stats.get("damageGraph") or [], key=lambda p: p["distance"])
    gx = np.array([p["distance"] for p in graph], float) if graph else np.array([0.0])
    gy = np.array([p["damage"] for p in graph], float) if graph else np.array([0.0])
    mh = stats.get("multhead") or 1
    mt = stats.get("multtorso") or 1
    ml = stats.get("multlimb") or 1
    mult = np.array([mh, mt, ml, ml, ml, ml, 0.0])
    o, vel, acc = rays["o"][:runs], rays["vel"][:runs], rays["acc"][:runs]
    oz = o[:, None, 2] + np.zeros(vel.shape[:2])

    def kills(d):
        tt = _time_to_plane(oz, vel[..., 2], acc[..., 2], -float(d))
        x = o[:, None, 0] + vel[..., 0] * tt + 0.5 * acc[..., 0] * tt * tt
        y = o[:, None, 1] + vel[..., 1] * tt + 0.5 * acc[..., 1] * tt * tt
        parts = classify_hits(x, y, target_cy)
        ok = (parts >= 0) & (tt <= BULLET_LIFETIME)
        dmg = float(np.interp(d, gx, gy)) * mult[np.where(parts >= 0, parts, 6)]
        per = np.where(ok, dmg, 0.0).sum(axis=1)
        if shots > 1:
            per = sum(np.roll(per, -j) for j in range(shots))
        return per >= health - 1e-9

    return kills, float(gx[-1])


def _bands_from(D, P, thr, refine, max_dist):
    """Contiguous distance bands where P >= thr, edges refined with refine(lo, hi, rising)."""
    on = P >= thr - 1e-12
    bands = []
    i, n = 0, len(D)
    while i < n:
        if not on[i]:
            i += 1
            continue
        j = i
        while j + 1 < n and on[j + 1]:
            j += 1
        a = 0.0 if i == 0 else refine(D[i - 1], D[i], True)
        b = None if j == n - 1 and D[-1] >= max_dist - 1e-9 else (refine(D[j], D[j + 1], False) if j + 1 < n else D[j])
        bands.append((a, b))
        i = j + 1
    return bands


def one_shot_profile(res: SimResult, cfg, health: float, target_cy: float = 0.0, chance: float = ONESHOT_CHANCE,
                     keep_matrix: bool = False, max_dist: float = ONESHOT_MAX, runs: int | None = None,
                     step: float = 2.0, shots: int = 1):
    """Where the first shot one-shots (or, with shots > 1, where that many pellet
    shots kill). Handles every damage curve: normal fall-off
    (kills from 0 out to some range), rising damage (kills from some range on, e.g.
    the KAC SRR or a bolo round) and humps (kills only between two ranges, e.g.
    the M107's torso). Returns
      bands     [(from, to)] where at least `chance` of first shots kill (to None = still at max_dist)
      coverage  total length of those bands: the score (bigger = one-shots over more
                range; for a band that runs to the end, that means it starts closer)
      avg       expected one-shot length: integral of the kill chance over distance
                (for a normal curve this is the average one-shot range)
      bands50   bands where at least half the shots kill
      K         (keep_matrix) per-run kills on the distance grid (`step` studs), for bootstrapping."""
    kills, last = _one_shot_kills(res, cfg, health, target_cy, runs, shots)
    grid = np.arange(0.5, max(last, 0.5) + step, step)
    K = np.stack([kills(d) for d in grid], axis=1)
    P = K.mean(axis=0)
    D = grid
    tail_const = None
    if P[-1] > 0:
        # past the last damage-curve point damage is constant, so the kill chance
        # only falls (pellets drift off the target, bullets expire)
        p_end = kills(max_dist).mean()
        if p_end >= P[-1] - 1e-12:
            tail_const = P[-1]
            D = np.append(D, max_dist)
            P = np.append(P, p_end)
        else:
            extra_d, extra_p = [], []
            d = grid[-1]
            while d < max_dist:
                d = min(max_dist, d + 5.0)
                pv = kills(d).mean()
                extra_d.append(d)
                extra_p.append(pv)
                if pv <= 0:
                    break
            D = np.append(D, extra_d)
            P = np.append(P, extra_p)

    def refine_for(thr):
        def refine(lo, hi, rising):
            for _ in range(10):
                mid = 0.5 * (lo + hi)
                good = kills(mid).mean() >= thr - 1e-12
                if good == rising:
                    hi = mid
                else:
                    lo = mid
            return 0.5 * (lo + hi)
        return refine

    bands = _bands_from(D, P, chance, refine_for(chance), max_dist)
    coverage = sum((max_dist if b is None else b) - a for a, b in bands)
    # farthest the shot one-shots, and how far it one-shots from point blank
    reach = max(((max_dist if b is None else b) for _a, b in bands), default=0.0)
    pointblank = next(((max_dist if b is None else b) for a, b in bands if a == 0.0), 0.0)
    avg = float(_trapz(np.concatenate(([P[0]], P)), np.concatenate(([0.0], D))))
    out = {"bands": bands, "coverage": float(coverage), "reach": float(reach), "pointblank": float(pointblank), "avg": avg,
           "bands50": _bands_from(D, P, 0.5, refine_for(0.5), max_dist), "last": last, "tail": tail_const}
    if keep_matrix:
        out["K"] = K
        out["step"] = step
    return out


def grid_coverage(K, chance, idx=None, step: float = 2.0, mode: str = "coverage"):
    """The one-shot score on the distance grid (for paired bootstrap differences):
    "coverage" total length, "reach" farthest one-shot, "pointblank" one-shot
    range from point blank."""
    on = (K if idx is None else K[idx]).mean(axis=0) >= chance - 1e-12
    if mode == "reach":
        nz = np.nonzero(on)[0]
        return float(nz[-1] + 1) * step if nz.size else 0.0
    if mode == "pointblank":
        off = np.nonzero(~on)[0]
        return float(off[0] if off.size else on.size) * step
    return float(on.sum()) * step


def one_shot_mode(base_stats: dict, cls: str | None = None) -> str:
    """How one-shot setups are compared. Shotguns (pellets or the shotgun class):
    "pointblank" — how far they one-shot from point blank. Everything else
    (snipers with a damage sweet spot, rising damage…): "coverage" — the total
    length of range they one-shot over (a 50–150 sweet spot counts 100)."""
    if (cls or "").upper() == "SHOTGUN" or int(base_stats.get("pelletcount") or 1) > 1:
        return "pointblank"
    return "coverage"


def band_text(bands, max_dist: float = ONESHOT_MAX, plain_from_zero: float | None = None) -> str:
    """'106.5' (from point blank), '80.0–250.0', '197.4+' (to the end), '–' (never)."""
    if not bands:
        return "–"
    if plain_from_zero is not None and len(bands) == 1 and bands[0][0] == 0.0:
        b = bands[0][1]
        return f"{plain_from_zero:.1f}" if b is not None else "any range"
    parts = []
    for a, b in bands:
        if a == 0.0 and b is not None:
            parts.append(f"{b:.1f}" if len(bands) == 1 else f"0–{b:.1f}")
        elif b is None:
            parts.append(f"{a:.1f}+" if a > 0 else "any range")
        else:
            parts.append(f"{a:.1f}–{b:.1f}")
    return ", ".join(parts)


def one_shot_range(dists, chance=ONESHOT_CHANCE):
    """Farthest distance at which at least `chance` of first shots kill."""
    dists = np.asarray(dists, float)
    if dists.size == 0:
        return 0.0
    return float(np.quantile(dists, 1.0 - chance, method="lower"))


def heatmap(res: SimResult, bounds, bins=(90, 120)):
    x = res.impacts[..., 0].ravel()
    y = res.impacts[..., 1].ravel()
    ok = np.isfinite(x) & np.isfinite(y)
    (x0, x1), (y0, y1) = bounds
    h, _, _ = np.histogram2d(x[ok], y[ok], bins=bins, range=[[x0, x1], [y0, y1]])
    # light blur so the map reads as density rather than speckle
    k = np.array([1, 4, 6, 4, 1], float)
    k /= k.sum()
    h = np.apply_along_axis(lambda r: np.convolve(r, k, mode="same"), 0, h)
    h = np.apply_along_axis(lambda r: np.convolve(r, k, mode="same"), 1, h)
    total = max(int(ok.sum()), 1)
    return {"grid": (h.T / h.max() if h.max() > 0 else h.T).round(4).tolist(),
            "x0": x0, "x1": x1, "y0": y0, "y1": y1, "count": total,
            "outside": int(total - ((x[ok] >= x0) & (x[ok] <= x1) & (y[ok] >= y0) & (y[ok] <= y1)).sum())}


def summarize(res: SimResult, st: SimSettings, health: float):
    imp = res.impacts
    runs, shots, pellets, _ = imp.shape
    parts = res.parts
    total = parts.size
    hit = parts >= 0
    groups = {"head": 0, "torso": 0, "limb": 0}
    for i, (name, *_rest) in enumerate(HITBOXES):
        groups[PART_GROUP[name]] += int((parts == i).sum())
    ks = kill_stats(res, health)
    ttk = ks["ttk"]
    stk = ks["stk"]
    finite = np.isfinite(imp[..., 0]) & np.isfinite(imp[..., 1])
    xs = imp[..., 0][finite]
    ys = imp[..., 1][finite]
    per_shot_mean = np.nanmean(np.where(finite[..., None], imp, np.nan), axis=(0, 2))
    per_shot_hit = hit.mean(axis=(0, 2))
    dist = st.distance
    to_deg = lambda studs: math.degrees(math.atan2(studs, dist))
    spread_x = float(np.std(xs)) if xs.size else 0.0
    spread_y = float(np.std(ys)) if ys.size else 0.0
    # spread around each shot's average position (what remains for a perfect controller)
    resid = imp - np.nanmean(np.where(finite[..., None], imp, np.nan), axis=0, keepdims=True)
    resid = resid[finite]
    rand_r = float(np.sqrt(np.mean(np.sum(resid ** 2, axis=-1)))) if resid.size else 0.0
    out = {
        "runs": runs,
        "shots": shots,
        "pellets": pellets,
        "bullets": int(total),
        "hit_rate": float(hit.mean()) if total else 0.0,
        "aim_error": float(aim_error(res).mean()) if total else 0.0,
        "head_rate": groups["head"] / total if total else 0.0,
        "torso_rate": groups["torso"] / total if total else 0.0,
        "limb_rate": groups["limb"] / total if total else 0.0,
        "avg_mag_damage": float(ks["mag_damage"].mean()),
        "kill_rate": ks["kill_rate"],
        "ttk_mean": float(np.nanmean(ttk)) if np.isfinite(ttk).any() else None,
        "ttk_median": float(np.nanmedian(ttk)) if np.isfinite(ttk).any() else None,
        "ttk_best": float(np.nanmin(ttk)) if np.isfinite(ttk).any() else None,
        "stk_mean": float(np.nanmean(stk)) if np.isfinite(stk).any() else None,
        "spread_x": spread_x,
        "spread_y": spread_y,
        "spread_x_deg": to_deg(spread_x),
        "spread_y_deg": to_deg(spread_y),
        "random_radius": rand_r,
        "random_radius_deg": to_deg(rand_r),
        "final_climb": float(per_shot_mean[-1, 1]) if shots else 0.0,
        "max_climb": float(np.nanmax(per_shot_mean[:, 1])) if shots else 0.0,
        "mean_path": [[float(a), float(b)] for a, b in np.nan_to_num(per_shot_mean)],
        "per_shot_hit": [float(v) for v in per_shot_hit],
        "damage": {k: round(float(v), 3) for k, v in res.dmg_values.items()},
        "firemode": res.plan.label,
        "duration": (res.plan.sample_times[-1] - res.plan.sample_times[0]) if res.plan.sample_times else 0,
        "effective_rpm": (60 * (shots - 1) / max(res.plan.sample_times[-1] - res.plan.sample_times[0], 1e-9)) if shots > 1 else None,
    }
    return out
