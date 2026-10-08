"""Calage du profil Opto Vintage sur les mesures du CL 1B mk II.
Usage : python -m modeles.fit_cl1b <étape>   (static | attack | release | modes | all)"""
import json
import os
import sys

import numpy as np
from scipy.optimize import least_squares

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
import bench  # noqa: E402
from bancs import cl1b as banc  # noqa: E402
from modeles import cl1b_profil as prof  # noqa: E402
from modeles.pyproc import ModelProc  # noqa: E402

LABO = r"D:\1 WORK\CONTENU\nova-labo\tubetech_cl1b"
M = json.load(open(os.path.join(LABO, "mesures.json"), encoding="utf-8"))
C = json.load(open(os.path.join(LABO, "mesures_carto.json"), encoding="utf-8"))


def p1db(s):
    i = np.array(s["in_db"])
    g = np.array(s["gr_db"])
    k = int(np.argmax(g > 1.0))
    return float(i[k - 1] + (1 - g[k - 1]) / (g[k] - g[k - 1]) * (i[k] - i[k - 1]))


def build_static(fit):
    thr = []
    for t in prof.THR_KNOB:
        s = C[f"c_thr{int(t)}"]["tests"]["stat_1k"]["static"]
        thr.append(p1db(s) if max(s["gr_db"]) > 1 else None)
    # bouton +2 : rien ne comprime jusqu'à 0 dBFS -> extrapolé
    thr[0] = thr[1] + (thr[1] - thr[2]) * 2 / 5
    fit["thr_1db"] = thr
    on25 = thr[prof.THR_KNOB.index(-25.0)]
    on40 = thr[prof.THR_KNOB.index(-40.0)]
    Lg = prof.L0 + prof.DL * np.arange(prof.NL)
    s40 = C["c_thr-40"]["tests"]["stat_1k"]["static"]
    L40 = np.array(s40["in_db"]) - on40
    G40 = np.array(s40["gr_db"])
    tabs = []
    for r in prof.RATIO_KNOB:
        key = f"c_ratio{r:g}"
        s = C[key]["tests"]["stat_1k"]["static"]
        L = np.array(s["in_db"]) - on25
        G = np.array(s["gr_db"])
        tab = np.interp(Lg, L, G)
        # au-delà de la mesure : saturation de la cellule (forme du 4:1 à -40)
        Lmax = L[-1]
        hi = Lg > Lmax
        if hi.any():
            g4_last = np.interp(Lmax, L40, G40)
            ext = np.interp(Lg[hi], L40, G40) - g4_last
            sl = (G[-1] - G[-3]) / (L[-1] - L[-3])
            sl4 = (np.interp(Lmax, L40, G40) - np.interp(Lmax - 2, L40, G40)) / 2
            tab[hi] = G[-1] + ext * (sl / max(sl4, 1e-3))
            tab[hi] = np.minimum(tab[hi], 31.4)
        tab[Lg < L[0]] = 0.0
        tabs.append(np.maximum(tab, 0.0).tolist())
    fit["tables"] = tabs
    return fit


def proc_for(fit):
    return ModelProc(prof.builder(fit, banc.to_nova), "OptoVintage-py")


def gr_curve(proc, settings, t):
    proc.configure(settings)
    return np.array(bench.step_response(proc, t.get("freq", 1000), t["base_db"], t["step_db"], t["hold"],
                                        t["rel_obs"])["gr_curve_ms"])


def find_test(case_tests, name):
    return case_tests[name]


def att_residual(fit, knob, tests_meas):
    proc = proc_for(fit)
    res = []
    for (settings, t, meas) in tests_meas:
        g = gr_curve(proc, settings, t)
        n = min(len(g), len(meas))
        hold = int(t["hold"] * 1000)
        w = np.zeros(n)
        w[45:50 + hold] = 1.0
        res.append((g[:n] - meas[:n]) * w)
    return np.concatenate(res)


def fit_attack(fit, knobs=range(11)):
    tot = []
    for k in knobs:
        case = C[f"c_att{k}"]
        tests = []
        for nm in ["s25", "s15"]:
            t = dict(banc.CARTO[[c["name"] for c in banc.CARTO].index(f"c_att{k}")]["tests"][0 if nm == "s25" else 1])
            tests.append((case["settings"], t, np.array(case["tests"][nm]["gr_curve_ms"])))

        from scipy.optimize import minimize
        if "att_slew_k" not in fit:
            fit["att_slew_k"] = [fit.get("cell_att_slew", 80.0)] * 11

        def f(v):
            fit["att_ms"][k] = float(np.exp(v[0]))
            fit["att_slew_k"][k] = float(np.exp(v[1]))
            return att_residual(fit, k, tests)

        def cost(v):
            return float(np.mean(f(v) ** 2))
        v0 = [np.log(max(fit["att_ms"][k], 0.05)), np.log(fit["att_slew_k"][k])]
        r = minimize(cost, v0, method="Nelder-Mead", options={"xatol": 0.01, "fatol": 1e-5, "maxfev": 80,
                                                                "initial_simplex": [v0, [v0[0] + 0.7, v0[1]], [v0[0], v0[1] + 0.7]]})
        f(r.x)
        r.fun = f(r.x)
        tot.append(float(np.sqrt(np.mean(r.fun ** 2))))
        print(f"att {k}: att_ms={fit['att_ms'][k]:.3f} slew={fit['att_slew_k'][k]:.1f} rms={np.sqrt(np.mean(r.fun ** 2)):.3f} dB", flush=True)
    return float(np.mean(tot))


