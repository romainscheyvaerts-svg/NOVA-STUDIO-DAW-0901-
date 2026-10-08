"""Calage du profil Leveler 2A sur les mesures de l'UADx LA-2A Silver.
Usage : python -m modeles.fit_la2a gains shaper eq tables sc dyn correct"""
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
from bancs import la2a as banc  # noqa: E402
from modeles import analog_comp as ac  # noqa: E402
from modeles import la2a_profil as prof  # noqa: E402
from modeles.pyproc import ModelProc  # noqa: E402

LABO = r"D:\1 WORK\CONTENU\nova-labo\ua_la2a"
M = json.load(open(os.path.join(LABO, "mesures.json"), encoding="utf-8"))
C = json.load(open(os.path.join(LABO, "mesures_carto.json"), encoding="utf-8"))
NAMES = [c["name"] for c in banc.CARTO]


def proc_for(fit):
    return ModelProc(prof.builder(fit, banc.to_nova), "LEVELER2A-py")


def fit_gains(fit):
    ks = list(range(0, 101, 5))
    fit["gain_knob"] = [float(k) for k in ks]
    fit["gain_db"] = [max(-180.0, C[f"c_gain{k}"]["tests"]["g"]["rows"][0]["ch0"]["out_db"] + 60) for k in ks]
    print("gains", [round(g, 1) for g in fit["gain_db"]])


def sat_rows():
    """Sans compression (PR 0) : la seule perte vient de l'étage de sortie."""
    return C["c_pr0"]["tests"]["stat_1k"]["rows"]


def fit_shaper(fit):
    lin = M["lineaire"]["tests"]["thd_1k"]["rows"]
    pr0 = sat_rows()

    def res(x):
        fit["out_a2"], fit["out_a3"], fit["out_sat"], fit["out_bias"], fit["out_ab"] = float(x[0]), float(x[1]), float(np.exp(x[2])), float(x[3]), float(x[4])
        fit["out_knee"] = float(np.exp(x[5]))
        proc = proc_for(fit)
        proc.configure({"peak_reduct": "0"})
        proc.cfg[0][ac.P_THR] = 1e6  # aucune compression pendant ce calage
        out = []
        for rows, dur in ((lin, 0.4), (pr0, 0.4)):
            lv = [r["in_db"] for r in rows]
            sim = bench.tone_levels(proc, 1000, lv, dur=dur)
            for a, b in zip(rows, sim["rows"]):
                out.append((b["ch0"]["out_db"] - a["ch0"]["out_db"]) * 2)
                for h in range(4):
                    ha, hb = a["ch0"]["harm_rel_db"][h], b["ch0"]["harm_rel_db"][h]
                    if ha > -100:
                        out.append((max(hb, -120) - ha) * 0.4)
        return np.array(out)
    x0 = [0.005, 0.0, np.log(2.0), 0.05, 0.0, np.log(4.0)]
    r = least_squares(res, x0, diff_step=0.02, max_nfev=400, bounds=([-1, -1, -3, -1, -1.5, np.log(1.0)], [1, 1, 3, 1, 1.5, np.log(30.0)]))
    res(r.x)
    print("shaper", [round(fit[k], 4) for k in ("out_a2", "out_a3", "out_sat", "out_bias", "out_ab", "out_knee")],
          "rms", round(float(np.sqrt(np.mean(r.fun ** 2))), 3), flush=True)


def fit_eq(fit):
    v = M["lineaire"]["tests"]["fr_-30"]
    f = np.array(v["freqs"])
    m = np.array(v["channels"][0]["mag_db"])
    sel = (f >= 20) & (f <= 19000)
    base = float(np.interp(50.0, fit["gain_knob"], fit["gain_db"]))

    def resp(x):
        h = np.ones(sel.sum(), complex)
        for kind, fc, q, gd in (("highshelf", x[0], x[1], x[2]), ("peak", x[3], x[4], x[5])):
            b = ac.biquad(kind, fc, q, gd)
            _, hh = sps.freqz([b[0], b[1], b[2]], [1, b[3], b[4]], worN=f[sel], fs=48000)
            h *= hh
        return 20 * np.log10(np.abs(h)) + base
    r = least_squares(lambda x: resp(x) - m[sel], [12000, 0.7, 1.0, 60, 0.7, 0.1],
                      bounds=([2000, 0.3, -3, 20, 0.2, -2], [23000, 2, 3, 400, 4, 2]))
    x = r.x
    fit["eq"] = [["highshelf", float(x[0]), float(x[1]), float(x[2])], ["peak", float(x[3]), float(x[4]), float(x[5])]]
    print("eq", np.round(x, 3), "max", round(float(np.max(np.abs(r.fun))), 3), flush=True)


