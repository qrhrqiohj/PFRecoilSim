"""Builds the 3D model of a gun with its attachments, following the game's
WeaponUtils.constructWeapon, and works out where the gun sits in front of the
camera when held at the hip or aimed (FirearmStats aim offsets)."""
from __future__ import annotations

import copy
import gzip
import json
from pathlib import Path

import numpy as np

from .gamedata import DATA_DIR, SLOTS, GameData

# ----------------------------------------------------------------- CFrames


def cf_from(c):
    """12 components (x,y,z,r00..r22) -> 4x4 matrix."""
    m = np.eye(4)
    m[:3, 3] = c[0:3]
    m[:3, :3] = np.array(c[3:12], float).reshape(3, 3)
    return m


def cf_to(m):
    return [round(float(v), 5) for v in list(m[:3, 3]) + list(m[:3, :3].reshape(-1))]


def cf_inv(m):
    r = m[:3, :3].T
    out = np.eye(4)
    out[:3, :3] = r
    out[:3, 3] = -r @ m[:3, 3]
    return out


def cf_translate(x, y, z):
    m = np.eye(4)
    m[:3, 3] = (x, y, z)
    return m


def _cf_value(v):
    """Weapon-data CFrame value -> matrix (accepts {'__cf': [...]} or a list)."""
    if isinstance(v, dict) and "__cf" in v:
        return cf_from(v["__cf"])
    if isinstance(v, (list, tuple)) and len(v) == 12:
        return cf_from(v)
    return None


def _truthy(v):
    return v is not None and v is not False


class ModelLibrary:
    def __init__(self, path: Path | None = None):
        path = Path(path) if path else DATA_DIR / "models.json.gz"
        self.available = path.exists()
        self.data = {"weapons": {}, "attachments": {}, "shared": {}, "meshes": {}}
        if self.available:
            with gzip.open(path, "rt", encoding="utf-8") as f:
                self.data = json.load(f)

    # ContentInterface.getAttachmentModel
    def attachment_model(self, name, variant=None):
        entry = self.data["attachments"].get(name) or {}
        shared = self.data["shared"]
        if variant:
            m = entry.get(variant) or shared.get(variant)
            if m:
                return m
            m = self.attachment_model(variant)
            if m:
                return m
        m = shared.get(name)
        if entry.get("Main"):
            m = entry["Main"]
        return m


def _part(rec):
    p = dict(rec)
    p["M"] = cf_from(rec["cf"])
    return p


def _find(parts, name):
    for p in parts:
        if p["n"] == name:
            return p
    return None


def _attachment_data(gd: GameData, weapon, slot, att):
    """ContentInterface.getAttachmentData(att, weapon, slot): global data + set entry overrides."""
    raw_att = gd._raw_attachments.get(att) or {}
    set_entry = ((gd._raw_weapons[weapon].get("attachments") or {}).get(slot) or {}).get(att)
    if set_entry is None:
        return None
    data = copy.deepcopy(raw_att.get("fields") or {})
    for k, v in (set_entry.get("fields") or {}).items():
        data[k] = copy.deepcopy(v)
    return data


def _as_list(v):
    if isinstance(v, list):
        return v
    if isinstance(v, dict):
        if all(isinstance(k, str) and k.startswith("#") for k in v):
            return [v[k] for k in sorted(v, key=lambda s: int(s[1:]))]
        return list(v.values())
    return []


def _as_map(v):
    """Lua table used as a set/map -> {name: value}."""
    if isinstance(v, dict):
        return v
    if isinstance(v, list):
        return {}
    return {}


