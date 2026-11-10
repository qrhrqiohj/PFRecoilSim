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

## Batch 21

- **Recoil-before-handling now applies to every setup that needs more than
  one shot, pellets included.** Batch 18 only swapped the order for
  single-bullet setups, so pellet conversions that don't one-shot still went
  handling first. Examples: the TAR-21 with TAR Duplex Ammo (3-shot torso) and
  the Skorpion with SKORP Rat Shot (2-shot torso).
  - Now any setup that needs 2+ shots ranks range → recoil → handling.
  - One-shots keep range → handling → recoil.
  - Goal descriptions, export help text and README updated.

---

# 9 November 2026

## Batch 22 — feedback round

### Search ranking
- **Fixed: First STK goals ignored small recoil gains.** Recoil only broke ties
  when it differed by 0.001 studs of distance from aim. At 100 % recoil control
  a Full Stock only takes about 0.0005 off, so it counted as a tie and the
  handling tie-break picked a laser instead. The Type 88 chose the Yellow
  Laser for this reason. The threshold is now 0.0001 studs, the same as the
  accuracy goal. The Type 88 now picks Full Stock (and DCL 120 is no longer
  dropped for the same reason).
- **Fixed: attachments that only change handling were treated as "no
  attachment".** The red Laser (+20 % sprint and sprint-to-aim speed) and the
  Blue Laser (+7 % aim speed) were grouped with an empty slot and never tried.
  Whenever handling breaks ties, they are now searched as their own options.
  The finder's slot cards also count them as options.
- **New: tie-breakers you can order yourself.** In the finder's Search section
  and in *Best setups · your guns*, choose *Default* (the built-in order) or
  *Custom*.
  - Custom: tick any of less recoil, better handling, more damage / mag, less
    climb and less spread, and move them up or down.
  - Fewer attachments always comes last.
  - With a custom order, an attachment stays in a setup only if it helps the
    goal or a ticked tie-breaker. For example, *Closest to aim point* with
    handling ticked adds handling-only attachments on top.
  - The finder and the export share the setting, and it's kept across
    restarts.
  - Server side: `tiebreak` in the search request, `TIEBREAKS` /
    `default_tiebreak()` in `optimizer.py`. Every evaluation now records
    distance from aim and damage per mag.

### Simulation accuracy
- **Bullets now leave the barrel (hip) or the sight part (aimed)**, as in the
  game's `FirearmObject.fire`, using the gun model.
  - Recoil turns the gun about its pivot in front of the camera (`mainoffset`),
    not about the camera.
  - Hip-fire shots land a fixed offset from the crosshair at every range (AK-47:
    0.75 st right, 0.71 st low). Recoil control doesn't remove that offset.
  - Aimed shots change by well under 0.01 st.
  - `models.fire_pose()`, `GameData.use_models()`, `WeaponConfig.pose`; search
    workers load the models too.
  - README limits updated. New test `test_fire_point`.
- Fixed the `RuntimeWarning: Mean of empty slice` spam (analysis.py) when no
  pellet of a shot reaches the target.

### Interface
- **Loading screen** on start-up. It shows what's loading and fades out once
  the 3D range has drawn the gun (it never stays longer than 20 s). The "pick
  up where you left off?" question comes after it.
- **Export keeps its settings.** Closing and reopening the export no longer
  resets the scenario to the range's values; only the first open copies them
  (*Copy from range* does it on demand). Every export option is also part of
  the session save, offered again on the next start.
- **Gun classes in the game's loadout order everywhere:**
  - primaries: assault rifle, battle rifle, carbine, shotgun, PDW, DMR, LMG,
    sniper rifle (the Assault / Scout / Support / Recon kits in turn);
  - then secondaries: pistols, machine pistols, revolvers, other.
  - The gun picker and the export gun list have *Primaries* / *Secondaries*
    headings.
- **Exclusions reworked.** There is one chip per attachment.
  - Click excludes it on every gun.
  - **Right-click** opens a list of the guns that can use it, to exclude it on
    some guns only. The chip turns orange and names the guns.
  - "Gun only" entries no longer clutter the list as separate chips.
  - Turning an attachment on for every gun replaces its gun-only entries.
  - This applies in the default-list editor and the export's own exclusions.
- New test `test_custom_tiebreak_keeps_handling_attachments`. README updated
  throughout.

## Batch 23 — recoil editor, designer, controller input, audit

