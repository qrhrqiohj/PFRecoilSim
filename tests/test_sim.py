"""Checks the simulator against reference results produced by the game's own code.

Run from the project folder:   python -m unittest discover tests
"""
import copy
import json
import math
import sys
import unittest
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from recoilsim.analysis import kill_stats, mean_path  # noqa: E402
from recoilsim.gamedata import GameData  # noqa: E402
from recoilsim.export import BatchJob, gun_stats_sheet, pick_firemode, to_csv, to_xlsx  # noqa: E402
from recoilsim.optimizer import DEPTHS, OptimizeJob, default_excludes_for  # noqa: E402
from recoilsim.simulate import SimSettings, classify_hits, interpolate_damage, plan_shots, simulate  # noqa: E402

FIX = Path(__file__).resolve().parent / "fixtures"
GD = GameData()


def _strip_delay(o):
    if isinstance(o, dict):
        if "delay" in o and all(isinstance(k, int) or k == "delay" for k in o):
            return [_strip_delay(o[i]) for i in sorted(k for k in o if isinstance(k, int))]
        return {k: _strip_delay(v) for k, v in o.items()}
    if isinstance(o, list):
        return [_strip_delay(v) for v in o]
    return o


def _diff(a, b, path=""):
    if isinstance(a, bool) or isinstance(b, bool):
        return [] if a == b else [(path, a, b)]
    if isinstance(a, (int, float)) and isinstance(b, (int, float)):
        return [] if math.isclose(a, b, rel_tol=1e-9, abs_tol=1e-9) else [(path, a, b)]
    if isinstance(a, dict) and isinstance(b, dict):
        out = []
        for k in set(a) | set(b):
            if k not in a or k not in b:
                out.append((f"{path}/{k}", a.get(k, "MISSING"), b.get(k, "MISSING")))
            else:
                out += _diff(a[k], b[k], f"{path}/{k}")
        return out
    if isinstance(a, list) and isinstance(b, list):
        if len(a) != len(b):
            return [(path, "len", len(a), len(b))]
        out = []
        for i, (x, y) in enumerate(zip(a, b)):
            out += _diff(x, y, f"{path}[{i}]")
        return out
    return [] if a == b else [(path, a, b)]


class MatchesGame(unittest.TestCase):
    def test_attachment_compile_matches_game(self):
        fx = json.loads((FIX / "studio_compile_cases.json").read_text())
        for (weapon, atts), game in zip(fx["cases"], fx["results"]):
            cfg = GD.compile(weapon, atts)
            mine = {"recoil": _strip_delay(cfg.recoil), "damageGraph": cfg.stats.get("damageGraph")}
            for k in game:
                if k not in mine:
                    mine[k] = cfg.stats.get(k)
            diffs = _diff(game, {k: mine[k] for k in game})
            self.assertEqual(diffs, [], f"{weapon} {atts}")

    def test_recoil_path_matches_game_springs(self):
        rows = np.array(json.loads((FIX / "studio_ak47_recoil_path.json").read_text())["rows"])
        cfg = copy.deepcopy(GD.compile("AK47", {}))
        for grp in cfg.recoil.values():
            for rows_ in grp.values():
                if isinstance(rows_, list):
                    for r in rows_:
                        if len(r) >= 4:
                            r[3] = 0.0
        for g in ("aimTranslation", "hipTranslation"):
            for rows_ in cfg.recoil[g].values():
                for r in rows_:
                    r[2] = 0.0
        D = 1000.0
        res = simulate(cfg, SimSettings(distance=D, runs=1, seed=1, gravity=False))
        mine = res.impacts[0, :, 0, :]
        sx = rows[:, 1] / -rows[:, 3] * D
        sy = rows[:, 2] / -rows[:, 3] * D
        err = np.hypot(mine[:, 0] - sx, mine[:, 1] - sy).max()
        self.assertLess(err, 1e-3)  # studs at 1000 studs


