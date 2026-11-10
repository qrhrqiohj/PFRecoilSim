"""Shot-by-shot recreation of the in-game firing + recoil pipeline.

What is modelled (all taken from the game's FirearmObject / MainCameraObject /
RecoilSprings code):
  * Camera-body, gun-rotation and gun-translation recoil springs, each made of
    layered 3-axis springs. Every shot adds a random velocity impulse per layer
    (uniform in mean +/- variance) scaled by stance and fire-mode stability.
  * Recovery: after `delay` seconds without an impulse each axis switches to its
    recovery damping/speed, checked once per rendered frame.
  * Shots fire on frame boundaries (the game checks once per frame and may fire
    several shots in one frame). The bullet direction is read before that
    frame's recoil impulse is applied, so the first shot always goes straight.
  * Hip fire spread spring (kicked by crosshair size), heat fire-rate spring,
    auto-burst, fire caps, burst / semi trigger behaviour, fire & recoil delays.
  * Pellet spread via the game's quasi-random gaussian sample generator.
  * Bullet travel with gravity (196.2 studs/s^2) and bullet acceleration.
  * Hitboxes of the game's character (head/torso/arms/legs, +0.1 stud radius,
    head > torso > arms > legs precedence) and the damage graph + multipliers.
"""
from __future__ import annotations

import bisect
import math
from dataclasses import dataclass, field

import numpy as np

from .gamedata import WeaponConfig
from .springs import ScalarSpring, VecSpringArray

GRAVITY = -196.2
# Time the game's fire loop takes per round inside one frame (raycast, effects,
# springs). GameClock keeps running while FirearmObject:fireRound() loops, so
# guns whose fire interval is shorter than this (e.g. the AF2011's 999 000 rpm
# double shot) fire several rounds in the same frame instead of one per frame.
SHOT_PROC_TIME = 0.0005
BULLET_LIFETIME = 2.0
AXES = ("x", "y", "z")
STANCE_STABILITY = {"stand": 0.0, "crouch": 0.15, "prone": 0.1}

# Character hitboxes relative to the torso centre (studs): (name, cx, cy, half_w, half_h, precedence)
HITBOXES = (
    ("Head", 0.0, 1.6, 0.5, 0.5, 1),
    ("Torso", 0.0, 0.0, 1.0, 1.0, 2),
    ("Left Arm", -1.5, 0.0, 0.5, 1.0, 3),
    ("Right Arm", 1.5, 0.0, 0.5, 1.0, 3),
    ("Left Leg", -0.5, -2.0, 0.5, 1.0, 4),
    ("Right Leg", 0.5, -2.0, 0.5, 1.0, 4),
)
HITBOX_RADIUS = 0.1
PART_GROUP = {"Head": "head", "Torso": "torso", "Left Arm": "limb", "Right Arm": "limb",
              "Left Leg": "limb", "Right Leg": "limb"}
AIM_POINTS = {"head": 1.6, "neck": 1.1, "chest": 0.5, "torso": 0.0, "stomach": -0.6, "legs": -2.0}


# ---------------------------------------------------------------------------
def _layers(tbl, axis):
    """Return the list of layer rows for one axis from a (plain) recoil table."""
    if not isinstance(tbl, dict):
        return []
    rows = tbl.get(axis)
    if isinstance(rows, list):
        return rows
    if isinstance(rows, dict):
        return [rows[k] for k in sorted(k for k in rows if isinstance(k, int))]
    return []


def _delay(tbl, axis):
    rows = tbl.get(axis) if isinstance(tbl, dict) else None
    if isinstance(rows, dict):
        return float(rows.get("delay") or 0.0)
    return 0.0


