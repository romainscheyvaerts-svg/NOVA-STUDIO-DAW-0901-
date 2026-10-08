"""
Tour 2 : Opto Vintage — la structure du tour 1 (cellule « A », deux étages,
cellules rapide / lente en parallèle pour le mode F/M) reste la meilleure pour
cet appareil ; ici on RECALE ses paramètres par CMA-ES sur de vraies voix et une
vraie batterie (modes Man et F/M ensemble, la table de relâchement leur est
commune), plus les sauts de niveau mesurés.

θ = multiplicateurs (log) des tables par bouton aux points d'ancrage + scalaires.
Usage : python -m tour2.fit_t1 [--gens N] [--workers W]   -> best_cl1b_t1.json ; --apply
"""
import argparse, copy, json, math, os, sys, time
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
from tour2.fitdyn import (GROUPS, load_real, load_steps, evaluate, import_prof, banc_mod, LABO)  # noqa: E402

GROUPS["cl1b_t1"] = {"banc": "cl1b", "prof": "modeles.cl1b_profil", "key": ("dyn2",),
                     "real": ["voix_man", "transitoires", "man_a5r5", "man_a0r0", "man_a8r8",
                              "romain_voix", "fm_a6r6", "fm_a1r1", "fm_batterie"],
                     "steps": ["c_att2.5", "c_att5", "c_att8", "c_rel2", "c_rel5", "c_rel8",
                               "c_fm_att3", "c_fm_att5", "c_fm_att7", "c_fm_rel5"], "knobs": {}}

ANCH = {"att_ms": ("att_knob", [0, 2, 4, 5, 5.5, 6.5, 8, 10]),
        "att_slew_k": ("att_knob", [0, 2, 4, 5, 6.5, 8, 10]),
        "rel_slew": (None, [0, 2, 4, 6, 8, 10]),
        "fm_att_ms": ("fm_knob", [0, 3, 5, 7, 10])}
SCAL = ["det_rel_ms", "fast_att_ms", "fast_rel_slew", "fast_det_rel_ms", "cell_rel_follow_ms"]


def _knobs(fit, key):
    kk = ANCH[key][0]
    return list(fit[kk]) if kk else [float(i) for i in range(len(fit[key]))]


def apply_theta(base, th):
    fit = copy.deepcopy(base)
    i = 0
    for key, (_, anchors) in ANCH.items():
        ks = _knobs(base, key)
        m = np.array(th[i:i + len(anchors)])
        i += len(anchors)
        mult = np.exp(np.interp(ks, anchors, m))
        fit[key] = (np.asarray(base[key], float) * mult).tolist()
    for s in SCAL:
        fit[s] = float(base.get(s, 1.0) if base.get(s, 0) else 1.0) * math.exp(th[i])
        i += 1
    fit.pop("dyn2", None)
    return fit


def n_theta():
    return sum(len(a) for _, a in ANCH.values()) + len(SCAL)


_W = {}


def _init(base):
    prof = import_prof("modeles.cl1b_profil")
    _W.update(base=base, prof=prof, banc=banc_mod("cl1b"), real=load_real("cl1b_t1"), steps=load_steps("cl1b_t1"))


def _cost(th):
    try:
        c, _ = evaluate(apply_theta(_W["base"], th), _W["real"], _W["steps"], _W["banc"], _W["prof"])
    except Exception:
        c = 1e3
    return c if np.isfinite(c) else 1e3


def run(gens, workers, sigma=float(os.environ.get("NOVA_SIGMA", "0.35"))):
    import cma
    from multiprocessing import Pool
    prof = import_prof("modeles.cl1b_profil")
    base = prof.load_fit()
    base.pop("dyn2", None)
    es = cma.CMAEvolutionStrategy([0.0] * n_theta(), sigma, {"popsize": 16, "maxiter": gens, "verbose": -9})
    out = os.path.join(LABO, "tubetech_cl1b", "tour2")
    log = open(os.path.join(out, "cma_cl1b_t1.log"), "a", encoding="utf-8")
    best = (None, 1e9)
    t0 = time.time()
    with Pool(workers, initializer=_init, initargs=(base,)) as pool:
        c0 = pool.apply(_cost, ([0.0] * n_theta(),))
        log.write(f"départ (tour 1) : {c0:.3f}\n")
        best = (np.zeros(n_theta()), c0)
        while not es.stop():
            X = es.ask()
            F = pool.map(_cost, X)
            es.tell(X, F)
            i = int(np.argmin(F))
            if F[i] < best[1]:
                best = (np.array(X[i]), F[i])
                json.dump({"cost": float(F[i]), "theta": list(map(float, X[i]))}, open(os.path.join(out, "best_cl1b_t1.json"), "w"))
            log.write(f"{time.strftime('%H:%M:%S')} it {es.countiter} best {best[1]:.3f} gen_min {min(F):.3f} ({time.time() - t0:.0f}s)\n")
            log.flush()
    return best


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--gens", type=int, default=120)
    ap.add_argument("--workers", type=int, default=8)
    ap.add_argument("--apply", action="store_true")
    a = ap.parse_args()
    if a.apply:
        prof = import_prof("modeles.cl1b_profil")
        base = prof.load_fit()
        base.pop("dyn2", None)
        b = json.load(open(os.path.join(LABO, "tubetech_cl1b", "tour2", "best_cl1b_t1.json")))
        fit = apply_theta(base, b["theta"])
        prof.save_fit(fit)
        print("appliqué, coût", b["cost"])
    else:
        print(run(a.gens, a.workers))
