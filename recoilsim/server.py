"""Local web server: serves the range UI and a small JSON API."""
from __future__ import annotations

import copy
import gzip
import json
import math
import mimetypes
import threading
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import numpy as np

from .analysis import METRICS, apply_compensation, heatmap, mean_path, one_shot_damage, summarize
from .gamedata import DATA_DIR, SLOTS, GameData, class_key
from .recoil_edit import from_lua, sanitize, to_lua
from .models import ModelLibrary, weapon_scene
from .export import BatchJob, gun_stats_sheet, read_sheet, to_csv, to_xlsx
from .optimizer import JobManager, default_exclude_map
from .simulate import (AIM_POINTS, HITBOX_RADIUS, HITBOXES, STANCE_STABILITY, SimResult, SimSettings, firemode_label,
                       interpolate_damage, plan_shots, simulate)

WEB_DIR = Path(__file__).resolve().parent.parent / "web"


class Cancelled(Exception):
    """A newer mag-dump request from the page replaced this one."""


def _clean(o):
    """Make numpy / inf / nan JSON safe."""
    if isinstance(o, dict):
        return {str(k): _clean(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [_clean(v) for v in o]
    if isinstance(o, np.ndarray):
        return _clean(o.tolist())
    if isinstance(o, (np.floating,)):
        o = float(o)
    if isinstance(o, (np.integer,)):
        return int(o)
    if isinstance(o, float):
        if math.isnan(o) or math.isinf(o):
            return None
        return o
    return o


class App:
    def __init__(self, data_path=None):
        self.gd = GameData(data_path)
        self.models = ModelLibrary()
        self.gd.use_models(self.models)
        self.scene_cache = {}
        self.jobs = JobManager(data_path)
        self.data_path = data_path
        self.import_parts = {}
        self.lock = threading.Lock()
        self.dump_gen = 0

    # ------------------------------------------------------------------ helpers
    def settings_from(self, s: dict, runs=1, record_track=False) -> SimSettings:
        return SimSettings(
            distance=float(s.get("distance", 50)),
            aiming=bool(s.get("aiming", True)),
            stance=s.get("stance", "stand"),
            firemode_index=int(s.get("firemode_index", 0)),
            firemode_label=s.get("firemode_label") or None,
            shots=int(s["shots"]) if s.get("shots") else None,
            fps=float(s.get("fps", 60)),
            trigger_rpm=float(s["trigger_rpm"]) if s.get("trigger_rpm") else None,
            aim_point=s.get("aim_point", "torso"),
            aim_offset=float(s["aim_offset"]) if s.get("aim_offset") not in (None, "") else None,
            gravity=bool(s.get("gravity", True)),
            health=float(s.get("health", 100)),
            runs=max(1, min(int(runs), 200000)),
            seed=int(s["seed"]) if s.get("seed") not in (None, "") else None,
            record_track=record_track,
            trigger_holds=s.get("trigger_holds") or None,
            track_end=float(s["track_end"]) if s.get("track_end") else None,
            track_start=float(s["track_start"]) if s.get("track_start") else None,
            controller=bool(s.get("controller", False)),
        )

    def attachment_groups(self, weapon, locked):
        """Per slot: groups of attachments with identical shooting stats, and
        which ones change nothing at all (never worth simulating)."""
        from .optimizer import HANDLING_KEYS, slot_groups_for
        base = {k: v for k, v in locked.items() if v and k in SLOTS}
        free = [s for s in SLOTS if s not in locked]
        # handling counts as a difference here: a laser that only speeds up
        # sprint-to-aim isn't "the same as an empty slot"
        groups = slot_groups_for(self.gd, weapon, base, free, None, HANDLING_KEYS)
        out = {}
        for s in free:
            out[s] = [{"rep": g["rep"], "members": [m for m in g["members"] if m], "no_effect": g["no_effect"]}
                      for g in groups[s]]
        return out

    def all_attachments(self):
        """Every attachment any gun can use, per slot, with how many guns use it
        (for the every-gun export's exclusions and locks)."""
        if getattr(self, "_all_atts", None) is None:
            seen = {}
            for w in self.gd.weapon_names():
                for slot, opts in self.gd.attachment_options(w).items():
                    for o in opts:
                        e = seen.setdefault((slot, o["name"]), {"name": o["name"], "displayname": o["displayname"], "guns": [], "ids": []})
                        e["guns"].append(self.gd.weapon_entry(w)["data"].get("displayname") or w)
                        e["ids"].append(w)
            out = {s: [] for s in SLOTS}
            for (slot, _n), e in seen.items():
                out[slot].append({"name": e["name"], "displayname": e["displayname"], "guns": len(e["guns"]),
                                  "only": e["guns"][0] if len(e["guns"]) == 1 else None,
                                  # every gun that can use it, for the hover text
                                  "gun_list": sorted(e["guns"]),
                                  # [weapon, display name] in menu order, for per-gun exclusions
                                  "gun_ids": [[w, d] for w, d in sorted(zip(e["ids"], e["guns"]), key=lambda x: (class_key(self.gd.weapon_entry(x[0])["class"]), self.gd.rank_key(x[0])))]})
            for lst in out.values():
                lst.sort(key=lambda e: (-e["guns"], e["displayname"].lower()))
            self._all_atts = out
        return self._all_atts

    def weapon_info(self, name):
        cfg = self.gd.compile(name, {})
        stats = cfg.stats
        fms = stats.get("firemodes") or [True]
        if not isinstance(fms, list):
            fms = [fms]
        return {
            "name": name,
            "displayname": cfg.displayname,
            "class": cfg.weapon_class,
            "rank": self.gd.unlock_rank(name),
            "test": self.gd.is_test_weapon(name),
            "description": stats.get("description") or "",
            "firemodes": [firemode_label(f) for f in fms],
            "attachments": self.gd.attachment_options(name),
            # most damage one shot can do per part: the finder picks the one-shot goal
            # when the torso figure reaches the enemy's health
            "oneshot_damage": one_shot_damage(stats),
            "pellets": int(stats.get("pelletcount") or 1),
            # attachments that make a single-bullet gun fire pellets (buckshot conversions)
            "pellet_atts": self.pellet_attachments(name) if int(stats.get("pelletcount") or 1) <= 1 else [],
        }

    @staticmethod
    def stk_bands(graph, mult, pellets, health, max_d):
        """Shots-to-kill bands along range: [{from, to, stk}] (uses every pellet hitting)."""
        bands = []
        d, step = 0.0, 0.25
        prev = None
        while d <= max_d + 1e-9:
            dmg = interpolate_damage(graph, d) * mult * pellets
            k = math.ceil(health / dmg - 1e-9) if dmg > 0 else None
            if k != prev:
                if bands:
                    bands[-1]["to"] = round(d, 2)
                bands.append({"from": round(d, 2), "to": None, "stk": k})
                prev = k
            d += step
        if bands:
            bands[-1]["to"] = None
        return bands

    def pellet_attachments(self, name):
        cache = self.__dict__.setdefault("_pellet_atts", {})
        if name in cache:
            return cache[name]
        out = cache[name] = []
        for slot, opts in self.gd.attachment_options(name).items():
            for o in opts:
                try:
                    if int(self.gd.compile(name, {slot: o["name"]}).stats.get("pelletcount") or 1) > 1:
                        out.append({"slot": slot, "name": o["name"]})
                except Exception:
                    pass
        return out

    def one_shot_avg(self, cfg, health, aiming=True):
        """Average one-shot range per part (first shot, every pellet's spread counted)."""
        from .optimizer import one_shot_averages
        st = SimSettings(distance=50, aiming=aiming, runs=1500, seed=4242, shots=1, gravity=False, keep_rays=True)
        try:
            return one_shot_averages(simulate(cfg, st), cfg, health)
        except Exception:
            return None

    def stats_summary(self, name, attachments, distance, health=100.0, aiming=True):
        cfg = self.gd.compile(name, attachments)
        s = cfg.stats
        graph = s.get("damageGraph") or []
        dmg = interpolate_damage(graph, distance)
        mh, mt, ml = s.get("multhead") or 1, s.get("multtorso") or 1, s.get("multlimb") or 1
        fr = s.get("firerate")
        fms = s.get("firemodes") or [True]
        if not isinstance(fms, list):
            fms = [fms]
        pellets = int(s.get("pelletcount") or 1)

        def stk(d):
            return math.ceil(health / d - 1e-9) if d > 0 else None

        return {
            "displayname": cfg.displayname,
            "firerate": fr,
            "firemodes": [firemode_label(f) for f in fms],
            "magsize": s.get("magsize"),
            "sparerounds": s.get("sparerounds"),
            "bulletspeed": s.get("bulletspeed"),
            "damageGraph": graph,
            "damage_here": {"base": dmg, "head": dmg * mh, "torso": dmg * mt, "limb": dmg * ml},
            "shots_to_kill": {"head": stk(dmg * mh) if pellets == 1 else None,
                              "torso": stk(dmg * mt) if pellets == 1 else None,
                              "limb": stk(dmg * ml) if pellets == 1 else None},
            "multhead": mh, "multtorso": mt, "multlimb": ml,
            "stk_bands": {
                part: self.stk_bands(graph, m, pellets, health, max(float(graph[-1]["distance"]) * 1.4 if graph else 300, distance * 1.2, 100))
                for part, m in (("head", mh), ("torso", mt), ("limb", ml))
            },
            "health": health,
            "one_shot_avg": self.one_shot_avg(cfg, health, aiming),
            "pelletcount": pellets,
            "spread": s.get("spread"),
            "hipfirespread": s.get("hipfirespread"),
            "aimspeed": s.get("aimspeed"),
            "walkspeed": s.get("walkspeed"),
            "zoom": s.get("zoom"),
            "ammotype": s.get("ammotype"),
            "penetrationdepth": s.get("penetrationdepth"),
            "recoildelay": s.get("recoildelay"),
            "heatfireratekick": s.get("heatfireratekick"),
            "firecap": s.get("firecap"),
            "forcecap": bool(s.get("forcecap")),
            "aimedfirerate": s.get("aimedfirerate"),
            "burstfirerate": s.get("burstfirerate"),
            "variablefirerate": bool(s.get("variablefirerate")),
        }

    MAX_BULLETS = 3_000_000   # per request (runs x shots x pellets); keeps memory and time sane
    CHUNK_BULLETS = 250_000

    def _simulate_chunked(self, cfg, st, body):
        """Run big mag-dump batches in chunks so memory stays small, a newer
        request from the page cancels an older one, and absurd sizes are capped."""
        plan_n = len(plan_shots(cfg, st).fire_times) or 1
        pellets = int(cfg.stats.get("pelletcount") or 1)
        per_run = plan_n * pellets
        capped = None
        max_runs = max(1, self.MAX_BULLETS // per_run)
        if st.runs > max_runs:
            capped = st.runs
            st.runs = max_runs
        is_dump = bool(body.get("dump"))
        if is_dump:
            with self.lock:
                self.dump_gen += 1
                gen = self.dump_gen
        chunk = max(1, self.CHUNK_BULLETS // per_run)
        if st.runs <= chunk:
            return simulate(cfg, st), capped
        results = []
        done = 0
        k = 0
        while done < st.runs:
            if is_dump and self.dump_gen != gen:
                raise Cancelled()
            sub = copy.copy(st)
            sub.runs = min(chunk, st.runs - done)
            sub.seed = None if st.seed is None else st.seed + 1000003 * k
            sub.record_track = st.record_track and k == 0
            results.append(simulate(cfg, sub))
            done += sub.runs
            k += 1
        r0 = results[0]
        return SimResult(r0.plan,
                         np.concatenate([r.impacts for r in results]),
                         np.concatenate([r.parts for r in results]),
                         np.concatenate([r.damage for r in results]),
                         np.concatenate([r.travel_time for r in results]),
                         r0.track, r0.target_cy, r0.dmg_values), capped

    def run_sim(self, body):
        weapon = body["weapon"]
        atts = {k: v for k, v in (body.get("attachments") or {}).items() if v}
        settings = body.get("settings") or {}
        runs = int(body.get("runs", 1))
        cfg = self.gd.compile(weapon, atts)
        st = self.settings_from(settings, runs=runs, record_track=bool(body.get("track")))
        t0 = time.time()
        res, capped = self._simulate_chunked(cfg, st, body)
        comp = float(settings.get("compensation", 0)) / 100.0
        path = None
        if comp > 0:
            if res.track:
                path, mtrack = mean_path(cfg, st, track=True)
            else:
                path, mtrack = mean_path(cfg, st), None
            apply_compensation(res, path, comp)
            if res.track and mtrack:
                # The shooter pulls against the average recoil continuously, so
                # the replay camera / gun get the same counter-movement: the
                # average path over time (it recovers back to 0 like the springs).
                # Appended to each row: [comp x, comp y] in studs at the target.
                mt = np.array([[r[0], r[1], r[2]] for r in mtrack])
                for row in res.track:
                    cx = float(np.interp(row[0], mt[:, 0], mt[:, 1])) * comp
                    cy = float(np.interp(row[0], mt[:, 0], mt[:, 2])) * comp
                    row[1] -= cx
                    row[2] -= cy
                    row += [round(cx, 5), round(cy, 5)]
        summ = summarize(res, st, st.health)
        out = {"summary": summ, "elapsed": round(time.time() - t0, 3), "runs": st.runs, "capped_from": capped,
               "target_cy": res.target_cy, "distance": st.distance,
               "fire_times": res.plan.sample_times, "firemode": res.plan.label}
        show = min(runs, int(body.get("return_runs", 1)))
        out["impacts"] = res.impacts[:show].round(4)
        out["parts"] = res.parts[:show]
        if res.track:
            out["track"] = res.track
        if runs > 1 or body.get("heatmap"):
            hb = body.get("heat_bounds")
            if not hb:
                hb = [[-4.5, 4.5], [res.target_cy - 3.6, res.target_cy + 2.9]]
            out["heatmap"] = heatmap(res, hb, bins=tuple(body.get("heat_bins", (90, 130))))
            # point cloud sample for the pattern view
            flat = res.impacts.reshape(-1, 2)
            fin = flat[np.isfinite(flat).all(axis=1)]
            if len(fin) > 30000:
                idx = np.random.default_rng(0).choice(len(fin), 30000, replace=False)
                fin = fin[idx]
            out["cloud"] = fin.round(3)
        return _clean(out)


def make_handler(app: App):
    class Handler(BaseHTTPRequestHandler):
        server_version = "RecoilSim/1.0"

        def log_message(self, fmt, *args):
            pass  # keep the console quiet

        def _send(self, code, payload, ctype="application/json"):
            if ctype == "application/json":
                data = json.dumps(payload, separators=(",", ":")).encode()
            else:
                data = payload
            accept = self.headers.get("Accept-Encoding", "")
            gz = "gzip" in accept and len(data) > 2048
            if gz:
                data = gzip.compress(data, 5)
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            if gz:
                self.send_header("Content-Encoding", "gzip")
            try:
                self.end_headers()
                self.wfile.write(data)
            except (ConnectionError, OSError):
                # the page went away (closed / reloaded / request replaced): nothing to do
                self.close_connection = True

        def _body(self):
            n = int(self.headers.get("Content-Length") or 0)
            raw = self.rfile.read(n) if n else b"{}"
            return json.loads(raw.decode("utf-8") or "{}")

        def do_GET(self):
            try:
                u = urlparse(self.path)
                q = {k: v[0] for k, v in parse_qs(u.query).items()}
                if u.path == "/api/stale":
                    return self._send(200, {"stale": _code_changed()})
                if u.path == "/api/catalog":
                    return self._send(200, {"classes": app.gd.catalog(), "meta": app.gd.meta,
                                            "metrics": METRICS, "aim_points": AIM_POINTS,
                                            "stances": list(STANCE_STABILITY), "slots": SLOTS,
                                            "hitboxes": [list(h) for h in HITBOXES],
                                            "default_excludes": default_exclude_map(app.gd), "hitbox_radius": HITBOX_RADIUS})
                if u.path == "/api/attachments_all":
                    return self._send(200, app.all_attachments())
                if u.path == "/api/weapon":
                    return self._send(200, _clean(app.weapon_info(q["name"])))
                if u.path == "/api/job":
                    job = app.jobs.get(q.get("id"))
                    if not job:
                        return self._send(404, {"error": "unknown job"})
                    if isinstance(job, BatchJob):
                        return self._send(200, _clean(job.status(with_table=q.get("table") == "1")))
                    return self._send(200, _clean(job.status()))
                # static files
                rel = u.path.lstrip("/") or "index.html"
                f = (WEB_DIR / rel).resolve()
                if WEB_DIR not in f.parents and f != WEB_DIR or not f.is_file():
                    return self._send(404, b"not found", "text/plain")
                ctype = mimetypes.guess_type(str(f))[0] or "application/octet-stream"
                if ctype.startswith("text/") or ctype in ("application/javascript",):
                    ctype += "; charset=utf-8"
                return self._send(200, f.read_bytes(), ctype)
            except Cancelled:
                return self._send(409, {"error": "cancelled"})
            except (ConnectionError, BrokenPipeError):
                return None
            except Exception as e:
                traceback.print_exc()
                return self._send(500, {"error": f"{type(e).__name__}: {e}"})

        def do_POST(self):
            try:
                u = urlparse(self.path)
                q = {k: v[0] for k, v in parse_qs(u.query).items()}
                if u.path == "/api/import":
                    return self._import(q)
                if u.path == "/api/import_sheet":
                    # a sheet exported before (CSV / TSV / .xlsx) back into the export preview
                    n = int(self.headers.get("Content-Length") or 0)
                    if n > 30_000_000:
                        return self._send(413, {"error": "file too large"})
                    try:
                        return self._send(200, _clean(read_sheet(self.rfile.read(n), q.get("name", "sheet"))))
                    except Exception as e:
                        return self._send(400, {"error": f"Couldn't read that file: {e}"})
                body = self._body()
                # edited recoil (Recoil tab) comes with every request's settings
                if isinstance(body.get("settings"), dict):
                    app.gd.set_recoil_overrides(body["settings"].get("recoil_overrides") or {})
                if u.path == "/api/recoil":
                    # the game's own recoil of a gun (for the Recoil tab), and its text form
                    base = app.gd.base_recoil(body["weapon"])
                    return self._send(200, {"recoil": base})
                if u.path == "/api/recoil/lua":
                    return self._send(200, {"text": to_lua(sanitize(body["recoil"]))})
                if u.path == "/api/recoil/parse":
                    try:
                        return self._send(200, {"recoil": from_lua(body.get("text") or "")})
                    except ValueError as e:
                        return self._send(400, {"error": f"Couldn't read that recoil: {e}"})
                if u.path == "/api/recoil/path":
                    from .recoil_fit import preview_path
                    return self._send(200, _clean(preview_path(app.gd, body)))
                if u.path == "/api/recoil/fit":
                    from .recoil_fit import fit_recoil
                    try:
                        return self._send(200, _clean(fit_recoil(app.gd, body)))
                    except ValueError as e:
                        return self._send(400, {"error": str(e)})
                if u.path == "/api/model":
                    atts = {k: v for k, v in (body.get("attachments") or {}).items() if v}
                    key = (body["weapon"], tuple(sorted(atts.items())))
                    if key not in app.scene_cache:
                        app.scene_cache[key] = weapon_scene(app.gd, app.models, body["weapon"], atts)
                        if len(app.scene_cache) > 64:
                            app.scene_cache.pop(next(iter(app.scene_cache)))
                    return self._send(200, _clean({"scene": app.scene_cache[key]}))
                if u.path == "/api/oneshot_info":
                    # most one-shot damage per part for a setup (conversions can change it)
                    cfg = app.gd.compile(body["weapon"], {k: v for k, v in (body.get("attachments") or {}).items() if v})
                    return self._send(200, _clean({"oneshot_damage": one_shot_damage(cfg.stats),
                                                   "pellets": int(cfg.stats.get("pelletcount") or 1)}))
                if u.path == "/api/stats":
                    return self._send(200, _clean(app.stats_summary(body["weapon"], {k: v for k, v in (body.get("attachments") or {}).items() if v}, float(body.get("distance", 50)), float(body.get("health", 100)), bool(body.get("aiming", True)))))
                if u.path == "/api/simulate":
                    return self._send(200, app.run_sim(body))
                if u.path == "/api/optimize":
                    job = app.jobs.start(app.gd, body)
                    return self._send(200, {"id": job.id})
                if u.path == "/api/optimize/cancel":
                    app.jobs.cancel(body.get("id"))
                    return self._send(200, {"ok": True})
                if u.path == "/api/export/stats":
                    return self._send(200, _clean(gun_stats_sheet(app.gd, body.get("classes"), body.get("distances") or (0, 50, 100, 200),
                                                                  float(body.get("health", 100)), body.get("groups"))))
                if u.path == "/api/batch":
                    job = app.jobs.launch(BatchJob(app.gd, body), "batch")
                    return self._send(200, {"id": job.id})
                if u.path == "/api/export/file":
                    return self._file(body)
                if u.path == "/api/attachment_groups":
                    return self._send(200, _clean(app.attachment_groups(body["weapon"], body.get("locked") or {})))
                return self._send(404, {"error": "unknown endpoint"})
            except Cancelled:
                return self._send(409, {"error": "cancelled"})
            except (ConnectionError, BrokenPipeError):
                return None
            except Exception as e:
                traceback.print_exc()
                return self._send(500, {"error": f"{type(e).__name__}: {e}"})

        def _file(self, body):
            """Turn table(s) built by the page into a downloadable .xlsx / .csv."""
            sheets = body.get("sheets") or []
            fmt = body.get("format", "xlsx")
            name = "".join(ch for ch in str(body.get("name") or "recoilsim") if ch.isalnum() or ch in " -_().") or "recoilsim"
            if fmt == "csv":
                data, ctype, ext = to_csv(sheets[0]), "text/csv; charset=utf-8", "csv"
            else:
                data = to_xlsx(sheets)
                ctype, ext = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "xlsx"
            self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Content-Disposition", f'attachment; filename="{name}.{ext}"')
            self.send_header("Cache-Control", "no-store")
            try:
                self.end_headers()
                self.wfile.write(data)
            except (ConnectionError, OSError):
                self.close_connection = True

        def _import(self, q):
            """Receives a raw export from tools/StudioExporter.lua (possibly in parts)."""
            n = int(self.headers.get("Content-Length") or 0)
            chunk = self.rfile.read(n).decode("utf-8")
            part, total = int(q.get("part", 1)), int(q.get("total", 1))
            key = q.get("id", "default")
            with app.lock:
                parts = app.import_parts.setdefault(key, {})
                parts[part] = chunk
                if len(parts) < total:
                    return self._send(200, {"ok": True, "received": len(parts), "total": total})
                raw = "".join(parts[i] for i in range(1, total + 1))
                app.import_parts.pop(key, None)
            raw_path = DATA_DIR / "studio_export_raw.json"
            raw_path.write_text(raw, encoding="utf-8")
            import subprocess
            import sys
            tool = Path(__file__).resolve().parent.parent / "tools" / "compact_export.py"
            subprocess.run([sys.executable, str(tool), str(raw_path), str(DATA_DIR)], check=True)
            raw_path.unlink()
            app.gd = GameData()
            app.models = ModelLibrary()
            app.gd.use_models(app.models)
            app.scene_cache.clear()
            app._all_atts = None
            app.jobs.reset_pool()
            print(f"[RecoilSim] Imported new game data: {len(app.gd.weapon_names())} weapons")
            return self._send(200, {"ok": True, "weapons": len(app.gd.weapon_names())})

    return Handler


class QuietServer(ThreadingHTTPServer):
    daemon_threads = True

    def handle_error(self, request, client_address):
        import sys
        if isinstance(sys.exc_info()[1], (ConnectionError, OSError)):
            return  # browser closed the connection; harmless
        super().handle_error(request, client_address)


_CODE_DIR = __import__("pathlib").Path(__file__).resolve().parent
_STARTED = time.time()


def _code_changed() -> bool:
    """True when RecoilSim's Python files were replaced after this server
    started (an update was copied in): it is still running the old code."""
    try:
        return any(p.stat().st_mtime > _STARTED + 1 for p in _CODE_DIR.glob("*.py"))
    except OSError:
        return False


def serve(port=8765, open_browser=True, data_path=None):
    app = App(data_path)
    httpd = None
    for p in range(port, port + 20):
        try:
            httpd = QuietServer(("127.0.0.1", p), make_handler(app))
            port = p
            break
        except OSError:
            continue
    if httpd is None:
        raise SystemExit("Could not find a free port")
    url = f"http://127.0.0.1:{port}/"
    print(f"[RecoilSim] {len(app.gd.weapon_names())} weapons loaded")
    print(f"[RecoilSim] Range is open at {url}  (Ctrl+C to quit)")
    if open_browser:
        import webbrowser
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n[RecoilSim] Bye")
    finally:
        httpd.server_close()
        app.jobs.reset_pool()