class Behaviour(unittest.TestCase):
    def test_first_shot_goes_straight(self):
        cfg = GD.compile("AK47", {})
        res = simulate(cfg, SimSettings(distance=50, runs=50, seed=3, gravity=False))
        self.assertTrue(np.allclose(res.impacts[:, 0, 0, :], 0, atol=1e-9))

    def test_fire_timing_is_frame_quantised(self):
        cfg = GD.compile("AK47", {})
        plan = plan_shots(cfg, SimSettings(fps=60))
        self.assertEqual(len(plan.fire_times), 30)
        self.assertAlmostEqual(plan.fire_times[1] - plan.fire_times[0], 0.1, places=6)
        an94 = GD.compile("AN-94", {})
        plan = plan_shots(an94, SimSettings(fps=60))  # hyperburst: first two shots at 1800 rpm
        self.assertAlmostEqual(plan.fire_times[1], 1 / 30, places=6)

    def test_hitbox_precedence(self):
        x = np.array([0.0, 0.0, 0.0, 1.05, 5.0])
        y = np.array([1.6, 1.05, 0.0, 0.0, 0.0])
        parts = classify_hits(x, y, 0.0)
        self.assertEqual(parts.tolist(), [0, 0, 1, 1, -1])  # head wins its 0.1 stud margin, torso beats arm

    def test_damage_graph(self):
        g = [{"distance": 0, "damage": 41}, {"distance": 70, "damage": 41}, {"distance": 140, "damage": 30}]
        self.assertEqual(interpolate_damage(g, 50), 41)
        self.assertAlmostEqual(interpolate_damage(g, 105), 35.5)
        self.assertEqual(interpolate_damage(g, 500), 30)

    def test_compensation_path(self):
        cfg = GD.compile("AK47", {})
        st = SimSettings(distance=50)
        path = mean_path(cfg, st)
        self.assertEqual(path.shape, (30, 2))
        self.assertGreater(path[-1, 1], 3)  # climbs upward

    def test_kill_stats(self):
        cfg = GD.compile("AK47", {})
        res = simulate(cfg, SimSettings(distance=10, runs=20, seed=5, shots=3))
        ks = kill_stats(res, 100)
        self.assertEqual(ks["ttk"].shape, (20,))

    def test_optimizer_quick(self):
        job = OptimizeJob(GD, {"weapon": "M4A1", "metric": "ttk", "runs_search": 30, "runs_final": 60,
                               "exhaustive_max": 40, "keep_per_slot": 2, "max_combos": 40, "top_n": 3,
                               "settings": {"distance": 40}})
        job._run()
        self.assertIsNone(job.error)
        self.assertTrue(job.result["results"])

    def test_trigger_holds_pause_and_resume(self):
        cfg = GD.compile("AK47", {})
        full = simulate(cfg, SimSettings(seed=5, trigger_holds=[[0, None]]))
        paused = simulate(cfg, SimSettings(seed=5, trigger_holds=[[0, 0.5], [1.5, None]]))
        k = sum(1 for t in paused.plan.fire_times if t < 0.5)
        self.assertEqual(k, 5)
        # identical until the pause, then the first shot after it starts from a recovered gun
        self.assertTrue(np.allclose(full.impacts[0, :k], paused.impacts[0, :k]))
        self.assertAlmostEqual(paused.plan.fire_times[k], 1.5, places=6)
        self.assertLess(abs(paused.impacts[0, k, 0, 1]), abs(full.impacts[0, k, 0, 1]))
        self.assertEqual(len(paused.plan.fire_times), 30)

    def test_tap_fire_and_long_sessions(self):
        import time
        cfg = GD.compile("DBV12", {})  # semi-auto shotgun
        # one shot per press; a press while the gun is still cycling is ignored
        res = simulate(cfg, SimSettings(seed=1, trigger_holds=[[0, 0.05], [0.1, 0.15], [0.5, 0.52], [1.0, None]]))
        self.assertEqual([round(t, 3) for t in res.plan.fire_times], [0.0, 0.5, 1.0])
        # taps spread over ten minutes stay fast when only the recent track is recorded
        holds = [[i * 20.0, i * 20.0 + 0.05] for i in range(30)]
        t0 = time.time()
        res = simulate(cfg, SimSettings(seed=1, trigger_holds=holds, record_track=True,
                                        track_start=holds[-1][0] - 0.5, track_end=holds[-1][1] + 6))
        self.assertLess(time.time() - t0, 1.0)
        self.assertEqual(len(res.plan.fire_times), 10)

    def test_autoburst_resets_each_pull(self):
        cfg = GD.compile("AN-94", {})
        p = simulate(cfg, SimSettings(seed=1, trigger_holds=[[0, 0.35], [1, 1.35]])).plan
        gaps = [round(b - a, 3) for a, b in zip(p.fire_times, p.fire_times[1:])]
        self.assertAlmostEqual(gaps[0], 1 / 30, places=2)   # 1800 rpm pair...
        self.assertAlmostEqual(gaps[1], 0.1, places=2)      # ...then 600 rpm
        i = p.fire_times.index(1.0)
        self.assertAlmostEqual(p.fire_times[i + 1] - p.fire_times[i], 1 / 30, places=2)

    def test_trigger_release_rules(self):
        # release cancels the rest of a burst unless the gun has burstlock
        tap = [[0, 0.02]]
        self.assertEqual(len(simulate(GD.compile("AKU12", {}), SimSettings(seed=1, firemode_index=1, trigger_holds=tap)).plan.fire_times), 1)
        locked = GD.compile("AKU12", {"Ammo": "AKU 9mm Conversion"})  # burstlock
        self.assertEqual(len(simulate(locked, SimSettings(seed=1, firemode_label="BURST 3", trigger_holds=tap)).plan.fire_times), 3)
        # an auto-burst gun waits 60/firecap after a release before the next pull
        p = simulate(GD.compile("AN-94", {}), SimSettings(seed=1, trigger_holds=[[0, 0.35], [0.4, 0.75]])).plan
        self.assertAlmostEqual([t for t in p.fire_times if t > 0.36][0], 0.55, places=2)
        # semi: spam clicking never beats the fire rate
        taps = [[i * 0.05, i * 0.05 + 0.02] for i in range(20)]
        p = simulate(GD.compile("AK47", {}), SimSettings(seed=1, firemode_label="SEMI", trigger_holds=taps)).plan
        gaps = [b - a for a, b in zip(p.fire_times, p.fire_times[1:])]
        self.assertGreaterEqual(min(gaps), 0.1 - 1e-9)

    def test_bullet_drop_never_counts_as_recoil(self):
        from recoilsim.optimizer import evaluate
        s = {"distance": 300, "aiming": True}
        hp = {"Ammo": "Hollow Point"}  # slower bullets, same recoil
        base = evaluate(GD, "AK47", {}, s, "accuracy", 200, 5)
        slow = evaluate(GD, "AK47", hp, s, "accuracy", 200, 5)
        self.assertAlmostEqual(slow[0], base[0])
        # ...but travel time still counts for time to kill
        near = {"distance": 60, "aiming": True, "compensation": 100}
        self.assertNotAlmostEqual(evaluate(GD, "AK47", hp, near, "ttk", 200, 5)[0],
                                  evaluate(GD, "AK47", {}, near, "ttk", 200, 5)[0], places=4)

    def test_burstcam_guns_plan_quickly(self):
        # burstcam guns (M16A4, M4, K2, K1A, K7, C8A3, burst trigger groups) used
        # to step through a million idle frames while the trigger was held
        import time
        for name in ("M16A4", "M4", "K2", "K1A", "K7", "C8A2"):
            cfg = GD.compile(name, {})
            fms = cfg.stats.get("firemodes") or [True]
            for fi in range(len(fms)):
                t0 = time.time()
                p = simulate(cfg, SimSettings(seed=1, firemode_index=fi, trigger_holds=[[0, 0.5], [1, None]])).plan
                self.assertLess(time.time() - t0, 0.2, f"{name} mode {fi}")
                self.assertGreater(len(p.fire_times), 0)

    def test_no_passenger_attachments_in_results(self):
        # a listed setup never carries an attachment that changes nothing
        job = OptimizeJob(GD, {"weapon": "M16A3", "metric": "accuracy", "runs_search": 40, "runs_final": 80,
                               "top_n": 6, "settings": {"distance": 50, "compensation": 100},
                               "locked": {"Optics": "", "Barrel": "", "Ammo": ""}})
        job._run()
        self.assertIsNone(job.error)
        for lst in job.result["lists"].values():
            for r in lst:
                self.assertNotIn(r["attachments"].get("Other"), ("Ballistics Tracker", "Green Laser", "Tri Laser",
                                                                 "Yellow Laser", "Canted Acog Scope"))

    def test_same_frame_multi_shot_guns(self):
        # 999 000 rpm double / quad shots leave together, like in game
        for name, n in (("M3822", 2), ("SAWED OFF", 2), ("STEVENS DB", 2), ("ROPOD SHOTTY", 2), ("M7644", 4)):
            cfg = GD.compile(name, {})
            for kw in ({}, {"trigger_holds": [[0, 0.05]]}):
                fm = (cfg.stats.get("firemodes") or [True]).index(n) if n in (cfg.stats.get("firemodes") or []) else 0
                p = simulate(cfg, SimSettings(seed=1, firemode_index=fm, **kw)).plan
                self.assertEqual(p.fire_times[:n], [0.0] * n, f"{name} {kw}")
        res = simulate(GD.compile("M3822", {}), SimSettings(seed=1, runs=200))
        mean = np.nanmean(res.impacts[:, :2, 0, 1], axis=0)
        self.assertLess(abs(mean[0] - mean[1]), 0.3)  # neither bullet climbs above the other

    def test_rank_key_separates_scores(self):
        job = OptimizeJob(GD, {"weapon": "AK47", "metric": "accuracy"})
        self.assertLess(job._rank_key(1.80, {}), job._rank_key(2.20, {}))
        job2 = OptimizeJob(GD, {"weapon": "AK47", "metric": "damage"})
        self.assertLess(job2._rank_key(900.0, {}), job2._rank_key(800.0, {}))