class RecoilSpringGroup:
    """Port of RecoilSprings for one group (camera body / gun rotation / gun translation)."""

    def __init__(self, recoil, prefix, aiming, runs):
        hip = recoil.get(f"hip{prefix}") or {}
        aim = recoil.get(f"aim{prefix}") or {}
        self.fire = aim if aiming else hip
        self.rec = recoil.get(f"{'aim' if aiming else 'hip'}{prefix}Recovery")
        n = 0
        for ax in AXES:
            n = max(n, len(_layers(hip, ax)), len(_layers(aim, ax) if aiming else []))
        self.n = max(n, 1)
        self.spr = VecSpringArray(runs, self.n)
        self._set_params(hip)
        if aiming:
            self._set_params(aim)
        self.last_impulse = -1e9
        self.in_recovery = {ax: False for ax in AXES}
        # impulse distributions (layer, axis) -> (mean, var)
        self.mean = np.zeros((self.n, 3))
        self.var = np.zeros((self.n, 3))
        self.has = np.zeros((self.n, 3), dtype=bool)
        for j, ax in enumerate(AXES):
            for i, row in enumerate(_layers(self.fire, ax)):
                if i < self.n and len(row) >= 4:
                    self.mean[i, j] = row[2]
                    self.var[i, j] = row[3]
                    self.has[i, j] = True

    def _set_params(self, params):
        for j, ax in enumerate(AXES):
            for i, row in enumerate(_layers(params, ax)):
                if i < self.n and len(row) >= 2:
                    self.spr.d[i, j] = row[0]
                    self.spr.s[i, j] = row[1]

    def impulse(self, time, mult, rng):
        self.spr.advance(time)
        self._set_params(self.fire)
        for ax in AXES:
            self.in_recovery[ax] = False
        runs = self.spr.p.shape[0]
        u = rng.random((runs, self.n, 3))
        imp = (self.var * 2 * u - self.var + self.mean) * self.has
        self.spr.v = self.spr.v + imp * mult
        self.last_impulse = time

    def check_recovery(self, time, force_until=None):
        """Called once per frame by the game (RecoilSprings:step)."""
        if not isinstance(self.rec, dict):
            return
        for j, ax in enumerate(AXES):
            if self.in_recovery[ax]:
                continue
            due = self.last_impulse + _delay(self.rec, ax)
            if ax in self.rec and (due < time + 1e-9 or (force_until is not None and due <= force_until + 1e-9)):
                self.spr.advance(time)
                for i, row in enumerate(_layers(self.rec, ax)):
                    if i < self.n and len(row) >= 2:
                        self.spr.d[i, j] = row[0]
                        self.spr.s[i, j] = row[1]
                self.in_recovery[ax] = True

    def next_recovery_time(self):
        if not isinstance(self.rec, dict):
            return math.inf
        times = [self.last_impulse + _delay(self.rec, ax) for ax in AXES
                 if ax in self.rec and not self.in_recovery[ax]]
        return min(times) if times else math.inf

    def position(self, time):
        return self.spr.position_sum(time)


def rotate(aa, v):
    """Rotate vectors v (N,3) by axis-angle vectors aa (N,3) (Rodrigues)."""
    theta = np.linalg.norm(aa, axis=1, keepdims=True)
    safe = np.where(theta > 1e-12, theta, 1.0)
    k = aa / safe
    c = np.cos(theta)
    s = np.sin(theta)
    kv = np.cross(k, v)
    kdot = np.sum(k * v, axis=1, keepdims=True)
    out = v * c + kv * s + k * kdot * (1 - c)
    return np.where(theta > 1e-12, out, v)


def aa_to_mat(aa):
    """Axis-angle vectors (N,3) -> rotation matrices (N,3,3) (CFrameLib.fromAxisAngle)."""
    theta = np.sqrt(np.sum(aa * aa, axis=1))
    safe = np.where(theta > 1e-12, theta, 1.0)
    kx, ky, kz = (aa / safe[:, None]).T
    c = np.cos(theta)
    s = np.sin(theta)
    C = 1 - c
    m = np.empty((len(aa), 3, 3))
    m[:, 0, 0] = c + kx * kx * C
    m[:, 0, 1] = kx * ky * C - kz * s
    m[:, 0, 2] = kx * kz * C + ky * s
    m[:, 1, 0] = ky * kx * C + kz * s
    m[:, 1, 1] = c + ky * ky * C
    m[:, 1, 2] = ky * kz * C - kx * s
    m[:, 2, 0] = kz * kx * C - ky * s
    m[:, 2, 1] = kz * ky * C + kx * s
    m[:, 2, 2] = c + kz * kz * C
    small = theta <= 1e-12
    if small.any():
        m[small] = np.eye(3)
    return m


