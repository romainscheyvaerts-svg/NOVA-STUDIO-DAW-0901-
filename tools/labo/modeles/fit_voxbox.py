"""Calage du profil Vox Strip sur les mesures de l'UADx Manley VOXBOX.
Usage : python -m modeles.fit_voxbox gains tables shaper xf eq times correct"""
import json
import math
import os
import sys

import numpy as np
from scipy import signal as sps
from scipy.optimize import least_squares, minimize

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
import bench  # noqa: E402
from bancs import voxbox as banc  # noqa: E402
from modeles import analog_comp as ac  # noqa: E402
from modeles import voxbox_profil as prof  # noqa: E402
from modeles.pyproc import ModelProc  # noqa: E402

LABO = r"D:\1 WORK\CONTENU\nova-labo\manley_voxbox"
M = json.load(open(os.path.join(LABO, "mesures.json"), encoding="utf-8"))
C = json.load(open(os.path.join(LABO, "mesures_carto.json"), encoding="utf-8"))
NAMES = [c["name"] for c in banc.CARTO]


def proc_for(fit):
    return ModelProc(prof.builder(fit, banc.to_nova), "VOXSTRIP-py")


def fit_gains(fit):
    fit["in_knob"] = prof.TH_KNOB
    fit["in_gain_db"] = [max(-120.0, C[f"c_in{i}"]["tests"]["g"]["rows"][0]["ch0"]["out_db"] + 60) for i in range(11)]
    print("gains", [round(g, 2) for g in fit["in_gain_db"]])


def fit_tables(fit):
    Lg = prof.L0 + prof.DL * np.arange(prof.NL)
    sat = C["c_th0"]["tests"]["stat_1k"]["rows"]
    li = np.array([q["in_db"] for q in sat])
    lg = np.array([q["ch0"]["out_db"] - q["in_db"] for q in sat])
    thr, tabs = [], []
    for t in range(11):
        rows = C[f"c_th{t}"]["tests"]["stat_1k"]["rows"]
        i = np.array([q["in_db"] for q in rows])
        g = np.array([q["ch0"]["out_db"] - q["in_db"] for q in rows])
        G = np.maximum(lg[0] - g, 0)
        G = np.maximum(G - np.maximum(lg[0] - np.interp(i - G, li, lg), 0), 0)
        if G.max() > 1:
            k = int(np.argmax(G > 1.0))
            th = float(i[k - 1] + (1 - G[k - 1]) / (G[k] - G[k - 1]) * (i[k] - i[k - 1]))
        else:
            th = None
        thr.append(th)
        tabs.append((i, G))
    for j in range(len(thr) - 1, -1, -1):
        if thr[j] is None:
            thr[j] = thr[j + 1] + 6.0
    T = []
    for (i, G), th in zip(tabs, thr):
        L = i - th
        tab = np.interp(Lg, L, G)
        hi = Lg > L[-1]
        if hi.any():
            tab[hi] = G[-1]
        tab[Lg < L[0]] = 0.0
        T.append(np.maximum(tab, 0).tolist())
    fit["thr_th"], fit["tables_th"] = thr, T
    print("seuils", [round(x, 1) for x in thr])


def fit_shaper(fit):
    rows = M["lineaire"]["tests"]["thd_1k"]["rows"] + C["c_th0"]["tests"]["stat_1k"]["rows"][-8:]

    def res(x):
        fit["out_a2"], fit["out_a3"], fit["out_sat"], fit["out_bias"], fit["out_ab"], fit["out_knee"] = (
            float(x[0]), float(x[1]), float(np.exp(x[2])), float(x[3]), float(x[4]), float(np.exp(x[5])))
        proc = proc_for(fit)
        proc.configure({"comp_byp": "Byp", "transformer_byp": "Byp"})
        sim = bench.tone_levels(proc, 1000, [r["in_db"] for r in rows], dur=0.4)
        out = []
        for a, b in zip(rows, sim["rows"]):
            out.append((b["ch0"]["out_db"] - a["ch0"]["out_db"]) * 2)
            for h in range(4):
                ha, hb = a["ch0"]["harm_rel_db"][h], b["ch0"]["harm_rel_db"][h]
                if ha > -100:
                    out.append((max(hb, -120) - ha) * 0.4)
        return np.array(out)
    x0 = [0.02, 0.0, np.log(3.0), 0.05, 0.0, np.log(4.0)]
    r = least_squares(res, x0, diff_step=0.02, max_nfev=300,
                      bounds=([-1, -1, -3, -1, -1.5, 0.0], [1, 1, 3, 1, 1.5, np.log(30.0)]))
    res(r.x)
    print("préampli", [round(fit[k], 4) for k in ("out_a2", "out_a3", "out_sat", "out_bias", "out_ab", "out_knee")],
          "rms", round(float(np.sqrt(np.mean(r.fun ** 2))), 3), flush=True)