class Export(unittest.TestCase):
    """Spreadsheet export: tables, file formats and the every-gun jobs."""

    def test_gun_stats_sheet(self):
        sh = gun_stats_sheet(GD, None, (0, 100), 100)
        self.assertEqual(len(sh["rows"]), len(GD.weapon_names()))
        self.assertTrue(all(len(r) == len(sh["columns"]) for r in sh["rows"]))
        names = [c["name"] for c in sh["columns"]]
        self.assertIn("STK torso @ 100", names)
        only = gun_stats_sheet(GD, ["SHOTGUN"], (50,), 100, ["basics"])
        self.assertTrue(only["rows"] and all(r[0] == "Shotgun" for r in only["rows"]))
        self.assertEqual(len(only["columns"]), 7)  # class, unlock rank, gun + 4 basics
        # game menu order within the class: unlock rank, test / admin guns last
        self.assertEqual([r[2] for r in only["rows"]], [w["displayname"] for w in GD.catalog()["SHOTGUN"]])
        normal = [w["rank"] for w in GD.catalog()["SHOTGUN"] if not w["test"] and w["rank"] is not None]
        self.assertEqual(normal, sorted(normal))

    def test_file_formats(self):
        import io
        import zipfile
        sheet = {"name": "T/1", "columns": [{"name": "Gun", "type": "text"}, {"name": "Hit", "type": "pct", "d": 1},
                                            {"name": "X", "type": "num", "d": 3}],
                 "rows": [["A,B", 0.5, 1.23456], ["C", None, float("nan")]]}
        csv_text = to_csv(sheet).decode("utf-8-sig")
        self.assertIn('"A,B",50.0%,1.235', csv_text)
        z = zipfile.ZipFile(io.BytesIO(to_xlsx([sheet, dict(sheet, name="T/1")])))
        self.assertIn("xl/worksheets/sheet2.xml", z.namelist())
        wb = z.read("xl/workbook.xml").decode()
        self.assertIn('name="T-1"', wb)
        self.assertIn('name="T-1 (2)"', wb)  # sheet names are made valid and unique

    def test_pick_firemode(self):
        self.assertEqual(pick_firemode(["SEMI", "AUTO"], "auto"), "AUTO")
        self.assertEqual(pick_firemode(["SEMI", "AUTO"], "default"), "SEMI")
        self.assertEqual(pick_firemode(["AUTO"], "burst"), "AUTO")
        self.assertEqual(pick_firemode(["AUTO", "BURST 3"], "burst"), "BURST 3")

    def test_batch_jobs(self):
        guns = GD.weapon_names()[:2]
        best = BatchJob(GD, {"kind": "best", "weapons": guns, "depth": "quick", "per_gun": 2, "lists": ["spread"],
                             "settings": {"distance": 50, "compensation": 100}, "runs_search": 20, "runs_final": 40,
                             "exhaustive_max": 40, "max_combos": 40})
        best._run()
        self.assertIsNone(best.error)
        self.assertEqual(len(best.rows), 4)
        self.assertTrue(all(len(r) == len(best.columns) for r in best.rows))
        stats = BatchJob(GD, {"kind": "stats", "weapons": guns, "runs": 30, "settings": {"distance": 50}})
        stats._run()
        self.assertIsNone(stats.error)
        self.assertEqual(len(stats.rows), 2)
        self.assertTrue(all(len(r) == len(stats.columns) for r in stats.rows))

    def test_default_exclusions(self):
        ak = default_excludes_for(GD, "AK47")
        self.assertIn("Halbek Device", ak["Barrel"])
        self.assertNotIn("DCL 120", ak.get("Optics", []))  # taken off the default list
        self.assertIn("Chainsaw Grip", ak["Underbarrel"])
        self.assertNotIn("Heavy Buffer", ak.get("Other", []))
        self.assertIn("Heavy Buffer", default_excludes_for(GD, "M231")["Other"])
        self.assertNotIn("Heavy Buffer", default_excludes_for(GD, "COLT SMG 635").get("Other", []))  # M231 only
        self.assertEqual(default_excludes_for(GD, "AK47", []), {})
        self.assertIn("Heavy Buffer", default_excludes_for(GD, "COLT SMG 635", ["Heavy Buffer"])["Other"])

    def test_batch_locks_lists_and_exclusions(self):
        job = BatchJob(GD, {"kind": "best", "weapons": ["AK47"], "depth": "quick", "per_gun": 3, "lists": ["combined"],
                            "locks": {"Ammo": "", "Optics": "No Such Sight"}, "exclude_tokens": ["Compensator"],
                            "settings": {"distance": 50, "compensation": 100}})
        job._run()
        self.assertIsNone(job.error)
        names = [c["name"] for c in job.columns]
        self.assertNotIn("List", names)  # one list: no constant "List" column
        self.assertIn("#", names)        # 3 setups per gun: rank in list is kept
        self.assertTrue(job.rows and all(r[2] == "AK-47" for r in job.rows))
        ammo, barrel = names.index("Ammo"), names.index("Barrel")
        self.assertTrue(all(r[ammo] == "" for r in job.rows))           # locked empty
        self.assertTrue(all(r[barrel] != "Compensator" for r in job.rows))  # excluded

    def test_unlock_requirements(self):
        self.assertEqual(GD.unlock_rank("AK47"), 47)
        self.assertEqual(GD.kill_req("AK47", "Underbarrel", "Tri Laser"), 1070)  # gun-specific override
        self.assertEqual(GD.kill_req("AK47", "Barrel", "Compensator"), 120)      # the attachment's own requirement
        opts = GD.attachment_options("AK47")["Underbarrel"]
        kills = [o["kills"] for o in opts]
        self.assertEqual(kills, sorted(kills))
        g36 = GD.attachment_options("G36")["Optics"]
        self.assertTrue(g36[-1]["test"])                                      # test-only attachments last
        cls = next(l for c, l in GD.catalog().items() if any(w["name"] == "GOLDEN SHORTY" for w in l))
        flags = [w["test"] for w in cls]
        self.assertEqual(flags, sorted(flags))                                # test / admin guns at the bottom

    def test_read_sheet_round_trip(self):
        from recoilsim.export import read_sheet
        sh = gun_stats_sheet(GD, ["SHOTGUN"], (50,), 100, ["basics"])
        for data, name in ((to_xlsx([sh]), "a.xlsx"), (to_csv(sh).encode() if isinstance(to_csv(sh), str) else to_csv(sh), "a.csv")):
            back = read_sheet(data, name)
            self.assertEqual([c["name"] for c in back["columns"]], [c["name"] for c in sh["columns"]])
            self.assertEqual(len(back["rows"]), len(sh["rows"]))
            self.assertEqual(back["rows"][0][2], sh["rows"][0][2])

    def test_test_only_attachments_excluded_on_normal_guns(self):
        ex = default_excludes_for(GD, "M107")
        self.assertIn("M107 Unfolded Bipod", ex.get("Other", []))
        for w in GD.weapon_names():
            if GD.is_test_weapon(w):  # test guns keep their test attachments
                tokens = {n for names in default_excludes_for(GD, w).values() for n in names}
                tests = {o["name"] for opts in GD.attachment_options(w).values() for o in opts if o.get("test")}
                self.assertFalse(tests & tokens)

    def test_same_shot_count_for_every_setup(self):
        from recoilsim.optimizer import evaluate
        # the M107's 5-round magazine has no recoil effect: same score as the stock 10
        a = evaluate(GD, "M107", {}, {"compensation": 100}, "accuracy", 200, 3)
        b = evaluate(GD, "M107", {"Other": "M107 Reduced Magazine"}, {"compensation": 100}, "accuracy", 200, 3)
        self.assertAlmostEqual(a[0], b[0], places=9)
        self.assertAlmostEqual(a[5]["climb"], b[5]["climb"], places=9)

    def test_depth_presets(self):
        job = OptimizeJob(GD, {"weapon": "AK47", "depth": "quick"})
        self.assertEqual(job.req["runs_search"], DEPTHS["quick"]["runs_search"])
        job = OptimizeJob(GD, {"weapon": "AK47", "depth": "quick", "runs_search": 7})
        self.assertEqual(job.req["runs_search"], 7)  # explicit values win


