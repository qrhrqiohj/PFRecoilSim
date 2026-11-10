"""Editable gun recoil: a simple canonical form for the editor, conversion to
and from the game's data, and the game's own text format
(PageWeaponEditorRecoilExport: ``gunData.recoil["aimRotation"] = {...}``).

Canonical form (what the browser edits)::

    {"aimRotation": {"x": [[damping, speed, mean, variance], ...], "y": [...], "z": [...]},
     "aimRotationRecovery": {"x": {"layers": [[damping, speed], ...], "delay": 0.1}, ...},
     ...}  # all 8 groups and their recovery tables
"""
from __future__ import annotations

import math
import re

GROUPS = ("hipTranslation", "aimTranslation", "hipRotation", "aimRotation",
          "hipCameraBody", "aimCameraBody", "hipCameraHead", "aimCameraHead")
AXES = ("x", "y", "z")
MAX_LAYERS = 16


def _num(v, default=0.0):
    try:
        f = float(v)
    except (TypeError, ValueError):
        return default
    return f if math.isfinite(f) else default


def canonical(plain: dict) -> dict:
    """The compiled (plain Python) recoil table of a gun -> canonical form."""
    plain = plain or {}
    out = {}
    for g in GROUPS:
        grp = plain.get(g) or {}
        out[g] = {}
        for ax in AXES:
            rows = grp.get(ax) if isinstance(grp, dict) else None
            if isinstance(rows, dict):  # Lua-style {1: [...], 2: [...]}
                rows = [rows[k] for k in sorted(k for k in rows if str(k).isdigit())]
            out[g][ax] = [[_num(r[i]) if i < len(r) else 0.0 for i in range(4)] for r in (rows or []) if isinstance(r, (list, tuple))]
        rec = plain.get(g + "Recovery") or {}
        out[g + "Recovery"] = {}
        for ax in AXES:
            a = rec.get(ax) if isinstance(rec, dict) else None
            layers, delay = [], 0.0
            if isinstance(a, dict):
                keys = sorted((k for k in a if str(k).lstrip("#").isdigit()), key=lambda k: int(str(k).lstrip("#")))
                layers = [[_num(a[k][0]), _num(a[k][1])] for k in keys if isinstance(a[k], (list, tuple)) and len(a[k]) >= 2]
                delay = _num(a.get("delay"))
            elif isinstance(a, list):
                layers = [[_num(r[0]), _num(r[1])] for r in a if isinstance(r, (list, tuple)) and len(r) >= 2]
            out[g + "Recovery"][ax] = {"layers": layers, "delay": delay}
    return out


def sanitize(canon: dict) -> dict:
    """Validate a canonical table from the browser (missing parts are filled
    with empty layers, numbers are checked, at most MAX_LAYERS per axis)."""
    if not isinstance(canon, dict):
        raise ValueError("recoil must be a table")
    out = {}
    for g in GROUPS:
        grp = canon.get(g) or {}
        out[g] = {}
        for ax in AXES:
            rows = grp.get(ax) or []
            if not isinstance(rows, list):
                raise ValueError(f"{g}.{ax} must be a list of layers")
            clean = []
            for r in rows[:MAX_LAYERS]:
                if not isinstance(r, (list, tuple)) or len(r) != 4:
                    raise ValueError(f"{g}.{ax}: every layer needs 4 values (damping, speed, mean, variance)")
                clean.append([_num(x) for x in r])
            out[g][ax] = clean
        rec = canon.get(g + "Recovery") or {}
        out[g + "Recovery"] = {}
        for ax in AXES:
            a = rec.get(ax) or {}
            layers = a.get("layers") or [] if isinstance(a, dict) else []
            clean = []
            for r in layers[:MAX_LAYERS]:
                if not isinstance(r, (list, tuple)) or len(r) != 2:
                    raise ValueError(f"{g}Recovery.{ax}: every recovery layer needs 2 values (damping, speed)")
                clean.append([_num(x) for x in r])
            out[g + "Recovery"][ax] = {"layers": clean, "delay": _num(a.get("delay") if isinstance(a, dict) else 0)}
    return out