def grid_det(fit):
    best = None
    base = json.loads(json.dumps(fit))
    for kd in (0.0, 0.3, 1.0):
        for dr in (5.0, 20.0, 60.0):
            f2 = json.loads(json.dumps(base))
            f2["det_att_k"], f2["det_rel_ms"] = kd, dr
            sc = fit_attack(f2, knobs=(5, 7, 10))
            print(f"== det_att_k={kd} det_rel={dr}: {sc:.3f}", flush=True)
            if best is None or sc < best[0]:
                best = (sc, kd, dr)
    fit["det_att_k"], fit["det_rel_ms"] = best[1], best[2]
    print("meilleur", best, flush=True)


def fit_release(fit):
    for k in range(11):
        case = C[f"c_rel{k}"]
        t = dict(banc.CARTO[[c["name"] for c in banc.CARTO].index(f"c_rel{k}")]["tests"][0])
        meas = np.array(case["tests"]["s25"]["gr_curve_ms"])

        def f(v):
            fit["rel_slew"][k] = float(np.exp(v[0]))
            proc = proc_for(fit)
            g = gr_curve(proc, case["settings"], t)
            n = min(len(g), len(meas))
            hold = int(t["hold"] * 1000)
            w = np.zeros(n)
            w[50 + hold:] = 1.0
            return (g[:n] - meas[:n]) * w
        v0 = [np.log(fit["rel_slew"][k])]
        r = least_squares(f, v0, diff_step=0.05, max_nfev=40)
        f(r.x)
        print(f"rel {k}: slew={fit['rel_slew'][k]:.2f}/s exp={fit['rel_exp_ms'][k]:.1f}ms rms={np.sqrt(np.mean(r.fun ** 2)):.3f} dB",
              flush=True)
    return fit


def save(fit):
    with open(prof.FIT_FILE, "w", encoding="utf-8") as fh:
        json.dump(fit, fh, indent=1)


def quick_score(fit, att_keys=(0, 2, 5, 8, 10), rel_keys=(0, 5, 10)):
    """Erreur RMS globale (dB) sur quelques cas, réglages par bouton gardés."""
    tot = []
    for k in att_keys:
        case = C[f"c_att{k}"]
        for j, nm in enumerate(["s25", "s15"]):
            t = dict(banc.CARTO[[c["name"] for c in banc.CARTO].index(f"c_att{k}")]["tests"][j])
            tot.append(att_residual(fit, k, [(case["settings"], t, np.array(case["tests"][nm]["gr_curve_ms"]))]))
    return float(np.sqrt(np.mean(np.concatenate(tot) ** 2)))


def grid_global(fit):
    best = None
    for rect in (1, 0):
        for drel in (2.0, 5.0, 10.0, 20.0, 50.0, 100.0):
            for catt in (0.05, 0.3, 1.0):
                fit["rect_half"], fit["det_rel_ms"], fit["cell_att_ms"] = rect, drel, catt
                fit_attack(fit) if False else None
                sc = quick_score(fit)
                print(f"rect={rect} det_rel={drel} cell_att={catt}: {sc:.3f}", flush=True)
                if best is None or sc < best[0]:
                    best = (sc, rect, drel, catt)
    fit["rect_half"], fit["det_rel_ms"], fit["cell_att_ms"] = best[1:]
    print("meilleur", best)
    return fit


if __name__ == "__main__":
    step = sys.argv[1] if len(sys.argv) > 1 else "all"
    fit = prof.load_fit()
    if step in ("static", "all"):
        build_static(fit)
        save(fit)
        print("statique ok", [round(x, 2) for x in fit["thr_1db"]])
    if step in ("griddet",):
        grid_det(fit)
        save(fit)
    if step in ("grid",):
        grid_global(fit)
        save(fit)
    if step in ("attack", "all"):
        fit_attack(fit)
        save(fit)
    if step in ("release", "all"):
        fit_release(fit)
        save(fit)
