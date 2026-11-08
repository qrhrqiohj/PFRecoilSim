"""Python port of the game's attachment stat-modifier pipeline.

Mirrors StatModifierUtils / StatModifierInterface.compileModifiers: modifier
groups are applied in a fixed order (setters, adders, inserters, removers,
relative multipliers, true multipliers, ...). Every rule here follows the game
so that compiled weapon stats match what the game computes for the same
attachments.
"""
from __future__ import annotations

import copy

from .lua import Vec, deep_copy, length, pairs, table_insert, table_remove, to_number

ALL = object()  # sentinel: "every key of this table"

MODIFIER_ORDER = (
    "setters",
    "adders",
    "tableInserters",
    "tableRemovers",
    "relativeMultipliers",
    "trueMultipliers",
    "tableRelativeMultipliers",
    "tableTrueMultipliers",
    "functionMods",
)


def _norm_key(k):
    if isinstance(k, float) and k.is_integer():
        return int(k)
    return k


def _resolve_neg(parent, v):
    if isinstance(v, (int, float)) and not isinstance(v, bool) and v < 0:
        return length(parent) + 1 + int(v)
    return _norm_key(v)


def _expand_element(parent, elem):
    if elem is ALL:
        return [k for k, _ in pairs(parent)]
    if isinstance(elem, dict):
        return [_resolve_neg(parent, v) for _, v in pairs(elem)]
    return [_resolve_neg(parent, elem)]


def _path_list(index_path):
    if isinstance(index_path, dict):
        return [v for _, v in pairs(index_path)]
    if isinstance(index_path, (list, tuple)):
        return list(index_path)
    return []


def _collect_targets(out, parent, path, i):
    last = i == len(path) - 1
    for key in _expand_element(parent, path[i]):
        if last:
            out.append((parent, key))
        else:
            child = parent.get(key) if isinstance(parent, dict) else None
            if isinstance(child, dict):
                _collect_targets(out, child, path, i + 1)


def _resolve_targets(data, path):
    out = []
    if path:
        _collect_targets(out, data, path, 0)
    return out


def _effective_path(entry):
    path = _path_list(entry.get("indexPath"))
    if entry.get("valueIndex") is None:
        return path
    path = list(path)
    if entry.get("indexList") is not None:
        path.append(entry["indexList"])
    else:
        path.append(ALL)
    path.append(entry["valueIndex"])
    return path


def _prio(e):
    return e.get("priority") or 0


def _abs_prio(e):
    return e.get("absolutePriority") or 0


def _clone(v):
    return copy.deepcopy(v) if isinstance(v, dict) else v


def _priority_ascending(entries):
    seq = list(pairs(entries))
    return sorted(seq, key=lambda kv: (_abs_prio(kv[1]), _prio(kv[1]), kv[0] if isinstance(kv[0], (int, float)) else 0))


def apply_setters(data, entries):
    winners = {}
    for seq, entry in pairs(entries):
        if not isinstance(entry, dict) or entry.get("value") == "__cf":
            continue
        for parent, key in _resolve_targets(data, _path_list(entry.get("indexPath"))):
            slot = (id(parent), key)
            cur = winners.get(slot)
            if cur is not None:
                cur_entry, cur_seq = cur[2], cur[3]
                if _abs_prio(entry) == _abs_prio(cur_entry):
                    if _prio(entry) == _prio(cur_entry):
                        better = cur_seq < seq
                    else:
                        better = _prio(cur_entry) < _prio(entry)
                else:
                    better = _abs_prio(cur_entry) < _abs_prio(entry)
                if not better:
                    continue
            winners[slot] = (parent, key, entry, seq)
    for parent, key, entry, _ in winners.values():
        value = entry.get("value")
        parent[key] = _clone(value)


def apply_adders(data, entries):
    sums = {}
    for _, entry in pairs(entries):
        if not isinstance(entry, dict):
            continue
        for parent, key in _resolve_targets(data, _path_list(entry.get("indexPath"))):
            slot = (id(parent), key)
            p, k, s = sums.get(slot, (parent, key, 0))
            sums[slot] = (p, k, s + (entry.get("value") or 0))
    for parent, key, s in sums.values():
        try:
            parent[key] = (parent.get(key) or 0) + s
        except TypeError:
            pass


