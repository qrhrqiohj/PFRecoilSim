"""Spreadsheet export: tables for Google Sheets / Excel, and the batch jobs that
build tables for every gun (best setups, simulated accuracy).

A table ("sheet") is {"name", "columns": [{"name", "type", "d"}], "rows": [[...]]}
with column types text | int | num | pct (fractions, shown as %) | ms.
"""
from __future__ import annotations

import csv
import io
import math
import threading
import time
import uuid
import zipfile
from xml.sax.saxutils import escape

from .analysis import METRICS, STK_METRICS, one_shot_part, stk_auto_part
from .gamedata import SLOTS
from .optimizer import DEPTHS, Cancelled, OptimizeJob, _eval_task, default_excludes_for, evaluate
from .simulate import firemode_label, interpolate_damage


def col(name, type_="text", d=None):
    return {"name": name, "type": type_, "d": d}


# ----------------------------------------------------------------------------- file writers
def _clean_cell(v):
    if isinstance(v, float) and (math.isnan(v) or math.isinf(v)):
        return None
    return v


def to_csv(sheet) -> bytes:
    buf = io.StringIO()
    w = csv.writer(buf, lineterminator="\r\n")
    w.writerow([c["name"] for c in sheet["columns"]])
    for row in sheet["rows"]:
        out = []
        for c, v in zip(sheet["columns"], row):
            v = _clean_cell(v)
            if v is None:
                out.append("")
            elif c["type"] == "pct" and isinstance(v, (int, float)):
                out.append(f"{v * 100:.{c.get('d') if c.get('d') is not None else 1}f}%")
            elif isinstance(v, float) and c.get("d") is not None:
                out.append(f"{v:.{c['d']}f}")
            else:
                out.append(v)
        w.writerow(out)
    return ("﻿" + buf.getvalue()).encode("utf-8")  # BOM: Excel reads UTF-8 correctly


def _col_letter(i):
    s = ""
    i += 1
    while i:
        i, r = divmod(i - 1, 26)
        s = chr(65 + r) + s
    return s


def _sheet_name(name, used):
    bad = '[]:*?/\\'
    n = "".join("-" if ch in bad else ch for ch in (name or "Sheet"))[:31] or "Sheet"
    base, k = n, 2
    while n.lower() in used:
        suffix = f" ({k})"
        n = base[:31 - len(suffix)] + suffix
        k += 1
    used.add(n.lower())
    return n