def _comp_only(rows):
    """Réduction de compression seule : on retire la perte de l'étage de sortie (PR 0)."""
    pr0 = sat_rows()
    li = np.array([q["in_db"] for q in pr0])
    lg = np.array([q["ch0"]["out_db"] - q["in_db"] for q in pr0])
    i = np.array([q["in_db"] for q in rows])
    g = np.array([q["ch0"]["out_db"] - q["in_db"] for q in rows])
    G = np.maximum(lg[0] - g, 0)
    sat_loss = lg[0] - np.interp(i - G, li, lg)
    return i, np.maximum(G - np.maximum(sat_loss, 0), 0)


def _p1(i, G):
    if G.max() < 1:
        return None
    k = int(np.argmax(G > 1.0))
    return float(i[k - 1] + (1 - G[k - 1]) / (G[k] - G[k - 1]) * (i[k] - i[k - 1]))


def fit_tables(fit):
    Lg = prof.L0 + prof.DL * np.arange(prof.NL)
    for kind, knobs, key in (("pr", prof.PR_KNOB, "c_pr"), ("lim", prof.LIM_KNOB, "c_lim")):
        thr, tabs = [], []
        for k in knobs:
            i, G = _comp_only(C[f"{key}{int(k)}"]["tests"]["stat_1k"]["rows"])
            t = _p1(i, G)
            thr.append(t)
            tabs.append((i, G))
        # positions sans compression mesurable (PR 0, 10) : seuil prolongé
        for j in range(len(thr)):
            if thr[j] is None:
                nxt = next(x for x in thr[j:] if x is not None)
                thr[j] = nxt + 6.0 * (sum(1 for x in thr[j:] if x is None))
        T = []
        for (i, G), t in zip(tabs, thr):
            L = i - t
            tab = np.interp(Lg, L, G)
            hi = Lg > L[-1]
            if hi.any():
                sl = (G[-1] - G[-3]) / max(L[-1] - L[-3], 1e-6)
                tab[hi] = G[-1] + sl * (Lg[hi] - L[-1])
            tab[Lg < L[0]] = 0.0
            T.append(np.maximum(tab, 0).tolist())
        fit[f"thr_{kind}"] = thr
        fit[f"tables_{kind}"] = T
        print(kind, [round(x, 2) for x in thr], flush=True)


def fit_sc(fit):
    """Filtre du détecteur par position d'accentuation des aigus : calage
    analytique. Pour chaque mesure (fréquence, niveau), on retrouve le décalage
    de niveau vu par le détecteur en inversant la courbe statique mesurée à
    1 kHz (PR 50, accentuation 0), puis on cale |H(f)| (passe-haut + cloche)."""
    ref = C["c_pr50"]["tests"]["stat_1k"]["rows"]
    ri = np.array([q["in_db"] for q in ref])
    ro = np.array([q["ch0"]["out_db"] for q in ref])
    g_lin = ro[0] - ri[0]
    freqs = np.array([100, 300, 1000, 3000, 5000, 10000], float)
    S = []
    for e in prof.EMPH_KNOB:
        pts_f, pts_d, pts_cap = [], [], []
        onset = float(np.interp(g_lin - 0.5, ro - ri, ri)) if False else None
        # entrée la plus forte du palier sans compression (référence 1 kHz)
        gg = ro - ri
        k = int(np.argmax(gg < g_lin - 0.3))
        in_nc = float(ri[k - 1] + (g_lin - 0.3 - gg[k - 1]) / (gg[k] - gg[k - 1]) * (ri[k] - ri[k - 1]))
        for f in freqs:
            rows = C[f"c_emph{int(e)}_f{int(f)}"]["tests"]["stat"]["rows"]
            for q in rows:
                o = q["ch0"]["out_db"]
                if o < q["in_db"] + g_lin - 0.5:      # en compression : décalage exact
                    gr_ref = ri + g_lin - ro            # réduction de la référence, croissante avec le niveau
                    gr_m = q["in_db"] + g_lin - o
                    x_eff = float(np.interp(gr_m, gr_ref, ri))
                    pts_f.append(f); pts_d.append(x_eff - q["in_db"]); pts_cap.append(0)
                elif o >= q["in_db"] + g_lin - 0.3:   # pas de compression : borne supérieure
                    pts_f.append(f); pts_d.append(in_nc - q["in_db"]); pts_cap.append(1)
        pts_f, pts_d, pts_cap = np.array(pts_f), np.array(pts_d), np.array(pts_cap)

        def resp(x):
            g0, fh, qh, fp, qp, gp = x[0], np.exp(x[1]), x[2], np.exp(x[3]), x[4], x[5]
            h = np.ones(len(pts_f), complex)
            for kind, fc, q, gd in (("hp", fh, qh, 0.0), ("peak", fp, qp, gp)):
                bq = ac.biquad(kind, fc, q, gd)
                _, hh = sps.freqz([bq[0], bq[1], bq[2]], [1, bq[3], bq[4]], worN=pts_f, fs=48000)
                h *= hh
            return 20 * np.log10(np.abs(h)) + g0
        best = None
        for fh0 in (15.0, 150.0, 600.0, 1500.0, 2500.0):
            for fp0 in (1500.0, 3000.0, 8000.0):
                x0 = [0.0, np.log(fh0), 0.7, np.log(fp0), 0.7, 0.0]
                def rr(x):
                    d = resp(x) - pts_d
                    return np.where(pts_cap > 0, np.maximum(d, 0.0) * 2.0, d)
                r = least_squares(rr, x0,
                                  bounds=([-30, np.log(10), 0.3, np.log(200), 0.2, -24], [30, np.log(8000), 3, np.log(20000), 5, 24]))
                if best is None or r.cost < best.cost:
                    best = r
        x = best.x
        S.append([float(x[0]), float(np.exp(x[1])), float(x[2]), float(np.exp(x[3])), float(x[4]), float(x[5])])
        print(f"emph {e}: {np.round(S[-1], 2).tolist()} écart max {float(np.max(np.abs(best.fun))):.2f} dB ({len(pts_f)} pts)", flush=True)
    fit["sc"] = S