def construct_weapon(gd: GameData, lib: ModelLibrary, weapon, attachments, stats):
    model = lib.data["weapons"].get(weapon)
    if not model:
        return None
    parts = [_part(r) for r in model["parts"]]
    nodes = {n: _part(r) for n, r in model["nodes"].items()}
    mainpart_name = stats.get("mainpart") or "Trigger"
    main = _find(parts, mainpart_name)
    if main is None:
        return None
    removeparts = _as_map(stats.get("removeparts"))
    transparencymod = _as_map(stats.get("transparencymod"))
    partcolormod = _as_map(stats.get("partcolormod"))
    parts = [p for p in parts if p["n"] != "Hitbox" and not _truthy(removeparts.get(p["n"]))]
    for p in parts:
        if isinstance(transparencymod.get(p["n"]), (int, float)):
            p["t"] = transparencymod[p["n"]]
        col = partcolormod.get(p["n"])
        if isinstance(col, list) and len(col) == 3:
            p["c"] = "%02x%02x%02x" % tuple(int(round(c * 255)) for c in col)
    for k, v in _as_map(stats.get("menuNodeOverride")).items():
        if isinstance(v, str) and v in nodes:
            nodes[k] = nodes.pop(v)

    equipped = [a for a in attachments.values() if a]
    for slot in SLOTS:
        att = attachments.get(slot)
        if not att:
            continue
        adata = _attachment_data(gd, weapon, slot, att)
        if adata is None:
            continue
        # applyConditionalOverrides
        for other, overrides in _as_map(adata.get("conditionalOverrides")).items():
            if other in equipped and isinstance(overrides, dict):
                adata.update(overrides)
        ctx = {
            "target": nodes.get(adata["node"]) if adata.get("node") else None,
            "sidemount": {},
            "slot": slot,
            "att": att,
            "data": adata,
        }
        if adata.get("sidemount"):
            _process_sidemount(lib, parts, nodes, ctx)
        else:
            ctx["target"] = ctx["target"] or nodes.get(slot + "Node")
        if adata.get("auxmodels"):
            _process_aux(lib, parts, nodes, ctx, stats)
        _weld_attachment(lib, parts, nodes, ctx)

    removeabs = _as_map(stats.get("removepartsabsolute"))
    transabs = _as_map(stats.get("transparencymodabsolute"))
    parts = [p for p in parts if not _truthy(removeabs.get(p["n"]))]
    for p in parts:
        if isinstance(transabs.get(p["n"]), (int, float)):
            p["t"] = transabs[p["n"]]
    return parts, main


def _place(parts_src, node_part, target_M, skip_node=True):
    """Move a clone's parts so its Node lands on target_M."""
    node_inv = cf_inv(node_part["M"])
    out = []
    for r in parts_src:
        if skip_node and r is node_part:
            continue
        p = dict(r)
        p["M"] = target_M @ node_inv @ r["M"]
        out.append(p)
    return out


def _clone(model):
    return [_part(r) for r in model] if model else None


def _process_sidemount(lib, parts, nodes, ctx):
    data, slot, att = ctx["data"], ctx["slot"], ctx["att"]
    clone = _clone(lib.attachment_model(att, data.get("sidemount")))
    if not clone:
        return
    anchor = nodes.get(data["mountnode"]) if data.get("mountnode") else None
    if anchor is None:
        if slot == "Underbarrel":
            anchor = nodes.get("UnderMountNode")
        elif slot == "Optics":
            anchor = nodes.get("MountNode")
    if data.get("altnode"):
        ctx["target"] = _find(clone, data["altnode"])
    node = _find(clone, "Node")
    if anchor is None or node is None:
        return
    for p in _place(clone, node, anchor["M"]):
        parts.append(p)
        ctx["sidemount"][p["n"]] = p
        if (p["n"] == slot + "Node" and not ctx["target"]) or p["n"] == data.get("nodeside"):
            ctx["target"] = p
        elif p["n"] == "SightMark":
            p["stay"] = True
    if data.get("altnode") and ctx["target"] is not None:
        # the alt node moved with the clone
        ctx["target"] = _find(parts, data["altnode"]) or ctx["target"]


def _process_aux(lib, parts, nodes, ctx, stats):
    data, att = ctx["data"], ctx["att"]
    ignore = _as_map(stats.get("ignoreAuxMount"))
    placed = {}
    for i, aux in enumerate(_as_list(data.get("auxmodels")), start=1):
        if not isinstance(aux, dict):
            continue
        name = aux.get("Name") or f"{att} {aux.get('PostName')}"
        if _truthy(ignore.get(name)):
            continue
        clone = _clone(lib.attachment_model(att, name))
        if not clone:
            continue
        node = _find(clone, "Node")
        placed[name] = {}
        if aux.get("sidemount") and aux.get("Node") in ctx["sidemount"]:
            target = ctx["sidemount"][aux["Node"]]
        elif aux.get("auxmount") and aux.get("Node") in placed.get(aux["auxmount"], {}):
            target = placed[aux["auxmount"]][aux["Node"]]
        else:
            target = nodes.get(aux.get("Node"))
        if node is None or target is None:
            continue
        mainnode = aux.get("mainnode")
        for p in _place(clone, node, target["M"]):
            parts.append(p)
            placed[name][p["n"]] = p
            if p["n"] == f"{i}Node" and not ctx["target"]:
                ctx["target"] = p
            elif p["n"] == "SightMark":
                p["stay"] = True
            if mainnode and p["n"] == mainnode:
                ctx["target"] = p