def read_sheet(data: bytes, name: str = "sheet") -> dict:
    """Read a CSV / TSV or .xlsx (first sheet) back into {name, columns, rows}:
    the first row is the header; columns whose cells are all numbers become
    number columns, all "12.3%" cells percent columns."""
    import csv
    import re
    import xml.etree.ElementTree as ET
    base = re.sub(r"\.(csv|tsv|txt|xlsx)$", "", name, flags=re.I)
    grid = []
    if data[:2] == b"PK":
        ns = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
        with zipfile.ZipFile(io.BytesIO(data)) as z:
            shared = []
            if "xl/sharedStrings.xml" in z.namelist():
                for si in ET.fromstring(z.read("xl/sharedStrings.xml")).findall("m:si", ns):
                    shared.append("".join(t.text or "" for t in si.iter(f"{{{ns['m']}}}t")))
            sheets = sorted(n for n in z.namelist() if re.match(r"xl/worksheets/sheet\d+\.xml$", n))
            if not sheets:
                raise ValueError("no worksheet in the file")
            root = ET.fromstring(z.read(sheets[0]))

            def col_index(ref):
                letters = re.match(r"[A-Z]+", ref).group(0)
                n = 0
                for ch in letters:
                    n = n * 26 + ord(ch) - 64
                return n - 1
            for row in root.iter(f"{{{ns['m']}}}row"):
                cells = {}
                for c in row.findall("m:c", ns):
                    t = c.get("t")
                    if t == "inlineStr":
                        v = "".join(x.text or "" for x in c.iter(f"{{{ns['m']}}}t"))
                    else:
                        ve = c.find("m:v", ns)
                        v = ve.text if ve is not None else None
                        if v is not None and t == "s":
                            v = shared[int(v)]
                        elif v is not None and t == "b":
                            v = v == "1"
                        elif v is not None and t not in ("str", "e"):
                            f = float(v)
                            v = int(f) if f.is_integer() and "." not in v and "E" not in v.upper() else f
                    cells[col_index(c.get("r"))] = v
                if cells:
                    grid.append([cells.get(i) for i in range(max(cells) + 1)])
    else:
        text = data.decode("utf-8-sig", errors="replace")
        first = text.split("\n", 1)[0]
        delim = "\t" if first.count("\t") > first.count(",") else ("," if "," in first else ";")
        grid = [r for r in csv.reader(io.StringIO(text), delimiter=delim)]
    grid = [r for r in grid if any(v not in (None, "") for v in r)]
    if not grid:
        raise ValueError("the file is empty")
    header = [str(v) if v is not None else "" for v in grid[0]]
    width = max(len(header), max(len(r) for r in grid))
    header += [f"Column {i + 1}" for i in range(len(header), width)]
    rows = [list(r) + [None] * (width - len(r)) for r in grid[1:]]
    num = re.compile(r"^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$")
    cols = []
    for i, h in enumerate(header):
        vals = [r[i] for r in rows if r[i] not in (None, "")]
        texts = [str(v).strip() for v in vals]
        if vals and all(isinstance(v, (int, float)) and not isinstance(v, bool) or num.match(t) for v, t in zip(vals, texts)):
            dec = max((len(t.split(".")[1]) if "." in t and "e" not in t.lower() else 0) for t in texts)
            for r in rows:
                if r[i] not in (None, ""):
                    f = float(r[i])
                    r[i] = int(f) if dec == 0 and f.is_integer() else f
                else:
                    r[i] = None
            cols.append(col(h, "num" if dec else "int", min(dec, 6) if dec else None))
        elif vals and all(t.endswith("%") and num.match(t[:-1]) for t in texts):
            dec = max((len(t[:-1].split(".")[1]) if "." in t else 0) for t in texts)
            for r in rows:
                r[i] = float(str(r[i]).strip()[:-1]) / 100 if r[i] not in (None, "") else None
            cols.append(col(h, "pct", dec))
        else:
            for r in rows:
                if r[i] is None:
                    r[i] = ""
            cols.append(col(h))
    return {"name": base or "Imported sheet", "columns": cols, "rows": rows}