def fit_xf(fit):
    rows = {50: M["lineaire"]["tests"]["thd_50"]["rows"], 100: M["lineaire"]["tests"]["thd_100"]["rows"]}

    def res(x):
        fit["xf_k"], fit["xf_fc"] = float(x[0]), float(np.exp(x[1]))
        proc = proc_for(fit)
        proc.configure({})
        out = []
        for f, rr in rows.items():
            sim = bench.tone_levels(proc, f, [r["in_db"] for r in rr[:4]], dur=0.6)
            for a, b in zip(rr[:4], sim["rows"]):
                out.append(b["ch0"]["harm_rel_db"][1] - a["ch0"]["harm_rel_db"][1])
                out.append((b["ch0"]["out_db"] - a["ch0"]["out_db"]) * 2)
        return np.array(out)
    r = least_squares(res, [0.05, np.log(20.0)], diff_step=0.03, max_nfev=80, bounds=([-50, np.log(1.0)], [50, np.log(500.0)]))
    res(r.x)
    print("transfo", round(fit["xf_k"], 4), round(fit["xf_fc"], 2), "rms", round(float(np.sqrt(np.mean(r.fun ** 2))), 3), flush=True)


def fit_eq(fit):
    flat = np.array(C["c_eqflat"]["tests"]["fr"]["channels"][0]["mag_db"])
    f = np.array(C["c_eqflat"]["tests"]["fr"]["freqs"])
    sel = (f >= 20) & (f <= 20000)
    # réponse de base (transformateur, préampli) : sur c_flat, relative au gain à 1 kHz
    base = np.array(C["c_flat"]["tests"]["fr"]["channels"][0]["mag_db"])
    b1k = float(np.interp(1000, f, base))

    def resp_base(x):
        h = np.ones(sel.sum(), complex)
        for kind, fc, q, gd in (("hp", x[0], x[1], 0.0), ("lp", x[2], x[3], 0.0), ("peak", x[4], x[5], x[6])):
            b = ac.biquad(kind, fc, q, gd)
            _, hh = sps.freqz([b[0], b[1], b[2]], [1, b[3], b[4]], worN=f[sel], fs=48000)
            h *= hh
        return 20 * np.log10(np.abs(h))
    r = least_squares(lambda x: resp_base(x) - (base[sel] - b1k), [15, 0.7, 30000 if False else 22000, 0.7, 60, 0.7, 0.2],
                      bounds=([3, 0.3, 8000, 0.3, 20, 0.2, -3], [60, 2, 23500, 2, 400, 4, 3]))
    x = r.x
    fit["eq_base"] = [["hp", float(x[0]), float(x[1]), 0.0], ["lp", float(x[2]), float(x[3]), 0.0], ["peak", float(x[4]), float(x[5]), float(x[6])]]
    print("base", np.round(x, 3), "max", round(float(np.max(np.abs(r.fun))), 3), flush=True)

    for band, freqs, sign, key in (("lo", prof.LO_F, 1, "c_lo"), ("mid", prof.MID_F, -1, "c_mid"), ("hi", prof.HI_F, 1, "c_hi")):
        best_kind, best_rows, best_err = None, None, 1e9
        for kind in (("peak", "lowshelf") if band == "lo" else ("peak", "highshelf") if band == "hi" else ("peak",)):
            rows, err = [], 0.0
            for fc0 in freqs:
                gq = []
                for g in (5, 10):
                    m = np.array(C[f"{key}{int(fc0)}_{sign * g}"]["tests"]["fr"]["channels"][0]["mag_db"]) - flat
                    msel = (f >= 15) & (f <= 21000)

                    def resp(xx):
                        bq = ac.biquad(kind, np.exp(xx[0]), xx[1], xx[2])
                        _, hh = sps.freqz([bq[0], bq[1], bq[2]], [1, bq[3], bq[4]], worN=f[msel], fs=48000)
                        return 20 * np.log10(np.abs(hh))
                    rr = least_squares(lambda xx: resp(xx) - m[msel], [np.log(min(fc0, 20000)), 0.7, sign * g],
                                       bounds=([np.log(10), 0.1, -30], [np.log(23000), 6, 30]))
                    err = max(err, float(np.max(np.abs(rr.fun))))
                    gq.append((float(np.exp(rr.x[0])), float(rr.x[1]), float(rr.x[2])))
                fc = math.sqrt(gq[0][0] * gq[1][0])
                rows.append([fc, gq[0][1], gq[1][1], abs(gq[0][2]), abs(gq[1][2])])
            if err < best_err:
                best_kind, best_rows, best_err = kind, rows, err
        fit[band] = best_rows
        fit[f"{band}_kind"] = best_kind
        print(band, best_kind, "écart max", round(best_err, 2), flush=True)


