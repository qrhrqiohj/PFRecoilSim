# RecoilSim

An offline shooting range that recreates the game's recoil system shot for shot.
Pick any gun, bolt on attachments exactly as the in-game loadout allows, set the
range, and look down the sights of the gun as it empties a magazine into a target with
the game's character hitboxes. Run thousands of mag dumps in a second to get a
heatmap, or let the optimiser find the best attachment setup for a range.

## Quick start (Windows)

1. Install Python 3.9 or newer from python.org (tick "Add python.exe to PATH").
2. Double-click **RecoilSim.bat**. The first time it offers to install `numpy`.
3. Your browser opens the range at `http://127.0.0.1:8765/`. Keep the black
   console window open while you use it; close it to quit.

Any OS: `python run.py` (options: `--port 9000`, `--no-browser`).

## Starting up

RecoilSim always starts from its defaults (AK-47, 50 studs, aimed, no
attachments). If your last session changed anything, it asks whether to pick up
where you left off or start fresh; if it didn't, it just starts. Loading brings
back the gun and its attachments (per gun), every Setup setting including fire
mode and recoil control, 1st / 3rd person and the camera orbit, the simulation
settings, sound, playback speed, the pattern view / fit / zoom, the open tab and
hidden panels, saved patterns, and the setup finder's goal, sight, recoil
control, depth and exclusions. Display preferences (gear icon) are always kept.

## What's on screen

The range fills the window. Everything else floats on top of it: a top bar,
**Setup** on the left, **Analysis** on the right and a small dock at the bottom.
Hide either panel with its panel icon (or **[** / **]**) to see more of the range.