def to_xlsx(sheets) -> bytes:
    """Minimal but proper .xlsx: bold frozen header, filters, column widths and
    number formats (percent columns stay real numbers)."""
    fmts = {}  # format code -> style index

    def style_for(c):
        t, d = c["type"], c.get("d")
        if t == "pct":
            code = "0." + "0" * (d if d is not None else 1) + "%" if (d or 1) > 0 else "0%"
        elif t in ("num", "ms"):
            code = "0." + "0" * d if d else "0"
        elif t == "int":
            code = "0"
        else:
            return 0
        if code not in fmts:
            fmts[code] = len(fmts) + 2  # 0 = default, 1 = header
        return fmts[code]

    used = set()
    sheet_xml = []
    names = []
    for sh in sheets:
        cols = sh["columns"]
        styles = [style_for(c) for c in cols]
        widths = []
        for i, c in enumerate(cols):
            longest = len(str(c["name"]))
            for row in sh["rows"][:400]:
                v = row[i] if i < len(row) else None
                if v is None:
                    continue
                longest = max(longest, len(f"{v:.{c['d']}f}" if isinstance(v, float) and c.get("d") is not None else str(v)))
            widths.append(min(60, max(8, longest + 2)))
        rows_xml = []
        hdr = "".join(f'<c r="{_col_letter(i)}1" t="inlineStr" s="1"><is><t>{escape(str(c["name"]))}</t></is></c>'
                      for i, c in enumerate(cols))
        rows_xml.append(f'<row r="1">{hdr}</row>')
        for r, row in enumerate(sh["rows"], start=2):
            cells = []
            for i, c in enumerate(cols):
                v = _clean_cell(row[i] if i < len(row) else None)
                ref = f"{_col_letter(i)}{r}"
                if v is None or v == "":
                    continue
                if isinstance(v, bool):
                    cells.append(f'<c r="{ref}" t="b"><v>{int(v)}</v></c>')
                elif isinstance(v, (int, float)):
                    cells.append(f'<c r="{ref}" s="{styles[i]}"><v>{repr(float(v)) if isinstance(v, float) else v}</v></c>')
                else:
                    cells.append(f'<c r="{ref}" t="inlineStr"><is><t xml:space="preserve">{escape(str(v))}</t></is></c>')
            rows_xml.append(f'<row r="{r}">{"".join(cells)}</row>')
        last = f"{_col_letter(max(len(cols) - 1, 0))}{max(len(sh['rows']) + 1, 1)}"
        cols_xml = "".join(f'<col min="{i + 1}" max="{i + 1}" width="{w}" customWidth="1"/>' for i, w in enumerate(widths))
        sheet_xml.append(
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
            '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>'
            f'<cols>{cols_xml}</cols><sheetData>{"".join(rows_xml)}</sheetData>'
            f'<autoFilter ref="A1:{last}"/></worksheet>')
        names.append(_sheet_name(sh.get("name"), used))

    num_fmts = "".join(f'<numFmt numFmtId="{164 + i}" formatCode="{escape(code)}"/>' for i, code in enumerate(fmts))
    xfs = '<xf numFmtId="0" fontId="0" fillId="0" borderId="0"/>' \
          '<xf numFmtId="0" fontId="1" fillId="2" borderId="0" applyFont="1" applyFill="1"/>' + \
          "".join(f'<xf numFmtId="{164 + i}" fontId="0" fillId="0" borderId="0" applyNumberFormat="1"/>' for i in range(len(fmts)))
    styles_xml = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
        f'<numFmts count="{len(fmts)}">{num_fmts}</numFmts>'
        '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>'
        '<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>'
        '<fill><patternFill patternType="solid"><fgColor rgb="FFF2F2F2"/><bgColor indexed="64"/></patternFill></fill></fills>'
        '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'
        '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
        f'<cellXfs count="{2 + len(fmts)}">{xfs}</cellXfs>'
        '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>')
    wb = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
          '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
          'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>'
          + "".join(f'<sheet name="{escape(n, {chr(34): "&quot;"})}" sheetId="{i + 1}" r:id="rId{i + 1}"/>' for i, n in enumerate(names))
          + "</sheets>"
          + "".join(f'<definedNames><definedName name="_xlnm._FilterDatabase" localSheetId="{i}" hidden="1">'
                    f"'{escape(n)}'!$A$1:${_col_letter(max(len(sheets[i]['columns']) - 1, 0))}${len(sheets[i]['rows']) + 1}"
                    "</definedName></definedNames>" for i, n in enumerate(names[:1]))
          + "</workbook>")
    rels = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            + "".join(f'<Relationship Id="rId{i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet{i + 1}.xml"/>' for i in range(len(names)))
            + f'<Relationship Id="rId{len(names) + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
            '</Relationships>')
    ctypes = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
              '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
              '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
              '<Default Extension="xml" ContentType="application/xml"/>'
              '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
              '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
              + "".join(f'<Override PartName="/xl/worksheets/sheet{i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' for i in range(len(names)))
              + "</Types>")
    root_rels = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                 '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
                 '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
                 '</Relationships>')
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", ctypes)
        z.writestr("_rels/.rels", root_rels)
        z.writestr("xl/workbook.xml", wb)
        z.writestr("xl/_rels/workbook.xml.rels", rels)
        z.writestr("xl/styles.xml", styles_xml)
        for i, x in enumerate(sheet_xml):
            z.writestr(f"xl/worksheets/sheet{i + 1}.xml", x)
    return out.getvalue()