def step_sets():
    out = []
    for key, holds in (("c_t_pr60", [0.05, 0.1, 0.3, 1.0, 3.0]), ("c_t_pr80", [0.05, 0.3, 1.0, 3.0])):
        case = C[key]
        tdefs = {t["name"]: t for t in banc.CARTO[NAMES.index(key)]["tests"]}
        out.append((case["settings"], [(tdefs[f"h{h}"], np.array(case["tests"][f"h{h}"]["gr_curve_ms"])) for h in holds]))
    return out


def residual(fit, sets):
    out = []
    proc = proc_for(fit)
    for settings, tl in sets:
        proc.configure(settings)
        for t, m in tl:
            g = np.array(bench.step_response(proc, 1000, t["base_db"], t["step_db"], t["hold"], min(t["rel_obs"], 6.0))["gr_curve_ms"])
            n = min(len(g), len(m))
            w = np.ones(n)
            w[:45] = 0
            w[48:80] *= 3
            out.append((g[:n] - m[:n]) * w)
    return np.concatenate(out)


def fit_dyn(fit):
    sets = step_sets()
    keys = ["att_ms", "rel_ms", "slow_frac", "slow_att_ms", "slow_rel_ms"]

    def put(x):
        fit["att_ms"], fit["rel_ms"] = float(np.exp(x[0])), float(np.exp(x[1]))
        fit["slow_frac"] = float(1 / (1 + np.exp(-x[2])))
        fit["slow_att_ms"] = float(min(5000.0, max(5.0, np.exp(x[3]))))
        fit["slow_rel_ms"] = float(min(8000.0, max(50.0, np.exp(x[4]))))

    def cost(x):
        put(x)
        return float(np.mean(residual(fit, sets) ** 2))
    x0 = [np.log(fit["att_ms"]), np.log(fit["rel_ms"]), np.log(fit["slow_frac"] / (1 - fit["slow_frac"])),
          np.log(fit["slow_att_ms"]), np.log(fit["slow_rel_ms"])]
    simplex = [x0] + [[x0[i] + (0.7 if i == j else 0) for i in range(5)] for j in range(5)]
    r = minimize(cost, x0, method="Nelder-Mead", options={"maxfev": 160, "initial_simplex": simplex})
    put(r.x)
    print("dyn", {k: round(fit[k], 3) for k in keys}, "rms", round(math.sqrt(r.fun), 3), flush=True)


def correct_tables(fit, iters=3):
    Lg = prof.L0 + prof.DL * np.arange(prof.NL)
    for it in range(iters):
        worst = 0
        for kind, knobs, key in (("pr", prof.PR_KNOB, "c_pr"), ("lim", prof.LIM_KNOB, "c_lim")):
            for j, k in enumerate(knobs):
                if kind == "pr" and k < 20:
                    continue
                case = C[f"{key}{int(k)}"]
                proc = proc_for(fit)
                proc.configure(case["settings"])
                rows = case["tests"]["stat_1k"]["rows"]
                lv = [q["in_db"] for q in rows]
                sim = bench.tone_levels(proc, 1000, lv, dur=3.0)
                err = np.array([b["ch0"]["out_db"] - a["ch0"]["out_db"] for a, b in zip(rows, sim["rows"])])
                worst = max(worst, float(np.max(np.abs(err))))
                L = np.array(lv) - fit[f"thr_{kind}"][j]
                tab = np.array(fit[f"tables_{kind}"][j])
                corr = np.interp(Lg, L, err, left=0.0, right=err[-1])
                fit[f"tables_{kind}"][j] = np.maximum(tab + corr * (Lg > L[0] - 2), 0).tolist()
        print("correction", it, "écart max avant", round(worst, 3), flush=True)


if __name__ == "__main__":
    fit = prof.load_fit()
    steps = {"gains": fit_gains, "shaper": fit_shaper, "eq": fit_eq, "tables": fit_tables, "sc": fit_sc,
             "dyn": fit_dyn, "correct": correct_tables}
    for st in sys.argv[1:]:
        steps[st](fit)
        prof.save_fit(fit)