| Part | What it does |
|---|---|
| **Top bar** | The gun picker (click the gun name or press **G**: search, filter by class, arrow keys + Enter), **Best setup**, **Export**, display settings (gear) and the controls / shortcuts sheet (**?**). |
| **Setup** (left) | *Attachments*: the five slots; click one to pick from only the attachments that gun can use, with each attachment's description. *Reset* clears them. If an attachment adds or removes fire modes (e.g. a conversion kit), the fire-mode buttons update and keep your mode when it still exists. *Target*: range, aim point, stance, sight (aimed / hip fire) and **Mouse aim** (off by default): control the recoil yourself. Hold the **right** mouse button and move the mouse to turn your view (shoot with the left button as usual, or use *Fire mag*); every bullet lands where you were aiming when it fired, with hits worked out by the same hitbox rules as the simulator. *Mouse sensitivity* sets how far the view turns per pixel (1× = the point under the cursor moves to the centre). While the right button is held the mouse pointer is locked to the range (hidden and kept still), so it can't drift onto the panels and every click stays on the range. Your aim carries over between magazines and only re-centres when you reload (**R**). *Shooting*: fire mode and recoil control; *More options* has shots per mag, click rate for semi / burst, enemy health, game FPS and bullet drop. |
| **Range** (background) | Endless baseplate and back wall with the target dummy at the chosen distance. In **1st person** *Aimed* puts the gun in the game's aim-down-sights pose (optics zoom, scopes black out the edges) and the gun fades so the target stays visible; *Hip fire* uses the hip pose. **3rd person** shows the gun on a stand; right-drag (or middle-drag, which works even with Mouse aim on) to orbit, scroll to zoom. **Hold the left mouse button** on the range to shoot and let go to stop: the magazine carries on from where it stopped on the next press, and the recoil springs keep recovering during the pause exactly as in game. Presses and releases follow the game's trigger code: on semi-auto and burst guns each click is one trigger pull, clicks while the gun is still cycling are ignored, letting go early cuts a burst short unless the gun has burst lock, binary triggers also fire on release, force-capped guns ignore clicks until the cap allows, and auto-burst guns (e.g. the AN-94's 1800 rpm pair, which restarts with every pull) wait 60 / fire-cap after you let go. With recoil control above 0 %, the view and gun also show the shooter pulling against the climb. Tracers fly with real bullet travel time and holes stay until you clear them. |
| **Dock** (bottom) | *Fire mag* empties a whole magazine (**F**; again to stop), 1st / 3rd person (**V**), playback speed (takes effect immediately, even mid-magazine), sound, new magazine (**R**) and clear bullet holes (**C**, also clears the shots in the pattern). Above it the read-out shows the fire mode and **fire rate** (while firing: the live rate of the last few shots, so burst rates, auto-burst and heat ramp-up show), ammo left, hits, head / torso / limb hits, damage and the kill time. |
| **Analysis → Pattern** (right) | Front view of the target at range with the exact hitboxes. *Heatmap* / *Shots* / *Both* switch what's drawn; − / + (or the mouse wheel) zoom and the fit button switches between fitting everything drawn and fitting the target. **Simulate** runs any number of full magazines (1 to 100 000) in one go; with *Auto* on it re-runs whenever the setup changes, and the bin icon (or **X**) clears the result. The six key results are shown as tiles (hover *Climb* / *Spread* / *Dist. from aim* — the average distance of every bullet from where you aim — for what they mean); *Show all results* adds six more and the hit chance of every shot in the mag. **Compare**: *Save pattern* keeps the current heatmap and numbers (up to 6). Saved patterns are drawn in their own colour as outlines of the areas holding 50 % (solid), 80 % (dashed) and 95 % (dotted) of their bullets plus their average recoil path, and a table compares them with the current setup (green / red = better / worse). The eye hides one, × deletes it. |
| **Analysis → Gun stats** | Compiled stats of the current setup and the damage-over-range graph. Dots on the curves mark the **shots-to-kill breakpoints** with their range, coloured bands underneath show shots to kill, and hovering reads off damage and shots to kill at any range. Scroll to zoom, drag to pan, double-click to reset. |
| **Display settings** (gear) | Field of view, how visible the gun stays while aiming, tracers, range markers, shot numbers in the pattern, heatmap colours and volume. Use your browser's zoom (Ctrl + / Ctrl −) to make the whole interface bigger or smaller. |

Clicking the range always takes keyboard focus off boxes, so the shortcuts
reach the range. **Esc** closes whatever is open.

**Simulating magazines:** 500 mags of a 30-round gun take well under a tenth
of a second. Very large runs
are capped at 3 million bullets (shotguns hit that sooner), and a new run
cancels one that's still going, so the range never gets stuck behind it.

**Recoil control:** 0 % means nobody touches the mouse: the pattern is exactly
what the gun does on its own. 100 % means a shooter who has perfectly learned
the average pattern and pulls against it, so only the random part is left. The
optimiser uses the same setting, so you can optimise for "raw" guns or for
skilled players.

**Units:** distances are in **studs** (shown as *st*), Roblox's unit of
distance. The target dummy is 5 studs tall, and one stud is about 28 cm.
*Climb* is how far the average pattern drifts from the aim point (after your
recoil control) and *spread* is how far bullets scatter randomly around that
average; both are measured on the target at the chosen range.

## How the simulation works

Everything below was read from the game's scripts and is reproduced, not
approximated, unless listed under *Limits*.

* **Recoil springs.** Three layered spring groups move the shot: camera body,
  gun rotation and gun translation. Each layer is a 3-axis damped spring solved
  analytically (the game's `Vector3Spring`). Every shot adds a random velocity
  impulse per layer and axis, uniform in *mean ± variance*, scaled by
  `(1 − fire-mode stability) × (1 − stance stability)` (stand 0, crouch 0.15,
  prone 0.1). Camera *head* springs only shake the view and never move bullets,
  same as the game.
* **Recovery.** When an axis has gone `delay` seconds without an impulse it
  switches to its recovery damping and speed. The game checks this once per
  rendered frame, so the simulator does too.
* **Frame timing.** Shots fire on frame boundaries (several per frame if the
  fire rate is higher than the frame rate). The game's clock keeps running
  while its fire loop runs inside a frame, so guns with near-instant multi-shots
  (AF2011-A1, Sawed Off, Stevens DB, Ropod Shotty: 2 rounds; M7644: 4 rounds,
  all at 999 000 rpm) fire every round of the shot in the same frame, from the
  same point of the recoil. A shot's direction is read before
  that frame's recoil impulse, so the first shot always goes exactly where the
  gun points. Change *Game FPS* (any value, e.g. 87.5, or pick a common one) to see how frame rate affects patterns.
* **Fire modes.** Auto, semi, burst, binary, switch, single/double action,
  auto-burst (hyperburst, e.g. the AN-94 fires its first two rounds at
  1800 rpm, then 600 rpm), fire caps, aimed fire rate, heat fire-rate springs
  (fire rate that ramps up on guns like the PKM or USAS-12, or drops on
  semi-autos when spammed, then recovers), fire and recoil delays, and
  animation-limited fire rates.
* **Hip fire.** The hip spread spring is kicked by the current crosshair size,
  as in the game.
* **Pellets.** Shotgun pellets use the game's quasi-random gaussian sample
  sequence (`SamplePointGenerator`) with spread, choke and x/y bias.
* **Ballistics.** Bullet speed, bullet acceleration and gravity (196.2
  studs/s²), with a 2-second bullet lifetime.
* **Hitboxes and damage.** The character hitboxes are head 1×1, torso 2×2, arms
  and legs 1×2 studs with a 0.1-stud margin. When a bullet is within the margin
  of several parts, head beats torso, torso beats arms, and arms beat legs.
  Damage comes from the gun's damage graph at the bullet's travel distance ×
  `multhead` / `multtorso` / `multlimb`.
* **Attachments.** The game's stat-modifier pipeline (setters, adders, table
  inserters and removers, relative and true multipliers) is ported one-to-one,
  including weapon-specific overrides from attachment sets and the
  priority/ordering rules.

### Verified against the game

`tests/` contains reference results generated inside Roblox Studio by the
game's own modules:

* 16 random gun + attachment setups compiled by the game's
  `StatModifierInterface` match the simulator's compiled stats exactly.
* A full AK-47 magazine run through the game's `RecoilSprings`, `Vector3Spring`
  and `CFrameLib` (with a controlled clock) matches the simulator's recoil path
  to within 0.00001°.

Run the tests with `python -m unittest discover tests`.

### Limits

* The gun is static: walking, idle and sniper-scope sway are not modelled.
* Gun models: the exact part layout (position, size, colour, attachments,
  optics) comes from the game, but Roblox only lets Studio read a mesh's shape
  if you own the mesh asset. Mesh parts and unions it can't read are drawn
  as stand-in shapes built from their bounding boxes: tube-shaped ones (scope
  bodies, suppressors, barrels) as cylinders, lenses as tinted glass, and the
  rest as slightly rounded blocks. The exporter grabs real shapes for any
  meshes it is allowed to read.
* Hip-fire bullets start at the camera rather than the barrel (a constant
  offset of about one stud).
* The gun-rotation pivot offset (under 0.05 studs) and the bullet's few-cm
  start offset are ignored.
* Recoil control is an idealised model: a fixed percentage of the average path.
* Penetration and map geometry are not simulated, and targets don't move.
* Mouse and keyboard only. The game halves camera recoil for pure controller
  input, and that isn't applied here.

## Best setup finder

The finder has everything that affects the search in one place:

* **Goal**: closest to aim point (the default: average distance of every bullet
  from where you aim), time to kill, damage per mag, damage per second,
  headshot rate or hit rate.
* **Gun**: the finder opens on the gun that's on the range; click the gun name
  in its header to search another gun without leaving the finder. **Equip**
  puts the chosen setup (and that gun) on the range.
* **Scenario**: range, aim point, stance, sight, fire mode, recoil control,
  enemy health, game FPS and bullet drop (off = you aim for drop, so it never
  counts as recoil). It's copied from the Setup panel when the finder opens
  (*Copy from range* copies it again) and changing it never changes the range.
  Sight (default aimed) and recoil control (default 100 %) are the finder's
  own and are remembered.
* **Slots to search**: each slot card shows what it searches and has two
  buttons. **Exclude** opens a chip list of that slot's attachments: red ones
  are left out (click to toggle, filter, include / exclude all). **Lock** opens
  the same kind of list: click one attachment (or *Empty slot*) to fix the slot
  to it, so you can search around e.g. a conversion kit without equipping it;
  the equipped one is marked. Exclusions are remembered per gun.
* **Joke attachments start out excluded**: DCL 120, Halbek Device, Oil Filter,
  Muffler, Ballistics Tracker, the canted ACOG / Animu / Furro sights,
  Suppressor..?, the .17 Incinerator (M107 and the other .50 snipers),
  .223 Remington ammo and the
  KS-23M harpoon, plus the Heavy Buffer on the M231 only, and every
  admin / super-tester-only attachment on normal guns (e.g. the M107 and M249
  bipods, the G36 family's Hensoldt Dual Optic; test guns keep theirs). Click a red chip to
  put one back. **Reset all** clears every exclusion and lock so everything is
  searched; pressed again (it then reads *Restore default exclusions*), it
  brings the default list back.
  **Edit default list** (next to *Reset all*, in the finder and the export)
  opens the whole list for every slot: click to add or remove, *Restore
  built-in list* undoes your changes. Your list is kept on this computer and is
  used by every gun whose own exclusions you haven't changed, and by the export.
* **Search**: *Thorough* (default, described below), *Standard* or *Quick*, and
  how many setups to list: a preset, *All* (every distinct setup the search
  finds; slower) or *Custom…* for your own number.
* **Copy from range** copies range, aim point, stance, sight, fire mode,
  recoil control, health and FPS from the Setup panel (the export's scenario
  has the same button).

Results come in three lists: *Lowest spread* (shown first), *Lowest climb* and
*Best overall* (your goal; shown first for the first STK goals). **Equip** puts a setup on the gun. *Every attachment on
its own* (under the list) shows how each attachment changes the
score, climb and spread compared with an empty slot. **B** opens the finder.

### How the search works

1. For each slot, every attachment is compiled and attachments with identical
   shooting stats are grouped. Anything that changes nothing about shooting
   (most sights, lights, lasers) is the same as an empty slot and is never
   simulated separately.
2. If there are at most 3 000 distinct combinations, every one is simulated.
3. Otherwise each option is scored on its own, every combination of the best
   six per slot is simulated (up to 3 000) — once for the goal and once each
   for the options with the least spread and the least climb (up to 1 500
   each) — and then the five best setups of each list are refined by swapping
   each slot for every option in turn, keeping any swap that helps, until
   nothing improves. Finally every one-slot swap around the ten leading setups
   of each list is tried, repeated until those ten stop changing. That catches
   attachments that only pay off together (for example a barrel that suits a
   conversion kit, or a muzzle that's poor on its own but great with one grip).
4. The top setups are re-run with many more mag dumps for the final ranking.
   Setups that only add attachments without improving the score are moved
   down, and ties are broken by damage per mag, then by fewer attachments.
   At least five setups are always listed.

**Goal descriptions:** hover a goal in the goal list (finder or export) to see what it ranks by; hovering the closed list shows the chosen one.

**First STK range goals.** *First STK range (torso)*, *(head)* and *(limb)*
rank setups by the fewest shots to kill (STK) aiming at that part at the gun's
best range — then by how much range that shot count holds over. The result
reads e.g. *3-shot: 118.8* (an AK47 three-shots the torso out to 118.8
studs) or *2-shot: any range*. Fewer shots always win: a setup that drops the
head STK from 2 to 1 beats any amount of extra 2-shot range. Several bullets
are counted from the damage curve, the hitbox multiplier and the 2 s bullet
lifetime; a **one-shot** also needs the first shot to land. **Pellet guns**
are simulated for any number of shots: every pellet counts for the part it
really hits (aiming at the torso, pellets on the head or limbs do head or
limb damage, misses do none), each shot a fresh pattern, and the shots have
to kill at least 80 % of the time (50 % / 95 % selectable). *(limb)* aims at
the middle of the legs.

Every damage curve works: a normal fall-off kills from point blank out to a
range (*1-shot: 95.7*), a damage sweet spot only between two ranges (the
M107's torso: *1-shot: 80.0–250.0*), rising damage from a range on (the KAC
SRR, a bolo round: *1-shot: 197.3+*), and some do several (the AWS on
subsonic: *0–40.0, 130.0+*). **Shotguns** (pellet guns) are ranked by how far
it holds from point blank, so a bolo round that only kills far out doesn't
replace buckshot. **Every other gun** is ranked by the total length of range
(a 50–150 sweet spot counts 100; measured out to 2000 studs, so a band that
runs on to the end counts more the closer it starts). The M107 takes the
Precision Barrel's 100–300 (200) over adding SLAP (150–336, only 186), and the
Timberwolf the .408 (40.7–194.3) over the .308 conversion's plain 0–90. Equal
totals go to the one that reaches farthest. Equal ranges are ranked by the
**average range** — pellet spread often decides how far a shot reliably
kills, and then a barrel that stretches the damage fall-off (e.g. a
suppressor) still pays off on average — then by **handling** (the average
change in aim / unaim speed, walk speed hip and aimed, sprint speed,
sprint-to-fire speed and equip speed vs the bare gun; differences under 0.1 %
are ties), then by recoil (average distance from the aim point). For a
**setup that needs more than one shot** (single bullet or pellets) the last two swap: less
recoil first, then handling, because a several-shot kill needs the
follow-up shots to land. *vs #1*
shows the extra shots when a setup needs more, else the range difference.
For these goals *Best overall* is shown first, and the results add handling
and the **average one-shot range** aiming at the head, torso and legs (where
one shot can kill there; 2000+ = any range). The *Gun stats* tab shows the
same averages for the setup on the range.

All three goals are always in the list. The finder picks one automatically:
*First STK range (torso)* for guns that can one-shot the torso — or
*First STK range (limb)* when a single-bullet gun's limb multiplier is
higher than its torso one. Pellet guns always get the torso goal (their
pellets spread onto the limbs anyway) and only when every pellet on the
torso kills — the Origin 12 (0.7× torso: 8 × 14 = 78) can't, so it gets
spread; aimed at the torso it's a *2-shot*.
Every other gun gets spread (*Closest to aim point*). "Can
one-shot" means on its own (shotguns, most snipers, the big revolvers…) or
with what's equipped on the range (for the finder's gun) or locked in the
finder, so equipping or locking e.g. the SKS buckshot or a magnum
conversion selects it. The goal is decided before the search starts: a
conversion the search itself tries doesn't change it (with First STK as the
goal, a conversion that saves a shot simply wins). A goal you pick yourself
stays until the gun or that answer changes. The every-gun export ranks
one-shot guns the same way by default (*One-shot guns: First STK range*,
on the torso, or the limbs for single-bullet guns where they're stronger;
the part used is shown next to the range, e.g. *1-shot: 70.2 (torso)*) and
fills the First STK range column from that search.

**Export full screen:** like the finder, the Export window has a full-screen
toggle (top right, or press F).

**Search progress:** the bar shows the current step, how far through that
step it is (e.g. *Testing 243 combinations of the strongest options (120 /
243)*), and how many setups have been simulated in total. The total keeps
growing past a step's count, because the search has several steps: each
attachment on its own, the combination pools (one per list), refining one
slot at a time, checking every swap around the best setups, removing
attachments that do nothing, and the final re-run of the top setups with
more mag dumps.

**Same number of shots for every setup:** the finder fires the bare gun's
magazine with every setup (for every goal except damage per mag / DPS, where
the magazine size really matters). A smaller magazine can't look like less
recoil just because its pattern stops sooner: the M107's 5-round magazine
scores the same as the stock 10 and is dropped as doing nothing. The
per-magazine numbers in the results (kills / mag, damage / mag, TTK, shots to
kill) still use each setup's real magazine, so they stay true to the gun.

**Bullet drop is held over:** the finder assumes you aim for bullet drop at
the chosen range, so drop never counts as recoil. Slower ammo (e.g. hollow
point) can't look like it reduces climb just because its bullets drop more,
while bullet speed still counts where it really matters: travel time, and so
time to kill.

**Three rankings:** each list gets its own search refinement
and its own final re-run, so the best low-spread setup isn't just the best
combined setup re-sorted.

**Climb vs spread:** every attachment in the per-slot table shows its effect
split into *climb* (how far the recoil drags the average pattern from the aim
point before any recoil control: how much you have to pull against, which a
player can learn) and *spread* (random kick around that pattern, which no one
can learn). Climb is measured before recoil control on purpose: after a
perfect pull it would be about zero for every gun and only rank sampling noise. Some attachments trade one
for the other: e.g. Remove Stock makes the gun dip harder on every shot, which
cancels part of the camera climb but adds random kick. At 0 % recoil control
that nets out as "less recoil"; at 100 % it's worse than Full Stock. Set
*Recoil control* to how well you (or your players) control recoil.

The *Stop* button cancels the search and stops its worker processes at once.

Search stages use 200 mag dumps per setup with the same random numbers for
every setup; finalists get 3 000. Because every setup in a stage fires the
exact same random mag dumps, two setups only score differently if their stats
really differ, so small recoil changes are ranked correctly. Differences
smaller than the last digit shown (0.0001 studs, 0.01 ms) count as ties: some
attachments change things that only touch a single frame of a magazine (e.g. a
laser that speeds up recovery after 0.1 s on a gun firing every 0.067–0.083 s)
and must never rank above an empty slot.

Before the final ranking every listed setup is stripped of passenger
attachments: anything whose removal doesn't make the setup worse by at least
that resolution is taken off, so a result never lists e.g. a ballistics
tracker or a laser that does nothing next to the attachments that matter.

The results table shows each
setup's difference to #1 measured on those shared mag dumps, with the noise of
that difference (grey = within noise). The simulations run in background worker
processes (one per CPU core but one), so the range stays responsive. On test
guns the finder's pick matched (within noise) a brute-force search over every
distinct combination.

An attachment can be real and still never show up: for example the DCL 120
cuts the AK-47's *rotational* recoil impulse by 5 %, but the gun-rotation
spring is fast and settles within a few frames, so its effect on where bullets
land is about 0.005 studs at 50 studs (inside the noise), while the camera
climb, which is what moves the pattern, is untouched.

**Closest to aim point** measures, for every bullet, the distance from the
aim point on the target plane (bullets that fly off count as 25 studs), and
averages it. Unlike "% on target", it still separates setups when every
bullet lands on the body, so tight, centred patterns win.

*Thorough* uses up to 3 000 combinations, 200 mags per setup and 3 000 for the
finalists. *Standard* uses 1 200 / 150 / 1 500 and *Quick* 300 / 80 / 500 with
fewer refinement starts; quick is what the every-gun export uses by default.

## Export (Google Sheets / Excel / CSV)

**Export** in the top bar builds a table, shows a preview, and then:

* **Copy for Google Sheets** puts it on the clipboard as tab-separated text:
  click cell A1 in a sheet and paste (Ctrl+V). Percentages paste as numbers.
* **Excel (.xlsx)** downloads a real workbook (bold frozen header, filters,
  number formats). Google Sheets opens it with *File → Import → Upload*.
* **CSV** downloads the table as comma-separated text.
* **Click a column header** in the preview to sort by it (again to reverse, a
  third time to undo); copying and saving keep the order you see.
* Guns are listed in **unlock-rank order** within their class (like the game's
  menu) with an *Unlock rank* column next to the gun's name; attachments
  everywhere are listed in **kills-to-unlock** order, with the kills shown.

What you can export:

| Table | Options |
|---|---|
| **Best setups · your guns** | A toggle list of guns (all by default; click a class to toggle all of it, *Pick guns* to choose single guns, or search), goal (the finder's goals plus **First STK range (auto: limb or torso)**: every gun ranked by First STK range on the limbs if it's a single-bullet gun whose limbs take more damage, else the torso; the goal column names the part, e.g. *2-shot: 50.5 (limb)*), which lists (lowest spread / lowest climb / best overall; only *best overall* by default, and fewer lists search faster), slot cards with the same **Exclude** / **Lock** buttons as the finder (a lock applies to every gun that can use that attachment; exclusions start from the same default joke list, with gun-specific entries such as the M231's Heavy Buffer; *Reset all* works the same way), setups per gun (a preset, *All* or your own number), search depth (*Thorough* by default), and the scenario (including game FPS and bullet drop) (range, aim point, stance, sight, fire-mode preference, recoil control, enemy health). Runs the finder on each gun in the background; the preview fills in as guns finish, it shows the time left, *Stop* keeps what's done, and everything done so far can be exported at any time. Columns: class, unlock rank, gun, list (only when you export several lists), # (only with several setups per gun), the five slots, spread, climb, the goal value, **First STK range (limb / torso / head)** (one column each, the finder's First STK logic: the fewest shots to kill that part and the range it holds over, e.g. *2-shot: 87.9*), **handling vs the bare gun** (every gun), the **average one-shot range** aiming at the limbs / torso / head (only for setups that fire pellets — shotguns or a buckshot conversion), average distance from the aim point, TTK, **On target (n st)** (n = the scenario range), headshot rate, kills per mag, and the fire mode actually used. Anything a row doesn't have reads **N/A** (an empty attachment slot stays blank). |
| **Best setups · one gun** | The latest finder results for the range's gun (or, if it has none, the last gun you searched): which lists (best overall by default), how many setups, and an optional second sheet (Excel) with every attachment's effect on its own. |
| **Gun stats · every gun** | Classes, your own list of ranges, enemy health, and column groups: basics, fire rates, damage & multipliers, damage at each range, shots to kill (head / torso / limb) at each range, bullet speed & penetration, handling. Instant. Optionally adds **simulated accuracy** for every gun (hit rate, headshots, distance from aim, climb, spread, TTK, kills and damage per mag) for a scenario (including FPS and bullet drop) and number of mags you choose. |
| **Damage by range** | For the current setup, either the **shots-to-kill breakpoints** (default: one row per body part and range band where shots to kill stays the same, with the damage at each end; the last band's *To* reads *inf*) or damage and shots to kill every *n* studs, up to a range you choose. |
| **Simulation results** | The current result and every saved pattern side by side. |
| **Imported sheet** | *Import sheet…* opens a CSV / TSV or Excel file exported from here (or any sheet with a header row) to sort, copy or save it again. |

A search in the finder and an every-gun export can run at the same time; they
share the background workers.

## Updating the data after you change guns

The gun data lives in `data/game_data.json.gz` and the gun / attachment models
in `data/models.json.gz`. To refresh both from Studio:

1. Start RecoilSim (`RecoilSim.bat`).
2. Open the place in Roblox Studio (Edit mode is fine).
3. Open `tools/StudioExporter.lua`, copy all of it into Studio's
   **Command Bar** and press Enter.
4. When the Output says *RecoilSim import complete*, refresh the browser tab.

The exporter only reads the place. It switches `HttpService.HttpEnabled` on
just long enough to send the data to `127.0.0.1` and then sets it back.

## Folder layout

```
RecoilSim/
  RecoilSim.bat            double-click launcher (Windows)
  run.py                   launcher (any OS)
  requirements.txt
  recoilsim/
    lua.py                 Lua-table helpers (1-based arrays, mixed tables)
    modifiers.py           port of the attachment stat-modifier pipeline
    gamedata.py            loads data, compiles gun + attachments
    springs.py             analytic spring maths (vectorised)
    simulate.py            firing pipeline, ballistics, hitboxes, damage
    analysis.py            stats, kill times, recoil-control path, heatmaps
    optimizer.py           best-setup search
    export.py              tables for Sheets / Excel / CSV and the every-gun export jobs
    models.py              assembles gun + attachment models like the game
    server.py              local web server + JSON API
  web/                     the range UI (no internet needed)
    index.html, style.css  layout and look
    renderer.js            WebGL renderer for the range and gun models
    core.js                shared state, helpers, storage, popovers
    range.js               the 3D range, firing replay, hold-to-fire, read-out
    panels.js              Setup and Analysis panels (pattern, results, gun stats)
    finder.js              best setup finder
    export.js              export dialog
    main.js                start-up and wiring
  data/game_data.json.gz   exported guns and attachments
  data/models.json.gz      exported gun, attachment and sight models
  tools/
    StudioExporter.lua     re-export from Studio into a running RecoilSim
    compact_export.py      shrinks a raw export into the two data files
  tests/                   checks against reference results from Studio
```