### New
- **Recoil tab** (next to Gun stats): the gun's own recoil per stance (aimed /
  hip) and part.
  - The parts are camera, gun turn, gun move and view shake. Each lists every
    axis's spring layers (damping, speed, mean, variance) and the recovery
    springs with their delay.
  - Every number is editable; **+ layer** / **×** add or remove layers.
  - Edited guns use their recoil everywhere (range, pattern, finder, export —
    search workers included). Attachments still apply on top.
  - **Export**: the game's own recoil text format, taken from the game's weapon
    editor (`PageWeaponEditorRecoilExport`). Copy it or save it as .lua.
  - **Import** reads that format back. **Reset** returns to the game's values.
  - Edits are part of the session save.
  - Code: `recoil_edit.py`, `GameData.set_recoil_overrides()` /
    `base_recoil()`, `/api/recoil*`.
- **Recoil designer** (*Recoil → Design…*).
  - A zoomable dummy at a chosen range. Click the shots in order, as a line
    (shots spread evenly along it) or one point per shot. Drag to move a
    point, right-click to delete it.
  - Helpers: start from the gun's pattern, mirror, smooth.
  - Settings: detail (1–3 spring layers) and randomness. Works for aimed and
    hip fire.
  - *Make recoil* fits the camera springs: a least-squares fit of the kicks
    inside a multi-start search over damping and speed, through the real
    simulator. It shows the new average pattern and the average miss.
  - *Use it on this gun* writes the fit into the Recoil tab.
  - Code: `recoil_fit.py`, `/api/recoil/fit` and `/api/recoil/path`.
- **Input: mouse & keyboard / controller** on the range, in the finder and in
  the export.
  - On a pure controller the game halves the camera kicks
    (`FirearmObject.impulseSprings`); that is now simulated
    (`SimSettings.controller`).
- **Settings parity.** The finder and the export got the range's remaining
  settings: input, shots per mag (export: best setups) and click rate.

### Changed
- **Tie-breakers.** *Custom* now opens a compact drop-down list instead of
  growing the panel. The chosen order shows as one line next to it.
- **Exclusions.** Ticking every gun an attachment is on (for example the only
  gun it's on) now counts as excluding it everywhere, so the chip just turns
  red.
- **Default exclusions.**
  - Taken off: DCL 120, the Muffler and Oil Filter variants on 27 / 24 guns,
    and Suppressor..?.
  - Added: Chainsaw Grip.
  - Edited lists follow automatically.
- **Everything survives a relaunch.** "Load previous session" brings back:
  - the finder's results (last 6 guns searched), its scenario and its other
    settings;
  - finished or stopped every-gun export tables and an imported sheet (kept
    separately, as they can be large);
  - edited recoil;
  - the simulation that was on screen (it is run again).
  The finder's scenario now also keeps your values instead of re-copying the
  range's every time it opens (*Copy from range* still does that).

### Audit fixes
- The tie-breaker *Custom* button didn't open its list (the click handler
  read the button after re-rendering it).
- The recoil designer's search could be poisoned by spring settings that fling
  shots off the target (NaN paths). It now measures each layer with a small
  kick and skips invalid settings.
- Small layout fixes (finder labels, the export click-rate box).
- Tests added: recoil text round trip and override, designer fit, controller
  halving, the new default list. 40 tests, all passing.

## Batch 24

- **Fixed: the start-up screen showed as a giant logo instead of fading.** A
  stylesheet edit in Batch 23 had dropped its styles. They're back, and the
  overlay now also carries its essential layout inline, so it can't show
  unstyled again.
- **Recoil tab:**
  - New **Blank** button next to Reset. It sets every recoil value to 0
    (aimed and hip, every part, recovery included) and leaves one layer per
    axis, to build recoil from scratch. Reset brings the game's values back.
  - Renamed: Gun turn → **Rotational**, Gun move → **Translational**, View
    shake → **Head Camera**.

## Batch 25 — recoil designer rebuilt

- **Every shot is editable.** The pattern is now the whole magazine, one
  numbered dot per shot. *Move shots*: click any shot, drag it, nudge it with
  the arrow keys, type its exact x / y, step through shots with `[` / `]`.
- **Per-shot weight**: Free / Soft / Normal / Strong / Lock decides how tightly
  the fit has to hit each shot.
- **Three tools**: *Draw line* (shots spread along it), *Place shots* (one
  click per shot), *Move shots*. The line now always starts at shot 1, which
  fires before any recoil.
- **Shots after the line**: *Line covers* sets how many shots the line spans;
  the rest are *Free*, *Settle* around the last point, or *Keep going* in the
  line's direction — and each can still be moved by hand, so the end of the
  magazine is fully designable.
- **More layers**: Auto, or 1–16 per direction (was 1–3). Fits are much closer:
  in testing a zig-zag pattern fits to ~0.06 st average miss.
- **Editable result**: the fitted layers (damping, speed, kick, variance) are
  listed and editable, layers can be added or removed, and every shot's landing
  point redraws live. *Re-fit kicks* keeps your springs and solves the kicks.