class GaussianSampler:
    """Port of SamplePointGenerator (2-D R-sequence + Marsaglia polar transform)."""

    def __init__(self):
        phi = 1.0
        for _ in range(6):
            v = phi ** 3
            phi -= phi * (v - phi - 1) / (2 * v + 1)
        self.c = (1 / phi, 1 / phi ** 2)

    def point(self, index):
        while True:
            index += 1
            a = (self.c[0] * index) % 1
            b = (self.c[1] * index) % 1
            x = 2 * a - 1
            y = 2 * b - 1
            r = x * x + y * y
            if 0 < r < 1:
                break
        m = math.sqrt(-math.log(1 - r) / r)
        return m * x, m * y, index

    def points(self, index):
        """Vectorised point(): index is an int array, returns (x, y, new_index)."""
        cand = index[:, None] + np.arange(1, 17)[None, :]
        a = (self.c[0] * cand) % 1
        b = (self.c[1] * cand) % 1
        x = 2 * a - 1
        y = 2 * b - 1
        r = x * x + y * y
        ok = (r > 0) & (r < 1)
        first = ok.argmax(axis=1)
        rows = np.arange(len(index))
        xs, ys, rs = x[rows, first], y[rows, first], r[rows, first]
        m = np.sqrt(-np.log(1 - rs) / rs)
        return m * xs, m * ys, cand[rows, first]


# ---------------------------------------------------------------------------
@dataclass
class SimSettings:
    distance: float = 50.0
    aiming: bool = True
    stance: str = "stand"
    firemode_index: int = 0
    shots: int | None = None          # default: magazine size
    fps: float = 60.0
    trigger_rpm: float | None = None  # click rate for semi / burst (default: max useful)
    aim_point: str = "torso"
    aim_offset: float | None = None   # custom aim height relative to torso centre
    gravity: bool = True
    health: float = 100.0
    runs: int = 1
    seed: int | None = None
    record_track: bool = False
    keep_rays: bool = False           # keep the first shot's pellet rays (for the one-shot range)
    # Optional trigger schedule: [[press, release], ...] in seconds; release None
    # means still held. Without it the trigger is held until the shots run out.
    trigger_holds: list | None = None
    track_end: float | None = None    # record the replay track at least until this time
    track_start: float | None = None  # ...and only from this time on (long hold-to-fire sessions)
    firemode_label: str | None = None  # preferred over the index when the setup has that mode
    controller: bool = False           # pure controller input: the game halves camera recoil
                                       # (FirearmObject.impulseSprings: MainCamera impulse * 0.5)


@dataclass
class ShotPlan:
    fire_times: list
    sample_times: list
    impulse_times: list
    firerates: list
    firemode: object
    label: str


def firemode_label(fm):
    if fm is True:
        return "AUTO"
    if fm == 1:
        return "SEMI"
    if isinstance(fm, (int, float)):
        return f"BURST {int(fm)}"
    return str(fm)


def _frame_at_or_after(t, fps):
    f = math.ceil(t * fps - 1e-9)
    return f / fps


def firemode_index(stats, st: SimSettings) -> int:
    """Pick the fire mode: by name when given (attachments can add or remove
    modes, which shifts the indices), otherwise by index."""
    fms = stats.get("firemodes") or [True]
    if not isinstance(fms, list):
        fms = [fms]
    if st.firemode_label:
        labels = [firemode_label(f) for f in fms]
        if st.firemode_label in labels:
            return labels.index(st.firemode_label)
        return 0
    return min(max(int(st.firemode_index), 0), len(fms) - 1)


