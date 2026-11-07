# RecoilSim changelog — 7 November 2026 session

Everything changed in this session, in the order it was asked for. The times are
when each batch was copied to `Documents\RecoilSim` (UTC). Restart RecoilSim to
load server changes.

---

## Batch 1 — 13:21

### FPS input
- *Game FPS* on the range and in the Best setup finder is now a number box. It
  takes any value (e.g. 87.5), is clamped to 1–1000, and shows "fps" inside the
  box.

### Export table sorting
- Click a column header in the export preview to sort by it. Click again to
  reverse, and a third time to go back to the original order.
- Copying and saving keep the order shown.

### Useless export columns dropped
- *Best setups · your guns*:
  - The *List* column only appears when you export more than one list.
  - The *#* column only appears with more than one setup per gun.
- *Best setups · one gun* follows the same rules.

### Default exclusions hover
- A default exclusion that applies to several guns now lists those guns (by
  their in-game names) when you hover it. The server sends `gun_list` for this.

### Finder layout
- The **Equip** button sits right after the rank number, so you no longer have
  to scroll the wide table sideways to reach it.
- The Best setup finder has a **full-screen toggle**: a button next to Close,
  or press **F** while it's open. It's remembered between sessions.

### Exporter gun list
- *Best setups · every gun* became *Best setups · your guns*. It has a list of
  guns, all selected by default:
  - click a class to toggle the whole class;
  - *Pick guns* chooses single guns;
  - there's a search box.

### Unlock ranks and kills (new game data)
- `tools/compact_export.py` now also reads the unlock data from the Studio
  export:
  - each gun's `unlockrank`;
  - each attachment's `unlockkills`, plus per-gun overrides.
- That data is stored in `data/game_data.json.gz` under `"unlock"`, and the
  data file was rebuilt.
