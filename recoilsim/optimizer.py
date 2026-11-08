"""Searches attachment combinations for the statistically best setup.

One button, always the deepest search that is practical:

 1. For every slot, compile each attachment on its own and group attachments
    whose shooting-relevant stats are identical. Attachments that change
    nothing about shooting (most sights, lights, lasers...) fall into the
    "empty slot" group and are never simulated separately.
 2. If the number of distinct combinations is manageable, every one of them
    is simulated (exhaustive search).
 3. Otherwise: score each option on its own, simulate every combination of
    the best options per slot, then refine the best setups by swapping one
    slot at a time for every option until nothing improves.
 4. The best setups are re-run with many more mag dumps for the final ranking.

All candidates in a stage use the same random numbers (common random numbers),
so differences between setups are not drowned out by noise. Simulations run in
worker processes, so the range stays responsive while the search runs.
"""
from __future__ import annotations

import copy
import hashlib
import itertools
import json
import math
import os
import threading
import time
import uuid
import warnings
from concurrent.futures import ProcessPoolExecutor

import numpy as np

from .analysis import (METRICS, ONESHOT_CHANCE, ONESHOT_TARGETS, STK_METRICS, STK_STEP, aim_error, apply_compensation,
                       band_text, best_stk, stk_profile,
                       grid_coverage, handling_score, mean_path, one_shot_damage, one_shot_mode, one_shot_profile, score_runs,
                       summarize)
from .gamedata import SLOTS, GameData
from .simulate import SimSettings, simulate

RELEVANT_KEYS = (
    "recoil", "firerate", "firemodes", "magsize", "damageGraph", "multhead", "multtorso",
    "multlimb", "bulletspeed", "bulletaccel", "spread", "pelletcount", "choke", "xbias", "ybias",
    "hipfirespread", "hipfirespreadrecover", "hipfirestability", "crosssize", "crossexpansion",
    "crossspeed", "crossdamper", "recoildelay", "firedelay", "aimedfirerate", "variablefirerate",
    "burstfirerate", "firecap", "autoburst", "heatfireratekick", "heatfireratespeed",
    "heatfireratedamping", "heatfireratecap", "heatfireratemin", "heatfirerateignorelist",
    "firemodestability", "forcecap", "onfireanim", "requirechamber", "chambered", "altreloadlong",
    "doubleactiondelay",
)

# smallest differences that count (the last digit shown in the results)
RESOLUTION = {"accuracy": 1e-4, "ttk": 1e-5, "damage": 1e-2, "dps": 1e-2, "hits": 1e-5, "headshots": 1e-5,
              "stk_torso": 0.1, "stk_head": 0.1, "stk_limb": 0.1}
STUD_RES = 1e-4
HANDLING_RES = 1e-3     # 0.1 % handling: smaller differences are ties
OSAVG_RES = 0.01        # average one-shot range: differences under 0.01 st are ties (setups that
                        # change neither pellets nor damage tie exactly: same random numbers)
RECOIL_TIE = 1e-3       # one-shot goal: recoil differences under 0.001 st distance from aim are ties


def snap(v, res):
    return 0.0 if abs(v) < res / 2 else v


EXHAUSTIVE_MAX = 3000   # simulate every combination when there are at most this many
RUNS_SEARCH = 200       # mag dumps per candidate while searching
RUNS_FINAL = 3000       # mag dumps per finalist
KEEP_PER_SLOT = 6       # options per slot kept for the combination stage (big guns)
REFINE_STARTS = 5       # local-search starting points
EXPAND_TOP = 10         # every one-slot swap of this many leading setups per list is tried
TOP_N = 10              # setups listed

# search depth presets (the finder defaults to "thorough"; every-gun exports to "quick")
DEPTHS = {
    "thorough": {},
    "standard": {"exhaustive_max": 1200, "max_combos": 1200, "runs_search": 150, "runs_final": 1500,
                 "keep_per_slot": 5, "refine_starts": 3, "expand_top": 5},
    "quick": {"exhaustive_max": 300, "max_combos": 300, "runs_search": 80, "runs_final": 500,
              "keep_per_slot": 3, "refine_starts": 2, "expand_top": 0},
}


