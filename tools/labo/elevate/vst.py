"""Processeur Elevate (VST3 réel, hors ligne, sans fenêtre) pour le banc."""
import os, sys
import numpy as np
LAB = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, LAB)
import host  # noqa
from bancs import elevate as banc  # noqa

SR = 48000


class Elevate:
    def __init__(self):
        self.plugin = host.open_plugin(banc.PLUGIN)
        self.applied = {}

    def configure(self, s):
        # l'ordre compte peu ; on applique deux fois (certains réglages dépendent d'autres)
        self.applied = host.set_params(self.plugin, s)
        self.applied = host.set_params(self.plugin, s)
        return self.applied

    @property
    def latency(self):
        return host.latency_of(self.plugin)

    def run(self, x, pre_s=0.2):
        """x (2, n) -> (2, n) aligné (pedalboard compense la latence annoncée)."""
        pre = int(pre_s * SR)
        xx = np.concatenate([np.zeros((x.shape[0], pre)), x], axis=1)
        y = host.process(self.plugin, xx, SR, block=512, reset=True)
        return y[:, pre:pre + x.shape[1]]
