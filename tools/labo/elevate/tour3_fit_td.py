"""Tour 3 : calage CMA-ES du limiteur « dans le temps » (prototype Python) sur l'original :
batterie + mix (+8 dB, vitesse 1 et 5 ms, sans adaptatif) et loi statique à 100 Hz (vitesse 1 / 5).
Usage : python elevate/tour3_fit_td.py <rdb 0|1> <gens>"""
import json, math, os, sys
import numpy as np
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import tour3_proto_td as P
from tour3_mesure_lim import sine, SR

T3 = P.T3
SPEC = [("la_ms", 0.1, 6.0), ("avg_ms", 0.05, 6.0), ("rel_k", 0.05, 20.0), ("rel_a", 0.0, 3.0), ("hold_ms", 0.0, 4.0), ("thr", -1.5, 1.5),
        ("ela", -0.5, 1.5), ("eavg", -0.5, 1.5)]
DATA = {}


def load():
    if DATA:
        return DATA
    A = json.load(open(os.path.join(T3, "mesures_lim_A.json")))
    DATA["A"] = A
    for tag in ("lim_g8_noadapt", "lim_g8_s5"):
        for nm in ("batterie", "mix"):
            x = np.load(os.path.join(P.AUD, f"in16_{nm}.npy")).astype(np.float64)
            DATA[(tag, nm)] = (x, np.load(os.path.join(P.AUD, f"{tag}_{nm}.npy")).astype(np.float64))
    return DATA


def unpack(z, rdb):
    prm = {"rdb": rdb}
    for (k, lo, hi), v in zip(SPEC, z):
        prm[k] = lo + (hi - lo) / (1 + math.exp(-v))
    return prm


def cost(z, rdb, verbose=False):
    D = load()
    prm = unpack(z, rdb)
    res = {}
    e = []
    for key, sp in (("stat_100_s1", 1.0), ("stat_100_s5", 5.0), ("stat_1000_s1", 1.0)):
        for L, gv, _ in D["A"][key][::5]:
            x = sine(L, 100 if "100_" in key else 1000, 0.4)
            y = P.run(np.vstack([x, x]), prm, sp)[0]
            e.append(20 * np.log10(np.std(y[-SR // 8:]) / np.std(x[-SR // 8:])) - gv)
    res["stat_max"] = round(float(np.max(np.abs(e))), 3)
    c = 20 * float(np.mean(np.square(e)))
    for tag, sp in (("lim_g8_noadapt", 1.0), ("lim_g8_s5", 5.0)):
        for nm in ("batterie", "mix"):
            x, yv = D[(tag, nm)]
            nd = P.null(yv, P.run(x, prm, sp))
            res[f"{tag}_{nm}"] = round(nd, 2)
            c += nd * (0.35 if sp == 1.0 else 0.15)
    if verbose:
        print(json.dumps(prm), res, flush=True)
    return c


if __name__ == "__main__":
    import ctypes, cma
    k = ctypes.windll.kernel32; k.SetPriorityClass(k.GetCurrentProcess(), 0x4000)
    rdb = float(sys.argv[1]); gens = int(sys.argv[2])
    x0 = {"la_ms": 1.0, "avg_ms": 0.6, "rel_k": 0.5, "rel_a": 0.5, "hold_ms": 0.1, "thr": 0.05, "ela": 0.6, "eavg": 0.6}
    z0 = [math.log((x0[k] - lo) / (hi - x0[k])) for k, lo, hi in SPEC]
    es = cma.CMAEvolutionStrategy(z0, 0.8, {"popsize": 10, "maxiter": gens, "verbose": -9})
    best = (None, 1e9)
    out = os.path.join(T3, f"fit_td2_rdb{int(rdb)}.json")
    while not es.stop():
        X = es.ask(); F = [cost(z, rdb) for z in X]; es.tell(X, F)
        i = int(np.argmin(F))
        if F[i] < best[1]:
            best = (X[i], F[i]); json.dump({"cost": F[i], "prm": unpack(X[i], rdb)}, open(out, "w"), indent=1)
            print(es.countiter, round(F[i], 3), flush=True)
    cost(best[0], rdb, True)
