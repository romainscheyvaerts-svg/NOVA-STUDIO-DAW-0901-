"""Processeurs du banc : VST3 réel (pedalboard, sans fenêtre) et effet NOVA
(cœur DSP TypeScript exécuté par Node, ou vrai moteur NOVA dans Chrome headless)."""
from __future__ import annotations

import base64
import json
import os
import subprocess
import sys
from typing import Any, Dict, Optional

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import host  # noqa: E402

SR = 48000
CREATE_NO_WINDOW = 0x08000000


class VstProc:
    def __init__(self, plugin_file: str, base: Optional[Dict[str, Any]] = None):
        self.plugin_file = plugin_file
        self.plugin = host.open_plugin(plugin_file)
        self.name = getattr(self.plugin, "name", plugin_file)
        self.base = dict(base or {})
        self.applied: Dict[str, str] = {}
        if self.base:
            self.applied = host.set_params(self.plugin, self.base)

    @property
    def latency(self) -> int:
        return host.latency_of(self.plugin)

    def configure(self, settings: Dict[str, Any]) -> Dict[str, str]:
        s = dict(self.base)
        s.update(settings or {})
        self.applied = host.set_params(self.plugin, s)
        return self.applied

    def run(self, x: np.ndarray) -> np.ndarray:
        # Remise à zéro de l'état + quelques ms de silence en tête : certains
        # plugins (UADx) ne prennent leurs réglages qu'à la préparation.
        pre = int(0.05 * SR)
        xx = np.concatenate([np.zeros((x.shape[0], pre)), x], axis=1)
        y = host.process(self.plugin, xx, SR, block=512, reset=True)
        return y[:, pre:pre + x.shape[1]]

    def close(self):
        self.plugin = None


class NodeCoreProc:
    """Cœur DSP NOVA (le MÊME code TypeScript que l'AudioWorklet), exécuté par
    Node via un petit serveur persistant (tools/labo/nova_core_server.mjs,
    construit par esbuild). Réglages = paramètres NOVA de l'effet."""

    def __init__(self, kind: str, base: Optional[Dict[str, Any]] = None, repo: Optional[str] = None):
        self.kind = kind
        self.name = kind + "-node"
        self.base = dict(base or {})
        self.settings: Dict[str, Any] = dict(self.base)
        self.repo = repo or os.path.abspath(os.path.join(HERE, "..", ".."))
        bundle = os.path.join(HERE, "build", "nova_cores.mjs")
        self._build(bundle)
        self.p = subprocess.Popen(["node", bundle], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                  stderr=subprocess.PIPE, creationflags=CREATE_NO_WINDOW, cwd=self.repo)
        self._latency = 0

    def _build(self, bundle):
        os.makedirs(os.path.dirname(bundle), exist_ok=True)
        esb = os.path.join(self.repo, "node_modules", ".bin", "esbuild.cmd")
        src = os.path.join(HERE, "nova_core_server.ts")
        r = subprocess.run([esb, src, "--bundle", "--platform=node", "--format=esm", f"--outfile={bundle}",
                            "--log-level=error"], cwd=self.repo, capture_output=True, text=True,
                           creationflags=CREATE_NO_WINDOW, shell=False)
        if r.returncode != 0:
            raise RuntimeError("esbuild : " + r.stderr[-2000:])

    @property
    def latency(self) -> int:
        return self._latency

    def configure(self, settings: Dict[str, Any]) -> Dict[str, Any]:
        s = dict(self.base)
        s.update(settings or {})
        self.settings = s
        return s

    def run(self, x: np.ndarray) -> np.ndarray:
        x = np.ascontiguousarray(x, dtype=np.float32)
        req = {"kind": self.kind, "params": self.settings, "sr": SR, "n": int(x.shape[1]),
               "data": base64.b64encode(x.tobytes()).decode("ascii")}
        self.p.stdin.write((json.dumps(req) + "\n").encode())
        self.p.stdin.flush()
        line = self.p.stdout.readline()
        if not line:
            raise RuntimeError("serveur Node arrêté : " + self.p.stderr.read().decode(errors="replace")[-2000:])
        r = json.loads(line)
        if r.get("error"):
            raise RuntimeError(r["error"])
        self._latency = int(r.get("latency", 0))
        y = np.frombuffer(base64.b64decode(r["data"]), dtype=np.float32).reshape(2, -1).astype(np.float64)
        L = self._latency
        if L > 0:   # compensation de la latence déclarée, comme le PDC de NOVA
            y = np.concatenate([y[:, L:], np.zeros((2, L))], axis=1)
        return y

    def close(self):
        try:
            self.p.stdin.close()
            self.p.wait(5)
        except Exception:
            self.p.kill()