def _plan_trigger_holds(stats, fm, holds, n_shots, fps, current_rate, heat, heat_active,
                        recoildelay, aimedfirerate, firecap, autoburst, frame_of):
    """Shot times for real trigger presses / releases (hold-to-fire), following
    FirearmObject:shoot(true/false) and fireRound() step by step:

    * press: ignored entirely while forcecap's disable timer runs; auto sets
      the auto flag; SWITCH loads 999 rounds; semi / burst load a burst only if
      the gun has cycled (nextShot < now); forcecap starts the disable timer
    * release: auto-burst guns wait 60/firecap before the next pull; the
      remaining burst is cancelled unless the gun has burstlock / burstcam;
      binary triggers fire one more round
    * every frame: fire while the gun is ready (now >= nextShot) and the auto
      flag or a burst is pending; after the last round of a burst on a
      non-auto, non-semi mode nextShot = now + 60/firecap
    """
    events = []
    for i, (a, b) in enumerate(holds):
        events.append((frame_of(a), 0, i))
        if b != math.inf:
            events.append((max(frame_of(b), frame_of(a)), 1, i))
    events.sort()
    burstlock = bool(stats.get("burstlock"))
    burstcam = bool(stats.get("burstcam"))
    loose = bool(stats.get("loosefiring"))
    forcecap = bool(stats.get("forcecap"))
    v102 = 1 if fm == "BINARY" else fm
    fire_times, rates = [], []
    next_shot, burst, auto, nshots, disable_until = -1.0, 0, False, 0, -math.inf
    ei = 0
    frame = events[0][0] if events else 0
    n_fired = 0
    guard = 0
    while n_fired < n_shots and guard < 200_000:
        guard += 1
        t = frame / fps
        # input first (between frames), then the frame's fireRound()
        while ei < len(events) and events[ei][0] <= frame:
            _f, kind, _i = events[ei]
            ei += 1
            if kind == 0:
                if t < disable_until:
                    continue
                if v102 is True:
                    auto = True
                elif v102 == "SWITCH":
                    burst = 999
                elif v102 in ("DOUBLE", "SINGLE"):
                    burst = 1
                elif burst == 0 and next_shot < t:
                    burst = int(v102) if isinstance(v102, (int, float)) else 1
                if burstcam:
                    auto = True
                if next_shot < t:
                    next_shot = t
                if forcecap and not auto and firecap:
                    n = v102 if isinstance(v102, (int, float)) and not isinstance(v102, bool) else 1
                    disable_until = t + 60 / firecap * n
            elif not loose:
                if autoburst and auto and nshots > 0 and fm is True and firecap:
                    next_shot = t + 60 / firecap
                nshots = 0
                auto = False
                if not burstlock and not burstcam and fm != "SWITCH":
                    burst = 0
                if fm == "BINARY":
                    if next_shot < t:
                        next_shot = t
                    burst = 1

        now = t  # the game's clock keeps running while fireRound() loops in a frame

        def can_fire():
            if now < next_shot - 1e-9:
                return False
            if burstcam and fm is not True:
                return auto and burst > 0
            return auto or burst > 0

        while n_fired < n_shots and can_fire():
            fire_times.append(t)
            n_fired += 1
            nshots += 1
            if burst > 0:
                burst -= 1
            if heat_active:
                heat.advance(t + recoildelay)
            rate = current_rate(t, nshots)
            rates.append(rate)
            if burst <= 0 and firecap and fm is not True and fm != 1:
                next_shot = now + 60 / firecap
            elif aimedfirerate:
                next_shot += 60 / aimedfirerate
            else:
                next_shot += 60 / rate
            if heat_active:
                heat.advance(t + recoildelay)
                heat.v += stats.get("heatfireratekick") or 0
            now += SHOT_PROC_TIME
        # next interesting frame: the next input, or the gun becoming ready -
        # but only if it could actually fire then (burstcam guns need the
        # trigger held AND a burst pending; without this, a held burstcam
        # trigger with an empty burst stepped through a million idle frames)
        cands = []
        if ei < len(events):
            cands.append(events[ei][0])
        could_fire = (auto and burst > 0) if (burstcam and fm is not True) else (auto or burst > 0)
        if could_fire:
            cands.append(max(frame + 1, frame_of(next_shot)))
        if not cands:
            break
        frame = max(frame + 1, min(cands))
    return fire_times, rates