def step_tests(a, r):
    key = f"c_t_a{a}_r{r}".replace(" ", "")
    case = C[key]
    tdefs = {t["name"]: t for t in banc.CARTO[NAMES.index(key)]["tests"]}
    return case["settings"], [(tdefs[f"h{h}"], np.array(case["tests"][f"h{h}"]["gr_curve_ms"])) for h in (0.1, 1.0, 3.0)]


def residual(fit, settings, tl):
    proc = proc_for(fit)
    proc.configure(settings)
    out = []
    for t, m in tl:
        g = np.array(bench.step_response(proc, 1000, t["base_db"], t["step_db"], t["hold"], t["rel_obs"])["gr_curve_ms"])
        n = min(len(g), len(m))
        w = np.ones(n)
        w[:45] = 0
        out.append((g[:n] - m[:n]) * w)
    return np.concatenate(out)


def fit_times(fit):
    # part lente globale, calée sur le couple Medium / Medium
    settings, tl = step_tests("Medium", "Medium")

    def cost(x):
        fit["slow_frac"] = float(1 / (1 + np.exp(-x[0])))
        fit["slow_att_ms"] = float(min(5000, max(5, np.exp(x[1]))))
        fit["slow_rel_ms"] = float(min(8000, max(50, np.exp(x[2]))))
        return float(np.mean(residual(fit, settings, tl) ** 2))
    x0 = [np.log(0.2 / 0.8), np.log(300.0), np.log(1500.0)]
    r = minimize(cost, x0, method="Nelder-Mead", options={"maxfev": 60, "initial_simplex": [x0, [x0[0] + 1, x0[1], x0[2]], [x0[0], x0[1] + 0.7, x0[2]], [x0[0], x0[1], x0[2] + 0.7]]})
    cost(r.x)
    print("lente", round(fit["slow_frac"], 3), round(fit["slow_att_ms"]), round(fit["slow_rel_ms"]), "rms", round(math.sqrt(r.fun), 3), flush=True)
    for ai, a in enumerate(prof.ATT_POS):
        for ri, rl in enumerate(prof.REL_POS):
            settings, tl = step_tests(a, rl)

            def c2(x):
                fit["att_ms"][ai][ri] = float(np.exp(x[0]))
                fit["rel_ms"][ai][ri] = float(np.exp(x[1]))
                return float(np.mean(residual(fit, settings, tl) ** 2))
            x0 = [np.log(fit["att_ms"][ai][ri]), np.log(fit["rel_ms"][ai][ri])]
            r = minimize(c2, x0, method="Nelder-Mead", options={"maxfev": 45, "initial_simplex": [x0, [x0[0] + 1.0, x0[1]], [x0[0], x0[1] + 0.7]]})
            c2(r.x)
            print(f"{a}/{rl}: att {fit['att_ms'][ai][ri]:.1f} ms rel {fit['rel_ms'][ai][ri]:.0f} ms rms {math.sqrt(r.fun):.3f}", flush=True)


def correct_tables(fit, iters=2):
    Lg = prof.L0 + prof.DL * np.arange(prof.NL)
    for it in range(iters):
        worst = 0
        for t in range(3, 11):
            case = C[f"c_th{t}"]
            proc = proc_for(fit)
            proc.configure(case["settings"])
            rows = case["tests"]["stat_1k"]["rows"]
            lv = [q["in_db"] for q in rows]
            sim = bench.tone_levels(proc, 1000, lv, dur=2.5)
            err = np.array([b["ch0"]["out_db"] - a["ch0"]["out_db"] for a, b in zip(rows, sim["rows"])])
            worst = max(worst, float(np.max(np.abs(err))))
            L = np.array(lv) - fit["thr_th"][t]
            tab = np.array(fit["tables_th"][t])
            corr = np.interp(Lg, L, err, left=0.0, right=err[-1])
            fit["tables_th"][t] = np.maximum(tab + corr * (Lg > L[0] - 2), 0).tolist()
        print("correction", it, "écart max avant", round(worst, 3), flush=True)


if __name__ == "__main__":
    fit = prof.load_fit()
    steps = {"gains": fit_gains, "tables": fit_tables, "shaper": fit_shaper, "xf": fit_xf, "eq": fit_eq,
             "times": fit_times, "correct": correct_tables}
    for st in sys.argv[1:]:
        steps[st](fit)
        prof.save_fit(fit)
