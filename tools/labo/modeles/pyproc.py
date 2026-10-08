"""Processeur Python (numba) branché sur le banc : même interface que VstProc."""
import numpy as np

from . import analog_comp as ac


class ModelProc:
    """`build(settings) -> (P, l0, dl, tab)` : profil d'un appareil."""

    def __init__(self, build, name="modele"):
        self.build = build
        self.name = name
        self.latency = 0
        self.cfg = None
        self.last_A = None

    def configure(self, settings):
        self.settings = dict(settings or {})
        self.cfg = self.build(self.settings)
        return self.settings

    def run(self, x):
        P, l0, dl, tab = self.cfg
        y, A = ac.process(np.ascontiguousarray(x, dtype=np.float64), P, float(l0), float(dl), tab)
        self.last_A = A
        return y

    def close(self):
        pass