def plan_shots(cfg: WeaponConfig, st: SimSettings) -> ShotPlan:
    """Work out when each shot fires (frame-quantised, like the game)."""
    stats = cfg.stats
    firemodes = stats.get("firemodes") or [True]
    if not isinstance(firemodes, list):
        firemodes = [firemodes]
    idx = firemode_index(stats, st)
    fm = firemodes[idx]
    mag = int(math.ceil(stats.get("magsize") or 1))
    n_shots = int(st.shots) if st.shots else mag
    n_shots = max(1, n_shots)

    base_rate = stats.get("firerate") or 600
    if stats.get("variablefirerate") and isinstance(base_rate, list):
        base_rate = base_rate[idx] if idx < len(base_rate) else base_rate[0]
    elif isinstance(base_rate, list):
        base_rate = base_rate[0]
    aimedfirerate = stats.get("aimedfirerate") if st.aiming else None
    firecap = stats.get("firecap")
    autoburst = stats.get("autoburst")
    burstfirerate = stats.get("burstfirerate")

    # animation-limited fire rate (FirearmObject._effectiveAnimationFirerate)
    anims = cfg.anims or {}
    times = []
    onfireanim = stats.get("onfireanim")
    if onfireanim and onfireanim in anims:
        a = anims[onfireanim]
        times.append(a["ds"] * (a.get("ts") or 0.5) + (a.get("rt") or 0.5))
    if stats.get("magsize") == 1 and not stats.get("chambered"):
        a = anims.get(f"{stats.get('altreloadlong') or ''}reload")
        if a:
            times.append(a["ds"] * (a.get("ts") or 0.5) + (a.get("rt") or 0.5))
    anim_cap = 60 / max(times) if times and max(times) > 0 else math.inf

    heat_kick = stats.get("heatfireratekick")
    ignore = stats.get("heatfirerateignorelist") or []
    heat_active = bool(heat_kick) and fm not in (ignore if isinstance(ignore, list) else [])
    heat = ScalarSpring(1.0, d=stats.get("heatfireratedamping") or 3, s=stats.get("heatfireratespeed") or 5)

    fps = st.fps
    firedelay = 0.0 if fm == "SINGLE" else (stats.get("doubleactiondelay") or 0.0) if fm == "DOUBLE" else (stats.get("firedelay") or 0.0)
    recoildelay = stats.get("recoildelay")
    recoildelay = firedelay if recoildelay is None else recoildelay

    def current_rate(t, n_fired):
        rate = base_rate
        if autoburst and fm is True and n_fired < autoburst and burstfirerate:
            rate = burstfirerate
        if heat_active:
            rate = rate * heat.pos(t)
            if stats.get("heatfireratecap"):
                rate = min(rate, stats["heatfireratecap"])
            if stats.get("heatfireratemin"):
                rate = max(rate, stats["heatfireratemin"])
        return max(min(rate, anim_cap), 1e-6)

    fire_times, rates = [], []
    is_auto = fm is True
    burst_size = 1
    if isinstance(fm, (int, float)) and not isinstance(fm, bool):
        burst_size = int(fm)
    elif fm == "SWITCH":
        is_auto = True
    # Semi / burst: either click at a fixed rate, or "perfect clicking" (press on
    # the first frame the gun will accept a new trigger pull).
    click_interval = 60 / st.trigger_rpm if (not is_auto and st.trigger_rpm) else None
    if click_interval and fm == "BINARY":
        click_interval /= 2  # binary triggers fire on press and on release

    holds = None
    if st.trigger_holds:
        holds = []
        for a, b in st.trigger_holds:
            a = float(a)
            b = math.inf if b is None else float(b)
            # a click always reaches at least one frame, however short the tap
            holds.append((a, max(b, _frame_at_or_after(a, st.fps) + 0.5 / st.fps)))
        holds.sort()
    def frame_of(x):
        return math.ceil(x * fps - 1e-9)

    if holds is not None:
        fire_times, rates = _plan_trigger_holds(stats, fm, holds, n_shots, fps, current_rate, heat, heat_active,
                                                recoildelay, aimedfirerate, firecap, autoburst, frame_of)
    else:
        # one long trigger pull: auto fires until the mag is empty; semi / burst
        # click at the chosen rate, or on the first frame the gun accepts a pull
        next_shot = 0.0
        frame = 0
        burst = 0
        disable_until = -1.0
        next_click = 0.0
        n_fired = 0
        guard = 0
        while n_fired < n_shots and guard < 2_000_000:
            guard += 1
            t = frame / fps
            if not is_auto:
                ready = burst == 0 and (next_shot < t or n_fired == 0) and t >= disable_until
                if click_interval is None:
                    press = ready
                else:
                    press = t >= next_click - 1e-9
                    if press:
                        next_click += click_interval
                if press and t >= disable_until:
                    # FirearmObject:shoot(true)
                    if burst == 0 and (next_shot < t or n_fired == 0):
                        burst = burst_size
                    if next_shot < t:
                        next_shot = t
                    if stats.get("forcecap") and firecap:
                        disable_until = t + 60 / firecap * burst_size
            now = t  # the game's clock keeps running while fireRound() loops in a frame
            while n_fired < n_shots and now >= next_shot - 1e-9 and (is_auto or burst > 0):
                fire_times.append(t)
                n_fired += 1
                if burst:
                    burst -= 1
                if heat_active:
                    heat.advance(t + recoildelay)
                rate = current_rate(t, n_fired)  # one pull: auto-burst counts from the first shot
                rates.append(rate)
                if burst <= 0 and firecap and fm is not True and fm != 1:
                    next_shot = now + 60 / firecap
                elif aimedfirerate:
                    next_shot += 60 / aimedfirerate
                else:
                    next_shot += 60 / rate
                if heat_active:
                    heat.advance(t + recoildelay)
                    heat.v += heat_kick
                now += SHOT_PROC_TIME
            frame += 1

    sample_times = [_frame_at_or_after(ft + firedelay, fps) if firedelay > 0 else ft for ft in fire_times]
    impulse_times = [_frame_at_or_after(ft + recoildelay, fps) if recoildelay > 0 else ft for ft in fire_times]
    return ShotPlan(fire_times, sample_times, impulse_times, rates, fm, firemode_label(fm))


