"""Calage du mode FIX./MAN. du profil Opto Vintage (cellule rapide + cellule lente)."""
import math
import os
import sys

import numpy as np
from scipy.optimize import least_squares, minimize

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from modeles import cl1b_profil as prof  # noqa: E402
from modeles import fit_cl1b as F  # noqa: E402

FM_KNOB = [0.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0, 10.0]
HOLDS = [2, 5, 10, 20, 40, 80, 160, 320]
NAMES = [c["name"] for c in F.banc.CARTO]


def tests_for(a, holds=HOLDS):
    key = f"c_fm_att{a:g}"
    case = F.C[key]
    tdefs = {t["name"]: t for t in F.banc.CARTO[NAMES.index(key)]["tests"]}
    return case["settings"], [(tdefs[f"h{h}"], np.array(case["tests"][f"h{h}"]["gr_curve_ms"])) for h in holds]


def residual(fit, settings, tl):
    proc = F.proc_for(fit)
    out = []
    for t, m in tl:
        g = F.gr_curve(proc, settings, t)
        n = min(len(g), len(m))
        out.append(g[45:n] - m[45:n])
    return np.concatenate(out)


def fit_fast(fit):
    settings, tl = tests_for(10.0, holds=[2, 5, 10, 20, 40, 80])
    if "fm_att_ms" not in fit:
        fit["fm_knob"] = FM_KNOB
        fit["fm_att_ms"] = [2000.0] * len(FM_KNOB)
        fit["fm_att_slew"] = [5.0] * len(FM_KNOB)
    x0 = [np.log(fit.get("fast_att_ms", 0.5)), np.log(fit.get("fast_rel_slew", 3000.0)), np.log(fit.get("fast_det_rel_ms", 2.0))]

    def res(x):
        fit["fast_att_ms"], fit["fast_rel_slew"], fit["fast_det_rel_ms"] = (float(np.exp(v)) for v in x)
        return residual(fit, settings, tl)
    r = least_squares(res, x0, diff_step=0.05, max_nfev=50)
    res(r.x)
    print("rapide", round(fit["fast_att_ms"], 3), round(fit["fast_rel_slew"], 1), round(fit["fast_det_rel_ms"], 3),
          "rms", round(float(np.sqrt(np.mean(r.fun ** 2))), 3), flush=True)


def fit_slow(fit):
    fit["fm_knob"] = FM_KNOB
    ms0 = fit.get("fm_att_ms") or [0.3, 0.3, 3.0, 8.0, 20.0, 50.0, 100.0, 200.0, 400.0]
    sl0 = [2000.0, 2000.0, 200.0, 120.0, 70.0, 50.0, 40.0, 35.0, 30.0]
    fit["fm_att_ms"], fit["fm_att_slew"] = list(ms0), list(sl0)
    ms0 = list(ms0)
    for j, a in enumerate(FM_KNOB):
        settings, tl = tests_for(a)

        from scipy.optimize import minimize_scalar

        def cost(v):
            fit["fm_att_ms"][j] = float(np.exp(v))
            return float(np.mean(residual(fit, settings, tl) ** 2))
        r = minimize_scalar(cost, bounds=(np.log(0.05), np.log(3000)), method="bounded", options={"xatol": 0.02})
        cost(r.x)
        print(f"fm att {a}: ms={fit['fm_att_ms'][j]:.2f} slew={fit['fm_att_slew'][j]:.1f} rms={math.sqrt(r.fun):.3f}", flush=True)


if __name__ == "__main__":
    fit = prof.load_fit()
    if "fast" in sys.argv[1:]:
        fit_fast(fit)
        F.save(fit)
    if "slow" in sys.argv[1:]:
        fit_slow(fit)
        F.save(fit)