class OneShotAndClimb(unittest.TestCase):
    def test_one_shot_distances_match_direct_simulation(self):
        from recoilsim.analysis import one_shot_distances
        for w in ("KSG 12", "SAWED OFF"):
            cfg = GD.compile(w, {})
            st = SimSettings(distance=50, runs=800, seed=3, gravity=True, keep_rays=True)
            kd = one_shot_distances(simulate(cfg, st), cfg, st, 100)
            for d in (30, 60, 90):
                res = simulate(cfg, SimSettings(distance=d, runs=800, seed=3, gravity=True))
                direct = (res.damage[:, 0, :].sum(axis=1) >= 100).mean()
                self.assertAlmostEqual(direct, (kd >= d).mean(), delta=0.01, msg=f"{w} at {d}")

    def test_climb_is_measured_before_recoil_control(self):
        from recoilsim.optimizer import evaluate
        a = evaluate(GD, "AK47", {}, {"compensation": 0}, "accuracy", 300, 5)[5]
        b = evaluate(GD, "AK47", {}, {"compensation": 100}, "accuracy", 300, 5)[5]
        self.assertAlmostEqual(a["climb"], b["climb"], places=9)
        self.assertAlmostEqual(a["spread"], b["spread"], places=9)
        self.assertGreater(a["climb"], 1.0)

    def test_one_shot_bands_for_rising_and_humped_damage(self):
        from recoilsim.analysis import one_shot_profile
        st = SimSettings(distance=50, runs=300, seed=3, gravity=False, keep_rays=True)
        m107 = GD.compile("M107", {})  # torso one-shots only where damage peaks
        a, b = one_shot_profile(simulate(m107, st), m107, 100)["bands"][0]
        self.assertGreater(a, 50)
        self.assertLess(b, 400)
        kac = GD.compile("KAC SRR", {})  # damage rises with range: one-shots from a distance on
        prof = one_shot_profile(simulate(kac, st), kac, 100)
        self.assertEqual(len(prof["bands"]), 1)
        self.assertGreater(prof["bands"][0][0], 100)
        self.assertIsNone(prof["bands"][0][1])

    def test_first_stk(self):
        from recoilsim.analysis import best_stk, stk_profile
        ak = GD.compile("AK47", {})
        self.assertEqual(best_stk(ak.stats, 100, "torso"), 3)
        self.assertEqual(best_stk(ak.stats, 100, "head"), 2)
        prof = stk_profile(ak, 100, "torso", 3)
        self.assertEqual(prof["bands"][0][0], 0.0)
        self.assertGreater(prof["pointblank"], 50)
        self.assertEqual(best_stk(GD.compile("SAWED OFF", {}).stats, 100, "torso"), 1)
        # pellets: several shots, every pellet scored where it lands
        from recoilsim.optimizer import evaluate
        r = evaluate(GD, "SAWED OFF", {}, {"health": 600, "compensation": 100}, "stk_torso", 200, 1, want_summary=True)
        self.assertTrue(r[3]["oneshot_band"].startswith("2-shot: "))

    def test_stk_recoil_before_handling(self):
        # single bullet, several shots (AK-47 torso): equal ranges are ranked by recoil first
        job = OptimizeJob(GD, {"weapon": "AK47", "metric": "stk_torso", "settings": {"compensation": 100},
                               "depth": "quick", "lists": ["combined"], "top_n": 6})
        job._optimize()
        rows = job.result["lists"]["combined"]
        band = rows[0]["summary"]["oneshot_band"]
        aims = [round(r["summary"]["aim_error"], 4) for r in rows if r["summary"]["oneshot_band"] == band]
        self.assertGreater(len(aims), 2)
        self.assertEqual(aims, sorted(aims))

    def test_fire_point(self):
        # with the gun model, hip-fire bullets leave the barrel (right of and below
        # the crosshair, parallel to the view); aimed ones leave the sight part
        from recoilsim.models import ModelLibrary
        gd = GameData()
        gd.use_models(ModelLibrary())
        for aiming, want in ((False, (0.75, -0.712)), (True, (0.0, 0.0))):
            cfg = gd.compile("AK47", {})
            res = simulate(cfg, SimSettings(distance=50, aiming=aiming, runs=50, seed=1, gravity=False, shots=1))
            first = np.nanmean(res.impacts[:, 0, :, :], axis=(0, 1))
            self.assertAlmostEqual(first[0], want[0], places=2)
            self.assertAlmostEqual(first[1], want[1], places=2)

    def test_custom_tiebreak_keeps_handling_attachments(self):
        # accuracy goal + handling as a tie-breaker: equal-accuracy setups go to the better handling
        job = OptimizeJob(GD, {"weapon": "TYPE 88", "metric": "accuracy", "settings": {"compensation": 100},
                               "depth": "quick", "lists": ["combined"], "top_n": 4, "tiebreak": ["handling", "recoil"]})
        job._optimize()
        rows = job.result["lists"]["combined"]
        best = round(rows[0]["score"], 4)
        hands = [r["handling"] for r in rows if round(r["score"], 4) == best]
        self.assertEqual(hands, sorted(hands, reverse=True))
        self.assertEqual(job.result["tiebreak"], ["handling", "recoil"])

    def test_recoil_edit_roundtrip_and_override(self):
        from recoilsim.recoil_edit import from_lua, to_lua
        gd = GameData()
        base = gd.base_recoil("AK47")
        self.assertEqual(from_lua(to_lua(base)), base)
        st = SimSettings(distance=50, runs=10, seed=3, gravity=False)
        a = simulate(gd.compile("AK47", {"Barrel": "Compensator"}), st).impacts
        gd.set_recoil_overrides({"AK47": base})  # unchanged values: same shots
        b = simulate(gd.compile("AK47", {"Barrel": "Compensator"}), st).impacts
        self.assertTrue(np.allclose(a, b, equal_nan=True))
        edited = copy.deepcopy(base)
        edited["aimCameraBody"]["x"][0][2] *= 2  # stronger climb
        gd.set_recoil_overrides({"AK47": edited})
        c = simulate(gd.compile("AK47", {"Barrel": "Compensator"}), st).impacts
        self.assertGreater(np.nanmean(c[:, -1, 0, 1]), np.nanmean(a[:, -1, 0, 1]) + 0.2)

    def test_recoil_designer_fits_a_path(self):
        from recoilsim.recoil_fit import fit_recoil
        pts = [[0, 0]] + [[0, 0.8 * i] for i in range(1, 12)] + [[0.6 * j, 8.8 + 0.15 * j] for j in range(1, 19)]
        r = fit_recoil(GameData(), {"weapon": "AK47", "aiming": True, "distance": 50, "points": pts, "layers": "auto", "variance": 0.3})
        self.assertLess(r["rms"], 0.5)
        self.assertEqual(len(r["path"]), len(pts))
        # free shots (None) are left to the recoil; a refit with fixed springs only changes the kicks
        part = pts[:12] + [None] * 18
        r2 = fit_recoil(GameData(), {"weapon": "AK47", "aiming": True, "distance": 50, "points": part, "layers": 3, "variance": 0})
        self.assertEqual(len(r2["path"]), 30)
        self.assertLess(r2["rms"], 0.2)
        springs = {ax: [row[:2] + row[4:6] for row in r2["layers"][ax]] for ax in ("x", "y")}
        r3 = fit_recoil(GameData(), {"weapon": "AK47", "aiming": True, "distance": 50, "points": part, "springs": springs, "variance": 0})
        self.assertEqual([row[:2] + row[4:6] for row in r3["layers"]["x"]], springs["x"])
        self.assertLess(r3["rms"], r2["rms"] + 0.05)
        # every designed layer has its own recovery spring (paired by index), so the view snaps back
        rec = r["recoil"]["aimCameraBodyRecovery"]
        self.assertEqual(len(rec["x"]["layers"]), len(r["layers"]["x"]))
        self.assertIsNotNone(r["settle"])
        self.assertLess(r["settle"], 1.5)

    def test_recoil_designer_recreates_a_gun(self):
        """The G11K2's own pattern and per-shot spread, rebuilt from scratch."""
        import numpy as np
        from recoilsim.recoil_fit import fit_recoil, preview_path, split_layers
        gd = GameData()
        for fm in (0, 1):
            base = {"weapon": "G11K2", "aiming": True, "distance": 50, "firemode_index": fm}
            pv = preview_path(gd, {**base, "sigma": True})
            r = fit_recoil(gd, {**base, "points": pv["path"], "spread": pv["sigma"], "layers": "auto"})
            self.assertLess(r["rms"], 0.1)
            self.assertLess(np.abs(np.array(r["sigma"]) - np.array(pv["sigma"])).mean(), 0.02)
        # with the gun's own springs only the kicks are left: an exact match
        sl = split_layers(gd.base_recoil("G11K2"), "aimCameraBody")
        r = fit_recoil(gd, {**base, "points": pv["path"], "springs": {ax: [a[:2] + a[4:6] for a in sl[ax]] for ax in "xy"}})
        self.assertLess(r["rms"], 0.005)
        self.assertAlmostEqual(r["layers"]["x"][0][2], 1.5, places=2)

    def test_controller_halves_camera_recoil(self):
        cfg = GD.compile("AK47", {})
        kb = mean_path(cfg, SimSettings(distance=50, runs=1, gravity=False))
        pad = mean_path(cfg, SimSettings(distance=50, runs=1, gravity=False, controller=True))
        self.assertLess(pad[-1, 1], kb[-1, 1] * 0.8)

    def test_shotgun_goal(self):
        job = OptimizeJob(GD, {"weapon": "SAWED OFF", "metric": "stk_torso", "settings": {"compensation": 100},
                               "depth": "quick", "lists": ["combined"], "top_n": 3})
        job._optimize()
        best = job.result["lists"]["combined"][0]
        self.assertGreater(best["score"], job.result["baseline"]["score"])


if __name__ == "__main__":
    unittest.main()