def interpolate_damage(graph, dist):
    if not graph:
        return 0.0
    for i, pt in enumerate(graph):
        if dist < pt["distance"]:
            if i == 0:
                return pt["damage"]
            prev = graph[i - 1]
            a = (dist - prev["distance"]) / (pt["distance"] - prev["distance"])
            return (1 - a) * prev["damage"] + a * pt["damage"]
    return graph[-1]["damage"]


def classify_hits(x, y, target_cy):
    """Return hit part index (-1 = miss) for impact points relative to aim point."""
    part = np.full(x.shape, -1, dtype=np.int8)
    # evaluate highest precedence number first so lower precedence overwrites
    order = sorted(range(len(HITBOXES)), key=lambda i: -HITBOXES[i][5])
    for i in order:
        _, cx, cy, hw, hh, _ = HITBOXES[i]
        dx = np.maximum(np.abs(x - cx) - hw, 0)
        dy = np.maximum(np.abs(y - (cy + target_cy)) - hh, 0)
        inside = dx * dx + dy * dy < HITBOX_RADIUS ** 2 + 1e-12
        part = np.where(inside, i, part)
    return part


@dataclass
class SimResult:
    plan: ShotPlan
    impacts: np.ndarray        # (runs, shots, pellets, 2) studs relative to aim point (x right, y up)
    parts: np.ndarray          # (runs, shots, pellets) hitbox index or -1
    damage: np.ndarray         # (runs, shots, pellets)
    travel_time: np.ndarray    # (runs, shots, pellets)
    track: list = field(default_factory=list)
    target_cy: float = 0.0
    dmg_values: dict = field(default_factory=dict)
    rays: dict | None = None   # first shot's rays when SimSettings.keep_rays (see one_shot_distances)


