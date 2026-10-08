"""Tour 3 : vitesse adaptative (prototype) : relâchement × as_mul × (centroïde/1 kHz)^(−as_k) × (1 + as_gr·réduction dB),
anticipation × as_la. Calage CMA sur lim_g8_a0_s100 (batterie + mix)."""
import json, math, os, sys
import numpy as np
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import tour3_proto_td as P
T3 = P.T3
base = json.load(open(os.path.join(T3, "fit_td2_rdb1.json")))["prm"]
X = {nm: (np.load(os.path.join(P.AUD, f"in16_{nm}.npy")).astype(float), np.load(os.path.join(P.AUD, f"lim_g8_a0_s100_{nm}.npy")).astype(float)) for nm in ("batterie", "mix")}
SPEC = [("as_mul", 0.1, 10.0), ("as_k", -2.0, 2.0), ("as_gr", -0.3, 2.0), ("as_la", 0.3, 3.0)]


def unpack(z):
    return {k: lo + (hi - lo) / (1 + math.exp(-v)) for (k, lo, hi), v in zip(SPEC, z)}


def cost(z, verbose=False):
    q = unpack(z)
    p = dict(base, as_ref=1000.0, **{k: v for k, v in q.items() if k != "as_la"})
    p["la_ms"] = base["la_ms"] * q["as_la"]; p["avg_ms"] = base["avg_ms"] * q["as_la"]
    r = [P.null(yv, P.run(x, p, 1.0, asp=1.0)) for x, yv in X.values()]
    if verbose:
        print(q, [round(v, 2) for v in r], flush=True)
    return float(np.mean(r))


if __name__ == "__main__":
    import ctypes, cma
    k = ctypes.windll.kernel32; k.SetPriorityClass(k.GetCurrentProcess(), 0x4000)
    z0 = [math.log((v - lo) / (hi - v)) for (kk, lo, hi), v in zip(SPEC, (1.0, 0.0, 0.0, 1.0))]
    es = cma.CMAEvolutionStrategy(z0, 0.8, {"popsize": 8, "maxiter": 25, "verbose": -9})
    best = (None, 1e9)
    while not es.stop():
        Xs = es.ask(); F = [cost(z) for z in Xs]; es.tell(Xs, F)
        i = int(np.argmin(F))
        if F[i] < best[1]:
            best = (Xs[i], F[i]); json.dump({"cost": F[i], "prm": unpack(Xs[i])}, open(os.path.join(T3, "fit_as.json"), "w"), indent=1)
            print(es.countiter, round(F[i], 2), flush=True)
    cost(best[0], True)
