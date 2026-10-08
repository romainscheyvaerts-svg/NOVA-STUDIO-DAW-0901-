"""Tour 3 : le cœur TypeScript et le portage Python donnent-ils la même chose avec le
détecteur à deux voies ? (vecteur P calculé côté Python, signal de paliers + salves,
mono et stéréo couplée). Usage : python -m tour3.d3_check [best.json groupe]"""
import json
import os
import subprocess
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
from modeles import analog_comp as ac  # noqa: E402
from modeles import cl1b_profil as prof  # noqa: E402
from tour3 import fit3  # noqa: E402

REPO = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
CREATE_NO_WINDOW = 0x08000000


def signal():
    sr = 48000
    parts = []
    for d, db, f in [(0.2, -60, 220), (0.3, -10, 220), (0.2, -30, 1000), (0.05, -3, 1000), (0.4, -25, 120), (0.3, -70, 3000)]:
        t = np.arange(int(d * sr)) / sr
        parts.append(10 ** (db / 20) * np.sin(2 * np.pi * f * t))
    return np.concatenate(parts).astype(np.float32).astype(np.float64)


def main(best=None, group="cl1b_fm"):
    fit = prof.load_fit()
    d2 = json.load(open(best, encoding="utf-8"))["d2"] if best else fit3.init_d2(group)
    d2 = dict(d2, pow=0.7)  # exposant quelconque : chemin Math.pow
    fit.setdefault("dyn2", {})
    fit["dyn2"] = dict(fit.get("dyn2") or {}, fm=d2)
    P, l0, dl, tab = prof.nova_to_internal({"threshold": -25, "ratio": 4, "attack": 3, "release": 3, "mode": 1, "output": 0, "mix": 100}, fit)
    P[ac.P_LINK] = 1.0
    x = signal()
    bundle = os.path.join(HERE, "..", "build", "d3_core.mjs")
    esb = os.path.join(REPO, "node_modules", ".bin", "esbuild.cmd")
    subprocess.run([esb, os.path.join(HERE, "d3_core.ts"), "--bundle", "--platform=node", "--format=esm", f"--outfile={bundle}",
                    "--log-level=error"], cwd=REPO, check=True, creationflags=CREATE_NO_WINDOW)
    worst = 0.0
    for stereo in (False, True):
        req = os.path.join(HERE, "..", "build", "d3_req.json")
        json.dump({"P": P.tolist(), "tab": np.asarray(tab).tolist(), "l0": l0, "dl": dl, "x": x.tolist(), "stereo": stereo}, open(req, "w"))
        r = subprocess.run(["node", bundle, req], cwd=REPO, capture_output=True, text=True, creationflags=CREATE_NO_WINDOW)
        out = json.loads(r.stdout)
        xr = x * (0.5 + 0.5 * np.cos(np.arange(len(x)) / 900)) if stereo else x
        xr = xr.astype(np.float32).astype(np.float64)
        y, _ = ac.process(np.vstack([x, xr]), P, float(l0), float(dl), np.ascontiguousarray(tab, dtype=np.float64))
        for ch, key in ((0, "y"), (1, "yr")):
            d = np.asarray(out[key]) - y[ch]
            e = 20 * np.log10(np.max(np.abs(d)) + 1e-30)
            worst = max(worst, e) if worst else e
            print(f"stéréo={stereo} canal {ch} : écart max {e:.1f} dBFS (sortie crête {20 * np.log10(np.max(np.abs(y[ch]))):.1f} dBFS)")
    return worst


if __name__ == "__main__":
    main(*sys.argv[1:])