- `gamedata.py` gained `unlock_rank()`, `kill_req()` and `rank_key()`.
- **Guns are listed in unlock-rank order** within their class (as in the
  game's menu): in the gun picker, the export gun list, and every-gun export
  rows.
- **Attachments are listed in kills-to-unlock order** everywhere, with the
  kills shown.
- New **Unlock rank** column next to the gun name in every-gun exports.

### Import sheet
- New export kind, **Imported sheet**. *Import sheet…* opens a CSV, TSV or
  .xlsx file (exported from here, or any sheet with a header row) so you can
  sort, copy or save it again.
- New server endpoint `/api/import_sheet` (30 MB limit), backed by `read_sheet`
  in `export.py`.

### Tests
- Tests were updated for the new columns, rank ordering and `read_sheet`.

---

## Batch 2 — 13:37

- **FPS presets are back.** The ▾ arrow in every fps box opens a menu of
  common rates (30, 60, 75, 120, 144, 165, 240, 360); typing any value still
  works. The previous white triangle (a browser datalist) did nothing, so it was
  replaced.
- New **Description** tab next to *Pattern* and *Gun stats*. It shows the
  gun's in-game description with its class, unlock rank, ammo type and
  magazine (+ spare rounds).
- **Export gun selector is now a dropdown** with a tick per gun and per class.
  You can open a class to pick single guns. It redraws without losing its
  scroll position or the search box focus.
- **Shooting range gun picker:** fixed the brief black box when scrolling. The
  menu is now solid and on its own layer instead of blurring the live 3D view.
- **Attachment hover text** now gives the name plus the kills required
  ("Name — N kills", or "free"). This applies in the finder results and the
  per-attachment breakdown.
- **Enemy health** box (range and finder) now shows "hp" inside the box on the
  right, like the range and fps boxes.

---

## Batch 3 — 13:48

### Presets and box sizes
- **Range presets:** the range box got a ▾ dropdown of common ranges, like
  the fps box. The fps and range menus share one generic preset menu
  (`presetButton()` in `core.js`).
- The **range input** on the shooting range is now the same size as the other
  boxes.

### Export field order
- Row 1: *Guns*, *Lists*.
- Row 2: *Goal*, *One-shot guns*, *Counts as a one-shot*.

### Test / admin guns and attachments go last
- Admin and super-tester guns are ordered after the normal guns in their
  class, by their own rank.
- Admin and super-tester attachments are ordered after the normal ones in
  their slot, by kills.
- This applies everywhere: the gun picker, attachment pickers, the exporter,
  and the export rows.
- Under the hood:
  - the data rebuild now records which attachments are admin / super-tester
    only on each gun (`"unlock" → "test"`), and `data/game_data.json.gz` was
    rebuilt again;
  - `gamedata.py` gained `is_test_attachment()` and `is_test_weapon()`;
  - `rankLabel()` and `killLabel()` in `core.js` add "· test only" to these items.

### "Off aim" renamed
- Now **"Dist. from aim"** in the tiles, tables and tooltips, and **"Avg
  distance from aim (st)"** in exports.
- The tooltip explains it: the average distance of every bullet from where you
  aim, in studs; misses count too.

---

## Batch 4 — 13:52

- **Attachment description removed** from under the slots on the range. It
  now only shows when you hover a slot, together with the kills required.

---

## Batch 5 — 13:57

### Test-only attachments excluded by default
- Every admin / super-tester-only attachment on a normal gun is now excluded
  by default, e.g. the M107 and M249 bipods and the G36 family's Hensoldt Dual
  Optic.
- Test / admin guns keep theirs.
- The server now sends `default_exclude_map(gd)` instead of the fixed list.

### Same number of shots for every setup
- The finder fires the **bare gun's magazine** with every setup, for every
  goal except damage per mag and DPS (where magazine size really matters).
- This fixes the M107's Reduced Magazine "winning" on recoil only because its
  5-round pattern stopped before it climbed. It now scores the same as the
  stock 10 rounds and is dropped as doing nothing.
- A test covers this.

---

## Batch 6 — 13:59

- **Per-magazine numbers re-run with the real magazine.** Kills / mag,
  damage / mag, TTK, shots to kill and effective RPM in the finder results now
  come from a run of each setup's own magazine, whenever that differs from the
  shared shot count above. They no longer describe rounds the gun doesn't have.

---

## Batch 7 — 14:08

- Export: the *One-shot guns* option "Use the goal above" now reads **"Use
  the goal to the left"**.

---

## Batch 8 — 14:22

### Default exclusions
- **Removed** from the built-in list:
  - .22 LR (Uzi)
  - spring mod (La Rata)
  - rat shot (M107)
  - banana mag (AKM)
  - engravings (1911)
  - fun switch (Juan)
- **Added:** the **.17 Incinerator** (`.17 Wildcat` / `M107 .17 Wildcat`).
- If you had edited your exclusion list, entries taken off the built-in list
  are also removed from it, and new built-in ones are added.

### One-shot goal replaced by three First STK range goals
- The goals are **First STK range (torso)**, **(head)** and **(limb)**.
- Each ranks setups by the fewest shots to kill that part at the gun's best
  range, then by how much range that shot count holds over. Results read like
  "3-shot: 118.8", "1-shot: 80.0–250.0" or "2-shot: any range".
- Fewer shots always win. In the code, score = range − 10 000 × shots.
- One-shots work as before: pellet spread is counted and the chance threshold
  (50 / 80 / 95 %) applies. Multi-shot single-bullet results come from the
  damage curve, multipliers and the 2 s bullet lifetime.
- **The option hiding was removed.** All three goals are always in the list.
- **The automatic choice was kept:** guns that can one-shot get the First STK
  goal, other guns get *Closest to aim point*.
- Older saved settings using `oneshot` map to `stk_torso`.

### Finder results for First STK goals
- *vs #1* shows "+1 shot" when a setup needs more shots, otherwise the range
  difference in studs.
- In the "every attachment on its own" lists, the empty-slot line shows the
  range with "baseline · N-shot" under it. The long text used to cut off the
  "None" label.

### Export
- With a First STK goal, the goal column holds text such as "3-shot: 118.8".
  The *One-shot guns* option is hidden for these goals and reads "First STK
  (torso)" otherwise.
- The export column was renamed *First STK range* (it holds text, so no "(st)"
  unit).

### Tests
- New `test_first_stk` (AK-47 = 3-shot torso, 2-shot head; Sawed Off one-shots).
- The shotgun goal test uses `stk_torso`.

---

## Batch 9 — 14:29

### Export full screen
- The Export window has the same full-screen toggle as the finder: a button
  top right, or **F**. It's remembered.

### Pellets count where they land, for any number of shots
- One-shots already counted every pellet by the part it hits (head, torso,
  limb or miss).
- Pellet guns needing 2+ shots used to assume every pellet hit the aimed part.
  Now each shot is a fresh simulated pellet pattern and every pellet counts
  where it lands:
  - head pellets can lower the shot count;
  - misses can raise it.
- Example: the Sawed Off at 600 hp is "2-shot: 21.1" (torso).
- Under the hood: `one_shot_profile(..., shots=k)` was added in `analysis.py`.
  The optimizer searches the fewest shots that reach the chance threshold.

### Other changes in this batch
- **Limb aim point** confirmed as the centre of the legs (halfway down,
  between the two leg hitboxes). The goal description says so now.
- Fixed: the head goal's one-shot averages were being filed under "torso".
- New test: Sawed Off at 600 hp is a 2-shot to the torso.

---

## Batch 10 — 14:36

- **Limb goal for guns whose limbs take more damage.** When a gun can
  one-shot, the automatic goal aims at whichever of torso or limb takes more
  damage.
- The every-gun export does the same, and its First STK column says which part
  was used, e.g. "1-shot: 60.8 (limb)". This uses `one_shot_part()` in
  `analysis.py`.

---

## Batch 11 — this delivery

### The limb preference is now for single-bullet guns only
- **Pellet guns always use the torso goal**, since their pellets spread onto
  the limbs anyway.
- A pellet gun still counts as a one-shot gun when all its pellets on the
  torso *or* on the limbs would kill.
- **Origin 12** (8 × 14 damage; torso 0.7×; no limb multiplier set, so 1×):
  - 112 damage if every pellet lands on the limbs, 78 on the torso;
  - automatic goal: **First STK range (torso)**;
  - aimed at the torso it's a 2-shot out to about 89 st (80 % chance);
  - aimed at the limbs it one-shots from point blank to about 33 st (80 %)
    or 40 st (50 %);
  - aimed at the head it one-shots out to about 28 st.
- Applies in both the finder and the every-gun export. README and export help
  text updated.

### This changelog
- Added `CHANGELOG.md`.

---

## Batch 12 — corrections

- **Fixed: the Origin 12 auto-selected First STK range (torso)** even though
  it can't one-shot the torso. Batch 11 counted a pellet gun as a one-shot
  gun when all its pellets on the *limbs* would kill. Now a pellet gun only
  counts when every pellet on the torso kills. The Origin 12 (78 damage max to
  the torso) goes back to spread. Fixed in the finder and the every-gun export
  (`one_shot_part()`).
- **Search progress shows the current step's own count.** The old label
  showed a step like "Testing 243 combinations…" next to a counter of every
  setup simulated in all steps, so the counter ran past the step's number.
  It now reads e.g. "Testing 243 combinations of the strongest options
  (120 / 243) · 280 simulated in total". Setups already simulated in an
  earlier step count as done. The server sends `step_done` / `step_total`.

## Batch 13

- In the export, the *One-shot guns* option now reads **"First STK range"**
  instead of "First STK (torso)". The part depends on the gun: torso, or limb
  for single-bullet guns whose limbs take more damage. Each row shows the part
  used next to its range. The option's help text was updated to match.

## Batch 14

Sheet exporter:
- **On target (n st):** the *On target* column names the range it was
  simulated at. This applies to *Best setups · your guns*, *Best setups · one
  gun* and *Gun stats · every gun* (with simulated accuracy).
  - In *Simulation results*, the range goes in the header when every row
    shares it. Otherwise a *Range (st)* column is added; saved patterns now
    remember their range.
- **Handling vs bare gun for every gun.** It used to be only for one-shot
  guns. It's also in *Best setups · one gun*.
- **First STK range for every gun, using the finder's First STK logic.**
  - Torso and limb are both worked out. The column shows the one that needs
    fewer shots, or, with the same shots, reaches further. It names the shot
    count and part, e.g. "3-shot torso: 121.8" (AK-47), "3-shot limb: 77.7"
    (UMP45, whose limbs take more damage) or "1-shot torso: 100.0–300.0" (M107).
  - Rows already ranked by First STK reuse that result. Every other row gets an
    extra first-shot simulation per part (500 runs).
- **Average one-shot ranges only for setups that fire pellets** (shotguns or a
  buckshot conversion). Everything else shows N/a.
  - For a single bullet the average is the same edge as the First STK range,
    just measured on a coarser 2-stud grid (the Henry's 87.5 vs 87.9).
- **Missing values read "N/a"** in the preview, the copied table and the saved
  CSV / Excel, and sort last. Empty attachment slots stay blank.

## Batch 15

- Missing values now read **"N/A"** (was "N/a").
- The single First STK range column is now three fixed columns: **First STK
  range (head)**, **(torso)** and **(limb)**. Each holds the shot count and
  range for that part, e.g. "2-shot: 87.9". There's no more picking between
  parts.

## Batch 16

- The First STK range columns are now ordered **limb, torso, head**. The
  average one-shot columns next to them follow the same order.

## Batch 17

- New goal in *Best setups · your guns*: **First STK range (auto: limb or
  torso)**. Every gun is ranked by First STK range:
  - on the limbs if it's a single-bullet gun whose limbs take more damage than
    its torso;
  - otherwise on the torso (pellet guns always the torso).
  - The part is chosen from the bare gun. The goal column names it, e.g.
    "2-shot: 50.5 (limb)" for the UMP45 / PDX-45 and "3-shot: 130.2 (torso)"
    for the AK-47.
  - `stk_auto_part()` in `analysis.py`.

## Batch 18

- **Fixed the First STK tie order.** It used to be range → handling → recoil
  for every gun. Now:
  - **single-bullet guns that need several shots** go range → **recoil**
    (distance from aim) → **handling**;
  - one-shots and pellet guns keep range → handling → recoil.
  - The order is set per setup (pellet count and shot count) and applies to
    the finder, the every-gun export, and the step that removes attachments
    that do nothing.
  - Example: the AK-47's 3-shot torso list is now sorted by distance from aim
    (0.821, 0.821, 0.842, 0.842, 0.852…).
  - New test `test_stk_recoil_before_handling`. Finder, export help text and
    README updated.

## Batch 19

- **Goal pickers show each goal's description on hover.** The Goal list in
  *Best setups · your guns* and in the Best setup finder opens RecoilSim's own
  menu. Hovering a goal shows what it does underneath the list, and hovering
  the closed picker shows the chosen goal's description. Keyboard: Enter /
  Space / Alt+↓ open it, Esc closes it. (`HINT_SETS` and `.selmenu` in
  `core.js` / `style.css`.)
- **Best setup finder:** the goal description no longer sits as text under the
  goal. It's in the hover instead.
- Added a description for *First STK range (auto: limb or torso)*.

## Batch 20

- The First STK range (head) and (limb) goal descriptions now repeat the full
  explanation, like the torso one. Each also says when that goal is picked
  automatically:
  - torso: guns that can one-shot the torso;
  - limb: single-bullet one-shot guns whose limbs take more damage;
  - head: never.
  The logic was already the same for all three; only the text was shorter.