- After a fit the canvas shows where every shot of the magazine lands, red
  miss lines, the average miss and the furthest-off shot (click to select it).
- *Spread* shows 150 simulated magazines with randomness; *Randomness* updates
  a finished fit straight away.
- *Undo / Redo* (Ctrl+Z / Ctrl+Y) for every pattern edit; keys L / P / M pick
  the tool.
- Server: new fitting engine (`recoil_fit.py`), `/api/recoil/path` (a recoil's
  path for any number of shots, optional spread), recoil layers allowed per
  axis raised to 16.
- Note: the game has no per-shot recoil, recovery or damping — every shot gets
  the same kick on each layer. Per-shot control is over where each shot should
  land; the layers are what you tune.
- Tests: designer fit with free shots and fixed-spring refit. 40 tests passing.

## Batch 26

- **Field of view** (Settings) now goes from 60° to 120°, default 80°. Saved
  settings that still had the old default move to 80; a value you set
  yourself is kept (clamped to the new range).
- **Fixed: "invalid literal for int() with base 10: 'auto'"** in the recoil
  designer. This came from RecoilSim still running the code from before the
  Batch 25 update (the page was new, the server was not). Restarting fixes it.
  To stop this catching you out again, the page now checks whether the server
  is older than its files and, if so, shows a banner asking you to restart.

## Batch 27 — recoil designer, round two

- **Fixed: designed recoil felt floaty and didn't snap back.** The game pairs
  every recoil layer with a recovery spring *by layer number*, and switches to
  it once no shot has come for the delay (0.1 s on almost every gun — so with
  most automatics it happens between shots, too). The old designer kept the
  gun's recovery list while replacing its layers: new layers got another
  layer's recovery spring, or none (they never recovered), and the fit was
  free to use slow, barely-damped springs. Now every designed layer has its own
  recovery spring, the fit models the switch exactly, and the *Game-like* feel
  only uses springs like the game's own guns (slow springs never bounce).
- **Snap back** (Camera tab): how soon after the last shot the view is back at
  the centre (default 0.6 s, or off), plus the recovery damping, speed and
  delay new layers start from.
- **Spread rings instead of exact coordinates**: each shot's ring says how
  widely it may land around its point (± left/right, ± up/down). Set rings on
  a few shots (or one size / a growing size for all); the ones between follow.
  Make recoil solves every layer's variance to match, adding randomness-only
  layers where needed. Drag the ring's handles or Shift+wheel to size it.
- **A line through the shots in every tool** (Place and Move too).
- **Gun & view tab**: Rotational, Translational, Head Camera and camera roll —
  every axis's layers with recovery springs and delay, presets, *This gun's
  own*, or copy a part from any gun. Live preview.
- **Start from any gun's recoil**; *Copy pattern* now also copies the spread.
- **Camera tab**: feel (Game-like / Smooth / Free), layers, snap back,
  **Punch** and **Side shake** per shot, randomness. Layers table with
  recovery columns, **lock** (kept through Make recoil), *Re-fit kicks*,
  *Gun's camera layers*.
- **Motion chart**: camera, gun and view-shake angles over time, with when
  the view is back at the centre.
- **Test fire**: fire a magazine on the range with the design, then use it,
  fire again or go back.
- **Faster and closer fits** (a second or two): the search runs on exact
  spring maths, keeps the best few combinations at each size, tunes recovery
  springs too, and corrects the kicks with the simulator. The G11K2's own
  pattern and spread, rebuilt from scratch: about 0.01–0.07 st average miss at
  50 st; with its own springs the kicks come out exactly (1.5, 0.35).
- **Tie-breakers**: *Default* now shows the built-in order for the chosen
  goal on the line under the buttons, like *Custom*. Long lines end in "…";
  hover shows the whole list.
- **Start fresh** now resets the tie-breakers, the default exclusion list and
  full-screen choices too (the Settings panel stays). A session that only
  changed recoil, export options or those also gets the question now, instead
  of being dropped silently.
- Tests: designed layers carry their own recovery and snap back; the G11K2
  rebuilt from scratch and from its own springs. 41 tests passing.

## Batch 28 — README check

README brought up to date with the code:
- Recovery explained as the game does it: each layer switches to the recovery
  spring with the same number after the delay, and on guns slower than
  600 rpm that also happens between shots (simulation section and Recoil tab).
- Controller input moved from *Limits* to *How the simulation works* (it's
  modelled, not a limit).
- Display settings: field of view 60–120° (default 80°), translucent panels.
- Starting up: `--data` option; restart after copying in a new version (and
  the banner that says so).
