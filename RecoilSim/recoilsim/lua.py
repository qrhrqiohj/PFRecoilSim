"""Helpers for working with Lua-style tables in Python.

The game data is exported from Luau, where arrays are 1-indexed and tables can
mix array and hash parts. To keep the attachment-modifier logic faithful to the
game, every Lua table is represented as a plain ``dict`` whose array part uses
integer keys starting at 1.

JSON encoding used by the exporter:
  * pure arrays             -> JSON lists
  * mixed / hash tables     -> JSON objects, integer keys written as "#<n>"
  * empty tables            -> {"__empty": true}
  * Vector3 / Vector2       -> {"__v3": [x, y, z]} / {"__v2": [x, y]}
  * Color3                  -> {"__c3": [r, g, b]}
  * functions / CFrames     -> markers that are ignored here
"""
from __future__ import annotations

import copy


class Vec(tuple):
    """Immutable small vector (Vector3 / Vector2) supporting scalar multiply."""

    def __mul__(self, other):
        if isinstance(other, (int, float)):
            return Vec(x * other for x in self)
        if isinstance(other, Vec):
            return Vec(a * b for a, b in zip(self, other))
        return NotImplemented

    __rmul__ = __mul__

    def __truediv__(self, other):
        if isinstance(other, (int, float)):
            return Vec(x / other for x in self)
        return NotImplemented

    def __add__(self, other):
        if isinstance(other, Vec):
            return Vec(a + b for a, b in zip(self, other))
        return NotImplemented


class CF(tuple):
    """Roblox CFrame as its 12 components (x, y, z, r00 .. r22)."""


def from_json(obj):
    """Convert exporter JSON into Lua-style dict tables."""
    if isinstance(obj, list):
        return {i + 1: from_json(v) for i, v in enumerate(obj)}
    if isinstance(obj, dict):
        if obj.get("__empty") and len(obj) == 1:
            return {}
        if "__v3" in obj and len(obj) == 1:
            return Vec(obj["__v3"])
        if "__v2" in obj and len(obj) == 1:
            return Vec(obj["__v2"])
        if "__cf" in obj and len(obj) == 1:
            return CF(obj["__cf"])
        if "__c3" in obj and len(obj) == 1:
            return Vec(obj["__c3"])
        if "__func" in obj and len(obj) == 1:
            return None
        out = {}
        for k, v in obj.items():
            if isinstance(k, str) and k.startswith("#"):
                try:
                    k = int(k[1:])
                except ValueError:
                    pass
            out[k] = from_json(v)
        return out
    if obj == "__nil":
        return None
    return obj


def to_plain(t):
    """Convert a Lua-style table back into natural Python lists/dicts."""
    if isinstance(t, dict):
        n = length(t)
        if n and n == len(t):
            return [to_plain(t[i]) for i in range(1, n + 1)]
        if not t:
            return []
        return {k: to_plain(v) for k, v in t.items()}
    if isinstance(t, CF):
        return {"__cf": list(t)}
    if isinstance(t, Vec):
        return list(t)
    return t


def length(t) -> int:
    """Lua ``#t`` (border of the array part)."""
    if not isinstance(t, dict):
        return 0
    n = 0
    while (n + 1) in t:
        n += 1
    return n


def pairs(t):
    """Iterate a table the way Luau generalized iteration does: array part first."""
    if not isinstance(t, dict):
        return
    n = length(t)
    for i in range(1, n + 1):
        yield i, t[i]
    rest = [k for k in t.keys() if not (isinstance(k, int) and 1 <= k <= n)]
    ints = sorted(k for k in rest if isinstance(k, (int, float)))
    others = [k for k in rest if not isinstance(k, (int, float))]
    for k in ints + others:
        yield k, t[k]


def values(t):
    return [v for _, v in pairs(t)]


def deep_copy(t):
    return copy.deepcopy(t)


def table_insert(t, pos, value):
    """Lua ``table.insert(t, pos, value)``."""
    n = length(t)
    pos = int(pos)
    if pos < 1:
        pos = 1
    if pos > n + 1:
        t[pos] = value
        return
    for i in range(n, pos - 1, -1):
        t[i + 1] = t[i]
    t[pos] = value


def table_append(t, value):
    t[length(t) + 1] = value


def table_remove(t, pos):
    n = length(t)
    pos = int(pos)
    if pos < 1 or pos > n:
        t.pop(pos, None)
        return
    for i in range(pos, n):
        t[i] = t[i + 1]
    del t[n]


def to_number(v):
    if isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        return v
    try:
        return float(v)
    except (TypeError, ValueError):
        return None