# ----------------------------------------------------------------------------- helpers
def pick_firemode(labels, pref):
    """Fire mode for a gun in an every-gun table: 'default' = the gun's first
    mode, otherwise the first mode of the preferred kind (falls back to first)."""
    if not labels:
        return None
    if pref in (None, "", "default"):
        return labels[0]
    want = {"auto": ("AUTO", "SWITCH"), "semi": ("SEMI", "SINGLE", "DOUBLE", "BINARY"), "burst": ("BURST",)}.get(pref, ())
    for lab in labels:
        if lab.startswith(want):
            return lab
    return labels[0]


def gun_labels(gd, weapon, attachments=None):
    s = gd.compile(weapon, attachments or {}).stats
    fms = s.get("firemodes") or [True]
    if not isinstance(fms, list):
        fms = [fms]
    return [firemode_label(f) for f in fms]


def nice_class(cls):
    """'ASSAULT RIFLE' -> 'Assault Rifle', keeping acronyms ('LMG', 'PDW', 'DMR')."""
    return " ".join(w if len(w) <= 3 and w.isalpha() and w not in ("GUN",) else w.capitalize() for w in str(cls).split())


def weapons_in(gd, classes):
    """[(class label, weapon name, display name)] for the chosen classes (all when
    empty), each class in unlock-rank order like the game's menu."""
    cat = gd.catalog()
    out = []
    for cls, lst in cat.items():
        if classes is not None and cls not in classes:
            continue
        out.extend((nice_class(cls), w["name"], w["displayname"]) for w in lst)
    return out


def rank_text(r):
    """Unlock rank for a sheet cell (guns not unlocked by rank show a dash)."""
    return "–" if r is None else r


def _first(v):
    if isinstance(v, (list, tuple)):
        return v[0] if v else None
    return v


def _stk(health, dmg):
    return math.ceil(health / dmg - 1e-9) if dmg and dmg > 0 else None


STAT_GROUPS = ("basics", "firing", "damage", "ranges", "stk", "ballistics", "handling")


def gun_stats_sheet(gd, classes=None, distances=(0, 50, 100, 200), health=100.0, groups=STAT_GROUPS):
    groups = set(groups or STAT_GROUPS)
    distances = [float(d) for d in distances]
    cols = [col("Class"), col("Unlock rank", "int"), col("Gun")]
    if "basics" in groups:
        cols += [col("Fire modes"), col("Fire rate (rpm)", "num", 0), col("Magazine", "int"), col("Reserve", "int")]
    if "firing" in groups:
        cols += [col("Aimed fire rate (rpm)", "num", 0), col("Burst rate (rpm)", "num", 0), col("Fire cap (rpm)", "num", 0), col("Pellets", "int")]
    if "damage" in groups:
        cols += [col("Max damage", "num", 2), col("Max damage until (st)", "num", 1), col("Min damage", "num", 2),
                 col("Min damage from (st)", "num", 1), col("Head ×", "num", 2), col("Torso ×", "num", 2), col("Limb ×", "num", 2)]
    if "ranges" in groups:
        cols += [col(f"Damage @ {d:g} st", "num", 2) for d in distances]
    if "stk" in groups:
        for d in distances:
            cols += [col(f"STK head @ {d:g}", "int"), col(f"STK torso @ {d:g}", "int"), col(f"STK limb @ {d:g}", "int")]
    if "ballistics" in groups:
        cols += [col("Bullet speed (st/s)", "num", 0), col("Penetration (st)", "num", 2)]
    if "handling" in groups:
        cols += [col("Aim speed", "num", 2), col("Walk speed", "num", 2), col("Sprint speed", "num", 2), col("Equip speed", "num", 2), col("Zoom", "num", 2)]
    rows = []
    for cls, name, disp in weapons_in(gd, classes):
        s = gd.compile(name, {}).stats
        g = s.get("damageGraph") or []
        pellets = int(s.get("pelletcount") or 1)
        mh, mt, ml = s.get("multhead") or 1, s.get("multtorso") or 1, s.get("multlimb") or 1
        row = [cls, rank_text(gd.unlock_rank(name)), disp]
        if "basics" in groups:
            fr = s.get("firerate")
            row += [" / ".join(gun_labels(gd, name)), _first(fr), s.get("magsize"), s.get("sparerounds")]
        if "firing" in groups:
            row += [s.get("aimedfirerate"), s.get("burstfirerate"), s.get("firecap"), pellets]
        if "damage" in groups:
            row += [g[0]["damage"] if g else None, g[0]["distance"] if g else None,
                    g[-1]["damage"] if g else None, g[-1]["distance"] if g else None, mh, mt, ml]
        if "ranges" in groups:
            row += [interpolate_damage(g, d) if g else None for d in distances]
        if "stk" in groups:
            for d in distances:
                base = (interpolate_damage(g, d) if g else 0) * pellets
                row += [_stk(health, base * mh), _stk(health, base * mt), _stk(health, base * ml)]
        if "ballistics" in groups:
            row += [s.get("bulletspeed"), s.get("penetrationdepth")]
        if "handling" in groups:
            row += [s.get("aimspeed"), s.get("walkspeed"), s.get("sprintspeed"), s.get("equipspeed"), s.get("zoom")]
        rows.append(row)
    return {"name": "Gun stats", "columns": cols, "rows": rows}