- Recoil designer: toolbar switches (Rings, Spread), Motion chart chips, what
  Test fire restores, the design staying until you open it for another gun.
- Export: tie-breakers and input in the every-gun options; *Copy from range*
  lists everything it copies (input, shots per mag, click rate).
- Folder layout: `recoil_edit.py`, `recoil_fit.py`, `recoil.js`, `designer.js`.

## Batch 29

- **Make recoil moved out of the Camera tab.** It's now the big button at the
  bottom of the designer's side panel, visible on every tab, with the result
  (average miss, furthest-off shot) under it. It pulses while the result is
  out of date and says so ("Something changed — make it again"); Ctrl+Enter
  works too. *Use it on this gun (aimed / hip fire)* and *Test fire* sit under it.
- **Fixed: clicking a shot didn't show its settings.** The shot panel lives on
  the Pattern tab, so with the Camera or Gun & view tab open a click selected
  the shot without showing anything; and clicking a shot's orange landing dot
  (rather than its target marker) selected nothing. Now a click on either
  selects the shot, switches to the Pattern tab and scrolls its panel into view
  (it flashes briefly). In *Place shots*, clicking a shot you already placed
  selects it instead of placing another one on top.

## Batch 30

- *Make recoil* is now **Combine Recoil**.
- The button, its result and *Use it* / *Test fire* are locked to the bottom
  of the designer's side panel on every tab: the open tab scrolls above them,
  and the result area has a fixed height, so nothing moves when the tab,
  the selected shot or the result changes.
- The line of small text inside the button is gone. The button still pulses
  while the result is out of date, and the result area says "Changed since the
  last Combine Recoil". Ctrl+Enter still works.

## Batch 31 — designer fixes

- **Fixed: "After the line" did nothing with placed shots.** It only looked at
  the drawn line, so with *Place shots* (or a line covering the whole magazine)
  every later shot was free and the recoil ran off to the side. It's now
  **After your shots**: it starts after the last shot you gave a place, line or
  placed, in the direction of your last shots. *Settle* is the default.
- **Free shots can't run away any more.** A free shot gets a very light hint —
  along the straight line between the placed shots around it, or carrying on
  after the last one — that only matters when nothing else does.
- **Fixed: recoil that "spazzed out".** Three causes:
  - Between shots the fit couldn't see the view, so springs could twitch
    wildly between shots and still land every one. Extra checks now keep the
    motion between two shots near the line between them, and the return after
    the last shot a smooth glide (no more overshoot dips). New **Smoothness**
    setting (Camera tab, default 30 %).
  - Layers could cancel each other with huge kicks; the kicks are now kept in
    check.
  - With *Randomness*, each layer's variance was a share of its own kick, so
    cancelling layers piled up enormous spread (±4 st at shot 30 in one test).
    Randomness is now a share of each shot's step along the pattern, and the
    variances are solved to match (±1 st there).
- **Fixed: resizing one spread ring resized all of them.** Rings used to carry
  over to the shots around them; now each ring belongs to its own shot. *Set* /
  *Growing* put a ring on every shot; shots without a ring use Randomness.
- Test updated: recreating the G11K2 from its own springs uses Smoothness 0.

## Batch 32

- **Clear now clears the combined recoil too** (the orange path, spread and
  miss lines): the pattern, rings and the camera go back to what the design
  started from. Gun & view edits stay, and *Undo* brings everything back,
  including whether the result was up to date.
- Until you press Combine Recoil, the recoil you started from is drawn as a
  grey dashed path (a reference, not a result); orange is only a combined
  result.

## Batch 33

- The orange path, spread and landing dots of the gun's own recoil show again
  when the designer opens (Batch 32 had turned them into a faint grey line
  before the first Combine Recoil). Orange is always what the recoil being
  designed does; *Clear* puts it back to the recoil you started from.

## Batch 34

- **Reset** button in the designer's toolbar, next to Clear: everything back to
  how the designer opens — the gun's recoil as it is now (every part, Gun &
  view included, *Start from* back to it), no pattern or rings, and the
  default settings (feel, layers, smoothness, snap back, recovery, punch,
  shake, randomness, After your shots, magazine, range). Undo brings the
  pattern and recoil back.

## Batch 35

- **Clear empties the canvas again**, while the gun's own orange recoil still
  shows when the designer opens: Clear hides the orange path, spread rings,
  landing dots, miss lines and the Motion chart (and undoes Combine Recoil).
  They come back with the next Combine Recoil, Reset, Copy pattern, a new
  *Start from*, the other stance, or an edit to the camera layers or Gun &
  view parts. Drawing a new pattern keeps the canvas clean. Undo brings back
  what Clear removed.
