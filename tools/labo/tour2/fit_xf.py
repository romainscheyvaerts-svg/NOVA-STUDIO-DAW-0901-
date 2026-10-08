"""Tour 2 : transformateur du Vox Strip recalé sur les harmoniques à 50 / 100 Hz
(après l'étage de sortie tabulé). Usage : python -m tour2.fit_xf"""
import json, os, sys
import numpy as np
from scipy.optimize import least_squares
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import bench  # noqa
from bancs import voxbox as banc  # noqa
from modeles import voxbox_profil as prof  # noqa
from modeles.pyproc import ModelProc  # noqa

M = json.load(open(r"D:\1 WORK\CONTENU\nova-labo\manley_voxbox\mesures.json", encoding="utf-8"))
fit = prof.load_fit()
fit["xf_mode"] = 2
tests = [(M["lineaire"]["tests"][k], f, {}) for k, f in (("thd_100", 100), ("thd_50", 50), ("thd_1k", 1000))]
tests += [(M["stat_th5_freq"]["tests"]["stat_100"], 100, M["stat_th5_freq"]["settings"])]


def res(p):
    fit["xf_k"], fit["xf_fc"] = float(p[0]), float(np.exp(p[1]))
    pr = ModelProc(prof.builder(fit, banc.to_nova))
    out = []
    for t, f, st in tests:
        pr.configure(st)
        lv = [r["in_db"] for r in t["rows"]]
        sim = bench.tone_levels(pr, f, lv, dur=0.6)
        for a, b in zip(t["rows"], sim["rows"]):
            out.append((b["ch0"]["out_db"] - a["ch0"]["out_db"]) * 3)
            for h in range(2):
                ha, hb = a["ch0"]["harm_rel_db"][h], b["ch0"]["harm_rel_db"][h]
                out.append((max(hb, -100) - max(ha, -100)) * 0.5)
    return np.array(out)


r = least_squares(res, [-1.0, np.log(20.0)], diff_step=0.05, max_nfev=60,
                  bounds=([-200, np.log(1.0)], [200, np.log(400.0)]))
res(r.x)
prof.save_fit(fit)
print("xf_k", fit["xf_k"], "xf_fc", fit["xf_fc"], "rms", float(np.sqrt(np.mean(r.fun ** 2))))
