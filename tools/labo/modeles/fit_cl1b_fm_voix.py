"""Affinage du mode FIX./MAN. (Opto Vintage) : courbes de saut ET vraie voix (null test)."""
import math, os, sys, json
import numpy as np
from scipy.optimize import minimize
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import bench
from modeles import fit_cl1b_fm as FM, fit_cl1b as F, cl1b_profil as prof
fit = prof.load_fit()
case = F.M["romain_voix"]
ref = np.load(r"D:\1 WORK\CONTENU\nova-labo\tubetech_cl1b\audio_vst\romain_voix__voix.npy").astype(np.float64)
x = bench.load_audio(F.banc.VOIX, 12, 0.0, -20.0)
sets = [FM.tests_for(3.0, [5, 20, 80, 320]), FM.tests_for(5.0, [10, 40, 160])]
j3 = FM.FM_KNOB.index(3.0)

def null_db():
    proc = F.proc_for(fit); proc.configure(case["settings"])
    y = proc.run(x)
    return bench.null_db(ref, y)

def cost(v):
    fit["fast_att_ms"], fit["fast_rel_slew"], fit["fast_det_rel_ms"] = float(np.exp(v[0])), float(np.exp(v[1])), float(np.exp(v[2]))
    fit["fm_att_ms"][j3] = float(np.exp(v[3]))
    st = float(np.mean(np.concatenate([FM.residual(fit, s, tl) for s, tl in sets]) ** 2))
    nd = null_db()
    return st + 0.15 * max(nd + 40, 0)

x0 = [np.log(fit["fast_att_ms"]), np.log(fit["fast_rel_slew"]), np.log(fit["fast_det_rel_ms"]), np.log(fit["fm_att_ms"][j3])]
print("départ : null", round(null_db(), 2), flush=True)
simplex = [x0] + [[x0[i] + (0.6 if i == k else 0) for i in range(4)] for k in range(4)]
r = minimize(cost, x0, method="Nelder-Mead", options={"maxfev": 70, "initial_simplex": simplex})
cost(r.x)
print("fin : null", round(null_db(), 2), {k: round(fit[k], 3) for k in ("fast_att_ms", "fast_rel_slew", "fast_det_rel_ms")}, round(fit["fm_att_ms"][j3], 2), flush=True)
F.save(fit)
