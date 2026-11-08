"""Loads exported game data and compiles a weapon + attachment setup into the
stats the simulator needs, following ContentUtils.compileWeaponData."""
from __future__ import annotations

import gzip
import json
import math
from dataclasses import dataclass, field
from pathlib import Path

from .lua import deep_copy, from_json, length, pairs, table_append, table_insert, to_plain
from .modifiers import compile_modifiers

SLOTS = ("Optics", "Barrel", "Underbarrel", "Other", "Ammo")
DATA_DIR = Path(__file__).resolve().parent.parent / "data"


def lua_round(x):
    return math.floor(x + 0.5) if x >= 0 else -math.floor(-x + 0.5)


@dataclass
class WeaponConfig:
    """Compiled stats for one weapon + attachment setup."""

    name: str
    displayname: str
    weapon_class: str
    attachments: dict
    stats: dict  # full compiled stat table (plain python)
    recoil: dict  # plain python recoil table
    anims: dict = field(default_factory=dict)

    def get(self, key, default=None):
        v = self.stats.get(key)
        return default if v is None else v


class GameData:
    def __init__(self, path: Path | None = None):
        self.path = Path(path) if path else self._default_path()
        self.reload()

    @staticmethod
    def _default_path():
        for name in ("game_data.json.gz", "game_data.json"):
            p = DATA_DIR / name
            if p.exists():
                return p
        raise FileNotFoundError(f"No game data found in {DATA_DIR}")

    def reload(self, raw=None):
        if raw is None:
            if self.path.suffix == ".gz":
                with gzip.open(self.path, "rt", encoding="utf-8") as f:
                    raw = json.load(f)
            else:
                raw = json.loads(self.path.read_text(encoding="utf-8"))
        self.meta = {k: raw.get(k) for k in ("version", "exportedAt", "source")}
        self._raw_weapons = raw["weapons"]
        self._raw_attachments = raw["attachments"]
        # unlock requirements: gun rank, attachment kills (per gun; -1 = test/admin only)
        u = raw.get("unlock") or {}
        self._ranks = u.get("ranks") or {}
        self._att_kills = u.get("attKills") or {}
        self._kill_over = u.get("over") or {}
        self._all_free = set(u.get("allFree") or [])
        # attachments only admins / super testers get, per gun ("Slot|name")
        self._test_atts = {w: set(v) for w, v in (u.get("test") or {}).items()}
        self._weapons = {}
        self._attachments = {}
        self._compile_cache = {}

    # ------------------------------------------------------------------ lookup
    def weapon_names(self):
        return sorted(self._raw_weapons)

    def weapon_entry(self, name):
        if name not in self._weapons:
            w = self._raw_weapons[name]
            self._weapons[name] = {
                "class": w["class"],
                "data": from_json(w["data"]),
                "attachments": {slot: from_json(v) if isinstance(v, dict) else {} for slot, v in w.get("attachments", {}).items()},
                "anims": w.get("anims", {}),
            }
        return self._weapons[name]

    def attachment_entry(self, name):
        if name not in self._attachments:
            a = self._raw_attachments.get(name)
            if a is None:
                self._attachments[name] = None
            else:
                self._attachments[name] = {
                    "category": a.get("category"),
                    "displayname": a.get("displayname"),
                    "info": a.get("info"),
                    "mods": from_json(a.get("mods") or {}),
                }
        return self._attachments[name]

    def unlock_rank(self, weapon):
        """Rank needed to unlock the gun (None: not unlocked by rank)."""
        return self._ranks.get(weapon)

    def kill_req(self, weapon, slot, att):
        """Kills on the gun needed to unlock an attachment."""
        k = (self._kill_over.get(weapon) or {}).get(f"{slot}|{att}")
        if k is None:
            k = 0 if weapon in self._all_free else self._att_kills.get(att, 0)
        return max(0, int(k))

    def is_test_attachment(self, weapon, slot, att):
        """Admin / super-tester only attachment on this gun."""
        return f"{slot}|{att}" in self._test_atts.get(weapon, ())

    def is_test_weapon(self, weapon):
        """Admin / super-tester gun (golden guns, test guns...)."""
        d = self._raw_weapons[weapon]["data"]
        return bool(d.get("supertest") or d.get("admin"))

    def rank_key(self, weapon):
        """Menu order: normal guns by unlock rank, then test / admin guns by rank."""
        r = self.unlock_rank(weapon)
        d = self._raw_weapons[weapon]["data"]
        return (self.is_test_weapon(weapon), r is None, r if r is not None else 0, d.get("displayname") or weapon)

    def catalog(self):
        """Weapons grouped by class for the UI, in unlock-rank order."""
        out = {}
        for name, w in self._raw_weapons.items():
            d = w["data"]
            out.setdefault(w["class"], []).append({
                "name": name,
                "displayname": d.get("displayname") or name,
                "rank": self.unlock_rank(name),
                "test": self.is_test_weapon(name),
            })
        for lst in out.values():
            lst.sort(key=lambda x: self.rank_key(x["name"]))
        return dict(sorted(out.items()))

    def attachment_options(self, weapon):
        entry = self.weapon_entry(weapon)
        out = {}
        for slot in SLOTS:
            opts = []
            for att_name, set_entry in (entry["attachments"].get(slot) or {}).items():
                a = self._raw_attachments.get(att_name) or {}
                disp = (set_entry or {}).get("displayname") if isinstance(set_entry, dict) else None
                opts.append({
                    "name": att_name,
                    "displayname": disp or a.get("displayname") or att_name,
                    "category": a.get("category") or "Unlisted",
                    "info": a.get("info") or "",
                    "kills": self.kill_req(weapon, slot, att_name),
                    "test": self.is_test_attachment(weapon, slot, att_name),
                })
            # the game's loadout order: by kills needed, then name; test-only ones last (by kills)
            opts.sort(key=lambda o: (o["test"], o["kills"], o["displayname"]))
            out[slot] = opts
        return out

    # --------------------------------------------------------------- compile
    def compile(self, weapon, attachments=None) -> WeaponConfig:
        attachments = {s: a for s, a in (attachments or {}).items() if a}
        key = (weapon, tuple(sorted(attachments.items())))
        if key in self._compile_cache:
            return self._compile_cache[key]
        entry = self.weapon_entry(weapon)
        base = entry["data"]
        att_set = entry["attachments"]

        mods = {}
        # 1) global attachment modifiers, in slot order
        for slot in SLOTS:
            att = attachments.get(slot)
            if not att or att not in (att_set.get(slot) or {}):
                continue
            adata = self.attachment_entry(att)
            if not adata:
                continue
            for mtype, lst in pairs(deep_copy(adata["mods"])):
                if not isinstance(lst, dict):
                    continue
                bucket = mods.setdefault(mtype, {})
                for _, m in pairs(lst):
                    if isinstance(m, dict):
                        path = m.get("indexPath") or {}
                        if path.get(1) == "altaimdata" and length(path) == 1 and m.get("value"):
                            if mtype == "setters" and isinstance(m["value"], dict):
                                for _, v in pairs(m["value"]):
                                    if isinstance(v, dict):
                                        v["name"] = att
                            elif mtype == "tableInserters" and isinstance(m["value"], dict):
                                m["value"]["name"] = att
                    table_append(bucket, m)
        # 2) weapon-specific overrides from the attachment set
        for slot in SLOTS:
            att = attachments.get(slot)
            if not att:
                continue
            set_entry = (att_set.get(slot) or {}).get(att)
            if not isinstance(set_entry, dict):
                continue
            for mtype, lst in pairs(set_entry.get("mods") or {}):
                if not isinstance(lst, dict):
                    continue
                bucket = mods.setdefault(mtype, {})
                for _, m in pairs(lst):
                    table_append(bucket, deep_copy(m))

        data = compile_modifiers(base, mods) if mods else deep_copy(base)

        if isinstance(data.get("sparerounds"), (int, float)):
            data["sparerounds"] = lua_round(data["sparerounds"])
        if isinstance(data.get("magsize"), (int, float)):
            data["magsize"] = lua_round(data["magsize"])
        graph = data.get("damageGraph")
        if isinstance(graph, dict) and length(graph):
            pts = [v for _, v in pairs(graph) if isinstance(v, dict)]
            pts.sort(key=lambda p: p.get("distance", 0))
            graph = {i + 1: p for i, p in enumerate(pts)}
            if graph[1].get("distance", 0) > 0:
                table_insert(graph, 1, {"distance": 0, "damage": graph[1]["damage"]})
            data["damageGraph"] = graph

        anims = entry["anims"]
        firerate = data.get("firerate")
        if firerate is not None:
            times = []

            def anim_time(name, with_reset=False):
                a = anims.get(name)
                if not a:
                    return 0.0
                t = a["ds"] * (a.get("ts") or 0.5)
                return t + (0 if not with_reset else (a.get("rt") or 0.5))

            if data.get("onfireanim"):
                times.append(anim_time(f"onfire{data['onfireanim']}"))
            if data.get("requirechamber") and "onfire" in anims:
                times.append(anim_time(f"onfire{data['onfireanim']}" if data.get("onfireanim") else "onfire"))
            if data.get("magsize") == 1 and not data.get("chambered"):
                times.append(anim_time(f"{data.get('altreloadlong') or ''}reload"))
            longest = max(times) if times else 0
            cap = 60 / longest if longest else math.inf
            if isinstance(firerate, dict):
                for k, v in list(firerate.items()):
                    if isinstance(v, (int, float)):
                        firerate[k] = min(v, cap)
            elif isinstance(firerate, (int, float)):
                data["firerate"] = min(firerate, cap)

        plain = to_plain(data)
        if not isinstance(plain, dict):
            plain = {}
        cfg = WeaponConfig(
            name=weapon,
            displayname=plain.get("displayname") or weapon,
            weapon_class=entry["class"],
            attachments=dict(attachments),
            stats=plain,
            recoil=plain.get("recoil") or {},
            anims=anims,
        )
        self._compile_cache[key] = cfg
        return cfg
