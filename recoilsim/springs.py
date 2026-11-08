"""Damped spring maths used by the game's recoil system (vectorised with numpy).

The game evaluates springs analytically (no per-frame integration): given
damping d, speed s, position p0, velocity v0 and target t, the state after dt
is a closed-form expression. This file reproduces Vector3Spring / Spring
exactly; every array dimension beyond the last is an independent simulation run.
"""
from __future__ import annotations

import math

import numpy as np


def spring_coeffs(d: float, s: float, dt: float):
    """Return (pp, pv, vp, vv, pt, vt) so that, for target T:
        p' = pp*p + pv*v + pt*T
        v' = vp*p + vv*v + vt*T
    Mirrors getPV in Vector3Spring/Spring."""
    if s == 0:
        return 1.0, dt, 0.0, 1.0, 0.0, 0.0
    x = s * dt
    d2 = d * d
    if d2 < 1:
        w = math.sqrt(1 - d2)
        e = math.exp(-d * x) / w
        co = e * math.cos(w * x)
        si = e * math.sin(w * x)
    elif d2 == 1:
        co = math.exp(-d * x)
        w = 1.0
        si = co * x
    else:
        w = math.sqrt(d2 - 1)
        a = math.exp((-d + w) * x) / (2 * w)
        b = math.exp((-d - w) * x) / (2 * w)
        co = a + b
        si = a - b
    pp = w * co + d * si
    pt = 1 - pp
    pv = si / s
    vp = -s * si
    vt = s * si
    vv = w * co - d * si
    return pp, pv, vp, vv, pt, vt


class ScalarSpring:
    """Deterministic scalar Spring (used for heat fire-rate)."""

    def __init__(self, p=0.0, d=1.0, s=1.0, target=None):
        self.p = float(p)
        self.v = 0.0
        self.d = d
        self.s = s
        self.t = float(p if target is None else target)
        self.time = 0.0

    def advance(self, time):
        dt = time - self.time
        if dt > 0:
            pp, pv, vp, vv, pt, vt = spring_coeffs(self.d, self.s, dt)
            p, v = self.p, self.v
            self.p = pp * p + pv * v + pt * self.t
            self.v = vp * p + vv * v + vt * self.t
            self.time = time

    def pos(self, time):
        self.advance(time)
        return self.p


class VecSpringArray:
    """A batch of independent 3-axis springs with target 0.

    Shapes: p, v -> (runs, layers, 3); d, s -> (layers, 3).
    """

    def __init__(self, runs: int, layers: int, track_target=None):
        self.p = np.zeros((runs, layers, 3))
        self.v = np.zeros((runs, layers, 3))
        self.d = np.ones((layers, 3))
        self.s = np.ones((layers, 3))
        self.target = np.zeros((layers, 3)) if track_target is None else track_target
        self.time = 0.0
        self._cache = {}

    def _coeffs(self, dt):
        key = (dt, self.d.tobytes(), self.s.tobytes())
        c = self._cache.get(key)
        if c is None:
            L = self.d.shape[0]
            c = np.empty((6, L, 3))
            for i in range(L):
                for j in range(3):
                    c[:, i, j] = spring_coeffs(float(self.d[i, j]), float(self.s[i, j]), dt)
            if len(self._cache) > 512:
                self._cache.clear()
            self._cache[key] = c
        return c

    def advance(self, time):
        dt = time - self.time
        if dt <= 0:
            return
        pp, pv, vp, vv, pt, vt = self._coeffs(round(dt, 12))
        p, v = self.p, self.v
        self.p = pp * p + pv * v + pt * self.target
        self.v = vp * p + vv * v + vt * self.target
        self.time = time

    def position_sum(self, time):
        """Sum over layers -> (runs, 3)."""
        self.advance(time)
        return self.p.sum(axis=1)