def _weld_attachment(lib, parts, nodes, ctx):
    data, slot, att = ctx["data"], ctx["slot"], ctx["att"]
    model = lib.attachment_model(att, data.get("altmodel")) if data.get("altmodel") else lib.attachment_model(att)
    if not model:
        return
    copies = int(data.get("copy") or 0)
    copynodes = _as_list(data.get("copynodes"))
    for i in range(copies + 1):
        clone = _clone(model)
        node = _find(clone, "Node")
        target = ctx["target"] if i == 0 else nodes.get(copynodes[i - 1] if i - 1 < len(copynodes) else None)
        if target is None or node is None:
            continue
        # processAttachmentModel: remove parts this attachment replaces
        mag_name = "Mag" if i == 0 else f"Mag{i + 1}"

        def replaced(name):
            return (data.get("replacemag") and name == mag_name) or (data.get("replacepart") and name == data.get("replacepart"))

        keep = []
        for p in parts:
            n = p["n"]
            if slot == "Optics":
                drop = n in ("Iron", "IronGlow") or (n == "SightMark" and not p.get("stay")) or replaced(n)
            elif slot == "Underbarrel":
                drop = n == "Grip" or replaced(n)
            else:
                drop = (slot == "Barrel" and n == "Barrel") or replaced(n)
            if not drop:
                keep.append(p)
        parts[:] = keep
        for p in _place(clone, node, target["M"]):
            if data.get("replacemag") and p["n"] == "AttMag":
                p["n"] = mag_name
            if data.get("replacepart") and p["n"] == "Part":
                p["n"] = data["replacepart"]
            parts.append(p)


# ----------------------------------------------------------------- poses


def weapon_scene(gd: GameData, lib: ModelLibrary, weapon, attachments):
    """Parts in main-part space + hip/aim placements relative to the camera."""
    cfg = gd.compile(weapon, attachments)
    stats = cfg.stats
    built = construct_weapon(gd, lib, weapon, attachments, stats)
    if not built:
        return None
    parts, main = built
    main_inv = cf_inv(main["M"])
    out_parts = []
    for p in parts:
        if p.get("t", 0) >= 0.99:
            continue
        rec = {k: v for k, v in p.items() if k not in ("M", "cf", "stay")}
        rec["cf"] = cf_to(main_inv @ p["M"])
        out_parts.append(rec)

    mainoffset = _cf_value(stats.get("mainoffset"))
    if mainoffset is None:
        mainoffset = cf_translate(0.75, -1, -1.2)
    # FirearmStats aim offset
    sight_name = stats.get("sight") or "SightMark"
    sight = _find(parts, sight_name) or _find(parts, "SightMark")
    aim = None
    if sight is not None:
        v7 = cf_inv(mainoffset) @ cf_inv(sight["M"]) @ main["M"]
        v10 = v7.copy()
        if stats.get("aimzdist") is not None:
            v10[:3, 3] -= np.array([0, 0, float(stats["aimzdist"]) + float(stats.get("aimzoffset") or 0)])
        else:
            v10[:3, 3] -= np.array([0, 0, v7[2, 3]])
        rel = _cf_value(stats.get("aimreloffset"))
        if rel is not None:
            v10 = v10 @ rel
        aim = mainoffset @ v10
    hip = mainoffset.copy()
    barrel = _find(parts, stats.get("barrel") or "Flame")
    muzzle = (main_inv @ barrel["M"])[:3, 3].tolist() if barrel is not None else [0, 0.2, -3]
    sight_local = (main_inv @ sight["M"])[:3, 3].tolist() if sight is not None else None
    return {
        "parts": out_parts,
        "meshes": {p["mid"]: lib.data["meshes"][p["mid"]] for p in out_parts if p.get("mid") in lib.data["meshes"]},
        "hip": cf_to(hip),
        "aim": cf_to(aim) if aim is not None else cf_to(hip),
        "muzzle": muzzle,
        "sight": sight_local,
        "zoom": float(stats.get("zoom") or 1),
        "blackscope": bool(stats.get("blackscope")),
        "real_meshes": bool(lib.data["meshes"]),
    }