def to_raw(canon: dict) -> dict:
    """Canonical -> the exporter's JSON form (recovery layers keyed "#1", "#2"...)."""
    raw = {}
    for g in GROUPS:
        raw[g] = {ax: [list(r) for r in canon[g][ax]] or {"__empty": True} for ax in AXES}
        rec = {}
        for ax in AXES:
            a = canon[g + "Recovery"][ax]
            d = {f"#{i + 1}": list(r) for i, r in enumerate(a["layers"])}
            d["delay"] = a["delay"]
            rec[ax] = d
        raw[g + "Recovery"] = rec
    return raw


def _fmt(v):
    s = f"{v:.4f}".rstrip("0").rstrip(".")
    return "0" if s in ("-0", "") else s


def to_lua(canon: dict) -> str:
    """The game's recoil export text (PageWeaponEditorRecoilExport), which its
    weapon editor reads back in."""
    parts = ["-- Argument order:\tDamping, Speed, Mean, Variance", "gunData.recoil = {}"]
    order = ("hipTranslation", "aimTranslation", "hipRotation", "aimRotation",
             "hipCameraBody", "aimCameraBody", "hipCameraHead", "aimCameraHead")
    for i, g in enumerate(order):
        lines = [f'gunData.recoil["{g}"] = {{']
        for ax in AXES:
            lines.append(f'\t["{ax}"] = {{' + ", ".join("{" + ", ".join(_fmt(x) for x in r) + "}" for r in canon[g][ax]) + "};")
        lines.append("}")
        lines.append(f'gunData.recoil["{g}Recovery"] = {{')
        for ax in AXES:
            a = canon[g + "Recovery"][ax]
            body = ", ".join("{" + ", ".join(_fmt(x) for x in r) + "}" for r in a["layers"])
            lines.append(f'\t["{ax}"] = {{{body}{"; " if body else ""}delay = {_fmt(a["delay"])}}};')
        lines.append("}")
        parts.append(("\n" if i else "") + "\n".join(lines))
    return "\n".join(parts) + "\n"


_ASSIGN = re.compile(r'gunData\.recoil\s*\[\s*["\'](\w+)["\']\s*\]\s*=\s*\{')
_AXIS = re.compile(r'\[\s*["\']([xyz])["\']\s*\]\s*=\s*\{')
_NUM = r'[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?'


def _block(text, start):
    """Text of the {...} block whose opening brace is at text[start-1]."""
    depth, i = 1, start
    while i < len(text) and depth:
        if text[i] == "{":
            depth += 1
        elif text[i] == "}":
            depth -= 1
        i += 1
    if depth:
        raise ValueError("unbalanced braces")
    return text[start:i - 1], i


def from_lua(text: str) -> dict:
    """Read the game's recoil text (as written by to_lua or the game's editor)."""
    text = re.sub(r"--[^\n]*", "", text)
    found = {}
    for m in _ASSIGN.finditer(text):
        body, _ = _block(text, m.end())
        axes = {}
        for am in _AXIS.finditer(body):
            ab, _ = _block(body, am.end())
            layers = [[float(x) for x in re.findall(_NUM, lm)] for lm in re.findall(r"\{([^{}]*)\}", ab)]
            dm = re.search(r"delay\s*=\s*(" + _NUM + ")", ab)
            axes[am.group(1)] = (layers, float(dm.group(1)) if dm else None)
        found[m.group(1)] = axes
    if not found:
        raise ValueError('no gunData.recoil["..."] tables found')
    canon = {}
    for g in GROUPS:
        if g not in found:
            raise ValueError(f"{g} is missing")
        if g + "Recovery" not in found:
            raise ValueError(f"{g}Recovery is missing")
        canon[g] = {ax: found[g].get(ax, ([], None))[0] for ax in AXES}
        canon[g + "Recovery"] = {ax: {"layers": found[g + "Recovery"].get(ax, ([], None))[0],
                                      "delay": found[g + "Recovery"].get(ax, ([], None))[1] or 0.0} for ax in AXES}
    return sanitize(canon)