SIM_COLS = [col("Fire mode used"), col("On target", "pct", 1), col("Headshots", "pct", 1), col("Avg distance from aim (st)", "num", 3),
            col("Climb (st)", "num", 4), col("Spread (st)", "num", 4), col("Avg TTK (ms)", "num", 0), col("Kills / mag", "pct", 0),
            col("Damage / mag", "num", 0)]


def _sim_values(label, summ, parts):
    ttk = summ.get("ttk_mean")
    return [label, summ.get("hit_rate"), summ.get("head_rate"), summ.get("aim_error"), parts.get("climb"), parts.get("spread"),
            ttk * 1000 if ttk is not None else None, summ.get("kill_rate"), summ.get("avg_mag_damage")]


LIST_LABEL = {"spread": "Lowest spread", "climb": "Lowest climb", "combined": "Best overall"}


def metric_col(metric):
    m = METRICS.get(metric, {"label": metric})
    if metric == "ttk":
        return col("Goal: avg TTK (ms)", "num", 2), (lambda v: v * 1000 if v is not None else None)
    if metric in ("hits", "headshots"):
        return col(f"Goal: {m['label'].lower()}", "pct", 2), (lambda v: v)
    if metric == "accuracy":
        return col("Goal: avg distance from aim (st)", "num", 4), (lambda v: v)
    if metric == "stk_auto":
        return col("Goal: first stk range (auto: limb or torso)"), (lambda v: v)
    if metric in STK_METRICS:
        # shown as "1-shot: 0–95.7" (the score itself mixes shots and studs)
        return col(f"Goal: {m['label'].lower()}"), (lambda v: v)
    return col(f"Goal: {m['label'].lower()}", "num", 2), (lambda v: v)