def _gather_multiplier_groups(data, entries):
    groups = {}
    for _, entry in pairs(entries):
        if not isinstance(entry, dict):
            continue
        for parent, key in _resolve_targets(data, _effective_path(entry)):
            slot = (id(parent), key)
            if slot not in groups:
                groups[slot] = (parent, key, [])
            groups[slot][2].append(entry.get("value"))
    return groups.values()


def apply_true_multipliers(data, entries):
    for parent, key, vals in _gather_multiplier_groups(data, entries):
        n = 1.0
        for v in vals:
            if isinstance(v, (int, float)):
                n *= v
        base = parent.get(key) if isinstance(parent, dict) else None
        if base is None:
            continue
        if isinstance(base, dict):
            for i in range(1, length(base) + 1):
                if isinstance(base[i], (int, float)) and not isinstance(base[i], bool):
                    base[i] = base[i] * n
        elif isinstance(base, bool):
            continue
        elif isinstance(base, (int, float, Vec)):
            parent[key] = base * n


def apply_relative_multipliers(data, entries):
    for parent, key, vals in _gather_multiplier_groups(data, entries):
        pos, neg = 1.0, 1.0
        for v in vals:
            if not isinstance(v, (int, float)):
                continue
            if v > 0:
                pos += v
            else:
                neg += -v
        base = parent.get(key) if isinstance(parent, dict) else None
        if base is None or isinstance(base, (bool, dict)):
            continue  # the game's pcall fails on tables/booleans
        if isinstance(base, (int, float, Vec)):
            parent[key] = base * pos / neg


def _insert_one(tbl, entry, idx):
    value = _clone(entry.get("value"))
    num = to_number(idx)
    if num is not None:
        num = int(num)
        if num < 0:
            n = length(tbl) or 1
            num = n + 1 + num
        num = max(1, min(num, length(tbl) + 1))
        table_insert(tbl, num, value)
    else:
        tbl[idx] = value


def apply_inserters(data, entries):
    for _, entry in _priority_ascending(entries):
        if not isinstance(entry, dict):
            continue
        for parent, key in _resolve_targets(data, _path_list(entry.get("indexPath"))):
            tbl = parent.get(key)
            if not isinstance(tbl, dict):
                tbl = {}
                parent[key] = tbl
            if entry.get("overrideIndex") is not None:
                idxs = entry["overrideIndex"]
                idxs = [v for _, v in pairs(idxs)] if isinstance(idxs, dict) else [idxs]
                for idx in idxs:
                    tbl[_norm_key(idx)] = _clone(entry.get("value"))
            elif entry.get("insertIndex") is not None:
                idxs = entry["insertIndex"]
                idxs = [v for _, v in pairs(idxs)] if isinstance(idxs, dict) else [idxs]
                for idx in idxs:
                    _insert_one(tbl, entry, idx)


def apply_removers(data, entries):
    plans = {}
    for _, entry in pairs(entries):
        if not isinstance(entry, dict):
            continue
        for parent, key in _resolve_targets(data, _path_list(entry.get("indexPath"))):
            tbl = parent.get(key)
            if not isinstance(tbl, dict):
                continue
            plan = plans.setdefault(id(tbl), (tbl, [], []))
            if entry.get("removeIndex") is not None:
                idxs = entry["removeIndex"]
                idxs = [v for _, v in pairs(idxs)] if isinstance(idxs, dict) else [idxs]
                for idx in idxs:
                    num = to_number(idx)
                    if num is not None:
                        num = int(num)
                        if num < 0:
                            num = length(tbl) + 1 + num
                        plan[1].append(num)
                    else:
                        plan[2].append(idx)
    for tbl, arr, hashes in plans.values():
        last = None
        for idx in sorted(arr, reverse=True):
            if idx != last:
                last = idx
                table_remove(tbl, idx)
        for k in hashes:
            tbl.pop(k, None)


OPERATORS = {
    "setters": apply_setters,
    "adders": apply_adders,
    "tableInserters": apply_inserters,
    "tableRemovers": apply_removers,
    "relativeMultipliers": apply_relative_multipliers,
    "trueMultipliers": apply_true_multipliers,
    "tableRelativeMultipliers": apply_relative_multipliers,
    "tableTrueMultipliers": apply_true_multipliers,
    "functionMods": lambda data, entries: None,  # functions can't be exported
}


def compile_modifiers(base, modifiers):
    data = deep_copy(base)
    for mtype in MODIFIER_ORDER:
        entries = modifiers.get(mtype)
        if entries:
            OPERATORS[mtype](data, entries)
    return data
