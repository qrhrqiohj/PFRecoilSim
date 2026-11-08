"""Shrink a raw Studio export into the data files the simulator ships with.

Usage:
    python tools/compact_export.py <raw_export.json> [output_folder]

Writes <output_folder>/game_data.json.gz (stats, attachments, placement rules)
and <output_folder>/models.json.gz (3D part layouts of guns and attachments).
The raw export comes from tools/StudioExporter.lua. Only sound, arm, animation
and menu-only data are dropped; nothing that changes shooting or how the gun
model is assembled is removed.
"""
import gzip
import json
import sys
from pathlib import Path

# First indexPath keys whose modifiers only affect sound, arms or menus.
DROP_KEYS = {
    "larmoffset", "larmaimoffset", "larmsprintoffset", "larmequip", "rarmoffset",
    "rarmaimoffset", "rarmsprintoffset", "rarmequip", "firepitch", "firevolume",
    "firesoundid", "casetype", "hiderange", "hideminimap", "scopeimagesize", "scopeid",
    "scopecolor", "scopedgesize", "animations", "animationmods", "sniperbass", "snipercrack",
    "specialSFX", "effectsettings", "imgres", "altinspect", "pinglife", "hideunlessowned",
    "simpleswayparameters", "lhold3p", "rhold3p", "offset3p", "drawcf3p", "sprintcf3p",
    "forward3p", "pivot3p", "aimpivot3p", "headaimangle3p", "unlockkills", "unlockrank",
}


def _first_key(mod):
    path = mod.get("indexPath") if isinstance(mod, dict) else None
    if isinstance(path, list) and path and isinstance(path[0], str):
        return path[0]
    return None


def clean_mods(mods):
    if not isinstance(mods, dict):
        return mods
    out = {}
    for mtype, entries in mods.items():
        if isinstance(entries, list):
            kept = [m for m in entries if _first_key(m) not in DROP_KEYS]
            if kept:
                out[mtype] = kept
        elif isinstance(entries, dict) and not entries.get("__empty"):
            kept = {k: m for k, m in entries.items() if _first_key(m) not in DROP_KEYS}
            if kept:
                out[mtype] = kept
    return out


def clean_fields(fields):
    if not isinstance(fields, dict):
        return {}
    return {k: v for k, v in fields.items() if k not in DROP_KEYS and k != "displayname"}


def build_unlock(raw):
    """Unlock requirements (the gun's rank, kills per attachment) for sorting and
    labels, from the fields the clean-up below drops: weapon data "unlockrank",
    attachment "unlockkills", and per-gun set entries that override it
    and which attachments are admin / super-tester only on each gun."""
    def num(v):
        return None if not isinstance(v, (int, float)) or isinstance(v, bool) or v >= 1e299 else v
    ranks = {n: num(w["data"].get("unlockrank")) for n, w in raw["weapons"].items()}
    att_kills = {}
    for n, a in raw["attachments"].items():
        k = num((a.get("fields") or {}).get("unlockkills"))
        if k:
            att_kills[n] = int(k)
    over, test = {}, {}
    for wn, w in raw["weapons"].items():
        for slot, entries in (w.get("attachments") or {}).items():
            if not isinstance(entries, dict):
                continue
            for an, e in entries.items():
                f = (e or {}).get("fields") or {}
                k = num(f.get("unlockkills"))
                a = (raw["attachments"].get(an) or {}).get("fields") or {}
                if f.get("admin") or f.get("supertest") or a.get("admin") or a.get("supertest"):
                    test.setdefault(wn, []).append(f"{slot}|{an}")
                if k is not None and k != att_kills.get(an, 0):
                    over.setdefault(wn, {})[f"{slot}|{an}"] = int(k)
    return {"ranks": ranks, "attKills": att_kills, "over": over, "allFree": [], "test": test}


def main():
    src = Path(sys.argv[1])
    out_dir = Path(sys.argv[2]) if len(sys.argv) > 2 else Path(__file__).resolve().parent.parent / "data"
    raw = json.loads(src.read_text(encoding="utf-8"))

    attachments = {}
    for name, att in raw["attachments"].items():
        attachments[name] = {
            "category": att.get("category"),
            "displayname": att.get("displayname"),
            "info": att.get("info"),
            "mods": clean_mods(att.get("mods") or {}),
            "fields": clean_fields(att.get("fields")),
        }

    weapons = {}
    for name, w in raw["weapons"].items():
        slots = {}
        for slot, entries in (w.get("attachments") or {}).items():
            if not isinstance(entries, dict):
                slots[slot] = {}
                continue
            slots[slot] = {}
            for an, e in entries.items():
                rec = {"mods": clean_mods(e.get("mods") or {}), "displayname": e.get("displayname"),
                       "fields": clean_fields(e.get("fields"))}
                slots[slot][an] = {k: v for k, v in rec.items() if v}
        weapons[name] = {
            "class": w["class"],
            "data": {k: v for k, v in w["data"].items() if k not in DROP_KEYS},
            "attachments": slots,
            "anims": dict(w.get("anims") or {}),
        }

    out = {
        "version": raw.get("version", 2),
        "exportedAt": raw.get("exportedAt"),
        "source": raw.get("source", "Studio export"),
        "weapons": weapons,
        "attachments": attachments,
        "unlock": build_unlock(raw),
    }
    out_dir.mkdir(parents=True, exist_ok=True)
    gd = out_dir / "game_data.json.gz"
    with gzip.open(gd, "wt", encoding="utf-8", compresslevel=9) as f:
        json.dump(out, f, separators=(",", ":"))
    print(f"wrote {gd} ({gd.stat().st_size / 1e6:.2f} MB): {len(weapons)} weapons, {len(attachments)} attachments")

    models = raw.get("models")
    if models:
        md = out_dir / "models.json.gz"
        with gzip.open(md, "wt", encoding="utf-8", compresslevel=9) as f:
            json.dump(models, f, separators=(",", ":"))
        print(f"wrote {md} ({md.stat().st_size / 1e6:.2f} MB): {len(models.get('weapons', {}))} gun models, "
              f"{len(models.get('meshes', {}))} real meshes")


if __name__ == "__main__":
    main()