def _str_keys(o):
    if isinstance(o, dict):
        return {str(k): _str_keys(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [_str_keys(v) for v in o]
    if isinstance(o, float):
        return round(o, 10)
    return o


def signature(cfg):
    """Hash of everything that affects shooting: equal hashes shoot identically."""
    rel = _str_keys({k: cfg.stats.get(k) for k in RELEVANT_KEYS})
    blob = json.dumps(rel, sort_keys=True, default=str)
    return hashlib.sha1(blob.encode()).hexdigest()


# Joke / novelty attachments left out of searches by default (the user can put
# them back). "*" applies to every gun; other keys only to that gun.
DEFAULT_EXCLUDES = {
    "*": ["DCL 120", "Halbek Device", "Oil Filter", "Oil Filter (Alt)", "Muffler", "Muffler (Alt)",
          "Ballistics Tracker", "Canted Acog Scope", "Canted Animu Sight", "Canted Furro Sight",
          "Suppressor..?", "M107 .17 Wildcat", ".17 Wildcat", "KS HARPOON", ".223 Remington", ".223 Remington (Alt)"],
    "M231": ["Heavy Buffer"],
}


def default_exclude_map(gd: GameData) -> dict:
    """The built-in default exclusions: the joke list for every gun, gun-specific
    entries, and every admin / super-tester-only attachment on normal guns (test
    guns keep theirs: that's what they're for)."""
    out = {k: list(v) for k, v in DEFAULT_EXCLUDES.items()}
    for w in gd.weapon_names():
        if gd.is_test_weapon(w):
            continue
        for slot, opts in gd.attachment_options(w).items():
            for o in opts:
                if o.get("test") and o["name"] not in out.setdefault(w, []):
                    out[w].append(o["name"])
    return {k: v for k, v in out.items() if v}


def default_excludes_for(gd: GameData, weapon: str, tokens=None) -> dict:
    """{slot: [attachment names]} to leave out for this gun. `tokens` is a list
    of attachment names (any gun) and "GUN::name" entries (that gun only);
    None means the defaults."""
    if tokens is None:
        dm = default_exclude_map(gd)
        tokens = dm["*"] + [f"{w}::{n}" for w, names in dm.items() if w != "*" for n in names]
    tokens = set(tokens)
    out = {}
    for slot, opts in gd.attachment_options(weapon).items():
        names = [o["name"] for o in opts if o["name"] in tokens or f"{weapon}::{o['name']}" in tokens]
        if "" in tokens or f"{weapon}::" in tokens:
            names.append("")
        if names:
            out[slot] = names
    return out


def slot_groups_for(gd: GameData, weapon: str, base_lock: dict, slots, exclude: dict | None = None):
    """{slot: [{"rep": name|None, "members": [...]}, ...]} grouping identical options.
    The group containing the empty slot always has rep None."""
    options = gd.attachment_options(weapon)
    out = {}
    for slot in slots:
        excluded = set((exclude or {}).get(slot) or [])
        candidates = [None] + [o["name"] for o in options.get(slot, [])]
        candidates = [c for c in candidates if (c or "") not in excluded] or [None]
        groups = {}
        none_sig = signature(gd.compile(weapon, base_lock))
        for opt in candidates:
            atts = dict(base_lock)
            if opt:
                atts[slot] = opt
            sig = none_sig if opt is None else signature(gd.compile(weapon, atts))
            groups.setdefault(sig, []).append(opt)
        lst = []
        for sig, members in groups.items():
            rep = None if (None in members or sig == none_sig) else members[0]
            lst.append({"rep": rep, "members": members, "no_effect": sig == none_sig})
        out[slot] = lst
    return out


# ----------------------------------------------------------------------------- evaluation
_WORKER_GD = None


def _init_worker(data_path):
    global _WORKER_GD
    _lower_priority()
    _WORKER_GD = GameData(data_path)


def _lower_priority():
    """Search workers run below normal priority so the range (server + browser)
    always stays responsive while a search is going."""
    try:
        if os.name == "nt":
            import ctypes
            BELOW_NORMAL = 0x00004000
            ctypes.windll.kernel32.SetPriorityClass(ctypes.windll.kernel32.GetCurrentProcess(), BELOW_NORMAL)
        else:
            os.nice(10)
    except Exception:
        pass


_BASE = {}


def _base_stats(gd, weapon):
    k = (id(gd), weapon)
    if k not in _BASE:
        _BASE[k] = gd.compile(weapon, {}).stats
    return _BASE[k]


def one_shot_averages(res, cfg, health, known=None):
    """Per part (aiming at the head, torso, legs): None where even every pellet on
    it can't kill, else {"avg": expected one-shot length (for a normal damage curve
    the average one-shot range), "text": where at least half the shots one-shot}."""
    dmg = one_shot_damage(cfg.stats)
    out = {}
    for part, cy in ONESHOT_TARGETS.items():
        if dmg[part] < health - 1e-9:
            out[part] = None
            continue
        # (display only: 1000 mag dumps are plenty)
        prof = (known or {}).get(part) or one_shot_profile(res, cfg, health, cy, 0.5, runs=1000)
        b50 = prof["bands50"]
        simple = len(b50) == 1 and b50[0][0] == 0.0 and b50[0][1] is not None
        out[part] = {"avg": prof["avg"], "text": f"{prof['avg']:.1f}" if simple else band_text(b50)}
    return out


SUMMARY_KEYS = ("aim_error", "hit_rate", "head_rate", "torso_rate", "limb_rate", "avg_mag_damage",
                "kill_rate", "ttk_mean", "ttk_median", "stk_mean", "random_radius", "final_climb", "effective_rpm")
# numbers that depend on how many rounds the magazine really holds
PER_MAG_KEYS = ("avg_mag_damage", "kill_rate", "ttk_mean", "ttk_median", "stk_mean", "effective_rpm")


def _summary(res, cfg, st, health, comp, shots_forced):
    """Result numbers for the finder's tables. Accuracy numbers come from the
    same-length run the ranking uses; when that run isn't the setup's own
    magazine, kills / mag, damage / mag, TTK and shots to kill are re-run with
    the magazine the setup really has, so they stay true to the gun."""
    s = summarize(res, st, health)
    summ = {k: s[k] for k in SUMMARY_KEYS}
    if shots_forced:
        st2 = copy.copy(st)
        st2.shots = None
        st2.keep_rays = False
        res2 = simulate(cfg, st2)
        if comp > 0:
            apply_compensation(res2, mean_path(cfg, st2), comp)
        s2 = summarize(res2, st2, health)
        summ.update({k: s2[k] for k in PER_MAG_KEYS})
    summ["mag_rounds"] = int(math.ceil(cfg.stats.get("magsize") or 0))
    return summ


def evaluate(gd, weapon, attachments, settings, metric, runs, seed, want_summary=False):
    """Score one setup. Returns (score, stderr, mag_damage_mean, summary|None,
    per-run scores|None, {"climb", "spread"}).

    Bullet drop is held over perfectly by default (as a player does at a known
    range; settings["drop"] = True makes it count instead), so it never counts
    as recoil: an attachment that only changes bullet speed
    can't look like it reduces climb just because slower bullets drop more.
    Bullet speed still counts where it really matters: travel time (TTK).

    metrics "stk_torso" / "stk_head" / "stk_limb" (first STK range): the fewest
    shots that kill that part, and the range over which they still do (for one
    shot: where the first shot kills in at least settings["oneshot_chance"] %
    (default 80) of runs), scored as range - 10000 * shots;
    the third value is then minus the average distance from the aim point (recoil), and
    parts["handling"] (always filled) ranks equal ranges before recoil does."""
    health = float(settings.get("health", 100))
    comp = float(settings.get("compensation", 0)) / 100.0
    cfg = gd.compile(weapon, attachments)
    shots = settings.get("shots") or None
    if not shots and metric not in ("damage", "dps"):
        # every setup fires the same number of rounds: the bare gun's magazine.
        # Otherwise a smaller magazine (e.g. the M107's 5-round one) "wins" on
        # recoil just because the pattern stops before it climbs. Damage goals
        # keep each setup's own magazine, where its size really matters.
        shots = int(math.ceil(_base_stats(gd, weapon).get("magsize") or 0)) or None
    # whether that differs from this setup's own magazine (then the per-magazine
    # numbers shown in the results are taken from a run of its real magazine)
    shots_forced = bool(shots) and not settings.get("shots") and shots != int(math.ceil(cfg.stats.get("magsize") or 0))
    st = SimSettings(
        distance=float(settings.get("distance", 50)),
        aiming=bool(settings.get("aiming", True)),
        stance=settings.get("stance", "stand"),
        firemode_index=int(settings.get("firemode_index", 0)),
        firemode_label=settings.get("firemode_label") or None,
        shots=shots,
        fps=float(settings.get("fps", 60)),
        trigger_rpm=settings.get("trigger_rpm") or None,
        aim_point=settings.get("aim_point", "torso"),
        aim_offset=settings.get("aim_offset"),
        # drop is held over by default (see above); "drop": true makes it count
        gravity=bool(settings.get("drop", False)),
        runs=runs,
        seed=seed,
        keep_rays=metric in STK_METRICS,
    )
    res = simulate(cfg, st)
    oneshot = metric in STK_METRICS
    # climb / spread are measured before recoil control: climb is how far the
    # recoil drags the average pattern from the aim point (what a player has to
    # pull against). After a perfect pull it would be ~0 for every gun and only
    # rank sampling noise; spread doesn't change with recoil control at all.
    parts = pattern_parts(res)
    parts["handling"] = handling_score(cfg.stats, _base_stats(gd, weapon))
    batches = None
    if want_summary:
        # climb / spread on 20 slices of the mag dumps, for paired noise estimates
        B = 20
        idx = np.array_split(np.arange(res.impacts.shape[0]), B)
        sl = [pattern_parts_arr(res.impacts[i]) for i in idx if len(i)]
        batches = np.array([[p["climb"], p["spread"]] for p in sl])
    if comp > 0:
        apply_compensation(res, mean_path(cfg, st), comp)
    if oneshot:
        chance = float(settings.get("oneshot_chance") or ONESHOT_CHANCE * 100) / 100.0
        # first STK range: the fewest shots to kill this part at the gun's best range
        # (one shot: every pellet's spread and the hit chance counted; more shots:
        # the damage curve), then how much range that holds over — shotguns from
        # point blank, other guns the total length (closer start for rising damage)
        part = metric.split("_", 1)[1]
        k0 = best_stk(cfg.stats, health, part) or 99
        prof = None
        if int(cfg.stats.get("pelletcount") or 1) > 1 and k0 < 99:
            # pellets: every pellet counts for the part it really hits (some land on the
            # head or limbs, some miss), so the fewest shots can be below the every-
            # pellet-on-the-part count (head pellets) or above it (misses)
            k_lo = min(best_stk(cfg.stats, health, p) or 99 for p in ("head", "torso", "limb"))
            for k in range(k_lo, k0 + 4):
                prof = one_shot_profile(res, cfg, health, ONESHOT_TARGETS[part], chance, keep_matrix=want_summary, shots=k)
                if prof["bands"]:
                    k0 = k
                    break
            else:
                prof = stk_profile(cfg, health, part, k0)
        elif k0 == 1:
            prof = one_shot_profile(res, cfg, health, ONESHOT_TARGETS[part], chance, keep_matrix=want_summary)
        else:
            prof = stk_profile(cfg, health, part, k0)
        mode = one_shot_mode(_base_stats(gd, weapon), cfg.weapon_class)
        score = prof[mode] - STK_STEP * k0
        parts["os_reach"] = prof["reach"]
        parts["os_cov"] = prof["coverage"]
        # the expected one-shot length breaks ties of the reliable range: e.g. a
        # suppressor that stretches the damage fall-off when pellet spread, not
        # damage, sets how far the shot reliably kills
        parts["oneshot_avg"] = prof["avg"]
        # setups that need more than one shot (single bullet or pellets): equal
        # ranges go to less recoil before handling, since a several-shot kill needs
        # the follow-ups to land; one-shots: handling first
        parts["recoil_first"] = k0 > 1
        boots = [score]
        if want_summary and "K" in prof:
            brng = np.random.default_rng(99)
            n = prof["K"].shape[0]
            boots = [grid_coverage(prof["K"], chance, brng.integers(0, n, n), prof["step"], mode) for _ in range(40)]
        aim = aim_error(res)
        summ = None
        if want_summary:
            summ = _summary(res, cfg, st, health, comp, shots_forced)
            summ["oneshot_chance"] = chance
            summ["oneshot_mode"] = mode
            summ["first_stk"] = k0
            summ["oneshot_band"] = f"{k0}-shot: {band_text(prof['bands'])}" if k0 < 99 else "–"
            summ["oneshot_avg"] = one_shot_averages(res, cfg, health, {part: prof} if k0 == 1 else None)
            parts["batches"] = batches
        return (score, float(np.std(boots)), -float(np.mean(aim)), summ,
                prof.get("K") if want_summary else None, parts)
    scores, ks = score_runs(res, health, metric)
    summ = None
    if want_summary:
        summ = _summary(res, cfg, st, health, comp, shots_forced)
    per_run = np.asarray(scores, dtype=np.float64) if want_summary else None
    if want_summary:
        parts["batches"] = batches
    return (float(np.mean(scores)), float(np.std(scores) / max(np.sqrt(len(scores)), 1)),
            float(np.mean(ks["mag_damage"])), summ, per_run, parts)


def pattern_parts(res):
    return pattern_parts_arr(res.impacts)


def pattern_parts_arr(imp):
    """Split a pattern into the part a player can learn and the part they can't:
    climb  = average distance of each shot's average landing point from the aim
             point (the recoil pattern; evaluate() measures it before recoil control)
    spread = RMS distance of bullets from their shot's average landing point
             (random kick / spread that no one can learn)"""
    ok = np.isfinite(imp).all(axis=-1)
    with np.errstate(all="ignore"), warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)  # a shot no bullet of reaches: nan, skipped below
        m = np.nanmean(np.where(ok[..., None], imp, np.nan), axis=(0, 2))  # (shots, 2)
    climb = float(np.nanmean(np.hypot(m[:, 0], m[:, 1]))) if len(m) else 0.0
    resid = imp - m[None, :, None, :]
    r2 = np.sum(resid ** 2, axis=-1)[ok]
    spread = float(np.sqrt(np.mean(r2))) if r2.size else 0.0
    return {"climb": climb, "spread": spread}


def _eval_task(args):
    weapon, attachments, settings, metric, runs, seed, want_summary = args
    return evaluate(_WORKER_GD, weapon, attachments, settings, metric, runs, seed, want_summary)


class Cancelled(Exception):
    pass


# ----------------------------------------------------------------------------- job
class OptimizeJob:
    kind = "search"

    def __init__(self, gd: GameData, request: dict, pool=None):
        self.id = uuid.uuid4().hex[:12]
        self.gd = gd
        # a named depth ("quick" / "standard" / "thorough") fills in the search sizes
        self.req = {**DEPTHS.get(request.get("depth") or "thorough", {}), **request}
        self.pool = pool
        self.progress = 0.0
        self.stage = "starting"
        self.done = False
        self.error = None
        self.result = None
        self.cancelled = False
        self.started = time.time()
        self.evaluated = 0
        self.step_done = self.step_total = 0
        self._secondary = {}
        self._handling = {}
        self._osavg = {}
        self._osreach = {}
        self._oscov = {}
        self._recfirst = {}
        self._thread = threading.Thread(target=self._run, daemon=True)

    def start(self):
        self._thread.start()
        return self

    def cancel(self):
        self.cancelled = True

    def status(self):
        return {"id": self.id, "progress": round(self.progress, 4), "stage": self.stage,
                "done": self.done, "error": self.error, "result": self.result,
                "evaluated": self.evaluated, "elapsed": round(time.time() - self.started, 1),
                # progress of the current step (its setups, ones already simulated count as done)
                "step_done": self.step_done, "step_total": self.step_total}

    # ------------------------------------------------------------------ helpers
    @property
    def metric(self):
        m = self.req.get("metric", "accuracy")
        return "stk_torso" if m == "oneshot" else m  # older saved settings

    @staticmethod
    def _key(attachments):
        return tuple(sorted((k, v) for k, v in attachments.items() if v))

    @property
    def res(self):
        """Smallest difference that counts: the last digit shown in the results
        (0.0001 studs, 0.01 ms, 0.001 %). Smaller differences are real but far too
        small to matter (e.g. a recovery change that only touches one frame of a
        mag) and are treated as ties, so they can't rank an attachment above none."""
        return RESOLUTION.get(self.metric, 1e-4)

    def _rank_key(self, score, attachments):
        """Primary metric down to the shown resolution; ties go to more damage
        per mag (one-shot range: less recoil, i.e. closer to the aim point),
        then fewer attachments."""
        better_lower = METRICS[self.metric]["better"] == "lower"
        primary = round((score if better_lower else -score) / self.res)
        sec = -self._secondary.get(self._key(attachments), 0.0)
        if self.oneshot:
            # first STK range, then reach / length / average range, then handling and
            # recoil (distance from aim) — recoil first for setups that need several
            # shots, handling first for one-shots
            k = self._key(attachments)
            reach = -round(self._osreach.get(k, 0.0) / self.res)
            cov = -round(self._oscov.get(k, 0.0) / self.res)
            avg = -round(self._osavg.get(k, 0.0) / OSAVG_RES)
            hand = -round(self._handling.get(k, 0.0) / HANDLING_RES)
            rec = round(sec / STUD_RES)
            t1, t2 = (rec, hand) if self._recfirst.get(k) else (hand, rec)
            return (primary, reach, cov, avg, t1, t2, len(k))
        return (primary, sec, len(self._key(attachments)))

    def _tiers_worse(self, c, a):
        """First STK goal, equal range: is setup c worse than a on reach, length and
        average range, then handling and recoil (recoil first when both setups
        need more than one shot)? +1 worse, -1 better, 0 tie."""
        kc, ka = self._key(c), self._key(a)
        for d, res in ((self._osreach, self.res), (self._oscov, self.res)):
            x = d.get(ka, 0.0) - d.get(kc, 0.0)
            if abs(x) >= res:
                return 1 if x > 0 else -1
        o = self._osavg.get(ka, 0.0) - self._osavg.get(kc, 0.0)
        if abs(o) >= OSAVG_RES:
            return 1 if o > 0 else -1
        h = self._handling.get(ka, 0.0) - self._handling.get(kc, 0.0)
        r = self._secondary.get(ka, 0.0) - self._secondary.get(kc, 0.0)
        tiers = [(h, HANDLING_RES), (r, RECOIL_TIE)]
        if self._recfirst.get(ka) and self._recfirst.get(kc):
            tiers.reverse()
        for x, res in tiers:
            if abs(x) >= res:
                return 1 if x > 0 else -1
        return 0

    @property
    def oneshot(self):
        return self.metric in STK_METRICS

    def _better(self, a, b):
        return a < b if METRICS[self.metric]["better"] == "lower" else a > b

    def _batch(self, setups, runs, seed, want_summary=False, progress=None, already=0):
        """Evaluate many setups (in worker processes when available). `already`:
        setups of this step that were simulated before (shown as done)."""
        settings = self.req.get("settings", {})
        args = [(self.req["weapon"], a, settings, self.metric, runs, seed, want_summary) for a in setups]
        self.step_total, self.step_done = len(args) + already, already
        out = [None] * len(args)
        p0, p1 = progress or (self.progress, self.progress)
        if self.pool is not None and len(args) > 1:
            futs = [self.pool.submit(_eval_task, a) for a in args]
            for i, f in enumerate(futs):
                while True:
                    if self.cancelled:
                        for g in futs:
                            g.cancel()
                        raise Cancelled()
                    try:
                        out[i] = f.result(timeout=0.25)
                        break
                    except TimeoutError:
                        continue
                    except Exception as e:  # concurrent.futures.TimeoutError on <3.11
                        if type(e).__name__ == "TimeoutError":
                            continue
                        raise
                self.evaluated += 1
                self.step_done += 1
                self.progress = p0 + (p1 - p0) * (i + 1) / len(args)
        else:
            for i, a in enumerate(args):
                if self.cancelled:
                    raise Cancelled()
                out[i] = evaluate(self.gd, *a)
                self.evaluated += 1
                self.step_done += 1
                self.progress = p0 + (p1 - p0) * (i + 1) / len(args)
        for a, r in zip(setups, out):
            self._secondary[self._key(a)] = r[2]
            self._handling[self._key(a)] = r[5].get("handling", 0.0)
            self._osavg[self._key(a)] = r[5].get("oneshot_avg", 0.0)
            self._osreach[self._key(a)] = r[5].get("os_reach", 0.0)
            self._oscov[self._key(a)] = r[5].get("os_cov", 0.0)
            self._recfirst[self._key(a)] = bool(r[5].get("recoil_first", False))
        return out

    def _run(self):
        try:
            self._optimize()
            self.stage = "Done"
        except Cancelled:
            self.stage = "Cancelled"
            self.error = "cancelled"
        except Exception as e:  # surfaced to the UI
            if self.cancelled:  # workers were stopped under us: that's the cancel
                self.stage = "Cancelled"
                self.error = "cancelled"
                return
            import traceback
            traceback.print_exc()
            self.error = f"{type(e).__name__}: {e}"
        finally:
            self.done = True
            self.progress = 1.0

    # ------------------------------------------------------------------ search
    def _optimize(self):
        weapon = self.req["weapon"]
        locked = {k: v for k, v in (self.req.get("locked") or {}).items() if k in SLOTS}
        seed = int(self.req.get("seed", 12345))
        runs_search = int(self.req.get("runs_search", RUNS_SEARCH))
        runs_final = int(self.req.get("runs_final", RUNS_FINAL))
        top_n = int(self.req.get("top_n", TOP_N))  # 0 or less = list every distinct setup found
        base_lock = {s: a for s, a in locked.items() if a}
        free_slots = [s for s in SLOTS if s not in locked]
        # which rankings to build (an export that only wants "best overall" skips the rest)
        crits = [c for c in ("combined", "climb", "spread") if c in (self.req.get("lists") or ("combined", "climb", "spread"))]
        crits = crits or ["combined"]

        # 1) group attachments with identical shooting stats
        self.stage = "Finding attachments that change the shooting"
        groups = slot_groups_for(self.gd, weapon, base_lock, free_slots, self.req.get("exclude"))
        for s in SLOTS:
            if s in locked:
                groups[s] = [{"rep": locked[s] or None, "members": [locked[s] or None], "no_effect": False}]
        self.progress = 0.04

        def atts_of(choice):
            a = dict(base_lock)
            for s, g in zip(SLOTS, choice):
                if g["rep"]:
                    a[s] = g["rep"]
                elif s in a and s not in locked:
                    a.pop(s)
            return a

        cache = {}
        parts_of = {}

        def run_batch(setups, p):
            todo, seen = [], set()
            for a in setups:
                k = self._key(a)
                if k not in cache and k not in seen:
                    seen.add(k)
                    todo.append(a)
            if todo:
                n_distinct = len({self._key(a) for a in setups})
                for a, r in zip(todo, self._batch(todo, runs_search, seed + 1, progress=p, already=n_distinct - len(todo))):
                    cache[self._key(a)] = r[0]
                    parts_of[self._key(a)] = r[5]
            return [cache[self._key(a)] for a in setups]

        def combined_key(a):
            return self._rank_key(cache[self._key(a)], a)

        def crit_key(crit):
            def f(a):
                k = self._key(a)
                return (round(parts_of[k][crit] / STUD_RES),) + self._rank_key(cache[k], a)
            return f

        n_starts = int(self.req.get("refine_starts", REFINE_STARTS))

        def best_starts(scored):
            starts = []
            for _sc, a in scored:
                if a not in starts:
                    starts.append(a)
                if len(starts) >= n_starts:
                    break
            return starts

        # per-slot singles (for the "every attachment" table)
        singles = []
        for s in free_slots:
            for g in groups[s]:
                a = dict(base_lock)
                if g["rep"]:
                    a[s] = g["rep"]
                singles.append((s, g, a))
        n_combos = 1
        for s in SLOTS:
            n_combos *= len(groups[s])
        exhaustive = n_combos <= int(self.req.get("exhaustive_max", EXHAUSTIVE_MAX))

        self.stage = "Testing each attachment on its own"
        run_batch([a for _s, _g, a in singles], (0.04, 0.12))
        slot_rankings = {}
        for s in free_slots:
            rows = [(cache[self._key(a)], g, a) for ss, g, a in singles if ss == s]
            none_score = next((sc for sc, g, _a in rows if g["rep"] is None), None)
            sign = 1 if METRICS[self.metric]["better"] == "lower" else -1
            # sort by the difference to the empty slot as shown (snapped), so an
            # effect too small to display can never rank above "none"
            rows.sort(key=lambda r: ((sign * snap(r[0] - none_score, self.res)) if none_score is not None else sign * r[0],)
                      + self._rank_key(r[0], r[2])[1:])

            none_parts = next((parts_of[self._key(a)] for _sc, g, a in rows if g["rep"] is None), None)
            slot_rankings[s] = [{"attachment": g["rep"], "same": [m for m in g["members"] if m != g["rep"]],
                                 "score": sc, "delta": snap(sc - none_score, self.res) if none_score is not None else None,
                                 "climb_delta": snap(parts_of[self._key(a)]["climb"] - none_parts["climb"], STUD_RES) if none_parts else None,
                                 "spread_delta": snap(parts_of[self._key(a)]["spread"] - none_parts["spread"], STUD_RES) if none_parts else None}
                                for sc, g, a in rows]

        if exhaustive:
            # 2) every distinct combination
            self.stage = f"Testing all {n_combos:,} distinct combinations"
            combos = [atts_of(c) for c in itertools.product(*[groups[s] for s in SLOTS])]
            scores = run_batch(combos, (0.12, 0.8))
            scored = sorted(zip(scores, combos), key=lambda r: self._rank_key(r[0], r[1]))
        else:
            # 3a) combinations of the best options per slot, once per ranking:
            # the slots' best options for the goal are often not the ones with
            # the least spread or climb, so each list gets its own pool
            keep = int(self.req.get("keep_per_slot", KEEP_PER_SLOT))
            budget = int(self.req.get("max_combos", EXHAUSTIVE_MAX))

            def pool_for(order_key, budget):
                finalists = {}
                for s in SLOTS:
                    if s in locked:
                        finalists[s] = groups[s]
                        continue
                    ordered = sorted(slot_rankings[s], key=order_key) if order_key else slot_rankings[s]
                    ranked = [next(g for g in groups[s] if g["rep"] == e["attachment"]) for e in ordered]
                    lst = ranked[:keep]
                    empty = next((g for g in groups[s] if g["rep"] is None), None)
                    if empty is not None and empty not in lst:
                        lst.append(empty)
                    finalists[s] = lst
                while True:
                    total = 1
                    for s in SLOTS:
                        total *= len(finalists[s])
                    if total <= budget:
                        break
                    s = max(finalists, key=lambda k: len(finalists[k]))
                    lst = finalists[s]
                    if len(lst) <= 2:
                        break
                    drop = next(i for i in range(len(lst) - 1, -1, -1) if lst[i]["rep"] is not None)
                    lst.pop(drop)
                return [atts_of(c) for c in itertools.product(*[finalists[s] for s in SLOTS])]

            side = [c for c in ("climb", "spread") if c in crits]
            pools = [("combined", None)] if "combined" in crits else []
            pools += [(c, (lambda c: lambda e: e[f"{c}_delta"] if e[f"{c}_delta"] is not None else 0.0)(c)) for c in side]
            span = 0.43 / max(len(pools), 1)
            scored = []
            for pi, (crit, okey) in enumerate(pools):
                # the spread / climb pools get half the budget: their lists also
                # draw on everything already simulated and get their own refinement
                combos = pool_for(okey, budget if crit == "combined" else max(1, budget // 2))
                self.stage = f"Testing {len(combos):,} combinations of the strongest options" + (f" ({crit})" if crit != "combined" else "")
                scores = run_batch(combos, (0.12 + span * pi, 0.12 + span * (pi + 1)))
                if crit == "combined":
                    scored = sorted(zip(scores, combos), key=lambda r: self._rank_key(r[0], r[1]))

            # 3b) local search over every option, from the best few setups of each list
            if "combined" in crits:
                self.stage = "Refining: swapping one slot at a time"
                self._refine(best_starts(scored), combined_key, run_batch, groups, free_slots, (0.55, 0.62))
            for i, crit in enumerate(side):
                self.stage = f"Refining the lowest-{crit} setups"
                keyf = crit_key(crit)
                starts = []
                for a in sorted((dict(k) for k in cache), key=keyf):
                    if a not in starts:
                        starts.append(a)
                    if len(starts) >= n_starts:
                        break
                self._refine(starts, keyf, run_batch, groups, free_slots, (0.62 + 0.05 * i, 0.67 + 0.05 * i))

            # 3c) every one-slot swap around each list's leading setups, so a setup
            # that's one attachment away from a listed one can't be missed
            # (e.g. a muzzle that's poor on its own but great with one grip)
            n_exp = int(self.req.get("expand_top", EXPAND_TOP))
            if n_exp > 0:
                want = max(n_exp, min(top_n if top_n > 0 else n_exp, 3 * n_exp))

                def distinct_top(keyf):
                    out = []
                    for a in sorted((dict(k) for k in cache), key=keyf):
                        items = set(a.items())
                        if any(set(b.items()) <= items for b in out):
                            continue  # same setup plus passengers
                        out.append(a)
                        if len(out) >= want:
                            break
                    return out

                for i, crit in enumerate(crits):
                    keyf = combined_key if crit == "combined" else crit_key(crit)
                    self.stage = "Checking every swap around the best setups" + (f" ({crit})" if crit != "combined" else "")
                    p0 = 0.72 + 0.1 * i / len(crits)
                    for _round in range(3):
                        tops = distinct_top(keyf)
                        cands = []
                        for a in tops:
                            for sl in free_slots:
                                for g in groups[sl]:
                                    c = dict(a)
                                    if g["rep"]:
                                        c[sl] = g["rep"]
                                    else:
                                        c.pop(sl, None)
                                    cands.append(c)
                        run_batch(cands, (p0, p0 + 0.1 / len(crits)))
                        if [self._key(a) for a in distinct_top(keyf)] == [self._key(a) for a in tops]:
                            break

        # 4) three rankings (combined score, climb, spread), each re-run with many
        # more mag dumps; keep each list diverse
        self.stage = "Final ranking with more mag dumps"
        everything = [dict(k) for k in cache]
        if top_n <= 0:
            top_n = len(everything)
        sign = 1 if METRICS[self.metric]["better"] == "lower" else -1

        def raw(a, crit):  # lower is better
            k = self._key(a)
            return sign * cache[k] if crit == "combined" else parts_of[k][crit]

        def strip(a, crit):
            """Drop passenger attachments: any attachment whose removal doesn't make
            the setup worse by at least the shown resolution (e.g. a tracker or a
            laser that only nudges roll by a hair) is taken off, so a listed
            setup never carries an attachment that does nothing."""
            res = self.res if crit == "combined" else STUD_RES

            def worse(c, a):  # is c (one attachment fewer) meaningfully worse than a?
                d = raw(c, crit) - raw(a, crit)
                if d >= res:
                    return True
                if crit == "combined" and self.oneshot and d > -res:
                    # same one-shot range: an attachment earns its slot by better
                    # handling, or (same handling) by noticeably less recoil
                    return self._tiers_worse(c, a) > 0
                return False

            changed = True
            while changed:
                changed = False
                for s in free_slots:
                    if s not in a:
                        continue
                    c = dict(a)
                    c.pop(s)
                    run_batch([c], (self.progress, self.progress))
                    if not worse(c, a):
                        a, changed = c, True
                        break
            return a

        picks = {}
        for crit in crits:
            self.stage = "Removing attachments that do nothing"
            keyf = combined_key if crit == "combined" else crit_key(crit)
            stripped = []
            for a in sorted(everything, key=keyf):
                b = strip(a, crit)
                if b not in stripped:
                    stripped.append(b)
                if len(stripped) >= top_n * 2:
                    break
            plen = 6 if (crit == "combined" and self.oneshot) else 1
            picks[crit] = self._diverse_top(sorted(stripped, key=keyf), keyf, top_n, plen)
        self.stage = "Final ranking with more mag dumps"
        union = []
        for lst in picks.values():
            for a in lst:
                if a not in union:
                    union.append(a)
        setups = union + [dict(base_lock)]
        finals_raw = self._batch(setups, runs_final, seed + 2, want_summary=True, progress=(0.82, 1.0))
        base_raw = finals_raw.pop()
        group_of = {s: {g["rep"]: g for g in groups[s]} for s in SLOTS}
        info = {}
        for a, (score, err, md, summ, per_run, parts) in zip(union, finals_raw):
            self._secondary[self._key(a)] = md
            info[self._key(a)] = {
                "slots": {s: a.get(s) for s in SLOTS},
                "score": score,
                "score_err": err,
                "handling": parts.get("handling", 0.0),
                "climb": parts["climb"],
                "spread": parts["spread"],
                "attachments": a,
                "alternatives": {s: [m for m in (group_of[s].get(a.get(s)) or {"members": []})["members"]
                                     if m and m != a.get(s)][:12] for s in SLOTS},
                "summary": summ,
                "_runs": per_run,
                "_batches": parts["batches"],
            }

        def res_of(crit):
            return self.res if crit == "combined" else STUD_RES

        def value(r, crit):
            return r["score"] if crit == "combined" else r[crit]

        def paired(r, k, crit):
            """Difference r - k and its noise, measured on the same mag dumps (so far
            less noisy than either value on its own)."""
            if crit == "combined" and self.oneshot:
                # range = a quantile of per-run kill distances: bootstrap the paired difference
                # coverage on the 1-stud grid, bootstrapped over the same mag dumps
                if r["_runs"] is None or k["_runs"] is None or r["_runs"].shape[0] != k["_runs"].shape[0]:
                    return r["score"] - k["score"], 0.0  # several-shot kills: no randomness
                chance = (r["summary"] or {}).get("oneshot_chance", ONESHOT_CHANCE)
                brng = np.random.default_rng(7)
                n = r["_runs"].shape[0]
                ds = []
                for _ in range(60):
                    ix = brng.integers(0, n, n)
                    mode = (r["summary"] or {}).get("oneshot_mode", "coverage")
                    ds.append(grid_coverage(r["_runs"], chance, ix, mode=mode) - grid_coverage(k["_runs"], chance, ix, mode=mode))
                return r["score"] - k["score"], float(np.std(ds))
            if crit == "combined":
                d = r["_runs"] - k["_runs"]
                return float(d.mean()), float(d.std() / max(np.sqrt(len(d)), 1))
            j = 0 if crit == "climb" else 1
            d = r["_batches"][:, j] - k["_batches"][:, j]
            return value(r, crit) - value(k, crit), float(d.std() / max(np.sqrt(len(d)), 1))

        def better(x, y, crit):
            return self._better(x, y) if crit == "combined" else x < y

        lists = {}
        for crit in crits:
            rows = [info[self._key(a)] for a in picks[crit]]
            if crit == "combined":
                rows.sort(key=lambda r: self._rank_key(r["score"], r["attachments"]))
            else:
                rows.sort(key=lambda r: (round(r[crit] / STUD_RES), self._rank_key(r["score"], r["attachments"])))

            def redundant(r):
                items = set(r["attachments"].items())
                for k in rows:
                    if set(k["attachments"].items()) < items:
                        diff, se = paired(r, k, crit)
                        if better(value(r, crit), value(k, crit), crit) and abs(diff) > 2 * se and abs(diff) >= res_of(crit):
                            continue
                        if crit == "combined" and self.oneshot and abs(diff) < res_of(crit) and \
                                self._tiers_worse(k["attachments"], r["attachments"]) > 0:
                            continue  # same one-shot range, better handling or less recoil
                        return True
                return False
            rows = [r for r in rows if not redundant(r)]
            out = []
            for r in rows:
                diff, se = paired(r, rows[0], crit)
                e = {k: v for k, v in r.items() if not k.startswith("_")}
                e["vs_best"] = diff
                e["vs_best_err"] = se
                e["vs_best_real"] = r is rows[0] or (abs(diff) > 2 * se and abs(diff) >= res_of(crit))
                out.append(e)
            lists[crit] = out

        no_effect = {s: sum(len([m for m in g["members"] if m]) for g in groups[s] if g.get("no_effect")) for s in free_slots}
        self.result = {
            "metric": self.metric,
            "metric_label": METRICS[self.metric]["label"],
            "better": METRICS[self.metric]["better"],
            "baseline": {"score": base_raw[0], "score_err": base_raw[1], "attachments": base_lock,
                         "climb": base_raw[5]["climb"], "spread": base_raw[5]["spread"],
                         "summary": base_raw[3]},
            "results": lists.get("combined") or lists[crits[0]],
            "lists": lists,
            "slot_rankings": slot_rankings,
            "searched": {"unique_options": {s: len(groups[s]) for s in SLOTS},
                         "combinations": n_combos, "exhaustive": exhaustive,
                         "simulated": len(cache) + len(setups), "no_effect": no_effect,
                         "runs_search": runs_search, "runs_final": runs_final},
        }

    # ------------------------------------------------------------------ helpers for the search
    def _refine(self, starts, keyf, run_batch, groups, free_slots, prog):
        """Swap one slot at a time for every option while it improves keyf."""
        for si, start in enumerate(starts):
            cur = dict(start)
            run_batch([cur], (prog[0], prog[0]))
            for _pass in range(5):
                improved = False
                for s in free_slots:
                    cands = []
                    for g in groups[s]:
                        c = dict(cur)
                        if g["rep"]:
                            c[s] = g["rep"]
                        else:
                            c.pop(s, None)
                        cands.append(c)
                    p = prog[0] + (prog[1] - prog[0]) * (si + (_pass + 0.5) / 5) / max(len(starts), 1)
                    run_batch(cands, (p, p))
                    for c in cands:
                        if keyf(c) < keyf(cur):
                            cur, improved = c, True
                if not improved:
                    break

    def _diverse_top(self, ordered, keyf, n, plen=1):
        """Best n, skipping setups that only add attachments to a listed one
        without ranking better (plen: how many leading key parts count, 2 lets
        recoil break one-shot range ties); padded so the list never gets too short."""
        top = []
        for a in ordered:
            items = set(a.items())
            if any(set(k.items()) < items and keyf(k)[:plen] <= keyf(a)[:plen] for k in top):
                continue
            top = [k for k in top if not (items < set(k.items()) and keyf(k)[:plen] >= keyf(a)[:plen])]
            top.append(a)
            if len(top) >= n:
                break
        for a in ordered:
            if len(top) >= min(n, 6):
                break
            if a not in top:
                top.append(a)
        return top


# ----------------------------------------------------------------------------- manager
class JobManager:
    def __init__(self, data_path=None):
        self.jobs = {}
        self.data_path = str(data_path) if data_path else None
        self._pool = None
        self._lock = threading.Lock()

    def pool(self):
        with self._lock:
            if self._pool is None:
                workers = max(1, (os.cpu_count() or 2) - 1)
                try:
                    self._pool = ProcessPoolExecutor(max_workers=workers, initializer=_init_worker,
                                                     initargs=(self.data_path,))
                except Exception:
                    self._pool = None
            return self._pool

    def reset_pool(self):
        """Stop all worker processes right away (cancel, data reload, quit).
        A fresh pool is started by the next search."""
        with self._lock:
            pool, self._pool = self._pool, None
        if pool is None:
            return
        procs = list(getattr(pool, "_processes", {}).values())
        try:
            pool.shutdown(wait=False, cancel_futures=True)
        except Exception:
            pass
        for pr in procs:  # don't let half-finished simulations keep the CPU busy
            try:
                pr.terminate()
            except Exception:
                pass

    def start(self, gd, request):
        """Start a best-setup search (replaces any running search)."""
        return self.launch(OptimizeJob(gd, request), "search")

    def launch(self, job, kind):
        """Run a job on the shared worker pool. Only one job per kind runs at a
        time (a new search replaces the old one); a search and an every-gun
        export can run side by side."""
        running = [j for j in self.jobs.values() if not j.done and getattr(j, "kind", None) == kind]
        for j in running:
            j.cancel()
        if running and not self._others_running(running):
            self.reset_pool()
        job.kind = kind
        job.pool = self.pool()
        self.jobs[job.id] = job.start()
        if len(self.jobs) > 20:
            for jid in [j for j, v in self.jobs.items() if v.done][:-10]:
                self.jobs.pop(jid, None)
        return job

    def _others_running(self, exclude):
        return any(not j.done and j not in exclude for j in self.jobs.values())

    def cancel(self, jid=None):
        hit = [j for k, j in self.jobs.items() if (jid is None or k == jid) and not j.done]
        for j in hit:
            j.cancel()
        # stop the worker processes right away, unless another job still needs them
        if hit and not self._others_running(hit):
            self.reset_pool()

    def get(self, jid):
        return self.jobs.get(jid)