# ----------------------------------------------------------------------------- batch jobs
class BatchJob:
    """Builds an every-gun table in the background (cancellable, with partial
    results so far available at any time)."""

    def __init__(self, gd, req, pool=None):
        self.id = uuid.uuid4().hex[:12]
        self.gd = gd
        self.req = req
        self.pool = pool
        self.mode = req.get("kind", "best")  # "best" setups or simulated "stats" (self.kind is the job-manager slot)
        self.started = time.time()
        self.done = False
        self.error = None
        self.cancelled = False
        self.result = None
        self.rows = []
        self.index = 0
        self.total = 0
        self.stage = "starting"
        self.current = None
        self._done_evals = 0
        self._thread = threading.Thread(target=self._run, daemon=True)
        self.columns = []

    def start(self):
        self._thread.start()
        return self

    def cancel(self):
        self.cancelled = True
        cur = self.current
        if cur is not None:
            cur.cancel()

    @property
    def progress(self):
        if self.done:
            return 1.0
        sub = self.current.progress if self.current is not None else 0.0
        return min(1.0, (self.index + sub) / max(self.total, 1))

    def status(self, with_table=False):
        st = {"id": self.id, "progress": round(self.progress, 4), "stage": self.stage, "done": self.done,
              "error": self.error, "elapsed": round(time.time() - self.started, 1), "guns_done": self.index,
              "guns_total": self.total, "rows": len(self.rows),
              "evaluated": self._done_evals + (self.current.evaluated if self.current is not None else 0)}
        if with_table or self.done:
            st["table"] = self.table()
        return st

    def table(self):
        name = "Best setups" if self.mode == "best" else "Gun accuracy"
        return {"name": name, "columns": self.columns, "rows": list(self.rows)}

    def _locks_for(self, weapon):
        """Slots locked for every gun: {slot: attachment name or "" for empty}.
        A lock only applies to guns that can use that attachment; other guns
        search the slot as usual."""
        out = {}
        opts = self.gd.attachment_options(weapon)
        for slot, name in (self.req.get("locks") or {}).items():
            if name == "" or any(o["name"] == name for o in opts.get(slot, [])):
                out[slot] = name
        return out

    def _settings_for(self, weapon):
        s = dict(self.req.get("settings") or {})
        labels = gun_labels(self.gd, weapon)
        lab = pick_firemode(labels, self.req.get("firemode_pref"))
        s["firemode_label"] = lab
        s["firemode_index"] = labels.index(lab) if lab in labels else 0
        return s, lab

    def _run(self):
        try:
            guns = weapons_in(self.gd, self.req.get("classes"))
            only = self.req.get("weapons")
            if only:
                guns = [g for g in guns if g[1] in set(only)]
            self.total = len(guns)
            if self.mode == "best":
                self._run_best(guns)
            else:
                self._run_stats(guns)
            self.stage = "Done" if not self.cancelled else "Stopped"
            if self.cancelled:
                self.error = "cancelled"
        except Cancelled:
            self.stage = "Stopped"
            self.error = "cancelled"
        except Exception as e:  # surfaced to the UI
            import traceback
            traceback.print_exc()
            self.error = f"{type(e).__name__}: {e}"
        finally:
            self.current = None
            self.done = True

    # -------------------------------------------------------------- best setups
    def _run_best(self, guns):
        metric = self.req.get("metric", "accuracy")
        metric = "stk_torso" if metric == "oneshot" else metric  # older saved settings
        lists = [l for l in (self.req.get("lists") or ["spread", "climb", "combined"]) if l in LIST_LABEL]
        per_gun = int(self.req.get("per_gun", 1))  # 0 or less = every setup the search lists
        per_gun = per_gun if per_gun > 0 else None
        depth = DEPTHS.get(self.req.get("depth", "quick"), DEPTHS["quick"])
        mcol, mval = metric_col(metric)
        aim_col = metric != "accuracy"  # the goal column already is the average distance from the aim point
        # guns that can one-shot the torso (shotguns included) are ranked by how far
        # they one-shot, then handling, then recoil, unless turned off
        health = float((self.req.get("settings") or {}).get("health", 100))
        # "stk_auto": every gun ranked by First STK range on the limbs or the torso
        # (the limbs for single-bullet guns whose limbs take more damage)
        stk_goal = metric in STK_METRICS or metric == "stk_auto"
        shot_mode = self.req.get("shotguns", "oneshot") == "oneshot" and not stk_goal
        shotgun = {name: one_shot_part(self.gd.compile(name, {}).stats, health) for cls, name, _d in guns} if shot_mode else {}
        dist = float((self.req.get("settings") or {}).get("distance", 50))
        # the goal value of a shotgun row (its search was ranked by one-shot range)
        from_summary = {"accuracy": "aim_error", "ttk": "ttk_mean", "hits": "hit_rate", "headshots": "head_rate",
                        "damage": "avg_mag_damage"}.get(metric)
        # "List" only when several lists are exported, "#" only when several setups per gun
        show_list, show_pos = len(lists) > 1, per_gun != 1
        self.columns = [col("Class"), col("Unlock rank", "int"), col("Gun")] + ([col("List")] if show_list else []) + \
                       ([col("#", "int")] if show_pos else []) + [col(s) for s in SLOTS] + \
                       [col("Spread (st)", "num", 4), col("Climb (st)", "num", 4), mcol] + \
                       [col("First STK range (limb)"), col("First STK range (torso)"), col("First STK range (head)"),
                        col("Handling vs bare gun", "pct", 1),
                        col("Avg 1-shot limb (st)"), col("Avg 1-shot torso (st)"), col("Avg 1-shot head (st)")] + \
                       ([col("Avg distance from aim (st)", "num", 3)] if aim_col else []) + \
                       [col("Avg TTK (ms)", "num", 0), col(f"On target ({dist:g} st)", "pct", 1), col("Headshots", "pct", 1),
                        col("Kills / mag", "pct", 0), col("Fire mode")]
        for i, (cls, name, disp) in enumerate(guns):
            if self.cancelled:
                break
            self.index = i
            settings, lab = self._settings_for(name)
            gun_metric = (f"stk_{stk_auto_part(self.gd.compile(name, {}).stats)}" if metric == "stk_auto"
                          else f"stk_{shotgun[name]}" if shotgun.get(name) else metric)
            req = {"weapon": name, "metric": gun_metric, "settings": settings, "locked": self._locks_for(name),
                   "exclude": default_excludes_for(self.gd, name, self.req.get("exclude_tokens")),
                   "lists": lists, "top_n": max(per_gun, 3) if per_gun else 0, **depth}
            job = OptimizeJob(self.gd, req, pool=self.pool)
            self.current = job
            self.stage = f"{disp} ({i + 1}/{len(guns)})"
            try:
                job._optimize()
            except Cancelled:
                break
            except Exception as e:
                if self.cancelled:
                    break
                lead = [cls, rank_text(self.gd.unlock_rank(name)), disp] + (["error"] if show_list else []) + ([None] if show_pos else [])
                self.rows.append(lead + [None] * (len(self.columns) - len(lead) - 1) + [f"{type(e).__name__}: {e}"])
                continue
            finally:
                self._done_evals += job.evaluated
                self.current = None
            names = {s: {o["name"]: o["displayname"] for o in opts} for s, opts in self.gd.attachment_options(name).items()}
            r = job.result
            for lst in lists:
                for rank, e in enumerate((r["lists"].get(lst) or [])[:per_gun], start=1):
                    summ = e.get("summary") or {}
                    ttk = summ.get("ttk_mean")
                    # attachments such as conversion kits can remove the requested mode
                    used = lab if lab in gun_labels(self.gd, name, e["attachments"]) else gun_labels(self.gd, name, e["attachments"])[0]
                    stk_texts, avgs = self._first_stk(name, e, settings, gun_metric)
                    self.rows.append([cls, rank_text(self.gd.unlock_rank(name)), disp] + ([LIST_LABEL[lst]] if show_list else [])
                                     + ([rank] if show_pos else [])
                                     + [names.get(s, {}).get(e["attachments"].get(s), e["attachments"].get(s)) or "" for s in SLOTS]
                                     + [e.get("spread"), e.get("climb"),
                                        ((f'{summ["oneshot_band"]} ({gun_metric[4:]})' if metric == "stk_auto" else summ["oneshot_band"])
                                         if summ.get("oneshot_band") and summ["oneshot_band"] != "–" else None) if stk_goal else
                                        mval(e.get("score")) if gun_metric == metric else
                                        (mval(summ.get(from_summary)) if from_summary and summ.get(from_summary) is not None else None)]
                                     + [*stk_texts, e.get("handling"), *avgs]
                                     + ([summ.get("aim_error")] if aim_col else [])
                                     + [ttk * 1000 if ttk is not None else None, summ.get("hit_rate"), summ.get("head_rate"),
                                        summ.get("kill_rate"), used])
        self.index = len(guns) if not self.cancelled else self.index

    STK_RUNS = 500

    def _first_stk(self, name, e, settings, gun_metric):
        """First STK range of an exported setup for the head, torso and limbs, the
        finder's way (limb, torso, head): the fewest shots to kill that part and the range it holds
        over ("2-shot: 87.9"). A row ranked by a First STK goal reuses that part's
        result. Also the average one-shot ranges (head, torso, limb), only for
        setups that fire pellets (None otherwise)."""
        atts = e["attachments"]
        summ = e.get("summary") or {}
        # the first shot only: the one-shot / STK range doesn't need the rest of the mag
        st1 = {**settings, "shots": 1}
        texts, avg = [], None
        for part in ("limb", "torso", "head"):
            m = f"stk_{part}"
            if gun_metric == m and summ.get("oneshot_band"):
                ps = summ
            else:
                ps = evaluate(self.gd, name, atts, st1, m, self.STK_RUNS, 4242, want_summary=True)[3] or {}
            band = ps.get("oneshot_band")
            texts.append(band if band and band != "–" else None)
            if part == "torso":
                avg = ps.get("oneshot_avg") or {}
        pellets = int(self.gd.compile(name, atts).stats.get("pelletcount") or 1)
        avgs = [((avg.get(p) or {}).get("text") if pellets > 1 else None) for p in ("limb", "torso", "head")]
        return texts, avgs

    # -------------------------------------------------------------- simulated accuracy per gun
    def _run_stats(self, guns):
        runs = max(20, min(int(self.req.get("runs", 300)), 5000))
        base = gun_stats_sheet(self.gd, self.req.get("classes"), self.req.get("distances") or (0, 50, 100, 200),
                               float((self.req.get("settings") or {}).get("health", 100)), self.req.get("groups"))
        by_name = {(r[0], r[2]): r for r in base["rows"]}
        dist = float((self.req.get("settings") or {}).get("distance", 50))
        self.columns = base["columns"] + [dict(c, name=f"On target ({dist:g} st)") if c["name"] == "On target" else c for c in SIM_COLS]
        self.stage = "Simulating every gun"
        tasks = []
        for cls, name, disp in guns:
            settings, lab = self._settings_for(name)
            tasks.append((cls, name, disp, lab, (name, {}, settings, "accuracy", runs, 777, True)))
        if self.pool is not None:
            futs = [self.pool.submit(_eval_task, t[4]) for t in tasks]
        for i, t in enumerate(tasks):
            if self.cancelled:
                if self.pool is not None:
                    for f in futs:
                        f.cancel()
                break
            cls, name, disp, lab, args = t
            self.stage = f"Simulating {disp} ({i + 1}/{len(tasks)})"
            try:
                if self.pool is not None:
                    while True:
                        if self.cancelled:
                            raise Cancelled()
                        try:
                            res = futs[i].result(timeout=0.25)
                            break
                        except Exception as e:
                            if type(e).__name__ == "TimeoutError":
                                continue
                            raise
                else:
                    res = evaluate(self.gd, *args)
                _score, _err, _md, summ, _runs, parts = res
                vals = _sim_values(lab, summ, parts)
            except Cancelled:
                for f in futs:
                    f.cancel()
                break
            except Exception as e:
                vals = [f"error: {type(e).__name__}"] + [None] * (len(SIM_COLS) - 1)
            self.rows.append(list(by_name.get((cls, disp), [cls, rank_text(self.gd.unlock_rank(name)), disp])) + vals)
            self.index = i + 1
            self._done_evals += 1
