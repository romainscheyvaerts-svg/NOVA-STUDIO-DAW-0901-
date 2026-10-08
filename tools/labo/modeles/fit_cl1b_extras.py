"""Calages complémentaires du profil Opto Vintage : couleur « Vintage mk I »,
filtre du sidechain, positions intermédiaires de l'attaque, mode Fixed."""
import math
import os
import sys

import numpy as np
from scipy import signal as sps
from scipy.optimize import least_squares, minimize

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import bench  # noqa: E402
from modeles import analog_comp as ac  # noqa: E402
from modeles import cl1b_profil as prof  # noqa: E402
from modeles import fit_cl1b as F  # noqa: E402


def fit_vintage(fit):
    v = F.C["c_vintage"]["tests"]["fr_-20"]
    f = np.array(v["freqs"])
    m = np.array(v["channels"][0]["mag_db"])
    sel = (f >= 20) & (f <= 18000)

    def resp(x):
        g, fh, qh, fl, ql = x
        h = np.ones(sel.sum(), complex)
        for kind, fc, q in (("hp", fh, qh), ("lp", fl, ql)):
            b = ac.biquad(kind, fc, q, 0.0)
            _, hh = sps.freqz([b[0], b[1], b[2]], [1, b[3], b[4]], worN=f[sel], fs=48000)
            h *= hh
        return 20 * np.log10(np.abs(h)) + g

    r = least_squares(lambda x: resp(x) - m[sel], [-0.4, 14, 0.8, 22000, 0.6],
                      bounds=([-2, 3, 0.3, 12000, 0.3], [1, 40, 2.0, 23500, 1.5]))
    g, fh, qh, fl, ql = r.x
    fit["vintage_gain_db"] = float(g)
    fit["vintage_eq"] = [["hp", float(fh), float(qh), 0.0], ["lp", float(fl), float(ql), 0.0]]
    print("vintage", np.round(r.x, 3), "max err", round(float(np.max(np.abs(r.fun))), 3), flush=True)


def fit_sc(fit):
    from modeles.pyproc import ModelProc
    for sc in ("80", "220"):
        cases = [(f, F.C[f"c_sc{sc}_f{f}"]) for f in [40, 60, 100, 150, 250, 400, 1000]]

        def res(x):
            fit.setdefault("sc_filters", {})[sc] = [float(np.exp(x[0])), float(x[1])]
            proc = ModelProc(prof.builder(fit, F.banc.to_nova))
            out = []
            for f, c in cases:
                proc.configure(c["settings"])
                r = bench.tone_levels(proc, f, [-30, -24, -18, -12], dur=2.0)
                out += [r["rows"][i]["ch0"]["out_db"] - c["tests"]["stat"]["rows"][i]["ch0"]["out_db"] for i in range(4)]
            return np.array(out)

        r = least_squares(res, [np.log(float(sc)), 0.7], bounds=([np.log(10), 0.3], [np.log(800), 3.0]), diff_step=0.02)
        res(r.x)
        print("sc", sc, fit["sc_filters"][sc], "max err", round(float(np.max(np.abs(r.fun))), 3), flush=True)


def fit_att_halves(fit):
    names = [c["name"] for c in F.banc.CARTO]
    old_k = fit.get("att_knob", [float(i) for i in range(11)])
    old_ms, old_sl = fit["att_ms"], fit["att_slew_k"]
    K = prof.ATT_KNOB
    fit["att_knob"] = K
    fit["att_ms"] = [float(np.exp(np.interp(k, old_k, np.log(old_ms)))) for k in K]
    fit["att_slew_k"] = [float(np.exp(np.interp(k, old_k, np.log(old_sl)))) for k in K]
    for j, k in enumerate(K):
        key = f"c_att{k:g}"
        case = F.C[key]
        tests = []
        for i, nm in enumerate(["s25", "s15"]):
            t = dict(F.banc.CARTO[names.index(key)]["tests"][i])
            tests.append((case["settings"], t, np.array(case["tests"][nm]["gr_curve_ms"])))

        def cost(v):
            fit["att_ms"][j] = float(np.exp(v[0]))
            fit["att_slew_k"][j] = float(np.exp(v[1]))
            return float(np.mean(F.att_residual(fit, k, tests) ** 2))

        v0 = [np.log(fit["att_ms"][j]), np.log(fit["att_slew_k"][j])]
        r = minimize(cost, v0, method="Nelder-Mead", options={
            "maxfev": 70, "xatol": 0.01, "fatol": 1e-5,
            "initial_simplex": [v0, [v0[0] + 0.5, v0[1]], [v0[0], v0[1] + 0.5]]})
        cost(r.x)
        print(f"att {k}: ms={fit['att_ms'][j]:.3f} slew={fit['att_slew_k'][j]:.1f} rms={math.sqrt(r.fun):.3f}", flush=True)
    # monotonie : la cellule ne doit jamais accélérer quand on tourne vers « slow »
    for j in range(1, len(K)):
        fit["att_slew_k"][j] = min(fit["att_slew_k"][j], fit["att_slew_k"][j - 1])
        fit["att_ms"][j] = max(fit["att_ms"][j], fit["att_ms"][j - 1])


def fit_fix(fit):
    case = F.M["mode_Fix"]
    tdefs = F.banc.CASES[[c["name"] for c in F.banc.CASES].index("mode_Fix")]["tests"]
    sel = [t for t in tdefs if t["name"] in ("m_h1.0_s15", "m_h1.0_s25")]

    def res(x):
        fit["fix_att_ms"] = float(np.exp(x[0]))
        fit["fix_rel_slew"] = float(np.exp(x[1]))
        fit["fix_det_rel_ms"] = float(np.exp(x[2]))
        proc = F.proc_for(fit)
        out = []
        for t in sel:
            g = F.gr_curve(proc, case["settings"], t)
            m = np.array(case["tests"][t["name"]]["gr_curve_ms"])
            n = min(len(g), len(m))
            out.append(g[45:n] - m[45:n])
        return np.concatenate(out)

    r = least_squares(res, [np.log(0.3), np.log(2000), np.log(2.0)], diff_step=0.05, max_nfev=60)
    res(r.x)
    print("fix", fit["fix_att_ms"], fit["fix_rel_slew"], fit["fix_det_rel_ms"], "rms",
          round(float(np.sqrt(np.mean(r.fun ** 2))), 3), flush=True)


if __name__ == "__main__":
    fit = prof.load_fit()
    for step in sys.argv[1:]:
        {"vintage": fit_vintage, "sc": fit_sc, "att": fit_att_halves, "fix": fit_fix}[step](fit)
        F.save(fit)
