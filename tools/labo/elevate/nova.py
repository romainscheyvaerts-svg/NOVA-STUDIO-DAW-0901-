"""Client Python du cœur TypeScript « Mastering Transient » exécuté par Node (même code que l'AudioWorklet)."""
import base64
import json
import os
import subprocess

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
CREATE_NO_WINDOW = 0x08000000
SR = 48000


class MasterTransient:
    def __init__(self, params=None, profile=None):
        self.params = dict(params or {})
        self.profile = profile
        bundle = os.path.join(HERE, "build", f"mt_server_{os.getpid()}.mjs")
        os.makedirs(os.path.dirname(bundle), exist_ok=True)
        esb = os.path.join(REPO, "node_modules", ".bin", "esbuild.cmd")
        r = subprocess.run([esb, os.path.join(HERE, "mt_server.ts"), "--bundle", "--platform=node", "--format=esm",
                            f"--outfile={bundle}", "--log-level=error"], cwd=REPO, capture_output=True, text=True,
                           creationflags=CREATE_NO_WINDOW)
        if r.returncode != 0:
            raise RuntimeError("esbuild : " + r.stderr[-2000:])
        self.bundle = bundle
        self._start()
        self.last = {}

    def _start(self):
        self.p = subprocess.Popen(["node", "--max-old-space-size=4096", self.bundle], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                  stderr=subprocess.DEVNULL, creationflags=CREATE_NO_WINDOW, cwd=REPO)

    def configure(self, params):
        self.params = dict(params)
        return self.params

    def run(self, x, params=None, profile=None):
        x = np.ascontiguousarray(x, dtype=np.float32)
        req = {"params": params if params is not None else self.params, "profile": profile or self.profile, "sr": SR,
               "n": int(x.shape[1]), "data": base64.b64encode(x.tobytes()).decode("ascii")}
        line = b""
        for _ in range(2):  # un redémarrage si Node s'est arrêté
            try:
                self.p.stdin.write((json.dumps(req) + "\n").encode())
                self.p.stdin.flush()
                line = self.p.stdout.readline()
            except OSError:
                line = b""
            if line:
                break
            self._start()
        if not line:
            raise RuntimeError("Node arrêté")
        r = json.loads(line)
        if r.get("error"):
            raise RuntimeError(r["error"])
        self.last = {k: v for k, v in r.items() if k != "data"}
        return np.frombuffer(base64.b64decode(r["data"]), dtype=np.float32).reshape(2, -1).astype(np.float64)

    def close(self):
        try:
            self.p.stdin.close()
            self.p.wait(5)
        except Exception:
            self.p.kill()


def transient_params(em, adaptive=0.0, bands=None):
    return {"emphasis": em, "adaptive": adaptive, "bandTransient": list(bands or [100.0] * 26), "transientOn": True,
            "limiterOn": False, "clipperOn": False, "limitGainDb": 0.0, "protect": False}


def romain_params():
    import sys
    sys.path.insert(0, os.path.dirname(HERE))
    from bancs import elevate as banc
    return {"emphasis": 27.0, "adaptive": 50.0, "bandTransient": banc.romain_band_transient(), "bandGainDb": [0.0] * 26,
            "limitGainDb": 8.0, "speedMs": 1.0, "adaptiveGainDb": 6.0, "adaptiveSpeed": 100.0, "ceilingDb": -0.1,
            "truePeak": True, "clipDriveDb": 0.0, "clipShape": 0.0, "transientOn": True, "limiterOn": True, "clipperOn": True}
