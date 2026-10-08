"""Tour 3 : calage CMA-ES du limiteur NOVA (cœur TypeScript via Node, la vérité terrain) sur les rendus
de l'original : +8 dB vitesse 1 et 5, adaptatif 6 dB, vitesse adaptative 100 %, réglage de Romain (poids 3),
batterie + mix, et loi statique (sinus 1 kHz / 100 Hz). Usage : python elevate/tour3_fit_ts.py <base.json> <gens> <sortie.json>"""
import json
import math
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

SPEC = [("limTdLa1", 0.1, 3.0), ("limTdAtt1", 0.05, 3.0), ("limTdRelK", 0.02, 3.0), ("limTdRelA", 0.0, 2.0),
        ("limHoldMs", 0.0, 1.0), ("limTdAsMul", 0.1, 10.0), ("limTdAsK", -1.0, 4.0), ("limTdAsLa", 0.05, 3.0),
        ("limAdBeta", 0.0, 0.9), ("limAdSlowMs", 1.0, 5000.0), ("limRelK", 0.01, 50.0), ("limOwnDb", -6.0, 4.0)]
W = {"lim_g8_noadapt": 1.0, "lim_g8_s5": 0.5, "lim_g8_a6_s0": 1.0, "lim_g8_a0_s100": 1.0, "lim_romain": 3.0}
_S = {}


def unpack(z, base):
    p = dict(base)
    for (k, lo, hi), v in zip(SPEC, z):
        p[k] = lo + (hi - lo) / (1 + math.exp(-max(min(v, 30), -30)))
    return p


def pack(p):
    out = []
    for k, lo, hi in SPEC:
        v = min(max(p.get(k, (lo + hi) / 2), lo + 1e-6 * (hi - lo)), hi - 1e-6 * (hi - lo))
        out.append(math.log((v - lo) / (hi - v)))
    return out


def _init():
    import ctypes
    k = ctypes.windll.kernel32
    k.SetPriorityClass(k.GetCurrentProcess(), 0x4000)
    import nova
    import tour3_scan as S
    from tour3_eval_lim import lim
    from tour3_mesure_lim import sine, SR
    _S["m"] = nova.MasterTransient()
    _S["S"] = S
    A = json.load(open(r"D:\1 WORK\CONTENU\nova-labo\elevate\tour3\mesures_lim_A.json"))
    st = []
    for key, f in (("stat_1000_s1", 1000), ("stat_100_s1", 100)):
        for L, gv, _ in A[key][::10]:
            x = sine(L, f, 0.4)
            st.append((np.vstack([x, x]), gv))
    _S["stat"] = st
    _S["lim"] = lim
    _S["SR"] = SR


def cost(args):
    z, base = args
    p = unpack(z, base)
    m, S = _S["m"], _S["S"]
    try:
        r = S.score(m, p, list(W))
        c = sum(W[k.rsplit("_", 1)[0]] * v for k, v in r.items()) / (2 * sum(W.values()))
        e = []
        for x, gv in _S["stat"]:
            y = m.run(x, _S["lim"](), p)[0]
            e.append(20 * np.log10(np.std(y[-_S["SR"] // 8:]) / np.std(x[0, -_S["SR"] // 8:])) - gv)
        c += 20 * float(np.mean(np.square(e)))
        return c, r
    except Exception as ex:  # noqa: BLE001
        return 100.0, {"err": str(ex)[:200]}


if __name__ == "__main__":
    import ctypes
    import cma
    from multiprocessing import Pool
    k = ctypes.windll.kernel32
    k.SetPriorityClass(k.GetCurrentProcess(), 0x4000)
    base = json.load(open(sys.argv[1]))
    gens = int(sys.argv[2])
    out = sys.argv[3]
    es = cma.CMAEvolutionStrategy(pack(base), 0.5, {"popsize": 12, "maxiter": gens, "verbose": -9})
    best = (None, 1e9)
    with Pool(5, initializer=_init) as pool:
        while not es.stop():
            X = es.ask()
            R = pool.map(cost, [(z, base) for z in X])
            F = [r[0] for r in R]
            es.tell(X, F)
            i = int(np.argmin(F))
            if F[i] < best[1]:
                best = (X[i], F[i])
                json.dump({"cost": F[i], "nulls": R[i][1], "profil": unpack(X[i], base)}, open(out, "w"), indent=1)
            print(es.countiter, round(F[i], 3), round(best[1], 3), R[i][1], flush=True)
