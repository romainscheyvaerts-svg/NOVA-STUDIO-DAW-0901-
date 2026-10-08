"""Références du test « identique au portage du labo » (tests/fixtures/analogComp_ref.json) :
sorties du portage Python (numba) sur des paliers de sinus, par segment."""
import importlib, json, os, sys
import numpy as np
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from modeles import analog_comp as ac
SR = 48000
SIGNAL = [[0.3, -50, 220], [0.4, -12, 220], [0.3, -30, 1000], [0.4, -6, 1000], [0.3, -45, 3000], [0.3, -20, 120]]
CASES = [
    ("OPTO_VINTAGE", "modeles.cl1b_profil", {"threshold": -30, "ratio": 4, "attack": 3, "release": 3, "mode": 2, "output": 2, "mix": 100}),
    ("OPTO_VINTAGE", "modeles.cl1b_profil", {"threshold": -25, "ratio": 2, "attack": 5, "release": 4, "mode": 1, "output": 0, "mix": 80, "scLowCut": 80}),
    ("FET76", "modeles.fet76_profil", {"input": -20, "output": -18, "attack": 5, "release": 6, "ratio": 4, "slo": 0, "mix": 100}),
    ("LEVELER2A", "modeles.la2a_profil", {"peakReduction": 55, "gain": 40, "limit": 0, "emphasis": 20, "mix": 100}),
    ("VOXSTRIP", "modeles.voxbox_profil", {}),
]


def signal():
    parts, ph = [], 0.0
    for d, db, f in SIGNAL:
        n = int(round(d * SR))
        k = np.arange(n)
        parts.append(10 ** (db / 20) * np.sin(ph + 2 * np.pi * f / SR * k))
        ph += 2 * np.pi * f / SR * n
    return np.concatenate(parts).astype(np.float32).astype(np.float64)


def main():
    x = signal()
    out = {"cases": []}
    for kind, mod, params in CASES:
        try:
            prof = importlib.import_module(mod)
        except Exception:
            continue
        if kind == "VOXSTRIP" and not params:
            params = dict(getattr(prof, "DEFAULT_NOVA", {}))
        P, l0, dl, tab = prof.nova_to_internal(params, prof.load_fit())
        y, _ = ac.process(np.vstack([x, x]), P, float(l0), float(dl), tab)
        y = y[0].astype(np.float32).astype(np.float64)
        nseg = 16
        seg = len(x) // nseg
        rms = [float(10 * np.log10(np.mean(y[s * seg:(s + 1) * seg] ** 2) + 1e-30)) for s in range(nseg)]
        out["cases"].append({"kind": kind, "params": params, "signal": SIGNAL, "rms_db": rms})
    dest = os.path.join(HERE, "..", "..", "tests", "fixtures", "analogComp_ref.json")
    with open(dest, "w", encoding="utf-8") as f:
        json.dump(out, f, indent=1)
    print("écrit", os.path.abspath(dest), len(out["cases"]), "cas")


if __name__ == "__main__":
    main()