def simulate(cfg: WeaponConfig, st: SimSettings) -> SimResult:
    stats = cfg.stats
    recoil = cfg.recoil
    rng = np.random.default_rng(st.seed)
    R = max(1, int(st.runs))
    plan = plan_shots(cfg, st)
    n = len(plan.fire_times)

    aiming = st.aiming
    cam = RecoilSpringGroup(recoil, "CameraBody", aiming, R)
    rot = RecoilSpringGroup(recoil, "Rotation", aiming, R)
    trans = RecoilSpringGroup(recoil, "Translation", aiming, R)
    groups = (cam, rot, trans)
    # camera head springs only shake the view; simulated for the replay track only
    head = RecoilSpringGroup(recoil, "CameraHead", aiming, R) if st.record_track else None
    head_rng = np.random.default_rng(None if st.seed is None else st.seed + 7919)

    stability = STANCE_STABILITY.get(st.stance, 0.0)
    fms = stats.get("firemodestability")
    fidx = firemode_index(stats, st)
    fm_stab = fms[fidx] if isinstance(fms, list) and fidx < len(fms) else 0.0
    mult = (1 - (fm_stab or 0)) * (1 - stability)

    # hip-fire spread + crosshair springs
    hip = not aiming
    spread_spring = VecSpringArray(R, 1)
    spread_spring.d[:] = stats.get("hipfirestability") or 0.7
    spread_spring.s[:] = stats.get("hipfirespreadrecover") or 1
    crosssize = stats.get("crosssize") or 1
    cross = ScalarSpring(crosssize, d=stats.get("crossdamper") or 0.8, s=stats.get("crossspeed") or 10, target=crosssize)
    hipfirespread = stats.get("hipfirespread") or 0
    hipfirerecover = stats.get("hipfirespreadrecover") or 0
    crossexp = stats.get("crossexpansion") or 0

    # pellets
    pellets = int(stats.get("pelletcount") or 1)
    spread = stats.get("spread")
    choke = stats.get("choke")
    xbias = (stats.get("xbias") or 1) if choke else 1
    ybias = (stats.get("ybias") or 1) if choke else 1
    sampler = GaussianSampler()
    sample_idx = rng.integers(0, 100000, size=R)

    D = float(st.distance)
    speed = float(stats.get("bulletspeed") or 2000)
    baccel = float(stats.get("bulletaccel") or 0)
    g = GRAVITY if st.gravity else 0.0
    target_cy = -(st.aim_offset if st.aim_offset is not None else AIM_POINTS.get(st.aim_point, 0.0))

    impacts = np.zeros((R, n, pellets, 2))
    ttime = np.zeros((R, n, pellets))
    track = []
    rays = None

    # Build event list: (time, order, kind, shot_index). Within a frame: sample(0) -> recovery(1) -> impulse(2)
    events = []
    for i in range(n):
        events.append((plan.sample_times[i], 0, "sample", i))
        events.append((plan.impulse_times[i], 2, "impulse", i))
    if st.record_track and (n or st.track_end):
        end = max(plan.sample_times[-1], plan.impulse_times[-1]) + 0.6 if n else 0.0
        if st.track_end:
            end = max(end, float(st.track_end))
        f = max(0, math.floor((st.track_start or 0.0) * st.fps))
        # every frame while the gun is kicking; every 4th frame while it just
        # settles (springs move smoothly then), which keeps replies small and fast
        shots = sorted(set(plan.impulse_times))
        while f / st.fps <= end:
            tf = f / st.fps
            i = bisect.bisect_right(shots, tf) - 1
            busy = (i >= 0 and tf - shots[i] < 0.6) or (i + 1 < len(shots) and shots[i + 1] - tf < 0.05)
            if busy or f % 4 == 0:
                events.append((tf, 1, "track", f))
            f += 1
    events.sort(key=lambda e: (round(e[0], 9), e[1]))

    # where bullets leave the gun (FirearmObject.fire): the barrel at the hip, the
    # sight part when aimed. The recoil springs turn the gun about its pivot (the
    # main part's place in front of the camera), not about the camera, so the fire
    # point is pivot + spread * (translation + rotation * part offset). Without a
    # gun model (pose None) bullets start at the camera, as before.
    fp = (getattr(cfg, "pose", None) or {}).get("aim" if aiming else "hip")
    if fp:
        f_P = np.asarray(fp["P"], float)
        f_Ra = np.asarray(fp["Ra"], float)
        f_w = np.asarray(fp["w"], float)
        f_Rf = np.asarray(fp["Rf"], float)
    else:
        f_P = np.zeros(3); f_Ra = np.eye(3); f_w = np.zeros(3); f_Rf = np.eye(3)

    fps = st.fps

    def apply_recovery_until(time):
        """Process per-frame recovery checks for all frames up to and including `time`."""
        for gp in groups:
            while True:
                tr = gp.next_recovery_time()
                if tr == math.inf:
                    break
                # first frame strictly after tr
                fr = math.floor(tr * fps + 1e-9) + 1
                ft = fr / fps
                if ft > time + 1e-9:
                    break
                before = gp.next_recovery_time()
                gp.check_recovery(ft)
                if gp.next_recovery_time() == before:  # numerical safety: never spin
                    gp.check_recovery(ft, force_until=before)

    def frame_matrices(time, with_spread=True):
        """Rotation from the sight frame to the world, and from the gun's
        translation frame to the world (camera body * hip spread * gun rotation)."""
        Mb = aa_to_mat(cam.position(time))
        if hip and with_spread:
            Mb = Mb @ aa_to_mat(spread_spring.position_sum(time))
        M = Mb @ aa_to_mat(rot.position(time))
        return M, Mb

    def aim_direction(time, with_spread=True):
        M, Mb = frame_matrices(time, with_spread)
        d = -M[:, :, 2]
        o = np.einsum("rij,rj->ri", Mb, trans.position(time))
        return d, o

    for time, _order, kind, i in events:
        if kind == "sample":
            apply_recovery_until(time - 1e-6)
            M, Mb = frame_matrices(time)
            if fp:
                Mc = aa_to_mat(cam.position(time))
                Rs = aa_to_mat(spread_spring.position_sum(time)) if hip else np.eye(3)[None]
                Rr = aa_to_mat(rot.position(time))
                local_pt = trans.position(time) + np.einsum("rij,j->ri", Rr, f_w)
                o = np.einsum("rij,rj->ri", Mc, f_P[None] + np.einsum("ij,rj->ri", f_Ra, np.einsum("rij,rj->ri", np.broadcast_to(Rs, Rr.shape), local_pt)))
                # the firing part's orientation: camera * mainoffset * spread * gun rotation * part
                M = np.einsum("rij,jk->rik", Mc, f_Ra) @ np.broadcast_to(Rs, Rr.shape) @ Rr @ f_Rf
            else:
                o = np.einsum("rij,rj->ri", Mb, trans.position(time))
            if spread:
                local = np.empty((R, pellets, 3))
                for k in range(pellets):
                    sx, sy, sample_idx = sampler.points(sample_idx)
                    local[:, k, 0] = spread * xbias * sx
                    local[:, k, 1] = spread * ybias * sy
                local[:, :, 2] = -1.0
                local /= np.linalg.norm(local, axis=2, keepdims=True)
                dk = np.einsum("rij,rpj->rpi", M, local)
            else:
                dk = np.repeat(-M[:, None, :, 2], pellets, axis=1)
            vel = speed * dk
            acc = baccel * dk + np.array([0.0, g, 0.0])
            ox, oy, oz = o[:, None, 0], o[:, None, 1], o[:, None, 2]
            tt = _time_to_plane(np.broadcast_to(oz, vel[..., 2].shape), vel[..., 2], acc[..., 2], -D)
            with np.errstate(invalid="ignore"):  # bullets that never reach the target: inf * 0 -> nan (a miss)
                impacts[:, i, :, 0] = ox + vel[..., 0] * tt + 0.5 * acc[..., 0] * tt * tt
                impacts[:, i, :, 1] = oy + vel[..., 1] * tt + 0.5 * acc[..., 1] * tt * tt
            ttime[:, i, :] = tt
            if i == 0 and st.keep_rays:
                rays = {"o": o.copy(), "vel": vel.copy(), "acc": np.broadcast_to(acc, vel.shape).copy()}
        elif kind == "impulse":
            apply_recovery_until(time)
            for gp in groups:
                # camera (body and head) kicks are halved on a pure controller
                gp.impulse(time, mult * (0.5 if st.controller and gp is cam else 1.0), rng)
            if head is not None:
                head.check_recovery(time)
                head.impulse(time, mult * (0.5 if st.controller else 1.0), head_rng)
            if hip:
                cs = cross.pos(time)
                spread_spring.advance(time)
                kick = 0.5 * (1 - stability) * hipfirespread * hipfirerecover * cs / crosssize
                rv = rng.random((R, 2)) * 2 - 1
                spread_spring.v[:, 0, 0] += kick * rv[:, 0]
                spread_spring.v[:, 0, 1] += kick * rv[:, 1]
                cross.advance(time)
                cross.v += crossexp
        elif kind == "track":
            apply_recovery_until(time)
            d, _ = aim_direction(time, with_spread=True)
            tt = D / max(-d[0, 2], 1e-6)
            # [time, aim x, aim y, body aa(3), gun rot aa(3), gun trans(3), spread aa(3), head aa(3)]
            body = cam.position(time)[0]
            rp = rot.position(time)[0]
            tp = trans.position(time)[0]
            sp = spread_spring.position_sum(time)[0] if hip else np.zeros(3)
            if head is not None:
                head.check_recovery(time)
                hp = head.position(time)[0]
            else:
                hp = np.zeros(3)
            row = [round(time, 4), float(d[0, 0] * tt), float(d[0, 1] * tt)]
            row += [round(float(v), 6) for v in (*body, *rp, *tp, *sp, *hp)]
            track.append(row)

    # hits & damage
    parts = classify_hits(impacts[..., 0], impacts[..., 1], target_cy)
    graph = stats.get("damageGraph") or []
    base_dmg = interpolate_damage(graph, D)
    mh = stats.get("multhead") or 1
    mt = stats.get("multtorso") or 1
    ml = stats.get("multlimb") or 1
    mult_by_part = np.array([mh, mt, ml, ml, ml, ml, 0.0])
    lifetime_ok = ttime <= BULLET_LIFETIME
    damage = np.where((parts >= 0) & lifetime_ok, base_dmg * mult_by_part[parts], 0.0)
    parts = np.where(lifetime_ok, parts, -1)
    return SimResult(plan, impacts, parts, damage, ttime, track, target_cy,
                     {"base": base_dmg, "head": base_dmg * mh, "torso": base_dmg * mt, "limb": base_dmg * ml}, rays)


def _time_to_plane(o, v, a, target):
    """Smallest positive t with o + v t + a t^2 / 2 = target (vectorised)."""
    a = np.broadcast_to(a, o.shape).astype(float)
    lin = np.abs(a) < 1e-9
    with np.errstate(divide="ignore", invalid="ignore"):
        t_lin = (target - o) / v
        A = 0.5 * a
        B = v
        C = o - target
        disc = B * B - 4 * A * C
        sq = np.sqrt(np.maximum(disc, 0))
        t1 = (-B - sq) / (2 * A)
        t2 = (-B + sq) / (2 * A)
        t_q = np.where((t1 > 0) & ((t1 < t2) | (t2 <= 0)), t1, t2)
        t_q = np.where(disc < 0, np.inf, t_q)
    t = np.where(lin, t_lin, t_q)
    return np.where(t > 0, t, np.inf)
