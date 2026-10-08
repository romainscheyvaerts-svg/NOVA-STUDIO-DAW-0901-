"""Tour 3 : balayage rapide de paramètres du profil (cœur TS) sur quelques cas réels du limiteur."""
import json, os, sys
import numpy as np
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import nova
from tour3_eval_lim import lim, null, AUD
CASES = {"lim_g8_noadapt": lim(), "lim_g8_s5": lim(speed=5.0), "lim_g8_a6_s0": lim(ad=6.0), "lim_g8_a0_s100": lim(asp=100.0),
         "lim_romain": lim(ad=6.0, asp=100.0)}
_D = {}


def data(tag, nm):
    k = (tag, nm)
    if k not in _D:
        _D[k] = (np.load(os.path.join(AUD, f"in16_{nm}.npy")).astype(np.float64), np.load(os.path.join(AUD, f"{tag}_{nm}.npy")).astype(np.float64))
    return _D[k]


def score(m, prof, tags):
    out = {}
    for t in tags:
        for nm in ("batterie", "mix"):
            x, yv = data(t, nm)
            out[f"{t}_{nm}"] = round(null(yv, m.run(x, CASES[t], prof)), 2)
    return out


if __name__ == "__main__":
    base = json.load(open(sys.argv[1]))
    key = sys.argv[2]; vals = [float(v) for v in sys.argv[3].split(",")]; tags = sys.argv[4].split(",")
    m = nova.MasterTransient()
    for v in vals:
        p = dict(base); p[key] = v
        print(key, v, score(m, p, tags), flush=True)
    m.close()
